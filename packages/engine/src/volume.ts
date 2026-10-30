/**
 * Weekly volume progression (spec §6.5 V2/V3) and cutbacks (§6.7 C1/C2).
 */
import type { GoalDistance, Level, Phase } from "./plan-types.js";

type CeilingBucket = "short" | "half" | "marathon";

/** Peak weekly ceilings in km/week by level × distance (§6.5 table, D). null = blocked for that level. */
export const PEAK_CEILING_KM: Record<Level, Record<CeilingBucket, readonly [number, number] | null>> = {
  beginner: { short: [15, 25], half: null, marathon: null },
  novice: { short: [20, 40], half: [30, 45], marathon: [40, 55] },
  intermediate: { short: [30, 55], half: [40, 65], marathon: [50, 80] },
  advanced: { short: [45, 80], half: [55, 95], marathon: [65, 110] },
};

/** V3 Δmax: the most the peak may sit above the starting volume (D). Beginner value is D (not in spec). */
export const PEAK_DELTA_MAX_KM: Record<Level, number> = {
  beginner: 10,
  novice: 15,
  intermediate: 25,
  advanced: 30,
};

/** V2: weekly growth target (5–10% → 8%, matching V3's 1.08), hard cap 15%, never above 30%. */
export const WEEKLY_GROWTH = 0.08;
export const WEEKLY_GROWTH_HARD_CAP = 0.15;
export const WEEKLY_GROWTH_NEVER = 0.3;
/** V2 low-volume rule: below this, allow an absolute step instead of a percentage. */
export const LOW_VOLUME_KM = 25;
/** Low-volume absolute step, lower end of the spec's 1.5–3 km range (D, see weeklyStepKm). */
export const LOW_VOLUME_STEP_KM = 1.5;

/** §6.7 cutback size: volume −20–30% → −25%; long run −25–35% → −30%; quality kept at 60–70% → 65%. */
export const CUTBACK_VOLUME_FACTOR = 0.75;
export const CUTBACK_LONG_RUN_FACTOR = 0.7;
export const CUTBACK_QUALITY_FACTOR = 0.65;

function bucket(distance: GoalDistance): CeilingBucket {
  if (distance === "marathon") return "marathon";
  if (distance === "half") return "half";
  return "short";
}

/**
 * §6.5: ceiling = min(range max, max(range min, 1.5 × entry volume)).
 * Blocked level/distance pairs (beginner HM/M) fall back to the novice row so the number is defined;
 * feasibility blocks those plans before they are generated (D).
 */
export function peakCeilingKm(level: Level, distance: GoalDistance, entryKm: number): number {
  const b = bucket(distance);
  const range = PEAK_CEILING_KM[level][b] ?? PEAK_CEILING_KM.novice[b];
  if (!range) throw new Error(`no ceiling for ${level}/${distance}`);
  const [lo, hi] = range;
  return Math.min(hi, Math.max(lo, 1.5 * entryKm));
}

/**
 * V3 peak cap: min(start + Δmax, ceiling), never below the starting volume (we never plan a
 * reduction just because someone already runs more than the ceiling). The start × 1.08^n term
 * is enforced step by step by weeklyStepKm.
 */
export function peakWeeklyKm(level: Level, distance: GoalDistance, startKm: number): number {
  const cap = Math.min(startKm + PEAK_DELTA_MAX_KM[level], peakCeilingKm(level, distance, startKm));
  return Math.max(startKm, cap);
}

/**
 * V2 step for one build week.
 * ≥ 25 km: +8%. Below 25 km the spec allows "+1.5–3 km per run day per build week"; we read that
 * conservatively as an absolute floor of +1.5 km per week, still under the 15% hard cap (D).
 */
export function weeklyStepKm(levelKm: number): number {
  const pct = WEEKLY_GROWTH * levelKm;
  if (levelKm >= LOW_VOLUME_KM) return pct;
  return Math.max(pct, Math.min(LOW_VOLUME_STEP_KM, WEEKLY_GROWTH_HARD_CAP * levelKm));
}

export interface CutbackPolicy {
  /** A cutback every N weeks: 3 = "2:1", 4 = "3:1". */
  every: 3 | 4;
  /** Rule IDs that triggered 2:1. */
  triggers: string[];
}

export interface CutbackInputs {
  level: Level;
  age?: number;
  injuryFlag: boolean;
  heavyCrossTraining: boolean;
}

/**
 * C1: 3:1 by default; 2:1 for age ≥ 40, injury flag, beginner/novice or heavy cross-training.
 * 4:1 is opt-in only for advanced runners under 40 and is never chosen by default.
 * TODO(§6.7, §8 R-LOAD-4): 4:1 opt-in and the R-LOAD-4 trigger need profile/load inputs.
 */
export function cutbackPolicy(input: CutbackInputs): CutbackPolicy {
  const triggers: string[] = [];
  if (input.age !== undefined && input.age >= 40) triggers.push("C1:age>=40");
  if (input.injuryFlag) triggers.push("C1:injury");
  if (input.level === "beginner" || input.level === "novice") triggers.push(`C1:${input.level}`);
  if (input.heavyCrossTraining) triggers.push("C1:cross_training>40%");
  return { every: triggers.length > 0 ? 3 : 4, triggers };
}

export type BuildWeekKind = "build" | "cutback" | "tt";

/** At least this many build weeks sit between two cutbacks, even after the C2 moves (D). */
export const MIN_BUILD_WEEKS_BETWEEN_CUTBACKS = 2;

/**
 * Lay out cutbacks across the build weeks (taper excluded).
 *  - C1: a cutback after every (N − 1) build weeks; a TT week counts as the cutback (C2).
 *  - C2 phase alignment: in the last week of a phase, a cutback that is due next week comes one
 *    week early, provided at least 2 build weeks precede it (so 3:1 can align; 2:1 already fits).
 *  - C2: no cutback in the last build week (the week right before the taper). It moves one week
 *    earlier under the same 2-build-week condition, otherwise it is dropped (the taper follows).
 * `phases[i]` and `ttWeeks` are indexed like the build weeks.
 */
export function layoutBuildWeeks(
  count: number,
  every: number,
  phases: readonly Phase[],
  ttWeeks: ReadonlySet<number> = new Set(),
): BuildWeekKind[] {
  const kinds: BuildWeekKind[] = [];
  let since = 0; // build weeks since the last cutback / TT
  for (let i = 0; i < count; i++) {
    const phaseEnds = i + 1 < count && phases[i + 1] !== phases[i];
    const due = since >= every - 1;
    const early = phaseEnds && since === every - 2 && since >= MIN_BUILD_WEEKS_BETWEEN_CUTBACKS;
    if (ttWeeks.has(i)) {
      kinds.push("tt");
      since = 0;
    } else if (due || early) {
      kinds.push("cutback");
      since = 0;
    } else {
      kinds.push("build");
      since += 1;
    }
  }
  const last = count - 1;
  if (last >= 1 && kinds[last] === "cutback") {
    kinds[last] = "build";
    if (buildsBefore(kinds, last - 1) >= MIN_BUILD_WEEKS_BETWEEN_CUTBACKS) kinds[last - 1] = "cutback";
  }
  return kinds;
}

/** Consecutive build weeks immediately before index j. */
function buildsBefore(kinds: readonly BuildWeekKind[], j: number): number {
  let n = 0;
  for (let k = j - 1; k >= 0 && kinds[k] === "build"; k--) n++;
  return kinds[j] === "build" ? n : -1;
}

/**
 * Weekly targets for the build weeks (km).
 *  - Week 1 starts at the current volume (V3).
 *  - A build week after a build week grows by weeklyStepKm, up to the peak.
 *  - A cutback is −25% of the current level; the week after it resumes at the pre-cutback level
 *    (e.g. 40-44-48-34-48-52, §6.7) …
 *  - … except that no week may exceed the previous one by more than 30% (V2 "never"). After a −25%
 *    cutback, a full resume would be +33%, so V2 wins and the resume week lands at ~97% of the
 *    pre-cutback level (D). The cap keeps a 2% margin for 100 m / whole-minute rounding.
 *  - A TT week counts as the cutback (C2), so it gets the cutback volume too.
 */
export function buildWeekTargets(
  startKm: number,
  peakKm: number,
  kinds: readonly BuildWeekKind[],
  /** Cutback / TT weeks never go below this (see CUTBACK_FLOOR_OF_ENTRY). */
  floorKm = 0,
): number[] {
  const targets: number[] = [];
  let level = startKm;
  kinds.forEach((kind, i) => {
    if (i > 0 && kind === "build" && kinds[i - 1] === "build") {
      level = Math.min(peakKm, level + weeklyStepKm(level));
    }
    const prev = targets[i - 1];
    const wanted = kind === "build" ? level : Math.max(level * CUTBACK_VOLUME_FACTOR, Math.min(level, floorKm));
    targets.push(prev === undefined ? wanted : Math.min(wanted, prev * MAX_WEEK_OVER_WEEK));
  });
  return targets;
}

/**
 * Cutbacks never drop below 95% of the build's starting volume (D): the runner already handles that
 * volume, so a deeper cut is detraining. Early cutbacks therefore come out shallower than −25%
 * (e.g. persona B week 3: 45.4 → 39.9 km, −12%). The 5% margin lets planned km land a little under
 * target (runs are floored to whole minutes / 100 m) and still stay ≥ 90% of entry.
 */
export const CUTBACK_FLOOR_OF_ENTRY = 0.95;

/** V2 "never above 30%", less a 2% rounding margin. */
export const MAX_WEEK_OVER_WEEK = (1 + WEEKLY_GROWTH_NEVER) * 0.98;
