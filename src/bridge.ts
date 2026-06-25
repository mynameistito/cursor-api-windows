import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import type { Server } from "node:net";

import { appendLog } from "@/logs";
import { bridgeDir, bridgeNodePath, bridgeScriptPath } from "@/paths";

const DEFAULT_BRIDGE_PORT = 8792;
const BRIDGE_PORT_SCAN = 100;
const BRIDGE_RUN_TIMEOUT_MS = 120_000;

export interface BridgeHandle {
  port: number;
  token: string;
  child: ChildProcess;
  close: () => Promise<void>;
}

const tryListen = async (port: number): Promise<number | null> => {
  const server: Server = createServer();
  server.listen(port, "127.0.0.1");
  try {
    await once(server, "listening");
    return port;
  } catch {
    return null;
  } finally {
    server.close();
  }
};

const pickBridgePort = async (offset = 0): Promise<number> => {
  if (offset > BRIDGE_PORT_SCAN) {
    return DEFAULT_BRIDGE_PORT;
  }
  const port = DEFAULT_BRIDGE_PORT + offset;
  const available = await tryListen(port);
  if (available !== null) {
    return available;
  }
  return pickBridgePort(offset + 1);
};

const pipeChild = (channel: "bridge", child: ChildProcess): void => {
  child.stdout?.on("data", (buf) => {
    for (const line of buf.toString().split("\n")) {
      if (line.trim()) {
        appendLog(channel, line);
      }
    }
  });
  child.stderr?.on("data", (buf) => {
    for (const line of buf.toString().split("\n")) {
      if (line.trim()) {
        appendLog(channel, line);
      }
    }
  });
};

export const assertBridgeRuntime = (): void => {
  const script = bridgeScriptPath();
  const node = bridgeNodePath();
  const dir = bridgeDir();
  if (!existsSync(script)) {
    throw new Error(
      `Bridge script not found: ${script}. Run "bun run stage:bridge" or reinstall.`
    );
  }
  if (!existsSync(node)) {
    throw new Error(
      `Bundled Node runtime not found: ${node}. Run "bun run stage:bridge" or reinstall.`
    );
  }
  if (!existsSync(dir)) {
    throw new Error(`Bridge directory not found: ${dir}`);
  }
};

const waitForChildExit = async (child: ChildProcess): Promise<void> => {
  await once(child, "exit");
};

/** Spawn the @cursor/sdk bridge (must run under Node, not Bun). */
export const startBridge = async (): Promise<BridgeHandle> => {
  assertBridgeRuntime();

  const port = await pickBridgePort();
  const token = randomBytes(16).toString("hex");
  const node = bridgeNodePath();
  const script = bridgeScriptPath();

  const child = spawn(node, [script], {
    cwd: bridgeDir(),
    env: {
      ...process.env,
      CURSOR_SDK_BRIDGE_HOST: "127.0.0.1",
      CURSOR_SDK_BRIDGE_PORT: String(port),
      CURSOR_SDK_BRIDGE_RUN_TIMEOUT_MS: String(BRIDGE_RUN_TIMEOUT_MS),
      CURSOR_SDK_BRIDGE_TOKEN: token,
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  pipeChild("bridge", child);

  child.on("exit", (code, signal) => {
    appendLog(
      "bridge",
      `process exited (code=${code ?? "null"}, signal=${signal ?? "null"})`
    );
  });

  return {
    child,
    close: async () => {
      if (child.killed) {
        return;
      }
      child.kill();
      await waitForChildExit(child);
    },
    port,
    token,
  };
};

export const bridgeUrl = (port: number): string =>
  `http://127.0.0.1:${port}/sdk`;
