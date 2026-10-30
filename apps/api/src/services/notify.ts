/**
 * Web push (spec §11.2): VAPID via the `web-push` library, one subscription per device per user.
 * 404/410 from the push service deletes the subscription.
 */
import webpush from "web-push";
import { formatDistance, type Units } from "@paceo/engine";
import { pushRepo } from "../repo/index.js";
import type { Services } from "./context.js";

export interface PushTarget {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export type PushResult = { ok: true } | { ok: false; gone: boolean; error: string };

export interface PushSender {
  send(target: PushTarget, payload: PushPayload): Promise<PushResult>;
}

export interface PushPayload {
  title: string;
  body: string;
  /** Path in the PWA to open on tap. */
  url: string;
  tag?: string;
}

export function webPushSender(vapid: { publicKey: string; privateKey: string; subject: string }): PushSender {
  return {
    async send(target, payload) {
      try {
        await webpush.sendNotification(target, JSON.stringify(payload), {
          TTL: 6 * 3600,
          vapidDetails: { subject: vapid.subject, publicKey: vapid.publicKey, privateKey: vapid.privateKey },
        });
        return { ok: true };
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode;
        return { ok: false, gone: status === 404 || status === 410, error: `push failed (${status ?? "network"})` };
      }
    },
  };
}

export function generateVapidKeys(): { publicKey: string; privateKey: string } {
  return webpush.generateVAPIDKeys();
}

/** Sends to every device of one user; prunes dead subscriptions. Returns how many were delivered. */
export async function pushToUser(svc: Services, userId: string, payload: PushPayload): Promise<number> {
  if (!svc.push) return 0;
  const subs = await pushRepo.list(svc.db, userId);
  let delivered = 0;
  for (const s of subs) {
    const r = await svc.push.send({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload);
    if (r.ok) {
      delivered++;
      await pushRepo.markSuccess(svc.db, userId, s.id);
    } else if (r.gone) {
      await pushRepo.deleteById(svc.db, userId, s.id);
    } else {
      svc.log.warn({ userId, err: r.error }, "web push failed");
    }
  }
  return delivered;
}

export interface TodayWorkoutLike {
  name: string;
  sport: string;
  planned: { minutes: number; run_m: number };
}

/** "Today's workout" message: name + duration in the user's units, plus where to follow it. */
export function todayMessage(w: TodayWorkoutLike, units: Units, onWatch: boolean): PushPayload {
  const parts: string[] = [];
  if (w.planned.minutes > 0) parts.push(`${Math.round(w.planned.minutes)} min`);
  if (w.sport === "run" && w.planned.run_m > 0) parts.push(formatDistance(w.planned.run_m, units));
  parts.push(onWatch ? "on your watch" : "open in app");
  return { title: `Today: ${w.name}`, body: parts.join(" · "), url: "/today", tag: "today" };
}
