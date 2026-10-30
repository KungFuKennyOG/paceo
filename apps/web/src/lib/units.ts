/**
 * Display formatting (spec §5). Everything is stored in SI; these helpers convert only for display,
 * and the parse helpers convert user input back to SI at the edge.
 */
import {
  formatDistance,
  formatDuration,
  formatMinSec,
  formatPace,
  formatPaceRange,
  METRES_PER_MILE,
  type PaceRange,
  type Units,
} from "@paceo/engine";

export { formatDistance, formatDuration, formatMinSec, formatPace, formatPaceRange, METRES_PER_MILE };
export type { PaceRange, Units };

/** US (and the two other imperial holdouts) default to imperial (§2.3). */
export function defaultUnits(locale?: string): Units {
  const l = locale ?? (typeof navigator !== "undefined" ? navigator.language : "en");
  return /^(en-US|en-LR|my-MM|my)$/i.test(l) ? "imperial" : "metric";
}

export function distanceUnit(units: Units): string {
  return units === "imperial" ? "mi" : "km";
}

/** km → display number in the user's unit. */
export function kmToUnit(km: number, units: Units): number {
  return units === "imperial" ? (km * 1000) / METRES_PER_MILE : km;
}

/** Display number in the user's unit → km (SI at the edge). */
export function unitToKm(value: number, units: Units): number {
  return units === "imperial" ? (value * METRES_PER_MILE) / 1000 : value;
}

/** "42 km" / "26 mi" style with chosen precision. */
export function formatKm(km: number, units: Units, digits = 1): string {
  return `${kmToUnit(km, units).toFixed(digits)} ${distanceUnit(units)}`;
}

/** Long-run prescriptions round to 0.5 km/mi (§5). */
export function formatLongRunDistance(m: number, units: Units): string {
  const v = kmToUnit(m / 1000, units);
  const r = Math.round(v * 2) / 2;
  return `${Number.isInteger(r) ? r.toFixed(0) : r.toFixed(1)} ${distanceUnit(units)}`;
}

const MILE_FRACTIONS: Record<number, string> = {
  200: "⅛ mi",
  400: "¼ mi",
  800: "½ mi",
  1200: "¾ mi",
  1600: "1 mi",
};

/**
 * Rep distances keep metric track units for everyone, with mile equivalents in brackets for
 * imperial users (§3.8, §5): "800 m (½ mi)".
 */
export function formatRepDistance(m: number, units: Units): string {
  const rounded = Math.round(m);
  const metric = rounded >= 1000 && rounded % 1000 === 0 ? `${rounded / 1000} km` : `${rounded.toLocaleString("en-US")} m`;
  if (units === "metric") return metric;
  const frac = MILE_FRACTIONS[rounded];
  const miles = frac ?? `${(rounded / METRES_PER_MILE).toFixed(2)} mi`;
  return `${metric} (${miles})`;
}

/** A pace target stored as lo/hi s/km (lo = faster bound). */
export function formatPaceTarget(loSPerKm: number, hiSPerKm: number, units: Units): string {
  return formatPaceRange({ fast: Math.min(loSPerKm, hiSPerKm), slow: Math.max(loSPerKm, hiSPerKm) }, units);
}

/** "45 min" or "1 h 30 min". */
export function formatMinutes(min: number): string {
  const total = Math.round(min);
  if (total < 60) return `${total} min`;
  const h = Math.floor(total / 60);
  const m = total % 60;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

/** Duration in seconds as "8 min", "90 s" or "1 h 05 min". */
export function formatSeconds(s: number): string {
  const total = Math.round(s);
  if (total < 120 && total % 60 !== 0) return `${total} s`;
  if (total % 60 === 0) return formatMinutes(total / 60);
  return formatMinSec(total);
}

export const KG_PER_LB = 0.45359237;

/**
 * Strength loads (§5): lb users get 5 lb steps for big lifts and 2.5 lb for small ones,
 * mirroring +5 kg / +2.5 kg.
 */
export function formatLoad(kg: number, units: Units, small = false): string {
  if (units === "metric") {
    const step = small ? 1 : 2.5;
    return `${(Math.round(kg / step) * step).toString()} kg`;
  }
  const lb = kg / KG_PER_LB;
  const step = small ? 2.5 : 5;
  return `${(Math.round(lb / step) * step).toString()} lb`;
}

/** Parse "h:mm:ss", "mm:ss" or plain minutes into seconds. Returns null when it doesn't parse. */
export function parseDuration(text: string): number | null {
  const t = text.trim();
  if (!t) return null;
  if (/^\d+(\.\d+)?$/.test(t)) return Math.round(Number(t) * 60);
  const parts = t.split(":");
  if (parts.length < 2 || parts.length > 3 || parts.some((p) => !/^\d+$/.test(p))) return null;
  const nums = parts.map(Number);
  if (nums.length === 2) {
    const [m, s] = nums as [number, number];
    if (s >= 60) return null;
    return m * 60 + s;
  }
  const [h, m, s] = nums as [number, number, number];
  if (m >= 60 || s >= 60) return null;
  return h * 3600 + m * 60 + s;
}
