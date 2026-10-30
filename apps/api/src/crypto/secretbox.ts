/**
 * AES-256-GCM envelope for per-user secrets (spec §12.2): random 12-byte nonce per value, auth tag
 * stored, master key from env PACEO_ENCRYPTION_KEY (32 bytes, base64).
 *
 * Envelope format (text, safe for a `text` column): "v<keyVersion>.<base64(nonce | tag | ciphertext)>".
 * The key version supports rotation: decrypt with the old key, re-encrypt with the new one.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export class SecretBoxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretBoxError";
  }
}

export function parseMasterKey(base64: string): Buffer {
  const key = Buffer.from(base64.trim(), "base64");
  if (key.length !== 32) {
    throw new SecretBoxError(`PACEO_ENCRYPTION_KEY must decode to 32 bytes (got ${key.length})`);
  }
  return key;
}

export interface SecretBox {
  encrypt(plaintext: string, aad?: string): string;
  decrypt(envelope: string, aad?: string): string;
  readonly keyVersion: number;
}

/**
 * `aad` (additional authenticated data) binds a ciphertext to its row, e.g. "<userId>:intervals_icu",
 * so a secret copied into another user's row fails to decrypt.
 */
export function createSecretBox(keys: Record<number, Buffer>, currentVersion: number): SecretBox {
  const current = keys[currentVersion];
  if (!current) throw new SecretBoxError(`no key for version ${currentVersion}`);
  return {
    keyVersion: currentVersion,
    encrypt(plaintext, aad) {
      const nonce = randomBytes(NONCE_BYTES);
      const cipher = createCipheriv("aes-256-gcm", current, nonce);
      if (aad !== undefined) cipher.setAAD(Buffer.from(aad, "utf8"));
      const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      const tag = cipher.getAuthTag();
      return `v${currentVersion}.${Buffer.concat([nonce, tag, ct]).toString("base64")}`;
    },
    decrypt(envelope, aad) {
      const m = /^v(\d+)\.([A-Za-z0-9+/=]+)$/.exec(envelope);
      if (!m) throw new SecretBoxError("malformed envelope");
      const key = keys[Number(m[1])];
      if (!key) throw new SecretBoxError(`no key for version ${m[1]}`);
      const raw = Buffer.from(m[2] as string, "base64");
      if (raw.length < NONCE_BYTES + TAG_BYTES) throw new SecretBoxError("envelope too short");
      const nonce = raw.subarray(0, NONCE_BYTES);
      const tag = raw.subarray(NONCE_BYTES, NONCE_BYTES + TAG_BYTES);
      const ct = raw.subarray(NONCE_BYTES + TAG_BYTES);
      const decipher = createDecipheriv("aes-256-gcm", key, nonce);
      if (aad !== undefined) decipher.setAAD(Buffer.from(aad, "utf8"));
      decipher.setAuthTag(tag);
      try {
        return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
      } catch {
        throw new SecretBoxError("decryption failed (wrong key or tampered data)");
      }
    },
  };
}
