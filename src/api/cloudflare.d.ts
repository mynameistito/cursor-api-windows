/** Minimal Cloudflare Worker type shims for local-only builds. */

interface D1PreparedStatement {
  bind: (...values: unknown[]) => D1PreparedStatement;
  first: <T = unknown>() => Promise<T | null>;
  run: () => Promise<unknown>;
}

interface D1Database {
  prepare: (query: string) => D1PreparedStatement;
}

type Fetcher = unknown;
type R2Bucket = unknown;

interface DurableObjectStub {
  fetch: (input: string | Request, init?: RequestInit) => Promise<Response>;
}

interface DurableObjectNamespace {
  get: (id: string) => DurableObjectStub;
  idFromName: (name: string) => string;
}

type BodyInit = Blob | BufferSource | FormData | URLSearchParams | string;
