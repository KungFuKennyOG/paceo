/**
 * Activity detail for the engine (spec §2.2 laps/samples, §3.9, §4.7–4.9): laps, ≤ 1 Hz samples and
 * the extra Activity fields, built at sync / upload time and stored in activity_streams.
 *
 * Storage decision (D): one activity_streams row per activity. Laps are small jsonb. Samples are a
 * columnar block, rounded and delta-encoded, JSON, then gzip, in a bytea column (format 1 below).
 * A 1 h run at 1 Hz is ~3600 samples → roughly 15–30 kB, so ~10 users × 5 runs/week × several years
 * stays in the low hundreds of MB, and the replanner reads one row per run instead of re-parsing the
 * original FIT (which stays in raw_files as the source of truth; streams can be rebuilt from it).
 *
 * Sources:
 * - Laps: intervals.icu `icu_intervals` from GET /activity/{id}?intervals=true (the detail JSON kept
 *   in activities.detail); when it has none, the FIT's own device laps (D).
 * - Samples: FIT record messages (distance, altitude, speed, heart rate, temperature).
 * - Extras: maxHr, elevation gain, environment (treadmill / track / outdoor) and altitude source.
 */
import { gunzipSync, gzipSync } from "node:zlib";
import type { ActivityLap, ActivitySample } from "@paceo/engine";
import type { FitStreams } from "../integrations/fit/parse.js";

export const STREAMS_FORMAT = 1;

/** Extra engine Activity fields kept next to the laps/samples (activity_streams.summary). */
export interface StreamsSummary {
  maxHr?: number;
  elevationGainM?: number;
  environment?: "outdoor" | "track" | "treadmill";
  altitudeSource?: "barometric" | "gps" | "none";
}

export interface BuiltStreams {
  laps: ActivityLap[];
  lapsSource: "intervals_icu" | "fit" | null;
  samples: ActivitySample[];
  summary: StreamsSummary;
}

type Rec = Record<string, unknown>;
const rec = (x: unknown): Rec => (typeof x === "object" && x !== null && !Array.isArray(x) ? (x as Rec) : {});
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

// ── laps from intervals.icu ──────────────────────────────────────────────────────────────────────

/**
 * intervals.icu `icu_intervals` → engine laps. Each interval carries start_time / end_time (seconds
 * from the start), moving_time / elapsed_time, distance and average_heartrate. Intervals without a
 * usable start or duration are skipped; the rest are sorted by start.
 */
export function lapsFromIntervalsIcu(detail: unknown): ActivityLap[] {
  const items = rec(detail)["icu_intervals"];
  if (!Array.isArray(items)) return [];
  const out: ActivityLap[] = [];
  for (const raw of items) {
    const i = rec(raw);
    const startS = num(i["start_time"]);
    const endS = num(i["end_time"]);
    const durationS = num(i["moving_time"]) ?? num(i["elapsed_time"]) ?? (startS !== undefined && endS !== undefined ? endS - startS : undefined);
    if (startS === undefined || durationS === undefined || durationS <= 0) continue;
    const lap: ActivityLap = { startS, durationS, distanceM: num(i["distance"]) ?? 0 };
    const hr = num(i["average_heartrate"]);
    if (hr !== undefined && hr > 0) lap.avgHr = hr;
    out.push(lap);
  }
  return out.sort((a, b) => a.startS - b.startS);
}

// ── environment / altitude ───────────────────────────────────────────────────────────────────────

const BARO_BRANDS = new Set(["garmin", "coros", "suunto", "polar", "wahoo"]);

/** Treadmill / track / outdoor from the intervals.icu detail and the FIT sub-sport. */
export function environmentOf(detail: unknown, subSport: string | null): StreamsSummary["environment"] {
  const d = rec(detail);
  const type = String(d["type"] ?? "").toLowerCase();
  const sub = (subSport ?? "").toLowerCase();
  if (d["trainer"] === true || type.startsWith("virtual") || sub === "treadmill" || sub === "indoor_running" || sub === "virtual_activity") return "treadmill";
  if (sub === "track") return "track";
  return "outdoor";
}

/**
 * Altitude source (§4.7: GAP only with barometric altitude). FIT files don't say whether altitude is
 * barometric; watches from these brands record barometric altitude on their running models, so their
 * altitude counts as barometric, other altitude as GPS (D).
 */
export function altitudeSourceOf(fit: Pick<FitStreams, "hasAltitude" | "manufacturer"> | null): StreamsSummary["altitudeSource"] {
  if (!fit || !fit.hasAltitude) return "none";
  return BARO_BRANDS.has((fit.manufacturer ?? "").toLowerCase()) ? "barometric" : "gps";
}

/** Laps, samples and extras from what the source gave us (either part may be missing). */
export function buildStreams(detail: unknown, fit: FitStreams | null): BuiltStreams {
  const icuLaps = lapsFromIntervalsIcu(detail);
  const laps = icuLaps.length > 0 ? icuLaps : (fit?.laps ?? []);
  const lapsSource = icuLaps.length > 0 ? "intervals_icu" : laps.length > 0 ? "fit" : null;
  const d = rec(detail);
  const summary: StreamsSummary = {};
  const maxHr = fit?.maxHr ?? num(d["max_heartrate"]) ?? null;
  if (maxHr !== null && maxHr > 0) summary.maxHr = maxHr;
  const gain = fit?.elevationGainM ?? num(d["total_elevation_gain"]) ?? null;
  if (gain !== null) summary.elevationGainM = gain;
  const env = environmentOf(detail, fit?.subSport ?? null);
  if (env) summary.environment = env;
  const alt = altitudeSourceOf(fit);
  if (alt) summary.altitudeSource = alt;
  return { laps, lapsSource, samples: fit?.samples ?? [], summary };
}

// ── sample block, format 1 ───────────────────────────────────────────────────────────────────────
//
// gzip(JSON {v: 1, n, t, d?, a?, s?, h?, c?}), one array per channel, n entries each:
//   t  seconds since start, delta-encoded integers
//   d  distance, decimetres, delta-encoded from the previous present value (null = missing)
//   a  altitude, decimetres          s  speed, cm/s          h  heart rate, bpm          c  °C
// A channel with no values at all is omitted.

interface Block {
  v: number;
  n: number;
  t: number[];
  d?: Array<number | null>;
  a?: Array<number | null>;
  s?: Array<number | null>;
  h?: Array<number | null>;
  c?: Array<number | null>;
}

function channel(samples: readonly ActivitySample[], get: (s: ActivitySample) => number | undefined, scale: number): Array<number | null> | undefined {
  const out = samples.map((s) => {
    const v = get(s);
    return v === undefined || !Number.isFinite(v) ? null : Math.round(v * scale);
  });
  return out.some((v) => v !== null) ? out : undefined;
}

function deltaEncode(xs: Array<number | null>): Array<number | null> {
  let prev = 0;
  return xs.map((x) => {
    if (x === null) return null;
    const d = x - prev;
    prev = x;
    return d;
  });
}

function deltaDecode(xs: ReadonlyArray<number | null>): Array<number | null> {
  let acc = 0;
  return xs.map((x) => {
    if (x === null) return null;
    acc += x;
    return acc;
  });
}

export function encodeSamples(samples: readonly ActivitySample[]): Buffer | null {
  if (samples.length === 0) return null;
  const block: Block = {
    v: STREAMS_FORMAT,
    n: samples.length,
    t: deltaEncode(samples.map((s) => Math.round(s.t))) as number[],
  };
  const d = channel(samples, (s) => s.distM, 10);
  const a = channel(samples, (s) => s.altM, 10);
  const sp = channel(samples, (s) => s.speedMps, 100);
  const h = channel(samples, (s) => s.hr, 1);
  const c = channel(samples, (s) => s.tempC, 1);
  if (d) block.d = deltaEncode(d);
  if (a) block.a = a;
  if (sp) block.s = sp;
  if (h) block.h = h;
  if (c) block.c = c;
  return gzipSync(Buffer.from(JSON.stringify(block)));
}

export function decodeSamples(bytes: Buffer | null | undefined): ActivitySample[] {
  if (!bytes || bytes.length === 0) return [];
  const block = JSON.parse(gunzipSync(bytes).toString("utf8")) as Block;
  if (block.v !== STREAMS_FORMAT || !Array.isArray(block.t)) return [];
  const t = deltaDecode(block.t);
  const d = block.d ? deltaDecode(block.d) : undefined;
  const out: ActivitySample[] = [];
  for (let i = 0; i < block.n; i++) {
    const ti = t[i];
    if (ti === null || ti === undefined) continue;
    const s: ActivitySample = { t: ti };
    const di = d?.[i];
    const ai = block.a?.[i];
    const si = block.s?.[i];
    const hi = block.h?.[i];
    const ci = block.c?.[i];
    if (di !== null && di !== undefined) s.distM = di / 10;
    if (ai !== null && ai !== undefined) s.altM = ai / 10;
    if (si !== null && si !== undefined) s.speedMps = si / 100;
    if (hi !== null && hi !== undefined) s.hr = hi;
    if (ci !== null && ci !== undefined) s.tempC = ci;
    out.push(s);
  }
  return out;
}

// ── race flag ────────────────────────────────────────────────────────────────────────────────────

const RACE_WORD = /\b(race|parkrun)\b/i;
const NOT_RACE = /\b(pace|paced|post|pre|shake ?out|warm ?up|cool ?down|recovery|recce|sim|simulation|practice|rehearsal|tune|after|before|spectat\w*|volunteer\w*|pacer|pacing)\b|race[- ]?(pace|day eve)/i;

/**
 * Race flag (D): intervals.icu's own race flag / RACE sub-type, else a name heuristic: the name says
 * "race" or "parkrun" and nothing that marks it as a training run around a race ("race pace",
 * "post-race shakeout", "warm-up", ...). A false race would set paces from a non-maximal effort,
 * so the heuristic is deliberately narrow.
 */
export function looksLikeRace(name: string | null | undefined): boolean {
  if (!name) return false;
  return RACE_WORD.test(name) && !NOT_RACE.test(name);
}
