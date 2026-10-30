/** Job handlers (spec §12.1). Each one is a thin wrapper over a service function. */
import { activitiesRepo, credentialsRepo, profileRepo, sessionsRepo, workoutsRepo, type PlannedWorkoutRow } from "../repo/index.js";
import type { PlannedWorkout } from "@paceo/engine";
import { localDate } from "../lib/time.js";
import { AppError } from "../http/errors.js";
import { syncUser } from "../services/sync.js";
import { pushUpcoming, resendMissing, sinkStateOf } from "../services/push-workouts.js";
import { generateAndStore, loadProfile, replanUser } from "../services/plan.js";
import { pushToUser, todayMessage } from "../services/notify.js";
import { PROVIDER } from "../services/connection.js";
import type { Services } from "../services/context.js";
import { dailyDue, syncDue } from "./dispatch.js";
import { JOB, type JobHandlers } from "./queue.js";

/**
 * The workout the morning push is about, or undefined when there's nothing to say: no workout
 * today (rest day), everything skipped, or today's sessions already logged (an activity of the
 * same sport today).
 */
export function morningWorkout(rows: readonly PlannedWorkoutRow[], sportsDoneToday: readonly string[]): PlannedWorkoutRow | undefined {
  const open = rows.filter((r) => r.status === "planned" && !sportsDoneToday.includes(r.sport));
  return open.find((r) => r.sport === "run") ?? open[0];
}

async function morningWorkoutFor(svc: Services, userId: string, today: string): Promise<PlannedWorkoutRow | undefined> {
  const rows = await workoutsRepo.range(svc.db, userId, today, today);
  if (rows.length === 0) return undefined;
  const done = (await activitiesRepo.list(svc.db, userId, today, today)).map((a) => a.sport);
  return morningWorkout(rows, done);
}

/** "Today's workout" push (§11.2). Quiet on rest days: no workout today → no push. */
export async function notifyToday(svc: Services, userId: string): Promise<number> {
  const profile = await loadProfile(svc, userId);
  if (!profile) return 0;
  const today = localDate(svc.clock(), profile.timezone);
  const first = await morningWorkoutFor(svc, userId, today);
  if (!first) return 0;
  const w = first.workout as PlannedWorkout;
  return pushToUser(svc, userId, todayMessage(w, profile.units, sinkStateOf(first).status === "pushed"));
}

export async function dispatchSync(svc: Services): Promise<number> {
  const now = svc.clock();
  const users = await credentialsRepo.systemActiveUsers(svc.db, PROVIDER);
  const tzs = new Map((await profileRepo.systemTimezones(svc.db)).map((r) => [r.userId, r.timezone]));
  let n = 0;
  for (const { userId } of users) {
    const due = syncDue(userId, now, tzs.get(userId) ?? "UTC");
    if (!due.due) continue;
    await svc.jobs.enqueue(
      JOB.syncUser,
      { userId, mode: "poll" },
      { singletonKey: `sync:${userId}`, singletonSeconds: 600, startAfterSeconds: due.startAfterSeconds },
    );
    n++;
  }
  return n;
}

export async function dispatchDaily(svc: Services, healthcheckPingUrl?: string): Promise<{ nightly: number; morning: number }> {
  const now = svc.clock();
  let nightly = 0;
  let morning = 0;
  for (const { userId, timezone } of await profileRepo.systemTimezones(svc.db)) {
    const night = dailyDue(now, timezone, svc.config.nightlyHour);
    if (night.due) {
      await svc.jobs.enqueue(JOB.nightlyUser, { userId }, { singletonKey: `nightly:${userId}:${night.localDate}`, singletonSeconds: 3600 });
      nightly++;
    }
    const am = dailyDue(now, timezone, svc.config.morningPushHour);
    // No workout today → no morning job at all (notifyToday checks again when it runs).
    if (am.due && (await morningWorkoutFor(svc, userId, am.localDate))) {
      await svc.jobs.enqueue(JOB.notifyToday, { userId }, { singletonKey: `today:${userId}:${am.localDate}`, singletonSeconds: 3600 });
      morning++;
    }
  }
  await sessionsRepo.systemDeleteExpired(svc.db, now);
  if (healthcheckPingUrl) {
    try {
      await fetch(healthcheckPingUrl, { method: "GET", signal: AbortSignal.timeout(10_000) });
    } catch (err) {
      svc.log.warn({ err: err instanceof Error ? err.message : String(err) }, "healthcheck ping failed");
    }
  }
  return { nightly, morning };
}

export function createHandlers(svc: Services, opts: { healthcheckPingUrl?: string } = {}): JobHandlers {
  return {
    [JOB.syncUser]: async (d) => {
      await syncUser(svc, d.userId, d.mode ?? "poll");
    },
    [JOB.pushWorkouts]: async (d) => {
      await pushUpcoming(svc, d.userId);
    },
    [JOB.replanUser]: async (d) => {
      if (d.reason === "profile_change") {
        try {
          await generateAndStore(svc, d.userId, "profile_change");
        } catch (err) {
          if (!(err instanceof AppError)) throw err;
          svc.log.warn({ userId: d.userId, code: err.code }, "replan after profile change skipped");
        }
        return;
      }
      await replanUser(svc, d.userId);
    },
    [JOB.nightlyUser]: async (d) => {
      // 7-day reconcile → replan (stub; pushes on change) → push window → re-send missing.
      await syncUser(svc, d.userId, "reconcile");
      await replanUser(svc, d.userId);
      await pushUpcoming(svc, d.userId);
      await resendMissing(svc, d.userId);
    },
    [JOB.resendMissing]: async (d) => {
      await resendMissing(svc, d.userId);
    },
    [JOB.notifyToday]: async (d) => {
      await notifyToday(svc, d.userId);
    },
    [JOB.dispatchSync]: async () => {
      await dispatchSync(svc);
    },
    [JOB.dispatchDaily]: async () => {
      await dispatchDaily(svc, opts.healthcheckPingUrl);
    },
  };
}
