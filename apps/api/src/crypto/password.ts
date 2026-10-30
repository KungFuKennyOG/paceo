/**
 * Password hashing with Node's built-in scrypt (no native dependencies).
 * Format: "scrypt$N$r$p$<salt b64>$<hash b64>", so parameters can be raised later without breaking
 * existing hashes.
 */
import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from "node:crypto";

const KEYLEN = 64;
/** N=2^15, r=8 → 32 MiB per hash; ~50–100 ms on a laptop. */
export const DEFAULT_SCRYPT = { N: 1 << 15, r: 8, p: 1 } as const;

function scrypt(password: string, salt: Buffer, keylen: number, opts: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(password.normalize("NFKC"), salt, keylen, opts, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

function maxmemFor(N: number, r: number): number {
  return 128 * N * r * 2;
}

export async function hashPassword(
  password: string,
  params: { N: number; r: number; p: number } = DEFAULT_SCRYPT,
): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, KEYLEN, { ...params, maxmem: maxmemFor(params.N, params.r) });
  return ["scrypt", params.N, params.r, params.p, salt.toString("base64"), key.toString("base64")].join("$");
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (![N, r, p].every((x) => Number.isInteger(x) && x > 0)) return false;
  const salt = Buffer.from(parts[4] as string, "base64");
  const expected = Buffer.from(parts[5] as string, "base64");
  const actual = await scrypt(password, salt, expected.length, { N, r, p, maxmem: maxmemFor(N, r) });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** A precomputed hash used to keep login timing similar when the email does not exist. */
let dummyHash: Promise<string> | undefined;
export function dummyPasswordHash(): Promise<string> {
  dummyHash ??= hashPassword("not-a-real-password-" + randomBytes(8).toString("hex"));
  return dummyHash;
}
