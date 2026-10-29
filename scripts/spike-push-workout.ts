/**
 * Spike: does a pace workout pushed through intervals.icu arrive on the watch WITH pace targets?
 * (spec §3.7 and §14 — the biggest open risk before building the full app)
 *
 * Usage (from the repo root, on your own machine):
 *   1. cp .env.example .env   and paste your intervals.icu API key
 *      (intervals.icu → Settings → Developer Settings → API Key)
 *   2. pnpm spike:push                       push a test workout for tomorrow
 *      pnpm spike:push --pace 5:50-6:07      use your own pace range (min/km, slow-fast or fast-slow)
 *      pnpm spike:push --date 2026-11-02     pick the day
 *      pnpm spike:push --delete              remove the test workout again
 *   3. Open Garmin Connect (or COROS app) → calendar → check the workout, sync the watch,
 *      open the workout on the watch and check the interval steps show a PACE target.
 *
 * Nothing here is stored anywhere except your intervals.icu calendar.
 */
import { stepsToIntervalsText } from "../packages/engine/src/intervals-text.js";
import type { Step } from "../packages/engine/src/workout.js";

const BASE = "https://intervals.icu/api/v1";
const EXTERNAL_ID = "paceo-spike:1";

// ---------- args & env ----------
try {
  (process as unknown as { loadEnvFile?: (p?: string) => void }).loadEnvFile?.(".env");
} catch {
  /* no .env file; fall back to the shell environment */
}
const key = process.env.INTERVALS_API_KEY?.trim();
if (!key) {
  console.error("Missing INTERVALS_API_KEY. Copy .env.example to .env and paste your key.");
  process.exit(1);
}

const args = process.argv.slice(2);
const argValue = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const wantDelete = args.includes("--delete");

function parseMinSec(s: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) throw new Error(`Bad pace "${s}", expected m:ss`);
  return Number(m[1]) * 60 + Number(m[2]);
}
function parsePaceRange(s: string): { fast: number; slow: number } {
  const [a, b] = s.split("-").map(parseMinSec);
  if (a === undefined || b === undefined) throw new Error(`Bad pace range "${s}", expected m:ss-m:ss`);
  return { fast: Math.min(a, b), slow: Math.max(a, b) };
}
function localDate(offsetDays: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const pace = parsePaceRange(argValue("--pace") ?? "6:00-6:30");
const date = argValue("--date") ?? localDate(1);

// ---------- http ----------
const headers = {
  Authorization: "Basic " + Buffer.from(`API_KEY:${key}`).toString("base64"),
  "Content-Type": "application/json",
  Accept: "application/json",
  // intervals.icu sits behind Cloudflare, which may challenge default library user agents (spec §3.2)
  "User-Agent": "Mozilla/5.0 (Paceo spike; personal use)",
};

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(BASE + path, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${method} ${path} → ${res.status} ${res.statusText}\n${text.slice(0, 500)}`);
  }
  return (text ? JSON.parse(text) : undefined) as T;
}

// ---------- main ----------
async function main() {
  // 1. Key check + who am I
  const athlete = await api<Record<string, unknown>>("GET", "/athlete/0");
  console.log(`✓ API key works for athlete: ${String(athlete.name ?? athlete.id)}`);

  // 2. Threshold pace check (pace targets arrive as "No Target" on Garmin without it — spec §3.2)
  const sportSettings = (athlete.sportSettings ?? []) as Array<Record<string, unknown>>;
  const run = sportSettings.find((s) => Array.isArray(s.types) && (s.types as string[]).includes("Run"));
  if (!run) {
    console.warn("⚠ No Run sport settings found in intervals.icu.");
  } else {
    const thresholdKeys = Object.keys(run).filter((k) => /threshold|pace/i.test(k));
    console.log("Run settings (pace-related fields):", Object.fromEntries(thresholdKeys.map((k) => [k, run[k]])));
    console.log("  → If threshold pace is empty, set it in intervals.icu → Settings → Run before testing.");
  }

  if (wantDelete) {
    await api("PUT", "/athlete/0/events/bulk-delete", [{ external_id: EXTERNAL_ID }]);
    console.log(`✓ Deleted test workout (${EXTERNAL_ID}).`);
    return;
  }

  // 3. Build a small test workout with the engine's own compiler
  const steps: Step[] = [
    { kind: "warmup", duration: { type: "time", s: 600 }, target: { type: "hr_pct_max", lo: 65, hi: 79 } },
    {
      kind: "repeat",
      count: 3,
      steps: [
        { kind: "work", duration: { type: "time", s: 180 }, target: { type: "pace", lo_s_per_km: pace.fast, hi_s_per_km: pace.slow } },
        { kind: "recovery", duration: { type: "time", s: 120 }, target: { type: "open" } },
      ],
    },
    { kind: "work", duration: { type: "distance", m: 1000 }, target: { type: "pace", lo_s_per_km: pace.fast, hi_s_per_km: pace.slow } },
    { kind: "cooldown", duration: { type: "time", s: 600 }, target: { type: "open" } },
  ];
  const description = stepsToIntervalsText(steps);
  console.log(`\nWorkout text sent to intervals.icu:\n---\n${description}\n---`);

  // 4. Upsert it
  await api("POST", "/athlete/0/events/bulk?upsert=true", [
    {
      category: "WORKOUT",
      start_date_local: `${date}T00:00:00`,
      type: "Run",
      name: "Paceo test — pace targets",
      description,
      external_id: EXTERNAL_ID,
    },
  ]);
  console.log(`✓ Pushed test workout for ${date}.`);

  // 5. Read it back to see how intervals.icu parsed the text
  const events = await api<Array<Record<string, unknown>>>(
    "GET",
    `/athlete/0/events?oldest=${date}&newest=${date}`,
  );
  const mine = events.find((e) => e.external_id === EXTERNAL_ID || e.name === "Paceo test — pace targets");
  if (!mine) {
    console.warn("⚠ Could not find the event on read-back.");
    return;
  }
  console.log(`\nRead back: event id ${String(mine.id)}`);
  const doc = mine.workout_doc as { steps?: unknown[] } | undefined;
  if (doc?.steps) {
    console.log("Parsed steps (workout_doc):");
    console.log(JSON.stringify(doc.steps, null, 2).slice(0, 3000));
  } else {
    console.log("No workout_doc returned. Raw event keys:", Object.keys(mine).join(", "));
  }

  console.log(`
Next:
  1. intervals.icu calendar → open the workout → do the steps show pace ranges?
  2. Garmin Connect / COROS app → calendar on ${date} → is the workout there?
     (Garmin needs "Upload planned workouts" ON in intervals.icu → Settings → Garmin.)
  3. Sync the watch → open the workout → do the 3-min reps show a PACE target, not "No Target"?
  Clean up afterwards with:  pnpm spike:push --delete
`);
}

main().catch((err) => {
  console.error("✗", err instanceof Error ? err.message : err);
  process.exit(1);
});
