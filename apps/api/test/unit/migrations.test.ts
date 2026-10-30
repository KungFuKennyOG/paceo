/**
 * Guards hand-maintained migrations: the latest drizzle snapshot must describe exactly the tables,
 * columns and indexes in src/db/schema.ts, and every journal entry must have its SQL file. (The SQL
 * itself is exercised by the integration tests, which migrate a fresh Postgres.)
 */
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "../../src/db/schema.js";

const dir = new URL("../../drizzle/", import.meta.url);
const journal = JSON.parse(readFileSync(new URL("meta/_journal.json", dir), "utf8")) as { entries: Array<{ idx: number; tag: string }> };

interface SnapColumn {
  name: string;
  type: string;
  primaryKey: boolean;
  notNull: boolean;
}
interface SnapTable {
  name: string;
  columns: Record<string, SnapColumn>;
  indexes: Record<string, unknown>;
  compositePrimaryKeys: Record<string, { columns: string[] }>;
}

describe("drizzle migrations", () => {
  it("every journal entry has its SQL and snapshot, in order", () => {
    journal.entries.forEach((e, i) => {
      expect(e.idx).toBe(i);
      expect(existsSync(new URL(`${e.tag}.sql`, dir)), e.tag).toBe(true);
      expect(existsSync(new URL(`meta/${String(e.idx).padStart(4, "0")}_snapshot.json`, dir)), e.tag).toBe(true);
    });
  });

  it("the latest snapshot matches src/db/schema.ts", () => {
    const last = journal.entries[journal.entries.length - 1]!;
    const snap = JSON.parse(readFileSync(new URL(`meta/${String(last.idx).padStart(4, "0")}_snapshot.json`, dir), "utf8")) as {
      tables: Record<string, SnapTable>;
    };
    const tables = (Object.values(schema) as unknown[]).filter((v): v is PgTable => is(v, PgTable)).map((t) => getTableConfig(t));
    expect(Object.keys(snap.tables).sort()).toEqual(tables.map((t) => `public.${t.name}`).sort());
    for (const t of tables) {
      const s = snap.tables[`public.${t.name}`]!;
      const cols = Object.fromEntries(
        t.columns.map((c) => [c.name, { name: c.name, type: c.getSQLType(), primaryKey: c.primary, notNull: c.notNull }]),
      );
      const snapCols = Object.fromEntries(
        Object.values(s.columns).map((c) => [c.name, { name: c.name, type: c.type, primaryKey: c.primaryKey, notNull: c.notNull }]),
      );
      expect(snapCols, t.name).toEqual(cols);
      expect(Object.keys(s.indexes).sort(), t.name).toEqual(t.indexes.map((i) => i.config.name).sort());
      expect(Object.values(s.compositePrimaryKeys).map((p) => p.columns), t.name).toEqual(t.primaryKeys.map((p) => p.columns.map((c) => c.name)));
    }
  });
});
