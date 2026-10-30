/**
 * HR targets (spec §3.7 single target per step, §3.8 %HRmax plus resolved bpm, §4.6 HRmax policy,
 * §6.9 beginner HR cap).
 */
import { describe, expect, it } from "vitest";
import {
  flattenSteps,
  generatePlan,
  planPaces,
  PlannedWorkoutSchema,
  replan,
  resolveHrMax,
  stepsToIntervalsText,
  type Plan,
  type PlanInput,
  type PlannedWorkout,
  type SimpleStep,
  type Target,
} from "../src/index.js";
import { personaA, personaA2, personaB, personaC } from "./personas.js";
import { expectBasics, expectSchedule, expectTargetTracking, expectV1, runWorkouts } from "./plan-checks.js";
import { preHistory, ranAsPlanned, stateOf } from "./replan-fixtures.js";

const steps = (p: Plan): Array<{ w: PlannedWorkout; st: SimpleStep }> =>
  runWorkouts(p)
    .filter((w) => w.type !== "RACE")
    .flatMap((w) => flattenSteps(w.steps).map((st) => ({ w, st })));
const isHr = (t: Target | undefined): t is Extract<Target, { type: "hr_pct_max" }> => t?.type === "hr_pct_max";
/** Easy-zone steps: their pace (target or fallback) is the plan's E, LR or REC range, or they are 65–79% HR. */
const easyBand = (t: Target | undefined) => isHr(t) && t.lo === 65 && t.hi === 79;

describe("HRmax resolution (§4.6)", () => {
  it("uses the input's HRmax (measured by default), else Tanaka when the age formula is asked for", () => {
    expect(resolveHrMax({ hrMax: 186 })).toEqual({ maxBpm: 186, source: "measured" });
    expect(resolveHrMax({ hrMax: 186, hrMaxSource: "age_formula" })).toEqual({ maxBpm: 186, source: "age_formula" });
    expect(resolveHrMax({ hrMaxSource: "age_formula", age: 40 })).toEqual({ maxBpm: 180, source: "age_formula" });
    expect(resolveHrMax({ age: 40 })).toBeUndefined(); // no opt-in: HR features off
    expect(resolveHrMax({ hrMax: 20 })).toBeUndefined();
  });
});

describe("HR targets with a measured HRmax (persona C, 185 bpm)", () => {
  const input: PlanInput = { ...personaC, hrMax: 185, hrMaxSource: "measured", hrRest: 48 };
  const p = generatePlan(input);
  const all = steps(p);

  it("easy and long steps target HR in bpm with the pace range as fallback; pace steps keep pace with the HR fallback", () => {
    const easy = all.filter(({ st }) => easyBand(st.target));
    expect(easy.length).toBeGreaterThan(50);
    for (const { st } of easy) {
      const t = st.target as Extract<Target, { type: "hr_pct_max" }>;
      expect([t.lo_bpm, t.hi_bpm]).toEqual([Math.round(0.65 * 185), Math.round(0.79 * 185)]);
      expect(st.fallback?.type).toBe("pace");
    }
    const work = all.filter(({ w, st }) => st.kind === "work" && st.target.type === "pace" && ["T", "I"].includes(w.type)); // GP has no %HRmax band (§4.1)
    expect(work.length).toBeGreaterThan(5);
    for (const { st } of work) {
      expect(isHr(st.fallback)).toBe(true);
      expect((st.fallback as Extract<Target, { type: "hr_pct_max" }>).hi_bpm).toBe(Math.round(((st.fallback as { hi: number }).hi / 100) * 185));
    }
    // A single target per step: never pace in both slots, never HR in both.
    for (const { st } of all) if (st.fallback) expect(st.fallback.type).not.toBe(st.target.type);
  });

  it("keeps the pace ranges, the volumes and the schedule of the plan without HRmax", () => {
    const plain = generatePlan(personaC);
    expect(p.weeks.map((w) => w.plannedKm)).toEqual(plain.weeks.map((w) => w.plannedKm));
    const easyPace = steps(plain).filter(({ st }) => st.target.type === "pace" && isHr(st.fallback) && st.fallback.lo === 65);
    const moved = all.filter(({ st }) => easyBand(st.target)).map(({ st }) => st.fallback);
    expect(moved).toEqual(easyPace.map(({ st }) => st.target));
    expectBasics(p, input);
    expectSchedule(p);
    expectV1(p, input);
    expectTargetTracking(p);
    for (const w of runWorkouts(p)) expect(() => PlannedWorkoutSchema.parse(w)).not.toThrow();
  });

  it("compiles bpm ranges into intervals.icu text (syntax unverified, §14)", () => {
    const t = runWorkouts(p).find((w) => w.type === "T")!;
    const text = stepsToIntervalsText(t.steps);
    expect(text).toMatch(/^- Warmup 15m 120-146bpm HR$/m);
    expect(text).toMatch(/\/km Pace/);
    expect(stepsToIntervalsText([{ kind: "work", duration: { type: "time", s: 600 }, target: { type: "hr_pct_max", lo: 65, hi: 79 } }])).toBe("- 10m 65-79% HR");
  });
});

describe("HR targets by level and HRmax source (§6.9, §4.6)", () => {
  it("non-beginners get HR targets from the age formula too (guidance; HR never changes VDOT)", () => {
    const p = generatePlan({ ...personaB, age: 40, hrMaxSource: "age_formula" });
    const e = steps(p).find(({ st }) => easyBand(st.target))!.st.target as Extract<Target, { type: "hr_pct_max" }>;
    expect([e.lo_bpm, e.hi_bpm]).toEqual([117, 142]); // 65–79% of 208 − 0.7·40 = 180
  });

  it("beginners get the 79% HR cap only from a measured HRmax", () => {
    const capped = generatePlan({ ...personaA, hrMax: 200 });
    const easy = steps(capped).filter(({ w }) => w.type === "E" || w.type === "L" || w.type === "S");
    expect(easy.some(({ st }) => easyBand(st.target) && (st.target as { hi_bpm?: number }).hi_bpm === 158)).toBe(true);
    for (const { st } of easy) if (isHr(st.target)) expect(st.target.hi).toBeLessThanOrEqual(79);
    const ladder = steps(generatePlan({ ...personaA2, hrMax: 200 })).filter(({ st }) => st.kind === "run");
    expect(ladder.length).toBeGreaterThan(0);
    expect(ladder.every(({ st }) => easyBand(st.target))).toBe(true);

    for (const input of [{ ...personaA, age: 30, hrMaxSource: "age_formula" as const }, { ...personaA, hrMax: 200, hrMaxSource: "age_formula" as const }]) {
      expect(steps(generatePlan(input)).some(({ st }) => isHr(st.target) || isHr(st.fallback))).toBe(false);
    }
  });

  it("without an HRmax nothing changes (percent-only fallbacks, as before)", () => {
    expect(steps(generatePlan(personaC)).some(({ st }) => isHr(st.target) || (isHr(st.fallback) && st.fallback.lo_bpm !== undefined))).toBe(false);
  });
});

describe("replanning keeps HR targets and re-paces their fallbacks (R-BREAK, persona B with HRmax)", () => {
  const input: PlanInput = { ...personaB, hrMax: 182 };
  const plan = generatePlan(input);
  const acts = [...preHistory(input), ...ranAsPlanned(plan, input.today, "2026-12-21")];
  const r = replan(stateOf(input, acts, plan), [], "2026-12-31");

  it("rebuilt easy runs target HR; their pace fallback carries the break multiplier", () => {
    expect(r.regenerated).toBe(true);
    const e = runWorkouts(r.plan).find((w) => w.date >= "2026-12-31" && w.type === "E")!;
    const st = flattenSteps(e.steps)[0]!;
    expect(easyBand(st.target)).toBe(true);
    if (st.fallback?.type !== "pace") throw new Error("pace fallback expected");
    expect(st.fallback.hi_s_per_km).toBeGreaterThan(planPaces(input).E.slow);
  });
});
