/**
 * Cross-training mapping (spec §10.2, all C/D: no validated conversion to running exists) and the
 * locked-event calendar (§7.1 step 1).
 *
 * Every activity is 0 running km; its full sRPE × minutes goes into total_load (load.ts). A "hard
 * day" is treated like a quality run for §7.1 adjacency and costs ½ key session (§6.4). External
 * lifting (§9.6) is locked load too, but it is never hard for running purposes: lower/full sessions
 * feed the ST rules instead (strength-schedule.ts).
 */
import type { LockedEvent, ScheduleConflict } from "./plan-types.js";
import { WEEKDAYS, fromDayNumber, type Weekday } from "./dates.js";

export type CrossTrainingClass =
  | "cycling"
  | "swimming"
  | "rowing"
  | "paddling"
  | "elliptical"
  | "hiking"
  | "xc_ski"
  | "team_sport"
  | "hiit"
  | "climbing"
  | "strength_upper"
  | "strength_lower"
  | "strength_full"
  | "strength_unknown"
  | "yoga"
  | "other";

/** §10.2 "Lower-body load?" column. */
export type LowerBodyLoad = "none" | "low" | "moderate" | "yes";

/** When a session of this class is a hard day (§10.2 column 4). */
type HardRule = "srpe7" | "srpe8" | "always" | "never" | "hike";

export interface CrossTrainingRow {
  cls: CrossTrainingClass;
  label: string;
  /** Counts toward the R-BREAK aerobic column. "if45" = only sessions ≥ 45 min. */
  aerobic: "yes" | "partial" | "no" | "if45";
  /** Default sRPE (easy, hard). */
  srpe: readonly [number, number];
  hardRule: HardRule;
  lowerBody: LowerBodyLoad;
  /** Loads the trunk: the strength CORE slot stays at 1 (§9.3). */
  trunkLoading: boolean;
  /** Team/court sports and HIIT: no quality run within 24 h after, no heavy lower or plyo that day (§7.1, §10.2). */
  plyoLike: boolean;
  /** External lifting (§9.6). */
  lift?: "upper" | "lower" | "full" | "unknown";
}

const row = (r: CrossTrainingRow): CrossTrainingRow => r;

/** The §10.2 table (every row D). */
export const CROSS_TRAINING_TABLE: Record<CrossTrainingClass, CrossTrainingRow> = {
  cycling: row({ cls: "cycling", label: "Cycling", aerobic: "yes", srpe: [3, 7], hardRule: "srpe7", lowerBody: "moderate", trunkLoading: false, plyoLike: false }),
  swimming: row({ cls: "swimming", label: "Swimming", aerobic: "yes", srpe: [3, 7], hardRule: "srpe7", lowerBody: "none", trunkLoading: false, plyoLike: false }),
  rowing: row({ cls: "rowing", label: "Rowing / erg", aerobic: "yes", srpe: [4, 7], hardRule: "srpe7", lowerBody: "moderate", trunkLoading: true, plyoLike: false }),
  paddling: row({ cls: "paddling", label: "Paddling", aerobic: "yes", srpe: [4, 7], hardRule: "srpe7", lowerBody: "low", trunkLoading: true, plyoLike: false }),
  elliptical: row({ cls: "elliptical", label: "Elliptical / aqua jogging", aerobic: "yes", srpe: [3, 6], hardRule: "srpe7", lowerBody: "low", trunkLoading: false, plyoLike: false }),
  hiking: row({ cls: "hiking", label: "Hiking / walking", aerobic: "if45", srpe: [2, 5], hardRule: "hike", lowerBody: "yes", trunkLoading: false, plyoLike: false }),
  xc_ski: row({ cls: "xc_ski", label: "XC skiing / skimo", aerobic: "yes", srpe: [4, 7], hardRule: "srpe7", lowerBody: "moderate", trunkLoading: false, plyoLike: false }),
  team_sport: row({ cls: "team_sport", label: "Team / court sport", aerobic: "partial", srpe: [5, 8], hardRule: "always", lowerBody: "yes", trunkLoading: false, plyoLike: true }),
  hiit: row({ cls: "hiit", label: "HIIT / CrossFit / bootcamp", aerobic: "partial", srpe: [6, 8], hardRule: "always", lowerBody: "yes", trunkLoading: true, plyoLike: true }),
  climbing: row({ cls: "climbing", label: "Climbing / bouldering", aerobic: "no", srpe: [4, 7], hardRule: "srpe8", lowerBody: "low", trunkLoading: true, plyoLike: false }),
  strength_upper: row({ cls: "strength_upper", label: "Strength (own program, upper)", aerobic: "no", srpe: [5, 7], hardRule: "never", lowerBody: "none", trunkLoading: true, plyoLike: false, lift: "upper" }),
  strength_lower: row({ cls: "strength_lower", label: "Strength (own program, lower)", aerobic: "no", srpe: [6, 8], hardRule: "never", lowerBody: "yes", trunkLoading: true, plyoLike: false, lift: "lower" }),
  strength_full: row({ cls: "strength_full", label: "Strength (own program, full body)", aerobic: "no", srpe: [6, 8], hardRule: "never", lowerBody: "yes", trunkLoading: true, plyoLike: false, lift: "full" }),
  strength_unknown: row({ cls: "strength_unknown", label: "Strength (own program)", aerobic: "no", srpe: [6, 8], hardRule: "never", lowerBody: "yes", trunkLoading: true, plyoLike: false, lift: "unknown" }),
  yoga: row({ cls: "yoga", label: "Yoga / mobility / Pilates", aerobic: "no", srpe: [2, 4], hardRule: "never", lowerBody: "none", trunkLoading: false, plyoLike: false }),
  other: row({ cls: "other", label: "Other", aerobic: "no", srpe: [4, 7], hardRule: "srpe7", lowerBody: "low", trunkLoading: false, plyoLike: false }),
};

/** Hard thresholds (§13): sRPE ≥ 7; climbing ≥ 8; hikes > 3 h with > 800 m gain. */
export const HARD_SRPE = 7;
export const HARD_SRPE_CLIMBING = 8;
export const HARD_HIKE_MIN = 180;
export const HARD_HIKE_GAIN_M = 800;
/** A hard cross-training day costs half a key session (§6.4, D). */
export const HARD_XT_KEY_COST = 0.5;

/** Names and intervals.icu sport types → class. Keys are lower-case with non-letters removed. */
const ALIASES: Record<string, CrossTrainingClass> = {
  // cycling
  cycling: "cycling", ride: "cycling", virtualride: "cycling", bike: "cycling", biking: "cycling",
  ebikeride: "cycling", gravelride: "cycling", mountainbikeride: "cycling", spinning: "cycling", indoorcycling: "cycling",
  // swimming
  swimming: "swimming", swim: "swimming", openwaterswim: "swimming",
  // rowing / paddling
  rowing: "rowing", erg: "rowing", indoorrowing: "rowing",
  paddling: "paddling", dragonboat: "paddling", kayak: "paddling", kayaking: "paddling", canoe: "paddling",
  canoeing: "paddling", sup: "paddling", standuppaddling: "paddling",
  // elliptical
  elliptical: "elliptical", aquajogging: "elliptical", deepwaterrunning: "elliptical", stairstepper: "elliptical",
  // hiking
  hiking: "hiking", hike: "hiking", walking: "hiking", walk: "hiking", rucking: "hiking",
  // skiing
  xcski: "xc_ski", nordicski: "xc_ski", crosscountryskiing: "xc_ski", skimo: "xc_ski", backcountryski: "xc_ski",
  // team & court
  teamsport: "team_sport", soccer: "team_sport", football: "team_sport", basketball: "team_sport", hockey: "team_sport",
  icehockey: "team_sport", ultimate: "team_sport", tennis: "team_sport", squash: "team_sport", badminton: "team_sport",
  pickleball: "team_sport", volleyball: "team_sport", rugby: "team_sport", handball: "team_sport",
  // HIIT
  hiit: "hiit", highintensityintervaltraining: "hiit", crossfit: "hiit", bootcamp: "hiit",
  // climbing
  climbing: "climbing", rockclimbing: "climbing", bouldering: "climbing",
  // strength (external)
  strengthupper: "strength_upper", upper: "strength_upper",
  strengthlower: "strength_lower", lower: "strength_lower",
  strengthfull: "strength_full", fullbody: "strength_full",
  strengthunknown: "strength_unknown", strength: "strength_unknown", weighttraining: "strength_unknown", lifting: "strength_unknown",
  // yoga
  yoga: "yoga", mobility: "yoga", pilates: "yoga", stretching: "yoga",
  other: "other",
};

/** §10.2 class of an activity name or intervals.icu sport type. Unknown → "other". */
export function crossTrainingClass(activity: string): CrossTrainingClass {
  const key = activity.toLowerCase().replace(/[^a-z]/g, "");
  return ALIASES[key] ?? "other";
}

export interface ClassifiedEvent {
  event: LockedEvent;
  row: CrossTrainingRow;
  srpe: number;
  hard: boolean;
  locked: boolean;
  /** ½ for a hard non-lifting session (§6.4), else 0. */
  keyCost: number;
  trace: string[];
}

/**
 * §10.2 classification. An explicit `hard` wins (team sport `hard: false` = "light/technique").
 * Otherwise: always/never by class; sRPE ≥ 7 (≥ 8 climbing); hikes > 3 h with > 800 m gain.
 * sRPE defaults to the class's easy value, or its hard value when the session is hard.
 */
export function classifyEvent(event: LockedEvent): ClassifiedEvent {
  const row = CROSS_TRAINING_TABLE[crossTrainingClass(event.activity)];
  const trace = [`§10.2:${row.cls}`];
  let hard: boolean;
  if (event.hard !== undefined) {
    hard = event.hard;
    trace.push(`§10.2:user_${hard ? "hard" : "easy"}`);
  } else {
    switch (row.hardRule) {
      case "always":
        hard = true;
        break;
      case "never":
        hard = false;
        break;
      case "srpe8":
        hard = (event.srpe ?? row.srpe[0]) >= HARD_SRPE_CLIMBING;
        break;
      case "hike":
        hard =
          (event.srpe ?? row.srpe[0]) >= HARD_SRPE ||
          (event.minutes > HARD_HIKE_MIN && (event.elevationGainM ?? 0) > HARD_HIKE_GAIN_M);
        break;
      case "srpe7":
        hard = (event.srpe ?? row.srpe[0]) >= HARD_SRPE;
        break;
    }
    trace.push(`§10.2:hard_rule:${row.hardRule}->${hard ? "hard" : "easy"}`);
  }
  // External lifting is never hard for running purposes (§10.2): it feeds the ST rules instead.
  if (row.lift) hard = false;
  const srpe = event.srpe ?? (hard ? row.srpe[1] : row.srpe[0]);
  const keyCost = hard ? HARD_XT_KEY_COST : 0;
  if (keyCost > 0) trace.push("§6.4:half_key_session");
  return { event, row, srpe, hard, locked: event.locked ?? true, keyCost, trace };
}

/** A locked session on a date (PlanWeek.crossTraining). 0 running km, always. */
export interface CrossTrainingSession {
  date: string;
  weekday: Weekday;
  /** As entered (e.g. "dragon boat", "Ride"). */
  activity: string;
  cls: CrossTrainingClass;
  name: string;
  minutes: number;
  expectedSrpe: number;
  /** total_load contribution, AU = sRPE × minutes (§10.1). */
  load: number;
  hard: boolean;
  locked: boolean;
  /** Key-session cost toward the weekly cap of 3 (§6.4): 0.5 when hard, else 0. */
  keyCost: number;
  lowerBody: LowerBodyLoad;
  /** External lifting type (§9.6), if this is the user's own strength program. */
  lift?: "upper" | "lower" | "full" | "unknown";
  /** No quality run the same day or within 24 h after (§7.1 step 4, §10.2). */
  blocksNextDayQuality: boolean;
  rule_trace: string[];
}

/** External lower/full/unknown lifting: subject to ST-3/4/5/7 (§9.6). Unknown is treated as lower (D). */
export function isLowerLift(s: Pick<CrossTrainingSession, "lift">): boolean {
  return s.lift !== undefined && s.lift !== "upper";
}

/**
 * §7.1 step 1: every locked event on its weekday, for each day in [firstDay, lastDay]. Race day is
 * skipped (D: nobody paddles on race morning); the summary says so.
 */
export function expandLockedEvents(
  events: readonly LockedEvent[],
  firstDay: number,
  lastDay: number,
  raceDay?: number,
): CrossTrainingSession[] {
  const classified = events.map(classifyEvent);
  const out: CrossTrainingSession[] = [];
  for (let day = firstDay; day <= lastDay; day++) {
    if (day === raceDay) continue;
    const weekday = WEEKDAYS[(((day + 3) % 7) + 7) % 7] as Weekday;
    for (const c of classified) {
      if (c.event.weekday !== weekday) continue;
      const session: CrossTrainingSession = {
        date: fromDayNumber(day),
        weekday,
        activity: c.event.activity,
        cls: c.row.cls,
        name: c.event.name ?? c.row.label,
        minutes: c.event.minutes,
        expectedSrpe: c.srpe,
        load: c.srpe * c.event.minutes,
        hard: c.hard,
        locked: c.locked,
        keyCost: c.keyCost,
        lowerBody: c.row.lowerBody,
        blocksNextDayQuality: c.hard || c.row.plyoLike,
        rule_trace: [...c.trace, c.locked ? "§10.2:locked" : "§10.2:flexible"],
      };
      if (c.row.lift) session.lift = c.row.lift;
      out.push(session);
    }
  }
  return out;
}

/** Whether the user has trunk-loading cross-training; if not, strength sessions get a 2nd CORE slot (§9.3). */
export function hasTrunkLoadingCrossTraining(events: readonly LockedEvent[] = []): boolean {
  return events.some((e) => CROSS_TRAINING_TABLE[crossTrainingClass(e.activity)].trunkLoading);
}

/** Merge a conflict into `list`, deduplicated by code and weekday (weeks accumulate). */
export function recordConflict(
  list: ScheduleConflict[],
  c: { code: string; weekday: Weekday; week: number; message: string; suggestion?: string },
): void {
  const found = list.find((x) => x.code === c.code && x.weekday === c.weekday);
  if (found) {
    if (!found.weeks.includes(c.week)) found.weeks.push(c.week);
    return;
  }
  const entry: ScheduleConflict = { code: c.code, weekday: c.weekday, weeks: [c.week], message: c.message };
  if (c.suggestion !== undefined) entry.suggestion = c.suggestion;
  list.push(entry);
}
