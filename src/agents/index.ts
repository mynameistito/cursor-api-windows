import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { LOCAL_API_KEY_LITERAL } from "@/config";

const BRAND = "cursor-api";

const LOCAL_API_KEY = LOCAL_API_KEY_LITERAL;

interface AgentInfo {
  id: string;
  name: string;
  status: "configured" | "not_configured" | "not_installed";
}

const configHome = function configHome(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg?.trim() && xdg.startsWith("/")) {
    return xdg;
  }
  return path.join(homedir(), ".config");
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
  value: unknown
): void {
  const dir = path.join(filePath, "..");
  mkdirSync(dir, { recursive: true });
  const contents = `${JSON.stringify(value, null, 2)}\n`;
  backupIfChanged(filePath, contents);
  writeFileSync(filePath, contents, "utf-8");
};

const readJson = function readJson(
  filePath: string,
  fallback: Record<string, unknown> = {}
): Record<string, unknown> {
  if (!existsSync(filePath)) {
    return { ...fallback };
  }
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf-8"));
    return typeof parsed === "object" && parsed && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : { ...fallback };
  } catch {
    return { ...fallback };
  }
};

const costLimitModels = function costLimitModels(): Record<string, unknown> {
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
  };
};

const opencodePath = function opencodePath(): string {
  return path.join(configHome(), "opencode", "opencode.json");
};

const configureOpencode = function configureOpencode(baseUrl: string): string {
  const filePath = opencodePath();
  const root = readJson(filePath);
  const provider =
    typeof root.provider === "object" &&
    root.provider &&
    !Array.isArray(root.provider)
      ? { ...(root.provider as Record<string, unknown>) }
      : {};
  delete provider.cursor;
  delete provider.cursorsdk;
  provider.cursorapi = {
    models: costLimitModels(),
    name: BRAND,
    npm: "@ai-sdk/openai-compatible",
    options: { apiKey: LOCAL_API_KEY, baseURL: baseUrl },
  };
  root.provider = provider;
  const model = typeof root.model === "string" ? root.model : "";
  if (!model || model.startsWith("cursor/") || model.startsWith("cursorsdk/")) {
    root.model = "cursorapi/composer-2.5-fast";
  }
  writePrettyJson(filePath, root);
  return filePath;
};

const opencodeStatus = function opencodeStatus(): AgentInfo["status"] {
  const filePath = opencodePath();
  const root = readJson(filePath);
  const { provider } = root;
  if (
    typeof provider === "object" &&
    provider &&
    !Array.isArray(provider) &&
    "cursorapi" in (provider as Record<string, unknown>)
  ) {
    return "configured";
  }
  return existsSync(filePath) ? "not_configured" : "not_configured";
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

export const listAgents = function listAgents(): Promise<AgentInfo[]> {
  return Promise.resolve(
    AGENTS.map((agent) => ({
      id: agent.id,
      name: agent.name,
      status: agent.status(),
    }))
  );
};

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
