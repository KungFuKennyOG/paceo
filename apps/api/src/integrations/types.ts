/**
 * Source / sink interfaces (spec §3.1). Bound per user; the intervals.icu implementations live in
 * ./intervals. Future: GarminPersonalApiSource, FitFileSink, StravaSource.
 */

/** A normalised activity summary as returned by an ActivitySource. */
export interface SourceActivity {
  sourceId: string;
  /** "garmin", "coros", ... or null when unknown. */
  originPlatform: string | null;
  startUtc: Date;
  /** Local date of the start, YYYY-MM-DD. */
  localDate: string;
  /** Normalised sport: run | ride | swim | strength | walk | hike | row | other */
  sport: string;
  distanceM: number | null;
  movingS: number | null;
  elapsedS: number | null;
  avgHr: number | null;
  isRace: boolean;
  name: string | null;
  device: string | null;
  garminOrigin: boolean;
  /** Raw source JSON for later parsing. */
  raw: unknown;
}

export interface ActivityListing {
  activities: SourceActivity[];
  /**
   * Activities the source can see but will not return (intervals.icu hides Strava-sourced
   * activities from the API; §3.2). Counted so the UI can explain the gap.
   */
  hiddenStravaCount: number;
}

export interface ActivitySource {
  readonly provider: "intervals_icu";
  listActivities(oldest: string, newest: string): Promise<ActivityListing>;
  getActivityDetail(sourceId: string): Promise<SourceActivity | null>;
  /** Original upload bytes (FIT, already gunzipped), or null when the source has none. */
  getOriginalFile(sourceId: string): Promise<{ bytes: Buffer; contentType: string } | null>;
}

/** One planned workout as the sink receives it. */
export interface SinkWorkout {
  externalId: string;
  date: string;
  sport: "run" | "strength";
  name: string;
  /** Device text (intervals.icu workout syntax). */
  description: string;
}

export interface SinkEvent {
  eventId: string;
  externalId: string | null;
  date: string;
  name: string | null;
}

export interface WorkoutSink {
  readonly provider: "intervals_icu";
  upsertWorkouts(workouts: SinkWorkout[]): Promise<void>;
  deleteWorkouts(externalIds: string[]): Promise<void>;
  /** Calendar read-back (inclusive range). */
  listEvents(oldest: string, newest: string): Promise<SinkEvent[]>;
}

export interface AthleteInfo {
  id: string;
  name: string | null;
}

/** Everything the app needs from one user's intervals.icu account. */
export interface IntervalsAccount {
  verify(): Promise<AthleteInfo>;
  source: ActivitySource;
  sink: WorkoutSink;
}

export type IntervalsAccountFactory = (apiKey: string) => IntervalsAccount;
