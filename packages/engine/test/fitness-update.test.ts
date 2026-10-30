import { describe, expect, it } from "vitest";
import {
  complianceBand,
  fitnessStepVdot,
  fitnessUpdate,
  generatePlan,
  matchActivities,
  performanceEvidence,
  snapRaceDistance,
  stepsBetween,
  tPacePctChange,
  vdotAfterSteps,
  vdotForVelocityFactor,
  type Activity,
  type FitnessState,
  type TrainingEvidence,
} from "../src/index.js";
import { personaC } from "./personas.js";
import { activityFor } from "./replan-fixtures.js";

const fit = (vdot: number, status: FitnessState["status"] = "race", history: FitnessState["history"] = []): FitnessState => ({ vdot, status, history });
const race = (id: string, date: string, distanceM: number, movingS: number, extra: Partial<Activity> = {}): Activity => ({ id, date, sport: "run", distanceM, movingS, isRace: true, ...extra });
const ev = (date: string, vdot: number, kind: TrainingEvidence["kind"] = "session_pace"): TrainingEvidence => ({ kind, date, vdot, source: `a-${date}` });

describe("§3.9 plan matching and compliance", () => {
  const plan = generatePlan(personaC);
  const wk5 = plan.weeks[4]!.workouts.filter((w) => w.sport === "run");
  const t = wk5.find((w) => w.type === "T")!;

  it("matches by date and sport; statuses completed / partial / missed / skipped / pending", () => {
    const [a, b, c, d] = wk5;
    const acts = [activityFor(a!), activityFor(b!, { volume: 0.6 })];
    const m = matchActivities(plan, acts, d!.date, [{ date: c!.date }]);
    const by = new Map(m.workouts.map((x) => [x.workoutId, x]));
    expect(by.get(a!.id)!.status).toBe("completed");
    expect(by.get(a!.id)!.band).toBe("green");
    expect(by.get(b!.id)!.status).toBe("partial");
    expect(by.get(b!.id)!.band).toBe("yellow");
    expect(by.get(c!.id)!.status).toBe("skipped");
    expect(by.get(d!.id)!.status).toBe("pending");
    const earlier = plan.weeks[3]!.workouts.find((w) => w.sport === "run")!;
    expect(by.get(earlier.id)!.status).toBe("missed");
  });

  it("TrainingPeaks bands", () => {
    expect(complianceBand(1)).toBe("green");
    expect(complianceBand(1.3)).toBe("yellow");
    expect(complianceBand(0.4)).toBe("orange");
    expect(complianceBand(undefined)).toBe("red");
  });

  it("laps 1:1 onto steps give per-step pace compliance (delta = (target − actual)/target)", () => {
    const m = matchActivities(plan, [activityFor(t, { workPace: 0.97 })], "2027-01-01");
    const steps = m.workouts.find((x) => x.workoutId === t.id)!.steps!;
    const work = steps.filter((s) => s.kind === "work");
    expect(work.length).toBeGreaterThan(0);
    for (const s of work) {
      expect(s.delta!).toBeCloseTo(0.03, 3);
      expect(s.result).toBe("fast");
    }
    const onPlan = matchActivities(plan, [activityFor(t)], "2027-01-01").workouts.find((x) => x.workoutId === t.id)!;
    expect(onPlan.steps!.filter((s) => s.kind === "work").every((s) => s.result === "on_target")).toBe(true);
  });
});

describe("§4.10 fitness step (1.2% of T pace)", () => {
  it("≈ +0.4 VDOT at 25, +0.5 at 34, +0.75 at 50, +0.9 at 60", () => {
    expect(fitnessStepVdot(25)).toBeCloseTo(0.4, 1);
    expect(fitnessStepVdot(34)).toBeCloseTo(0.52, 1);
    expect(fitnessStepVdot(50)).toBeCloseTo(0.75, 2);
    expect(fitnessStepVdot(60)).toBeCloseTo(0.9, 2);
    expect(tPacePctChange(50, 50 + fitnessStepVdot(50))).toBeCloseTo(1.2, 6);
    expect(stepsBetween(50, vdotAfterSteps(50, 2))).toBeCloseTo(2, 1);
    expect(stepsBetween(50, vdotAfterSteps(50, -1))).toBeCloseTo(-1, 2);
    expect(tPacePctChange(50, vdotForVelocityFactor(50, 0.973))).toBeCloseTo(-2.77, 1);
  });
});

describe("FIT-UPDATE: races and time trials", () => {
  const base = { today: "2026-12-14", level: "advanced" as const, training: [] };

  it("a faster race sets VDOT immediately (distance snapped to 21.0975 km)", () => {
    expect(snapRaceDistance(21300)).toBe(21097.5);
    const p = performanceEvidence(race("hm", "2026-12-13", 21300, 5300), "race", { currentVdot: 50 });
    const r = fitnessUpdate({ ...base, fitness: fit(50), performances: [p] });
    expect(r.fitness.vdot!).toBeGreaterThan(52);
    expect(r.fitness.status).toBe("race");
    expect(r.fitness.anchorM).toBe(21097.5);
    expect(r.applied).toHaveLength(1);
    expect(r.proposals).toHaveLength(0);
    // Idempotent: the same race is not applied twice.
    const again = fitnessUpdate({ ...base, fitness: r.fitness, performances: [p] });
    expect(again.applied).toHaveLength(0);
  });

  it("a race ≥ 2 steps slower is only a prompt; explained by illness or a hilly course → no prompt", () => {
    const slow = performanceEvidence(race("10k", "2026-12-13", 10000, 2700), "race", { currentVdot: 50 });
    const r = fitnessUpdate({ ...base, fitness: fit(50), performances: [slow] });
    expect(r.fitness.vdot).toBe(50);
    expect(r.proposals).toHaveLength(1);
    expect(r.proposals[0]!.kind).toBe("vdot_change");
    const sick = performanceEvidence(race("10k", "2026-12-13", 10000, 2700), "race", { currentVdot: 50, illnessWithin7d: true });
    expect(fitnessUpdate({ ...base, fitness: fit(50), performances: [sick] }).proposals).toHaveLength(0);
    const hilly = performanceEvidence(race("10k", "2026-12-13", 10000, 2700, { elevationGainM: 300 }), "race", { currentVdot: 50 });
    expect(fitnessUpdate({ ...base, fitness: fit(50), performances: [hilly] }).proposals).toHaveLength(0);
  });

  it("races above 20 °C WBGT are excluded; 10–20 °C results are heat-normalized", () => {
    const hot = performanceEvidence(race("5k", "2026-12-13", 5000, 1200, { wbgtC: 24 }), "race");
    expect(hot.excluded!).toMatch(/heat/);
    const warm = performanceEvidence(race("5k", "2026-12-13", 5000, 1200, { wbgtC: 16 }), "race", { currentVdot: 50 });
    expect(warm.timeS).toBeLessThan(1200);
  });

  it("a TT replaces an estimated VDOT even when lower; beginners ignore races (TT only)", () => {
    const tt = performanceEvidence({ id: "tt", date: "2026-12-13", sport: "run", distanceM: 3000, movingS: 1260, isRace: false, isTimeTrial: true }, "tt");
    const r = fitnessUpdate({ ...base, fitness: fit(30, "estimated"), performances: [tt] });
    expect(r.fitness.status).toBe("tt");
    expect(r.fitness.vdot!).toBeCloseTo(24.8, 1);
    const p = performanceEvidence(race("5k", "2026-12-13", 5000, 1500), "race");
    const b = fitnessUpdate({ ...base, level: "beginner", fitness: fit(25, "tt"), performances: [p] });
    expect(b.fitness.vdot).toBe(25);
  });
});

describe("FIT-UPDATE: training evidence → proposals only", () => {
  const base = { today: "2026-12-24", level: "advanced" as const, performances: [], raceDate: "2027-03-01" };
  const strong = [ev("2026-12-03", 51.9), ev("2026-12-10", 51.9), ev("2026-12-24", 51.9)];

  it("≥ 3 qualifying runs over ≥ 14 days, ≥ 1 step gap and R-PERF faster → +1 step proposal, never applied", () => {
    const r = fitnessUpdate({ ...base, fitness: fit(50), training: strong, perf: "faster" });
    expect(r.fitness.vdot).toBe(50);
    expect(r.proposals).toHaveLength(1);
    const p = r.proposals[0]!;
    if (p.kind !== "vdot_change") throw new Error("kind");
    expect(p.steps).toBe(1);
    expect(p.toVdot).toBeCloseTo(50.75, 2);
    expect(p.pacePct).toBeCloseTo(1.2, 1);
  });

  it("no raise with < 3 runs, < 14 days, mixed R-PERF, a recent change (freeze) or a CS that disagrees", () => {
    expect(fitnessUpdate({ ...base, fitness: fit(50), training: strong.slice(1), perf: "faster" }).proposals).toHaveLength(0);
    const tight = [ev("2026-12-18", 52), ev("2026-12-21", 52), ev("2026-12-24", 52)];
    expect(fitnessUpdate({ ...base, fitness: fit(50), training: tight, perf: "faster" }).proposals).toHaveLength(0);
    expect(fitnessUpdate({ ...base, fitness: fit(50), training: strong, perf: "mixed" }).proposals).toHaveLength(0);
    const recent = fit(50, "race", [{ date: "2026-12-20", fromVdot: 49.3, toVdot: 50, status: "race", rule: "R-PERF", source: "x", reason: "" }]);
    expect(fitnessUpdate({ ...base, fitness: recent, training: strong, perf: "faster" }).proposals).toHaveLength(0);
    expect(fitnessUpdate({ ...base, fitness: fit(50), training: strong, perf: "faster", csVdot: 47 }).proposals).toHaveLength(0);
  });

  it("decreases trigger more easily: R-PERF slower → −1 step proposal from 2 sessions", () => {
    const r = fitnessUpdate({ ...base, fitness: fit(50), training: [ev("2026-12-20", 49), ev("2026-12-24", 49)], perf: "slower" });
    expect(r.proposals).toHaveLength(1);
    const p = r.proposals[0]!;
    if (p.kind !== "vdot_change") throw new Error("kind");
    expect(p.steps).toBe(-1);
    expect(p.toVdot).toBeLessThan(50);
  });

  it("estimated VDOT and beginners: only a TT changes fitness", () => {
    expect(fitnessUpdate({ ...base, fitness: fit(50, "estimated"), training: strong, perf: "faster" }).proposals).toHaveLength(0);
    expect(fitnessUpdate({ ...base, level: "beginner", fitness: fit(50), training: strong, perf: "faster" }).proposals).toHaveLength(0);
  });

  it("final 6 weeks: never from HR data alone; HR evidence ignored for 7 days after a break", () => {
    const hr = strong.map((e) => ({ ...e, kind: "hr_pace" as const }));
    expect(fitnessUpdate({ ...base, raceDate: "2027-01-20", fitness: fit(50), training: hr, perf: "insufficient" }).proposals).toHaveLength(0);
    expect(fitnessUpdate({ ...base, fitness: fit(50), training: hr, perf: "insufficient" }).proposals.length).toBe(1);
    expect(fitnessUpdate({ ...base, fitness: fit(50), training: hr, perf: "insufficient", hrIgnoreUntil: "2026-12-30" }).proposals).toHaveLength(0);
  });
});
