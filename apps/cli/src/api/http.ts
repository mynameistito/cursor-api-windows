const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
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

export const json = (data: unknown, init: ResponseInit = {}): Response =>
  Response.json(data, {
    ...init,
    headers: {
      ...JSON_HEADERS,
      ...init.headers,
    },
  });

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

export const errorResponse = (error: unknown): Response => {
  if (error instanceof HttpError) {
    return openAiError(error.message, error.status, error.code, error.param);
  }
  const message = error instanceof Error ? error.message : "Unexpected error";
  return openAiError(message, 500, "internal_error");
};

export const sseResponse = (readable: ReadableStream<Uint8Array>): Response =>
  new Response(readable, {
    headers: {
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "content-type": "text/event-stream; charset=utf-8",
      "x-accel-buffering": "no",
    },
  });
