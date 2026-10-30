/** Per-step validation for the onboarding wizard (§2.3 table). Pure: returns field → message. */
import type { FeasibilityStatus } from "@paceo/engine";
import { ageFromBirthYear } from "../lib/dates";
import type { WizardDraft } from "./draft";

export const STEP_IDS = ["health", "connect", "profile", "goal", "schedule", "strength", "cross", "review", "preview"] as const;
export type StepId = (typeof STEP_IDS)[number];

export const STEP_TITLES: Record<StepId, string> = {
  health: "Health check",
  connect: "Connect your watch",
  profile: "About your running",
  goal: "Your goal",
  schedule: "Your week",
  strength: "Strength",
  cross: "Cross-training",
  review: "Goal check",
  preview: "Your plan",
};

export type StepErrors = Record<string, string>;

export interface ValidationContext {
  today: string;
  /** Feasibility status shown on the review step (server result when available, else client). */
  feasibilityStatus?: FeasibilityStatus | null;
}

const between = (v: number | null, lo: number, hi: number) => v !== null && Number.isFinite(v) && v >= lo && v <= hi;

export function validateStep(step: StepId, d: WizardDraft, ctx: ValidationContext): StepErrors {
  const e: StepErrors = {};
  const p = d.profile;
  switch (step) {
    case "health": {
      const all = [...d.health.answers, d.health.pregnantOrPostpartum, d.health.recentSeriousInjuryOrSurgery];
      if (all.some((a) => a === null)) e.answers = "Answer every question.";
      else if (!d.screening) e.screening = "Submit your answers to continue.";
      else if (!d.screening.canProceed) e.screening = "Confirm professional clearance to continue.";
      break;
    }
    case "connect":
      if (!p.watchBrand) e.watchBrand = "Pick your watch brand.";
      if (!d.connect.connected && !d.connect.skipped) e.connection = "Connect intervals.icu, or skip and upload FIT files instead.";
      break;
    case "profile": {
      if (!p.experienceLevel) e.experienceLevel = "Pick your experience level.";
      if (!between(p.monthsRunning, 0, 600) || (p.monthsRunning !== null && !Number.isInteger(p.monthsRunning))) {
        e.monthsRunning = "Enter whole months, 0–600.";
      }
      if (!between(p.currentWeeklyKm, 0, 250)) e.currentWeeklyKm = "Enter your weekly volume (up to 250 km / 155 mi).";
      if (!between(p.longestRunKm, 0, 45)) e.longestRunKm = "Enter your longest run in the last 30 days (up to 45 km / 28 mi).";
      else if (p.currentWeeklyKm !== null && p.longestRunKm !== null && p.longestRunKm > p.currentWeeklyKm + 0.05) {
        e.longestRunKm = "Your longest run can't be more than your weekly volume.";
      }
      if (!between(p.longestRunMinutes, 0, 400)) e.longestRunMinutes = "Enter how long that run took, in minutes.";
      if (p.canRun20MinContinuous === null) e.canRun20MinContinuous = "Answer this one.";
      if (p.hasRecentResult) {
        const r = p.recentResult;
        if (!between(r.distanceM, 1500, 42195)) e.recentDistance = "Distance must be between 1,500 m and a marathon.";
        if (r.timeS === null || !(r.timeS > 0)) e.recentTime = "Enter your time as h:mm:ss or mm:ss.";
        if (!/^\d{4}-\d{2}-\d{2}$/.test(r.date)) e.recentDate = "Enter the date.";
        else if (r.date > ctx.today) e.recentDate = "That date is in the future.";
      }
      if (p.birthYear !== null) {
        if (!between(p.birthYear, 1930, 2015) || !Number.isInteger(p.birthYear)) e.birthYear = "Enter a birth year between 1930 and 2015.";
        else if (ageFromBirthYear(p.birthYear, ctx.today) < 18) e.birthYear = "Paceo is for adults (18+) for now.";
      }
      if (p.hrMax !== null && !between(p.hrMax, 140, 220)) e.hrMax = "Max HR must be 140–220 bpm.";
      if (p.hrRest !== null && !between(p.hrRest, 30, 100)) e.hrRest = "Resting HR must be 30–100 bpm.";
      break;
    }
    case "goal":
      if (p.goalType === "race") {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(p.raceDate)) e.raceDate = "Pick your race date.";
        else if (p.raceDate <= ctx.today) e.raceDate = "The race date must be in the future.";
        if (p.goalTimeS !== null && !(p.goalTimeS > 0)) e.goalTimeS = "Enter a goal time like 1:45:00, or leave it empty.";
      } else if (p.targetWeeklyMinutes !== null && !between(p.targetWeeklyMinutes, 60, 600)) {
        e.targetWeeklyMinutes = "Weekly time must be 60–600 minutes, or leave it empty.";
      }
      break;
    case "schedule": {
      const n = p.daysAvailable.length;
      const min = p.goalType === "race" ? 3 : 2;
      if (n < min) e.daysAvailable = `Pick at least ${min} days${p.goalType === "race" ? " for a race plan" : ""}.`;
      if (!p.daysAvailable.includes(p.longRunDay)) e.longRunDay = "Your long-run day must be one of your running days.";
      for (const [day, mins] of Object.entries(p.maxMinutesByDay)) {
        if (mins !== undefined && mins < 20) e[`max_${day}`] = "Daily limits must be at least 20 minutes.";
      }
      break;
    }
    case "strength": {
      const s = p.strength;
      if (!Number.isInteger(s.sessionsPerWeek) || s.sessionsPerWeek < 0 || s.sessionsPerWeek > 3) e.sessionsPerWeek = "Choose 0–3 sessions.";
      break;
    }
    case "cross":
      if (p.crossTraining.length > 10) e.crossTraining = "Up to 10 activities.";
      p.crossTraining.forEach((c, i) => {
        if (!c.activity.trim() || c.activity.length > 40) e[`xt_${i}_activity`] = "Name the activity.";
        if (c.days.length === 0) e[`xt_${i}_days`] = "Pick at least one day.";
        if (!between(c.typicalMinutes, 5, 600) || !Number.isInteger(c.typicalMinutes)) e[`xt_${i}_minutes`] = "Minutes must be 5–600.";
        if (!between(c.typicalSrpe, 1, 10)) e[`xt_${i}_srpe`] = "Effort must be 1–10.";
      });
      break;
    case "review":
      if (ctx.feasibilityStatus === "block") e.feasibility = "This goal is blocked. Pick an option or change your goal.";
      break;
    case "preview":
      break;
  }
  return e;
}

export function isStepValid(step: StepId, d: WizardDraft, ctx: ValidationContext): boolean {
  return Object.keys(validateStep(step, d, ctx)).length === 0;
}
