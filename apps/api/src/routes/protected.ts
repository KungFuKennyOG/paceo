/** Session-protected routes (everything in ROUTES except health/register/login/logout). */
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { addDays } from "@paceo/engine";
import {
  ActivityListResponse,
  ActivitySummary,
  CheckInRequest,
  CheckInResponse,
  ConnectIntervalsRequest,
  ConnectionStatus,
  CreateInviteResponse,
  DateRangeQuery,
  HealthScreenRequest,
  HealthScreenResponse,
  MeResponse,
  PlanPreviewRequest,
  PlanPreviewResponse,
  PlanResponse,
  Profile,
  ProposalDecisionRequest,
  ProposalDecisionResponse,
  ProposalListResponse,
  PushSubscribeRequest,
  PushUnsubscribeRequest,
  ROUTES,
  SkipWorkoutRequest,
  SyncResponse,
  TestWorkoutResponse,
  VapidKeyResponse,
  WorkoutDetailResponse,
  WorkoutItem,
  WorkoutListResponse,
  type ScreeningOutcome,
} from "@paceo/contracts";
import { output, parseInput } from "../http/validate.js";
import { AppError, forbidden, unauthorized } from "../http/errors.js";
import { isValidTimeZone, localDate } from "../lib/time.js";
import {
  activitiesRepo,
  credentialsRepo,
  plansRepo,
  profileRepo,
  pushRepo,
  screeningRepo,
  type UserRow,
} from "../repo/index.js";
import { createInvite, SESSION_COOKIE, toUser, userForToken } from "../services/auth.js";
import { connectIntervals, disconnectIntervals, PROVIDER, toConnectionStatus, userTimezone } from "../services/connection.js";
import {
  generateAndStore,
  loadProfile,
  pendingProposals,
  previewPlan,
  respondToProposal,
  screeningOutcome,
  toPlanResponse,
} from "../services/plan.js";
import {
  deleteTestWorkout,
  removeUpcomingFromSink,
  resendWorkout,
  sendTestWorkout,
} from "../services/push-workouts.js";
import { listWorkoutItems, skipWorkout, toActivitySummary, workoutDetail, workoutItem } from "../services/workouts.js";
import { recordCheckIn } from "../services/checkins.js";
import { ingestFitUpload } from "../services/sync.js";
import { evaluateScreening, screeningExpired } from "../plan/screening.js";
import { JOB } from "../jobs/queue.js";
import type { Services } from "../services/context.js";

const MAX_RANGE_DAYS = 400;

const DISCONNECTED: ConnectionStatus = {
  provider: "intervals_icu",
  connected: false,
  status: "disconnected",
  athleteName: null,
  lastSyncAt: null,
  activityCounts: null,
  message: null,
};

function me(req: FastifyRequest): UserRow {
  if (!req.user) throw unauthorized();
  return req.user;
}

export function protectedRoutes(svc: Services): FastifyPluginAsync {
  async function today(userId: string) {
    return localDate(svc.clock(), await userTimezone(svc, userId));
  }

  async function range(userId: string, query: unknown, back: number, ahead: number) {
    const q = parseInput(DateRangeQuery, query ?? {});
    const t = await today(userId);
    const from = q.from ?? addDays(t, -back);
    const to = q.to ?? addDays(t, ahead);
    if (from > to) throw new AppError(400, "validation", "`from` must not be after `to`.");
    if (addDays(from, MAX_RANGE_DAYS) < to) throw new AppError(400, "validation", `Range is limited to ${MAX_RANGE_DAYS} days.`);
    return { from, to };
  }

  async function screeningResponse(userId: string): Promise<HealthScreenResponse | null> {
    const s = await screeningRepo.get(svc.db, userId);
    if (!s) return null;
    const expired = screeningExpired(s.screenedAt, svc.clock());
    const notes = (s.notes as string[]) ?? [];
    return {
      outcome: s.outcome as ScreeningOutcome,
      canProceed: s.canProceed && !expired,
      notes: expired ? [...notes, "It's been 12 months: please take the health screen again."] : notes,
      screenedAt: s.screenedAt.toISOString(),
    };
  }

  return async (app) => {
    app.addHook("preHandler", async (req) => {
      const raw = req.cookies[SESSION_COOKIE];
      if (!raw) throw unauthorized();
      const un = req.unsignCookie(raw);
      if (!un.valid || !un.value) throw unauthorized();
      const user = await userForToken(svc, un.value);
      if (!user) throw unauthorized();
      req.user = user;
    });

    // ── admin ──
    app.post(ROUTES.createInvite.path, async (req) => {
      const user = me(req);
      if (!user.isAdmin) throw forbidden("Only the admin can create invites.");
      const inv = await createInvite(svc.db, user.id, svc.clock());
      return output(CreateInviteResponse, { code: inv.code, expiresAt: inv.expiresAt.toISOString() });
    });

    // ── me / screening / profile ──
    app.get(ROUTES.me.path, async (req) => {
      const user = me(req);
      const profile = await loadProfile(svc, user.id);
      const screening = await screeningResponse(user.id);
      const cred = await credentialsRepo.get(svc.db, user.id, PROVIDER);
      const plan = await plansRepo.current(svc.db, user.id);
      return output(MeResponse, {
        user: toUser(user),
        profile,
        screening,
        connection: toConnectionStatus(cred),
        onboardingComplete: profile !== null && screening?.canProceed === true && plan !== undefined,
      });
    });

    app.post(ROUTES.healthScreen.path, async (req) => {
      const user = me(req);
      const body = parseInput(HealthScreenRequest, req.body);
      const profile = await loadProfile(svc, user.id);
      const now = svc.clock();
      const age = profile?.birthYear ? now.getUTCFullYear() - profile.birthYear : null;
      const result = evaluateScreening(body, { age, currentInjury: profile?.injury === "current" });
      const cleared = result.outcome === "cleared" || result.outcome === "cleared_conservative";
      await screeningRepo.upsert(svc.db, user.id, {
        outcome: result.outcome,
        canProceed: result.canProceed,
        answers: body,
        notes: result.notes,
        screenedAt: now,
        clearanceConfirmedAt: cleared ? now : null,
      });
      return output(HealthScreenResponse, { ...result, screenedAt: now.toISOString() });
    });

    app.get(ROUTES.getProfile.path, async (req) => {
      const profile = await loadProfile(svc, me(req).id);
      if (!profile) throw new AppError(404, "not_found", "No profile yet.");
      return output(Profile, profile);
    });

    app.put(ROUTES.putProfile.path, async (req) => {
      const user = me(req);
      const profile = parseInput(Profile, req.body);
      if (!isValidTimeZone(profile.timezone)) {
        throw new AppError(400, "validation", `Unknown timezone "${profile.timezone}".`);
      }
      const hadPlan = (await plansRepo.current(svc.db, user.id)) !== undefined;
      const previous = await loadProfile(svc, user.id);
      await profileRepo.upsert(svc.db, user.id, {
        profile,
        units: profile.units,
        timezone: profile.timezone,
        goalType: profile.goal.type,
        raceDate: profile.goal.type === "race" ? profile.goal.raceDate : null,
        watchBrand: profile.watchBrand,
      });
      // §2.3 re-onboarding: profile edits re-check feasibility and replan from today.
      if (hadPlan && planRelevantChange(previous, profile)) {
        await svc.jobs.enqueue(JOB.replanUser, { userId: user.id, reason: "profile_change" }, { singletonKey: `replan:${user.id}`, singletonSeconds: 60 });
      }
      return output(Profile, profile);
    });

    // ── connections ──
    app.post(ROUTES.connectIntervals.path, async (req) => {
      const body = parseInput(ConnectIntervalsRequest, req.body);
      return output(ConnectionStatus, await connectIntervals(svc, me(req).id, body));
    });

    app.delete(ROUTES.disconnectIntervals.path, async (req, reply) => {
      const user = me(req);
      await removeUpcomingFromSink(svc, user.id);
      await disconnectIntervals(svc, user.id);
      return reply.status(204).send();
    });

    app.get(ROUTES.connectionStatus.path, async (req) => {
      const cred = await credentialsRepo.get(svc.db, me(req).id, PROVIDER);
      return output(ConnectionStatus, toConnectionStatus(cred) ?? DISCONNECTED);
    });

    app.post(ROUTES.testWorkout.path, async (req) => {
      return output(TestWorkoutResponse, await sendTestWorkout(svc, me(req).id));
    });

    app.delete(ROUTES.deleteTestWorkout.path, async (req, reply) => {
      await deleteTestWorkout(svc, me(req).id);
      return reply.status(204).send();
    });

    // ── plan ──
    app.post(ROUTES.planPreview.path, async (req) => {
      const body = parseInput(PlanPreviewRequest, req.body);
      if (!isValidTimeZone(body.profile.timezone)) {
        throw new AppError(400, "validation", `Unknown timezone "${body.profile.timezone}".`);
      }
      return output(PlanPreviewResponse, await previewPlan(svc, me(req).id, body.profile));
    });

    app.post(ROUTES.planGenerate.path, async (req) => {
      const { row } = await generateAndStore(svc, me(req).id, "generate");
      return output(PlanResponse, toPlanResponse(row));
    });

    app.get(ROUTES.planCurrent.path, async (req) => {
      const row = await plansRepo.current(svc.db, me(req).id);
      if (!row) throw new AppError(404, "not_found", "No plan yet.");
      return output(PlanResponse, toPlanResponse(row));
    });

    // ── workouts ──
    app.get(ROUTES.workouts.path, async (req) => {
      const user = me(req);
      const { from, to } = await range(user.id, req.query, 7, 27);
      return output(WorkoutListResponse, { items: await listWorkoutItems(svc, user.id, from, to) });
    });

    app.get<{ Params: { id: string } }>(ROUTES.workout.path, async (req) => {
      return output(WorkoutDetailResponse, await workoutDetail(svc, me(req).id, uuidParam(req.params.id)));
    });

    app.post<{ Params: { id: string } }>(ROUTES.resendWorkout.path, async (req) => {
      const user = me(req);
      const id = uuidParam(req.params.id);
      await resendWorkout(svc, user.id, id);
      return output(WorkoutItem, await workoutItem(svc, user.id, id));
    });

    app.post<{ Params: { id: string } }>(ROUTES.skipWorkout.path, async (req) => {
      const body = parseInput(SkipWorkoutRequest, req.body ?? {});
      return output(CheckInResponse, await skipWorkout(svc, me(req).id, uuidParam(req.params.id), body));
    });

    // ── check-ins ──
    app.post(ROUTES.checkIn.path, async (req) => {
      const body = parseInput(CheckInRequest, req.body);
      return output(CheckInResponse, await recordCheckIn(svc, me(req).id, body));
    });

    // ── proposals ──
    app.get(ROUTES.proposals.path, async (req) => {
      return output(ProposalListResponse, { items: await pendingProposals(svc, me(req).id) });
    });

    app.post<{ Params: { id: string } }>(ROUTES.respondProposal.path, async (req) => {
      const body = parseInput(ProposalDecisionRequest, req.body);
      const id = req.params.id;
      if (!id || id.length > 200) throw new AppError(404, "not_found", "Proposal not found.");
      return output(ProposalDecisionResponse, await respondToProposal(svc, me(req).id, id, body.accept));
    });

    // ── activities / sync ──
    app.get(ROUTES.activities.path, async (req) => {
      const user = me(req);
      const { from, to } = await range(user.id, req.query, 30, 0);
      const rows = await activitiesRepo.list(svc.db, user.id, from, to);
      return output(ActivityListResponse, { items: rows.map(toActivitySummary) });
    });

    app.post(ROUTES.uploadFit.path, async (req) => {
      const user = me(req);
      if (!req.isMultipart()) throw new AppError(415, "unsupported_media_type", 'Upload a .fit file as multipart field "file".');
      const file = await req.file();
      if (!file) throw new AppError(400, "validation", 'Missing multipart field "file".');
      const bytes = await file.toBuffer();
      const row = await ingestFitUpload(svc, user.id, bytes);
      return output(ActivitySummary, toActivitySummary(row));
    });

    app.post(ROUTES.sync.path, async (req) => {
      const user = me(req);
      const cred = await credentialsRepo.get(svc.db, user.id, PROVIDER);
      if (!cred || cred.status === "invalid") return output(SyncResponse, { queued: false, jobId: null });
      const jobId = await svc.jobs.enqueue(JOB.syncUser, { userId: user.id, mode: "poll" }, { singletonKey: `sync:${user.id}`, singletonSeconds: 30 });
      return output(SyncResponse, { queued: true, jobId });
    });

    // ── push ──
    app.get(ROUTES.vapidKey.path, async () => {
      if (!svc.config.vapidPublicKey) throw new AppError(503, "push_disabled", "Push notifications are not configured on this server.");
      return output(VapidKeyResponse, { publicKey: svc.config.vapidPublicKey });
    });

    app.post(ROUTES.pushSubscribe.path, async (req, reply) => {
      const body = parseInput(PushSubscribeRequest, req.body);
      const ua = req.headers["user-agent"];
      await pushRepo.upsert(svc.db, me(req).id, {
        endpoint: body.endpoint,
        p256dh: body.keys.p256dh,
        auth: body.keys.auth,
        userAgent: typeof ua === "string" ? ua.slice(0, 300) : null,
      });
      return reply.status(204).send();
    });

    app.delete(ROUTES.pushUnsubscribe.path, async (req, reply) => {
      const body = parseInput(PushUnsubscribeRequest, req.body);
      await pushRepo.deleteByEndpoint(svc.db, me(req).id, body.endpoint);
      return reply.status(204).send();
    });
  };
}

/** Display-only fields: changing them must not replan (units are formatting only, §5). */
export function planRelevantChange(before: Profile | null, after: Profile): boolean {
  if (!before) return true;
  const strip = ({ units: _u, ...rest }: Profile) => rest;
  return stableJson(strip(before)) !== stableJson(strip(after));
}

function stableJson(v: unknown): string {
  return JSON.stringify(v, (_k, val: unknown) =>
    val && typeof val === "object" && !Array.isArray(val)
      ? Object.fromEntries(Object.entries(val as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
      : val,
  );
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function uuidParam(id: string): string {
  if (!UUID.test(id)) throw new AppError(404, "not_found", "Workout not found.");
  return id;
}
