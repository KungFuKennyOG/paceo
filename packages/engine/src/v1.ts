/**
 * V1 single-run spike cap (spec §6.5, E-obs for distance; time variant, race exclusion and run/walk
 * handling are D):
 *   every planned run: distance ≤ 1.10 × max(single non-race run distance, prior 30 days)
 *   in time mode, also duration ≤ 1.10 × max non-race run duration, prior 30 days
 *   run/walk sessions count by total duration; races are excluded from the reference.
 *
 * The reference starts from the entered longest run (`longestRun30d`) and rolls forward with the
 * planned runs. The entered run is dated yesterday (it is "within the last 30 days"; we don't know
 * when). If the window holds no distance-bearing run (e.g. only run/walk), the
 * entered run stays the reference (D: "with no history, the reference is the entered longest run").
 */

export const V1_FACTOR = 1.1;
export const V1_WINDOW_DAYS = 30;
/** Rounding slack so 100 m / whole-minute rounding never reads as a breach. */
const EPS = 1e-6;

export interface RunRecord {
  day: number;
  /** Running km; undefined for run/walk (duration only). */
  km?: number;
  minutes: number;
}

export interface V1Seed {
  day: number;
  km: number;
  minutes: number;
}

export interface V1Reference {
  km: number;
  minutes: number;
}

/** Max non-race run in [day − 30, day − 1]. */
export function v1Reference(history: readonly RunRecord[], seed: V1Seed, day: number): V1Reference {
  const inWindow = (d: number) => d >= day - V1_WINDOW_DAYS && d < day;
  let km = inWindow(seed.day) ? seed.km : 0;
  let minutes = inWindow(seed.day) ? seed.minutes : 0;
  let anyKm = km > 0;
  for (const r of history) {
    if (!inWindow(r.day)) continue;
    minutes = Math.max(minutes, r.minutes);
    if (r.km !== undefined) {
      km = Math.max(km, r.km);
      anyKm = true;
    }
  }
  if (!anyKm) km = seed.km;
  if (minutes === 0) minutes = seed.minutes;
  return { km, minutes };
}

export interface V1Limit {
  /** Max km for this run. */
  km: number;
  /** Max minutes, or Infinity when the time variant doesn't apply. */
  minutes: number;
}

export function v1Limit(ref: V1Reference, timeMode: boolean): V1Limit {
  return { km: V1_FACTOR * ref.km, minutes: timeMode ? V1_FACTOR * ref.minutes : Infinity };
}

/** `runWalk` sessions are checked by total duration only. */
export function v1Ok(km: number, minutes: number, limit: V1Limit, runWalk = false): boolean {
  const minuteLimit = runWalk && !Number.isFinite(limit.minutes) ? Infinity : limit.minutes;
  return (runWalk || km <= limit.km + EPS) && minutes <= minuteLimit + EPS;
}

export function v1Trace(km: number, limit: V1Limit): string {
  return `V1:ok(${km.toFixed(1)}<=${limit.km.toFixed(1)})`;
}

/** What V1 records for a planned run: run/walk counts by total duration only. */
export function v1Measure(w: { type: string; planned: { run_m: number; minutes: number } }): Omit<RunRecord, "day"> {
  if (w.type === "RW") return { minutes: w.planned.minutes };
  return { km: w.planned.run_m / 1000, minutes: w.planned.minutes };
}
