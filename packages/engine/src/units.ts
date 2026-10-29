/**
 * Units and display (spec §5). Internal values are always SI; these helpers are display-only.
 */
import type { PaceRange } from "./paces.js";

export type Units = "metric" | "imperial";

export const METRES_PER_MILE = 1609.344;
export const KM_PER_MILE = 1.609344;

/** s/km → s per display unit. */
export function paceToUnit(sPerKm: number, units: Units): number {
  return units === "imperial" ? sPerKm * KM_PER_MILE : sPerKm;
}

/** "m:ss" for a duration in whole seconds. */
export function formatMinSec(totalS: number): string {
  const s = Math.round(totalS);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, "0")}`;
}

/** "h:mm:ss" or "m:ss". */
export function formatDuration(totalS: number): string {
  const s = Math.round(totalS);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
  return `${m}:${String(r).padStart(2, "0")}`;
}

/** e.g. "6:15 /km" or "10:04 /mi". Pace rounds to the nearest second. */
export function formatPace(sPerKm: number, units: Units = "metric"): string {
  const suffix = units === "imperial" ? "/mi" : "/km";
  return `${formatMinSec(paceToUnit(sPerKm, units))} ${suffix}`;
}

/**
 * Pace range for display, rounded OUTWARD (fast end down, slow end up)
 * so the displayed range never narrows (spec §5). Shown slow–fast, e.g. "6:07–5:50 /km".
 */
export function formatPaceRange(r: PaceRange, units: Units = "metric"): string {
  const fast = Math.floor(paceToUnit(r.fast, units));
  const slow = Math.ceil(paceToUnit(r.slow, units));
  const suffix = units === "imperial" ? "/mi" : "/km";
  return `${formatMinSec(slow)}–${formatMinSec(fast)} ${suffix}`;
}

/** Distance for display, 0.1 precision. */
export function formatDistance(m: number, units: Units = "metric"): string {
  if (units === "imperial") return `${(m / METRES_PER_MILE).toFixed(1)} mi`;
  return `${(m / 1000).toFixed(1)} km`;
}
