/**
 * pg-boss wiring (spec §2.6, §12.1): Postgres-backed queues in the `pgboss` schema, cron schedules,
 * retries with exponential backoff and a dead-letter queue. Runs in the API process.
 */
import { PgBoss } from "pg-boss";
import type { Logger } from "../services/context.js";
import { JOB, type EnqueueOptions, type JobHandlers, type JobName, type JobQueue, type UserJobData } from "./queue.js";

export const DEAD_LETTER_QUEUE = "dead-letter";

export const CRON = {
  [JOB.dispatchSync]: "*/5 * * * *",
  [JOB.dispatchDaily]: "*/15 * * * *",
} as const;

export interface BossRuntime {
  boss: PgBoss;
  queue: JobQueue;
  /** Start workers and cron schedules (call once handlers exist). */
  startWorkers(handlers: JobHandlers): Promise<void>;
  stop(): Promise<void>;
}

export async function startBoss(connectionString: string, log: Logger): Promise<BossRuntime> {
  const boss = new PgBoss({ connectionString, max: 4 });
  boss.on("error", (err: unknown) => log.error({ err: err instanceof Error ? err.message : String(err) }, "pg-boss error"));
  await boss.start();

  if (!(await boss.getQueue(DEAD_LETTER_QUEUE))) await boss.createQueue(DEAD_LETTER_QUEUE);
  for (const name of Object.values(JOB)) {
    if (await boss.getQueue(name)) continue;
    await boss.createQueue(name, {
      retryLimit: 3,
      retryDelay: 30,
      retryBackoff: true,
      expireInSeconds: 15 * 60,
      deadLetter: DEAD_LETTER_QUEUE,
    });
  }

  const queue: JobQueue = {
    async enqueue(name: JobName, data: UserJobData, opts: EnqueueOptions = {}) {
      const options: { singletonKey?: string; singletonSeconds?: number; startAfter?: number } = {};
      if (opts.singletonKey !== undefined) options.singletonKey = opts.singletonKey;
      if (opts.singletonSeconds !== undefined) options.singletonSeconds = opts.singletonSeconds;
      if (opts.startAfterSeconds !== undefined && opts.startAfterSeconds > 0) options.startAfter = opts.startAfterSeconds;
      return boss.send(name, { ...data }, options);
    },
  };

  return {
    boss,
    queue,
    async startWorkers(handlers) {
      for (const [name, handler] of Object.entries(handlers)) {
        if (!handler) continue;
        await boss.work<UserJobData>(name, async (jobs) => {
          for (const job of jobs) await handler(job.data);
        });
      }
      for (const [name, cron] of Object.entries(CRON)) {
        await boss.schedule(name, cron, { userId: "system" });
      }
    },
    async stop() {
      await boss.stop({ graceful: true, timeout: 15_000 });
    },
  };
}
