const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
};

/** An HTTP error that can be projected into an OpenAI-compatible response. */
export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly param?: string;

  /**
   * Create an HTTP error with a status, code, and optional parameter name.
   * @param message - The safe error message.
   * @param status - The HTTP status code.
   * @param code - The machine-readable error code.
   * @param param - The request parameter associated with the error.
   */
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

/**
 * Create a JSON response with the standard content type.
 * @param data - The value to serialize as JSON.
 * @param init - Additional response options.
 * @returns The JSON response.
 */
export const json = <T>(data: T, init: ResponseInit = {}): Response =>
  Response.json(data, {
    ...init,
    headers: {
      ...JSON_HEADERS,
      ...init.headers,
    },
  });

/**
 * Create an OpenAI-compatible error response.
 * @param message - The error message.
 * @param status - The HTTP status code.
 * @param code - The machine-readable error code.
 * @param param - The request parameter associated with the error.
 * @returns The JSON error response.
 */
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

/**
 * Create an unauthorized response.
 * @param message - The error message.
 * @returns The unauthorized JSON response.
 */
export const unauthorized = (
  message = "Missing or invalid API key"
): Response => openAiError(message, 401, "unauthorized");

/**
 * Create a not-found response.
 * @returns The not-found JSON response.
 */
export const notFound = (): Response =>
  openAiError("Not found", 404, "not_found");

/** The supported underlying error types for an error response. */
type ErrorResponseCause = Error | HttpError;

const parseErrorResponseCause = <T>(
  value: T
): ErrorResponseCause | undefined =>
  value instanceof Error ? value : undefined;

/**
 * Convert an unknown error into an OpenAI-compatible response.
 * @param error - The error to project.
 * @returns The matching JSON error response.
 */
export const errorResponse = <T>(error: T): Response => {
  const cause = parseErrorResponseCause(error);
  if (cause instanceof HttpError) {
    return openAiError(cause.message, cause.status, cause.code, cause.param);
  }
  const message = cause?.message ?? "Unexpected error";
  return openAiError(message, 500, "internal_error");
};

/**
 * Create a server-sent events response with streaming headers.
 * @param readable - The stream to expose in the response body.
 * @returns The server-sent events response.
 */
export const sseResponse = (readable: ReadableStream<Uint8Array>): Response =>
  new Response(readable, {
    headers: {
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "content-type": "text/event-stream; charset=utf-8",
      "x-accel-buffering": "no",
    },
  });
