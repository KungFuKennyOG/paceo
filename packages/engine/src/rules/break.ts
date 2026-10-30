/**
 * R-BREAK: consecutive days with no running (spec §8; Daniels return table via RunnersTribe, C weak).
 *   ≤ 5 d   resume at the calendar position, paces unchanged.
 *   6–28 d  rebuild from today on the pre-break volume; 50% of it for ceil(d/2) days (all easy, no
 *           quality), then 75% for ceil(d/2) days; every pace velocity × the table multiplier; LR
 *           capped by V1 against actual history. Ladder: step back one stage per 7 days off.
 *   > 28 d  rebuild + re-test: VDOT detrained by the multiplier and marked `estimated`, so the
 *           generator schedules a time trial (§4.2) and prescribes by time/RPE until it is run.
 * HR runs high for 1–2 weeks after a break: HR-based downgrades are suppressed for 7 days (FIT-UPDATE).
 */
import { formatPace, type Units } from "../units.js";
import { addDays } from "../dates.js";
import { vdotForVelocityFactor } from "../fitness-update.js";
import { BREAK_REBUILD_DAYS, BREAK_RESUME_MAX_DAYS, longestRun, type BreakInfo } from "../replan-history.js";
import type { RuleContext } from "../replan-context.js";
import { emptyResult, type ReplanAction, type RuleResult } from "../replan-types.js";

export const REBUILD_VOLUME_FRACTION = 0.5;
/** Floor for the rebuilt V1 reference after > 28 days (D). */
export const REBUILD_MIN_LONGEST = { km: 3, minutes: 20 };

/** Ramp actions for a return from `daysOff` days (shared with R-ILL-4). */
export function rampActions(rule: string, b: Pick<BreakInfo, "returnDate" | "halfDays" | "end50" | "end75">): ReplanAction[] {
  return [
    {
      kind: "scale_volume",
      rule,
      from: b.returnDate,
      to: addDays(b.end50, -1),
      factor: 0.5,
      easyOnly: true,
      reason: `return ramp: 50% of pre-break volume for ${b.halfDays} days, all easy`,
    },
    {
      kind: "scale_volume",
      rule,
      from: b.end50,
      to: addDays(b.end75, -1),
      factor: 0.75,
      easyOnly: false,
      reason: `return ramp: 75% of pre-break volume for ${b.halfDays} days`,
    },
  ];
}

export function ruleBreak(ctx: RuleContext, units: Units = "metric"): RuleResult {
  const out = emptyResult("R-BREAK");
  const b = ctx.brk;
  if (!b || b.daysOff <= BREAK_RESUME_MAX_DAYS) return out;
  const d = b.daysOff;
  out.trace.push(`R-BREAK:${d}d(x${b.multiplier.toFixed(3)}${b.crossTrained ? ",xt" : ""})`);
  const actual = longestRun(ctx.runs, ctx.editableFrom, 30);

  if (d > BREAK_REBUILD_DAYS) {
    const pre = b.preBreakLongest;
    const longest = {
      km: Math.max(actual.km, REBUILD_MIN_LONGEST.km, Math.round(REBUILD_VOLUME_FRACTION * pre.km * 10) / 10),
      minutes: Math.max(actual.minutes, REBUILD_MIN_LONGEST.minutes, Math.round(REBUILD_VOLUME_FRACTION * pre.minutes)),
    };
    const patch: NonNullable<RuleResult["regenerate"]>["patch"] = {
      currentWeeklyKm: Math.round(REBUILD_VOLUME_FRACTION * b.preBreakWeeklyKm * 10) / 10,
      longestRun30d: longest,
      ladderStepBack: Math.ceil(d / 7),
    };
    if (ctx.fitness.vdot !== undefined) {
      patch.vdot = Math.round(vdotForVelocityFactor(ctx.fitness.vdot, b.multiplier) * 100) / 100;
      patch.vdotStatus = "estimated";
    }
    out.regenerate = { rule: "R-BREAK", key: `R-BREAK:${b.returnDate}:${d}`, reason: `${d} days without running`, patch };
    out.changes.push({
      rule: "R-BREAK",
      date: b.returnDate,
      message: `After ${d} days off, the plan restarts from ${patch.currentWeeklyKm} km/week with easy running and a time trial to re-test your fitness; paces stay by effort until then.`,
    });
    return out;
  }

  // 6–28 days.
  const patch: NonNullable<RuleResult["regenerate"]>["patch"] = {
    currentWeeklyKm: Math.round(b.preBreakWeeklyKm * 10) / 10,
    longestRun30d: actual.km > 0 ? actual : { km: b.preBreakLongest.km * b.multiplier, minutes: b.preBreakLongest.minutes },
    ladderStepBack: Math.ceil(d / 7),
  };
  out.regenerate = { rule: "R-BREAK", key: `R-BREAK:${b.returnDate}:${d}`, reason: `${d} days without running`, patch };
  out.actions.push(...rampActions("R-BREAK", b));
  if (b.multiplier < 1) {
    out.actions.push({ kind: "scale_paces", rule: "R-BREAK", from: b.returnDate, factor: b.multiplier, reason: `Daniels return multiplier ×${b.multiplier.toFixed(3)} after ${d} days off` });
  }
  const slower = ((1 / b.multiplier - 1) * 100).toFixed(1);
  const mp = ctx.goalDistance === "marathon" && ctx.goalTimeS !== undefined ? ctx.goalTimeS / 42.195 : undefined;
  const example = mp !== undefined && b.multiplier < 1 ? ` (goal marathon pace ${formatPace(mp, units)} → ${formatPace(mp / b.multiplier, units)})` : "";
  out.changes.push({
    rule: "R-BREAK",
    date: b.returnDate,
    message:
      `Welcome back after ${d} days off. Next ${b.halfDays} days: easy running at about half your usual ${Math.round(b.preBreakWeeklyKm)} km/week, ` +
      `then ${b.halfDays} days at three-quarters, before the plan picks up again.` +
      (b.multiplier < 1 ? ` Paces are ${slower}% slower for now${example}${b.crossTrained ? "; your cross-training kept more of your fitness" : ""}.` : ""),
  });
  if (ctx.isLadderPlan) out.changes.push({ rule: "R-BREAK", message: `Run/walk: stepping back ${Math.ceil(d / 7)} stage(s).` });
  return out;
}
