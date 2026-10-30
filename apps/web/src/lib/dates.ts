/** Local calendar helpers. Dates are YYYY-MM-DD strings; arithmetic comes from the engine (UTC day numbers). */
import { addDays, daysBetween, weekdayIndex, weekdayOf, WEEKDAYS, type Weekday } from "@paceo/engine";

export { addDays, daysBetween, weekdayIndex, weekdayOf, WEEKDAYS };
export type { Weekday };

/** Today's local date in an IANA timezone (defaults to the browser's). */
export function localToday(timeZone?: string, now: Date = new Date()): string {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(now);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
    return `${get("year")}-${get("month")}-${get("day")}`;
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** Monday of the week containing `date`. */
export function mondayOf(date: string): string {
  return addDays(date, -weekdayIndex(date));
}

function asUtcDate(date: string): Date {
  return new Date(`${date}T00:00:00Z`);
}

/** "Tue 17 Nov" */
export function formatDay(date: string): string {
  return asUtcDate(date).toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
}

/** "Tuesday 17 November" */
export function formatDayLong(date: string): string {
  return asUtcDate(date).toLocaleDateString(undefined, {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: "UTC",
  });
}

/** "17 Nov 2026" */
export function formatDate(date: string): string {
  return asUtcDate(date).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

export const WEEKDAY_SHORT: Record<Weekday, string> = {
  mon: "Mon",
  tue: "Tue",
  wed: "Wed",
  thu: "Thu",
  fri: "Fri",
  sat: "Sat",
  sun: "Sun",
};

export const WEEKDAY_LONG: Record<Weekday, string> = {
  mon: "Monday",
  tue: "Tuesday",
  wed: "Wednesday",
  thu: "Thursday",
  fri: "Friday",
  sat: "Saturday",
  sun: "Sunday",
};

/** "3 min ago", "5 h ago", "2 d ago", or a date for anything older than a week. */
export function timeAgo(iso: string, now: Date = new Date()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "unknown";
  const s = Math.max(0, Math.round((now.getTime() - t) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d <= 7) return `${d} d ago`;
  return new Date(t).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

/** Full years between a birth year and a local date (approximate: assumes the birthday has passed). */
export function ageFromBirthYear(birthYear: number, today: string): number {
  return Number(today.slice(0, 4)) - birthYear;
}
