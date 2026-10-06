import {
  createWriteStream,
  existsSync,
  openSync,
  readFileSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { setTimeout } from "node:timers/promises";

import { logsDir, ensureConfigDirs } from "@/config";

type LogChannel = "server" | "bridge" | "daemon";

const logChannelLabel = (file: string): LogChannel => {
  if (file.includes("bridge")) {
    return "bridge";
  }
  if (file.includes("server")) {
    return "server";
  }
  return "daemon";
};

const logFile = (channel: LogChannel): string => {
  ensureConfigDirs();
  return path.join(logsDir(), `${channel}.log`);
};

/** Append a timestamped line to the selected log.
 * @param channel - Log channel to write to.
 * @param line - Message to append.
 */
export const appendLog = (channel: LogChannel, line: string): void => {
  const filePath = logFile(channel);
  const stream = createWriteStream(filePath, { flags: "a" });
  const stamped = `[${new Date().toISOString()}] ${line}\n`;
  stream.write(stamped);
  stream.end();
};

/** Open a log file descriptor for child stdio (caller should close after spawn).
 * @param channel - Log channel to open.
 * @returns An open file descriptor in append mode.
 */
export const openLogFd = (channel: LogChannel): number => {
  ensureConfigDirs();
  return openSync(logFile(channel), "a");
};

/** Read the most recent lines from one or all logs.
 * @param channel - Log channel to read, or `all` to combine channels.
 * @param lines - Maximum number of lines to return.
 * @returns Recent log lines prefixed with their channel labels.
 */
export const readRecentLogs = (
  channel: LogChannel | "all",
  lines = 80
): string[] => {
  const allChannels: LogChannel[] = ["daemon", "server", "bridge"];
  const files =
    channel === "all" ? allChannels.map(logFile) : [logFile(channel)];

  const output: string[] = [];
  for (const file of files) {
    if (existsSync(file)) {
      const content = readFileSync(file, "utf-8").trim();
      if (content) {
        const label = logChannelLabel(file);
        const chunk = content.split("\n").slice(-lines);
        for (const line of chunk) {
          output.push(`[${label}] ${line}`);
        }
      }
    }
  }
  return output.slice(-lines);
};

/** Continuously write new lines from the selected logs to stdout.
 * @param channel - Log channel to follow, or `all` to follow every channel.
 */
export const followLogs = async (
  channel: LogChannel | "all"
): Promise<void> => {
  const allChannels: LogChannel[] = ["daemon", "server", "bridge"];
  const targets = channel === "all" ? allChannels : [channel];

  const positions = new Map<string, number>();
  for (const ch of targets) {
    const file = logFile(ch);
    positions.set(file, existsSync(file) ? statSync(file).size : 0);
  }

  process.stdout.write(`Following logs in ${logsDir()} (Ctrl+C to exit)\n`);

  const poll = async (): Promise<void> => {
    for (const ch of targets) {
      const file = logFile(ch);
      if (existsSync(file)) {
        const { size } = statSync(file);
        const prev = positions.get(file) ?? 0;
        if (size > prev) {
          const buf = readFileSync(file);
          const chunk = buf.subarray(prev, size).toString("utf-8");
          positions.set(file, size);
          for (const line of chunk.split("\n")) {
            if (line.trim()) {
              process.stdout.write(`[${ch}] ${line}\n`);
            }
          }
        }
      }
    }
    await setTimeout(500);
    await poll();
  };

  await poll();
};
