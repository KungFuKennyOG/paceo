/**
 * R-MISS: missed sessions (spec §8).
 *   R-MISS-1 missed easy/recovery run → drop it; never add its km elsewhere (C, Runna/TrainAsONE).
 *   R-MISS-2 missed key session → move it within the same week only if every §7.1 constraint still
 *            holds (48 h between key sessions, nothing hard the day before/after the LR, ≤ 3 keys); else drop (C/D).
 *   R-MISS-3 missed LR → re-insert only if it lands ≥ 4 days from the next LR and passes V1 (D on E).
 *   R-MISS-4 > 3 missed (14 days) or a full week missed → prompt realignment; on acceptance rebuild
 *            from today, re-anchored to the km actually run over the last 3 weeks (C, Runna).
 * A break of ≥ 6 days supersedes all of this (R-BREAK), and days covered by an illness or pain
 * check-in are handled by R-ILL / R-PAIN.
 */
import { addDays, daysBetween, weekdayOf } from "../dates.js";
import type { WorkoutMatch } from "../matching.js";
import { meanWeeklyKm } from "../replan-history.js";
import {
  dateRange,
  illnessDates,
  isKeyDay,
  isQualityWorkout,
  qualityAllowedOn,
  v1LimitAt,
  weekContaining,
  type RuleContext,
} from "../replan-context.js";
import { emptyResult, type RuleResult } from "../replan-types.js";
import { v1Measure, v1Ok } from "../v1.js";
import type { PlannedWorkout } from "../workout.js";

export const MISS_LOOKBACK_DAYS = 7;
export const REALIGN_WINDOW_DAYS = 14;
export const REALIGN_MIN_MISSED = 4; // "more than 3"
export const LR_REINSERT_MIN_GAP_DAYS = 4;
export const LR_REINSERT_MAX_LATE_DAYS = 3;
export const MAX_KEYS_PER_WEEK = 3;

const DAY_NAME: Record<string, string> = { mon: "Monday", tue: "Tuesday", wed: "Wednesday", thu: "Thursday", fri: "Friday", sat: "Saturday", sun: "Sunday" };
export function dayName(date: string): string {
  return DAY_NAME[weekdayOf(date)] ?? date;
}

const LABEL: Record<string, string> = {
  E: "easy run",
  S: "easy run with strides",
  L: "long run",
  T: "threshold session",
  I: "intervals",
  R: "repetitions",
  H: "hill session",
  M: "marathon-pace run",
  TT: "time trial",
  RW: "run/walk session",
  RACE: "race",
};
export function workoutLabel(w: Pick<PlannedWorkout, "type">): string {
  return LABEL[w.type] ?? "session";
}

/** Misses that R-MISS owns: not explained by illness or a pain/illness skip. */
function ownedMisses(ctx: RuleContext, from: string): WorkoutMatch[] {
  const ill = illnessDates(ctx);
  const excused = new Set(
    ctx.events.flatMap((e) => (e.type === "skip" && (e.reason === "illness" || e.reason === "pain") ? [e.date] : [])),
  );
  return ctx.match.workouts.filter(
    (m) =>
      (m.status === "missed" || m.status === "skipped") &&
      m.date >= from &&
      m.date < ctx.today &&
      m.type !== "RACE" &&
      !ill.has(m.date) &&
      !excused.has(m.date),
  );
}

function alreadyHandled(ctx: RuleContext, rule: string, fromDate: string): boolean {
  return ctx.workouts.some((w) => w.rule_trace.includes(`${rule}:from(${fromDate})`));
}

/** Days in [from, to] that can take a moved key session: an easy run on that day, free neighbours, ≤ 3 keys/week. */
function keySlot(ctx: RuleContext, moved: PlannedWorkout, from: string, to: string, extra?: (date: string) => boolean): string | undefined {
  for (const date of dateRange(from, to)) {
    if (date < ctx.editableFrom || date >= ctx.raceDate) continue;
    const host = ctx.runOn.get(date);
    if (!host || host.flags.key_session || isQualityWorkout(host) || host.type === "L" || host.type === "RACE") continue;
    if (isKeyDay(ctx, addDays(date, -1)) || isKeyDay(ctx, addDays(date, 1))) continue;
    if (isQualityWorkout(moved) && !qualityAllowedOn(ctx.plan, date)) continue;
    const week = weekContaining(ctx.plan, date);
    if (week) {
      const keys = dateRange(week.startDate, addDays(week.startDate, 6)).filter((d) => isKeyDay(ctx, d)).length;
      if (keys + 1 > MAX_KEYS_PER_WEEK) continue;
    }
    if (extra && !extra(date)) continue;
    const future = ctx.workouts.filter((w) => w.date >= ctx.editableFrom && w.date < date);
    const m = v1Measure(moved);
    if (!v1Ok(m.km ?? 0, m.minutes, v1LimitAt(ctx, date, future), moved.type === "RW")) continue;
    return date;
  }
  return undefined;
}

export function ruleMiss(ctx: RuleContext): RuleResult {
  const out = emptyResult("R-MISS");
  if (ctx.brk) {
    out.trace.push("R-MISS:superseded_by_R-BREAK");
    return out;
  }
  const recent = ownedMisses(ctx, addDays(ctx.today, -MISS_LOOKBACK_DAYS));
  const currentWeek = weekContaining(ctx.plan, ctx.today);

  for (const m of recent) {
    const w = ctx.workouts.find((x) => x.id === m.workoutId);
    if (!w || w.sport !== "run") continue;
    const when = `${dayName(w.date)}'s ${workoutLabel(w)}`;
    if (w.type === "L") {
      // R-MISS-3
      if (alreadyHandled(ctx, "R-MISS-3", w.date)) continue;
      const nextLr = ctx.workouts.find((x) => x.type === "L" && x.date >= ctx.editableFrom);
      const latest = nextLr ? addDays(nextLr.date, -LR_REINSERT_MIN_GAP_DAYS) : addDays(ctx.today, LR_REINSERT_MAX_LATE_DAYS);
      const until = [latest, addDays(w.date, LR_REINSERT_MAX_LATE_DAYS)].sort()[0] as string;
      const slot = daysBetween(w.date, ctx.today) <= LR_REINSERT_MAX_LATE_DAYS ? keySlot(ctx, w, ctx.editableFrom, until) : undefined;
      if (slot) {
        out.actions.push({ kind: "move", rule: "R-MISS-3", workoutId: w.id, fromDate: w.date, toDate: slot, reason: `missed long run re-inserted ≥ ${LR_REINSERT_MIN_GAP_DAYS} days before the next one` });
        out.changes.push({ rule: "R-MISS-3", date: slot, message: `Moved ${when} to ${dayName(slot)}: it still lands at least ${LR_REINSERT_MIN_GAP_DAYS} days before your next long run and within your safe single-run limit.` });
      } else {
        out.changes.push({ rule: "R-MISS-3", date: w.date, message: `Dropped ${when}: there's no day for it at least ${LR_REINSERT_MIN_GAP_DAYS} days before the next long run. Next week's long run is checked against what you actually ran.` });
      }
      continue;
    }
    if (isQualityWorkout(w)) {
      // R-MISS-2: same plan week only.
      if (alreadyHandled(ctx, "R-MISS-2", w.date)) continue;
      const wk = weekContaining(ctx.plan, w.date);
      const sameWeek = wk !== undefined && wk === currentWeek;
      const slot = sameWeek ? keySlot(ctx, w, ctx.editableFrom, addDays(wk.startDate, 6)) : undefined;
      if (slot) {
        out.actions.push({ kind: "move", rule: "R-MISS-2", workoutId: w.id, fromDate: w.date, toDate: slot, reason: "missed key session moved within its week" });
        out.changes.push({ rule: "R-MISS-2", date: slot, message: `Moved ${when} to ${dayName(slot)}, replacing that day's easy run; there's still 48 h between hard sessions.` });
      } else {
        out.changes.push({ rule: "R-MISS-2", date: w.date, message: `Dropped ${when}: ${sameWeek ? "no day left this week keeps 48 h between hard sessions" : "the week is over"}. Don't make it up; just carry on.` });
      }
      continue;
    }
    // R-MISS-1: easy, recovery, strides, run/walk.
    out.changes.push({ rule: "R-MISS-1", date: w.date, message: `Dropped ${when}; its km aren't added to other days.` });
  }

  // R-MISS-4: realignment prompt.
  const window = ownedMisses(ctx, addDays(ctx.today, -REALIGN_WINDOW_DAYS)).filter((m) => m.type !== "STRENGTH");
  const fullWeek = ctx.plan.weeks.find((wk) => {
    const end = addDays(wk.startDate, 6);
    if (end >= ctx.today || daysBetween(end, ctx.today) > REALIGN_WINDOW_DAYS) return false;
    const runs = wk.workouts.filter((x) => x.sport === "run" && x.type !== "RACE");
    return runs.length > 0 && runs.every((x) => window.some((m) => m.workoutId === x.id));
  });
  if (window.length >= REALIGN_MIN_MISSED || fullWeek) {
    const latest = window.map((m) => m.date).sort().at(-1) ?? ctx.today;
    const id = `realign:${latest}`;
    const why = fullWeek ? "a full week was missed" : `${window.length} sessions were missed in the last 2 weeks`;
    if (ctx.accepted.has(id)) {
      const km = Math.round(meanWeeklyKm(ctx.runs, ctx.today, 3) * 10) / 10;
      out.regenerate = {
        rule: "R-MISS-4",
        key: id,
        reason: why,
        patch: { currentWeeklyKm: km, ladderStepBack: 1 },
      };
      out.changes.push({ rule: "R-MISS-4", message: `Rebuilt your plan from today to race day, starting from the ${km.toFixed(1)} km/week you've actually averaged over the last 3 weeks.` });
    } else if (!ctx.declined.has(id)) {
      out.proposals.push({
        id,
        kind: "realign",
        rule: "R-MISS-4",
        message: `Life happens: ${why}. Rebuild the plan from today, based on what you've actually been running? We won't repeat a week.`,
      });
    }
    out.trace.push(`R-MISS-4:${window.length}missed${fullWeek ? "+full_week" : ""}`);
  }
  return out;
}
