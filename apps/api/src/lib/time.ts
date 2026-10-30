/** Timezone helpers. Dates are local YYYY-MM-DD strings; the engine never reads the clock (spec §2.6). */

const dateFmtCache = new Map<string, Intl.DateTimeFormat>();

function fmt(tz: string): Intl.DateTimeFormat {
  let f = dateFmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      weekday: "short",
    });
    dateFmtCache.set(tz, f);
  }
  return f;
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export interface LocalParts {
  date: string;
  hour: number;
  minute: number;
}

export function localParts(now: Date, tz: string): LocalParts {
  const safeTz = isValidTimeZone(tz) ? tz : "UTC";
  const parts = Object.fromEntries(fmt(safeTz).formatToParts(now).map((p) => [p.type, p.value]));
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
  };
}

export function localDate(now: Date, tz: string): string {
  return localParts(now, tz).date;
}

/** Local YYYY-MM-DD from an intervals.icu "start_date_local" (e.g. "2026-10-28T07:01:02"). */
export function dateOfLocalTimestamp(s: string): string {
  return s.slice(0, 10);
}

export type Clock = () => Date;
export const systemClock: Clock = () => new Date();
