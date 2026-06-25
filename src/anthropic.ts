/**
 * Anthropic Messages API <-> OpenAI/Cursor adapter (sidecar-local, pure translation).
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
import type { CursorToolCall } from "@/api/types";

const PRIMARY_MODEL = "composer-2.5";

type Block = Record<string, unknown>;

interface Msg {
  role?: string;
  content?: unknown;
}

const asArray = function asArray<T = unknown>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
};

const isRecord = function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
};

export const mapModel = function mapModel(_model: unknown): string {
  return PRIMARY_MODEL;
};

export const estimateTokens = function estimateTokens(chars: number): number {
  return Math.max(1, Math.ceil(chars / 4));
};

export const anthropicError = function anthropicError(
  message: string,
  type = "api_error"
): {
  type: "error";
  error: {
    type: string;
    message: string;
  };
} {
  return { error: { message, type }, type: "error" };
};

export const flattenToolResultContent = function flattenToolResultContent(
  content: unknown,
  isError = false
): string {
  let text: string;
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    text = content
      .map((b) => {
        if (!isRecord(b)) {
          return typeof b === "string" ? b : "";
        }
        if (b.type === "text" && typeof b.text === "string") {
          return b.text;
        }
        if (b.type === "image") {
          return "[image]";
        }
        return typeof b.text === "string" ? b.text : JSON.stringify(b);
      })
      .filter(Boolean)
      .join("\n");
  } else {
    text = content === null || content === undefined ? "" : String(content);
  }
  return isError ? `[tool error] ${text}` : text;
};

export const mapToolChoice = function mapToolChoice(tc: unknown): unknown {
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
      return typeof tc.name === "string"
        ? { function: { name: tc.name }, type: "function" }
        : undefined;
    }
    default: {
      return undefined;
    }
  }
};

const imagePartFromBlock = function imagePartFromBlock(
  block: Block
): Record<string, unknown> | null {
  const source = isRecord(block.source) ? block.source : null;
  if (source && source.type === "base64" && typeof source.data === "string") {
    const mediaType =
      typeof source.media_type === "string" ? source.media_type : "image/png";
    return {
      image_url: { url: `data:${mediaType};base64,${source.data}` },
      type: "image_url",
    };
  }
  // url / file sources are best-effort: surface as text so we never crash.
  if (source && source.type === "url" && typeof source.url === "string") {
    return { image_url: { url: source.url }, type: "image_url" };
  }
  return null;
};

const appendSystemMessages = (
  record: Record<string, unknown>,
  messages: Record<string, unknown>[]
): void => {
  const { system } = record;
  if (typeof system === "string" && system.trim()) {
    messages.push({ content: system, role: "system" });
    return;
  }
  if (!Array.isArray(system)) {
    return;
  }
  const text = system
    .map((block) =>
      isRecord(block) && typeof block.text === "string" ? block.text : ""
    )
    .filter(Boolean)
    .join("\n");
  if (text) {
    messages.push({ content: text, role: "system" });
  }
};

const appendAssistantMessage = (
  blocks: Block[],
  messages: Record<string, unknown>[]
): void => {
  const parts: Record<string, unknown>[] = [];
  const toolCalls: Record<string, unknown>[] = [];
  for (const block of blocks) {
    if (!isRecord(block)) {
      continue;
    }
    if (block.type === "text" && typeof block.text === "string") {
      parts.push({ text: block.text, type: "text" });
    } else if (block.type === "tool_use") {
      toolCalls.push({
        function: {
          arguments: JSON.stringify(block.input ?? {}),
          name: typeof block.name === "string" ? block.name : "",
        },
        id:
          typeof block.id === "string" ? block.id : `toolu_${toolCalls.length}`,
        type: "function",
      });
    }
  }
  const assistant: Record<string, unknown> = {
    content: parts.length ? parts : null,
    role: "assistant",
  };
  if (toolCalls.length) {
    assistant.tool_calls = toolCalls;
  }
  messages.push(assistant);
};

const appendUserMessage = (
  blocks: Block[],
  messages: Record<string, unknown>[]
): void => {
  const userParts: Record<string, unknown>[] = [];
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
        tool_call_id:
          typeof block.tool_use_id === "string" ? block.tool_use_id : "",
      });
    } else if (block.type === "text" && typeof block.text === "string") {
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
  record: Record<string, unknown>,
  messages: Record<string, unknown>[]
): void => {
  for (const raw of asArray<Msg>(record.messages)) {
    const role = raw?.role === "assistant" ? "assistant" : "user";
    const content = raw?.content;
    if (typeof content === "string") {
      messages.push({ content, role });
      continue;
    }
    const blocks = asArray<Block>(content);
    if (role === "assistant") {
      appendAssistantMessage(blocks, messages);
      continue;
    }
    appendUserMessage(blocks, messages);
  }
};

export const anthropicToChatBody = function anthropicToChatBody(
  body: unknown
): Record<string, unknown> {
  const record = isRecord(body) ? body : {};
  const out: Record<string, unknown> = {
    model: PRIMARY_MODEL,
    stream: record.stream === true,
  };
  const messages: Record<string, unknown>[] = [];
  appendSystemMessages(record, messages);
  appendAnthropicMessages(record, messages);
  out.messages = messages;
  const tools = asArray<Block>(record.tools)
    .filter(isRecord)
    .map((t) => ({
      function: {
        name: typeof t.name === "string" ? t.name : "",
        ...(typeof t.description === "string"
          ? { description: t.description }
          : {}),
        parameters: t.input_schema ?? { properties: {}, type: "object" },
      },
      type: "function",
    }));
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
): Record<string, unknown> {
  return {
    id: `toolu_${crypto.randomUUID().replaceAll("-", "")}`,
    input: isRecord(toolCall.arguments) ? toolCall.arguments : {},
    name: toolCall.name,
    type: "tool_use",
  };
};

export const anthropicMessage = function anthropicMessage(opts: {
  id: string;
  model: string;
  text: string;
  toolCalls: CursorToolCall[];
  inputTokens: number;
  outputTokens: number;
}): Record<string, unknown> {
  const content: Record<string, unknown>[] = [];
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

export const anthropicSseEvents = async function* anthropicSseEvents(opts: {
  id: string;
  model: string;
  inputTokens: number;
  stream: AsyncIterable<CursorTextEvent>;
}): AsyncGenerator<{
  event: string;
  data: Record<string, unknown>;
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
      const input = block.input as Record<string, unknown>;
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
