/**
 * Stage the SDK bridge runtime: node.exe + @cursor/sdk + bridge script.
 *
 * The bridge cannot be bun-compiled (@cursor/sdk sqlite3 native addon) and must
 * run under Node (Bun's HTTP/2 client breaks SDK gRPC).
 */
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";

import { $ } from "bun";

const root = path.join(import.meta.dirname, "..");
const bridgeDir = path.join(root, "bridge");

mkdirSync(bridgeDir, { recursive: true });

const scriptSrc = path.join(bridgeDir, "cursor-sdk-local-agent-bridge.mjs");
if (!existsSync(scriptSrc)) {
  throw new Error(`Missing bridge script at ${scriptSrc}`);
}

console.log("Installing bridge dependencies…");
await $`npm install --omit=dev`.cwd(bridgeDir);

const nodeExe = await (async (): Promise<string> => {
  if (
    process.execPath.endsWith("bun.exe") ||
    process.execPath.endsWith("bun")
  ) {
    const whereOutput = await $`where node`.text();
    return whereOutput.trim().split(/\r?\n/u)[0] ?? "";
  }
  return process.execPath;
})();

if (!nodeExe || !existsSync(nodeExe)) {
  throw new Error(
    "Node.js is required to stage the bridge runtime (node.exe)."
  );
}

copyFileSync(nodeExe, path.join(bridgeDir, "node.exe"));
console.log(`Staged bridge runtime at ${bridgeDir}`);
