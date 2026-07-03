import { Readable } from "node:stream";

import { describe, expect, it } from "vitest";

import {
  contentLengthExceedsLimit,
  MAX_REQUEST_BODY_BYTES,
  readBoundedBody,
} from "@/server";

describe(contentLengthExceedsLimit, () => {
  it("allows content-length values at or under the request body limit", () => {
    expect(
      contentLengthExceedsLimit("POST", String(MAX_REQUEST_BODY_BYTES - 1))
    ).toBeFalsy();
    expect(
      contentLengthExceedsLimit("POST", String(MAX_REQUEST_BODY_BYTES))
    ).toBeFalsy();
  });

  it("rejects content-length values over the request body limit", () => {
    expect(
      contentLengthExceedsLimit("POST", String(MAX_REQUEST_BODY_BYTES + 1))
    ).toBeTruthy();
  });

  it("does not apply the body limit precheck to GET or HEAD requests", () => {
    const overLimit = String(MAX_REQUEST_BODY_BYTES + 1);

    expect(contentLengthExceedsLimit("GET", overLimit)).toBeFalsy();
    expect(contentLengthExceedsLimit("HEAD", overLimit)).toBeFalsy();
  });
});

describe(readBoundedBody, () => {
  it("preserves valid request body bytes", async () => {
    const body = Readable.from([Buffer.from("hello"), Buffer.from(" world")]);

    await expect(readBoundedBody(body)).resolves.toStrictEqual(
      Buffer.from("hello world")
    );
  });

  it("rejects chunked reads after crossing the request body limit", async () => {
    const body = Readable.from([
      Buffer.alloc(MAX_REQUEST_BODY_BYTES),
      Buffer.from("x"),
    ]);

    await expect(readBoundedBody(body)).rejects.toMatchObject({
      code: "request_body_too_large",
      status: 413,
    });
  });
});
