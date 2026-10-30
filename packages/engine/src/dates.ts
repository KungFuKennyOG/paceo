/**
 * Calendar-date helpers for YYYY-MM-DD strings (spec §2.6: the engine is pure and deterministic).
 * All arithmetic is in UTC day numbers, so the host timezone and DST never shift a date.
 */

const MS_PER_DAY = 86_400_000;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export type Weekday = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";

/** Monday-first, matching the §7.2 template columns. */
export const WEEKDAYS: readonly Weekday[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

/** Days since 1970-01-01. Throws on malformed or impossible dates (e.g. 2026-02-30). */
export function toDayNumber(date: string): number {
  const m = ISO_DATE.exec(date);
  if (!m) throw new RangeError(`invalid date "${date}" (expected YYYY-MM-DD)`);
  const day = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / MS_PER_DAY;
  if (fromDayNumber(day) !== date) throw new RangeError(`invalid date "${date}"`);
  return day;
}

export function fromDayNumber(day: number): string {
  return new Date(day * MS_PER_DAY).toISOString().slice(0, 10);
}

export function addDays(date: string, days: number): string {
  return fromDayNumber(toDayNumber(date) + days);
}

/** `to − from` in whole days. */
export function daysBetween(from: string, to: string): number {
  return toDayNumber(to) - toDayNumber(from);
}

/** Monday = 0 … Sunday = 6. 1970-01-01 was a Thursday (index 3). */
export function weekdayIndex(date: string): number {
  return (((toDayNumber(date) + 3) % 7) + 7) % 7;
}

export function weekdayOf(date: string): Weekday {
  return WEEKDAYS[weekdayIndex(date)] as Weekday;
}

export interface PlanCalendar {
  /** Whole 7-day weeks from week 1 to the race week (0 if the race is less than a week away). */
  weeks: number;
  /** Day number of week 1, offset 0. */
  startDay: number;
  /** Day number of the race: always the last day (offset 6) of the last week. */
  raceDay: number;
  raceOffset: 6;
  /** Offset (0–6) of the long-run weekday inside every week. */
  lrOffset: number;
  /** Days between today and week 1 that the plan leaves open. */
  leadInDays: number;
}

/**
 * Plan weeks are 7-day blocks counted back from race day, so the race always ends the last week and
 * taper weeks are exactly 7, 14, 21 days out. The §7.2 template is rotated so its long run lands on
 * the long-run weekday (`lrOffset`). Week 1 is the first whole block starting today or later.
 */
export function planCalendar(today: string, raceDate: string, longRunDay: Weekday): PlanCalendar {
  const todayDay = toDayNumber(today);
  const raceDay = toDayNumber(raceDate);
  const weeks = Math.max(0, Math.floor((raceDay - todayDay + 1) / 7));
  const startDay = raceDay - 7 * weeks + 1;
  const startWeekday = (((startDay + 3) % 7) + 7) % 7;
  return {
    weeks,
    startDay,
    raceDay,
    raceOffset: 6,
    lrOffset: (WEEKDAYS.indexOf(longRunDay) - startWeekday + 7) % 7,
    leadInDays: startDay - todayDay,
  };
}
