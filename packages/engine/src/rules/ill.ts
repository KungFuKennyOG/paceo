/**
 * R-ILL: illness (spec §8; IOC 2022 consensus and BJSM graduated return, C).
 *   R-ILL-1 neck check. Fever or systemic → no running until fever-free and systemic symptoms gone.
 *           Above-neck only → optional easy run at ≤ 60% of planned duration, no quality.
 *   R-ILL-2 first run back is an exercise challenge: 15 min at 60–70% effort. Red flags → stop + doctor.
 *   R-ILL-3 suspected COVID / flu-like (fever or flagged) with systemic symptoms: ≥ 10 days from onset
 *           to normal training; above-neck only: ≥ 5 days. "Normal training" = quality allowed (D).
 *   R-ILL-4 sick days feed R-BREAK; after a systemic illness the 50% phase applies even after 4–5 days.
 *   R-ILL-5 symptoms > 7 days or worsening → recommend a doctor and stop auto-replanning.
 */
import { addDays, daysBetween } from "../dates.js";
import { detectBreak } from "../replan-history.js";
import { dateRange, type RuleContext } from "../replan-context.js";
import { emptyResult, type IllnessEvent, type RuleResult } from "../replan-types.js";
import { rampActions } from "./break.js";
import { dayName } from "./miss.js";

/** Rolling no-run / easy-only horizon while still ill; re-evaluated at the next check-in (D). */
export const ILL_HORIZON_DAYS = 3;
export const ILL_EASY_FRACTION = 0.6;
export const EXERCISE_CHALLENGE_MIN = 15;
export const ILL_SYSTEMIC_RETURN_DAYS = 10;
export const ILL_ABOVE_NECK_RETURN_DAYS = 5;
export const ILL_MAX_DAYS = 7;
/** Episodes resolved longer ago than this no longer shape the plan. */
export const ILL_RELEVANT_DAYS = 28;

function isSystemic(e: IllnessEvent): boolean {
  return e.fever || e.systemic;
}

export function ruleIll(ctx: RuleContext): RuleResult {
  const out = emptyResult("R-ILL");
  const e = ctx.illness.filter((x) => x.date <= ctx.today).at(-1);
  if (!e) return out;
  const resolved = e.resolvedDate !== undefined && e.resolvedDate <= ctx.today;
  if (resolved && daysBetween(e.resolvedDate as string, ctx.today) > ILL_RELEVANT_DAYS) return out;
  const systemic = isSystemic(e);
  out.trace.push(`R-ILL:${systemic ? "systemic" : "above_neck"}(${e.date}${resolved ? `..${e.resolvedDate}` : ""})`);

  // R-ILL-2 red flags after (or during) the return.
  const flags = ctx.events.filter((x) => x.type === "illness_red_flag" && x.date >= e.date);
  if (flags.length > 0) {
    out.halt = { rule: "R-ILL-2", referral: "doctor", reason: "red-flag symptoms after returning from illness" };
    out.changes.push({ rule: "R-ILL-2", message: "Red-flag symptoms after illness (like chest pain, palpitations or dizziness): please see a doctor before running again. Your plan is paused." });
    return out;
  }

  if (!resolved) {
    const days = daysBetween(e.date, ctx.today);
    if (days > ILL_MAX_DAYS || e.worsening) {
      out.halt = { rule: "R-ILL-5", referral: "doctor", reason: e.worsening ? "symptoms worsening" : `symptoms for ${days} days` };
      out.changes.push({ rule: "R-ILL-5", message: `${e.worsening ? "Your symptoms are getting worse" : `You've been unwell for ${days} days`}: please see a doctor. Automatic replanning is paused until you're cleared.` });
      return out;
    }
    const horizon = dateRange(ctx.editableFrom, addDays(ctx.today, ILL_HORIZON_DAYS - 1));
    if (systemic) {
      for (const date of horizon) out.actions.push({ kind: "rest", rule: "R-ILL-1", date, reason: e.fever ? "fever" : "below-neck symptoms" });
      out.changes.push({ rule: "R-ILL-1", message: `No running while you have ${e.fever ? "a fever" : "below-neck symptoms"}. Rest; your return starts once you're fever-free and those symptoms are gone.` });
    } else {
      for (const date of horizon) {
        out.actions.push({ kind: "easy", rule: "R-ILL-1", date, maxFraction: ILL_EASY_FRACTION, reason: "above-neck symptoms only" });
      }
      out.changes.push({ rule: "R-ILL-1", message: `Head cold only: you can run easy if you feel like it, up to about ${Math.round(ILL_EASY_FRACTION * 100)}% of the planned time. No hard sessions until the symptoms clear.` });
    }
    return out;
  }

  // Resolved.
  const back = e.resolvedDate as string;
  const ranSince = ctx.runs.some((r) => r.date >= back);
  if (systemic) {
    if (!ranSince) {
      const first = ctx.workouts.find((w) => w.sport === "run" && w.type !== "RACE" && w.date >= ctx.editableFrom && w.date >= back);
      if (first) {
        out.actions.push({ kind: "test_run", rule: "R-ILL-2", date: first.date, minutes: EXERCISE_CHALLENGE_MIN, label: "exercise_challenge", reason: "first run after illness" });
        out.changes.push({ rule: "R-ILL-2", date: first.date, message: `${dayName(first.date)}: ${EXERCISE_CHALLENGE_MIN} min very easy as a test. Stop and tell us if you get chest pain, palpitations, dizziness or unusual breathlessness, during the run or in the next 24 h.` });
      }
    }
    const flu = e.fever || e.suspectedCovidOrFlu === true;
    if (flu) {
      const normal = addDays(e.date, ILL_SYSTEMIC_RETURN_DAYS);
      if (normal > ctx.editableFrom) {
        out.actions.push({ kind: "no_quality", rule: "R-ILL-3", from: ctx.editableFrom, to: addDays(normal, -1), reason: `≥ ${ILL_SYSTEMIC_RETURN_DAYS} days from onset to normal training` });
        out.changes.push({ rule: "R-ILL-3", message: `Easy running only until ${dayName(normal)} ${normal} (${ILL_SYSTEMIC_RETURN_DAYS} days after you got sick).` });
      }
    }
    // R-ILL-4: short gaps still start at the 50% phase. Longer gaps (≥ 6 d) are R-BREAK's.
    const gap = detectBreak(ctx.runs, ctx.activities, ctx.today, 1);
    if (gap && gap.daysOff <= 5 && gap.returnDate >= e.date && !ctx.brk) {
      out.actions.push(...rampActions("R-ILL-4", gap));
      out.changes.push({ rule: "R-ILL-4", message: `Coming back from a full-body illness: half your usual volume for ${gap.halfDays} days, then three-quarters for ${gap.halfDays} days.` });
    }
    return out;
  }
  if (e.suspectedCovidOrFlu) {
    const normal = addDays(e.date, ILL_ABOVE_NECK_RETURN_DAYS);
    if (normal > ctx.editableFrom) {
      out.actions.push({ kind: "no_quality", rule: "R-ILL-3", from: ctx.editableFrom, to: addDays(normal, -1), reason: `≥ ${ILL_ABOVE_NECK_RETURN_DAYS} days from onset` });
      out.changes.push({ rule: "R-ILL-3", message: `Easy running only until ${normal} (${ILL_ABOVE_NECK_RETURN_DAYS} days after onset).` });
    }
  }
  return out;
}
