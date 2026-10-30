/**
 * Onboarding / profile-edit draft. Inputs are nullable while the user is typing; everything is SI
 * (km, s, s/km) and converted only in the input widgets. `profileFromDraft` produces the contract Profile.
 */
import { Profile, type CrossTraining, type HealthScreenResponse, type MeResponse } from "@paceo/contracts";
import type { Alternative, GoalDistance, Level, Units, Weekday } from "@paceo/engine";
import { browserTimeZone } from "../lib/dates";
import { defaultUnits } from "../lib/units";

export type WatchBrand = Profile["watchBrand"];
export type StrengthPrefs = Profile["strength"];
export type Injury = Profile["injury"];

export interface ProfileDraft {
  units: Units;
  timezone: string;
  experienceLevel: Level | null;
  monthsRunning: number | null;
  currentWeeklyKm: number | null;
  longestRunKm: number | null;
  longestRunMinutes: number | null;
  canRun20MinContinuous: boolean | null;
  hasRecentResult: boolean;
  recentResult: { distanceM: number | null; timeS: number | null; date: string; kind: "race" | "time_trial" };
  birthYear: number | null;
  hrMax: number | null;
  hrRest: number | null;
  injury: Injury;
  goalType: "race" | "general_fitness";
  distance: GoalDistance;
  raceDate: string;
  goalTimeS: number | null;
  targetWeeklyMinutes: number | null;
  daysAvailable: Weekday[];
  longRunDay: Weekday;
  maxMinutesByDay: Partial<Record<Weekday, number>>;
  longRunMode: "daniels" | "pfitz";
  strength: StrengthPrefs;
  crossTraining: CrossTraining[];
  watchBrand: WatchBrand | null;
}

export interface HealthDraft {
  /** Q1–Q7, null = unanswered. */
  answers: (boolean | null)[];
  pregnantOrPostpartum: boolean | null;
  recentSeriousInjuryOrSurgery: boolean | null;
  clearanceConfirmed: boolean;
}

export interface WizardDraft {
  version: 1;
  step: number;
  profile: ProfileDraft;
  health: HealthDraft;
  screening: HealthScreenResponse | null;
  connect: { connected: boolean; skipped: boolean };
  appliedAlternative: string | null;
}

export function emptyHealth(): HealthDraft {
  return {
    answers: [null, null, null, null, null, null, null],
    pregnantOrPostpartum: null,
    recentSeriousInjuryOrSurgery: null,
    clearanceConfirmed: false,
  };
}

export function defaultProfileDraft(): ProfileDraft {
  return {
    units: defaultUnits(),
    timezone: browserTimeZone(),
    experienceLevel: null,
    monthsRunning: null,
    currentWeeklyKm: null,
    longestRunKm: null,
    longestRunMinutes: null,
    canRun20MinContinuous: null,
    hasRecentResult: false,
    recentResult: { distanceM: 5000, timeS: null, date: "", kind: "race" },
    birthYear: null,
    hrMax: null,
    hrRest: null,
    injury: "none",
    goalType: "race",
    distance: "10k",
    raceDate: "",
    goalTimeS: null,
    targetWeeklyMinutes: null,
    daysAvailable: ["tue", "thu", "sat", "sun"],
    longRunDay: "sun",
    maxMinutesByDay: {},
    longRunMode: "daniels",
    // §2.3 / §9.2 defaults: running-focused, bodyweight, 2/week, no lifting experience.
    strength: { mode: "running", equipment: "bodyweight", sessionsPerWeek: 2, liftingExperience: "none" },
    crossTraining: [],
    watchBrand: null,
  };
}

export function draftFromProfile(p: Profile): ProfileDraft {
  const d = defaultProfileDraft();
  return {
    ...d,
    units: p.units,
    timezone: p.timezone,
    experienceLevel: p.experienceLevel,
    monthsRunning: p.monthsRunning,
    currentWeeklyKm: p.currentWeeklyKm,
    longestRunKm: p.longestRun30d.km,
    longestRunMinutes: p.longestRun30d.minutes,
    canRun20MinContinuous: p.canRun20MinContinuous,
    hasRecentResult: p.recentResult !== null,
    recentResult: p.recentResult
      ? { distanceM: p.recentResult.distanceM, timeS: p.recentResult.timeS, date: p.recentResult.date, kind: p.recentResult.kind }
      : d.recentResult,
    birthYear: p.birthYear,
    hrMax: p.hrMax,
    hrRest: p.hrRest,
    injury: p.injury,
    goalType: p.goal.type,
    distance: p.goal.type === "race" ? p.goal.distance : d.distance,
    raceDate: p.goal.type === "race" ? p.goal.raceDate : "",
    goalTimeS: p.goal.type === "race" ? p.goal.goalTimeS : null,
    targetWeeklyMinutes: p.goal.type === "general_fitness" ? p.goal.targetWeeklyMinutes : null,
    daysAvailable: [...p.daysAvailable],
    longRunDay: p.longRunDay,
    maxMinutesByDay: { ...p.maxMinutesByDay },
    longRunMode: p.longRunMode,
    strength: { ...p.strength },
    crossTraining: p.crossTraining.map((c) => ({ ...c, days: [...c.days] })),
    watchBrand: p.watchBrand,
  };
}

export function initialDraft(me: MeResponse | undefined): WizardDraft {
  return {
    version: 1,
    step: 0,
    profile: me?.profile ? draftFromProfile(me.profile) : defaultProfileDraft(),
    health: emptyHealth(),
    screening: me?.screening ?? null,
    connect: { connected: Boolean(me?.connection?.connected), skipped: false },
    appliedAlternative: null,
  };
}

/** Build the contract Profile, or the zod issues explaining why it isn't valid yet. */
export function profileFromDraft(d: ProfileDraft):
  | { ok: true; profile: Profile }
  | { ok: false; issues: { path: (string | number)[]; message: string }[] } {
  const candidate = {
    units: d.units,
    timezone: d.timezone,
    experienceLevel: d.experienceLevel,
    monthsRunning: d.monthsRunning,
    currentWeeklyKm: d.currentWeeklyKm === null ? null : round(d.currentWeeklyKm, 1),
    longestRun30d: {
      km: d.longestRunKm === null ? null : round(d.longestRunKm, 2),
      minutes: d.longestRunMinutes,
    },
    canRun20MinContinuous: d.canRun20MinContinuous,
    recentResult:
      d.hasRecentResult && d.recentResult.distanceM !== null && d.recentResult.timeS !== null
        ? { distanceM: d.recentResult.distanceM, timeS: d.recentResult.timeS, date: d.recentResult.date, kind: d.recentResult.kind }
        : null,
    birthYear: d.birthYear,
    hrMax: d.hrMax,
    hrRest: d.hrRest,
    injury: d.injury,
    goal:
      d.goalType === "race"
        ? { type: "race", distance: d.distance, raceDate: d.raceDate, goalTimeS: d.goalTimeS }
        : { type: "general_fitness", targetWeeklyMinutes: d.targetWeeklyMinutes },
    daysAvailable: d.daysAvailable,
    longRunDay: d.longRunDay,
    maxMinutesByDay: Object.fromEntries(
      Object.entries(d.maxMinutesByDay).filter(([k, v]) => v !== undefined && d.daysAvailable.includes(k as Weekday)),
    ),
    longRunMode: d.longRunMode,
    strength: d.strength,
    crossTraining: d.crossTraining,
    watchBrand: d.watchBrand ?? "other",
  };
  const r = Profile.safeParse(candidate);
  if (r.success) return { ok: true, profile: r.data };
  return { ok: false, issues: r.error.issues.map((i) => ({ path: i.path, message: i.message })) };
}

function round(x: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(x * f) / f;
}

/** Apply a ranked feasibility alternative (§6.2) to the draft. */
export function applyAlternative(d: ProfileDraft, a: Alternative): ProfileDraft {
  switch (a.kind) {
    case "later_date":
      return a.raceDate ? { ...d, goalType: "race", raceDate: a.raceDate } : d;
    case "shorter_distance":
      return a.distance ? { ...d, goalType: "race", distance: a.distance } : d;
    case "finish_goal":
      return { ...d, goalTimeS: null };
    case "slower_goal":
      return a.goalTimeS ? { ...d, goalTimeS: a.goalTimeS } : d;
    case "base_block":
      return { ...d, goalType: "general_fitness", targetWeeklyMinutes: null };
    default:
      return d;
  }
}

export function screeningRequest(h: HealthDraft) {
  return {
    answers: h.answers.map((a) => a === true),
    pregnantOrPostpartum: h.pregnantOrPostpartum === true,
    recentSeriousInjuryOrSurgery: h.recentSeriousInjuryOrSurgery === true,
    clearanceConfirmed: h.clearanceConfirmed,
  };
}
