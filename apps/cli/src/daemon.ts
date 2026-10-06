import { spawn, execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { setTimeout } from "node:timers/promises";
import { promisify } from "node:util";

import { bridgeUrl, startBridge } from "@/bridge";
import type { BridgeHandle } from "@/bridge";
import {
  baseUrl,
  ensureConfigDirs,
  loadSettings,
  pidFilePath,
  runDir,
  stateFilePath,
} from "@/config";
import { readApiKey } from "@/credentials";
import { appendLog, openLogFd } from "@/logs";
import { startHttpServer } from "@/server";

const execFileAsync = promisify(execFile);

interface DaemonState {
  pid: number;
  port: number;
  bridgePort: number | null;
  startedAt: string;
  apiKeyFingerprint?: string;
}

const apiKeyFingerprint = function apiKeyFingerprint(apiKey: string): string {
  return createHash("sha256").update(apiKey.trim()).digest("hex").slice(0, 16);
};

const readPid = function readPid(): number | null {
  if (!existsSync(pidFilePath())) {
    return null;
  }
  const raw = readFileSync(pidFilePath(), "utf-8").trim();
  const pid = Math.trunc(Number(raw));
  return Number.isInteger(pid) && pid > 0 ? pid : null;
};

const writePid = function writePid(pid: number): void {
  ensureConfigDirs();
  writeFileSync(pidFilePath(), `${pid}\n`, "utf-8");
};

const clearPid = function clearPid(): void {
  if (existsSync(pidFilePath())) {
    unlinkSync(pidFilePath());
  }
};

const writeState = function writeState(state: DaemonState): void {
  ensureConfigDirs();
  writeFileSync(
    stateFilePath(),
    `${JSON.stringify(state, null, 2)}\n`,
    "utf-8"
  );
};

const readState = function readState(): DaemonState | null {
  if (!existsSync(stateFilePath())) {
    return null;
  }
  try {
    const state: Partial<DaemonState> = JSON.parse(
      readFileSync(stateFilePath(), "utf-8")
    );
    if (Object.prototype.toString.call(state) !== "[object Object]") {
      return null;
    }
    const hasValidPid = Number.isInteger(state.pid);
    const hasValidPort = Number.isInteger(state.port);
    const hasValidBridgePort =
      state.bridgePort === null || Number.isInteger(state.bridgePort);
    const hasValidStartedAt =
      Object.prototype.toString.call(state.startedAt) === "[object String]";
    const hasValidApiKeyFingerprint =
      state.apiKeyFingerprint === undefined ||
      Object.prototype.toString.call(state.apiKeyFingerprint) ===
        "[object String]";
    if (!hasValidPid || !hasValidPort || !hasValidBridgePort) {
      return null;
    }
    if (!hasValidStartedAt || !hasValidApiKeyFingerprint) {
      return null;
    }
    return {
      ...state,
      apiKeyFingerprint: state.apiKeyFingerprint,
      bridgePort: state.bridgePort === null ? null : Number(state.bridgePort),
      pid: Number(state.pid),
      port: Number(state.port),
      startedAt: String(state.startedAt),
    };
  } catch {
    return null;
  }
};

const clearState = function clearState(): void {
  if (existsSync(stateFilePath())) {
    unlinkSync(stateFilePath());
  }
};

/** Whether tasklist stdout indicates the given PID is running.
 * @param stdout - Output returned by tasklist.
 * @param pid - Process ID to look for.
 * @returns Whether stdout contains the PID as a process entry.
 */
export const tasklistOutputContainsPid = function tasklistOutputContainsPid(
  stdout: string,
  pid: number
): boolean {
  const line = stdout.trim();
  if (!line || /^INFO:/iu.test(line)) {
    return false;
  }
  return new RegExp(String.raw`\b${pid}\b`, "u").test(line);
};

const isProcessAlive = async function isProcessAlive(
  pid: number
): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(
      "tasklist",
      ["/FI", `PID eq ${pid}`, "/NH"],
      { windowsHide: true }
    );
    return tasklistOutputContainsPid(stdout, pid);
  } catch {
    return false;
  }
};

const daemonSpawnArgs = function daemonSpawnArgs(): string[] {
  const entry = process.argv[1] ?? "";
  if (entry.endsWith(".ts") || entry.endsWith(".js")) {
    return [entry, "daemon"];
  }
  return ["daemon"];
};

/** Read the daemon status and clean up stale PID and state files.
 * @returns Current process, port, bridge, and API-key status.
 */
export const getStatus = async function getStatus(): Promise<{
  running: boolean;
  pid: number | null;
  port: number;
  baseUrl: string;
  bridgePort: number | null;
  hasApiKey: boolean;
}> {
  const settings = loadSettings();
  const pid = readPid();
  const state = readState();
  const running = pid ? await isProcessAlive(pid) : false;
  const apiKey = await readApiKey();
  if (pid && !running) {
    clearPid();
    clearState();
  }
  return {
    baseUrl: baseUrl(state?.port ?? settings.port),
    bridgePort: state?.bridgePort ?? null,
    hasApiKey: Boolean(apiKey.trim()),
    pid: running ? pid : null,
    port: state?.port ?? settings.port,
    running,
  };
};

/** Check whether the running daemon matches the requested configuration.
 * @param state - Persisted state for the running daemon, if available.
 * @param port - Configured local server port.
 * @param apiKey - Configured Cursor API key.
 * @returns Whether the port and API-key fingerprint match.
 */
export const runningConfigMatches = function runningConfigMatches(
  state: DaemonState | null,
  port: number,
  apiKey: string
): boolean {
  if (state === null || state.port !== port) {
    return false;
  }
  return state.apiKeyFingerprint === apiKeyFingerprint(apiKey);
};

const spawnDaemon = function spawnDaemon(port: number): void {
  ensureConfigDirs();
  const logFd = openLogFd("daemon");
  const child = spawn(process.execPath, daemonSpawnArgs(), {
    detached: true,
    env: process.env,
    stdio: ["ignore", logFd, logFd],
    windowsHide: true,
  });
  closeSync(logFd);
  child.unref();
  console.log(`cursor-api starting in background (port ${port})`);
  console.log(`Base URL: ${baseUrl(port)}`);
  console.log(`Logs: ${runDir().replace(/\\run$/u, "\\logs")}`);
  console.log("Check status: cursor-api status");
};

/** Stop the daemon process and clear its runtime state.
 * @param options - Optional controls for command output.
 */
export const stopDaemon = async function stopDaemon(options?: {
  quiet?: boolean;
}): Promise<void> {
  const pid = readPid();
  if (!pid) {
    console.log("cursor-api is not running");
    clearState();
    return;
  }
  try {
    await execFileAsync("taskkill", ["/PID", String(pid), "/T", "/F"], {
      windowsHide: true,
    });
  } catch (error) {
    const alive = await isProcessAlive(pid);
    if (alive) {
      throw error;
    }
  }
  clearPid();
  clearState();
  if (!options?.quiet) {
    console.log("cursor-api stopped");
  }
};

/** Start the daemon in the background, restarting it if configuration changed. */
export const startDaemon = async function startDaemon(): Promise<void> {
  const settings = loadSettings();
  const [apiKey, status] = await Promise.all([readApiKey(), getStatus()]);
  const state = readState();
  if (status.running) {
    if (runningConfigMatches(state, settings.port, apiKey)) {
      console.log(`cursor-api is already running (pid ${status.pid})`);
      console.log(`Base URL: ${baseUrl(settings.port)}`);
      return;
    }
    const portChanged = state !== null && state.port !== settings.port;
    const keyChanged =
      state !== null &&
      state.apiKeyFingerprint !== undefined &&
      state.apiKeyFingerprint !== apiKeyFingerprint(apiKey);
    if (portChanged) {
      const previousPort = state?.port ?? status.port;
      console.log(
        `Port changed (${previousPort} -> ${settings.port}); restarting cursor-api...`
      );
    } else if (keyChanged) {
      console.log("API key changed; restarting cursor-api...");
    } else {
      console.log("Configuration changed; restarting cursor-api...");
    }
    await stopDaemon({ quiet: true });
    await setTimeout(500);
  }
  spawnDaemon(settings.port);
};

/** Run the daemon server and bridge in the foreground.
 */
export const runDaemonForeground =
  async function runDaemonForeground(): Promise<void> {
    const existing = readPid();
    if (
      existing &&
      (await isProcessAlive(existing)) &&
      existing !== process.pid
    ) {
      appendLog(
        "daemon",
        `another instance is already running (pid ${existing})`
      );
      process.exit(1);
    }
    const settings = loadSettings();
    const apiKey = await readApiKey();
    if (!apiKey.trim()) {
      appendLog("daemon", "no API key configured; run: cursor-api key set");
      console.error("No API key configured. Run: cursor-api key set");
      process.exit(1);
    }
    writePid(process.pid);
    process.env.PORT = String(settings.port);
    process.env.CURSOR_API_KEY = apiKey;
    let bridge: BridgeHandle | null = null;
    try {
      bridge = await startBridge();
      process.env.CURSOR_SDK_BRIDGE_URL = bridgeUrl(bridge.port);
      process.env.CURSOR_SDK_BRIDGE_TOKEN = bridge.token;
    } catch (error) {
      appendLog("daemon", `bridge failed to start: ${String(error)}`);
      bridge = null;
    }
    const server = await startHttpServer(settings.port);
    writeState({
      apiKeyFingerprint: apiKeyFingerprint(apiKey),
      bridgePort: bridge?.port ?? null,
      pid: process.pid,
      port: settings.port,
      startedAt: new Date().toISOString(),
    });
    appendLog("daemon", `listening on ${baseUrl(settings.port)}`);
    appendLog("server", `API server running at ${baseUrl(settings.port)}`);
    const shutdown = async () => {
      appendLog("daemon", "shutting down");
      await server.close();
      if (bridge) {
        await bridge.close();
      }
      clearPid();
      clearState();
      process.exit(0);
    };
    process.on("SIGINT", () => {
      void shutdown();
    });
    process.on("SIGTERM", () => {
      void shutdown();
    });
  };

/** Check whether the local server responds to its health endpoint.
 * @param port - Local server port; defaults to the configured port.
 * @returns The health endpoint response.
 */
export const checkHealth = function checkHealth(
  port = loadSettings().port
): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/health`);
};
