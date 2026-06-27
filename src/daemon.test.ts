import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { DEFAULT_PORT } from "@/config";
import { runningConfigMatches, tasklistOutputContainsPid } from "@/daemon";

const apiKeyFingerprint = (apiKey: string): string =>
  createHash("sha256").update(apiKey.trim()).digest("hex").slice(0, 16);

describe(tasklistOutputContainsPid, () => {
  it("returns true when stdout lists the PID", () => {
    const stdout =
      "cursor-api.exe               12345 Console                    1     45,678 K\n";
    expect(tasklistOutputContainsPid(stdout, 12_345)).toBeTruthy();
  });

  it("returns false for the no-match INFO line", () => {
    const stdout =
      "INFO: No tasks are running which match the specified criteria.\n";
    expect(tasklistOutputContainsPid(stdout, 12_345)).toBeFalsy();
  });

  it("returns false for empty stdout", () => {
    expect(tasklistOutputContainsPid("", 1)).toBeFalsy();
  });

  it("does not match a PID that appears only as a substring", () => {
    const stdout =
      "cursor-api.exe               1234 Console                    1     45,678 K\n";
    expect(tasklistOutputContainsPid(stdout, 12_345)).toBeFalsy();
  });
});

describe(runningConfigMatches, () => {
  const apiKey = "crsr_test_key_12345";

  it("returns true when port and API key fingerprint match", () => {
    expect(
      runningConfigMatches(
        {
          apiKeyFingerprint: apiKeyFingerprint(apiKey),
          bridgePort: null,
          pid: 1,
          port: DEFAULT_PORT,
          startedAt: "2026-01-01T00:00:00.000Z",
        },
        DEFAULT_PORT,
        apiKey
      )
    ).toBeTruthy();
  });

  it("returns false when state is null, port differs, or API key differs", () => {
    const state = {
      apiKeyFingerprint: apiKeyFingerprint(apiKey),
      bridgePort: null,
      pid: 1,
      port: DEFAULT_PORT,
      startedAt: "2026-01-01T00:00:00.000Z",
    };
    expect(runningConfigMatches(null, DEFAULT_PORT, apiKey)).toBeFalsy();
    expect(runningConfigMatches(state, 9000, apiKey)).toBeFalsy();
    expect(
      runningConfigMatches(state, DEFAULT_PORT, "crsr_different_key")
    ).toBeFalsy();
    expect(runningConfigMatches(state, DEFAULT_PORT, apiKey)).toBeTruthy();
  });
});
