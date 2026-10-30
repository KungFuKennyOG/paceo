import { describe, expect, it } from "vitest";
import { addDays, generatePlan, replan, type PlanInput } from "@paceo/engine";
import { toEngineActivity, toEngineEvents, toFitnessState } from "../../src/plan/replan-state.js";
import { compliance } from "../../src/plan/matching.js";
import { engineExplainer } from "../../src/plan/explain.js";

const today = "2026-12-09";

describe("stored rows → engine replan inputs (§8)", () => {
  it("maps activities, sports and fitness", () => {
    const a = toEngineActivity({ id: "a", localDate: "2026-12-01", sport: "walk", distanceM: null, movingS: 3000, elapsedS: 3100, avgHr: null, isRace: false, name: "Dog walk" });
    expect(a).toEqual({ id: "a", date: "2026-12-01", sport: "hike", distanceM: 0, movingS: 3000, isRace: false, activity: "Dog walk" });
    const f = toFitnessState({ vdot: 45, vdotSource: "race", vdotDate: "2026-10-01" }, { vdotStatus: "none" });
    expect(f).toMatchObject({ vdot: 45, status: "race" });
    expect(f.history[0]?.date).toBe("2026-10-01");
    expect(toFitnessState(undefined, { vdot: 40, vdotStatus: "tt" })).toEqual({ vdot: 40, status: "tt", history: [] });
  });

  it("groups illness check-ins into episodes; an episode with no report for 2 days is resolved", () => {
    const ill = (date: string, fever: boolean) => ({ type: "illness", date, activityId: null, workoutId: null, payload: { type: "illness", date, fever, aboveNeckOnly: !fever } });
    const ongoing = toEngineEvents([ill("2026-12-07", true), ill("2026-12-08", false)], [], today, () => undefined);
    expect(ongoing).toEqual([{ type: "illness", date: "2026-12-07", reportedOn: "2026-12-08", fever: true, systemic: true, aboveNeck: true }]);
    const done = toEngineEvents([ill("2026-12-03", false)], [], today, () => undefined);
    expect(done[0]).toMatchObject({ type: "illness", date: "2026-12-03", systemic: false, resolvedDate: "2026-12-04" });
  });

  it("maps pain, sRPE, cross-training and skipped workouts", () => {
    const ev = toEngineEvents(
      [
        { type: "pain", date: today, activityId: null, workoutId: null, payload: { location: "left knee", duringRun: 6, nextMorning: null } },
        { type: "session_rpe", date: today, activityId: null, workoutId: "w1", payload: { rpe: 7, minutes: 40 } },
        { type: "cross_training", date: today, activityId: null, workoutId: null, payload: { activity: "Swim", minutes: 45, rpe: 4 } },
      ],
      [{ id: "w2", date: "2026-12-08", status: "skipped", skipReason: "sick" }],
      today,
      () => "act-1",
    );
    expect(ev).toEqual([
      { type: "pain", date: today, bodyPart: "left knee", during: 6 },
      { type: "srpe", date: today, activityId: "act-1", srpe: 7 },
      { type: "cross_training", date: today, sport: "swim", activity: "Swim", minutes: 45, srpe: 4 },
      { type: "skip", date: "2026-12-08", reason: "illness" },
    ]);
  });

  it("feeds the engine: a fever check-in removes the next days' runs", () => {
    const input: PlanInput = {
      level: "intermediate",
      runDays: 4,
      longRunDay: "sun",
      today: "2026-11-02",
      raceDate: addDays("2026-11-02", 18 * 7 - 1),
      goal: { distance: "marathon" },
      currentWeeklyKm: 42,
      longestRun30d: { km: 14, minutes: 98 },
      vdot: 34,
      vdotStatus: "race",
      injuryFlag: false,
      heavyCrossTraining: false,
      longRunMode: "daniels",
      canRun20MinContinuous: true,
      monthsRunning: 36,
    };
    const plan = generatePlan(input);
    const events = toEngineEvents([{ type: "illness", date: today, activityId: null, workoutId: null, payload: { fever: true, aboveNeckOnly: false } }], [], today, () => undefined);
    const r = replan({ plan, input, fitness: toFitnessState(undefined, { vdot: 34, vdotStatus: "race" }), activities: [] }, events, today);
    const runs = r.plan.weeks.flatMap((w) => w.workouts).filter((w) => w.sport === "run" && w.date >= today && w.date <= addDays(today, 2));
    expect(runs).toEqual([]);
    expect(r.changes.some((c) => c.rule === "R-ILL-1")).toBe(true);
  });
});

describe("matching and explanations use the engine", () => {
  it("pace-prescribed runs are judged by distance, time/RPE by duration", () => {
    const w = { id: "w", date: today, sport: "run", plannedMinutes: 40, plannedRunM: 8000 };
    const a = { id: "a", localDate: today, sport: "run", movingS: 2400, distanceM: 5000 };
    expect(compliance({ ...w, prescriptionMode: "pace", type: "E" }, a)).toBeCloseTo(0.625, 6);
    expect(compliance({ ...w, prescriptionMode: "time_rpe", type: "E" }, a)).toBeCloseTo(1, 6);
  });

  it("explains rule traces in plain English", () => {
    expect(engineExplainer.explain({ rule_trace: ["W-E", "V1:ok(10.5<=12.1)"] }, "metric")).toEqual([
      "Easy run: conversational pace to build aerobic base.",
      "10.5 km is within your safe single-run limit of 12.1 km (10% over your longest run in the last 30 days).",
    ]);
  });
});
