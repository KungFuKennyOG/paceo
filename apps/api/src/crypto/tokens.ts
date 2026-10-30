import { createHash, randomBytes } from "node:crypto";

/** URL-safe random token (session tokens). */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function sha256Hex(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * Human-friendly invite code: 4 groups of 4 from an unambiguous alphabet (no 0/O/1/I/L),
 * ~80 bits of entropy. Compared case-insensitively.
 */
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export function inviteCode(): string {
  const bytes = randomBytes(16);
  let out = "";
  for (let i = 0; i < 16; i++) {
    out += ALPHABET[(bytes[i] as number) % ALPHABET.length];
    if (i % 4 === 3 && i < 15) out += "-";
  }
  return out;
}

export function normalizeInviteCode(code: string): string {
  return code.trim().toUpperCase().replace(/\s+/g, "");
}
