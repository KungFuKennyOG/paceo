/**
 * Planned workout ↔ completed activity matching and status for the workout list (spec §3.9, §8).
 * Same rules as the engine's matcher (matchActivities in @paceo/engine, which the replanner uses on
 * the full history): local date + sport, completed at ≥ 80% of plan, measured by distance for
 * pace-prescribed runs and by duration for time/RPE and run/walk sessions. Per-step compliance from
 * laps is computed by the engine during replanning; rows here carry no laps.
 */
import { COMPLETED_MIN_RATIO, complianceMeasure, type WorkoutType } from "@paceo/engine";

export interface MatchableWorkout {
  id: string;
  date: string;
  sport: string;
  plannedMinutes: number;
  plannedRunM: number;
  /** When known, picks the engine's compliance measure (§8). */
  prescriptionMode?: "pace" | "time_rpe" | "run_walk" | undefined;
  type?: string | undefined;
}

export interface MatchableActivity {
  id: string;
  localDate: string;
  sport: string;
  movingS: number | null;
  distanceM: number | null;
}

function sportsMatch(workoutSport: string, activitySport: string): boolean {
  if (workoutSport === "run") return activitySport === "run";
  if (workoutSport === "strength") return activitySport === "strength";
  return workoutSport === activitySport;
}

/** Each activity matches at most one workout; on a day with several candidates the closest duration wins. */
export function matchActivities<W extends MatchableWorkout, A extends MatchableActivity>(
  workouts: readonly W[],
  activities: readonly A[],
): Map<string, A> {
  const used = new Set<string>();
  const out = new Map<string, A>();
  for (const w of workouts) {
    const candidates = activities.filter((a) => !used.has(a.id) && a.localDate === w.date && sportsMatch(w.sport, a.sport));
    if (candidates.length === 0) continue;
    const target = w.plannedMinutes * 60;
    candidates.sort((a, b) => Math.abs((a.movingS ?? 0) - target) - Math.abs((b.movingS ?? 0) - target));
    const best = candidates[0] as A;
    used.add(best.id);
    out.set(w.id, best);
  }
  return out;
}

export type DerivedStatus = "planned" | "completed" | "partial" | "missed" | "skipped";

/** Completion as a fraction of planned duration (or distance when duration is unknown). */
export function compliance(w: MatchableWorkout, a: MatchableActivity): number | null {
  if (w.prescriptionMode !== undefined && w.type !== undefined && w.sport === "run") {
    const by = complianceMeasure({ prescription_mode: w.prescriptionMode, type: w.type as WorkoutType });
    if (by === "distance" && w.plannedRunM > 0 && a.distanceM !== null) return a.distanceM / w.plannedRunM;
    if (by === "duration" && w.plannedMinutes > 0 && a.movingS !== null) return a.movingS / (w.plannedMinutes * 60);
  }
  if (w.plannedMinutes > 0 && a.movingS !== null) return a.movingS / (w.plannedMinutes * 60);
  if (w.plannedRunM > 0 && a.distanceM !== null) return a.distanceM / w.plannedRunM;
  return null;
}

/** Green band starts at 80% (§8, TrainingPeaks); below that the session is partial. */
export function deriveStatus(
  stored: string,
  w: MatchableWorkout,
  match: MatchableActivity | undefined,
  today: string,
): DerivedStatus {
  if (stored === "skipped") return "skipped";
  if (match) {
    const c = compliance(w, match);
    return c === null || c >= COMPLETED_MIN_RATIO ? "completed" : "partial";
  }
  return w.date < today ? "missed" : "planned";
}
