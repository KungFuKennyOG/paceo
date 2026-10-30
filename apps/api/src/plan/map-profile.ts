/**
 * Contract Profile → engine PlanInput. This is the ONLY place that knows both shapes, so engine
 * changes (strength, cross-training, general fitness, schedule constraints) land here.
 *
 * Pending engine work, marked TODO(engine-*) below:
 * - TODO(engine-strength): pass profile.strength (mode, equipment, sessions/week, lifting experience).
 * - TODO(engine-crosstraining): non-locked cross-training load; locked events are passed already.
 * - TODO(engine-general-fitness): general-fitness mode. Until then a general-fitness goal is mapped to
 *   a 16-week open 10K-shaped block and the race-day session is dropped (see GENERAL_FITNESS_*).
 * - TODO(engine-schedule): daysAvailable (which weekdays) and maxMinutesByDay; the engine only takes a
 *   run-day count and the long-run day today.
 * - TODO(engine-hr): hrMax / hrRest for HR targets.
 */
import {
  addDays,
  computeVdot,
  daysBetween,
  isVdotInRange,
  planPaces,
  trainingPaces,
  type Level,
  type LockedEvent,
  type PlanInput,
  type VdotStatus,
} from "@paceo/engine";
import type { Profile, ScreeningOutcome } from "@paceo/contracts";

export interface MapContext {
  userId: string;
  /** User-local today, YYYY-MM-DD. */
  today: string;
  /** Latest screening outcome; "cleared_conservative" forces the most conservative settings (§2.4). */
  screening: ScreeningOutcome | null;
}

export interface MappedProfile {
  input: PlanInput;
  /** True when the goal is general fitness (engine mode pending; see TODO above). */
  generalFitness: boolean;
  /** User-facing notes about how the profile was interpreted. */
  notes: string[];
  /** VDOT provenance, for fitness_state. */
  vdot: { value: number | null; status: VdotStatus; date: string | null };
}

/** Weeks in the stand-in general-fitness block. TODO(engine-general-fitness). */
export const GENERAL_FITNESS_WEEKS = 16;
/** Result age (days) that still counts at full weight (§2.3: ≤ 12 weeks). */
export const RESULT_FULL_WEIGHT_DAYS = 84;
/** Older than this, a result is ignored. (D) */
export const RESULT_MAX_AGE_DAYS = 365;

const LEVEL_ORDER: readonly Level[] = ["beginner", "novice", "intermediate", "advanced"];
const GOAL_DISTANCE_M = { "5k": 5000, "10k": 10000, half: 21097.5, marathon: 42195 } as const;

/** Experience level derived from history (§2.3 table). */
export function deriveLevel(p: Profile): Level {
  const months = p.monthsRunning;
  const weekly = p.currentWeeklyKm;
  if (months < 3 || !p.canRun20MinContinuous || weekly < 10) return "beginner";
  if (months <= 12) return "novice";
  if (months > 36) {
    const racedGoalDistance =
      p.goal.type === "race" &&
      p.recentResult !== null &&
      p.recentResult.kind === "race" &&
      Math.abs(p.recentResult.distanceM - GOAL_DISTANCE_M[p.goal.distance]) / GOAL_DISTANCE_M[p.goal.distance] < 0.02;
    if (weekly >= 50 || (racedGoalDistance && weekly >= 40)) return "advanced";
  }
  return "intermediate";
}

/** The engine uses min(self-report, derived) (§2.3). */
export function effectiveLevel(selfReport: Level, derived: Level): Level {
  return LEVEL_ORDER[Math.min(LEVEL_ORDER.indexOf(selfReport), LEVEL_ORDER.indexOf(derived))] as Level;
}

/**
 * §6.7 C1 / R-LOAD-4: cross-training above 40% of total load. Running load is estimated from weekly
 * km at ~6 min/km and sRPE 4 (D, rough until the load model lands).
 */
export function isHeavyCrossTraining(p: Profile): boolean {
  const ct = p.crossTraining.reduce((sum, c) => sum + c.days.length * c.typicalMinutes * c.typicalSrpe, 0);
  if (ct === 0) return false;
  const run = p.currentWeeklyKm * 6 * 4;
  return ct / (ct + run) > 0.4;
}

export function lockedEvents(p: Profile): LockedEvent[] {
  const out: LockedEvent[] = [];
  for (const c of p.crossTraining) {
    if (!c.locked) continue;
    for (const weekday of c.days) {
      out.push({ weekday, activity: c.activity, minutes: c.typicalMinutes, srpe: c.typicalSrpe, hard: c.typicalSrpe >= 7 });
    }
  }
  return out;
}

function vdotFromResult(p: Profile, today: string): MappedProfile["vdot"] & { anchorM?: number; note?: string } {
  const r = p.recentResult;
  if (!r) return { value: null, status: "none", date: null };
  let age: number;
  try {
    age = daysBetween(r.date, today);
  } catch {
    return { value: null, status: "none", date: null, note: "The race date could not be read, so paces come from your training." };
  }
  if (age < 0) return { value: null, status: "none", date: null, note: "The race result is dated in the future, so it was ignored." };
  if (age > RESULT_MAX_AGE_DAYS) {
    return { value: null, status: "none", date: null, note: "Your race result is over a year old, so paces come from your recent training instead." };
  }
  let vdot: number;
  try {
    vdot = computeVdot(r.distanceM, r.timeS);
  } catch {
    return { value: null, status: "none", date: null, note: "That race time is outside the range the pace model supports." };
  }
  if (!isVdotInRange(vdot)) {
    return { value: null, status: "none", date: null, note: "That race time is outside the range the pace model supports." };
  }
  // Results older than 12 weeks still set paces, flagged as estimated (§2.3; D on the split).
  const status: VdotStatus = age <= RESULT_FULL_WEIGHT_DAYS ? (r.kind === "race" ? "race" : "tt") : "estimated";
  const out: MappedProfile["vdot"] & { anchorM?: number; note?: string } = {
    value: vdot,
    status,
    date: r.date,
    anchorM: r.distanceM,
  };
  if (status === "estimated") out.note = "Your race result is more than 12 weeks old, so paces are treated as an estimate.";
  return out;
}

export function mapProfileToPlanInput(profile: Profile, ctx: MapContext): MappedProfile {
  const notes: string[] = [];
  const conservative = ctx.screening === "cleared_conservative";

  let level = effectiveLevel(profile.experienceLevel, deriveLevel(profile));
  if (level !== profile.experienceLevel) {
    notes.push(`Plan level set to ${level} from your running history (it uses the lower of your answer and your history).`);
  }
  if (conservative) {
    level = "beginner";
    notes.push("Using the most conservative settings after your health screen (beginner caps).");
  }

  const v = vdotFromResult(profile, ctx.today);
  if (v.note) notes.push(v.note);

  const generalFitness = profile.goal.type === "general_fitness";
  let raceDate: string;
  let goal: PlanInput["goal"];
  if (profile.goal.type === "race") {
    raceDate = profile.goal.raceDate;
    goal = profile.goal.goalTimeS !== null ? { distance: profile.goal.distance, timeS: profile.goal.goalTimeS } : { distance: profile.goal.distance };
  } else {
    // TODO(engine-general-fitness): replace with the engine's open-ended mode and targetWeeklyMinutes.
    raceDate = addDays(ctx.today, GENERAL_FITNESS_WEEKS * 7 - 1);
    goal = { distance: "10k" };
    notes.push(`General fitness: showing a ${GENERAL_FITNESS_WEEKS}-week base-building block for now.`);
  }

  if (!profile.daysAvailable.includes(profile.longRunDay)) {
    notes.push("Your long-run day is not one of your available days; the long run stays on the day you picked.");
  }

  const input: PlanInput = {
    userId: ctx.userId,
    level,
    runDays: profile.daysAvailable.length,
    longRunDay: profile.longRunDay,
    today: ctx.today,
    raceDate,
    goal,
    currentWeeklyKm: profile.currentWeeklyKm,
    longestRun30d: { km: profile.longestRun30d.km, minutes: profile.longestRun30d.minutes },
    vdotStatus: v.status,
    injuryFlag: profile.injury !== "none" || conservative,
    heavyCrossTraining: isHeavyCrossTraining(profile),
    longRunMode: profile.longRunMode,
    canRun20MinContinuous: profile.canRun20MinContinuous,
    monthsRunning: profile.monthsRunning,
    lockedEvents: lockedEvents(profile),
    // TODO(engine-strength): strength: profile.strength
    // TODO(engine-schedule): daysAvailable: profile.daysAvailable, maxMinutesByDay: profile.maxMinutesByDay
    // TODO(engine-hr): hrMax: profile.hrMax, hrRest: profile.hrRest
  };
  if (v.value !== null) input.vdot = v.value;
  if (v.anchorM !== undefined && v.value !== null) input.vdotAnchorM = v.anchorM;
  if (profile.birthYear !== null) input.age = Number(ctx.today.slice(0, 4)) - profile.birthYear;

  return { input, generalFitness, notes, vdot: { value: v.value, status: v.status, date: v.date } };
}

/** Paces for display (contract PlanResponse.paces), from the same inputs the plan used. */
export function pacesFor(input: PlanInput): Record<string, unknown> {
  try {
    const set = planPaces({
      level: input.level,
      vdotStatus: input.vdotStatus,
      goal: input.goal,
      longestRun30d: input.longestRun30d,
      ...(input.vdot !== undefined ? { vdot: input.vdot } : {}),
    });
    return { ...set } as Record<string, unknown>;
  } catch {
    if (input.vdot !== undefined) {
      try {
        return { ...trainingPaces(input.vdot) } as Record<string, unknown>;
      } catch {
        /* fall through */
      }
    }
    return {};
  }
}
