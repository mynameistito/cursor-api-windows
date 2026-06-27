import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { parse as parseJsonc } from "jsonc-parser";
import { afterEach, describe, expect, it } from "vitest";

import {
  configureOpencodeFile,
  resolveOpencodeConfigPath,
} from "@/agents/index";

describe(resolveOpencodeConfigPath, () => {
  let tempDir: string | undefined;

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { force: true, recursive: true });
      tempDir = undefined;
    }
  });

  it("prefers opencode.jsonc when both files exist", () => {
    tempDir = mkdtempSync(path.join(tmpdir(), "opencode-config-"));
    writeFileSync(path.join(tempDir, "opencode.jsonc"), "{}\n");
    writeFileSync(path.join(tempDir, "opencode.json"), "{}\n");
    expect(resolveOpencodeConfigPath(tempDir)).toBe(
      path.join(tempDir, "opencode.jsonc")
    );
  });

  it("falls back to opencode.json when only json exists", () => {
    tempDir = mkdtempSync(path.join(tmpdir(), "opencode-config-"));
    writeFileSync(path.join(tempDir, "opencode.json"), "{}\n");
    expect(resolveOpencodeConfigPath(tempDir)).toBe(
      path.join(tempDir, "opencode.json")
    );
  });

  it("defaults to opencode.jsonc when neither file exists", () => {
    tempDir = mkdtempSync(path.join(tmpdir(), "opencode-config-"));
    expect(resolveOpencodeConfigPath(tempDir)).toBe(
      path.join(tempDir, "opencode.jsonc")
    );
  });
});

describe(configureOpencodeFile, () => {
  let tempDir: string | undefined;

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { force: true, recursive: true });
      tempDir = undefined;
    }
  });

  it("updates jsonc while preserving comments", () => {
    tempDir = mkdtempSync(path.join(tmpdir(), "opencode-config-"));
    const filePath = path.join(tempDir, "opencode.jsonc");
    writeFileSync(
      filePath,
      `{
  // keep this comment
  "provider": {
    "other": { "enabled": true }
  },
  "model": "cursor/old-model",
}
`,
      "utf-8"
    );

    configureOpencodeFile(filePath, "http://127.0.0.1:6903/v1");

    const text = readFileSync(filePath, "utf-8");
    expect(text).toContain("// keep this comment");
    expect(text).toContain("http://127.0.0.1:6903/v1");
    expect(text).toContain("cursorapi/composer-2.5-fast");

    const root = parseJsonc(text);
    expect(root).toMatchObject({
      model: "cursorapi/composer-2.5-fast",
      provider: {
        cursorapi: {
          options: {
            apiKey: "cursor-local",
            baseURL: "http://127.0.0.1:6903/v1",
          },
        },
        other: { enabled: true },
      },
    });
  });

  it("writes a new jsonc file when missing", () => {
    tempDir = mkdtempSync(path.join(tmpdir(), "opencode-config-"));
    const filePath = path.join(tempDir, "opencode.jsonc");

    configureOpencodeFile(filePath, "http://127.0.0.1:6903/v1");

    expect(existsSync(filePath)).toBeTruthy();
    const root = parseJsonc(readFileSync(filePath, "utf-8"));
    expect(root).toMatchObject({
      model: "cursorapi/composer-2.5-fast",
      provider: {
        cursorapi: {
          options: {
            baseURL: "http://127.0.0.1:6903/v1",
          },
        },
      },
    });
  });

  it("still updates plain opencode.json", () => {
    tempDir = mkdtempSync(path.join(tmpdir(), "opencode-config-"));
    const filePath = path.join(tempDir, "opencode.json");
    writeFileSync(filePath, '{"model":"cursor/legacy"}\n', "utf-8");

    configureOpencodeFile(filePath, "http://127.0.0.1:6903/v1");

    const root = JSON.parse(readFileSync(filePath, "utf-8")) as Record<
      string,
      unknown
    >;
    expect(root.model).toBe("cursorapi/composer-2.5-fast");
    expect(root).toMatchObject({
      provider: {
        cursorapi: {
          options: {
            baseURL: "http://127.0.0.1:6903/v1",
          },
        },
      },
    });
  });
});
