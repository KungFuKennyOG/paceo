/** Load .env from the current directory (or the repo's deploy/.env) for CLI use, if present. */
import { existsSync } from "node:fs";

export function loadDotEnv(): void {
  for (const p of [".env", "../../deploy/.env", "deploy/.env"]) {
    if (existsSync(p)) {
      try {
        process.loadEnvFile(p);
      } catch {
        /* ignore malformed file; env vars may already be set */
      }
      return;
    }
  }
}

export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing ${name}. Set it in the environment or in .env.`);
    process.exit(1);
  }
  return v;
}
