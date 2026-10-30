/**
 * Contract Profile → engine PlanRequest. This is the ONLY place that knows both shapes, so engine
 * changes land here.
 *
 * Schedule and HR settings map onto the engine's PlanInput.runWeekdays, maxMinutesByDay, hrMax,
 * hrMaxSource and hrRest. (Replans also pass the profile's HRmax/HRrest through FitnessState, see
 * replan-state.ts.)
 */
import {
  computeVdot,
  daysBetween,
  generalFitnessAsRaceInput,
  isGeneralFitness,
  isVdotInRange,
  planPaces,
  trainingPaces,
  type GeneralFitnessInput,
  type Level,
  type LockedEvent,
  type PlanInput,
  type PlanRequest,
  type StrengthConfig,
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
  input: PlanRequest;
  generalFitness: boolean;
  /** User-facing notes about how the profile was interpreted. */
  notes: string[];
  /** VDOT provenance, for fitness_state. */
  vdot: { value: number | null; status: VdotStatus; date: string | null };
}

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

/** Every cross-training entry × each of its days → one engine LockedEvent (§7.1 step 1, §10.2). */
export function lockedEvents(p: Profile): LockedEvent[] {
  const out: LockedEvent[] = [];
  for (const c of p.crossTraining) {
    for (const weekday of c.days) {
      // `hard` is left to the engine's §10.2 classification (sRPE, activity class).
      out.push({ weekday, activity: c.activity, minutes: c.typicalMinutes, srpe: c.typicalSrpe, locked: c.locked, name: c.activity });
    }
  }
  return out;
}

export function strengthConfig(p: Profile): StrengthConfig {
  return {
    mode: p.strength.mode,
    equipment: p.strength.equipment,
    sessionsPerWeek: p.strength.sessionsPerWeek,
    liftingExperience: p.strength.liftingExperience,
  };
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
    notes.push("Using the most conservative settings after your health screen: beginner caps, no plyometrics and no heavy strength work.");
  }

  const v = vdotFromResult(profile, ctx.today);
  if (v.note) notes.push(v.note);

  if (!profile.daysAvailable.includes(profile.longRunDay)) {
    notes.push("Your long-run day is not one of your available days; the long run stays on the day you picked, as an extra run day.");
  }

  const common: Omit<PlanInput, "raceDate" | "goal"> = {
    userId: ctx.userId,
    level,
    runDays: profile.daysAvailable.length,
    longRunDay: profile.longRunDay,
    today: ctx.today,
    currentWeeklyKm: profile.currentWeeklyKm,
    longestRun30d: { km: profile.longestRun30d.km, minutes: profile.longestRun30d.minutes },
    vdotStatus: v.status,
    injuryFlag: profile.injury !== "none" || conservative,
    // No history yet: false. buildPlan re-runs with true when the planned weeks show cross-training
    // above 40% of total load (§6.7 C1).
    heavyCrossTraining: false,
    longRunMode: profile.longRunMode,
    canRun20MinContinuous: profile.canRun20MinContinuous,
    monthsRunning: profile.monthsRunning,
    lockedEvents: lockedEvents(profile),
    strength: strengthConfig(profile),
    conservative,
    // Runs only on the available days (the engine adds the long-run day if it isn't one of them).
    runWeekdays: profile.daysAvailable,
    // §7.1 step 4: only days with a cap; {} = none.
    maxMinutesByDay: profile.maxMinutesByDay,
  };
  // HR settings (exactOptionalPropertyTypes: set only when known). A profile HRmax counts as measured
  // (replan-state.ts makes the same call); without one, the engine uses Tanaka from the age, and
  // beginners then get no HR cap (§6.9 needs a measured HRmax).
  if (profile.hrMax !== null) {
    common.hrMax = profile.hrMax;
    common.hrMaxSource = "measured";
  } else if (profile.birthYear !== null) {
    common.hrMaxSource = "age_formula";
  }
  if (profile.hrRest !== null) common.hrRest = profile.hrRest;
  if (v.value !== null) common.vdot = v.value;
  if (v.anchorM !== undefined && v.value !== null) common.vdotAnchorM = v.anchorM;
  if (profile.birthYear !== null) common.age = Number(ctx.today.slice(0, 4)) - profile.birthYear;

  const generalFitness = profile.goal.type === "general_fitness";
  let input: PlanRequest;
  if (profile.goal.type === "race") {
    const goal: PlanInput["goal"] =
      profile.goal.goalTimeS !== null
        ? { type: "race", distance: profile.goal.distance, timeS: profile.goal.goalTimeS }
        : { type: "race", distance: profile.goal.distance };
    input = { ...common, raceDate: profile.goal.raceDate, goal };
  } else {
    const goal: GeneralFitnessInput["goal"] = { type: "general_fitness" };
    if (profile.goal.targetWeeklyMinutes !== null) goal.targetWeeklyMinutes = profile.goal.targetWeeklyMinutes;
    input = { ...common, goal };
  }

  return { input, generalFitness, notes, vdot: { value: v.value, status: v.status, date: v.date } };
}

/** Paces for display (contract PlanResponse.paces), from the same inputs the plan used. */
export function pacesFor(request: PlanRequest): Record<string, unknown> {
  const input = isGeneralFitness(request) ? generalFitnessAsRaceInput(request) : request;
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
