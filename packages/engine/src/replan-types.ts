/**
 * Types for adaptive replanning (spec §8), FIT-UPDATE (§4.10) and their inputs.
 * The replanner consumes Plan / PlanInput only through their public shapes (plan-types.ts) and keeps
 * everything it needs beyond them here.
 */
import type { Activity, ActivitySport } from "./activity.js";
import type { HrMaxSource } from "./analysis.js";
import type { MatchResult } from "./matching.js";
import type { Alternative, Plan, PlanInput, VdotStatus } from "./plan-types.js";
import type { Units } from "./units.js";

// ── fitness state (§4.10) ────────────────────────────────────────────────────────────────────────

export interface FitnessChange {
  date: string;
  fromVdot?: number;
  toVdot: number;
  status: VdotStatus;
  /** Rule that made the change, e.g. "FIT-UPDATE:race", "R-PERF", "R-BREAK". */
  rule: string;
  /** Activity id or proposal id that caused it; evidence already in history is never re-applied. */
  source: string;
  reason: string;
}

export interface FitnessState {
  vdot?: number;
  status: VdotStatus;
  /** Distance (m) of the race/TT behind the VDOT (PACE-FADE, §4.4). */
  anchorM?: number;
  hrMax?: number;
  hrMaxSource?: HrMaxSource;
  hrRest?: number;
  history: FitnessChange[];
}

// ── check-in events ──────────────────────────────────────────────────────────────────────────────

interface EventBase {
  /** The day the event refers to (onset, run day, …), YYYY-MM-DD. */
  date: string;
  /** Day the user reported it; later reports about the same thing win. Defaults to `date`. */
  reportedOn?: string;
}

/** R-ILL-1 neck check. One episode per onset date; send updated check-ins with the same onset. */
export interface IllnessEvent extends EventBase {
  type: "illness";
  fever: boolean;
  /** Below-neck or systemic symptoms (chest, aches, GI, fatigue). */
  systemic: boolean;
  /** Above-neck symptoms (runny nose, sore throat, sneezing). */
  aboveNeck: boolean;
  suspectedCovidOrFlu?: boolean;
  /** First day fever-free with systemic symptoms gone (symptoms gone, for above-neck). */
  resolvedDate?: string;
  worsening?: boolean;
}

/** R-ILL-2 red flags during or within 24 h of the first run back. */
export interface IllnessRedFlagEvent extends EventBase {
  type: "illness_red_flag";
  flags: Array<"chest_pain" | "palpitations" | "dizziness" | "unusual_breathlessness" | "rpe_far_above_normal" | "dark_urine">;
}

/** R-PAIN inputs per body part (Silbernagel model). Scores 0–10. */
export interface PainEvent extends EventBase {
  type: "pain";
  bodyPart: string;
  /** During / right after the run on `date`. */
  during: number;
  /** Next-morning score. Missing → not known yet. */
  nextMorning?: number;
  /** Usual resting score for this body part (default 0). */
  baseline?: number;
  alteredGait?: boolean;
  /** Sharp, localized bone pain → suspected bone stress: out of scope (§2.4). */
  sharpBonePain?: boolean;
}

export type SkipReason = "busy" | "tired" | "illness" | "pain" | "travel" | "weather" | "other";

export interface SkipEvent extends EventBase {
  type: "skip";
  workoutId?: string;
  reason: SkipReason;
}

/** Session RPE logged after the fact (§10.1). */
export interface SrpeEvent extends EventBase {
  type: "srpe";
  activityId: string;
  srpe: number;
}

/** Manually logged cross-training (§10.2). Imported cross-training arrives as an Activity instead. */
export interface CrossTrainingEvent extends EventBase {
  type: "cross_training";
  sport: Exclude<ActivitySport, "run">;
  minutes: number;
  srpe?: number;
  hard?: boolean;
}

export interface ProposalResponseEvent extends EventBase {
  type: "proposal_response";
  proposalId: string;
  accept: boolean;
}

/** Subjective readiness for R-HRV-2 ("above the band together with high fatigue"). 1 = fresh … 5 = exhausted. */
export interface ReadinessEvent extends EventBase {
  type: "readiness";
  fatigue: number;
}

export type CheckInEvent =
  | IllnessEvent
  | IllnessRedFlagEvent
  | PainEvent
  | SkipEvent
  | SrpeEvent
  | CrossTrainingEvent
  | ProposalResponseEvent
  | ReadinessEvent;

/** One night of HRV from the source's wellness data (R-HRV). */
export interface HrvNight {
  date: string;
  rmssdMs: number;
}

// ── rule outputs ─────────────────────────────────────────────────────────────────────────────────

interface ActionBase {
  /** Rule ID, e.g. "R-ILL-1". Also written into the affected workout's rule_trace. */
  rule: string;
  reason: string;
}

/**
 * Structured, date-addressed modifications. The replanner applies them to editable days only
 * (today onward; today is frozen once a run is logged), in a fixed order, most restrictive last.
 */
export type ReplanAction =
  | (ActionBase & { kind: "rest"; date: string })
  | (ActionBase & { kind: "easy"; date: string; maxFraction?: number; maxMinutes?: number })
  | (ActionBase & { kind: "test_run"; date: string; minutes: number; label: "exercise_challenge" | "pain_test" })
  | (ActionBase & { kind: "move"; workoutId: string; fromDate: string; toDate: string })
  | (ActionBase & { kind: "scale_volume"; from: string; to: string; factor: number; easyOnly: boolean })
  | (ActionBase & { kind: "scale_paces"; from: string; factor: number })
  | (ActionBase & { kind: "no_quality"; from: string; to: string; kinds?: string[] })
  | (ActionBase & { kind: "cap_long_run"; from: string; to: string; km: number })
  | (ActionBase & { kind: "cap_week_km"; weekStart: string; km: number })
  | (ActionBase & { kind: "shorten"; date: string; factor: number })
  | (ActionBase & { kind: "trim_load"; weekStart: string; maxLoad: number })
  | (ActionBase & { kind: "cross_training_only"; from: string; to: string });

export type ReplanActionKind = ReplanAction["kind"];

/** Overrides for the derived PlanInput when a rule asks for a rebuild. */
export interface InputPatch {
  currentWeeklyKm?: number;
  longestRun30d?: { km: number; minutes: number };
  vdot?: number;
  vdotStatus?: VdotStatus;
  heavyCrossTraining?: boolean;
  /** Run/walk ladder: stages to step back (R-BREAK 1 per 7 days off; R-MISS-4 one stage). */
  ladderStepBack?: number;
}

export interface RegenerateRequest {
  rule: string;
  /** Stable key: the same event never triggers a second rebuild (written to plan.summary.notes). */
  key: string;
  reason: string;
  patch: InputPatch;
}

export interface Halt {
  rule: string;
  reason: string;
  referral: "doctor" | "physio";
}

interface ProposalBase {
  /** Stable while its evidence is unchanged; accept/decline it with a ProposalResponseEvent. */
  id: string;
  rule: string;
  message: string;
}

export type Proposal =
  | (ProposalBase & {
      kind: "vdot_change";
      fromVdot: number;
      toVdot: number;
      /** In fitness steps (≈ 1.2% T pace each). */
      steps: number;
      /** T-pace change in %, positive = faster. */
      pacePct: number;
      evidence: string[];
    })
  | (ProposalBase & {
      kind: "goal_change";
      currentGoalS?: number;
      suggestedGoalS?: number;
      alternatives: Alternative[];
    })
  | (ProposalBase & { kind: "realign" });

export interface ReplanChange {
  rule: string;
  date?: string;
  message: string;
}

export interface RuleResult {
  /** Family, e.g. "R-MISS". */
  rule: string;
  actions: ReplanAction[];
  proposals: Proposal[];
  changes: ReplanChange[];
  regenerate?: RegenerateRequest;
  /** Input changes to carry into the next rebuild, without forcing one (e.g. R-LOAD-4 → 2:1 cutbacks). */
  inputPatch?: InputPatch;
  halt?: Halt;
  trace: string[];
}

export function emptyResult(rule: string): RuleResult {
  return { rule, actions: [], proposals: [], changes: [], trace: [] };
}

// ── replan entry point ───────────────────────────────────────────────────────────────────────────

export interface ReplanOptions {
  /**
   * "auto" (default): rebuild the future with generatePlan only on a structural trigger (break,
   * accepted realignment, illness return, VDOT source change); otherwise keep the future and
   * modify it in place. "always": rebuild on every call.
   */
  regenerate?: "auto" | "always";
  units?: Units;
}

export interface ReplanState {
  plan: Plan;
  /** The PlanInput the plan was generated from (race date, level, goal, schedule). */
  input: PlanInput;
  fitness: FitnessState;
  activities: readonly Activity[];
  hrv?: readonly HrvNight[];
  options?: ReplanOptions;
}

export interface ReplanMetrics {
  /** R-LOAD-3, display only. */
  monotony?: number;
  strain?: number;
  weeklyLoad: number;
  /** Cross-training share of total_load, last 28 days. */
  crossTrainingShare: number;
  breakDays?: number;
  breakMultiplier?: number;
}

export interface ReplanResult {
  plan: Plan;
  fitness: FitnessState;
  /** User-facing sentences, in rule order. */
  changes: ReplanChange[];
  /** Need user acceptance; resend with a ProposalResponseEvent. */
  proposals: Proposal[];
  /** Every action that was applied (or attempted) this run. */
  actions: ReplanAction[];
  halted?: Halt;
  regenerated: boolean;
  /** The PlanInput passed to generatePlan when regenerated. */
  derivedInput?: PlanInput;
  matching: MatchResult;
  metrics: ReplanMetrics;
  /** Re-push window (§8 "re-push the next 14 days"). */
  repush: { from: string; to: string };
  trace: string[];
}
