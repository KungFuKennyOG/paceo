/**
 * Daniels–Gilbert VDOT model (spec §4.1).
 *
 * Units are fixed by the original equations:
 *   velocity v in metres per MINUTE, race duration t in MINUTES.
 * Public functions in this module take SI inputs (metres, seconds) and convert internally.
 *
 * Label: C (published model, secondary transcriptions agree across calculators).
 */

const A = -4.6;
const B = 0.182258;
const C = 0.000104;

/** Oxygen cost of running at velocity v (m/min), in ml·kg⁻¹·min⁻¹. */
export function vo2AtVelocity(vMPerMin: number): number {
  return A + B * vMPerMin + C * vMPerMin * vMPerMin;
}

/** Fraction of VO2max sustainable for a race lasting t minutes. */
export function fractionSustainable(tMin: number): number {
  return (
    0.8 +
    0.1894393 * Math.exp(-0.012778 * tMin) +
    0.2989558 * Math.exp(-0.1932605 * tMin)
  );
}

/** Valid input range for the app (spec §4.1, D). */
export const VDOT_MIN = 15;
export const VDOT_MAX = 85;
export const RACE_MIN_S = 3.5 * 60;
export const RACE_MAX_S = 360 * 60;

export class VdotRangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VdotRangeError";
  }
}

/** VDOT from a race or time-trial result. */
export function computeVdot(distanceM: number, timeS: number): number {
  if (!(distanceM > 0) || !(timeS > 0)) {
    throw new VdotRangeError("distance and time must be positive");
  }
  if (timeS < RACE_MIN_S || timeS > RACE_MAX_S) {
    throw new VdotRangeError(
      `race duration ${Math.round(timeS)} s is outside the supported ${RACE_MIN_S}–${RACE_MAX_S} s range`,
    );
  }
  const tMin = timeS / 60;
  const v = distanceM / tMin;
  return vo2AtVelocity(v) / fractionSustainable(tMin);
}

/** True when a VDOT is inside the range the app trusts; outside it, use cold start (§4.2). */
export function isVdotInRange(vdot: number): boolean {
  return vdot >= VDOT_MIN && vdot <= VDOT_MAX;
}

/**
 * Velocity (m/min) at which the oxygen cost equals `fraction × vdot`.
 * Inverts the quadratic VO2(v).
 */
export function velocityAtFraction(vdot: number, fraction: number): number {
  const target = fraction * vdot;
  const disc = B * B - 4 * C * (A - target);
  return (-B + Math.sqrt(disc)) / (2 * C);
}

/** Training pace (s/km) at a given fraction of VDOT. */
export function paceAtFraction(vdot: number, fraction: number): number {
  return 60000 / velocityAtFraction(vdot, fraction);
}

/**
 * Race-equivalent time (s) at `distanceM` for a given VDOT.
 * Solves computeVdot(d, t) = vdot by bisection over 1–900 min; VDOT decreases as t increases.
 */
export function raceTimeS(vdot: number, distanceM: number): number {
  let lo = 1; // minutes
  let hi = 900;
  const vdotAt = (tMin: number) =>
    vo2AtVelocity(distanceM / tMin) / fractionSustainable(tMin);
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (vdotAt(mid) > vdot) lo = mid;
    else hi = mid;
    if (hi - lo < 1e-9) break;
  }
  return ((lo + hi) / 2) * 60;
}

/** Common race distances in metres. */
export const DISTANCES_M = {
  mile: 1609.344,
  "3k": 3000,
  "5k": 5000,
  "10k": 10000,
  half: 21097.5,
  marathon: 42195,
} as const;

export type RaceDistanceKey = keyof typeof DISTANCES_M;

/**
 * Rule PACE-FADE (spec §4.4, D on E/C).
 * Predicts a half/marathon goal time from a shorter anchor result with a personal fade exponent,
 * because raw VDOT (≈ Riegel 1.05) is too optimistic for recreational marathoners.
 */
export function defaultFadeExponent(vdot: number, lowVolume = false): number {
  const hmEquivMin = raceTimeS(vdot, DISTANCES_M.half) / 60;
  let k = clamp(1.1 + (0.05 * (hmEquivMin - 80)) / 40, 1.08, 1.15);
  if (lowVolume) k = Math.min(k + 0.03, 1.19);
  return k;
}

/** Personal fade exponent once two races exist: ln(T2/T1)/ln(D2/D1), clamped 1.03–1.20. */
export function fittedFadeExponent(
  d1M: number,
  t1S: number,
  d2M: number,
  t2S: number,
): number {
  return clamp(Math.log(t2S / t1S) / Math.log(d2M / d1M), 1.03, 1.2);
}

export function fadedRaceTimeS(
  anchorDistanceM: number,
  anchorTimeS: number,
  goalDistanceM: number,
  k: number,
): number {
  return anchorTimeS * Math.pow(goalDistanceM / anchorDistanceM, k);
}

export function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}
