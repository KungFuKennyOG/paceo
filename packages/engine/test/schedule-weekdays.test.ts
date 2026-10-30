/**
 * Specific run weekdays and per-day time limits (spec §2.3 "days available", "max minutes per
 * weekday"; §7.1 step 4 and fallbacks; §7.2 rows). Property tests over many random weekday sets
 * from fixed seeds, so every run is reproducible.
 */
import { describe, expect, it } from "vitest";
import {
  generatePlan,
  toDayNumber,
  WEEKDAYS,
  weekdayOf,
  weekdayTemplate,
  weekTemplate,
  type Plan,
  type PlanInput,
  type Weekday,
} from "../src/index.js";
import { personaA, personaA2, personaB, personaC, raceIn } from "./personas.js";
import {
  expectBasics,
  expectCrossTrainingRules,
  expectDanielsCaps,
  expectKeyBudget,
  expectLockedEventsListed,
  expectLongRunIsLongest,
  expectSchedule,
  expectStrengthRules,
  expectTargetTracking,
  expectV1,
  expectWeeklyGrowth,
  runWorkouts,
} from "./plan-checks.js";

/** mulberry32: a tiny deterministic PRNG, so the "random" sets are the same on every run. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T;

function randomWeekdays(r: () => number): Weekday[] {
  const n = 2 + Math.floor(r() * 6); // 2–7
  const pool = [...WEEKDAYS];
  const out: Weekday[] = [];
  while (out.length < n) out.push(pool.splice(Math.floor(r() * pool.length), 1)[0]!);
  return out.sort((a, b) => WEEKDAYS.indexOf(a) - WEEKDAYS.indexOf(b));
}

/** A random schedule on one of the personas: weekdays, long-run day among them, and sometimes day limits. */
function randomInput(seed: number): PlanInput {
  const r = rng(seed);
  const base = pick(r, [personaA, personaA2, personaB, personaC, { ...personaC, level: "novice" as const, monthsRunning: 10 }]);
  const days = randomWeekdays(r);
  const input: PlanInput = { ...base, runWeekdays: days, longRunDay: pick(r, days), raceDate: base.raceDate };
  if (r() < 0.5) {
    const caps: Partial<Record<Weekday, number>> = {};
    for (const d of days) if (r() < 0.4) caps[d] = pick(r, [20, 30, 45, 60, 75, 90, 120]);
    input.maxMinutesByDay = caps;
  }
  return input;
}

const runs = (p: Plan) => runWorkouts(p).filter((w) => w.type !== "RACE");
const capOf = (input: PlanInput, date: string) => input.maxMinutesByDay?.[weekdayOf(date)] ?? Infinity;

function expectWeekdayRules(p: Plan, input: PlanInput): void {
  const allowed = input.runWeekdays ? new Set([...input.runWeekdays, input.longRunDay]) : new Set(WEEKDAYS);
  for (const w of runs(p)) {
    expect(allowed.has(weekdayOf(w.date)), `${w.date} (${weekdayOf(w.date)}) is not a run day`).toBe(true);
    expect(w.planned.minutes, `${w.date} ${w.name}: over the ${weekdayOf(w.date)} limit`).toBeLessThanOrEqual(capOf(input, w.date) + 1e-6);
  }
  if (input.level === "beginner") {
    // §6.4 cap of 4 run days; §7.1 no back-to-back run days in the first 4 weeks.
    for (const wk of p.weeks) expect(new Set(wk.workouts.filter((w) => w.sport === "run" && w.type !== "RACE").map((w) => w.date)).size).toBeLessThanOrEqual(4);
    const early = new Set(p.weeks.slice(0, 4).flatMap((wk) => wk.workouts.filter((w) => w.sport === "run").map((w) => toDayNumber(w.date))));
    for (const d of early) expect(early.has(d + 1), `back-to-back beginner runs at day ${d}`).toBe(false);
  }
  // A long run held to its day's limit is reported (§7.1 fallback 3 / 6).
  const lrCapped = runs(p).filter((w) => w.type === "L" && w.rule_trace.includes("S:max_minutes"));
  if (lrCapped.length > 0) expect((p.summary.conflicts ?? []).some((c) => c.code === "S:max_minutes_long_run")).toBe(true);
}

function expectAllInvariants(p: Plan, input: PlanInput): void {
  expectBasics(p, input);
  expectSchedule(p);
  expectKeyBudget(p);
  expectV1(p, input);
  expectWeeklyGrowth(p);
  expectLongRunIsLongest(p);
  expectTargetTracking(p);
  expectDanielsCaps(p);
  expectCrossTrainingRules(p);
  expectStrengthRules(p);
  expectLockedEventsListed(p, input);
  expectWeekdayRules(p, input);
}

describe("weekday templates (§7.2 roles on any set of days, D)", () => {
  it("reproduces the §7.2 rows when the days match them", () => {
    const rows: Array<[number, Weekday[]]> = [
      [3, ["tue", "thu", "sun"]],
      [4, ["tue", "thu", "sat", "sun"]],
      [5, ["tue", "wed", "thu", "sat", "sun"]],
      [6, ["mon", "tue", "wed", "thu", "sat", "sun"]],
      [7, [...WEEKDAYS]],
    ];
    for (const [n, days] of rows) {
      for (const lrOffset of [0, 3, 6]) {
        expect(weekTemplate(n, { lrOffset, weekdays: { days, longRunDay: "sun" } })).toEqual(weekTemplate(n, { lrOffset }));
      }
    }
  });

  it("places roles by days after the long run: Q ≥ 48 h from the LR, never the day before it", () => {
    // Saturday LR on Mon/Wed/Fri/Sat: Q1 Mon (2 days after), Q2 (easy-LR weeks) Wed, E Fri.
    expect(weekdayTemplate({ days: ["mon", "wed", "fri", "sat"], longRunDay: "sat" }, 4)).toEqual([
      { offset: 1, role: "Q1" },
      { offset: 3, role: "Q2_IF_EASY_LR" },
      { offset: 5, role: "E" },
      { offset: 6, role: "L" },
    ]);
    // Only the days right around the LR: no quality slot at all (placement converts it to E + strides).
    expect(weekdayTemplate({ days: ["sat", "mon"], longRunDay: "sun" }, 3).map((s) => s.role)).toEqual(["E", "E", "L"]);
  });

  it("adds the long-run day, caps beginners at 4 days, and picks non-consecutive days for the first weeks and the ladder", () => {
    expect(weekdayTemplate({ days: ["tue", "thu"], longRunDay: "sun" }, 3).map((s) => s.role)).toEqual(["Q1", "E", "L"]);
    const four = weekdayTemplate({ days: [...WEEKDAYS], longRunDay: "sun" }, 4);
    expect(four.map((s) => s.offset)).toEqual([1, 3, 5, 6]); // the §7.2 4-day row
    const early = weekdayTemplate({ days: ["mon", "tue", "wed", "sun"], longRunDay: "sun" }, 4, { noConsecutiveDays: true });
    expect(early.map((s) => s.offset)).toEqual([2, 6]); // Wed + Sun: Mon and Tue touch Sun / Wed
    // The ladder uses the same days as the first post-ladder weeks (the §7.2 3-day row here).
    expect(weekdayTemplate({ days: [...WEEKDAYS], longRunDay: "sun" }, 3, { ladder: true }).map((s) => s.offset)).toEqual([1, 3, 6]);
  });
});

describe("runWeekdays in generatePlan", () => {
  const input: PlanInput = { ...personaC, runWeekdays: ["mon", "wed", "thu", "fri", "sat"], longRunDay: "sat" };
  const p = generatePlan(input);

  it("runs only on the chosen days, with the run-day count taken from them", () => {
    const used = new Set(runs(p).map((w) => weekdayOf(w.date)));
    expect([...used].every((d) => input.runWeekdays!.includes(d))).toBe(true);
    expect(used.size).toBe(5);
    expectAllInvariants(p, input);
  });

  it("matches the plain run-day count when the days are the §7.2 row", () => {
    const row: PlanInput = { ...personaC, runWeekdays: ["mon", "tue", "wed", "thu", "sat", "sun"] };
    expect(JSON.stringify(generatePlan(row).weeks)).toBe(JSON.stringify(generatePlan(personaC).weeks));
  });
});

describe("maxMinutesByDay (§7.1 step 4)", () => {
  it("shortens the long run to the day's limit (fallback 3) and reports it", () => {
    const input: PlanInput = { ...personaC, maxMinutesByDay: { sun: 90 } };
    const p = generatePlan(input);
    expectAllInvariants(p, input);
    const lrs = runs(p).filter((w) => w.type === "L");
    expect(Math.max(...lrs.map((w) => w.planned.minutes))).toBeLessThanOrEqual(90);
    expect(lrs.some((w) => w.rule_trace.includes("S:max_minutes"))).toBe(true);
    const c = p.summary.conflicts!.find((x) => x.code === "S:max_minutes_long_run")!;
    expect(c.weekday).toBe("sun");
    expect(c.suggestion).toMatch(/Sun/);
  });

  it("keeps quality off a day it doesn't fit: moved (fallback 1) or easy + strides (fallback 2), reported", () => {
    const input: PlanInput = { ...personaC, maxMinutesByDay: { tue: 30 } };
    const p = generatePlan(input);
    expectAllInvariants(p, input);
    const tue = runs(p).filter((w) => weekdayOf(w.date) === "tue");
    expect(tue.every((w) => w.planned.minutes <= 30)).toBe(true);
    // Only sessions that fit 30 min stay on Tuesday; the normal Tuesday Q1 doesn't.
    expect(tue.filter((w) => w.flags.key_session).length).toBeLessThan(generatePlan(personaC).weeks.length / 2);
    expect(p.summary.conflicts!.some((x) => x.code === "S:max_minutes_quality" && x.weekday === "tue")).toBe(true);
    // The week still gets its quality on another legal day where it can.
    expect(runs(p).filter((w) => w.flags.key_session && w.type !== "L").length).toBeGreaterThan(0);
  });

  it("caps easy days and reports volume that no longer fits", () => {
    const input: PlanInput = { ...personaB, maxMinutesByDay: { sat: 20, tue: 25 } };
    const p = generatePlan(input);
    expectAllInvariants(p, input);
    expect(p.summary.conflicts!.some((x) => x.code === "S:max_minutes_easy_volume")).toBe(true);
  });

  it("leaves plans without limits unchanged", () => {
    expect(JSON.stringify(generatePlan({ ...personaB, maxMinutesByDay: {} }))).toBe(JSON.stringify(generatePlan(personaB)));
  });
});

describe("properties over random weekday sets and day limits (fixed seeds)", () => {
  const SEEDS = Array.from({ length: 48 }, (_, i) => 1000 + i * 7919);
  it.each(SEEDS.map((s) => [s] as const))("seed %s: every hard constraint holds", (seed) => {
    const input = randomInput(seed);
    const p = generatePlan(input);
    if (p.weeks.length === 0) return; // feasibility block (e.g. a beginner HM): nothing to check
    expectAllInvariants(p, input);
  });

  it("is deterministic", () => {
    for (const seed of SEEDS.slice(0, 6)) {
      const input = randomInput(seed);
      expect(JSON.stringify(generatePlan(input))).toBe(JSON.stringify(generatePlan(randomInput(seed))));
    }
  });

  it("covers every set size and long-run weekday across the seeds", () => {
    const inputs = SEEDS.map(randomInput);
    expect(new Set(inputs.map((i) => i.runWeekdays!.length)).size).toBe(6);
    expect(new Set(inputs.map((i) => i.longRunDay)).size).toBe(7);
    expect(raceIn(10)).toBe(personaA.raceDate);
  });
});
