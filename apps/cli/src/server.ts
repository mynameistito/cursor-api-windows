/**
 * API for Cursor — standalone sidecar server.
 *
 * A `node:http` server that exposes the standard (non-account) OpenAI-compatible
 * `/v1/*` surface by reusing the import-clean worker helpers.
 *
 * It has two paths for chat/responses:
 *   - PRIMARY (full macOS parity): when `CURSOR_SDK_BRIDGE_URL` is set, route via
 *     `worker/cursor-sdk.ts` `createCursorSdkCompletion`, mirroring `worker/index.ts`.
 *     This works with only the user's Cursor key (no private backend secrets).
 *   - FALLBACK: the direct `worker/cursor.ts` path when no bridge is configured.
 *
 * `cursor-sdk.ts` is import-clean here: it only TYPE-references
 * `DurableObjectNamespace` and touches `env.DB` inside try/catch (in-memory
 * fallback), so an undefined `env.DB` is fine. We still avoid importing
 * `worker/index`, `worker/db`, or `worker/sdk-bridge-container`.
 *
 * The worker helpers operate on Web `Request`/`Response` and parsed JSON. Node
 * 24 ships global `fetch`/`Request`/`Response`/`ReadableStream`/`crypto`, so we
 * only need thin adapters between `node:http` messages and Web types.
 */
import { once } from "node:events";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { buffer } from "node:stream/consumers";

import {
  createCursorCompletion,
  resolveCursorModel,
  streamCursorText,
  collectCursorOutput,
} from "@/api/cursor";
import type { CursorTextEvent } from "@/api/cursor";
import {
  createCursorSdkCompletion,
  collectCursorSdkOutput,
} from "@/api/cursor-sdk";
import {
  errorResponse,
  json,
  notFound,
  openAiError,
  sseResponse,
  unauthorized,
} from "@/api/http";
import {
  chatChunk,
  chatCompletionResponse,
  chatUsageChunk,
  completionCharsFromOutput,
  doneChunk,
  modelList,
  prepareChatRequest,
  prepareResponsesRequest,
  responseCreatedEvents,
  responseDeltaEvent,
  responseDoneEvents,
  responseObject,
  responseTextStartEvents,
  responseToolCallEvents,
  toOpenAiToolCalls,
  toolCallRetryHint,
} from "@/api/openai";
import type {
  OpenAiToolCall,
  OpenAiToolSpec,
  ToolCallContext,
} from "@/api/openai";
import { encodeSse } from "@/api/sse";
import type { CursorToolCall, Deps, Env } from "@/api/types";
import { DEFAULT_PORT } from "@/config";

import {
  anthropicError,
  anthropicMessage,
  anthropicSseEvents,
  anthropicToChatBody,
  estimateTokens,
  mapModel,
} from "./anthropic";

const HOST = "127.0.0.1";

interface ByteChunkReader {
  read: () => Promise<
    { done: false; value: Uint8Array } | { done: true; value?: undefined }
  >;
  releaseLock: () => void;
}

const LOCAL_API_KEY_LITERAL = "cursor-local";

const PRIMARY_MODEL = "composer-2.5";

const FAST_MODEL = "composer-2.5-fast";

/**
 * Minimal `Deps` backed by the real runtime. Identical in spirit to the
 * worker's `defaultDeps`, but with no Cloudflare assumptions.
 */
const deps: Deps = {
  fetch: ((input, init) => fetch(input, init)) as Deps["fetch"],
  now: () => new Date(),
  randomUUID: () => crypto.randomUUID(),
};

/**
 * Best-effort, in-memory store for the Responses API so that
 * `GET/DELETE /v1/responses/{id}` can echo a previously created response.
 */
interface StoredResponse {
  response: Record<string, unknown>;
  updatedAt: number;
}

const responseStore = new Map<string, StoredResponse>();

const RESPONSE_STORE_LIMIT = 512;

// ---------------------------------------------------------------------------
// SDK bridge path (full macOS parity). Mirrors `worker/index.ts`
// `handleSdkPreparedOpenAiRoute`: `createCursorSdkCompletion` ->
// `collectCursorSdkOutput` + `chatCompletionResponse`/`responseObject` (non-stream)
// or `streamOpenAiEvents` over `completion.stream` (stream). The SDK completion's
// `.stream` is already an `AsyncIterable<CursorTextEvent>`, so the same
// `streamOpenAiEvents` / collected-output builders work unchanged.
// ---------------------------------------------------------------------------
type PreparedRequest =
  | ReturnType<typeof prepareChatRequest>
  | ReturnType<typeof prepareResponsesRequest>;

// ---------------------------------------------------------------------------
// Streaming glue. This mirrors `streamOpenAiEvents` from `worker/index.ts` but
// runs the pump directly (no `ExecutionContext.waitUntil`) and skips the
// request-log bookkeeping that only exists on the hosted proxy path.
// ---------------------------------------------------------------------------
interface StreamInput {
  id: string;
  created: number;
  model: string;
  promptChars: number;
  includeUsage: boolean;
  metadata?: Record<string, unknown>;
  tools: OpenAiToolSpec[];
  context?: ToolCallContext;
  onDone?: (
    text: string,
    completionChars: number,
    toolCalls: OpenAiToolCall[]
  ) => void;
}

interface HttpServerHandle {
  port: number;
  close: () => Promise<void>;
}

const ignoreError = function ignoreError() {
  void 0;
};

const BEARER_TOKEN_PATTERN = /^Bearer\s+(?<token>.+)$/iu;

const TRAILING_SLASHES_PATTERN = /\/+$/u;

const MODEL_PATH_PATTERN = /^\/models\/(?<id>.+)$/u;

const RESPONSE_PATH_PATTERN = /^\/responses\/(?<id>[^/]+)$/u;

const buildEnv = function buildEnv(): Env {
  return {
    ASSETS: undefined as unknown as Env["ASSETS"],
    CURSOR_API_BASE: process.env.CURSOR_API_BASE || "https://api.cursor.com",
    CURSOR_BACKEND_BASE_URL: process.env.CURSOR_BACKEND_BASE_URL,
    CURSOR_CHAT_ENDPOINT: process.env.CURSOR_CHAT_ENDPOINT,
    CURSOR_CLIENT_VERSION: process.env.CURSOR_CLIENT_VERSION || "2.6.22",
    CURSOR_SDK_BRIDGE_TIMEOUT_MS: process.env.CURSOR_SDK_BRIDGE_RUN_TIMEOUT_MS,
    CURSOR_SDK_BRIDGE_TOKEN: process.env.CURSOR_SDK_BRIDGE_TOKEN,
    CURSOR_SDK_BRIDGE_URL: process.env.CURSOR_SDK_BRIDGE_URL,
    DB: undefined as unknown as Env["DB"],
    ENCRYPTION_KEY: process.env.ENCRYPTION_KEY || "api-for-cursor",
  };
};

const env = (): Env => buildEnv();

const hasSdkBridge = function hasSdkBridge(): boolean {
  return Boolean(env().CURSOR_SDK_BRIDGE_URL?.trim());
};

const sessionAffinity = function sessionAffinity(request: Request): string {
  const { headers } = request;
  const candidate =
    headers.get("x-session-affinity") ||
    headers.get("x-opencode-session-id") ||
    headers.get("x-opencode-session") ||
    headers.get("idempotency-key") ||
    "";
  const trimmed = candidate.trim();
  return trimmed || `session-${crypto.randomUUID()}`;
};

const sdkSessionOwner = function sdkSessionOwner(apiKey: string): string {
  return `cursor-key:${apiKey}`;
};

const storeResponse = function storeResponse(
  id: string,
  response: Record<string, unknown>
): void {
  responseStore.set(id, { response, updatedAt: Date.now() });
  if (responseStore.size <= RESPONSE_STORE_LIMIT) {
    return;
  }
  const entries = [...responseStore.entries()].toSorted(
    (a, b) => a[1].updatedAt - b[1].updatedAt
  );
  for (const [key] of entries.slice(
    0,
    responseStore.size - RESPONSE_STORE_LIMIT
  )) {
    responseStore.delete(key);
  }
};

const resolveApiKey = function resolveApiKey(request: Request): string {
  // Anthropic clients (Claude Code) send the key as `x-api-key`; OpenAI clients use
  // `Authorization: Bearer`. Either source, with `cursor-local`/empty falling back to the
  // env key (Credential Manager).
  const apiKeyHeader = (request.headers.get("x-api-key") || "").trim();
  const authorization = request.headers.get("authorization") || "";
  const match = BEARER_TOKEN_PATTERN.exec(authorization.trim());
  const bearer = match?.groups?.token?.trim() ?? "";
  const candidate = apiKeyHeader || bearer;
  if (candidate && candidate !== LOCAL_API_KEY_LITERAL) {
    return candidate;
  }
  return (process.env.CURSOR_API_KEY || "").trim();
};

const healthResponse = function healthResponse(port: number): Response {
  return json({
    baseUrl: `http://${HOST}:${port}/v1`,
    host: HOST,
    models: [PRIMARY_MODEL, FAST_MODEL],
    ok: true,
    service: "cursor-api-windows",
  });
};

const handleModels = function handleModels(): Response {
  return json(modelList());
};

const handleModel = function handleModel(id: string): Response {
  const list = modelList().data as Record<string, unknown>[];
  const model = list.find((item) => item.id === id);
  if (!model) {
    return openAiError(`Model '${id}' not found`, 404, "not_found", "model");
  }
  return json(model);
};

const sdkAllowToolCall = function sdkAllowToolCall(
  prepared: PreparedRequest,
  toolCall: CursorToolCall
) {
  if (!prepared.tools.length) {
    return "No client tool inventory was available for this request.";
  }
  const toolCalls = toOpenAiToolCalls({
    context: prepared.toolContext,
    responseId: "probe",
    toolCalls: [toolCall],
    tools: prepared.tools,
  });
  return (
    toolCalls.length > 0 ||
    toolCallRetryHint({
      context: prepared.toolContext,
      toolCall,
      tools: prepared.tools,
    })
  );
};

const isTransientSdkError = function isTransientSdkError(
  error: unknown
): boolean {
  const message = (
    error instanceof Error ? error.message : String(error ?? "")
  ).toLowerCase();
  const status = (
    error as {
      status?: number;
    } | null
  )?.status;
  const code = (
    error as {
      code?: string;
    } | null
  )?.code;
  return (
    code === "cursor_sdk_timeout" ||
    status === 502 ||
    status === 503 ||
    status === 504 ||
    message.includes("timed out") ||
    message.includes("timeout") ||
    message.includes("unable to connect")
  );
};

const retryingSdkStream = function retryingSdkStream(
  make: (attempt: number) => Promise<AsyncIterable<CursorTextEvent>>,
  maxAttempts = 2
): AsyncIterable<CursorTextEvent> {
  return {
    async *[Symbol.asyncIterator]() {
      const runAttempt = async function* runAttempt(
        attempt: number
      ): AsyncGenerator<CursorTextEvent> {
        const iterable = await make(attempt);
        const iterator = iterable[Symbol.asyncIterator]();
        let emitted = false;
        try {
          const pump = async function* pump(): AsyncGenerator<CursorTextEvent> {
            const next = await iterator.next();
            if (next.done) {
              return;
            }
            emitted = true;
            yield next.value;
            yield* pump();
          };
          yield* pump();
        } catch (error) {
          try {
            await iterator.return?.();
          } catch {
            /* ignore iterator cleanup */
          }
          if (
            !emitted &&
            attempt + 1 < maxAttempts &&
            isTransientSdkError(error)
          ) {
            yield* runAttempt(attempt + 1);
            return;
          }
          throw error;
        }
      };
      yield* runAttempt(0);
    },
  };
};

interface OpenAiStreamPumpState {
  text: string;
  toolCallCount: number;
  finishReason: "stop" | "tool_calls";
  streamedToolCalls: OpenAiToolCall[];
  responseNextOutputIndex: number;
  responseTextOutputIndex: number | null;
}

const createOpenAiStreamPumpState =
  function createOpenAiStreamPumpState(): OpenAiStreamPumpState {
    return {
      finishReason: "stop",
      responseNextOutputIndex: 0,
      responseTextOutputIndex: null,
      streamedToolCalls: [],
      text: "",
      toolCallCount: 0,
    };
  };

const writeUint8Chunks = async function writeUint8Chunks(
  writer: WritableStreamDefaultWriter<Uint8Array>,
  chunks: Uint8Array[],
  index = 0
): Promise<void> {
  if (index >= chunks.length) {
    return;
  }
  await writer.write(chunks[index]);
  await writeUint8Chunks(writer, chunks, index + 1);
};

const writeOpenAiStreamPreamble = async function writeOpenAiStreamPreamble(
  kind: "chat" | "responses",
  writer: WritableStreamDefaultWriter<Uint8Array>,
  input: StreamInput
): Promise<void> {
  if (kind === "chat") {
    await writer.write(
      chatChunk({
        created: input.created,
        id: input.id,
        model: input.model,
        role: "assistant",
      })
    );
    return;
  }
  await writeUint8Chunks(writer, [...responseCreatedEvents(input)]);
};

const writeOpenAiTextEvent = async function writeOpenAiTextEvent(
  kind: "chat" | "responses",
  writer: WritableStreamDefaultWriter<Uint8Array>,
  input: StreamInput,
  state: OpenAiStreamPumpState,
  delta: string
): Promise<void> {
  state.text += delta;
  if (kind === "chat") {
    await writer.write(
      chatChunk({
        created: input.created,
        delta,
        id: input.id,
        model: input.model,
      })
    );
    return;
  }
  if (state.responseTextOutputIndex === null) {
    state.responseTextOutputIndex = state.responseNextOutputIndex;
    state.responseNextOutputIndex += 1;
    await writeUint8Chunks(writer, [
      ...responseTextStartEvents({
        id: input.id,
        outputIndex: state.responseTextOutputIndex,
      }),
    ]);
  }
  await writer.write(
    responseDeltaEvent({
      delta,
      id: input.id,
      outputIndex: state.responseTextOutputIndex,
    })
  );
};

const writeOpenAiToolCallEvent = async function writeOpenAiToolCallEvent(
  kind: "chat" | "responses",
  writer: WritableStreamDefaultWriter<Uint8Array>,
  input: StreamInput,
  state: OpenAiStreamPumpState,
  toolCall: OpenAiToolCall
): Promise<void> {
  state.finishReason = "tool_calls";
  state.streamedToolCalls.push(toolCall);
  if (kind === "chat") {
    await writer.write(
      chatChunk({
        created: input.created,
        id: input.id,
        model: input.model,
        toolCall: { index: state.toolCallCount, value: toolCall },
      })
    );
    state.toolCallCount += 1;
    return;
  }
  await writeUint8Chunks(writer, [
    ...responseToolCallEvents({
      id: input.id,
      outputIndex: state.responseNextOutputIndex,
      toolCall,
    }),
  ]);
  state.responseNextOutputIndex += 1;
  state.toolCallCount += 1;
};

const processOpenAiCursorEvent = async function processOpenAiCursorEvent(
  kind: "chat" | "responses",
  writer: WritableStreamDefaultWriter<Uint8Array>,
  input: StreamInput,
  state: OpenAiStreamPumpState,
  event: CursorTextEvent
): Promise<void> {
  if (event.type === "text" && event.text) {
    await writeOpenAiTextEvent(kind, writer, input, state, event.text);
    return;
  }
  if (event.type === "tool_call") {
    const [toolCall] = toOpenAiToolCalls({
      context: input.context,
      responseId: input.id,
      startIndex: state.toolCallCount,
      toolCalls: [event.toolCall],
      tools: input.tools,
    });
    if (toolCall) {
      await writeOpenAiToolCallEvent(kind, writer, input, state, toolCall);
    }
    return;
  }
  if (event.type === "done") {
    state.text = event.finalText;
  }
};

const pumpOpenAiCursorEvents = async function pumpOpenAiCursorEvents(
  kind: "chat" | "responses",
  writer: WritableStreamDefaultWriter<Uint8Array>,
  input: StreamInput,
  state: OpenAiStreamPumpState,
  iterator: AsyncIterator<CursorTextEvent>
): Promise<void> {
  const next = await iterator.next();
  if (next.done) {
    return;
  }
  await processOpenAiCursorEvent(kind, writer, input, state, next.value);
  await pumpOpenAiCursorEvents(kind, writer, input, state, iterator);
};

const writeOpenAiStreamEpilogue = async function writeOpenAiStreamEpilogue(
  kind: "chat" | "responses",
  writer: WritableStreamDefaultWriter<Uint8Array>,
  input: StreamInput,
  state: OpenAiStreamPumpState
): Promise<void> {
  if (kind === "chat") {
    const completionChars = completionCharsFromOutput(
      state.text,
      state.streamedToolCalls
    );
    await writer.write(
      chatChunk({
        created: input.created,
        finish: true,
        finishReason: state.finishReason,
        id: input.id,
        model: input.model,
      })
    );
    if (input.includeUsage) {
      await writer.write(
        chatUsageChunk({
          completionChars,
          created: input.created,
          id: input.id,
          model: input.model,
          promptChars: input.promptChars,
        })
      );
    }
    await writer.write(doneChunk());
    return;
  }
  if (
    state.responseTextOutputIndex === null &&
    !state.streamedToolCalls.length
  ) {
    state.responseTextOutputIndex = state.responseNextOutputIndex;
    state.responseNextOutputIndex += 1;
    await writeUint8Chunks(writer, [
      ...responseTextStartEvents({
        id: input.id,
        outputIndex: state.responseTextOutputIndex,
      }),
    ]);
  }
  await writeUint8Chunks(writer, [
    ...responseDoneEvents({
      ...input,
      text: state.text,
      textOutputIndex: state.responseTextOutputIndex ?? 0,
      textStarted: state.responseTextOutputIndex !== null,
      toolCalls: state.streamedToolCalls,
    }),
  ]);
};

const streamOpenAiEvents = function streamOpenAiEvents(
  kind: "chat" | "responses",
  cursorEvents: AsyncIterable<CursorTextEvent>,
  input: StreamInput
): Response {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const pump = async () => {
    const state = createOpenAiStreamPumpState();
    try {
      await writeOpenAiStreamPreamble(kind, writer, input);
      const iterator = cursorEvents[Symbol.asyncIterator]();
      await pumpOpenAiCursorEvents(kind, writer, input, state, iterator);
      await writeOpenAiStreamEpilogue(kind, writer, input, state);
      input.onDone?.(
        state.text,
        completionCharsFromOutput(state.text, state.streamedToolCalls),
        state.streamedToolCalls
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Stream failed";
      await writer
        .write(
          encodeSse(
            {
              error: {
                code: "cursor_stream_error",
                message,
                type: "cursor_error",
              },
            },
            "error"
          )
        )
        .catch(ignoreError);
    } finally {
      await writer.close().catch(ignoreError);
    }
  };
  void pump();
  return sseResponse(readable);
};

const handleSdkRoute = async function handleSdkRoute(
  kind: "chat" | "responses",
  request: Request,
  prepared: PreparedRequest,
  apiKey: string,
  id: string,
  created: number,
  incrementalPrompt?: ReturnType<typeof prepareChatRequest>["prompt"]
): Promise<Response> {
  // Maintain one SDK agent per client session "under the hood": attempt 0 reuses the
  // session (stable affinity key) and sends only the new turn (incrementalPrompt). The
  // bridge re-feeds nothing while the agent is still cached and falls back to the full
  // prompt if it was evicted, so context is never lost. A transparent retry (attempt >= 1)
  // uses a FRESH session + the full prompt, so a transient bridge stall ("run timed out")
  // self-recovers instead of surfacing to the client.
  const baseSessionKey = sessionAffinity(request);
  const makeStream = async (
    attempt: number
  ): Promise<AsyncIterable<CursorTextEvent>> => {
    const completion = await createCursorSdkCompletion(env(), deps, apiKey, {
      allowToolCall: (toolCall) => sdkAllowToolCall(prepared, toolCall),
      clientTools: prepared.tools,
      incrementalPrompt: attempt === 0 ? incrementalPrompt : undefined,
      model: prepared.cursorModel,
      prompt: prepared.prompt,
      requiresLocalTool: prepared.requiresLocalTool,
      sessionKey:
        attempt === 0 ? baseSessionKey : `retry-${crypto.randomUUID()}`,
      sessionOwnerKey: sdkSessionOwner(apiKey),
      workingDirectory: prepared.toolContext?.workingDirectory,
    });
    return completion.stream;
  };
  const stream = retryingSdkStream(makeStream);
  if (prepared.stream) {
    return streamOpenAiEvents(kind, stream, {
      context: prepared.toolContext,
      created,
      id,
      includeUsage: prepared.includeUsage,
      metadata: prepared.responseMetadata,
      model: prepared.model,
      onDone: (text, _completionChars, toolCalls) => {
        if (kind === "responses") {
          storeResponse(
            id,
            responseObject({
              created,
              id,
              metadata: prepared.responseMetadata,
              model: prepared.model,
              promptChars: prepared.promptChars,
              text,
              toolCalls,
            })
          );
        }
      },
      promptChars: prepared.promptChars,
      tools: prepared.tools,
    });
  }
  const output = await collectCursorSdkOutput(stream);
  const toolCalls = toOpenAiToolCalls({
    context: prepared.toolContext,
    responseId: id,
    toolCalls: output.toolCalls,
    tools: prepared.tools,
  });
  if (kind === "chat") {
    return json(
      chatCompletionResponse({
        created,
        id,
        metadata: prepared.responseMetadata,
        model: prepared.model,
        promptChars: prepared.promptChars,
        text: output.text,
        toolCalls,
      })
    );
  }
  const response = responseObject({
    created,
    id,
    metadata: prepared.responseMetadata,
    model: prepared.model,
    promptChars: prepared.promptChars,
    text: output.text,
    toolCalls,
  });
  storeResponse(id, response);
  return json(response);
};

const chatIncrementalPrompt = function chatIncrementalPrompt(
  body: unknown,
  cursorModel:
    | {
        id: string;
      }
    | undefined
): ReturnType<typeof prepareChatRequest>["prompt"] | undefined {
  const messages = (
    body as {
      messages?: {
        role?: string;
      }[];
    } | null
  )?.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    return undefined;
  }
  let lastAssistant = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === "assistant") {
      lastAssistant = i;
      break;
    }
  }
  if (lastAssistant < 0 || lastAssistant >= messages.length - 1) {
    return undefined;
  }
  const tail = messages.slice(lastAssistant + 1);
  try {
    const deltaBody = {
      ...(body as Record<string, unknown>),
      messages: tail,
      stream: false,
    };
    return prepareChatRequest(
      deltaBody as Parameters<typeof prepareChatRequest>[0],
      cursorModel
    ).prompt;
  } catch {
    return undefined;
  }
};

const streamOpenAiResponse = function streamOpenAiResponse(
  kind: "chat" | "responses",
  cursorStream: Response,
  input: StreamInput
): Response {
  return streamOpenAiEvents(kind, streamCursorText(cursorStream), input);
};

const handleChatCompletions = async function handleChatCompletions(
  request: Request
): Promise<Response> {
  const apiKey = resolveApiKey(request);
  if (!apiKey) {
    return unauthorized();
  }
  const body = await request.json();
  const requestedModel =
    typeof (
      body as {
        model?: unknown;
      }
    )?.model === "string"
      ? (
          body as {
            model: string;
          }
        ).model
      : PRIMARY_MODEL;
  const cursorModel = resolveCursorModel(requestedModel);
  const prepared = prepareChatRequest(body, cursorModel);
  const id = `chatcmpl_${crypto.randomUUID().replaceAll("-", "")}`;
  const created = Math.floor(deps.now().getTime() / 1000);
  if (hasSdkBridge()) {
    return handleSdkRoute(
      "chat",
      request,
      prepared,
      apiKey,
      id,
      created,
      chatIncrementalPrompt(body, cursorModel)
    );
  }
  const completion = await createCursorCompletion(env(), deps, apiKey, {
    model: prepared.cursorModel,
    prompt: prepared.prompt,
  });
  if (prepared.stream) {
    return streamOpenAiResponse("chat", completion.stream, {
      context: prepared.toolContext,
      created,
      id,
      includeUsage: prepared.includeUsage,
      model: prepared.model,
      promptChars: prepared.promptChars,
      tools: prepared.tools,
    });
  }
  const output = await collectCursorOutput(completion.stream);
  const toolCalls = toOpenAiToolCalls({
    context: prepared.toolContext,
    responseId: id,
    toolCalls: output.toolCalls,
    tools: prepared.tools,
  });
  return json(
    chatCompletionResponse({
      created,
      id,
      metadata: prepared.responseMetadata,
      model: prepared.model,
      promptChars: prepared.promptChars,
      text: output.text,
      toolCalls,
    })
  );
};

const handleResponses = async function handleResponses(
  request: Request
): Promise<Response> {
  const apiKey = resolveApiKey(request);
  if (!apiKey) {
    return unauthorized();
  }
  const body = await request.json();
  const requestedModel =
    typeof (
      body as {
        model?: unknown;
      }
    )?.model === "string"
      ? (
          body as {
            model: string;
          }
        ).model
      : PRIMARY_MODEL;
  const cursorModel = resolveCursorModel(requestedModel);
  const prepared = prepareResponsesRequest(body, cursorModel);
  const id = `resp_${crypto.randomUUID().replaceAll("-", "")}`;
  const created = Math.floor(deps.now().getTime() / 1000);
  if (hasSdkBridge()) {
    return handleSdkRoute("responses", request, prepared, apiKey, id, created);
  }
  const completion = await createCursorCompletion(env(), deps, apiKey, {
    model: prepared.cursorModel,
    prompt: prepared.prompt,
  });
  if (prepared.stream) {
    return streamOpenAiResponse("responses", completion.stream, {
      context: prepared.toolContext,
      created,
      id,
      includeUsage: prepared.includeUsage,
      metadata: prepared.responseMetadata,
      model: prepared.model,
      onDone: (text, _completionChars, toolCalls) => {
        storeResponse(
          id,
          responseObject({
            created,
            id,
            metadata: prepared.responseMetadata,
            model: prepared.model,
            promptChars: prepared.promptChars,
            text,
            toolCalls,
          })
        );
      },
      promptChars: prepared.promptChars,
      tools: prepared.tools,
    });
  }
  const output = await collectCursorOutput(completion.stream);
  const toolCalls = toOpenAiToolCalls({
    context: prepared.toolContext,
    responseId: id,
    toolCalls: output.toolCalls,
    tools: prepared.tools,
  });
  const response = responseObject({
    created,
    id,
    metadata: prepared.responseMetadata,
    model: prepared.model,
    promptChars: prepared.promptChars,
    text: output.text,
    toolCalls,
  });
  storeResponse(id, response);
  return json(response);
};

const anthropicSseResponse = function anthropicSseResponse(
  events: AsyncGenerator<{
    event: string;
    data: Record<string, unknown>;
  }>
): Response {
  const readable = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const { event, data } of events) {
          controller.enqueue(encodeSse(data, event));
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        controller.enqueue(
          encodeSse(anthropicError(message, "api_error"), "error")
        );
      } finally {
        controller.close();
      }
    },
  });
  return sseResponse(readable);
};

const handleAnthropicMessages = async function handleAnthropicMessages(
  request: Request
): Promise<Response> {
  const apiKey = resolveApiKey(request);
  if (!apiKey) {
    return json(
      anthropicError("Missing or invalid x-api-key.", "authentication_error"),
      { status: 401 }
    );
  }
  const body = await request.json();
  const requestedModel =
    body &&
    typeof body === "object" &&
    typeof (
      body as {
        model?: unknown;
      }
    ).model === "string"
      ? (
          body as {
            model: string;
          }
        ).model
      : "claude";
  const cursorModel = resolveCursorModel(mapModel(requestedModel));
  const prepared = prepareChatRequest(anthropicToChatBody(body), cursorModel);
  const id = `msg_${crypto.randomUUID().replaceAll("-", "")}`;
  const inputTokens = estimateTokens(prepared.promptChars);
  // Claude Code resends the full conversation (incl. tool_result) every turn, so /v1/messages is
  // stateless: a fresh SDK session + full prompt per request, plus the transparent auto-retry.
  const makeStream = async (
    _attempt: number
  ): Promise<AsyncIterable<CursorTextEvent>> => {
    const completion = await createCursorSdkCompletion(env(), deps, apiKey, {
      allowToolCall: (toolCall) => sdkAllowToolCall(prepared, toolCall),
      clientTools: prepared.tools,
      model: prepared.cursorModel,
      prompt: prepared.prompt,
      requiresLocalTool: prepared.requiresLocalTool,
      sessionKey: `cc-${crypto.randomUUID()}`,
      sessionOwnerKey: sdkSessionOwner(apiKey),
      workingDirectory: prepared.toolContext?.workingDirectory,
    });
    return completion.stream;
  };
  const stream = retryingSdkStream(makeStream);
  if (prepared.stream) {
    return anthropicSseResponse(
      anthropicSseEvents({ id, inputTokens, model: requestedModel, stream })
    );
  }
  const output = await collectCursorSdkOutput(stream);
  return json(
    anthropicMessage({
      id,
      inputTokens,
      model: requestedModel,
      outputTokens: estimateTokens(output.text.length),
      text: output.text,
      toolCalls: output.toolCalls,
    })
  );
};

const handleCountTokens = async function handleCountTokens(
  request: Request
): Promise<Response> {
  const body = await request.json();
  const prepared = prepareChatRequest(
    anthropicToChatBody(body),
    resolveCursorModel(mapModel(""))
  );
  return json({ input_tokens: estimateTokens(prepared.promptChars) });
};

const handleResponseState = function handleResponseState(
  request: Request,
  responseId: string
): Response {
  const stored = responseStore.get(responseId);
  if (!stored) {
    return openAiError("Response not found", 404, "not_found");
  }
  if (request.method === "GET" || request.method === "HEAD") {
    return json(stored.response);
  }
  if (request.method === "DELETE") {
    responseStore.delete(responseId);
    return json({ deleted: true, id: responseId, object: "response" });
  }
  return notFound();
};

const resolveV1Path = function resolveV1Path(pathname: string): string {
  if (pathname.startsWith("/v1/")) {
    return pathname.slice(3);
  }
  if (pathname === "/v1") {
    return "/";
  }
  return "";
};

const routeV1Path = async function routeV1Path(
  request: Request,
  v1Path: string
): Promise<Response> {
  if (v1Path === "/models") {
    return request.method === "GET" ? handleModels() : notFound();
  }
  const modelMatch = MODEL_PATH_PATTERN.exec(v1Path);
  if (modelMatch?.groups?.id) {
    return request.method === "GET"
      ? handleModel(decodeURIComponent(modelMatch.groups.id))
      : notFound();
  }
  if (v1Path === "/chat/completions") {
    return request.method === "POST"
      ? await handleChatCompletions(request)
      : notFound();
  }
  if (v1Path === "/responses") {
    return request.method === "POST"
      ? await handleResponses(request)
      : notFound();
  }
  if (v1Path === "/messages/count_tokens") {
    return request.method === "POST"
      ? await handleCountTokens(request)
      : notFound();
  }
  if (v1Path === "/messages") {
    return request.method === "POST"
      ? await handleAnthropicMessages(request)
      : notFound();
  }
  const responseMatch = RESPONSE_PATH_PATTERN.exec(v1Path);
  if (responseMatch?.groups?.id) {
    return handleResponseState(
      request,
      decodeURIComponent(responseMatch.groups.id)
    );
  }
  return notFound();
};

const route = async function route(
  request: Request,
  port: number
): Promise<Response> {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "access-control-allow-headers": "authorization,content-type,x-api-key",
        "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
        "access-control-allow-origin": "*",
      },
      status: 204,
    });
  }
  const url = new URL(request.url);
  const pathname = url.pathname.replace(TRAILING_SLASHES_PATTERN, "") || "/";
  try {
    if (pathname === "/health") {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return notFound();
      }
      return healthResponse(port);
    }
    const v1Path = resolveV1Path(pathname);
    if (v1Path) {
      return await routeV1Path(request, v1Path);
    }
    return notFound();
  } catch (error) {
    return errorResponse(error);
  }
};

const toWebRequest = function toWebRequest(
  req: IncomingMessage,
  port: number
): Request {
  const method = req.method || "GET";
  const url = `http://${HOST}:${port}${req.url || "/"}`;
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) {
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        headers.append(key, item);
      }
    } else {
      headers.set(key, value);
    }
  }
  const init: RequestInit = { headers, method };
  if (method !== "GET" && method !== "HEAD") {
    const bodyPromise = buffer(req);
    init.body = new ReadableStream<Uint8Array>({
      async start(controller) {
        const bodyBuffer = await bodyPromise;
        if (bodyBuffer.length) {
          controller.enqueue(new Uint8Array(bodyBuffer));
        }
        controller.close();
      },
    });
    (
      init as {
        duplex?: string;
      }
    ).duplex = "half";
  }
  return new Request(url, init);
};

const pumpResponseBody = async function pumpResponseBody(
  res: ServerResponse,
  reader: ByteChunkReader
): Promise<void> {
  const next = await reader.read();
  if (next.done) {
    return;
  }
  if (next.value) {
    res.write(Buffer.from(next.value));
  }
  await pumpResponseBody(res, reader);
};

const writeWebResponse = async function writeWebResponse(
  res: ServerResponse,
  response: Response
): Promise<void> {
  const headers: Record<string, string> = {};
  for (const [key, value] of response.headers) {
    headers[key] = value;
  }
  res.writeHead(response.status, headers);
  if (!response.body) {
    res.end();
    return;
  }
  const reader = response.body.getReader() as ByteChunkReader;
  try {
    await pumpResponseBody(res, reader);
  } finally {
    reader.releaseLock();
    res.end();
  }
};

const handleHttpRequest = async function handleHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  port: number
): Promise<void> {
  try {
    const request = toWebRequest(req, port);
    const response = await route(request, port);
    await writeWebResponse(res, response);
  } catch (error) {
    const response = errorResponse(error);
    try {
      await writeWebResponse(res, response);
    } catch {
      if (!res.headersSent) {
        res.writeHead(500);
      }
      res.end();
    }
  }
};

const parsePort = function parsePort(raw = process.env.PORT): number {
  if (!raw) {
    return DEFAULT_PORT;
  }
  const value = Number.parseInt(raw, 10);
  return Number.isInteger(value) && value > 0 && value < 65_536
    ? value
    : DEFAULT_PORT;
};

export const startHttpServer = async function startHttpServer(
  port = parsePort()
): Promise<HttpServerHandle> {
  const server = createServer((req, res) => {
    void handleHttpRequest(req, res, port);
  });
  server.listen(port, HOST);
  await once(server, "listening");
  return {
    close: async () => {
      const closed = once(server, "close");
      server.close();
      await closed;
    },
    port,
  };
};
