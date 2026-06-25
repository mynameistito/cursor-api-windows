import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

import { APP_NAME, ensureConfigDirs } from "@/config";

/** Independent credential namespace (does not share with API for Cursor GUI). */
const CREDENTIAL_SERVICE = "ai.cursorapi.cli";

const SECRET_FILE = "api-key.enc";

const secretPath = (): string =>
  path.join(process.env.APPDATA || "", APP_NAME, SECRET_FILE);

const deriveKey = (): Buffer => {
  const material = `${process.env.USERNAME || "user"}@${process.env.COMPUTERNAME || "pc"}:${CREDENTIAL_SERVICE}`;
  return createHash("sha256").update(material).digest();
};

const encrypt = (plaintext: string): string => {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(), iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf-8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString("base64");
};

const decrypt = (encoded: string): string => {
  const buf = Buffer.from(encoded, "base64");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const data = buf.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", deriveKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString(
    "utf-8"
  );
};

const readFromFile = (): string => {
  const filePath = secretPath();
  if (!existsSync(filePath)) {
    return "";
  }
  try {
    return decrypt(readFileSync(filePath, "utf-8").trim());
  } catch {
    return "";
  }
};

const writeToFile = (key: string): void => {
  ensureConfigDirs();
  writeFileSync(secretPath(), encrypt(key.trim()), "utf-8");
};

const deleteFile = (): void => {
  const filePath = secretPath();
  if (existsSync(filePath)) {
    unlinkSync(filePath);
  }
};

/** Read the stored Cursor API key, or empty string when unset. */
export const readApiKey = (): Promise<string> =>
  Promise.resolve(readFromFile());

/** Persist the Cursor API key (trimmed). */
export const writeApiKey = (key: string): Promise<void> => {
  const trimmed = key.trim();
  if (!trimmed) {
    return Promise.reject(new Error("API key cannot be empty"));
  }
  writeToFile(trimmed);
  return Promise.resolve();
};

/** Remove the stored API key. */
export const deleteApiKey = (): Promise<void> => {
  deleteFile();
  return Promise.resolve();
};

/** Mask a key for display (`crsr_…xxxx`). */
export const maskApiKey = (key: string): string => {
  const trimmed = key.trim();
  if (!trimmed) {
    return "(not set)";
  }
  if (trimmed.length <= 8) {
    return "********";
  }
  return `${trimmed.slice(0, 5)}…${trimmed.slice(-4)}`;
};
