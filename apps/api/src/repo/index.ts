/**
 * Repository layer. Every function that touches user-owned rows takes `userId` as its first argument
 * and filters on it (spec §2.2 tenancy). The few cross-user helpers used by jobs are named
 * `system*` so they stand out in review.
 */
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lte, ne, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import * as t from "../db/schema.js";

export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type DbOrTx = Db | Tx;

export type UserRow = typeof t.users.$inferSelect;
export type CredentialRow = typeof t.credentials.$inferSelect;
export type ActivityRow = typeof t.activities.$inferSelect;
export type PlanRow = typeof t.plans.$inferSelect;
export type PlannedWorkoutRow = typeof t.plannedWorkouts.$inferSelect;
export type PushSubscriptionRow = typeof t.pushSubscriptions.$inferSelect;
export type ScreeningRow = typeof t.screening.$inferSelect;
export type ProfileRow = typeof t.userProfile.$inferSelect;
export type ProposalRow = typeof t.proposals.$inferSelect;
export type ActivityStreamsRow = typeof t.activityStreams.$inferSelect;

// ── users / invites / sessions ───────────────────────────────────────────────────────────────────

export const usersRepo = {
  async byEmail(db: DbOrTx, email: string): Promise<UserRow | undefined> {
    const rows = await db.select().from(t.users).where(eq(t.users.email, email.toLowerCase())).limit(1);
    return rows[0];
  },
  async byId(db: DbOrTx, userId: string): Promise<UserRow | undefined> {
    const rows = await db.select().from(t.users).where(eq(t.users.id, userId)).limit(1);
    return rows[0];
  },
  async count(db: DbOrTx): Promise<number> {
    const rows = await db.select({ n: sql<number>`count(*)::int` }).from(t.users);
    return rows[0]?.n ?? 0;
  },
  async create(
    db: DbOrTx,
    v: { email: string; passwordHash: string; displayName: string; isAdmin: boolean; invitedBy: string | null },
  ): Promise<UserRow> {
    const rows = await db
      .insert(t.users)
      .values({ ...v, email: v.email.toLowerCase() })
      .returning();
    return rows[0] as UserRow;
  },
  /** System: all user ids (jobs fan out per user). */
  async systemAllIds(db: DbOrTx): Promise<string[]> {
    const rows = await db.select({ id: t.users.id }).from(t.users);
    return rows.map((r) => r.id);
  },
};

export const invitesRepo = {
  async create(db: DbOrTx, v: { codeHash: string; createdBy: string | null; expiresAt: Date }) {
    const rows = await db.insert(t.invites).values(v).returning();
    return rows[0] as typeof t.invites.$inferSelect;
  },
  /** Locks the invite row for the registration transaction. */
  async lockUsable(tx: Tx, codeHash: string, now: Date) {
    const rows = await tx
      .select()
      .from(t.invites)
      .where(and(eq(t.invites.codeHash, codeHash), isNull(t.invites.usedAt), gte(t.invites.expiresAt, now)))
      .for("update")
      .limit(1);
    return rows[0];
  },
  async markUsed(tx: Tx, inviteId: string, userId: string, now: Date) {
    await tx.update(t.invites).set({ usedAt: now, usedBy: userId }).where(eq(t.invites.id, inviteId));
  },
};

export const sessionsRepo = {
  async create(db: DbOrTx, v: { id: string; userId: string; expiresAt: Date }) {
    await db.insert(t.sessions).values(v);
  },
  async findUser(db: DbOrTx, sessionId: string, now: Date): Promise<UserRow | undefined> {
    const rows = await db
      .select({ user: t.users })
      .from(t.sessions)
      .innerJoin(t.users, eq(t.users.id, t.sessions.userId))
      .where(and(eq(t.sessions.id, sessionId), gte(t.sessions.expiresAt, now)))
      .limit(1);
    return rows[0]?.user;
  },
  async delete(db: DbOrTx, sessionId: string) {
    await db.delete(t.sessions).where(eq(t.sessions.id, sessionId));
  },
  async systemDeleteExpired(db: DbOrTx, now: Date) {
    await db.delete(t.sessions).where(lte(t.sessions.expiresAt, now));
  },
};

// ── profile / screening / fitness ────────────────────────────────────────────────────────────────

export const profileRepo = {
  async get(db: DbOrTx, userId: string): Promise<ProfileRow | undefined> {
    const rows = await db.select().from(t.userProfile).where(eq(t.userProfile.userId, userId)).limit(1);
    return rows[0];
  },
  async upsert(
    db: DbOrTx,
    userId: string,
    v: { profile: unknown; units: string; timezone: string; goalType: string; raceDate: string | null; watchBrand: string },
  ) {
    const now = new Date();
    await db
      .insert(t.userProfile)
      .values({ userId, ...v, updatedAt: now })
      .onConflictDoUpdate({ target: t.userProfile.userId, set: { ...v, updatedAt: now } });
  },
  /** System: user ids with a profile, plus their timezone (jobs need local time). */
  async systemTimezones(db: DbOrTx): Promise<Array<{ userId: string; timezone: string }>> {
    return db.select({ userId: t.userProfile.userId, timezone: t.userProfile.timezone }).from(t.userProfile);
  },
};

export const screeningRepo = {
  async get(db: DbOrTx, userId: string): Promise<ScreeningRow | undefined> {
    const rows = await db.select().from(t.screening).where(eq(t.screening.userId, userId)).limit(1);
    return rows[0];
  },
  async upsert(db: DbOrTx, userId: string, v: Omit<ScreeningRow, "userId">) {
    await db
      .insert(t.screening)
      .values({ userId, ...v })
      .onConflictDoUpdate({ target: t.screening.userId, set: v });
  },
};

export const fitnessRepo = {
  async get(db: DbOrTx, userId: string) {
    const rows = await db.select().from(t.fitnessState).where(eq(t.fitnessState.userId, userId)).limit(1);
    return rows[0];
  },
  async upsert(db: DbOrTx, userId: string, v: { vdot: number | null; vdotSource: string; vdotDate: string | null }) {
    const now = new Date();
    await db
      .insert(t.fitnessState)
      .values({ userId, ...v, updatedAt: now })
      .onConflictDoUpdate({ target: t.fitnessState.userId, set: { ...v, updatedAt: now } });
  },
};

// ── credentials ──────────────────────────────────────────────────────────────────────────────────

export const credentialsRepo = {
  async get(db: DbOrTx, userId: string, provider: string): Promise<CredentialRow | undefined> {
    const rows = await db
      .select()
      .from(t.credentials)
      .where(and(eq(t.credentials.userId, userId), eq(t.credentials.provider, provider)))
      .limit(1);
    return rows[0];
  },
  async upsert(
    db: DbOrTx,
    userId: string,
    v: {
      provider: string;
      kind: string;
      secretEnc: string;
      keyVersion: number;
      athleteExtId: string | null;
      athleteName: string | null;
      status: string;
      statusMessage: string | null;
      lastValidatedAt: Date;
    },
  ) {
    const now = new Date();
    const set = { ...v, updatedAt: now, lastSyncAt: null, lastSeenDate: null, activityCounts: null };
    await db
      .insert(t.credentials)
      .values({ userId, ...set })
      .onConflictDoUpdate({ target: [t.credentials.userId, t.credentials.provider], set });
  },
  async update(
    db: DbOrTx,
    userId: string,
    provider: string,
    v: Partial<
      Pick<CredentialRow, "status" | "statusMessage" | "lastSyncAt" | "lastSeenDate" | "activityCounts" | "lastValidatedAt">
    >,
  ) {
    await db
      .update(t.credentials)
      .set({ ...v, updatedAt: new Date() })
      .where(and(eq(t.credentials.userId, userId), eq(t.credentials.provider, provider)));
  },
  async delete(db: DbOrTx, userId: string, provider: string) {
    await db.delete(t.credentials).where(and(eq(t.credentials.userId, userId), eq(t.credentials.provider, provider)));
  },
  /** System: users with a usable credential for a provider (sync fan-out). */
  async systemActiveUsers(db: DbOrTx, provider: string): Promise<Array<{ userId: string }>> {
    return db
      .select({ userId: t.credentials.userId })
      .from(t.credentials)
      .where(and(eq(t.credentials.provider, provider), ne(t.credentials.status, "invalid")));
  },
};

// ── activities / raw files ───────────────────────────────────────────────────────────────────────

export interface ActivityInput {
  source: string;
  sourceId: string;
  originPlatform: string | null;
  startUtc: Date;
  localDate: string;
  sport: string;
  distanceM: number | null;
  movingS: number | null;
  elapsedS: number | null;
  avgHr: number | null;
  isRace: boolean;
  name: string | null;
  device: string | null;
  garminOrigin: boolean;
  stravaDerived: boolean;
  detail: unknown;
}

export const activitiesRepo = {
  /** Idempotent ingest on (user_id, source, source_id) (§3.9). */
  async upsert(db: DbOrTx, userId: string, v: ActivityInput): Promise<{ row: ActivityRow; inserted: boolean }> {
    const existing = await db
      .select()
      .from(t.activities)
      .where(and(eq(t.activities.userId, userId), eq(t.activities.source, v.source), eq(t.activities.sourceId, v.sourceId)))
      .limit(1);
    if (existing[0]) {
      const rows = await db
        .update(t.activities)
        .set({ ...v, updatedAt: new Date() })
        .where(and(eq(t.activities.userId, userId), eq(t.activities.id, existing[0].id)))
        .returning();
      return { row: rows[0] as ActivityRow, inserted: false };
    }
    const rows = await db
      .insert(t.activities)
      .values({ userId, ...v })
      .onConflictDoNothing({ target: [t.activities.userId, t.activities.source, t.activities.sourceId] })
      .returning();
    if (rows[0]) return { row: rows[0], inserted: true };
    // Lost a race with a concurrent ingest of the same activity.
    const again = await db
      .select()
      .from(t.activities)
      .where(and(eq(t.activities.userId, userId), eq(t.activities.source, v.source), eq(t.activities.sourceId, v.sourceId)))
      .limit(1);
    return { row: again[0] as ActivityRow, inserted: false };
  },
  /**
   * Cross-source duplicate (§3.9): another source's activity starting within ±60 s and, when both
   * have a distance, within ±2%.
   */
  async findCrossSourceDuplicate(
    db: DbOrTx,
    userId: string,
    v: { source: string; startUtc: Date; distanceM: number | null },
  ): Promise<ActivityRow | undefined> {
    const lo = new Date(v.startUtc.getTime() - 60_000);
    const hi = new Date(v.startUtc.getTime() + 60_000);
    const rows = await db
      .select()
      .from(t.activities)
      .where(
        and(
          eq(t.activities.userId, userId),
          ne(t.activities.source, v.source),
          isNull(t.activities.duplicateOf),
          gte(t.activities.startUtc, lo),
          lte(t.activities.startUtc, hi),
        ),
      );
    return rows.find((r) => {
      if (v.distanceM === null || r.distanceM === null || v.distanceM === 0) return true;
      return Math.abs(r.distanceM - v.distanceM) / v.distanceM <= 0.02;
    });
  },
  async markDuplicate(db: DbOrTx, userId: string, id: string, ofId: string) {
    await db
      .update(t.activities)
      .set({ duplicateOf: ofId })
      .where(and(eq(t.activities.userId, userId), eq(t.activities.id, id)));
  },
  async setRawFile(db: DbOrTx, userId: string, id: string, rawFileId: string) {
    await db
      .update(t.activities)
      .set({ rawFileId })
      .where(and(eq(t.activities.userId, userId), eq(t.activities.id, id)));
  },
  async list(db: DbOrTx, userId: string, from: string, to: string): Promise<ActivityRow[]> {
    return db
      .select()
      .from(t.activities)
      .where(
        and(
          eq(t.activities.userId, userId),
          isNull(t.activities.duplicateOf),
          gte(t.activities.localDate, from),
          lte(t.activities.localDate, to),
        ),
      )
      .orderBy(asc(t.activities.startUtc));
  },
  async byId(db: DbOrTx, userId: string, id: string): Promise<ActivityRow | undefined> {
    const rows = await db
      .select()
      .from(t.activities)
      .where(and(eq(t.activities.userId, userId), eq(t.activities.id, id)))
      .limit(1);
    return rows[0];
  },
};

export const rawFilesRepo = {
  /** Stores bytes once per (user, sha256); returns the row id. */
  async put(
    db: DbOrTx,
    userId: string,
    v: { source: string; sourceId: string; sha256: string; contentType: string; bytes: Buffer },
  ): Promise<string> {
    const inserted = await db
      .insert(t.rawFiles)
      .values({ userId, ...v, size: v.bytes.length })
      .onConflictDoNothing({ target: [t.rawFiles.userId, t.rawFiles.sha256] })
      .returning({ id: t.rawFiles.id });
    if (inserted[0]) return inserted[0].id;
    const rows = await db
      .select({ id: t.rawFiles.id })
      .from(t.rawFiles)
      .where(and(eq(t.rawFiles.userId, userId), eq(t.rawFiles.sha256, v.sha256)))
      .limit(1);
    return (rows[0] as { id: string }).id;
  },
  async bytes(db: DbOrTx, userId: string, id: string): Promise<{ bytes: Buffer; contentType: string } | undefined> {
    const rows = await db
      .select({ bytes: t.rawFiles.bytes, contentType: t.rawFiles.contentType })
      .from(t.rawFiles)
      .where(and(eq(t.rawFiles.userId, userId), eq(t.rawFiles.id, id)))
      .limit(1);
    return rows[0];
  },
};

export interface ActivityStreamsInput {
  format: number;
  laps: unknown;
  lapsSource: string | null;
  samples: Buffer | null;
  sampleCount: number;
  summary: unknown;
}

export const streamsRepo = {
  async upsert(db: DbOrTx, userId: string, activityId: string, v: ActivityStreamsInput) {
    const now = new Date();
    await db
      .insert(t.activityStreams)
      .values({ activityId, userId, ...v, updatedAt: now })
      .onConflictDoUpdate({ target: t.activityStreams.activityId, set: { ...v, updatedAt: now } });
  },
  async forActivities(db: DbOrTx, userId: string, activityIds: string[]): Promise<ActivityStreamsRow[]> {
    if (activityIds.length === 0) return [];
    return db
      .select()
      .from(t.activityStreams)
      .where(and(eq(t.activityStreams.userId, userId), inArray(t.activityStreams.activityId, activityIds)));
  },
};

// ── proposals ────────────────────────────────────────────────────────────────────────────────────

export const proposalsRepo = {
  async list(db: DbOrTx, userId: string, status?: string): Promise<ProposalRow[]> {
    const where = status ? and(eq(t.proposals.userId, userId), eq(t.proposals.status, status)) : eq(t.proposals.userId, userId);
    return db.select().from(t.proposals).where(where).orderBy(asc(t.proposals.createdAt), asc(t.proposals.id));
  },
  async get(db: DbOrTx, userId: string, id: string): Promise<ProposalRow | undefined> {
    const rows = await db
      .select()
      .from(t.proposals)
      .where(and(eq(t.proposals.userId, userId), eq(t.proposals.id, id)))
      .limit(1);
    return rows[0];
  },
  async insert(db: DbOrTx, userId: string, v: { id: string; kind: string; payload: unknown; message: string }) {
    await db
      .insert(t.proposals)
      .values({ userId, ...v, status: "pending" })
      .onConflictDoNothing({ target: [t.proposals.userId, t.proposals.id] });
  },
  async update(
    db: DbOrTx,
    userId: string,
    id: string,
    v: Partial<Pick<ProposalRow, "kind" | "payload" | "message" | "status" | "respondedAt">>,
  ) {
    await db
      .update(t.proposals)
      .set(v)
      .where(and(eq(t.proposals.userId, userId), eq(t.proposals.id, id)));
  },
};

// ── plans / planned workouts ─────────────────────────────────────────────────────────────────────

export const plansRepo = {
  async current(db: DbOrTx, userId: string): Promise<PlanRow | undefined> {
    const rows = await db
      .select()
      .from(t.plans)
      .where(and(eq(t.plans.userId, userId), eq(t.plans.status, "active")))
      .orderBy(desc(t.plans.createdAt))
      .limit(1);
    return rows[0];
  },
  /** Inserts a new active plan and supersedes the previous one. */
  async insertActive(
    db: DbOrTx,
    userId: string,
    v: { input: unknown; plan: unknown; paces: unknown; reason: string },
  ): Promise<PlanRow> {
    await db
      .update(t.plans)
      .set({ status: "superseded" })
      .where(and(eq(t.plans.userId, userId), eq(t.plans.status, "active")));
    const rows = await db
      .insert(t.plans)
      .values({ userId, status: "active", ...v })
      .returning();
    return rows[0] as PlanRow;
  },
  /** A replan that only modifies days in place revises the active plan rather than superseding it. */
  async updatePlan(db: DbOrTx, userId: string, id: string, v: { plan: unknown; paces: unknown }) {
    await db.update(t.plans).set(v).where(and(eq(t.plans.userId, userId), eq(t.plans.id, id)));
  },
  /** System: users with an active plan. */
  async systemUsersWithActivePlan(db: DbOrTx): Promise<string[]> {
    const rows = await db.selectDistinct({ userId: t.plans.userId }).from(t.plans).where(eq(t.plans.status, "active"));
    return rows.map((r) => r.userId);
  },
};

export type PlannedWorkoutInsert = Omit<typeof t.plannedWorkouts.$inferInsert, "userId" | "id">;

export const workoutsRepo = {
  async range(db: DbOrTx, userId: string, from: string, to: string): Promise<PlannedWorkoutRow[]> {
    return db
      .select()
      .from(t.plannedWorkouts)
      .where(
        and(
          eq(t.plannedWorkouts.userId, userId),
          isNull(t.plannedWorkouts.removedAt),
          gte(t.plannedWorkouts.date, from),
          lte(t.plannedWorkouts.date, to),
        ),
      )
      .orderBy(asc(t.plannedWorkouts.date), asc(t.plannedWorkouts.createdAt));
  },
  async fromDate(db: DbOrTx, userId: string, from: string): Promise<PlannedWorkoutRow[]> {
    return db
      .select()
      .from(t.plannedWorkouts)
      .where(and(eq(t.plannedWorkouts.userId, userId), isNull(t.plannedWorkouts.removedAt), gte(t.plannedWorkouts.date, from)))
      .orderBy(asc(t.plannedWorkouts.date));
  },
  async byId(db: DbOrTx, userId: string, id: string): Promise<PlannedWorkoutRow | undefined> {
    const rows = await db
      .select()
      .from(t.plannedWorkouts)
      .where(and(eq(t.plannedWorkouts.userId, userId), eq(t.plannedWorkouts.id, id), isNull(t.plannedWorkouts.removedAt)))
      .limit(1);
    return rows[0];
  },
  async insertMany(db: DbOrTx, userId: string, rows: PlannedWorkoutInsert[]): Promise<PlannedWorkoutRow[]> {
    if (rows.length === 0) return [];
    return db
      .insert(t.plannedWorkouts)
      .values(rows.map((r) => ({ ...r, userId })))
      .returning();
  },
  async reassignPlan(db: DbOrTx, userId: string, ids: string[], planId: string, workoutsById: Map<string, unknown>) {
    for (const id of ids) {
      await db
        .update(t.plannedWorkouts)
        .set({ planId, workout: workoutsById.get(id), updatedAt: new Date() })
        .where(and(eq(t.plannedWorkouts.userId, userId), eq(t.plannedWorkouts.id, id)));
    }
  },
  async markRemoved(db: DbOrTx, userId: string, ids: string[]) {
    if (ids.length === 0) return;
    await db
      .update(t.plannedWorkouts)
      .set({ removedAt: new Date() })
      .where(and(eq(t.plannedWorkouts.userId, userId), inArray(t.plannedWorkouts.id, ids)));
  },
  async removed(db: DbOrTx, userId: string): Promise<PlannedWorkoutRow[]> {
    return db
      .select()
      .from(t.plannedWorkouts)
      .where(and(eq(t.plannedWorkouts.userId, userId), isNotNull(t.plannedWorkouts.removedAt)));
  },
  async hardDelete(db: DbOrTx, userId: string, ids: string[]) {
    if (ids.length === 0) return;
    await db
      .delete(t.plannedWorkouts)
      .where(and(eq(t.plannedWorkouts.userId, userId), inArray(t.plannedWorkouts.id, ids)));
  },
  async updateSink(
    db: DbOrTx,
    userId: string,
    id: string,
    v: { sinkState: unknown; rev?: number; deviceText?: string | null },
  ) {
    const set: Partial<typeof t.plannedWorkouts.$inferInsert> = { sinkState: v.sinkState, updatedAt: new Date() };
    if (v.rev !== undefined) set.rev = v.rev;
    if (v.deviceText !== undefined) set.deviceText = v.deviceText;
    await db
      .update(t.plannedWorkouts)
      .set(set)
      .where(and(eq(t.plannedWorkouts.userId, userId), eq(t.plannedWorkouts.id, id)));
  },
  async setStatus(db: DbOrTx, userId: string, id: string, status: "planned" | "skipped", skipReason: string | null) {
    await db
      .update(t.plannedWorkouts)
      .set({ status, skipReason, updatedAt: new Date() })
      .where(and(eq(t.plannedWorkouts.userId, userId), eq(t.plannedWorkouts.id, id)));
  },
};

// ── check-ins ────────────────────────────────────────────────────────────────────────────────────

export const checkinsRepo = {
  async insert(
    db: DbOrTx,
    userId: string,
    v: { type: string; date: string; workoutId: string | null; activityId: string | null; payload: unknown; planChanges: string[] },
  ): Promise<string> {
    const rows = await db
      .insert(t.checkins)
      .values({ userId, ...v })
      .returning({ id: t.checkins.id });
    return (rows[0] as { id: string }).id;
  },
  async range(db: DbOrTx, userId: string, from: string, to: string) {
    return db
      .select()
      .from(t.checkins)
      .where(and(eq(t.checkins.userId, userId), gte(t.checkins.date, from), lte(t.checkins.date, to)))
      .orderBy(asc(t.checkins.date));
  },
};

// ── push subscriptions ───────────────────────────────────────────────────────────────────────────

export const pushRepo = {
  async upsert(db: DbOrTx, userId: string, v: { endpoint: string; p256dh: string; auth: string; userAgent: string | null }) {
    // An endpoint belongs to one browser profile; re-subscribing moves it to the current user.
    await db
      .insert(t.pushSubscriptions)
      .values({ userId, ...v })
      .onConflictDoUpdate({ target: t.pushSubscriptions.endpoint, set: { userId, p256dh: v.p256dh, auth: v.auth, userAgent: v.userAgent } });
  },
  async deleteByEndpoint(db: DbOrTx, userId: string, endpoint: string) {
    await db
      .delete(t.pushSubscriptions)
      .where(and(eq(t.pushSubscriptions.userId, userId), eq(t.pushSubscriptions.endpoint, endpoint)));
  },
  async list(db: DbOrTx, userId: string): Promise<PushSubscriptionRow[]> {
    return db.select().from(t.pushSubscriptions).where(eq(t.pushSubscriptions.userId, userId));
  },
  async deleteById(db: DbOrTx, userId: string, id: string) {
    await db
      .delete(t.pushSubscriptions)
      .where(and(eq(t.pushSubscriptions.userId, userId), eq(t.pushSubscriptions.id, id)));
  },
  async markSuccess(db: DbOrTx, userId: string, id: string) {
    await db
      .update(t.pushSubscriptions)
      .set({ lastSuccessAt: new Date() })
      .where(and(eq(t.pushSubscriptions.userId, userId), eq(t.pushSubscriptions.id, id)));
  },
};
