/**
 * Quality count (spec §6.4 I2, C/D) and phase emphasis (§6.3 P3, C).
 * "Quality" = T, I, R, hills, an M/GP block ≥ 20 min, or an LR with M / fast-finish content.
 * Strides are not quality. Never more than 3 key sessions a week, counting the LR (C).
 */
import type { GoalDistance, Level, LockedEvent, Phase, VdotStatus } from "./plan-types.js";
import { classifyEvent, HARD_XT_KEY_COST } from "./cross-training.js";

export const MAX_KEY_SESSIONS = 3;
/** A hard cross-training session costs half a key session (§6.4, D). */
export const HARD_CROSS_TRAINING_KEY_COST = HARD_XT_KEY_COST;

/** When the long run itself may carry M / fast-finish work (I2 + L3). */
export type QualityLongRun = "never" | "alternate" | "alternate_from_TQ";

export interface QualityAllowance {
  /** Quality runs in every quality week (LR excluded). */
  base: number;
  /** Extra quality run allowed only in weeks whose LR is easy (intermediate 4–5 days). */
  extraIfEasyLR: number;
  qualityLR: QualityLongRun;
  rule: string;
}

function daysBucket(runDays: number): "2-3" | "4" | "5" | "6-7" {
  if (runDays <= 3) return "2-3";
  if (runDays === 4) return "4";
  if (runDays === 5) return "5";
  return "6-7";
}

/** The I2 matrix. `monthsRunning` gates the novice 6–7-day second quality (> 6 months). */
export function qualityAllowance(level: Level, runDays: number, monthsRunning: number): QualityAllowance {
  const d = daysBucket(runDays);
  const rule = `I2:${level}:${d}d`;
  const a = (base: number, qualityLR: QualityLongRun, extraIfEasyLR = 0): QualityAllowance => ({
    base,
    extraIfEasyLR,
    qualityLR,
    rule,
  });
  switch (level) {
    case "beginner":
      // 2–3 days: strides only. 4–5 days: one short T/fartlek by RPE after graduation (ladder weeks
      // never carry quality, so "after graduation" holds by construction). Capped at 4 days.
      return a(d === "2-3" ? 0 : 1, "never");
    case "novice":
      if (d === "2-3" || d === "4") return a(1, "never");
      if (d === "5") return a(1, "alternate_from_TQ");
      return a(monthsRunning > 6 ? 2 : 1, "alternate_from_TQ");
    case "intermediate":
      if (d === "2-3") return a(1, "never");
      if (d === "4" || d === "5") return a(1, "alternate", 1);
      return a(2, "alternate");
    case "advanced":
      if (d === "2-3") return a(1, "alternate");
      if (d === "4") return a(2, "never");
      return a(2, "alternate");
  }
}

/**
 * Key sessions left for quality runs after the LR and hard cross-training (§6.4): each hard
 * cross-training day (§10.2) costs ½, so persona B's hard paddle leaves 1 quality run (Q + LR + ½ = 2.5).
 */
export function qualityBudget(lockedEvents: readonly LockedEvent[] = []): number {
  return keyBudget(lockedEvents.reduce((a, e) => a + classifyEvent(e).keyCost, 0));
}

/** Quality runs that fit under the cap of 3 with the LR and `crossTrainingKeyCost` (sum of ½s). */
export function keyBudget(crossTrainingKeyCost: number): number {
  return Math.max(0, Math.floor(MAX_KEY_SESSIONS - 1 - crossTrainingKeyCost + 1e-9));
}

/** Whether this week's LR may carry quality content (before the alternation is applied). */
export function longRunMayBeQuality(allow: QualityAllowance, phase: Phase): boolean {
  if (allow.qualityLR === "never") return false;
  if (phase === "BASE" || phase === "FI") return false;
  if (allow.qualityLR === "alternate_from_TQ") return phase === "TQ" || phase === "FQ";
  return true;
}

/** Quality runs this week: base, plus the easy-LR extra, limited by the key budget. */
export function weeklyQualityCount(allow: QualityAllowance, lrIsQuality: boolean, budget: number): number {
  const wanted = allow.base + (lrIsQuality ? 0 : allow.extraIfEasyLR);
  // The LR is always a key session; `budget` already excludes it, so quality runs + LR ≤ 3.
  return Math.min(wanted, budget);
}

/** GP = race-specific goal-pace session; M = marathon-pace block. */
export type QualityKind = "T" | "I" | "R" | "H" | "M" | "GP";

const alt = <T>(i: number, a: T, b: T): T => (i % 2 === 0 ? a : b);

/**
 * P3 emphasis: [Q1, Q2] for 2-quality weeks and the single session for 1-quality weeks.
 * `i` = week index within the phase (0-based), `len` = phase length. Secondary picks are D where the
 * spec names only one emphasis (5K EQ/TQ).
 */
export function phaseEmphasis(
  distance: GoalDistance,
  phase: Phase,
  i: number,
  len: number,
): { pair: [QualityKind, QualityKind]; single: QualityKind } | null {
  if (phase === "BASE" || phase === "FI") return null; // E + strides
  const early = i < len / 2;
  switch (distance) {
    case "marathon":
      if (phase === "EQ") return { pair: ["R", "T"], single: early ? "R" : "T" }; // R/I then T
      if (phase === "TQ") return { pair: [alt(i, "I", "T"), "M"], single: alt(i, "I", "T") }; // I or T, M secondary
      return { pair: ["T", "M"], single: alt(i, "T", "M") }; // T + M
    case "half":
      if (phase === "EQ") return { pair: ["R", "T"], single: alt(i, "R", "T") };
      if (phase === "TQ") return { pair: [alt(i, "I", "H"), "T"], single: alt(i, "I", "T") };
      return { pair: ["T", "GP"], single: alt(i, "T", "GP") }; // T dominant + GP
    case "10k":
      if (phase === "EQ") return { pair: [alt(i, "R", "H"), "T"], single: alt(i, "R", "T") };
      if (phase === "TQ") return { pair: ["I", "R"], single: alt(i, "I", "R") };
      return { pair: ["T", alt(i, "GP", "I")], single: alt(i, "T", "GP") };
    case "5k":
      if (phase === "EQ") return { pair: ["R", "T"], single: "R" };
      if (phase === "TQ") return { pair: ["I", "R"], single: "I" };
      return { pair: [alt(i, "GP", "T"), "I"], single: alt(i, "GP", "T") };
  }
}

/**
 * P3 substitutions (D):
 *  - beginners: one short T/fartlek by RPE, nothing else.
 *  - VDOT not from a race or TT: no I/R (§4.2) → hills; GP needs a trusted pace → T by RPE.
 *  - beginners and novices: I no earlier than TQ → hills before that.
 */
export function substituteQuality(
  kind: QualityKind,
  level: Level,
  vdotStatus: VdotStatus,
  phase: Phase,
): { kind: QualityKind; rule?: string } {
  if (level === "beginner") return kind === "T" ? { kind } : { kind: "T", rule: `P3:sub:${kind}->T(beginner)` };
  const trusted = vdotStatus === "race" || vdotStatus === "tt";
  if (!trusted && (kind === "I" || kind === "R")) return { kind: "H", rule: `P3:sub:${kind}->H(${vdotStatus})` };
  if (!trusted && kind === "GP") return { kind: "T", rule: `P3:sub:GP->T(${vdotStatus})` };
  if (level === "novice" && kind === "I" && (phase === "EQ" || phase === "FI" || phase === "BASE")) {
    return { kind: "H", rule: "P3:sub:I->H(novice<TQ)" };
  }
  return { kind };
}
