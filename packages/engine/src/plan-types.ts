/**
 * Plan generator inputs and outputs (spec §6.1, §2.3). Plain TS: these never cross a trust boundary
 * inside the engine; the API validates user input before it gets here.
 */
import type { Weekday } from "./dates.js";
import type { PlannedWorkout } from "./workout.js";
import type { StrengthConfig } from "./strength.js";
import type { CrossTrainingSession } from "./cross-training.js";
import { DISTANCES_M } from "./vdot.js";

export type Level = "beginner" | "novice" | "intermediate" | "advanced";
export type GoalDistance = "5k" | "10k" | "half" | "marathon";
export type VdotStatus = "race" | "tt" | "estimated" | "none";
/** Marathon long-run convention (§6.6): Daniels 150 min or Higdon/Pfitz 180 min. */
export type LongRunMode = "daniels" | "pfitz";
/** BASE = General-mode weeks prepended to plans over 24 weeks (§6.3 P1). */
export type Phase = "BASE" | "FI" | "EQ" | "TQ" | "FQ";

export const GOAL_DISTANCE_M: Record<GoalDistance, number> = {
  "5k": DISTANCES_M["5k"],
  "10k": DISTANCES_M["10k"],
  half: DISTANCES_M.half,
  marathon: DISTANCES_M.marathon,
};

/**
 * Cross-training or external lifting on a fixed weekday, every week of the plan (§7.1 step 1, §9.6, §10.2).
 * Classified per §10.2 by `activity` (cross-training.ts). Race day itself never carries one (D).
 */
export interface LockedEvent {
  weekday: Weekday;
  /**
   * §10.2 activity: a class id ("cycling", "paddling", "team_sport", "hiit", "strength_upper", …),
   * a common name ("dragon boat", "soccer", "crossfit") or an intervals.icu sport type ("Ride",
   * "Rowing", "WeightTraining"). Unknown values fall into "other".
   */
  activity: string;
  minutes: number;
  /** Expected session RPE (CR-10). Defaults to the §10.2 easy value, or the hard value when `hard`. */
  srpe?: number;
  /**
   * The user's own hard/easy call. When absent it is derived (§10.2): sRPE ≥ 7 (climbing ≥ 8),
   * team sports and HIIT always hard, hikes > 3 h with > 800 m gain hard.
   * `false` on a team sport = "light/technique".
   */
  hard?: boolean;
  /** Locked (default) sessions are never moved; flexible ones may get a "move it" suggestion (§10.2, §7.1 fallback 5). */
  locked?: boolean;
  /** Display name, e.g. "Club paddling". */
  name?: string;
  /** Hikes only: elevation gain in metres, for the "> 3 h with > 800 m" hard rule. */
  elevationGainM?: number;
}

/** §6.1 plan modes. "beginner ladder" isn't a separate mode: it is the opening weeks of either. */
export type PlanMode = "race" | "general_fitness";

/** Race goal (the original PlanInput goal). `type` is optional so existing `{ distance }` literals still compile. */
export interface RaceGoal {
  type?: "race";
  distance: GoalDistance;
  timeS?: number;
}

/**
 * General fitness / base building (§6.1): rolling 4-week blocks, a weekly target time or volume,
 * a TT every 6–8 weeks, no taper, no race.
 */
export interface GeneralFitnessGoal {
  type: "general_fitness";
  /** Weekly running time to build toward (minutes). Converted to km at E pace. */
  targetWeeklyMinutes?: number;
  /** Weekly running volume to build toward (km). Used when minutes aren't given. */
  targetWeeklyKm?: number;
  /** Weeks to generate from `today`. Default 12. */
  weeks?: number;
  /**
   * Distance whose §6.5/§6.6 caps and P3 emphasis the plan borrows (D). Default: 10K for
   * beginners and novices, half marathon otherwise.
   */
  referenceDistance?: GoalDistance;
}

export interface PlanInput {
  /** Stamped on every workout; defaults to "me". */
  userId?: string;
  /** Effective level: min(self-report, derived), §2.3. */
  level: Level;
  /** Run days per week, 2–7 (§2.3). Beginners are capped at 4 (§6.4). Ignored when `runWeekdays` is given. */
  runDays: number;
  longRunDay: Weekday;
  /**
   * The weekdays the user can run (§2.3 "days available"). When given, runs go only on these days
   * and the run-day count is their number; the long-run day always counts as one (added if missing).
   * Absent: `runDays` days on the §7.2 rows, rotated to the long-run day.
   */
  runWeekdays?: readonly Weekday[];
  /**
   * §7.1 step 4: the most minutes a run session may take on each weekday (§2.3 "max minutes per
   * weekday", ≥ 20). Missing days are unlimited. Never exceeded: sessions are shortened or moved
   * (quality: fallbacks 1–2; long run: fallback 3) and the conflicts are reported in
   * summary.conflicts. Races are exempt. Strength sessions are separate sessions (ST-6) and don't count.
   */
  maxMinutesByDay?: Partial<Record<Weekday, number>>;
  /** Local "today", YYYY-MM-DD. The engine never reads the clock. */
  today: string;
  raceDate: string;
  goal: RaceGoal;
  currentWeeklyKm: number;
  /** Longest non-race run in the last 30 days (§6.1). Seeds the V1 reference. */
  longestRun30d: { km: number; minutes: number };
  vdot?: number;
  vdotStatus: VdotStatus;
  /**
   * Distance (m) of the race or TT the VDOT came from. Needed for PACE-FADE (§4.4) when the
   * goal is HM/M and the anchor is shorter. Absent → no fade is applied.
   */
  vdotAnchorM?: number;
  age?: number;
  /** Injury in the past 12 months or current (§2.3). */
  injuryFlag: boolean;
  /** Cross-training > 40% of total_load over the last 4 weeks (§6.7 C1). */
  heavyCrossTraining: boolean;
  longRunMode: LongRunMode;
  canRun20MinContinuous: boolean;
  monthsRunning: number;
  /** Run/walk ladder entry stage 1–10 from onboarding (§6.9). Defaults to 1. */
  ladderEntryStage?: number;
  /** Cross-training and external lifting on fixed weekdays (§7.1 step 1, §10.2). */
  lockedEvents?: readonly LockedEvent[];
  /** §9.2 strength settings. Absent = off (the API applies the spec defaults, DEFAULT_STRENGTH_CONFIG). */
  strength?: StrengthConfig;
  /**
   * Out-of-scope user continuing after professional guidance (§2.4: pregnancy/postpartum, recent
   * serious injury or surgery): no plyometrics and no heavy strength work.
   */
  conservative?: boolean;
  /**
   * Mid-plan rebuild (§8 R-RACE-2): continue an existing race plan's phase structure from the week
   * holding `today` instead of re-deriving Daniels phases for the weeks left. Set by replan();
   * ignored in general-fitness mode and when the calendar doesn't reach back to `today`'s week.
   */
  continuation?: PlanContinuation;
}

/** Progression families for quality sessions (all marathon-pace work shares "M", §6.10). */
export type ExposureFamily = "T" | "I" | "R" | "H" | "M" | "GP" | "TT";

/**
 * How a rebuild continues the plan it replaces (§8 R-BREAK, R-RACE-1/2; the rule is D, see
 * continuedPhases in phases.ts):
 *  - the remaining weeks keep the original phase of their date, taper weeks included (R-RACE-1);
 *  - `phaseReset` starts the current phase's emphasis over (shift back within the phase);
 *  - `rebuildWeeks` (0–2) Foundation weeks go in first, taken from the build phases, never the taper;
 *  - `restart` re-splits the build weeks with the §6.3 table ("treat it as a new plan if the date
 *    allows", R-BREAK > 28 d), still keeping the taper.
 * Volume, long runs and sessions are always recomputed from the input's current fitness and history.
 * New-plan minimums (§6.2 min weeks, entry volume) don't apply; feasibility runs the R-RACE checks.
 */
export interface PlanContinuation {
  /**
   * Phase of every week of the plan being continued, index 0 = its week 1. Its last week is the race
   * week (weeks are 7-day blocks ending on race day), so week w of the rebuild is calendar week
   * `phaseCalendar.length − weeks + w`.
   */
  phaseCalendar: readonly Phase[];
  /** Taper length of the plan being continued, kept as is (§8 R-RACE-1; §6.8 T1 is not re-run). */
  taperWeeks: number;
  /** Start the current phase's emphasis sequence over instead of resuming mid-phase. */
  phaseReset?: boolean;
  /** Foundation rebuild weeks to insert at the front (0–2), taken from the build phases. */
  rebuildWeeks?: number;
  /** Re-split the remaining build weeks with the §6.3 table (taper kept). */
  restart?: boolean;
  /** Quality sessions already done per progression family, so sessions keep growing from there. */
  exposures?: Partial<Record<ExposureFamily, number>>;
  /** Build weeks since the last cutback in the plan being continued (§6.7 rhythm); default 0. */
  weeksSinceCutback?: number;
  /** Why (rule key), for traces, e.g. "R-BREAK:2026-12-31:10". */
  reason?: string;
}

/** §6.1 general-fitness request: the race fields are replaced by a GeneralFitnessGoal. */
export type GeneralFitnessInput = Omit<PlanInput, "raceDate" | "goal"> & { goal: GeneralFitnessGoal };

/** Anything generatePlan accepts. PlanInput (race mode) is unchanged for existing callers. */
export type PlanRequest = PlanInput | GeneralFitnessInput;

export function isGeneralFitness(input: PlanRequest): input is GeneralFitnessInput {
  return input.goal.type === "general_fitness";
}

export type FeasibilityStatus = "ok" | "warn" | "block";

export interface FeasibilityReason {
  code: string;
  /** "info" never changes the overall status. */
  status: FeasibilityStatus | "info";
  message: string;
}

export type AlternativeKind =
  | "later_date"
  | "shorter_distance"
  | "finish_goal"
  | "base_block"
  | "slower_goal";

export interface Alternative {
  kind: AlternativeKind;
  rank: number;
  message: string;
  raceDate?: string;
  distance?: GoalDistance;
  goalTimeS?: number;
  baseWeeks?: number;
}

export interface Feasibility {
  status: FeasibilityStatus;
  reasons: FeasibilityReason[];
  /** Ranked per §6.2; empty when status is ok. */
  alternatives: Alternative[];
  /** Simulated peak long run (km) and the plan's own L1 target (km) from the reachability check. */
  reach: { peakLongRunKm: number; l1TargetKm: number; ratio: number };
  goalVdotDelta?: number;
}

export interface PlanWeek {
  /** 1-based. Week N ends on race day. */
  index: number;
  startDate: string;
  phase: Phase;
  targetKm: number;
  plannedKm: number;
  longRunKm: number;
  isCutback: boolean;
  isTaper: boolean;
  isLadder: boolean;
  /** Runs and app-prescribed strength (sport "strength"), by date; on a shared day the run comes first. */
  workouts: PlannedWorkout[];
  /**
   * Locked cross-training and external lifting that falls in this week (§7.1 step 1, §10.2). These
   * aren't prescribed or pushed to a watch; they are listed so the week shows its full load.
   * Always set by generatePlan (optional only so older Plan JSON still type-checks).
   */
  crossTraining?: CrossTrainingSession[];
  notes: string[];
  /** Set when planned km misses the target by more than 10%, with the caps that caused it. */
  volumeFlag?: VolumeFlag;
}

/** A week whose planned km is more than 10% off target, and the rule IDs of the caps that explain it. */
export interface VolumeFlag {
  week: number;
  targetKm: number;
  plannedKm: number;
  /** e.g. "S3:easy_capacity", "TT:fixed_session"; "unexplained" means no cap was recorded (a bug). */
  reasons: string[];
}

/** A rule the week couldn't satisfy (§7.1 fallbacks 5–6, §9.6). Deduplicated per code and weekday in the summary. */
export interface ScheduleConflict {
  code: string;
  /** Weekday of the session that causes it. */
  weekday: Weekday;
  /** Plan weeks (1-based) where it occurs. */
  weeks: number[];
  message: string;
  /** A concrete fix, e.g. a weekday to move a flexible session or an external lifting day to. */
  suggestion?: string;
}

export interface PlanSummary {
  /** §6.1. Always set by generatePlan; absent in Plan JSON from before general-fitness mode. */
  mode?: PlanMode;
  /** Last day of the plan (race day in race mode). */
  endDate?: string;
  weeks: number;
  /** Days between today and week 1 that the plan leaves unscheduled (weeks are aligned to end on race day). */
  leadInDays: number;
  startDate: string;
  /** Race day. In general-fitness mode: the last day of the plan (same as endDate). */
  raceDate: string;
  /** Goal distance; in general-fitness mode, the reference distance the caps come from. */
  distance: GoalDistance;
  phaseSplit: Record<Phase, number>;
  ladderWeeks: number;
  taperWeeks: number;
  /** 3 = 2:1, 4 = 3:1 (§6.7). */
  cutbackEvery: number;
  peakWeekKm: number;
  peakLongRunKm: number;
  peakLongRunWeek: number;
  totalKm: number;
  /** Weeks whose planned km is more than 10% off target (see PlanWeek.volumeFlag). */
  volumeFlags: VolumeFlag[];
  /** Locked-session conflicts and fallback suggestions (§7.1 fallbacks 5–6). */
  conflicts?: ScheduleConflict[];
  notes: string[];
}

export interface Plan {
  feasibility: Feasibility;
  weeks: PlanWeek[];
  summary: PlanSummary;
}
