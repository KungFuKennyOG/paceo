/**
 * Beginner run/walk ladder (spec §6.9, D modelled on NHS C25K, C).
 * Each stage is 3 sessions in one week; every session = 5 min brisk walk + block + 5 min walk.
 */

export interface LadderStage {
  stage: number;
  reps: number;
  runS: number;
  /** 0 for continuous stages (8–10). */
  walkS: number;
}

export const LADDER_STAGES: readonly LadderStage[] = [
  { stage: 1, reps: 8, runS: 60, walkS: 90 },
  { stage: 2, reps: 6, runS: 90, walkS: 120 },
  { stage: 3, reps: 6, runS: 120, walkS: 90 },
  { stage: 4, reps: 5, runS: 180, walkS: 90 },
  { stage: 5, reps: 4, runS: 300, walkS: 120 },
  { stage: 6, reps: 2, runS: 600, walkS: 120 },
  { stage: 7, reps: 2, runS: 750, walkS: 120 },
  { stage: 8, reps: 1, runS: 1200, walkS: 0 },
  { stage: 9, reps: 1, runS: 1500, walkS: 0 },
  { stage: 10, reps: 1, runS: 1800, walkS: 0 },
];

/** Brisk walk before and after the block (§6.9). */
export const LADDER_WALK_WARMUP_S = 300;
/** Stage 8 = 20 min continuous: graduation, then the TT within 2 weeks (§6.9). */
export const LADDER_GRADUATION_STAGE = 8;

export function ladderStage(stage: number): LadderStage {
  const s = LADDER_STAGES[stage - 1];
  if (!s) throw new RangeError(`ladder stage ${stage} does not exist (1–10)`);
  return s;
}

/**
 * Ladder weeks the plan needs before handing over (§6.1 beginner ladder mode): one week per stage
 * from the entry stage through graduation (stage 8, 20 min continuous). The TT follows the next
 * week (§6.9 "within 2 weeks"). "Can run 20 min continuously" skips the ladder.
 * Planned at one stage per week; the "repeat / step back" rules are replanning (§8 TODO).
 */
export function ladderWeeksNeeded(canRun20MinContinuous: boolean, entryStage = 1): number {
  if (canRun20MinContinuous) return 0;
  const entry = Math.min(Math.max(1, Math.round(entryStage)), LADDER_GRADUATION_STAGE);
  return LADDER_GRADUATION_STAGE - entry + 1;
}

/** Total session duration in seconds; the walking warm-up/cool-down is 5 min in §6.9 but V1 may need less (D). */
export function ladderSessionSecondsWith(stage: number, walkWarmCoolS: number): number {
  const s = ladderStage(stage);
  return 2 * walkWarmCoolS + s.reps * (s.runS + s.walkS);
}

/** Total running time of one session in a stage, seconds. */
export function ladderRunSeconds(stage: number): number {
  const s = ladderStage(stage);
  return s.reps * s.runS;
}
