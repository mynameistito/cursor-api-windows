import {
  createWriteStream,
  existsSync,
  openSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { setTimeout } from "node:timers/promises";

import { logsDir, ensureConfigDirs } from "@/config";

export type LogChannel = "server" | "bridge" | "daemon";

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

export const appendLog = (channel: LogChannel, line: string): void => {
  const filePath = logFile(channel);
  const stream = createWriteStream(filePath, { flags: "a" });
  const stamped = `[${new Date().toISOString()}] ${line}\n`;
  stream.write(stamped);
  stream.end();
};

export const createLogStream = (channel: LogChannel) => {
  ensureConfigDirs();
  const fd = openSync(logFile(channel), "a");
  return createWriteStream("", { fd, flags: "a" });
};

export const readRecentLogs = (
  channel: LogChannel | "all",
  lines = 80
): string[] => {
  const files =
    channel === "all"
      ? (["daemon", "server", "bridge"] as LogChannel[]).map((c) => logFile(c))
      : [logFile(channel)];

  const output: string[] = [];
  for (const file of files) {
    if (!existsSync(file)) {
      continue;
    }
    const content = readFileSync(file, "utf-8").trim();
    if (!content) {
      continue;
    }
    const label = logChannelLabel(file);
    const chunk = content.split("\n").slice(-lines);
    for (const line of chunk) {
      output.push(`[${label}] ${line}`);
    }
  }
  return output.slice(-lines);
};

export const followLogs = async (
  channel: LogChannel | "all"
): Promise<void> => {
  const targets =
    channel === "all"
      ? (["daemon", "server", "bridge"] as LogChannel[])
      : [channel];

  const positions = new Map<string, number>();
  for (const ch of targets) {
    const file = logFile(ch);
    positions.set(file, existsSync(file) ? statSync(file).size : 0);
  }

  process.stdout.write(`Following logs in ${logsDir()} (Ctrl+C to exit)\n`);

  const poll = async (): Promise<void> => {
    for (const ch of targets) {
      const file = logFile(ch);
      if (!existsSync(file)) {
        continue;
      }
      const { size } = statSync(file);
      const prev = positions.get(file) ?? 0;
      if (size <= prev) {
        continue;
      }
      const buf = readFileSync(file);
      const chunk = buf.subarray(prev, size).toString("utf-8");
      positions.set(file, size);
      for (const line of chunk.split("\n")) {
        if (line.trim()) {
          process.stdout.write(`[${ch}] ${line}\n`);
        }
      }
    }
    await setTimeout(500);
    await poll();
  };

  await poll();
};

export const listLogFiles = (): string[] => {
  ensureConfigDirs();
  return readdirSync(logsDir())
    .filter((name) => name.endsWith(".log"))
    .map((name) => path.join(logsDir(), name));
};
