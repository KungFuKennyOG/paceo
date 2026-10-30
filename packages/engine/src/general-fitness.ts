/**
 * General fitness / base building mode (spec §6.1, D on C).
 *  - Rolling blocks: 3 build + 1 cutback (4-week blocks), or 2 + 1 under any C1 risk flag (§6.7).
 *  - A weekly target time or volume to build toward (V2/V3 still govern the steps).
 *  - Content cycles FI → EQ-style; a 3K TT every 6–8 weeks in a cutback slot (a TT week counts as
 *    the cutback, §6.7 C2).
 *  - No taper and no race. N weeks (default 12) from `today`.
 *
 * Internally the generator reuses the race pipeline with a "race-shaped" input: a reference distance
 * for the §6.5/§6.6 caps and P3 emphasis, and a virtual race day far past the plan's end so that no
 * race-proximity rule (T3, L2's peak window, ST taper days) ever fires.
 */
import type { GeneralFitnessInput, GoalDistance, Level, Phase, PlanInput } from "./plan-types.js";
import type { BuildWeekKind } from "./volume.js";
import { addDays, toDayNumber, weekdayIndex, WEEKDAYS, type PlanCalendar } from "./dates.js";

export const GENERAL_FITNESS_DEFAULT_WEEKS = 12;
export const GENERAL_FITNESS_MAX_WEEKS = 52;
/** TT every 2 blocks: 8 weeks at 3:1, 6 weeks at 2:1 (§6.1 "every 6–8 weeks"). */
export const GF_TT_EVERY_BLOCKS = 2;
/** Days between the plan's last day and the virtual race day: past every taper/T3/ST window (D). */
const VIRTUAL_RACE_GAP_DAYS = 70;

/** Reference distance: the goal's, else 10K for beginners/novices and half otherwise (D). */
export function generalFitnessReferenceDistance(level: Level, goal: GeneralFitnessInput["goal"]): GoalDistance {
  if (goal.referenceDistance) {
    // Beginners can't take the HM/M caps (§6.2 level block); fall back to 10K.
    const blocked = level === "beginner" && (goal.referenceDistance === "half" || goal.referenceDistance === "marathon");
    return blocked ? "10k" : goal.referenceDistance;
  }
  return level === "beginner" || level === "novice" ? "10k" : "half";
}

export function generalFitnessWeeks(goal: GeneralFitnessInput["goal"]): number {
  const n = Math.round(goal.weeks ?? GENERAL_FITNESS_DEFAULT_WEEKS);
  return Math.max(1, Math.min(GENERAL_FITNESS_MAX_WEEKS, n));
}

/**
 * Weeks start today (no lead-in) and the long run lands on the long-run weekday inside each 7-day block.
 * `raceDay` is virtual (see the module note); `raceOffset` is unused in this mode.
 */
export function generalFitnessCalendar(input: Pick<GeneralFitnessInput, "today" | "longRunDay" | "goal">): PlanCalendar {
  const weeks = generalFitnessWeeks(input.goal);
  const startDay = toDayNumber(input.today);
  const startWeekday = weekdayIndex(input.today);
  return {
    weeks,
    startDay,
    raceDay: startDay + 7 * weeks - 1 + VIRTUAL_RACE_GAP_DAYS,
    raceOffset: 6,
    lrOffset: (WEEKDAYS.indexOf(input.longRunDay) - startWeekday + 7) % 7,
    leadInDays: 0,
  };
}

/** The race-shaped input the shared pipeline runs on. Never shown to the user. */
export function generalFitnessAsRaceInput(input: GeneralFitnessInput): PlanInput {
  const { goal, ...rest } = input;
  const cal = generalFitnessCalendar(input);
  return {
    ...rest,
    goal: { distance: generalFitnessReferenceDistance(input.level, goal) },
    raceDate: addDays(input.today, cal.raceDay - cal.startDay),
  };
}

/**
 * Week kinds after any ladder weeks: `every − 1` build weeks then a cutback, repeating. Every
 * GF_TT_EVERY_BLOCKS-th cutback is a TT week; with no trusted VDOT the first TT comes at the end of
 * block 1 (D).
 */
export function generalFitnessKinds(count: number, every: number, needsTt: boolean): BuildWeekKind[] {
  const kinds: BuildWeekKind[] = [];
  for (let i = 0; i < count; i++) {
    const pos = i % every;
    if (pos !== every - 1) {
      kinds.push("build");
      continue;
    }
    const block = Math.floor(i / every); // 0-based
    const tt = needsTt ? block % GF_TT_EVERY_BLOCKS === 0 : block % GF_TT_EVERY_BLOCKS === GF_TT_EVERY_BLOCKS - 1;
    kinds.push(tt ? "tt" : "cutback");
  }
  return kinds;
}

/** Content cycle per block: FI, EQ, EQ, FI, … (D). Ladder weeks are FI. */
export function generalFitnessPhases(ladderWeeks: number, count: number, every: number): Phase[] {
  const cycle: Phase[] = ["FI", "EQ", "EQ"];
  return [
    ...Array<Phase>(ladderWeeks).fill("FI"),
    ...Array.from({ length: count }, (_, i) => cycle[Math.floor(i / every) % cycle.length] as Phase),
  ];
}

/** Weekly km the plan builds toward: target km, else target minutes at E pace, else undefined (V3 default). */
export function generalFitnessTargetKm(goal: GeneralFitnessInput["goal"], easyPaceSPerKm: number): number | undefined {
  if (goal.targetWeeklyMinutes !== undefined && goal.targetWeeklyMinutes > 0) {
    return (goal.targetWeeklyMinutes * 60) / easyPaceSPerKm;
  }
  if (goal.targetWeeklyKm !== undefined && goal.targetWeeklyKm > 0) return goal.targetWeeklyKm;
  return undefined;
}
