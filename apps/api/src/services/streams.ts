/**
 * activity_streams writes and reads (see src/plan/activity-streams.ts for the storage decision).
 * - storeStreams: at sync (intervals.icu detail + original FIT) and at FIT upload.
 * - backfillStreams: activities ingested before streams existed get theirs from the stored FIT and
 *   detail JSON, a few per nightly run.
 * - loadStreams: decoded laps/samples/extras for the replanner.
 */
import type { ActivityLap, ActivitySample } from "@paceo/engine";
import { rawFilesRepo, streamsRepo, type ActivityRow } from "../repo/index.js";
import { FitParseError, isFitBytes, maybeGunzip, parseFitStreams, type FitStreams } from "../integrations/fit/parse.js";
import { buildStreams, decodeSamples, encodeSamples, STREAMS_FORMAT, type StreamsSummary } from "../plan/activity-streams.js";
import type { Services } from "./context.js";

/** Parse laps/samples from FIT bytes; null (logged) when the file can't be read. */
export function fitStreamsOrNull(svc: Services, bytes: Buffer | null | undefined): FitStreams | null {
  if (!bytes) return null;
  const raw = maybeGunzip(bytes);
  if (!isFitBytes(raw)) return null;
  try {
    return parseFitStreams(raw);
  } catch (err) {
    svc.log.warn({ err: err instanceof FitParseError ? err.message : String(err) }, "FIT streams not readable");
    return null;
  }
}

export async function storeStreams(svc: Services, userId: string, activityId: string, detail: unknown, fit: FitStreams | null): Promise<void> {
  const built = buildStreams(detail, fit);
  await streamsRepo.upsert(svc.db, userId, activityId, {
    format: STREAMS_FORMAT,
    laps: built.laps,
    lapsSource: built.lapsSource,
    samples: encodeSamples(built.samples),
    sampleCount: built.samples.length,
    summary: built.summary,
  });
}

/** Most activities backfilled per call (each one parses a stored FIT). */
export const BACKFILL_LIMIT = 25;

/** Runs in `rows` without a streams row get one from their stored FIT and detail JSON. */
export async function backfillStreams(svc: Services, userId: string, rows: readonly ActivityRow[]): Promise<number> {
  const runs = rows.filter((r) => r.sport === "run");
  if (runs.length === 0) return 0;
  const have = new Set((await streamsRepo.forActivities(svc.db, userId, runs.map((r) => r.id))).map((s) => s.activityId));
  let n = 0;
  for (const r of runs) {
    if (have.has(r.id)) continue;
    if (n >= BACKFILL_LIMIT) break;
    const file = r.rawFileId ? await rawFilesRepo.bytes(svc.db, userId, r.rawFileId) : undefined;
    await storeStreams(svc, userId, r.id, r.detail, fitStreamsOrNull(svc, file?.bytes));
    n++;
  }
  return n;
}

export interface LoadedStreams {
  laps: ActivityLap[];
  samples: ActivitySample[];
  summary: StreamsSummary;
}

/** Decoded streams by activity id (activities without a row are absent). */
export async function loadStreams(svc: Services, userId: string, activityIds: string[]): Promise<Map<string, LoadedStreams>> {
  const out = new Map<string, LoadedStreams>();
  for (const row of await streamsRepo.forActivities(svc.db, userId, activityIds)) {
    let samples: ActivitySample[] = [];
    try {
      samples = row.format === STREAMS_FORMAT ? decodeSamples(row.samples) : [];
    } catch (err) {
      svc.log.warn({ userId, activityId: row.activityId, err: String(err) }, "stored samples not readable");
    }
    out.set(row.activityId, {
      laps: Array.isArray(row.laps) ? (row.laps as ActivityLap[]) : [],
      samples,
      summary: (row.summary ?? {}) as StreamsSummary,
    });
  }
  return out;
}
