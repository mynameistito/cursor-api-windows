import { once } from "node:events";

import { sha256Hex } from "./crypto";
import { exchangeCursorApiKey } from "./cursor";
import type { CursorCollectedOutput, CursorTextEvent } from "./cursor";
import { HttpError } from "./http";
import {
  connectFlagHas,
  hasHighBit,
  low7Bits,
  protoFieldNumber,
  protoTag,
  protoWireType,
  toUint32,
  varintContribution,
} from "./proto-bits";
import type { CursorImage, CursorToolCall, Deps, Env } from "./types";

interface CursorSdkSession {
  agentId: string;
  updatedAt: number;
}

interface CursorSdkCompletion {
  agentId: string;
  runId: string;
  stream: AsyncGenerator<CursorTextEvent>;
}

interface CursorSdkBridgeOutput {
  text?: string;
  toolCalls?: CursorToolCall[];
  agentID?: string;
  runID?: string;
  status?: string;
}

interface ClientToolSpec {
  name: string;
  description?: string;
  parameters?: unknown;
}

type ToolCallDecision = boolean | string;

interface ProtobufField {
  no: number;
  wt: number;
  value: number | Uint8Array;
}

type LocalSdkDecodedEvent =
  | {
      type: "text";
      text: string;
    }
  | {
      type: "tool_call";
      id: string;
      toolCall: CursorToolCall;
    }
  | {
      type: "request_context";
      id: number;
      execId?: string;
    }
  | {
      type: "done";
    }
  | {
      type: "ignore";
    };

type ArgsKind =
  | "delete"
  | "edit"
  | "glob"
  | "grep"
  | "ls"
  | "mcp"
  | "readExec"
  | "readLints"
  | "readTool"
  | "semSearch"
  | "shell"
  | "write";

interface ToolSpec {
  name: string;
  argsKind: ArgsKind;
}

const sdkSessions = new Map<string, CursorSdkSession>();

const SDK_SESSION_TTL_MS = 6 * 60 * 60 * 1000;

const AGENT_MODE_AGENT = 1;

const DEFAULT_SDK_CLIENT_VERSION = "sdk-1.0.13";

const SDK_STREAM_START_TIMEOUT_MS = 25_000;

const DEFAULT_SDK_BRIDGE_REQUEST_TIMEOUT_MS = 180_000;

const SDK_GLOB_IN_PATH_PATTERN = /[*?[\]{}]/u;

const TRAILING_SLASH_PATTERN = /\/$/u;

const ABSOLUTE_URL_PATTERN = /^https?:\/\//u;

const SDK_TOOL_RETRY_ATTEMPTS = 3;

const ignoreError = function ignoreError() {
  void 0;
};

const mapSdkBridgeHttpStatus = function mapSdkBridgeHttpStatus(
  responseStatus: number
): number {
  if (responseStatus === 401) {
    return 502;
  }
  if (responseStatus === 429) {
    return 429;
  }
  if (responseStatus >= 500) {
    return 502;
  }
  return 400;
};

const mapCursorSdkHttpStatus = function mapCursorSdkHttpStatus(
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

const TOOL_CALL_SPECS: Record<number, ToolSpec> = {
  1: { argsKind: "shell", name: "shell" },
  12: { argsKind: "edit", name: "edit" },
  13: { argsKind: "ls", name: "ls" },
  14: { argsKind: "readLints", name: "readLints" },
  15: { argsKind: "mcp", name: "mcp" },
  16: { argsKind: "semSearch", name: "semSearch" },
  3: { argsKind: "delete", name: "delete" },
  4: { argsKind: "glob", name: "glob" },
  5: { argsKind: "grep", name: "grep" },
  8: { argsKind: "readTool", name: "read" },
};

const EXEC_TOOL_SPECS: Record<number, ToolSpec> = {
  11: { argsKind: "mcp", name: "mcp" },
  14: { argsKind: "shell", name: "shell" },
  2: { argsKind: "shell", name: "shell" },
  3: { argsKind: "write", name: "write" },
  4: { argsKind: "delete", name: "delete" },
  5: { argsKind: "grep", name: "grep" },
  7: { argsKind: "readExec", name: "read" },
  8: { argsKind: "ls", name: "ls" },
  9: { argsKind: "readLints", name: "readLints" },
};

const pruneSessions = function pruneSessions(now: number) {
  for (const [key, session] of sdkSessions) {
    if (session.updatedAt + SDK_SESSION_TTL_MS < now) {
      sdkSessions.delete(key);
    }
  }
};

const sdkSessionIdentity = async function sdkSessionIdentity(
  apiKey: string,
  sessionKey: string,
  sessionOwnerKey?: string
): Promise<{
  id: string;
  ownerHash: string;
  sessionHash: string;
}> {
  const ownerHash = await sha256Hex(
    sessionOwnerKey || `cursor-key:${await sha256Hex(apiKey)}`
  );
  const sessionHash = await sha256Hex(sessionKey);
  return {
    id: await sha256Hex(`${ownerHash}\n${sessionHash}`),
    ownerHash,
    sessionHash,
  };
};

const deletePersistedSdkSession = async function deletePersistedSdkSession(
  env: Env,
  id: string
): Promise<void> {
  try {
    await env.DB.prepare(`DELETE FROM sdk_sessions WHERE id = ?`)
      .bind(id)
      .run();
  } catch {
    // Ignore missing table or transient persistence failures.
  }
};

const readPersistedSdkSession = async function readPersistedSdkSession(
  env: Env,
  id: string,
  now: number
): Promise<CursorSdkSession | undefined> {
  try {
    const row = await env.DB.prepare(
      `SELECT agent_id, updated_at FROM sdk_sessions WHERE id = ? LIMIT 1`
    )
      .bind(id)
      .first<{
        agent_id: string;
        updated_at: string;
      }>();
    if (!row?.agent_id) {
      return undefined;
    }
    const updatedAt = Date.parse(row.updated_at);
    if (!Number.isFinite(updatedAt) || updatedAt + SDK_SESSION_TTL_MS < now) {
      await deletePersistedSdkSession(env, id);
      return undefined;
    }
    const session = { agentId: row.agent_id, updatedAt };
    sdkSessions.set(id, session);
    return session;
  } catch {
    return undefined;
  }
};

const newLocalSdkAgentId = function newLocalSdkAgentId(uuid: string): string {
  return uuid.startsWith("agent-") ? uuid : `agent-${uuid}`;
};

const newLocalSdkRunId = function newLocalSdkRunId(uuid: string): string {
  return uuid.startsWith("run-") ? uuid : `run-${uuid}`;
};

const savePersistedSdkSession = async function savePersistedSdkSession(
  env: Env,
  identity: {
    id: string;
    ownerHash: string;
    sessionHash: string;
  },
  agentId: string,
  updatedAt: Date
): Promise<void> {
  try {
    const timestamp = updatedAt.toISOString();
    await env.DB.prepare(`INSERT INTO sdk_sessions (id, owner_hash, session_hash, agent_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         agent_id = excluded.agent_id,
         updated_at = excluded.updated_at`)
      .bind(
        identity.id,
        identity.ownerHash,
        identity.sessionHash,
        agentId,
        timestamp,
        timestamp
      )
      .run();
  } catch {
    // D1 persistence is best-effort so local development without migrations still works.
  }
};

const sdkPrompt = function sdkPrompt(prompt: {
  text: string;
  images?: CursorImage[];
}): string {
  if (!prompt.images?.length) {
    return prompt.text;
  }
  return `${prompt.text}\n\n[${prompt.images.length} image input${prompt.images.length === 1 ? "" : "s"} attached by the OpenAI-compatible client.]`;
};

const hasCursorSdkBridge = function hasCursorSdkBridge(env: Env): boolean {
  return Boolean(
    env.CURSOR_SDK_BRIDGE_CONTAINER || env.CURSOR_SDK_BRIDGE_URL?.trim()
  );
};

const bridgeClientTools = function bridgeClientTools(
  tools: ClientToolSpec[] | undefined
): ClientToolSpec[] {
  return (tools ?? []).flatMap((tool) => {
    const name = typeof tool.name === "string" ? tool.name.trim() : "";
    if (!name) {
      return [];
    }
    return [
      {
        name,
        ...(typeof tool.description === "string" && tool.description
          ? { description: tool.description }
          : {}),
        ...(tool.parameters === undefined
          ? {}
          : { parameters: tool.parameters }),
      },
    ];
  });
};

const sdkWorkingDirectory = function sdkWorkingDirectory(
  value: string | undefined
): string {
  const trimmed = value?.trim();
  if (
    !trimmed ||
    trimmed.toLowerCase() === "undefined" ||
    trimmed.toLowerCase() === "null"
  ) {
    return ".";
  }
  return trimmed;
};

const cursorLocalSdkBridgeTimeoutMs = function cursorLocalSdkBridgeTimeoutMs(
  env: Env
): number {
  const value = Number.parseInt(env.CURSOR_SDK_BRIDGE_TIMEOUT_MS || "", 10);
  return Number.isFinite(value) && value > 0
    ? value
    : DEFAULT_SDK_BRIDGE_REQUEST_TIMEOUT_MS;
};

const withCursorLocalSdkBridgeTimeout =
  async function withCursorLocalSdkBridgeTimeout<T>(
    env: Env,
    run: (signal: AbortSignal) => Promise<T>
  ): Promise<T> {
    const timeoutMs = cursorLocalSdkBridgeTimeoutMs(env);
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    try {
      return await run(timeoutSignal);
    } catch (error) {
      if (timeoutSignal.aborted) {
        throw new HttpError(
          "Cursor SDK bridge request timed out.",
          504,
          "cursor_sdk_bridge_timeout"
        );
      }
      throw error;
    }
  };

const cursorLocalSdkBridgeHeaders = function cursorLocalSdkBridgeHeaders(
  env: Env
): Headers {
  const headers = new Headers({
    "Content-Type": "application/json",
  });
  if (env.CURSOR_SDK_BRIDGE_TOKEN?.trim()) {
    headers.set(
      "Authorization",
      `Bearer ${env.CURSOR_SDK_BRIDGE_TOKEN.trim()}`
    );
  }
  return headers;
};

const cursorLocalSdkContainerBridgeJson =
  function cursorLocalSdkContainerBridgeJson(
    env: Env,
    bridgeBinding: DurableObjectNamespace,
    body: string,
    signal?: AbortSignal
  ): Promise<Response> {
    const bridgeId = bridgeBinding.idFromName("shared");
    const bridge = bridgeBinding.get(bridgeId);
    return bridge.fetch("http://cursor-sdk-bridge.local/sdk", {
      body,
      headers: cursorLocalSdkBridgeHeaders(env),
      method: "POST",
      signal,
    });
  };

const cursorLocalSdkUrlBridgeJson = function cursorLocalSdkUrlBridgeJson(
  env: Env,
  deps: Deps,
  bridgeUrl: string,
  body: string,
  signal?: AbortSignal
): Promise<Response> {
  return deps.fetch(bridgeUrl, {
    body,
    headers: cursorLocalSdkBridgeHeaders(env),
    method: "POST",
    signal,
  });
};

const isRecord = function isRecord(
  value: unknown
): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
};

const cursorToolCallFromJson = function cursorToolCallFromJson(
  value: unknown
): CursorToolCall[] {
  if (
    !isRecord(value) ||
    typeof value.name !== "string" ||
    !value.name.trim()
  ) {
    return [];
  }
  return [
    {
      arguments: isRecord(value.arguments) ? value.arguments : {},
      name: value.name.trim(),
    },
  ];
};

const bridgeErrorFromResponse = function bridgeErrorFromResponse(
  response: Response,
  object: unknown
): never {
  const error =
    isRecord(object) && isRecord(object.error) ? object.error : undefined;
  const message =
    typeof error?.message === "string" && error.message
      ? error.message
      : `Cursor SDK bridge failed with status ${response.status}`;
  const code =
    typeof error?.code === "string" && error.code
      ? error.code
      : "cursor_sdk_bridge_error";
  throw new HttpError(message, mapSdkBridgeHttpStatus(response.status), code);
};

const parseBridgeJsonObject = function parseBridgeJsonObject(
  text: string
): unknown {
  if (!text.trim()) {
    return {};
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(
      "Cursor SDK bridge returned invalid JSON",
      502,
      "cursor_sdk_bridge_invalid_json"
    );
  }
};

const parseCursorLocalSdkBridgeJsonResponse =
  async function parseCursorLocalSdkBridgeJsonResponse(
    response: Response
  ): Promise<CursorSdkBridgeOutput> {
    const text = await response.text().catch(() => "");
    const object = parseBridgeJsonObject(text);
    if (!response.ok) {
      bridgeErrorFromResponse(response, object);
    }
    if (!isRecord(object)) {
      throw new HttpError(
        "Cursor SDK bridge returned invalid JSON",
        502,
        "cursor_sdk_bridge_invalid_json"
      );
    }
    return {
      agentID: typeof object.agentID === "string" ? object.agentID : undefined,
      runID: typeof object.runID === "string" ? object.runID : undefined,
      status: typeof object.status === "string" ? object.status : undefined,
      text: typeof object.text === "string" ? object.text : "",
      toolCalls: Array.isArray(object.toolCalls)
        ? object.toolCalls.flatMap(cursorToolCallFromJson)
        : [],
    };
  };

const cursorLocalSdkBridgeJson = async function cursorLocalSdkBridgeJson(
  env: Env,
  deps: Deps,
  apiKey: string,
  input: {
    agentId: string;
    runId: string;
    sessionKey: string;
    prompt: string;
    modelId: string;
    workingDirectory?: string;
    clientTools?: ClientToolSpec[];
    incrementalPrompt?: string;
  }
): Promise<CursorSdkBridgeOutput> {
  const body = JSON.stringify({
    apiKey,
    incrementalPrompt: input.incrementalPrompt,
    model: input.modelId,
    prompt: input.prompt,
    requestId: input.runId,
    sessionKey: input.sessionKey || input.agentId,
    tools: bridgeClientTools(input.clientTools),
    workingDirectory: sdkWorkingDirectory(input.workingDirectory),
  });
  const bridgeBinding = env.CURSOR_SDK_BRIDGE_CONTAINER;
  const bridgeUrl = env.CURSOR_SDK_BRIDGE_URL?.trim();
  const response = await withCursorLocalSdkBridgeTimeout(env, (signal) => {
    if (bridgeBinding) {
      return cursorLocalSdkContainerBridgeJson(
        env,
        bridgeBinding,
        body,
        signal
      );
    }
    if (bridgeUrl) {
      return cursorLocalSdkUrlBridgeJson(env, deps, bridgeUrl, body, signal);
    }
    throw new HttpError(
      "Cursor SDK bridge is not configured",
      500,
      "cursor_sdk_bridge_missing"
    );
  });
  return parseCursorLocalSdkBridgeJsonResponse(response);
};

const stringArg = function stringArg(
  args: Record<string, unknown>,
  key: string
): string | undefined {
  const value = args[key];
  return typeof value === "string" && value ? value : undefined;
};

const stringArgAllowEmpty = function stringArgAllowEmpty(
  args: Record<string, unknown>,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string") {
      return value;
    }
  }
  return undefined;
};

const normalizeSdkToolCallForOpenCode =
  function normalizeSdkToolCallForOpenCode(
    toolCall: CursorToolCall
  ): CursorToolCall {
    if (toolCall.name.toLowerCase() !== "edit") {
      return toolCall;
    }
    const path = stringArg(toolCall.arguments, "path");
    const streamContent = stringArgAllowEmpty(
      toolCall.arguments,
      "streamContent",
      "stream_content"
    );
    if (!path || streamContent === undefined) {
      return toolCall;
    }
    return {
      arguments: {
        fileText: streamContent,
        path,
      },
      name: "write",
    };
  };

const hasStringArg = function hasStringArg(
  args: Record<string, unknown>,
  key: string
): boolean {
  return typeof args[key] === "string" && args[key].trim().length > 0;
};

const hasAnyStringArg = function hasAnyStringArg(
  args: Record<string, unknown>,
  ...keys: string[]
): boolean {
  return keys.some((key) => hasStringArg(args, key));
};

const hasGlobRequest = function hasGlobRequest(
  args: Record<string, unknown>
): boolean {
  if (
    hasAnyStringArg(
      args,
      "globPattern",
      "glob_pattern",
      "filePattern",
      "file_pattern",
      "pattern",
      "glob",
      "query",
      "include",
      "includeGlob",
      "include_glob"
    )
  ) {
    return true;
  }
  const target =
    stringArg(args, "targetDirectory") ||
    stringArg(args, "target_directory") ||
    stringArg(args, "targeting") ||
    stringArg(args, "path");
  return typeof target === "string" && SDK_GLOB_IN_PATH_PATTERN.test(target);
};

const hasAnyStringArgAllowEmpty = function hasAnyStringArgAllowEmpty(
  args: Record<string, unknown>,
  ...keys: string[]
): boolean {
  return keys.some((key) => typeof args[key] === "string");
};

const isEmittableSdkToolCall = function isEmittableSdkToolCall(
  toolCall: CursorToolCall
): boolean {
  const name = toolCall.name.toLowerCase();
  const args = toolCall.arguments ?? {};
  if (name === "glob") {
    return hasGlobRequest(args);
  }
  if (name === "ls") {
    return true;
  }
  if (name === "shell") {
    return hasAnyStringArg(args, "command", "cmd", "script");
  }
  if (name === "write") {
    return (
      hasAnyStringArg(
        args,
        "path",
        "filePath",
        "file_path",
        "targetFile",
        "target_file"
      ) &&
      hasAnyStringArgAllowEmpty(
        args,
        "fileText",
        "file_text",
        "content",
        "contents",
        "text",
        "fileContent",
        "file_content",
        "streamContent",
        "stream_content"
      )
    );
  }
  if (name === "edit") {
    const hasCompleteReplacement =
      hasAnyStringArgAllowEmpty(
        args,
        "oldText",
        "old_text",
        "oldString",
        "old_string",
        "old_str",
        "old",
        "search",
        "searchString",
        "search_string"
      ) &&
      hasAnyStringArgAllowEmpty(
        args,
        "newText",
        "new_text",
        "newString",
        "new_string",
        "new_str",
        "replacement",
        "replace",
        "content"
      );
    return (
      hasAnyStringArg(
        args,
        "path",
        "filePath",
        "file_path",
        "targetFile",
        "target_file"
      ) &&
      (hasAnyStringArgAllowEmpty(
        args,
        "patchContent",
        "patch_content",
        "patch",
        "diff",
        "unifiedDiff",
        "unified_diff"
      ) ||
        hasAnyStringArgAllowEmpty(args, "streamContent", "stream_content") ||
        hasCompleteReplacement)
    );
  }
  if (name === "read" || name === "delete") {
    return hasAnyStringArg(
      args,
      "path",
      "filePath",
      "file_path",
      "targetFile",
      "target_file"
    );
  }
  if (name === "grep") {
    return hasAnyStringArg(args, "pattern", "query", "regex", "search");
  }
  if (name === "semSearch") {
    return hasAnyStringArg(args, "query", "pattern", "search");
  }
  if (name === "readLints") {
    return (
      Array.isArray(args.paths) &&
      args.paths.some((item) => typeof item === "string" && item.trim())
    );
  }
  if (name === "mcp") {
    return hasAnyStringArg(args, "toolName", "tool_name", "name");
  }
  return Object.keys(args).length > 0;
};

const streamCursorLocalSdkBridgeRun =
  async function* streamCursorLocalSdkBridgeRun(
    env: Env,
    deps: Deps,
    apiKey: string,
    input: {
      agentId: string;
      runId: string;
      sessionKey: string;
      prompt: string;
      modelId: string;
      workingDirectory?: string;
      clientTools?: ClientToolSpec[];
      allowToolCall?: (toolCall: CursorToolCall) => ToolCallDecision;
    }
  ): AsyncGenerator<CursorTextEvent> {
    const output = await cursorLocalSdkBridgeJson(env, deps, apiKey, input);
    const text = typeof output.text === "string" ? output.text : "";
    const toolCalls: CursorToolCall[] = [];
    const rawToolCalls = Array.isArray(output.toolCalls)
      ? output.toolCalls
      : [];
    if (text) {
      yield { text, type: "text" };
    }
    for (const rawToolCall of rawToolCalls) {
      if (!rawToolCall || typeof rawToolCall.name !== "string") {
        continue;
      }
      const toolCall = normalizeSdkToolCallForOpenCode({
        arguments: isRecord(rawToolCall.arguments) ? rawToolCall.arguments : {},
        name: rawToolCall.name,
      });
      if (!isEmittableSdkToolCall(toolCall)) {
        continue;
      }
      const decision = input.allowToolCall?.(toolCall) ?? true;
      if (decision !== true) {
        yield {
          reason: typeof decision === "string" ? decision : undefined,
          toolCall,
          type: "rejected_tool_call",
        };
        yield { finalText: text, toolCalls, type: "done" };
        return;
      }
      toolCalls.push(toolCall);
      yield { toolCall, type: "tool_call" };
      yield { finalText: text, toolCalls, type: "done" };
      return;
    }
    yield { finalText: text, toolCalls, type: "done" };
  };

const retryPromptAfterUnsupportedTool =
  function retryPromptAfterUnsupportedTool(
    prompt: string,
    toolCall: CursorToolCall,
    reason?: string,
    attempt = 2,
    maxAttempts = SDK_TOOL_RETRY_ATTEMPTS
  ): string {
    return [
      prompt,
      "",
      `TOOL CALL RETRY (attempt ${attempt} of ${maxAttempts}):`,
      `Your previous SDK response requested ${toolCall.name}, but that tool could not be mapped to the allowed OpenCode tool inventory above.`,
      ...(reason ? [`Mapping failure detail: ${reason}`] : []),
      "The next response is invalid unless it contains a mappable tool_call.",
      "Do not answer in prose. Emit exactly one SDK tool call that maps to an allowed client tool.",
      "For filesystem mutations, prefer SDK write with path and fileText or SDK shell with command when those capabilities are present.",
      "For OpenCode MCP/server tools exposed as provider_tool names, use SDK mcp with providerIdentifier, toolName, and args.",
    ].join("\n");
  };

const retryPromptAfterMissingTool = function retryPromptAfterMissingTool(
  prompt: string,
  attempt = 2,
  maxAttempts = SDK_TOOL_RETRY_ATTEMPTS
): string {
  return [
    prompt,
    "",
    `TOOL CALL RETRY (attempt ${attempt} of ${maxAttempts}):`,
    "Your previous SDK response did not emit a local tool call, but the latest user request requires local OpenCode execution.",
    "The next response is invalid unless it contains a tool_call.",
    "Do not answer in prose. Emit exactly one SDK tool call now using the allowed OpenCode tool inventory above, then wait for the local tool result.",
    "Use SDK mcp for an exact client tool route, or SDK shell/write when the routing map says those built-ins map to the client schema.",
    "If a specific client tool was named in the request, use that exact tool mapping and do not substitute shell, glob, or prose.",
  ].join("\n");
};

const drainCursorTextEvents = async function drainCursorTextEvents(
  stream: AsyncIterable<CursorTextEvent>,
  onEvent: (event: CursorTextEvent) => void
): Promise<void> {
  const iterator = stream[Symbol.asyncIterator]();
  const step = async (): Promise<void> => {
    const next = await iterator.next();
    if (next.done) {
      return;
    }
    onEvent(next.value);
    await step();
  };
  await step();
};

const streamCursorLocalSdkBridgeRunWithRetry =
  async function* streamCursorLocalSdkBridgeRunWithRetry(
    env: Env,
    deps: Deps,
    apiKey: string,
    input: {
      agentId: string;
      runId: string;
      sessionKey: string;
      prompt: string;
      modelId: string;
      workingDirectory?: string;
      clientTools?: ClientToolSpec[];
      requiresLocalTool: boolean;
      allowToolCall?: (toolCall: CursorToolCall) => ToolCallDecision;
      incrementalPrompt?: string;
    }
  ): AsyncGenerator<CursorTextEvent> {
    if (!input.requiresLocalTool && !input.allowToolCall) {
      yield* streamCursorLocalSdkBridgeRun(env, deps, apiKey, input);
      return;
    }
    const attemptRun = async function* attemptRun(
      attemptInput: typeof input,
      attempt: number
    ): AsyncGenerator<CursorTextEvent> {
      const events: CursorTextEvent[] = [];
      let sawToolCall = false;
      let rejectedToolCall: CursorToolCall | undefined;
      let rejectedToolReason: string | undefined;
      await drainCursorTextEvents(
        streamCursorLocalSdkBridgeRun(env, deps, apiKey, attemptInput),
        (event) => {
          events.push(event);
          if (event.type === "tool_call") {
            sawToolCall = true;
          }
          if (event.type === "rejected_tool_call") {
            rejectedToolCall = event.toolCall;
            rejectedToolReason = event.reason;
          }
        }
      );
      if (sawToolCall) {
        for (const event of events) {
          yield event;
        }
        return;
      }
      const shouldRetry = rejectedToolCall || input.requiresLocalTool;
      if (!shouldRetry || attempt >= SDK_TOOL_RETRY_ATTEMPTS) {
        for (const event of events) {
          yield event;
        }
        return;
      }
      yield* attemptRun(
        {
          ...input,
          prompt: rejectedToolCall
            ? retryPromptAfterUnsupportedTool(
                input.prompt,
                rejectedToolCall,
                rejectedToolReason,
                attempt + 1,
                SDK_TOOL_RETRY_ATTEMPTS
              )
            : retryPromptAfterMissingTool(
                input.prompt,
                attempt + 1,
                SDK_TOOL_RETRY_ATTEMPTS
              ),
          runId: newLocalSdkRunId(deps.randomUUID()),
        },
        attempt + 1
      );
    };
    yield* attemptRun(input, 1);
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

const protoMessage = function protoMessage(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
};

const varint = function varint(value: number): Uint8Array {
  const bytes: number[] = [];
  let current = toUint32(value);
  while (current >= 0x80) {
    bytes.push(low7Bits(current) + 0x80);
    current = Math.floor(current / 128);
  }
  bytes.push(current);
  return new Uint8Array(bytes);
};

const protoLengthDelimitedField = function protoLengthDelimitedField(
  fieldNumber: number,
  value: Uint8Array
): Uint8Array {
  return protoMessage([
    varint(protoTag(fieldNumber, 2)),
    varint(value.length),
    value,
  ]);
};

const protoNumericVarint = function protoNumericVarint(
  value: number | boolean
): number {
  if (value === true) {
    return 1;
  }
  if (value === false) {
    return 0;
  }
  return value;
};

const protoVarintField = function protoVarintField(
  fieldNumber: number,
  value: number | boolean | undefined
): Uint8Array {
  if (value === undefined) {
    return new Uint8Array(0);
  }
  return protoMessage([
    varint(protoTag(fieldNumber, 0)),
    varint(protoNumericVarint(value)),
  ]);
};

const protoStringField = function protoStringField(
  fieldNumber: number,
  value: string | undefined
): Uint8Array {
  if (value === undefined) {
    return new Uint8Array(0);
  }
  return protoLengthDelimitedField(
    fieldNumber,
    new TextEncoder().encode(value)
  );
};

const protoMessageField = function protoMessageField(
  fieldNumber: number,
  value: Uint8Array
): Uint8Array {
  return protoLengthDelimitedField(fieldNumber, value);
};

const encodeAgentClientRunRequest =
  function encodeAgentClientRunRequest(input: {
    agentId: string;
    messageId: string;
    modelId: string;
    prompt: string;
  }): Uint8Array {
    const userMessage = protoMessage([
      protoStringField(1, input.prompt),
      protoStringField(2, input.messageId),
      protoVarintField(4, AGENT_MODE_AGENT),
    ]);
    const userMessageAction = protoMessage([protoMessageField(1, userMessage)]);
    const conversationAction = protoMessage([
      protoMessageField(1, userMessageAction),
    ]);
    const modelDetails = protoMessage([
      protoStringField(1, input.modelId),
      protoStringField(3, input.modelId),
      protoStringField(4, input.modelId),
    ]);
    const requestedModel = protoMessage([protoStringField(1, input.modelId)]);
    const runRequest = protoMessage([
      protoMessageField(1, protoMessage([])),
      protoMessageField(2, conversationAction),
      protoMessageField(3, modelDetails),
      protoMessageField(4, protoMessage([])),
      protoStringField(5, input.agentId),
      protoStringField(13, "sdk"),
      protoMessageField(9, requestedModel),
      protoVarintField(19, 1),
    ]);
    return protoMessage([protoMessageField(1, runRequest)]);
  };

const parseCursorSdkError = function parseCursorSdkError(text: string): {
  message?: string;
  code?: string;
} {
  try {
    const payload = JSON.parse(text) as unknown;
    if (isRecord(payload)) {
      const error = isRecord(payload.error) ? payload.error : payload;
      return {
        code: typeof error.code === "string" ? error.code : undefined,
        message: typeof error.message === "string" ? error.message : undefined,
      };
    }
  } catch {
    // Ignore JSON parse failures.
  }
  return { message: text || undefined };
};

const cursorLocalSdkRaw = async function cursorLocalSdkRaw(
  env: Env,
  deps: Deps,
  endpoint: string,
  accessToken: string,
  requestId: string,
  body: BodyInit,
  signal?: AbortSignal
): Promise<Response> {
  const base = env.CURSOR_BACKEND_BASE_URL?.trim();
  if (!base) {
    throw new HttpError(
      "Cursor backend URL is not configured",
      500,
      "cursor_missing_backend_url"
    );
  }
  const url = ABSOLUTE_URL_PATTERN.test(endpoint)
    ? endpoint
    : `${base.replace(TRAILING_SLASH_PATTERN, "")}${endpoint.startsWith("/") ? endpoint : `/${endpoint}`}`;
  const headers = new Headers({
    Authorization: `Bearer ${accessToken}`,
    "Connect-Protocol-Version": "1",
    "Content-Type": "application/connect+proto",
    "User-Agent": "connect-es/1.6.1",
    "x-cursor-client-type": "sdk",
    "x-cursor-client-version":
      env.CURSOR_SDK_CLIENT_VERSION || DEFAULT_SDK_CLIENT_VERSION,
    "x-ghost-mode": "true",
    "x-original-request-id": requestId,
    "x-request-id": requestId,
  });
  const init: RequestInit & {
    duplex?: "half";
  } = {
    body,
    headers,
    method: "POST",
    signal,
  };
  if (body instanceof ReadableStream) {
    init.duplex = "half";
  }
  const response = await deps.fetch(url, init);
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    const parsed = parseCursorSdkError(text);
    const message =
      response.status === 401
        ? "Invalid Cursor API key"
        : parsed.message ||
          `Cursor local SDK request failed with status ${response.status}`;
    const status = mapCursorSdkHttpStatus(response.status);
    const code =
      response.status === 401
        ? "cursor_unauthorized"
        : parsed.code || "cursor_sdk_error";
    throw new HttpError(message, status, code);
  }
  return response;
};

const cursorLocalSdkEndpoint = function cursorLocalSdkEndpoint(
  env: Env
): string {
  const endpoint = env.CURSOR_LOCAL_AGENT_ENDPOINT?.trim();
  if (!endpoint) {
    throw new HttpError(
      "Cursor local SDK endpoint is not configured",
      500,
      "cursor_missing_endpoint"
    );
  }
  return endpoint;
};

const writeSdkUpload = async function writeSdkUpload(
  writer: WritableStreamDefaultWriter<Uint8Array>,
  frame: Uint8Array
): Promise<void> {
  await writer.write(frame).catch((error) => {
    throw error instanceof Error ? error : new Error(String(error));
  });
};

const waitForAbortSignal = function waitForAbortSignal(
  signal: AbortSignal
): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }
  return once(signal, "abort").then(() => {
    void 0;
  });
};

const withSdkStartTimeout = function withSdkStartTimeout<T>(
  promise: Promise<T>
): Promise<T> {
  const timeoutSignal = AbortSignal.timeout(SDK_STREAM_START_TIMEOUT_MS);
  const timeoutFailure = (async (): Promise<T> => {
    await waitForAbortSignal(timeoutSignal);
    throw new HttpError(
      "Cursor local SDK stream did not start.",
      504,
      "cursor_sdk_stream_timeout"
    );
  })();
  return Promise.race([promise, timeoutFailure]);
};

const concatBytes = function concatBytes(
  a: Uint8Array<ArrayBufferLike>,
  b: Uint8Array<ArrayBufferLike>
): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(a.length + b.length) as Uint8Array<ArrayBuffer>;
  out.set(a, 0);
  out.set(b, a.length);
  return out;
};

const decodeUtf8 = function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
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
        typeof parsed.error.message === "string"
          ? parsed.error.message
          : "Cursor local SDK stream failed";
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
          "Cursor returned a compressed SDK frame that this Worker cannot decode.",
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
    await reader.cancel().catch(ignoreError);
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
  return { offset, value };
};

const decodeProtobufFields = function decodeProtobufFields(
  bytes: Uint8Array
): ProtobufField[] {
  const fields: ProtobufField[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    const key = readVarint(bytes, offset);
    ({ offset } = key);
    const fieldNumber = protoFieldNumber(key.value);
    const wireType = protoWireType(key.value);
    if (wireType === 0) {
      const value = readVarint(bytes, offset);
      ({ offset } = value);
      fields.push({ no: fieldNumber, value: value.value, wt: wireType });
    } else if (wireType === 1) {
      const end = offset + 8;
      if (end > bytes.length) {
        break;
      }
      const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 8);
      fields.push({
        no: fieldNumber,
        value: view.getFloat64(0, true),
        wt: wireType,
      });
      offset = end;
    } else if (wireType === 2) {
      const length = readVarint(bytes, offset);
      ({ offset } = length);
      const end = offset + length.value;
      if (end > bytes.length) {
        break;
      }
      fields.push({
        no: fieldNumber,
        value: bytes.slice(offset, end),
        wt: wireType,
      });
      offset = end;
    } else if (wireType === 5) {
      const end = offset + 4;
      if (end > bytes.length) {
        break;
      }
      const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 4);
      fields.push({
        no: fieldNumber,
        value: view.getUint32(0, true),
        wt: wireType,
      });
      offset = end;
    } else {
      break;
    }
  }
  return fields;
};

const bytesField = function bytesField(
  fields: ProtobufField[],
  fieldNumber: number
): Uint8Array | undefined {
  const field = fields.find(
    (item) => item.no === fieldNumber && item.value instanceof Uint8Array
  );
  return field?.value instanceof Uint8Array ? field.value : undefined;
};

const stringField = function stringField(
  fields: ProtobufField[],
  fieldNumber: number
): string | undefined {
  const bytes = bytesField(fields, fieldNumber);
  return bytes ? decodeUtf8(bytes) : undefined;
};

const stableToolCallId = function stableToolCallId(value: Uint8Array): string {
  let hash = 0;
  for (const byte of value.slice(0, 64)) {
    hash = toUint32(hash * 31 + byte);
  }
  return `tool_${hash.toString(16)}`;
};

const compactRecord = function compactRecord(
  input: Record<string, unknown>
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(input).filter(
      ([, value]) =>
        value !== undefined && (!Array.isArray(value) || value.length > 0)
    )
  );
};

const numberField = function numberField(
  fields: ProtobufField[],
  fieldNumber: number
): number | undefined {
  const field = fields.find(
    (item) => item.no === fieldNumber && typeof item.value === "number"
  );
  return typeof field?.value === "number" ? field.value : undefined;
};

const booleanField = function booleanField(
  fields: ProtobufField[],
  fieldNumber: number
): boolean | undefined {
  const value = numberField(fields, fieldNumber);
  return value === undefined ? undefined : value !== 0;
};

const stringFields = function stringFields(
  fields: ProtobufField[],
  fieldNumber: number
): string[] | undefined {
  const values = fields
    .filter(
      (item) => item.no === fieldNumber && item.value instanceof Uint8Array
    )
    .map((item) => decodeUtf8(item.value as Uint8Array));
  return values.length ? values : undefined;
};

const protoSchemaCodec = {
  decodeProtoValue: function decodeProtoValue(bytes: Uint8Array): unknown {
    const protoStruct = function protoStruct(
      structBytes: Uint8Array
    ): Record<string, unknown> {
      return (
        protoSchemaCodec.decodeProtoValueMap(
          decodeProtobufFields(structBytes),
          1
        ) ?? {}
      );
    };

    const protoList = function protoList(listBytes: Uint8Array): unknown[] {
      const output: unknown[] = [];
      for (const field of decodeProtobufFields(listBytes)) {
        if (field.no !== 1 || !(field.value instanceof Uint8Array)) {
          continue;
        }
        const value = protoSchemaCodec.decodeProtoValue(field.value);
        if (value !== undefined) {
          output.push(value);
        }
      }
      return output;
    };

    const fields = decodeProtobufFields(bytes);
    if (fields.some((field) => field.no === 1)) {
      return null;
    }
    const numberValue = numberField(fields, 2);
    if (numberValue !== undefined) {
      return numberValue;
    }
    const stringValue = stringField(fields, 3);
    if (stringValue !== undefined) {
      return stringValue;
    }
    const boolValue = booleanField(fields, 4);
    if (boolValue !== undefined) {
      return boolValue;
    }
    const structValue = bytesField(fields, 5);
    if (structValue) {
      return protoStruct(structValue);
    }
    const listValue = bytesField(fields, 6);
    if (listValue) {
      return protoList(listValue);
    }
    return undefined;
  },
  decodeProtoValueMap: function decodeProtoValueMap(
    fields: ProtobufField[],
    fieldNumber: number
  ): Record<string, unknown> | undefined {
    const output: Record<string, unknown> = {};
    for (const field of fields) {
      if (field.no !== fieldNumber || !(field.value instanceof Uint8Array)) {
        continue;
      }
      const entryFields = decodeProtobufFields(field.value);
      const key = stringField(entryFields, 1);
      const valueBytes = bytesField(entryFields, 2);
      const value = valueBytes
        ? protoSchemaCodec.decodeProtoValue(valueBytes)
        : undefined;
      if (key && value !== undefined) {
        output[key] = value;
      }
    }
    return Object.keys(output).length ? output : undefined;
  },
};

const protoValueMap = protoSchemaCodec.decodeProtoValueMap;

const decodeToolArgs = function decodeToolArgs(
  kind: ArgsKind,
  payload: Uint8Array
): Record<string, unknown> {
  const fields = decodeProtobufFields(payload);
  switch (kind) {
    case "shell": {
      return compactRecord({
        command: stringField(fields, 1),
        timeout: numberField(fields, 3),
        toolCallId: stringField(fields, 4),
        workingDirectory: stringField(fields, 2),
      });
    }
    case "write": {
      return compactRecord({
        fileText: stringField(fields, 2),
        path: stringField(fields, 1),
        returnFileContentAfterWrite: booleanField(fields, 4),
        toolCallId: stringField(fields, 3),
      });
    }
    case "delete": {
      return compactRecord({
        path: stringField(fields, 1),
        toolCallId: stringField(fields, 2),
      });
    }
    case "glob": {
      return compactRecord({
        globPattern: stringField(fields, 2),
        targetDirectory: stringField(fields, 1),
      });
    }
    case "grep": {
      return compactRecord({
        caseInsensitive: booleanField(fields, 8),
        context: numberField(fields, 7),
        contextAfter: numberField(fields, 6),
        contextBefore: numberField(fields, 5),
        glob: stringField(fields, 3),
        headLimit: numberField(fields, 10),
        multiline: booleanField(fields, 11),
        offset: numberField(fields, 16),
        outputMode: stringField(fields, 4),
        path: stringField(fields, 2),
        pattern: stringField(fields, 1),
        sort: stringField(fields, 12),
        sortAscending: booleanField(fields, 13),
        toolCallId: stringField(fields, 14),
        type: stringField(fields, 9),
      });
    }
    case "readTool": {
      return compactRecord({
        includeLineNumbers: booleanField(fields, 5),
        limit: numberField(fields, 3),
        offset: numberField(fields, 2),
        path: stringField(fields, 1),
      });
    }
    case "readExec": {
      return compactRecord({
        limit: numberField(fields, 5),
        offset: numberField(fields, 4),
        path: stringField(fields, 1),
        toolCallId: stringField(fields, 2),
      });
    }
    case "edit": {
      return compactRecord({
        path: stringField(fields, 1),
        streamContent: stringField(fields, 6),
      });
    }
    case "ls": {
      return compactRecord({
        ignore: stringFields(fields, 2),
        path: stringField(fields, 1),
        toolCallId: stringField(fields, 3),
      });
    }
    case "readLints": {
      return compactRecord({ paths: stringFields(fields, 1) });
    }
    case "mcp": {
      return compactRecord({
        args: protoValueMap(fields, 2),
        name: stringField(fields, 1),
        providerIdentifier: stringField(fields, 4),
        toolCallId: stringField(fields, 3),
        toolName: stringField(fields, 5),
      });
    }
    case "semSearch": {
      return compactRecord({
        explanation: stringField(fields, 3),
        query: stringField(fields, 1),
        targetDirectories: stringFields(fields, 2),
      });
    }
    default: {
      return {};
    }
  }
};

const decodeSdkToolCall = function decodeSdkToolCall(payload: Uint8Array): {
  toolCall: CursorToolCall;
  hasResult: boolean;
} | null {
  for (const field of decodeProtobufFields(payload)) {
    if (!(field.value instanceof Uint8Array)) {
      continue;
    }
    const spec = TOOL_CALL_SPECS[field.no];
    if (!spec) {
      continue;
    }
    const toolFields = decodeProtobufFields(field.value);
    const args = bytesField(toolFields, 1);
    const hasResult = toolFields.some((item) => item.no === 2);
    return {
      hasResult,
      toolCall: {
        arguments: args ? decodeToolArgs(spec.argsKind, args) : {},
        name: spec.name,
      },
    };
  }
  return null;
};

const decodeToolCallUpdate = function decodeToolCallUpdate(
  payload: Uint8Array,
  completed: boolean
): LocalSdkDecodedEvent | null {
  const fields = decodeProtobufFields(payload);
  const callId = stringField(fields, 1) || stableToolCallId(payload);
  const toolCallBytes = bytesField(fields, 2);
  if (!toolCallBytes) {
    return null;
  }
  const decoded = decodeSdkToolCall(toolCallBytes);
  if (!decoded || (completed && decoded.hasResult)) {
    return null;
  }
  return {
    id: callId,
    toolCall: normalizeSdkToolCallForOpenCode(decoded.toolCall),
    type: "tool_call",
  };
};

const decodeInteractionUpdate = function decodeInteractionUpdate(
  payload: Uint8Array
): LocalSdkDecodedEvent[] {
  const output: LocalSdkDecodedEvent[] = [];
  for (const field of decodeProtobufFields(payload)) {
    if (!(field.value instanceof Uint8Array)) {
      continue;
    }
    if (field.no === 1) {
      const text = stringField(decodeProtobufFields(field.value), 1);
      if (text) {
        output.push({ text, type: "text" });
      }
    } else if (field.no === 2 || field.no === 3 || field.no === 7) {
      const event = decodeToolCallUpdate(field.value, field.no === 3);
      if (event) {
        output.push(event);
      }
    } else if (field.no === 14) {
      output.push({ type: "done" });
    }
  }
  return output;
};

const decodeExecServerToolCall = function decodeExecServerToolCall(
  payload: Uint8Array,
  fields = decodeProtobufFields(payload)
): LocalSdkDecodedEvent | null {
  const id = numberField(fields, 1);
  const execId = stringField(fields, 15);
  for (const field of fields) {
    if (!(field.value instanceof Uint8Array)) {
      continue;
    }
    const spec = EXEC_TOOL_SPECS[field.no];
    if (!spec) {
      continue;
    }
    const args = decodeToolArgs(spec.argsKind, field.value);
    const toolCallId =
      stringArg(args, "toolCallId") ||
      execId ||
      `exec_${id ?? stableToolCallId(payload)}`;
    delete args.toolCallId;
    return {
      id: toolCallId,
      toolCall: normalizeSdkToolCallForOpenCode({
        arguments: args,
        name: spec.name,
      }),
      type: "tool_call",
    };
  }
  return null;
};

const decodeExecServerMessage = function decodeExecServerMessage(
  payload: Uint8Array
): LocalSdkDecodedEvent | null {
  const fields = decodeProtobufFields(payload);
  if (
    fields.some((field) => field.no === 10 && field.value instanceof Uint8Array)
  ) {
    return {
      execId: stringField(fields, 15),
      id: numberField(fields, 1) || 0,
      type: "request_context",
    };
  }
  return decodeExecServerToolCall(payload, fields);
};

const decodeLocalAgentServerFrame = function decodeLocalAgentServerFrame(
  payload: Uint8Array
): LocalSdkDecodedEvent[] {
  const output: LocalSdkDecodedEvent[] = [];
  try {
    for (const field of decodeProtobufFields(payload)) {
      if (field.no === 1 && field.value instanceof Uint8Array) {
        output.push(...decodeInteractionUpdate(field.value));
      } else if (field.no === 2 && field.value instanceof Uint8Array) {
        const event = decodeExecServerMessage(field.value);
        if (event) {
          output.push(event);
        }
      }
    }
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Could not decode Cursor local SDK stream";
    throw new HttpError(message, 502, "cursor_stream_error");
  }
  return output.length ? output : [{ type: "ignore" }];
};

const encodeAgentClientRequestContextResult =
  function encodeAgentClientRequestContextResult(
    input: {
      id: number;
      execId?: string;
    },
    options: {
      workingDirectory?: string;
    } = {}
  ): Uint8Array {
    const workingDirectory = sdkWorkingDirectory(options.workingDirectory);
    const env = protoMessage([
      protoStringField(1, "Cloudflare Worker"),
      protoStringField(2, workingDirectory),
      protoStringField(3, "sh"),
      protoVarintField(5, false),
      protoStringField(10, "UTC"),
      protoStringField(11, workingDirectory),
      protoStringField(21, workingDirectory),
    ]);
    const requestContext = protoMessage([
      protoMessageField(4, env),
      protoVarintField(17, false),
      protoVarintField(24, false),
      protoVarintField(32, true),
      protoVarintField(33, true),
      protoVarintField(35, false),
      protoVarintField(36, true),
      protoVarintField(39, true),
      protoVarintField(40, true),
      protoVarintField(41, true),
      protoVarintField(42, true),
      protoVarintField(43, true),
      protoVarintField(44, true),
      protoVarintField(45, true),
    ]);
    const success = protoMessage([protoMessageField(1, requestContext)]);
    const result = protoMessage([protoMessageField(1, success)]);
    const execClientMessage = protoMessage([
      protoVarintField(1, input.id),
      protoStringField(15, input.execId),
      protoMessageField(10, result),
    ]);
    return protoMessage([protoMessageField(2, execClientMessage)]);
  };

const closeSdkUpload = async function closeSdkUpload(
  writer: WritableStreamDefaultWriter<Uint8Array>
): Promise<void> {
  await writer.close().catch(ignoreError);
  writer.releaseLock();
};

const emitLocalSdkFrameEvents = async function* emitLocalSdkFrameEvents(
  events: ReturnType<typeof decodeLocalAgentServerFrame>,
  eventIndex: number,
  frameIterator: AsyncIterator<Uint8Array>,
  input: {
    allowToolCall?: (toolCall: CursorToolCall) => ToolCallDecision;
    workingDirectory?: string;
  },
  state: {
    emittedToolCallIds: Set<string>;
    text: string;
    toolCalls: CursorToolCall[];
    uploadOpen: boolean;
    uploadWriter: WritableStreamDefaultWriter<Uint8Array>;
  }
): AsyncGenerator<CursorTextEvent> {
  if (eventIndex >= events.length) {
    return;
  }
  const event = events[eventIndex];
  if (event.type === "text" && event.text) {
    state.text += event.text;
    yield { text: event.text, type: "text" };
    yield* emitLocalSdkFrameEvents(
      events,
      eventIndex + 1,
      frameIterator,
      input,
      state
    );
    return;
  }
  if (event.type === "tool_call") {
    if (!isEmittableSdkToolCall(event.toolCall)) {
      yield* emitLocalSdkFrameEvents(
        events,
        eventIndex + 1,
        frameIterator,
        input,
        state
      );
      return;
    }
    const decision = input.allowToolCall?.(event.toolCall) ?? true;
    if (decision !== true) {
      yield {
        reason: typeof decision === "string" ? decision : undefined,
        toolCall: event.toolCall,
        type: "rejected_tool_call",
      };
      yield {
        finalText: state.text,
        toolCalls: state.toolCalls,
        type: "done",
      };
      return;
    }
    if (!state.emittedToolCallIds.has(event.id)) {
      state.emittedToolCallIds.add(event.id);
      state.toolCalls.push(event.toolCall);
      yield { toolCall: event.toolCall, type: "tool_call" };
      yield {
        finalText: state.text,
        toolCalls: state.toolCalls,
        type: "done",
      };
      return;
    }
    yield* emitLocalSdkFrameEvents(
      events,
      eventIndex + 1,
      frameIterator,
      input,
      state
    );
    return;
  }
  if (event.type === "request_context") {
    if (state.uploadOpen && state.uploadWriter) {
      await writeSdkUpload(
        state.uploadWriter,
        encodeConnectFrame(
          encodeAgentClientRequestContextResult(event, {
            workingDirectory: input.workingDirectory,
          })
        )
      );
    }
    yield* emitLocalSdkFrameEvents(
      events,
      eventIndex + 1,
      frameIterator,
      input,
      state
    );
    return;
  }
  if (event.type === "done") {
    yield { finalText: state.text, toolCalls: state.toolCalls, type: "done" };
    return;
  }
  yield* emitLocalSdkFrameEvents(
    events,
    eventIndex + 1,
    frameIterator,
    input,
    state
  );
};

const advanceLocalSdkFrame = async function* advanceLocalSdkFrame(
  frameIterator: AsyncIterator<Uint8Array>,
  input: {
    allowToolCall?: (toolCall: CursorToolCall) => ToolCallDecision;
    workingDirectory?: string;
  },
  state: {
    emittedToolCallIds: Set<string>;
    text: string;
    toolCalls: CursorToolCall[];
    uploadOpen: boolean;
    uploadWriter: WritableStreamDefaultWriter<Uint8Array>;
  }
): AsyncGenerator<CursorTextEvent> {
  const next = await frameIterator.next();
  if (next.done) {
    return;
  }
  const events = decodeLocalAgentServerFrame(next.value);
  yield* emitLocalSdkFrameEvents(events, 0, frameIterator, input, state);
  yield* advanceLocalSdkFrame(frameIterator, input, state);
};

const streamCursorLocalSdkRun = async function* streamCursorLocalSdkRun(
  env: Env,
  deps: Deps,
  accessToken: string,
  input: {
    agentId: string;
    runId: string;
    prompt: string;
    modelId: string;
    workingDirectory?: string;
    clientTools?: ClientToolSpec[];
    allowToolCall?: (toolCall: CursorToolCall) => ToolCallDecision;
  }
): AsyncGenerator<CursorTextEvent> {
  const requestId = deps.randomUUID();
  const requestBody = encodeConnectFrame(
    encodeAgentClientRunRequest({
      agentId: input.agentId,
      messageId: input.runId,
      modelId: input.modelId,
      prompt: input.prompt,
    })
  );
  const runAbort = new AbortController();
  const upload = new TransformStream<Uint8Array, Uint8Array>();
  const uploadWriter = upload.writable.getWriter();
  const runResponsePromise = (async () => {
    const response = await cursorLocalSdkRaw(
      env,
      deps,
      cursorLocalSdkEndpoint(env),
      accessToken,
      requestId,
      upload.readable,
      runAbort.signal
    );
    return {
      response,
      source: "run" as const,
    };
  })();
  const selected = await withSdkStartTimeout(runResponsePromise);
  const { response } = selected;
  const state = {
    emittedToolCallIds: new Set<string>(),
    text: "",
    toolCalls: [] as CursorToolCall[],
    uploadOpen: false,
    uploadWriter,
  };
  try {
    if (uploadWriter) {
      await writeSdkUpload(uploadWriter, requestBody);
      state.uploadOpen = true;
    }
    const frameIterator = parseConnectProtoFrames(response.body)[
      Symbol.asyncIterator
    ]();
    yield* advanceLocalSdkFrame(frameIterator, input, state);
  } finally {
    if (state.uploadOpen && uploadWriter) {
      await closeSdkUpload(uploadWriter);
    }
    runAbort.abort("opencode_sdk_run_finished");
  }
  yield { finalText: state.text, toolCalls: state.toolCalls, type: "done" };
};

const streamCursorLocalSdkRunWithRetry =
  async function* streamCursorLocalSdkRunWithRetry(
    env: Env,
    deps: Deps,
    accessToken: string,
    input: {
      agentId: string;
      runId: string;
      prompt: string;
      modelId: string;
      workingDirectory?: string;
      clientTools?: ClientToolSpec[];
      requiresLocalTool: boolean;
      allowToolCall?: (toolCall: CursorToolCall) => ToolCallDecision;
      incrementalPrompt?: string;
    }
  ): AsyncGenerator<CursorTextEvent> {
    if (!input.requiresLocalTool && !input.allowToolCall) {
      yield* streamCursorLocalSdkRun(env, deps, accessToken, input);
      return;
    }
    const attemptRun = async function* attemptRun(
      attemptInput: typeof input,
      attempt: number
    ): AsyncGenerator<CursorTextEvent> {
      const events: CursorTextEvent[] = [];
      let sawToolCall = false;
      let rejectedToolCall: CursorToolCall | undefined;
      let rejectedToolReason: string | undefined;
      await drainCursorTextEvents(
        streamCursorLocalSdkRun(env, deps, accessToken, attemptInput),
        (event) => {
          events.push(event);
          if (event.type === "tool_call") {
            sawToolCall = true;
          }
          if (event.type === "rejected_tool_call") {
            rejectedToolCall = event.toolCall;
            rejectedToolReason = event.reason;
          }
        }
      );
      if (sawToolCall) {
        for (const event of events) {
          yield event;
        }
        return;
      }
      const shouldRetry = rejectedToolCall || input.requiresLocalTool;
      if (!shouldRetry || attempt >= SDK_TOOL_RETRY_ATTEMPTS) {
        for (const event of events) {
          yield event;
        }
        return;
      }
      yield* attemptRun(
        {
          ...input,
          prompt: rejectedToolCall
            ? retryPromptAfterUnsupportedTool(
                input.prompt,
                rejectedToolCall,
                rejectedToolReason,
                attempt + 1,
                SDK_TOOL_RETRY_ATTEMPTS
              )
            : retryPromptAfterMissingTool(
                input.prompt,
                attempt + 1,
                SDK_TOOL_RETRY_ATTEMPTS
              ),
          runId: newLocalSdkRunId(deps.randomUUID()),
        },
        attempt + 1
      );
    };
    yield* attemptRun(input, 1);
  };

export const createCursorSdkCompletion =
  async function createCursorSdkCompletion(
    env: Env,
    deps: Deps,
    apiKey: string,
    input: {
      prompt: {
        text: string;
        images?: CursorImage[];
      };
      model?: {
        id: string;
      };
      sessionKey?: string;
      sessionOwnerKey?: string;
      workingDirectory?: string;
      clientTools?: ClientToolSpec[];
      requiresLocalTool?: boolean;
      allowToolCall?: (toolCall: CursorToolCall) => ToolCallDecision;
      // Optional delta for a follow-up turn. When the bridge's agent for this session is
      // still cached, the bridge sends only this (the new turn) instead of re-feeding the
      // full prompt; if the agent was evicted it falls back to `prompt`, so this is safe.
      incrementalPrompt?: {
        text: string;
        images?: CursorImage[];
      };
    }
  ): Promise<CursorSdkCompletion> {
    const now = deps.now();
    pruneSessions(now.getTime());
    const sessionIdentity = await sdkSessionIdentity(
      apiKey,
      input.sessionKey || "default",
      input.sessionOwnerKey
    );
    const session =
      sdkSessions.get(sessionIdentity.id) ??
      (await readPersistedSdkSession(env, sessionIdentity.id, now.getTime()));
    const agentId = session?.agentId || newLocalSdkAgentId(deps.randomUUID());
    const runId = newLocalSdkRunId(deps.randomUUID());
    const updatedAt = deps.now();
    sdkSessions.set(sessionIdentity.id, {
      agentId,
      updatedAt: updatedAt.getTime(),
    });
    await savePersistedSdkSession(env, sessionIdentity, agentId, updatedAt);
    const runInput = {
      agentId,
      allowToolCall: input.allowToolCall,
      clientTools: input.clientTools,
      incrementalPrompt: input.incrementalPrompt
        ? sdkPrompt(input.incrementalPrompt)
        : undefined,
      modelId: input.model?.id || "composer-2.5",
      prompt: sdkPrompt(input.prompt),
      requiresLocalTool: input.requiresLocalTool === true,
      runId,
      sessionKey: sessionIdentity.id,
      workingDirectory: input.workingDirectory,
    };
    if (hasCursorSdkBridge(env)) {
      return {
        agentId,
        runId,
        stream: streamCursorLocalSdkBridgeRunWithRetry(
          env,
          deps,
          apiKey,
          runInput
        ),
      };
    }
    const accessToken = await exchangeCursorApiKey(env, deps, apiKey);
    return {
      agentId,
      runId,
      stream: streamCursorLocalSdkRunWithRetry(
        env,
        deps,
        accessToken,
        runInput
      ),
    };
  };

export const collectCursorSdkOutput = async function collectCursorSdkOutput(
  stream: AsyncIterable<CursorTextEvent>
): Promise<CursorCollectedOutput> {
  let text = "";
  let toolCalls: CursorToolCall[] = [];
  for await (const event of stream) {
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

export const resetCursorSdkSessionCacheForTest =
  function resetCursorSdkSessionCacheForTest() {
    sdkSessions.clear();
  };

export const cursorSdkTestExports = {
  decodeLocalAgentServerFrame,
  encodeAgentClientRequestContextResult,
  encodeAgentClientRunRequest,
  isEmittableSdkToolCall,
  normalizeSdkToolCallForOpenCode,
  retryPromptAfterMissingTool,
  retryPromptAfterUnsupportedTool,
};
