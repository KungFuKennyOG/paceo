/**
 * R-HRV: optional readiness modifier (spec §8; Vesterinen 2016, E). A soft modifier only: the engine
 * works with HRV disabled and never changes weekly volume from HRV.
 *   R-HRV-1 enabled after ≥ 21 valid nights. ln(rMSSD); 7-day rolling mean vs a band of
 *           mean ± 0.5 SD of the nightly values over the last 28 nights (4-week baseline).
 *   R-HRV-2 rolling mean below the band, or above it with high fatigue → today's quality session
 *           becomes easy (and moves later in the week when a legal day exists, R-MISS-2 rules).
 *           Never skip the LR on HRV alone: shorten it by 20%.
 *   R-HRV-3 a single-night drop only prompts "how do you feel?"; ≥ 1 SD below the 10-day baseline on
 *           2 consecutive nights acts like R-HRV-2 (Kiviniemi rule).
 */
import { addDays } from "../dates.js";
import { dateRange, isKeyDay, isQualityWorkout, weekContaining, type RuleContext } from "../replan-context.js";
import { emptyResult, type HrvNight, type RuleResult } from "../replan-types.js";
import { dayName, workoutLabel } from "./miss.js";
import type { PlannedWorkout } from "../workout.js";

export const HRV_MIN_NIGHTS = 21;
export const HRV_BASELINE_DAYS = 28;
export const HRV_ROLLING_DAYS = 7;
export const HRV_SWC_SD = 0.5;
export const HRV_KIVINIEMI_DAYS = 10;
export const HRV_LR_SHORTEN = 0.8;
/** Readiness fatigue (1–5) at or above which "above the band" also counts as a warning. */
export const HIGH_FATIGUE = 4;

export interface HrvStatus {
  enabled: boolean;
  nights: number;
  rolling?: number;
  bandLo?: number;
  bandHi?: number;
  state: "disabled" | "below" | "within" | "above";
  singleDayDrop: boolean;
  twoDayDrop: boolean;
}

function lnNights(nights: readonly HrvNight[], from: string, to: string): number[] {
  return nights.filter((n) => n.date >= from && n.date <= to && n.rmssdMs > 0).map((n) => Math.log(n.rmssdMs));
}

function meanSd(xs: readonly number[]): { mean: number; sd: number } {
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const sd = Math.sqrt(xs.reduce((a, x) => a + (x - mean) ** 2, 0) / Math.max(1, xs.length - 1));
  return { mean, sd };
}

export function hrvStatus(nights: readonly HrvNight[], today: string): HrvStatus {
  const base = lnNights(nights, addDays(today, -(HRV_BASELINE_DAYS - 1)), today);
  const all = lnNights(nights, addDays(today, -59), today);
  const off: HrvStatus = { enabled: false, nights: all.length, state: "disabled", singleDayDrop: false, twoDayDrop: false };
  if (all.length < HRV_MIN_NIGHTS || base.length < 7) return off;
  const roll = lnNights(nights, addDays(today, -(HRV_ROLLING_DAYS - 1)), today);
  if (roll.length < 3) return off;
  const { mean, sd } = meanSd(base);
  const rolling = roll.reduce((a, b) => a + b, 0) / roll.length;
  const bandLo = mean - HRV_SWC_SD * sd;
  const bandHi = mean + HRV_SWC_SD * sd;
  const state = rolling < bandLo ? "below" : rolling > bandHi ? "above" : "within";
  const night = (d: string) => lnNights(nights, d, d)[0];
  const tonight = night(today);
  const k = (d: string) => {
    const ref = lnNights(nights, addDays(d, -HRV_KIVINIEMI_DAYS), addDays(d, -1));
    if (ref.length < 5) return undefined;
    return meanSd(ref);
  };
  const low = (d: string) => {
    const v = night(d);
    const r = k(d);
    return v !== undefined && r !== undefined && v < r.mean - r.sd;
  };
  return {
    enabled: true,
    nights: all.length,
    rolling,
    bandLo,
    bandHi,
    state,
    singleDayDrop: tonight !== undefined && tonight < bandLo && state === "within",
    twoDayDrop: low(today) && low(addDays(today, -1)),
  };
}

export function ruleHrv(ctx: RuleContext): RuleResult {
  const out = emptyResult("R-HRV");
  const s = hrvStatus(ctx.hrv, ctx.today);
  if (!s.enabled) {
    out.trace.push(`R-HRV:disabled(${s.nights}<${HRV_MIN_NIGHTS})`);
    return out;
  }
  out.trace.push(`R-HRV:${s.state}`);
  const fatigue = ctx.events.filter((e) => e.type === "readiness" && e.date === ctx.today).at(-1);
  const highFatigue = fatigue?.type === "readiness" && fatigue.fatigue >= HIGH_FATIGUE;
  const act = s.state === "below" || (s.state === "above" && highFatigue) || s.twoDayDrop;
  const today = ctx.editableFrom === ctx.today ? ctx.runOn.get(ctx.today) : undefined;
  if (!act) {
    if (s.singleDayDrop) out.changes.push({ rule: "R-HRV-3", message: "Your HRV dipped last night. How do you feel? If you're fine, train as planned." });
    return out;
  }
  const rule = s.twoDayDrop && s.state !== "below" ? "R-HRV-3" : "R-HRV-2";
  if (!today) return out;
  if (today.type === "L") {
    out.actions.push({ kind: "shorten", rule, date: today.date, factor: HRV_LR_SHORTEN, reason: "low readiness: long run shortened, not skipped" });
    out.changes.push({ rule, date: today.date, message: `Your HRV trend is low, so today's long run is ${Math.round((1 - HRV_LR_SHORTEN) * 100)}% shorter. Keep it truly easy.` });
    return out;
  }
  if (!isQualityWorkout(today)) return out;
  out.actions.push({ kind: "easy", rule, date: today.date, reason: "low readiness" });
  // Try to move the session later in the same week (R-MISS-2 constraints).
  const week = weekContaining(ctx.plan, today.date);
  const end = week ? addDays(week.startDate, 6) : today.date;
  const future = new Map<string, PlannedWorkout | undefined>(ctx.runOn);
  future.set(today.date, undefined);
  const slot = dateRange(addDays(today.date, 2), end).find((d) => {
    const host = ctx.runOn.get(d);
    if (!host || host.flags.key_session || isQualityWorkout(host) || d >= ctx.raceDate) return false;
    return !isKeyDay(ctx, addDays(d, -1), future) && !isKeyDay(ctx, addDays(d, 1), future);
  });
  if (slot) out.actions.push({ kind: "move", rule, workoutId: today.id, fromDate: today.date, toDate: slot, reason: "quality moved after a low-readiness day" });
  out.changes.push({
    rule,
    date: today.date,
    message: `Your HRV trend is ${s.state === "above" ? "unusually high and you feel tired" : "low"}: today's ${workoutLabel(today)} is now an easy run${slot ? ` and moves to ${dayName(slot)}` : ""}.`,
  });
  return out;
}
