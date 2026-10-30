/** Apply migrations and exit (the server also does this at boot). */
import { createDatabase } from "../db/client.js";
import { runMigrations } from "../db/migrate.js";
import { loadDotEnv, requireEnv } from "./env-file.js";

loadDotEnv();
const database = createDatabase(requireEnv("DATABASE_URL"), { max: 2 });
try {
  await runMigrations(database);
  console.log("Migrations applied.");
} finally {
  await database.close();
}
