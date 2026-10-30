/**
 * Job queue abstraction. Production uses pg-boss (./boss.ts); tests use InlineQueue, which runs the
 * handler immediately so a request's side effects (e.g. the 14-day push) are visible right away.
 */
export const JOB = {
  /** Poll one user's intervals.icu activities (§3.2 sync strategy). */
  syncUser: "sync-user",
  /** Bulk-upsert the next 14 days to the user's sink; delete removed events; read back. */
  pushWorkouts: "push-workouts",
  /** Regenerate from today (stub until engine replan() lands). */
  replanUser: "replan-user",
  /** Nightly per user: 7-day reconcile → replan → push → re-send missing (next 3 d). */
  nightlyUser: "nightly-user",
  /** Re-send workouts in the next 3 days that are missing on read-back (§3.7). */
  resendMissing: "resend-missing",
  /** "Today's workout" web push (§11.2). */
  notifyToday: "notify-today",
  /** Cron: fan out per-user sync (every 5 min, each user every 15 min, staggered). */
  dispatchSync: "dispatch-sync",
  /** Cron: fan out per-user nightly and morning jobs by user-local time (every 15 min). */
  dispatchDaily: "dispatch-daily",
} as const;

export type JobName = (typeof JOB)[keyof typeof JOB];

export interface UserJobData {
  userId: string;
  /** sync-user: "poll" (default) or "reconcile" (last 7 days) or "setup" (last 120 days). */
  mode?: "poll" | "reconcile" | "setup";
  /** replan-user: why. */
  reason?: string;
}

export interface EnqueueOptions {
  /** Dedupe key; at most one queued job per key within singletonSeconds. */
  singletonKey?: string;
  singletonSeconds?: number;
  startAfterSeconds?: number;
}

export interface JobQueue {
  enqueue(name: JobName, data: UserJobData, opts?: EnqueueOptions): Promise<string | null>;
}

export type JobHandler = (data: UserJobData) => Promise<void>;
export type JobHandlers = Partial<Record<JobName, JobHandler>>;

/** Runs handlers synchronously in-process (tests, scripts). Records every call. */
export class InlineQueue implements JobQueue {
  readonly calls: Array<{ name: JobName; data: UserJobData }> = [];
  private handlers: JobHandlers = {};
  private seq = 0;
  constructor(private readonly run = true) {}

  setHandlers(h: JobHandlers) {
    this.handlers = h;
  }

  async enqueue(name: JobName, data: UserJobData): Promise<string | null> {
    this.calls.push({ name, data });
    const h = this.handlers[name];
    if (this.run && h) await h(data);
    return `inline-${++this.seq}`;
  }
}
