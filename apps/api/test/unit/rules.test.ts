import { describe, expect, it } from "vitest";
import { compliance, deriveStatus, matchActivities } from "../../src/plan/matching.js";
import { evaluateScreening, screeningExpired } from "../../src/plan/screening.js";
import { dailyDue, hash32, syncDue } from "../../src/jobs/dispatch.js";
import { painZone } from "../../src/services/checkins.js";
import { localParts } from "../../src/lib/time.js";
import { loadEnv } from "../../src/env.js";

describe("matching (§3.9)", () => {
  const w = (id: string, date: string, sport = "run", minutes = 40) => ({ id, date, sport, plannedMinutes: minutes, plannedRunM: 8000 });
  const a = (id: string, localDate: string, sport = "run", movingS: number | null = 2400) => ({ id, localDate, sport, movingS, distanceM: 8000 });

  it("matches by local date and sport, one activity per workout", () => {
    const m = matchActivities(
      [w("w1", "2026-11-02"), w("w2", "2026-11-02", "strength", 30), w("w3", "2026-11-03")],
      [a("a1", "2026-11-02"), a("a2", "2026-11-02", "strength", 1800), a("a3", "2026-11-04")],
    );
    expect(m.get("w1")?.id).toBe("a1");
    expect(m.get("w2")?.id).toBe("a2");
    expect(m.has("w3")).toBe(false);
  });

  it("picks the closest duration on a two-run day", () => {
    const m = matchActivities([w("long", "2026-11-02", "run", 90)], [a("short", "2026-11-02", "run", 1200), a("lng", "2026-11-02", "run", 5300)]);
    expect(m.get("long")?.id).toBe("lng");
  });

  it("derives status with the 80% compliance band", () => {
    const today = "2026-11-05";
    expect(deriveStatus("planned", w("x", "2026-11-02"), a("y", "2026-11-02", "run", 2400), today)).toBe("completed");
    expect(deriveStatus("planned", w("x", "2026-11-02"), a("y", "2026-11-02", "run", 1200), today)).toBe("partial");
    expect(deriveStatus("planned", w("x", "2026-11-02"), undefined, today)).toBe("missed");
    expect(deriveStatus("planned", w("x", "2026-11-06"), undefined, today)).toBe("planned");
    expect(deriveStatus("skipped", w("x", "2026-11-02"), a("y", "2026-11-02"), today)).toBe("skipped");
    expect(compliance(w("x", "d", "run", 0), a("y", "d", "run", null))).toBe(1);
  });
});

describe("health screen (§2.4)", () => {
  const req = (over: Partial<Parameters<typeof evaluateScreening>[0]> = {}) => ({
    answers: [false, false, false, false, false, false, false],
    pregnantOrPostpartum: false,
    recentSeriousInjuryOrSurgery: false,
    clearanceConfirmed: false,
    ...over,
  });
  const ctx = { age: 30, currentInjury: false };

  it("all no → ok", () => {
    expect(evaluateScreening(req(), ctx)).toMatchObject({ outcome: "ok", canProceed: true });
  });
  it("adds the 45+ note", () => {
    expect(evaluateScreening(req(), { age: 50, currentInjury: false }).notes.join(" ")).toMatch(/45/);
  });
  it("any yes → see_doctor until clearance", () => {
    const yes = req({ answers: [false, true, false, false, false, false, false] });
    expect(evaluateScreening(yes, ctx)).toMatchObject({ outcome: "see_doctor", canProceed: false });
    expect(evaluateScreening({ ...yes, clearanceConfirmed: true }, ctx)).toMatchObject({ outcome: "cleared", canProceed: true });
  });
  it("current injury counts as a yes", () => {
    expect(evaluateScreening(req(), { age: 30, currentInjury: true }).outcome).toBe("see_doctor");
  });
  it("pregnancy / recent surgery → out_of_scope, then conservative", () => {
    expect(evaluateScreening(req({ pregnantOrPostpartum: true }), ctx)).toMatchObject({ outcome: "out_of_scope", canProceed: false });
    expect(evaluateScreening(req({ recentSeriousInjuryOrSurgery: true, clearanceConfirmed: true }), ctx)).toMatchObject({
      outcome: "cleared_conservative",
      canProceed: true,
    });
  });
  it("expires after 12 months", () => {
    expect(screeningExpired(new Date("2025-10-01"), new Date("2026-10-30"))).toBe(true);
    expect(screeningExpired(new Date("2026-01-01"), new Date("2026-10-30"))).toBe(false);
  });
});

describe("pain zones (§8 R-PAIN)", () => {
  it("classifies", () => {
    expect(painZone(2, 0)).toBe("green");
    expect(painZone(4, null)).toBe("amber");
    expect(painZone(2, 1)).toBe("amber");
    expect(painZone(6, null)).toBe("red");
    expect(painZone(3, 4)).toBe("red");
  });
});

describe("dispatch rules (§12.1)", () => {
  it("syncs each user in exactly one of every three 5-minute slots, only while awake", () => {
    const start = Date.parse("2026-10-30T16:00:00Z"); // 12:00 in Toronto
    for (const user of ["u-a", "u-b", "u-c", "u-d"]) {
      const due = [0, 1, 2].map((i) => syncDue(user, new Date(start + i * 5 * 60_000), "America/Toronto").due);
      expect(due.filter(Boolean)).toHaveLength(1);
      expect(syncDue(user, new Date(start), "America/Toronto").startAfterSeconds).toBeLessThan(300);
    }
    const night = Date.parse("2026-10-30T07:00:00Z"); // 03:00 in Toronto
    const anyDue = [0, 1, 2].some((i) => syncDue("u-a", new Date(night + i * 5 * 60_000), "America/Toronto").due);
    expect(anyDue).toBe(false);
  });

  it("daily jobs fire once in the 15-minute window at the local hour, half-hour zones included", () => {
    expect(dailyDue(new Date("2026-10-30T11:05:00Z"), "America/Toronto", 7)).toEqual({ due: true, localDate: "2026-10-30" });
    expect(dailyDue(new Date("2026-10-30T11:20:00Z"), "America/Toronto", 7).due).toBe(false);
    // India is UTC+5:30: 07:00 local = 01:30Z.
    expect(dailyDue(new Date("2026-10-30T01:30:00Z"), "Asia/Kolkata", 7).due).toBe(true);
    expect(dailyDue(new Date("2026-10-30T01:00:00Z"), "Asia/Kolkata", 7).due).toBe(false);
  });

  it("hash32 is stable", () => {
    expect(hash32("abc")).toBe(hash32("abc"));
    expect(hash32("abc")).not.toBe(hash32("abd"));
  });

  it("localParts handles unknown zones", () => {
    expect(localParts(new Date("2026-10-30T12:00:00Z"), "Not/AZone").date).toBe("2026-10-30");
  });
});

describe("env", () => {
  const base = {
    DATABASE_URL: "postgres://x",
    SESSION_SECRET: "s".repeat(40),
    PACEO_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
  };
  it("parses with defaults", () => {
    const env = loadEnv(base);
    expect(env.PORT).toBe(3000);
    expect(env.JOBS_ENABLED).toBe(true);
    expect(env.INTERVALS_RATE_PER_SEC).toBe(5);
  });
  it("refuses bad or missing secrets", () => {
    expect(() => loadEnv({ ...base, PACEO_ENCRYPTION_KEY: "short" })).toThrow(/PACEO_ENCRYPTION_KEY/);
    expect(() => loadEnv({ ...base, SESSION_SECRET: undefined })).toThrow(/SESSION_SECRET/);
    expect(() => loadEnv({ ...base, NODE_ENV: "production" })).toThrow(/VAPID_PUBLIC_KEY/);
  });
});
