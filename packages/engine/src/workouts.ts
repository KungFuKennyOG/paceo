/**
 * Workout library (spec §6.10, formats D on C) and the run/walk ladder sessions (§6.9).
 * Builders return a WorkoutDraft; the scheduler (§7) gives it an id, a user and a date.
 * All distances are metres, durations seconds, paces s/km. Builders never read the clock.
 */
import type { SimpleStep, Step, Target, PlannedWorkout, WorkoutType } from "./workout.js";
import type { GoalDistance, Level, Phase } from "./plan-types.js";
import { GOAL_DISTANCE_M } from "./plan-types.js";
import { ZONE_HR_PCT_MAX, type PaceRange } from "./paces.js";
import { midPace, type PaceSet, type Prescription } from "./prescription.js";
import { ladderStage, LADDER_WALK_WARMUP_S } from "./ladder.js";
import { formatDistance } from "./units.js";
import { hrTarget, type ResolvedHr } from "./hr.js";

export type WorkoutDraft = Omit<PlannedWorkout, "id" | "user_id" | "date">;

/** Everything a builder needs to know about the week it builds for. */
export interface BuildContext {
  paces: PaceSet;
  rx: Prescription;
  level: Level;
  distance: GoalDistance;
  phase: Phase;
  /** This week's target volume (km), used by the Daniels % caps. */
  weeklyKm: number;
  /** HRmax for HR targets (hr.ts: already off for beginners without a measured HRmax). Absent = no HR targets. */
  hr?: ResolvedHr;
}

// ── Daniels caps (§6.10, C) and the low-volume floor (D) ─────────────────────────────────────────
export const CAP_T = 0.1;
export const CAP_I = 0.08;
export const CAP_R = 0.05;
export const CAP_M = 0.2;
export const CAP_M_MAX_MIN = 110;
/** Below this weekly volume a minimum 2 × 8 min T or 4 × 3 min I session is allowed (§6.10, D). */
export const LOW_VOLUME_FLOOR_KM = 30;

/** I reps 3–5 min, R reps ≤ 2 min (§6.6 rep-length rule). */
export const I_REP_WINDOW_S = { min: 180, max: 300 } as const;
export const R_REP_MAX_S = 120;
const I_REP_DISTANCES_M = [1600, 1200, 1000, 800, 600, 400] as const;
const R_REP_DISTANCES_M = [400, 300, 200] as const;

type Zone = "E" | "REC" | "LR" | "M" | "T" | "I" | "R" | "GP" | "HM" | "HILL" | "ALLOUT";

const RPE: Record<Zone, string> = {
  E: "3-4",
  REC: "2",
  LR: "3-4",
  M: "5",
  T: "6-7",
  I: "8-9",
  R: "9",
  GP: "7-8",
  HM: "6-7",
  HILL: "8",
  ALLOUT: "9-10",
};

function gpRpe(distance: GoalDistance): string {
  return { "5k": "8-9", "10k": "8", half: "6-7", marathon: "5" }[distance];
}

/** Which PaceSet range each zone uses. Hills and all-out efforts are RPE-only on the watch. */
const ZONE_PACE: Record<Zone, keyof Omit<PaceSet, "vdot" | "source" | "hasGoalTime">> = {
  E: "E",
  REC: "REC",
  LR: "LR",
  M: "M",
  T: "T",
  I: "I",
  HILL: "I",
  R: "R",
  GP: "GP",
  HM: "HM",
  ALLOUT: "GP",
};

function zonePace(p: PaceSet, zone: Zone): PaceRange {
  return p[ZONE_PACE[zone]];
}

/** %HRmax fallback per zone (§3.8, §4.1). Zones without a band get no fallback. */
const ZONE_HR: Partial<Record<Zone, { lo: number; hi: number }>> = {
  E: ZONE_HR_PCT_MAX.E,
  LR: ZONE_HR_PCT_MAX.E,
  REC: ZONE_HR_PCT_MAX.E,
  M: ZONE_HR_PCT_MAX.M,
  T: ZONE_HR_PCT_MAX.T,
  I: ZONE_HR_PCT_MAX.I,
};

function hrFallback(zone: Zone, hr?: ResolvedHr): Target | undefined {
  const band = ZONE_HR[zone];
  return band ? hrTarget(band, hr) : undefined;
}

/** Easy, long and recovery steps carry HR as their target when the HRmax is known (§3.7, D). */
const HR_FIRST: ReadonlySet<Zone> = new Set(["E", "LR", "REC"]);

// ── step accumulation ────────────────────────────────────────────────────────────────────────────

/** A step plus its estimated running metres and seconds. */
interface Seg {
  step: Step;
  runM: number;
  s: number;
}

type Len = { s: number } | { m: number };
type SegKind = SimpleStep["kind"];

function rpeFor(ctx: BuildContext, zone: Zone): string {
  return zone === "GP" ? gpRpe(ctx.distance) : RPE[zone];
}

/** One running step at a zone. Pace targets in pace mode; RPE otherwise (§6.6 prescription table). */
function run(ctx: BuildContext, kind: SegKind, len: Len, zone: Zone, note?: string): Seg {
  const pace = midPace(zonePace(ctx.paces, zone));
  const s = "s" in len ? Math.round(len.s) : Math.round((len.m / 1000) * pace);
  const m = "m" in len ? Math.round(len.m) : Math.round((len.s / pace) * 1000);
  const rpe = rpeFor(ctx, zone);
  const usePace = ctx.rx.mode === "pace" && zone !== "HILL" && zone !== "ALLOUT";
  const range = zonePace(ctx.paces, zone);
  const target: Target = usePace
    ? { type: "pace", lo_s_per_km: round1(range.fast), hi_s_per_km: round1(range.slow) }
    : zone === "ALLOUT"
      ? { type: "open" }
      : { type: "rpe", value: rpe };
  const step: SimpleStep = {
    kind,
    duration: "s" in len ? { type: "time", s } : { type: "distance", m },
    target,
    rpe,
  };
  // §3.7 single target per step: pace for T/I/M/R (HR as the fallback); HR for easy / long steps
  // when the HRmax is known, with the pace (pace mode) as the fallback. RPE stays on the step.
  const hrFirst = ctx.hr !== undefined && HR_FIRST.has(zone);
  if (hrFirst) {
    step.target = hrTarget(ZONE_HR[zone]!, ctx.hr);
    if (usePace) step.fallback = target;
  } else {
    const fb = usePace ? hrFallback(zone, ctx.hr) : undefined;
    if (fb) step.fallback = fb;
  }
  if (note) step.note = note;
  return { step, runM: m, s };
}

/** Recovery jog between reps: open target, distance estimated at recovery pace. */
function jog(ctx: BuildContext, s: number): Seg {
  const pace = midPace(ctx.paces.REC);
  return {
    step: { kind: "recovery", duration: { type: "time", s: Math.round(s) }, target: { type: "open" } },
    runM: Math.round((s / pace) * 1000),
    s: Math.round(s),
  };
}

function walk(s: number, kind: SegKind = "walk"): Seg {
  return {
    step: { kind, duration: { type: "time", s: Math.round(s) }, target: { type: "open" }, rpe: "1-2" },
    runM: 0,
    s: Math.round(s),
  };
}

function repeat(count: number, segs: Seg[]): Seg {
  const steps = segs.map((x) => x.step as SimpleStep);
  return {
    step: { kind: "repeat", count, steps },
    runM: count * sum(segs.map((x) => x.runM)),
    s: count * sum(segs.map((x) => x.s)),
  };
}

function warmup(ctx: BuildContext): Seg {
  const min = ctx.level === "beginner" || ctx.level === "novice" ? 10 : 15;
  return run(ctx, "warmup", { s: min * 60 }, "E");
}

function cooldown(ctx: BuildContext): Seg {
  return run(ctx, "cooldown", { s: 10 * 60 }, "E");
}

interface DraftMeta {
  type: WorkoutType;
  name: string;
  srpe: number;
  key: boolean;
  trace: string[];
  mode?: PlannedWorkout["prescription_mode"];
}

function draft(ctx: BuildContext, segs: Seg[], meta: DraftMeta): WorkoutDraft {
  return {
    sport: "run",
    type: meta.type,
    name: meta.name,
    phase: ctx.phase,
    prescription_mode: meta.mode ?? (ctx.rx.mode === "pace" ? "pace" : "time_rpe"),
    steps: segs.map((x) => x.step),
    planned: {
      run_m: Math.round(sum(segs.map((x) => x.runM))),
      minutes: round1(sum(segs.map((x) => x.s)) / 60),
      expected_srpe: meta.srpe,
    },
    flags: { heat_adjusted: false, key_session: meta.key },
    rule_trace: meta.trace,
  };
}

// ── easy, recovery, strides ──────────────────────────────────────────────────────────────────────

export const STRIDE_S = 20;
const STRIDE_RECOVERY_S = 60;

/** 4–8 × 20 s relaxed ≈ R, after an easy run (§6.10). Not a quality session. */
function strides(ctx: BuildContext, count: number): Seg {
  return repeat(count, [run(ctx, "work", { s: STRIDE_S }, "R", "relaxed, fast"), jog(ctx, STRIDE_RECOVERY_S)]);
}

/** Running km of `count` strides with their recovery jogs. */
export function stridesKm(ctx: BuildContext, count: number): number {
  return count > 0 ? strides(ctx, count).runM / 1000 : 0;
}

/** Strides progression 4 → 8 over the plan (§6.10): +1 every 2 weeks (D). */
export function strideCount(weekIndex: number): number {
  return Math.min(8, 4 + Math.floor((weekIndex - 1) / 2));
}

export interface EasyOptions {
  strides?: number;
  recovery?: boolean;
  /** Pre-race shake-out. */
  shakeout?: boolean;
  trace?: string[];
}

/** Easy (or recovery) run of about `km`; minutes in time mode, km otherwise (§6.6 prescription table). */
export function easyRun(ctx: BuildContext, km: number, opts: EasyOptions = {}): WorkoutDraft {
  const zone: Zone = opts.recovery ? "REC" : "E";
  const byTime = ctx.rx.easyBy === "time";
  // Floor, so the run never exceeds the km the caller cleared against V1.
  const main = byTime
    ? run(ctx, "run", { s: Math.max(1, Math.floor((km * midPace(zonePace(ctx.paces, zone))) / 60 + 1e-6)) * 60 }, zone)
    : run(ctx, "run", { m: Math.max(100, Math.floor(km * 10 + 1e-6) * 100) }, zone);
  const segs = [main];
  if (opts.strides && opts.strides > 0) segs.push(strides(ctx, opts.strides));
  const size = byTime ? `${Math.round(main.s / 60)} min` : formatDistance(main.runM);
  const label = opts.shakeout ? "Shake-out" : opts.recovery ? "Recovery" : "Easy";
  const name = `${label} ${size}${opts.strides ? ` + ${opts.strides} × ${STRIDE_S} s strides` : ""}`;
  return draft(ctx, segs, {
    type: opts.strides ? "S" : "E",
    name,
    srpe: opts.recovery || opts.shakeout ? 2 : 3,
    key: false,
    trace: [...(opts.trace ?? []), opts.strides ? "W-S" : opts.recovery ? "W-REC" : "W-E"],
  });
}

/** Easy distance (km) that a run of `minutes` covers at E pace. */
export function easyKmForMinutes(paces: PaceSet, minutes: number): number {
  return (minutes * 60) / midPace(paces.E);
}

// ── long run (§6.6) ──────────────────────────────────────────────────────────────────────────────

export type LongRunContentKind = "easy" | "fast_finish" | "m_segment";

/** Fast finish: last 20% (spec 15–25%) at M (marathon) or HM pace (§6.10). */
export const FAST_FINISH_FRACTION = 0.2;
/** M segment inside the LR: start at 20 min of M, +1.5 km per exposure (D on C, §6.10 M/GP row). */
const M_START_MIN = 20;
const M_STEP_KM = 1.5;

export interface LongRunOptions {
  content: LongRunContentKind;
  /** Prior M-segment exposures, for the +1–2 km progression. */
  mExposures?: number;
  trace?: string[];
}

/** M block size (km) for the n-th exposure, under the M caps (≤ 20% weekly and ≤ 110 min). */
export function mBlockKm(ctx: BuildContext, exposures: number): { km: number; trace: string[] } {
  const mPace = midPace(ctx.paces.M);
  const wanted = (M_START_MIN * 60) / mPace + M_STEP_KM * exposures;
  const capPct = CAP_M * ctx.weeklyKm;
  const capTime = (CAP_M_MAX_MIN * 60) / mPace;
  const floor = (M_START_MIN * 60) / mPace; // < 20 min of M is not a quality session (§6.4)
  let km = Math.min(wanted, capPct, capTime);
  const trace = [`W-M:${round1(wanted)}km`];
  if (km < wanted) trace.push(capPct <= capTime ? "CAP:M<20%" : "CAP:M<=110min");
  if (km < floor) {
    km = floor;
    trace.push("CAP:M:floor20min");
  }
  return { km, trace };
}

export function longRun(ctx: BuildContext, km: number, opts: LongRunOptions): WorkoutDraft {
  const byTime = ctx.rx.longBy === "time";
  const trace = [...(opts.trace ?? []), `L3:${opts.content}`];
  const totalKm = Math.floor(km * 10 + 1e-6) / 10; // whole 100 m, never above the cleared km
  // Segment lengths in whole 100 m; the first (LR-pace) segment takes the remainder so parts sum to totalKm.
  const split = (rest: Array<[number, Zone, SegKind]>): Seg[] => {
    const tail = rest.map(([k, z, kind]): [number, Zone, SegKind] => [Math.round(k * 10) / 10, z, kind]);
    const first = totalKm - tail.reduce((a, [k]) => a + k, 0);
    const all: Array<[number, Zone, SegKind]> = [[first, "LR", "run"], ...tail];
    return all.map(([k, z, kind]) =>
      byTime
        ? run(ctx, kind, { s: Math.max(60, Math.floor((k * midPace(zonePace(ctx.paces, z))) / 60 + 1e-6) * 60) }, z)
        : run(ctx, kind, { m: Math.round(k * 10) * 100 }, z),
    );
  };

  let segs: Seg[];
  let name: string;
  if (opts.content === "easy") {
    segs = split([]);
    const main = segs[0] as Seg;
    name = `Long run ${byTime ? `${Math.round(main.s / 60)} min` : formatDistance(main.runM)}`;
  } else if (opts.content === "fast_finish") {
    const fastZone: Zone = ctx.distance === "marathon" ? "M" : "HM";
    const fast = Math.round(totalKm * FAST_FINISH_FRACTION * 10) / 10;
    segs = split([[fast, fastZone, "work"]]);
    name = `Long run ${formatDistance(totalKm * 1000)}, last ${formatDistance(fast * 1000)} at ${fastZone} pace`;
  } else {
    const m = mBlockKm(ctx, opts.mExposures ?? 0);
    const mKm = Math.round(Math.min(m.km, 0.6 * totalKm) * 10) / 10;
    const tail = Math.round(Math.min(1.5, 0.1 * totalKm) * 10) / 10;
    segs = split([[mKm, "M", "work"], [tail, "E", "cooldown"]]);
    trace.push(...m.trace);
    name = `Long run ${formatDistance(totalKm * 1000)} with ${formatDistance(mKm * 1000)} at M`;
  }
  return draft(ctx, segs, {
    type: "L",
    name,
    srpe: opts.content === "easy" ? 4 : 6,
    key: true,
    trace,
  });
}

// ── threshold ────────────────────────────────────────────────────────────────────────────────────

/** T minutes before caps: start by level, +5 min every 2 exposures (§6.10 "+5 min per 1–2 wk"). */
const T_START_MIN: Record<Level, number> = { beginner: 12, novice: 16, intermediate: 20, advanced: 24 };
const T_MAX_MIN: Record<Level, number> = { beginner: 12, novice: 24, intermediate: 32, advanced: 40 };

export interface QualityOptions {
  /** Prior sessions of this kind (progression). */
  exposures: number;
  /** 1 normally; 0.65 in cutback weeks (§6.7); 0.6 in the taper (§6.8 T3). */
  workFactor: number;
  trace?: string[];
}

function factorTrace(f: number): string[] {
  return f < 1 ? [`Q:work×${f}`] : [];
}

/** Minutes of work allowed by a %-of-weekly cap at a pace. */
function capMinutes(weeklyKm: number, pct: number, paceS: number): number {
  return (pct * weeklyKm * paceS) / 60;
}

export function thresholdRun(ctx: BuildContext, o: QualityOptions): WorkoutDraft {
  const tPace = midPace(ctx.paces.T);
  const trace = [...(o.trace ?? [])];
  let min = Math.min(T_MAX_MIN[ctx.level], T_START_MIN[ctx.level] + 5 * Math.floor(o.exposures / 2));
  const cap = capMinutes(ctx.weeklyKm, CAP_T, tPace);
  if (min > cap) {
    min = cap;
    trace.push("CAP:T<=10%");
  }
  if (ctx.weeklyKm < LOW_VOLUME_FLOOR_KM && min < 16 && ctx.level !== "beginner") {
    min = 16;
    trace.push("CAP:T:low_volume_floor");
  }
  min *= o.workFactor;
  trace.push(...factorTrace(o.workFactor));

  let work: Seg[];
  let label: string;
  if (ctx.level === "beginner") {
    // One short T/fartlek by RPE after graduation (§6.4): 2–4 × 3 min, 2 min jog.
    const reps = Math.max(2, Math.round(min / 3));
    work = [repeat(reps, [run(ctx, "work", { s: 180 }, "T"), jog(ctx, 120)])];
    label = `Fartlek ${reps} × 3 min @ RPE 6-7`;
  } else if (ctx.level === "intermediate" && ctx.phase === "EQ" && min <= 30) {
    const m = Math.max(10, Math.floor(min));
    work = [run(ctx, "work", { s: m * 60 }, "T")];
    label = `Tempo ${m} min @ T`;
  } else {
    // Whole minutes, rounded down so the session never exceeds the minutes cleared above.
    const repMin = ctx.level === "novice" ? 8 : min >= 36 ? 10 : 8;
    const reps = clampInt(Math.round(min / repMin), 2, ctx.level === "novice" ? 3 : 6);
    const rep = Math.min(10, Math.max(5, Math.floor(min / reps)));
    work = [repeat(reps, [run(ctx, "work", { s: rep * 60 }, "T"), jog(ctx, 60)])];
    label = `Cruise intervals ${reps} × ${rep} min @ T`;
  }
  trace.push(`W-T:${label}`);
  return draft(ctx, [warmup(ctx), ...work, cooldown(ctx)], { type: "T", name: label, srpe: 6, key: true, trace });
}

// ── intervals (I) and repetitions (R) ────────────────────────────────────────────────────────────

/** Longest distance rep whose duration at both ends of the pace range stays in [min, max] s. */
export function pickDistanceRep(
  distances: readonly number[],
  pace: { fast: number; slow: number },
  window: { min: number; max: number },
): number | undefined {
  return distances.find((m) => (m / 1000) * pace.fast >= window.min && (m / 1000) * pace.slow <= window.max);
}

export function intervalRun(ctx: BuildContext, o: QualityOptions): WorkoutDraft {
  const iPace = midPace(ctx.paces.I);
  const trace = [...(o.trace ?? [])];
  const capKm = CAP_I * ctx.weeklyKm;
  const distRep = ctx.rx.repsBy === "rule" ? pickDistanceRep(I_REP_DISTANCES_M, ctx.paces.I, I_REP_WINDOW_S) : undefined;
  let reps = Math.min(6, 4 + Math.floor(o.exposures / 2));
  const repS = distRep ? (distRep / 1000) * iPace : Math.min(300, 180 + 60 * Math.floor(o.exposures / 4));
  const repKm = repS / iPace;
  while (reps > 4 && reps * repKm > capKm) reps--;
  if (reps * repKm > capKm) {
    if (ctx.weeklyKm < LOW_VOLUME_FLOOR_KM) trace.push("CAP:I:low_volume_floor");
    else {
      reps = Math.max(2, Math.floor(capKm / repKm));
      trace.push("CAP:I<=8%");
    }
  }
  reps = Math.max(2, Math.round(reps * o.workFactor));
  trace.push(...factorTrace(o.workFactor));
  const rec = jog(ctx, repS); // jog ≈ rep time
  const rep = distRep ? run(ctx, "work", { m: distRep }, "I") : run(ctx, "work", { s: Math.round(repS) }, "I");
  const label = distRep ? `Intervals ${reps} × ${distRep} m @ I` : `Intervals ${reps} × ${Math.round(repS / 60)} min @ I`;
  trace.push(`W-I:${distRep ? "distance" : "time"}_reps`);
  return draft(ctx, [warmup(ctx), repeat(reps, [rep, rec]), cooldown(ctx)], {
    type: "I",
    name: label,
    srpe: 7,
    key: true,
    trace,
  });
}

/** R reps ≤ 2 min: 8–12 reps (+2 per 2 exposures), full recovery 2.5 × rep time (spec 2–3×). */
export function repetitionRun(ctx: BuildContext, o: QualityOptions): WorkoutDraft {
  const rPace = midPace(ctx.paces.R);
  const trace = [...(o.trace ?? [])];
  const capKm = CAP_R * ctx.weeklyKm;
  const wanted = Math.min(12, 8 + 2 * Math.floor(o.exposures / 2));
  // Longest rep ≤ 2 min that still allows 8 reps under the 5% cap; else the shortest legal rep.
  const legal =
    ctx.rx.repsBy === "rule"
      ? R_REP_DISTANCES_M.filter((m) => (m / 1000) * ctx.paces.R.slow <= R_REP_MAX_S)
      : [];
  const distRep = legal.find((m) => (8 * m) / 1000 <= capKm) ?? legal[legal.length - 1];
  const repS = distRep ? (distRep / 1000) * rPace : 45;
  const repKm = repS / rPace;
  let reps = Math.min(wanted, Math.floor(capKm / repKm));
  if (reps < 8) trace.push("CAP:R<=5%");
  reps = Math.max(4, Math.round(reps * o.workFactor));
  trace.push(...factorTrace(o.workFactor));
  const rep = distRep ? run(ctx, "work", { m: distRep }, "R") : run(ctx, "work", { s: Math.round(repS) }, "R");
  const rec = jog(ctx, Math.round((2.5 * repS) / 15) * 15);
  const label = distRep ? `Repetitions ${reps} × ${distRep} m @ R` : `Repetitions ${reps} × ${Math.round(repS)} s @ R`;
  trace.push(`W-R:${distRep ? "distance" : "time"}_reps`);
  return draft(ctx, [warmup(ctx), repeat(reps, [rep, rec]), cooldown(ctx)], {
    type: "R",
    name: label,
    srpe: 7,
    key: true,
    trace,
  });
}

/** Hills: 6–10 × 45 s up at RPE 8, walk/jog down (beginners/novices 4–6). Counts under the I cap. */
export function hillRun(ctx: BuildContext, o: QualityOptions): WorkoutDraft {
  const low = ctx.level === "beginner" || ctx.level === "novice";
  const [start, max] = low ? [4, 6] : [6, 10];
  const repS = 45;
  const trace = [...(o.trace ?? [])];
  let reps = Math.min(max, start + 2 * Math.floor(o.exposures / 2));
  const capReps = Math.floor((CAP_I * ctx.weeklyKm) / (repS / midPace(ctx.paces.I)));
  if (capReps < reps && ctx.weeklyKm >= LOW_VOLUME_FLOOR_KM) {
    reps = Math.max(start, capReps);
    trace.push("CAP:H<=8%");
  }
  reps = Math.max(3, Math.round(reps * o.workFactor));
  trace.push(...factorTrace(o.workFactor), "W-H");
  const segs = [warmup(ctx), repeat(reps, [run(ctx, "work", { s: repS }, "HILL", "uphill, hard effort"), jog(ctx, 90)]), cooldown(ctx)];
  return draft(ctx, segs, { type: "H", name: `Hills ${reps} × ${repS} s uphill`, srpe: 7, key: true, trace });
}

// ── marathon pace and race-specific goal pace ────────────────────────────────────────────────────

export function marathonPaceRun(ctx: BuildContext, o: QualityOptions): WorkoutDraft {
  const m = mBlockKm(ctx, o.exposures);
  const km = m.km * o.workFactor;
  const trace = [...(o.trace ?? []), ...m.trace, ...factorTrace(o.workFactor)];
  const byTime = ctx.rx.repsBy === "time";
  const block = byTime
    ? run(ctx, "work", { s: Math.round((km * midPace(ctx.paces.M)) / 60) * 60 }, "M")
    : run(ctx, "work", { m: Math.round(km * 10) * 100 }, "M");
  const size = byTime ? `${Math.round(block.s / 60)} min` : formatDistance(block.runM);
  return draft(ctx, [warmup(ctx), block, cooldown(ctx)], {
    type: "M",
    name: `Marathon pace ${size} @ M`,
    srpe: 6,
    key: true,
    trace,
  });
}

/**
 * Race-specific goal-pace session (§6.10): 5K 5 × 1 km, 10K 3 × 2 km, HM 2–3 × 3–5 km.
 * Counted under the I cap (5K/10K) or the T cap (HM). Marathon GP = an M session.
 */
export function goalPaceRun(ctx: BuildContext, o: QualityOptions): WorkoutDraft {
  if (ctx.distance === "marathon") return marathonPaceRun(ctx, o);
  const spec = {
    "5k": { reps: 5, km: 1, timeS: 300, jogS: 150, cap: CAP_I },
    "10k": { reps: 3, km: 2, timeS: 600, jogS: 180, cap: CAP_I },
    half: { reps: 2, km: 3 + Math.min(2, Math.floor(o.exposures / 2)), timeS: 900, jogS: 180, cap: CAP_T },
  }[ctx.distance];
  const trace = [...(o.trace ?? [])];
  const byTime = ctx.rx.repsBy === "time";
  const gpPace = midPace(ctx.paces.GP);
  let reps = ctx.distance === "half" && o.exposures >= 2 ? 3 : spec.reps;
  let repKm = byTime ? spec.timeS / gpPace : spec.km;
  const capKm = spec.cap * ctx.weeklyKm;
  while (reps > 2 && reps * repKm > capKm) reps--;
  if (reps * repKm > capKm && ctx.weeklyKm >= LOW_VOLUME_FLOOR_KM) {
    repKm = capKm / reps;
    trace.push(spec.cap === CAP_T ? "CAP:GP<=10%" : "CAP:GP<=8%");
  }
  reps = Math.max(1, Math.round(reps * o.workFactor));
  trace.push(...factorTrace(o.workFactor), `W-GP:${ctx.distance}`);
  const rep = byTime
    ? run(ctx, "work", { s: Math.round((repKm * gpPace) / 60) * 60 }, "GP")
    : run(ctx, "work", { m: Math.round(repKm * 10) * 100 }, "GP");
  const size = byTime ? `${Math.round(rep.s / 60)} min` : formatDistance(rep.runM);
  return draft(ctx, [warmup(ctx), repeat(reps, [rep, jog(ctx, spec.jogS)]), cooldown(ctx)], {
    type: "M",
    name: `Goal pace ${reps} × ${size} @ ${raceLabel(ctx.distance)} pace`,
    srpe: 7,
    key: true,
    trace,
  });
}

// ── time trial, run/walk, race ───────────────────────────────────────────────────────────────────

/** 3K time trial (§4.2 path A): warm-up + 4 strides, 3 km all-out, cool-down. Counts as a key session. */
export function timeTrial(ctx: BuildContext, trace: string[] = []): WorkoutDraft {
  const tt = run(ctx, "work", { m: 3000 }, "ALLOUT", "3K time trial: flat route, not in heat (WBGT > 20 °C → move it)");
  return draft(ctx, [warmup(ctx), strides(ctx, 4), tt, cooldown(ctx)], {
    type: "TT",
    name: "3K time trial",
    srpe: 9,
    key: true,
    trace: [...trace, "W-TT:3k", "§4.2:A"],
  });
}

/** One run/walk ladder session (§6.9): 5 min walk + block + 5 min walk, runs at RPE 3–4. */
export function ladderSession(
  ctx: BuildContext,
  stage: number,
  trace: string[] = [],
  walkWarmCoolS: number = LADDER_WALK_WARMUP_S,
): WorkoutDraft {
  const s = ladderStage(stage);
  const runSeg = run({ ...ctx, rx: { ...ctx.rx, mode: "time_rpe" } }, "run", { s: s.runS }, "E", "talk-test pace");
  const block = s.walkS > 0 ? repeat(s.reps, [runSeg, walk(s.walkS)]) : runSeg;
  const segs = [walk(walkWarmCoolS, "warmup"), block, walk(walkWarmCoolS, "cooldown")];
  const name =
    s.walkS > 0
      ? `Run/walk stage ${stage}: ${s.reps} × (${fmtS(s.runS)} run / ${fmtS(s.walkS)} walk)`
      : `Run/walk stage ${stage}: ${s.runS / 60} min continuous`;
  return draft(ctx, segs, {
    type: "RW",
    name,
    srpe: 3,
    key: false,
    trace: [...trace, `§6.9:stage${stage}`],
    mode: "run_walk",
  });
}

export function raceDay(ctx: BuildContext, goalTimeS: number | undefined, predictedS: number): WorkoutDraft {
  const m = GOAL_DISTANCE_M[ctx.distance];
  const useGoal = ctx.rx.mode === "pace" && (ctx.paces.hasGoalTime || ctx.paces.source === "vdot");
  const step: SimpleStep = useGoal
    ? {
        kind: "work",
        duration: { type: "distance", m },
        target: { type: "pace", lo_s_per_km: round1(ctx.paces.GP.fast), hi_s_per_km: round1(ctx.paces.GP.slow) },
      }
    : { kind: "work", duration: { type: "distance", m }, target: { type: "rpe", value: gpRpe(ctx.distance) } };
  const s = goalTimeS ?? predictedS;
  return {
    sport: "run",
    type: "RACE",
    name: `Race: ${raceLabel(ctx.distance)}`,
    phase: ctx.phase,
    prescription_mode: useGoal ? "pace" : "time_rpe",
    steps: [step],
    planned: { run_m: Math.round(m), minutes: round1(s / 60), expected_srpe: 9 },
    flags: { heat_adjusted: false, key_session: true },
    rule_trace: ["RACE", goalTimeS !== undefined ? "RACE:goal_time" : "RACE:predicted"],
  };
}

export function raceLabel(d: GoalDistance): string {
  return { "5k": "5K", "10k": "10K", half: "Half marathon", marathon: "Marathon" }[d];
}

// ── V1 fitting ───────────────────────────────────────────────────────────────────────────────────

/** Warm-up / cool-down never shrink below this (D). */
export const MIN_WARM_COOL_S = 300;

/**
 * Shorten time-based warm-up and cool-down steps so the session fits a V1 limit (§6.5).
 * Returns undefined if the session still doesn't fit; the caller then converts it to an easy run.
 */
export function fitWarmCool(ctx: BuildContext, d: WorkoutDraft, maxKm: number, maxMin: number): WorkoutDraft | undefined {
  const ePace = midPace(ctx.paces.E);
  let excessKm = d.planned.run_m / 1000 - maxKm;
  let excessS = d.planned.minutes * 60 - maxMin * 60;
  if (excessKm <= 1e-9 && excessS <= 1e-9) return d;
  const steps: Step[] = d.steps.map((st: Step) => ({ ...st }));
  let removedS = 0;
  for (const st of steps) {
    if (st.kind !== "warmup" && st.kind !== "cooldown") continue;
    if (st.duration.type !== "time") continue;
    const needS = Math.max(excessKm * ePace, excessS, 0);
    const cut = Math.min(st.duration.s - MIN_WARM_COOL_S, Math.ceil(needS / 60) * 60);
    if (cut <= 0) continue;
    st.duration = { type: "time", s: st.duration.s - cut };
    removedS += cut;
    excessKm -= cut / ePace;
    excessS -= cut;
  }
  if (excessKm > 1e-9 || excessS > 1e-9) return undefined;
  return {
    ...d,
    steps,
    planned: {
      ...d.planned,
      run_m: Math.round(d.planned.run_m - (removedS / ePace) * 1000),
      minutes: round1(d.planned.minutes - removedS / 60),
    },
    rule_trace: [...d.rule_trace, "V1:trimmed_warm_cool"],
  };
}

// ── small helpers ────────────────────────────────────────────────────────────────────────────────

function sum(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0);
}

function round1(x: number): number {
  return Math.round(x * 10) / 10;
}

function clampInt(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, Math.round(x)));
}

function fmtS(s: number): string {
  return s % 60 === 0 ? `${s / 60}:00` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
