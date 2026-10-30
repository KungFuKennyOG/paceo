/**
 * Plan matching and compliance (spec §3.9, §8 compliance classification).
 *
 * Each completed activity matches the planned workout with the same LOCAL date and sport. Several
 * same-day runs add up (double runs). A planned day with no activity is "missed" once the day is
 * over, or "skipped" when the user said so. Compliance is completed ÷ planned by distance, or by
 * duration for time/RPE and run/walk sessions (§8: run/walk is measured on total duration).
 * When laps map 1:1 onto the flattened steps, per-step pace compliance is computed too.
 */
import type { Activity, ActivityLap } from "./activity.js";
import { sortActivities } from "./activity.js";
import { addDays } from "./dates.js";
import type { Plan } from "./plan-types.js";
import type { PlannedWorkout, SimpleStep, Step } from "./workout.js";

export type WorkoutStatus = "completed" | "partial" | "missed" | "skipped" | "pending";
/** TrainingPeaks bands (C): green 80–120%, yellow 50–79 or 121–150, orange < 50 or > 150, red missed. */
export type ComplianceBand = "green" | "yellow" | "orange" | "red";

export const COMPLETED_MIN_RATIO = 0.8;
/** Weekly compliance at or above this → no structural change (Pfitzinger, C). */
export const NO_CHANGE_WEEKLY_COMPLIANCE = 0.9;

export function complianceBand(ratio: number | undefined): ComplianceBand {
  if (ratio === undefined || ratio <= 0) return "red";
  if (ratio >= 0.8 && ratio <= 1.2) return "green";
  if ((ratio >= 0.5 && ratio < 0.8) || (ratio > 1.2 && ratio <= 1.5)) return "yellow";
  return "orange";
}

export interface StepCompliance {
  /** Index into the flattened step list. */
  index: number;
  kind: SimpleStep["kind"];
  /** Actual / planned for the step's duration (time or distance). */
  durationRatio?: number;
  actualPaceSPerKm?: number;
  targetLoSPerKm?: number;
  targetHiSPerKm?: number;
  /** R-PERF delta = (target − actual) / target, target = range midpoint. Positive = faster. */
  delta?: number;
  result: "on_target" | "fast" | "slow" | "no_target";
}

export interface WorkoutMatch {
  workoutId: string;
  date: string;
  type: PlannedWorkout["type"];
  status: WorkoutStatus;
  activityIds: string[];
  measure: "distance" | "duration";
  /** Actual / planned (distance or duration); undefined when nothing was done. */
  ratio?: number;
  band: ComplianceBand | "pending";
  steps?: StepCompliance[];
}

export interface WeekCompliance {
  index: number;
  startDate: string;
  /** Planned km for days already over (or completed today). */
  plannedKm: number;
  actualKm: number;
  /** actual ÷ planned for the elapsed part of the week; undefined if nothing was planned yet. */
  compliance?: number;
  /** compliance < 90%: structural changes are allowed (§8). */
  structuralChangeAllowed: boolean;
}

export interface MatchResult {
  workouts: WorkoutMatch[];
  /** Activities on days without a planned session of that sport (cross-training, extra runs). */
  unplanned: string[];
  weeks: WeekCompliance[];
}

export interface SkipMark {
  date: string;
  workoutId?: string;
}

/** Steps with repeats expanded, in watch order. */
export function flattenSteps(steps: readonly Step[]): SimpleStep[] {
  const out: SimpleStep[] = [];
  for (const st of steps) {
    if (st.kind === "repeat") for (let i = 0; i < st.count; i++) out.push(...st.steps);
    else out.push(st);
  }
  return out;
}

/** Distance unless the session is prescribed by time/RPE or run/walk (§8). */
export function complianceMeasure(w: Pick<PlannedWorkout, "prescription_mode" | "type">): "distance" | "duration" {
  return w.prescription_mode === "pace" && w.type !== "RW" ? "distance" : "duration";
}

/** Per-step compliance when the laps map 1:1 onto the flattened steps; otherwise undefined. */
export function stepCompliance(w: Pick<PlannedWorkout, "steps">, laps: readonly ActivityLap[] | undefined): StepCompliance[] | undefined {
  const flat = flattenSteps(w.steps);
  if (!laps || laps.length !== flat.length || flat.length === 0) return undefined;
  return flat.map((st, index) => {
    const lap = laps[index] as ActivityLap;
    const out: StepCompliance = { index, kind: st.kind, result: "no_target" };
    if (st.duration.type === "time") out.durationRatio = lap.durationS / st.duration.s;
    else if (st.duration.type === "distance") out.durationRatio = lap.distanceM / st.duration.m;
    if (lap.distanceM > 0) out.actualPaceSPerKm = lap.durationS / (lap.distanceM / 1000);
    // An HR-targeted easy step keeps its pace range as the fallback (§3.7): compare against that.
    const pace = st.target.type === "pace" ? st.target : st.fallback?.type === "pace" ? st.fallback : undefined;
    if (pace && out.actualPaceSPerKm !== undefined) {
      const lo = pace.lo_s_per_km;
      const hi = pace.hi_s_per_km;
      const mid = (lo + hi) / 2;
      out.targetLoSPerKm = lo;
      out.targetHiSPerKm = hi;
      out.delta = (mid - out.actualPaceSPerKm) / mid;
      out.result = out.actualPaceSPerKm < lo ? "fast" : out.actualPaceSPerKm > hi ? "slow" : "on_target";
    }
    return out;
  });
}

function sportOf(w: PlannedWorkout): Activity["sport"] {
  return w.sport === "strength" ? "strength" : "run";
}

/**
 * Match activities to the plan. Days after `today` are "pending"; `today` is pending until something
 * is logged. Deterministic: activities are processed in (date, id) order.
 */
export function matchActivities(
  plan: Plan,
  activities: readonly Activity[],
  today: string,
  skips: readonly SkipMark[] = [],
): MatchResult {
  const acts = sortActivities(activities);
  const used = new Set<string>();
  const workouts: WorkoutMatch[] = [];
  for (const week of plan.weeks) {
    for (const w of week.workouts) {
      const same = acts.filter((a) => a.date === w.date && a.sport === sportOf(w));
      same.forEach((a) => used.add(a.id));
      const measure = complianceMeasure(w);
      const base = { workoutId: w.id, date: w.date, type: w.type, activityIds: same.map((a) => a.id), measure };
      if (same.length === 0) {
        const skipped = skips.some((s) => s.workoutId === w.id || (s.workoutId === undefined && s.date === w.date));
        const over = w.date < today;
        workouts.push({ ...base, status: skipped && w.date <= today ? "skipped" : over ? "missed" : "pending", band: over || skipped ? "red" : "pending" });
        continue;
      }
      const planned = measure === "distance" ? w.planned.run_m : w.planned.minutes * 60;
      const actual = same.reduce((acc, a) => acc + (measure === "distance" ? a.distanceM : a.movingS), 0);
      const ratio = planned > 0 ? actual / planned : 1;
      const m: WorkoutMatch = {
        ...base,
        status: ratio >= COMPLETED_MIN_RATIO ? "completed" : "partial",
        ratio,
        band: complianceBand(ratio),
      };
      const withLaps = same.length === 1 ? (same[0] as Activity).laps : undefined;
      const steps = stepCompliance(w, withLaps);
      if (steps) m.steps = steps;
      workouts.push(m);
    }
  }
  const unplanned = acts.filter((a) => !used.has(a.id)).map((a) => a.id);
  return { workouts, unplanned, weeks: weeklyCompliance(plan, acts, today) };
}

function weeklyCompliance(plan: Plan, acts: readonly Activity[], today: string): WeekCompliance[] {
  const out: WeekCompliance[] = [];
  for (const week of plan.weeks) {
    if (week.startDate > today) break;
    const elapsed = week.workouts.filter((w) => w.date < today && w.type !== "RACE" && w.sport === "run");
    const plannedKm = elapsed.reduce((a, w) => a + w.planned.run_m / 1000, 0);
    const end = addDays(week.startDate, 6);
    const actualKm = acts
      .filter((a) => a.sport === "run" && a.date >= week.startDate && a.date <= end && a.date < today && !a.isRace)
      .reduce((a, x) => a + x.distanceM / 1000, 0);
    const wc: WeekCompliance = {
      index: week.index,
      startDate: week.startDate,
      plannedKm: round1(plannedKm),
      actualKm: round1(actualKm),
      structuralChangeAllowed: false,
    };
    if (plannedKm > 0) {
      wc.compliance = actualKm / plannedKm;
      wc.structuralChangeAllowed = wc.compliance < NO_CHANGE_WEEKLY_COMPLIANCE;
    }
    out.push(wc);
  }
  return out;
}

function round1(x: number): number {
  return Math.round(x * 10) / 10;
}
