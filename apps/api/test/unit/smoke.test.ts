import { describe, expect, it } from "vitest";
import { hash32 } from "../../src/jobs/dispatch.js";

describe("smoke", () => {
  it("hash32 is stable", () => {
    expect(hash32("abc")).toBe(hash32("abc"));
  });
});
