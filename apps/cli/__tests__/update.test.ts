import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  buildFinishSelfUpdateScript,
  compareSemver,
  isUpdatingInstalledBinary,
} from "@/update";

describe(compareSemver, () => {
  it("orders versions numerically", () => {
    expect(compareSemver("1.0.1", "1.0.0")).toBe(1);
    expect(compareSemver("1.0.0", "1.0.1")).toBe(-1);
    expect(compareSemver("1.0.0", "1.0.0")).toBe(0);
  });

  it("strips a leading v prefix", () => {
    expect(compareSemver("v1.2.0", "1.1.9")).toBe(1);
  });

  it("treats missing patch segments as zero", () => {
    expect(compareSemver("1.0", "1.0.0")).toBe(0);
    expect(compareSemver("1.1", "1.0.9")).toBe(1);
  });
});

describe(isUpdatingInstalledBinary, () => {
  const originalExecPath = process.execPath;
  let tempDir: string | null = null;

  afterEach(() => {
    Object.defineProperty(process, "execPath", { value: originalExecPath });
    if (tempDir !== null) {
      rmSync(tempDir, { force: true, recursive: true });
      tempDir = null;
    }
  });

  it("returns false when the installed exe is missing", () => {
    tempDir = mkdtempSync(path.join(homedir(), ".cursor-api-update-"));
    expect(isUpdatingInstalledBinary(tempDir)).toBeFalsy();
  });

  it("returns true when the running binary is the installed exe", () => {
    tempDir = mkdtempSync(path.join(homedir(), ".cursor-api-update-"));
    const exePath = path.join(tempDir, "cursor-api.exe");
    writeFileSync(exePath, "");
    Object.defineProperty(process, "execPath", { value: exePath });
    expect(isUpdatingInstalledBinary(tempDir)).toBeTruthy();
  });

  it("returns false when running from a different path", () => {
    tempDir = mkdtempSync(path.join(homedir(), ".cursor-api-update-"));
    writeFileSync(path.join(tempDir, "cursor-api.exe"), "");
    Object.defineProperty(process, "execPath", {
      value: path.join(homedir(), "cursor-api-dev.exe"),
    });
    expect(isUpdatingInstalledBinary(tempDir)).toBeFalsy();
  });
});

describe(buildFinishSelfUpdateScript, () => {
  let workDir: string | null = null;

  afterEach(() => {
    if (workDir !== null) {
      rmSync(workDir, { force: true, recursive: true });
      workDir = null;
    }
  });

  it("retries the executable swap and logs failures", () => {
    workDir = mkdtempSync(path.join(homedir(), ".cursor-api-update-work-"));
    const script = buildFinishSelfUpdateScript({
      parentPid: 1234,
      targetDir: "C:\\Programs\\cursor-api",
      wasRunning: true,
      workDir,
    });

    expect(
      [
        "Wait-Process -Id 1234",
        "$attempt -le 30",
        "replace attempt $attempt failed",
        "self-update: $Message",
        "Start-Process -FilePath",
      ].every((token) => script.includes(token))
    ).toBeTruthy();
    expect(script).not.toContain(
      `Remove-Item -LiteralPath '${workDir}' -Recurse`
    );
    expect(script.indexOf("Start-Process -FilePath")).toBeGreaterThan(
      script.indexOf("if (-not $installed)")
    );
  });

  it("does not restart the daemon when it was not running", () => {
    workDir = mkdtempSync(path.join(homedir(), ".cursor-api-update-work-"));
    const script = buildFinishSelfUpdateScript({
      parentPid: 1234,
      targetDir: "C:\\Programs\\cursor-api",
      wasRunning: false,
      workDir,
    });

    expect(script).not.toContain("Start-Process -FilePath");
  });
});
