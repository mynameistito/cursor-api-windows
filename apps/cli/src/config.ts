import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { JsonValue } from "./api/types";

export const APP_NAME = "cursor-api";
export const DEFAULT_PORT = 6903;
export const LOCAL_API_KEY_LITERAL = "cursor-local";

interface Settings {
  port: number;
  autostart: boolean;
}

interface SettingsFile {
  autostart?: boolean;
  port?: number;
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

/** Resolve the application's runtime directory.
 * @returns The path used for PID and daemon state files.
 */
export const runDir = (): string => path.join(configDir(), "run");

/** Resolve the application's log directory.
 * @returns The path used for log files.
 */
export const logsDir = (): string => path.join(configDir(), "logs");

/** Resolve the daemon PID file path.
 * @returns The path to the PID file.
 */
export const pidFilePath = (): string => path.join(runDir(), "cursor-api.pid");

/** Resolve the daemon state file path.
 * @returns The path to the state file.
 */
export const stateFilePath = (): string => path.join(runDir(), "state.json");

/** Create the application config, runtime, and log directories. */
export const ensureConfigDirs = (): void => {
  mkdirSync(configDir(), { recursive: true });
  mkdirSync(runDir(), { recursive: true });
  mkdirSync(logsDir(), { recursive: true });
};

const isSettingsObject = (
  value: JsonValue
): value is Record<string, JsonValue> =>
  value !== null &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(new Object(value)) === Object.prototype;

const parseSettings = (value: JsonValue): SettingsFile => {
  if (!isSettingsObject(value)) {
    return {};
  }

  const settings: SettingsFile = {};
  if (
    "autostart" in value &&
    (value.autostart === true || value.autostart === false)
  ) {
    settings.autostart = value.autostart;
  }
  if (
    "port" in value &&
    Number.isFinite(Number(value.port)) &&
    Number(value.port) === value.port
  ) {
    settings.port = value.port;
  }
  return settings;
};

/** Load settings from disk, falling back to defaults if unavailable.
 * @returns Validated application settings.
 */
export const loadSettings = (): Settings => {
  try {
    const raw = readFileSync(settingsPath(), "utf-8");
    const value: JsonValue = JSON.parse(raw);
    const parsed = parseSettings(value);
    return {
      autostart: parsed.autostart ?? DEFAULT_SETTINGS.autostart,
      port: parsed.port ?? DEFAULT_SETTINGS.port,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
};

/** Persist application settings.
 * @param settings - Settings to write.
 */
export const saveSettings = (settings: Settings): void => {
  ensureConfigDirs();
  writeFileSync(
    settingsPath(),
    `${JSON.stringify(settings, null, 2)}\n`,
    "utf-8"
  );
};

/** Build the local API base URL.
 * @param port - Local server port; defaults to the configured port.
 * @returns The versioned local API URL.
 */
export const baseUrl = (port = loadSettings().port): string =>
  `http://127.0.0.1:${port}/v1`;
