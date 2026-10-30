/** intervals.icu activity JSON → SourceActivity (spec §3.1 provenance fields). */
import type { SourceActivity } from "../types.js";
import type { IcuActivity } from "./schemas.js";
import { looksLikeRace } from "../../plan/activity-streams.js";

export function normalizeSport(type: string | null | undefined): string {
  const t = (type ?? "").toLowerCase();
  if (t.includes("run")) return "run";
  if (t.includes("ride") || t.includes("cycl")) return "ride";
  if (t.includes("swim")) return "swim";
  if (t === "weighttraining" || t.includes("strength")) return "strength";
  if (t === "walk") return "walk";
  if (t === "hike") return "hike";
  if (t.includes("row")) return "row";
  return "other";
}

const BRANDS = ["garmin", "coros", "suunto", "wahoo", "polar", "huawei", "amazfit", "apple", "zwift"] as const;

/** Device platform the activity came from: from intervals.icu `source`, else from the device name. */
export function originPlatform(source: string | null | undefined, deviceName: string | null | undefined): string | null {
  const s = (source ?? "").toUpperCase();
  if (s === "STRAVA") return "strava";
  if (s.startsWith("GARMIN")) return "garmin";
  for (const b of BRANDS) if (s.includes(b.toUpperCase())) return b;
  if (s === "ZEPP") return "amazfit";
  const d = (deviceName ?? "").toLowerCase();
  for (const b of BRANDS) if (d.includes(b)) return b;
  return null;
}

/** intervals.icu hides Strava-sourced activities from the API and returns at most a stub (§3.2). */
export function isStravaStub(a: IcuActivity): boolean {
  return (a.source ?? "").toUpperCase() === "STRAVA" || /strava/i.test(a._note ?? "");
}

export function normalizeActivity(a: IcuActivity): SourceActivity | null {
  const local = a.start_date_local ?? null;
  const utcStr = a.start_date ?? (local ? `${local}Z` : null);
  if (!utcStr) return null;
  const startUtc = new Date(utcStr.endsWith("Z") || /[+-]\d\d:?\d\d$/.test(utcStr) ? utcStr : `${utcStr}Z`);
  if (Number.isNaN(startUtc.getTime())) return null;
  const localDate = (local ?? startUtc.toISOString()).slice(0, 10);
  const device = a.device_name ?? null;
  const origin = originPlatform(a.source, device);
  return {
    sourceId: a.id,
    originPlatform: origin,
    startUtc,
    localDate,
    sport: normalizeSport(a.type),
    distanceM: a.distance ?? null,
    movingS: a.moving_time ?? null,
    elapsedS: a.elapsed_time ?? null,
    avgHr: a.average_heartrate ?? a.icu_average_hr ?? null,
    // intervals.icu's race flag / RACE sub-type, else a narrow name heuristic (D, activity-streams.ts).
    isRace: a.race === true || (a.sub_type ?? "").toUpperCase() === "RACE" || looksLikeRace(a.name),
    name: a.name ?? null,
    device,
    // Garmin attribution is required for Garmin-derived data (§3.2 terms).
    garminOrigin: origin === "garmin" || /garmin/i.test(device ?? ""),
    raw: a,
  };
}
