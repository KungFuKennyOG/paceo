/**
 * Phase lengths (spec §6.3, Daniels table, C) and the P1 adjustments (D on C).
 */
import type { Level, Phase } from "./plan-types.js";

export type QualityPhase = Exclude<Phase, "BASE">;

export interface PhaseSplit {
  FI: number;
  EQ: number;
  TQ: number;
  FQ: number;
}

/** Daniels caps each phase at 6 weeks, so the table tops out at 24. */
export const MAX_DANIELS_WEEKS = 24;

/**
 * The phase that receives week n (1-based) as the plan grows one week at a time.
 * Weeks 1–12 fill FI to 3, then FQ, TQ and EQ to 3 each (Coach Ray's order).
 * Weeks 13–24 are added in pairs that reproduce Daniels' table (14, 16, …, 24); within each pair the
 * same fill priority (FI, FQ, TQ, EQ) decides which phase takes the odd week. (C table, D for odd weeks.)
 */
const FILL_ORDER: readonly QualityPhase[] = [
  "FI", "FI", "FI", // 1–3
  "FQ", "FQ", "FQ", // 4–6
  "TQ", "TQ", "TQ", // 7–9
  "EQ", "EQ", "EQ", // 10–12
  "FI", "TQ", // 13–14 → 4/3/4/3
  "TQ", "TQ", // 15–16 → 4/3/6/3
  "FQ", "EQ", // 17–18 → 4/4/6/4
  "EQ", "EQ", // 19–20 → 4/6/6/4
  "FI", "FQ", // 21–22 → 5/6/6/5
  "FI", "FQ", // 23–24 → 6/6/6/6
];

/** Raw Daniels allocation for 1–24 weeks (§6.3 table). */
export function danielsPhaseSplit(weeks: number): PhaseSplit {
  if (!Number.isInteger(weeks) || weeks < 1 || weeks > MAX_DANIELS_WEEKS) {
    throw new RangeError(`phase table covers 1–${MAX_DANIELS_WEEKS} weeks, got ${weeks}`);
  }
  const split: PhaseSplit = { FI: 0, EQ: 0, TQ: 0, FQ: 0 };
  // Below 4 weeks the table has no row; keep one FQ week so the taper has a home (D).
  if (weeks < 4) return { ...split, FI: weeks - 1, FQ: 1 };
  for (const phase of FILL_ORDER.slice(0, weeks)) split[phase] += 1;
  return split;
}

export interface PlanPhases {
  /** General-mode weeks prepended to plans longer than 24 weeks (P1). */
  base: number;
  split: PhaseSplit;
  /** Phase label for each plan week, index 0 = week 1. */
  byWeek: Phase[];
  /**
   * Continuation only: phases of the original plan's weeks before week 1, so a phase that started
   * before the rebuild keeps its position (week index within the phase, P3 emphasis).
   */
  before?: Phase[];
  /** Continuation only: Foundation rebuild weeks at the front (R-BREAK > 28 d, D). */
  rebuildWeeks?: number;
}

/**
 * Daniels split plus the P1 adjustments:
 *  - > 24 weeks: prepend BASE weeks (General mode) and run the 24-week split after them.
 *  - beginner / novice: FI grows by 2 / 1 weeks taken from EQ. We never take more than half of EQ,
 *    which keeps persona A's 10-week split at 3/1/3/3 as §6.3 lists it (D).
 *  - run/walk ladder weeks count inside FI; if they don't fit, FI borrows from EQ, then TQ (D).
 */
export function planPhases(totalWeeks: number, level: Level, ladderWeeks = 0): PlanPhases {
  const base = Math.max(0, totalWeeks - MAX_DANIELS_WEEKS);
  const split = { ...danielsPhaseSplit(totalWeeks - base) };

  const wanted = level === "beginner" ? 2 : level === "novice" ? 1 : 0;
  const extend = Math.min(wanted, Math.floor(split.EQ / 2));
  split.FI += extend;
  split.EQ -= extend;

  for (const donor of ["EQ", "TQ"] as const) {
    const take = Math.min(split[donor], Math.max(0, ladderWeeks - split.FI));
    split[donor] -= take;
    split.FI += take;
  }

  const byWeek: Phase[] = [
    ...Array<Phase>(base).fill("BASE"),
    ...Array<Phase>(split.FI).fill("FI"),
    ...Array<Phase>(split.EQ).fill("EQ"),
    ...Array<Phase>(split.TQ).fill("TQ"),
    ...Array<Phase>(split.FQ).fill("FQ"),
  ];
  return { base, split, byWeek };
}

/** At most this many Foundation rebuild weeks go into a continued plan (§8 R-BREAK > 28 d, D). */
export const MAX_REBUILD_WEEKS = 2;

export interface ContinuationOptions {
  phaseReset?: boolean;
  rebuildWeeks?: number;
  restart?: boolean;
}

/**
 * Phases for a mid-plan rebuild (§8 R-RACE-1/2 and R-BREAK; the rule is D):
 *  - Week w keeps the original phase of its date. The last `taperWeeks` weeks (the taper, §6.8 P2)
 *    are never changed (R-RACE-1: compress the build, not the taper).
 *  - `restart` ("treat it as a new plan if the date allows", R-BREAK > 28 d): the build weeks are
 *    re-split with the §6.3 table and P1 (planPhases over the weeks left); the taper stays.
 *  - `rebuildWeeks`: that many FI weeks go first. Each replaces one week of the earliest quality
 *    phase that still has ≥ 2 build weeks (the interrupted phase first), so no phase disappears;
 *    fewer fit when the build is too short. Never inside BASE (it is easy running already).
 *  - Run/walk ladder weeks must be FI: the earliest build weeks become FI as needed (planPhases
 *    likewise borrows from EQ, then TQ).
 *  - The current phase resumes where it was (`before` = the original weeks before week 1), unless
 *    `phaseReset`, a restart or rebuild weeks start it over ("shift back within the phase").
 * `calendar.length` must be ≥ `weeks` (the caller checks); it ends on race day like the plan.
 */
export function continuedPhases(
  calendar: readonly Phase[],
  weeks: number,
  taperWeeks: number,
  level: Level,
  ladderWeeks: number,
  opts: ContinuationOptions = {},
): PlanPhases {
  const elapsed = calendar.length - weeks;
  const remaining = calendar.slice(elapsed);
  const taper = Math.max(0, Math.min(taperWeeks, weeks));
  const buildN = weeks - taper;
  let build: Phase[] = opts.restart && buildN > 0 ? planPhases(weeks, level, ladderWeeks).byWeek.slice(0, buildN) : remaining.slice(0, buildN);

  let rebuild = 0;
  const wanted = opts.restart ? 0 : Math.max(0, Math.min(MAX_REBUILD_WEEKS, Math.round(opts.rebuildWeeks ?? 0)));
  while (rebuild < wanted && build[0] !== "BASE") {
    const count = (p: Phase) => build.slice(rebuild).filter((x) => x === p).length;
    const donor = build.findIndex((p, i) => i >= rebuild && p !== "FI" && p !== "BASE" && count(p) >= 2);
    if (donor < 0) break;
    build = ["FI", ...build.slice(0, donor), ...build.slice(donor + 1)];
    rebuild += 1;
  }
  for (let i = 0; i < Math.min(ladderWeeks, build.length); i++) if (build[i] !== "BASE") build[i] = "FI";

  const byWeek: Phase[] = [...build, ...remaining.slice(buildN)];
  const split: PhaseSplit = { FI: 0, EQ: 0, TQ: 0, FQ: 0 };
  for (const p of byWeek) if (p !== "BASE") split[p] += 1;
  const fresh = opts.phaseReset === true || opts.restart === true || rebuild > 0;
  return {
    base: byWeek.filter((p) => p === "BASE").length,
    split,
    byWeek,
    before: fresh ? [] : calendar.slice(0, elapsed),
    rebuildWeeks: rebuild,
  };
}
