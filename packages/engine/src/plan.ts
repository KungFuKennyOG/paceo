/**
 * Plan generator (spec §6) and its weekly assembly (§7).
 *
 * generatePlan is a pure function of its input: no clock, no randomness, no I/O.
 * Pipeline: feasibility (§6.2) → shape (phases §6.3, ladder §6.9, cutbacks §6.7, volume §6.5,
 * taper §6.8) → per week: quality choice (§6.4, P3) → placement (§7.1) → long run (§6.6) →
 * workouts (§6.10) → easy spreading (S3) → V1 on every run (§6.5).
 *
 * TODO(§6.1): general-fitness mode (BASE weeks currently run as E + strides + easy LR).
 * TODO(§8): replanning; the TT result should trigger a replan into pace mode.
 * TODO(§9): strength placement. TODO(§10): locked cross-training. TODO(§4.8): heat; HR targets beyond the DSL fallback.
 */
import type { PlannedWorkout } from "./workout.js";
import type { Phase, Plan, PlanInput, PlanSummary, PlanWeek, VolumeFlag } from "./plan-types.js";
import { planCalendar, fromDayNumber, toDayNumber, type PlanCalendar } from "./dates.js";
import { formatDuration } from "./units.js";
import { checkFeasibility, levelBlocked, predictedGoalTimeS } from "./feasibility.js";
import { easyMaxKm, effectiveRunDays, planShape, slotMaxKm, type PlanShape, type WeekKind } from "./plan-shape.js";
import { midPace, prescriptionFor, type Prescription } from "./prescription.js";
import {
  longRunMayBeQuality,
  phaseEmphasis,
  qualityAllowance,
  qualityBudget,
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
} from "./volume.js";
import { lastHardSessionDays, TAPER_QUALITY_WORK_FRACTION, taperLongRunFraction } from "./taper.js";
import {
  EASY_MIN_MINUTES,
  EASY_MIN_MINUTES_BEGINNER,
  placeWeek,
  spreadEasy,
  weekTemplate,
  type EasySlot,
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

/**
 * L2: the peak long run falls 3–5 weeks before the race. A build-week long run less than 21 days
 * before the race is held to 85% of the peak so far (D); taper long runs follow T3.
 */
const PEAK_LR_MIN_DAYS_OUT = 21;
const PRE_TAPER_LR_FRACTION = 0.85;
/** Strides at most twice a week (§6.10). */
const MAX_STRIDE_SESSIONS = 2;

interface Env {
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
  /** Caps that pushed planned km away from the target this week (rule IDs, for VolumeFlag). */
  caps: Set<string>;
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

export function generatePlan(input: PlanInput): Plan {
  const feasibility = checkFeasibility(input);
  const cal = planCalendar(input.today, input.raceDate, input.longRunDay);
  if (cal.weeks < 2 || levelBlocked(input.level, input.goal.distance)) {
    return { feasibility, weeks: [], summary: emptySummary(input, cal, feasibility.status) };
  }
  const env = makeEnv(effectiveInput(input, feasibility), cal);
  const st: State = {
    history: [],
    keyDays: [],
    exposures: new Map(),
    lrEligibleWeeks: 0,
    lrLevelKm: input.longestRun30d.km,
    peakLrKm: 0,
    prevPlannedKm: 0,
  };
  const weeks: PlanWeek[] = [];
  for (let w = 1; w <= cal.weeks; w++) weeks.push(planWeek(env, st, w));
  return { feasibility, weeks, summary: summarize(env, weeks, feasibility.status, input) };
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

function makeEnv(input: PlanInput, cal: PlanCalendar): Env {
  const shape = planShape(input, cal.weeks);
  const runDays = effectiveRunDays(input.level, input.runDays);
  const rx = prescriptionFor(input.level, input.vdotStatus, shape.paces);
  return {
    input,
    userId: input.userId ?? "me",
    cal,
    shape,
    rx,
    allow: qualityAllowance(input.level, runDays, input.monthsRunning),
    budget: qualityBudget(input.lockedEvents),
    runDays,
    timeMode: rx.longBy === "time",
    // The entered longest run is "within the last 30 days"; we date it yesterday (D).
    seed: { day: toDayNumber(input.today) - 1, km: input.longestRun30d.km, minutes: input.longestRun30d.minutes },
  };
}

// ── one week ─────────────────────────────────────────────────────────────────────────────────────

function weekInfo(env: Env, w: number): WeekInfo {
  const byWeek = env.shape.phases.byWeek;
  const phase = byWeek[w - 1] as Phase;
  const first = byWeek.indexOf(phase);
  return {
    w,
    kind: env.shape.kinds[w - 1] as WeekKind,
    phase,
    targetKm: env.shape.targets[w - 1] as number,
    startDay: env.cal.startDay + 7 * (w - 1),
    weeksOut: env.cal.weeks - w + 1,
    isRace: w === env.cal.weeks,
    phaseIdx: w - 1 - first,
    phaseLen: byWeek.filter((p) => p === phase).length,
    caps: new Set(),
  };
}

function planWeek(env: Env, st: State, w: number): PlanWeek {
  const info = capToPreviousWeek(weekInfo(env, w), st, env.shape.kinds[w - 2] === "ladder");
  const notes: string[] = [];
  const placed = info.kind === "ladder" ? ladderWeek(env, st, info, notes) : runWeek(env, st, info, notes);
  placed.sort((a, b) => a.offset - b.offset);

  const workouts: PlannedWorkout[] = placed.map(({ offset, draft }) => {
    const date = fromDayNumber(info.startDay + offset);
    return { id: `${env.userId}-w${String(w).padStart(2, "0")}-${date}`, user_id: env.userId, date, ...draft };
  });
  for (const [i, wk] of workouts.entries()) {
    const day = info.startDay + (placed[i] as Placed).offset;
    if (wk.flags.key_session) st.keyDays.push(day);
    if (wk.type !== "RACE") st.history.push({ day, ...v1Measure(wk) });
  }

  const lr = workouts.find((x) => x.type === "L");
  const plannedKm = sumKm(workouts);
  st.prevPlannedKm = plannedKm;
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
  if (info.kind === "ladder" || prevWasLadder || st.prevPlannedKm <= 0) return info;
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
  return weekTemplate(env.runDays, { ladder: true, lrOffset: env.cal.lrOffset }).map((slot) => {
    const day = info.startDay + slot.offset;
    // Run/walk V1 is by total duration only (§6.5), so the time limit applies even in pace mode.
    const { ref } = v1At(env, st, day, sameWeek);
    const maxMin = V1_FACTOR * ref.minutes;
    const fit = fitLadderStage(planned, maxMin);
    if (fit.stage !== planned) notes.push(`V1: stage ${planned} is too long yet; repeating stage ${fit.stage}.`);
    const trace = ["C1:ladder_no_cutback", `V1:ok(${fit.minutes.toFixed(0)}min<=${maxMin.toFixed(0)}min)`];
    if (fit.walkS < LADDER_WALK_WARMUP_S) trace.push("V1:short_walk_warmup");
    sameWeek.push({ day, minutes: fit.minutes });
    return { offset: slot.offset, draft: W.ladderSession(ctx, fit.stage, trace, fit.walkS) };
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
  const slots = weekTemplate(env.runDays, {
    noConsecutiveDays: input.level === "beginner" && info.w <= 4,
    lrOffset: env.cal.lrOffset,
  });
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
  });
  notes.push(...placement.trace);

  const placed: Placed[] = [];
  let lrKm = 0;
  let lrDraft: W.WorkoutDraft | undefined;
  if (placement.lrOffset !== undefined) {
    lrDraft = buildLongRun(env, st, info, ctx, lrQuality, placement.lrOffset);
    lrKm = lrDraft.planned.run_m / 1000;
  }

  // No other run outranks the week's long run, except in taper and TT weeks (D).
  const lrRules = lrKm > 0 && info.kind !== "taper" && info.kind !== "tt";
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
  return enforceV1InDateOrder(env, st, info, ctx, placed);
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
      const { limit } = v1At(env, st, day, sameWeek);
      const km = draft.planned.run_m / 1000;
      if (!v1Ok(km, draft.planned.minutes, limit, draft.type === "RW")) {
        draft = shrinkToLimit(ctx, draft, limit);
        info.caps.add("V1:cap");
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
  if (info.isRace && env.cal.raceOffset < lastHardSessionDays(input.goal.distance).min) return [];

  let n = weeklyQualityCount(env.allow, lrQuality, env.budget);
  if (info.kind === "cutback" || info.kind === "taper") n = Math.min(1, n);
  const emph = phaseEmphasis(input.goal.distance, info.phase, info.phaseIdx, info.phaseLen);
  if (n === 0 || !emph) return [];

  const kinds: QualityKind[] = info.kind === "taper" ? ["GP"] : n >= 2 ? [...emph.pair] : [emph.single];
  const dist = { "5k": "5K", "10k": "10K", half: "HM", marathon: "M" }[input.goal.distance];
  return kinds.map((k, i) => {
    const sub = substituteQuality(k, input.level, input.vdotStatus, info.phase);
    const trace = [`P3:${info.phase}:${dist}:${sub.kind}`, `${env.allow.rule}:Q${i + 1}`];
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
  const capped = withLrCap(limit, lrCapKm);
  const fitted = W.fitWarmCool(ctx, draft, capped.km, capped.minutes);
  if (fitted !== draft) info.caps.add(capped === limit ? "V1:cap" : "LR:longest_run_of_week");
  if (fitted) return withTrace(fitted, v1Trace(fitted.planned.run_m / 1000, limit));
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
    if (daysToRace < PEAK_LR_MIN_DAYS_OUT && st.peakLrKm > 0) {
      options.push([PRE_TAPER_LR_FRACTION * st.peakLrKm, "L2:peak_3-5wk_out"]);
    }
  }
  const [raw, rule] = options.reduce((a, b) => (b[0] < a[0] ? b : a));
  const km = floorKm(Math.max(0, raw));
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
  slots: readonly EasySlot[],
  budgetKm: number,
  lrKm: number,
  lrCapKm: number,
  notes: string[],
): Placed[] {
  const minMin = env.input.level === "beginner" ? EASY_MIN_MINUTES_BEGINNER : EASY_MIN_MINUTES;
  const minKm = W.easyKmForMinutes(ctx.paces, minMin);
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
  const spread = spreadEasy(
    budgetKm - strideSessions * perStrideKm,
    slots,
    minKm,
    Math.min(maxKm, lrCapKm),
    slotMaxKm(ctx.paces),
  );
  if (spread.unplacedKm > 0.5) {
    notes.push(`S3: ${spread.unplacedKm.toFixed(1)} km of easy volume doesn't fit; more run days would help.`);
    info.caps.add("S3:easy_capacity");
  }
  if (spread.trace.includes("S3:raised_to_min")) info.caps.add("S3:easy_min_length");
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
    const draft = fitEasy(ctx, km, opts, withLrCap(limit, lrCapKm));
    const wanted = km + W.stridesKm(ctx, opts.strides ?? 0);
    if (draft.planned.run_m / 1000 < wanted - 0.3) info.caps.add(km > limit.km ? "V1:cap" : "LR:longest_run_of_week");
    out.push({ offset: slot.offset, draft });
  });
  return out;
}

/** Day before the race: a short easy run with 4 strides (§6.8 T3 "strides and goal-pace touches"). */
function shakeout(env: Env, st: State, info: WeekInfo, ctx: W.BuildContext, offset: number): W.WorkoutDraft {
  const minutes = env.input.level === "beginner" ? EASY_MIN_MINUTES_BEGINNER : EASY_MIN_MINUTES;
  const km = W.easyKmForMinutes(ctx.paces, minutes);
  const { limit } = v1At(env, st, info.startDay + offset);
  return fitEasy(ctx, km, { shakeout: true, strides: 4, trace: ["T3:shakeout"] }, limit);
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
  if (shape.ttWeek !== undefined) notes.push(`Week ${shape.ttWeek}: 3K time trial; replan into pace mode with the result (§4.2, §8).`);
  if (input.lockedEvents?.length) notes.push("Locked cross-training isn't scheduled yet (§10 TODO); only hard sessions reduce the key-session budget.");
  return {
    weeks: weeks.length,
    leadInDays: cal.leadInDays,
    startDate: fromDayNumber(cal.startDay),
    raceDate: input.raceDate,
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

function emptySummary(input: PlanInput, cal: PlanCalendar, status: string): PlanSummary {
  return {
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
    notes: [`feasibility:${status}`, "No plan generated: see feasibility."],
  };
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
