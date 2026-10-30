/**
 * HTTP contract between apps/api and apps/web (spec §2–3, §11).
 *
 * Every request body and response body that crosses the wire has a zod schema here.
 * - apps/api validates request bodies with these schemas and returns objects matching the response schemas.
 * - apps/web imports the inferred types for its typed client.
 *
 * Engine types (PlannedWorkout, Plan, Feasibility) are referenced as JSON blobs here (z.unknown / passthrough)
 * so this package does not depend on the engine; the web app casts them to the engine's TS types.
 * All quantities are SI (metres, seconds, s/km). Dates are local YYYY-MM-DD; timestamps are ISO-8601 UTC.
 *
 * Changing a schema here is a breaking change for both apps: update both in the same PR.
 */
import { z } from "zod";

// ---------- primitives ----------
export const LocalDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");
export const Timestamp = z.string().datetime({ offset: true });
export const Weekday = z.enum(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);
export type Weekday = z.infer<typeof Weekday>;

export const ErrorBody = z.object({
  error: z.object({
    /** machine-readable, e.g. "invalid_credentials", "invite_invalid", "key_rejected", "not_found", "validation" */
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});
export type ErrorBody = z.infer<typeof ErrorBody>;

// ---------- auth (§2.2: invite-only, session cookie) ----------
export const RegisterRequest = z.object({
  inviteCode: z.string().min(4),
  email: z.string().email(),
  password: z.string().min(10).max(200),
  displayName: z.string().min(1).max(60),
});
export type RegisterRequest = z.infer<typeof RegisterRequest>;

export const LoginRequest = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});
export type LoginRequest = z.infer<typeof LoginRequest>;

export const User = z.object({
  id: z.string(),
  email: z.string().email(),
  displayName: z.string(),
  isAdmin: z.boolean(),
});
export type User = z.infer<typeof User>;

export const CreateInviteResponse = z.object({ code: z.string(), expiresAt: Timestamp });
export type CreateInviteResponse = z.infer<typeof CreateInviteResponse>;

// ---------- health screen (§2.4) ----------
export const HealthScreenRequest = z.object({
  /** Q1–Q7 in spec order */
  answers: z.array(z.boolean()).length(7),
  pregnantOrPostpartum: z.boolean(),
  recentSeriousInjuryOrSurgery: z.boolean(),
  /** Set true when the user confirms professional clearance after a "see_doctor" or "out_of_scope" outcome. */
  clearanceConfirmed: z.boolean().default(false),
});
export type HealthScreenRequest = z.infer<typeof HealthScreenRequest>;

export const ScreeningOutcome = z.enum(["ok", "see_doctor", "out_of_scope", "cleared", "cleared_conservative"]);
export type ScreeningOutcome = z.infer<typeof ScreeningOutcome>;

export const HealthScreenResponse = z.object({
  outcome: ScreeningOutcome,
  /** May the user generate a plan now? */
  canProceed: z.boolean(),
  notes: z.array(z.string()),
  screenedAt: Timestamp,
});
export type HealthScreenResponse = z.infer<typeof HealthScreenResponse>;

// ---------- profile / onboarding (§2.3) ----------
export const ExperienceLevel = z.enum(["beginner", "novice", "intermediate", "advanced"]);
export const GoalDistance = z.enum(["5k", "10k", "half", "marathon"]);
export const WatchBrand = z.enum([
  "garmin", "coros", "suunto", "wahoo", "polar", "apple", "huawei", "amazfit", "other", "none",
]);
export const StrengthMode = z.enum(["off", "running", "full_body", "external"]);
export const Equipment = z.enum(["gym", "dumbbells", "bodyweight"]);
export const LiftingExperience = z.enum(["none", "novice", "experienced"]);

export const RecentResult = z.object({
  distanceM: z.number().min(1500).max(42195),
  timeS: z.number().positive(),
  date: LocalDate,
  kind: z.enum(["race", "time_trial"]),
});
export type RecentResult = z.infer<typeof RecentResult>;

export const CrossTraining = z.object({
  /** e.g. "cycling", "swimming", "paddling", "team_sport", "hiking", "lifting", "hiit", "other" (§10.2) */
  activity: z.string().min(1).max(40),
  days: z.array(Weekday),
  typicalMinutes: z.number().int().min(5).max(600),
  /** session RPE 1–10 */
  typicalSrpe: z.number().min(1).max(10),
  locked: z.boolean(),
});
export type CrossTraining = z.infer<typeof CrossTraining>;

export const Profile = z.object({
  units: z.enum(["metric", "imperial"]),
  timezone: z.string(), // IANA, e.g. "America/Toronto"
  experienceLevel: ExperienceLevel,
  monthsRunning: z.number().int().min(0).max(600),
  currentWeeklyKm: z.number().min(0).max(250),
  longestRun30d: z.object({ km: z.number().min(0).max(45), minutes: z.number().min(0).max(400) }),
  canRun20MinContinuous: z.boolean(),
  recentResult: RecentResult.nullable(),
  birthYear: z.number().int().min(1930).max(2015).nullable(),
  hrMax: z.number().int().min(140).max(220).nullable(),
  hrRest: z.number().int().min(30).max(100).nullable(),
  injury: z.enum(["none", "past_12_months", "current"]),
  goal: z.discriminatedUnion("type", [
    z.object({
      type: z.literal("race"),
      distance: GoalDistance,
      raceDate: LocalDate,
      goalTimeS: z.number().positive().nullable(),
    }),
    z.object({
      type: z.literal("general_fitness"),
      targetWeeklyMinutes: z.number().int().min(60).max(600).nullable(),
    }),
  ]),
  daysAvailable: z.array(Weekday).min(2).max(7),
  longRunDay: Weekday,
  maxMinutesByDay: z.record(Weekday, z.number().int().min(20)).default({}),
  longRunMode: z.enum(["daniels", "pfitz"]).default("daniels"),
  strength: z.object({
    mode: StrengthMode,
    equipment: Equipment,
    sessionsPerWeek: z.number().int().min(0).max(3),
    liftingExperience: LiftingExperience,
  }),
  crossTraining: z.array(CrossTraining).max(10).default([]),
  watchBrand: WatchBrand,
});
export type Profile = z.infer<typeof Profile>;

// ---------- connections (§2.5, §3.2) ----------
export const ConnectIntervalsRequest = z.object({
  apiKey: z.string().min(10).max(200),
  /** Optional: the athlete id shown in intervals.icu Developer Settings, e.g. "i12345"; checked against the key. */
  athleteId: z.string().max(40).optional(),
});
export type ConnectIntervalsRequest = z.infer<typeof ConnectIntervalsRequest>;

export const ConnectionStatus = z.object({
  provider: z.enum(["intervals_icu", "fit_upload"]),
  connected: z.boolean(),
  status: z.enum(["ok", "invalid", "rate_limited", "never_synced", "disconnected"]),
  athleteName: z.string().nullable(),
  lastSyncAt: Timestamp.nullable(),
  /** e.g. { run: 42, ride: 3 } from the setup pull (§2.5 step 7) */
  activityCounts: z.record(z.string(), z.number()).nullable(),
  message: z.string().nullable(),
});
export type ConnectionStatus = z.infer<typeof ConnectionStatus>;

// ---------- me ----------
export const MeResponse = z.object({
  user: User,
  profile: Profile.nullable(),
  screening: HealthScreenResponse.nullable(),
  connection: ConnectionStatus.nullable(),
  /** true once profile + screening(canProceed) + a plan exist */
  onboardingComplete: z.boolean(),
});
export type MeResponse = z.infer<typeof MeResponse>;

// ---------- plan (§6) ----------
/** Engine `Plan` (packages/engine/src/plan-types.ts) serialized as JSON. */
export const EnginePlanJson = z.object({
  feasibility: z.object({ status: z.enum(["ok", "warn", "block"]) }).passthrough(),
  weeks: z.array(z.object({ index: z.number(), startDate: LocalDate }).passthrough()),
  summary: z.object({}).passthrough(),
}).passthrough();

export const PlanPreviewRequest = z.object({ profile: Profile });
export type PlanPreviewRequest = z.infer<typeof PlanPreviewRequest>;
export const PlanResponse = z.object({
  planId: z.string(),
  generatedAt: Timestamp,
  /** Engine Plan JSON. */
  plan: EnginePlanJson,
  /** Current paces (s/km) used by the plan, for display. */
  paces: z.object({}).passthrough(),
});
export type PlanResponse = z.infer<typeof PlanResponse>;

export const PlanPreviewResponse = z.object({
  plan: EnginePlanJson,
  paces: z.object({}).passthrough(),
});
export type PlanPreviewResponse = z.infer<typeof PlanPreviewResponse>;

// ---------- workouts (§3.7, §11.3, §11.4) ----------
export const WorkoutStatus = z.enum(["planned", "completed", "partial", "missed", "skipped"]);
export type WorkoutStatus = z.infer<typeof WorkoutStatus>;
export const SinkState = z.object({
  provider: z.literal("intervals_icu").nullable(),
  externalId: z.string().nullable(),
  eventId: z.string().nullable(),
  lastPushedAt: Timestamp.nullable(),
  status: z.enum(["not_pushed", "pushed", "missing_on_readback", "error"]),
});
export type SinkState = z.infer<typeof SinkState>;

export const ActivitySummary = z.object({
  id: z.string(),
  source: z.enum(["intervals_icu", "fit_upload"]),
  originPlatform: z.string().nullable(), // "garmin", "coros", ...
  startUtc: Timestamp,
  localDate: LocalDate,
  sport: z.string(),
  distanceM: z.number().nullable(),
  movingS: z.number().nullable(),
  avgHr: z.number().nullable(),
  isRace: z.boolean(),
  name: z.string().nullable(),
  /** Garmin attribution required when true (intervals.icu API terms, §3.2) */
  garminOrigin: z.boolean(),
});
export type ActivitySummary = z.infer<typeof ActivitySummary>;

export const WorkoutItem = z.object({
  id: z.string(),
  date: LocalDate,
  /** Engine PlannedWorkout JSON (packages/engine/src/workout.ts). */
  workout: z.object({ id: z.string(), date: LocalDate, type: z.string(), name: z.string() }).passthrough(),
  status: WorkoutStatus,
  matchedActivity: ActivitySummary.nullable(),
  sink: SinkState,
});
export type WorkoutItem = z.infer<typeof WorkoutItem>;

export const WorkoutListResponse = z.object({ items: z.array(WorkoutItem) });
export type WorkoutListResponse = z.infer<typeof WorkoutListResponse>;

export const WorkoutDetailResponse = z.object({
  item: WorkoutItem,
  /** "Why this workout" lines from the rule trace (§11.4), in the user's units. */
  explanation: z.array(z.string()),
  /** intervals.icu workout text as pushed, for debugging. */
  deviceText: z.string().nullable(),
});
export type WorkoutDetailResponse = z.infer<typeof WorkoutDetailResponse>;

export const SkipWorkoutRequest = z.object({
  reason: z.enum(["busy", "sick", "injured", "tired", "travel", "other"]),
  note: z.string().max(500).optional(),
});
export type SkipWorkoutRequest = z.infer<typeof SkipWorkoutRequest>;

// ---------- check-ins (§8: R-ILL, R-PAIN, sRPE) ----------
export const CheckInRequest = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("session_rpe"),
    date: LocalDate,
    workoutId: z.string().optional(),
    activityId: z.string().optional(),
    rpe: z.number().min(0).max(10),
    minutes: z.number().min(0).max(600),
  }),
  z.object({
    type: z.literal("illness"),
    date: LocalDate,
    aboveNeckOnly: z.boolean(),
    fever: z.boolean(),
    note: z.string().max(500).optional(),
  }),
  z.object({
    type: z.literal("pain"),
    date: LocalDate,
    location: z.string().max(60),
    /** 0–10 during the run */
    duringRun: z.number().min(0).max(10),
    /** 0–10 next morning */
    nextMorning: z.number().min(0).max(10).nullable(),
  }),
  z.object({
    type: z.literal("cross_training"),
    date: LocalDate,
    activity: z.string().max(40),
    minutes: z.number().min(1).max(600),
    rpe: z.number().min(0).max(10),
  }),
]);
export type CheckInRequest = z.infer<typeof CheckInRequest>;

export const CheckInResponse = z.object({
  id: z.string(),
  /** Plan changes triggered by this check-in, as user-facing sentences. */
  planChanges: z.array(z.string()),
  /** e.g. "see a doctor" routing for red flags (§2.4 out of scope). */
  advice: z.array(z.string()),
});
export type CheckInResponse = z.infer<typeof CheckInResponse>;

// ---------- activities & sync ----------
export const ActivityListResponse = z.object({ items: z.array(ActivitySummary) });
export type ActivityListResponse = z.infer<typeof ActivityListResponse>;
export const SyncResponse = z.object({ queued: z.boolean(), jobId: z.string().nullable() });
export type SyncResponse = z.infer<typeof SyncResponse>;

/** Response of ROUTES.testWorkout (§2.5 step 8): the "Setup test" event pushed for tomorrow. */
export const TestWorkoutResponse = z.object({ externalId: z.string(), date: LocalDate });
export type TestWorkoutResponse = z.infer<typeof TestWorkoutResponse>;

// ---------- push (§11.2) ----------
export const VapidKeyResponse = z.object({ publicKey: z.string() });
export type VapidKeyResponse = z.infer<typeof VapidKeyResponse>;
export const PushSubscribeRequest = z.object({
  endpoint: z.string().url(),
  keys: z.object({ p256dh: z.string(), auth: z.string() }),
});
export type PushSubscribeRequest = z.infer<typeof PushSubscribeRequest>;
/** Body of ROUTES.pushUnsubscribe. */
export const PushUnsubscribeRequest = z.object({ endpoint: z.string().url() });
export type PushUnsubscribeRequest = z.infer<typeof PushUnsubscribeRequest>;

// ---------- additions (apps/api, additive only) ----------
/** ?from=&to= on GET /api/workouts and GET /api/activities. Both optional; the API picks a default window. */
export const DateRangeQuery = z.object({ from: LocalDate.optional(), to: LocalDate.optional() });
export type DateRangeQuery = z.infer<typeof DateRangeQuery>;

/** GET /api/health */
export const HealthResponse = z.object({ status: z.literal("ok"), db: z.boolean() });
export type HealthResponse = z.infer<typeof HealthResponse>;

// ---------- proposals (§8: replan suggestions that need the user's OK) ----------
/**
 * A replan proposal awaiting the user. `kind` is one of "vdot_change" (paces up/down), "goal_change"
 * (revisit the race goal), "realign" (rebuild after missed sessions); kept a string so new engine
 * kinds don't break older clients. `details` is the engine Proposal JSON (fromVdot/toVdot,
 * alternatives, ...).
 */
export const Proposal = z.object({
  id: z.string(),
  kind: z.string(),
  /** User-facing question, e.g. "Speed up your paces by about 1.2%?" */
  message: z.string(),
  status: z.enum(["pending", "accepted", "declined", "expired"]),
  createdAt: Timestamp,
  respondedAt: Timestamp.nullable(),
  details: z.object({}).passthrough(),
});
export type Proposal = z.infer<typeof Proposal>;

/** GET /api/proposals: pending proposals, oldest first. */
export const ProposalListResponse = z.object({ items: z.array(Proposal) });
export type ProposalListResponse = z.infer<typeof ProposalListResponse>;

/** POST /api/proposals/:id body. */
export const ProposalDecisionRequest = z.object({ accept: z.boolean() });
export type ProposalDecisionRequest = z.infer<typeof ProposalDecisionRequest>;

/** POST /api/proposals/:id response: what the immediate replan changed, plus follow-up advice. */
export const ProposalDecisionResponse = z.object({
  planChanges: z.array(z.string()),
  advice: z.array(z.string()),
});
export type ProposalDecisionResponse = z.infer<typeof ProposalDecisionResponse>;

/**
 * Route table (method, path, request schema, response schema). The API registers exactly these;
 * the web client calls exactly these. All routes except auth/register|login and health require a session cookie.
 */
export const ROUTES = {
  health: { method: "GET", path: "/api/health" },
  register: { method: "POST", path: "/api/auth/register" }, // RegisterRequest → User
  login: { method: "POST", path: "/api/auth/login" }, // LoginRequest → User
  logout: { method: "POST", path: "/api/auth/logout" }, // → 204
  createInvite: { method: "POST", path: "/api/admin/invites" }, // admin only → CreateInviteResponse
  me: { method: "GET", path: "/api/me" }, // → MeResponse
  healthScreen: { method: "POST", path: "/api/health-screen" }, // HealthScreenRequest → HealthScreenResponse
  getProfile: { method: "GET", path: "/api/profile" }, // → Profile | 404
  putProfile: { method: "PUT", path: "/api/profile" }, // Profile → Profile
  connectIntervals: { method: "POST", path: "/api/connections/intervals" }, // ConnectIntervalsRequest → ConnectionStatus
  disconnectIntervals: { method: "DELETE", path: "/api/connections/intervals" }, // → 204 (deletes key)
  connectionStatus: { method: "GET", path: "/api/connections/intervals" }, // → ConnectionStatus
  testWorkout: { method: "POST", path: "/api/connections/intervals/test-workout" }, // → TestWorkoutResponse { externalId, date }
  deleteTestWorkout: { method: "DELETE", path: "/api/connections/intervals/test-workout" }, // → 204
  planPreview: { method: "POST", path: "/api/plan/preview" }, // PlanPreviewRequest → PlanPreviewResponse
  planGenerate: { method: "POST", path: "/api/plan/generate" }, // → PlanResponse (stores + pushes next 14 d)
  planCurrent: { method: "GET", path: "/api/plan/current" }, // → PlanResponse | 404
  workouts: { method: "GET", path: "/api/workouts" }, // ?from=&to= → WorkoutListResponse
  workout: { method: "GET", path: "/api/workouts/:id" }, // → WorkoutDetailResponse
  resendWorkout: { method: "POST", path: "/api/workouts/:id/resend" }, // → WorkoutItem
  skipWorkout: { method: "POST", path: "/api/workouts/:id/skip" }, // SkipWorkoutRequest → CheckInResponse
  checkIn: { method: "POST", path: "/api/checkins" }, // CheckInRequest → CheckInResponse
  activities: { method: "GET", path: "/api/activities" }, // ?from=&to= → ActivityListResponse
  uploadFit: { method: "POST", path: "/api/activities/upload" }, // multipart "file" (.fit) → ActivitySummary
  sync: { method: "POST", path: "/api/sync" }, // → SyncResponse
  vapidKey: { method: "GET", path: "/api/push/vapid-public-key" }, // → VapidKeyResponse
  pushSubscribe: { method: "POST", path: "/api/push/subscriptions" }, // PushSubscribeRequest → 204
  pushUnsubscribe: { method: "DELETE", path: "/api/push/subscriptions" }, // PushUnsubscribeRequest { endpoint } → 204
  proposals: { method: "GET", path: "/api/proposals" }, // → ProposalListResponse (pending only)
  respondProposal: { method: "POST", path: "/api/proposals/:id" }, // ProposalDecisionRequest → ProposalDecisionResponse (replans now)
} as const;
