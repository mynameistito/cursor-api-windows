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
} from "./types";

interface CursorModelResponse {
  items?: {
    id: string;
    displayName?: string;
    aliases?: string[];
  }[];
}

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

const INLINE_TOOL_ARG_PATTERN =
  /^(?<key>[A-Za-z0-9_.-]+)\s*[:=]\s*(?<value>[\s\S]*)$/u;

const INLINE_TOOL_CALL_PATTERN =
  /^(?<name>[A-Za-z0-9_.-]+)\s*(?:\((?<paren>[\s\S]*)\)|\[(?<bracket>[\s\S]*)\])?$/u;

const TOOL_PART_KEY_VALUE_PATTERN =
  /^(?<key>[^\r\n]+)(?:\r?\n(?<value>[\s\S]*))?$/u;

const CANONICAL_TOOL_MARKER_PATTERN =
  /<\s*[|｜]\s*(?<marker>tool[_▁]calls[_▁]begin|tool[_▁]calls[_▁]end|tool[_▁]call[_▁]begin|tool[_▁]call[_▁]end|tool[_▁]sep)\s*[|｜]\s*>/gu;

const COMPOSER_TOOL_MARKER_PATTERN = (marker: string) =>
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

const isRecord = function isRecord(
  value: unknown
): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
};

const canonicalizeComposerToolMarkers =
  function canonicalizeComposerToolMarkers(value: string): string {
    return value.replaceAll(CANONICAL_TOOL_MARKER_PATTERN, (_match, marker) => {
      const normalizedMarker =
        typeof marker === "string" ? marker.replaceAll("▁", "_") : "";
      return `<|${normalizedMarker}|>`;
    });
  };

const firstString = function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return null;
};

const recordFromToolArguments = function recordFromToolArguments(
  value: unknown
): Record<string, unknown> | null {
  if (isRecord(value)) {
    return value;
  }
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  try {
    const decoded = JSON.parse(value) as unknown;
    return isRecord(decoded) ? decoded : null;
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
    const parsed = JSON.parse(value) as unknown;
    if (!isRecord(parsed)) {
      return null;
    }
    const fn = isRecord(parsed.function) ? parsed.function : undefined;
    const name = firstString(
      parsed.name,
      parsed.tool,
      parsed.tool_name,
      parsed.toolName,
      fn?.name
    );
    if (!name) {
      return null;
    }
    const rawArguments =
      parsed.arguments ??
      parsed.args ??
      parsed.input ??
      parsed.parameters ??
      parsed.params ??
      fn?.arguments;
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
  let quote: string | null = null;
  let depth = 0;
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    if (quote) {
      if (char === quote && value[i - 1] !== "\\") {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "{" || char === "[") {
      depth += 1;
    }
    if (char === "}" || char === "]") {
      depth = Math.max(0, depth - 1);
    }
    if (char === "," && depth === 0) {
      parts.push(value.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(value.slice(start));
  return parts;
};

const parseComposerToolArgument = function parseComposerToolArgument(
  value: string
): unknown {
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
      return JSON.parse(value) as unknown;
    } catch {
      return value;
    }
  }
  return value;
};

const parseInlineToolArguments = function parseInlineToolArguments(
  value: string
): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const part of splitInlineArguments(value)) {
    const match = INLINE_TOOL_ARG_PATTERN.exec(part.trim());
    if (!match?.groups?.key || match.groups.value === undefined) {
      continue;
    }
    args[match.groups.key] = parseComposerToolArgument(
      match.groups.value.trim()
    );
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
  const args: Record<string, unknown> = {};
  for (const part of parts) {
    const trimmed = part.replace(LEADING_WHITESPACE_PATTERN, "");
    if (!trimmed) {
      continue;
    }
    const match = TOOL_PART_KEY_VALUE_PATTERN.exec(trimmed);
    if (!match?.groups?.key) {
      continue;
    }
    const key = match.groups.key.trim();
    if (!key) {
      continue;
    }
    const rawValue = (match.groups.value || "").trim();
    args[key] = parseComposerToolArgument(rawValue);
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
  for (;;) {
    const start = body.indexOf(TOOL_CALL_BEGIN, offset);
    if (start === -1) {
      break;
    }
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
  const match = COMPOSER_TOOL_MARKER_PATTERN(marker).exec(value);
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

const createComposerToolCallFilter = function createComposerToolCallFilter() {
  let buffer = "";
  const drain = function drain(force: boolean): ComposerToolMarkerEvent[] {
    const events: ComposerToolMarkerEvent[] = [];
    for (;;) {
      const begin = findComposerToolMarker(buffer, "tool_calls_begin");
      if (!begin) {
        if (!buffer.trim()) {
          if (force) {
            buffer = "";
          }
          break;
        }
        const prefixIndex = force ? -1 : toolMarkerPrefixIndex(buffer);
        if (prefixIndex !== -1) {
          const visible = buffer.slice(0, prefixIndex);
          if (visible.trim()) {
            events.push({ text: visible, type: "text" });
          }
          buffer = buffer.slice(prefixIndex);
          break;
        }
        const visible = buffer;
        if (visible) {
          events.push({ text: visible, type: "text" });
        }
        buffer = "";
        break;
      }
      if (begin.index > 0) {
        const before = buffer.slice(0, begin.index);
        if (before.trim()) {
          events.push({ text: before, type: "text" });
        }
        buffer = buffer.slice(begin.index);
        continue;
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
        break;
      }
      const blockEnd = begin.length + end.index + end.length;
      const block = buffer.slice(0, blockEnd);
      for (const toolCall of parseComposerToolCalls(block)) {
        events.push({ toolCall, type: "tool_call" });
      }
      buffer = buffer.slice(blockEnd).replace(LEADING_WHITESPACE_PATTERN, "");
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
    const payload = JSON.parse(text) as unknown;
    if (isRecord(payload)) {
      const error = isRecord(payload.error) ? payload.error : payload;
      if (typeof error.message === "string") {
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
    const text = await response.text().catch(() => "");
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
  init: {
    method?: string;
    body?: unknown;
    idempotencyKey?: string;
  } = {}
): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(init.idempotencyKey ? { "Idempotency-Key": init.idempotencyKey } : {}),
  };
  const response = await cursorPublicRaw(env, deps, apiKey, path, {
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    headers,
    method: init.method || "GET",
  });
  return response.json() as Promise<T>;
};

export const verifyCursorApiKey = function verifyCursorApiKey(
  env: Env,
  deps: Deps,
  apiKey: string
): Promise<CursorMe> {
  return cursorPublicJson<CursorMe>(env, deps, apiKey, "/v1/me");
};

export const listCursorModels = function listCursorModels(
  env: Env,
  deps: Deps,
  apiKey: string
): Promise<CursorModelResponse> {
  return cursorPublicJson<CursorModelResponse>(env, deps, apiKey, "/v1/models");
};

export const resolveCursorModel = function resolveCursorModel(model: unknown):
  | {
      id: string;
    }
  | undefined {
  if (typeof model !== "string" || !model.trim()) {
    return { id: "composer-2.5" };
  }
  const normalized = model.trim().toLowerCase();
  if (
    normalized === "composer-2.5" ||
    normalized === "composer-2-5" ||
    normalized === "composer-2.5-sdk" ||
    normalized === "composer-latest"
  ) {
    return { id: "composer-2.5" };
  }
  if (
    normalized === "composer-2.5-fast" ||
    normalized === "composer-2-5-fast"
  ) {
    return { id: "composer-2.5-fast" };
  }
  if (normalized === "auto" || normalized === "default") {
    return { id: "composer-2.5" };
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
  return typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `image-${Date.now()}-${index}`;
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
      return {
        data,
        uuid: image.uuid || stableImageId(index),
        ...("dimension" in image && image.dimension
          ? { dimension: image.dimension }
          : {}),
      };
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
  if (typeof me.userId === "number") {
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
  const url = ABSOLUTE_URL_PATTERN.test(path)
    ? path
    : `${base.replace(TRAILING_SLASH_PATTERN, "")}${path.startsWith("/") ? path : `/${path}`}`;
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  const response = await deps.fetch(url, { ...init, headers });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    const parsed = parseCursorError(text);
    const message =
      response.status === 401
        ? "Invalid Cursor API key"
        : parsed ||
          (response.status === 464
            ? "Cursor rejected the proxied chat request. The proxy request is valid, but Cursor refused this account/session."
            : `Cursor internal API request failed with status ${response.status}`);
    const status = mapCursorInternalHttpStatus(response.status);
    throw new HttpError(
      message,
      status,
      response.status === 401 ? "cursor_unauthorized" : "cursor_api_error"
    );
  }
  return response;
};

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
  const payload = (await response.json()) as CursorAccessTokenResponse;
  if (!payload.accessToken) {
    throw new HttpError(
      "Cursor did not return an internal access token",
      502,
      "cursor_bad_response"
    );
  }
  return payload.accessToken;
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
    return concatBytes(tag, encodeVarint(value as number));
  }
  let bytes: Uint8Array;
  if (typeof value === "string") {
    bytes = new TextEncoder().encode(value);
  } else if (value instanceof Uint8Array) {
    bytes = value;
  } else {
    bytes = encodeVarint(value);
  }
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
  const images = await resolveCursorImages(input.prompt.images ?? [], deps);
  const cursorIdentity = await getCursorAccountIdentity(env, deps, apiKey);
  const accessToken = await exchangeCursorApiKey(env, deps, apiKey);
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
      body: requestBody.buffer as ArrayBuffer,
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
  payload: Record<string, unknown>
): string {
  if (typeof payload.result === "string") {
    return payload.result;
  }
  if (typeof payload.text === "string") {
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
      yield emitted;
    } else {
      state.toolCalls.push(emitted.toolCall);
      yield emitted;
    }
  }
};

const handleLegacyInteractionUpdate = function* handleLegacyInteractionUpdate(
  payload: Record<string, unknown>,
  state: {
    text: string;
    mode: "unknown" | "assistant" | "delta";
    emit: (value: string) => Generator<CursorTextEvent>;
  }
): Generator<CursorTextEvent> {
  const { type } = payload;
  if (
    type === "text-delta" &&
    typeof payload.text === "string" &&
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
    typeof payload.summary === "string" &&
    !state.text &&
    state.mode === "unknown"
  ) {
    state.text = stripComposerControlTokens(payload.summary);
  }
};

const handleLegacySsePayload = function* handleLegacySsePayload(
  eventName: string,
  payload: unknown,
  state: {
    text: string;
    toolCalls: CursorToolCall[];
    mode: "unknown" | "assistant" | "delta";
    emit: (value: string) => Generator<CursorTextEvent>;
    toolMarkers: ReturnType<typeof createComposerToolCallFilter>;
  }
): Generator<CursorTextEvent, "continue" | "done"> {
  if (eventName === "interaction_update" && isRecord(payload)) {
    yield* handleLegacyInteractionUpdate(payload, state);
    return "continue";
  }
  if (
    eventName === "assistant" &&
    isRecord(payload) &&
    typeof payload.text === "string" &&
    state.mode !== "delta"
  ) {
    state.mode = "assistant";
    const delta = stripComposerControlTokens(payload.text);
    if (delta) {
      yield* state.emit(delta);
    }
    return "continue";
  }
  if (eventName === "result" && isRecord(payload)) {
    const result = stripComposerControlTokens(legacyStreamResultText(payload));
    if (!state.text && result) {
      yield* state.emit(result);
    }
    yield* yieldFlushedMarkerEvents(state.toolMarkers.flush(), state);
    yield { finalText: state.text, toolCalls: state.toolCalls, type: "done" };
    return "done";
  }
  if (eventName === "error" && isRecord(payload)) {
    const message =
      typeof payload.message === "string"
        ? payload.message
        : "Cursor stream failed";
    throw new HttpError(message, 502, "cursor_stream_error");
  }
  return "continue";
};

const streamLegacyAgentText = async function* streamLegacyAgentText(
  response: Response
): AsyncGenerator<CursorTextEvent> {
  const toolMarkers = createComposerToolCallFilter();
  const state = {
    emit(value: string): Generator<CursorTextEvent> {
      return (function* emitGenerator() {
        for (const event of toolMarkers.push(value)) {
          if (event.type === "text") {
            state.text += event.text;
            yield event;
          } else {
            state.toolCalls.push(event.toolCall);
            yield event;
          }
        }
      })();
    },
    mode: "unknown" as "unknown" | "assistant" | "delta",
    text: "",
    toolCalls: [] as CursorToolCall[],
    toolMarkers,
  };
  for await (const event of parseSse(response.body)) {
    if (event.event === "done") {
      break;
    }
    if (!event.data) {
      continue;
    }
    let payload: unknown;
    try {
      payload = JSON.parse(event.data);
    } catch {
      continue;
    }
    const outcome = yield* handleLegacySsePayload(
      event.event ?? "",
      payload,
      state
    );
    if (outcome === "done") {
      return;
    }
  }
  yield* yieldFlushedMarkerEvents(toolMarkers.flush(), state);
  yield { finalText: state.text, toolCalls: state.toolCalls, type: "done" };
};

const decodeUtf8 = function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
};

const detailFromCursorError = function detailFromCursorError(
  error: Record<string, unknown>
): string | undefined {
  const details = Array.isArray(error.details) ? error.details : [];
  for (const detail of details) {
    if (!isRecord(detail) || !isRecord(detail.debug)) {
      continue;
    }
    const debugDetails = isRecord(detail.debug.details)
      ? detail.debug.details
      : undefined;
    const title =
      typeof debugDetails?.title === "string" ? debugDetails.title : "";
    const body =
      typeof debugDetails?.detail === "string" ? debugDetails.detail : "";
    const message = [title, body].filter(Boolean).join(" ");
    if (message) {
      return message;
    }
  }
  return undefined;
};

const cursorStreamErrorMessage = function cursorStreamErrorMessage(
  error: unknown
): string | undefined {
  if (!isRecord(error)) {
    return undefined;
  }
  const titleAndDetail = detailFromCursorError(error);
  if (titleAndDetail) {
    return titleAndDetail;
  }
  return typeof error.message === "string" ? error.message : undefined;
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
    const parsed = JSON.parse(text) as unknown;
    if (isRecord(parsed) && isRecord(parsed.error)) {
      const message =
        cursorStreamErrorMessage(parsed.error) || "Cursor stream failed";
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
): {
  value: number;
  offset: number;
} {
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
): {
  text: string;
  thinking: string;
} {
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

const decodeCursorChatFrame = function decodeCursorChatFrame(
  payload: Uint8Array
):
  | {
      type: "text";
      text: string;
    }
  | {
      type: "thinking";
      text: string;
    }
  | {
      type: "tool_call";
      toolCall?: CursorToolCall;
    }
  | {
      type: "ignore";
    }
  | {
      type: "error";
      message: string;
    } {
  try {
    for (const field of decodeProtobufFields(payload)) {
      if (field.no === 1) {
        return {
          type: "tool_call",
          ...(field.value instanceof Uint8Array
            ? decodeBinaryToolCall(field.value)
            : {}),
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

export const streamCursorText = async function* streamCursorText(
  response: Response
): AsyncGenerator<CursorTextEvent> {
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("application/connect+proto")) {
    yield* streamLegacyAgentText(response);
    return;
  }
  let text = "";
  const toolCalls: CursorToolCall[] = [];
  const thinking = createThinkingTextExtractor();
  const output = createComposerOutputFilter();
  const toolMarkers = createComposerToolCallFilter();
  const emit = function* emit(value: string): Generator<CursorTextEvent> {
    for (const delta of output.push(value)) {
      for (const event of toolMarkers.push(delta)) {
        if (event.type === "text") {
          text += event.text;
          yield event;
        } else {
          toolCalls.push(event.toolCall);
          yield event;
        }
      }
    }
  };
  for await (const frame of parseConnectProtoFrames(response.body)) {
    const event = decodeCursorChatFrame(frame);
    if (event.type === "error") {
      throw new HttpError(event.message, 502, "cursor_stream_error");
    }
    if (event.type === "tool_call") {
      if (event.toolCall) {
        toolCalls.push(event.toolCall);
        yield { toolCall: event.toolCall, type: "tool_call" };
      }
      continue;
    }
    if (event.type === "text" && event.text) {
      yield* emit(event.text);
    }
    if (event.type === "thinking" && event.text) {
      for (const delta of thinking.push(event.text)) {
        yield* emit(delta);
      }
    }
  }
  const flushed = thinking.flush();
  if (flushed) {
    yield* emit(flushed);
  }
  for (const delta of output.flush()) {
    for (const event of toolMarkers.push(delta)) {
      if (event.type === "text") {
        text += event.text;
        yield event;
      } else {
        toolCalls.push(event.toolCall);
        yield event;
      }
    }
  }
  for (const event of toolMarkers.flush()) {
    if (event.type === "text") {
      text += event.text;
      yield event;
    } else {
      toolCalls.push(event.toolCall);
      yield event;
    }
  }
  yield { finalText: text, toolCalls, type: "done" };
};

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

export const collectCursorText = async function collectCursorText(
  response: Response
): Promise<string> {
  const output = await collectCursorOutput(response);
  return output.text;
};

export const cursorTestExports = {
  encodeCursorChatRequest,
  parseComposerToolCalls,
};
