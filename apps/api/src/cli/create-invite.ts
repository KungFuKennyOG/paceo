/**
 * Prints a single-use invite code (valid 7 days). Bootstraps the first admin: the first account
 * registered on an empty database becomes admin.
 *   pnpm --filter @paceo/api admin:create-invite
 *   docker compose exec api node dist/cli/create-invite.js
 */
import { createDatabase } from "../db/client.js";
import { runMigrations } from "../db/migrate.js";
import { createInvite } from "../services/auth.js";
import { usersRepo } from "../repo/index.js";
import { loadDotEnv, requireEnv } from "./env-file.js";

loadDotEnv();
const database = createDatabase(requireEnv("DATABASE_URL"), { max: 2 });
try {
  await runMigrations(database);
  const users = await usersRepo.count(database.db);
  const { code, expiresAt } = await createInvite(database.db, null, new Date());
  console.log(`Invite code: ${code}`);
  console.log(`Expires:     ${expiresAt.toISOString()}`);
  if (users === 0) console.log("No users yet: whoever registers with this code becomes the admin.");
} finally {
  await database.close();
}
