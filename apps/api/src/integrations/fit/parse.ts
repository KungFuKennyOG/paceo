/**
 * FIT activity → summary, with Garmin's official SDK (@garmin/fitsdk, spec §2.6, §3.4).
 * Accepts raw or gzipped FIT. parseFit extracts the session summary; parseFitStreams extracts the
 * device laps and the record samples (§2.2 laps/samples, §4.9) for the engine's Activity.
 */
import { gunzipSync } from "node:zlib";
import * as fitsdk from "@garmin/fitsdk";

/** Narrow view of the SDK so this module does not depend on the exact shipped typings. */
interface FitSdkLike {
  Stream: { fromBuffer(buf: Buffer): unknown };
  Decoder: new (stream: unknown) => {
    isFIT(): boolean;
    checkIntegrity(): boolean;
    read(opts?: Record<string, unknown>): { messages: Record<string, unknown[] | undefined>; errors: unknown[] };
  };
}
const sdk = fitsdk as unknown as FitSdkLike;

/** Seconds between the Unix epoch and the FIT epoch (1989-12-31T00:00:00Z). */
const FIT_EPOCH_S = 631_065_600;

export class FitParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FitParseError";
  }
}

export interface FitSummary {
  startUtc: Date;
  /** Local offset from the FIT activity message (local_timestamp − timestamp), when present. */
  utcOffsetS: number | null;
  sport: string;
  rawSport: string | null;
  distanceM: number | null;
  movingS: number | null;
  elapsedS: number | null;
  avgHr: number | null;
  manufacturer: string | null;
  product: string | null;
  serialNumber: string | null;
}

export function maybeGunzip(bytes: Buffer): Buffer {
  return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes) : bytes;
}

export function isFitBytes(bytes: Buffer): boolean {
  return bytes.length >= 12 && bytes.subarray(8, 12).toString("latin1") === ".FIT";
}

export function normalizeFitSport(sport: string | null, subSport: string | null): string {
  const s = (sport ?? "").toLowerCase();
  const sub = (subSport ?? "").toLowerCase();
  if (s === "running") return "run";
  if (s === "cycling" || s === "e_biking" || s === "ebiking") return "ride";
  if (s === "swimming") return "swim";
  if (s === "walking") return "walk";
  if (s === "hiking") return "hike";
  if (s === "rowing") return "row";
  if (s === "training" && sub.includes("strength")) return "strength";
  return "other";
}

type Rec = Record<string, unknown>;
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" ? v : typeof v === "number" ? String(v) : null);
const dateOf = (v: unknown): Date | null => {
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v;
  if (typeof v === "number") return new Date((v + FIT_EPOCH_S) * 1000);
  return null;
};

type Messages = Record<string, unknown[] | undefined>;

function decodeFit(input: Buffer): { messages: Messages; errors: unknown[] } {
  const bytes = maybeGunzip(input);
  if (!isFitBytes(bytes)) throw new FitParseError("not a FIT file");
  const decoder = new sdk.Decoder(sdk.Stream.fromBuffer(bytes));
  if (!decoder.isFIT()) throw new FitParseError("not a FIT file");
  if (!decoder.checkIntegrity()) throw new FitParseError("FIT file failed its integrity check (truncated or corrupt)");
  return decoder.read({
    applyScaleAndOffset: true,
    expandSubFields: true,
    expandComponents: true,
    convertTypesToStrings: true,
    convertDateTimesToDates: true,
    mergeHeartRates: false,
  });
}

export function parseFit(input: Buffer): FitSummary {
  const { messages, errors } = decodeFit(input);
  const session = (messages.sessionMesgs?.[0] ?? null) as Rec | null;
  const activity = (messages.activityMesgs?.[0] ?? null) as Rec | null;
  const fileId = (messages.fileIdMesgs?.[0] ?? null) as Rec | null;
  const firstRecord = (messages.recordMesgs?.[0] ?? null) as Rec | null;
  if (!session && errors.length > 0) {
    throw new FitParseError(`could not decode FIT file: ${String((errors[0] as Error)?.message ?? errors[0])}`);
  }

  const start = dateOf(session?.startTime) ?? dateOf(firstRecord?.timestamp) ?? dateOf(activity?.timestamp);
  if (!start) throw new FitParseError("FIT file has no start time");

  let utcOffsetS: number | null = null;
  const actTs = dateOf(activity?.timestamp);
  const localTs = num(activity?.localTimestamp);
  if (actTs && localTs !== null) {
    const offset = localTs - (actTs.getTime() / 1000 - FIT_EPOCH_S);
    // Real offsets are within ±14 h; anything else is a bad clock.
    if (Math.abs(offset) <= 14 * 3600) utcOffsetS = Math.round(offset / 60) * 60;
  }

  const rawSport = str(session?.sport);
  return {
    startUtc: start,
    utcOffsetS,
    sport: normalizeFitSport(rawSport, str(session?.subSport)),
    rawSport,
    distanceM: num(session?.totalDistance),
    movingS: num(session?.totalTimerTime) ?? num(session?.totalMovingTime),
    elapsedS: num(session?.totalElapsedTime),
    avgHr: num(session?.avgHeartRate),
    manufacturer: str(fileId?.manufacturer),
    product: str(fileId?.garminProduct) ?? str(fileId?.productName) ?? str(fileId?.product),
    serialNumber: str(fileId?.serialNumber),
  };
}

// ── laps and samples ─────────────────────────────────────────────────────────────────────────────

/** One record sample, seconds since the activity start. Same shape as the engine's ActivitySample. */
export interface FitSample {
  t: number;
  distM?: number;
  altM?: number;
  speedMps?: number;
  hr?: number;
  tempC?: number;
}

export interface FitLap {
  startS: number;
  durationS: number;
  distanceM: number;
  avgHr?: number;
}

export interface FitStreams {
  laps: FitLap[];
  samples: FitSample[];
  maxHr: number | null;
  elevationGainM: number | null;
  /** FIT session sub_sport, e.g. "treadmill", "track", "trail", "generic". */
  subSport: string | null;
  manufacturer: string | null;
  /** True when the records carry altitude. */
  hasAltitude: boolean;
}

/**
 * Longest activity kept at 1 Hz; longer ones are thinned to every n-th second so a 24 h ultra stays
 * ~43k samples (D).
 */
export const MAX_SAMPLES = 43_200;

/**
 * Device laps and ≤ 1 Hz samples. Sub-second records are thinned to the first one in each second;
 * records before the start or without a timestamp are dropped.
 */
export function parseFitStreams(input: Buffer): FitStreams {
  const { messages } = decodeFit(input);
  const session = (messages.sessionMesgs?.[0] ?? null) as Rec | null;
  const fileId = (messages.fileIdMesgs?.[0] ?? null) as Rec | null;
  const records = (messages.recordMesgs ?? []) as Rec[];
  const start = dateOf(session?.startTime) ?? dateOf(records[0]?.timestamp);
  if (!start) throw new FitParseError("FIT file has no start time");
  const t0 = start.getTime();

  const lastTs = dateOf(records[records.length - 1]?.timestamp);
  const spanS = lastTs ? (lastTs.getTime() - t0) / 1000 : 0;
  const every = Math.max(1, Math.ceil(spanS / MAX_SAMPLES));
  const samples: FitSample[] = [];
  let lastT = -Infinity;
  let hasAltitude = false;
  for (const r of records) {
    const ts = dateOf(r.timestamp);
    if (!ts) continue;
    const t = Math.round((ts.getTime() - t0) / 1000);
    if (t < 0 || t < lastT + every) continue;
    lastT = t;
    const s: FitSample = { t };
    const dist = num(r.distance);
    const alt = num(r.enhancedAltitude) ?? num(r.altitude);
    const speed = num(r.enhancedSpeed) ?? num(r.speed);
    const hr = num(r.heartRate);
    const temp = num(r.temperature);
    if (dist !== null) s.distM = dist;
    if (alt !== null) {
      s.altM = alt;
      hasAltitude = true;
    }
    if (speed !== null) s.speedMps = speed;
    if (hr !== null && hr > 0) s.hr = hr;
    if (temp !== null) s.tempC = temp;
    samples.push(s);
  }

  const laps: FitLap[] = [];
  for (const l of (messages.lapMesgs ?? []) as Rec[]) {
    const ls = dateOf(l.startTime);
    const dur = num(l.totalTimerTime) ?? num(l.totalElapsedTime);
    if (!ls || dur === null) continue;
    const lap: FitLap = { startS: Math.max(0, Math.round((ls.getTime() - t0) / 1000)), durationS: dur, distanceM: num(l.totalDistance) ?? 0 };
    const hr = num(l.avgHeartRate);
    if (hr !== null && hr > 0) lap.avgHr = hr;
    laps.push(lap);
  }
  laps.sort((a, b) => a.startS - b.startS);

  return {
    laps,
    samples,
    maxHr: num(session?.maxHeartRate),
    elevationGainM: num(session?.totalAscent),
    subSport: str(session?.subSport),
    manufacturer: str(fileId?.manufacturer),
    hasAltitude,
  };
}
