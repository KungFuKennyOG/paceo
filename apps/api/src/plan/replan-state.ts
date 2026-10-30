/**
 * Stored rows → engine replan inputs (spec §8). Pure: no DB, no clock. This is the only place that
 * knows both the DB shapes (activities, check-ins, planned workouts, fitness_state) and the engine's
 * ReplanState / CheckInEvent shapes.
 *
 * Mapping decisions (D):
 * - Illness: the contract's check-in has no "resolved" field, so consecutive illness check-ins (gaps
 *   of ≤ 2 days) form one episode. An episode with no check-in today or yesterday counts as resolved
 *   the day after its last report; logging again reopens it.
 * - fever → fever + systemic; aboveNeckOnly = false → systemic (below-neck) symptoms.
 * - Skipped workouts become skip events by date (ids can change across rebuilds).
 * - fitness_state keeps no history: its vdot_date stands in as the last change (for the 2-week freeze).
 * - Activities carry their stored streams (laps, ≤ 1 Hz samples, maxHr, elevation, environment,
 *   altitude source; src/plan/activity-streams.ts) so per-step compliance, R-PERF, GAP and critical
 *   speed have input. isRace also applies the narrow name heuristic to rows stored before it existed.
 * - HRmax / HRrest come from the profile. A user-entered HRmax counts as "measured" (D: the profile
 *   asks for a known max, not an estimate); without one the engine's age formula applies.
 */
import {
  addDays,
  daysBetween,
  type Activity,
  type ActivityLap,
  type ActivitySample,
  type ActivitySport,
  type CheckInEvent,
  type CrossTrainingEvent,
  type FitnessState,
  type SkipReason,
  type VdotStatus,
} from "@paceo/engine";
import { looksLikeRace, type StreamsSummary } from "./activity-streams.js";

export interface ActivityLike {
  id: string;
  localDate: string;
  sport: string;
  distanceM: number | null;
  movingS: number | null;
  elapsedS: number | null;
  avgHr: number | null;
  isRace: boolean;
  name: string | null;
}

export interface CheckinLike {
  type: string;
  date: string;
  activityId: string | null;
  workoutId: string | null;
  payload: unknown;
}

export interface WorkoutRowLike {
  id: string;
  date: string;
  status: string;
  skipReason: string | null;
}

export interface FitnessRowLike {
  vdot: number | null;
  vdotSource: string;
  vdotDate: string | null;
}

const SPORTS: Record<string, ActivitySport> = {
  run: "run",
  ride: "ride",
  swim: "swim",
  strength: "strength",
  walk: "hike",
  hike: "hike",
  row: "row",
};

export function engineSport(sport: string): ActivitySport {
  return SPORTS[sport] ?? "other";
}

/** Stored activity_streams content for one activity (decoded). */
export interface StreamsLike {
  laps: ActivityLap[];
  samples: ActivitySample[];
  summary: StreamsSummary;
}

export function toEngineActivity(a: ActivityLike, streams?: StreamsLike): Activity {
  const out: Activity = {
    id: a.id,
    date: a.localDate,
    sport: engineSport(a.sport),
    distanceM: a.distanceM ?? 0,
    movingS: a.movingS ?? a.elapsedS ?? 0,
    isRace: a.isRace || (engineSport(a.sport) === "run" && looksLikeRace(a.name)),
  };
  if (a.avgHr !== null) out.avgHr = a.avgHr;
  if (out.sport !== "run" && a.name) out.activity = a.name;
  if (streams) {
    if (streams.laps.length > 0) out.laps = streams.laps;
    if (streams.samples.length > 1) out.samples = streams.samples;
    const s = streams.summary;
    if (s.maxHr !== undefined) out.maxHr = s.maxHr;
    if (s.elevationGainM !== undefined) out.elevationGainM = s.elevationGainM;
    if (s.environment !== undefined) out.environment = s.environment;
    if (s.altitudeSource !== undefined) out.altitudeSource = s.altitudeSource;
  }
  return out;
}

/** HR settings from the profile, for FitnessState (§4.6 HR-pace evidence, Uth–Sørensen check). */
export interface HrProfileLike {
  hrMax: number | null;
  hrRest: number | null;
}

const VDOT_STATUSES: readonly VdotStatus[] = ["race", "tt", "estimated", "none"];

export function toFitnessState(
  row: FitnessRowLike | undefined,
  fallback: { vdot?: number; vdotStatus: VdotStatus },
  hr?: HrProfileLike,
): FitnessState {
  const status = row && (VDOT_STATUSES as readonly string[]).includes(row.vdotSource) ? (row.vdotSource as VdotStatus) : fallback.vdotStatus;
  const vdot = row?.vdot ?? fallback.vdot;
  const f: FitnessState = { status, history: [] };
  if (vdot !== undefined && vdot !== null) f.vdot = vdot;
  const hrMax = hr?.hrMax ?? null;
  const hrRest = hr?.hrRest ?? null;
  if (hrMax !== null) {
    f.hrMax = hrMax;
    f.hrMaxSource = "measured";
  }
  if (hrRest !== null) f.hrRest = hrRest;
  if (row?.vdotDate && f.vdot !== undefined) {
    f.history.push({ date: row.vdotDate, toVdot: f.vdot, status, rule: "stored", source: `stored:${row.vdotDate}`, reason: "stored fitness" });
  }
  return f;
}

const SKIP_REASONS: Record<string, SkipReason> = { sick: "illness", injured: "pain", busy: "busy", tired: "tired", travel: "travel", weather: "weather" };

function rec(x: unknown): Record<string, unknown> {
  return typeof x === "object" && x !== null ? (x as Record<string, unknown>) : {};
}

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** Illness check-ins grouped into episodes (see module note). */
function illnessEvents(rows: readonly CheckinLike[], today: string): CheckInEvent[] {
  const ill = rows.filter((r) => r.type === "illness").sort((a, b) => (a.date < b.date ? -1 : 1));
  const out: CheckInEvent[] = [];
  let i = 0;
  while (i < ill.length) {
    const first = ill[i]!;
    let last = first;
    let fever = false;
    let systemic = false;
    while (i < ill.length && daysBetween(last.date, ill[i]!.date) <= 2) {
      last = ill[i]!;
      const p = rec(last.payload);
      fever ||= p["fever"] === true;
      systemic ||= p["fever"] === true || p["aboveNeckOnly"] === false;
      i++;
    }
    const e: CheckInEvent = { type: "illness", date: first.date, reportedOn: last.date, fever, systemic, aboveNeck: true };
    if (daysBetween(last.date, today) >= 2) e.resolvedDate = addDays(last.date, 1);
    out.push(e);
  }
  return out;
}

/** Check-ins + skipped workouts → engine events. `activityOnDate` resolves sRPE logged against a workout. */
export function toEngineEvents(
  checkins: readonly CheckinLike[],
  workouts: readonly WorkoutRowLike[],
  today: string,
  activityOnDate: (date: string) => string | undefined,
): CheckInEvent[] {
  const out: CheckInEvent[] = [...illnessEvents(checkins, today)];
  for (const c of checkins) {
    const p = rec(c.payload);
    if (c.type === "pain") {
      const during = num(p["duringRun"]);
      if (during === undefined) continue;
      const e: CheckInEvent = { type: "pain", date: c.date, bodyPart: String(p["location"] ?? "unspecified"), during };
      const morning = num(p["nextMorning"]);
      if (morning !== undefined) e.nextMorning = morning;
      out.push(e);
    } else if (c.type === "session_rpe") {
      const srpe = num(p["rpe"]);
      const activityId = c.activityId ?? activityOnDate(c.date);
      if (srpe !== undefined && activityId) out.push({ type: "srpe", date: c.date, activityId, srpe });
    } else if (c.type === "cross_training") {
      const minutes = num(p["minutes"]);
      if (minutes === undefined) continue;
      const activity = String(p["activity"] ?? "other");
      const sport = engineSport(activity.toLowerCase());
      const e: CrossTrainingEvent = { type: "cross_training", date: c.date, sport: sport === "run" ? "other" : sport, activity, minutes };
      const srpe = num(p["rpe"]);
      if (srpe !== undefined) e.srpe = srpe;
      out.push(e);
    }
  }
  for (const w of workouts) {
    if (w.status !== "skipped") continue;
    out.push({ type: "skip", date: w.date, reason: SKIP_REASONS[w.skipReason ?? ""] ?? "other" });
  }
  return out;
}
