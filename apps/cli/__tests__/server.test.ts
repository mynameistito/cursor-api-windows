import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { JsonValue } from "@/api/types";
import { LOCAL_API_KEY_LITERAL } from "@/config";
import {
  contentLengthExceedsLimit,
  MAX_REQUEST_BODY_BYTES,
  readBoundedBody,
  resolveApiKey,
  startHttpServer,
} from "@/server";

interface TestServer {
  port: number;
  close: () => Promise<void>;
}

const isJsonValue = (value: unknown): value is JsonValue => {
  if (value === null) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }
  switch (typeof value) {
    case "boolean": {
      return true;
    }
    case "number": {
      return true;
    }
    case "string": {
      return true;
    }
    case "object": {
      return Object.values(value).every(isJsonValue);
    }
    default: {
      return false;
    }
  }
};

const readJson = async (response: Response): Promise<JsonValue> => {
  const value: unknown = await response.json();
  if (!isJsonValue(value)) {
    throw new Error("Response body was not valid JSON");
  }
  return value;
};

const postWithOversizedContentLength =
  async function postWithOversizedContentLength(
    port: number
  ): Promise<{ body: unknown; status: number }> {
    const req = request({
      headers: {
        connection: "close",
        "content-length": String(MAX_REQUEST_BODY_BYTES + 1),
        "content-type": "application/json",
      },
      host: "127.0.0.1",
      method: "POST",
      path: "/v1/chat/completions",
      port,
    });
    req.end();
    const [res] = await once(req, "response");
    const chunks: Buffer[] = [];
    for await (const chunk of res) {
      chunks.push(Buffer.from(chunk));
    }
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
    return { body, status: res.statusCode ?? 0 };
  };

describe(startHttpServer, () => {
  let savedAppData: string | undefined;
  let savedCursorApiKey: string | undefined;
  let savedCursorSdkBridgeUrl: string | undefined;
  let server: TestServer;
  let tempAppData: string;

  beforeEach(async () => {
    savedAppData = process.env.APPDATA;
    savedCursorApiKey = process.env.CURSOR_API_KEY;
    savedCursorSdkBridgeUrl = process.env.CURSOR_SDK_BRIDGE_URL;
    tempAppData = mkdtempSync(path.join(tmpdir(), "cursor-api-server-"));
    process.env.APPDATA = tempAppData;
    process.env.CURSOR_API_KEY = "crsr_test_stored_key";
    delete process.env.CURSOR_SDK_BRIDGE_URL;
    server = await startHttpServer(0);
  });

  afterEach(async () => {
    await server.close();
    rmSync(tempAppData, { force: true, recursive: true });
    if (savedAppData === undefined) {
      delete process.env.APPDATA;
    } else {
      process.env.APPDATA = savedAppData;
    }
    if (savedCursorApiKey === undefined) {
      delete process.env.CURSOR_API_KEY;
    } else {
      process.env.CURSOR_API_KEY = savedCursorApiKey;
    }
    if (savedCursorSdkBridgeUrl === undefined) {
      delete process.env.CURSOR_SDK_BRIDGE_URL;
    } else {
      process.env.CURSOR_SDK_BRIDGE_URL = savedCursorSdkBridgeUrl;
    }
  });

  it("returns health metadata with the bound base URL", async () => {
    const response = await fetch(`http://127.0.0.1:${server.port}/health`);
    const body = await readJson(response);

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      baseUrl: `http://127.0.0.1:${server.port}/v1`,
      ok: true,
    });
  });

  it("lists models from the public v1 models route", async () => {
    const response = await fetch(`http://127.0.0.1:${server.port}/v1/models`);
    const body = await readJson(response);

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      data: expect.arrayContaining([
        expect.objectContaining({ id: "composer-2.5", object: "model" }),
      ]),
      object: "list",
    });
  });

  it("returns the not-found error shape for unsupported methods", async () => {
    const response = await fetch(`http://127.0.0.1:${server.port}/v1/models`, {
      method: "POST",
    });
    const body = await readJson(response);

    expect(response.status).toBe(404);
    expect(body).toMatchObject({
      error: {
        code: "not_found",
        message: "Not found",
        type: "not_found",
      },
    });
  });

  it("rejects chat completions without an API key", async () => {
    const response = await fetch(
      `http://127.0.0.1:${server.port}/v1/chat/completions`,
      {
        body: JSON.stringify({ messages: [] }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }
    );
    const body = await readJson(response);

    expect(response.status).toBe(401);
    expect(body).toMatchObject({
      error: { code: "unauthorized", type: "unauthorized" },
    });
  });

  it("maps the local placeholder API key to the stored Cursor key", () => {
    const apiRequest = new Request("http://127.0.0.1/v1/chat/completions", {
      headers: { authorization: `Bearer ${LOCAL_API_KEY_LITERAL}` },
    });

    expect(resolveApiKey(apiRequest)).toBe("crsr_test_stored_key");
  });

  it("rejects oversized request bodies before completion handling", async () => {
    const response = await postWithOversizedContentLength(server.port);

    expect(response.status).toBe(413);
    expect(response.body).toMatchObject({
      error: {
        code: "request_body_too_large",
        type: "request_body_too_large",
      },
    });
  });

  it("does not allow unknown browser origins during preflight", async () => {
    const response = await fetch(
      `http://127.0.0.1:${server.port}/v1/chat/completions`,
      {
        headers: {
          "access-control-request-method": "POST",
          origin: "https://unknown.example",
        },
        method: "OPTIONS",
      }
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });
});

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
