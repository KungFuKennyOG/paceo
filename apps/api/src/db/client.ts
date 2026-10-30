import pg from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "./schema.js";

export type Db = NodePgDatabase<typeof schema>;

export interface Database {
  pool: pg.Pool;
  db: Db;
  close(): Promise<void>;
}

export function createDatabase(url: string, opts: { max?: number } = {}): Database {
  // Small pool: 10 users, one process; pg-boss keeps its own pool.
  const pool = new pg.Pool({ connectionString: url, max: opts.max ?? 8 });
  pool.on("error", () => {
    /* idle client errors are reported by the next query; avoid crashing the process */
  });
  const db = drizzle({ client: pool, schema });
  return {
    pool,
    db,
    close: () => pool.end(),
  };
}
