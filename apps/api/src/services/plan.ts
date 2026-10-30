/**
 * Plan preview / generate / materialize (spec §6, §3.2 push strategy).
 * TODO(engine-replan): nightly replans call generatePlan from today; switch to replan(state, events)
 * once it lands so missed sessions, illness and pain feed the plan.
 */
import { generatePlan, HEAVY_CROSS_TRAINING_SHARE, weeklyLoad, type Plan, type PlannedWorkout } from "@paceo/engine";
import type { PlanResponse, PlanPreviewResponse, Profile, ScreeningOutcome } from "@paceo/contracts";
import { Profile as ProfileSchema } from "@paceo/contracts";
import { fitnessRepo, plansRepo, profileRepo, screeningRepo, workoutsRepo, type PlanRow, type PlannedWorkoutInsert } from "../repo/index.js";
import { AppError } from "../http/errors.js";
import { sha256Hex } from "../crypto/tokens.js";
import { localDate } from "../lib/time.js";
import { mapProfileToPlanInput, pacesFor, type MappedProfile } from "../plan/map-profile.js";
import { screeningExpired } from "../plan/screening.js";
import { JOB } from "../jobs/queue.js";
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

/**
 * Nightly replan stub (§12.1 replan:nightly): regenerate from today with the stored profile.
 * Skips users without a plan, without a valid screen, or whose race is in the past.
 */
export async function replanUser(svc: Services, userId: string): Promise<"replanned" | "skipped"> {
  const current = await plansRepo.current(svc.db, userId);
  if (!current) return "skipped";
  const profile = await loadProfile(svc, userId);
  if (!profile) return "skipped";
  const today = localDate(svc.clock(), profile.timezone);
  if (profile.goal.type === "race" && profile.goal.raceDate < today) return "skipped";
  try {
    await generateAndStore(svc, userId, "replan_nightly");
    return "replanned";
  } catch (err) {
    if (err instanceof AppError) {
      svc.log.warn({ userId, code: err.code }, "nightly replan skipped");
      return "skipped";
    }
    throw err;
  }
}
