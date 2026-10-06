import { existsSync } from "node:fs";
import path from "node:path";

const srcDir = import.meta.dirname;
const projectRoot = path.join(srcDir, "..");

/** Install / project root (directory containing `bridge/`).
 * @returns The configured install root, bundled executable directory, or project root.
 */
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

/** Resolve the SDK bridge directory.
 * @returns The bridge runtime directory.
 */
export const bridgeDir = (): string => path.join(installRoot(), "bridge");

/** Resolve the SDK bridge script path.
 * @returns The path to the bridge script.
 */
export const bridgeScriptPath = (): string =>
  path.join(bridgeDir(), "cursor-sdk-local-agent-bridge.mjs");

/** Resolve the bundled Node executable path.
 * @returns The path to `node.exe` in the bridge directory.
 */
export const bridgeNodePath = (): string => path.join(bridgeDir(), "node.exe");
