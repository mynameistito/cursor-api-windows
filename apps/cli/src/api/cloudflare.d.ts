/** Minimal Cloudflare Worker type shims for local-only builds. */

interface D1PreparedStatement {
  bind: (...values: unknown[]) => D1PreparedStatement;
  first: <T = unknown>() => Promise<T | null>;
  run: () => Promise<D1Result>;
}

interface D1Result {
  success: boolean;
  meta: { changes: number; duration: number; last_row_id: number | null };
}

interface D1Database {
  prepare: (query: string) => D1PreparedStatement;
}

interface Fetcher {
  fetch: (request: Request) => Promise<Response>;
}

interface R2Bucket {
  get: (key: string) => Promise<R2Object | null>;
  put: (
    key: string,
    value: ReadableStream | ArrayBuffer | string
  ) => Promise<R2Object>;
}

interface R2Object {
  key: string;
  body: ReadableStream;
}

interface DurableObjectStub {
  fetch: (input: string | Request, init?: RequestInit) => Promise<Response>;
}

interface DurableObjectNamespace {
  get: (id: string) => DurableObjectStub;
  idFromName: (name: string) => string;
}

type BodyInit = Blob | BufferSource | FormData | URLSearchParams | string;
