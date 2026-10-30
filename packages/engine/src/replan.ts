/**
 * replan(state, events, today): adaptive replanning (spec §8) with FIT-UPDATE (§4.10).
 *
 * Pipeline (pure and deterministic; no clock, no randomness):
 *   1. Match activities to the plan (§3.9) and apply check-ins (sRPE, cross-training logs).
 *   2. FIT-UPDATE: races/TTs update VDOT at once; training evidence (R-PERF, HR–pace, CS cross-check)
 *      becomes proposals; accepted proposals are applied.
 *   3. Rules: R-ILL, R-PAIN, R-BREAK, R-MISS, R-HRV, R-LOAD (and R-RACE after a disruption).
 *   4. Rebuild (generatePlan through its public API) when a structural trigger fires: break ≥ 6 d,
 *      accepted realignment, a VDOT source upgrade (estimated/none → race/TT), or options.regenerate
 *      = "always". The rebuild uses actual history: current weekly km (median of the last 4 non-cutback
 *      weeks actually run), longest run in the last 30 days, current VDOT; race date unchanged.
 *      Days before `editableFrom` are never changed.
 *   5. Apply the rules' actions to the editable days, then the guards: V1 against ACTUAL history
 *      (R-LOAD-1) and the §7.1 constraints on the lived schedule.
 *
 * Each rebuild is keyed (e.g. "R-BREAK:2026-12-31:10") and recorded in plan.summary.notes as
 * "replan:<key>", so calling replan again the next day with the same history doesn't rebuild twice,
 * and every marker-tagged modification is a no-op the second time.
 */
import type { Activity } from "./activity.js";
import { criticalSpeedFromActivities, uthSanityCheck, vdotFromCriticalSpeed } from "./analysis.js";
import { addDays, daysBetween, toDayNumber } from "./dates.js";
import {
  acceptVdotProposal,
  fitnessUpdate,
  hrPaceEvidence,
  performanceEvidence,
  type PerformanceEvidence,
  type TtPiece,
} from "./fitness-update.js";
import { flattenSteps } from "./matching.js";
import { generatePlan } from "./plan.js";
import { isGeneralFitness, type Plan, type PlanRequest } from "./plan-types.js";
import { generalFitnessWeeks } from "./general-fitness.js";
import {
  applyActions,
  applyPaceScale,
  blockStart,
  Builder,
  clearPushWindow,
  enforceSchedule,
  enforceStrength,
  enforceV1Actual,
  enforceWeeklyGrowth,
  mergeRegenerated,
  PlanEditor,
  refreshPlan,
  repaceFuture,
  type PaceScale,
} from "./replan-apply.js";
import { buildRuleContext, currentPaces, illnessDates, weekContaining, type RuleContext } from "./replan-context.js";
import { currentWeeklyKmFromHistory, longestRun } from "./replan-history.js";
import type {
  CheckInEvent,
  FitnessChange,
  FitnessState,
  InputPatch,
  Proposal,
  RegenerateRequest,
  ReplanAction,
  ReplanChange,
  ReplanResult,
  ReplanState,
  RuleResult,
} from "./replan-types.js";
import { ruleBreak } from "./rules/break.js";
import { ruleHrv } from "./rules/hrv.js";
import { ruleIll } from "./rules/ill.js";
import { loadMetrics, ruleLoad } from "./rules/load.js";
import { ruleMiss } from "./rules/miss.js";
import { rulePain } from "./rules/pain.js";
import { perfVerdict, scoreSessions, sessionEvidence } from "./rules/perf.js";
import { ruleRace } from "./rules/race.js";

export const REPUSH_DAYS = 14;
/** CS fit quality needed before it can veto a raise (D). */
export const CS_MIN_R2 = 0.9;
const MARKER_PREFIX = "replan:";

function trusted(s: FitnessState["status"]): boolean {
  return s === "race" || s === "tt";
}

function clonePlan(p: Plan): Plan {
  return JSON.parse(JSON.stringify(p)) as Plan;
}

// ── evidence collection ──────────────────────────────────────────────────────────────────────────

const PERF_LOOKBACK_DAYS = 28;

function ttPiece(ctx: RuleContext, a: Activity): TtPiece | undefined {
  const planned = ctx.workouts.find((w) => w.date === a.date && w.type === "TT");
  if (!planned || !a.laps) return undefined;
  const flat = flattenSteps(planned.steps);
  if (flat.length !== a.laps.length) return undefined;
  const i = flat.findIndex((s) => s.kind === "work" && s.duration.type === "distance" && s.target.type === "open");
  const lap = a.laps[i];
  return i >= 0 && lap ? { distanceM: lap.distanceM, timeS: lap.durationS } : undefined;
}

function collectPerformances(ctx: RuleContext): PerformanceEvidence[] {
  const ill = illnessDates(ctx);
  const from = addDays(ctx.today, -PERF_LOOKBACK_DAYS);
  const out: PerformanceEvidence[] = [];
  for (const a of ctx.runs) {
    if (a.date < from) continue;
    const plannedTt = ctx.match.workouts.some((m) => m.type === "TT" && m.activityIds.includes(a.id) && (m.status === "completed" || m.status === "partial"));
    const kind = a.isRace ? "race" : a.isTimeTrial || plannedTt ? "tt" : undefined;
    if (!kind) continue;
    let sick = false;
    for (let d = addDays(a.date, -7); d <= a.date; d = addDays(d, 1)) if (ill.has(d)) sick = true;
    const opts: Parameters<typeof performanceEvidence>[2] = { illnessWithin7d: sick };
    if (ctx.fitness.vdot !== undefined) opts.currentVdot = ctx.fitness.vdot;
    const piece = kind === "tt" ? ttPiece(ctx, a) : undefined;
    if (piece) opts.ttPiece = piece;
    out.push(performanceEvidence(a, kind, opts));
  }
  return out;
}

// ── derived input for a rebuild ──────────────────────────────────────────────────────────────────

function currentLadderStage(ctx: RuleContext): number | undefined {
  const done = ctx.workouts.filter((w) => w.type === "RW" && w.date < ctx.editableFrom).at(-1);
  const t = done?.rule_trace.find((x) => x.startsWith("§6.9:stage"));
  return t ? Number(t.slice("§6.9:stage".length)) : undefined;
}

/**
 * The request for a rebuild: the original request (level, schedule, strength config, locked events,
 * goal) with history-derived volume, longest run and current fitness, starting at the current plan
 * week. Race date unchanged; a general-fitness plan keeps its end date.
 */
export function deriveInput(ctx: RuleContext, fitness: FitnessState, patches: readonly InputPatch[]): PlanRequest {
  const base = ctx.input;
  const anchor = weekContaining(ctx.plan, ctx.editableFrom)?.startDate ?? (ctx.isGeneralFitness ? ctx.editableFrom : blockStart(ctx.editableFrom, ctx.raceDate));
  const lr = longestRun(ctx.runs, ctx.editableFrom, 30);
  let currentWeeklyKm = Math.round(currentWeeklyKmFromHistory(ctx.plan, ctx.runs, ctx.editableFrom, base.currentWeeklyKm) * 10) / 10;
  let longestRun30d = lr.km > 0 || lr.minutes > 0 ? lr : base.longestRun30d;
  let vdot = fitness.vdot;
  let vdotStatus = fitness.status;
  let heavyCrossTraining = base.heavyCrossTraining;
  let stepBack = 0;
  for (const p of patches) {
    if (p.currentWeeklyKm !== undefined) currentWeeklyKm = p.currentWeeklyKm;
    if (p.longestRun30d !== undefined) longestRun30d = { km: Math.round(p.longestRun30d.km * 10) / 10, minutes: Math.round(p.longestRun30d.minutes) };
    if (p.vdot !== undefined) vdot = p.vdot;
    if (p.vdotStatus !== undefined) vdotStatus = p.vdotStatus;
    if (p.heavyCrossTraining !== undefined) heavyCrossTraining = p.heavyCrossTraining;
    if (p.ladderStepBack !== undefined) stepBack = Math.max(stepBack, p.ladderStepBack);
  }
  const { vdot: _v, vdotAnchorM: _a, ladderEntryStage: _l, ...rest } = base;
  const out = { ...rest, today: anchor, currentWeeklyKm, longestRun30d, vdotStatus, heavyCrossTraining } as PlanRequest;
  if (vdot !== undefined) out.vdot = vdot;
  const anchorM = fitness.anchorM ?? (fitness.vdot === base.vdot ? base.vdotAnchorM : undefined);
  if (anchorM !== undefined) out.vdotAnchorM = anchorM;
  if (base.ladderEntryStage !== undefined) out.ladderEntryStage = base.ladderEntryStage;
  const stage = currentLadderStage(ctx);
  if (ctx.isLadderPlan && stage !== undefined && !base.canRun20MinContinuous) out.ladderEntryStage = Math.max(1, stage - stepBack);
  if (isGeneralFitness(out)) {
    const end = addDays(ctx.raceDate, -1);
    const remaining = Math.max(1, Math.ceil((daysBetween(anchor, end) + 1) / 7));
    out.goal = { ...out.goal, weeks: Math.min(remaining, generalFitnessWeeks({ ...out.goal, weeks: remaining })) };
  }
  return out;
}

// ── main ─────────────────────────────────────────────────────────────────────────────────────────

export function replan(state: ReplanState, events: readonly CheckInEvent[], today: string): ReplanResult {
  const units = state.options?.units ?? "metric";
  const trace: string[] = [];
  const changes: ReplanChange[] = [];
  let fitness: FitnessState = { ...state.fitness, history: [...state.fitness.history] };
  let ctx = buildRuleContext(state, events, today, fitness);

  // ── 2. FIT-UPDATE ────────────────────────────────────────────────────────────────────────────
  const scores = scoreSessions(ctx);
  const verdict = perfVerdict(scores);
  trace.push(`R-PERF:${verdict.verdict}(${verdict.used.length})`);
  const qualityIds = new Set(ctx.match.workouts.filter((m) => ["T", "I", "R", "H", "TT", "RACE"].includes(m.type)).flatMap((m) => m.activityIds));
  const cs = criticalSpeedFromActivities(ctx.activities, today, ctx.level, (a) => a.isRace || a.isTimeTrial === true || qualityIds.has(a.id));
  // Cross-check only with a good fit (§4.5 "not a driver").
  const csVdot = cs.status === "ok" && cs.r2 >= CS_MIN_R2 ? vdotFromCriticalSpeed(cs.csMps) : undefined;
  const lastIll = ctx.illness.filter((e) => e.resolvedDate !== undefined && e.resolvedDate <= today).at(-1);
  const hrIgnore = [ctx.brk ? addDays(ctx.brk.returnDate, 7) : undefined, lastIll?.resolvedDate ? addDays(lastIll.resolvedDate, 7) : undefined]
    .filter((x): x is string => x !== undefined)
    .sort()
    .at(-1);
  const fuInput: Parameters<typeof fitnessUpdate>[0] = {
    fitness,
    today,
    level: ctx.level,
    raceDate: ctx.raceDate,
    performances: collectPerformances(ctx),
    training: [...sessionEvidence(scores), ...hrPaceEvidence(ctx.runs, fitness, today)],
    perf: verdict.verdict,
  };
  if (csVdot !== undefined) fuInput.csVdot = csVdot;
  if (hrIgnore !== undefined) fuInput.hrIgnoreUntil = hrIgnore;
  if (fitness.hrMax !== undefined && fitness.hrRest !== undefined && fitness.vdot !== undefined) {
    fuInput.uth = uthSanityCheck(fitness.vdot, fitness.hrMax, fitness.hrRest, fitness.hrMaxSource ?? "age_formula");
  }
  const fu = fitnessUpdate(fuInput);
  fitness = fu.fitness;
  changes.push(...fu.changes);
  trace.push(...fu.trace);
  const proposals: Proposal[] = [];
  for (const p of fu.proposals) {
    if (ctx.declined.has(p.id)) continue;
    if (p.kind === "vdot_change" && ctx.accepted.has(p.id)) {
      const acc = acceptVdotProposal(fitness, p, today);
      fitness = acc.fitness;
      changes.push({ rule: p.rule, message: `Paces updated: VDOT ${p.fromVdot.toFixed(1)} → ${p.toVdot.toFixed(1)}, from today.` });
      trace.push(`FIT-UPDATE:accepted(${p.id})`);
      continue;
    }
    proposals.push(p);
  }
  const vdotChanged = fitness.vdot !== state.fitness.vdot || fitness.status !== state.fitness.status;
  if (vdotChanged) ctx = buildRuleContext(state, events, today, fitness);

  // ── 3. rules ─────────────────────────────────────────────────────────────────────────────────
  const results: RuleResult[] = [ruleIll(ctx), rulePain(ctx), ruleBreak(ctx, units), ruleMiss(ctx), ruleHrv(ctx), ruleLoad(ctx)];
  const halt = results.find((r) => r.halt)?.halt;

  // ── 4. rebuild? ──────────────────────────────────────────────────────────────────────────────
  const requests: RegenerateRequest[] = results.flatMap((r) => (r.regenerate ? [r.regenerate] : []));
  if (vdotChanged && !trusted(state.fitness.status) && trusted(fitness.status)) {
    const src = fitness.history.at(-1)?.source ?? today;
    requests.push({ rule: "FIT-UPDATE", key: `FIT-UPDATE:${src}`, reason: "first trusted VDOT: switch to pace targets", patch: {} });
  }
  if (state.options?.regenerate === "always") requests.push({ rule: "REPLAN", key: `always:${today}`, reason: "requested", patch: {} });
  const done = new Set(state.plan.summary.notes.filter((n) => n.startsWith(MARKER_PREFIX)).map((n) => n.slice(MARKER_PREFIX.length)));
  const pending = requests.filter((r) => !done.has(r.key));
  const patches = [...results.flatMap((r) => (r.inputPatch ? [r.inputPatch] : [])), ...pending.map((r) => r.patch)];

  let plan = clonePlan(state.plan);
  let regenerated = false;
  let derivedInput: PlanRequest | undefined;
  const notes = [...state.plan.summary.notes];
  const canRebuild = !halt && pending.length > 0 && ctx.editableFrom < ctx.raceDate;
  const derived = deriveInput(ctx, fitness, patches);
  if (canRebuild) {
    // R-BREAK > 28 d: the stale VDOT becomes an estimate, and the rebuild schedules a re-test.
    const reset = pending.find((r) => r.patch.vdotStatus === "estimated" && r.patch.vdot !== undefined);
    if (reset && fitness.vdot !== undefined && reset.patch.vdot !== undefined) {
      const c: FitnessChange = { date: today, fromVdot: fitness.vdot, toVdot: reset.patch.vdot, status: "estimated", rule: reset.rule, source: reset.key, reason: reset.reason };
      fitness = { ...fitness, vdot: reset.patch.vdot, status: "estimated", history: [...fitness.history, c] };
    }
    const fresh = generatePlan(derived);
    if (fresh.weeks.length > 0) {
      plan = mergeRegenerated(plan, fresh, ctx.editableFrom);
      regenerated = true;
      derivedInput = derived;
      notes.splice(0, notes.length, ...fresh.summary.notes, ...state.plan.summary.notes.filter((n) => n.startsWith(MARKER_PREFIX)));
      for (const r of pending) {
        notes.push(`${MARKER_PREFIX}${r.key}`);
        trace.push(`REPLAN:rebuild(${r.rule}:${r.reason})`);
      }
      // A rebuild seeded with a patched longest run (no actual run in the window, e.g. > 28 days off)
      // uses it as generatePlan does: dated the day before (D, §6.5 "no history → entered run").
      if (pending.some((r) => r.patch.longestRun30d !== undefined)) {
        ctx.v1Seed = { day: toDayNumber(ctx.editableFrom) - 1, km: derived.longestRun30d.km, minutes: derived.longestRun30d.minutes };
      }
      changes.push({ rule: "REPLAN", message: `Rebuilt your plan from ${ctx.editableFrom} to race day (${fresh.summary.weeks} weeks, taper kept at ${fresh.summary.taperWeeks} week(s)).` });
      trace.push(`R-RACE-1:taper_kept(${fresh.summary.taperWeeks}wk)`);
    } else {
      trace.push("REPLAN:rebuild_skipped(no_weeks)");
    }
  }

  // ── R-RACE after a disruption ──────────────────────────────────────────────────────────────
  const illInWindow = [...illnessDates(ctx)].some((d) => d >= addDays(ctx.raceDate, -56));
  const disruption = ctx.brk ? `${ctx.brk.returnDate}` : illInWindow ? `ill:${ctx.illness.at(-1)?.date ?? today}` : pending.find((r) => r.rule === "R-MISS-4")?.key;
  if (disruption !== undefined && !halt && !ctx.isGeneralFitness && !isGeneralFitness(derived)) {
    const race = ruleRace(ctx, { derived, taperWeeks: plan.summary.taperWeeks, disruptionKey: disruption });
    results.push(race);
  }

  // ── 5. apply ─────────────────────────────────────────────────────────────────────────────────
  const builder = new Builder(ctx.raceInput, fitness);
  const ed = new PlanEditor(plan, ctx, builder, units);
  if (regenerated) {
    const cur = ed.weekOf(ctx.editableFrom);
    if (cur) ed.touched.set(cur.index, new Set(["REPLAN"]));
  }
  const actions: ReplanAction[] = [];
  if (halt) {
    clearPushWindow(ed, halt.rule);
    changes.push(...results.flatMap((r) => (r.halt ? r.changes : [])));
    trace.push(`HALT:${halt.rule}(${halt.reason})`);
  } else {
    if (vdotChanged && !regenerated && state.fitness.vdot !== undefined && fitness.vdot !== undefined) {
      const oldP = currentPaces(ctx.raceInput, state.fitness.vdot, state.fitness.status);
      const newP = currentPaces(ctx.raceInput, fitness.vdot, fitness.status);
      repaceFuture(ed, oldP, newP, `FIT-UPDATE:vdot(${state.fitness.vdot.toFixed(1)}->${fitness.vdot.toFixed(1)})`);
    }
    for (const r of results) {
      const acts = regenerated ? r.actions.filter((a) => !(a.kind === "move" && a.rule.startsWith("R-MISS"))) : r.actions;
      actions.push(...acts);
      changes.push(...r.changes);
      trace.push(...r.trace);
      proposals.push(...r.proposals.filter((p) => !ctx.declined.has(p.id)));
    }
    const scale = actions.find((a): a is Extract<ReplanAction, { kind: "scale_paces" }> => a.kind === "scale_paces");
    if (scale) {
      const s: PaceScale = { from: scale.from, factor: scale.factor, rule: scale.rule };
      builder.scale = s;
      applyPaceScale(ed, s);
    }
    applyActions(ed, actions, plan);
    // Guards to a fixed point: V2 / §7.1 trims can lower a later run's V1 reference (they only shrink).
    for (let i = 0; i < 4; i++) {
      const before = JSON.stringify(ed.weeks);
      enforceV1Actual(ed);
      enforceWeeklyGrowth(ed);
      enforceSchedule(ed);
      if (JSON.stringify(ed.weeks) === before) break;
    }
    enforceStrength(ed);
    changes.push(...ed.log.changes);
  }

  const out = refreshPlan(plan, ed.weeks, ed.touched, notes);
  const metrics = loadMetrics(ctx);
  if (ctx.brk) {
    metrics.breakDays = ctx.brk.daysOff;
    metrics.breakMultiplier = Math.round(ctx.brk.multiplier * 1000) / 1000;
  }
  const result: ReplanResult = {
    plan: out,
    fitness,
    changes,
    proposals: dedupe(proposals),
    actions,
    regenerated,
    matching: ctx.match,
    metrics,
    repush: { from: ctx.editableFrom, to: addDays(ctx.editableFrom, REPUSH_DAYS - 1) },
    trace,
  };
  if (halt) result.halted = halt;
  if (derivedInput) result.derivedInput = derivedInput;
  return result;
}

function dedupe(ps: readonly Proposal[]): Proposal[] {
  const seen = new Set<string>();
  return ps.filter((p) => (seen.has(p.id) ? false : (seen.add(p.id), true)));
}
