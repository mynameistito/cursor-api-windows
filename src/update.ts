import { execFile } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { stopDaemon } from "./daemon";
import { installRoot } from "./paths";
import { GITHUB_REPO, VERSION } from "./version";

const execFileAsync = promisify(execFile);

interface ReleaseInfo {
  version: string;
  tag: string;
  downloadUrl: string;
  publishedAt: string;
  releaseNotes: string;
}

interface GitHubReleaseAsset {
  name: string;
  browser_download_url: string;
}

interface GitHubRelease {
  tag_name: string;
  published_at: string;
  body: string;
  assets: GitHubReleaseAsset[];
}

const parseSemver = (value: string): number[] =>
  value
    .replace(/^v/u, "")
    .split(".")
    .map((part) => Number.parseInt(part, 10) || 0);

const compareSemver = function compareSemver(a: string, b: string): number {
  const av = parseSemver(a);
  const bv = parseSemver(b);
  const len = Math.max(av.length, bv.length);
  for (let index = 0; index < len; index += 1) {
    const diff = (av[index] ?? 0) - (bv[index] ?? 0);
    if (diff !== 0) {
      return diff > 0 ? 1 : -1;
    }
  }
  return 0;
};

const fetchLatestRelease =
  async function fetchLatestRelease(): Promise<ReleaseInfo | null> {
    const res = await fetch(
      `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`,
      {
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "cursor-api-cli",
        },
      }
    );
    if (res.status === 404) {
      return null;
    }
    if (!res.ok) {
      throw new Error(`GitHub API error: ${res.status} ${res.statusText}`);
    }
    const data = (await res.json()) as GitHubRelease;
    const tag = data.tag_name.replace(/^v/u, "");
    const asset = data.assets.find((item) =>
      /^cursor-api-.*-win-x64\.zip$/iu.test(item.name)
    );
    if (!asset) {
      throw new Error("Latest release has no Windows x64 zip asset.");
    }
    return {
      downloadUrl: asset.browser_download_url,
      publishedAt: data.published_at,
      releaseNotes: data.body || "",
      tag: data.tag_name,
      version: tag,
    };
  };

const runPowerShell = async function runPowerShell(
  script: string
): Promise<string> {
  const { stdout, stderr } = await execFileAsync(
    "powershell",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
    { maxBuffer: 10 * 1024 * 1024, windowsHide: true }
  );
  if (stderr?.trim()) {
    // PowerShell writes informational output to stderr; only fail on thrown errors.
  }
  return stdout;
};

const downloadFile = async function downloadFile(
  url: string,
  dest: string
): Promise<void> {
  const script = `
$ProgressPreference = 'SilentlyContinue'
Invoke-WebRequest -Uri '${url.replaceAll("'", "''")}' -OutFile '${dest.replaceAll("'", "''")}' -UseBasicParsing
`.trim();
  await runPowerShell(script);
};

const extractZip = async function extractZip(
  zipPath: string,
  destDir: string
): Promise<void> {
  mkdirSync(destDir, { recursive: true });
  const script = `
$ProgressPreference = 'SilentlyContinue'
if (Test-Path '${destDir.replaceAll("'", "''")}') { Remove-Item -Recurse -Force '${destDir.replaceAll("'", "''")}' }
New-Item -ItemType Directory -Path '${destDir.replaceAll("'", "''")}' -Force | Out-Null
Expand-Archive -Path '${zipPath.replaceAll("'", "''")}' -DestinationPath '${destDir.replaceAll("'", "''")}' -Force
`.trim();
  await runPowerShell(script);
};

const copyBundle = async function copyBundle(
  sourceDir: string,
  targetDir: string
): Promise<void> {
  mkdirSync(targetDir, { recursive: true });
  const script = `
$ProgressPreference = 'SilentlyContinue'
Copy-Item -Path (Join-Path '${sourceDir.replaceAll("'", "''")}' '*') -Destination '${targetDir.replaceAll("'", "''")}' -Recurse -Force
`.trim();
  await runPowerShell(script);
};

export const checkForUpdate = async function checkForUpdate(): Promise<{
  current: string;
  latest: ReleaseInfo | null;
  updateAvailable: boolean;
}> {
  const latest = await fetchLatestRelease();
  if (!latest) {
    return { current: VERSION, latest: null, updateAvailable: false };
  }
  return {
    current: VERSION,
    latest,
    updateAvailable: compareSemver(latest.version, VERSION) > 0,
  };
};

export const runUpdate = async function runUpdate(
  options: {
    force?: boolean;
  } = {}
): Promise<void> {
  const { current, latest, updateAvailable } = await checkForUpdate();
  if (!latest) {
    throw new Error(
      "No published releases found. Install from source or wait for the first GitHub release."
    );
  }
  if (!updateAvailable && !options.force) {
    console.log(`cursor-api ${current} is up to date.`);
    return;
  }
  if (updateAvailable) {
    console.log(`Updating cursor-api ${current} -> ${latest.version}`);
  } else {
    console.log(`Reinstalling cursor-api ${current}`);
  }
  const wasRunning = existsSync(
    path.join(process.env.APPDATA || "", "cursor-api", "run", "cursor-api.pid")
  );
  if (wasRunning) {
    console.log("Stopping cursor-api…");
    await stopDaemon();
  }
  const workDir = path.join(tmpdir(), `cursor-api-update-${latest.version}`);
  const zipPath = path.join(workDir, "bundle.zip");
  const extractDir = path.join(workDir, "extract");
  rmSync(workDir, { force: true, recursive: true });
  mkdirSync(workDir, { recursive: true });
  console.log("Downloading release…");
  await downloadFile(latest.downloadUrl, zipPath);
  console.log("Extracting…");
  await extractZip(zipPath, extractDir);
  const targetDir = installRoot();
  console.log(`Installing to ${targetDir}…`);
  await copyBundle(extractDir, targetDir);
  rmSync(workDir, { force: true, recursive: true });
  console.log(`cursor-api updated to ${latest.version}.`);
  if (wasRunning) {
    console.log("Run: cursor-api start");
  }
};

export const recordUpdateCheck = function recordUpdateCheck(
  result: Awaited<ReturnType<typeof checkForUpdate>>
): void {
  const dir = path.join(process.env.APPDATA || "", "cursor-api");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "update-check.json"),
    `${JSON.stringify({ checkedAt: new Date().toISOString(), ...result }, null, 2)}\n`,
    "utf-8"
  );
};
