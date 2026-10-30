/**
 * Load model (spec §10.1, D on E): two channels, never merged.
 *  - running_km: runs only (run/walk by distance run). Drives V1, V2, L1/L2, taper, R-PAIN caps.
 *  - total_load: AU = sRPE (CR-10) × minutes, for runs, strength and cross-training. Drives R-LOAD
 *    trims, cutback frequency and monotony/strain display. Session-RPE works across modalities
 *    (Haddad 2017, E) and for resistance training (Day 2004, E).
 *  - lower_body_load (optional, D): lower strength, plyo contacts, runs and lower-dominant cross-training.
 * Cross-training never adds running km and never unlocks running progression (§10.2).
 */
import type { PlanWeek } from "./plan-types.js";
import type { PlannedWorkout } from "./workout.js";
import type { CrossTrainingSession, LowerBodyLoad } from "./cross-training.js";
import { isLowerStrength, plyoContactsOf } from "./strength.js";

/** Session load in AU (§10.1). */
export function sessionLoad(srpe: number, minutes: number): number {
  return srpe * minutes;
}

/** Share of a cross-training session's AU counted as lower-body load, by the §10.2 column (D). */
export const LOWER_BODY_SHARE: Record<LowerBodyLoad, number> = { none: 0, low: 0, moderate: 0.5, yes: 1 };

/** Cross-training share of total_load above which C1 calls for 2:1 cutbacks (§6.7, D). */
export const HEAVY_CROSS_TRAINING_SHARE = 0.4;

export interface WeeklyLoad {
  /** Channel 1: running km, all runs including a race. */
  runningKm: number;
  runningMinutes: number;
  /** Channel 2: total_load in AU (sRPE × minutes) across runs, strength and cross-training. */
  totalLoad: number;
  byKind: { run: number; strength: number; crossTraining: number };
  /** Cross-training share of total_load, 0–1 (feeds the §6.7 "> 40%" 2:1 trigger). */
  crossTrainingShare: number;
  /** AU from runs, lower/full strength and lower-dominant cross-training (D weighting). */
  lowerBodyLoad: number;
  plyoContacts: number;
  /** Key sessions toward the weekly cap of 3 (§6.4): key runs (race excluded) + ½ per hard cross-training day. */
  keySessions: number;
}

function workoutLoad(w: PlannedWorkout): number {
  return sessionLoad(w.planned.expected_srpe, w.planned.minutes);
}

/** Both load channels for a plan week (planned values; logs replace them once sessions are done). */
export function weeklyLoad(week: Pick<PlanWeek, "workouts" | "crossTraining">): WeeklyLoad {
  const runs = week.workouts.filter((w) => w.sport === "run");
  const strength = week.workouts.filter((w) => w.sport === "strength");
  const xt: readonly CrossTrainingSession[] = week.crossTraining ?? [];

  const run = runs.reduce((a, w) => a + workoutLoad(w), 0);
  const str = strength.reduce((a, w) => a + workoutLoad(w), 0);
  const cross = xt.reduce((a, x) => a + x.load, 0);
  const total = run + str + cross;

  const lower =
    run +
    strength.filter((w) => isLowerStrength(w)).reduce((a, w) => a + workoutLoad(w), 0) +
    xt.reduce((a, x) => a + x.load * LOWER_BODY_SHARE[x.lowerBody], 0);

  return {
    runningKm: round1(runs.reduce((a, w) => a + w.planned.run_m, 0) / 1000),
    runningMinutes: round1(runs.reduce((a, w) => a + w.planned.minutes, 0)),
    totalLoad: Math.round(total),
    byKind: { run: Math.round(run), strength: Math.round(str), crossTraining: Math.round(cross) },
    crossTrainingShare: total > 0 ? round2(cross / total) : 0,
    lowerBodyLoad: Math.round(lower),
    plyoContacts: strength.reduce((a, w) => a + plyoContactsOf(w), 0),
    keySessions:
      runs.filter((w) => w.flags.key_session && w.type !== "RACE").length + xt.reduce((a, x) => a + x.keyCost, 0),
  };
}

function round1(x: number): number {
  return Math.round(x * 10) / 10;
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}
