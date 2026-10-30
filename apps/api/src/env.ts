/**
 * Environment, validated at boot (spec §12.2): the process refuses to start when a required secret
 * is missing or malformed. Every variable is documented in deploy/.env.example.
 */
import { z } from "zod";

const bool = z
  .enum(["true", "false", "1", "0", "yes", "no"])
  .transform((v) => v === "true" || v === "1" || v === "yes");

const base64Key32 = z
  .string()
  .refine((v) => Buffer.from(v.trim(), "base64").length === 32, "must be 32 bytes, base64 (openssl rand -base64 32)");

export const EnvSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    HOST: z.string().default("0.0.0.0"),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
    /** Public origin, e.g. https://paceo.example.com (links in push notifications). */
    PUBLIC_URL: z.string().url().default("http://localhost:3000"),

    DATABASE_URL: z.string().min(1),
    /** Signs the session cookie. ≥ 32 chars (openssl rand -base64 48). */
    SESSION_SECRET: z.string().min(32),
    /** AES-256-GCM master key for per-user secrets. 32 bytes, base64. */
    PACEO_ENCRYPTION_KEY: base64Key32,
    /** Optional previous key during rotation (decrypt-only), as "<version>:<base64>". */
    PACEO_ENCRYPTION_KEY_PREVIOUS: z.string().optional(),
    PACEO_ENCRYPTION_KEY_VERSION: z.coerce.number().int().min(1).default(1),
    /** Session lifetime in days. */
    SESSION_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(60),
    /** Overrides the Secure cookie flag (defaults to true in production). */
    COOKIE_SECURE: bool.optional(),

    /** Web push (VAPID). Required in production; `pnpm --filter @paceo/api vapid:generate` prints a pair. */
    VAPID_PUBLIC_KEY: z.string().optional(),
    VAPID_PRIVATE_KEY: z.string().optional(),
    VAPID_SUBJECT: z.string().default("mailto:admin@example.com"),

    /** Built PWA to serve (apps/web/dist). Ignored if the directory does not exist. */
    WEB_DIST_DIR: z.string().optional(),

    INTERVALS_BASE_URL: z.string().url().default("https://intervals.icu/api/v1"),
    /** Global intervals.icu token bucket (per-IP limit is 10 req/s; stay ≤ 5). */
    INTERVALS_RATE_PER_SEC: z.coerce.number().min(0.1).max(10).default(5),
    INTERVALS_USER_AGENT: z
      .string()
      .default("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 Paceo/0.1"),

    /** Run pg-boss workers and cron in this process. */
    JOBS_ENABLED: bool.default("true"),
    /** Local hour (0–23) for the daily "today's workout" push. */
    MORNING_PUSH_HOUR: z.coerce.number().int().min(0).max(23).default(7),
    /** Local hour for nightly reconcile / replan / re-send. */
    NIGHTLY_HOUR: z.coerce.number().int().min(0).max(23).default(3),
    /** Optional uptime ping (e.g. healthchecks.io) hit after the nightly jobs. */
    HEALTHCHECK_PING_URL: z.string().url().optional(),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === "production") {
      for (const k of ["VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY"] as const) {
        if (!env[k]) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [k], message: "required in production" });
      }
    }
  });

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const cleaned = Object.fromEntries(Object.entries(source).filter(([, v]) => v !== undefined && v !== ""));
  const parsed = EnvSchema.safeParse(cleaned);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`);
    throw new Error(`Invalid environment:\n${lines.join("\n")}`);
  }
  return parsed.data;
}

export function cookieSecure(env: Env): boolean {
  return env.COOKIE_SECURE ?? env.NODE_ENV === "production";
}
