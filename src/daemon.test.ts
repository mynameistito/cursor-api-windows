import { describe, expect, it } from "vitest";

import { runningConfigMatches, tasklistOutputContainsPid } from "@/daemon";

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
  it("returns true when state port matches", () => {
    expect(
      runningConfigMatches(
        {
          bridgePort: null,
          pid: 1,
          port: 8787,
          startedAt: "2026-01-01T00:00:00.000Z",
        },
        8787
      )
    ).toBeTruthy();
  });

  it("returns false when state is null or port differs", () => {
    expect(runningConfigMatches(null, 8787)).toBeFalsy();
    expect(
      runningConfigMatches(
        {
          bridgePort: null,
          pid: 1,
          port: 8787,
          startedAt: "2026-01-01T00:00:00.000Z",
        },
        9000
      )
    ).toBeFalsy();
  });
});
