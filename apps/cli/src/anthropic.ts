/**
 * Anthropic Messages API to OpenAI/Cursor adapter (sidecar-local, pure translation).
 *
 * Lets Claude Code (CLI) use Cursor's Composer via ANTHROPIC_BASE_URL: we convert an
 * Anthropic `/v1/messages` request into the OpenAI-shaped body that `worker/openai.ts`
 * `prepareChatRequest` already understands, run it through the existing Cursor SDK path,
 * then translate the resulting `CursorTextEvent` stream back into an Anthropic `Message`
 * (non-stream) or Anthropic SSE events (stream).
 *
 * See docs/superpowers/specs/2026-06-02-anthropic-endpoint-claude-code-design.md.
 */
import type { CursorTextEvent } from "@/api/cursor";
import type { CursorToolCall, JsonValue } from "@/api/types";

const PRIMARY_MODEL = "composer-2.5";

interface JsonObject {
  [key: string]: JsonValue;
}

interface AnthropicErrorResponse {
  type: "error";
  error: { type: string; message: string };
}

interface AnthropicToolUseBlock {
  id: string;
  input: JsonObject;
  name: string;
  type: "tool_use";
}

interface AnthropicMessageResponse {
  content: (JsonObject | AnthropicToolUseBlock)[];
  id: string;
  model: string;
  role: "assistant";
  stop_reason: "tool_use" | "end_turn";
  stop_sequence: null;
  type: "message";
  usage: { input_tokens: number; output_tokens: number };
}

const asArray = function asArray(v: JsonValue | undefined): JsonValue[] {
  return Array.isArray(v) ? v : [];
};

const isRecord = function isRecord(v: JsonValue | undefined): v is JsonObject {
  return (
    v !== undefined &&
    v !== null &&
    !Array.isArray(v) &&
    Object.getPrototypeOf(new Object(v)) === Object.prototype
  );
};

const isString = (value: JsonValue | undefined): value is string =>
  value !== undefined &&
  Object.prototype.toString.call(value) === "[object String]";

type OpenAIToolChoice =
  | "required"
  | "none"
  | { function: { name: string }; type: "function" };

/** Map an incoming model name to the configured Composer model.
 * @param _model - Requested model name, currently ignored.
 * @returns The Composer model used by the adapter.
 */
export const mapModel = function mapModel(_model: string): string {
  return PRIMARY_MODEL;
};

/** Estimate token usage from a character count.
 * @param chars - Number of input or output characters.
 * @returns Estimated token count, with a minimum of one.
 */
export const estimateTokens = function estimateTokens(chars: number): number {
  return Math.max(1, Math.ceil(chars / 4));
};

/** Build an Anthropic-compatible error response.
 * @param message - Human-readable error message.
 * @param type - Anthropic error type.
 * @returns The error response body.
 */
export const anthropicError = function anthropicError(
  message: string,
  type = "api_error"
): AnthropicErrorResponse {
  return { error: { message, type }, type: "error" };
};

const flattenContentBlock = (block: JsonValue): string => {
  if (isString(block)) {
    return block;
  }
  if (!isRecord(block)) {
    return "";
  }
  if (block.type === "text" && isString(block.text)) {
    return block.text;
  }
  if (block.type === "image") {
    return "[image]";
  }
  return isString(block.text) ? block.text : JSON.stringify(block);
};

const flattenToolResultContent = function flattenToolResultContent(
  content: JsonValue | undefined,
  isError = false
): string {
  let text = "";
  if (isString(content)) {
    text = content;
  } else if (Array.isArray(content)) {
    const textParts: string[] = [];
    for (const block of content) {
      const part = flattenContentBlock(block);
      if (part) {
        textParts.push(part);
      }
    }
    text = textParts.join("\n");
  } else if (content !== null && content !== undefined) {
    text = String(content);
  }
  return isError ? `[tool error] ${text}` : text;
};

const parseToolArguments = (args: CursorToolCall["arguments"]): JsonObject => {
  const parsed: JsonObject = {};
  for (const [key, value] of Object.entries(args)) {
    const encoded = JSON.stringify(value);
    if (encoded !== undefined) {
      parsed[key] = JSON.parse(encoded);
    }
  }
  return parsed;
};

const mapToolChoice = function mapToolChoice(
  tc: JsonValue | undefined
): OpenAIToolChoice | undefined {
  if (!isRecord(tc)) {
    return undefined;
  }
  switch (tc.type) {
    case "auto": {
      return undefined;
    }
    case "any": {
      return "required";
    }
    case "none": {
      return "none";
    }
    case "tool": {
      return isString(tc.name)
        ? { function: { name: tc.name }, type: "function" }
        : undefined;
    }
    default: {
      return undefined;
    }
  }
};

const imagePartFromBlock = function imagePartFromBlock(
  block: JsonObject
): JsonObject | null {
  const source = isRecord(block.source) ? block.source : null;
  if (source && source.type === "base64" && isString(source.data)) {
    const mediaType = isString(source.media_type)
      ? source.media_type
      : "image/png";
    return {
      image_url: { url: `data:${mediaType};base64,${source.data}` },
      type: "image_url",
    };
  }
  // url / file sources are best-effort: surface as text so we never crash.
  if (source && source.type === "url" && isString(source.url)) {
    return { image_url: { url: source.url }, type: "image_url" };
  }
  return null;
};

const appendSystemMessages = (
  record: JsonObject,
  messages: JsonObject[]
): void => {
  const { system } = record;
  if (isString(system) && system.trim()) {
    messages.push({ content: system, role: "system" });
    return;
  }
  if (!Array.isArray(system)) {
    return;
  }
  const textParts: string[] = [];
  for (const block of system) {
    if (isRecord(block) && isString(block.text) && block.text) {
      textParts.push(block.text);
    }
  }
  const text = textParts.join("\n");
  if (text) {
    messages.push({ content: text, role: "system" });
  }
};

const appendAssistantMessage = (
  blocks: JsonValue[],
  messages: JsonObject[]
): void => {
  const parts: JsonObject[] = [];
  const toolCalls: JsonObject[] = [];
  for (const block of blocks) {
    if (!isRecord(block)) {
      continue;
    }
    if (block.type === "text" && isString(block.text)) {
      parts.push({ text: block.text, type: "text" });
    } else if (block.type === "tool_use") {
      toolCalls.push({
        function: {
          arguments: JSON.stringify(block.input ?? {}),
          name: isString(block.name) ? block.name : "",
        },
        id: isString(block.id) ? block.id : `toolu_${toolCalls.length}`,
        type: "function",
      });
    }
  }
  const assistant: JsonObject = {
    content: parts.length ? parts : null,
    role: "assistant",
  };
  if (toolCalls.length) {
    assistant.tool_calls = toolCalls;
  }
  messages.push(assistant);
};

const appendUserMessage = (
  blocks: JsonValue[],
  messages: JsonObject[]
): void => {
  const userParts: JsonObject[] = [];
  for (const block of blocks) {
    if (!isRecord(block)) {
      continue;
    }
    if (block.type === "tool_result") {
      messages.push({
        content: flattenToolResultContent(
          block.content,
          block.is_error === true
        ),
        role: "tool",
        tool_call_id: isString(block.tool_use_id) ? block.tool_use_id : "",
      });
    } else if (block.type === "text" && isString(block.text)) {
      userParts.push({ text: block.text, type: "text" });
    } else if (block.type === "image") {
      const img = imagePartFromBlock(block);
      userParts.push(
        img ?? { text: "[unsupported image source]", type: "text" }
      );
    }
  }
  if (userParts.length) {
    messages.push({ content: userParts, role: "user" });
  }
};

const appendAnthropicMessages = (
  record: JsonObject,
  messages: JsonObject[]
): void => {
  for (const value of asArray(record.messages)) {
    if (!isRecord(value)) {
      continue;
    }
    const { role: inputRole, content } = value;
    const role = inputRole === "assistant" ? "assistant" : "user";
    if (isString(content)) {
      messages.push({ content, role });
    } else {
      const blocks = asArray(content);
      if (role === "assistant") {
        appendAssistantMessage(blocks, messages);
      } else {
        appendUserMessage(blocks, messages);
      }
    }
  }
};

/** Convert an Anthropic Messages request into the chat-completions shape.
 * @param body - Parsed Anthropic request body.
 * @returns The corresponding OpenAI-compatible request body.
 */
export const anthropicToChatBody = function anthropicToChatBody(
  body: JsonValue
): JsonObject {
  const record = isRecord(body) ? body : {};
  const out: JsonObject = {
    model: PRIMARY_MODEL,
    stream: record.stream === true,
  };
  const messages: JsonObject[] = [];
  appendSystemMessages(record, messages);
  appendAnthropicMessages(record, messages);
  out.messages = messages;
  const tools: JsonObject[] = [];
  for (const candidate of asArray(record.tools)) {
    if (!isRecord(candidate)) {
      continue;
    }
    const tool: JsonObject = {
      function: {
        name: isString(candidate.name) ? candidate.name : "",
        parameters: candidate.input_schema ?? {
          properties: {},
          type: "object",
        },
      },
      type: "function",
    };
    if (isString(candidate.description) && isRecord(tool.function)) {
      tool.function.description = candidate.description;
    }
    tools.push(tool);
  }
  if (tools.length) {
    out.tools = tools;
  }
  const toolChoice = mapToolChoice(record.tool_choice);
  if (toolChoice !== undefined) {
    out.tool_choice = toolChoice;
  }
  return out;
};

const toolUseBlock = function toolUseBlock(
  toolCall: CursorToolCall
): AnthropicToolUseBlock {
  const input = parseToolArguments(toolCall.arguments);
  return {
    id: `toolu_${crypto.randomUUID().replaceAll("-", "")}`,
    input,
    name: toolCall.name,
    type: "tool_use",
  };
};

/** Build a non-streaming Anthropic assistant message.
 * @param opts - Message identity, model, generated content, and usage counts.
 * @returns The Anthropic message response.
 */
export const anthropicMessage = function anthropicMessage(opts: {
  id: string;
  model: string;
  text: string;
  toolCalls: CursorToolCall[];
  inputTokens: number;
  outputTokens: number;
}): AnthropicMessageResponse {
  const content: (JsonObject | AnthropicToolUseBlock)[] = [];
  if (opts.text) {
    content.push({ text: opts.text, type: "text" });
  }
  for (const tc of opts.toolCalls) {
    content.push(toolUseBlock(tc));
  }
  return {
    content,
    id: opts.id,
    model: opts.model,
    role: "assistant",
    stop_reason: opts.toolCalls.length ? "tool_use" : "end_turn",
    stop_sequence: null,
    type: "message",
    usage: { input_tokens: opts.inputTokens, output_tokens: opts.outputTokens },
  };
};

/** Convert Cursor text events into Anthropic Messages SSE events.
 * @param opts - Message identity, model, input usage, and source event stream.
 * @returns An async stream of named Anthropic events and their payloads.
 */
export const anthropicSseEvents = async function* anthropicSseEvents(opts: {
  id: string;
  model: string;
  inputTokens: number;
  stream: AsyncIterable<CursorTextEvent>;
}): AsyncGenerator<{
  event: string;
  data: JsonObject;
}> {
  yield {
    data: {
      message: {
        content: [],
        id: opts.id,
        model: opts.model,
        role: "assistant",
        stop_reason: null,
        stop_sequence: null,
        type: "message",
        usage: { input_tokens: opts.inputTokens, output_tokens: 1 },
      },
      type: "message_start",
    },
    event: "message_start",
  };
  // Index of the open text block, or -1 when none is open.
  let textIndex = -1;
  let nextIndex = 0;
  let outputChars = 0;
  let sawTool = false;
  for await (const event of opts.stream) {
    if (event.type === "text" && event.text) {
      if (textIndex === -1) {
        textIndex = nextIndex;
        nextIndex += 1;
        yield {
          data: {
            content_block: { text: "", type: "text" },
            index: textIndex,
            type: "content_block_start",
          },
          event: "content_block_start",
        };
      }
      outputChars += event.text.length;
      yield {
        data: {
          delta: { text: event.text, type: "text_delta" },
          index: textIndex,
          type: "content_block_delta",
        },
        event: "content_block_delta",
      };
    } else if (event.type === "tool_call" && event.toolCall) {
      if (textIndex !== -1) {
        yield {
          data: { index: textIndex, type: "content_block_stop" },
          event: "content_block_stop",
        };
        textIndex = -1;
      }
      const idx = nextIndex;
      nextIndex += 1;
      const block = toolUseBlock(event.toolCall);
      const input = isRecord(block.input) ? block.input : {};
      yield {
        data: {
          content_block: {
            id: block.id,
            input: {},
            name: block.name,
            type: "tool_use",
          },
          index: idx,
          type: "content_block_start",
        },
        event: "content_block_start",
      };
      yield {
        data: {
          delta: {
            partial_json: JSON.stringify(input),
            type: "input_json_delta",
          },
          index: idx,
          type: "content_block_delta",
        },
        event: "content_block_delta",
      };
      yield {
        data: { index: idx, type: "content_block_stop" },
        event: "content_block_stop",
      };
      sawTool = true;
    } else if (event.type === "done") {
      break;
    }
  }
  if (textIndex !== -1) {
    yield {
      data: { index: textIndex, type: "content_block_stop" },
      event: "content_block_stop",
    };
  }
  yield {
    data: {
      delta: {
        stop_reason: sawTool ? "tool_use" : "end_turn",
        stop_sequence: null,
      },
      type: "message_delta",
      usage: { output_tokens: estimateTokens(outputChars) },
    },
    event: "message_delta",
  };
  yield { data: { type: "message_stop" }, event: "message_stop" };
};
