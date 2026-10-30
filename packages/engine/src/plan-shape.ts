/**
 * Plan shape: the week-by-week skeleton that feasibility (§6.2) and the generator (§6.3–6.9) share,
 * so the reachability check simulates exactly the cutbacks and caps the generator will use.
 * Pure function of (input, number of weeks); no dates.
 */
import type { GeneralFitnessGoal, GoalDistance, Level, Phase, PlanContinuation, PlanInput } from "./plan-types.js";
import { continuedPhases, planPhases, type PlanPhases } from "./phases.js";
import { taperMultipliers, taperWeeks as taperLength } from "./taper.js";
import {
  buildWeekTargets,
  CUTBACK_FLOOR_OF_ENTRY,
  cutbackPolicy,
  layoutBuildWeeks,
  peakWeeklyKm,
  type CutbackPolicy,
} from "./volume.js";
import { ladderRunSeconds, ladderWeeksNeeded, LADDER_GRADUATION_STAGE } from "./ladder.js";
import { l1CapKm, longRunCaps, type LongRunCaps } from "./long-run.js";
import { midPace, planPaces, prescriptionFor, type PaceSet } from "./prescription.js";
import {
  EASY_MAX_FRACTION_OF_LR,
  EASY_MAX_MINUTES,
  EASY_MAX_MINUTES_BEGINNER,
  RECOVERY_MAX_MINUTES,
  columnWeekday,
  weekTemplate,
  type RunWeekdays,
  type TemplateSlot,
} from "./scheduler.js";
import type { Weekday } from "./dates.js";
import { generalFitnessKinds, generalFitnessPhases, generalFitnessTargetKm } from "./general-fitness.js";

export type WeekKind = "ladder" | "build" | "cutback" | "tt" | "taper";

export interface PlanShape {
  weeks: number;
  ladderWeeks: number;
  /** Ladder stage for each ladder week (index 0 = week 1). */
  ladderStages: number[];
  taperWeeks: number;
  phases: PlanPhases;
  cutback: CutbackPolicy;
  /** One per week; the last week is the race week (kind "taper"). */
  kinds: WeekKind[];
  /** Weekly running-km targets, one per week (race excluded). */
  targets: number[];
  /** Build starting volume: max(entry volume, last ladder week), capped only by template capacity. */
  startKm: number;
  /** Rule ID when startKm is below the entry volume. */
  startCap?: string;
  /** Build-peak cap: min(V3, template capacity). */
  peakCapKm: number;
  /** What the week template can hold under L1 and S3 (D). */
  capacityKm: number;
  /** Highest build-week target actually reached; taper multipliers apply to this. */
  buildPeakKm: number;
  /** 1-based week of the (first) 3K TT, if one is scheduled (§4.2 path A / §6.9 graduation / §6.1 GF). */
  ttWeek?: number;
  paces: PaceSet;
  lrCaps: LongRunCaps;
  /** The plan's own L1 target at the build peak (§6.2 reachability, R-RACE-3b). */
  l1TargetKm: number;
  trace: string[];
}

/** Effective run days: beginners are capped at 4 (§6.4). */
export function effectiveRunDays(level: Level, runDays: number): number {
  const d = Math.min(7, Math.max(2, Math.round(runDays)));
  return level === "beginner" ? Math.min(4, d) : d;
}

/** Run days the input asks for: the number of run weekdays (long-run day included) when given, else `runDays`. */
export function requestedRunDays(input: Pick<PlanInput, "runDays" | "runWeekdays" | "longRunDay">): number {
  return input.runWeekdays ? new Set([...input.runWeekdays, input.longRunDay]).size : input.runDays;
}

/** The weekday schedule options for weekTemplate, when the input names run weekdays. */
export function runWeekdaysOf(input: Pick<PlanInput, "runWeekdays" | "longRunDay" | "maxMinutesByDay">): RunWeekdays | undefined {
  if (!input.runWeekdays) return undefined;
  const out: RunWeekdays = { days: input.runWeekdays, longRunDay: input.longRunDay };
  if (input.maxMinutesByDay) out.maxMinutes = (wd) => maxMinutesOn(input, wd);
  return out;
}

/** §7.1 step 4 limit (minutes) on a weekday; Infinity when none is set (non-positive values are ignored). */
export function maxMinutesOn(input: Pick<PlanInput, "maxMinutesByDay">, weekday: Weekday): number {
  const m = input.maxMinutesByDay?.[weekday];
  return m !== undefined && Number.isFinite(m) && m > 0 ? m : Infinity;
}

/** VDOT is trusted for pace work only from a race or TT (§4.2). */
export function needsTimeTrial(input: Pick<PlanInput, "vdotStatus">): boolean {
  return input.vdotStatus === "none" || input.vdotStatus === "estimated";
}

/** TT: week 2 after ≥ 3 easy runs (§4.2 A), or the first week after ladder graduation (§6.9). Never in the final 3 weeks. */
function ttWeekFor(input: PlanInput, weeks: number, ladderWeeks: number, taper: number): number | undefined {
  if (!needsTimeTrial(input)) return undefined;
  const week = ladderWeeks > 0 ? ladderWeeks + 1 : 2;
  return week <= weeks - Math.max(3, taper) ? week : undefined;
}

/**
 * Longest easy run allowed by S3 and §6.10, in km.
 * With ≤ 3 run days, S3's 70%-of-LR limit and pct_hard can't both hold (LR ≤ 0.35 W leaves two runs
 * of ≤ 0.245 W, so the week can reach only 84% of W), so easy runs may be as long as the LR (D).
 */
export function easyMaxKm(level: Level, runDays: number, paces: PaceSet, longRunKm: number): number {
  const minutes = level === "beginner" ? EASY_MAX_MINUTES_BEGINNER : EASY_MAX_MINUTES;
  const fraction = runDays <= 3 ? 1 : EASY_MAX_FRACTION_OF_LR;
  return Math.min(fraction * longRunKm, (minutes * 60) / midPace(paces.E));
}

/** Per-slot easy cap: recovery runs are 20–40 min (§6.10). */
export function slotMaxKm(paces: PaceSet): (slot: TemplateSlot) => number {
  return (slot) => (slot.role === "REC" ? (RECOVERY_MAX_MINUTES * 60) / midPace(paces.REC) : Infinity);
}

/**
 * Template capacity (D): the most a week can hold when every non-LR slot is a maximal easy run and
 * the LR sits at its time/distance cap. V3 alone can set a peak that the run days can't carry
 * (e.g. persona B at 4 days); capping the peak here keeps targets placeable and taper multipliers honest.
 */
export function templateCapacityKm(
  level: Level,
  runDays: number,
  paces: PaceSet,
  caps: LongRunCaps,
  generalFitness = false,
  /** Run weekdays and §7.1 step 4 limits: what each day can hold (D). */
  schedule?: CapacitySchedule,
): number {
  const weekdays = schedule?.weekdays;
  const limit = (s: TemplateSlot, pace: number) => {
    if (!schedule?.maxMinutes) return Infinity;
    return (schedule.maxMinutes(columnWeekday(s.offset, schedule.longRunDay)) * 60) / pace;
  };
  const slots = weekTemplate(runDays, weekdays ? { generalFitness, weekdays } : { generalFitness });
  const lrSlot = slots.find((s) => s.role === "L");
  const lr = Math.min(caps.timeCapKm, caps.distanceCapKm, lrSlot ? limit(lrSlot, midPace(paces.LR)) : Infinity);
  const easy = easyMaxKm(level, runDays, paces, lr);
  const perSlot = slotMaxKm(paces);
  return slots
    .filter((s) => s.role !== "L")
    .reduce((acc, s) => acc + Math.min(easy, perSlot(s), limit(s, midPace(s.role === "REC" ? paces.REC : paces.E))), lrSlot ? lr : 0);
}

export interface CapacitySchedule {
  longRunDay: Weekday;
  weekdays?: RunWeekdays;
  /** Minutes allowed on a weekday (Infinity = no limit). */
  maxMinutes?: (weekday: Weekday) => number;
}

/** Capacity options for an input: its run weekdays and day limits. */
function scheduleOf(input: PlanInput): CapacitySchedule {
  const out: CapacitySchedule = { longRunDay: input.longRunDay };
  const weekdays = runWeekdaysOf(input);
  if (weekdays) out.weekdays = weekdays;
  if (input.maxMinutesByDay) out.maxMinutes = (wd) => maxMinutesOn(input, wd);
  return out;
}

export function ladderKm(stage: number, paces: PaceSet): number {
  return (3 * ladderRunSeconds(stage)) / midPace(paces.E);
}

/**
 * The input's continuation (§8 R-RACE-2) when it applies to a plan of `weeks` weeks: its calendar
 * must reach back to week 1 and its taper must be a §6.8 length. Otherwise the plan is built fresh.
 */
export function activeContinuation(input: PlanInput, weeks: number): PlanContinuation | undefined {
  const c = input.continuation;
  if (!c || weeks < 1 || c.phaseCalendar.length < weeks) return undefined;
  if (!Number.isInteger(c.taperWeeks) || c.taperWeeks < 1 || c.taperWeeks > 3) return undefined;
  return c;
}

/**
 * Shape a plan of `weeks` weeks. Two passes for the marathon taper: T1 says 2 weeks when the peak
 * is under 50 km/week, and the peak depends on how many build weeks remain. A continuation keeps
 * the original taper instead (R-RACE-1), so T1 isn't re-run.
 */
export function planShape(input: PlanInput, weeks: number): PlanShape {
  const cont = activeContinuation(input, weeks);
  if (cont) return shapeWithTaper(input, weeks, cont.taperWeeks, cont);
  const first = shapeWithTaper(input, weeks, taperLength(input.goal.distance, input.level, Infinity));
  const taper = taperLength(input.goal.distance, input.level, first.buildPeakKm);
  return taper === first.taperWeeks ? first : shapeWithTaper(input, weeks, taper);
}

function shapeWithTaper(input: PlanInput, weeks: number, taperRequested: number, cont?: PlanContinuation): PlanShape {
  const trace: string[] = [];
  const distance: GoalDistance = input.goal.distance;
  const paces = planPaces(input);
  const entry = input.ladderEntryStage ?? 1;
  const ladderWanted = input.level === "beginner" ? ladderWeeksNeeded(input.canRun20MinContinuous, entry) : 0;
  // A continuation may start inside the taper: then every week left is taper (R-RACE-1).
  const taperWeeks = cont ? Math.min(taperRequested, weeks) : Math.max(1, Math.min(taperRequested, weeks - 1));
  const ladderWeeks = Math.max(0, Math.min(ladderWanted, weeks - taperWeeks - 1));
  if (ladderWeeks < ladderWanted) {
    trace.push(`§6.9: only ${ladderWeeks} of ${ladderWanted} ladder weeks fit; graduation (stage ${LADDER_GRADUATION_STAGE}) isn't reached before the race`);
  }
  const ladderStages = Array.from({ length: ladderWeeks }, (_, i) => Math.min(LADDER_GRADUATION_STAGE, entry + i));
  const buildCount = Math.max(0, weeks - taperWeeks - ladderWeeks);
  const phases = cont
    ? continuedPhases(cont.phaseCalendar, weeks, taperWeeks, input.level, ladderWeeks, cont)
    : planPhases(Math.max(1, weeks), input.level, ladderWeeks);
  const cutback = cutbackPolicy(input);
  if (cont) trace.push(...continuationTrace(cont, weeks, phases));

  const ttWeek = ttWeekFor(input, weeks, ladderWeeks, taperWeeks);
  const ttBuildIdx = new Set(ttWeek !== undefined ? [ttWeek - 1 - ladderWeeks] : []);
  const buildPhases: Phase[] = phases.byWeek.slice(ladderWeeks, ladderWeeks + buildCount);
  // A continued plan keeps the cutback rhythm it had (a break resets it: the break was the rest).
  const buildKinds = layoutBuildWeeks(buildCount, cutback.every, buildPhases, ttBuildIdx, ladderWeeks === 0 ? (cont?.weeksSinceCutback ?? 0) : 0);

  // V3 "week 1 starts at current volume". After a ladder the build resumes from the higher of the
  // entry volume and the last ladder week, never below what the runner already does (no detraining).
  // The only thing that lowers it is what the run days can hold under L1/S3 (D), which is flagged.
  const runDays = effectiveRunDays(input.level, requestedRunDays(input));
  const timeBased = prescriptionFor(input.level, input.vdotStatus, paces).longBy === "time";
  const lrCaps = longRunCaps(input.level, distance, input.longRunMode, paces.LR, { timeBased, runDays });
  const capacityKm = templateCapacityKm(input.level, runDays, paces, lrCaps, false, scheduleOf(input));
  const lastStage = ladderStages[ladderStages.length - 1];
  const entryKm = Math.max(0, input.currentWeeklyKm, lastStage === undefined ? 0 : ladderKm(lastStage, paces));
  let startKm = entryKm;
  let startCap: string | undefined;
  if (startKm > capacityKm) {
    startKm = capacityKm;
    startCap = `V3:start_capped_to_run_days(${capacityKm.toFixed(1)}km)`;
    trace.push(startCap);
  }
  const v3Peak = peakWeeklyKm(input.level, distance, startKm);
  const peakCapKm = Math.max(startKm, Math.min(v3Peak, capacityKm));
  if (peakCapKm < v3Peak) trace.push(`V3:template_capacity(${capacityKm.toFixed(1)}km)`);
  const buildTargets = buildWeekTargets(startKm, peakCapKm, buildKinds, CUTBACK_FLOOR_OF_ENTRY * startKm);
  const buildPeakKm = Math.max(startKm, ...buildTargets);
  // Inside the taper, the weeks left take the tail of its T2 multipliers (weeks out stay the same).
  const fullTaper = cont ? taperRequested : taperWeeks;
  const mult = taperMultipliers(fullTaper).slice(fullTaper - taperWeeks);

  const kinds: WeekKind[] = [
    ...Array<WeekKind>(ladderWeeks).fill("ladder"),
    ...buildKinds,
    ...Array<WeekKind>(taperWeeks).fill("taper"),
  ];
  const targets = [
    ...ladderStages.map((s) => ladderKm(s, paces)),
    ...buildTargets,
    ...mult.map((m) => m * buildPeakKm),
  ];

  const l1TargetKm = l1CapKm(lrCaps, buildPeakKm, input.longestRun30d.km).km;
  const shape: PlanShape = {
    weeks,
    ladderWeeks,
    ladderStages,
    taperWeeks,
    phases,
    cutback,
    kinds,
    targets,
    startKm,
    peakCapKm,
    capacityKm,
    buildPeakKm,
    paces,
    lrCaps,
    l1TargetKm,
    trace,
  };
  if (ttWeek !== undefined) shape.ttWeek = ttWeek;
  if (startCap !== undefined) shape.startCap = startCap;
  return shape;
}

/**
 * General-fitness shape (§6.1): optional run/walk ladder, then rolling blocks (general-fitness.ts)
 * building from the entry volume toward the weekly target. No taper. `input` is the race-shaped
 * internal input (generalFitnessAsRaceInput): its goal distance is the reference distance.
 */
export function generalFitnessShape(input: PlanInput, weeks: number, goal: GeneralFitnessGoal): PlanShape {
  const trace: string[] = [];
  const distance = input.goal.distance;
  const paces = planPaces(input);
  const entry = input.ladderEntryStage ?? 1;
  const ladderWanted = input.level === "beginner" ? ladderWeeksNeeded(input.canRun20MinContinuous, entry) : 0;
  const ladderWeeks = Math.max(0, Math.min(ladderWanted, weeks));
  const ladderStages = Array.from({ length: ladderWeeks }, (_, i) => Math.min(LADDER_GRADUATION_STAGE, entry + i));
  const buildCount = weeks - ladderWeeks;
  const cutback = cutbackPolicy(input);
  const buildKinds = generalFitnessKinds(buildCount, cutback.every, needsTimeTrial(input));
  const byWeek = generalFitnessPhases(ladderWeeks, buildCount, cutback.every);

  const runDays = effectiveRunDays(input.level, requestedRunDays(input));
  const timeBased = prescriptionFor(input.level, input.vdotStatus, paces).longBy === "time";
  const lrCaps = longRunCaps(input.level, distance, input.longRunMode, paces.LR, { timeBased, runDays });
  const capacityKm = templateCapacityKm(input.level, runDays, paces, lrCaps, true, scheduleOf(input));
  const lastStage = ladderStages[ladderStages.length - 1];
  const entryKm = Math.max(0, input.currentWeeklyKm, lastStage === undefined ? 0 : ladderKm(lastStage, paces));
  const wantedKm = generalFitnessTargetKm(goal, midPace(paces.E));
  let startKm = entryKm;
  let startCap: string | undefined;
  if (wantedKm !== undefined && wantedKm < startKm) {
    startKm = wantedKm;
    trace.push(`§6.1:target_below_current(${wantedKm.toFixed(1)}km)`);
  }
  if (startKm > capacityKm) {
    startKm = capacityKm;
    startCap = `V3:start_capped_to_run_days(${capacityKm.toFixed(1)}km)`;
    trace.push(startCap);
  }
  const v3Peak = peakWeeklyKm(input.level, distance, startKm);
  const goalKm = wantedKm === undefined ? v3Peak : Math.max(startKm, wantedKm);
  const peakCapKm = Math.max(startKm, Math.min(goalKm, capacityKm));
  if (peakCapKm < goalKm) trace.push(`V3:template_capacity(${capacityKm.toFixed(1)}km)`);
  const buildTargets = buildWeekTargets(startKm, peakCapKm, buildKinds, CUTBACK_FLOOR_OF_ENTRY * startKm);
  const buildPeakKm = Math.max(startKm, ...buildTargets);
  const ttIdx = buildKinds.indexOf("tt");

  const shape: PlanShape = {
    weeks,
    ladderWeeks,
    ladderStages,
    taperWeeks: 0,
    phases: { base: 0, split: splitOf(byWeek), byWeek },
    cutback,
    kinds: [...Array<WeekKind>(ladderWeeks).fill("ladder"), ...buildKinds],
    targets: [...ladderStages.map((st) => ladderKm(st, paces)), ...buildTargets],
    startKm,
    peakCapKm,
    capacityKm,
    buildPeakKm,
    paces,
    lrCaps,
    l1TargetKm: l1CapKm(lrCaps, buildPeakKm, input.longestRun30d.km).km,
    trace,
  };
  if (ttIdx >= 0) shape.ttWeek = ladderWeeks + ttIdx + 1;
  if (startCap !== undefined) shape.startCap = startCap;
  return shape;
}

/** Summary notes for a continued plan (R-RACE-2, D). */
function continuationTrace(cont: PlanContinuation, weeks: number, phases: PlanPhases): string[] {
  const from = cont.phaseCalendar.length - weeks + 1;
  const out = [`R-RACE-2:continue(wk${from}/${cont.phaseCalendar.length},${phases.byWeek[0] ?? "-"},taper${cont.taperWeeks})`];
  if (cont.restart) out.push("R-RACE-2:restart");
  else if (phases.rebuildWeeks) out.push(`R-RACE-2:rebuild_weeks(${phases.rebuildWeeks})`);
  else if (cont.phaseReset) out.push("R-RACE-2:phase_reset");
  if (cont.reason) out.push(`R-RACE-2:reason(${cont.reason})`);
  return out;
}

function splitOf(byWeek: readonly Phase[]): PlanPhases["split"] {
  const split = { FI: 0, EQ: 0, TQ: 0, FQ: 0 };
  for (const p of byWeek) if (p !== "BASE") split[p] += 1;
  return split;
}
