import { existsSync } from "node:fs";
import path from "node:path";

const srcDir = import.meta.dirname;
const projectRoot = path.join(srcDir, "..");

/** Install / project root (directory containing `bridge/`). */
export const installRoot = (): string => {
  if (process.env.CURSOR_API_HOME?.trim()) {
    return process.env.CURSOR_API_HOME.trim();
  }

  // Compiled binary: resources sit next to cursor-api.exe.
  const exeDir = path.dirname(process.execPath);
  if (
    existsSync(path.join(exeDir, "bridge", "cursor-sdk-local-agent-bridge.mjs"))
  ) {
    return exeDir;
  }

  return projectRoot;
};

export const bridgeDir = (): string => path.join(installRoot(), "bridge");

export const bridgeScriptPath = (): string =>
  path.join(bridgeDir(), "cursor-sdk-local-agent-bridge.mjs");

export const bridgeNodePath = (): string => path.join(bridgeDir(), "node.exe");
