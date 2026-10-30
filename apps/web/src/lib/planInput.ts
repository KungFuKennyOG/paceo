/**
 * Profile (contract) → engine PlanInput, for instant client-side previews during onboarding (§2.6).
 * The server's /plan/preview and /plan/generate are authoritative; this mapping is advisory and
 * mirrors the §2.3 derivations closely enough for a preview.
 */
import type { Profile } from "@paceo/contracts";
import {
  checkFeasibility,
  computeVdot,
  generatePlan,
  planPaces,
  trainingPaces,
  type Feasibility,
  type Level,
  type LockedEvent,
  type PaceSet,
  type Plan,
  type PlanInput,
  type TrainingPaces,
} from "@paceo/engine";
import { ageFromBirthYear } from "./dates";

const LEVEL_ORDER: Level[] = ["beginner", "novice", "intermediate", "advanced"];

/** Experience level derivation table (§2.3). */
export function deriveLevel(p: Pick<Profile, "monthsRunning" | "currentWeeklyKm" | "canRun20MinContinuous">): Level {
  if (p.monthsRunning < 3 || !p.canRun20MinContinuous || p.currentWeeklyKm < 10) return "beginner";
  if (p.monthsRunning <= 12) return "novice";
  if (p.monthsRunning > 36 && p.currentWeeklyKm >= 50) return "advanced";
  return "intermediate";
}

/** Engine uses min(self-report, derived) (§2.3). */
export function effectiveLevel(p: Profile): Level {
  const derived = deriveLevel(p);
  const self = p.experienceLevel;
  return LEVEL_ORDER[Math.min(LEVEL_ORDER.indexOf(self), LEVEL_ORDER.indexOf(derived))] ?? "beginner";
}

/** Cross-training above 40% of total load (§6.7 C1). Load = minutes × sRPE; running at an assumed sRPE 4 and 6 min/km (D). */
export function heavyCrossTraining(p: Profile): boolean {
  const xt = p.crossTraining.reduce((sum, c) => sum + c.typicalMinutes * c.typicalSrpe * c.days.length, 0);
  const run = p.currentWeeklyKm * 6 * 4;
  const total = xt + run;
  return total > 0 && xt / total > 0.4;
}

export function lockedEvents(p: Profile): LockedEvent[] {
  return p.crossTraining
    .filter((c) => c.locked)
    .flatMap((c) =>
      c.days.map((weekday) => ({
        weekday,
        activity: c.activity,
        minutes: c.typicalMinutes,
        srpe: c.typicalSrpe,
        hard: c.typicalSrpe >= 7,
      })),
    );
}

export interface VdotInfo {
  vdot: number;
  status: "race" | "tt";
  anchorM: number;
}

export function vdotFromProfile(p: Pick<Profile, "recentResult">): VdotInfo | null {
  const r = p.recentResult;
  if (!r) return null;
  try {
    const vdot = computeVdot(r.distanceM, r.timeS);
    if (!Number.isFinite(vdot)) return null;
    return { vdot, status: r.kind === "race" ? "race" : "tt", anchorM: r.distanceM };
  } catch {
    return null;
  }
}

export type PlanInputResult =
  | { ok: true; input: PlanInput }
  | { ok: false; reason: string };

export function profileToPlanInput(p: Profile, today: string): PlanInputResult {
  if (p.goal.type !== "race") {
    return { ok: false, reason: "General-fitness previews come from the server." };
  }
  const vd = vdotFromProfile(p);
  const input: PlanInput = {
    level: effectiveLevel(p),
    runDays: p.daysAvailable.length,
    longRunDay: p.longRunDay,
    today,
    raceDate: p.goal.raceDate,
    goal: p.goal.goalTimeS ? { distance: p.goal.distance, timeS: p.goal.goalTimeS } : { distance: p.goal.distance },
    currentWeeklyKm: p.currentWeeklyKm,
    longestRun30d: { km: p.longestRun30d.km, minutes: p.longestRun30d.minutes },
    vdotStatus: vd ? vd.status : "none",
    injuryFlag: p.injury !== "none",
    heavyCrossTraining: heavyCrossTraining(p),
    longRunMode: p.longRunMode,
    canRun20MinContinuous: p.canRun20MinContinuous,
    monthsRunning: p.monthsRunning,
    lockedEvents: lockedEvents(p),
  };
  if (vd) {
    input.vdot = vd.vdot;
    input.vdotAnchorM = vd.anchorM;
  }
  if (p.birthYear !== null) input.age = ageFromBirthYear(p.birthYear, today);
  return { ok: true, input };
}

export interface ClientPreview {
  plan: Plan;
  paces: PaceSet;
}

/** Run the engine in the browser. Never throws: engine errors become a reason string. */
export function clientPreview(p: Profile, today: string): { ok: true; preview: ClientPreview } | { ok: false; reason: string } {
  const r = profileToPlanInput(p, today);
  if (!r.ok) return r;
  try {
    const plan = generatePlan(r.input);
    const paceInput: Parameters<typeof planPaces>[0] = {
      level: r.input.level,
      vdotStatus: r.input.vdotStatus,
      goal: r.input.goal,
      longestRun30d: r.input.longestRun30d,
    };
    if (r.input.vdot !== undefined) paceInput.vdot = r.input.vdot;
    return { ok: true, preview: { plan, paces: planPaces(paceInput) } };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : "The preview engine failed." };
  }
}

export function clientFeasibility(p: Profile, today: string): Feasibility | null {
  const r = profileToPlanInput(p, today);
  if (!r.ok) return null;
  try {
    return checkFeasibility(r.input);
  } catch {
    return null;
  }
}

/** Training paces from a race/TT result, for the intervals.icu threshold-pace step (§2.5 step 4). */
export function pacesFromResult(distanceM: number, timeS: number): TrainingPaces | null {
  try {
    return trainingPaces(computeVdot(distanceM, timeS));
  } catch {
    return null;
  }
}
