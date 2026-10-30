/**
 * Profile (contract) → engine PlanInput, for instant client-side previews during onboarding (§2.6).
 * The server's /plan/preview and /plan/generate are authoritative; this mapping is advisory and
 * mirrors the §2.3 derivations closely enough for a preview.
 */
import type { Profile } from "@paceo/contracts";
import {
  checkFeasibility,
  computeVdot,
  generalFitnessAsRaceInput,
  generatePlan,
  isGeneralFitness,
  planPaces,
  trainingPaces,
  type Feasibility,
  type GeneralFitnessInput,
  type Level,
  type LockedEvent,
  type PaceSet,
  type Plan,
  type PlanInput,
  type PlanRequest,
  type StrengthConfig,
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

/** Every cross-training entry, per weekday (§10.2). Flexible ones are passed with locked=false. */
export function lockedEvents(p: Profile): LockedEvent[] {
  return p.crossTraining.flatMap((c) =>
    c.days.map((weekday) => ({
      weekday,
      activity: c.activity,
      minutes: c.typicalMinutes,
      srpe: c.typicalSrpe,
      locked: c.locked,
    })),
  );
}

export function strengthConfig(p: Profile): StrengthConfig {
  return {
    mode: p.strength.mode,
    equipment: p.strength.equipment,
    sessionsPerWeek: p.strength.mode === "off" ? 0 : p.strength.sessionsPerWeek,
    liftingExperience: p.strength.liftingExperience,
  };
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
  | { ok: true; input: PlanRequest }
  | { ok: false; reason: string };

export interface PlanInputOptions {
  /** Screening outcome "cleared_conservative" (§2.4): no plyometrics, no heavy strength. */
  conservative?: boolean;
}

export function profileToPlanInput(p: Profile, today: string, opts: PlanInputOptions = {}): PlanInputResult {
  const vd = vdotFromProfile(p);
  const base: Omit<PlanInput, "raceDate" | "goal"> = {
    level: effectiveLevel(p),
    runDays: p.daysAvailable.length,
    longRunDay: p.longRunDay,
    today,
    currentWeeklyKm: p.currentWeeklyKm,
    longestRun30d: { km: p.longestRun30d.km, minutes: p.longestRun30d.minutes },
    vdotStatus: vd ? vd.status : "none",
    injuryFlag: p.injury !== "none",
    heavyCrossTraining: heavyCrossTraining(p),
    longRunMode: p.longRunMode,
    canRun20MinContinuous: p.canRun20MinContinuous,
    monthsRunning: p.monthsRunning,
    lockedEvents: lockedEvents(p),
    strength: strengthConfig(p),
    conservative: opts.conservative ?? false,
  };
  if (vd) {
    base.vdot = vd.vdot;
    base.vdotAnchorM = vd.anchorM;
  }
  if (p.birthYear !== null) base.age = ageFromBirthYear(p.birthYear, today);
  if (p.goal.type === "general_fitness") {
    const gf: GeneralFitnessInput = { ...base, goal: { type: "general_fitness" } };
    if (p.goal.targetWeeklyMinutes !== null) gf.goal.targetWeeklyMinutes = p.goal.targetWeeklyMinutes;
    return { ok: true, input: gf };
  }
  const input: PlanInput = {
    ...base,
    raceDate: p.goal.raceDate,
    goal: p.goal.goalTimeS ? { distance: p.goal.distance, timeS: p.goal.goalTimeS } : { distance: p.goal.distance },
  };
  return { ok: true, input };
}

/** The race-shaped input used for paces and feasibility (general fitness maps onto its reference distance). */
export function raceShaped(input: PlanRequest): PlanInput {
  return isGeneralFitness(input) ? generalFitnessAsRaceInput(input) : input;
}

export interface ClientPreview {
  plan: Plan;
  paces: PaceSet;
}

/** Run the engine in the browser. Never throws: engine errors become a reason string. */
export function clientPreview(
  p: Profile,
  today: string,
  opts: PlanInputOptions = {},
): { ok: true; preview: ClientPreview } | { ok: false; reason: string } {
  const r = profileToPlanInput(p, today, opts);
  if (!r.ok) return r;
  try {
    const plan = generatePlan(r.input);
    const race = raceShaped(r.input);
    const paceInput: Parameters<typeof planPaces>[0] = {
      level: race.level,
      vdotStatus: race.vdotStatus,
      goal: { distance: race.goal.distance, ...(race.goal.timeS !== undefined ? { timeS: race.goal.timeS } : {}) },
      longestRun30d: race.longestRun30d,
    };
    if (race.vdot !== undefined) paceInput.vdot = race.vdot;
    return { ok: true, preview: { plan, paces: planPaces(paceInput) } };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : "The preview engine failed." };
  }
}

/** Race mode: the §6.2 checks alone (fast). General fitness: the plan's own feasibility. */
export function clientFeasibility(p: Profile, today: string, opts: PlanInputOptions = {}): Feasibility | null {
  const r = profileToPlanInput(p, today, opts);
  if (!r.ok) return null;
  try {
    return isGeneralFitness(r.input) ? generatePlan(r.input).feasibility : checkFeasibility(r.input);
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
