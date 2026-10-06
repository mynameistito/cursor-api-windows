const encoder = new TextEncoder();

/**
 * Create a hexadecimal SHA-256 digest for a string.
 * @param value - The input string.
 * @returns The lowercase hexadecimal digest.
 */
export const sha256Hex = async (value: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
};
