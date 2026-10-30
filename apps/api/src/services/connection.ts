/**
 * intervals.icu connection (spec §2.5 steps 5–8 and error states). The API key is encrypted with
 * the user id as AAD and only decrypted here, right before an adapter call.
 */
import type { ConnectIntervalsRequest, ConnectionStatus } from "@paceo/contracts";
import { addDays } from "@paceo/engine";
import { credentialsRepo, profileRepo, type CredentialRow } from "../repo/index.js";
import { AppError } from "../http/errors.js";
import { IntervalsError } from "../integrations/intervals/client.js";
import type { IntervalsAccount } from "../integrations/types.js";
import { localDate } from "../lib/time.js";
import { JOB } from "../jobs/queue.js";
import type { Services } from "./context.js";

export const PROVIDER = "intervals_icu";

export const MESSAGES = {
  keyRejected: "Key not accepted — copy it again from intervals.icu → Settings → Developer Settings.",
  noActivities:
    "intervals.icu has no activities yet. Check that your watch is connected under Connections in intervals.icu, then sync your watch. You can also upload FIT files.",
  strava: (n: number) =>
    `${n} ${n === 1 ? "activity comes" : "activities come"} from Strava, which intervals.icu can't share with other apps. ` +
    "Connect your watch directly in intervals.icu (Settings → Connections) or upload FIT files instead.",
  rateLimited: "intervals.icu is busy; we'll retry automatically.",
  athleteMismatch: "That key belongs to a different intervals.icu athlete than the id you entered.",
  unreachable: "Couldn't reach intervals.icu right now. Try again in a minute.",
} as const;

const aad = (userId: string) => `${userId}:${PROVIDER}`;

export async function userTimezone(svc: Services, userId: string): Promise<string> {
  const p = await profileRepo.get(svc.db, userId);
  return p?.timezone ?? "UTC";
}

export function toConnectionStatus(cred: CredentialRow | undefined): ConnectionStatus | null {
  if (!cred) return null;
  const status = (["ok", "invalid", "rate_limited", "never_synced"] as const).find((s) => s === cred.status) ?? "ok";
  return {
    provider: "intervals_icu",
    connected: cred.status !== "invalid",
    status,
    athleteName: cred.athleteName,
    lastSyncAt: cred.lastSyncAt ? cred.lastSyncAt.toISOString() : null,
    activityCounts: (cred.activityCounts as Record<string, number> | null) ?? null,
    message: cred.statusMessage,
  };
}

export async function getAccount(
  svc: Services,
  userId: string,
): Promise<{ account: IntervalsAccount; cred: CredentialRow } | null> {
  const cred = await credentialsRepo.get(svc.db, userId, PROVIDER);
  if (!cred || cred.status === "invalid") return null;
  const apiKey = svc.secretBox.decrypt(cred.secretEnc, aad(userId));
  return { account: svc.intervals(apiKey), cred };
}

/** Records the outcome of an adapter error on the credential; returns true when handled. */
export async function recordAdapterError(svc: Services, userId: string, err: unknown): Promise<boolean> {
  if (!(err instanceof IntervalsError)) return false;
  if (err.kind === "auth") {
    await credentialsRepo.update(svc.db, userId, PROVIDER, { status: "invalid", statusMessage: MESSAGES.keyRejected });
    return true;
  }
  if (err.kind === "rate_limited") {
    await credentialsRepo.update(svc.db, userId, PROVIDER, { status: "rate_limited", statusMessage: MESSAGES.rateLimited });
    svc.log.warn({ userId }, "intervals.icu rate limit persisted after retries");
    return true;
  }
  if (err.kind === "blocked") {
    // Server-side problem (User-Agent / Cloudflare); never shown to the user (§2.5).
    svc.log.error({ userId, err: err.message }, "intervals.icu blocked the request (Cloudflare challenge)");
    return true;
  }
  return false;
}

export function countBySport(sports: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const s of sports) counts[s] = (counts[s] ?? 0) + 1;
  return counts;
}

export async function connectIntervals(svc: Services, userId: string, req: ConnectIntervalsRequest): Promise<ConnectionStatus> {
  const apiKey = req.apiKey.trim();
  const account = svc.intervals(apiKey);
  let athlete;
  try {
    athlete = await account.verify();
  } catch (err) {
    if (err instanceof IntervalsError && err.kind === "auth") throw new AppError(400, "key_rejected", MESSAGES.keyRejected);
    if (err instanceof IntervalsError && err.kind === "rate_limited") throw new AppError(503, "rate_limited", MESSAGES.rateLimited);
    svc.log.error({ userId, err: err instanceof Error ? err.message : String(err) }, "intervals.icu verify failed");
    throw new AppError(502, "upstream_unavailable", MESSAGES.unreachable);
  }
  if (req.athleteId && req.athleteId.trim().toLowerCase() !== athlete.id.toLowerCase()) {
    throw new AppError(400, "athlete_mismatch", MESSAGES.athleteMismatch);
  }

  const now = svc.clock();
  await credentialsRepo.upsert(svc.db, userId, {
    provider: PROVIDER,
    kind: "api_key",
    secretEnc: svc.secretBox.encrypt(apiKey, aad(userId)),
    keyVersion: svc.secretBox.keyVersion,
    athleteExtId: athlete.id,
    athleteName: athlete.name,
    status: "never_synced",
    statusMessage: null,
    lastValidatedAt: now,
  });

  // Setup pull (§2.5 step 7): count the last 120 days by sport. Ingest happens in the sync job.
  const today = localDate(now, await userTimezone(svc, userId));
  let counts: Record<string, number> | null = null;
  let message: string | null = null;
  try {
    const listing = await account.source.listActivities(addDays(today, -120), today);
    counts = countBySport(listing.activities.map((a) => a.sport));
    if (listing.hiddenStravaCount > 0) counts.strava_hidden = listing.hiddenStravaCount;
    if (listing.activities.length === 0) message = listing.hiddenStravaCount > 0 ? MESSAGES.strava(listing.hiddenStravaCount) : MESSAGES.noActivities;
    else if (listing.hiddenStravaCount > 0) message = MESSAGES.strava(listing.hiddenStravaCount);
    await credentialsRepo.update(svc.db, userId, PROVIDER, { activityCounts: counts, statusMessage: message });
  } catch (err) {
    if (!(await recordAdapterError(svc, userId, err))) {
      svc.log.warn({ userId, err: err instanceof Error ? err.message : String(err) }, "setup pull failed");
    }
  }
  await svc.jobs.enqueue(JOB.syncUser, { userId, mode: "setup" }, { singletonKey: `sync:${userId}`, singletonSeconds: 60 });

  const cred = await credentialsRepo.get(svc.db, userId, PROVIDER);
  return toConnectionStatus(cred) as ConnectionStatus;
}

export async function disconnectIntervals(svc: Services, userId: string): Promise<void> {
  // Deleting the row deletes the only copy of the key (§2.5: delete in one tap).
  await credentialsRepo.delete(svc.db, userId, PROVIDER);
}
