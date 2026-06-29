import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
  let tempDir: string | undefined;

  afterEach(() => {
    Object.defineProperty(process, "execPath", { value: originalExecPath });
    if (tempDir) {
      rmSync(tempDir, { force: true, recursive: true });
      tempDir = undefined;
    }
  });

  it("returns false when the installed exe is missing", () => {
    tempDir = mkdtempSync(path.join(tmpdir(), "cursor-api-update-"));
    expect(isUpdatingInstalledBinary(tempDir)).toBeFalsy();
  });

  it("returns true when the running binary is the installed exe", () => {
    tempDir = mkdtempSync(path.join(tmpdir(), "cursor-api-update-"));
    const exePath = path.join(tempDir, "cursor-api.exe");
    writeFileSync(exePath, "");
    Object.defineProperty(process, "execPath", { value: exePath });
    expect(isUpdatingInstalledBinary(tempDir)).toBeTruthy();
  });

  it("returns false when running from a different path", () => {
    tempDir = mkdtempSync(path.join(tmpdir(), "cursor-api-update-"));
    writeFileSync(path.join(tempDir, "cursor-api.exe"), "");
    Object.defineProperty(process, "execPath", {
      value: path.join(tmpdir(), "cursor-api-dev.exe"),
    });
    expect(isUpdatingInstalledBinary(tempDir)).toBeFalsy();
  });
});

describe(buildFinishSelfUpdateScript, () => {
  it("retries the executable swap and logs failures", () => {
    const script = buildFinishSelfUpdateScript({
      parentPid: 1234,
      targetDir: "C:\\Programs\\cursor-api",
      wasRunning: true,
      workDir: "C:\\Temp\\cursor-api-update",
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
      "Remove-Item -LiteralPath 'C:\\Temp\\cursor-api-update' -Recurse"
    );
    expect(script.indexOf("Start-Process -FilePath")).toBeGreaterThan(
      script.indexOf("if (-not $installed)")
    );
  });

  it("does not restart the daemon when it was not running", () => {
    const script = buildFinishSelfUpdateScript({
      parentPid: 1234,
      targetDir: "C:\\Programs\\cursor-api",
      wasRunning: false,
      workDir: "C:\\Temp\\cursor-api-update",
    });

    expect(script).not.toContain("Start-Process -FilePath");
  });
});
