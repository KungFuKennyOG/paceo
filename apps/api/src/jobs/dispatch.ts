/**
 * Pure scheduling rules for the cron dispatchers (spec §12.1), kept free of pg-boss so they are
 * unit-testable.
 * - Sync: dispatcher runs every 5 min; each user is due every 3rd slot (15 min), in a slot chosen by
 *   hash(user_id), during waking hours, with a start delay spread over the slot.
 * - Daily: dispatcher runs every 15 min; a user's job is due in the 15-min window starting at the
 *   configured local hour.
 */
import { localParts } from "../lib/time.js";

export const SYNC_SLOT_MINUTES = 5;
export const SYNC_EVERY_SLOTS = 3;
/** Waking hours for polling, user-local [from, to). */
export const WAKING_HOURS = { from: 6, to: 23 } as const;

/** FNV-1a 32-bit, stable across processes. */
export function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function syncDue(userId: string, now: Date, tz: string): { due: boolean; startAfterSeconds: number } {
  const slot = Math.floor(now.getTime() / (SYNC_SLOT_MINUTES * 60_000));
  const h = hash32(userId);
  const local = localParts(now, tz);
  const awake = local.hour >= WAKING_HOURS.from && local.hour < WAKING_HOURS.to;
  return {
    due: awake && slot % SYNC_EVERY_SLOTS === h % SYNC_EVERY_SLOTS,
    startAfterSeconds: Math.floor(h / SYNC_EVERY_SLOTS) % (SYNC_SLOT_MINUTES * 60 - 30),
  };
}

/** True once per day: in the 15-minute window starting at `hour` local time. */
export function dailyDue(now: Date, tz: string, hour: number): { due: boolean; localDate: string } {
  const local = localParts(now, tz);
  return { due: local.hour === hour && local.minute < 15, localDate: local.date };
}
