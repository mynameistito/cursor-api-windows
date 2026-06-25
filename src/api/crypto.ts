const encoder = new TextEncoder();
const decoder = new TextDecoder();

const base64Encode = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCodePoint(byte);
  }
  return btoa(binary);
};

const base64Decode = (value: string): Uint8Array => {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    const codePoint = binary.codePointAt(index);
    bytes[index] = codePoint ?? 0;
  }
  return bytes;
};

const base64UrlEncode = (bytes: Uint8Array): string =>
  base64Encode(bytes)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");

const toArrayBuffer = (bytes: Uint8Array): ArrayBuffer =>
  bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength
  ) as ArrayBuffer;

const normalizeKeyBytes = async (secret: string): Promise<Uint8Array> => {
  const trimmed = secret.trim();
  if (/^[0-9a-f]{64}$/iu.test(trimmed)) {
    return new Uint8Array(
      trimmed.match(/.{1,2}/gu)?.map((part) => Number.parseInt(part, 16)) ?? []
    );
  }
  try {
    const decoded = base64Decode(trimmed);
    if (decoded.byteLength === 32) {
      return decoded;
    }
  } catch {
    // Fall through to hash derivation.
  }
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", encoder.encode(trimmed))
  );
};

const importAesKey = async (secret: string): Promise<CryptoKey> => {
  const bytes = await normalizeKeyBytes(secret);
  return crypto.subtle.importKey(
    "raw",
    toArrayBuffer(bytes),
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"]
  );
};

export const sha256Hex = async (value: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
};

export const accountIdForCursor = async (
  userId: string | null,
  email: string | null,
  fallback: string
): Promise<string> => {
  let basis: string;
  if (userId) {
    basis = `cursor-user:${userId}`;
  } else if (email) {
    basis = `cursor-email:${email.toLowerCase()}`;
  } else {
    basis = `cursor-key:${fallback}`;
  }
  const hash = await sha256Hex(basis);
  return `acct_${hash.slice(0, 24)}`;
};

export const randomToken = (prefix: string, bytes = 32): string => {
  const values = new Uint8Array(bytes);
  crypto.getRandomValues(values);
  return `${prefix}_${base64UrlEncode(values)}`;
};

export const apiKeyPrefix = (apiKey: string): string => apiKey.slice(0, 14);

export const encryptText = async (
  plaintext: string,
  secret: string
): Promise<{ ciphertext: string; iv: string }> => {
  const key = await importAesKey(secret);
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const ciphertext = await crypto.subtle.encrypt(
    { iv: toArrayBuffer(iv), name: "AES-GCM" },
    key,
    toArrayBuffer(encoder.encode(plaintext))
  );
  return {
    ciphertext: base64Encode(new Uint8Array(ciphertext)),
    iv: base64Encode(iv),
  };
};

export const decryptText = async (
  ciphertext: string,
  iv: string,
  secret: string
): Promise<string> => {
  const key = await importAesKey(secret);
  const plaintext = await crypto.subtle.decrypt(
    { iv: toArrayBuffer(base64Decode(iv)), name: "AES-GCM" },
    key,
    toArrayBuffer(base64Decode(ciphertext))
  );
  return decoder.decode(plaintext);
};
