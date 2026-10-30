import { defineConfig } from "drizzle-kit";

// `pnpm --filter @paceo/api db:generate` writes a new SQL migration into ./drizzle after a schema change.
// Migrations are applied at boot (src/db/migrate.ts), never by drizzle-kit push.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
});
