/**
 * Completed-activity model (spec §3.9, §4.9, §10.1–10.2).
 * Activities arrive already deduplicated (§3.9 unique key, cross-source match) and in SI units.
 * Dates are the athlete's LOCAL calendar date (YYYY-MM-DD); the engine never reads the clock.
 */

/** Sport classes from the §10.2 cross-training table, plus running. */
export type ActivitySport =
  | "run"
  | "ride"
  | "swim"
  | "row" // rowing, erg, paddling, dragon boat, kayak, SUP
  | "elliptical" // elliptical, aqua jogging
  | "hike" // hiking, walking, rucking
  | "xc_ski"
  | "team_sport"
  | "hiit"
  | "climb"
  | "strength"
  | "yoga"
  | "other";

/** One 1 Hz sample (FIT record). Every channel is optional: sources differ. */
export interface ActivitySample {
  /** Seconds since activity start (elapsed, pauses included). */
  t: number;
  /** Device cumulative distance, m (§4.9: preferred over recomputed lat/lng). */
  distM?: number;
  altM?: number;
  speedMps?: number;
  hr?: number;
  tempC?: number;
  /** GPS horizontal accuracy, m. */
  accuracyM?: number;
}

/** A device lap. When the watch ran the structured workout, laps map 1:1 onto steps (§3.9). */
export interface ActivityLap {
  /** Seconds since activity start. */
  startS: number;
  /** Timer (moving) duration of the lap, s. Splits use Δdist/Δtime (§4.9). */
  durationS: number;
  distanceM: number;
  avgHr?: number;
}

export interface Activity {
  id: string;
  /** Local start date, YYYY-MM-DD. */
  date: string;
  sport: ActivitySport;
  distanceM: number;
  movingS: number;
  /** All-out race effort on a verified course. */
  isRace: boolean;
  /** Time trial (§4.2 path A); a planned TT workout matched to the run also counts. */
  isTimeTrial?: boolean;
  avgHr?: number;
  maxHr?: number;
  /** Session RPE (CR-10, ~30 min post-session, §10.1). Missing → the activity type's default. */
  srpe?: number;
  laps?: ActivityLap[];
  samples?: ActivitySample[];
  /** §4.7: GAP only with barometric altitude, outdoors. */
  altitudeSource?: "barometric" | "gps" | "none";
  environment?: "outdoor" | "track" | "treadmill";
  elevationGainM?: number;
  /** Wet-bulb globe temperature during the run (°C), from weather data (§4.8). */
  wbgtC?: number;
  /** Set by ingestion when GPS was unusable (tunnels, urban canyon, §4.9 long gaps). */
  gpsQuality?: "good" | "poor";
  /** Run/walk session: walk segments count as moving time (§4.9). */
  runWalk?: boolean;
  /** Cross-training only: intervals, race pieces, or the user marked it hard (§10.2). */
  hard?: boolean;
}

export interface CrossTrainingClass {
  /** Counts toward the "aerobic cross-training" R-BREAK column (§8). "if45" = only sessions ≥ 45 min. */
  aerobic: boolean | "if45";
  /** Default sRPE when the user didn't log one (§10.2, D). */
  srpe: { easy: number; hard: number };
  /** Always a hard day (§10.2: team sports, HIIT). */
  alwaysHard: boolean;
  /** sRPE at or above which the session is a hard day. */
  hardAtSrpe: number;
  /** Excluded from monotony (§10.2 yoga row). */
  excludeFromMonotony: boolean;
}

/** §10.2 cross-training table (all D). Running is listed for completeness (easy default sRPE 3). */
export const SPORT_CLASS: Record<ActivitySport, CrossTrainingClass> = {
  run: { aerobic: true, srpe: { easy: 3, hard: 7 }, alwaysHard: false, hardAtSrpe: 7, excludeFromMonotony: false },
  ride: { aerobic: true, srpe: { easy: 3, hard: 7 }, alwaysHard: false, hardAtSrpe: 7, excludeFromMonotony: false },
  swim: { aerobic: true, srpe: { easy: 3, hard: 7 }, alwaysHard: false, hardAtSrpe: 7, excludeFromMonotony: false },
  row: { aerobic: true, srpe: { easy: 4, hard: 7 }, alwaysHard: false, hardAtSrpe: 7, excludeFromMonotony: false },
  elliptical: { aerobic: true, srpe: { easy: 3, hard: 6 }, alwaysHard: false, hardAtSrpe: 7, excludeFromMonotony: false },
  hike: { aerobic: "if45", srpe: { easy: 2, hard: 5 }, alwaysHard: false, hardAtSrpe: 7, excludeFromMonotony: false },
  xc_ski: { aerobic: true, srpe: { easy: 4, hard: 7 }, alwaysHard: false, hardAtSrpe: 7, excludeFromMonotony: false },
  team_sport: { aerobic: false, srpe: { easy: 5, hard: 8 }, alwaysHard: true, hardAtSrpe: 0, excludeFromMonotony: false },
  hiit: { aerobic: false, srpe: { easy: 6, hard: 8 }, alwaysHard: true, hardAtSrpe: 0, excludeFromMonotony: false },
  climb: { aerobic: false, srpe: { easy: 4, hard: 7 }, alwaysHard: false, hardAtSrpe: 8, excludeFromMonotony: false },
  strength: { aerobic: false, srpe: { easy: 5, hard: 8 }, alwaysHard: false, hardAtSrpe: 8, excludeFromMonotony: false },
  yoga: { aerobic: false, srpe: { easy: 2, hard: 4 }, alwaysHard: false, hardAtSrpe: 11, excludeFromMonotony: true },
  // "Other / unknown": the user classifies it once (§10.2). Until then: not aerobic, moderate default.
  other: { aerobic: false, srpe: { easy: 4, hard: 7 }, alwaysHard: false, hardAtSrpe: 7, excludeFromMonotony: false },
};

export const AEROBIC_HIKE_MIN_S = 45 * 60;

/** True when the session counts toward the R-BREAK "aerobic cross-training" column (§8, §10.2). */
export function isAerobicCrossTraining(a: Pick<Activity, "sport" | "movingS">): boolean {
  if (a.sport === "run") return false;
  const c = SPORT_CLASS[a.sport].aerobic;
  return c === "if45" ? a.movingS >= AEROBIC_HIKE_MIN_S : c;
}

/** sRPE used for load: the logged value, else the type's default (§10.1 "default to expected_srpe"). */
export function effectiveSrpe(a: Pick<Activity, "sport" | "srpe" | "hard">, expectedSrpe?: number): number {
  if (a.srpe !== undefined) return a.srpe;
  if (expectedSrpe !== undefined) return expectedSrpe;
  const c = SPORT_CLASS[a.sport];
  return a.hard || c.alwaysHard ? c.srpe.hard : c.srpe.easy;
}

/** total_load contribution, AU = sRPE × minutes (§10.1). */
export function sessionLoad(a: Pick<Activity, "sport" | "srpe" | "hard" | "movingS">, expectedSrpe?: number): number {
  return effectiveSrpe(a, expectedSrpe) * (a.movingS / 60);
}

/** Hard day for §7.1 adjacency (§10.2). */
export function isHardDay(a: Pick<Activity, "sport" | "srpe" | "hard">): boolean {
  const c = SPORT_CLASS[a.sport];
  return c.alwaysHard || a.hard === true || (a.srpe ?? 0) >= c.hardAtSrpe;
}

/** Deterministic order: by date, then id. */
export function sortActivities<T extends Pick<Activity, "date" | "id">>(acts: readonly T[]): T[] {
  return [...acts].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export function isRun(a: Pick<Activity, "sport">): boolean {
  return a.sport === "run";
}
