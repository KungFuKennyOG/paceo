/**
 * Activity ingest (spec §3.2 sync strategy, §3.4 FIT upload, §3.9 dedup).
 * - Poll: oldest = last_seen_date − 1 d (first run: today − 120 d), newest = today.
 * - Reconcile (nightly): the last 7 days.
 * - New activities: fetch detail, then the original FIT (/file) for runs. ~3 calls per new activity.
 * Ingest is idempotent on (user_id, source, source_id).
 */
import { addDays } from "@paceo/engine";
import { activitiesRepo, credentialsRepo, rawFilesRepo, type ActivityInput, type ActivityRow } from "../repo/index.js";
import type { SourceActivity } from "../integrations/types.js";
import { FitParseError, maybeGunzip, parseFit } from "../integrations/fit/parse.js";
import { sha256Hex } from "../crypto/tokens.js";
import { localDate } from "../lib/time.js";
import { AppError } from "../http/errors.js";
import { countBySport, getAccount, MESSAGES, PROVIDER, recordAdapterError, userTimezone } from "./connection.js";
import type { Services } from "./context.js";

export interface SyncResult {
  fetched: number;
  inserted: number;
  hiddenStrava: number;
  skipped?: "no_credential" | "error";
}

export function activityInputFromSource(a: SourceActivity): ActivityInput {
  return {
    source: "intervals_icu",
    sourceId: a.sourceId,
    originPlatform: a.originPlatform,
    startUtc: a.startUtc,
    localDate: a.localDate,
    sport: a.sport,
    distanceM: a.distanceM,
    movingS: a.movingS,
    elapsedS: a.elapsedS,
    avgHr: a.avgHr,
    isRace: a.isRace,
    name: a.name,
    device: a.device,
    garminOrigin: a.garminOrigin,
    stravaDerived: false,
    detail: a.raw ?? null,
  };
}

async function ingest(svc: Services, userId: string, input: ActivityInput): Promise<{ row: ActivityRow; inserted: boolean }> {
  const res = await activitiesRepo.upsert(svc.db, userId, input);
  if (res.inserted) {
    const dup = await activitiesRepo.findCrossSourceDuplicate(svc.db, userId, {
      source: input.source,
      startUtc: input.startUtc,
      distanceM: input.distanceM,
    });
    if (dup && dup.id !== res.row.id) await activitiesRepo.markDuplicate(svc.db, userId, res.row.id, dup.id);
  }
  return res;
}

export async function syncUser(svc: Services, userId: string, mode: "poll" | "reconcile" | "setup" = "poll"): Promise<SyncResult> {
  const acct = await getAccount(svc, userId);
  if (!acct) return { fetched: 0, inserted: 0, hiddenStrava: 0, skipped: "no_credential" };
  const { account, cred } = acct;
  const today = localDate(svc.clock(), await userTimezone(svc, userId));
  const oldest =
    mode === "reconcile"
      ? addDays(today, -7)
      : mode === "setup" || !cred.lastSeenDate
        ? addDays(today, -120)
        : addDays(cred.lastSeenDate < today ? cred.lastSeenDate : today, -1);

  try {
    const listing = await account.source.listActivities(oldest, today);
    let inserted = 0;
    let newest = cred.lastSeenDate;
    for (const a of listing.activities) {
      const res = await ingest(svc, userId, activityInputFromSource(a));
      if (!newest || a.localDate > newest) newest = a.localDate;
      if (!res.inserted) continue;
      inserted++;
      if (a.sport !== "run") continue;
      // Detail with intervals, then the canonical original file (§3.2).
      const detail = await account.source.getActivityDetail(a.sourceId);
      if (detail) await activitiesRepo.upsert(svc.db, userId, activityInputFromSource(detail));
      const file = await account.source.getOriginalFile(a.sourceId);
      if (file) {
        const rawId = await rawFilesRepo.put(svc.db, userId, {
          source: "intervals_icu",
          sourceId: a.sourceId,
          sha256: sha256Hex(file.bytes),
          contentType: file.contentType,
          bytes: file.bytes,
        });
        await activitiesRepo.setRawFile(svc.db, userId, res.row.id, rawId);
      }
    }

    const update: Parameters<typeof credentialsRepo.update>[3] = {
      status: "ok",
      lastSyncAt: svc.clock(),
      lastSeenDate: newest ?? null,
    };
    if (mode === "setup") {
      const counts = countBySport(listing.activities.map((a) => a.sport));
      if (listing.hiddenStravaCount > 0) counts.strava_hidden = listing.hiddenStravaCount;
      update.activityCounts = counts;
    }
    if (listing.hiddenStravaCount > 0) update.statusMessage = MESSAGES.strava(listing.hiddenStravaCount);
    else if (listing.activities.length === 0 && !cred.lastSeenDate) update.statusMessage = MESSAGES.noActivities;
    else update.statusMessage = null;
    await credentialsRepo.update(svc.db, userId, PROVIDER, update);
    return { fetched: listing.activities.length, inserted, hiddenStrava: listing.hiddenStravaCount };
  } catch (err) {
    if (await recordAdapterError(svc, userId, err)) return { fetched: 0, inserted: 0, hiddenStrava: 0, skipped: "error" };
    throw err;
  }
}

/** Manual FIT upload (§3.4). Returns the stored (or already-known) activity. */
export async function ingestFitUpload(svc: Services, userId: string, upload: Buffer): Promise<ActivityRow> {
  const bytes = maybeGunzip(upload);
  let summary;
  try {
    summary = parseFit(bytes);
  } catch (err) {
    if (err instanceof FitParseError) throw new AppError(400, "invalid_fit", `Couldn't read that file: ${err.message}.`);
    throw err;
  }
  const sha = sha256Hex(bytes);
  const tz = await userTimezone(svc, userId);
  const local =
    summary.utcOffsetS !== null
      ? new Date(summary.startUtc.getTime() + summary.utcOffsetS * 1000).toISOString().slice(0, 10)
      : localDate(summary.startUtc, tz);
  const manufacturer = summary.manufacturer?.toLowerCase() ?? null;
  const device = [summary.manufacturer, summary.product].filter(Boolean).join(" ") || null;
  const rawId = await rawFilesRepo.put(svc.db, userId, {
    source: "fit_upload",
    sourceId: sha.slice(0, 32),
    sha256: sha,
    contentType: "application/vnd.ant.fit",
    bytes,
  });
  const res = await ingest(svc, userId, {
    source: "fit_upload",
    sourceId: sha.slice(0, 32),
    originPlatform: manufacturer && manufacturer !== "development" ? manufacturer : null,
    startUtc: summary.startUtc,
    localDate: local,
    sport: summary.sport,
    distanceM: summary.distanceM,
    movingS: summary.movingS,
    elapsedS: summary.elapsedS,
    avgHr: summary.avgHr,
    isRace: false,
    name: null,
    device,
    // User-uploaded files are the user's own data; attribution still applies when shown (§3.2).
    garminOrigin: manufacturer === "garmin",
    stravaDerived: false,
    detail: { fit: { ...summary, startUtc: summary.startUtc.toISOString() } },
  });
  await activitiesRepo.setRawFile(svc.db, userId, res.row.id, rawId);
  return { ...res.row, rawFileId: rawId };
}
