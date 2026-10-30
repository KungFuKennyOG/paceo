/**
 * Postgres schema (spec §2.2, simplified). Every user-owned table carries `user_id`; repositories in
 * src/repo/ take `userId` as a required argument and always filter on it.
 *
 * Simplifications vs §2.2 (D):
 * - user_profile stores the whole contract `Profile` as validated jsonb, plus a few indexed columns
 *   (user_goal / user_schedule / user_strength / user_crosstraining collapse into it).
 * - checkins doubles as §2.2 session_log (sRPE, pain, illness, cross-training rows).
 * - raw_files stores FIT bytes in a bytea column, so a single pg_dump backs up everything.
 * - laps/samples (§2.2) live in activity_streams: one row per activity, laps as jsonb and the 1 Hz
 *   samples as one gzipped columnar blob (see src/plan/activity-streams.ts for the format).
 */
import { sql } from "drizzle-orm";
import {
  boolean,
  customType,
  date,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
});

const createdAt = () => timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow();
const updatedAt = () => timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow();

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** Stored lower-cased. */
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  displayName: text("display_name").notNull(),
  isAdmin: boolean("is_admin").notNull().default(false),
  invitedBy: uuid("invited_by"),
  createdAt: createdAt(),
});

export const invites = pgTable("invites", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** sha256 of the invite code; the code itself is shown once. */
  codeHash: text("code_hash").notNull().unique(),
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: createdAt(),
  expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true, mode: "date" }),
  usedBy: uuid("used_by").references(() => users.id, { onDelete: "set null" }),
});

export const sessions = pgTable(
  "sessions",
  {
    /** sha256 of the random session token held in the cookie. */
    id: text("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
);

export const userProfile = pgTable("user_profile", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  /** Contract `Profile` (packages/contracts), validated on write and on read. */
  profile: jsonb("profile").notNull(),
  units: text("units").notNull(),
  timezone: text("timezone").notNull(),
  goalType: text("goal_type").notNull(),
  raceDate: date("race_date", { mode: "string" }),
  watchBrand: text("watch_brand").notNull(),
  updatedAt: updatedAt(),
});

export const screening = pgTable("screening", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  outcome: text("outcome").notNull(),
  canProceed: boolean("can_proceed").notNull(),
  /** The HealthScreenRequest as submitted. */
  answers: jsonb("answers").notNull(),
  notes: jsonb("notes").notNull(),
  screenedAt: timestamp("screened_at", { withTimezone: true, mode: "date" }).notNull(),
  clearanceConfirmedAt: timestamp("clearance_confirmed_at", { withTimezone: true, mode: "date" }),
});

export const credentials = pgTable(
  "credentials",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** intervals_icu | garmin_personal | strava */
    provider: text("provider").notNull(),
    /** api_key | oauth */
    kind: text("kind").notNull(),
    /** AES-256-GCM envelope, see src/crypto/secretbox.ts. */
    secretEnc: text("secret_enc").notNull(),
    keyVersion: integer("key_version").notNull().default(1),
    athleteExtId: text("athlete_ext_id"),
    athleteName: text("athlete_name"),
    /** ok | invalid | rate_limited | never_synced */
    status: text("status").notNull(),
    statusMessage: text("status_message"),
    lastValidatedAt: timestamp("last_validated_at", { withTimezone: true, mode: "date" }),
    lastSyncAt: timestamp("last_sync_at", { withTimezone: true, mode: "date" }),
    /** Newest activity local date seen; the next poll starts one day before it (§3.2). */
    lastSeenDate: date("last_seen_date", { mode: "string" }),
    activityCounts: jsonb("activity_counts"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("credentials_user_provider_uq").on(t.userId, t.provider)],
);

export const rawFiles = pgTable(
  "raw_files",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    source: text("source").notNull(),
    sourceId: text("source_id").notNull(),
    sha256: text("sha256").notNull(),
    contentType: text("content_type").notNull(),
    size: integer("size").notNull(),
    bytes: bytea("bytes").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("raw_files_user_sha_uq").on(t.userId, t.sha256)],
);

export const activities = pgTable(
  "activities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** intervals_icu | fit_upload */
    source: text("source").notNull(),
    sourceId: text("source_id").notNull(),
    originPlatform: text("origin_platform"),
    startUtc: timestamp("start_utc", { withTimezone: true, mode: "date" }).notNull(),
    localDate: date("local_date", { mode: "string" }).notNull(),
    /** Normalised: run | ride | swim | strength | walk | hike | row | other */
    sport: text("sport").notNull(),
    distanceM: doublePrecision("distance_m"),
    movingS: doublePrecision("moving_s"),
    elapsedS: doublePrecision("elapsed_s"),
    avgHr: doublePrecision("avg_hr"),
    isRace: boolean("is_race").notNull().default(false),
    name: text("name"),
    device: text("device"),
    garminOrigin: boolean("garmin_origin").notNull().default(false),
    stravaDerived: boolean("strava_derived").notNull().default(false),
    /** Cross-source duplicate (§3.9): set on the later row; listings hide it. */
    duplicateOf: uuid("duplicate_of"),
    rawFileId: uuid("raw_file_id").references(() => rawFiles.id, { onDelete: "set null" }),
    /** Source detail payload (intervals.icu activity JSON), kept for later parsing. */
    detail: jsonb("detail"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("activities_dedup_uq").on(t.userId, t.source, t.sourceId),
    index("activities_user_date_idx").on(t.userId, t.localDate),
    index("activities_user_start_idx").on(t.userId, t.startUtc),
  ],
);

export const plans = pgTable(
  "plans",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** active | superseded */
    status: text("status").notNull(),
    /** Engine PlanInput as passed to generatePlan. */
    input: jsonb("input").notNull(),
    /** Engine Plan JSON. */
    plan: jsonb("plan").notNull(),
    paces: jsonb("paces").notNull(),
    /** Why this plan was made: generate | replan_nightly | profile_change */
    reason: text("reason").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("plans_user_created_idx").on(t.userId, t.createdAt)],
);

export const plannedWorkouts = pgTable(
  "planned_workouts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    planId: uuid("plan_id").references(() => plans.id, { onDelete: "set null" }),
    /** Engine workout id, e.g. "<user>-w03-2026-11-17". */
    engineId: text("engine_id").notNull(),
    date: date("date", { mode: "string" }).notNull(),
    sport: text("sport").notNull(),
    type: text("type").notNull(),
    /** Hash of the workout content; materialize() keeps rows whose content did not change. */
    contentHash: text("content_hash").notNull(),
    /** Engine PlannedWorkout JSON (§3.8). */
    workout: jsonb("workout").notNull(),
    /** Stored status: planned | skipped. completed/partial/missed are derived at read time. */
    status: text("status").notNull().default("planned"),
    skipReason: text("skip_reason"),
    ruleTrace: jsonb("rule_trace").notNull(),
    /** Contract SinkState. */
    sinkState: jsonb("sink_state").notNull(),
    /** Bumped by re-send; part of the intervals.icu external_id. */
    rev: integer("rev").notNull().default(0),
    /** intervals.icu workout text as last pushed. */
    deviceText: text("device_text"),
    /** Set when a replan drops the workout; the push job deletes the remote event, then the row. */
    removedAt: timestamp("removed_at", { withTimezone: true, mode: "date" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("planned_workouts_user_date_idx").on(t.userId, t.date),
    index("planned_workouts_removed_idx").on(t.userId).where(sql`${t.removedAt} is not null`),
  ],
);

/** Check-ins and the session log (§2.2 session_log, §8 R-ILL / R-PAIN / sRPE). */
export const checkins = pgTable(
  "checkins",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** session_rpe | illness | pain | cross_training | skip */
    type: text("type").notNull(),
    date: date("date", { mode: "string" }).notNull(),
    workoutId: uuid("workout_id").references(() => plannedWorkouts.id, { onDelete: "set null" }),
    activityId: uuid("activity_id").references(() => activities.id, { onDelete: "set null" }),
    payload: jsonb("payload").notNull(),
    planChanges: jsonb("plan_changes").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("checkins_user_date_idx").on(t.userId, t.date)],
);

export const fitnessState = pgTable("fitness_state", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  vdot: doublePrecision("vdot"),
  /** race | tt | estimated | none */
  vdotSource: text("vdot_source").notNull(),
  vdotDate: date("vdot_date", { mode: "string" }),
  updatedAt: updatedAt(),
});

export const pushSubscriptions = pgTable(
  "push_subscriptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    endpoint: text("endpoint").notNull().unique(),
    p256dh: text("p256dh").notNull(),
    auth: text("auth").notNull(),
    userAgent: text("user_agent"),
    createdAt: createdAt(),
    lastSuccessAt: timestamp("last_success_at", { withTimezone: true, mode: "date" }),
  },
  (t) => [index("push_subscriptions_user_idx").on(t.userId)],
);

/**
 * Laps and samples per activity (§2.2 laps/samples, §4.9), written at sync / FIT upload and read by
 * the replanner. One row per activity, not one per sample: ~10 users × years of runs stays small.
 * - laps: engine ActivityLap[] (intervals.icu intervals when available, else the FIT's device laps).
 * - samples: gzip(JSON) of a columnar, delta-encoded sample block at ≤ 1 Hz (format `format`).
 * - summary: extra engine Activity fields from the detail/FIT (maxHr, elevationGainM, environment, ...).
 */
export const activityStreams = pgTable(
  "activity_streams",
  {
    activityId: uuid("activity_id")
      .primaryKey()
      .references(() => activities.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    format: integer("format").notNull(),
    laps: jsonb("laps").notNull(),
    /** intervals_icu | fit | null (no laps) */
    lapsSource: text("laps_source"),
    samples: bytea("samples"),
    sampleCount: integer("sample_count").notNull().default(0),
    summary: jsonb("summary").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("activity_streams_user_idx").on(t.userId)],
);

/**
 * Engine replan proposals awaiting the user (§8: vdot_change, goal_change, realign). Keyed by the
 * engine's stable proposal id per user, so a proposal re-emitted by later replans is one row.
 * status: pending | accepted | declined | expired (no longer emitted by the engine).
 */
export const proposals = pgTable(
  "proposals",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    id: text("id").notNull(),
    kind: text("kind").notNull(),
    /** Engine Proposal JSON. */
    payload: jsonb("payload").notNull(),
    message: text("message").notNull(),
    status: text("status").notNull().default("pending"),
    createdAt: createdAt(),
    respondedAt: timestamp("responded_at", { withTimezone: true, mode: "date" }),
  },
  (t) => [primaryKey({ columns: [t.userId, t.id] }), index("proposals_user_status_idx").on(t.userId, t.status)],
);
