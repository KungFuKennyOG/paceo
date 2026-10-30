import { describe, expect, it } from "vitest";
import { isGeneralFitness } from "@paceo/engine";
import type { Profile } from "@paceo/contracts";
import {
  deriveLevel,
  effectiveLevel,
  lockedEvents,
  mapProfileToPlanInput,
  pacesFor,
  strengthConfig,
} from "../../src/plan/map-profile.js";
import { buildPlan, plannedCrossTrainingShare } from "../../src/services/plan.js";

const TODAY = "2026-11-02";

export function baseProfile(over: Partial<Profile> = {}): Profile {
  return {
    units: "metric",
    timezone: "America/Toronto",
    experienceLevel: "intermediate",
    monthsRunning: 30,
    currentWeeklyKm: 40,
    longestRun30d: { km: 16, minutes: 95 },
    canRun20MinContinuous: true,
    recentResult: { distanceM: 10000, timeS: 47 * 60, date: "2026-10-04", kind: "race" },
    birthYear: 1990,
    hrMax: null,
    hrRest: null,
    injury: "none",
    goal: { type: "race", distance: "half", raceDate: "2027-02-28", goalTimeS: null },
    daysAvailable: ["tue", "thu", "sat", "sun"],
    longRunDay: "sun",
    maxMinutesByDay: {},
    longRunMode: "daniels",
    strength: { mode: "running", equipment: "bodyweight", sessionsPerWeek: 2, liftingExperience: "none" },
    crossTraining: [],
    watchBrand: "garmin",
    ...over,
  };
}

const ctx = { userId: "u1", today: TODAY, screening: "ok" as const };

describe("level derivation (§2.3)", () => {
  it("follows the table", () => {
    expect(deriveLevel(baseProfile({ monthsRunning: 2 }))).toBe("beginner");
    expect(deriveLevel(baseProfile({ canRun20MinContinuous: false }))).toBe("beginner");
    expect(deriveLevel(baseProfile({ currentWeeklyKm: 8 }))).toBe("beginner");
    expect(deriveLevel(baseProfile({ monthsRunning: 8 }))).toBe("novice");
    expect(deriveLevel(baseProfile({ monthsRunning: 24 }))).toBe("intermediate");
    expect(deriveLevel(baseProfile({ monthsRunning: 60, currentWeeklyKm: 45 }))).toBe("intermediate");
    expect(deriveLevel(baseProfile({ monthsRunning: 60, currentWeeklyKm: 55 }))).toBe("advanced");
  });

  it("an advanced runner with a race at the goal distance needs only 40 km/week", () => {
    const p = baseProfile({
      monthsRunning: 60,
      currentWeeklyKm: 42,
      recentResult: { distanceM: 21097.5, timeS: 5400, date: "2026-10-01", kind: "race" },
    });
    expect(deriveLevel(p)).toBe("advanced");
  });

  it("uses min(self-report, derived)", () => {
    expect(effectiveLevel("advanced", "novice")).toBe("novice");
    expect(effectiveLevel("beginner", "advanced")).toBe("beginner");
  });
});

describe("mapProfileToPlanInput", () => {
  it("maps a race profile", () => {
    const m = mapProfileToPlanInput(baseProfile(), ctx);
    expect(isGeneralFitness(m.input)).toBe(false);
    if (isGeneralFitness(m.input)) return;
    expect(m.input).toMatchObject({
      userId: "u1",
      level: "intermediate",
      runDays: 4,
      longRunDay: "sun",
      today: TODAY,
      raceDate: "2027-02-28",
      goal: { type: "race", distance: "half" },
      vdotStatus: "race",
      vdotAnchorM: 10000,
      age: 36,
      injuryFlag: false,
      heavyCrossTraining: false,
      conservative: false,
      strength: { mode: "running", equipment: "bodyweight", sessionsPerWeek: 2, liftingExperience: "none" },
    });
    expect(m.input.vdot).toBeGreaterThan(40);
    expect(m.input.goal.timeS).toBeUndefined();
    expect(m.vdot.status).toBe("race");
  });

  it("treats results older than 12 weeks as estimated and older than a year as absent", () => {
    const old = mapProfileToPlanInput(baseProfile({ recentResult: { distanceM: 5000, timeS: 1500, date: "2026-05-01", kind: "time_trial" } }), ctx);
    expect(old.input.vdotStatus).toBe("estimated");
    const ancient = mapProfileToPlanInput(baseProfile({ recentResult: { distanceM: 5000, timeS: 1500, date: "2024-05-01", kind: "race" } }), ctx);
    expect(ancient.input.vdotStatus).toBe("none");
    expect(ancient.input.vdot).toBeUndefined();
  });

  it("maps run weekdays, per-day limits and HR settings (set only when known)", () => {
    const m = mapProfileToPlanInput(
      baseProfile({ daysAvailable: ["mon", "wed", "fri", "sat"], longRunDay: "sat", maxMinutesByDay: { mon: 45 }, hrMax: 188, hrRest: 52 }),
      ctx,
    );
    expect(m.input).toMatchObject({ runWeekdays: ["mon", "wed", "fri", "sat"], runDays: 4, maxMinutesByDay: { mon: 45 }, hrMax: 188, hrMaxSource: "measured", hrRest: 52 });
    const ageOnly = mapProfileToPlanInput(baseProfile(), ctx).input;
    expect(ageOnly.hrMaxSource).toBe("age_formula");
    expect("hrMax" in ageOnly).toBe(false);
    expect("hrRest" in ageOnly).toBe(false);
    const none = mapProfileToPlanInput(baseProfile({ birthYear: null }), ctx).input;
    expect("hrMaxSource" in none).toBe(false);
  });

  it("maps a recent time trial as tt", () => {
    const m = mapProfileToPlanInput(baseProfile({ recentResult: { distanceM: 3000, timeS: 800, date: "2026-10-20", kind: "time_trial" } }), ctx);
    expect(m.input.vdotStatus).toBe("tt");
  });

  it("maps general fitness to the engine's general-fitness goal", () => {
    const m = mapProfileToPlanInput(baseProfile({ goal: { type: "general_fitness", targetWeeklyMinutes: 240 } }), ctx);
    expect(m.generalFitness).toBe(true);
    expect(isGeneralFitness(m.input)).toBe(true);
    expect(m.input.goal).toEqual({ type: "general_fitness", targetWeeklyMinutes: 240 });
    expect("raceDate" in m.input).toBe(false);
  });

  it("forces conservative settings after cleared_conservative", () => {
    const m = mapProfileToPlanInput(baseProfile(), { ...ctx, screening: "cleared_conservative" });
    expect(m.input.level).toBe("beginner");
    expect(m.input.conservative).toBe(true);
    expect(m.input.injuryFlag).toBe(true);
  });

  it("maps each cross-training entry × day to a locked event", () => {
    const p = baseProfile({
      crossTraining: [
        { activity: "dragon boat", days: ["mon", "wed"], typicalMinutes: 90, typicalSrpe: 6, locked: true },
        { activity: "cycling", days: ["fri"], typicalMinutes: 45, typicalSrpe: 4, locked: false },
      ],
    });
    expect(lockedEvents(p)).toEqual([
      { weekday: "mon", activity: "dragon boat", minutes: 90, srpe: 6, locked: true, name: "dragon boat" },
      { weekday: "wed", activity: "dragon boat", minutes: 90, srpe: 6, locked: true, name: "dragon boat" },
      { weekday: "fri", activity: "cycling", minutes: 45, srpe: 4, locked: false, name: "cycling" },
    ]);
  });

  it("maps strength settings", () => {
    expect(strengthConfig(baseProfile({ strength: { mode: "full_body", equipment: "gym", sessionsPerWeek: 3, liftingExperience: "experienced" } }))).toEqual({
      mode: "full_body",
      equipment: "gym",
      sessionsPerWeek: 3,
      liftingExperience: "experienced",
    });
  });

  it("produces display paces for race and general-fitness inputs", () => {
    const race = pacesFor(mapProfileToPlanInput(baseProfile(), ctx).input);
    expect(race).toHaveProperty("E");
    const gf = pacesFor(mapProfileToPlanInput(baseProfile({ goal: { type: "general_fitness", targetWeeklyMinutes: null } }), ctx).input);
    expect(gf).toHaveProperty("E");
  });
});

describe("buildPlan (engine end-to-end)", () => {
  it("generates a race plan with runs and strength sessions", () => {
    const built = buildPlan(baseProfile(), ctx);
    expect(built.plan.weeks.length).toBeGreaterThan(10);
    const all = built.plan.weeks.flatMap((w) => w.workouts);
    expect(all.some((w) => w.sport === "run")).toBe(true);
    expect(all.some((w) => w.sport === "strength")).toBe(true);
    expect(all.every((w) => w.user_id === "u1")).toBe(true);
  });

  it("generates a general-fitness plan with no race", () => {
    const built = buildPlan(baseProfile({ goal: { type: "general_fitness", targetWeeklyMinutes: 200 } }), ctx);
    expect(built.plan.weeks.length).toBeGreaterThan(0);
    expect(built.plan.weeks.flatMap((w) => w.workouts).some((w) => w.type === "RACE")).toBe(false);
  });

  it("switches to heavy cross-training when planned cross-training dominates the load", () => {
    const p = baseProfile({
      currentWeeklyKm: 20,
      crossTraining: [
        { activity: "dragon boat", days: ["mon", "wed", "fri"], typicalMinutes: 120, typicalSrpe: 7, locked: true },
      ],
    });
    const built = buildPlan(p, ctx);
    if (plannedCrossTrainingShare(built.plan) > 0.4 || built.mapped.input.heavyCrossTraining) {
      expect(built.mapped.input.heavyCrossTraining).toBe(true);
    }
    expect(built.plan.weeks[0]?.crossTraining?.length ?? 0).toBeGreaterThan(0);
  });
});
