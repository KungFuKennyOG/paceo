/**
 * Process entry: validate env → migrate (advisory lock) → pg-boss → Fastify. One container runs
 * the API, the workers and the cron dispatchers (spec §12.1).
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv, cookieSecure } from "./env.js";
import { createDatabase } from "./db/client.js";
import { runMigrations } from "./db/migrate.js";
import { createSecretBox, parseMasterKey } from "./crypto/secretbox.js";
import { TokenBucket } from "./integrations/limiter.js";
import { intervalsAccountFactory } from "./integrations/intervals/account.js";
import { createDefaultExplainer } from "./plan/explain.js";
import { systemClock } from "./lib/time.js";
import { webPushSender } from "./services/notify.js";
import { silentLogger, type Logger, type Services } from "./services/context.js";
import { startBoss } from "./jobs/boss.js";
import { createHandlers } from "./jobs/handlers.js";
import { buildApp, LOG_REDACT } from "./app.js";

function secretKeys(env: ReturnType<typeof loadEnv>): Record<number, Buffer> {
  const keys: Record<number, Buffer> = { [env.PACEO_ENCRYPTION_KEY_VERSION]: parseMasterKey(env.PACEO_ENCRYPTION_KEY) };
  if (env.PACEO_ENCRYPTION_KEY_PREVIOUS) {
    const [v, k] = env.PACEO_ENCRYPTION_KEY_PREVIOUS.split(":");
    if (v && k) keys[Number(v)] = parseMasterKey(k);
  }
  return keys;
}

async function main() {
  const env = loadEnv();
  const database = createDatabase(env.DATABASE_URL);
  await runMigrations(database);

  // Services log through Fastify's (redacting) logger once it exists.
  const logRef: { current: Logger } = { current: silentLogger };
  const log: Logger = {
    info: (o, m) => logRef.current.info(o, m),
    warn: (o, m) => logRef.current.warn(o, m),
    error: (o, m) => logRef.current.error(o, m),
  };

  const runtime = await startBoss(env.DATABASE_URL, log);
  const services: Services = {
    db: database.db,
    secretBox: createSecretBox(secretKeys(env), env.PACEO_ENCRYPTION_KEY_VERSION),
    intervals: intervalsAccountFactory({
      baseUrl: env.INTERVALS_BASE_URL,
      userAgent: env.INTERVALS_USER_AGENT,
      limiter: new TokenBucket({ ratePerSec: env.INTERVALS_RATE_PER_SEC }),
    }),
    jobs: runtime.queue,
    clock: systemClock,
    push:
      env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY
        ? webPushSender({ publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY, subject: env.VAPID_SUBJECT })
        : null,
    explainer: createDefaultExplainer(),
    config: {
      cookieSecure: cookieSecure(env),
      sessionTtlDays: env.SESSION_TTL_DAYS,
      publicUrl: env.PUBLIC_URL,
      vapidPublicKey: env.VAPID_PUBLIC_KEY ?? null,
      morningPushHour: env.MORNING_PUSH_HOUR,
      nightlyHour: env.NIGHTLY_HOUR,
    },
    log,
  };

  const here = path.dirname(fileURLToPath(import.meta.url));
  const app = await buildApp({
    services,
    sessionSecret: env.SESSION_SECRET,
    webDistDir: env.WEB_DIST_DIR ?? path.resolve(here, "../../web/dist"),
    logger: { level: env.LOG_LEVEL, redact: { paths: LOG_REDACT, censor: "[redacted]" } },
  });
  logRef.current = app.log;

  if (env.JOBS_ENABLED) {
    await runtime.startWorkers(
      createHandlers(services, env.HEALTHCHECK_PING_URL ? { healthcheckPingUrl: env.HEALTHCHECK_PING_URL } : {}),
    );
  }

  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    app.log.info({ signal }, "shutting down");
    try {
      await app.close();
      await runtime.stop();
      await database.close();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  await app.listen({ host: env.HOST, port: env.PORT });
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
