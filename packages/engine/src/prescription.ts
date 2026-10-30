/**
 * Plan pace set and prescription mode (spec §4.1, §4.2, §6.6).
 * Every zone is a PaceRange in s/km (fast < slow). In time/RPE mode the ranges are only used to
 * estimate distance; the athlete sees minutes and RPE.
 */
import type { GoalDistance, Level, VdotStatus } from "./plan-types.js";
import { GOAL_DISTANCE_M } from "./plan-types.js";
import { trainingPaces, ZONE_FRACTIONS, type PaceRange } from "./paces.js";
import {
  clamp,
  DISTANCES_M,
  paceAtFraction,
  raceTimeS,
  VDOT_MAX,
  VDOT_MIN,
} from "./vdot.js";

export interface PaceSet {
  vdot: number;
  /**
   * "vdot" = from a race/TT/estimate the user gave. "longest_run" = no VDOT yet (§4.2 path C):
   * an estimation-only VDOT whose easy pace matches the entered longest run (see estimationVdotFromRun).
   */
  source: "vdot" | "longest_run";
  E: PaceRange;
  /** Long-run pace (§6.6). */
  LR: PaceRange;
  /** Slower than E (§6.10 recovery). */
  REC: PaceRange;
  T: PaceRange;
  I: PaceRange;
  R: PaceRange;
  /** Marathon pace (goal-time pace for a marathon goal, else race solution; §4.1). */
  M: PaceRange;
  /** Goal pace for the goal distance: goal time if set, else the race solution at current VDOT. */
  GP: PaceRange;
  /** Half-marathon pace (GP for a half goal, else the race solution) for fast-finish long runs (§6.10). */
  HM: PaceRange;
  /** True when GP comes from a goal time. */
  hasGoalTime: boolean;
}

/** Width of a single-pace target (M, GP, R) on the watch: ±1.5% (D). */
const POINT_PACE_TOLERANCE = 0.015;
/** Long-run sub-band for non-marathon plans: 65–74% VDOT (§6.6). */
const LR_FRACTIONS = { fast: 0.74, slow: 0.65 } as const;
/** Marathon LR = MP + 10–20% (Pfitzinger, §6.6). */
const LR_MP_FACTORS = { fast: 1.1, slow: 1.2 } as const;
/** Recovery runs: from the slow end of E to 8% slower (D). */
const RECOVERY_SLOWDOWN = 1.08;

function around(pace: number): PaceRange {
  return { fast: pace * (1 - POINT_PACE_TOLERANCE), slow: pace * (1 + POINT_PACE_TOLERANCE) };
}

export function midPace(r: PaceRange): number {
  return (r.fast + r.slow) / 2;
}

/**
 * VDOT used only to turn minutes into estimated km when there is no VDOT yet (vdot_status "none").
 * Such users are prescribed by time and RPE (§4.2 path C, §6.6), so no pace target ever comes from it.
 * It is chosen so that the midpoint of the E band equals the average pace of the entered longest run,
 * which is an easy/long effort by definition (D).
 *
 * Not the §4.2 path-B formula (VO2(v)/0.78 − 1): that one is deliberately conservative for pace
 * targets and puts E ~5–15% slower than the runner's own easy pace, which made every minutes → km
 * estimate too short (persona A: 20.7 → E 9:41–11:23/km vs a 9:00/km long run). Path B is for users
 * with vdot_status "estimated", who pass that VDOT in.
 * Persona A check: 5 km in 45 min → ≈ 25.6, close to the 24.8 from A's 3K time trial (§4.3).
 */
export function estimationVdotFromRun(km: number, minutes: number): number {
  if (!(km > 0) || !(minutes > 0)) return VDOT_MIN;
  const target = (minutes * 60) / km;
  const eMid = (v: number) => (paceAtFraction(v, ZONE_FRACTIONS.E.fast) + paceAtFraction(v, ZONE_FRACTIONS.E.slow)) / 2;
  let lo = VDOT_MIN;
  let hi = VDOT_MAX;
  if (eMid(lo) <= target) return lo;
  if (eMid(hi) >= target) return hi;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (eMid(mid) > target) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

export interface PaceSetInput {
  /** Beginners run long runs at plain E / RPE 3–4 (§6.6). */
  level?: Level;
  vdot?: number;
  vdotStatus: VdotStatus;
  goal: { distance: GoalDistance; timeS?: number };
  longestRun30d: { km: number; minutes: number };
}

export function planPaces(input: PaceSetInput): PaceSet {
  const hasVdot = input.vdot !== undefined && input.vdotStatus !== "none";
  const vdot = hasVdot
    ? clamp(input.vdot as number, VDOT_MIN, VDOT_MAX)
    : estimationVdotFromRun(input.longestRun30d.km, input.longestRun30d.minutes);
  const goalM = GOAL_DISTANCE_M[input.goal.distance];
  const goal = input.goal.timeS !== undefined ? { distanceM: goalM, timeS: input.goal.timeS } : undefined;
  const p = trainingPaces(vdot, goal);

  const gp = p.goalPace ?? raceTimeS(vdot, goalM) / (goalM / 1000);
  const lr: PaceRange =
    input.level === "beginner"
      ? p.E
      : input.goal.distance === "marathon"
      ? {
          // never faster than the fast end of E (§6.6)
          fast: Math.max(p.E.fast, p.M.pace * LR_MP_FACTORS.fast),
          slow: Math.max(p.E.fast, p.M.pace * LR_MP_FACTORS.slow),
        }
      : { fast: paceAtFraction(vdot, LR_FRACTIONS.fast), slow: paceAtFraction(vdot, LR_FRACTIONS.slow) };

  return {
    vdot,
    source: hasVdot ? "vdot" : "longest_run",
    E: p.E,
    LR: lr,
    REC: { fast: p.E.slow, slow: p.E.slow * RECOVERY_SLOWDOWN },
    T: p.T,
    I: p.I,
    R: around(p.R),
    M: around(p.M.pace),
    GP: around(gp),
    HM: around(
      input.goal.distance === "half" ? gp : raceTimeS(vdot, DISTANCES_M.half) / (DISTANCES_M.half / 1000),
    ),
    hasGoalTime: p.goalPace !== undefined,
  };
}

export type DurationBy = "time" | "distance";

export interface Prescription {
  mode: "pace" | "time_rpe";
  easyBy: DurationBy;
  longBy: DurationBy;
  /** "rule" = distance reps when the rep duration fits the window, else time reps (§6.6). */
  repsBy: "time" | "rule";
  rule: string;
}

/** E pace slower than 7:30/km switches to time-based prescriptions (§6.6). Compared at the E midpoint (D). */
export const SLOW_E_PACE_S_PER_KM = 450;

/** Prescription mode table (§6.6, D). */
export function prescriptionFor(level: Level, vdotStatus: VdotStatus, paces: PaceSet): Prescription {
  if (level === "beginner" || vdotStatus === "none" || vdotStatus === "estimated") {
    return { mode: "time_rpe", easyBy: "time", longBy: "time", repsBy: "time", rule: `PM:time_rpe(${level},${vdotStatus})` };
  }
  if (level === "novice" || midPace(paces.E) > SLOW_E_PACE_S_PER_KM) {
    return { mode: "pace", easyBy: "time", longBy: "time", repsBy: "time", rule: "PM:minutes" };
  }
  if (level === "intermediate") {
    return { mode: "pace", easyBy: "time", longBy: "distance", repsBy: "rule", rule: "PM:intermediate" };
  }
  return { mode: "pace", easyBy: "distance", longBy: "distance", repsBy: "rule", rule: "PM:km" };
}
