import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createSecretBox, parseMasterKey, SecretBoxError } from "../../src/crypto/secretbox.js";
import { hashPassword, verifyPassword } from "../../src/crypto/password.js";
import { inviteCode, normalizeInviteCode, sha256Hex } from "../../src/crypto/tokens.js";

const key = () => randomBytes(32);

describe("secretbox (AES-256-GCM)", () => {
  it("round-trips with AAD", () => {
    const box = createSecretBox({ 1: key() }, 1);
    const env = box.encrypt("my-intervals-key", "user-1:intervals_icu");
    expect(env).toMatch(/^v1\./);
    expect(env).not.toContain("my-intervals-key");
    expect(box.decrypt(env, "user-1:intervals_icu")).toBe("my-intervals-key");
  });

  it("uses a fresh nonce each time", () => {
    const box = createSecretBox({ 1: key() }, 1);
    expect(box.encrypt("x")).not.toBe(box.encrypt("x"));
  });

  it("rejects a different AAD (secret moved to another user's row)", () => {
    const box = createSecretBox({ 1: key() }, 1);
    const env = box.encrypt("secret", "user-1:intervals_icu");
    expect(() => box.decrypt(env, "user-2:intervals_icu")).toThrow(SecretBoxError);
  });

  it("rejects tampered ciphertext", () => {
    const box = createSecretBox({ 1: key() }, 1);
    const env = box.encrypt("secret");
    const raw = Buffer.from(env.slice(3), "base64");
    raw[raw.length - 1] = (raw[raw.length - 1] as number) ^ 0xff;
    expect(() => box.decrypt(`v1.${raw.toString("base64")}`)).toThrow(SecretBoxError);
  });

  it("rejects the wrong key and malformed envelopes", () => {
    const a = createSecretBox({ 1: key() }, 1);
    const b = createSecretBox({ 1: key() }, 1);
    expect(() => b.decrypt(a.encrypt("secret"))).toThrow(SecretBoxError);
    expect(() => a.decrypt("garbage")).toThrow(SecretBoxError);
    expect(() => a.decrypt("v9.AAAA")).toThrow(SecretBoxError);
  });

  it("decrypts old versions during key rotation", () => {
    const k1 = key();
    const k2 = key();
    const old = createSecretBox({ 1: k1 }, 1).encrypt("secret");
    const rotated = createSecretBox({ 1: k1, 2: k2 }, 2);
    expect(rotated.decrypt(old)).toBe("secret");
    expect(rotated.encrypt("secret")).toMatch(/^v2\./);
  });

  it("validates the master key length", () => {
    expect(parseMasterKey(randomBytes(32).toString("base64")).length).toBe(32);
    expect(() => parseMasterKey(randomBytes(16).toString("base64"))).toThrow(/32 bytes/);
  });
});

describe("scrypt passwords", () => {
  it("verifies the right password and rejects the wrong one", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(hash).toMatch(/^scrypt\$32768\$8\$1\$/);
    expect(await verifyPassword("correct horse battery staple", hash)).toBe(true);
    expect(await verifyPassword("wrong password!!", hash)).toBe(false);
  });

  it("salts every hash", async () => {
    const params = { N: 1024, r: 8, p: 1 };
    expect(await hashPassword("same-password", params)).not.toBe(await hashPassword("same-password", params));
  });

  it("verifies hashes made with other parameters", async () => {
    const hash = await hashPassword("pw-with-low-cost", { N: 1024, r: 8, p: 1 });
    expect(await verifyPassword("pw-with-low-cost", hash)).toBe(true);
  });

  it("rejects malformed stored hashes", async () => {
    expect(await verifyPassword("x", "bcrypt$whatever")).toBe(false);
    expect(await verifyPassword("x", "scrypt$0$8$1$AA$AA")).toBe(false);
  });
});

describe("invite codes", () => {
  it("are 4×4 groups and normalise case/whitespace", () => {
    const code = inviteCode();
    expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(sha256Hex(normalizeInviteCode(` ${code.toLowerCase()} `))).toBe(sha256Hex(code));
  });
});
