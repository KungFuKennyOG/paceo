/**
 * Weekly scheduler (spec §7). Places the long run, quality sessions and easy runs onto days.
 *
 * Templates are written as in §7.2 (Mon–Sun columns, Sunday long run = column 6) and rotated so the
 * long run lands on the user's long-run weekday inside each plan week ("rotate the whole template",
 * §7.2). Plan weeks are 7-day blocks ending on race day (dates.ts), so after rotation a template may
 * wrap across the block boundary; all spacing rules use absolute days, so that is safe.
 *
 * §7.1 step 1 (locked cross-training) reaches placeWeek as `qualityBlockedDays`: the generator
 * expands the locked events (cross-training.ts) and blocks quality on and after every hard / team /
 * HIIT session and after external lower-body lifting. Step 5 (strength, §9.5) and fallbacks 4–5 run
 * after all runs are placed (strength-schedule.ts, plan.ts).
 *
 * Specific weekdays (§2.3 "days available"): weekdayTemplate places the same roles on any set of
 * weekdays, by days after the long run (D, reproducing the §7.2 rows when the days match them).
 * §7.1 step 4 "respect max_session_minutes_by_day" is applied by the generator (plan.ts): it caps
 * each run on its day, keeps quality off days it can't fit (`qualityFits`, fallbacks 1–2), shortens
 * the LR (fallback 3) and reports the conflicts.
 */
import { WEEKDAYS, type Weekday } from "./dates.js";

export type SlotRole = "L" | "Q1" | "Q2" | "Q2_IF_EASY_LR" | "E" | "REC" | "E_SHORT" | "RW";

export interface TemplateSlot {
  /** Day offset 0–6 inside the plan week (after rotation). */
  offset: number;
  role: SlotRole;
}

/** An easy slot after placement; `wasQualitySlot` marks "the Q slot becomes E + strides" (§7.2). */
export interface EasySlot extends TemplateSlot {
  wasQualitySlot: boolean;
}

/** Column of the long run in the §7.2 (Sunday) templates. */
const TEMPLATE_LR_COLUMN = 6;

const slot = (offset: number, role: SlotRole): TemplateSlot => ({ offset, role });

/** §7.2 templates (Sunday long run). The 2-day row is the race-mode version: Q + L (D); general fitness uses E + L. */
const TEMPLATES: Record<number, readonly TemplateSlot[]> = {
  2: [slot(1, "Q1"), slot(6, "L")],
  3: [slot(1, "Q1"), slot(3, "E"), slot(6, "L")],
  4: [slot(1, "Q1"), slot(3, "Q2_IF_EASY_LR"), slot(5, "E"), slot(6, "L")],
  5: [slot(1, "Q1"), slot(2, "E"), slot(3, "Q2"), slot(5, "E"), slot(6, "L")],
  6: [slot(0, "REC"), slot(1, "Q1"), slot(2, "E"), slot(3, "Q2"), slot(5, "E"), slot(6, "L")],
  7: [slot(0, "REC"), slot(1, "Q1"), slot(2, "E"), slot(3, "Q2"), slot(4, "E_SHORT"), slot(5, "E"), slot(6, "L")],
};

/** §7.2 2-day row, "general fitness only": Tue E (+ strength), Sun L. */
const GENERAL_FITNESS_2_DAY: readonly TemplateSlot[] = [slot(1, "E"), slot(6, "L")];

/** Beginner ladder: Mon / Wed / Sat run/walk (§7.2). */
const LADDER_TEMPLATE: readonly TemplateSlot[] = [slot(0, "RW"), slot(2, "RW"), slot(5, "RW")];

/** The user's run weekdays and long-run weekday (§2.3), for weekdayTemplate. */
export interface RunWeekdays {
  days: readonly Weekday[];
  longRunDay: Weekday;
  /** §7.1 step 4 limit per weekday (Infinity = none): when only some days are used, roomier days win. */
  maxMinutes?: (weekday: Weekday) => number;
}

export interface TemplateOptions {
  ladder?: boolean;
  noConsecutiveDays?: boolean;
  /** Offset of the long-run weekday inside the plan week; default 6 (unrotated). */
  lrOffset?: number;
  /** General-fitness mode: the 2-day row is E + L (§7.2). */
  generalFitness?: boolean;
  /** Run only on these weekdays (the long-run day always counts as one); replaces the §7.2 rows. */
  weekdays?: RunWeekdays;
}

/**
 * Template for a week, rotated to the long-run day and sorted by offset. Beginners in their first
 * 4 weeks get no consecutive run days (§7.1), which over a repeating 7-day week allows at most 3 runs:
 * the 3-day row is used (D).
 */
export function weekTemplate(runDays: number, opts: TemplateOptions = {}): TemplateSlot[] {
  const days = opts.noConsecutiveDays ? Math.min(3, runDays) : runDays;
  const n = Math.min(7, Math.max(2, days));
  const t = opts.weekdays
    ? weekdayTemplate(opts.weekdays, runDays, opts)
    : opts.ladder ? LADDER_TEMPLATE : opts.generalFitness && n === 2 ? GENERAL_FITNESS_2_DAY : TEMPLATES[n];
  if (!t) throw new RangeError(`no template for ${runDays} run days`);
  const shift = (opts.lrOffset ?? TEMPLATE_LR_COLUMN) - TEMPLATE_LR_COLUMN;
  return t.map((s) => ({ ...s, offset: (s.offset + shift + 7) % 7 })).sort((a, b) => a.offset - b.offset);
}

// ── specific weekdays (§2.3 days available, §7.1–7.2; D) ─────────────────────────────────────────

/**
 * Template columns (the §7.2 Sunday frame: long run = column 6, Mon = 0) of the run weekdays,
 * long-run day included. Column c is (c + 1) % 7 days after the long run.
 */
export function weekdayColumns(w: RunWeekdays): number[] {
  const lr = WEEKDAYS.indexOf(w.longRunDay);
  const cols = [...w.days, w.longRunDay].map((d) => (WEEKDAYS.indexOf(d) - lr + TEMPLATE_LR_COLUMN + 7) % 7);
  return [...new Set(cols)].sort((a, b) => a - b);
}

/** Weekday of a Sunday-frame template column for this long-run day. */
export function columnWeekday(column: number, longRunDay: Weekday): Weekday {
  return WEEKDAYS[(column - TEMPLATE_LR_COLUMN + WEEKDAYS.indexOf(longRunDay) + 7) % 7] as Weekday;
}

/** Days after the long run (0 = the LR day) of a Sunday-frame column. */
const afterLr = (column: number) => (column + 1) % 7;
const cyclicGap = (a: number, b: number) => Math.min(Math.abs(a - b), 7 - Math.abs(a - b));

/** Lexicographic `a < b` for equal-length number keys. */
function lexLess(a: readonly number[], b: readonly number[]): boolean {
  const i = a.findIndex((v, j) => v !== b[j]);
  return i >= 0 && (a[i] as number) < (b[i] as number);
}

function combinations<T>(xs: readonly T[], k: number): T[][] {
  if (k === 0) return [[]];
  if (k > xs.length) return [];
  const [first, ...rest] = xs as [T, ...T[]];
  return [...combinations(rest, k - 1).map((c) => [first, ...c]), ...combinations(rest, k)];
}

/**
 * Choose `k` of the columns (fewer only when `noAdjacent` can't fit k), deterministic (D): fewest
 * back-to-back pairs (the week repeats, so Sun → Mon counts), then the most time on the tightest
 * day (`minutes`, counted up to 90 min), then the widest smallest gap, then a
 * day that can hold quality (2–5 days after the LR), then the most days of the §7.2 row of that
 * size, then the earliest columns.
 */
export function pickRunColumns(
  columns: readonly number[],
  k: number,
  opts: { include?: number; noAdjacent?: boolean; minutes?: (column: number) => number } = {},
): number[] {
  const must = opts.include !== undefined && columns.includes(opts.include) ? [opts.include] : [];
  const pool = columns.filter((c) => !must.includes(c));
  for (let size = Math.min(k, columns.length); size >= must.length && size > 0; size--) {
    let best: number[] | undefined;
    let bestKey: number[] | undefined;
    for (const combo of combinations(pool, size - must.length)) {
      const set = [...combo, ...must].sort((a, b) => a - b);
      const gaps = set.length < 2 ? [7] : set.map((c, i) => cyclicGap(c, set[(i + 1) % set.length] as number));
      const adjacent = set.length < 2 ? 0 : set.length === 2 ? Number(gaps[0] === 1) : gaps.filter((g) => g === 1).length;
      if (opts.noAdjacent && adjacent > 0) continue;
      const row = new Set((TEMPLATES[size] ?? []).map((x) => x.offset));
      const room = opts.minutes ? Math.min(90, ...set.map(opts.minutes)) : 90;
      const key = [adjacent, -room, -Math.min(...gaps), set.some((c) => afterLr(c) >= 2 && afterLr(c) <= 5) ? 0 : 1, set.filter((c) => !row.has(c)).length, ...set];
      if (!bestKey || lexLess(key, bestKey)) {
        best = set;
        bestKey = key;
      }
    }
    if (best) return best;
  }
  return must;
}

/**
 * §7.2 roles on any set of weekdays (D). By days after the long run (d):
 *  - L on the long-run day;
 *  - Q1 on the earliest day with 2 ≤ d ≤ 5 (≥ 48 h after the LR and before the next one, §7.1 step 3);
 *    Q2 on the next such day ≥ 2 days after Q1 (5+ run days; "only with an easy LR" at 4, as §7.2);
 *    no Q2 at 2–3 days, and none on the 2-day general-fitness row;
 *  - the day after the LR is a recovery run at 6–7 days; at 7 days the day 2 days before the LR is
 *    the short E; everything else is E.
 * Placement still checks every constraint per week (placeWeek); a role is only a preference.
 * Beginners in their first weeks, and the run/walk ladder, run on ≤ 3 non-consecutive days with
 * the long-run day; a level cap (beginners 4) picks that many days (pickRunColumns).
 */
export function weekdayTemplate(w: RunWeekdays, runDays: number, opts: Pick<TemplateOptions, "ladder" | "noConsecutiveDays" | "generalFitness"> = {}): TemplateSlot[] {
  const all = weekdayColumns(w);
  const minutes = w.maxMinutes ? (c: number) => w.maxMinutes!(columnWeekday(c, w.longRunDay)) : undefined;
  const pickOpts = minutes ? { minutes } : {};
  // The ladder runs on the same ≤ 3 non-consecutive days (long-run day included) as the first
  // post-ladder weeks, so the hand-over never puts two runs on back-to-back days (§7.1).
  if (opts.ladder) return pickRunColumns(all, 3, { ...pickOpts, include: TEMPLATE_LR_COLUMN, noAdjacent: true }).map((c) => slot(c, "RW"));
  const cols = opts.noConsecutiveDays
    ? pickRunColumns(all, Math.min(3, runDays), { ...pickOpts, include: TEMPLATE_LR_COLUMN, noAdjacent: true })
    : runDays < all.length
      ? pickRunColumns(all, Math.max(1, runDays), { ...pickOpts, include: TEMPLATE_LR_COLUMN })
      : all;
  const n = cols.length;
  const roles = new Map<number, SlotRole>([[TEMPLATE_LR_COLUMN, "L"]]);
  const others = cols.filter((c) => c !== TEMPLATE_LR_COLUMN);
  const q = others.filter((c) => afterLr(c) >= 2 && afterLr(c) <= 5).sort((a, b) => afterLr(a) - afterLr(b));
  const q1 = q[0];
  if (q1 !== undefined && !(opts.generalFitness && n <= 2)) {
    roles.set(q1, "Q1");
    const q2 = n >= 4 ? q.find((c) => afterLr(c) >= afterLr(q1) + MIN_KEY_GAP_DAYS) : undefined;
    if (q2 !== undefined) roles.set(q2, n === 4 ? "Q2_IF_EASY_LR" : "Q2");
  }
  for (const c of others) if (!roles.has(c)) roles.set(c, n >= 6 && afterLr(c) === 1 ? "REC" : n === 7 && afterLr(c) === 5 ? "E_SHORT" : "E");
  return cols.map((c) => slot(c, roles.get(c) as SlotRole));
}

export interface PlacementInput {
  /** Absolute day number (dates.ts) of block offset 0. */
  weekStartDay: number;
  slots: readonly TemplateSlot[];
  /** False in the race week (the race replaces the LR), or when the LR day is too close to the race; the L slot then holds an easy run. */
  longRun: boolean;
  /** Race week only: offset of race day; slots on or after it are dropped. */
  raceOffset?: number;
  /** Quality sessions to place, highest priority first. A TT goes first. */
  qualityCount: number;
  /** Key or quality days already fixed before this week (absolute day numbers). */
  priorKeyDays: readonly number[];
  /** Absolute race day; with `minDaysBeforeRace`, no quality closer to it (§6.8 T3). */
  raceDay?: number;
  minDaysBeforeRace?: number;
  /**
   * Absolute days that may not hold a quality session (§7.1 step 4, §10.2, §9.6): the day of and the
   * day after a hard cross-training, team-sport or HIIT session; the day after external lower lifting (ST-4).
   */
  qualityBlockedDays?: ReadonlySet<number>;
  /** The subset of `qualityBlockedDays` caused only by flexible (non-locked) sessions, for fallback 5. */
  flexibleBlockedDays?: ReadonlySet<number>;
  /**
   * §7.1 step 4 "respect max_session_minutes_by_day": whether quality session `index` fits the
   * time allowed on the day at `offset`. A day it doesn't fit is illegal for it (fallbacks 1–2).
   */
  qualityFits?: (index: number, offset: number) => boolean;
}

export interface Placement {
  lrOffset?: number;
  /** Placed quality sessions, in input order; `undefined` = converted to easy + strides. */
  qualityOffsets: Array<number | undefined>;
  easy: EasySlot[];
  trace: string[];
}

/** Minimum day gap between two key sessions: 48 h (§7.1 step 3, C). */
export const MIN_KEY_GAP_DAYS = 2;

/**
 * §7.1 steps 2–4 and fallbacks 1–2:
 *  - LR on the long-run day.
 *  - Q1 on its template slot, Q2 on its slot; a slot is legal only if it is ≥ 48 h from every other
 *    key session (LR, quality, TT, race). That one rule covers "no consecutive quality days",
 *    "the day before / after the LR is easy or rest" and the 48 h rule.
 *  - Fallback 1: move the session to another legal run day (nearest first).
 *  - Fallback 2: convert it to easy + strides. Key sessions are never stacked.
 * Fallback 3 (shorten the LR) is applied by the generator, which always plans the LR at its
 * largest legal value (L1/L2/V1). Fallback 6 (report) surfaces through `trace` and plan notes.
 */
export function placeWeek(input: PlacementInput): Placement {
  const trace: string[] = [];
  const race = input.raceOffset;
  const usable = input.slots.filter((s) => race === undefined || s.offset < race);
  const keyDays = [...input.priorKeyDays];
  const taken = new Set<number>();

  const lrSlot = usable.find((s) => s.role === "L");
  let lrOffset: number | undefined;
  if (input.longRun && lrSlot) {
    lrOffset = lrSlot.offset;
    taken.add(lrOffset);
    // Next week's LR falls on the same weekday: keep 48 h before it too (a rotated week can end
    // the day before it, D).
    keyDays.push(input.weekStartDay + lrOffset, input.weekStartDay + lrOffset + 7);
  }
  if (race !== undefined) keyDays.push(input.weekStartDay + race);

  const blocked = input.qualityBlockedDays ?? new Set<number>();
  const flexible = input.flexibleBlockedDays ?? new Set<number>();
  /** `ignore`: which cross-training blocks to disregard (only used to explain a conversion). */
  const legal = (offset: number, ignore: "none" | "flexible" | "all" = "none", index?: number) => {
    const day = input.weekStartDay + offset;
    if (taken.has(offset)) return false;
    if (index !== undefined && input.qualityFits && !input.qualityFits(index, offset)) return false;
    const xtOk = ignore === "all" || !blocked.has(day) || (ignore === "flexible" && flexible.has(day));
    if (!xtOk) return false;
    if (input.raceDay !== undefined && input.raceDay - day < (input.minDaysBeforeRace ?? MIN_KEY_GAP_DAYS)) return false;
    return keyDays.every((k) => Math.abs(day - k) >= MIN_KEY_GAP_DAYS);
  };

  const qualityOffsets: Array<number | undefined> = [];
  for (let i = 0; i < input.qualityCount; i++) {
    const label = `Q${i + 1}`;
    const preferred = preferredOffset(usable, i);
    const candidates = usable
      .filter((s) => s.role !== "L" && s.offset !== preferred)
      .map((s) => s.offset)
      .sort((a, b) => Math.abs(a - (preferred ?? 1)) - Math.abs(b - (preferred ?? 1)) || a - b);
    let chosen: number | undefined;
    if (preferred !== undefined && legal(preferred, "none", i)) {
      chosen = preferred;
    } else {
      // Only the day's time limit stands in the way: say so, for the conflict report (§7.1 step 4).
      if (preferred !== undefined && legal(preferred)) trace.push(`S:max_minutes_blocks_d${preferred}`);
      chosen = candidates.find((o) => legal(o, "none", i));
      if (chosen !== undefined) trace.push(`S:fallback1:move_${label}->d${chosen}`);
    }
    if (chosen === undefined) {
      trace.push(`S:fallback2:${label}->E+S`);
      // Fallback 5: a flexible cross-training session is all that stands in the way (§7.1, §10.2);
      // fallback 6: locked sessions are, so the loss is reported.
      if (preferred !== undefined && legal(preferred, "flexible")) trace.push(`S:fallback5:flexible_xt_blocks_d${preferred}`);
      else if (preferred !== undefined && legal(preferred, "all")) trace.push(`S:fallback6:locked_xt_blocks_d${preferred}`);
    } else {
      taken.add(chosen);
      keyDays.push(input.weekStartDay + chosen);
    }
    qualityOffsets.push(chosen);
  }

  const easy: EasySlot[] = usable
    .filter((s) => !taken.has(s.offset))
    .map((s) =>
      s.role.startsWith("Q") || s.role === "L"
        ? { offset: s.offset, role: "E", wasQualitySlot: s.role !== "L" }
        : { ...s, wasQualitySlot: false },
    );
  if (!input.longRun && race === undefined && usable.some((s) => s.role === "L")) trace.push("S:no_LR_near_race");
  return lrOffset === undefined ? { qualityOffsets, easy, trace } : { lrOffset, qualityOffsets, easy, trace };
}

function preferredOffset(slots: readonly TemplateSlot[], i: number): number | undefined {
  const roles: SlotRole[] = i === 0 ? ["Q1"] : ["Q2", "Q2_IF_EASY_LR"];
  return slots.find((s) => roles.includes(s.role))?.offset;
}

// ── S3: easy-volume spreading (§7.1 step 6) ──────────────────────────────────────────────────────

/** Share weights per easy slot (D): recovery and "short" days take less. */
const EASY_WEIGHT: Partial<Record<SlotRole, number>> = { REC: 0.6, E_SHORT: 0.7 };
/** Drop order when easy runs would be too short: short day, then recovery day, then the latest E. */
const DROP_PRIORITY: Partial<Record<SlotRole, number>> = { E_SHORT: 0, REC: 1 };

/** Easy runs are no longer than 70% of the LR (spec 60–70%). */
export const EASY_MAX_FRACTION_OF_LR = 0.7;
export const EASY_MIN_MINUTES = 20;
export const EASY_MIN_MINUTES_BEGINNER = 15;
/** Easy format by level (§6.10): 20–75 min, beginners 20–35 min. Recovery runs 20–40 min. */
export const EASY_MAX_MINUTES = 75;
export const EASY_MAX_MINUTES_BEGINNER = 35;
export const RECOVERY_MAX_MINUTES = 40;

export interface EasySpread {
  /** km per easy slot (same order as input); 0 = slot dropped. */
  km: number[];
  /** Volume that could not be placed without breaking S3 ("needs more days"). */
  unplacedKm: number;
  trace: string[];
}

/**
 * Spread `totalKm` over the easy slots by weight, each run within [minKm, maxKm].
 * Too little volume → drop slots (lowest priority first); a run still below the minimum is raised to it.
 * Too much → fill every slot up to maxKm (water-filling) and report the rest (§7.1: "needs more days").
 */
export function spreadEasy(
  totalKm: number,
  slots: readonly TemplateSlot[],
  minKm: number,
  maxKm: number,
  /** Per-slot upper bound (e.g. recovery runs ≤ 40 min), applied on top of maxKm. */
  slotMaxKm: (slot: TemplateSlot) => number = () => Infinity,
): EasySpread {
  const trace: string[] = [];
  const active = slots.map(() => true);
  const weight = (i: number) => EASY_WEIGHT[(slots[i] as TemplateSlot).role] ?? 1;
  const total = Math.max(0, totalKm);
  const capOf = (i: number) => Math.max(minKm, Math.min(maxKm, slotMaxKm(slots[i] as TemplateSlot)));

  // Weighted shares, capped at effectiveMax; capped slots' excess flows to the others.
  const share = () => {
    const out = active.map(() => 0);
    const open = new Set(active.flatMap((on, i) => (on ? [i] : [])));
    let left = total;
    while (open.size > 0 && left > 1e-9) {
      const w = [...open].reduce((acc, i) => acc + weight(i), 0);
      let capped = false;
      for (const i of [...open]) {
        const want = (left * weight(i)) / w;
        if ((out[i] as number) + want >= capOf(i)) {
          left -= capOf(i) - (out[i] as number);
          out[i] = capOf(i);
          open.delete(i);
          capped = true;
        }
      }
      if (capped) continue;
      for (const i of open) out[i] = (out[i] as number) + (left * weight(i)) / w;
      left = 0;
    }
    return out;
  };

  if (total < minKm / 2) {
    trace.push("S3:no_easy_volume");
    return { km: slots.map(() => 0), unplacedKm: 0, trace };
  }

  let km = share();
  const dropOrder = slots
    .map((s, i) => ({ i, p: DROP_PRIORITY[s.role] ?? 2, offset: s.offset }))
    .sort((a, b) => a.p - b.p || b.offset - a.offset);
  for (const { i } of dropOrder) {
    if (active.filter(Boolean).length <= 1) break;
    if (km.every((k, j) => !active[j] || k >= minKm)) break;
    active[i] = false;
    trace.push(`S3:drop_d${(slots[i] as TemplateSlot).offset}`);
    km = share();
  }

  km = km.map((k, i) => {
    if (!active[i]) return 0;
    if (k < minKm) {
      trace.push("S3:raised_to_min");
      return minKm;
    }
    return k;
  });
  const unplaced = Math.max(0, total - km.reduce((a, b) => a + b, 0));
  if (unplaced > 0.05) trace.push(`S3:needs_more_days(${unplaced.toFixed(1)}km)`);
  return { km, unplacedKm: unplaced, trace };
}
