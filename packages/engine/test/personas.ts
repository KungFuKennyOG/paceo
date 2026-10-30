/** Persona fixtures from spec §4.3, as plan inputs. "Today" is a fixed Monday so plans are stable. */
import { addDays, computeVdot, DISTANCES_M, type PlanInput } from "../src/index.js";

export const TODAY = "2026-11-02";
/** Race on the Sunday that ends week `weeks`. */
export const raceIn = (weeks: number): string => addDays(TODAY, 7 * weeks - 1);
export const hms = (h: number, m: number, s: number): number => h * 3600 + m * 60 + s;

/**
 * A: beginner, 3×/week, 12 km/week, longest run 5 km in 45 min, first 5K in 10 weeks, no goal time,
 * no VDOT yet. §4.3 says A "can just run 20 min continuously", so A skips the ladder (§6.9) and
 * starts with time-based easy running and a time trial.
 */
export const personaA: PlanInput = {
  level: "beginner",
  runDays: 3,
  longRunDay: "sun",
  today: TODAY,
  raceDate: raceIn(10),
  goal: { distance: "5k" },
  currentWeeklyKm: 12,
  longestRun30d: { km: 5, minutes: 45 },
  vdotStatus: "none",
  injuryFlag: false,
  heavyCrossTraining: false,
  longRunMode: "daniels",
  canRun20MinContinuous: true,
  monthsRunning: 2,
  // §9.2: beginners get the bodyweight technique block whatever the settings.
  strength: { mode: "running", equipment: "bodyweight", sessionsPerWeek: 2, liftingExperience: "none" },
};

/** A2: the same runner who can't yet run 20 min continuously → run/walk ladder from stage 6 (§4.3 weeks 1–3). */
export const personaA2: PlanInput = { ...personaA, canRun20MinContinuous: false, ladderEntryStage: 6 };

/**
 * B: intermediate marathoner, 4 days, 40–45 km/week, 14 km longest run, 4:24 marathon → 4:15 goal.
 * Paddles twice a week (Thursday hard practice, Saturday easy) and lifts upper body on their own
 * program Tuesday and Friday; the app adds running-focused lower A/B in the gym (§9.6).
 */
export const personaB: PlanInput = {
  level: "intermediate",
  runDays: 4,
  longRunDay: "sun",
  today: TODAY,
  raceDate: raceIn(18),
  goal: { distance: "marathon", timeS: hms(4, 15, 0) },
  currentWeeklyKm: 42,
  longestRun30d: { km: 14, minutes: 98 },
  vdot: computeVdot(DISTANCES_M.marathon, hms(4, 24, 0)),
  vdotStatus: "race",
  vdotAnchorM: DISTANCES_M.marathon,
  injuryFlag: false,
  // Paddling + lifting is likely > 40% of total_load (§6.7 persona outcomes) → 2:1.
  heavyCrossTraining: true,
  longRunMode: "daniels",
  canRun20MinContinuous: true,
  monthsRunning: 36,
  lockedEvents: [
    { weekday: "thu", activity: "dragon boat", minutes: 90, srpe: 7, name: "Dragon boat practice" },
    { weekday: "sat", activity: "paddling", minutes: 75, srpe: 4, name: "Easy paddle" },
    { weekday: "tue", activity: "strength_upper", minutes: 60, name: "Own upper-body lifting" },
    { weekday: "fri", activity: "strength_upper", minutes: 60, name: "Own upper-body lifting" },
  ],
  strength: { mode: "running", equipment: "gym", sessionsPerWeek: 2, liftingExperience: "experienced" },
};

/** C: advanced, 6 days, 60–65 km/week, HM PR 1:31:31 (VDOT 50) → sub-1:30 in 14 weeks. */
export const personaC: PlanInput = {
  level: "advanced",
  runDays: 6,
  longRunDay: "sun",
  today: TODAY,
  raceDate: raceIn(14),
  goal: { distance: "half", timeS: hms(1, 29, 59) },
  currentWeeklyKm: 62,
  longestRun30d: { km: 18, minutes: 95 },
  vdot: 50,
  vdotStatus: "race",
  vdotAnchorM: DISTANCES_M.half,
  injuryFlag: false,
  heavyCrossTraining: false,
  longRunMode: "daniels",
  canRun20MinContinuous: true,
  monthsRunning: 60,
  strength: { mode: "full_body", equipment: "gym", sessionsPerWeek: 2, liftingExperience: "experienced" },
};
