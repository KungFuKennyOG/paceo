/**
 * Goal feasibility checks (spec §6.2, mostly D on C) and the R-RACE-2 reachability simulation.
 * Each check adds a reason; the overall status is the worst of them. "info" reasons never change it.
 */
import type {
  Alternative,
  Feasibility,
  FeasibilityReason,
  FeasibilityStatus,
  GoalDistance,
  Level,
  PlanInput,
} from "./plan-types.js";
import { GOAL_DISTANCE_M } from "./plan-types.js";
import { addDays, planCalendar } from "./dates.js";
import { planShape, type PlanShape } from "./plan-shape.js";
import { V1_FACTOR } from "./v1.js";
import { computeVdot, defaultFadeExponent, fadedRaceTimeS, raceTimeS, VdotRangeError } from "./vdot.js";
import { AGGRESSIVE_GOAL_VDOT_DELTA } from "./paces.js";
import { peakCeilingKm } from "./volume.js";
import { formatDuration } from "./units.js";

/** Δ VDOT above which a goal is "unrealistic in this block" (§6.2, D). */
export const UNREALISTIC_GOAL_VDOT_DELTA = 3.0;
/** Realistic band / suggested goal: current VDOT + 0 … + 1.0 (§6.2). */
export const REALISTIC_GOAL_VDOT_GAIN = 1.0;
/** Reachability: warn below 85% of the plan's own L1 target, block below 70% (§6.2, D). */
export const REACH_WARN = 0.85;
export const REACH_BLOCK = 0.7;
/** How far ahead the "later date" search looks (D). */
const LATER_DATE_MAX_WEEKS = 52;

interface EntryRow {
  minWeeks: number;
  weeklyKm: number;
  longestKm: number;
  longestMin: number;
  /** Minimum months running (block below). */
  minMonths: number;
  /** Recommended months running (info below). */
  recommendedMonths: number;
}

/** §6.2 entry table. Minutes for weekly volume aren't checked: the input carries km only. */
const ENTRY: Record<GoalDistance, EntryRow> = {
  "5k": { minWeeks: 6, weeklyKm: 6, longestKm: 2.5, longestMin: 20, minMonths: 0, recommendedMonths: 0 },
  "10k": { minWeeks: 8, weeklyKm: 12, longestKm: 5, longestMin: 35, minMonths: 0, recommendedMonths: 0 },
  half: { minWeeks: 10, weeklyKm: 20, longestKm: 10, longestMin: 70, minMonths: 6, recommendedMonths: 6 },
  marathon: { minWeeks: 12, weeklyKm: 30, longestKm: 14, longestMin: 100, minMonths: 6, recommendedMonths: 12 },
};

export function entryMet(input: PlanInput, distance: GoalDistance = input.goal.distance): { volume: boolean; longest: boolean } {
  const e = ENTRY[distance];
  const ladder = distance === "5k" && input.level === "beginner" && !input.canRun20MinContinuous;
  return {
    volume: input.currentWeeklyKm >= e.weeklyKm,
    longest: ladder || input.longestRun30d.km >= e.longestKm || input.longestRun30d.minutes >= e.longestMin,
  };
}

/** Beginners can't do HM/M (§6.2). */
export function levelBlocked(level: Level, distance: GoalDistance): boolean {
  return level === "beginner" && (distance === "half" || distance === "marathon");
}

/** §6.2 minimum weeks, by level. */
export function minWeeks(input: PlanInput, distance: GoalDistance = input.goal.distance): number {
  const lvl = input.level;
  switch (distance) {
    case "5k":
      return lvl === "beginner" && !input.canRun20MinContinuous ? 9 : 6;
    case "10k":
      return lvl === "beginner" ? 12 : 8;
    case "half": {
      const e = entryMet(input, distance);
      if (lvl === "novice") return 12;
      return (lvl === "intermediate" || lvl === "advanced") && e.volume && e.longest ? 8 : 10;
    }
    case "marathon":
      return lvl === "novice" ? 16 : 12;
  }
}

/**
 * R-RACE-2: step the long run +10% (V1) in every build week of weeks_to_race − taper_weeks; cutback,
 * TT and ladder weeks don't step (§6.7, §6.9). Compared with the plan's own L1 target.
 * The generator also applies L2's +2 km limit, which only binds above 20 km.
 */
export function reachability(shape: PlanShape, longestKm: number): Feasibility["reach"] {
  const buildKinds = shape.kinds.slice(0, shape.weeks - shape.taperWeeks);
  let peak = longestKm;
  for (const kind of buildKinds) if (kind === "build") peak = Math.min(shape.l1TargetKm, peak * V1_FACTOR);
  peak = Math.max(peak, Math.min(longestKm, shape.l1TargetKm));
  const target = shape.l1TargetKm;
  return { peakLongRunKm: peak, l1TargetKm: target, ratio: target > 0 ? Math.min(1, peak / target) : 1 };
}

interface CoreResult {
  reasons: FeasibilityReason[];
  reach: Feasibility["reach"];
  weeks: number;
}

/** Calendar, level, entry and reachability checks for one (distance, date) pair. */
function coreChecks(input: PlanInput): CoreResult {
  const reasons: FeasibilityReason[] = [];
  const d = input.goal.distance;
  const e = ENTRY[d];
  const cal = planCalendar(input.today, input.raceDate, input.longRunDay);
  const need = minWeeks(input);

  if (levelBlocked(input.level, d)) {
    reasons.push({ code: "level_blocked", status: "block", message: `Beginners can't train for a ${d} yet; build up with a 5K or 10K first.` });
  }
  if (cal.weeks < need) {
    reasons.push({ code: "min_weeks", status: "block", message: `${d} needs at least ${need} weeks for this level; ${cal.weeks} are available.` });
  }
  const entry = entryMet(input);
  if (!entry.volume) {
    reasons.push({ code: "entry_volume", status: "warn", message: `Entry volume for a ${d} is ≥ ${e.weeklyKm} km/week; you run ${input.currentWeeklyKm} km.` });
  }
  if (!entry.longest) {
    reasons.push({ code: "entry_longest_run", status: "warn", message: `Entry longest run for a ${d} is ≥ ${e.longestKm} km or ${e.longestMin} min.` });
  }
  if (input.monthsRunning < e.minMonths) {
    reasons.push({ code: "months_running", status: "block", message: `A ${d} needs ≥ ${e.minMonths} months of consistent running.` });
  } else if (input.monthsRunning < e.recommendedMonths) {
    reasons.push({ code: "months_running", status: "info", message: `≥ ${e.recommendedMonths} months of running is recommended before a ${d}.` });
  }
  if (input.level === "beginner" && d === "10k") {
    reasons.push({ code: "beginner_10k", status: "info", message: "Consider a 5K first." });
  }

  let reach: Feasibility["reach"] = { peakLongRunKm: input.longestRun30d.km, l1TargetKm: 0, ratio: 0 };
  if (cal.weeks >= 2 && !levelBlocked(input.level, d)) {
    reach = reachability(planShape(input, cal.weeks), input.longestRun30d.km);
    const pct = Math.round(reach.ratio * 100);
    if (reach.ratio < REACH_BLOCK) {
      reasons.push({ code: "reachability", status: "block", message: `Long runs can only reach ${pct}% of this plan's target (${reach.l1TargetKm.toFixed(1)} km).` });
    } else if (reach.ratio < REACH_WARN) {
      reasons.push({ code: "reachability", status: "warn", message: `Long runs reach ${pct}% of this plan's target (${reach.l1TargetKm.toFixed(1)} km).` });
    }
  }
  return { reasons, reach, weeks: cal.weeks };
}

// ── goal time (§6.2 goal-time checks, PACE-FADE §4.4) ────────────────────────────────────────────

/** Predicted time at the goal distance for a VDOT, with PACE-FADE for HM/M from a shorter anchor. */
export function predictedGoalTimeS(input: PlanInput, vdot: number): number {
  const goalM = GOAL_DISTANCE_M[input.goal.distance];
  const anchor = input.vdotAnchorM;
  const fade = (input.goal.distance === "half" || input.goal.distance === "marathon") && anchor !== undefined && anchor < goalM - 1;
  if (!fade) return raceTimeS(vdot, goalM);
  const ceiling = peakCeilingKm(input.level, input.goal.distance, input.currentWeeklyKm);
  const k = defaultFadeExponent(vdot, input.currentWeeklyKm < 0.6 * ceiling);
  return fadedRaceTimeS(anchor, raceTimeS(vdot, anchor), goalM, k);
}

/** Δ VDOT = goal VDOT − current VDOT (after fade, expressed as the VDOT of the faded prediction). */
export function goalVdotDelta(input: PlanInput): number | undefined {
  if (input.goal.timeS === undefined || input.vdot === undefined || input.vdotStatus === "none") return undefined;
  const goalM = GOAL_DISTANCE_M[input.goal.distance];
  const goalVdot = computeVdot(goalM, input.goal.timeS);
  const current = computeVdot(goalM, predictedGoalTimeS(input, input.vdot));
  return goalVdot - current;
}

function goalTimeChecks(input: PlanInput, weeks: number): { reasons: FeasibilityReason[]; delta?: number } {
  const reasons: FeasibilityReason[] = [];
  if (input.goal.timeS === undefined) return { reasons };
  if (input.vdot === undefined || input.vdotStatus === "none") {
    reasons.push({ code: "goal_needs_tt", status: "info", message: "Run a time trial (§4.2) so the goal time can be checked." });
    return { reasons };
  }
  let delta: number;
  try {
    delta = goalVdotDelta(input) as number;
  } catch (err) {
    if (!(err instanceof VdotRangeError)) throw err;
    reasons.push({ code: "goal_out_of_range", status: "warn", message: "The goal time is outside the range the pace model supports." });
    return { reasons };
  }
  const band = `${formatDuration(predictedGoalTimeS(input, input.vdot))}–${formatDuration(predictedGoalTimeS(input, input.vdot + REALISTIC_GOAL_VDOT_GAIN))}`;
  if (delta > UNREALISTIC_GOAL_VDOT_DELTA) {
    reasons.push({ code: "goal_unrealistic", status: "warn", message: `Goal needs +${delta.toFixed(2)} VDOT: unrealistic in this block. Suggested goal ${formatDuration(predictedGoalTimeS(input, input.vdot + REALISTIC_GOAL_VDOT_GAIN))}.` });
  } else if (delta > AGGRESSIVE_GOAL_VDOT_DELTA) {
    reasons.push({ code: "goal_aggressive", status: "warn", message: `Goal needs +${delta.toFixed(2)} VDOT: aggressive. Realistic band ${band}.` });
  } else if (delta > REALISTIC_GOAL_VDOT_GAIN) {
    reasons.push({ code: "goal_edge", status: "info", message: `Goal needs +${delta.toFixed(2)} VDOT, at the edge of the +${AGGRESSIVE_GOAL_VDOT_DELTA} flag.` });
  }
  if (weeks < 12 && delta > REALISTIC_GOAL_VDOT_GAIN) {
    reasons.push({ code: "goal_short_block", status: "warn", message: `Under 12 weeks, a gain of +${delta.toFixed(2)} VDOT is unlikely.` });
  }
  if ((input.level === "beginner" || input.level === "novice") && input.vdotStatus === "estimated") {
    reasons.push({ code: "goal_informational", status: "info", message: "Goal time is informational until a time trial; no pace targets come from it." });
  }
  return { reasons, delta };
}

// ── alternatives (§6.2 "What the app recommends instead") ────────────────────────────────────────

const SHORTER: Record<GoalDistance, GoalDistance[]> = {
  marathon: ["half", "10k", "5k"],
  half: ["10k", "5k"],
  "10k": ["5k"],
  "5k": [],
};

function passes(core: CoreResult): boolean {
  return core.reasons.every((r) => r.status !== "block") && core.reach.ratio >= REACH_WARN;
}

/** Earliest race date (same weekday) meeting min weeks and reachability. */
function laterDate(input: PlanInput, weeks: number): string | undefined {
  for (let extra = 1; extra <= LATER_DATE_MAX_WEEKS; extra++) {
    const raceDate = addDays(input.raceDate, 7 * extra);
    const core = coreChecks({ ...input, raceDate });
    if (core.weeks >= weeks + extra && passes(core)) return raceDate;
  }
  return undefined;
}

function shorterDistance(input: PlanInput): GoalDistance | undefined {
  return SHORTER[input.goal.distance].find((distance) => passes(coreChecks({ ...input, goal: { distance } })));
}

/** General-mode weeks to grow from the current volume to the entry volume at +8%/week with 3:1 cutbacks (D). */
function baseBlockWeeks(input: PlanInput): number {
  const target = Math.max(ENTRY[input.goal.distance].weeklyKm, input.currentWeeklyKm);
  const from = Math.max(input.currentWeeklyKm, 5);
  const builds = Math.ceil(Math.log(target / from) / Math.log(1.08));
  return Math.max(4, Math.ceil((builds * 4) / 3));
}

function alternatives(input: PlanInput, reasons: FeasibilityReason[], weeks: number): Alternative[] {
  const problems = new Set(reasons.filter((r) => r.status !== "info" && r.status !== "ok").map((r) => r.code));
  if (problems.size === 0) return [];
  const goalProblem = ["goal_aggressive", "goal_unrealistic", "goal_short_block"].some((c) => problems.has(c));
  const planProblem = [...problems].some((c) => !c.startsWith("goal_"));
  const out: Omit<Alternative, "rank">[] = [];

  if (planProblem) {
    const date = laterDate(input, weeks);
    if (date) out.push({ kind: "later_date", raceDate: date, message: `Race on ${date} instead.` });
    const shorter = shorterDistance(input);
    if (shorter) out.push({ kind: "shorter_distance", distance: shorter, message: `Race a ${shorter} on the same date.` });
  }
  if (goalProblem || problems.has("reachability") || problems.has("entry_longest_run")) {
    out.push({ kind: "finish_goal", message: "Drop the goal time: aim to finish, at RPE 5, with a run/walk race strategy (§6.9)." });
  }
  if (planProblem) {
    const n = baseBlockWeeks(input);
    out.push({ kind: "base_block", baseWeeks: n, message: `Build a base for ${n} weeks first, then re-check.` });
  }
  if (goalProblem && input.vdot !== undefined) {
    const t = predictedGoalTimeS(input, input.vdot + REALISTIC_GOAL_VDOT_GAIN);
    out.push({ kind: "slower_goal", goalTimeS: Math.round(t), message: `Aim for ${formatDuration(t)} (current fitness + 1 VDOT).` });
  }
  // The spec offers 2–3 options, in this rank order.
  return out.slice(0, 3).map((a, i) => ({ ...a, rank: i + 1 }));
}

function worst(reasons: readonly FeasibilityReason[]): FeasibilityStatus {
  if (reasons.some((r) => r.status === "block")) return "block";
  if (reasons.some((r) => r.status === "warn")) return "warn";
  return "ok";
}

export function checkFeasibility(input: PlanInput): Feasibility {
  const core = coreChecks(input);
  const goal = goalTimeChecks(input, core.weeks);
  const reasons = [...core.reasons, ...goal.reasons];
  const status = worst(reasons);
  const result: Feasibility = {
    status,
    reasons,
    alternatives: status === "ok" ? [] : alternatives(input, reasons, core.weeks),
    reach: core.reach,
  };
  if (goal.delta !== undefined) result.goalVdotDelta = goal.delta;
  return result;
}
