import { describe, expect, it } from "vitest";
import {
  classifyEvent,
  crossTrainingClass,
  DEFAULT_STRENGTH_CONFIG,
  EXERCISE_LIBRARY,
  exerciseCard,
  exerciseFor,
  expandLockedEvents,
  generatePlan,
  mainScheme,
  PLYO_LADDER,
  plyoContacts,
  plyoEntryRung,
  PlannedWorkoutSchema,
  qualityBudget,
  STRENGTH_PHASE_TABLE,
  strengthRowFor,
  strengthSession,
  toDayNumber,
  weekdayOf,
  weeklyLoad,
  type PlanInput,
  type StrengthSessionSpec,
} from "../src/index.js";
import { personaA, personaB, personaC } from "./personas.js";
import { crossTraining, strengthWorkouts } from "./plan-checks.js";

const spec = (over: Partial<StrengthSessionSpec> = {}): StrengthSessionSpec => ({
  kind: "lower",
  variant: "A",
  row: "build",
  intensity: "row",
  equipment: "gym",
  experience: "experienced",
  cutback: false,
  plyo: { rung: 2, contacts: 60 },
  coreSlots: 1,
  withUpper: false,
  generalWeek: 0,
  phase: "EQ",
  trace: [],
  ...over,
});
const slots = (w: ReturnType<typeof strengthSession>) => (w.exercises ?? []).map((e) => e.slot);

describe("strength configuration and phase table (spec §9.2, §9.4)", () => {
  it("defaults to running-focused, bodyweight, 2/week, no lifting experience", () => {
    expect(DEFAULT_STRENGTH_CONFIG).toMatchObject({ mode: "running", equipment: "bodyweight", sessionsPerWeek: 2, liftingExperience: "none" });
  });

  it("caps sessions by phase: 2–3 general, 2 base/build, 1 peak, 1 taper, 0 race week", () => {
    const n = (id: keyof typeof STRENGTH_PHASE_TABLE) => STRENGTH_PHASE_TABLE[id].sessions;
    expect([n("general"), n("base"), n("build"), n("peak"), n("taper"), n("race_week")]).toEqual([3, 2, 2, 1, 1, 0]);
    expect(strengthRowFor({ phase: "FI", isTaper: false }, "race", false)).toBe("base");
    expect(strengthRowFor({ phase: "TQ", isTaper: false }, "race", false)).toBe("build");
    expect(strengthRowFor({ phase: "FQ", isTaper: false }, "race", false)).toBe("peak");
    expect(strengthRowFor({ phase: "FQ", isTaper: true }, "race", false)).toBe("taper");
    expect(strengthRowFor({ phase: "FQ", isTaper: true }, "race", true)).toBe("race_week");
    expect(strengthRowFor({ phase: "EQ", isTaper: false }, "general_fitness", false)).toBe("general");
    expect(strengthRowFor({ phase: "BASE", isTaper: false }, "race", false)).toBe("general");
  });

  it("limits intensity by lifting experience: ≥ 90% only for experienced lifters", () => {
    expect(mainScheme({ intensity: "row", row: "build", experience: "experienced", generalWeek: 0 }).load).toMatch(/90%/);
    expect(mainScheme({ intensity: "row", row: "build", experience: "novice", generalWeek: 0 }).load).toMatch(/no ≥ 90%/);
    expect(mainScheme({ intensity: "technique", row: "build", experience: "none", generalWeek: 0 })).toMatchObject({ sets: 3, reps: "8–12" });
    expect(mainScheme({ intensity: "row", row: "general", experience: "novice", generalWeek: 0 }).reps).toBe("8–10");
    expect(mainScheme({ intensity: "row", row: "general", experience: "novice", generalWeek: 8 }).reps).toBe("6");
    expect(mainScheme({ intensity: "light", row: "taper", experience: "experienced", generalWeek: 0 }).load).toMatch(/40% 1RM/);
  });

  it("doses plyos per §9.5: entry rung by experience, +15 contacts a week, row and 150 caps", () => {
    expect([plyoEntryRung("none"), plyoEntryRung("novice"), plyoEntryRung("experienced")]).toEqual([0, 1, 2]);
    const build = STRENGTH_PHASE_TABLE.build;
    expect(plyoContacts("none", 0, build, false)).toBe(35);
    expect(plyoContacts("experienced", 0, build, false)).toBe(50);
    expect(plyoContacts("experienced", 2, build, false)).toBe(80);
    expect(plyoContacts("experienced", 20, build, false)).toBe(120);
    expect(plyoContacts("experienced", 20, STRENGTH_PHASE_TABLE.peak, false)).toBe(60);
    expect(plyoContacts("experienced", 2, build, true)).toBe(50); // 80 × 0.6 → 48 → 50
    for (let w = 0; w < 30; w++) expect(plyoContacts("experienced", w, build, false)).toBeLessThanOrEqual(150);
  });
});

describe("exercise library (spec §9.3)", () => {
  it("covers every slot × equipment cell with a complete card", () => {
    for (const slot of ["SQUAT", "HINGE", "SINGLE_LEG", "CALF_STRAIGHT", "CALF_BENT", "HIP", "CORE", "UPPER_PUSH", "UPPER_PULL"] as const) {
      for (const eq of ["gym", "dumbbells", "bodyweight"] as const) {
        const c = exerciseFor(slot, eq);
        expect(c.slot).toBe(slot);
        expect(c.equipment).toContain(eq);
      }
    }
    for (const c of EXERCISE_LIBRARY) {
      expect(c.cues.length, c.id).toBeGreaterThanOrEqual(3);
      expect(c.cues.length, c.id).toBeLessThanOrEqual(4);
      expect(c.commonFaults.length, c.id).toBeGreaterThanOrEqual(1);
      expect(c.commonFaults.length, c.id).toBeLessThanOrEqual(2);
      if (c.regressionId) expect(exerciseCard(c.regressionId).slot, c.id).toBe(c.slot);
      if (c.progressionId) expect(exerciseCard(c.progressionId).slot, c.id).toBe(c.slot);
    }
  });

  it("has the 7-rung plyo ladder from pogo hops to hurdle hops", () => {
    expect(PLYO_LADDER).toHaveLength(7);
    expect(PLYO_LADDER[0]).toBe("pogo_hops");
    expect(PLYO_LADDER[6]).toBe("hurdle_hops");
    for (const id of PLYO_LADDER) expect(exerciseCard(id).slot).toBe("PLYO");
  });
});

describe("strength sessions (spec §9.3)", () => {
  it("running-focused A/B: plyos first, squat or hinge, single-leg, alternating calf, ~45 min", () => {
    const a = strengthSession(spec());
    const b = strengthSession(spec({ variant: "B" }));
    expect(slots(a).slice(0, 4)).toEqual(["PLYO", "SQUAT", "SINGLE_LEG", "CALF_STRAIGHT"]);
    expect(slots(b).slice(0, 4)).toEqual(["PLYO", "HINGE", "SINGLE_LEG", "CALF_BENT"]);
    expect(slots(a).filter((s) => s === "CORE").length).toBeLessThanOrEqual(1);
    for (const w of [a, b]) {
      expect(w.sport).toBe("strength");
      expect(w.type).toBe("STRENGTH");
      expect(w.planned.minutes).toBeGreaterThanOrEqual(38);
      expect(w.planned.minutes).toBeLessThanOrEqual(50);
      expect(w.steps.length).toBe((w.exercises ?? []).length + 1); // warm-up + one step per exercise
      expect(() => PlannedWorkoutSchema.parse({ ...w, id: "x", user_id: "me", date: "2026-11-03" })).not.toThrow();
    }
  });

  it("full-body A/B adds upper push and pull, ~55–60 min", () => {
    const a = strengthSession(spec({ kind: "full" }));
    const b = strengthSession(spec({ kind: "full", variant: "B" }));
    for (const w of [a, b]) {
      expect(slots(w)).toContain("UPPER_PUSH");
      expect(slots(w)).toContain("UPPER_PULL");
      expect(w.planned.minutes).toBeGreaterThanOrEqual(50);
      expect(w.planned.minutes).toBeLessThanOrEqual(65);
    }
    expect(b.exercises!.find((e) => e.slot === "UPPER_PUSH")!.name).toBe("Overhead press"); // vertical push on B
  });

  it("2 core slots only without trunk-loading cross-training", () => {
    expect(slots(strengthSession(spec({ variant: "B", coreSlots: 2 }))).filter((s) => s === "CORE")).toHaveLength(2);
    expect(slots(strengthSession(spec({ variant: "B", coreSlots: 1 }))).filter((s) => s === "CORE")).toHaveLength(1);
    expect(slots(strengthSession(spec({ kind: "full", coreSlots: 2 }))).filter((s) => s === "CORE")).toHaveLength(2);
    expect(slots(strengthSession(spec({ kind: "full", coreSlots: 1 }))).filter((s) => s === "CORE")).toHaveLength(1);
  });

  it("beginner technique block: bodyweight, no plyos, ≤ 30 min", () => {
    const { plyo: _p, ...noPlyo } = spec();
    const w = strengthSession({ ...noPlyo, kind: "technique", intensity: "technique", equipment: "bodyweight", experience: "none", maxMinutes: 30 });
    expect(w.planned.minutes).toBeLessThanOrEqual(30);
    expect(slots(w)).not.toContain("PLYO");
    expect(w.exercises!.find((e) => e.slot === "SQUAT")!.reps).toBe("8–12");
  });

  it("cutback weeks deload ~40% of sets; taper sessions are light", () => {
    const normal = strengthSession(spec());
    const deload = strengthSession(spec({ cutback: true }));
    const sq = (w: typeof normal) => w.exercises!.find((e) => e.slot === "SQUAT")!.sets;
    expect(sq(normal)).toBe(4);
    expect(sq(deload)).toBe(2);
    const { plyo: _p, ...noPlyo } = spec();
    const light = strengthSession({ ...noPlyo, row: "taper", intensity: "light" });
    expect(light.exercises!.find((e) => e.slot === "SQUAT")!.load).toMatch(/40% 1RM/);
    expect(light.rule_trace).toContain("§9.4:light");
  });

  it("keeps old workout JSON (no exercises) valid", () => {
    const run = generatePlan(personaB).weeks[0]!.workouts.find((w) => w.sport === "run")!;
    const { exercises: _e, ...old } = run;
    expect(() => PlannedWorkoutSchema.parse(old)).not.toThrow();
    expect(run.exercises).toBe(undefined);
  });
});

describe("cross-training mapping (spec §10.2)", () => {
  it("classifies names and intervals.icu sport types", () => {
    expect(crossTrainingClass("dragon boat")).toBe("paddling");
    expect(crossTrainingClass("Ride")).toBe("cycling");
    expect(crossTrainingClass("VirtualRide")).toBe("cycling");
    expect(crossTrainingClass("Soccer")).toBe("team_sport");
    expect(crossTrainingClass("CrossFit")).toBe("hiit");
    expect(crossTrainingClass("WeightTraining")).toBe("strength_unknown");
    expect(crossTrainingClass("strength_upper")).toBe("strength_upper");
    expect(crossTrainingClass("Yoga")).toBe("yoga");
    expect(crossTrainingClass("underwater hockey?")).toBe("other");
  });

  it("applies the hard-day rules and default sRPE", () => {
    const c = (e: Partial<Parameters<typeof classifyEvent>[0]>) =>
      classifyEvent({ weekday: "mon", activity: "cycling", minutes: 60, ...e });
    expect(c({ srpe: 7 }).hard).toBe(true);
    expect(c({ srpe: 6 }).hard).toBe(false);
    expect(c({}).srpe).toBe(3);
    expect(c({ hard: true }).srpe).toBe(7);
    expect(c({ activity: "soccer" })).toMatchObject({ hard: true, srpe: 8, keyCost: 0.5 });
    expect(c({ activity: "soccer", hard: false }).hard).toBe(false); // "light/technique"
    expect(c({ activity: "climbing", srpe: 7 }).hard).toBe(false);
    expect(c({ activity: "climbing", srpe: 8 }).hard).toBe(true);
    expect(c({ activity: "hiking", minutes: 200, elevationGainM: 900 }).hard).toBe(true);
    expect(c({ activity: "hiking", minutes: 200, elevationGainM: 500 }).hard).toBe(false);
    expect(c({ activity: "hiit" }).keyCost).toBe(0.5);
    expect(c({ activity: "yoga", srpe: 9 }).hard).toBe(false);
    // External lifting is never hard for running purposes.
    expect(c({ activity: "strength_lower", srpe: 9 })).toMatchObject({ hard: false, keyCost: 0 });
  });

  it("½ key per hard day: 0 → 2 quality, 1–2 → 1, 3+ → 0", () => {
    const hard = { weekday: "thu", activity: "paddling", minutes: 90, srpe: 7 } as const;
    expect(qualityBudget([])).toBe(2);
    expect(qualityBudget([hard])).toBe(1);
    expect(qualityBudget([hard, { ...hard, weekday: "mon" }])).toBe(1);
    expect(qualityBudget([hard, { ...hard, weekday: "mon" }, { ...hard, weekday: "sat" }])).toBe(0);
    expect(qualityBudget([{ weekday: "tue", activity: "strength_upper", minutes: 60 }])).toBe(2);
  });

  it("expands locked events onto their weekdays and skips race day", () => {
    const start = toDayNumber("2026-11-02");
    const xt = expandLockedEvents([{ weekday: "sun", activity: "swim", minutes: 30 }], start, start + 13, start + 13);
    expect(xt.map((x) => x.date)).toEqual(["2026-11-08"]);
    expect(xt[0]).toMatchObject({ cls: "swimming", expectedSrpe: 3, load: 90, hard: false, locked: true });
  });
});

describe("load model: two channels (spec §10.1)", () => {
  const plan = generatePlan(personaB);

  it("keeps running km and total load apart; cross-training adds load, never km", () => {
    for (const wk of plan.weeks) {
      const l = weeklyLoad(wk);
      const runKm = wk.workouts.filter((w) => w.sport === "run").reduce((a, w) => a + w.planned.run_m, 0) / 1000;
      expect(l.runningKm).toBeCloseTo(runKm, 1);
      expect(l.totalLoad).toBeCloseTo(l.byKind.run + l.byKind.strength + l.byKind.crossTraining, -1);
      const xtLoad = (wk.crossTraining ?? []).reduce((a, x) => a + x.expectedSrpe * x.minutes, 0);
      expect(l.byKind.crossTraining).toBe(Math.round(xtLoad));
      const dry = weeklyLoad({ ...wk, crossTraining: [] });
      expect(dry.runningKm).toBe(l.runningKm);
    }
  });

  it("persona B: paddling + lifting is > 40% of total load (the 2:1 cutback trigger, §6.7)", () => {
    const build = plan.weeks.filter((w) => !w.isTaper && !w.isCutback);
    const share = build.reduce((a, w) => a + weeklyLoad(w).crossTrainingShare, 0) / build.length;
    expect(share).toBeGreaterThan(0.4);
  });

  it("counts Q + LR + ½ hard paddle = 2.5 key sessions in quality weeks", () => {
    const q = plan.weeks.filter((w) => w.workouts.some((x) => ["T", "I", "R", "H", "M"].includes(x.type)) && !w.isTaper);
    expect(q.length).toBeGreaterThan(0);
    for (const wk of q) expect(weeklyLoad(wk).keySessions).toBe(2.5);
  });
});

describe("persona B week layout (§7.2 4-day template, §9.6)", () => {
  const plan = generatePlan(personaB);
  const byWeekday = (wk: (typeof plan.weeks)[number]) => {
    const m = new Map<string, string[]>();
    for (const w of wk.workouts) m.set(weekdayOf(w.date), [...(m.get(weekdayOf(w.date)) ?? []), w.sport === "strength" ? "STR" : w.type]);
    for (const x of wk.crossTraining ?? []) m.set(x.weekday, [...(m.get(x.weekday) ?? []), x.hard ? "XT!" : "XT"]);
    return m;
  };

  it("build week: Tue Q1 + strength A merged into the upper day, Thu easy + strength B + hard paddle, Sun LR", () => {
    const wk = plan.weeks.find((w) => w.phase === "TQ" && !w.isCutback)!;
    const d = byWeekday(wk);
    expect(d.get("tue")!.filter((t) => ["T", "I", "R", "H", "M"].includes(t))).toHaveLength(1);
    expect(d.get("tue")).toContain("STR");
    const thu = d.get("thu")!;
    expect(thu).toHaveLength(3);
    expect(thu).toContain("STR");
    expect(thu).toContain("XT!");
    expect(thu.some((t) => t === "E" || t === "S")).toBe(true);
    expect(d.get("fri")).toEqual(["XT"]);
    expect(d.get("sat")).toContain("XT");
    expect(d.get("sun")).toEqual(["L"]);
    const tue = wk.workouts.find((w) => w.sport === "strength" && weekdayOf(w.date) === "tue")!;
    expect(tue.rule_trace).toContain("ST-1:after_quality_run");
    expect(tue.rule_trace.some((t) => t.startsWith("§9.6:merge_into_upper_day"))).toBe(true);
  });

  it("no quality on the paddle day or the day after it", () => {
    for (const wk of plan.weeks) {
      const d = byWeekday(wk);
      for (const day of ["thu", "fri"]) expect((d.get(day) ?? []).some((t) => ["T", "I", "R", "H", "M", "TT"].includes(t))).toBe(false);
    }
  });

  it("2 sessions in base/build, 1 at peak and in the taper, none in race week; last heavy ≥ 10 days out", () => {
    for (const wk of plan.weeks) {
      const n = wk.workouts.filter((w) => w.sport === "strength").length;
      if (wk.phase === "FI" || wk.phase === "EQ" || wk.phase === "TQ") expect(n, `week ${wk.index}`).toBe(2);
      else if (wk.index === plan.weeks.length) expect(n).toBe(0);
      else expect(n, `week ${wk.index}`).toBe(1);
    }
    const race = toDayNumber(personaB.raceDate);
    const heavy = strengthWorkouts(plan).filter((w) => !w.rule_trace.includes("§9.4:light"));
    const last = Math.max(...heavy.map((w) => toDayNumber(w.date)));
    expect(race - last).toBeGreaterThanOrEqual(10);
    expect(race - last).toBeLessThanOrEqual(14);
  });

  it("lists both paddles and both upper days every week", () => {
    for (const wk of plan.weeks.slice(0, -1)) expect(wk.crossTraining).toHaveLength(4);
    expect(crossTraining(plan).filter((x) => x.keyCost > 0).every((x) => x.weekday === "thu")).toBe(true);
  });
});

describe("personas A and C strength", () => {
  it("A (beginner): bodyweight technique block only, ≤ 30 min, ≤ 2/week, no plyos", () => {
    const plan = generatePlan(personaA);
    const s = strengthWorkouts(plan);
    expect(s.length).toBeGreaterThan(0);
    for (const w of s) {
      expect(w.planned.minutes).toBeLessThanOrEqual(30);
      expect(w.name).toMatch(/technique/);
      expect((w.exercises ?? []).some((e) => e.slot === "PLYO")).toBe(false);
      for (const e of w.exercises ?? []) expect(exerciseCard(e.id).equipment).toContain("bodyweight");
    }
    for (const wk of plan.weeks) expect(wk.workouts.filter((w) => w.sport === "strength").length).toBeLessThanOrEqual(2);
  });

  it("C (full body, gym): Strength A/B after Q1/Q2 in build weeks (ST-1)", () => {
    const plan = generatePlan(personaC);
    const build = plan.weeks.filter((w) => (w.phase === "EQ" || w.phase === "TQ") && !w.isCutback);
    for (const wk of build) {
      const s = wk.workouts.filter((w) => w.sport === "strength");
      expect(s).toHaveLength(2);
      for (const w of s) {
        expect(w.name).toMatch(/full body/);
        expect(w.rule_trace).toContain("ST-1:after_quality_run");
      }
    }
  });
});

describe("strength fallbacks and special modes", () => {
  it("conservative (§2.4): no plyos and no heavy work", () => {
    const plan = generatePlan({ ...personaC, conservative: true });
    for (const w of strengthWorkouts(plan)) {
      expect((w.exercises ?? []).some((e) => e.slot === "PLYO")).toBe(false);
      expect(w.rule_trace.some((t) => t === "§9.4:technique" || t === "§9.4:light")).toBe(true);
    }
  });

  it("no-experience lifters start with a technique block, then the phase table", () => {
    const plan = generatePlan({ ...personaC, strength: { ...personaC.strength!, liftingExperience: "none" } });
    const s = strengthWorkouts(plan);
    expect(s[0]!.name).toMatch(/technique/);
    expect(s.some((w) => w.name.includes("full body"))).toBe(true);
  });

  it("fallback 4: drops a session when only two legal days exist", () => {
    // 3 sessions wanted; with Q1/Q2/LR at 6 days only Tue and Thu clear ST-3/ST-4 (general row allows 3).
    const { raceDate: _r, goal: _g, ...c } = personaC;
    const plan = generatePlan({ ...c, goal: { type: "general_fitness" }, strength: { ...personaC.strength!, sessionsPerWeek: 3 } });
    const dropped = plan.weeks.filter((w) => w.notes.includes("S:fallback4:drop_strength"));
    expect(dropped.length).toBeGreaterThan(0);
    for (const wk of dropped) expect(wk.workouts.filter((w) => w.sport === "strength").length).toBeLessThan(3);
  });

  it("external mode: nothing prescribed unless the add-on is on; the add-on follows the user's lower day", () => {
    const ext: PlanInput = {
      ...personaB,
      lockedEvents: [{ weekday: "mon", activity: "strength_lower", minutes: 60, name: "Own leg day" }],
      strength: { mode: "external", equipment: "gym", sessionsPerWeek: 2, liftingExperience: "experienced" },
    };
    expect(strengthWorkouts(generatePlan(ext))).toHaveLength(0);
    const addOn = generatePlan({ ...ext, strength: { ...ext.strength!, externalAddOn: true } });
    const s = strengthWorkouts(addOn);
    expect(s.length).toBeGreaterThan(0);
    for (const w of s) {
      expect(weekdayOf(w.date)).toBe("mon");
      expect(w.planned.minutes).toBeLessThanOrEqual(20);
      expect(w.rule_trace).toContain("§9.6:running_add_on");
    }
  });

  it("reports an external lower day that breaks ST-3 with a suggested swap", () => {
    const plan = generatePlan({
      ...personaB,
      lockedEvents: [{ weekday: "sat", activity: "strength_lower", minutes: 60, name: "Own leg day" }],
    });
    const c = plan.summary.conflicts!.find((x) => x.code === "ST-3:external_lift")!;
    expect(c.weekday).toBe("sat");
    expect(c.suggestion).toMatch(/Move it to/);
  });

  it("reports a hard locked session the day before the LR, and suggests moving a flexible one (fallback 5)", () => {
    const locked = generatePlan({ ...personaB, longRunDay: "fri" });
    expect(locked.summary.conflicts!.some((c) => c.code === "XT:hard_day_before_LR" && c.weekday === "thu" && !c.suggestion)).toBe(true);
    const flex = generatePlan({
      ...personaC,
      lockedEvents: [{ weekday: "wed", activity: "soccer", minutes: 90, hard: false, locked: false, name: "Pickup soccer" }],
    });
    const c = flex.summary.conflicts!.find((x) => x.code === "XT:flexible_blocks_quality")!;
    expect(c.suggestion).toMatch(/fallback 5: move it to/);
  });
});
