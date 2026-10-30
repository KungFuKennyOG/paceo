/**
 * Planned workout ↔ completed activity matching and status (spec §3.9, §8 compliance bands).
 * Simple local-date + sport matching for now.
 * TODO(engine-matcher): replace with the engine's matcher (laps → steps, per-step compliance).
 */
export interface MatchableWorkout {
  id: string;
  date: string;
  sport: string;
  plannedMinutes: number;
  plannedRunM: number;
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
    return c === null || c >= 0.8 ? "completed" : "partial";
  }
  return w.date < today ? "missed" : "planned";
}
