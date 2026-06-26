#!/usr/bin/env bun
import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";

import { Command } from "commander";

import { configureAgent, listAgents } from "@/agents/index";
import { loadSettings, saveSettings, baseUrl, DEFAULT_PORT } from "@/config";
import {
  deleteApiKey,
  maskApiKey,
  readApiKey,
  writeApiKey,
} from "@/credentials";
import {
  checkHealth,
  getStatus,
  runDaemonForeground,
  startDaemon,
  stopDaemon,
} from "@/daemon";
import { followLogs, readRecentLogs } from "@/logs";
import { checkForUpdate, recordUpdateCheck, runUpdate } from "@/update";
import { VERSION } from "@/version";

const printHeading = (text: string): void => {
  console.log(`\n${text}`);
  console.log("─".repeat(text.length));
};

const promptHidden = async (prompt: string): Promise<string> => {
  const rl = createInterface({ input, output });
  try {
    const answer = await rl.question(prompt);
    return answer.trim();
  } finally {
    rl.close();
  }
};

const buildProgram = (): Command => {
  const program = new Command("cursor-api")
    .description("Local OpenAI-compatible Cursor API for Windows (CLI)")
    .version(VERSION);

  const key = program.command("key").description("Manage your Cursor API key");

  key
    .command("set")
    .description("Save your Cursor API key (crsr_…)")
    .option("--key <key>", "API key value (omit to prompt)")
    .action(async (opts: { key?: string }) => {
      const value =
        opts.key?.trim() || (await promptHidden("Cursor API key: "));
      if (!value) {
        console.error("No key provided.");
        process.exit(1);
      }
      await writeApiKey(value);
      console.log("API key saved.");
      console.log(
        "Restart the server if it is already running: cursor-api restart"
      );
    });

  key
    .command("status")
    .description("Show whether a key is configured")
    .action(async () => {
      const keyValue = await readApiKey();
      console.log(
        keyValue.trim()
          ? `configured: ${maskApiKey(keyValue)}`
          : "not configured"
      );
    });

  key
    .command("delete")
    .description("Remove the stored API key")
    .action(async () => {
      await deleteApiKey();
      console.log("API key deleted.");
    });

  program
    .command("start")
    .description("Start cursor-api in the background")
    .action(async () => {
      await startDaemon();
    });

  program
    .command("stop")
    .description("Stop the background cursor-api process")
    .action(async () => {
      await stopDaemon();
    });

  program
    .command("restart")
    .description("Restart cursor-api")
    .action(async () => {
      await stopDaemon();
      await startDaemon();
    });

  program
    .command("status")
    .description("Show server status")
    .action(async () => {
      const status = await getStatus();
      printHeading("cursor-api status");
      console.log(`version:   ${VERSION}`);
      console.log(`running:   ${status.running ? "yes" : "no"}`);
      console.log(`pid:       ${status.pid ?? "-"}`);
      console.log(`port:      ${status.port}`);
      console.log(`base url:  ${status.baseUrl}`);
      console.log(`bridge:    ${status.bridgePort ?? "not running"}`);
      console.log(
        `api key:   ${status.hasApiKey ? "configured" : "not configured"}`
      );
      try {
        const update = await checkForUpdate();
        recordUpdateCheck(update);
        if (update.latest) {
          console.log(
            `update:    ${update.updateAvailable ? `available (${update.current} -> ${update.latest.version})` : "up to date"}`
          );
        }
      } catch {
        console.log("update:    (could not reach GitHub)");
      }
    });

  program
    .command("daemon")
    .description("(internal) run foreground supervisor")
    .action(async () => {
      await runDaemonForeground();
    });

  const logs = program.command("logs").description("View server logs");

  logs
    .option("-f, --follow", "follow log output")
    .option("-n, --lines <count>", "number of lines when not following", "80")
    .action(async (opts: { follow?: boolean; lines: string }) => {
      if (opts.follow) {
        await followLogs("all");
        return;
      }
      const lines = Number.parseInt(opts.lines, 10) || 80;
      for (const line of readRecentLogs("all", lines)) {
        console.log(line);
      }
    });

  program
    .command("health")
    .description("Check the local /health endpoint")
    .action(async () => {
      const { port } = loadSettings();
      try {
        const res = await checkHealth(port);
        const body = await res.text();
        console.log(`${res.status} ${body}`);
        process.exit(res.ok ? 0 : 1);
      } catch (error) {
        console.error(`health check failed: ${String(error)}`);
        process.exit(1);
      }
    });

  const port = program.command("port").description("Configure the HTTP port");

  port
    .command("show")
    .description("Show the configured port")
    .action(() => {
      console.log(loadSettings().port);
    });

  port
    .command("set <port>")
    .description(`Set the HTTP port (default ${DEFAULT_PORT})`)
    .action((value: string) => {
      const parsed = Number.parseInt(value, 10);
      if (!Number.isInteger(parsed) || parsed <= 0 || parsed >= 65_536) {
        console.error("Port must be an integer between 1 and 65535.");
        process.exit(1);
      }
      const settings = loadSettings();
      settings.port = parsed;
      saveSettings(settings);
      console.log(
        `Port set to ${parsed}. Run cursor-api start to apply the change.`
      );
    });

  const configure = program
    .command("configure")
    .description("Wire an agent to cursor-api");

  configure
    .command("list")
    .description("List supported agents")
    .action(async () => {
      const agents = await listAgents();
      for (const agent of agents) {
        console.log(
          `${agent.id.padEnd(10)} ${agent.name.padEnd(12)} ${agent.status}`
        );
      }
    });

  configure
    .command("agent <id>")
    .description(
      "Configure a supported agent (opencode, codex, vscode, cline, kilo, pi)"
    )
    .action(async (id: string) => {
      const url = baseUrl();
      const result = await configureAgent(id, url);
      console.log(result);
    });

  program
    .command("url")
    .description("Print the local OpenAI base URL")
    .action(() => {
      console.log(baseUrl());
    });

  const update = program
    .command("update")
    .description("Check for or install updates");

  update
    .command("check")
    .description("Check whether a newer release is available")
    .action(async () => {
      const result = await checkForUpdate();
      recordUpdateCheck(result);
      if (!result.latest) {
        console.log("No published releases found yet.");
        process.exit(1);
      }
      if (result.updateAvailable) {
        console.log(
          `Update available: ${result.current} -> ${result.latest.version}`
        );
        console.log(`Published: ${result.latest.publishedAt}`);
        if (result.latest.releaseNotes.trim()) {
          console.log("\nRelease notes:\n");
          console.log(result.latest.releaseNotes.trim());
        }
        console.log("\nRun: cursor-api update");
        process.exit(2);
      }
      console.log(`cursor-api ${result.current} is up to date.`);
    });

  update
    .command("install", { isDefault: true })
    .description("Download and install the latest release")
    .option("--force", "reinstall even if already on the latest version")
    .action(async (opts: { force?: boolean }) => {
      await runUpdate({ force: opts.force });
    });

  return program;
};

const program = buildProgram();
await program.parseAsync(process.argv);
