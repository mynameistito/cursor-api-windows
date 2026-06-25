const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
};

const CORS_HEADERS = {
  "access-control-allow-headers":
    "authorization,content-type,x-api-key,idempotency-key,x-session-affinity,x-opencode-session-id,x-opencode-session",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-origin": "*",
  "access-control-max-age": "86400",
};

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly param?: string;

  constructor(
    message: string,
    status = 400,
    code = "invalid_request_error",
    param?: string
  ) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.param = param;
  }
}

export const withCors = (response: Response): Response => {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    headers.set(key, value);
  }
  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
};

export const optionsResponse = (): Response =>
  new Response(null, {
    headers: CORS_HEADERS,
    status: 204,
  });

export const json = (data: unknown, init: ResponseInit = {}): Response =>
  withCors(
    Response.json(data, {
      ...init,
      headers: {
        ...JSON_HEADERS,
        ...init.headers,
      },
    })
  );

export const openAiError = (
  message: string,
  status = 400,
  code = "invalid_request_error",
  param?: string
): Response =>
  json(
    {
      error: {
        code,
        message,
        param: param ?? null,
        type: code,
      },
    },
    { status }
  );

export const unauthorized = (
  message = "Missing or invalid API key"
): Response => openAiError(message, 401, "unauthorized");

export const notFound = (): Response =>
  openAiError("Not found", 404, "not_found");

export const bearerToken = (request: Request): string | undefined => {
  const authorization = request.headers.get("authorization") || "";
  const match = /^Bearer\s+(?<token>.+)$/iu.exec(authorization.trim());
  if (match?.groups?.token) {
    return match.groups.token.trim();
  }
  const apiKey = request.headers.get("x-api-key");
  return apiKey?.trim() || undefined;
};

export const parseJsonBody = <T = unknown>(request: Request): Promise<T> => {
  const contentType = request.headers.get("content-type") || "";
  if (contentType && !contentType.toLowerCase().includes("application/json")) {
    throw new HttpError("Content-Type must be application/json", 415);
  }
  return request.json() as Promise<T>;
};

export const errorResponse = (error: unknown): Response => {
  if (error instanceof HttpError) {
    return openAiError(error.message, error.status, error.code, error.param);
  }
  const message = error instanceof Error ? error.message : "Unexpected error";
  return openAiError(message, 500, "internal_error");
};

export const sseResponse = (readable: ReadableStream<Uint8Array>): Response =>
  withCors(
    new Response(readable, {
      headers: {
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "content-type": "text/event-stream; charset=utf-8",
        "x-accel-buffering": "no",
      },
    })
  );
