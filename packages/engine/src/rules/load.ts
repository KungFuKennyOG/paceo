/**
 * R-LOAD: load guardrails (spec §8, §10.1).
 *   R-LOAD-1 V1 is the only hard injury constraint: enforced by the replanner against ACTUAL history
 *            (replan-apply.ts enforceV1Actual), not here.
 *   R-LOAD-2 planned weekly total_load > 1.30 × the mean of the previous 4 weeks → trim easy running
 *            first, then Q2 → easy. Never the LR first. Locked cross-training is never trimmed (D).
 *   R-LOAD-3 monotony = mean ÷ SD of daily load; strain = weekly load × monotony. Display only (E/D).
 *   R-LOAD-4 cross-training > 40% of total_load (4 weeks), or R-LOAD-2 two weeks running → 2:1 cutbacks
 *            at the next rebuild (D).
 */
import { addDays } from "../dates.js";
import { weeklyLoad } from "../load.js";
import type { PlanWeek } from "../plan-types.js";
import { crossTrainingShare, dailyLoads, loadBetween } from "../replan-history.js";
import { illnessDates, weekContaining, type RuleContext } from "../replan-context.js";
import { emptyResult, type ReplanMetrics, type RuleResult } from "../replan-types.js";

export const LOAD_SPIKE_FACTOR = 1.3;
export const XT_SHARE_2TO1 = 0.4;

/**
 * Planned total_load of the 7-day week starting `start`: actual load on days already lived, and
 * load.ts weeklyLoad (runs, strength and locked cross-training) on the editable days.
 */
export function plannedWeekLoad(ctx: RuleContext, start: string, weeks: readonly PlanWeek[] = ctx.plan.weeks): number {
  const past = loadBetween(ctx.activities, start, ctx.editableFrom < addDays(start, 7) ? ctx.editableFrom : addDays(start, 7));
  const wk = weeks.find((w) => w.startDate === start);
  if (!wk) return past;
  const editable = (d: string) => d >= ctx.editableFrom;
  const future = weeklyLoad({
    workouts: wk.workouts.filter((w) => editable(w.date)),
    crossTraining: (wk.crossTraining ?? []).filter((x) => editable(x.date)),
  });
  return past + future.totalLoad;
}

function prior4WeekMean(ctx: RuleContext, start: string): number | undefined {
  const first = ctx.activities[0]?.date;
  if (!first || first > addDays(start, -28)) return undefined; // need 4 weeks of history
  let total = 0;
  for (let i = 1; i <= 4; i++) {
    const from = addDays(start, -7 * i);
    const to = addDays(from, 7);
    total += to <= ctx.editableFrom ? loadBetween(ctx.activities, from, to) : plannedWeekLoad(ctx, from);
  }
  return total / 4;
}

export function loadMetrics(ctx: RuleContext): ReplanMetrics {
  const from = addDays(ctx.today, -7);
  const daily = dailyLoads(ctx.activities, from, ctx.today, false);
  const weeklyLoad = daily.reduce((a, b) => a + b, 0);
  const m: ReplanMetrics = { weeklyLoad: Math.round(weeklyLoad), crossTrainingShare: Math.round(crossTrainingShare(ctx.activities, addDays(ctx.today, -28), ctx.today) * 100) / 100 };
  const mean = weeklyLoad / 7;
  const sd = Math.sqrt(daily.reduce((a, x) => a + (x - mean) ** 2, 0) / daily.length);
  if (sd > 0) {
    m.monotony = Math.round((mean / sd) * 100) / 100;
    m.strain = Math.round(weeklyLoad * (mean / sd));
  }
  return m;
}

export function ruleLoad(ctx: RuleContext): RuleResult {
  const out = emptyResult("R-LOAD");
  const cur = weekContaining(ctx.plan, ctx.today);
  if (!cur) return out;
  let triggers = 0;
  // A return from a break is R-BREAK's ramp; the break weeks would deflate the 4-week baseline (D).
  // Same for the 14 days after an illness (R-ILL-4 owns that return).
  const ill = illnessDates(ctx);
  const recentIllness = [...ill].some((d) => d >= addDays(ctx.today, -14));
  const starts = ctx.brk || recentIllness ? [] : [cur.startDate, addDays(cur.startDate, 7)];
  if (ctx.brk) out.trace.push("R-LOAD-2:superseded_by_R-BREAK");
  else if (recentIllness) out.trace.push("R-LOAD-2:superseded_by_R-ILL");
  for (const start of starts) {
    const mean = prior4WeekMean(ctx, start);
    if (mean === undefined || mean <= 0) continue;
    const planned = plannedWeekLoad(ctx, start);
    const max = LOAD_SPIKE_FACTOR * mean;
    out.trace.push(`R-LOAD-2:${start}(${Math.round(planned)}/${Math.round(mean)})`);
    if (planned <= max) continue;
    triggers++;
    out.actions.push({ kind: "trim_load", rule: "R-LOAD-2", weekStart: start, maxLoad: Math.round(max), reason: `planned load ${Math.round(planned)} AU > 1.3 × recent mean ${Math.round(mean)} AU` });
    out.changes.push({
      rule: "R-LOAD-2",
      date: start,
      message: `The week of ${start} would be ${Math.round((planned / mean - 1) * 100)}% above your recent training load, so easy runs are shortened first (your long run and fixed cross-training are kept).`,
    });
  }
  const share = crossTrainingShare(ctx.activities, addDays(ctx.today, -28), ctx.today);
  if ((share > XT_SHARE_2TO1 || triggers >= 2) && !ctx.input.heavyCrossTraining) {
    out.inputPatch = { heavyCrossTraining: true };
    const why = share > XT_SHARE_2TO1 ? `Cross-training is ${Math.round(share * 100)}% of your training load` : "Your load jumped two weeks running";
    out.changes.push({ rule: "R-LOAD-4", message: `${why}, so lighter "cutback" weeks will come every 3rd week when the plan is next rebuilt.` });
  }
  return out;
}
