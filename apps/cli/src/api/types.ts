import "./cloudflare.d.ts";

/** JSON-compatible values accepted by the API. */
export type JsonValue =
  | boolean
  | null
  | number
  | string
  | JsonValue[]
  | JsonObject;

/** A JSON object whose values are JSON-compatible. */
export interface JsonObject {
  [key: string]: JsonValue;
}

/** Values accepted as Cursor tool arguments, including nested objects. */
type CursorToolArgumentValue =
  | JsonValue
  | undefined
  | CursorToolArgumentValue[]
  | { [key: string]: CursorToolArgumentValue };

/** A map of argument names to Cursor tool argument values. */
interface CursorToolArguments {
  [key: string]: CursorToolArgumentValue;
}

/** Runtime bindings available to the API application. */
export interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  RELEASES?: R2Bucket;
  CURSOR_SDK_BRIDGE_CONTAINER?: DurableObjectNamespace;
  ENCRYPTION_KEY?: string;
  CURSOR_API_BASE?: string;
  CURSOR_BACKEND_BASE_URL?: string;
  CURSOR_CHAT_ENDPOINT?: string;
  CURSOR_CLIENT_VERSION?: string;
  CURSOR_LOCAL_AGENT_ENDPOINT?: string;
  CURSOR_SDK_BRIDGE_TOKEN?: string;
  CURSOR_SDK_BRIDGE_TIMEOUT_MS?: string;
  CURSOR_SDK_BRIDGE_URL?: string;
  CURSOR_SDK_CLIENT_VERSION?: string;
  GITHUB_RELEASE_DISPATCH_TOKEN?: string;
  GITHUB_RELEASE_REPOSITORY?: string;
  NOTARY_WEBHOOK_TOKEN?: string;
  WAITLIST_API_TOKEN?: string;
  WAITLIST_SOURCE?: string;
}

/** Injectable runtime dependencies used by the API. */
export interface Deps {
  fetch: typeof fetch;
  now: () => Date;
  randomUUID: () => `${string}-${string}-${string}-${string}-${string}`;
}

/** Parsed identity information returned by Cursor. */
export interface CursorMe {
  apiKeyName: string;
  userId?: number;
  userEmail?: string;
  userFirstName?: string;
  userLastName?: string;
  createdAt: string;
}

/** An image supplied to a Cursor prompt as a URL or encoded data. */
export type CursorImage =
  | {
      url: string;
      dimension?: { width: number; height: number };
      uuid?: string;
    }
  | {
      data: string;
      mimeType: string;
      dimension?: { width: number; height: number };
      uuid?: string;
    };

/** The text, images, and mode sent to Cursor. */
export interface CursorPrompt {
  text: string;
  images?: CursorImage[];
  mode?: "ask" | "agent";
}

/** A tool invocation parsed from Cursor output. */
export interface CursorToolCall {
  name: string;
  arguments: CursorToolArguments;
}

/** The identifiers and stream returned for a Cursor completion. */
export interface CursorCompletion {
  requestId: string;
  conversationId: string;
  stream: Response;
}
