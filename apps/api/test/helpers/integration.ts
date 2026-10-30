/** Integration harness: real Postgres (TEST_DATABASE_URL), fake intervals.icu, inline job queue. */
import { randomBytes } from "node:crypto";
import pg from "pg";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { buildApp } from "../../src/app.js";
import { createDatabase, type Database } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { createSecretBox } from "../../src/crypto/secretbox.js";
import { IntervalsError } from "../../src/integrations/intervals/client.js";
import type { IntervalsAccount, SinkEvent, SinkWorkout, SourceActivity } from "../../src/integrations/types.js";
import { engineExplainer } from "../../src/plan/explain.js";
import { InlineQueue } from "../../src/jobs/queue.js";
import { createHandlers } from "../../src/jobs/handlers.js";
import { silentLogger, type Services } from "../../src/services/context.js";
import type { PushSender } from "../../src/services/notify.js";

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

export async function resetDatabase(url: string): Promise<void> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query("drop schema if exists public cascade");
    await client.query("drop schema if exists drizzle cascade");
    await client.query("drop schema if exists pgboss cascade");
    await client.query("create schema public");
  } finally {
    await client.end();
  }
}

export const GOOD_KEY = "good-key-0123456789";
export const BAD_KEY = "bad-key-0123456789";

/** In-memory intervals.icu account: calendar keyed by external_id. */
export class FakeIntervals {
  calendar = new Map<string, SinkEvent & { description: string; sport: string }>();
  upserts: SinkWorkout[][] = [];
  deletes: string[][] = [];
  activities: SourceActivity[] = [];
  hiddenStrava = 0;
  private nextId = 1000;

  factory = (apiKey: string): IntervalsAccount => {
    const self = this;
    if (apiKey === BAD_KEY) {
      const fail = async (): Promise<never> => {
        throw new IntervalsError("auth", "GET /athlete/0: key not accepted (401)", 401);
      };
      return {
        verify: fail,
        source: { provider: "intervals_icu", listActivities: fail, getActivityDetail: fail, getOriginalFile: fail },
        sink: { provider: "intervals_icu", upsertWorkouts: fail, deleteWorkouts: fail, listEvents: fail },
      };
    }
    return {
      verify: async () => ({ id: "i42", name: "Test Athlete" }),
      source: {
        provider: "intervals_icu",
        async listActivities(oldest, newest) {
          return {
            activities: self.activities.filter((a) => a.localDate >= oldest && a.localDate <= newest),
            hiddenStravaCount: self.hiddenStrava,
          };
        },
        async getActivityDetail(id) {
          return self.activities.find((a) => a.sourceId === id) ?? null;
        },
        async getOriginalFile() {
          return null;
        },
      },
      sink: {
        provider: "intervals_icu",
        async upsertWorkouts(ws) {
          self.upserts.push(ws);
          for (const w of ws) {
            const prev = self.calendar.get(w.externalId);
            self.calendar.set(w.externalId, {
              eventId: prev?.eventId ?? String(self.nextId++),
              externalId: w.externalId,
              date: w.date,
              name: w.name,
              description: w.description,
              sport: w.sport,
            });
          }
        },
        async deleteWorkouts(ids) {
          self.deletes.push(ids);
          for (const id of ids) self.calendar.delete(id);
        },
        async listEvents(oldest, newest) {
          return [...self.calendar.values()]
            .filter((e) => e.date >= oldest && e.date <= newest)
            .map(({ eventId, externalId, date, name }) => ({ eventId, externalId, date, name }));
        },
      },
    };
  };
}

export class FakePush implements PushSender {
  sent: Array<{ endpoint: string; title: string }> = [];
  async send(target: { endpoint: string }, payload: { title: string }) {
    this.sent.push({ endpoint: target.endpoint, title: payload.title });
    return { ok: true } as const;
  }
}

export interface Harness {
  app: FastifyInstance;
  svc: Services;
  queue: InlineQueue;
  fake: FakeIntervals;
  push: FakePush;
  database: Database;
  close(): Promise<void>;
}

export async function startHarness(url: string): Promise<Harness> {
  await resetDatabase(url);
  const database = createDatabase(url, { max: 4 });
  await runMigrations(database);
  const fake = new FakeIntervals();
  const queue = new InlineQueue(true);
  const push = new FakePush();
  const svc: Services = {
    db: database.db,
    secretBox: createSecretBox({ 1: randomBytes(32) }, 1),
    intervals: fake.factory,
    jobs: queue,
    clock: () => new Date(),
    push,
    explainer: engineExplainer,
    config: {
      cookieSecure: false,
      sessionTtlDays: 30,
      publicUrl: "http://localhost:3000",
      vapidPublicKey: "BTestVapidPublicKey",
      morningPushHour: 7,
      nightlyHour: 3,
    },
    log: silentLogger,
  };
  queue.setHandlers(createHandlers(svc));
  const app = await buildApp({ services: svc, sessionSecret: "x".repeat(48), webDistDir: null });
  return {
    app,
    svc,
    queue,
    fake,
    push,
    database,
    async close() {
      await app.close();
      await database.close();
    },
  };
}

export function sessionCookie(res: LightMyRequestResponse): string {
  const c = res.cookies.find((x) => x.name === "paceo_session");
  if (!c) throw new Error(`no session cookie (status ${res.statusCode}: ${res.body})`);
  return c.value;
}

export function multipartFile(field: string, filename: string, bytes: Buffer) {
  const boundary = `----paceo${randomBytes(8).toString("hex")}`;
  const payload = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
    ),
    bytes,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { payload, headers: { "content-type": `multipart/form-data; boundary=${boundary}` } };
}
