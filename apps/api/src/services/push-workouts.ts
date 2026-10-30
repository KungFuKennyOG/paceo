/**
 * Workout delivery through the user's WorkoutSink (spec §3.2 push strategy, §3.7 re-send, §11.3).
 * external_id = "{user_id}:{planned_workout_id}:{rev}"; a re-send deletes the event and upserts with
 * rev + 1, which forces a new event id and a fresh vendor upload.
 */
import { addDays, stepsToIntervalsText, toIntervalsEvent, type PlannedWorkout } from "@paceo/engine";
import { workoutsRepo, type PlannedWorkoutRow } from "../repo/index.js";
import { AppError } from "../http/errors.js";
import type { SinkWorkout, WorkoutSink } from "../integrations/types.js";
import { localDate } from "../lib/time.js";
import { getAccount, recordAdapterError, userTimezone } from "./connection.js";
import { pushToUser } from "./notify.js";
import { EMPTY_SINK } from "./plan.js";
import type { Services } from "./context.js";

export const PUSH_DAYS = 14;
export const RESEND_DAYS = 3;

export interface SinkStateJson {
  provider: "intervals_icu" | null;
  externalId: string | null;
  eventId: string | null;
  lastPushedAt: string | null;
  status: "not_pushed" | "pushed" | "missing_on_readback" | "error";
}

export function externalId(userId: string, workoutId: string, rev: number): string {
  return `${userId}:${workoutId}:${rev}`;
}

export function sinkStateOf(row: PlannedWorkoutRow): SinkStateJson {
  const s = row.sinkState as Partial<SinkStateJson> | null;
  return { ...EMPTY_SINK, ...(s ?? {}) } as SinkStateJson;
}

export function toSinkWorkout(row: PlannedWorkoutRow, rev = row.rev): SinkWorkout {
  const w = row.workout as PlannedWorkout;
  const ev = toIntervalsEvent(w, rev);
  return {
    externalId: externalId(row.userId, row.id, rev),
    date: row.date,
    sport: w.sport,
    name: ev.name,
    description: ev.description,
  };
}

async function sinkFor(svc: Services, userId: string): Promise<WorkoutSink | null> {
  const acct = await getAccount(svc, userId);
  return acct ? acct.account.sink : null;
}

export interface PushSummary {
  pushed: number;
  deleted: number;
  missing: number;
  skipped?: "no_sink" | "error";
}

/** Bulk-upsert the next 14 days, delete removed/skipped events, then read back event ids (§3.2). */
export async function pushUpcoming(svc: Services, userId: string): Promise<PushSummary> {
  const sink = await sinkFor(svc, userId);
  if (!sink) return { pushed: 0, deleted: 0, missing: 0, skipped: "no_sink" };
  const today = localDate(svc.clock(), await userTimezone(svc, userId));
  const to = addDays(today, PUSH_DAYS - 1);
  try {
    // 1. Workouts dropped by a replan: delete remote events, then the rows.
    const removed = await workoutsRepo.removed(svc.db, userId);
    const removedRemote = removed.map((r) => sinkStateOf(r).externalId).filter((x): x is string => !!x);
    await sink.deleteWorkouts(removedRemote);
    await workoutsRepo.hardDelete(svc.db, userId, removed.map((r) => r.id));

    const rows = await workoutsRepo.range(svc.db, userId, today, to);
    // 2. Skipped workouts come off the watch calendar.
    const skipped = rows.filter((r) => r.status === "skipped" && sinkStateOf(r).externalId);
    await sink.deleteWorkouts(skipped.map((r) => sinkStateOf(r).externalId as string));
    for (const r of skipped) await workoutsRepo.updateSink(svc.db, userId, r.id, { sinkState: EMPTY_SINK });

    // 3. Upsert everything planned in the window.
    const planned = rows.filter((r) => r.status === "planned");
    const payload = planned.map((r) => toSinkWorkout(r));
    await sink.upsertWorkouts(payload);

    // 4. Read back and store event ids.
    const events = await sink.listEvents(today, to);
    const byExt = new Map(events.filter((e) => e.externalId).map((e) => [e.externalId as string, e.eventId]));
    const now = svc.clock().toISOString();
    let missing = 0;
    for (const [i, r] of planned.entries()) {
      const sw = payload[i] as SinkWorkout;
      const eventId = byExt.get(sw.externalId) ?? null;
      if (!eventId) missing++;
      await workoutsRepo.updateSink(svc.db, userId, r.id, {
        sinkState: {
          provider: "intervals_icu",
          externalId: sw.externalId,
          eventId,
          lastPushedAt: now,
          status: eventId ? "pushed" : "missing_on_readback",
        } satisfies SinkStateJson,
        deviceText: sw.description,
      });
    }
    return { pushed: planned.length, deleted: removedRemote.length + skipped.length, missing };
  } catch (err) {
    if (await recordAdapterError(svc, userId, err)) return { pushed: 0, deleted: 0, missing: 0, skipped: "error" };
    throw err;
  }
}

/** Re-send one workout (§3.7): delete by current external_id, upsert with rev + 1, read back. */
export async function resendWorkout(svc: Services, userId: string, workoutId: string): Promise<PlannedWorkoutRow> {
  const row = await workoutsRepo.byId(svc.db, userId, workoutId);
  if (!row) throw new AppError(404, "not_found", "Workout not found.");
  if (row.status === "skipped") throw new AppError(409, "workout_skipped", "This workout was skipped; un-skip it before re-sending.");
  const sink = await sinkFor(svc, userId);
  if (!sink) throw new AppError(409, "not_connected", "Connect intervals.icu to send workouts to your watch.");
  const current = sinkStateOf(row);
  const rev = row.rev + 1;
  const sw = toSinkWorkout(row, rev);
  try {
    if (current.externalId) await sink.deleteWorkouts([current.externalId]);
    await sink.upsertWorkouts([sw]);
    const events = await sink.listEvents(row.date, row.date);
    const eventId = events.find((e) => e.externalId === sw.externalId)?.eventId ?? null;
    await workoutsRepo.updateSink(svc.db, userId, row.id, {
      rev,
      deviceText: sw.description,
      sinkState: {
        provider: "intervals_icu",
        externalId: sw.externalId,
        eventId,
        lastPushedAt: svc.clock().toISOString(),
        status: eventId ? "pushed" : "missing_on_readback",
      } satisfies SinkStateJson,
    });
  } catch (err) {
    await recordAdapterError(svc, userId, err);
    await workoutsRepo.updateSink(svc.db, userId, row.id, { sinkState: { ...current, status: "error" } satisfies SinkStateJson });
    throw new AppError(502, "sink_error", "Couldn't reach intervals.icu to re-send this workout. Try again shortly.");
  }
  return (await workoutsRepo.byId(svc.db, userId, workoutId)) as PlannedWorkoutRow;
}

/** Nightly (§3.7): re-send workouts in the next 3 days whose event is missing on read-back. */
export async function resendMissing(svc: Services, userId: string): Promise<{ checked: number; resent: number; stillMissing: number }> {
  const sink = await sinkFor(svc, userId);
  if (!sink) return { checked: 0, resent: 0, stillMissing: 0 };
  const today = localDate(svc.clock(), await userTimezone(svc, userId));
  const to = addDays(today, RESEND_DAYS - 1);
  const rows = (await workoutsRepo.range(svc.db, userId, today, to)).filter((r) => r.status === "planned");
  if (rows.length === 0) return { checked: 0, resent: 0, stillMissing: 0 };
  let events;
  try {
    events = await sink.listEvents(today, to);
  } catch (err) {
    if (await recordAdapterError(svc, userId, err)) return { checked: rows.length, resent: 0, stillMissing: 0 };
    throw err;
  }
  const present = new Set(events.map((e) => e.externalId).filter(Boolean));
  let resent = 0;
  let stillMissing = 0;
  for (const r of rows) {
    const ext = sinkStateOf(r).externalId;
    if (ext && present.has(ext)) continue;
    try {
      const updated = await resendWorkout(svc, userId, r.id);
      resent++;
      if (sinkStateOf(updated).status !== "pushed") stillMissing++;
    } catch {
      stillMissing++;
    }
  }
  if (stillMissing > 0) {
    await pushToUser(svc, userId, {
      title: "Workout not on your watch",
      body: "A workout in the next few days didn't reach your calendar. Tap to re-send or follow it in the app.",
      url: "/plan",
      tag: "not-on-watch",
    });
  }
  return { checked: rows.length, resent, stillMissing };
}

/** Best effort before a disconnect: take future pushed workouts off the calendar. */
export async function removeUpcomingFromSink(svc: Services, userId: string): Promise<void> {
  const sink = await sinkFor(svc, userId);
  if (!sink) return;
  const today = localDate(svc.clock(), await userTimezone(svc, userId));
  const rows = await workoutsRepo.fromDate(svc.db, userId, today);
  const pushed = rows.filter((r) => sinkStateOf(r).externalId);
  try {
    await sink.deleteWorkouts(pushed.map((r) => sinkStateOf(r).externalId as string));
  } catch (err) {
    svc.log.warn({ userId, err: err instanceof Error ? err.message : String(err) }, "could not clear calendar on disconnect");
  }
  for (const r of pushed) await workoutsRepo.updateSink(svc.db, userId, r.id, { sinkState: EMPTY_SINK });
}

/** §2.5 step 8: a 10-min easy "Setup test" workout tomorrow with a known external_id. */
export function testWorkoutExternalId(userId: string): string {
  return `${userId}:setup-test:0`;
}

export async function sendTestWorkout(svc: Services, userId: string): Promise<{ externalId: string; date: string }> {
  const sink = await sinkFor(svc, userId);
  if (!sink) throw new AppError(409, "not_connected", "Connect intervals.icu first.");
  const date = addDays(localDate(svc.clock(), await userTimezone(svc, userId)), 1);
  const ext = testWorkoutExternalId(userId);
  try {
    await sink.upsertWorkouts([
      {
        externalId: ext,
        date,
        sport: "run",
        name: "Paceo setup test",
        description: stepsToIntervalsText([
          { kind: "work", duration: { type: "time", s: 600 }, target: { type: "hr_pct_max", lo: 65, hi: 79 } },
        ]),
      },
    ]);
  } catch (err) {
    await recordAdapterError(svc, userId, err);
    throw new AppError(502, "sink_error", "Couldn't send the test workout to intervals.icu.");
  }
  return { externalId: ext, date };
}

export async function deleteTestWorkout(svc: Services, userId: string): Promise<void> {
  const sink = await sinkFor(svc, userId);
  if (!sink) throw new AppError(409, "not_connected", "Connect intervals.icu first.");
  try {
    await sink.deleteWorkouts([testWorkoutExternalId(userId)]);
  } catch (err) {
    await recordAdapterError(svc, userId, err);
    throw new AppError(502, "sink_error", "Couldn't delete the test workout from intervals.icu.");
  }
}
