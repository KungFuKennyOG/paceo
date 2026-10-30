/**
 * Plan generator inputs and outputs (spec §6.1, §2.3). Plain TS: these never cross a trust boundary
 * inside the engine; the API validates user input before it gets here.
 */
import type { Weekday } from "./dates.js";
import type { PlannedWorkout } from "./workout.js";
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
 * Cross-training or external lifting on fixed days (§7.1 step 1, §10.2).
 * TODO(§10, §7.1): accepted but not scheduled yet; hard sessions should count as ½ key session (§6.4).
 */
export interface LockedEvent {
  weekday: Weekday;
  activity: string;
  minutes: number;
  srpe: number;
  hard: boolean;
}

export interface PlanInput {
  /** Stamped on every workout; defaults to "me". */
  userId?: string;
  /** Effective level: min(self-report, derived), §2.3. */
  level: Level;
  /** Run days per week, 2–7 (§2.3). Beginners are capped at 4 (§6.4). */
  runDays: number;
  longRunDay: Weekday;
  /** Local "today", YYYY-MM-DD. The engine never reads the clock. */
  today: string;
  raceDate: string;
  goal: { distance: GoalDistance; timeS?: number };
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
  /** TODO(§10): accepted, not scheduled in this slice. */
  lockedEvents?: readonly LockedEvent[];
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
  workouts: PlannedWorkout[];
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

export interface PlanSummary {
  weeks: number;
  /** Days between today and week 1 that the plan leaves unscheduled (weeks are aligned to end on race day). */
  leadInDays: number;
  startDate: string;
  raceDate: string;
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
  notes: string[];
}

export interface Plan {
  feasibility: Feasibility;
  weeks: PlanWeek[];
  summary: PlanSummary;
}
