/** pg-boss against real Postgres: queues are created, cron is registered, a job is worked. */
import { afterAll, describe, expect, it } from "vitest";
import { startBoss, type BossRuntime } from "../../src/jobs/boss.js";
import { JOB, type UserJobData } from "../../src/jobs/queue.js";
import { silentLogger } from "../../src/services/context.js";
import { TEST_DATABASE_URL } from "../helpers/integration.js";

describe.skipIf(!TEST_DATABASE_URL)("pg-boss runtime", () => {
  let rt: BossRuntime | undefined;
  afterAll(async () => {
    await rt?.stop();
  });

  it("creates queues and works a job", async () => {
    rt = await startBoss(TEST_DATABASE_URL as string, silentLogger);
    let resolve: (d: UserJobData) => void = () => {};
    const got = new Promise<UserJobData>((r) => {
      resolve = r;
    });
    await rt.startWorkers({ [JOB.pushWorkouts]: async (d) => resolve(d) });
    for (const name of Object.values(JOB)) expect(await rt.boss.getQueue(name)).not.toBeNull();
    const id = await rt.queue.enqueue(JOB.pushWorkouts, { userId: "u-test" }, { singletonKey: "push:u-test", singletonSeconds: 30 });
    expect(id).toBeTruthy();
    const data = await Promise.race([
      got,
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("job not worked within 20 s")), 20_000)),
    ]);
    expect(data.userId).toBe("u-test");
  });
});
