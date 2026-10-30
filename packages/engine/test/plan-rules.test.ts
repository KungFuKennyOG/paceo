import { describe, expect, it } from "vitest";
import {
  addDays,
  buildWeekTargets,
  cutbackPolicy,
  danielsPhaseSplit,
  I_REP_WINDOW_S,
  layoutBuildWeeks,
  peakWeeklyKm,
  pickDistanceRep,
  planCalendar,
  planPaces,
  planPhases,
  qualityAllowance,
  R_REP_MAX_S,
  spreadEasy,
  taperMultipliers,
  taperWeeks,
  toDayNumber,
  weekTemplate,
  weekdayOf,
  type Phase,
} from "../src/index.js";

describe("dates (UTC, no local timezone)", () => {
  it("adds days across month, leap-day and DST boundaries", () => {
    expect(addDays("2026-02-28", 1)).toBe("2026-03-01");
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(addDays("2026-03-28", 2)).toBe("2026-03-30");
    expect(weekdayOf("2026-11-02")).toBe("mon");
    expect(weekdayOf("2027-03-07")).toBe("sun");
    expect(() => toDayNumber("2026-02-30")).toThrow(RangeError);
  });

  it("counts plan weeks back from race day", () => {
    const cal = planCalendar("2026-11-02", "2027-03-07", "sun");
    expect(cal).toMatchObject({ weeks: 18, leadInDays: 0, lrOffset: 6, raceOffset: 6 });
    expect(planCalendar("2026-11-04", "2027-03-07", "sun")).toMatchObject({ weeks: 17, leadInDays: 5 });
    // Saturday race with a Sunday long run: weeks run Sun–Sat, the LR is offset 0.
    expect(planCalendar("2026-11-02", "2027-03-06", "sun")).toMatchObject({ weeks: 17, leadInDays: 6, lrOffset: 0 });
  });
});

describe("phase lengths (spec §6.3)", () => {
  const TABLE: Record<number, [number, number, number, number]> = {
    4: [3, 0, 0, 1],
    6: [3, 0, 0, 3],
    8: [3, 0, 2, 3],
    10: [3, 1, 3, 3],
    12: [3, 3, 3, 3],
    14: [4, 3, 4, 3],
    16: [4, 3, 6, 3],
    18: [4, 4, 6, 4],
    20: [4, 6, 6, 4],
    22: [5, 6, 6, 5],
    24: [6, 6, 6, 6],
  };

  it.each(Object.entries(TABLE))("reproduces the Daniels row for %s weeks", (weeks, [FI, EQ, TQ, FQ]) => {
    expect(danielsPhaseSplit(Number(weeks))).toEqual({ FI, EQ, TQ, FQ });
  });

  it("fills odd week counts in the same order, between the neighbouring rows", () => {
    expect(danielsPhaseSplit(7)).toEqual({ FI: 3, EQ: 0, TQ: 1, FQ: 3 });
    expect(danielsPhaseSplit(13)).toEqual({ FI: 4, EQ: 3, TQ: 3, FQ: 3 });
    for (let w = 5; w <= 23; w += 2) {
      const s = danielsPhaseSplit(w);
      const lo = danielsPhaseSplit(w - 1);
      const hi = danielsPhaseSplit(w + 1);
      expect(s.FI + s.EQ + s.TQ + s.FQ).toBe(w);
      for (const k of ["FI", "EQ", "TQ", "FQ"] as const) {
        expect(s[k]).toBeGreaterThanOrEqual(lo[k]);
        expect(s[k]).toBeLessThanOrEqual(hi[k]);
      }
    }
  });

  it("gives the persona splits", () => {
    expect(planPhases(10, "beginner", 3).split).toEqual({ FI: 3, EQ: 1, TQ: 3, FQ: 3 }); // A
    expect(planPhases(18, "intermediate").split).toEqual({ FI: 4, EQ: 4, TQ: 6, FQ: 4 }); // B
    expect(planPhases(14, "advanced").split).toEqual({ FI: 4, EQ: 3, TQ: 4, FQ: 3 }); // C
  });

  it("P1: extends FI for beginners and novices, and prepends base weeks beyond 24", () => {
    expect(planPhases(18, "novice").split).toEqual({ FI: 5, EQ: 3, TQ: 6, FQ: 4 });
    expect(planPhases(20, "beginner").split).toEqual({ FI: 6, EQ: 4, TQ: 6, FQ: 4 });
    const long = planPhases(28, "advanced");
    expect(long.base).toBe(4);
    expect(long.byWeek.slice(0, 5)).toEqual(["BASE", "BASE", "BASE", "BASE", "FI"]);
    expect(long.split).toEqual({ FI: 6, EQ: 6, TQ: 6, FQ: 6 });
  });
});

describe("taper (spec §6.8)", () => {
  it("T1 lengths", () => {
    expect(taperWeeks("marathon", "intermediate", 55)).toBe(3);
    expect(taperWeeks("marathon", "intermediate", 45)).toBe(2);
    expect(taperWeeks("half", "advanced", 80)).toBe(2);
    expect(taperWeeks("10k", "advanced", 80)).toBe(1);
    expect(taperWeeks("5k", "beginner", 10)).toBe(1);
  });

  it("T2 multipliers are range midpoints and strictly decreasing", () => {
    expect(taperMultipliers(3)).toEqual([0.825, 0.675, 0.45]);
    expect(taperMultipliers(2)).toEqual([0.725, 0.5]);
    expect(taperMultipliers(1)).toEqual([0.6]);
    for (const n of [2, 3]) {
      const m = taperMultipliers(n);
      for (let i = 1; i < m.length; i++) expect(m[i]!).toBeLessThan(m[i - 1]!);
    }
  });
});

describe("volume and cutbacks (spec §6.5, §6.7)", () => {
  const base = { level: "intermediate", injuryFlag: false, heavyCrossTraining: false } as const;

  it("C1: 3:1 by default, 2:1 on any risk flag, never 4:1 by default", () => {
    expect(cutbackPolicy(base).every).toBe(4);
    expect(cutbackPolicy({ ...base, age: 39 }).every).toBe(4);
    expect(cutbackPolicy({ ...base, age: 40 }).every).toBe(3);
    expect(cutbackPolicy({ ...base, injuryFlag: true }).every).toBe(3);
    expect(cutbackPolicy({ ...base, heavyCrossTraining: true }).every).toBe(3);
    expect(cutbackPolicy({ ...base, level: "novice" }).every).toBe(3);
    expect(cutbackPolicy({ ...base, level: "beginner" }).every).toBe(3);
    expect(cutbackPolicy({ ...base, level: "advanced" }).every).toBe(4);
  });

  it("C2: no cutback in the week before the taper", () => {
    const kinds = layoutBuildWeeks(12, 4, Array<Phase>(12).fill("EQ"));
    expect(kinds[11]).not.toBe("cutback");
    expect(kinds.filter((k) => k === "cutback").length).toBeGreaterThanOrEqual(2);
  });

  it("cutback −25%, then resume at the pre-cutback level (capped by V2's 30%)", () => {
    const t = buildWeekTargets(40, 100, ["build", "build", "build", "cutback", "build", "build"]);
    expect(t.map((x) => Math.round(x * 10) / 10)).toEqual([40, 43.2, 46.7, 35, 44.6, 50.4]);
  });

  it("V3: peak ≤ start + Δmax and ≤ the level ceiling", () => {
    expect(peakWeeklyKm("intermediate", "marathon", 42)).toBeCloseTo(63, 6); // 1.5 × 42
    expect(peakWeeklyKm("novice", "10k", 20)).toBeCloseTo(30, 6);
    expect(peakWeeklyKm("advanced", "half", 62)).toBeCloseTo(92, 6); // start + 30
  });
});

describe("quality count I2 (spec §6.4)", () => {
  it("matches the level × run-days matrix", () => {
    expect(qualityAllowance("beginner", 3, 2).base).toBe(0);
    expect(qualityAllowance("beginner", 4, 2).base).toBe(1);
    expect(qualityAllowance("novice", 4, 8).base).toBe(1);
    expect(qualityAllowance("novice", 6, 5).base).toBe(1);
    expect(qualityAllowance("novice", 6, 8).base).toBe(2);
    expect(qualityAllowance("intermediate", 4, 24)).toMatchObject({ base: 1, extraIfEasyLR: 1 });
    expect(qualityAllowance("intermediate", 6, 24).base).toBe(2);
    expect(qualityAllowance("advanced", 4, 60)).toMatchObject({ base: 2, qualityLR: "never" });
    expect(qualityAllowance("advanced", 6, 60).base).toBe(2);
  });
});

describe("rep-length rule (spec §6.6)", () => {
  const pA = planPaces({ vdot: 24.8, vdotStatus: "tt", goal: { distance: "5k" }, longestRun30d: { km: 5, minutes: 45 } });
  const pC = planPaces({ vdot: 50, vdotStatus: "race", goal: { distance: "half" }, longestRun30d: { km: 18, minutes: 95 } });
  const I_REPS = [1600, 1200, 1000, 800, 600, 400];

  it("I: A gets 600 m, C gets 1,200 m", () => {
    expect(pickDistanceRep(I_REPS, pA.I, I_REP_WINDOW_S)).toBe(600);
    expect(pickDistanceRep(I_REPS, pC.I, I_REP_WINDOW_S)).toBe(1200);
  });

  it("R: A gets 200–300 m, C gets 400 m", () => {
    expect([200, 300]).toContain(pickDistanceRep([400, 300, 200], pA.R, { min: 0, max: R_REP_MAX_S }));
    expect(pickDistanceRep([400, 300, 200], pC.R, { min: 0, max: R_REP_MAX_S })).toBe(400);
  });
});

describe("scheduler (spec §7)", () => {
  it("rotates the Sunday template to the long-run day", () => {
    const sun = weekTemplate(5);
    expect(sun.map((s) => `${s.offset}${s.role}`)).toEqual(["1Q1", "2E", "3Q2", "5E", "6L"]);
    const wed = weekTemplate(5, { lrOffset: 2 });
    expect(wed.find((s) => s.role === "L")!.offset).toBe(2);
    expect(wed.find((s) => s.role === "Q1")!.offset).toBe(4);
  });

  it("S3: spreads easy volume within bounds and reports what doesn't fit", () => {
    const slots = weekTemplate(6).filter((s) => s.role !== "L" && !s.role.startsWith("Q"));
    const ok = spreadEasy(24, slots, 3, 12);
    expect(ok.km.reduce((a, b) => a + b, 0)).toBeCloseTo(24, 6);
    expect(ok.unplacedKm).toBeCloseTo(0, 6);
    const full = spreadEasy(60, slots, 3, 12);
    expect(Math.max(...full.km)).toBeLessThanOrEqual(12);
    expect(full.unplacedKm).toBeGreaterThan(0);
    const thin = spreadEasy(5, slots, 3, 12);
    expect(thin.km.filter((k) => k > 0).every((k) => k >= 3)).toBe(true);
  });
});
