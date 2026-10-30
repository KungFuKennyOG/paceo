/**
 * intervals.icu implementations of ActivitySource and WorkoutSink (spec §3.2), bound to one user's
 * API key. All calls share the process-wide limiter passed in.
 */
import { gunzipSync } from "node:zlib";
import type {
  ActivityListing,
  ActivitySource,
  AthleteInfo,
  IntervalsAccount,
  SinkEvent,
  SinkWorkout,
  SourceActivity,
  WorkoutSink,
} from "../types.js";
import { IntervalsClient, IntervalsError, type IntervalsClientOptions } from "./client.js";
import { IcuActivity, IcuAthlete, IcuEvent } from "./schemas.js";
import { isStravaStub, normalizeActivity } from "./normalize.js";

const ATHLETE = "/athlete/0";

export class IntervalsIcuSource implements ActivitySource {
  readonly provider = "intervals_icu" as const;
  constructor(private readonly client: IntervalsClient) {}

  async listActivities(oldest: string, newest: string): Promise<ActivityListing> {
    const raw = await this.client.json<unknown>("GET", `${ATHLETE}/activities`, { query: { oldest, newest } });
    const items = Array.isArray(raw) ? raw : [];
    const activities: SourceActivity[] = [];
    let hiddenStravaCount = 0;
    for (const item of items) {
      const parsed = IcuActivity.safeParse(item);
      if (!parsed.success) continue;
      if (isStravaStub(parsed.data)) {
        hiddenStravaCount++;
        continue;
      }
      const a = normalizeActivity(parsed.data);
      if (a) activities.push(a);
    }
    return { activities, hiddenStravaCount };
  }

  async getActivityDetail(sourceId: string): Promise<SourceActivity | null> {
    try {
      const raw = await this.client.json<unknown>("GET", `/activity/${encodeURIComponent(sourceId)}`, {
        query: { intervals: true },
      });
      const parsed = IcuActivity.safeParse(raw);
      if (!parsed.success || isStravaStub(parsed.data)) return null;
      return normalizeActivity(parsed.data);
    } catch (err) {
      if (err instanceof IntervalsError && err.kind === "not_found") return null;
      throw err;
    }
  }

  async getOriginalFile(sourceId: string): Promise<{ bytes: Buffer; contentType: string } | null> {
    try {
      const res = await this.client.bytes("GET", `/activity/${encodeURIComponent(sourceId)}/file`);
      return decodeOriginal(res.bytes);
    } catch (err) {
      if (err instanceof IntervalsError && err.kind === "not_found") return null;
      throw err;
    }
  }
}

/** The /file endpoint returns the original upload, usually gzipped (§3.2). */
export function decodeOriginal(input: Buffer): { bytes: Buffer; contentType: string } {
  let bytes = input;
  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) bytes = gunzipSync(bytes);
  if (bytes.length >= 12 && bytes.subarray(8, 12).toString("latin1") === ".FIT") {
    return { bytes, contentType: "application/vnd.ant.fit" };
  }
  const head = bytes.subarray(0, 512).toString("utf8");
  if (head.includes("<gpx")) return { bytes, contentType: "application/gpx+xml" };
  if (head.includes("TrainingCenterDatabase")) return { bytes, contentType: "application/vnd.garmin.tcx+xml" };
  return { bytes, contentType: "application/octet-stream" };
}

export class IntervalsIcuSink implements WorkoutSink {
  readonly provider = "intervals_icu" as const;
  constructor(private readonly client: IntervalsClient) {}

  async upsertWorkouts(workouts: SinkWorkout[]): Promise<void> {
    if (workouts.length === 0) return;
    const events = workouts.map((w) => ({
      category: "WORKOUT",
      start_date_local: `${w.date}T00:00:00`,
      type: w.sport === "run" ? "Run" : "WeightTraining",
      name: w.name,
      description: w.description,
      external_id: w.externalId,
    }));
    await this.client.json("POST", `${ATHLETE}/events/bulk`, { query: { upsert: true }, body: events });
  }

  async deleteWorkouts(externalIds: string[]): Promise<void> {
    if (externalIds.length === 0) return;
    await this.client.json("PUT", `${ATHLETE}/events/bulk-delete`, {
      body: externalIds.map((external_id) => ({ external_id })),
    });
  }

  async listEvents(oldest: string, newest: string): Promise<SinkEvent[]> {
    const raw = await this.client.json<unknown>("GET", `${ATHLETE}/events`, { query: { oldest, newest } });
    const out: SinkEvent[] = [];
    for (const item of Array.isArray(raw) ? raw : []) {
      const p = IcuEvent.safeParse(item);
      if (!p.success) continue;
      out.push({
        eventId: p.data.id,
        externalId: p.data.external_id ?? null,
        date: (p.data.start_date_local ?? "").slice(0, 10),
        name: p.data.name ?? null,
      });
    }
    return out;
  }
}

export class IntervalsIcuAccount implements IntervalsAccount {
  readonly source: IntervalsIcuSource;
  readonly sink: IntervalsIcuSink;
  constructor(private readonly client: IntervalsClient) {
    this.source = new IntervalsIcuSource(client);
    this.sink = new IntervalsIcuSink(client);
  }

  async verify(): Promise<AthleteInfo> {
    const raw = await this.client.json<unknown>("GET", ATHLETE);
    const p = IcuAthlete.safeParse(raw);
    if (!p.success) throw new IntervalsError("http", "GET /athlete/0: unexpected response shape");
    return { id: p.data.id, name: p.data.name ?? null };
  }
}

export function intervalsAccountFactory(base: Omit<IntervalsClientOptions, "apiKey">) {
  return (apiKey: string): IntervalsAccount => new IntervalsIcuAccount(new IntervalsClient({ ...base, apiKey }));
}
