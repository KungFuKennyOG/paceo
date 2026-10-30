import { describe, expect, it } from "vitest";
import {
  addDays,
  generalFitnessAsRaceInput,
  generalFitnessKinds,
  generatePlan,
  isGeneralFitness,
  toDayNumber,
  weeklyLoad,
  type GeneralFitnessInput,
  type Plan,
  type PlanInput,
} from "../src/index.js";
import { personaA2, personaB, personaC, TODAY } from "./personas.js";
import {
  allWorkouts,
  expectCrossTrainingRules,
  expectKeyBudget,
  expectLockedEventsListed,
  expectSchedule,
  expectStrengthRules,
  expectV1,
  expectWeeklyGrowth,
  runWorkouts,
} from "./plan-checks.js";

/** Drop the race fields from a persona and attach a general-fitness goal. */
function gf(base: PlanInput, goal: Omit<GeneralFitnessInput["goal"], "type"> = {}, over: Partial<GeneralFitnessInput> = {}): GeneralFitnessInput {
  const { raceDate: _r, goal: _g, ...rest } = base;
  return { ...rest, goal: { type: "general_fitness", ...goal }, ...over };
}

function expectGeneralFitnessInvariants(plan: Plan, input: GeneralFitnessInput): void {
  expectV1(plan, generalFitnessAsRaceInput(input));
  expectSchedule(plan);
  expectWeeklyGrowth(plan);
  expectStrengthRules(plan);
  expectCrossTrainingRules(plan);
  expectKeyBudget(plan);
  expectLockedEventsListed(plan, input);
  expect(plan.summary.mode).toBe("general_fitness");
  expect(plan.summary.taperWeeks).toBe(0);
  for (const w of allWorkouts(plan)) {
    expect(w.type, w.id).not.toBe("RACE");
    expect(w.date >= input.today && w.date <= plan.summary.endDate!, w.id).toBe(true);
    expect(w.rule_trace.length).toBeGreaterThan(0);
  }
  for (const wk of plan.weeks) expect(wk.isTaper).toBe(false);
}

describe("general-fitness mode (spec §6.1)", () => {
  it("is told apart from race inputs; race inputs keep their shape", () => {
    expect(isGeneralFitness(personaB)).toBe(false);
    expect(isGeneralFitness(gf(personaB))).toBe(true);
  });

  it("lays out rolling blocks with a TT every 6–8 weeks in a cutback slot", () => {
    expect(generalFitnessKinds(12, 4, false).join(",")).toBe(
      "build,build,build,cutback,build,build,build,tt,build,build,build,cutback",
    );
    expect(generalFitnessKinds(9, 3, true).join(",")).toBe("build,build,tt,build,build,cutback,build,build,tt");
  });

  it("generates 12 weeks from today by default: 3+1 blocks, no race, no taper", () => {
    const input = gf(personaC);
    const plan = generatePlan(input);
    expect(plan.weeks).toHaveLength(12);
    expect(plan.summary.startDate).toBe(TODAY);
    expect(plan.summary.endDate).toBe(addDays(TODAY, 83));
    expect(plan.summary.cutbackEvery).toBe(4);
    expect(plan.weeks.filter((w) => w.isCutback).map((w) => w.index)).toEqual([4, 8, 12]);
    const tts = plan.weeks.filter((w) => w.workouts.some((x) => x.type === "TT")).map((w) => w.index);
    expect(tts).toEqual([8]);
    expectGeneralFitnessInvariants(plan, input);
  });

  it("uses 2+1 blocks under a C1 risk flag and starts mid-week when today is mid-week", () => {
    const input = gf(personaB, { weeks: 9 }, { today: "2026-11-04" });
    const plan = generatePlan(input);
    expect(plan.weeks).toHaveLength(9);
    expect(plan.summary.cutbackEvery).toBe(3);
    expect(plan.weeks[0]!.startDate).toBe("2026-11-04");
    expect(plan.weeks.filter((w) => w.isCutback).map((w) => w.index)).toEqual([3, 6, 9]);
    expectGeneralFitnessInvariants(plan, input);
  });

  it("builds toward a weekly time target and holds there", () => {
    const input = gf(personaC, { targetWeeklyMinutes: 420, weeks: 16 });
    const plan = generatePlan(input);
    const build = plan.weeks.filter((w) => !w.isCutback);
    const mins = build.map((w) => weeklyLoad(w).runningMinutes);
    expect(Math.max(...mins)).toBeLessThanOrEqual(420 * 1.1);
    expect(mins.at(-1)!).toBeGreaterThan(mins[0]!);
    expectGeneralFitnessInvariants(plan, input);
  });

  it("cycles FI → EQ content: no quality in FI blocks, quality in EQ blocks", () => {
    const plan = generatePlan(gf(personaC));
    for (const wk of plan.weeks) {
      const q = wk.workouts.filter((w) => ["T", "I", "R", "H", "M"].includes(w.type)).length;
      if (wk.phase === "FI") expect(q).toBe(0);
    }
    expect(plan.weeks.some((w) => w.phase === "EQ" && w.workouts.some((x) => x.type === "R" || x.type === "T"))).toBe(true);
  });

  it("uses the 2-day general-fitness template: easy + long", () => {
    const input = gf(personaC, {}, { runDays: 2, currentWeeklyKm: 20, longestRun30d: { km: 12, minutes: 65 } });
    const plan = generatePlan(input);
    for (const wk of plan.weeks.filter((w) => !w.workouts.some((x) => x.type === "TT"))) {
      const runs = wk.workouts.filter((w) => w.sport === "run");
      expect(runs).toHaveLength(2);
      expect(runs.some((w) => w.type === "L")).toBe(true);
      expect(runs.every((w) => w.type === "L" || w.type === "E" || w.type === "S")).toBe(true);
    }
    expectGeneralFitnessInvariants(plan, input);
  });

  it("strength follows the off-season row: up to 3 sessions, 3 × 8–10 → 3 × 6", () => {
    const input = gf(personaC, { weeks: 12 }, { runDays: 4, strength: { ...personaC.strength!, mode: "running", sessionsPerWeek: 3 } });
    const plan = generatePlan(input);
    const s = plan.weeks.flatMap((w) => w.workouts.filter((x) => x.sport === "strength"));
    expect(s.every((w) => w.rule_trace.includes("§9.4:general"))).toBe(true);
    const main = (i: number) => s[i]!.exercises!.find((e) => e.slot === "SQUAT" || e.slot === "HINGE")!.reps;
    expect(main(0)).toBe("8–10");
    expect(main(s.length - 1)).toBe("6");
    expectGeneralFitnessInvariants(plan, input);
  });

  it("starts with the run/walk ladder for a beginner who can't run 20 min", () => {
    const input = gf(personaA2, { weeks: 10 });
    const plan = generatePlan(input);
    expect(plan.summary.ladderWeeks).toBe(3);
    expect(runWorkouts(plan).filter((w) => toDayNumber(w.date) < toDayNumber(plan.weeks[3]!.startDate)).every((w) => w.type === "RW")).toBe(true);
    expectGeneralFitnessInvariants(plan, input);
  });

  it("is deterministic", () => {
    const input = gf(personaB, { targetWeeklyKm: 48 });
    expect(generatePlan(structuredClone(input))).toEqual(generatePlan(input));
  });
});
