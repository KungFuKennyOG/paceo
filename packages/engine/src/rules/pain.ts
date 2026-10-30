/**
 * R-PAIN: niggles, Silbernagel pain-monitoring model (spec §8; E single RCT, tendon-specific).
 *   Green  during ≤ 3 and next morning at baseline → continue.
 *   Amber  during 3–5, or next morning ≤ 2 above baseline → next 3 runs easy only; freeze weekly km
 *          and the LR; drop intervals, hills and repetitions for a week.
 *   Red    during > 5, not settled by morning (> baseline + 2), rising weekly trend, altered gait →
 *          3 days no running, then a 20-min easy test (12 min on the ladder). Pain > 5 again after
 *          the test → "see a physio" + cross-training-only mode (R-BREAK's cross-trained column).
 *   Sharp localized bone pain (any score) → suspected bone stress: out of scope (§2.4), stop + refer (D).
 *   R-PAIN-4 any amber or red → next week's volume capped at the last completed week.
 */
import { addDays } from "../dates.js";
import { dateRange, weekContaining, type RuleContext } from "../replan-context.js";
import { emptyResult, type PainEvent, type RuleResult } from "../replan-types.js";
import { dayName } from "./miss.js";

export type PainZone = "green" | "amber" | "red" | "bone";

export const PAIN_LOOKBACK_DAYS = 14;
export const PAIN_RED_REST_DAYS = 3;
export const PAIN_TEST_MIN = 20;
export const PAIN_TEST_MIN_LADDER = 12;
export const PAIN_AMBER_EASY_RUNS = 3;
export const PAIN_AMBER_NO_QUALITY_DAYS = 7;
export const PAIN_XT_ONLY_DAYS = 14;
/** Weekly mean "during" score rising by more than this → red (D). */
export const PAIN_TREND_RISE = 1;

/** Zone for one check-in, given earlier check-ins for the same body part (sorted). */
export function painZone(e: PainEvent, earlier: readonly PainEvent[] = []): { zone: PainZone; why: string } {
  if (e.sharpBonePain) return { zone: "bone", why: "sharp localized bone pain" };
  const base = e.baseline ?? 0;
  if (e.during > 5) return { zone: "red", why: `${e.during}/10 during the run` };
  if (e.nextMorning !== undefined && e.nextMorning > base + 2) return { zone: "red", why: "not settled by the next morning" };
  if (e.alteredGait) return { zone: "red", why: "it changed how you run" };
  const thisWeek = [...earlier, e].filter((x) => x.date > addDays(e.date, -7));
  const lastWeek = earlier.filter((x) => x.date <= addDays(e.date, -7) && x.date > addDays(e.date, -14));
  const avg = (xs: readonly PainEvent[]) => xs.reduce((a, x) => a + x.during, 0) / xs.length;
  if (lastWeek.length > 0 && avg(thisWeek) > avg(lastWeek) + PAIN_TREND_RISE) return { zone: "red", why: "rising week to week" };
  if (e.during > 3) return { zone: "amber", why: `${e.during}/10 during the run` };
  if (e.nextMorning !== undefined && e.nextMorning > base) return { zone: "amber", why: "a little sore the next morning" };
  return { zone: "green", why: "settled" };
}

export function rulePain(ctx: RuleContext): RuleResult {
  const out = emptyResult("R-PAIN");
  const from = addDays(ctx.today, -PAIN_LOOKBACK_DAYS);
  const all = ctx.events.filter((e): e is PainEvent => e.type === "pain" && e.date <= ctx.today);
  const parts = [...new Set(all.filter((e) => e.date >= from).map((e) => e.bodyPart))].sort();
  let worst: PainZone = "green";
  for (const part of parts) {
    const list = all.filter((e) => e.bodyPart === part);
    // Latest report per run day wins (events are sorted by report date).
    const byDay = new Map<string, PainEvent>();
    for (const e of list) byDay.set(e.date, e);
    const days = [...byDay.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
    const latest = days.at(-1) as PainEvent;
    if (latest.date < from) continue;
    const { zone, why } = painZone(latest, days.slice(0, -1));
    out.trace.push(`R-PAIN:${zone}(${part})`);

    if (zone === "bone") {
      out.halt = { rule: "R-PAIN", referral: "doctor", reason: `suspected bone stress (${part})` };
      out.changes.push({ rule: "R-PAIN", message: `Sharp, localized bone pain in your ${part} can be a stress injury: please see a doctor or sports physio before running again. Your plan is paused.` });
      return out;
    }
    if (zone === "red") {
      worst = "red";
      const reds = days.filter((d, i) => painZone(d, days.slice(0, i)).zone === "red");
      const first = reds[0] as PainEvent;
      const testDate = addDays(addDays(first.date, 1), PAIN_RED_REST_DAYS);
      const failedTest = reds.length >= 2 && latest.date >= testDate && latest.during > 5;
      if (failedTest) {
        out.actions.push({ kind: "cross_training_only", rule: "R-PAIN", from: ctx.editableFrom, to: addDays(ctx.editableFrom, PAIN_XT_ONLY_DAYS - 1), reason: `pain > 5 again after the test run (${part})` });
        out.changes.push({ rule: "R-PAIN", message: `Your ${part} hurt again on the test run: please see a physio. Swap running for cycling, swimming or the elliptical for the next 2 weeks; we'll rebuild from there.` });
        continue;
      }
      const restFrom = addDays(latest.date, 1);
      const restDays = dateRange(restFrom, addDays(restFrom, PAIN_RED_REST_DAYS - 1)).filter((d) => d >= ctx.editableFrom);
      for (const date of restDays) out.actions.push({ kind: "rest", rule: "R-PAIN", date, reason: `red pain (${part}): ${why}` });
      const test = addDays(restFrom, PAIN_RED_REST_DAYS);
      if (test >= ctx.editableFrom) {
        const minutes = ctx.isLadderPlan ? PAIN_TEST_MIN_LADDER : PAIN_TEST_MIN;
        out.actions.push({ kind: "test_run", rule: "R-PAIN", date: test, minutes, label: "pain_test", reason: `test run after red pain (${part})` });
        out.changes.push({ rule: "R-PAIN", date: test, message: `Your ${part} is in the red zone (${why}): no running for ${PAIN_RED_REST_DAYS} days, then a ${minutes}-min easy test run on ${dayName(test)}. If it goes above 5/10 again, see a physio.` });
      }
      continue;
    }
    if (zone === "amber") {
      if (worst !== "red") worst = "amber";
      const next = ctx.workouts.filter((w) => w.sport === "run" && w.type !== "RACE" && w.date >= ctx.editableFrom).slice(0, PAIN_AMBER_EASY_RUNS);
      for (const w of next) out.actions.push({ kind: "easy", rule: "R-PAIN", date: w.date, reason: `amber pain (${part})` });
      out.actions.push({ kind: "no_quality", rule: "R-PAIN", from: ctx.editableFrom, to: addDays(ctx.editableFrom, PAIN_AMBER_NO_QUALITY_DAYS - 1), kinds: ["I", "H", "R"], reason: `amber pain (${part}): no intervals, hills or repetitions` });
      const lastLr = ctx.match.workouts.filter((m) => m.type === "L" && (m.status === "completed" || m.status === "partial")).at(-1);
      const lrKm = lastLr ? ctx.runs.filter((r) => lastLr.activityIds.includes(r.id)).reduce((a, r) => a + r.distanceM / 1000, 0) : undefined;
      if (lrKm !== undefined && lrKm > 0) {
        out.actions.push({ kind: "cap_long_run", rule: "R-PAIN", from: ctx.editableFrom, to: addDays(ctx.editableFrom, PAIN_LOOKBACK_DAYS - 1), km: Math.floor(lrKm * 10) / 10, reason: "freeze the long run" });
      }
      out.changes.push({ rule: "R-PAIN", message: `Your ${part} is in the amber zone (${why}): your next ${next.length} runs are easy, no intervals or hills this week, and your long run and weekly km won't go up until it settles.` });
    }
  }
  if (worst === "amber" || worst === "red") {
    // R-PAIN-4: next week capped at the last completed week.
    const cur = weekContaining(ctx.plan, ctx.today);
    const done = ctx.match.weeks.filter((w) => addDays(w.startDate, 7) <= ctx.today).at(-1);
    if (cur && done) {
      const nextStart = addDays(cur.startDate, 7);
      for (const ws of [cur.startDate, nextStart]) {
        out.actions.push({ kind: "cap_week_km", rule: "R-PAIN-4", weekStart: ws, km: done.actualKm, reason: `${worst} pain: not progressing` });
      }
      out.changes.push({ rule: "R-PAIN-4", message: `Weekly volume is held at last week's ${done.actualKm.toFixed(1)} km while the pain settles.` });
    }
  }
  return out;
}
