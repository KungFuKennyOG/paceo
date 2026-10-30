/**
 * Everything a replanning rule reads, computed once per replan call (spec §8). Rules are pure
 * functions of this context. This module is also the ONLY place that reads PlanInput fields, so a
 * PlanInput change (e.g. a general-fitness goal variant) is absorbed here.
 */
import type { Activity } from "./activity.js";
import { isHardDay, sortActivities } from "./activity.js";
import { addDays, toDayNumber } from "./dates.js";
import { matchActivities, type MatchResult, type WorkoutMatch } from "./matching.js";
import { planPaces, prescriptionFor, type PaceSet } from "./prescription.js";
import type { GoalDistance, Level, Plan, PlanInput, PlanWeek, VdotStatus } from "./plan-types.js";
import { detectBreak, illnessEpisodes, sortEvents, v1History, type BreakInfo } from "./replan-history.js";
import type { CheckInEvent, FitnessState, HrvNight, IllnessEvent, ReplanState } from "./replan-types.js";
import { v1Limit, v1Measure, v1Reference, type RunRecord, type V1Limit, type V1Seed } from "./v1.js";
import type { PlannedWorkout } from "./workout.js";

export const QUALITY_TYPES: ReadonlySet<string> = new Set(["T", "I", "R", "H", "M", "TT"]);
export const EASY_TYPES: ReadonlySet<string> = new Set(["E", "S"]);

export interface RuleContext {
  today: string;
  /** First day the replanner may change: today, or tomorrow once a run is logged today. */
  editableFrom: string;
  plan: Plan;
  input: PlanInput;
  level: Level;
  raceDate: string;
  goalDistance: GoalDistance;
  goalTimeS?: number;
  isLadderPlan: boolean;
  fitness: FitnessState;
  /** Sorted; manual cross-training logs merged in; sRPE check-ins applied. */
  activities: Activity[];
  runs: Activity[];
  events: CheckInEvent[];
  match: MatchResult;
  matchById: Map<string, WorkoutMatch>;
  /** All planned workouts in date order. */
  workouts: PlannedWorkout[];
  /** date → the planned RUN on that day. */
  runOn: Map<string, PlannedWorkout>;
  hrv: HrvNight[];
  illness: IllnessEvent[];
  /** R-BREAK of ≥ 6 days still in its return window (or ongoing). */
  brk?: BreakInfo;
  accepted: Set<string>;
  declined: Set<string>;
  /** V1 time variant applies (long runs prescribed in minutes, §6.5). */
  timeMode: boolean;
  /** V1 reference when no actual run is in the 30-day window (D: the entered/derived longest run). */
  v1Seed: V1Seed;
}

// ── PlanInput adapter ────────────────────────────────────────────────────────────────────────────

export function inputFacts(input: PlanInput): { raceDate: string; distance: GoalDistance; goalTimeS?: number; level: Level } {
  const out: { raceDate: string; distance: GoalDistance; goalTimeS?: number; level: Level } = {
    raceDate: input.raceDate,
    distance: input.goal.distance,
    level: input.level,
  };
  if (input.goal.timeS !== undefined) out.goalTimeS = input.goal.timeS;
  return out;
}

/** PaceSet for builders, from the current fitness (not the plan's original VDOT). */
export function currentPaces(input: PlanInput, vdot: number | undefined, status: VdotStatus): PaceSet {
  const p: Parameters<typeof planPaces>[0] = { level: input.level, vdotStatus: status, goal: input.goal, longestRun30d: input.longestRun30d };
  if (vdot !== undefined) p.vdot = vdot;
  return planPaces(p);
}

// ── context builder ──────────────────────────────────────────────────────────────────────────────

function eventActivities(events: readonly CheckInEvent[]): Activity[] {
  const out: Activity[] = [];
  events.forEach((e, i) => {
    if (e.type !== "cross_training") return;
    const a: Activity = { id: `xt-${e.date}-${i}`, date: e.date, sport: e.sport, distanceM: 0, movingS: e.minutes * 60, isRace: false };
    if (e.srpe !== undefined) a.srpe = e.srpe;
    if (e.hard !== undefined) a.hard = e.hard;
    out.push(a);
  });
  return out;
}

export function buildRuleContext(state: ReplanState, rawEvents: readonly CheckInEvent[], today: string, fitness: FitnessState): RuleContext {
  toDayNumber(today); // validates
  const events = sortEvents(rawEvents);
  const srpe = new Map<string, number>();
  for (const e of events) if (e.type === "srpe") srpe.set(e.activityId, e.srpe);
  const activities = sortActivities(
    [...state.activities, ...eventActivities(events)]
      .filter((a) => a.date <= today)
      .map((a) => (srpe.has(a.id) ? { ...a, srpe: srpe.get(a.id) as number } : a)),
  );
  const runs = activities.filter((a) => a.sport === "run");
  const skips = events.flatMap((e) => (e.type === "skip" ? [e.workoutId !== undefined ? { date: e.date, workoutId: e.workoutId } : { date: e.date }] : []));
  const match = matchActivities(state.plan, activities, today, skips);
  const workouts = state.plan.weeks.flatMap((w) => w.workouts).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const runOn = new Map<string, PlannedWorkout>();
  for (const w of workouts) if (w.sport === "run") runOn.set(w.date, w);
  const facts = inputFacts(state.input);
  const paces = currentPaces(state.input, fitness.vdot, fitness.status);
  const rx = prescriptionFor(facts.level, fitness.status, paces);
  const accepted = new Set<string>();
  const declined = new Set<string>();
  for (const e of events) {
    if (e.type !== "proposal_response") continue;
    (e.accept ? accepted : declined).add(e.proposalId);
    (e.accept ? declined : accepted).delete(e.proposalId);
  }
  const ranToday = runs.some((r) => r.date === today);
  const ctx: RuleContext = {
    today,
    editableFrom: ranToday ? addDays(today, 1) : today,
    plan: state.plan,
    input: state.input,
    level: facts.level,
    raceDate: facts.raceDate,
    goalDistance: facts.distance,
    isLadderPlan: state.plan.weeks.some((w) => w.isLadder),
    fitness,
    activities,
    runs,
    events,
    match,
    matchById: new Map(match.workouts.map((m) => [m.workoutId, m])),
    workouts,
    runOn,
    hrv: [...(state.hrv ?? [])].sort((a, b) => (a.date < b.date ? -1 : 1)),
    illness: illnessEpisodes(events),
    accepted,
    declined,
    timeMode: rx.longBy === "time",
    v1Seed: { day: toDayNumber(today) - 10_000, km: state.input.longestRun30d.km, minutes: state.input.longestRun30d.minutes },
  };
  if (facts.goalTimeS !== undefined) ctx.goalTimeS = facts.goalTimeS;
  const brk = detectBreak(runs, activities, today);
  if (brk) ctx.brk = brk;
  return ctx;
}

// ── shared helpers ───────────────────────────────────────────────────────────────────────────────

export function weekContaining(plan: Plan, date: string): PlanWeek | undefined {
  return plan.weeks.find((w) => w.startDate <= date && date <= addDays(w.startDate, 6));
}

export function isQualityWorkout(w: Pick<PlannedWorkout, "type">): boolean {
  return QUALITY_TYPES.has(w.type);
}

/**
 * A hard/key day for §7.1 adjacency, as the athlete actually lived it: past days count when a key
 * session was done (completed or partial) or a hard cross-training session was logged; editable days
 * use the plan (`future` overrides it when given).
 */
export function isKeyDay(ctx: RuleContext, date: string, future?: ReadonlyMap<string, PlannedWorkout | undefined>): boolean {
  if (date < ctx.editableFrom) {
    const planned = ctx.runOn.get(date);
    if (planned?.flags.key_session) {
      const m = ctx.matchById.get(planned.id);
      if (m && (m.status === "completed" || m.status === "partial")) return true;
    }
    return ctx.activities.some((a) => a.date === date && a.sport !== "run" && isHardDay(a));
  }
  const w = future?.has(date) ? future.get(date) : ctx.runOn.get(date);
  return w?.flags.key_session === true;
}

/** Actual runs before `editableFrom` plus planned runs from `editableFrom` up to (not incl.) `date`. */
export function v1LimitAt(ctx: RuleContext, date: string, plannedFuture: readonly PlannedWorkout[]): V1Limit {
  const day = toDayNumber(date);
  const records: RunRecord[] = v1History(ctx.runs.filter((r) => r.date < ctx.editableFrom));
  for (const w of plannedFuture) {
    if (w.sport !== "run" || w.type === "RACE" || w.date < ctx.editableFrom || w.date >= date) continue;
    records.push({ day: toDayNumber(w.date), ...v1Measure(w) });
  }
  return v1Limit(v1Reference(records, ctx.v1Seed, day), ctx.timeMode);
}

/** Dates on which an illness episode was active (onset … resolved − 1, or … today). */
export function illnessDates(ctx: RuleContext): Set<string> {
  const out = new Set<string>();
  for (const e of ctx.illness) {
    const end = e.resolvedDate !== undefined && e.resolvedDate <= ctx.today ? e.resolvedDate : addDays(ctx.today, 1);
    for (let d = e.date; d < end; d = addDays(d, 1)) out.add(d);
  }
  return out;
}

/** Any illness or pain check-in in [date − days, date]. */
export function flaggedWithin(ctx: RuleContext, date: string, days: number): boolean {
  const from = addDays(date, -days);
  const ill = illnessDates(ctx);
  for (let d = from; d <= date; d = addDays(d, 1)) if (ill.has(d)) return true;
  return ctx.events.some((e) => e.type === "pain" && e.date >= from && e.date <= date && e.during > 3);
}

export function dateRange(from: string, toInclusive: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= toInclusive; d = addDays(d, 1)) out.push(d);
  return out;
}
