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
 * TODO(§7.1 step 4): respect max_session_minutes_by_day.
 */

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

export interface TemplateOptions {
  ladder?: boolean;
  noConsecutiveDays?: boolean;
  /** Offset of the long-run weekday inside the plan week; default 6 (unrotated). */
  lrOffset?: number;
  /** General-fitness mode: the 2-day row is E + L (§7.2). */
  generalFitness?: boolean;
}

/**
 * Template for a week, rotated to the long-run day and sorted by offset. Beginners in their first
 * 4 weeks get no consecutive run days (§7.1), which over a repeating 7-day week allows at most 3 runs:
 * the 3-day row is used (D).
 */
export function weekTemplate(runDays: number, opts: TemplateOptions = {}): TemplateSlot[] {
  const days = opts.noConsecutiveDays ? Math.min(3, runDays) : runDays;
  const n = Math.min(7, Math.max(2, days));
  const t = opts.ladder ? LADDER_TEMPLATE : opts.generalFitness && n === 2 ? GENERAL_FITNESS_2_DAY : TEMPLATES[n];
  if (!t) throw new RangeError(`no template for ${runDays} run days`);
  const shift = (opts.lrOffset ?? TEMPLATE_LR_COLUMN) - TEMPLATE_LR_COLUMN;
  return t.map((s) => ({ ...s, offset: (s.offset + shift + 7) % 7 })).sort((a, b) => a.offset - b.offset);
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
    keyDays.push(input.weekStartDay + lrOffset);
  }
  if (race !== undefined) keyDays.push(input.weekStartDay + race);

  const blocked = input.qualityBlockedDays ?? new Set<number>();
  const flexible = input.flexibleBlockedDays ?? new Set<number>();
  /** `ignore`: which cross-training blocks to disregard (only used to explain a conversion). */
  const legal = (offset: number, ignore: "none" | "flexible" | "all" = "none") => {
    const day = input.weekStartDay + offset;
    if (taken.has(offset)) return false;
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
    if (preferred !== undefined && legal(preferred)) {
      chosen = preferred;
    } else {
      chosen = candidates.find((o) => legal(o));
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
