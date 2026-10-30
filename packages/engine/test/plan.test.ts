import { describe, expect, it } from "vitest";
import {
  addDays,
  checkFeasibility,
  generatePlan,
  longRunCaps,
  planPaces,
  PlannedWorkoutSchema,
  toDayNumber,
  type Plan,
  type PlanInput,
} from "../src/index.js";
import { hms, personaA, personaA2, personaB, personaC, raceIn } from "./personas.js";
import {
  allWorkouts,
  expectBasics,
  expectDanielsCaps,
  expectLongRunIsLongest,
  expectNoDetraining,
  expectSchedule,
  expectTargetTracking,
  expectV1,
  expectWeeklyGrowth,
  isQuality,
  peakLongRunWeeksOut,
} from "./plan-checks.js";

/** Every invariant that holds for every plan. */
function expectAllInvariants(plan: Plan, input: PlanInput): void {
  expectV1(plan, input);
  expectSchedule(plan);
  expectWeeklyGrowth(plan);
  expectBasics(plan, input);
  expectDanielsCaps(plan);
  expectLongRunIsLongest(plan);
  expectTargetTracking(plan);
  expectNoDetraining(plan, input);
}

const toDays = (p: Plan, weeks: number) => p.weeks.slice(0, weeks).flatMap((w) => w.workouts.map((x) => toDayNumber(x.date)));

const isQualityLR = (p: Plan["weeks"][number]) => {
  const lr = p.workouts.find((x) => x.type === "L");
  return lr !== undefined && !lr.rule_trace.includes("L3:easy");
};

describe("persona B: intermediate marathon, 18 weeks (spec §4.3, §6)", () => {
  const plan = generatePlan(personaB);

  it("is feasible, with goal Δ ≈ +1.48 VDOT", () => {
    expect(plan.feasibility.status).toBe("ok");
    expect(plan.feasibility.goalVdotDelta).toBeCloseTo(1.48, 1);
    expect(plan.summary.weeks).toBe(18);
    expect(plan.summary.phaseSplit).toEqual({ BASE: 0, FI: 4, EQ: 4, TQ: 6, FQ: 4 });
  });

  it("uses 2:1 cutbacks only because of a risk flag (heavy cross-training)", () => {
    expect(plan.summary.cutbackEvery).toBe(3);
    expect(generatePlan({ ...personaB, heavyCrossTraining: false }).summary.cutbackEvery).toBe(4);
    const cuts = plan.weeks.filter((w) => w.isCutback).map((w) => w.index);
    for (let i = 1; i < cuts.length; i++) expect(cuts[i]! - cuts[i - 1]!).toBeGreaterThanOrEqual(3);
    expect(plan.weeks[14]!.isCutback).toBe(false); // the week before the taper
  });

  it("tapers to ≈ 0.825 / 0.675 / 0.45 of the peak week", () => {
    const peak = Math.max(...plan.weeks.filter((w) => !w.isTaper).map((w) => w.targetKm));
    const taper = plan.weeks.filter((w) => w.isTaper);
    expect(taper).toHaveLength(3);
    [0.825, 0.675, 0.45].forEach((m, i) => {
      expect(taper[i]!.targetKm / peak).toBeCloseTo(m, 2);
      expect(Math.abs(taper[i]!.plannedKm / peak - m)).toBeLessThan(0.05);
    });
  });

  it("peaks the long run 3–5 weeks out and never past the 150-min cap at LR pace", () => {
    const caps = longRunCaps("intermediate", "marathon", "daniels", planPaces(personaB).LR);
    expect(caps.timeCapMin).toBe(150);
    const out = peakLongRunWeeksOut(plan);
    expect(out).toBeGreaterThanOrEqual(3);
    expect(out).toBeLessThanOrEqual(5);
    for (const lr of allWorkouts(plan).filter((w) => w.type === "L")) {
      expect(lr.planned.run_m / 1000).toBeLessThanOrEqual(caps.timeCapKm + 1e-6);
      expect(lr.planned.minutes).toBeLessThanOrEqual(150);
    }
  });

  it("I2: 1 quality + LR, a 2nd quality only in easy-LR weeks; none in FI", () => {
    for (const wk of plan.weeks) {
      const q = wk.workouts.filter(isQuality).length;
      expect(q).toBeLessThanOrEqual(isQualityLR(wk) ? 1 : 2);
      if (wk.phase === "FI") expect(q).toBe(0);
    }
    expect(plan.weeks.some((w) => w.workouts.filter(isQuality).length === 2)).toBe(true);
  });

  it("holds every invariant", () => {
    expectAllInvariants(plan, personaB);
  });

  it("produces workouts that satisfy the DSL schema", () => {
    for (const w of allWorkouts(plan)) expect(() => PlannedWorkoutSchema.parse(w)).not.toThrow();
  });
});

describe("persona C: advanced half marathon, 14 weeks", () => {
  const plan = generatePlan(personaC);

  it("is feasible with 3:1 cutbacks and a 2-week taper", () => {
    expect(plan.feasibility.status).toBe("ok");
    expect(plan.feasibility.goalVdotDelta).toBeCloseTo(0.99, 1);
    expect(plan.summary.phaseSplit).toEqual({ BASE: 0, FI: 4, EQ: 3, TQ: 4, FQ: 3 });
    expect(plan.summary.cutbackEvery).toBe(4);
    expect(plan.summary.taperWeeks).toBe(2);
  });

  it("runs 2 Q + LR in every normal quality week and caps the LR at 22 km", () => {
    for (const wk of plan.weeks) {
      if (wk.phase !== "FI" && !wk.isCutback && !wk.isTaper) expect(wk.workouts.filter(isQuality)).toHaveLength(2);
      for (const lr of wk.workouts.filter((x) => x.type === "L")) expect(lr.planned.run_m).toBeLessThanOrEqual(22000);
    }
    expect(plan.summary.peakLongRunKm).toBe(22);
  });

  it("uses 1,200 m I reps with pace targets", () => {
    const i = allWorkouts(plan).find((w) => w.type === "I")!;
    expect(i.name).toMatch(/1200 m/);
    expect(i.prescription_mode).toBe("pace");
  });

  it("holds every invariant", () => {
    expectAllInvariants(plan, personaC);
  });
});

describe("persona A: beginner who can run 20 min → no ladder, time-based running + TT", () => {
  const plan = generatePlan(personaA);

  it("skips the ladder and runs a 3K time trial in week 2", () => {
    expect(plan.feasibility.status).toBe("ok");
    expect(plan.summary.ladderWeeks).toBe(0);
    expect(plan.summary.phaseSplit).toEqual({ BASE: 0, FI: 3, EQ: 1, TQ: 3, FQ: 3 });
    expect(allWorkouts(plan).some((w) => w.type === "RW")).toBe(false);
    expect(plan.weeks[1]!.workouts.filter((w) => w.type === "TT")).toHaveLength(1);
  });

  it("starts from entry volume and the entry long run, never detraining", () => {
    expect(plan.weeks[0]!.plannedKm).toBeGreaterThanOrEqual(0.9 * personaA.currentWeeklyKm);
    const lr1 = plan.weeks[0]!.workouts.find((w) => w.type === "L")!;
    expect(lr1.planned.run_m).toBeGreaterThanOrEqual(personaA.longestRun30d.km * 1000);
    expect(Math.max(...plan.weeks.map((w) => w.plannedKm))).toBeGreaterThan(personaA.currentWeeklyKm);
  });

  it("keeps long runs time-based under the 60-min beginner 5K cap", () => {
    for (const lr of allWorkouts(plan).filter((w) => w.type === "L")) {
      expect(lr.planned.minutes).toBeLessThanOrEqual(60);
      expect(lr.prescription_mode).toBe("time_rpe");
      const first = lr.steps[0]!;
      expect(first.kind !== "repeat" && first.duration.type === "time").toBe(true);
    }
  });

  it("keeps rest days between runs in weeks 1–4 and has no quality besides the TT", () => {
    const days = toDays(plan, 4);
    for (let i = 1; i < days.length; i++) expect(days[i]! - days[i - 1]!).toBeGreaterThanOrEqual(2);
    for (const w of allWorkouts(plan)) expect(isQuality(w) && w.type !== "TT").toBe(false);
  });

  it("prescribes by time and RPE while VDOT is unknown", () => {
    const runs = allWorkouts(plan).filter((w) => w.type !== "RACE");
    expect(runs.every((w) => w.prescription_mode === "time_rpe")).toBe(true);
  });

  it("holds every invariant", () => {
    expectAllInvariants(plan, personaA);
  });
});

describe("persona A2: beginner who can't run 20 min → run/walk ladder first", () => {
  const plan = generatePlan(personaA2);

  it("starts with ladder weeks from stage 6 to graduation, then a 3K time trial", () => {
    expect(plan.feasibility.status).toBe("ok");
    expect(plan.summary.ladderWeeks).toBe(3);
    expect(plan.summary.phaseSplit).toEqual({ BASE: 0, FI: 3, EQ: 1, TQ: 3, FQ: 3 });
    for (const wk of plan.weeks.slice(0, 3)) {
      expect(wk.isLadder).toBe(true);
      expect(wk.isCutback).toBe(false); // no cutbacks inside the ladder
      expect(wk.workouts).toHaveLength(3);
      expect(wk.workouts.every((w) => w.type === "RW" && w.prescription_mode === "run_walk")).toBe(true);
    }
    expect(plan.weeks[0]!.workouts[0]!.name).toMatch(/stage 6/);
    expect(plan.weeks[2]!.workouts[0]!.name).toMatch(/stage 8/); // graduation: 20 min continuous
    expect(plan.weeks[3]!.workouts.filter((w) => w.type === "TT")).toHaveLength(1);
  });

  it("resumes at the entry volume after the ladder", () => {
    for (const wk of plan.weeks.slice(3, -1)) expect(wk.plannedKm).toBeGreaterThanOrEqual(0.9 * personaA2.currentWeeklyKm);
  });

  it("keeps rest days between runs in weeks 1–4", () => {
    const days = toDays(plan, 4);
    for (let i = 1; i < days.length; i++) expect(days[i]! - days[i - 1]!).toBeGreaterThanOrEqual(2);
  });

  it("holds every invariant", () => {
    expectAllInvariants(plan, personaA2);
  });
});

describe("feasibility (spec §6.2)", () => {
  it("blocks a marathon in 8 weeks from 10 km/week and offers a later date that passes", () => {
    const input: PlanInput = {
      ...personaB,
      goal: { distance: "marathon" },
      raceDate: raceIn(8),
      currentWeeklyKm: 10,
      longestRun30d: { km: 6, minutes: 45 },
    };
    const f = checkFeasibility(input);
    expect(f.status).toBe("block");
    expect(f.reasons.map((r) => r.code)).toContain("min_weeks");
    const later = f.alternatives.find((a) => a.kind === "later_date");
    expect(later?.raceDate! > input.raceDate).toBe(true);
    expect(f.alternatives[0]!.rank).toBe(1);
    const retry = checkFeasibility({ ...input, raceDate: later!.raceDate! });
    expect(retry.reasons.some((r) => r.status === "block")).toBe(false);
  });

  it("warns that persona B's 4:10 goal is aggressive (Δ ≈ +2.35)", () => {
    const f = checkFeasibility({ ...personaB, goal: { distance: "marathon", timeS: hms(4, 10, 0) } });
    expect(f.status).toBe("warn");
    expect(f.reasons.map((r) => r.code)).toContain("goal_aggressive");
    expect(f.goalVdotDelta).toBeCloseTo(2.35, 1);
    expect(f.alternatives.map((a) => a.kind)).toContain("slower_goal");
  });

  it("blocks a beginner marathon and defaults an unrealistic goal to current + 1 VDOT", () => {
    expect(checkFeasibility({ ...personaB, level: "beginner" }).status).toBe("block");
    const p = generatePlan({ ...personaB, goal: { distance: "marathon", timeS: hms(3, 45, 0) } });
    expect(p.feasibility.reasons.map((r) => r.code)).toContain("goal_unrealistic");
    expect(p.summary.notes.some((n) => n.includes("goal defaulted"))).toBe(true);
  });

  it("generates no weeks when the race is too close to plan", () => {
    expect(generatePlan({ ...personaB, raceDate: raceIn(1) }).weeks).toHaveLength(0);
  });
});

describe("properties across many generated plans", () => {
  const variants: PlanInput[] = [];
  for (const base of [personaB, personaC]) {
    for (const runDays of [3, 4, 5, 6, 7]) {
      for (const longRunDay of ["sun", "sat", "wed"] as const) {
        for (const weeks of [12, 16, 20, 26]) variants.push({ ...base, runDays, longRunDay, raceDate: raceIn(weeks) });
      }
    }
  }
  for (const distance of ["5k", "10k", "half"] as const) {
    for (const runDays of [3, 4, 5]) {
      variants.push({
        ...personaB,
        level: "novice",
        monthsRunning: 8,
        goal: { distance },
        runDays,
        raceDate: raceIn(14),
        vdotStatus: "estimated",
        currentWeeklyKm: 22,
        longestRun30d: { km: 8, minutes: 55 },
      });
    }
  }
  for (const runDays of [3, 4]) {
    for (const weeks of [9, 12]) {
      variants.push({ ...personaA2, runDays, raceDate: raceIn(weeks), ladderEntryStage: 1 });
      variants.push({ ...personaA, runDays, raceDate: raceIn(weeks) });
      variants.push({
        ...personaA,
        runDays,
        raceDate: raceIn(weeks),
        canRun20MinContinuous: true,
        goal: { distance: "10k" },
        currentWeeklyKm: 14,
        longestRun30d: { km: 5, minutes: 40 },
      });
    }
  }
  variants.push({ ...personaC, today: "2026-11-04" });
  variants.push({ ...personaB, raceDate: addDays(raceIn(18), -1) });
  variants.push({ ...personaC, goal: { distance: "10k", timeS: hms(0, 40, 30) }, raceDate: raceIn(10) });
  variants.push({ ...personaC, goal: { distance: "marathon" }, longRunMode: "pfitz", raceDate: raceIn(20), age: 45 });

  const label = (v: PlanInput) => `${v.level} ${v.goal.distance} ${v.runDays}d LR ${v.longRunDay} race ${v.raceDate}`;

  const rows = variants.map((v): [string, PlanInput] => [label(v), v]);
  it.each(rows)("%s", (_name, input) => {
    const plan = generatePlan(input);
    expect(plan.weeks.length).toBeGreaterThan(0);
    expectAllInvariants(plan, input);
    expect(generatePlan(structuredClone(input))).toEqual(plan); // deterministic
    const lastBuild = plan.weeks.filter((w) => !w.isTaper).at(-1)!;
    expect(lastBuild.isCutback).toBe(false); // C2
    if (plan.summary.ladderWeeks === 0 && plan.summary.peakLongRunKm > input.longestRun30d.km) {
      const out = peakLongRunWeeksOut(plan);
      expect(out).toBeGreaterThanOrEqual(3);
      expect(out).toBeLessThanOrEqual(5);
    }
  });
});
