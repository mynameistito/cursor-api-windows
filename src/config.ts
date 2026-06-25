import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export const APP_NAME = "cursor-api";
export const DEFAULT_PORT = 8787;
export const LOCAL_API_KEY_LITERAL = "cursor-local";

interface Settings {
  port: number;
  autostart: boolean;
}

const DEFAULT_SETTINGS: Settings = {
  autostart: false,
  port: DEFAULT_PORT,
};

const configDir = (): string => {
  const base = process.env.APPDATA;
  if (!base) {
    throw new Error("APPDATA is not set");
  }
  return path.join(base, APP_NAME);
};

const settingsPath = (): string => path.join(configDir(), "settings.json");

export const runDir = (): string => path.join(configDir(), "run");

export const logsDir = (): string => path.join(configDir(), "logs");

export const pidFilePath = (): string => path.join(runDir(), "cursor-api.pid");

export const stateFilePath = (): string => path.join(runDir(), "state.json");

export const ensureConfigDirs = (): void => {
  mkdirSync(configDir(), { recursive: true });
  mkdirSync(runDir(), { recursive: true });
  mkdirSync(logsDir(), { recursive: true });
};

export const loadSettings = (): Settings => {
  try {
    const raw = readFileSync(settingsPath(), "utf-8");
    const parsed = JSON.parse(raw) as Partial<Settings>;
    return {
      autostart: parsed.autostart ?? false,
      port: parsed.port ?? DEFAULT_PORT,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
};

export const saveSettings = (settings: Settings): void => {
  ensureConfigDirs();
  writeFileSync(
    settingsPath(),
    `${JSON.stringify(settings, null, 2)}\n`,
    "utf-8"
  );
};

export const baseUrl = (port = loadSettings().port): string =>
  `http://127.0.0.1:${port}/v1`;
