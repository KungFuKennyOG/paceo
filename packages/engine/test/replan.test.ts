import { describe, expect, it } from "vitest";
import {
  addDays,
  breakPaceMultiplier,
  generatePlan,
  isGeneralFitness,
  planPaces,
  REACH_WARN,
  replan,
  toDayNumber,
  type Activity,
  type CheckInEvent,
  type GeneralFitnessInput,
  type HrvNight,
  type Plan,
  type PlanInput,
  type PlannedWorkout,
  type ReplanResult,
  type ReplanState,
} from "../src/index.js";
import { personaA, personaB, personaC } from "./personas.js";
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
  isQuality,
} from "./plan-checks.js";
import { activityFor, preHistory, ranAsPlanned, stateOf, workoutsBefore } from "./replan-fixtures.js";

const planB = generatePlan(personaB);
const planC = generatePlan(personaC);
const runsOf = (p: Plan) => p.weeks.flatMap((w) => w.workouts).filter((w) => w.sport === "run");
const between = (p: Plan, from: string, toExcl: string) => runsOf(p).filter((w) => w.date >= from && w.date < toExcl);
const on = (p: Plan, date: string) => runsOf(p).find((w) => w.date === date);
const rules = (r: ReplanResult) => r.changes.map((c) => c.rule);
const editableFrom = (r: ReplanResult) => r.repush.from;

/** The plan as lived: past sessions that were missed or skipped didn't happen. */
function lived(r: ReplanResult): Plan {
  const gone = new Set(r.matching.workouts.filter((m) => m.status === "missed" || m.status === "skipped").map((m) => m.workoutId));
  return { ...r.plan, weeks: r.plan.weeks.map((w) => ({ ...w, workouts: w.workouts.filter((x) => !gone.has(x.id)) })) };
}

/** V1 against ACTUAL history: actual runs before today + planned runs from today, 30-day window. */
function expectV1Actual(r: ReplanResult, acts: readonly Activity[]): void {
  const from = editableFrom(r);
  // A rebuild with no run in the last 30 days is seeded like generatePlan: the derived longest run, dated yesterday.
  const seed = r.derivedInput && !acts.some((a) => a.sport === "run" && a.date >= addDays(from, -30) && a.date < from) ? [{ day: toDayNumber(from) - 1, km: r.derivedInput.longestRun30d.km as number | undefined }] : [];
  const hist = [...seed, ...acts.filter((a) => a.sport === "run" && !a.isRace && a.date < from).map((a) => ({ day: toDayNumber(a.date), km: a.runWalk ? undefined : a.distanceM / 1000 }))];
  for (const w of runsOf(r.plan).filter((x) => x.date >= from && x.type !== "RACE")) {
    const day = toDayNumber(w.date);
    const kms = hist.filter((h) => h.day >= day - 30 && h.day < day && h.km !== undefined).map((h) => h.km as number);
    if (kms.length > 0 && w.type !== "RW") expect(w.planned.run_m / 1000, `V1 actual ${w.date} ${w.name}`).toBeLessThanOrEqual(1.1 * Math.max(...kms) + 1e-3);
    hist.push({ day, km: w.type === "RW" ? undefined : w.planned.run_m / 1000 });
  }
}

/** V2 on planned km, with the documented return floor (75% of target) after a week the replanner cut. */
function expectGrowth(r: ReplanResult): void {
  const from = editableFrom(r);
  for (let i = 1; i < r.plan.weeks.length; i++) {
    const prev = r.plan.weeks[i - 1]!;
    const cur = r.plan.weeks[i]!;
    if (addDays(cur.startDate, 6) < from || prev.isLadder || prev.plannedKm <= 0) continue;
    expect(cur.plannedKm, `week ${cur.index}`).toBeLessThanOrEqual(Math.max(prev.plannedKm * 1.3, 0.75 * cur.targetKm) + 0.15);
  }
}

function expectReplanInvariants(r: ReplanResult, before: Plan, input: PlanInput, acts: readonly Activity[]): void {
  const from = editableFrom(r);
  expect(JSON.stringify(workoutsBefore(r.plan, from)), "past days unchanged").toBe(JSON.stringify(workoutsBefore(before, from)));
  const view = lived(r);
  expectSchedule(view);
  expectKeyBudget(view);
  expectBasics(r.plan, input);
  expectLongRunIsLongest(view);
  expectTargetTracking(r.plan);
  expectDanielsCaps(r.plan);
  expectCrossTrainingRules(r.plan);
  expectStrengthRules(r.plan);
  expectLockedEventsListed(r.plan, input);
  expectV1Actual(r, acts);
  expectGrowth(r);
  for (const wk of r.plan.weeks) {
    const km = wk.workouts.filter((w) => w.sport === "run" && w.type !== "RACE").reduce((a, w) => a + w.planned.run_m / 1000, 0);
    // plannedKm is rounded to 0.1 km, so it can sit exactly 0.05 km from the raw sum.
    expect(Math.abs(wk.plannedKm - km), `week ${wk.index}: strength never counts as running km`).toBeLessThanOrEqual(0.05 + 1e-9);
  }
}

// ── R-MISS ───────────────────────────────────────────────────────────────────────────────────────

describe("R-MISS: 3 missed days (persona C)", () => {
  const missed = new Set(["2026-12-08", "2026-12-09", "2026-12-10"]);
  const acts = [...preHistory(personaC), ...ranAsPlanned(planC, personaC.today, "2026-12-11", (w) => missed.has(w.date))];
  const r = replan(stateOf(personaC, acts, planC), [], "2026-12-11");

  it("drops the missed easy run and the key sessions with no legal day left; no realignment, no rebuild", () => {
    expect(r.regenerated).toBe(false);
    expect(rules(r)).toContain("R-MISS-1");
    expect(rules(r)).toContain("R-MISS-2");
    expect(r.proposals.filter((p) => p.kind === "realign")).toHaveLength(0);
    // Never add the km elsewhere: the rest of the week is unchanged.
    for (const w of between(r.plan, "2026-12-11", "2026-12-14")) expect(w).toEqual(on(planC, w.date));
  });

  it("satisfies the plan invariants", () => expectReplanInvariants(r, planC, personaC, acts));
});

describe("R-MISS-2: a missed key session moves within its week when §7.1 still holds", () => {
  // Persona C misses Tuesday's R; Wednesday's easy run can host it (Thu T is 2 days later... not adjacent check below).
  const acts = [...preHistory(personaC), ...ranAsPlanned(planC, personaC.today, "2026-12-03", (w) => w.date === "2026-12-01")];
  const r = replan(stateOf(personaC, acts, planC), [], "2026-12-02");
  it("moves it or drops it with a reason, and the lived schedule keeps 48 h between key sessions", () => {
    const moved = runsOf(r.plan).find((w) => w.rule_trace.includes("R-MISS-2:from(2026-12-01)"));
    if (moved) expect(moved.date >= "2026-12-02" && moved.date <= "2026-12-06").toBe(true);
    else expect(r.changes.some((c) => c.rule === "R-MISS-2" && /Dropped/.test(c.message))).toBe(true);
    expectReplanInvariants(r, planC, personaC, acts);
  });
});

describe("R-MISS-4: more than 3 missed in 2 weeks → realignment prompt, then rebuild on acceptance", () => {
  const missed = new Set(["2026-12-01", "2026-12-03", "2026-12-08", "2026-12-10"]);
  const acts = [...preHistory(personaC), ...ranAsPlanned(planC, personaC.today, "2026-12-11", (w) => missed.has(w.date))];
  const r = replan(stateOf(personaC, acts, planC), [], "2026-12-11");
  const prompt = r.proposals.find((p) => p.kind === "realign");

  it("prompts, without changing the plan structure yet", () => {
    expect(prompt).toBeDefined();
    expect(r.regenerated).toBe(false);
  });

  it("accepted → rebuilt from today on the km actually run over the last 3 weeks", () => {
    const r2 = replan(stateOf(personaC, acts, planC), [{ type: "proposal_response", date: "2026-12-11", proposalId: prompt!.id, accept: true }], "2026-12-11");
    expect(r2.regenerated).toBe(true);
    const runKm = acts.filter((a) => a.sport === "run" && a.date >= "2026-11-20" && a.date < "2026-12-11").reduce((s, a) => s + a.distanceM / 1000, 0);
    expect(r2.derivedInput!.currentWeeklyKm).toBeCloseTo(runKm / 3, 0);
    expect(r2.proposals.filter((p) => p.kind === "realign")).toHaveLength(0);
    // Realignment continues the plan (§8 R-RACE-2): same phases and taper, progression carried over.
    expect(r2.plan.weeks.map((w) => w.phase)).toEqual(planC.weeks.map((w) => w.phase));
    expect(r2.plan.weeks.map((w) => w.isTaper)).toEqual(planC.weeks.map((w) => w.isTaper));
    expect((r2.derivedInput as PlanInput).continuation).toMatchObject({ taperWeeks: 2 });
    expectReplanInvariants(r2, planC, personaC, acts);
  });
});

// ── R-BREAK ──────────────────────────────────────────────────────────────────────────────────────

describe("R-BREAK: 10 days off mid-build (persona B)", () => {
  const acts = [...preHistory(personaB), ...ranAsPlanned(planB, personaB.today, "2026-12-21")];
  const state = stateOf(personaB, acts, planB);
  const r = replan(state, [], "2026-12-31");

  it("rebuilds from the current week with history-derived inputs; race date, strength and locked events kept", () => {
    expect(r.regenerated).toBe(true);
    const d = r.derivedInput!;
    if (isGeneralFitness(d)) throw new Error("mode");
    expect(d.raceDate).toBe(personaB.raceDate);
    expect(d.today).toBe("2026-12-28");
    expect(d.longestRun30d.km).toBeCloseTo(20.6, 1);
    expect(d.currentWeeklyKm).toBeGreaterThan(40);
    expect(d.strength).toEqual(personaB.strength);
    expect(d.lockedEvents).toEqual(personaB.lockedEvents);
    expect(r.metrics.breakDays).toBe(10);
    expect(r.metrics.breakMultiplier!).toBeCloseTo(0.985, 3);
    expect(r.plan.summary.notes).toContain("replan:R-BREAK:2026-12-31:10");
  });

  it("50% of pre-break volume, all easy, for 5 days; then 75% for 5 days; paces ÷ 0.985", () => {
    const ramp50 = between(r.plan, "2026-12-31", "2027-01-05").filter((w) => w.type !== "RACE");
    expect(ramp50.length).toBeGreaterThan(0);
    for (const w of ramp50) {
      expect(isQuality(w)).toBe(false);
      expect(w.rule_trace).toContain("R-BREAK:vol×0.5");
    }
    expect(between(r.plan, "2027-01-05", "2027-01-10").some((w) => w.rule_trace.includes("R-BREAK:vol×0.75"))).toBe(true);
    const e = ramp50.find((w) => w.type === "E")!;
    const step = e.steps[0]!;
    if (step.kind === "repeat" || step.target.type !== "pace") throw new Error("pace target expected");
    expect(step.target.hi_s_per_km).toBeCloseTo(planPaces(personaB).E.slow / breakPaceMultiplier(10, false), 0);
    expect(r.changes.find((c) => c.rule === "R-BREAK")!.message).toMatch(/6:03 \/km → 6:08 \/km/);
  });

  it("satisfies the plan invariants (V1 against actual history, past days unchanged)", () => expectReplanInvariants(r, planB, personaB, acts));

  it("is deterministic and idempotent (the next call doesn't rebuild or re-apply)", () => {
    expect(JSON.stringify(replan(state, [], "2026-12-31"))).toBe(JSON.stringify(replan(state, [], "2026-12-31")));
    const again = replan({ ...state, plan: r.plan, fitness: r.fitness }, [], "2026-12-31");
    expect(again.regenerated).toBe(false);
    expect(JSON.stringify(again.plan)).toBe(JSON.stringify(r.plan));
  });
});

describe("R-BREAK: 30 days off (persona B) → rebuild + re-test", () => {
  const acts = [...preHistory(personaB), ...ranAsPlanned(planB, personaB.today, "2026-12-01")];
  const r = replan(stateOf(personaB, acts, planB), [], "2026-12-31");

  it("detrains VDOT, marks it estimated, schedules a time trial and prompts a goal revision", () => {
    expect(r.regenerated).toBe(true);
    expect(r.fitness.status).toBe("estimated");
    expect(r.fitness.vdot!).toBeLessThan(personaB.vdot!);
    expect(runsOf(r.plan).some((w) => w.type === "TT" && w.date > "2026-12-31")).toBe(true);
    const goal = r.proposals.find((p) => p.kind === "goal_change");
    expect(goal).toBeDefined();
    if (goal?.kind === "goal_change") expect(goal.suggestedGoalS!).toBeGreaterThan(personaB.goal.timeS!);
  });

  it("continues the calendar: one Foundation rebuild week, then the original TQ/FQ weeks; the taper is unchanged", () => {
    const d = r.derivedInput as PlanInput;
    expect(d.continuation).toMatchObject({ rebuildWeeks: 1, phaseReset: true, taperWeeks: 3 });
    expect(r.plan.weeks.map((w) => w.phase)).toEqual([...planB.weeks.slice(0, 8).map((w) => w.phase), "FI", ...planB.weeks.slice(9).map((w) => w.phase)]);
    expect(r.plan.weeks.map((w) => w.isTaper)).toEqual(planB.weeks.map((w) => w.isTaper));
    for (const w of between(r.plan, "2026-12-31", "2027-01-04")) expect(w.rule_trace).toContain("R-RACE-2:rebuild_week");
    expect(r.plan.feasibility.status).not.toBe("block");
  });

  it("satisfies the plan invariants", () => expectReplanInvariants(r, planB, personaB, acts));
});

/** Every plan invariant (plan-checks.ts) on the plan generatePlan builds from a rebuild's derived input. */
function expectRebuiltPlanInvariants(d: PlanInput): void {
  const p = generatePlan(d);
  expect(p.weeks.length).toBeGreaterThan(0);
  expectBasics(p, d);
  expectSchedule(p);
  expectKeyBudget(p);
  expectV1(p, d);
  expectWeeklyGrowth(p);
  expectLongRunIsLongest(p);
  expectTargetTracking(p);
  expectDanielsCaps(p);
  expectCrossTrainingRules(p);
  expectStrengthRules(p);
  expectLockedEventsListed(p, d);
}

describe("§8 R-RACE-2: a rebuild continues the phases (persona B, 10 days off mid-TQ)", () => {
  // Ran weeks 1–9 as planned (week 9 = first TQ week), then 10 days off; back on Thursday of week 11.
  const acts = [...preHistory(personaB), ...ranAsPlanned(planB, personaB.today, "2027-01-04")];
  const state = stateOf(personaB, acts, planB);
  const r = replan(state, [], "2027-01-14");
  const d = r.derivedInput as PlanInput;

  it("stays in TQ / FQ: every remaining week keeps its original phase, and the taper is unchanged", () => {
    expect(r.regenerated).toBe(true);
    expect(d.today).toBe("2027-01-11");
    expect(d.continuation).toMatchObject({ taperWeeks: 3, weeksSinceCutback: 0 });
    expect(d.continuation!.phaseReset).toBeUndefined();
    expect(r.plan.weeks.map((w) => w.phase)).toEqual(planB.weeks.map((w) => w.phase));
    expect(r.plan.weeks.slice(10).map((w) => w.phase)).toEqual(["TQ", "TQ", "TQ", "TQ", "FQ", "FQ", "FQ", "FQ"]);
    expect(r.plan.weeks.map((w) => w.isTaper)).toEqual(planB.weeks.map((w) => w.isTaper));
    expect(r.plan.summary.taperWeeks).toBe(3);
    expect(r.plan.summary.notes.some((n) => n.startsWith("R-RACE-2:continue(wk11/18,TQ,taper3)"))).toBe(true);
    // After the all-easy 50% days, quality comes back as TQ work (I or T, §6.3 P3), not Foundation running.
    const q = between(r.plan, "2027-01-19", "2027-02-08").filter(isQuality);
    expect(q.length).toBeGreaterThan(0);
    for (const w of q) expect(w.rule_trace.some((t) => t.startsWith("P3:TQ:M:"))).toBe(true);
  });

  it("runs the R-RACE checks instead of the new-plan minimum: not blocked, long-run target reachable", () => {
    const codes = r.plan.feasibility.reasons.map((x) => x.code);
    expect(r.plan.feasibility.status).not.toBe("block");
    expect(codes).toContain("continuation");
    expect(codes).not.toContain("min_weeks");
    expect(codes).not.toContain("goal_short_block");
    expect(r.plan.feasibility.reach.ratio).toBeGreaterThanOrEqual(REACH_WARN);
    expect(r.trace).toContain("R-RACE:ok");
    expect(r.proposals.filter((p) => p.kind === "goal_change")).toHaveLength(0);
  });

  it("recomputes volume and sessions from actual history: the return ramp first, progression carried over", () => {
    expect(d.currentWeeklyKm).toBeGreaterThan(40);
    expect(between(r.plan, "2027-01-14", "2027-01-19").every((w) => !isQuality(w))).toBe(true);
    // Progression steps back one exposure per 7 days off: 2 T, 1 I and 2 R sessions done, less 2.
    expect(d.continuation!.exposures).toBeUndefined();
  });

  it("satisfies the replan invariants", () => expectReplanInvariants(r, planB, personaB, acts));
  it("the rebuilt plan on its own satisfies every plan invariant", () => expectRebuiltPlanInvariants(d));

  it("is deterministic and idempotent", () => {
    expect(JSON.stringify(replan(state, [], "2027-01-14"))).toBe(JSON.stringify(r));
    expect(JSON.stringify(generatePlan(d))).toBe(JSON.stringify(generatePlan(JSON.parse(JSON.stringify(d)) as PlanInput)));
    const again = replan({ ...state, plan: r.plan, fitness: r.fitness }, [], "2027-01-14");
    expect(again.regenerated).toBe(false);
    expect(JSON.stringify(again.plan)).toBe(JSON.stringify(r.plan));
  });
});

describe("§8 R-BREAK > 28 days early in the plan: restart FI with a re-test (persona B, 30 days off from week 2)", () => {
  const acts = [...preHistory(personaB), ...ranAsPlanned(planB, personaB.today, "2026-11-09")];
  const r = replan(stateOf(personaB, acts, planB), [], "2026-12-09");
  const d = r.derivedInput as PlanInput;

  it("13 weeks left meets the new-plan minimum, so the build restarts from FI; the taper stays", () => {
    expect(r.regenerated).toBe(true);
    expect(d.continuation).toMatchObject({ restart: true, taperWeeks: 3 });
    const rebuilt = r.plan.weeks.slice(5);
    expect(rebuilt[0]!.phase).toBe("FI");
    expect(rebuilt.map((w) => w.phase)).toEqual([...planPhasesFor(13), "FQ", "FQ", "FQ"].slice(0, 13));
    expect(r.plan.weeks.map((w) => w.isTaper)).toEqual(planB.weeks.map((w) => w.isTaper));
    expect(r.plan.feasibility.status).not.toBe("block");
  });

  it("re-tests: VDOT detrained and estimated, a time trial in the next week, a goal revision offered", () => {
    expect(r.fitness.status).toBe("estimated");
    const tt = runsOf(r.plan).filter((w) => w.type === "TT" && w.date >= "2026-12-09");
    expect(tt).toHaveLength(1);
    expect(tt[0]!.date < "2026-12-21").toBe(true);
    expect(r.proposals.some((p) => p.kind === "goal_change")).toBe(true);
  });

  it("satisfies the replan invariants", () => expectReplanInvariants(r, planB, personaB, acts));
  it("the rebuilt plan on its own satisfies every plan invariant", () => expectRebuiltPlanInvariants(d));
  it("is deterministic", () => expect(JSON.stringify(replan(stateOf(personaB, acts, planB), [], "2026-12-09"))).toBe(JSON.stringify(r)));
});

describe("PlanInput.continuation in generatePlan (§8 R-RACE-2)", () => {
  const cal = planB.weeks.map((w) => w.phase);
  const base: PlanInput = { ...personaB, today: "2027-01-11", continuation: { phaseCalendar: cal, taperWeeks: 3 } };
  const firstT = (p: Plan) => runsOf(p).find((w) => w.type === "T")!;

  it("continues progression from the exposures already done", () => {
    const fresh = generatePlan(base);
    const carried = generatePlan({ ...base, continuation: { ...base.continuation!, exposures: { T: 6 } } });
    expect(fresh.weeks.map((w) => w.phase)).toEqual(cal.slice(10));
    expect(carried.weeks.map((w) => w.phase)).toEqual(cal.slice(10));
    expect(firstT(carried).planned.minutes).toBeGreaterThan(firstT(fresh).planned.minutes);
  });

  it("keeps the taper even when it is all that's left", () => {
    const input: PlanInput = { ...base, today: "2027-02-22", continuation: { phaseCalendar: cal, taperWeeks: 3 } };
    const p = generatePlan(input);
    expect(p.weeks.map((w) => [w.phase, w.isTaper])).toEqual([["FQ", true], ["FQ", true]]);
    expectRebuiltPlanInvariants(input);
    expect(p.summary.taperWeeks).toBe(2);
    expect(p.feasibility.status).not.toBe("block");
  });

  it("is ignored when its calendar doesn't reach back to today's week: a new plan, with the new-plan minimum", () => {
    const p = generatePlan({ ...base, continuation: { phaseCalendar: cal.slice(0, 5), taperWeeks: 3 } });
    expect(p.feasibility.reasons.map((r) => r.code)).toContain("min_weeks");
    expect(p.weeks[0]!.phase).toBe("FI");
  });
});

/** §6.3 phases of a fresh `weeks`-week intermediate plan (build part first). */
function planPhasesFor(weeks: number): string[] {
  return generatePlan({ ...personaB, raceDate: addDays(personaB.today, 7 * weeks - 1) }).weeks.map((w) => w.phase).slice(0, weeks - 3);
}

// ── R-ILL ────────────────────────────────────────────────────────────────────────────────────────

describe("R-ILL: illness with fever (persona B)", () => {
  const acts = [...preHistory(personaB), ...ranAsPlanned(planB, personaB.today, "2026-12-08")];
  const fever: CheckInEvent = { type: "illness", date: "2026-12-08", fever: true, systemic: true, aboveNeck: true };
  const r = replan(stateOf(personaB, acts, planB), [fever], "2026-12-09");

  it("no running (and no strength) while feverish", () => {
    expect(rules(r)).toContain("R-ILL-1");
    for (const d of ["2026-12-09", "2026-12-10", "2026-12-11"]) {
      expect(r.plan.weeks.flatMap((w) => w.workouts).some((w) => w.date === d)).toBe(false);
    }
    expectReplanInvariants(r, planB, personaB, acts);
  });

  it("once fever-free: a 15-min return test, easy only until day 10, and the 50% → 75% ramp", () => {
    const resolved: CheckInEvent = { ...fever, resolvedDate: "2026-12-12", reportedOn: "2026-12-12" };
    const r2 = replan({ ...stateOf(personaB, acts, r.plan), fitness: r.fitness }, [fever, resolved], "2026-12-12");
    const test = on(r2.plan, "2026-12-12")!;
    expect(test.name).toBe("Return test: 15 min very easy");
    expect(test.planned.minutes).toBe(15);
    for (const w of between(r2.plan, "2026-12-12", "2026-12-18")) expect(isQuality(w)).toBe(false);
    expect(rules(r2)).toContain("R-ILL-3");
    expect(rules(r2)).toContain("R-ILL-4");
    expectReplanInvariants(r2, r.plan, personaB, acts);
  });

  it("red flags after the return, or symptoms over 7 days → see a doctor, plan paused", () => {
    const flag: CheckInEvent = { type: "illness_red_flag", date: "2026-12-13", flags: ["chest_pain"] };
    const r3 = replan(stateOf(personaB, acts, planB), [{ ...fever, resolvedDate: "2026-12-12" }, flag], "2026-12-13");
    expect(r3.halted!.referral).toBe("doctor");
    expect(between(r3.plan, "2026-12-13", "2026-12-27").filter((w) => w.type !== "RACE")).toHaveLength(0);
    const long = replan(stateOf(personaB, acts, planB), [fever], "2026-12-17");
    expect(long.halted!.rule).toBe("R-ILL-5");
  });
});

describe("R-ILL: above-neck cold (persona B)", () => {
  const acts = [...preHistory(personaB), ...ranAsPlanned(planB, personaB.today, "2026-12-08")];
  const r = replan(stateOf(personaB, acts, planB), [{ type: "illness", date: "2026-12-08", fever: false, systemic: false, aboveNeck: true }], "2026-12-08");
  it("optional easy runs at ≤ 60% of planned time, no quality", () => {
    for (const w of between(r.plan, "2026-12-08", "2026-12-11")) {
      const original = on(planB, w.date)!;
      expect(isQuality(w)).toBe(false);
      expect(w.planned.minutes).toBeLessThanOrEqual(0.6 * original.planned.minutes + 1);
    }
    expectReplanInvariants(r, planB, personaB, acts);
  });
});

// ── R-PAIN ───────────────────────────────────────────────────────────────────────────────────────

describe("R-PAIN (Silbernagel)", () => {
  const acts = [...preHistory(personaB), ...ranAsPlanned(planB, personaB.today, "2026-12-07")];
  const red: CheckInEvent = { type: "pain", date: "2026-12-06", bodyPart: "Achilles", during: 6, nextMorning: 4, reportedOn: "2026-12-07" };

  it("6/10 that's still there next morning → red: 3 days off, then a 20-min test run", () => {
    const r = replan(stateOf(personaB, acts, planB), [red], "2026-12-07");
    expect(between(r.plan, "2026-12-07", "2026-12-10")).toHaveLength(0);
    const test = on(r.plan, "2026-12-10")!;
    expect(test.name).toBe("Pain test: 20 min very easy");
    expect(rules(r)).toContain("R-PAIN-4");
    expectReplanInvariants(r, planB, personaB, acts);
  });

  it("pain > 5 again on the test run → physio + cross-training only", () => {
    const later = [...acts, activityFor(on(planB, "2026-12-10")!)];
    const again: CheckInEvent = { type: "pain", date: "2026-12-10", bodyPart: "Achilles", during: 6, reportedOn: "2026-12-10" };
    const r = replan(stateOf(personaB, later, planB), [red, again], "2026-12-11");
    expect(r.changes.some((c) => /physio/.test(c.message))).toBe(true);
    expect(between(r.plan, "2026-12-11", "2026-12-25").filter((w) => w.type !== "RACE")).toHaveLength(0);
  });

  it("amber: next 3 runs easy, no intervals/hills/reps, long run frozen", () => {
    const amber: CheckInEvent = { type: "pain", date: "2026-12-06", bodyPart: "knee", during: 4, nextMorning: 0 };
    const r = replan(stateOf(personaB, acts, planB), [amber], "2026-12-07");
    const next = runsOf(r.plan).filter((w) => w.date >= "2026-12-07" && w.type !== "RACE").slice(0, 3);
    for (const w of next) expect(isQuality(w)).toBe(false);
    for (const w of between(r.plan, "2026-12-07", "2026-12-14")) expect(["I", "H", "R"]).not.toContain(w.type);
    const lastLr = acts.filter((a) => a.date === "2026-12-06")[0]!.distanceM / 1000;
    for (const w of between(r.plan, "2026-12-07", "2026-12-21").filter((x) => x.type === "L")) expect(w.planned.run_m / 1000).toBeLessThanOrEqual(lastLr + 1e-6);
    expectReplanInvariants(r, planB, personaB, acts);
  });

  it("sharp localized bone pain → out of scope: stop and refer", () => {
    const r = replan(stateOf(personaB, acts, planB), [{ type: "pain", date: "2026-12-06", bodyPart: "shin", during: 2, sharpBonePain: true }], "2026-12-07");
    expect(r.halted!.rule).toBe("R-PAIN");
  });
});

// ── R-PERF / FIT-UPDATE through replan ───────────────────────────────────────────────────────────

describe("R-PERF: 3+ strong threshold sessions over 3 weeks (persona C)", () => {
  const strong = (w: PlannedWorkout) => ({ workPace: w.type === "T" || w.type === "I" ? 0.97 : 1 });
  const acts = [...preHistory(personaC), ...ranAsPlanned(planC, personaC.today, "2026-12-25", () => false, strong)];
  const state = stateOf(personaC, acts, planC);
  const r = replan(state, [], "2026-12-25");
  const p = r.proposals.find((x) => x.kind === "vdot_change");

  it("proposes +1 step (≈ 1.2% faster T pace) and does not apply it", () => {
    expect(p).toBeDefined();
    if (p?.kind !== "vdot_change") return;
    expect(p.rule).toBe("R-PERF");
    expect(p.steps).toBe(1);
    expect(p.toVdot).toBeCloseTo(50.75, 2);
    expect(r.fitness.vdot).toBe(50);
    expect(JSON.stringify(r.plan)).toBe(JSON.stringify(replan(state, [], "2026-12-25").plan));
  });

  it("accepted → VDOT updated and future pace targets re-derived; past days unchanged; then frozen 2 weeks", () => {
    const r2 = replan(state, [{ type: "proposal_response", date: "2026-12-25", proposalId: p!.id, accept: true }], "2026-12-25");
    expect(r2.fitness.vdot).toBeCloseTo(50.75, 2);
    const t = runsOf(r2.plan).find((w) => w.type === "T" && w.date >= "2026-12-25")!;
    const before = runsOf(planC).find((w) => w.id === t.id)!;
    const pace = (w: PlannedWorkout) => {
      const flat = w.steps.flatMap((s) => (s.kind === "repeat" ? s.steps : [s]));
      const work = flat.find((s) => s.kind === "work")!;
      return work.target.type === "pace" ? work.target.lo_s_per_km : NaN;
    };
    expect(pace(t)).toBeLessThan(pace(before));
    expect(t.rule_trace.some((x) => x.startsWith("FIT-UPDATE:vdot("))).toBe(true);
    expectReplanInvariants(r2, planC, personaC, acts);
    const later = replan({ ...state, plan: r2.plan, fitness: r2.fitness }, [], "2027-01-01");
    expect(later.proposals.filter((x) => x.kind === "vdot_change")).toHaveLength(0);
  });

  it("declined → not offered again for the same evidence", () => {
    const r3 = replan(state, [{ type: "proposal_response", date: "2026-12-25", proposalId: p!.id, accept: false }], "2026-12-25");
    expect(r3.proposals.filter((x) => x.id === p!.id)).toHaveLength(0);
  });
});

describe("FIT-UPDATE: a race result updates VDOT immediately (persona C)", () => {
  const acts = [...preHistory(personaC), ...ranAsPlanned(planC, personaC.today, "2026-12-13")];
  const race: Activity = { id: "race-hm", date: "2026-12-13", sport: "run", distanceM: 21250, movingS: 5300, isRace: true };
  const r = replan(stateOf(personaC, [...acts, race], planC), [], "2026-12-14");
  it("sets VDOT from the race and re-paces the future in place", () => {
    expect(r.fitness.vdot!).toBeGreaterThan(52);
    expect(r.fitness.history.at(-1)!.source).toBe("race-hm");
    expect(r.proposals.filter((p) => p.kind === "vdot_change")).toHaveLength(0);
    expect(rules(r)).toContain("FIT-UPDATE");
    expectReplanInvariants(r, planC, personaC, [...acts, race]);
  });
});

describe("FIT-UPDATE: the first time trial switches a time/RPE plan into pace mode (persona A)", () => {
  const planA = generatePlan(personaA);
  const tt = runsOf(planA).find((w) => w.type === "TT")!;
  const acts = ranAsPlanned(planA, personaA.today, addDays(tt.date, 1));
  const r = replan(stateOf(personaA, acts, planA), [], addDays(tt.date, 1));
  it("sets VDOT from the TT and rebuilds with pace targets", () => {
    expect(r.fitness.status).toBe("tt");
    expect(r.regenerated).toBe(true);
    expectReplanInvariants(r, planA, personaA, acts);
  });
});

// ── R-HRV, R-LOAD ────────────────────────────────────────────────────────────────────────────────

describe("R-HRV: 7-day rMSSD below the 4-week band", () => {
  const today = "2026-12-03"; // persona C: Thursday T
  const acts = [...preHistory(personaC), ...ranAsPlanned(planC, personaC.today, today)];
  const hrv: HrvNight[] = Array.from({ length: 30 }, (_, i) => {
    const date = addDays(today, -29 + i);
    return { date, rmssdMs: i >= 24 ? 40 : 60 + (i % 3) * 2 };
  });
  const state: ReplanState = { ...stateOf(personaC, acts, planC), hrv };
  const r = replan(state, [], today);
  it("today's quality session becomes easy; weekly volume is not changed by HRV", () => {
    expect(on(planC, today)!.type).toBe("T");
    expect(isQuality(on(r.plan, today)!)).toBe(false);
    expect(rules(r)).toContain("R-HRV-2");
    expectReplanInvariants(r, planC, personaC, acts);
  });
  it("is off without enough nights", () => {
    const off = replan({ ...state, hrv: hrv.slice(-10) }, [], today);
    expect(on(off.plan, today)!.type).toBe("T");
  });
});

describe("R-LOAD: guardrails", () => {
  // Persona C ran only 60% of the plan for 4 weeks: the next weeks would spike total_load.
  const acts = [...preHistory(personaC), ...ranAsPlanned(planC, personaC.today, "2026-12-07", () => false, () => ({ volume: 0.6 }))];
  const r = replan(stateOf(personaC, acts, planC), [], "2026-12-07");
  it("R-LOAD-2 trims easy running first, never the long run; V1 holds against what was actually run", () => {
    expect(rules(r)).toContain("R-LOAD-2");
    const lrBefore = between(planC, "2026-12-07", "2026-12-14").find((w) => w.type === "L")!;
    const lrAfter = between(r.plan, "2026-12-07", "2026-12-14").find((w) => w.type === "L")!;
    expect(lrAfter.planned.run_m).toBeLessThanOrEqual(lrBefore.planned.run_m);
    expect(between(r.plan, "2026-12-07", "2026-12-14").some((w) => w.rule_trace.includes("R-LOAD-2:trim"))).toBe(true);
    expectReplanInvariants(r, planC, personaC, acts);
  });
  it("R-LOAD-3 monotony and strain are reported, display only", () => {
    expect(r.metrics.monotony).toBeDefined();
    expect(r.metrics.strain).toBeDefined();
  });
});

// ── general fitness ──────────────────────────────────────────────────────────────────────────────

describe("general-fitness plans replan too (no race rules)", () => {
  const { raceDate: _r, goal: _g, ...rest } = personaC;
  const gf: GeneralFitnessInput = { ...rest, goal: { type: "general_fitness", weeks: 12 } };
  const plan = generatePlan(gf);
  const acts = [...preHistory(personaC), ...ranAsPlanned(plan, gf.today, "2026-11-23")];
  const r = replan({ plan, input: gf, fitness: { vdot: 50, status: "race", history: [] }, activities: acts }, [], "2026-12-04");
  it("rebuilds after a break and keeps the end date", () => {
    expect(r.regenerated).toBe(true);
    expect(r.plan.weeks.at(-1)!.startDate).toBe(plan.weeks.at(-1)!.startDate);
    expect(r.proposals.filter((p) => p.kind === "goal_change")).toHaveLength(0);
    expect(JSON.stringify(workoutsBefore(r.plan, "2026-12-04"))).toBe(JSON.stringify(workoutsBefore(plan, "2026-12-04")));
  });
});
