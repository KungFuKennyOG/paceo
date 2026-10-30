/**
 * Taper (spec §6.8). Lengths (T1) and volume multipliers (T2) at the midpoint of each spec range.
 */
import type { GoalDistance, Level } from "./plan-types.js";

/** Marathon taper drops to 2 weeks when the peak week is under this (T1, E/C). */
export const MARATHON_SHORT_TAPER_PEAK_KM = 50;

/**
 * T1 length in whole weeks. Weeks are 7-day blocks ending on race day, so 10K (7–10 d) and
 * 5K (5–7 d) both round to the 7-day minimum (R-RACE-1). Beginners' first races are 7 days.
 */
export function taperWeeks(distance: GoalDistance, level: Level, projectedPeakKm: number): number {
  if (level === "beginner") return 1;
  switch (distance) {
    case "marathon":
      return projectedPeakKm < MARATHON_SHORT_TAPER_PEAK_KM ? 2 : 3;
    case "half":
      return 2;
    case "10k":
    case "5k":
      return 1;
  }
}

/**
 * T2 multipliers vs the peak week, last entry = race week (excluding the race), strictly decreasing.
 * Keyed by taper length rather than distance, so a 2-week marathon taper uses the 2-week (HM) row (D).
 *   3 wk: 0.80–0.85 / 0.65–0.70 / 0.40–0.50 → 0.825 / 0.675 / 0.45
 *   2 wk: 0.70–0.75 / 0.45–0.55            → 0.725 / 0.50
 *   1 wk: 0.55–0.65                         → 0.60
 */
const MULTIPLIERS: Record<number, readonly number[]> = {
  1: [0.6],
  2: [0.725, 0.5],
  3: [0.825, 0.675, 0.45],
};

export function taperMultipliers(weeks: number): readonly number[] {
  const m = MULTIPLIERS[weeks];
  if (!m) throw new RangeError(`no taper multipliers for ${weeks} weeks`);
  return m;
}

/**
 * T3: long run during the taper as a fraction of the peak long run, by weeks before the race
 * (1 = race week, which has the race instead of a long run). −2 weeks ≈ 50–60% → 0.55 (C);
 * −3 weeks 0.80 is D (≈ that week's 0.825 volume multiplier).
 */
export function taperLongRunFraction(weeksOut: number): number {
  if (weeksOut >= 3) return 0.8;
  if (weeksOut === 2) return 0.55;
  return 0;
}

/** T3: quality in the taper keeps intensity at goal pace with 30–50% less work → 0.6. */
export const TAPER_QUALITY_WORK_FRACTION = 0.6;

/** T3: last hard session before the race, in days. */
export function lastHardSessionDays(distance: GoalDistance): { min: number; max: number } {
  return distance === "marathon" || distance === "half" ? { min: 7, max: 10 } : { min: 4, max: 6 };
}
