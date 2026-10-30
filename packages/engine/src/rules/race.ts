/**
 * R-RACE: fixed race date (spec §8; Feely 2023 E-obs, Pfitzinger C, rest D).
 *   R-RACE-1 the taper is never compressed below 7 days: compress the build, not the taper. The
 *            rebuild keeps the generator's taper length (checked in replan.ts).
 *   R-RACE-2 weeks_available = weeks_to_race − taper_weeks; restart at the R-BREAK return level and
 *            progress under V1/V2: that is what the rebuild does (generatePlan from today).
 *   R-RACE-3 prompt a goal revision if (a) ≥ 10 cumulative days lost in the final 8 weeks, (b) the
 *            achievable peak LR < 85% of the plan's own L1 target, or (c) the break multiplier implies
 *            goal pace > 2% slower. Offer old_goal / multiplier plus the §6.2 alternatives.
 *   R-RACE-4 < 4 build weeks and no run ≥ 75% of the L1 peak LR in the last 30 days → offer a finish or
 *            run/walk goal, a shorter distance or a later race.
 * Only evaluated after a disruption (break, illness, realignment): an ambitious plan alone is §6.2's job.
 */
import { addDays, daysBetween } from "../dates.js";
import { checkFeasibility } from "../feasibility.js";
import { REACH_WARN } from "../feasibility.js";
import type { Alternative, PlanInput } from "../plan-types.js";
import { illnessDates, type RuleContext } from "../replan-context.js";
import { BREAK_RESUME_MAX_DAYS, longestRun } from "../replan-history.js";
import { emptyResult, type RuleResult } from "../replan-types.js";
import { formatDuration } from "../units.js";

export const FINAL_WEEKS_DAYS = 56;
export const LOST_DAYS_TRIGGER = 10;
export const MULTIPLIER_TRIGGER_PCT = 2;
export const MIN_BUILD_WEEKS = 4;
export const RECENT_LR_FRACTION = 0.75;

/** Days lost (illness, or inside a no-run gap ≥ 6 days) in [race − 56 d, today). */
export function daysLostInFinalWeeks(ctx: RuleContext): number {
  const from = addDays(ctx.raceDate, -FINAL_WEEKS_DAYS);
  const ill = illnessDates(ctx);
  const runDays = [...new Set(ctx.runs.map((r) => r.date))].sort();
  const lost = new Set<string>();
  for (const d of ill) if (d >= from && d < ctx.today) lost.add(d);
  const bounds = [...runDays.filter((d) => d < ctx.today), ctx.today];
  for (let i = 1; i < bounds.length; i++) {
    const a = bounds[i - 1] as string;
    const b = bounds[i] as string;
    if (daysBetween(a, b) - 1 <= BREAK_RESUME_MAX_DAYS) continue;
    for (let d = addDays(a, 1); d < b; d = addDays(d, 1)) if (d >= from) lost.add(d);
  }
  return lost.size;
}

export interface RaceRuleInput {
  /** The input the rebuild used (or would use). */
  derived: PlanInput;
  taperWeeks: number;
  /** Stable key of the disruption, for the proposal id. */
  disruptionKey: string;
}

export function ruleRace(ctx: RuleContext, r: RaceRuleInput): RuleResult {
  const out = emptyResult("R-RACE");
  if (ctx.today >= ctx.raceDate) return out;
  const lost = daysLostInFinalWeeks(ctx);
  const feas = checkFeasibility(r.derived);
  const m = ctx.brk?.multiplier ?? 1;
  const slowerPct = (1 / m - 1) * 100;
  const triggers: string[] = [];
  if (lost >= LOST_DAYS_TRIGGER) triggers.push(`a:${lost}d_lost`);
  if (feas.reach.ratio < REACH_WARN) triggers.push(`b:reach${Math.round(feas.reach.ratio * 100)}%`);
  if (slowerPct > MULTIPLIER_TRIGGER_PCT) triggers.push(`c:+${slowerPct.toFixed(1)}%`);
  out.trace.push(`R-RACE:${triggers.length ? triggers.join(",") : "ok"}`);

  const weeksToRace = Math.floor((daysBetween(ctx.today, ctx.raceDate) + 1) / 7);
  const buildWeeks = weeksToRace - r.taperWeeks;
  const recentLong = longestRun(ctx.runs, ctx.today, 30).km;
  const shortBuild = buildWeeks < MIN_BUILD_WEEKS && recentLong < RECENT_LR_FRACTION * feas.reach.l1TargetKm;

  if (triggers.length === 0 && !shortBuild) return out;
  const id = `goal:${r.disruptionKey}`;
  if (ctx.declined.has(id)) return out;
  const alternatives: Alternative[] = feas.alternatives.filter((a) => a.kind !== "base_block");
  const ensure = (kind: Alternative["kind"], message: string, extra: Partial<Alternative> = {}): void => {
    if (!alternatives.some((a) => a.kind === kind)) alternatives.push({ kind, rank: alternatives.length + 1, message, ...extra });
  };
  let suggested: number | undefined;
  if (ctx.goalTimeS !== undefined && m < 1) suggested = Math.round(ctx.goalTimeS / m);
  else if (ctx.goalTimeS !== undefined) suggested = alternatives.find((a) => a.kind === "slower_goal")?.goalTimeS;
  if (suggested !== undefined) ensure("slower_goal", `Aim for ${formatDuration(suggested)}.`, { goalTimeS: suggested });

  if (shortBuild) {
    out.trace.push(`R-RACE-4:${buildWeeks}build_weeks`);
    ensure("finish_goal", "Drop the goal time: aim to finish, with a run/walk race strategy if needed.");
    ensure("shorter_distance", "Race a shorter distance on the same date.");
    ensure("later_date", "Pick a later race.");
  }
  const reasons: string[] = [];
  if (lost >= LOST_DAYS_TRIGGER) reasons.push(`you've lost ${lost} days in the last 8 weeks before the race`);
  if (feas.reach.ratio < REACH_WARN) reasons.push(`the longest run you can safely build to is ${Math.round(feas.reach.ratio * 100)}% of this plan's target`);
  if (slowerPct > MULTIPLIER_TRIGGER_PCT) reasons.push(`the time off costs about ${slowerPct.toFixed(1)}% in pace`);
  if (shortBuild) reasons.push(`only ${Math.max(0, buildWeeks)} build weeks are left`);
  const feely = ctx.brk && ctx.brk.daysOff >= 7 ? " Runners with similar breaks finished about 4–8% slower (Feely 2023)." : "";
  out.proposals.push({
    id,
    kind: "goal_change",
    rule: shortBuild && triggers.length === 0 ? "R-RACE-4" : "R-RACE-3",
    ...(ctx.goalTimeS !== undefined ? { currentGoalS: ctx.goalTimeS } : {}),
    ...(suggested !== undefined ? { suggestedGoalS: suggested } : {}),
    alternatives: alternatives.map((a, i) => ({ ...a, rank: i + 1 })),
    message:
      `Time to revisit the goal: ${reasons.join(", ")}.` +
      (suggested !== undefined ? ` A realistic target now is ${formatDuration(suggested)}.` : "") +
      feely,
  });
  return out;
}
