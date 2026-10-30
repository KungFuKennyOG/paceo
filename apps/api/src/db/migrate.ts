/**
 * Apply drizzle-kit migrations (apps/api/drizzle) at boot, behind a Postgres advisory lock so two
 * containers starting together never race (spec §12.2).
 */
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import path from "node:path";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { Database } from "./client.js";

const LOCK_KEY = 815_200_1; // arbitrary, app-wide

/** Finds ./drizzle next to src/ (dev, tests) or next to dist/ (production bundle). */
export function defaultMigrationsFolder(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    process.env.PACEO_MIGRATIONS_DIR,
    path.resolve(here, "../../drizzle"),
    path.resolve(here, "../drizzle"),
    path.resolve(process.cwd(), "drizzle"),
  ].filter((p): p is string => typeof p === "string");
  for (const c of candidates) if (existsSync(path.join(c, "meta", "_journal.json"))) return c;
  throw new Error(`drizzle migrations folder not found (tried ${candidates.join(", ")})`);
}

export async function runMigrations(database: Database, migrationsFolder = defaultMigrationsFolder()): Promise<void> {
  const client = await database.pool.connect();
  try {
    await client.query("select pg_advisory_lock($1)", [LOCK_KEY]);
    await migrate(database.db, { migrationsFolder });
  } finally {
    try {
      await client.query("select pg_advisory_unlock($1)", [LOCK_KEY]);
    } finally {
      client.release();
    }
  }
}
