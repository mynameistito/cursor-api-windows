import { HttpError } from "./http";
import {
  bitXor,
  connectFlagHas,
  hasHighBit,
  low7Bits,
  protoFieldNumber,
  protoTag,
  protoWireType,
  toUint32,
  varintContribution,
} from "./proto-bits";
import { parseSse } from "./sse";
import type {
  CursorCompletion,
  CursorImage,
  CursorMe,
  CursorPrompt,
  CursorToolCall,
  Deps,
  Env,
  JsonValue,
} from "./types";

interface CursorAccessTokenResponse {
  accessToken?: string;
}

interface ProtobufField {
  no: number;
  wt: number;
  value: number | Uint8Array;
}

const cursorIdentityCache = new Map<
  string,
  {
    identity: string;
    expiresAt: number;
  }
>();

const COMPOSER_CONTROL_TOKEN_PATTERN =
  /<\/think>|<\s*[|｜]\s*final\s*[|｜]\s*>/gu;

const LEADING_WHITESPACE_PATTERN = /^\s+/u;

const TRAILING_SLASH_PATTERN = /\/$/u;

const ABSOLUTE_URL_PATTERN = /^https?:\/\//u;

const WHITESPACE_PATTERN = /\s/gu;

const NUMERIC_LITERAL_PATTERN = /^-?\d+(?:\.\d+)?$/u;

const INLINE_TOOL_KEY_PATTERN = /^[A-Za-z0-9_.-]+$/u;

const INLINE_TOOL_CALL_PATTERN =
  /^(?<name>[A-Za-z0-9_.-]+)\s*(?:\((?<paren>[\s\S]*)\)|\[(?<bracket>[\s\S]*)\])?$/u;

const TOOL_PART_KEY_VALUE_PATTERN =
  /^(?<key>[^\r\n]+)(?:\r?\n(?<value>[\s\S]*))?$/u;

const CANONICAL_TOOL_MARKER_PATTERN =
  /<\s*[|｜]\s*(?<marker>tool[_▁]calls[_▁]begin|tool[_▁]calls[_▁]end|tool[_▁]call[_▁]begin|tool[_▁]call[_▁]end|tool[_▁]sep)\s*[|｜]\s*>/gu;

const composerToolMarkerPattern = (marker: string) =>
  new RegExp(
    `<\\s*[|｜]\\s*${marker.replaceAll("_", "[_▁]")}\\s*[|｜]\\s*>`,
    "u"
  );

const MAX_CURSOR_IMAGE_BYTES = 1024 * 1024;

interface EncodedCursorImage {
  data: Uint8Array;
  dimension?: {
    width: number;
    height: number;
  };
  uuid: string;
}

/** Events emitted while decoding Cursor's completion stream. */
export type CursorTextEvent =
  | {
      type: "text";
      text: string;
    }
  | {
      type: "tool_call";
      toolCall: CursorToolCall;
    }
  | {
      type: "rejected_tool_call";
      toolCall: CursorToolCall;
      reason?: string;
    }
  | {
      type: "done";
      finalText: string;
      toolCalls: CursorToolCall[];
    };

/** The combined text and tool calls collected from a Cursor stream. */
export interface CursorCollectedOutput {
  text: string;
  toolCalls: CursorToolCall[];
}

type ComposerToolMarkerEvent =
  | {
      type: "text";
      text: string;
    }
  | {
      type: "tool_call";
      toolCall: CursorToolCall;
    };

const TOOL_CALLS_BEGIN = "<|tool_calls_begin|>";

const TOOL_CALLS_END = "<|tool_calls_end|>";

const TOOL_CALL_BEGIN = "<|tool_call_begin|>";

const TOOL_CALL_END = "<|tool_call_end|>";

const TOOL_SEP = "<|tool_sep|>";

const TOOL_MARKER_CANDIDATES = [
  TOOL_CALLS_BEGIN,
  TOOL_CALLS_END,
  TOOL_CALL_BEGIN,
  TOOL_CALL_END,
  TOOL_SEP,
].flatMap((marker) => [
  marker,
  marker.replaceAll("|", "｜").replaceAll("_", "▁"),
]);

interface JsonObject {
  [key: string]: JsonValue;
}

const isJsonObject = function isJsonObject(
  value: JsonValue | undefined
): value is JsonObject {
  return Object.prototype.toString.call(value) === "[object Object]";
};

const asJsonObject = function asJsonObject(
  value: JsonValue | undefined
): JsonObject | null {
  return isJsonObject(value) ? value : null;
};

const isString = function isString(
  value: JsonValue | undefined
): value is string {
  return Object.prototype.toString.call(value) === "[object String]";
};

const isNumber = function isNumber(value: JsonValue): value is number {
  return Object.prototype.toString.call(value) === "[object Number]";
};

const canonicalizeComposerToolMarkers =
  function canonicalizeComposerToolMarkers(value: string): string {
    return value.replaceAll(CANONICAL_TOOL_MARKER_PATTERN, (_match, marker) => {
      const normalizedMarker = isString(marker)
        ? marker.replaceAll("▁", "_")
        : "";
      return `<|${normalizedMarker}|>`;
    });
  };

const firstString = function firstString(
  ...values: (JsonValue | undefined)[]
): string | null {
  for (const value of values) {
    if (value !== undefined && isString(value) && value.trim()) {
      return value.trim();
    }
  }
  return null;
};

const recordFromToolArguments = function recordFromToolArguments(
  value: JsonValue | undefined
): JsonObject | null {
  if (value === undefined) {
    return null;
  }
  if (!isString(value)) {
    return asJsonObject(value);
  }
  if (!value.trim()) {
    return null;
  }
  try {
    const decoded: JsonValue = JSON.parse(value);
    return asJsonObject(decoded);
  } catch {
    return null;
  }
};

const parseJsonToolCallBody = function parseJsonToolCallBody(
  value: string
): CursorToolCall | null {
  if (!value.startsWith("{") || !value.endsWith("}")) {
    return null;
  }
  try {
    const parsed: JsonValue = JSON.parse(value);
    const object = asJsonObject(parsed);
    if (!object) {
      return null;
    }
    const fn =
      object.function === undefined ? undefined : asJsonObject(object.function);
    const name = firstString(
      object.name,
      object.tool,
      object.tool_name,
      object.toolName,
      fn?.name
    );
    if (!name) {
      return null;
    }
    const rawArguments = [
      object.arguments,
      object.args,
      object.input,
      object.parameters,
      object.params,
      fn?.arguments,
    ].find((argument) => argument !== undefined);
    return { arguments: recordFromToolArguments(rawArguments) ?? {}, name };
  } catch {
    return null;
  }
};

const splitInlineArguments = function splitInlineArguments(
  value: string
): string[] {
  const parts: string[] = [];
  let start = 0;
  let index = 0;
  let quote: string | null = null;
  let depth = 0;
  for (const char of value) {
    const escaped = value[index - 1] === "\\";
    if (quote && char === quote && !escaped) {
      quote = null;
    } else if (!quote && (char === '"' || char === "'")) {
      quote = char;
    } else if (!quote && (char === "{" || char === "[")) {
      depth += 1;
    } else if (!quote && (char === "}" || char === "]")) {
      depth = Math.max(0, depth - 1);
    } else if (!quote && char === "," && depth === 0) {
      parts.push(value.slice(start, index));
      start = index + 1;
    }
    index += char.length;
  }
  parts.push(value.slice(start));
  return parts;
};

const parseComposerToolArgument = function parseComposerToolArgument(
  value: string
) {
  if (!value) {
    return "";
  }
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  if (value === "null") {
    return null;
  }
  if (NUMERIC_LITERAL_PATTERN.test(value)) {
    return Number(value);
  }
  if (
    (value.startsWith("{") && value.endsWith("}")) ||
    (value.startsWith("[") && value.endsWith("]"))
  ) {
    try {
      const parsed: JsonValue = JSON.parse(value);
      return parsed;
    } catch {
      return value;
    }
  }
  return value;
};

const parseInlineToolArguments = function parseInlineToolArguments(
  value: string
): JsonObject {
  const args: JsonObject = {};
  for (const part of splitInlineArguments(value)) {
    const trimmed = part.trim();
    const colon = trimmed.indexOf(":");
    const equals = trimmed.indexOf("=");
    let delimiter = Number.POSITIVE_INFINITY;
    for (const index of [colon, equals]) {
      if (index >= 0) {
        delimiter = Math.min(delimiter, index);
      }
    }
    if (Number.isFinite(delimiter)) {
      const key = trimmed.slice(0, delimiter).trim();
      if (INLINE_TOOL_KEY_PATTERN.test(key)) {
        args[key] = parseComposerToolArgument(
          trimmed.slice(delimiter + 1).trim()
        );
      }
    }
  }
  return args;
};

const parseInlineToolCall = function parseInlineToolCall(
  value: string
): CursorToolCall | null {
  const match = INLINE_TOOL_CALL_PATTERN.exec(value.trim());
  if (!match?.groups?.name) {
    return null;
  }
  const name = match.groups.name.trim();
  const rawArgs = (match.groups.paren ?? match.groups.bracket ?? "").trim();
  const args = rawArgs ? parseInlineToolArguments(rawArgs) : {};
  return { arguments: args, name };
};

const parseComposerToolCallBody = function parseComposerToolCallBody(
  value: string
): CursorToolCall | null {
  const trimmedBody = value.trim();
  const jsonBody = parseJsonToolCallBody(trimmedBody);
  if (jsonBody) {
    return jsonBody;
  }
  const parts = value.split(TOOL_SEP);
  const name = (parts.shift() || "").trim();
  if (!name) {
    return null;
  }
  if (!parts.length) {
    const inline = parseInlineToolCall(name);
    return inline ?? { arguments: {}, name };
  }
  const args: JsonObject = {};
  for (const part of parts) {
    const trimmed = part.replace(LEADING_WHITESPACE_PATTERN, "");
    const match = trimmed ? TOOL_PART_KEY_VALUE_PATTERN.exec(trimmed) : null;
    const key = match?.groups?.key?.trim();
    if (key) {
      const rawValue = (match?.groups?.value || "").trim();
      args[key] = parseComposerToolArgument(rawValue);
    }
  }
  return { arguments: args, name };
};

const parseComposerToolCalls = function parseComposerToolCalls(
  value: string
): CursorToolCall[] {
  const normalized = canonicalizeComposerToolMarkers(value);
  const beginIndex = normalized.indexOf(TOOL_CALLS_BEGIN);
  const endIndex = normalized.lastIndexOf(TOOL_CALLS_END);
  if (beginIndex === -1 || endIndex === -1 || endIndex <= beginIndex) {
    return [];
  }
  const body = normalized.slice(beginIndex + TOOL_CALLS_BEGIN.length, endIndex);
  const calls: CursorToolCall[] = [];
  let offset = 0;
  for (
    let start = body.indexOf(TOOL_CALL_BEGIN, offset);
    start !== -1;
    start = body.indexOf(TOOL_CALL_BEGIN, offset)
  ) {
    const contentStart = start + TOOL_CALL_BEGIN.length;
    const end = body.indexOf(TOOL_CALL_END, contentStart);
    if (end === -1) {
      break;
    }
    const call = parseComposerToolCallBody(body.slice(contentStart, end));
    if (call) {
      calls.push(call);
    }
    offset = end + TOOL_CALL_END.length;
  }
  return calls;
};

const findComposerToolMarker = function findComposerToolMarker(
  value: string,
  marker: string
): {
  index: number;
  length: number;
} | null {
  const match = composerToolMarkerPattern(marker).exec(value);
  return match ? { index: match.index, length: match[0].length } : null;
};

const toolMarkerPrefixIndex = function toolMarkerPrefixIndex(
  value: string
): number {
  const max = Math.min(
    value.length,
    Math.max(...TOOL_MARKER_CANDIDATES.map((candidate) => candidate.length))
  );
  for (let length = max; length >= 1; length -= 1) {
    const index = value.length - length;
    const suffix = value.slice(index);
    if (
      TOOL_MARKER_CANDIDATES.some((candidate) => candidate.startsWith(suffix))
    ) {
      return index;
    }
  }
  return -1;
};

const controlTokenPrefixLength = function controlTokenPrefixLength(
  value: string
): number {
  const candidates = ["</think>", "<|final|>", "<｜final｜>", "< | final | >"];
  let keep = 0;
  const max = Math.min(
    value.length,
    Math.max(...candidates.map((candidate) => candidate.length))
  );
  for (let length = 1; length <= max; length += 1) {
    const suffix = value.slice(value.length - length);
    if (candidates.some((candidate) => candidate.startsWith(suffix))) {
      keep = length;
    }
  }
  return keep;
};

const findComposerControlToken = function findComposerControlToken(
  value: string
): {
  index: number;
  length: number;
} | null {
  let found: {
    index: number;
    length: number;
  } | null = null;
  const pattern = new RegExp(COMPOSER_CONTROL_TOKEN_PATTERN.source, "gu");
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(value))) {
    found = { index: match.index, length: match[0].length };
  }
  return found;
};

const stripLeadingWhitespace = function stripLeadingWhitespace(
  value: string
): string {
  return value.replace(LEADING_WHITESPACE_PATTERN, "");
};

const stripComposerControlTokens = function stripComposerControlTokens(
  value: string
): string {
  const marker = findComposerControlToken(value);
  if (!marker) {
    return value;
  }
  return stripLeadingWhitespace(
    value
      .slice(marker.index + marker.length)
      .replace(COMPOSER_CONTROL_TOKEN_PATTERN, "")
  );
};

const emitVisibleText = function emitVisibleText(
  text: string,
  events: ComposerToolMarkerEvent[]
): void {
  if (text.trim()) {
    events.push({ text, type: "text" });
  }
};

const createComposerToolCallFilter = function createComposerToolCallFilter() {
  let buffer = "";
  const drainPlainText = function drainPlainText(
    force: boolean,
    events: ComposerToolMarkerEvent[]
  ): boolean {
    if (!buffer.trim()) {
      if (force) {
        buffer = "";
      }
      return buffer.length === 0;
    }
    const prefixIndex = force ? -1 : toolMarkerPrefixIndex(buffer);
    if (prefixIndex !== -1) {
      emitVisibleText(buffer.slice(0, prefixIndex), events);
      buffer = buffer.slice(prefixIndex);
      return buffer.length === 0;
    }
    emitVisibleText(buffer, events);
    buffer = "";
    return buffer.length === 0;
  };
  const drainToolBlock = function drainToolBlock(
    begin: { index: number; length: number },
    force: boolean,
    events: ComposerToolMarkerEvent[]
  ): boolean {
    if (begin.index > 0) {
      emitVisibleText(buffer.slice(0, begin.index), events);
      buffer = buffer.slice(begin.index);
      return true;
    }
    const end = findComposerToolMarker(
      buffer.slice(begin.length),
      "tool_calls_end"
    );
    if (!end) {
      if (force) {
        events.push({ text: buffer, type: "text" });
        buffer = "";
      }
      return false;
    }
    const blockEnd = begin.length + end.index + end.length;
    const block = buffer.slice(0, blockEnd);
    for (const toolCall of parseComposerToolCalls(block)) {
      events.push({ toolCall, type: "tool_call" });
    }
    buffer = buffer.slice(blockEnd).replace(LEADING_WHITESPACE_PATTERN, "");
    return true;
  };
  const drain = function drain(force: boolean): ComposerToolMarkerEvent[] {
    const events: ComposerToolMarkerEvent[] = [];
    let shouldContinue = true;
    while (shouldContinue) {
      const begin = findComposerToolMarker(buffer, "tool_calls_begin");
      shouldContinue = begin
        ? drainToolBlock(begin, force, events)
        : drainPlainText(force, events);
    }
    return events;
  };
  return {
    flush(): ComposerToolMarkerEvent[] {
      return drain(true);
    },
    push(delta: string): ComposerToolMarkerEvent[] {
      buffer += delta;
      return drain(false);
    },
  };
};

const createThinkingTextExtractor = function createThinkingTextExtractor() {
  let buffer = "";
  let open = true;
  return {
    flush(): string {
      if (!open) {
        return "";
      }
      const marker = findComposerControlToken(buffer);
      if (marker) {
        const after = stripLeadingWhitespace(
          buffer.slice(marker.index + marker.length)
        );
        buffer = "";
        return after;
      }
      buffer = "";
      return "";
    },
    push(delta: string): string[] {
      if (!open) {
        return [delta];
      }
      buffer += delta;
      const marker = findComposerControlToken(buffer);
      if (!marker) {
        return [];
      }
      open = false;
      const after = stripLeadingWhitespace(
        buffer.slice(marker.index + marker.length)
      );
      buffer = "";
      return after ? [after] : [];
    },
  };
};

const createComposerOutputFilter = function createComposerOutputFilter() {
  let buffer = "";
  return {
    flush(): string[] {
      const marker = findComposerControlToken(buffer);
      const visible = marker
        ? stripLeadingWhitespace(buffer.slice(marker.index + marker.length))
        : buffer;
      buffer = "";
      return visible ? [visible] : [];
    },
    push(delta: string): string[] {
      buffer += delta;
      const marker = findComposerControlToken(buffer);
      if (marker) {
        const after = stripLeadingWhitespace(
          buffer.slice(marker.index + marker.length)
        );
        buffer = "";
        return after ? [after] : [];
      }
      const keep = controlTokenPrefixLength(buffer);
      if (keep === buffer.length) {
        return [];
      }
      const visible = buffer.slice(0, buffer.length - keep);
      buffer = buffer.slice(buffer.length - keep);
      return visible ? [visible] : [];
    },
  };
};

const mapCursorPublicHttpStatus = function mapCursorPublicHttpStatus(
  responseStatus: number
): number {
  if (responseStatus === 401) {
    return 401;
  }
  if (responseStatus === 429) {
    return 429;
  }
  if (responseStatus >= 500) {
    return 502;
  }
  return 400;
};

const mapCursorInternalHttpStatus = function mapCursorInternalHttpStatus(
  responseStatus: number
): number {
  if (responseStatus === 401) {
    return 401;
  }
  if (responseStatus === 429) {
    return 429;
  }
  if (responseStatus >= 500 || responseStatus === 464) {
    return 502;
  }
  return 400;
};

const parseCursorError = function parseCursorError(
  text: string
): string | undefined {
  try {
    const payload: JsonValue = JSON.parse(text);
    const object = asJsonObject(payload);
    if (object) {
      const error = asJsonObject(object.error ?? null) ?? object;
      if (isString(error.message)) {
        return error.message;
      }
    }
  } catch {
    // Ignore JSON parse failures.
  }
  return text || undefined;
};

const cursorPublicRaw = async function cursorPublicRaw(
  env: Env,
  deps: Deps,
  apiKey: string,
  path: string,
  init: RequestInit = {}
): Promise<Response> {
  const base = env.CURSOR_API_BASE || "https://api.cursor.com";
  const url = `${base.replace(TRAILING_SLASH_PATTERN, "")}${path}`;
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${apiKey}`);
  headers.set("x-cursor-client-type", "sdk");
  headers.set("x-cursor-client-version", "composer-api-0.1.0");
  headers.set("x-ghost-mode", "true");
  const response = await deps.fetch(url, { ...init, headers });
  if (!response.ok) {
    let text = "";
    try {
      text = await response.text();
    } catch {
      // Preserve the empty-body fallback when reading the error response fails.
    }
    const message =
      response.status === 401
        ? "Invalid Cursor API key"
        : parseCursorError(text) ||
          `Cursor API request failed with status ${response.status}`;
    const status = mapCursorPublicHttpStatus(response.status);
    throw new HttpError(
      message,
      status,
      response.status === 401 ? "cursor_unauthorized" : "cursor_api_error"
    );
  }
  return response;
};

const cursorPublicJson = async function cursorPublicJson<T>(
  env: Env,
  deps: Deps,
  apiKey: string,
  path: string,
  parse: (value: JsonValue) => T,
  init: {
    method?: string;
    body?: unknown;
    idempotencyKey?: string;
  } = {}
): Promise<T> {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (init.idempotencyKey) {
    headers.set("Idempotency-Key", init.idempotencyKey);
  }
  const response = await cursorPublicRaw(env, deps, apiKey, path, {
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    headers,
    method: init.method || "GET",
  });
  const payload: JsonValue = JSON.parse(await response.text());
  return parse(payload);
};

const parseCursorMe = function parseCursorMe(value: JsonValue): CursorMe {
  const object = asJsonObject(value);
  if (!object || !isString(object.apiKeyName) || !isString(object.createdAt)) {
    throw new HttpError(
      "Cursor returned an invalid account response",
      502,
      "cursor_bad_response"
    );
  }
  const me: CursorMe = {
    apiKeyName: object.apiKeyName,
    createdAt: object.createdAt,
  };
  if (object.userId !== undefined && isNumber(object.userId)) {
    me.userId = object.userId;
  }
  if (object.userEmail !== undefined && isString(object.userEmail)) {
    me.userEmail = object.userEmail;
  }
  if (object.userFirstName !== undefined && isString(object.userFirstName)) {
    me.userFirstName = object.userFirstName;
  }
  if (object.userLastName !== undefined && isString(object.userLastName)) {
    me.userLastName = object.userLastName;
  }
  return me;
};

const verifyCursorApiKey = function verifyCursorApiKey(
  env: Env,
  deps: Deps,
  apiKey: string
): Promise<CursorMe> {
  return cursorPublicJson(env, deps, apiKey, "/v1/me", parseCursorMe);
};

/**
 * Resolve the requested model, using the default when none is provided.
 * @param model - The requested model identifier.
 * @returns The resolved model identifier, or `undefined` for invalid input.
 */
export const resolveCursorModel = function resolveCursorModel(
  model: string | undefined
):
  | {
      id: string;
    }
  | undefined {
  const defaultModelId = "composer-2.5";
  if (!model?.trim()) {
    return { id: defaultModelId };
  }
  const normalized = model.trim().toLowerCase();
  if (
    normalized === defaultModelId ||
    normalized === "composer-2-5" ||
    normalized === "composer-2.5-sdk" ||
    normalized === "composer-latest"
  ) {
    return { id: defaultModelId };
  }
  if (
    normalized === "composer-2.5-fast" ||
    normalized === "composer-2-5-fast"
  ) {
    return { id: "composer-2.5-fast" };
  }
  if (normalized === "auto" || normalized === "default") {
    return { id: defaultModelId };
  }
  return { id: model.trim() };
};

const decodeBase64 = function decodeBase64(value: string): Uint8Array {
  const normalized = value.replaceAll(WHITESPACE_PATTERN, "");
  try {
    const binary = atob(normalized);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.codePointAt(i) ?? 0;
    }
    return bytes;
  } catch {
    throw new HttpError(
      "Image data URL contains invalid base64 data.",
      400,
      "invalid_request_error",
      "image_url"
    );
  }
};

const fetchImageBytes = async function fetchImageBytes(
  url: string,
  deps: Deps
): Promise<Uint8Array> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new HttpError(
      "Image URL is invalid.",
      400,
      "invalid_request_error",
      "image_url"
    );
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new HttpError(
      "Image URL must use http or https.",
      400,
      "invalid_request_error",
      "image_url"
    );
  }
  const response = await deps.fetch(parsed.toString(), { method: "GET" });
  if (!response.ok) {
    throw new HttpError(
      `Could not fetch image URL (${response.status}).`,
      400,
      "invalid_request_error",
      "image_url"
    );
  }
  const contentType = response.headers.get("content-type") || "";
  if (contentType && !contentType.toLowerCase().startsWith("image/")) {
    throw new HttpError(
      "Image URL did not return an image content type.",
      400,
      "invalid_request_error",
      "image_url"
    );
  }
  return new Uint8Array(await response.arrayBuffer());
};

const stableImageId = function stableImageId(index: number): string {
  return crypto.randomUUID?.() ?? `image-${Date.now()}-${index}`;
};

const resolveCursorImages = function resolveCursorImages(
  images: CursorImage[],
  deps: Deps
): Promise<EncodedCursorImage[]> {
  return Promise.all(
    images.map(async (image, index) => {
      const data =
        "data" in image
          ? decodeBase64(image.data)
          : await fetchImageBytes(image.url, deps);
      if (!data.length) {
        throw new HttpError(
          "Image input is empty.",
          400,
          "invalid_request_error",
          "image"
        );
      }
      if (data.length > MAX_CURSOR_IMAGE_BYTES) {
        throw new HttpError(
          "Image input is too large. Resize images to 1024px or less and keep each image under 1MB.",
          400,
          "invalid_request_error",
          "image"
        );
      }
      const encodedImage: EncodedCursorImage = {
        data,
        uuid: image.uuid || stableImageId(index),
      };
      if ("dimension" in image && image.dimension) {
        encodedImage.dimension = image.dimension;
      }
      return encodedImage;
    })
  );
};

const sha256Hex = async function sha256Hex(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value)
  );
  return [...new Uint8Array(bytes)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
};

const getCursorAccountIdentity = async function getCursorAccountIdentity(
  env: Env,
  deps: Deps,
  apiKey: string
): Promise<string> {
  const apiKeyHash = await sha256Hex(apiKey);
  const now = deps.now().getTime();
  const cached = cursorIdentityCache.get(apiKeyHash);
  if (cached && cached.expiresAt > now) {
    return cached.identity;
  }
  const me = await verifyCursorApiKey(env, deps, apiKey);
  let identity = `cursor-key:${apiKeyHash}`;
  if (me.userId !== undefined) {
    identity = `cursor-user:${me.userId}`;
  } else if (me.userEmail) {
    identity = `cursor-email:${me.userEmail.trim().toLowerCase()}`;
  }
  cursorIdentityCache.set(apiKeyHash, {
    expiresAt: now + 60 * 60 * 1000,
    identity,
  });
  return identity;
};

const internalCursorErrorMessage = function internalCursorErrorMessage(
  status: number
): string {
  if (status === 464) {
    return "Cursor rejected the proxied chat request. The proxy request is valid, but Cursor refused this account/session.";
  }
  return `Cursor internal API request failed with status ${status}`;
};

const parseCursorAccessTokenResponse = function parseCursorAccessTokenResponse(
  value: JsonValue
): CursorAccessTokenResponse | undefined {
  const object = asJsonObject(value);
  if (!object || !isString(object.accessToken)) {
    return undefined;
  }
  return { accessToken: object.accessToken };
};

const cursorInternalRaw = async function cursorInternalRaw(
  env: Env,
  deps: Deps,
  token: string,
  path: string,
  init: RequestInit = {}
): Promise<Response> {
  const base = env.CURSOR_BACKEND_BASE_URL?.trim();
  if (!base) {
    throw new HttpError(
      "Cursor backend URL is not configured",
      500,
      "cursor_missing_backend_url"
    );
  }
  let url = path;
  if (!ABSOLUTE_URL_PATTERN.test(path)) {
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    url = `${base.replace(TRAILING_SLASH_PATTERN, "")}${normalizedPath}`;
  }
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  const response = await deps.fetch(url, { ...init, headers });
  if (!response.ok) {
    let text = "";
    try {
      text = await response.text();
    } catch {
      // Preserve the empty-body fallback when reading the error response fails.
    }
    const parsed = parseCursorError(text);
    const message =
      response.status === 401
        ? "Invalid Cursor API key"
        : parsed || internalCursorErrorMessage(response.status);
    const status = mapCursorInternalHttpStatus(response.status);
    throw new HttpError(
      message,
      status,
      response.status === 401 ? "cursor_unauthorized" : "cursor_api_error"
    );
  }
  return response;
};

/**
 * Exchange a Cursor API key for an access token.
 * @param env - The configured runtime environment.
 * @param deps - Runtime dependencies used for the request.
 * @param apiKey - The Cursor API key to exchange.
 * @returns The exchanged access token.
 */
export const exchangeCursorApiKey = async function exchangeCursorApiKey(
  env: Env,
  deps: Deps,
  apiKey: string
): Promise<string> {
  const response = await cursorInternalRaw(
    env,
    deps,
    apiKey,
    "/auth/exchange_user_api_key",
    {
      body: "{}",
      headers: { "Content-Type": "application/json" },
      method: "POST",
    }
  );
  const payload: JsonValue = JSON.parse(await response.text());
  const parsedPayload = parseCursorAccessTokenResponse(payload);
  const accessToken = parsedPayload?.accessToken;
  if (!accessToken) {
    throw new HttpError(
      "Cursor did not return an internal access token",
      502,
      "cursor_bad_response"
    );
  }
  return accessToken;
};

const stableUuid = async function stableUuid(
  namespace: string,
  value: string
): Promise<string> {
  const hashHex = await sha256Hex(`${namespace}:${value}`);
  const hash = hashHex.slice(0, 32);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20)}`;
};

const encodeConnectFrame = function encodeConnectFrame(
  payload: Uint8Array
): Uint8Array {
  const frame = new Uint8Array(5 + payload.length);
  frame[0] = 0;
  new DataView(frame.buffer).setUint32(1, payload.length, false);
  frame.set(payload, 5);
  return frame;
};

const encodeVarint = function encodeVarint(value: number): Uint8Array {
  const bytes: number[] = [];
  let current = toUint32(value);
  while (current >= 0x80) {
    bytes.push(low7Bits(current) + 0x80);
    current = Math.floor(current / 128);
  }
  bytes.push(current);
  return new Uint8Array(bytes);
};

const concatBytes = function concatBytes(
  ...parts: Uint8Array<ArrayBufferLike>[]
): Uint8Array<ArrayBuffer> {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
};

const protoField = function protoField(
  fieldNumber: number,
  wireType: 0 | 2,
  value: string | number | Uint8Array
): Uint8Array {
  const tag = encodeVarint(protoTag(fieldNumber, wireType));
  if (wireType === 0) {
    return concatBytes(tag, encodeVarint(Number(value)));
  }
  const bytes =
    value instanceof Uint8Array
      ? value
      : new TextEncoder().encode(String(value));
  return concatBytes(tag, encodeVarint(bytes.length), bytes);
};

const protoMessage = function protoMessage(parts: Uint8Array[]): Uint8Array {
  return concatBytes(...parts);
};

const encodeImageProto = function encodeImageProto(
  image: EncodedCursorImage
): Uint8Array {
  const fields = [protoField(1, 2, image.data)];
  if (image.dimension) {
    fields.push(
      protoField(
        2,
        2,
        protoMessage([
          protoField(1, 0, image.dimension.width),
          protoField(2, 0, image.dimension.height),
        ])
      )
    );
  }
  fields.push(protoField(3, 2, image.uuid));
  return protoMessage(fields);
};

const encodeCursorChatRequest = function encodeCursorChatRequest(input: {
  prompt: CursorPrompt;
  images?: EncodedCursorImage[];
  model: string;
  requestId: string;
  conversationId: string;
  messageId: string;
}): Uint8Array {
  const { messageId } = input;
  const composerMode = input.prompt.mode === "agent" ? "Agent" : "Ask";
  const imageFields = (input.images ?? []).map((image) =>
    protoField(10, 2, encodeImageProto(image))
  );
  const userMessage = protoMessage([
    protoField(1, 2, input.prompt.text),
    protoField(2, 0, 1),
    ...imageFields,
    protoField(13, 2, messageId),
    protoField(47, 0, 1),
  ]);
  const model = protoMessage([
    protoField(1, 2, input.model),
    protoField(4, 2, new Uint8Array(0)),
  ]);
  const cursorSetting = protoMessage([
    protoField(1, 2, "cursor\\aisettings"),
    protoField(3, 2, new Uint8Array(0)),
    protoField(
      6,
      2,
      protoMessage([
        protoField(1, 2, new Uint8Array(0)),
        protoField(2, 2, new Uint8Array(0)),
      ])
    ),
    protoField(8, 0, 1),
    protoField(9, 0, 1),
  ]);
  const metadata = protoMessage([
    protoField(1, 2, "linux"),
    protoField(2, 2, "x64"),
    protoField(3, 2, "unknown"),
    protoField(4, 2, "composer-api"),
    protoField(5, 2, new Date().toISOString()),
  ]);
  const messageIdRecord = protoMessage([
    protoField(1, 2, messageId),
    protoField(3, 0, 1),
  ]);
  const request = protoMessage([
    protoField(1, 2, userMessage),
    protoField(2, 0, 1),
    protoField(3, 2, new Uint8Array(0)),
    protoField(4, 0, 1),
    protoField(5, 2, model),
    protoField(8, 2, ""),
    protoField(13, 0, 1),
    protoField(15, 2, cursorSetting),
    protoField(19, 0, 1),
    protoField(23, 2, input.conversationId),
    protoField(26, 2, metadata),
    protoField(27, 0, 0),
    protoField(30, 2, messageIdRecord),
    protoField(35, 0, 0),
    protoField(38, 0, 0),
    protoField(46, 0, 1),
    protoField(47, 2, ""),
    protoField(48, 0, 0),
    protoField(49, 0, 0),
    protoField(51, 0, 0),
    protoField(53, 0, 1),
    protoField(54, 2, composerMode),
  ]);
  return protoMessage([protoField(1, 2, request)]);
};

const cursorChatEndpoint = function cursorChatEndpoint(env: Env): string {
  const endpoint = env.CURSOR_CHAT_ENDPOINT?.trim();
  if (!endpoint) {
    throw new HttpError(
      "Cursor chat endpoint is not configured",
      500,
      "cursor_missing_endpoint"
    );
  }
  return endpoint;
};

const base64Url = function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCodePoint(byte);
  }
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
};

const cursorChecksum = async function cursorChecksum(
  env: Env,
  cursorIdentity: string
): Promise<string> {
  const machineId = await sha256Hex(
    `${env.ENCRYPTION_KEY || "composer-api"}:cursor-machine:${cursorIdentity}`
  );
  const timestamp = BigInt(Math.floor(Date.now() / 1_000_000));
  const bytes = new Uint8Array([
    Number((timestamp / 281_474_976_710_656n) % 256n),
    Number((timestamp / 1_099_511_627_776n) % 256n),
    Number((timestamp / 4_294_967_296n) % 256n),
    Number((timestamp / 16_777_216n) % 256n),
    Number((timestamp / 65_536n) % 256n),
    Number(timestamp % 256n),
  ]);
  let t = 165;
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = (bitXor(bytes[i], t) + (i % 256)) % 256;
    t = bytes[i];
  }
  return `${base64Url(bytes)}${machineId}`;
};

const sessionId = async function sessionId(token: string): Promise<string> {
  const hashHex = await sha256Hex(token);
  const hash = hashHex.slice(0, 32);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20)}`;
};

const cursorInternalHeaders = async function cursorInternalHeaders(
  env: Env,
  accessToken: string,
  cursorIdentity: string,
  requestId: string
): Promise<Record<string, string>> {
  return {
    "Connect-Protocol-Version": "1",
    "Content-Type": "application/connect+proto",
    "User-Agent": "connect-es/1.6.1",
    "x-amzn-trace-id": `Root=${requestId}`,
    "x-client-key": await sha256Hex(accessToken),
    "x-cursor-checksum": await cursorChecksum(env, cursorIdentity),
    "x-cursor-client-arch": "x64",
    "x-cursor-client-device-type": "desktop",
    "x-cursor-client-os": "linux",
    "x-cursor-client-os-version": "unknown",
    "x-cursor-client-type": "ide",
    "x-cursor-client-version": env.CURSOR_CLIENT_VERSION || "2.6.22",
    "x-cursor-config-version": await stableUuid(
      "cursor-config",
      cursorIdentity
    ),
    "x-cursor-timezone": "UTC",
    "x-ghost-mode": "false",
    "x-new-onboarding-completed": "false",
    "x-request-id": requestId,
    "x-session-id": await sessionId(accessToken),
  };
};

/**
 * Create a Cursor completion stream for a prompt.
 * @param env - The configured runtime environment.
 * @param deps - Runtime dependencies used for network and time operations.
 * @param apiKey - The Cursor API key for this request.
 * @param input - The model and prompt to send.
 * @returns Completion identifiers and the response stream.
 */
export const createCursorCompletion = async function createCursorCompletion(
  env: Env,
  deps: Deps,
  apiKey: string,
  input: {
    prompt: CursorPrompt;
    model?: {
      id: string;
    };
    conversationKey?: string;
  }
): Promise<CursorCompletion> {
  const [images, cursorIdentity, accessToken] = await Promise.all([
    resolveCursorImages(input.prompt.images ?? [], deps),
    getCursorAccountIdentity(env, deps, apiKey),
    exchangeCursorApiKey(env, deps, apiKey),
  ]);
  const requestId = deps.randomUUID();
  const conversationId = input.conversationKey
    ? await stableUuid(
        "composer-api-conversation",
        `${cursorIdentity}:${input.conversationKey}`
      )
    : deps.randomUUID();
  const requestBody = encodeConnectFrame(
    encodeCursorChatRequest({
      conversationId,
      images,
      messageId: deps.randomUUID(),
      model: input.model?.id || "composer-2.5",
      prompt: input.prompt,
      requestId,
    })
  );
  const response = await cursorInternalRaw(
    env,
    deps,
    accessToken,
    cursorChatEndpoint(env),
    {
      body: new Uint8Array(requestBody).buffer,
      headers: await cursorInternalHeaders(
        env,
        accessToken,
        cursorIdentity,
        requestId
      ),
      method: "POST",
    }
  );
  return { conversationId, requestId, stream: response };
};

const legacyStreamResultText = function legacyStreamResultText(
  payload: JsonObject
): string {
  if (isString(payload.result)) {
    return payload.result;
  }
  if (isString(payload.text)) {
    return payload.text;
  }
  return "";
};

const yieldFlushedMarkerEvents = function* yieldFlushedMarkerEvents(
  flushed: ComposerToolMarkerEvent[],
  state: { text: string; toolCalls: CursorToolCall[] }
): Generator<CursorTextEvent> {
  for (const emitted of flushed) {
    if (emitted.type === "text") {
      state.text += emitted.text;
    } else {
      state.toolCalls.push(emitted.toolCall);
    }
    yield emitted;
  }
};

const handleLegacyInteractionUpdate = function* handleLegacyInteractionUpdate(
  payload: JsonObject,
  state: LegacyStreamState
): Generator<CursorTextEvent> {
  const { type } = payload;
  if (
    type === "text-delta" &&
    isString(payload.text) &&
    state.mode !== "assistant"
  ) {
    state.mode = "delta";
    const delta = stripComposerControlTokens(payload.text);
    if (delta) {
      yield* state.emit(delta);
    }
    return;
  }
  if (
    type === "summary" &&
    isString(payload.summary) &&
    !state.text &&
    state.mode === "unknown"
  ) {
    state.text = stripComposerControlTokens(payload.summary);
  }
};

interface LegacyStreamState {
  text: string;
  mode: "unknown" | "assistant" | "delta";
  emit: (value: string) => Generator<CursorTextEvent>;
}

interface LegacySseState extends LegacyStreamState {
  toolCalls: CursorToolCall[];
  toolMarkers: ReturnType<typeof createComposerToolCallFilter>;
}

const CURSOR_STREAM_FAILURE_MESSAGE = "Cursor stream failed";

const handleLegacySsePayload = function* handleLegacySsePayload(
  eventName: string,
  payload: JsonObject,
  state: LegacySseState
): Generator<CursorTextEvent, "continue" | "done"> {
  if (eventName === "interaction_update") {
    yield* handleLegacyInteractionUpdate(payload, state);
    return "continue";
  }
  if (
    eventName === "assistant" &&
    isString(payload.text) &&
    state.mode !== "delta"
  ) {
    state.mode = "assistant";
    const delta = stripComposerControlTokens(payload.text);
    if (delta) {
      yield* state.emit(delta);
    }
    return "continue";
  }
  if (eventName === "result") {
    const result = stripComposerControlTokens(legacyStreamResultText(payload));
    if (!state.text && result) {
      yield* state.emit(result);
    }
    yield* yieldFlushedMarkerEvents(state.toolMarkers.flush(), state);
    yield { finalText: state.text, toolCalls: state.toolCalls, type: "done" };
    return "done";
  }
  if (eventName === "error") {
    const message = isString(payload.message)
      ? payload.message
      : CURSOR_STREAM_FAILURE_MESSAGE;
    throw new HttpError(message, 502, "cursor_stream_error");
  }
  return "continue";
};

const streamLegacyAgentText = async function* streamLegacyAgentText(
  response: Response
): AsyncGenerator<CursorTextEvent> {
  const toolMarkers = createComposerToolCallFilter();
  const state: LegacySseState = {
    emit(value: string): Generator<CursorTextEvent> {
      return (function* emitGenerator() {
        for (const event of toolMarkers.push(value)) {
          if (event.type === "text") {
            state.text += event.text;
          } else {
            state.toolCalls.push(event.toolCall);
          }
          yield event;
        }
      })();
    },
    mode: "unknown",
    text: "",
    toolCalls: [],
    toolMarkers,
  };
  for await (const event of parseSse(response.body)) {
    if (event.event !== "done" && event.data) {
      let payload: JsonValue = null;
      try {
        payload = JSON.parse(event.data);
      } catch {
        payload = null;
      }
      const record = asJsonObject(payload);
      if (record) {
        const outcome = yield* handleLegacySsePayload(
          event.event ?? "",
          record,
          state
        );
        if (outcome === "done") {
          return;
        }
      }
    }
  }
  yield* yieldFlushedMarkerEvents(toolMarkers.flush(), state);
  yield { finalText: state.text, toolCalls: state.toolCalls, type: "done" };
};

const decodeUtf8 = function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
};

const detailFromCursorError = function detailFromCursorError(
  error: JsonObject
): string | undefined {
  const details = Array.isArray(error.details) ? error.details : [];
  for (const detail of details) {
    if (!isJsonObject(detail) || !isJsonObject(detail.debug)) {
      continue;
    }
    const debugDetails = isJsonObject(detail.debug.details)
      ? detail.debug.details
      : undefined;
    const titleValue = debugDetails?.title;
    const title =
      titleValue !== undefined && isString(titleValue) ? titleValue : "";
    const bodyValue = debugDetails?.detail;
    const body =
      bodyValue !== undefined && isString(bodyValue) ? bodyValue : "";
    const message = [title, body].filter(Boolean).join(" ");
    if (message) {
      return message;
    }
  }
  return undefined;
};

const cursorStreamErrorMessage = function cursorStreamErrorMessage(
  error: JsonObject
): string | undefined {
  const titleAndDetail = detailFromCursorError(error);
  if (titleAndDetail) {
    return titleAndDetail;
  }
  return isString(error.message) ? error.message : undefined;
};

const handleEndStreamFrame = function handleEndStreamFrame(
  payload: Uint8Array
) {
  if (!payload.length) {
    return;
  }
  const text = decodeUtf8(payload).trim();
  if (!text || text === "{}") {
    return;
  }
  try {
    const parsed: JsonValue = JSON.parse(text);
    const parsedRecord = asJsonObject(parsed);
    const parsedError = parsedRecord && asJsonObject(parsedRecord.error);
    if (parsedError) {
      const message =
        cursorStreamErrorMessage(parsedError) || CURSOR_STREAM_FAILURE_MESSAGE;
      throw new HttpError(message, 502, "cursor_stream_error");
    }
  } catch (error) {
    if (error instanceof HttpError) {
      throw error;
    }
  }
};

const parseConnectProtoFrames = async function* parseConnectProtoFrames(
  stream: ReadableStream<Uint8Array> | null
): AsyncGenerator<Uint8Array> {
  if (!stream) {
    return;
  }
  const reader = stream.getReader();
  let buffer = new Uint8Array(0);
  const readChunk = async (): Promise<Uint8Array | null> => {
    const { value, done } = await reader.read();
    if (done) {
      return null;
    }
    return value ?? new Uint8Array(0);
  };
  const drainFrames =
    async function* drainFrames(): AsyncGenerator<Uint8Array> {
      if (buffer.length < 5) {
        return;
      }
      const [flags] = buffer;
      const length = new DataView(
        buffer.buffer,
        buffer.byteOffset + 1,
        4
      ).getUint32(0, false);
      if (buffer.length < 5 + length) {
        return;
      }
      const payload = buffer.slice(5, 5 + length);
      buffer = buffer.slice(5 + length);
      if (connectFlagHas(flags, 1)) {
        throw new HttpError(
          "Cursor returned a compressed Connect frame that this Worker cannot decode.",
          502,
          "cursor_stream_error"
        );
      }
      if (connectFlagHas(flags, 2)) {
        handleEndStreamFrame(payload);
      } else {
        yield payload;
      }
      yield* drainFrames();
    };
  const pump = async function* pump(): AsyncGenerator<Uint8Array> {
    const chunk = await readChunk();
    if (chunk === null) {
      return;
    }
    if (chunk.length) {
      buffer = concatBytes(buffer, chunk);
    }
    yield* drainFrames();
    yield* pump();
  };
  try {
    yield* pump();
  } finally {
    reader.releaseLock();
  }
};

const readVarint = function readVarint(
  bytes: Uint8Array,
  startOffset: number
): VarintRead {
  let value = 0;
  let shift = 0;
  let offset = startOffset;
  while (offset < bytes.length) {
    const byte = bytes[offset];
    offset += 1;
    value += varintContribution(byte, shift);
    if (!hasHighBit(byte)) {
      return { offset, value };
    }
    shift += 7;
  }
  throw new Error("Unexpected end of protobuf varint");
};

interface VarintRead {
  value: number;
  offset: number;
}

const decodeProtobufFields = function decodeProtobufFields(
  bytes: Uint8Array
): ProtobufField[] {
  const fields: ProtobufField[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    const tag = readVarint(bytes, offset);
    ({ offset } = tag);
    const no = protoFieldNumber(tag.value);
    const wt = protoWireType(tag.value);
    if (wt === 0) {
      const value = readVarint(bytes, offset);
      ({ offset } = value);
      fields.push({ no, value: value.value, wt });
    } else if (wt === 2) {
      const length = readVarint(bytes, offset);
      ({ offset } = length);
      fields.push({
        no,
        value: bytes.slice(offset, offset + length.value),
        wt,
      });
      offset += length.value;
    } else if (wt === 1) {
      offset += 8;
    } else if (wt === 5) {
      offset += 4;
    } else {
      throw new Error(`Unsupported protobuf wire type ${wt}`);
    }
  }
  return fields;
};

const decodeBinaryToolCall = function decodeBinaryToolCall(
  _payload: Uint8Array
):
  | {
      toolCall: CursorToolCall;
    }
  | Record<string, never> {
  return {};
};

const decodeChatMessageFields = function decodeChatMessageFields(
  fieldValue: Uint8Array
): ChatMessageFields {
  let text = "";
  let thinking = "";
  for (const inner of decodeProtobufFields(fieldValue)) {
    if (inner.no === 1 && inner.wt === 2 && inner.value instanceof Uint8Array) {
      text += decodeUtf8(inner.value);
    }
    if (
      inner.no === 25 &&
      inner.wt === 2 &&
      inner.value instanceof Uint8Array
    ) {
      for (const thinkingField of decodeProtobufFields(inner.value)) {
        if (
          thinkingField.no === 1 &&
          thinkingField.wt === 2 &&
          thinkingField.value instanceof Uint8Array
        ) {
          thinking += decodeUtf8(thinkingField.value);
        }
      }
    }
  }
  return { text, thinking };
};

interface ChatMessageFields {
  text: string;
  thinking: string;
}

const decodeCursorChatFrame = function decodeCursorChatFrame(
  payload: Uint8Array
): DecodedCursorChatFrame {
  try {
    for (const field of decodeProtobufFields(payload)) {
      if (field.no === 1) {
        const decodedToolCall =
          field.value instanceof Uint8Array
            ? decodeBinaryToolCall(field.value)
            : {};
        return {
          type: "tool_call",
          ...decodedToolCall,
        };
      }
      if (
        field.no !== 2 ||
        field.wt !== 2 ||
        !(field.value instanceof Uint8Array)
      ) {
        continue;
      }
      const { text, thinking } = decodeChatMessageFields(field.value);
      if (text) {
        return { text, type: "text" };
      }
      if (thinking) {
        return { text: thinking, type: "thinking" };
      }
    }
    return { type: "ignore" };
  } catch (error) {
    return {
      message:
        error instanceof Error
          ? error.message
          : "Failed to decode Cursor stream",
      type: "error",
    };
  }
};

interface DecodedCursorChatFrame {
  type: string;
  message?: string;
  text?: string;
  toolCall?: CursorToolCall;
}

interface CursorStreamState {
  text: string;
  toolCalls: CursorToolCall[];
}

const yieldCursorMarkerEvents = function* yieldCursorMarkerEvents(
  events: ComposerToolMarkerEvent[],
  state: CursorStreamState
): Generator<CursorTextEvent> {
  for (const event of events) {
    if (event.type === "text") {
      state.text += event.text;
    } else {
      state.toolCalls.push(event.toolCall);
    }
    yield event;
  }
};

const emitCursorText = function* emitCursorText(
  value: string,
  output: ReturnType<typeof createComposerOutputFilter>,
  toolMarkers: ReturnType<typeof createComposerToolCallFilter>,
  state: CursorStreamState
): Generator<CursorTextEvent> {
  for (const delta of output.push(value)) {
    yield* yieldCursorMarkerEvents(toolMarkers.push(delta), state);
  }
};

const handleDecodedCursorFrame = function* handleDecodedCursorFrame(
  event: DecodedCursorChatFrame,
  thinking: ReturnType<typeof createThinkingTextExtractor>,
  emit: (value: string) => Generator<CursorTextEvent>,
  state: CursorStreamState
): Generator<CursorTextEvent> {
  if (event.type === "error") {
    throw new HttpError(
      event.message ?? CURSOR_STREAM_FAILURE_MESSAGE,
      502,
      "cursor_stream_error"
    );
  }
  if (event.type === "tool_call") {
    if (event.toolCall) {
      state.toolCalls.push(event.toolCall);
      yield { toolCall: event.toolCall, type: "tool_call" };
    }
    return;
  }
  if (event.type === "text" && event.text) {
    yield* emit(event.text);
  }
  if (event.type === "thinking" && event.text) {
    for (const delta of thinking.push(event.text)) {
      yield* emit(delta);
    }
  }
};

/**
 * Decode the response into text and tool-call events.
 * @param response - The Cursor completion response.
 * @returns Events decoded from the response stream.
 */
export const streamCursorText = async function* streamCursorText(
  response: Response
): AsyncGenerator<CursorTextEvent> {
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("application/connect+proto")) {
    yield* streamLegacyAgentText(response);
    return;
  }
  const state: CursorStreamState = { text: "", toolCalls: [] };
  const thinking = createThinkingTextExtractor();
  const output = createComposerOutputFilter();
  const toolMarkers = createComposerToolCallFilter();
  const emit = (value: string) =>
    emitCursorText(value, output, toolMarkers, state);
  for await (const frame of parseConnectProtoFrames(response.body)) {
    yield* handleDecodedCursorFrame(
      decodeCursorChatFrame(frame),
      thinking,
      emit,
      state
    );
  }
  const flushed = thinking.flush();
  if (flushed) {
    yield* emit(flushed);
  }
  for (const delta of output.flush()) {
    yield* yieldCursorMarkerEvents(toolMarkers.push(delta), state);
  }
  yield* yieldCursorMarkerEvents(toolMarkers.flush(), state);
  yield { finalText: state.text, toolCalls: state.toolCalls, type: "done" };
};

/**
 * Collect the text and tool calls from a Cursor completion response.
 * @param response - The Cursor completion response.
 * @returns The collected text and tool calls.
 */
export const collectCursorOutput = async function collectCursorOutput(
  response: Response
): Promise<CursorCollectedOutput> {
  let text = "";
  let toolCalls: CursorToolCall[] = [];
  for await (const event of streamCursorText(response)) {
    if (event.type === "text" && event.text) {
      text += event.text;
    }
    if (event.type === "tool_call") {
      toolCalls.push(event.toolCall);
    }
    if (event.type === "done") {
      text = event.finalText;
      ({ toolCalls } = event);
    }
  }
  return { text, toolCalls };
};
