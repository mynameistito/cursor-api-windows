import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_PORT, loadSettings, saveSettings } from "@/config";

describe(loadSettings, () => {
  let savedAppData: string | undefined;
  let tempAppData: string;

  beforeEach(() => {
    savedAppData = process.env.APPDATA;
    tempAppData = mkdtempSync(path.join(tmpdir(), "cursor-api-config-"));
    process.env.APPDATA = tempAppData;
  });

  afterEach(() => {
    rmSync(tempAppData, { force: true, recursive: true });
    if (savedAppData === undefined) {
      delete process.env.APPDATA;
    } else {
      process.env.APPDATA = savedAppData;
    }
  });

  it("returns defaults when settings.json is missing", () => {
    expect(loadSettings()).toStrictEqual({
      autostart: false,
      port: DEFAULT_PORT,
    });
  });

  it("merges partial settings with defaults", () => {
    saveSettings({ autostart: false, port: DEFAULT_PORT });
    const settingsPath = path.join(tempAppData, "cursor-api", "settings.json");
    const raw = JSON.parse(readFileSync(settingsPath, "utf-8")) as Record<
      string,
      unknown
    >;
    raw.port = 9000;
    writeFileSync(settingsPath, `${JSON.stringify(raw)}\n`, "utf-8");

    expect(loadSettings()).toStrictEqual({
      autostart: false,
      port: 9000,
    });
  });

  it("round-trips saveSettings and loadSettings", () => {
    saveSettings({ autostart: true, port: 4242 });
    expect(loadSettings()).toStrictEqual({
      autostart: true,
      port: 4242,
    });
    expect(
      existsSync(path.join(tempAppData, "cursor-api", "settings.json"))
    ).toBeTruthy();
  });
});
