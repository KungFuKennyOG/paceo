/**
 * Training paces from VDOT (spec §4.1).
 * All paces are seconds per km (SI). Ranges are { fast, slow } where fast < slow numerically.
 */
import {
  computeVdot,
  DISTANCES_M,
  isVdotInRange,
  paceAtFraction,
  raceTimeS,
  VdotRangeError,
} from "./vdot.js";

export interface PaceRange {
  /** Faster bound, s/km (smaller number). */
  fast: number;
  /** Slower bound, s/km (larger number). */
  slow: number;
}

/** Zone fractions of VDOT (spec §4.1 zone table, C). */
export const ZONE_FRACTIONS = {
  E: { slow: 0.59, fast: 0.74 },
  M: { slow: 0.75, fast: 0.84 },
  T: { slow: 0.83, fast: 0.88 },
  I: { slow: 0.95, fast: 1.0 },
} as const;

/** %HRmax bands paired with the zones (spec §4.1, C). Use one set consistently. */
export const ZONE_HR_PCT_MAX = {
  E: { lo: 65, hi: 79 },
  M: { lo: 80, hi: 90 },
  T: { lo: 88, hi: 92 },
  I: { lo: 98, hi: 100 },
} as const;

/** Aggressive-goal flag threshold in VDOT points (spec §4.1 / §6.2, D). */
export const AGGRESSIVE_GOAL_VDOT_DELTA = 1.5;

export interface Goal {
  distanceM: number;
  /** Optional goal time in seconds. */
  timeS?: number;
}

export type MPaceSource = "goal_time" | "race_solution" | "band_fallback";

export interface TrainingPaces {
  vdot: number;
  E: PaceRange;
  /** Marathon pace (s/km) and how it was derived. */
  M: { pace: number; source: MPaceSource };
  /** Band-based M range, kept for display and as the fallback (spec §4.1). */
  mBand: PaceRange;
  T: PaceRange;
  I: PaceRange;
  /** Repetition pace = mile race solution at current VDOT (D). */
  R: number;
  /** Goal pace for the goal race distance, when a goal time is set. */
  goalPace?: number;
  goalVdot?: number;
  /** goalVdot − vdot. */
  goalVdotDelta?: number;
  aggressiveGoal: boolean;
}

function range(vdot: number, f: { slow: number; fast: number }): PaceRange {
  return { fast: paceAtFraction(vdot, f.fast), slow: paceAtFraction(vdot, f.slow) };
}

/**
 * Compute all training paces.
 *
 * M pace priority (spec §4.1, D):
 *  1. goal race is a marathon with a goal time → goal-time pace
 *  2. otherwise → marathon race-time solution at current VDOT
 *  3. band midpoint (79%) only if no race solution is available
 *
 * E/T/I are never re-derived from the goal: an aggressive goal is flagged, not trained for.
 */
export function trainingPaces(vdot: number, goal?: Goal): TrainingPaces {
  if (!isVdotInRange(vdot)) {
    throw new VdotRangeError(`VDOT ${vdot.toFixed(1)} is outside the supported range; use cold start`);
  }

  const marathonS = raceTimeS(vdot, DISTANCES_M.marathon);
  const marathonSolution = marathonS / (DISTANCES_M.marathon / 1000);

  let goalPace: number | undefined;
  let goalVdot: number | undefined;
  if (goal?.timeS !== undefined) {
    goalPace = goal.timeS / (goal.distanceM / 1000);
    goalVdot = computeVdot(goal.distanceM, goal.timeS);
  }

  const isMarathonGoal =
    goal !== undefined && Math.abs(goal.distanceM - DISTANCES_M.marathon) < 1;

  let M: TrainingPaces["M"];
  if (isMarathonGoal && goalPace !== undefined) {
    M = { pace: goalPace, source: "goal_time" };
  } else if (Number.isFinite(marathonSolution)) {
    M = { pace: marathonSolution, source: "race_solution" };
  } else {
    M = { pace: paceAtFraction(vdot, 0.79), source: "band_fallback" };
  }

  const goalVdotDelta = goalVdot !== undefined ? goalVdot - vdot : undefined;

  const result: TrainingPaces = {
    vdot,
    E: range(vdot, ZONE_FRACTIONS.E),
    M,
    mBand: range(vdot, ZONE_FRACTIONS.M),
    T: range(vdot, ZONE_FRACTIONS.T),
    I: range(vdot, ZONE_FRACTIONS.I),
    R: raceTimeS(vdot, DISTANCES_M.mile) / (DISTANCES_M.mile / 1000),
    aggressiveGoal:
      goalVdotDelta !== undefined && goalVdotDelta > AGGRESSIVE_GOAL_VDOT_DELTA,
  };
  if (goalPace !== undefined) result.goalPace = goalPace;
  if (goalVdot !== undefined) result.goalVdot = goalVdot;
  if (goalVdotDelta !== undefined) result.goalVdotDelta = goalVdotDelta;
  return result;
}

/** Percent change in pace for +1 VDOT at a given level (spec §4.1: ~3.0% at 25 … 1.4% at 60). */
export function pacePercentPerVdotPoint(vdot: number): number {
  const now = paceAtFraction(vdot, ZONE_FRACTIONS.T.fast);
  const next = paceAtFraction(vdot + 1, ZONE_FRACTIONS.T.fast);
  return ((now - next) / now) * 100;
}
