/**
 * Long run (spec §6.6): L1 caps, L2 progression, L3 content.
 */
import type { GoalDistance, Level, LongRunMode, Phase } from "./plan-types.js";
import type { PaceRange } from "./paces.js";

type CapRow = Record<GoalDistance, number | null>;

/** L1 time caps in minutes (§6.6 table; C for Daniels 150, D elsewhere). null = blocked for the level. */
export const LR_TIME_CAP_MIN: Record<Level, CapRow> = {
  beginner: { "5k": 60, "10k": 75, half: null, marathon: null },
  novice: { "5k": 75, "10k": 90, half: 120, marathon: 150 },
  intermediate: { "5k": 90, "10k": 105, half: 150, marathon: 150 },
  advanced: { "5k": 100, "10k": 120, half: 150, marathon: 150 },
};
/** Higdon/Pfitz mode lifts the marathon cap for intermediate and advanced runners (§6.6, D). */
export const LR_TIME_CAP_PFITZ_MARATHON_MIN = 180;

/** L1 distance caps in km, all levels (§6.6, D on C). Advanced Pfitz-mode marathon: 35 km. */
export const LR_DISTANCE_CAP_KM: Record<GoalDistance, number> = {
  "5k": 16,
  "10k": 20,
  half: 22,
  marathon: 32,
};

/**
 * pct_hard: hard share of weekly volume for the long run (§6.6, D): 0.45 M, 0.35 others.
 * With ≤ 3 run days it is 0.5 (D): an LR plus two easy runs at S3's 70% of it is already 42% of the
 * week, so 0.35 would force three equal runs and the LR could never progress toward its time cap.
 */
export function pctHard(distance: GoalDistance, runDays = 7): number {
  if (runDays <= 3) return 0.5;
  return distance === "marathon" ? 0.45 : 0.35;
}

/** L2: per-long-run growth limits over the running max (D on E). */
export const LR_STEP_PCT = 0.1;
export const LR_STEP_KM = 2;

/** Daniels soft cap: 30% of weekly below 64 km/week, else 25% (§6.6, C). Warn only. */
export function lrSoftCapFraction(weeklyKm: number): number {
  return weeklyKm < 64 ? 0.3 : 0.25;
}

export function lrTimeCapMin(level: Level, distance: GoalDistance, mode: LongRunMode): number {
  const raw = LR_TIME_CAP_MIN[level][distance] ?? LR_TIME_CAP_MIN.novice[distance];
  if (raw === null) throw new Error(`no LR time cap for ${level}/${distance}`);
  const pfitz =
    mode === "pfitz" &&
    distance === "marathon" &&
    (level === "intermediate" || level === "advanced");
  return pfitz ? LR_TIME_CAP_PFITZ_MARATHON_MIN : raw;
}

export function lrDistanceCapKm(level: Level, distance: GoalDistance, mode: LongRunMode): number {
  if (distance === "marathon" && level === "advanced" && mode === "pfitz") return 35;
  return LR_DISTANCE_CAP_KM[distance];
}

export interface LongRunCaps {
  timeCapMin: number;
  /**
   * Time cap converted to km. Distance-prescribed plans use the SLOW end of the LR pace range
   * (conservative, D); time-prescribed plans use its midpoint, since the athlete runs minutes and
   * km is only the estimate the planner budgets with.
   */
  timeCapKm: number;
  distanceCapKm: number;
  pctHard: number;
}

export function longRunCaps(
  level: Level,
  distance: GoalDistance,
  mode: LongRunMode,
  lrPace: PaceRange,
  opts: { timeBased?: boolean; runDays?: number } = {},
): LongRunCaps {
  const timeCapMin = lrTimeCapMin(level, distance, mode);
  const pace = opts.timeBased ? (lrPace.fast + lrPace.slow) / 2 : lrPace.slow;
  return {
    timeCapMin,
    timeCapKm: (timeCapMin * 60) / pace,
    distanceCapKm: lrDistanceCapKm(level, distance, mode),
    pctHard: pctHard(distance, opts.runDays),
  };
}

/**
 * Static part of L1 for one week: min(time cap, distance cap, pct_hard × weekly). Rule ID of the binding cap.
 * `establishedKm` (the entered 30-day longest run) floors the pct_hard term: pct_hard limits how
 * fast the LR's share of the week grows, but never cuts a long run the runner already does (D).
 * Without it a low-volume runner (persona A: 12 km/week, 5 km LR = 42%) gets a 2–4 km "long run".
 */
export function l1CapKm(caps: LongRunCaps, weeklyKm: number, establishedKm = 0): { km: number; rule: string } {
  const options: Array<[number, string]> = [
    [caps.timeCapKm, "L1:time_cap"],
    [caps.distanceCapKm, "L1:distance_cap"],
    [Math.max(caps.pctHard * weeklyKm, establishedKm), "L1:pct_hard"],
  ];
  let best = options[0] as [number, string];
  for (const o of options) if (o[0] < best[0]) best = o;
  return { km: best[0], rule: best[1] };
}

/** L2: next long run may exceed the running max by ≤ 10% and ≤ 2 km (V1 is the 10% part). */
export function lrStepLimitKm(runningMaxKm: number): { km: number; rule: string } {
  const pct = runningMaxKm * (1 + LR_STEP_PCT);
  const abs = runningMaxKm + LR_STEP_KM;
  return pct <= abs ? { km: pct, rule: "L2:+10%" } : { km: abs, rule: "L2:+2km" };
}

/** Floor to 100 m so rounding never breaks a cap. */
export function floorKm(km: number): number {
  return Math.floor(km * 10 + 1e-9) / 10;
}

export type LongRunContent = "easy" | "fast_finish" | "m_segment";

/**
 * L3 (C): what a quality long run contains.
 *  - beginners: always easy
 *  - novices: fast finish only, from TQ
 *  - intermediate/advanced: from EQ; marathon uses fast finish in EQ and M segments in TQ/FQ (D)
 * `quality` says whether this week's LR is a quality LR at all (I2 alternation, quality.ts).
 */
export function longRunContent(
  level: Level,
  distance: GoalDistance,
  phase: Phase,
  quality: boolean,
): LongRunContent {
  if (!quality || level === "beginner") return "easy";
  if (phase === "BASE" || phase === "FI") return "easy";
  if (level === "novice") return phase === "EQ" ? "easy" : "fast_finish";
  if (distance === "marathon" && phase !== "EQ") return "m_segment";
  return "fast_finish";
}
