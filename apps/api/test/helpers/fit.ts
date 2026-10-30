/** Builds a tiny FIT activity with Garmin's own Encoder (no binary fixture needed). */
import * as fitsdk from "@garmin/fitsdk";

interface EncoderLike {
  onMesg(mesgNum: number, mesg: Record<string, unknown>): void;
  close(): Uint8Array;
}
const sdk = fitsdk as unknown as {
  Encoder: new () => EncoderLike;
  Profile: { MesgNum: Record<string, number> };
};

const FIT_EPOCH_S = 631_065_600;

export interface FitFixture {
  start: Date;
  distanceM: number;
  timerS: number;
  avgHr: number;
  /** Local offset written into the activity message, seconds. */
  utcOffsetS: number;
  sport?: string;
}

export function makeFitActivity(f: FitFixture): Buffer {
  const enc = new sdk.Encoder();
  const M = sdk.Profile.MesgNum;
  const end = new Date(f.start.getTime() + f.timerS * 1000);
  enc.onMesg(M.FILE_ID as number, {
    type: "activity",
    manufacturer: "garmin",
    product: 4315,
    serialNumber: 3_456_789_012,
    timeCreated: f.start,
  });
  enc.onMesg(M.RECORD as number, { timestamp: f.start, heartRate: f.avgHr, distance: 0 });
  enc.onMesg(M.RECORD as number, { timestamp: end, heartRate: f.avgHr, distance: f.distanceM });
  enc.onMesg(M.SESSION as number, {
    timestamp: end,
    startTime: f.start,
    sport: f.sport ?? "running",
    subSport: "generic",
    totalElapsedTime: f.timerS + 60,
    totalTimerTime: f.timerS,
    totalDistance: f.distanceM,
    avgHeartRate: f.avgHr,
  });
  enc.onMesg(M.ACTIVITY as number, {
    timestamp: end,
    numSessions: 1,
    type: "manual",
    localTimestamp: Math.round(end.getTime() / 1000) - FIT_EPOCH_S + f.utcOffsetS,
  });
  return Buffer.from(enc.close());
}

export interface FitRunFixture {
  start: Date;
  /** One record per second for this many seconds. */
  seconds: number;
  /** Constant speed, m/s. */
  speedMps: number;
  hr: number;
  tempC?: number;
  /** Lap boundaries in seconds from the start (each lap runs to the next, the last to the end). */
  lapStarts?: number[];
  subSport?: string;
  manufacturer?: string;
}

/** A 1 Hz run with records (distance, altitude, speed, HR, temperature), device laps and a session. */
export function makeFitRun(f: FitRunFixture): Buffer {
  const enc = new sdk.Encoder();
  const M = sdk.Profile.MesgNum;
  const at = (s: number) => new Date(f.start.getTime() + s * 1000);
  const end = at(f.seconds);
  enc.onMesg(M.FILE_ID as number, {
    type: "activity",
    manufacturer: f.manufacturer ?? "garmin",
    product: 4315,
    serialNumber: 3_456_789_012,
    timeCreated: f.start,
  });
  for (let s = 0; s <= f.seconds; s++) {
    const rec: Record<string, unknown> = {
      timestamp: at(s),
      distance: s * f.speedMps,
      altitude: 100 + Math.sin(s / 60) * 5,
      speed: f.speedMps,
      heartRate: f.hr + (s % 7),
    };
    if (f.tempC !== undefined) rec.temperature = f.tempC;
    enc.onMesg(M.RECORD as number, rec);
  }
  const starts = f.lapStarts ?? [0];
  starts.forEach((ls, i) => {
    const le = starts[i + 1] ?? f.seconds;
    enc.onMesg(M.LAP as number, {
      timestamp: at(le),
      startTime: at(ls),
      totalElapsedTime: le - ls,
      totalTimerTime: le - ls,
      totalDistance: (le - ls) * f.speedMps,
      avgHeartRate: f.hr + 3,
    });
  });
  enc.onMesg(M.SESSION as number, {
    timestamp: end,
    startTime: f.start,
    sport: "running",
    subSport: f.subSport ?? "generic",
    totalElapsedTime: f.seconds,
    totalTimerTime: f.seconds,
    totalDistance: f.seconds * f.speedMps,
    avgHeartRate: f.hr + 3,
    maxHeartRate: f.hr + 6,
    totalAscent: 42,
  });
  enc.onMesg(M.ACTIVITY as number, {
    timestamp: end,
    numSessions: 1,
    type: "manual",
    localTimestamp: Math.round(end.getTime() / 1000) - FIT_EPOCH_S,
  });
  return Buffer.from(enc.close());
}
