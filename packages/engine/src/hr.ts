/**
 * Heart-rate targets (spec §3.7, §3.8, §4.6, §6.9).
 *
 *  - HRmax: the input's hrMax (measured unless said otherwise), else Tanaka 208 − 0.7·age when the
 *    input asks for the age formula (§4.6 HRmax policy). Without either, HR targets are off.
 *  - Single target per step (§3.7, D): easy, long and recovery steps take the HR range as their
 *    target (pace, if any, becomes the fallback); T/I/M/R and other pace steps keep the pace target
 *    with the HR range as fallback.
 *  - Ranges are the §4.1 %HRmax bands, resolved to bpm (§3.8 "HR as %HRmax plus resolved bpm").
 *  - Beginners: the 65–79% band (79% = the §6.9 HR cap) only from a measured HRmax (§6.9); with an
 *    age-formula HRmax they stay on RPE / talk test.
 */
import type { HrMaxSource } from "./analysis.js";
import { tanakaHrMax } from "./analysis.js";
import type { Level, PlanInput } from "./plan-types.js";
import type { Target } from "./workout.js";

/** §6.9: beginners' runs are capped at 79% HRmax (the top of the E band). */
export const BEGINNER_HR_CAP_PCT = 79;
/** Plausible HRmax range (§2.3 validation: 140–220 bpm, widened for the age formula). */
const HR_MAX_RANGE = { min: 100, max: 230 } as const;

export interface ResolvedHr {
  maxBpm: number;
  source: HrMaxSource;
}

/** The HRmax the plan uses, or undefined when HR targets are off. */
export function resolveHrMax(input: Pick<PlanInput, "hrMax" | "hrMaxSource" | "age">): ResolvedHr | undefined {
  const ok = (x: number) => Number.isFinite(x) && x >= HR_MAX_RANGE.min && x <= HR_MAX_RANGE.max;
  if (input.hrMax !== undefined && ok(input.hrMax)) return { maxBpm: Math.round(input.hrMax), source: input.hrMaxSource ?? "measured" };
  if (input.hrMaxSource === "age_formula" && input.age !== undefined && input.age > 0) {
    const bpm = Math.round(tanakaHrMax(input.age));
    if (ok(bpm)) return { maxBpm: bpm, source: "age_formula" };
  }
  return undefined;
}

/** Whether this runner gets HR targets at all (§6.9: beginners only from a measured HRmax). */
export function hrTargetsFor(level: Level, hr: ResolvedHr | undefined): ResolvedHr | undefined {
  if (!hr) return undefined;
  return level === "beginner" && hr.source !== "measured" ? undefined : hr;
}

/** A %HRmax band as a DSL target, with bpm when the HRmax is known. */
export function hrTarget(band: { lo: number; hi: number }, hr: ResolvedHr | undefined): Extract<Target, { type: "hr_pct_max" }> {
  const t: Extract<Target, { type: "hr_pct_max" }> = { type: "hr_pct_max", lo: band.lo, hi: band.hi };
  if (hr) {
    t.lo_bpm = Math.round((band.lo / 100) * hr.maxBpm);
    t.hi_bpm = Math.round((band.hi / 100) * hr.maxBpm);
  }
  return t;
}
