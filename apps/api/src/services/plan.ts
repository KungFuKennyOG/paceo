/**
 * Plan preview / generate / materialize (spec §6, §3.2 push strategy) and adaptive replanning (§8).
 * Nightly, check-in and proposal replans run the engine's replan() on the stored plan, activities
 * (with laps/samples), check-ins and fitness: in-place changes revise the active plan row; a
 * structural rebuild supersedes it.
 *
 * Proposals (§8 vdot_change / goal_change / realign): every replan stores the engine's pending
 * proposals (one row per engine id; ids it no longer emits expire). The user answers with
 * respondToProposal, which replans at once with a proposal_response event. Declined ids are sent
 * on every later replan; an acceptance is sent once, on the replan that applies it, because a
 * re-sent "accept" could apply the same VDOT step again if the engine re-emitted the same id.
 */
import {
  addDays,
  generatePlan,
  HEAVY_CROSS_TRAINING_SHARE,
  replan,
  weeklyLoad,
  type Activity,
  type CheckInEvent,
  type FitnessState,
  type Plan,
  type PlannedWorkout,
  type PlanRequest,
  type Proposal as EngineProposal,
  type ProposalResponseEvent,
} from "@paceo/engine";
import type { PlanResponse, PlanPreviewResponse, Profile, Proposal, ProposalDecisionResponse, ScreeningOutcome } from "@paceo/contracts";
import { Profile as ProfileSchema } from "@paceo/contracts";
import {
  activitiesRepo,
  checkinsRepo,
  fitnessRepo,
  plansRepo,
  profileRepo,
  proposalsRepo,
  screeningRepo,
  workoutsRepo,
  type PlanRow,
  type PlannedWorkoutInsert,
  type ProposalRow,
} from "../repo/index.js";
import { toEngineActivity, toEngineEvents, toFitnessState, type CheckinLike } from "../plan/replan-state.js";
import { AppError } from "../http/errors.js";
import { sha256Hex } from "../crypto/tokens.js";
import { localDate } from "../lib/time.js";
import { mapProfileToPlanInput, pacesFor, type MappedProfile } from "../plan/map-profile.js";
import { screeningExpired } from "../plan/screening.js";
import { JOB } from "../jobs/queue.js";
import { backfillStreams, loadStreams } from "./streams.js";
import type { Services } from "./context.js";

export const EMPTY_SINK = {
  provider: null,
  externalId: null,
  eventId: null,
  lastPushedAt: null,
  status: "not_pushed",
} as const;

export interface BuiltPlan {
  mapped: MappedProfile;
  plan: Plan;
  paces: Record<string, unknown>;
}

/** Mean cross-training share of total load over the first 4 planned weeks (§6.7 C1 proxy). */
export function plannedCrossTrainingShare(plan: Plan): number {
  const weeks = plan.weeks.slice(0, 4);
  if (weeks.length === 0) return 0;
  return weeks.reduce((a, w) => a + weeklyLoad(w).crossTrainingShare, 0) / weeks.length;
}

/** Runs the engine for a profile. Pure apart from reading "today" from the clock. */
export function buildPlan(profile: Profile, ctx: { userId: string; today: string; screening: ScreeningOutcome | null }): BuiltPlan {
  const mapped = mapProfileToPlanInput(profile, ctx);
  let plan = generatePlan(mapped.input);
  // §6.7 C1: until there is logged history, judge "heavy cross-training" from the planned weeks
  // and re-run with 2:1 cutbacks when cross-training is above 40% of total load.
  // TODO(history): use the last 4 logged weeks once session_log/activities feed the load model.
  if (!mapped.input.heavyCrossTraining && plannedCrossTrainingShare(plan) > HEAVY_CROSS_TRAINING_SHARE) {
    mapped.input = { ...mapped.input, heavyCrossTraining: true };
    plan = generatePlan(mapped.input);
  }
  if (mapped.notes.length > 0) plan.summary.notes = [...mapped.notes, ...plan.summary.notes];
  return { mapped, plan, paces: pacesFor(mapped.input) };
}

function planJson(plan: Plan): PlanPreviewResponse["plan"] {
  // Round-trip so the stored/returned value is plain JSON.
  return JSON.parse(JSON.stringify(plan)) as PlanPreviewResponse["plan"];
}

export async function loadProfile(svc: Services, userId: string): Promise<Profile | null> {
  const row = await profileRepo.get(svc.db, userId);
  if (!row) return null;
  const parsed = ProfileSchema.safeParse(row.profile);
  return parsed.success ? parsed.data : null;
}

export async function screeningOutcome(svc: Services, userId: string): Promise<{ outcome: ScreeningOutcome | null; canProceed: boolean }> {
  const s = await screeningRepo.get(svc.db, userId);
  if (!s) return { outcome: null, canProceed: false };
  const expired = screeningExpired(s.screenedAt, svc.clock());
  return { outcome: s.outcome as ScreeningOutcome, canProceed: s.canProceed && !expired };
}

export async function previewPlan(svc: Services, userId: string, profile: Profile): Promise<PlanPreviewResponse> {
  const { outcome } = await screeningOutcome(svc, userId);
  const built = buildPlan(profile, { userId, today: localDate(svc.clock(), profile.timezone), screening: outcome });
  return { plan: planJson(built.plan), paces: built.paces };
}

export function toPlanResponse(row: PlanRow): PlanResponse {
  return {
    planId: row.id,
    generatedAt: row.createdAt.toISOString(),
    plan: row.plan as PlanResponse["plan"],
    paces: row.paces as PlanResponse["paces"],
  };
}

export function contentHash(w: PlannedWorkout): string {
  const { id: _id, user_id: _u, rule_trace: _t, ...content } = w;
  return sha256Hex(JSON.stringify(content));
}

/**
 * Replace the user's planned workouts from `fromDate` on with the plan's, keeping rows whose content
 * did not change (same id, rev, sink state and skip status) so external ids stay stable. Rows that
 * disappear are marked removed; the push job deletes their remote events and then the rows.
 */
export async function materialize(
  svc: Services,
  userId: string,
  planId: string,
  workouts: PlannedWorkout[],
  fromDate: string,
): Promise<{ kept: number; added: number; removed: number }> {
  return svc.db.transaction(async (tx) => {
    const existing = await workoutsRepo.fromDate(tx, userId, fromDate);
    const byKey = new Map<string, (typeof existing)[number][]>();
    for (const r of existing) {
      const k = `${r.date}|${r.contentHash}`;
      byKey.set(k, [...(byKey.get(k) ?? []), r]);
    }
    const keep = new Map<string, unknown>();
    const inserts: PlannedWorkoutInsert[] = [];
    for (const w of workouts.filter((x) => x.date >= fromDate)) {
      const hash = contentHash(w);
      const bucket = byKey.get(`${w.date}|${hash}`);
      const match = bucket?.shift();
      if (match) {
        keep.set(match.id, w);
        continue;
      }
      inserts.push({
        planId,
        engineId: w.id,
        date: w.date,
        sport: w.sport,
        type: w.type,
        contentHash: hash,
        workout: w,
        status: "planned",
        skipReason: null,
        ruleTrace: w.rule_trace,
        sinkState: EMPTY_SINK,
        rev: 0,
        deviceText: null,
        removedAt: null,
      });
    }
    const removed = existing.filter((r) => !keep.has(r.id)).map((r) => r.id);
    await workoutsRepo.reassignPlan(tx, userId, [...keep.keys()], planId, keep);
    await workoutsRepo.markRemoved(tx, userId, removed);
    await workoutsRepo.insertMany(tx, userId, inserts);
    return { kept: keep.size, added: inserts.length, removed: removed.length };
  });
}

/** True when the stored workouts from `today` on have exactly the new plan's content. */
async function sameWorkouts(svc: Services, userId: string, workouts: PlannedWorkout[], today: string): Promise<boolean> {
  const existing = await workoutsRepo.fromDate(svc.db, userId, today);
  const a = existing.map((r) => `${r.date}|${r.contentHash}`).sort();
  const b = workouts.filter((w) => w.date >= today).map((w) => `${w.date}|${contentHash(w)}`).sort();
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

export async function generateAndStore(
  svc: Services,
  userId: string,
  reason: "generate" | "replan_nightly" | "profile_change",
): Promise<{ row: PlanRow; changes: { kept: number; added: number; removed: number } }> {
  const profile = await loadProfile(svc, userId);
  if (!profile) throw new AppError(409, "profile_required", "Fill in your profile first.");
  const screening = await screeningOutcome(svc, userId);
  if (!screening.canProceed) {
    throw new AppError(403, "screening_required", "Complete the health screen (or confirm clearance) before generating a plan.");
  }
  const today = localDate(svc.clock(), profile.timezone);
  const built = buildPlan(profile, { userId, today, screening: screening.outcome });
  if (built.plan.feasibility.status === "block" || built.plan.weeks.length === 0) {
    throw new AppError(422, "plan_infeasible", "This goal can't be planned safely as entered. See the alternatives.", {
      feasibility: built.plan.feasibility,
    });
  }
  const workouts = built.plan.weeks.flatMap((w) => w.workouts);
  if (reason === "replan_nightly") {
    const current = await plansRepo.current(svc.db, userId);
    if (current && (await sameWorkouts(svc, userId, workouts, today))) {
      return { row: current, changes: { kept: workouts.length, added: 0, removed: 0 } };
    }
  }
  const row = await plansRepo.insertActive(svc.db, userId, {
    input: built.mapped.input,
    plan: planJson(built.plan),
    paces: built.paces,
    reason,
  });
  const changes = await materialize(svc, userId, row.id, workouts, today);
  await fitnessRepo.upsert(svc.db, userId, {
    vdot: built.mapped.vdot.value,
    vdotSource: built.mapped.vdot.status,
    vdotDate: built.mapped.vdot.date,
  });
  // Push the next 14 days after any plan change (§3.2).
  if (changes.added > 0 || changes.removed > 0 || reason === "generate") {
    await svc.jobs.enqueue(JOB.pushWorkouts, { userId }, { singletonKey: `push:${userId}`, singletonSeconds: 30 });
  }
  return { row, changes };
}

/** History the replanner reads (§6.1 derived inputs use up to 16 weeks for CS; 120 days covers it). */
export const REPLAN_HISTORY_DAYS = 120;
export const REPLAN_CHECKIN_DAYS = 60;

export interface ReplanOutcome {
  status: "replanned" | "unchanged" | "skipped";
  /** User-facing sentences for applied changes. */
  changes: string[];
  /** Proposals waiting for the user (e.g. a VDOT change), as messages; also stored (proposals table). */
  proposals: string[];
  halted: boolean;
}

const SKIPPED: ReplanOutcome = { status: "skipped", changes: [], proposals: [], halted: false };

export type ReplanReason = "replan_nightly" | "replan_checkin" | "replan_proposal";

function withFitness(input: PlanRequest, f: FitnessState): PlanRequest {
  const out = { ...input, vdotStatus: f.status } as PlanRequest;
  if (f.vdot !== undefined) out.vdot = f.vdot;
  return out;
}

/** Everything replan() needs for one user, from the stored rows. */
export interface ReplanInputs {
  current: PlanRow;
  profile: Profile;
  plan: Plan;
  input: PlanRequest;
  fitness: FitnessState;
  activities: Activity[];
  events: CheckInEvent[];
  today: string;
}

export interface ReplanLoadOptions {
  extra?: CheckinLike[];
  response?: { proposalId: string; accept: boolean };
}

/**
 * Stored rows → replan inputs. `extra` check-ins count as already stored; `response` is the
 * proposal answer being applied now. Null when there is nothing to replan.
 */
export async function loadReplanInputs(svc: Services, userId: string, opts: ReplanLoadOptions = {}): Promise<ReplanInputs | null> {
  const current = await plansRepo.current(svc.db, userId);
  if (!current) return null;
  const profile = await loadProfile(svc, userId);
  if (!profile) return null;
  const plan = current.plan as Plan;
  const input = current.input as PlanRequest;
  const first = plan.weeks[0];
  if (!first) return null;
  const today = localDate(svc.clock(), profile.timezone);
  const end = plan.summary.endDate ?? plan.summary.raceDate;
  if (end < today) return null;

  const rows = await activitiesRepo.list(svc.db, userId, addDays(today, -REPLAN_HISTORY_DAYS), today);
  const streams = await loadStreams(svc, userId, rows.filter((r) => r.sport === "run").map((r) => r.id));
  const activities = rows.map((r) => toEngineActivity(r, streams.get(r.id)));
  const checkins: CheckinLike[] = [...(await checkinsRepo.range(svc.db, userId, addDays(today, -REPLAN_CHECKIN_DAYS), today)), ...(opts.extra ?? [])];
  const workoutRows = await workoutsRepo.range(svc.db, userId, first.startDate, end);
  const fitness = toFitnessState(
    await fitnessRepo.get(svc.db, userId),
    input.vdot !== undefined ? { vdot: input.vdot, vdotStatus: input.vdotStatus } : { vdotStatus: input.vdotStatus },
    { hrMax: profile.hrMax, hrRest: profile.hrRest },
  );
  const runOn = (d: string) => activities.find((a) => a.date === d && a.sport === "run")?.id;
  const events = toEngineEvents(checkins, workoutRows, today, runOn);
  events.push(...(await proposalEvents(svc, userId, profile.timezone, today, opts.response)));
  return { current, profile, plan, input, fitness, activities, events, today };
}

/** Declined proposals (always) plus the answer being applied now (see module note). */
async function proposalEvents(
  svc: Services,
  userId: string,
  timezone: string,
  today: string,
  response: { proposalId: string; accept: boolean } | undefined,
): Promise<ProposalResponseEvent[]> {
  const out: ProposalResponseEvent[] = [];
  for (const r of await proposalsRepo.list(svc.db, userId, "declined")) {
    if (r.id === response?.proposalId) continue;
    const answered = r.respondedAt ? localDate(r.respondedAt, timezone) : today;
    out.push({ type: "proposal_response", date: answered < today ? answered : today, proposalId: r.id, accept: false });
  }
  if (response) out.push({ type: "proposal_response", date: today, proposalId: response.proposalId, accept: response.accept });
  return out;
}

/**
 * Store the engine's current proposals: new ids are inserted as pending, re-emitted pending or
 * expired ones are refreshed (and pending again), answered ones are left alone, and pending ones the
 * engine no longer emits expire (superseded).
 */
export async function storeProposals(svc: Services, userId: string, proposals: readonly EngineProposal[]): Promise<void> {
  const existing = new Map((await proposalsRepo.list(svc.db, userId)).map((r) => [r.id, r]));
  const seen = new Set<string>();
  for (const p of proposals) {
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    const payload = JSON.parse(JSON.stringify(p)) as unknown;
    const row = existing.get(p.id);
    if (!row) await proposalsRepo.insert(svc.db, userId, { id: p.id, kind: p.kind, payload, message: p.message });
    else if (row.status === "pending" || row.status === "expired") {
      await proposalsRepo.update(svc.db, userId, p.id, { kind: p.kind, payload, message: p.message, status: "pending" });
    }
  }
  for (const row of existing.values()) {
    if (row.status === "pending" && !seen.has(row.id)) await proposalsRepo.update(svc.db, userId, row.id, { status: "expired" });
  }
}

export function toProposal(row: ProposalRow): Proposal {
  const details = row.payload && typeof row.payload === "object" && !Array.isArray(row.payload) ? (row.payload as Record<string, unknown>) : {};
  return {
    id: row.id,
    kind: row.kind,
    message: row.message,
    status: (["pending", "accepted", "declined", "expired"] as const).find((s) => s === row.status) ?? "expired",
    createdAt: row.createdAt.toISOString(),
    respondedAt: row.respondedAt ? row.respondedAt.toISOString() : null,
    details,
  };
}

export async function pendingProposals(svc: Services, userId: string): Promise<Proposal[]> {
  return (await proposalsRepo.list(svc.db, userId, "pending")).map(toProposal);
}

/**
 * Engine replan (§8) for one user. `extra` check-ins are included as if already stored (a check-in
 * being recorded now); `response` applies a proposal answer. Deterministic given the stored rows
 * and today's date. Stores the resulting proposals.
 */
export async function runReplan(
  svc: Services,
  userId: string,
  opts: { reason: ReplanReason; extra?: CheckinLike[]; response?: { proposalId: string; accept: boolean } },
): Promise<ReplanOutcome> {
  const loadOpts: ReplanLoadOptions = {};
  if (opts.extra) loadOpts.extra = opts.extra;
  if (opts.response) loadOpts.response = opts.response;
  const st = await loadReplanInputs(svc, userId, loadOpts);
  if (!st) return SKIPPED;
  const { current, profile, plan, input, fitness, activities, events, today } = st;

  const result = replan({ plan, input, fitness, activities, options: { units: profile.units } }, events, today);
  await storeProposals(svc, userId, result.proposals);
  const out: ReplanOutcome = {
    status: "unchanged",
    changes: result.changes.map((c) => c.message),
    proposals: result.proposals.map((p) => p.message),
    halted: result.halted !== undefined,
  };
  const workouts = result.plan.weeks.flatMap((w) => w.workouts);
  const fitnessChanged = result.fitness.vdot !== fitness.vdot || result.fitness.status !== fitness.status;
  if (!result.regenerated && !fitnessChanged && (await sameWorkouts(svc, userId, workouts, result.repush.from))) {
    return { ...out, changes: [] };
  }
  const nextInput = result.derivedInput ?? input;
  const paces = result.regenerated || fitnessChanged ? pacesFor(withFitness(nextInput, result.fitness)) : current.paces;
  let planId = current.id;
  if (result.regenerated) {
    const row = await plansRepo.insertActive(svc.db, userId, { input: nextInput, plan: planJson(result.plan), paces, reason: opts.reason });
    planId = row.id;
  } else {
    await plansRepo.updatePlan(svc.db, userId, current.id, { plan: planJson(result.plan), paces });
  }
  const changes = await materialize(svc, userId, planId, workouts, result.repush.from);
  if (fitnessChanged) {
    await fitnessRepo.upsert(svc.db, userId, {
      vdot: result.fitness.vdot ?? null,
      vdotSource: result.fitness.status,
      vdotDate: result.fitness.history.at(-1)?.date ?? today,
    });
  }
  if (changes.added > 0 || changes.removed > 0) {
    await svc.jobs.enqueue(JOB.pushWorkouts, { userId }, { singletonKey: `push:${userId}`, singletonSeconds: 30 });
  }
  return { ...out, status: "replanned" };
}

/**
 * POST /api/proposals/:id: record the answer and replan now with it. Only pending proposals can be
 * answered (404 unknown, 409 already answered or expired).
 */
export async function respondToProposal(svc: Services, userId: string, id: string, accept: boolean): Promise<ProposalDecisionResponse> {
  const row = await proposalsRepo.get(svc.db, userId, id);
  if (!row) throw new AppError(404, "not_found", "Proposal not found.");
  if (row.status !== "pending") {
    throw new AppError(409, "proposal_closed", row.status === "expired" ? "That suggestion no longer applies." : "You've already answered that suggestion.");
  }
  await proposalsRepo.update(svc.db, userId, id, { status: accept ? "accepted" : "declined", respondedAt: svc.clock() });
  const advice: string[] = [];
  let planChanges: string[] = [];
  try {
    const r = await runReplan(svc, userId, { reason: "replan_proposal", response: { proposalId: id, accept } });
    planChanges = r.changes;
  } catch (err) {
    // The answer is stored; declines apply on the next replan. An acceptance is not re-sent (see
    // module note), so put the proposal back for the user to answer again.
    svc.log.error({ userId, err }, "proposal replan failed");
    if (accept) await proposalsRepo.update(svc.db, userId, id, { status: "pending", respondedAt: null });
    throw new AppError(503, "replan_failed", "Couldn't update your plan right now. Try again in a minute.");
  }
  if (accept && row.kind === "goal_change") {
    const p = row.payload as { suggestedGoalS?: unknown };
    const s = typeof p?.suggestedGoalS === "number" ? p.suggestedGoalS : null;
    advice.push(
      s !== null
        ? `To switch to the new target (${formatHms(s)}), change your goal time in Settings; the plan rebuilds from it.`
        : "To change your goal, edit it in Settings; the plan rebuilds from it.",
    );
  } else if (!accept) {
    advice.push("Okay, your plan stays as it is.");
  } else if (planChanges.length === 0) {
    advice.push("Accepted. There was nothing to change in your plan right now.");
  }
  return { planChanges, advice };
}

function formatHms(totalS: number): string {
  const s = Math.round(totalS);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(h > 0 ? 2 : 1, "0");
  const ss = String(sec).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/**
 * Nightly replan (§12.1 replan:nightly): the engine's replan on what actually happened.
 * Skips users without a plan or a valid screen, or whose plan has ended.
 */
export async function replanUser(svc: Services, userId: string): Promise<"replanned" | "skipped"> {
  const current = await plansRepo.current(svc.db, userId);
  if (!current) return "skipped";
  const screening = await screeningOutcome(svc, userId);
  if (!screening.canProceed) return "skipped";
  try {
    // Activities from before activity_streams existed get their laps/samples from the stored FIT.
    const profile = await loadProfile(svc, userId);
    if (profile) {
      const today = localDate(svc.clock(), profile.timezone);
      await backfillStreams(svc, userId, await activitiesRepo.list(svc.db, userId, addDays(today, -REPLAN_HISTORY_DAYS), today));
    }
    const r = await runReplan(svc, userId, { reason: "replan_nightly" });
    if (r.proposals.length > 0) svc.log.info({ userId, proposals: r.proposals.length }, "replan proposals pending");
    return r.status === "replanned" ? "replanned" : "skipped";
  } catch (err) {
    if (err instanceof AppError) {
      svc.log.warn({ userId, code: err.code }, "nightly replan skipped");
      return "skipped";
    }
    throw err;
  }
}
