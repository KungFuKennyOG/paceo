/**
 * Plan generator (spec §6) and its weekly assembly (§7).
 *
 * generatePlan is a pure function of its input: no clock, no randomness, no I/O.
 * Pipeline: feasibility (§6.2) → shape (phases §6.3, ladder §6.9, cutbacks §6.7, volume §6.5,
 * taper §6.8; or general-fitness blocks §6.1) → locked cross-training expanded onto days (§7.1
 * step 1, §10.2) → per week: quality choice (§6.4, P3, ½ key per hard cross-training day) →
 * placement (§7.1, quality kept off hard-cross-training days) → long run (§6.6) → workouts (§6.10)
 * → easy spreading (S3) → V1 on every run (§6.5) → strength placement over the finished runs
 * (§7.1 step 5, §9) → conflicts and fallback 5–6 reports.
 *
 * TODO(§8): replanning; the TT result should trigger a replan into pace mode.
 * TODO(§6.3): BASE weeks of > 24-week race plans still run as E + strides + easy LR (strength uses the general row).
 * TODO(§4.8): heat; HR targets beyond the DSL fallback.
 */
import type { PlannedWorkout } from "./workout.js";
import type {
  ExposureFamily,
  Feasibility,
  GeneralFitnessInput,
  Phase,
  Plan,
  PlanInput,
  PlanMode,
  PlanRequest,
  PlanSummary,
  PlanWeek,
  ScheduleConflict,
  VolumeFlag,
} from "./plan-types.js";
import { isGeneralFitness } from "./plan-types.js";
import { planCalendar, fromDayNumber, toDayNumber, weekdayOf, type PlanCalendar } from "./dates.js";
import { formatDuration } from "./units.js";
import { checkFeasibility, levelBlocked, predictedGoalTimeS } from "./feasibility.js";
import {
  activeContinuation,
  easyMaxKm,
  effectiveRunDays,
  generalFitnessShape,
  maxMinutesOn,
  planShape,
  requestedRunDays,
  runWeekdaysOf,
  slotMaxKm,
  type PlanShape,
  type WeekKind,
} from "./plan-shape.js";
import { midPace, prescriptionFor, type Prescription } from "./prescription.js";
import {
  longRunMayBeQuality,
  keyBudget,
  phaseEmphasis,
  qualityAllowance,
  substituteQuality,
  weeklyQualityCount,
  type QualityAllowance,
  type QualityKind,
} from "./quality.js";
import { floorKm, l1CapKm, longRunContent, lrSoftCapFraction, lrStepLimitKm } from "./long-run.js";
import {
  CUTBACK_LONG_RUN_FACTOR,
  CUTBACK_QUALITY_FACTOR,
  CUTBACK_VOLUME_FACTOR,
  MAX_WEEK_OVER_WEEK,
  WEEKLY_GROWTH_NEVER,
} from "./volume.js";
import { lastHardSessionDays, TAPER_QUALITY_WORK_FRACTION, taperLongRunFraction } from "./taper.js";
import {
  EASY_MIN_MINUTES,
  EASY_MIN_MINUTES_BEGINNER,
  placeWeek,
  spreadEasy,
  weekTemplate,
  type EasySlot,
  type RunWeekdays,
  type TemplateOptions,
} from "./scheduler.js";
import * as W from "./workouts.js";
import { LADDER_WALK_WARMUP_S, ladderSessionSecondsWith } from "./ladder.js";
import {
  v1Limit,
  v1Measure,
  v1Ok,
  v1Reference,
  v1Trace,
  type RunRecord,
  type V1Limit,
  type V1Reference,
  type V1Seed,
  V1_FACTOR,
} from "./v1.js";
import {
  expandLockedEvents,
  hasTrunkLoadingCrossTraining,
  isLowerLift,
  recordConflict,
  type CrossTrainingSession,
} from "./cross-training.js";
import { scheduleStrength } from "./strength-schedule.js";
import {
  generalFitnessAsRaceInput,
  generalFitnessCalendar,
  generalFitnessWeeks,
} from "./general-fitness.js";

/**
 * L2: the peak long run falls 3–5 weeks before the race. A build-week long run less than 21 days
 * before the race is held to 85% of the peak so far (D); taper long runs follow T3.
 */
const PEAK_LR_MIN_DAYS_OUT = 21;
const PRE_TAPER_LR_FRACTION = 0.85;
/** Strides at most twice a week (§6.10). */
const MAX_STRIDE_SESSIONS = 2;

interface Env {
  mode: PlanMode;
  input: PlanInput;
  userId: string;
  cal: PlanCalendar;
  shape: PlanShape;
  rx: Prescription;
  allow: QualityAllowance;
  budget: number;
  runDays: number;
  /** V1 time variant applies when the plan prescribes long runs in minutes (§6.5). */
  timeMode: boolean;
  seed: V1Seed;
  /** Locked cross-training and external lifting on its dates (§7.1 step 1). */
  xt: CrossTrainingSession[];
  /** Days that can't hold a quality run because of cross-training / external lifting (§7.1 step 4, §10.2, ST-4/ST-7). */
  qualityBlocked: Set<number>;
  /** Subset of qualityBlocked caused only by flexible sessions (fallback 5). */
  flexibleBlocked: Set<number>;
  /** The user's run weekdays (§2.3), when given. */
  weekdays?: RunWeekdays;
  /** §7.1 step 4: minutes a run may take on an absolute day (Infinity = no limit). */
  dayCap: (day: number) => number;
}

interface State {
  history: RunRecord[];
  keyDays: number[];
  exposures: Map<string, number>;
  lrEligibleWeeks: number;
  /** Last non-cutback long run (cutbacks resume from here, §6.7). */
  lrLevelKm: number;
  peakLrKm: number;
  /** Last week's planned running km (V2 is checked against what was planned, not the target). */
  prevPlannedKm: number;
  /** Last week's planned running minutes (V2 after a run/walk week is judged by time, §6.5). */
  prevPlannedMinutes: number;
}

interface WeekInfo {
  w: number;
  kind: WeekKind;
  phase: Phase;
  targetKm: number;
  startDay: number;
  /** 1 = race week. */
  weeksOut: number;
  isRace: boolean;
  phaseIdx: number;
  phaseLen: number;
  /** Quality runs allowed under the cap of 3 key sessions after the LR and this week's hard cross-training (§6.4). */
  budget: number;
  /** Caps that pushed planned km away from the target this week (rule IDs, for VolumeFlag). */
  caps: Set<string>;
  /** V2 "never above 30%" over last week's planned km (Infinity when exempt). */
  v2HardKm: number;
  /** The same, by session time, for the first week after a run/walk week (Infinity otherwise). */
  v2HardMinutes: number;
}

interface Placed {
  offset: number;
  draft: W.WorkoutDraft;
}

interface QualityPick {
  kind: QualityKind | "TT";
  trace: string[];
}

// ── public API ───────────────────────────────────────────────────────────────────────────────────

/**
 * Race mode (PlanInput) or general-fitness mode (GeneralFitnessInput, §6.1). Existing race callers
 * are unchanged; `isGeneralFitness` tells the two apart.
 */
export function generatePlan(input: PlanRequest): Plan {
  if (isGeneralFitness(input)) return generateGeneralFitness(input);
  const feasibility = checkFeasibility(input);
  const cal = planCalendar(input.today, input.raceDate, input.longRunDay);
  if (cal.weeks < 2 || levelBlocked(input.level, input.goal.distance)) {
    return { feasibility, weeks: [], summary: emptySummary(input, cal, feasibility.status, "race") };
  }
  const env = makeEnv(effectiveInput(input, feasibility), cal, planShape(input, cal.weeks), "race");
  return runPlan(env, feasibility, input);
}

/** §6.1 general fitness: N weeks from today, rolling blocks, no taper, no race. */
function generateGeneralFitness(gf: GeneralFitnessInput): Plan {
  const input = generalFitnessAsRaceInput(gf);
  const cal = generalFitnessCalendar(gf);
  const shape = generalFitnessShape(input, cal.weeks, gf.goal);
  const feasibility: Feasibility = {
    status: "ok",
    reasons: [
      {
        code: "general_fitness",
        status: "info",
        message: `General fitness: ${generalFitnessWeeks(gf.goal)} weeks of ${shape.cutback.every - 1}+1 blocks toward ${shape.peakCapKm.toFixed(0)} km/week; no race, no taper.`,
      },
    ],
    alternatives: [],
    reach: { peakLongRunKm: shape.l1TargetKm, l1TargetKm: shape.l1TargetKm, ratio: 1 },
  };
  return runPlan(makeEnv(input, cal, shape, "general_fitness"), feasibility, input);
}

function runPlan(env: Env, feasibility: Feasibility, input: PlanInput): Plan {
  // A continued plan (§8 R-RACE-2) keeps growing sessions from the exposures already run, and its
  // taper / pre-taper long runs are relative to the longest run actually done (D).
  const cont = env.mode === "race" ? activeContinuation(env.input, env.cal.weeks) : undefined;
  const st: State = {
    history: [],
    keyDays: [],
    exposures: new Map(Object.entries(cont?.exposures ?? {}).map(([k, n]) => [k, Math.max(0, Math.round(n ?? 0))])),
    lrEligibleWeeks: 0,
    lrLevelKm: input.longestRun30d.km,
    peakLrKm: cont ? input.longestRun30d.km : 0,
    prevPlannedKm: 0,
    prevPlannedMinutes: 0,
  };
  const runWeeks: PlanWeek[] = [];
  for (let w = 1; w <= env.cal.weeks; w++) runWeeks.push(planWeek(env, st, w));

  const conflicts: ScheduleConflict[] = [];
  crossTrainingConflicts(env, runWeeks, conflicts);
  dayLimitConflicts(env, runWeeks, conflicts);
  const strength = scheduleStrength(
    {
      userId: env.userId,
      config: input.strength,
      level: input.level,
      conservative: input.conservative ?? false,
      mode: env.mode,
      distance: env.input.goal.distance,
      ...(env.mode === "race" ? { raceDay: env.cal.raceDay } : {}),
      firstDay: env.cal.startDay,
      trunkLoadingXt: hasTrunkLoadingCrossTraining(input.lockedEvents),
    },
    runWeeks,
    env.xt,
  );
  conflicts.push(...strength.conflicts);
  const weeks = strength.weeks;
  const summary = summarize(env, weeks, feasibility.status, input);
  summary.notes.push(...strength.notes);
  summary.conflicts = conflicts;
  for (const c of conflicts) summary.notes.push(`Conflict ${c.code} (${c.weekday}, weeks ${c.weeks.join(",")}): ${c.message}${c.suggestion ? ` ${c.suggestion}` : ""}`);
  return { feasibility, weeks, summary };
}

/**
 * §6.2: a goal more than 3.0 VDOT above current fitness defaults to current + 1.0 for this block
 * (the user can override by re-entering it). Paces then come from the defaulted goal.
 */
function effectiveInput(input: PlanInput, feasibility: Plan["feasibility"]): PlanInput {
  const unrealistic = feasibility.reasons.some((r) => r.code === "goal_unrealistic");
  const slower = feasibility.alternatives.find((a) => a.kind === "slower_goal");
  if (!unrealistic || slower?.goalTimeS === undefined) return input;
  return { ...input, goal: { ...input.goal, timeS: slower.goalTimeS } };
}

function makeEnv(input: PlanInput, cal: PlanCalendar, shape: PlanShape, mode: PlanMode): Env {
  const runDays = effectiveRunDays(input.level, requestedRunDays(input));
  const weekdays = runWeekdaysOf(input);
  const rx = prescriptionFor(input.level, input.vdotStatus, shape.paces);
  const lastDay = cal.startDay + 7 * cal.weeks - 1;
  const xt = expandLockedEvents(input.lockedEvents ?? [], cal.startDay, lastDay, mode === "race" ? cal.raceDay : undefined);
  const { blocked, flexible } = qualityBlockedDays(xt);
  return {
    mode,
    input,
    userId: input.userId ?? "me",
    cal,
    shape,
    rx,
    allow: qualityAllowance(input.level, runDays, input.monthsRunning),
    budget: keyBudget(0),
    runDays,
    timeMode: rx.longBy === "time",
    // The entered longest run is "within the last 30 days"; we date it yesterday (D).
    seed: { day: toDayNumber(input.today) - 1, km: input.longestRun30d.km, minutes: input.longestRun30d.minutes },
    xt,
    qualityBlocked: blocked,
    flexibleBlocked: flexible,
    ...(weekdays ? { weekdays } : {}),
    dayCap: (day) => maxMinutesOn(input, weekdayOf(fromDayNumber(day))),
  };
}

/** Template options shared by every week: the long-run offset and the user's run weekdays. */
function templateOptions(env: Env, extra: TemplateOptions = {}): TemplateOptions {
  return { ...extra, lrOffset: env.cal.lrOffset, ...(env.weekdays ? { weekdays: env.weekdays } : {}) };
}

/** §7.1 step 4: the day's time limit on top of a run's V1 / long-run limit. */
function withDayCap(limit: V1Limit, capMin: number): V1Limit {
  return capMin < limit.minutes ? { ...limit, minutes: capMin } : limit;
}

/**
 * §7.1 step 4 / §10.2: no quality run on the day of, or within 24 h after, a hard cross-training,
 * team-sport or HIIT session (D: session times aren't known, so "same day" counts too; ST-7 also
 * forbids hard cross-training + a hard run + lower lifting on one day). §9.6: external lower/full
 * lifting moves quality off the next day (ST-4) and, with hard cross-training the same day, off that day (ST-7).
 */
function qualityBlockedDays(xt: readonly CrossTrainingSession[]): { blocked: Set<number>; flexible: Set<number> } {
  const byDay = new Map<number, { locked: boolean }[]>();
  const add = (day: number, locked: boolean) => byDay.set(day, [...(byDay.get(day) ?? []), { locked }]);
  const hardDays = new Set(xt.filter((x) => x.hard).map((x) => toDayNumber(x.date)));
  for (const x of xt) {
    const day = toDayNumber(x.date);
    if (x.blocksNextDayQuality) {
      add(day, x.locked);
      add(day + 1, x.locked);
    }
    if (isLowerLift(x)) {
      add(day + 1, x.locked);
      if (hardDays.has(day)) add(day, x.locked);
    }
  }
  const blocked = new Set(byDay.keys());
  const flexible = new Set([...byDay].filter(([, causes]) => causes.every((c) => !c.locked)).map(([d]) => d));
  return { blocked, flexible };
}

/** Hard cross-training key cost (§6.4) of the sessions in [startDay, startDay + 6]. */
function crossTrainingKeyCost(env: Env, startDay: number): number {
  return env.xt.reduce((a, x) => {
    const d = toDayNumber(x.date);
    return d >= startDay && d < startDay + 7 ? a + x.keyCost : a;
  }, 0);
}

// ── one week ─────────────────────────────────────────────────────────────────────────────────────

function weekInfo(env: Env, w: number): WeekInfo {
  // A continued plan counts the phase from where it started in the original calendar (R-RACE-2).
  const before = env.shape.phases.before ?? [];
  const byWeek = [...before, ...env.shape.phases.byWeek];
  const at = before.length + w - 1;
  const phase = byWeek[at] as Phase;
  // Index/length within the contiguous run of this phase (general-fitness phases repeat, D).
  let first = at;
  while (first > 0 && byWeek[first - 1] === phase) first--;
  let last = at;
  while (last + 1 < byWeek.length && byWeek[last + 1] === phase) last++;
  const startDay = env.cal.startDay + 7 * (w - 1);
  const race = env.mode === "race";
  return {
    w,
    kind: env.shape.kinds[w - 1] as WeekKind,
    phase,
    targetKm: env.shape.targets[w - 1] as number,
    startDay,
    weeksOut: race ? env.cal.weeks - w + 1 : Infinity,
    isRace: race && w === env.cal.weeks,
    phaseIdx: at - first,
    phaseLen: last - first + 1,
    budget: keyBudget(crossTrainingKeyCost(env, startDay)),
    caps: new Set(),
    v2HardKm: Infinity,
    v2HardMinutes: Infinity,
  };
}

function planWeek(env: Env, st: State, w: number): PlanWeek {
  const info = capToPreviousWeek(weekInfo(env, w), st, env.shape.kinds[w - 2] === "ladder");
  const notes: string[] = [];
  const placed = info.kind === "ladder" ? ladderWeek(env, st, info, notes) : runWeek(env, st, info, notes);
  placed.sort((a, b) => a.offset - b.offset);

  // R-BREAK > 28 d: Foundation rebuild weeks at the front of a continued plan (R-RACE-2, D).
  const rebuild = w <= (env.shape.phases.rebuildWeeks ?? 0);
  if (rebuild) notes.push("R-RACE-2:rebuild_week");
  const workouts: PlannedWorkout[] = placed.map(({ offset, draft }) => {
    const date = fromDayNumber(info.startDay + offset);
    const d = rebuild ? withTrace(draft, "R-RACE-2:rebuild_week") : draft;
    return { id: `${env.userId}-w${String(w).padStart(2, "0")}-${date}`, user_id: env.userId, date, ...d };
  });
  for (const [i, wk] of workouts.entries()) {
    const day = info.startDay + (placed[i] as Placed).offset;
    if (wk.flags.key_session) st.keyDays.push(day);
    if (wk.type !== "RACE") st.history.push({ day, ...v1Measure(wk) });
  }

  const lr = workouts.find((x) => x.type === "L");
  const plannedKm = sumKm(workouts);
  st.prevPlannedKm = plannedKm;
  st.prevPlannedMinutes = workouts.filter((x) => x.type !== "RACE").reduce((a, x) => a + x.planned.minutes, 0);
  const week: PlanWeek = {
    index: w,
    startDate: fromDayNumber(info.startDay),
    phase: info.phase,
    targetKm: round1(info.targetKm),
    plannedKm: round1(plannedKm),
    longRunKm: lr ? round1(lr.planned.run_m / 1000) : 0,
    isCutback: info.kind === "cutback" || info.kind === "tt",
    isTaper: info.kind === "taper",
    isLadder: info.kind === "ladder",
    workouts,
    crossTraining: env.xt.filter((x) => {
      const d = toDayNumber(x.date);
      return d >= info.startDay && d < info.startDay + 7;
    }),
    notes,
  };
  const flag = volumeFlag(info, plannedKm);
  if (flag) week.volumeFlag = flag;
  return week;
}

/** Planned km may drift ±10% from the target from rounding and min/max run lengths; beyond that, say why. */
export const VOLUME_TOLERANCE = 0.1;

function volumeFlag(info: WeekInfo, plannedKm: number): VolumeFlag | undefined {
  if (info.kind === "ladder" || info.targetKm <= 0) return undefined; // ladder volume is the stage itself
  if (Math.abs(plannedKm - info.targetKm) <= VOLUME_TOLERANCE * info.targetKm) return undefined;
  const reasons = [...info.caps].sort();
  return {
    week: info.w,
    targetKm: round1(info.targetKm),
    plannedKm: round1(plannedKm),
    reasons: reasons.length > 0 ? reasons : ["unexplained"],
  };
}

/**
 * Weekly volume the Daniels % caps are measured against. In cutback and taper weeks the caps use the
 * normal (pre-cutback / peak) week, and the work factor then sets the session to 60–70% (§6.7) or
 * 50–70% (§6.8 T3) of its normal work, instead of shrinking it twice (D).
 */
function capWeeklyKm(env: Env, info: WeekInfo): number {
  if (info.kind === "cutback" || info.kind === "tt") return info.targetKm / CUTBACK_VOLUME_FACTOR;
  if (info.kind === "taper") return env.shape.buildPeakKm;
  return info.targetKm;
}

/**
 * V2 "never above 30%": the shape already caps target-to-target growth, but a week can land under
 * its target (e.g. a capacity-limited cutback), so the next target is re-capped against what was
 * actually planned.
 * Exception: the first week after a run/walk ladder. Ladder km count running only (walking
 * excluded) and sit below the entry volume by design, so the handover resumes at the entry volume
 * (V3: the runner already does that much) and V2 is judged by session time there instead (D).
 */
function capToPreviousWeek(info: WeekInfo, st: State, prevWasLadder: boolean): WeekInfo {
  if (info.kind !== "ladder" && prevWasLadder && st.prevPlannedMinutes > 0) {
    info.v2HardMinutes = st.prevPlannedMinutes * (1 + WEEKLY_GROWTH_NEVER);
  }
  if (info.kind === "ladder" || prevWasLadder || st.prevPlannedKm <= 0) return info;
  info.v2HardKm = st.prevPlannedKm * (1 + WEEKLY_GROWTH_NEVER);
  const cap = st.prevPlannedKm * MAX_WEEK_OVER_WEEK;
  if (info.targetKm <= cap) return info;
  info.caps.add("V2:30%_over_last_week");
  return { ...info, targetKm: cap };
}

function buildContext(env: Env, info: WeekInfo): W.BuildContext {
  return {
    paces: env.shape.paces,
    rx: env.rx,
    level: env.input.level,
    distance: env.input.goal.distance,
    phase: info.phase,
    weeklyKm: capWeeklyKm(env, info),
  };
}

/**
 * V1 limit for a run on `day`. Uses runs from earlier weeks (plus `sameWeek`, when given): a subset
 * of the 30-day window, so the reference is never overstated.
 */
function v1At(env: Env, st: State, day: number, sameWeek: readonly RunRecord[] = []): { ref: V1Reference; limit: V1Limit } {
  const ref = v1Reference([...st.history, ...sameWeek], env.seed, day);
  return { ref, limit: v1Limit(ref, env.timeMode) };
}

/** §6.9: three run/walk sessions at this week's stage. No cutbacks inside the ladder (§6.7). */
function ladderWeek(env: Env, st: State, info: WeekInfo, notes: string[]): Placed[] {
  const planned = env.shape.ladderStages[info.w - 1] as number;
  const ctx = buildContext(env, info);
  const sameWeek: RunRecord[] = [];
  return weekTemplate(env.runDays, templateOptions(env, { ladder: true })).flatMap((slot): Placed[] => {
    const day = info.startDay + slot.offset;
    // Run/walk V1 is by total duration only (§6.5), so the time limit applies even in pace mode.
    const { ref } = v1At(env, st, day, sameWeek);
    const v1Min = V1_FACTOR * ref.minutes;
    const maxMin = Math.min(v1Min, env.dayCap(day));
    const fit = fitLadderStage(planned, maxMin);
    if (fit.stage !== planned) {
      notes.push(maxMin < v1Min ? `S:max_minutes_ladder_d${slot.offset}` : `V1: stage ${planned} is too long yet; repeating stage ${fit.stage}.`);
    }
    if (fit.minutes > env.dayCap(day) + 1e-9) {
      notes.push(`S:max_minutes_ladder_d${slot.offset}`); // not even stage 1 fits the day (§7.1 step 4)
      return [];
    }
    const trace = ["C1:ladder_no_cutback", `V1:ok(${fit.minutes.toFixed(0)}min<=${maxMin.toFixed(0)}min)`];
    if (fit.walkS < LADDER_WALK_WARMUP_S) trace.push("V1:short_walk_warmup");
    sameWeek.push({ day, minutes: fit.minutes });
    return [{ offset: slot.offset, draft: W.ladderSession(ctx, fit.stage, trace, fit.walkS) }];
  });
}

/**
 * V1 for run/walk is total duration (§6.5). Highest stage ≤ planned whose session fits, first with
 * 5-min walks, then 3-min walks (D). If even stage 1 doesn't fit, stage 1 with 2-min walks.
 */
function fitLadderStage(planned: number, maxMin: number): { stage: number; walkS: number; minutes: number } {
  for (let stage = planned; stage >= 1; stage--) {
    for (const walkS of [LADDER_WALK_WARMUP_S, 180]) {
      const minutes = ladderSessionSecondsWith(stage, walkS) / 60;
      if (minutes <= maxMin + 1e-9) return { stage, walkS, minutes };
    }
  }
  return { stage: 1, walkS: 120, minutes: ladderSessionSecondsWith(1, 120) / 60 };
}

function runWeek(env: Env, st: State, info: WeekInfo, notes: string[]): Placed[] {
  const { input, shape } = env;
  const ctx = buildContext(env, info);
  const lrQuality = decideQualityLongRun(env, st, info);
  const picks = chooseQuality(env, info, lrQuality);
  const slots = weekTemplate(
    env.runDays,
    templateOptions(env, { noConsecutiveDays: input.level === "beginner" && info.w <= 4, generalFitness: env.mode === "general_fitness" }),
  );
  // §7.1 step 4: a quality session may only go on a day whose time limit it fits (warm-up and
  // cool-down trimmed if needed); otherwise fallback 1 moves it, fallback 2 makes it easy.
  const qualityFits = (i: number, offset: number): boolean => {
    const cap = env.dayCap(info.startDay + offset);
    const pick = picks[i];
    if (!Number.isFinite(cap) || !pick) return true;
    const draft = qualityDraft(ctx, pick, { exposures: peekExposure(env, st, info, pick.kind), workFactor: workFactor(info.kind), trace: pick.trace });
    return draft.planned.minutes <= cap + 1e-9 || W.fitWarmCool(ctx, draft, Infinity, cap) !== undefined;
  };
  // T3: no long run inside the last-hard-session window (e.g. a Saturday LR before a Sunday race).
  const lrDaysToRace = env.cal.raceDay - (info.startDay + env.cal.lrOffset);
  const placement = placeWeek({
    weekStartDay: info.startDay,
    slots,
    longRun: !info.isRace && lrDaysToRace >= lastHardSessionDays(input.goal.distance).min,
    ...(info.isRace ? { raceOffset: env.cal.raceOffset } : {}),
    qualityCount: picks.length,
    priorKeyDays: st.keyDays,
    raceDay: env.cal.raceDay,
    minDaysBeforeRace: lastHardSessionDays(input.goal.distance).min,
    qualityBlockedDays: env.qualityBlocked,
    flexibleBlockedDays: env.flexibleBlocked,
    qualityFits,
  });
  notes.push(...placement.trace);

  const placed: Placed[] = [];
  let lrKm = 0;
  let lrDraft: W.WorkoutDraft | undefined;
  if (placement.lrOffset !== undefined) {
    lrDraft = buildLongRun(env, st, info, ctx, lrQuality, placement.lrOffset);
    lrKm = lrDraft.planned.run_m / 1000;
  }

  // No other run outranks the week's long run, except in taper and TT weeks (D) – unless the TT
  // couldn't be placed (e.g. no day had the time for it, §7.1 step 4).
  const ttPlaced = picks.some((p, i) => p.kind === "TT" && placement.qualityOffsets[i] !== undefined);
  const lrRules = lrKm > 0 && info.kind !== "taper" && !(info.kind === "tt" && ttPlaced);
  let lrCapKm = lrRules ? lrKm : Infinity;

  picks.forEach((pick, i) => {
    const offset = placement.qualityOffsets[i];
    if (offset === undefined) return; // fallback 2: the slot stays easy and gets strides below
    placed.push({ offset, draft: buildQuality(env, st, info, ctx, pick, offset, lrCapKm) });
  });

  // Cutback weeks cut the LR (−30%) harder than the week (−5 to −25%). If the easy runs, each
  // capped at the LR, then can't carry the week, raise the LR just enough (still ≤ its normal level
  // and every L1/V1 cap) instead of planning a deeper cutback than intended (D).
  if (lrDraft && lrRules && info.kind === "cutback" && placement.lrOffset !== undefined) {
    const qualityKm = sumDraftKm(placed);
    const fillKm = (info.targetKm - qualityKm) / (placement.easy.length + 1);
    if (fillKm > lrKm + 0.05) {
      lrDraft = buildLongRun(env, st, info, ctx, lrQuality, placement.lrOffset, fillKm);
      lrKm = lrDraft.planned.run_m / 1000;
      lrCapKm = lrKm;
    }
  }
  if (lrDraft && placement.lrOffset !== undefined) placed.push({ offset: placement.lrOffset, draft: lrDraft });

  let easySlots = placement.easy;
  if (info.isRace) {
    const shake = easySlots.find((s) => s.offset === env.cal.raceOffset - 1);
    if (shake) {
      placed.push({ offset: shake.offset, draft: shakeout(env, st, info, ctx, shake.offset) });
      easySlots = easySlots.filter((s) => s !== shake);
    }
  }
  const easyBudget = info.targetKm - sumDraftKm(placed);
  placed.push(...buildEasyRuns(env, st, info, ctx, easySlots, easyBudget, lrKm, lrCapKm, notes));

  if (info.isRace) {
    const predicted = predictedGoalTimeS(input, shape.paces.vdot);
    placed.push({ offset: env.cal.raceOffset, draft: W.raceDay(ctx, input.goal.timeS, predicted) });
  }
  return enforceV1InDateOrder(env, st, info, ctx, enforceWeeklyGrowthNever(env, info, ctx, placed));
}

/**
 * V2 "never above 30%" as a hard guard (§6.5). Targets are already capped against last week, but
 * S3's minimum run length (and the entered longest run as the LR floor) can push a sparse week over
 * when the week before was far under target, e.g. a single-run beginner week on adjacent weekdays.
 * What gives way, in order (D): easy runs (the longest shortened if it stays ≥ the S3 minimum,
 * else the shortest dropped), then quality warm-ups / cool-downs, then quality sessions, then the LR.
 */
function enforceWeeklyGrowthNever(env: Env, info: WeekInfo, ctx: W.BuildContext, placed: Placed[]): Placed[] {
  // After a run/walk week V2 is judged by session time (§6.5), otherwise by km.
  const byTime = Number.isFinite(info.v2HardMinutes);
  const hard = byTime ? info.v2HardMinutes : info.v2HardKm;
  const kmOf = (p: Placed) => (byTime ? p.draft.planned.minutes : p.draft.planned.run_m / 1000);
  const total = (ps: readonly Placed[]) => ps.filter((p) => p.draft.type !== "RACE").reduce((a, p) => a + kmOf(p), 0);
  if (!(total(placed) - hard > 1e-9)) return placed;
  info.caps.add("V2:30%_over_last_week");
  const minMin = env.input.level === "beginner" ? EASY_MIN_MINUTES_BEGINNER : EASY_MIN_MINUTES;
  const minKm = byTime ? minMin : W.easyKmForMinutes(ctx.paces, minMin);
  const limitOf = (p: Placed, size: number): V1Limit =>
    byTime ? { km: p.draft.planned.run_m / 1000, minutes: Math.floor(size) } : { km: floorKm(size - 0.05), minutes: Infinity };
  const excess = (ps: readonly Placed[]) => total(ps) - hard;
  const swap = (ps: Placed[], p: Placed, draft: W.WorkoutDraft) => ps.map((x) => (x === p ? { offset: x.offset, draft: withTrace(draft, "V2:30%_over_last_week") } : x));
  let out = [...placed];

  const easy = out.filter((p) => p.draft.type === "E" || p.draft.type === "S");
  const longest = [...easy].sort((a, b) => kmOf(b) - kmOf(a) || a.offset - b.offset)[0];
  if (longest && kmOf(longest) - excess(out) >= minKm) {
    return swap(out, longest, shrinkToLimit(ctx, longest.draft, limitOf(longest, kmOf(longest) - excess(out))));
  }
  for (const p of [...easy].sort((a, b) => kmOf(a) - kmOf(b) || b.offset - a.offset)) {
    if (excess(out) <= 1e-9) return out;
    out = out.filter((x) => x !== p);
  }
  const quality = out.filter((p) => p.draft.flags.key_session && p.draft.type !== "L" && p.draft.type !== "RACE");
  for (const p of quality) {
    if (excess(out) <= 1e-9) return out;
    const lim = limitOf(p, kmOf(p) - excess(out));
    const trimmed = W.fitWarmCool(ctx, p.draft, lim.km, lim.minutes);
    if (trimmed) return swap(out, p, trimmed);
  }
  for (const p of [...quality].sort((a, b) => kmOf(a) - kmOf(b) || b.offset - a.offset)) {
    if (excess(out) <= 1e-9) return out;
    out = out.filter((x) => x !== p);
  }
  const lr = out.find((p) => p.draft.type === "L");
  if (lr && excess(out) > 1e-9) out = swap(out, lr, shrinkToLimit(ctx, lr.draft, limitOf(lr, Math.max(byTime ? 1 : 0.15, kmOf(lr) - excess(out)))));
  return out;
}

/**
 * Final V1 pass in date order, with this week's earlier runs in the history (§6.5). Sessions are
 * planned LR-first (it sets the week's shape), so each was checked against earlier weeks only. That
 * is usually the stricter check, but not always: when the window held only run/walk sessions, the
 * entered longest run stood in as the distance reference, and the week's own earlier easy runs
 * replace it. Any run over its limit here is shortened, and later runs are kept ≤ a shortened LR.
 */
function enforceV1InDateOrder(env: Env, st: State, info: WeekInfo, ctx: W.BuildContext, placed: Placed[]): Placed[] {
  const sorted = [...placed].sort((a, b) => a.offset - b.offset);
  const sameWeek: RunRecord[] = [];
  const out: Placed[] = [];
  for (const p of sorted) {
    const day = info.startDay + p.offset;
    let draft = p.draft;
    if (draft.type !== "RACE") {
      const { limit: v1 } = v1At(env, st, day, sameWeek);
      const limit = withDayCap(v1, env.dayCap(day));
      const km = draft.planned.run_m / 1000;
      if (!v1Ok(km, draft.planned.minutes, limit, draft.type === "RW")) {
        const byDay = v1Ok(km, draft.planned.minutes, v1, draft.type === "RW");
        draft = shrinkToLimit(ctx, draft, limit);
        if (byDay) draft = withTrace(draft, "S:max_minutes");
        info.caps.add(byDay ? "S:max_minutes" : "V1:cap");
      }
      const minutes: number = draft.planned.minutes;
      const runM: number = draft.planned.run_m;
      sameWeek.push(draft.type === "RW" ? { day, minutes } : { day, km: runM / 1000, minutes });
    }
    out.push({ offset: p.offset, draft });
  }
  return out;
}

/** Rebuild a run so it fits `limit`, keeping its kind where possible. */
function shrinkToLimit(ctx: W.BuildContext, d: W.WorkoutDraft, limit: V1Limit): W.WorkoutDraft {
  if (d.type === "L") {
    const trace0: string[] = d.rule_trace;
    const content = (trace0.find((t) => t.startsWith("L3:"))?.slice(3) ?? "easy") as W.LongRunContentKind;
    const pace = midPace(ctx.paces.LR);
    const km = floorKm(Math.min(limit.km, (limit.minutes * 60) / pace) - 0.05);
    const trace = trace0.filter((t) => !t.startsWith("L3:") && !t.startsWith("V1:ok"));
    return withTrace(W.longRun(ctx, km, { content, trace }), `V1:shortened_in_week(${km.toFixed(1)})`);
  }
  const fitted = W.fitWarmCool(ctx, d, limit.km, limit.minutes);
  if (fitted) return fitted;
  return fitEasy(ctx, limit.km, { trace: [...d.rule_trace, "V1:shortened_in_week"] }, limit);
}

// ── quality choice (§6.4, P3) ────────────────────────────────────────────────────────────────────

/** L3/I2 alternation: every other eligible build week gets a quality long run. */
function decideQualityLongRun(env: Env, st: State, info: WeekInfo): boolean {
  const eligible = info.kind === "build" && info.weeksOut > 2 && longRunMayBeQuality(env.allow, info.phase);
  if (!eligible) return false;
  st.lrEligibleWeeks += 1;
  return st.lrEligibleWeeks % 2 === 0;
}

function chooseQuality(env: Env, info: WeekInfo, lrQuality: boolean): QualityPick[] {
  const { input } = env;
  if (info.kind === "tt") return [{ kind: "TT", trace: ["C2:tt_counts_as_cutback"] }];
  if (info.phase === "BASE" || info.phase === "FI") return [];
  // §7.2: the 2-day general-fitness row has no Q slot (E + L only).
  if (env.mode === "general_fitness" && env.runDays <= 2) return [];
  if (info.isRace && env.cal.raceOffset < lastHardSessionDays(input.goal.distance).min) return [];

  let n = weeklyQualityCount(env.allow, lrQuality, info.budget);
  if (info.kind === "cutback" || info.kind === "taper") n = Math.min(1, n);
  const emph = phaseEmphasis(input.goal.distance, info.phase, info.phaseIdx, info.phaseLen);
  if (n === 0 || !emph) return [];

  const kinds: QualityKind[] = info.kind === "taper" ? ["GP"] : n >= 2 ? [...emph.pair] : [emph.single];
  const dist = { "5k": "5K", "10k": "10K", half: "HM", marathon: "M" }[input.goal.distance];
  return kinds.map((k, i) => {
    const sub = substituteQuality(k, input.level, input.vdotStatus, info.phase);
    const trace = [`P3:${info.phase}:${dist}:${sub.kind}`, `${env.allow.rule}:Q${i + 1}`];
    if (info.budget < env.budget) trace.push(`§6.4:hard_xt_half_key(budget=${info.budget})`);
    if (sub.rule) trace.push(sub.rule);
    if (info.kind === "cutback") trace.push("C1:cutback_quality");
    if (info.kind === "taper") trace.push("T3:goal_pace");
    return { kind: sub.kind, trace };
  });
}

function workFactor(kind: WeekKind): number {
  if (kind === "cutback") return CUTBACK_QUALITY_FACTOR;
  if (kind === "taper") return TAPER_QUALITY_WORK_FRACTION;
  return 1;
}

/**
 * Progression counter per session family. Every marathon-pace exposure (M sessions, marathon GP,
 * M-segment long runs) shares one counter so M blocks grow +1–2 km per exposure (§6.10).
 */
function exposureKey(env: Env, kind: QualityKind | "TT" | "LR_M"): string {
  if (kind === "LR_M" || kind === "M") return "M";
  if (kind === "GP" && env.input.goal.distance === "marathon") return "M";
  return kind;
}

/**
 * The progression family (exposureKey) a planned workout counted toward, read from its type and
 * trace; undefined for sessions that don't progress (easy, easy LR, race, run/walk). Used to carry
 * progression into a continued plan (§8 R-RACE-2).
 */
export function exposureFamilyOf(w: Pick<PlannedWorkout, "type" | "rule_trace">): ExposureFamily | undefined {
  switch (w.type) {
    case "L":
      return w.rule_trace.includes("L3:m_segment") ? "M" : undefined;
    case "M":
      // Non-marathon goal-pace sessions are typed M with a W-GP trace; marathon GP is an M session.
      return w.rule_trace.some((t) => t.startsWith("W-GP:")) ? "GP" : "M";
    case "T":
    case "I":
    case "R":
    case "H":
    case "TT":
      return w.type;
    default:
      return undefined;
  }
}

/** The exposure count the next session of this kind would get, without counting it. */
function peekExposure(env: Env, st: State, info: WeekInfo, kind: QualityKind | "TT"): number {
  const n = st.exposures.get(exposureKey(env, kind)) ?? 0;
  return info.kind === "taper" ? Math.max(0, (n || 1) - 1) : n;
}

function nextExposure(env: Env, st: State, kind: QualityKind | "TT" | "LR_M"): number {
  const key = exposureKey(env, kind);
  const n = st.exposures.get(key) ?? 0;
  st.exposures.set(key, n + 1);
  return n;
}

function buildQuality(
  env: Env,
  st: State,
  info: WeekInfo,
  ctx: W.BuildContext,
  pick: QualityPick,
  offset: number,
  lrCapKm: number,
): W.WorkoutDraft {
  // Taper sessions repeat the last exposure's size (no progression), scaled by the work factor.
  const exposures =
    info.kind === "taper"
      ? Math.max(0, (st.exposures.get(exposureKey(env, pick.kind)) ?? 1) - 1)
      : nextExposure(env, st, pick.kind);
  const o: W.QualityOptions = { exposures, workFactor: workFactor(info.kind), trace: pick.trace };
  const draft = qualityDraft(ctx, pick, o);
  if (pick.kind === "TT") info.caps.add("TT:fixed_session");

  const { limit } = v1At(env, st, info.startDay + offset);
  const lrCapped = withLrCap(limit, lrCapKm);
  const capped = withDayCap(lrCapped, env.dayCap(info.startDay + offset));
  const fitted = W.fitWarmCool(ctx, draft, capped.km, capped.minutes);
  // Which limit trimmed it: the day's time (§7.1 step 4), V1, or the week's long run.
  const byDay = fitted !== draft && capped !== lrCapped && W.fitWarmCool(ctx, draft, lrCapped.km, lrCapped.minutes) === draft;
  if (fitted !== draft) info.caps.add(byDay ? "S:max_minutes" : lrCapped === limit ? "V1:cap" : "LR:longest_run_of_week");
  if (fitted) return withTrace(byDay ? withTrace(fitted, "S:max_minutes") : fitted, v1Trace(fitted.planned.run_m / 1000, limit));
  // Still over V1 (or the LR) after trimming: convert to easy + strides (never exceed V1, §6.5).
  const km = Math.min(capped.km, (capped.minutes * 60) / midPace(ctx.paces.E));
  return fitEasy(ctx, km, { strides: W.strideCount(info.w), trace: [...pick.trace, "V1:Q->E+S"] }, capped);
}

/** The V1 limit, further capped at the week's long run (km). */
function withLrCap(limit: V1Limit, lrCapKm: number): V1Limit {
  return lrCapKm < limit.km ? { ...limit, km: lrCapKm } : limit;
}

function qualityDraft(ctx: W.BuildContext, pick: QualityPick, o: W.QualityOptions): W.WorkoutDraft {
  // (A TT is a fixed 3 km all-out plus warm-up; its size doesn't follow the weekly target.)
  switch (pick.kind) {
    case "TT":
      return W.timeTrial(ctx, pick.trace);
    case "T":
      return W.thresholdRun(ctx, o);
    case "I":
      return W.intervalRun(ctx, o);
    case "R":
      return W.repetitionRun(ctx, o);
    case "H":
      return W.hillRun(ctx, o);
    case "M":
      return W.marathonPaceRun(ctx, o);
    case "GP":
      return W.goalPaceRun(ctx, o);
  }
}

// ── long run (§6.6, §6.7, §6.8) ──────────────────────────────────────────────────────────────────

function buildLongRun(
  env: Env,
  st: State,
  info: WeekInfo,
  ctx: W.BuildContext,
  lrQuality: boolean,
  offset: number,
  cutbackFloorKm = 0,
): W.WorkoutDraft {
  const day = info.startDay + offset;
  const { ref, limit } = v1At(env, st, day);
  const { km, trace } = longRunKm(env, st, info, ref, limit, env.cal.raceDay - day, cutbackFloorKm);
  const content = longRunContent(env.input.level, env.input.goal.distance, info.phase, lrQuality);
  const mExposures = content === "m_segment" ? nextExposure(env, st, "LR_M") : 0;
  const draft = W.longRun(ctx, km, { content, mExposures, trace: [...trace, v1Trace(km, limit)] });

  // Daniels soft cap (§6.6): a convention warning in the trace only; the summary counts the weeks.
  const soft = lrSoftCapFraction(info.targetKm);
  return km > soft * info.targetKm && info.kind === "build" ? withTrace(draft, "L1:warn_daniels_soft_cap") : draft;
}

function longRunKm(
  env: Env,
  st: State,
  info: WeekInfo,
  ref: V1Reference,
  limit: V1Limit,
  daysToRace: number,
  cutbackFloorKm = 0,
): { km: number; trace: string[] } {
  const l1 = l1CapKm(env.shape.lrCaps, info.targetKm, env.input.longestRun30d.km);
  const options: Array<[number, string]> = [
    [l1.km, l1.rule],
    [limit.km, "V1:cap"],
    [(limit.minutes * 60) / midPace(env.shape.paces.LR), "V1:time_cap"],
  ];
  // §7.1 step 4 / fallback 3: the long run shortened to what the day's time limit allows.
  const cap = env.dayCap(env.cal.raceDay - daysToRace);
  if (Number.isFinite(cap)) options.push([(cap * 60) / midPace(env.shape.paces.LR), "S:max_minutes"]);
  if (info.kind === "taper") {
    const f = taperLongRunFraction(info.weeksOut);
    options.push([f * st.peakLrKm, `T3:LR×${f}`]);
  } else if (info.kind === "cutback" || info.kind === "tt") {
    const cut = CUTBACK_LONG_RUN_FACTOR * st.lrLevelKm;
    options.push(
      cutbackFloorKm > cut
        ? [Math.min(cutbackFloorKm, st.lrLevelKm), "C1:cutback_LR_raised_to_fill_week"]
        : [cut, "C1:cutback_LR-30%"],
    );
  } else {
    const l2 = lrStepLimitKm(ref.km);
    options.push([l2.km, l2.rule]);
    // A week held back by V2 never gets a long run bigger than the whole week (sparse schedules).
    if (info.caps.has("V2:30%_over_last_week")) options.push([info.targetKm, "V2:30%_over_last_week"]);
    if (daysToRace < PEAK_LR_MIN_DAYS_OUT && st.peakLrKm > 0) {
      options.push([PRE_TAPER_LR_FRACTION * st.peakLrKm, "L2:peak_3-5wk_out"]);
    }
  }
  const [raw, rule] = options.reduce((a, b) => (b[0] < a[0] ? b : a));
  const km = floorKm(Math.max(0, raw));
  if (rule === "S:max_minutes") info.caps.add(rule);
  if (info.kind === "build" && rule !== "L2:peak_3-5wk_out") {
    st.lrLevelKm = km;
    st.peakLrKm = Math.max(st.peakLrKm, km);
  }
  return { km, trace: [rule] };
}

// ── easy runs (S3) and strides ───────────────────────────────────────────────────────────────────

function buildEasyRuns(
  env: Env,
  st: State,
  info: WeekInfo,
  ctx: W.BuildContext,
  allSlots: readonly EasySlot[],
  budgetKm: number,
  lrKm: number,
  lrCapKm: number,
  notes: string[],
): Placed[] {
  let slots = allSlots;
  const minMin = env.input.level === "beginner" ? EASY_MIN_MINUTES_BEGINNER : EASY_MIN_MINUTES;
  const minKm = W.easyKmForMinutes(ctx.paces, minMin);
  // §7.1 step 4: each easy run fits its day's time limit; a day that can't hold the S3 minimum is
  // left free (D) and the volume it can't take is reported.
  const dayKm = (slot: EasySlot) => {
    const cap = env.dayCap(info.startDay + slot.offset);
    return Number.isFinite(cap) ? (cap * 60) / midPace(slot.role === "REC" ? ctx.paces.REC : ctx.paces.E) : Infinity;
  };
  const tooShort = slots.filter((s) => dayKm(s) < minKm - 1e-9);
  for (const s of tooShort) notes.push(`S:max_minutes_easy_d${s.offset}`);
  if (tooShort.length > 0) slots = slots.filter((s) => !tooShort.includes(s));
  // S3 caps easy runs at 70% of the LR. In cutback/TT/taper weeks the LR is cut on purpose (−30%),
  // more than the week (−5 to −25%), so S3 uses the normal LR level there; otherwise the run days
  // can't carry the week. The "LR is the longest run" rule (lrCapKm) still applies on top (D).
  const refLr = info.kind === "build" ? lrKm : Math.max(lrKm, st.lrLevelKm);
  const maxKm = easyMaxKm(env.input.level, env.runDays, ctx.paces, refLr);

  // Strides (≤ 2×/week) go on converted Q slots first, then the earliest easy days. Their km
  // (strides + jogs) comes out of the easy budget so the week lands on target, but never at the
  // cost of an easy run: fewer stride sessions are planned when the runs would drop below S3's minimum.
  const strideN = W.strideCount(info.w);
  const perStrideKm = W.stridesKm(ctx, strideN);
  const fits = (k: number) => budgetKm - k * perStrideKm >= minKm * slots.length;
  let strideSessions = Math.min(MAX_STRIDE_SESSIONS, slots.filter((s) => s.role !== "REC").length);
  while (strideSessions > 0 && !fits(strideSessions)) strideSessions--;
  const strideSlots = new Set(
    [...slots]
      .filter((s) => s.role !== "REC")
      .sort((a, b) => Number(b.wasQualitySlot) - Number(a.wasQualitySlot) || a.offset - b.offset)
      .slice(0, strideSessions)
      .map((s) => s.offset),
  );
  const perSlot = slotMaxKm(ctx.paces);
  const spread = spreadEasy(
    budgetKm - strideSessions * perStrideKm,
    slots,
    minKm,
    Math.min(maxKm, lrCapKm),
    (s) => Math.min(perSlot(s), dayKm(s as EasySlot)),
  );
  const atDayCap = slots.filter((s, i) => Number.isFinite(dayKm(s)) && (spread.km[i] ?? 0) >= Math.min(maxKm, lrCapKm, perSlot(s), dayKm(s)) - 0.05 && dayKm(s) < Math.min(maxKm, lrCapKm, perSlot(s)));
  if (spread.unplacedKm > 0.05) info.caps.add("S3:easy_capacity");
  if (spread.unplacedKm > 0.5) {
    notes.push(`S3: ${spread.unplacedKm.toFixed(1)} km of easy volume doesn't fit; more run days would help.`);
    for (const s of atDayCap) notes.push(`S:max_minutes_easy_d${s.offset}`);
    if (atDayCap.length > 0 || tooShort.length > 0) info.caps.add("S:max_minutes");
  }
  if (spread.trace.includes("S3:raised_to_min") || spread.trace.includes("S3:no_easy_volume")) info.caps.add("S3:easy_min_length");
  if (budgetKm < 0) info.caps.add("S3:no_easy_budget");

  const out: Placed[] = [];
  slots.forEach((slot, i) => {
    const km = spread.km[i] ?? 0;
    if (km <= 0) return;
    const { limit } = v1At(env, st, info.startDay + slot.offset);
    const opts: W.EasyOptions = {
      recovery: slot.role === "REC",
      strides: strideSlots.has(slot.offset) ? strideN : 0,
      trace: spread.trace,
    };
    const cap = env.dayCap(info.startDay + slot.offset);
    const draft = fitEasy(ctx, km, opts, withDayCap(withLrCap(limit, lrCapKm), cap));
    const wanted = km + W.stridesKm(ctx, opts.strides ?? 0);
    if (draft.planned.run_m / 1000 < wanted - 0.3) info.caps.add(km > limit.km ? "V1:cap" : draft.planned.minutes >= cap - 1 ? "S:max_minutes" : "LR:longest_run_of_week");
    out.push({ offset: slot.offset, draft });
  });
  return out;
}

/** Day before the race: a short easy run with 4 strides (§6.8 T3 "strides and goal-pace touches"). */
function shakeout(env: Env, st: State, info: WeekInfo, ctx: W.BuildContext, offset: number): W.WorkoutDraft {
  const minutes = env.input.level === "beginner" ? EASY_MIN_MINUTES_BEGINNER : EASY_MIN_MINUTES;
  const km = W.easyKmForMinutes(ctx.paces, minutes);
  const { limit } = v1At(env, st, info.startDay + offset);
  return fitEasy(ctx, km, { shakeout: true, strides: 4, trace: ["T3:shakeout"] }, withDayCap(limit, env.dayCap(info.startDay + offset)));
}

/**
 * Build an easy run of `km` (+ strides) no bigger than `limit`. If the strides don't fit, they are
 * dropped and their km goes into the run itself, so the week keeps its volume; then the run shortens.
 */
function fitEasy(ctx: W.BuildContext, km: number, opts: W.EasyOptions, limit: V1Limit): W.WorkoutDraft {
  const strideKm = W.stridesKm(ctx, opts.strides ?? 0);
  let target = floorKm(Math.min(km, limit.km));
  for (let attempt = 0; attempt < 4; attempt++) {
    const tries: Array<[number, number]> = opts.strides
      ? [[opts.strides, target], [0, floorKm(Math.min(target + strideKm, limit.km))]]
      : [[0, target]];
    for (const [strides, k] of tries) {
      const d = W.easyRun(ctx, k, { ...opts, strides });
      const runKm = d.planned.run_m / 1000;
      if (v1Ok(runKm, d.planned.minutes, limit)) return withTrace(d, v1Trace(runKm, limit));
    }
    const d = W.easyRun(ctx, target, { ...opts, strides: 0 });
    const ratio = Math.min(limit.km / (d.planned.run_m / 1000), limit.minutes / d.planned.minutes);
    target = floorKm(target * Math.min(0.99, ratio));
  }
  return withTrace(W.easyRun(ctx, floorKm(target * 0.9), { ...opts, strides: 0 }), "V1:shortened");
}

// ── summary ──────────────────────────────────────────────────────────────────────────────────────

function summarize(env: Env, weeks: PlanWeek[], status: string, input: PlanInput): PlanSummary {
  const { shape, cal } = env;
  const endDate = fromDayNumber(cal.startDay + 7 * cal.weeks - 1);
  let peakLr = 0;
  let peakLrWeek = 0;
  for (const wk of weeks) {
    if (wk.longRunKm >= peakLr && wk.longRunKm > 0) {
      peakLr = wk.longRunKm;
      peakLrWeek = wk.index;
    }
  }
  const notes = [`feasibility:${status}`, ...shape.trace];
  if (input.goal.timeS !== env.input.goal.timeS && env.input.goal.timeS !== undefined) {
    notes.push(`§6.2: goal defaulted to ${formatDuration(env.input.goal.timeS)} (current fitness + 1 VDOT); you can override it.`);
  }
  const soft = weeks.filter((w) => w.workouts.some((x) => x.rule_trace.includes("L1:warn_daniels_soft_cap"))).length;
  if (soft > 0) notes.push(`L1: the long run is above Daniels' 25–30% of the week in ${soft} weeks (convention warning).`);
  const flagged = weeks.filter((w) => w.volumeFlag);
  if (flagged.length > 0) {
    notes.push(
      `Volume: ${flagged.length} week(s) more than ${VOLUME_TOLERANCE * 100}% off target: ` +
        flagged.map((w) => `wk ${w.index} (${w.volumeFlag!.reasons.join(", ")})`).join("; "),
    );
  }
  const tts = weeks.filter((w) => w.workouts.some((x) => x.type === "TT")).map((w) => w.index);
  if (tts.length > 0) notes.push(`Week ${tts.join(", ")}: 3K time trial; replan into pace mode with the result (§4.2, §8).`);
  if (env.mode === "general_fitness") notes.push(`§6.1: general fitness, ${shape.cutback.every - 1}+1 blocks, no taper.`);
  notes.push(...crossTrainingNotes(env, input));
  return {
    mode: env.mode,
    endDate,
    weeks: weeks.length,
    leadInDays: cal.leadInDays,
    startDate: fromDayNumber(cal.startDay),
    raceDate: env.mode === "race" ? input.raceDate : endDate,
    distance: input.goal.distance,
    phaseSplit: phaseCounts(shape.phases.byWeek),
    ladderWeeks: shape.ladderWeeks,
    taperWeeks: shape.taperWeeks,
    cutbackEvery: shape.cutback.every,
    peakWeekKm: round1(Math.max(0, ...weeks.map((w) => w.plannedKm))),
    peakLongRunKm: peakLr,
    peakLongRunWeek: peakLrWeek,
    totalKm: round1(weeks.reduce((a, w) => a + w.plannedKm, 0)),
    volumeFlags: weeks.flatMap((w) => (w.volumeFlag ? [w.volumeFlag] : [])),
    notes,
  };
}

function emptySummary(input: PlanInput, cal: PlanCalendar, status: string, mode: PlanMode): PlanSummary {
  return {
    mode,
    endDate: input.raceDate,
    weeks: 0,
    leadInDays: cal.leadInDays,
    startDate: fromDayNumber(cal.startDay),
    raceDate: input.raceDate,
    distance: input.goal.distance,
    phaseSplit: phaseCounts([]),
    ladderWeeks: 0,
    taperWeeks: 0,
    cutbackEvery: 4,
    peakWeekKm: 0,
    peakLongRunKm: 0,
    peakLongRunWeek: 0,
    totalKm: 0,
    volumeFlags: [],
    conflicts: [],
    notes: [`feasibility:${status}`, "No plan generated: see feasibility."],
  };
}

// ── cross-training reports (§7.1 fallbacks 5–6, §10.2) ───────────────────────────────────────────

const WD = (day: number) => {
  const w = weekdayOf(fromDayNumber(day));
  return w.slice(0, 1).toUpperCase() + w.slice(1);
};

/**
 * Locked sessions are placed first and never moved (§10.2), so what the scheduler can't fix is
 * reported: a hard session the day before the LR or race, and quality runs lost only to a flexible
 * session (fallback 5, with a suggested day; fallback 6 otherwise).
 */
function crossTrainingConflicts(env: Env, weeks: readonly PlanWeek[], out: ScheduleConflict[]): void {
  const lrDays = new Set<number>();
  const qualityDays = new Set<number>();
  for (const w of weeks.flatMap((x) => x.workouts)) {
    const d = toDayNumber(w.date);
    if (w.type === "L" || w.type === "RACE") lrDays.add(d);
    else if (w.flags.key_session) qualityDays.add(d);
  }
  const weekOf = (day: number) => weeks.find((w) => day >= toDayNumber(w.startDate) && day < toDayNumber(w.startDate) + 7);
  /** A day in the same plan week where this session breaks nothing (nearest first). */
  const suggestDay = (x: CrossTrainingSession, day: number, start: number, avoid: readonly number[] = []): number | undefined => {
    const cands = Array.from({ length: 7 }, (_, i) => start + i)
      .filter((c) => c !== day && !lrDays.has(c) && !avoid.includes(c))
      .filter((c) => !(x.hard && lrDays.has(c + 1)))
      .filter((c) => !x.blocksNextDayQuality || (!qualityDays.has(c) && !qualityDays.has(c + 1)))
      .sort((a, b) => Math.abs(a - day) - Math.abs(b - day) || a - b);
    return cands[0];
  };

  for (const x of env.xt) {
    const day = toDayNumber(x.date);
    const wk = weekOf(day);
    if (!wk || !x.hard) continue;
    if (!lrDays.has(day + 1)) continue;
    const alt = x.locked ? undefined : suggestDay(x, day, toDayNumber(wk.startDate));
    recordConflict(out, {
      code: "XT:hard_day_before_LR",
      weekday: x.weekday,
      week: wk.index,
      message: `${x.name} (hard) on ${WD(day)} is the day before the ${lrDays.has(day + 1) && day + 1 === env.cal.raceDay ? "race" : "long run"} (§7.1: no hard cross-training the day before the LR).${x.locked ? " It's locked, so it stays: keep it easy that day if you can." : ""}`,
      ...(alt !== undefined ? { suggestion: `§7.1 fallback 5: move it to ${WD(alt)}.` } : {}),
    });
  }

  // T3: the last hard session is 7–10 days out; a hard locked session in the final 3 days is flagged (D).
  if (env.mode === "race") {
    for (const x of env.xt) {
      const day = toDayNumber(x.date);
      const wk = weekOf(day);
      if (!wk || !x.hard || day + 1 === env.cal.raceDay || env.cal.raceDay - day > 3) continue;
      recordConflict(out, {
        code: "XT:hard_in_race_week",
        weekday: x.weekday,
        week: wk.index,
        message: `${x.name} (hard) on ${WD(day)} is ${env.cal.raceDay - day} days before the race: keep it easy or skip it that week (§6.8 T3).`,
      });
    }
  }

  for (const wk of weeks) {
    const start = toDayNumber(wk.startDate);
    for (const n of wk.notes) {
      const m = /^S:fallback([56]):(?:flexible|locked)_xt_blocks_d(\d)$/.exec(n);
      if (!m) continue;
      const flexibleOnly = m[1] === "5";
      const qDay = start + Number(m[2]);
      for (const x of env.xt) {
        const d = toDayNumber(x.date);
        const blocks = (x.blocksNextDayQuality && (d === qDay || d === qDay - 1)) || (isLowerLift(x) && d === qDay - 1);
        if (!blocks || (flexibleOnly && x.locked)) continue;
        const alt = x.locked ? undefined : suggestDay(x, d, start, [qDay - 1, qDay]);
        recordConflict(out, {
          code: x.locked ? "XT:locked_blocks_quality" : "XT:flexible_blocks_quality",
          weekday: x.weekday,
          week: wk.index,
          message: `${x.name} on ${WD(d)} turned a quality run into easy + strides (no quality on or within 24 h after a hard session, or the day after lower-body lifting).`,
          ...(alt !== undefined ? { suggestion: `§7.1 fallback 5: move it to ${WD(alt)}.` } : {}),
        });
      }
    }
  }
}

/**
 * §7.1 step 4 ("respect max_session_minutes_by_day") with fallbacks 1–3 and 6: every run already
 * fits its day; what the limits cost is reported here (D), once per code and weekday with its weeks.
 */
function dayLimitConflicts(env: Env, weeks: readonly PlanWeek[], out: ScheduleConflict[]): void {
  const limit = (day: number) => `${Math.round(env.dayCap(day))}-min limit on ${WD(day)}`;
  const add = (code: string, day: number, week: number, message: string, suggestion: string) =>
    recordConflict(out, { code, weekday: weekdayOf(fromDayNumber(day)), week, message, suggestion });
  for (const wk of weeks) {
    const start = toDayNumber(wk.startDate);
    for (const n of new Set(wk.notes)) {
      const m = /^S:max_minutes_(blocks|easy|ladder)_d(\d)$/.exec(n);
      if (!m) continue;
      const day = start + Number(m[2]);
      if (m[1] === "blocks") {
        add("S:max_minutes_quality", day, wk.index, `A quality session doesn't fit your ${limit(day)}, so it moved to another day or became easy running with strides (§7.1 fallbacks 1–2).`, `Allow more time on ${WD(day)} to keep it there.`);
      } else if (m[1] === "easy") {
        add("S:max_minutes_easy_volume", day, wk.index, `Your ${limit(day)} leaves part of the week's easy volume unplanned (§7.1 step 6: "needs more days").`, `Allow more time on ${WD(day)}, or add a run day.`);
      } else {
        add("S:max_minutes_run_walk", day, wk.index, `Your ${limit(day)} holds the run/walk session to an earlier stage.`, `Allow more time on ${WD(day)}.`);
      }
    }
    for (const w of wk.workouts) {
      if (w.sport !== "run" || w.type !== "L" || !w.rule_trace.includes("S:max_minutes")) continue;
      const day = toDayNumber(w.date);
      add("S:max_minutes_long_run", day, wk.index, `The long run is held to your ${limit(day)} (§7.1 fallback 3: the longest run that fits).`, `Allow more time on ${WD(day)}, or pick a long-run day with more time.`);
    }
  }
}

/** Plan-level cross-training notes: race-day sessions skipped, load share vs the C1 flag. */
function crossTrainingNotes(env: Env, input: PlanInput): string[] {
  const events = input.lockedEvents ?? [];
  if (events.length === 0) return [];
  const notes: string[] = [];
  const raceWeekday = env.mode === "race" ? weekdayOf(input.raceDate) : undefined;
  for (const e of events) {
    if (e.weekday === raceWeekday) notes.push(`§10.2: ${e.name ?? e.activity} is skipped on race day.`);
  }
  const hard = env.xt.filter((x) => x.keyCost > 0);
  if (hard.length > 0) {
    notes.push(`§6.4: each hard cross-training day counts as ½ key session (${hard[0]!.name} on ${hard[0]!.weekday}).`);
  }
  return notes;
}

function phaseCounts(byWeek: readonly Phase[]): Record<Phase, number> {
  const out: Record<Phase, number> = { BASE: 0, FI: 0, EQ: 0, TQ: 0, FQ: 0 };
  for (const p of byWeek) out[p] += 1;
  return out;
}

// ── helpers ──────────────────────────────────────────────────────────────────────────────────────

function withTrace(d: W.WorkoutDraft, rule: string): W.WorkoutDraft {
  return { ...d, rule_trace: [...d.rule_trace, rule] };
}

function sumDraftKm(placed: readonly Placed[]): number {
  return placed.reduce((a, p) => a + p.draft.planned.run_m / 1000, 0);
}

/** Planned running km for a week; the race is excluded (§6.8 "excl. race"). */
function sumKm(workouts: readonly PlannedWorkout[]): number {
  return workouts.filter((w) => w.type !== "RACE").reduce((a, w) => a + w.planned.run_m / 1000, 0);
}

function round1(x: number): number {
  return Math.round(x * 10) / 10;
}
