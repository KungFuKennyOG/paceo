/**
 * Applying replanning actions to a plan (spec §8), and the guards every replan output passes:
 *   - V1 (R-LOAD-1) against ACTUAL history: every editable run ≤ 1.10 × the longest non-race run
 *     actually done in the prior 30 days (plus planned runs between today and that day), §6.5.
 *   - §7.1 hard constraints on the lived schedule: no key session next to another key day (48 h),
 *     nothing hard the day before/after the LR, ≤ 3 key sessions a week, the LR is the week's longest run.
 * Days before `editableFrom` are never touched. Every changed workout gets a rule-trace marker, which
 * also makes re-applying the same action a no-op (idempotence across daily replans).
 */
import type { Activity } from "./activity.js";
import { addDays, toDayNumber } from "./dates.js";
import { floorKm } from "./long-run.js";
import type { PaceRange } from "./paces.js";
import type { Phase, Plan, PlanInput, PlanSummary, PlanWeek, VolumeFlag } from "./plan-types.js";
import { midPace, prescriptionFor, type PaceSet, type Prescription } from "./prescription.js";
import { currentPaces, isQualityWorkout, qualityAllowedOn, type RuleContext } from "./replan-context.js";
import { isLowerStrength } from "./strength.js";
import type { FitnessState, ReplanAction, ReplanChange } from "./replan-types.js";
import { plannedWeekLoad } from "./rules/load.js";
import { dayName, workoutLabel } from "./rules/miss.js";
import { EASY_MIN_MINUTES } from "./scheduler.js";
import { formatDistance, type Units } from "./units.js";
import { v1Limit, v1Measure, v1Ok, v1Reference, type RunRecord, type V1Limit } from "./v1.js";
import { hrTargetsFor, resolveHrMax, type ResolvedHr } from "./hr.js";
import type { PlannedWorkout, SimpleStep, Step } from "./workout.js";
import * as W from "./workouts.js";

// ── builder: current paces (and an active break multiplier) for rebuilt sessions ─────────────────

export interface PaceScale {
  from: string;
  factor: number;
  rule: string;
}

export function paceMarker(s: Pick<PaceScale, "rule" | "factor">): string {
  return `${s.rule}:pace×${s.factor.toFixed(3)}`;
}

function scaleRange(r: PaceRange, f: number): PaceRange {
  return { fast: r.fast / f, slow: r.slow / f };
}

function scalePaceSet(p: PaceSet, f: number): PaceSet {
  return { ...p, E: scaleRange(p.E, f), LR: scaleRange(p.LR, f), REC: scaleRange(p.REC, f), T: scaleRange(p.T, f), I: scaleRange(p.I, f), R: scaleRange(p.R, f), M: scaleRange(p.M, f), GP: scaleRange(p.GP, f), HM: scaleRange(p.HM, f) };
}

export class Builder {
  readonly paces: PaceSet;
  readonly rx: Prescription;
  scale: PaceScale | undefined;
  constructor(input: PlanInput, fitness: FitnessState) {
    this.paces = currentPaces(input, fitness.vdot, fitness.status);
    this.rx = prescriptionFor(input.level, fitness.status, this.paces);
    this.level = input.level;
    this.distance = input.goal.distance;
    // HR targets exactly as the plan made them (hr.ts), so rebuilt and edited sessions match.
    this.hr = hrTargetsFor(input.level, resolveHrMax(input));
  }
  readonly level: PlanInput["level"];
  readonly distance: PlanInput["goal"]["distance"];
  readonly hr: ResolvedHr | undefined;

  pacesOn(date: string): PaceSet {
    return this.scale && date >= this.scale.from ? scalePaceSet(this.paces, this.scale.factor) : this.paces;
  }

  ctx(date: string, phase: string | undefined, weeklyKm: number): W.BuildContext {
    const c: W.BuildContext = { paces: this.pacesOn(date), rx: this.rx, level: this.level, distance: this.distance, phase: (phase ?? "FI") as Phase, weeklyKm };
    if (this.hr) c.hr = this.hr;
    return c;
  }

  /** Stamp a draft onto a day, adding the pace marker when the break multiplier applies. */
  finish(draft: W.WorkoutDraft, base: Pick<PlannedWorkout, "id" | "user_id" | "date">): PlannedWorkout {
    const trace = draft.rule_trace.filter((t) => !t.includes(":pace×"));
    if (this.scale && base.date >= this.scale.from) trace.push(paceMarker(this.scale));
    return { ...base, ...draft, rule_trace: trace };
  }
}

// ── editor ───────────────────────────────────────────────────────────────────────────────────────

const STALE = [/^V2:replan_cap/, /^V1:ok/, /^L3:/, /^W-/, /^CAP:/, /^Q:work/, /:pace×/, /^V1:trimmed/, /^V1:shortened/];

function keepTrace(t: readonly string[]): string[] {
  return t.filter((x) => !STALE.some((r) => r.test(x)));
}

function km(w: PlannedWorkout): number {
  return w.planned.run_m / 1000;
}

function lrContent(w: PlannedWorkout): W.LongRunContentKind {
  const c = w.rule_trace.find((t) => t.startsWith("L3:"))?.slice(3);
  return c === "fast_finish" || c === "m_segment" ? c : "easy";
}

function strideCountOf(w: PlannedWorkout): number {
  const rep = w.steps.find((s): s is Extract<Step, { kind: "repeat" }> => s.kind === "repeat");
  return w.type === "S" && rep ? rep.count : 0;
}

export function idFor(userId: string, weekIndex: number, date: string): string {
  return `${userId}-w${String(weekIndex).padStart(2, "0")}-${date}`;
}

export interface EditLog {
  changes: ReplanChange[];
  trace: string[];
}

export class PlanEditor {
  readonly weeks: PlanWeek[];
  /** Week index → rule IDs that changed it (for VolumeFlag reasons). */
  readonly touched = new Map<number, Set<string>>();
  readonly log: EditLog = { changes: [], trace: [] };

  constructor(
    plan: Plan,
    readonly ctx: RuleContext,
    readonly b: Builder,
    readonly units: Units,
  ) {
    this.weeks = JSON.parse(JSON.stringify(plan.weeks)) as PlanWeek[];
  }

  editable(date: string): boolean {
    return date >= this.ctx.editableFrom;
  }

  weekOf(date: string): PlanWeek | undefined {
    return this.weeks.find((w) => w.startDate <= date && date <= addDays(w.startDate, 6));
  }

  runOn(date: string): PlannedWorkout | undefined {
    return this.weekOf(date)?.workouts.find((w) => w.date === date && w.sport === "run");
  }

  /** Editable runs (incl. the race) in date order. */
  futureRuns(): PlannedWorkout[] {
    return this.weeks.flatMap((w) => w.workouts).filter((w) => w.sport === "run" && this.editable(w.date)).sort((a, b) => (a.date < b.date ? -1 : 1));
  }

  private touch(date: string, rule: string): void {
    const wk = this.weekOf(date);
    if (!wk) return;
    const set = this.touched.get(wk.index) ?? new Set<string>();
    set.add(rule.split(":")[0] as string);
    this.touched.set(wk.index, set);
  }

  put(date: string, w: PlannedWorkout, rule: string): void {
    const wk = this.weekOf(date);
    if (!wk || !this.editable(date)) return;
    const i = wk.workouts.findIndex((x) => x.date === date && x.sport === "run");
    const placed = { ...w, id: idFor(w.user_id, wk.index, date), date };
    if (i >= 0) wk.workouts[i] = placed;
    else {
      wk.workouts.push(placed);
      wk.workouts.sort((a, b) => (a.date < b.date ? -1 : 1));
    }
    this.touch(date, rule);
  }

  /** Remove the run on `date` (never the race); with `strength`, that day's strength session too. */
  remove(date: string, rule: string, strength = false): PlannedWorkout | undefined {
    const wk = this.weekOf(date);
    if (!wk || !this.editable(date)) return undefined;
    if (strength) wk.workouts = wk.workouts.filter((x) => !(x.date === date && x.sport === "strength"));
    const i = wk.workouts.findIndex((x) => x.date === date && x.sport === "run" && x.type !== "RACE");
    if (i < 0) return undefined;
    const [gone] = wk.workouts.splice(i, 1);
    this.touch(date, rule);
    return gone;
  }

  private bctx(w: PlannedWorkout): W.BuildContext {
    const wk = this.weekOf(w.date);
    return this.b.ctx(w.date, w.phase ?? wk?.phase, wk?.targetKm ?? 0);
  }

  private base(w: PlannedWorkout): Pick<PlannedWorkout, "id" | "user_id" | "date"> {
    return { id: w.id, user_id: w.user_id, date: w.date };
  }

  easyLike(w: PlannedWorkout, kmWanted: number, trace: string[], strides = 0): PlannedWorkout {
    const c = this.bctx(w);
    const k = Math.max(1, floorKm(kmWanted));
    return this.b.finish(W.easyRun(c, k, { strides, trace }), this.base(w));
  }

  longLike(w: PlannedWorkout, kmWanted: number, content: W.LongRunContentKind, trace: string[]): PlannedWorkout {
    const c = this.bctx(w);
    return this.b.finish(W.longRun(c, Math.max(1, floorKm(kmWanted)), { content, trace }), this.base(w));
  }

  /** Minutes → km at the day's easy pace. */
  easyKmFor(w: PlannedWorkout, minutes: number): number {
    return (minutes * 60) / midPace(this.b.pacesOn(w.date).E);
  }
}

function has(w: PlannedWorkout, marker: string): boolean {
  return w.rule_trace.includes(marker);
}

function isTestRun(w: PlannedWorkout): boolean {
  return w.rule_trace.some((t) => t.includes(":test("));
}

function datesIn(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

const ORDER: ReplanAction["kind"][] = [
  "move",
  "scale_volume",
  "no_quality",
  "easy",
  "shorten",
  "cap_long_run",
  "cap_week_km",
  "trim_load",
  "test_run",
  "cross_training_only",
  "rest",
];

/** Apply rule actions (scale_paces is separate: see applyPaceScale). Stable order, most restrictive last. */
export function applyActions(ed: PlanEditor, actions: readonly ReplanAction[], plan: Plan): void {
  const sorted = actions
    .map((a, i) => ({ a, i }))
    .filter(({ a }) => a.kind !== "scale_paces")
    .sort((x, y) => ORDER.indexOf(x.a.kind) - ORDER.indexOf(y.a.kind) || x.i - y.i)
    .map(({ a }) => a);
  const original = new Map(plan.weeks.flatMap((w) => w.workouts).map((w) => [w.id, w]));
  for (const a of sorted) applyOne(ed, a, original);
}

function applyOne(ed: PlanEditor, a: ReplanAction, original: ReadonlyMap<string, PlannedWorkout>): void {
  switch (a.kind) {
    case "move": {
      const src = original.get(a.workoutId);
      const host = ed.runOn(a.toDate);
      const marker = `${a.rule}:from(${a.fromDate})`;
      if (!src || !host || !ed.editable(a.toDate) || has(host, marker)) return;
      ed.put(a.toDate, { ...JSON.parse(JSON.stringify(src)) as PlannedWorkout, rule_trace: [...src.rule_trace, marker] }, a.rule);
      return;
    }
    case "scale_volume": {
      const marker = `${a.rule}:vol×${a.factor}`;
      for (const d of datesIn(a.from, a.to)) {
        const w = ed.runOn(d);
        if (!w || !ed.editable(d) || w.type === "RACE" || w.type === "RW" || has(w, marker) || isTestRun(w)) continue;
        const target = km(w) * a.factor;
        if (w.type === "L") ed.put(d, ed.longLike(w, target, a.easyOnly ? "easy" : lrContent(w), [...keepTrace(w.rule_trace), marker]), a.rule);
        else if (isQualityWorkout(w)) {
          if (a.easyOnly) ed.put(d, ed.easyLike(w, target, [marker, `${a.rule}:easy(was:${w.type})`]), a.rule);
          else ed.put(d, { ...w, rule_trace: [...w.rule_trace, marker] }, a.rule);
        } else ed.put(d, ed.easyLike(w, target, [...keepTrace(w.rule_trace), marker], a.easyOnly ? 0 : strideCountOf(w)), a.rule);
      }
      return;
    }
    case "no_quality": {
      const marker = `${a.rule}:no_quality`;
      for (const d of datesIn(a.from, a.to)) {
        const w = ed.runOn(d);
        if (!w || !ed.editable(d) || has(w, marker) || isTestRun(w)) continue;
        const kinds = a.kinds ?? ["T", "I", "R", "H", "M", "TT"];
        if (isQualityWorkout(w) && kinds.includes(w.type)) ed.put(d, ed.easyLike(w, km(w), [marker, `${a.rule}:easy(was:${w.type})`]), a.rule);
        else if (w.type === "L" && a.kinds === undefined && lrContent(w) !== "easy") ed.put(d, ed.longLike(w, km(w), "easy", [...keepTrace(w.rule_trace), marker]), a.rule);
      }
      return;
    }
    case "easy": {
      const w = ed.runOn(a.date);
      const marker = `${a.rule}:easy(was:${w?.type ?? ""})`;
      if (!w || !ed.editable(a.date) || w.type === "RACE" || w.type === "RW" || w.rule_trace.some((t) => t.startsWith(`${a.rule}:easy(`)) || isTestRun(w)) return;
      const capMin = Math.min(a.maxFraction !== undefined ? a.maxFraction * w.planned.minutes : Infinity, a.maxMinutes ?? Infinity);
      const capKm = Number.isFinite(capMin) ? ed.easyKmFor(w, capMin) : Infinity;
      if (w.type === "L" && !Number.isFinite(capKm)) {
        ed.put(a.date, ed.longLike(w, km(w), "easy", [...keepTrace(w.rule_trace), marker]), a.rule);
        return;
      }
      if (!isQualityWorkout(w) && w.type !== "L" && !Number.isFinite(capKm)) {
        ed.put(a.date, { ...w, rule_trace: [...w.rule_trace, marker] }, a.rule);
        return;
      }
      ed.put(a.date, ed.easyLike(w, Math.min(km(w), capKm), [marker]), a.rule);
      return;
    }
    case "shorten": {
      const w = ed.runOn(a.date);
      const marker = `${a.rule}:shorten×${a.factor}`;
      if (!w || !ed.editable(a.date) || w.type === "RACE" || has(w, marker)) return;
      if (w.type === "L") ed.put(a.date, ed.longLike(w, km(w) * a.factor, lrContent(w), [...keepTrace(w.rule_trace), marker]), a.rule);
      else ed.put(a.date, ed.easyLike(w, km(w) * a.factor, [marker]), a.rule);
      return;
    }
    case "cap_long_run": {
      for (const d of datesIn(a.from, a.to)) {
        const w = ed.runOn(d);
        if (!w || w.type !== "L" || !ed.editable(d) || km(w) <= a.km + 1e-9) continue;
        ed.put(d, ed.longLike(w, a.km, "easy", [...keepTrace(w.rule_trace), `${a.rule}:LR≤${a.km.toFixed(1)}`]), a.rule);
      }
      return;
    }
    case "cap_week_km":
      trimWeek(ed, a.weekStart, a.rule, `${a.rule}:week≤${a.km.toFixed(1)}`, (wk) => weekKm(ed, wk) - a.km, (w) => km(w));
      return;
    case "trim_load":
      trimWeek(ed, a.weekStart, a.rule, `${a.rule}:trim`, (wk) => weekLoad(ed, wk) - a.maxLoad, (w) => w.planned.expected_srpe * w.planned.minutes, true);
      return;
    case "test_run": {
      const marker = `${a.rule}:test(${a.minutes}min)`;
      const w = ed.runOn(a.date);
      if (!ed.editable(a.date) || (w && (has(w, marker) || w.type === "RACE"))) return;
      const wk = ed.weekOf(a.date);
      if (!wk) return;
      const userId = w?.user_id ?? wk.workouts[0]?.user_id ?? ed.ctx.input.userId ?? "me";
      const stub: PlannedWorkout = w ?? {
        id: idFor(userId, wk.index, a.date),
        user_id: userId,
        date: a.date,
        sport: "run",
        type: "E",
        name: "",
        phase: wk.phase,
        prescription_mode: "time_rpe",
        steps: [],
        planned: { run_m: 0, minutes: 0, expected_srpe: 2 },
        flags: { heat_adjusted: false, key_session: false },
        rule_trace: [],
      };
      const built = ed.easyLike(stub, ed.easyKmFor(stub, a.minutes), [marker]);
      const title = a.label === "exercise_challenge" ? "Return test" : "Pain test";
      ed.put(a.date, { ...timeBased(built, a.minutes), name: `${title}: ${a.minutes} min very easy` }, a.rule);
      return;
    }
    case "cross_training_only":
      for (const d of datesIn(a.from, a.to)) ed.remove(d, a.rule);
      return;
    case "rest":
      // Fever / systemic illness: no training at all, strength included (§8 R-ILL-1, D).
      ed.remove(a.date, a.rule, a.rule.startsWith("R-ILL"));
      return;
    case "scale_paces":
      return;
  }
}

/** Force a single-step easy run to a fixed duration with an RPE target (test runs are by feel). */
function timeBased(w: PlannedWorkout, minutes: number): PlannedWorkout {
  const step: SimpleStep = { kind: "run", duration: { type: "time", s: minutes * 60 }, target: { type: "rpe", value: "2-3" }, rpe: "2-3" };
  const paceS = w.planned.minutes > 0 && w.planned.run_m > 0 ? (w.planned.minutes * 60) / (w.planned.run_m / 1000) : 420;
  return { ...w, prescription_mode: "time_rpe", steps: [step], planned: { ...w.planned, minutes, run_m: Math.round(((minutes * 60) / paceS) * 1000), expected_srpe: 2 } };
}

function weekRuns(ed: PlanEditor, wk: PlanWeek): PlannedWorkout[] {
  return wk.workouts.filter((w) => w.sport === "run" && w.type !== "RACE");
}

function actualOn(ctx: RuleContext, date: string): Activity[] {
  return ctx.activities.filter((a) => a.date === date);
}

function weekKm(ed: PlanEditor, wk: PlanWeek): number {
  let total = 0;
  for (let i = 0; i < 7; i++) {
    const d = addDays(wk.startDate, i);
    if (!ed.editable(d)) total += actualOn(ed.ctx, d).filter((a) => a.sport === "run" && !a.isRace).reduce((a, x) => a + x.distanceM / 1000, 0);
  }
  return total + weekRuns(ed, wk).filter((w) => ed.editable(w.date)).reduce((a, w) => a + km(w), 0);
}

/** Lived load on past days + planned load (runs, strength, locked cross-training) on editable days. */
function weekLoad(ed: PlanEditor, wk: PlanWeek): number {
  return plannedWeekLoad(ed.ctx, wk.startDate, ed.weeks);
}

/**
 * Trim a week by `excess(week)` measured with `size(workout)`: easy runs first (proportionally, never
 * below 20 min), then, if allowed, the second quality session → easy. Never the long run (R-LOAD-2).
 */
function trimWeek(
  ed: PlanEditor,
  weekStart: string,
  rule: string,
  marker: string,
  excess: (wk: PlanWeek) => number,
  size: (w: PlannedWorkout) => number,
  allowQ2 = false,
): void {
  const wk = ed.weekOf(weekStart);
  if (!wk) return;
  let over = excess(wk);
  if (over <= 1e-6) return;
  const easy = weekRuns(ed, wk).filter((w) => ed.editable(w.date) && (w.type === "E" || w.type === "S") && !isTestRun(w));
  const room = easy.map((w) => Math.max(0, size(w) * (1 - EASY_MIN_MINUTES / Math.max(w.planned.minutes, EASY_MIN_MINUTES))));
  const totalRoom = room.reduce((a, b) => a + b, 0);
  if (totalRoom > 0) {
    const f = Math.min(1, over / totalRoom);
    easy.forEach((w, i) => {
      const cut = (room[i] as number) * f;
      if (cut <= 0) return;
      const scale = (size(w) - cut) / size(w);
      ed.put(w.date, ed.easyLike(w, km(w) * scale, [...keepTrace(w.rule_trace), marker], strideCountOf(w)), rule);
    });
    over = excess(wk);
  }
  if (over > 1e-6 && allowQ2) {
    const q2 = weekRuns(ed, wk).find((w) => ed.editable(w.date) && isQualityWorkout(w) && w.rule_trace.some((t) => /:Q2$/.test(t)));
    if (q2) ed.put(q2.date, ed.easyLike(q2, km(q2), [marker, `${rule}:easy(was:${q2.type})`]), rule);
  }
}

// ── pace changes ─────────────────────────────────────────────────────────────────────────────────

/** Map every pace target of a workout and re-estimate planned km/minutes from the new midpoints. */
export function mapPaces(w: PlannedWorkout, fn: (lo: number, hi: number) => [number, number]): PlannedWorkout {
  let dS = 0;
  let dM = 0;
  const one = (st: SimpleStep, mult: number): SimpleStep => {
    // The pace range is the target, or the fallback of an HR-targeted easy / long step (§3.7).
    const inTarget = st.target.type === "pace";
    const pace = st.target.type === "pace" ? st.target : st.fallback?.type === "pace" ? st.fallback : undefined;
    if (!pace) return st;
    const oldMid = (pace.lo_s_per_km + pace.hi_s_per_km) / 2;
    const [lo, hi] = fn(pace.lo_s_per_km, pace.hi_s_per_km);
    const newMid = (lo + hi) / 2;
    if (st.duration.type === "distance") dS += mult * (st.duration.m / 1000) * (newMid - oldMid);
    else if (st.duration.type === "time") dM += mult * st.duration.s * (1000 / newMid - 1000 / oldMid);
    const mapped = { type: "pace" as const, lo_s_per_km: round1(lo), hi_s_per_km: round1(hi) };
    return inTarget ? { ...st, target: mapped } : { ...st, fallback: mapped };
  };
  const steps: Step[] = w.steps.map((st) => (st.kind === "repeat" ? { ...st, steps: st.steps.map((x) => one(x, st.count)) } : one(st, 1)));
  return {
    ...w,
    steps,
    planned: { ...w.planned, run_m: Math.max(0, Math.round(w.planned.run_m + dM)), minutes: Math.max(0.1, round1(w.planned.minutes + dS / 60)) },
  };
}

/** R-BREAK multiplier on kept workouts (rebuilt ones already got scaled paces from the Builder). */
export function applyPaceScale(ed: PlanEditor, s: PaceScale): void {
  const marker = paceMarker(s);
  for (const w of ed.futureRuns()) {
    if (w.date < s.from || has(w, marker)) continue;
    const scaled = mapPaces(w, (lo, hi) => [lo / s.factor, hi / s.factor]);
    ed.put(w.date, { ...scaled, rule_trace: [...w.rule_trace, marker] }, s.rule);
  }
}

const ZONES = ["E", "LR", "REC", "T", "I", "R", "M", "GP", "HM"] as const;

/** FIT-UPDATE in place: each pace target is matched to its zone in the old PaceSet and moved to the new one. */
export function repaceFuture(ed: PlanEditor, oldP: PaceSet, newP: PaceSet, marker: string): void {
  const ratio = midPace(newP.T) / midPace(oldP.T);
  for (const w of ed.futureRuns()) {
    if (has(w, marker)) continue;
    const re = mapPaces(w, (lo, hi) => {
      for (const z of ZONES) {
        const o = oldP[z];
        if (Math.abs(round1(o.fast) - lo) < 0.06 && Math.abs(round1(o.slow) - hi) < 0.06) return [newP[z].fast, newP[z].slow];
      }
      return [lo * ratio, hi * ratio];
    });
    ed.put(w.date, { ...re, rule_trace: [...w.rule_trace, marker] }, "FIT-UPDATE");
  }
}

// ── guards ───────────────────────────────────────────────────────────────────────────────────────

/** R-LOAD-1: V1 against actual history + planned runs before each day. Shrinks any run over its limit. */
export function enforceV1Actual(ed: PlanEditor): void {
  const ctx = ed.ctx;
  const records: RunRecord[] = ctx.runs
    .filter((r) => r.date < ctx.editableFrom && !r.isRace)
    .map((r) => (r.runWalk ? { day: toDayNumber(r.date), minutes: r.movingS / 60 } : { day: toDayNumber(r.date), km: r.distanceM / 1000, minutes: r.movingS / 60 }));
  const window = addDays(ctx.editableFrom, 14);
  for (const w0 of ed.futureRuns()) {
    if (w0.type === "RACE") continue;
    const day = toDayNumber(w0.date);
    const limit: V1Limit = v1Limit(v1Reference(records, ctx.v1Seed, day), ctx.timeMode);
    let w = w0;
    if (!v1Ok(km(w), w.planned.minutes, limit, w.type === "RW")) {
      w = shrink(ed, w, limit);
      ed.put(w.date, w, "R-LOAD-1");
      if (w.date < window) {
        ed.log.changes.push({
          rule: "R-LOAD-1",
          date: w.date,
          message: `${dayName(w.date)}'s ${workoutLabel(w0)} is now ${formatDistance(w.planned.run_m, ed.units)}: a single run stays within 10% of your longest run in the last 30 days (${formatDistance(limit.km / 1.1 * 1000, ed.units)}).`,
        });
      }
    }
    records.push({ day, ...v1Measure(w) });
  }
}

function shrink(ed: PlanEditor, w: PlannedWorkout, limit: V1Limit): PlannedWorkout {
  const tag = `R-LOAD-1:v1_actual(${Math.min(km(w), limit.km).toFixed(1)}<=${limit.km.toFixed(1)})`;
  if (w.type === "RW") return { ...w, rule_trace: [...w.rule_trace, tag] };
  const paces = ed.b.pacesOn(w.date);
  if (w.type === "L") {
    const k = floorKm(Math.min(limit.km, (limit.minutes * 60) / midPace(paces.LR)) - 0.05);
    return ed.longLike(w, k, lrContent(w), [...keepTrace(w.rule_trace), tag]);
  }
  if (isQualityWorkout(w)) {
    const wk = ed.weekOf(w.date);
    const fitted = W.fitWarmCool(ed.b.ctx(w.date, w.phase, wk?.targetKm ?? 0), w, limit.km, limit.minutes);
    if (fitted) return { ...w, ...fitted, rule_trace: [...fitted.rule_trace, tag] };
  }
  const k = floorKm(Math.min(limit.km, (limit.minutes * 60) / midPace(paces.E)) - 0.05);
  return ed.easyLike(w, k, [...keepTrace(w.rule_trace), tag]);
}

/** §7.1 on the lived schedule, plus "the LR is the week's longest run". Downgrades editable sessions only. */
export function enforceSchedule(ed: PlanEditor): void {
  const ctx = ed.ctx;
  const keyOn = (date: string): boolean => {
    if (!ed.editable(date)) {
      const planned = ctx.runOn.get(date);
      if (planned?.flags.key_session) {
        const m = ctx.matchById.get(planned.id);
        if (m && (m.status === "completed" || m.status === "partial")) return true;
      }
      return false;
    }
    return ed.runOn(date)?.flags.key_session === true;
  };
  const downgrade = (w: PlannedWorkout, why: string): void => {
    const e = ed.easyLike(w, km(w), [`SCHED:${why}`, `SCHED:easy(was:${w.type})`]);
    ed.put(w.date, e, "SCHED");
    if (w.date < addDays(ctx.editableFrom, 14)) {
      ed.log.changes.push({ rule: "SCHED", date: w.date, message: `${dayName(w.date)}'s ${workoutLabel(w)} is now an easy run to keep 48 h between hard days.` });
    }
  };
  for (const w of ed.futureRuns()) {
    if (!w.flags.key_session || w.type === "L" || w.type === "RACE") continue;
    if (keyOn(addDays(w.date, -1)) || keyOn(addDays(w.date, 1))) downgrade(w, "key_adjacent");
    else if (isQualityWorkout(w) && !qualityAllowedOn(ctx.plan, w.date)) downgrade(w, "after_hard_cross_training");
  }
  for (const wk of ed.weeks) {
    const keys = wk.workouts.filter((w) => w.sport === "run" && w.flags.key_session && w.type !== "RACE" && (ed.editable(w.date) ? true : keyOn(w.date)));
    const xtCost = (wk.crossTraining ?? []).reduce((a, x) => a + x.keyCost, 0);
    const editableKeys = keys.filter((w) => ed.editable(w.date) && w.type !== "L").sort((a, b) => (a.date < b.date ? 1 : -1));
    for (let n = keys.length + xtCost; n > 3 && editableKeys.length > 0; n--) downgrade(editableKeys.shift() as PlannedWorkout, "max_3_keys");
    // The LR stays the longest run (not in taper / TT weeks).
    if (wk.isTaper || wk.workouts.some((x) => x.type === "TT")) continue;
    const lr = wk.workouts.find((x) => x.type === "L");
    if (!lr) continue;
    for (const x of wk.workouts) {
      if (x === lr || x.type === "RACE" || x.sport !== "run" || !ed.editable(x.date) || x.planned.run_m <= lr.planned.run_m) continue;
      if (isQualityWorkout(x)) {
        const fitted = W.fitWarmCool(ed.b.ctx(x.date, x.phase, wk.targetKm), x, km(lr), Infinity);
        ed.put(x.date, fitted ? { ...x, ...fitted } : ed.easyLike(x, km(lr), [...keepTrace(x.rule_trace), "SCHED:lr_longest"]), "SCHED");
      } else ed.put(x.date, ed.easyLike(x, km(lr), [...keepTrace(x.rule_trace), "SCHED:lr_longest"], strideCountOf(x)), "SCHED");
    }
  }
}

/** V2 "never above 30%" week over week, on planned km: easy runs first, then the long run (D). */
export const V2_FACTOR = 1.3;
export const V2_RETURN_FLOOR = 0.75;

export function enforceWeeklyGrowth(ed: PlanEditor): void {
  for (let i = 1; i < ed.weeks.length; i++) {
    const prev = ed.weeks[i - 1] as PlanWeek;
    const wk = ed.weeks[i] as PlanWeek;
    if (prev.isLadder || wk.isLadder || addDays(wk.startDate, 6) < ed.ctx.editableFrom) continue;
    const prevKm = plannedKmOf(prev);
    if (prevKm <= 0) continue;
    // After a week that was cut well below its target (illness, pain, a break ramp), the next week may
    // come back to the ramp's 75% level of its own target; from there the 30% rule applies again (D).
    // Judged from the plan alone, so a second replan reaches the same fixed point.
    const cut = prevKm < V2_RETURN_FLOOR * prev.targetKm;
    const cap = Math.max(V2_FACTOR * prevKm, cut ? V2_RETURN_FLOOR * wk.targetKm : 0);
    const excess = (w: PlanWeek) => plannedKmOf(w) - cap;
    if (excess(wk) <= 0.05) continue;
    trimWeek(ed, wk.startDate, "V2", `V2:replan_cap(${cap.toFixed(1)})`, excess, (w) => km(w));
    const over = excess(wk);
    const lr = wk.workouts.find((w) => w.type === "L" && ed.editable(w.date));
    if (over > 0.05 && lr) ed.put(lr.date, ed.longLike(lr, Math.max(1, km(lr) - over - 0.05), lrContent(lr), [...keepTrace(lr.rule_trace), `V2:replan_cap(${cap.toFixed(1)})`]), "V2");
  }
}

function plannedKmOf(wk: PlanWeek): number {
  return wk.workouts.filter((w) => w.sport === "run" && w.type !== "RACE").reduce((a, w) => a + km(w), 0);
}

/**
 * Strength after run changes (§9.5): an editable lower-body session is dropped when a moved or
 * rebuilt run now breaks ST-3 (LR within 2 days after), ST-4 (quality the next day) or ST-5 (< 48 h
 * after another lower session). Running takes precedence in replanning (D).
 */
export function enforceStrength(ed: PlanEditor): void {
  const all = ed.weeks.flatMap((w) => w.workouts);
  const runOn = (d: string) => all.find((w) => w.sport === "run" && w.date === d);
  const lowerOn = (d: string) => all.some((w) => w.sport === "strength" && w.date === d && isLowerStrength(w) && !w.id.endsWith("-addon"));
  for (const wk of ed.weeks) {
    for (const s of [...wk.workouts]) {
      if (s.sport !== "strength" || !ed.editable(s.date) || !isLowerStrength(s)) continue;
      const lr = [0, 1, 2].some((k) => {
        const r = runOn(addDays(s.date, k));
        return r?.type === "L" || r?.type === "RACE";
      });
      const next = runOn(addDays(s.date, 1));
      const q = next !== undefined && next.flags.key_session && next.type !== "L" && next.type !== "RACE";
      const st5 = lowerOn(addDays(s.date, -1));
      if (!lr && !q && !st5) continue;
      wk.workouts = wk.workouts.filter((x) => x !== s);
      const i = all.indexOf(s);
      if (i >= 0) all.splice(i, 1);
      ed.log.trace.push(`ST:dropped(${s.date},${lr ? "ST-3" : q ? "ST-4" : "ST-5"})`);
      if (s.date < addDays(ed.ctx.editableFrom, 14)) {
        ed.log.changes.push({ rule: "SCHED", date: s.date, message: `${dayName(s.date)}'s strength session is dropped: after this week's changes it would sit too close to a hard run.` });
      }
    }
  }
}

// ── halt ─────────────────────────────────────────────────────────────────────────────────────────

/** Paused plan: nothing gets pushed to the watch for the next 14 days (§8 "stop the plan"). */
export function clearPushWindow(ed: PlanEditor, rule: string): void {
  for (const d of datesIn(ed.ctx.editableFrom, addDays(ed.ctx.editableFrom, 13))) ed.remove(d, rule, true);
}

// ── regenerated plan merge ───────────────────────────────────────────────────────────────────────

/** Start of the race-aligned 7-day block that contains `date` (weeks end on race day, §7). */
export function blockStart(date: string, raceDate: string): string {
  const n = Math.floor((toDayNumber(raceDate) - toDayNumber(date)) / 7);
  return addDays(raceDate, -7 * n - 6);
}

/**
 * Past days from `old`, editable days from `fresh` (generated with today = the current block's start).
 * Weeks keep their calendar position; fresh weeks are renumbered to continue the old numbering.
 */
export function mergeRegenerated(old: Plan, fresh: Plan, editableFrom: string): Plan {
  const firstFresh = fresh.weeks[0];
  if (!firstFresh) return old;
  const cur = old.weeks.find((w) => w.startDate === firstFresh.startDate);
  const offset = cur ? cur.index - 1 : old.weeks.filter((w) => w.startDate < firstFresh.startDate).length;
  const past = old.weeks.filter((w) => w.startDate < firstFresh.startDate);
  const renumber = (w: PlanWeek): PlanWeek => {
    const index = w.index + offset;
    const out: PlanWeek = { ...w, index, workouts: w.workouts.map((x) => ({ ...x, id: idFor(x.user_id, index, x.date) })) };
    if (w.volumeFlag) out.volumeFlag = { ...w.volumeFlag, week: index };
    return out;
  };
  const weeks: PlanWeek[] = [...JSON.parse(JSON.stringify(past)) as PlanWeek[]];
  fresh.weeks.forEach((w, i) => {
    const r = renumber(w);
    if (i === 0 && cur) {
      // Past days were sized against the old week; keep the larger target so its caps still hold.
      r.targetKm = Math.max(r.targetKm, cur.targetKm);
      const kept = cur.workouts.filter((x) => x.date < editableFrom);
      r.workouts = [...JSON.parse(JSON.stringify(kept)) as PlannedWorkout[], ...r.workouts.filter((x) => x.date >= editableFrom)];
      const xtKept = (cur.crossTraining ?? []).filter((x) => x.date < editableFrom);
      const xtNew = (r.crossTraining ?? []).filter((x) => x.date >= editableFrom);
      if (xtKept.length + xtNew.length > 0) r.crossTraining = [...JSON.parse(JSON.stringify(xtKept)) as typeof xtKept, ...xtNew];
    } else if (i === 0) {
      r.workouts = r.workouts.filter((x) => x.date >= editableFrom);
    }
    weeks.push(r);
  });
  return { feasibility: fresh.feasibility, weeks, summary: { ...fresh.summary, startDate: old.summary.startDate } };
}

// ── week and summary refresh ─────────────────────────────────────────────────────────────────────

const VOLUME_TOLERANCE = 0.1;

function round1(x: number): number {
  return Math.round(x * 10) / 10;
}

export function refreshPlan(plan: Plan, weeks: PlanWeek[], touched: ReadonlyMap<number, ReadonlySet<string>>, notes: readonly string[]): Plan {
  for (const wk of weeks) {
    const runs = wk.workouts.filter((w) => w.type !== "RACE" && w.sport === "run");
    wk.plannedKm = round1(runs.reduce((a, w) => a + km(w), 0));
    const lr = wk.workouts.find((w) => w.type === "L");
    wk.longRunKm = lr ? round1(km(lr)) : 0;
    const rules = touched.get(wk.index);
    if (!rules || rules.size === 0) continue;
    const off = wk.targetKm > 0 && !wk.isLadder && Math.abs(wk.plannedKm - wk.targetKm) > VOLUME_TOLERANCE * wk.targetKm;
    if (!off) {
      delete wk.volumeFlag;
      continue;
    }
    const reasons = new Set((wk.volumeFlag?.reasons ?? []).filter((r) => r !== "unexplained"));
    for (const r of rules) reasons.add(`${r}:replan`);
    const flag: VolumeFlag = { week: wk.index, targetKm: wk.targetKm, plannedKm: wk.plannedKm, reasons: [...reasons].sort() };
    wk.volumeFlag = flag;
  }
  let peakLr = 0;
  let peakLrWeek = 0;
  for (const wk of weeks) {
    if (wk.longRunKm >= peakLr && wk.longRunKm > 0) {
      peakLr = wk.longRunKm;
      peakLrWeek = wk.index;
    }
  }
  const phaseSplit: PlanSummary["phaseSplit"] = { BASE: 0, FI: 0, EQ: 0, TQ: 0, FQ: 0 };
  for (const wk of weeks) phaseSplit[wk.phase] += 1;
  const summary: PlanSummary = {
    ...plan.summary,
    weeks: weeks.length,
    phaseSplit,
    ladderWeeks: weeks.filter((w) => w.isLadder).length,
    peakWeekKm: round1(Math.max(0, ...weeks.map((w) => w.plannedKm))),
    peakLongRunKm: peakLr,
    peakLongRunWeek: peakLrWeek,
    totalKm: round1(weeks.reduce((a, w) => a + w.plannedKm, 0)),
    volumeFlags: weeks.flatMap((w) => (w.volumeFlag ? [w.volumeFlag] : [])),
    notes: [...notes],
  };
  return { feasibility: plan.feasibility, weeks, summary };
}
