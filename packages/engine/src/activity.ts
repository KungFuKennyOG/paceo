/**
 * Completed-activity model (spec §3.9, §4.9, §10.1–10.2).
 * Activities arrive already deduplicated (§3.9 unique key, cross-source match) and in SI units.
 * Dates are the athlete's LOCAL calendar date (YYYY-MM-DD); the engine never reads the clock.
 */
import { CROSS_TRAINING_TABLE, crossTrainingClass, HARD_HIKE_GAIN_M, HARD_HIKE_MIN, HARD_SRPE, HARD_SRPE_CLIMBING, type CrossTrainingClass, type CrossTrainingRow } from "./cross-training.js";
import { sessionLoad } from "./load.js";


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
  /** Raw activity name or intervals.icu sport type ("dragon boat", "VirtualRide"): refines the §10.2 class. */
  activity?: string;
}

/** ActivitySport → the §10.2 row in cross-training.ts (single source of the table). */
export const SPORT_TO_CLASS: Record<Exclude<ActivitySport, "run">, CrossTrainingClass> = {
  ride: "cycling",
  swim: "swimming",
  row: "rowing",
  elliptical: "elliptical",
  hike: "hiking",
  xc_ski: "xc_ski",
  team_sport: "team_sport",
  hiit: "hiit",
  climb: "climbing",
  strength: "strength_unknown",
  yoga: "yoga",
  other: "other",
};

/** §10.2 class of a non-run activity: its raw name when given (e.g. "dragon boat"), else its sport. */
export function activityClass(a: Pick<Activity, "sport" | "activity">): CrossTrainingRow | undefined {
  if (a.sport === "run") return undefined;
  const cls = a.activity !== undefined ? crossTrainingClass(a.activity) : SPORT_TO_CLASS[a.sport];
  return CROSS_TRAINING_TABLE[cls === "other" && a.activity !== undefined ? SPORT_TO_CLASS[a.sport] : cls];
}

/** True when the session counts toward the R-BREAK "aerobic cross-training" column (§8, §10.2). */
export function isAerobicCrossTraining(a: Pick<Activity, "sport" | "movingS" | "activity">): boolean {
  const row = activityClass(a);
  if (!row) return false;
  return row.aerobic === "if45" ? a.movingS >= AEROBIC_HIKE_MIN_S : row.aerobic === "yes";
}

export const AEROBIC_HIKE_MIN_S = 45 * 60;
/** Easy run default sRPE when nothing was logged or planned (§10.1, D). */
export const RUN_DEFAULT_SRPE = 3;

/** sRPE used for load: the logged value, else the planned expected sRPE, else the §10.2 default. */
export function effectiveSrpe(a: Pick<Activity, "sport" | "srpe" | "hard" | "activity">, expectedSrpe?: number): number {
  if (a.srpe !== undefined) return a.srpe;
  if (expectedSrpe !== undefined) return expectedSrpe;
  const row = activityClass(a);
  if (!row) return RUN_DEFAULT_SRPE;
  return a.hard || row.hardRule === "always" ? row.srpe[1] : row.srpe[0];
}

/** total_load contribution, AU = sRPE × minutes (§10.1, load.ts). */
export function activityLoad(a: Pick<Activity, "sport" | "srpe" | "hard" | "movingS" | "activity">, expectedSrpe?: number): number {
  return sessionLoad(effectiveSrpe(a, expectedSrpe), a.movingS / 60);
}

/** Hard day for §7.1 adjacency (§10.2). External lifting is never hard for running purposes. */
export function isHardDay(a: Pick<Activity, "sport" | "srpe" | "hard" | "activity" | "movingS" | "elevationGainM">): boolean {
  const row = activityClass(a);
  if (!row) return false;
  const srpe = a.srpe ?? 0;
  switch (row.hardRule) {
    case "always":
      return true;
    case "never":
      return false;
    case "srpe8":
      return a.hard === true || srpe >= HARD_SRPE_CLIMBING;
    case "hike":
      return a.hard === true || srpe >= HARD_SRPE || (a.movingS / 60 > HARD_HIKE_MIN && (a.elevationGainM ?? 0) > HARD_HIKE_GAIN_M);
    default:
      return a.hard === true || srpe >= HARD_SRPE;
  }
}

/** Excluded from monotony (§10.2 yoga row). */
export function excludedFromMonotony(a: Pick<Activity, "sport" | "activity">): boolean {
  return activityClass(a)?.cls === "yoga";
}

/** Deterministic order: by date, then id. */
export function sortActivities<T extends Pick<Activity, "date" | "id">>(acts: readonly T[]): T[] {
  return [...acts].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export function isRun(a: Pick<Activity, "sport">): boolean {
  return a.sport === "run";
}
