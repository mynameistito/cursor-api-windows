import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { applyEdits, modify, parse as parseJsonc } from "jsonc-parser";

import type { JsonObject, JsonValue } from "@/api/types";
import { LOCAL_API_KEY_LITERAL } from "@/config";

const BRAND = "cursor-api";

const LOCAL_API_KEY = LOCAL_API_KEY_LITERAL;

const OPENCODE_JSON = "opencode.json";

const OPENCODE_JSONC = "opencode.jsonc";

const JSONC_FORMATTING = { insertSpaces: true, tabSize: 2 };

interface AgentInfo {
  id: string;
  name: string;
  status: "configured" | "not_configured" | "not_installed";
}

const isRecord = (
  value: JsonValue | undefined
): value is Extract<JsonValue, JsonObject> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isStringValue = (value: JsonValue | undefined): value is string =>
  typeof value === "string";

const configHome = function configHome(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg?.trim() && xdg.startsWith("/")) {
    return xdg;
  }
  return path.join(homedir(), ".config");
};

const opencodeConfigDir = function opencodeConfigDir(): string {
  return path.join(configHome(), "opencode");
};

/** Resolve OpenCode config path, preferring opencode.jsonc when present.
 * @param dir - Directory to search for the OpenCode config.
 * @returns The selected config path, or the preferred path if neither exists.
 */
export const resolveOpencodeConfigPath = function resolveOpencodeConfigPath(
  dir = opencodeConfigDir()
): string {
  const jsonc = path.join(dir, OPENCODE_JSONC);
  const json = path.join(dir, OPENCODE_JSON);
  if (existsSync(jsonc)) {
    return jsonc;
  }
  if (existsSync(json)) {
    return json;
  }
  return jsonc;
};

const epochMs = function epochMs(): number {
  return Date.now();
};

const backupIfChanged = function backupIfChanged(
  filePath: string,
  nextContents: string
): void {
  if (!existsSync(filePath)) {
    return;
  }
  const prev = readFileSync(filePath, "utf-8");
  if (prev === nextContents) {
    return;
  }
  const backup = `${filePath}.cursor-api-backup.${epochMs()}`;
  writeFileSync(backup, prev, "utf-8");
};

const writePrettyJson = function writePrettyJson(
  filePath: string,
  value: JsonObject
): void {
  const dir = path.join(filePath, "..");
  mkdirSync(dir, { recursive: true });
  const contents = `${JSON.stringify(value, null, 2)}\n`;
  backupIfChanged(filePath, contents);
  writeFileSync(filePath, contents, "utf-8");
};

const readJson = function readJson(
  filePath: string,
  fallback: JsonObject = {}
): JsonObject {
  if (!existsSync(filePath)) {
    return { ...fallback };
  }
  try {
    const parsed: JsonValue = JSON.parse(readFileSync(filePath, "utf-8"));
    return isRecord(parsed) ? parsed : { ...fallback };
  } catch {
    return { ...fallback };
  }
};

const readOpencodeRoot = function readOpencodeRoot(
  filePath: string
): JsonObject {
  if (!existsSync(filePath)) {
    return {};
  }
  const text = readFileSync(filePath, "utf-8");
  if (filePath.endsWith(".jsonc")) {
    const parsed: JsonValue = parseJsonc(text);
    return isRecord(parsed) ? parsed : {};
  }
  return readJson(filePath);
};

const costLimitModels = function costLimitModels() {
  return {
    "composer-2.5": {
      cost: { input: 0.5, output: 2.5 },
      limit: { context: 200_000, output: 65_536 },
      name: "Composer 2.5",
    },
    "composer-2.5-fast": {
      cost: { input: 3, output: 15 },
      limit: { context: 200_000, output: 65_536 },
      name: "Composer 2.5 Fast",
    },
  } satisfies JsonObject;
};

const cursorapiProvider = function cursorapiProvider(baseUrl: string) {
  return {
    models: costLimitModels(),
    name: BRAND,
    npm: "@ai-sdk/openai-compatible",
    options: { apiKey: LOCAL_API_KEY, baseURL: baseUrl },
  } satisfies JsonObject;
};

const shouldSetDefaultModel = function shouldSetDefaultModel(
  model: JsonValue | undefined
): boolean {
  return (
    !isStringValue(model) ||
    !model ||
    model.startsWith("cursor/") ||
    model.startsWith("cursorsdk/")
  );
};

const applyJsoncEdits = function applyJsoncEdits(
  text: string,
  edits: ReturnType<typeof modify>
): string {
  const next = applyEdits(text, edits);
  return next.endsWith("\n") ? next : `${next}\n`;
};

/** Configure cursor-api provider in an OpenCode config file (json or jsonc).
 * @param filePath - Path to the OpenCode config file.
 * @param baseUrl - Local cursor-api base URL to configure.
 */
export const configureOpencodeFile = function configureOpencodeFile(
  filePath: string,
  baseUrl: string
): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const cursorapi = cursorapiProvider(baseUrl);

  if (filePath.endsWith(".jsonc")) {
    let text = existsSync(filePath)
      ? readFileSync(filePath, "utf-8")
      : "{\n}\n";
    for (const key of ["cursor", "cursorsdk"]) {
      const root: JsonValue = parseJsonc(text);
      const provider =
        isRecord(root) && isRecord(root.provider) ? root.provider : {};
      if (key in provider) {
        text = applyJsoncEdits(
          text,
          modify(text, ["provider", key], undefined, {
            formattingOptions: JSONC_FORMATTING,
          })
        );
      }
    }
    text = applyJsoncEdits(
      text,
      modify(text, ["provider", "cursorapi"], cursorapi, {
        formattingOptions: JSONC_FORMATTING,
      })
    );
    const root: JsonValue = parseJsonc(text);
    if (isRecord(root) && shouldSetDefaultModel(root.model)) {
      text = applyJsoncEdits(
        text,
        modify(text, ["model"], "cursorapi/composer-2.5-fast", {
          formattingOptions: JSONC_FORMATTING,
        })
      );
    }
    backupIfChanged(filePath, text);
    writeFileSync(filePath, text, "utf-8");
    return;
  }

  const root = readJson(filePath);
  const provider = isRecord(root.provider) ? { ...root.provider } : {};
  delete provider.cursor;
  delete provider.cursorsdk;
  provider.cursorapi = cursorapi;
  root.provider = provider;
  if (shouldSetDefaultModel(root.model)) {
    root.model = "cursorapi/composer-2.5-fast";
  }
  writePrettyJson(filePath, root);
};

const configureOpencode = function configureOpencode(baseUrl: string): string {
  const filePath = resolveOpencodeConfigPath();
  configureOpencodeFile(filePath, baseUrl);
  return filePath;
};

const opencodeConfigExists = function opencodeConfigExists(
  dir: string
): boolean {
  return (
    existsSync(path.join(dir, OPENCODE_JSONC)) ||
    existsSync(path.join(dir, OPENCODE_JSON))
  );
};

const opencodeStatus = function opencodeStatus(): AgentInfo["status"] {
  const dir = opencodeConfigDir();
  if (!opencodeConfigExists(dir)) {
    return "not_configured";
  }
  const filePath = resolveOpencodeConfigPath(dir);
  const root = readOpencodeRoot(filePath);
  const { provider } = root;
  if (isRecord(provider) && "cursorapi" in provider) {
    return "configured";
  }
  return "not_configured";
};

const AGENTS: {
  id: string;
  name: string;
  status: () => AgentInfo["status"];
}[] = [
  { id: "opencode", name: "OpenCode", status: opencodeStatus },
  { id: "codex", name: "Codex", status: () => "not_configured" },
  { id: "vscode", name: "VS Code", status: () => "not_configured" },
  { id: "cline", name: "Cline", status: () => "not_configured" },
  { id: "kilo", name: "Kilo Code", status: () => "not_configured" },
  { id: "pi", name: "pi", status: () => "not_configured" },
];

/** Return the configured status of each supported agent.
 * @returns Agent identifiers, display names, and configuration statuses.
 */
export const listAgents = function listAgents(): Promise<AgentInfo[]> {
  return Promise.resolve(
    AGENTS.map((agent) => ({
      id: agent.id,
      name: agent.name,
      status: agent.status(),
    }))
  );
};

/** Configure the requested supported agent.
 * @param agentId - Identifier of the agent to configure.
 * @param baseUrl - Local cursor-api base URL to configure.
 * @returns A message describing the configuration result.
 */
export const configureAgent = function configureAgent(
  agentId: string,
  baseUrl: string
): Promise<string> {
  switch (agentId.toLowerCase()) {
    case "opencode": {
      return Promise.resolve(
        `Configured OpenCode at ${configureOpencode(baseUrl)}`
      );
    }
    default: {
      return Promise.reject(
        new Error(
          `Agent "${agentId}" is not ported yet in the CLI draft. OpenCode is supported; others coming soon.`
        )
      );
    }
  }
};
