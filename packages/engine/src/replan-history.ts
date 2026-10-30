/**
 * What actually happened: history-derived inputs for replanning (spec §6.1 derived inputs, §8 R-BREAK,
 * §10.1 load channels). Pure functions of the activity list and a local "today".
 */
import type { Activity } from "./activity.js";
import { isAerobicCrossTraining, sessionLoad, SPORT_CLASS } from "./activity.js";
import { addDays, daysBetween, toDayNumber } from "./dates.js";
import type { Plan } from "./plan-types.js";
import type { CheckInEvent, IllnessEvent } from "./replan-types.js";
import type { RunRecord } from "./v1.js";

// ── R-BREAK: Daniels return table (C, secondhand) ────────────────────────────────────────────────

export const BREAK_TABLE_DAYS = [5, 7, 10, 14, 21, 28, 35, 42, 56, 70, 72] as const;
export const BREAK_TABLE_NO_XT = [1.0, 0.994, 0.985, 0.973, 0.952, 0.931, 0.91, 0.889, 0.847, 0.805, 0.8] as const;
export const BREAK_TABLE_XT = [1.0, 0.997, 0.992, 0.986, 0.976, 0.965, 0.955, 0.944, 0.923, 0.9, 0.9] as const;
/** ≤ 5 days: resume with unchanged paces. */
export const BREAK_RESUME_MAX_DAYS = 5;
/** > 28 days: rebuild plus re-test. */
export const BREAK_REBUILD_DAYS = 28;
/** Aerobic cross-training sessions per week during the break for the cross-trained column (D). */
export const BREAK_XT_SESSIONS_PER_WEEK = 3;

/** Pace (velocity) multiplier after `daysOff` days, linear between table columns (§8 R-BREAK). */
export function breakPaceMultiplier(daysOff: number, crossTrained: boolean): number {
  const ys = crossTrained ? BREAK_TABLE_XT : BREAK_TABLE_NO_XT;
  const xs = BREAK_TABLE_DAYS;
  if (daysOff <= xs[0]) return 1;
  if (daysOff >= xs[xs.length - 1]!) return ys[ys.length - 1]!;
  for (let i = 1; i < xs.length; i++) {
    const x1 = xs[i]!;
    if (daysOff <= x1) {
      const x0 = xs[i - 1]!;
      const f = (daysOff - x0) / (x1 - x0);
      return ys[i - 1]! + f * (ys[i]! - ys[i - 1]!);
    }
  }
  return ys[ys.length - 1]!;
}

export interface BreakInfo {
  daysOff: number;
  lastRunDate: string;
  /** First running day after the break (today while the break is ongoing). */
  returnDate: string;
  ongoing: boolean;
  crossTrained: boolean;
  multiplier: number;
  /** ceil(d/2): length of each ramp phase. */
  halfDays: number;
  /** Exclusive end of the 50% phase and of the 75% phase. */
  end50: string;
  end75: string;
  preBreakWeeklyKm: number;
  preBreakLongest: { km: number; minutes: number };
}

function runDates(runs: readonly Activity[], today: string): string[] {
  return [...new Set(runs.filter((r) => r.date <= today).map((r) => r.date))].sort();
}

/**
 * The most recent run of consecutive no-running days that still matters today: a break of ≥ 6 days
 * (or ≥ 1 day when `minDays` is lowered, e.g. for a systemic illness, R-ILL-4) whose return ramp has
 * not finished, or that is still going on. Undefined without any run history (nothing to measure).
 */
export function detectBreak(
  runs: readonly Activity[],
  activities: readonly Activity[],
  today: string,
  minDays = BREAK_RESUME_MAX_DAYS + 1,
): BreakInfo | undefined {
  const dates = runDates(runs, today);
  if (dates.length === 0) return undefined;
  const gaps: Array<{ last: string; ret: string; days: number; ongoing: boolean }> = [];
  for (let i = 1; i < dates.length; i++) {
    const a = dates[i - 1]!;
    const b = dates[i]!;
    gaps.push({ last: a, ret: b, days: daysBetween(a, b) - 1, ongoing: false });
  }
  const last = dates[dates.length - 1]!;
  if (last < today) gaps.push({ last, ret: today, days: daysBetween(last, today) - 1, ongoing: true });
  for (let i = gaps.length - 1; i >= 0; i--) {
    const g = gaps[i]!;
    if (g.days < minDays) continue;
    const half = Math.ceil(g.days / 2);
    const end75 = addDays(g.ret, 2 * half);
    if (!g.ongoing && today >= end75 && g.days <= BREAK_REBUILD_DAYS) return undefined;
    if (!g.ongoing && g.days > BREAK_REBUILD_DAYS && daysBetween(g.ret, today) > BREAK_REBUILD_DAYS) return undefined;
    const xtSessions = activities.filter((a) => a.date > g.last && a.date < g.ret && isAerobicCrossTraining(a)).length;
    const crossTrained = xtSessions >= (BREAK_XT_SESSIONS_PER_WEEK * g.days) / 7;
    const breakStart = addDays(g.last, 1);
    return {
      daysOff: g.days,
      lastRunDate: g.last,
      returnDate: g.ret,
      ongoing: g.ongoing,
      crossTrained,
      multiplier: breakPaceMultiplier(g.days, crossTrained),
      halfDays: half,
      end50: addDays(g.ret, half),
      end75,
      preBreakWeeklyKm: medianWeeklyKm(runs, breakStart, 4),
      preBreakLongest: longestRun(runs, breakStart, 30),
    };
  }
  return undefined;
}

// ── weekly volume and longest run (§6.1 derived inputs) ──────────────────────────────────────────

function median(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

function kmBetween(runs: readonly Activity[], from: string, toExclusive: string): number {
  return runs
    .filter((r) => r.sport === "run" && !r.isRace && r.date >= from && r.date < toExclusive)
    .reduce((a, r) => a + r.distanceM / 1000, 0);
}

/** Median of `n` 7-day windows of actual running km ending the day before `before`. */
export function medianWeeklyKm(runs: readonly Activity[], before: string, n: number): number {
  const weeks: number[] = [];
  for (let i = 1; i <= n; i++) weeks.push(kmBetween(runs, addDays(before, -7 * i), addDays(before, -7 * (i - 1))));
  return median(weeks);
}

/** Mean of `n` 7-day windows of actual running km ending the day before `before` (R-MISS-4 re-anchor). */
export function meanWeeklyKm(runs: readonly Activity[], before: string, n: number): number {
  let total = 0;
  for (let i = 1; i <= n; i++) total += kmBetween(runs, addDays(before, -7 * i), addDays(before, -7 * (i - 1)));
  return total / n;
}

/**
 * current_weekly_km (§6.1): median of the last 4 completed non-cutback plan weeks, by ACTUAL km.
 * Before 4 such weeks exist, 7-day windows before the plan fill in; with no runs at all, `fallbackKm`.
 */
export function currentWeeklyKmFromHistory(plan: Plan, runs: readonly Activity[], today: string, fallbackKm: number): number {
  if (!runs.some((r) => r.sport === "run" && r.date < today)) return fallbackKm;
  const done = plan.weeks.filter((w) => addDays(w.startDate, 7) <= today && !w.isCutback && !w.isTaper);
  const weeks = done.slice(-4).map((w) => kmBetween(runs, w.startDate, addDays(w.startDate, 7)));
  const firstStart = plan.weeks[0]?.startDate ?? today;
  for (let i = 1; weeks.length < 4; i++) weeks.push(kmBetween(runs, addDays(firstStart, -7 * i), addDays(firstStart, -7 * (i - 1))));
  return median(weeks);
}

/** Longest non-race run (distance and duration, separately) in the `days` before `before`. */
export function longestRun(runs: readonly Activity[], before: string, days = 30): { km: number; minutes: number } {
  const from = addDays(before, -days);
  let km = 0;
  let minutes = 0;
  for (const r of runs) {
    if (r.sport !== "run" || r.isRace || r.date < from || r.date >= before) continue;
    km = Math.max(km, r.runWalk ? 0 : r.distanceM / 1000);
    minutes = Math.max(minutes, r.movingS / 60);
  }
  return { km: Math.round(km * 10) / 10, minutes: Math.round(minutes) };
}

/** Actual non-race runs as V1 records (§6.5: run/walk counts by duration only). */
export function v1History(runs: readonly Activity[]): RunRecord[] {
  return runs
    .filter((r) => r.sport === "run" && !r.isRace)
    .map((r) => (r.runWalk ? { day: toDayNumber(r.date), minutes: r.movingS / 60 } : { day: toDayNumber(r.date), km: r.distanceM / 1000, minutes: r.movingS / 60 }));
}

// ── load (§10.1) ─────────────────────────────────────────────────────────────────────────────────

export function dailyLoads(activities: readonly Activity[], from: string, toExclusive: string, includeMonotonyExcluded = true): number[] {
  const n = Math.max(0, daysBetween(from, toExclusive));
  const out = new Array<number>(n).fill(0);
  for (const a of activities) {
    if (a.date < from || a.date >= toExclusive) continue;
    if (!includeMonotonyExcluded && SPORT_CLASS[a.sport].excludeFromMonotony) continue;
    const i = daysBetween(from, a.date);
    out[i] = (out[i] ?? 0) + sessionLoad(a);
  }
  return out;
}

export function loadBetween(activities: readonly Activity[], from: string, toExclusive: string): number {
  return dailyLoads(activities, from, toExclusive).reduce((a, b) => a + b, 0);
}

export function crossTrainingShare(activities: readonly Activity[], from: string, toExclusive: string): number {
  const total = loadBetween(activities, from, toExclusive);
  if (total <= 0) return 0;
  const xt = loadBetween(activities.filter((a) => a.sport !== "run"), from, toExclusive);
  return xt / total;
}

// ── illness episodes (R-ILL) ─────────────────────────────────────────────────────────────────────

/** Episodes keyed by onset date; the latest report about an onset wins (events pre-sorted). */
export function illnessEpisodes(events: readonly CheckInEvent[]): IllnessEvent[] {
  const byOnset = new Map<string, IllnessEvent>();
  for (const e of events) if (e.type === "illness") byOnset.set(e.date, e);
  return [...byOnset.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
}

/** Deterministic event order: by report date, then event date, then input order. */
export function sortEvents(events: readonly CheckInEvent[]): CheckInEvent[] {
  return events
    .map((e, i) => ({ e, i }))
    .sort((a, b) => {
      const ra = a.e.reportedOn ?? a.e.date;
      const rb = b.e.reportedOn ?? b.e.date;
      if (ra !== rb) return ra < rb ? -1 : 1;
      if (a.e.date !== b.e.date) return a.e.date < b.e.date ? -1 : 1;
      return a.i - b.i;
    })
    .map((x) => x.e);
}
