/**
 * Rule FIT-UPDATE (spec §4.10, D): when fitness evidence changes VDOT.
 *
 * Evidence hierarchy: race > TT > CS fit > HR–pace trend > Uth ratio. Races and TTs act at once
 * when they raise VDOT; everything training-derived is a PROPOSAL the user must accept, needs ≥ 3
 * qualifying runs over ≥ 14 days and a gap of ≥ 1 step in pace terms. Decreases trigger more easily
 * than increases but are never applied automatically (except a TT replacing an estimated VDOT).
 *
 * Step size is defined in pace: one step = the VDOT change that moves T pace by 1.2% (≈ +0.4 VDOT
 * at 25, +0.5 at 34, +0.75 at 50, +0.9 at 60), computed from the §4.1 equations.
 */
import type { Activity } from "./activity.js";
import { cleanSamples, excludedForHeat, heatPenaltyPct, hrSpeedFit, steadyWindows, type UthCheck } from "./analysis.js";
import { addDays, daysBetween } from "./dates.js";
import { ZONE_FRACTIONS } from "./paces.js";
import type { Level, VdotStatus } from "./plan-types.js";
import type { FitnessChange, FitnessState, Proposal, ReplanChange } from "./replan-types.js";
import { computeVdot, DISTANCES_M, paceAtFraction, velocityAtFraction, vo2AtVelocity, VdotRangeError, VDOT_MAX, VDOT_MIN } from "./vdot.js";

export const FITNESS_STEP_PACE_PCT = 1.2;
/** Training-fitness EWMA time constant (§13: 21–28 d). */
export const FITNESS_EWMA_TAU_DAYS = 21;
export const MIN_QUALIFYING_RUNS = 3;
export const MIN_QUALIFYING_SPAN_DAYS = 14;
/** +2 steps per 2–3 weeks at most (§13). */
export const RAISE_CAP_STEPS = 2;
export const RAISE_CAP_WINDOW_DAYS = 21;
/** Freeze after any change (Runna "Monitoring", §8 R-PERF 6). */
export const FREEZE_DAYS = 14;
/** Race/TT ≥ 2 steps below current → prompt (never auto-drop). */
export const RACE_DROP_PROMPT_STEPS = 2;
/** EWMA ≤ current − 4 steps for ≥ 3 weeks → prompt a downgrade. */
export const EWMA_DROP_STEPS = 4;
export const EWMA_DROP_WEEKS = 3;
/** Final 4–6 weeks: goal/M pace never changes from HR data alone. 6 weeks (D). */
export const HR_FREEZE_BEFORE_RACE_DAYS = 42;
/** First 7 days after a break or illness: HR runs high (Mujika & Padilla). */
export const HR_IGNORE_AFTER_BREAK_DAYS = 7;
/** Race distances within ±3% snap to the official distance (GPS reads long on courses, D). */
export const DISTANCE_SNAP = 0.03;
/** Elevation gain above this (m per km) "explains" a slow result and blocks R-PERF use (D). */
export const HILLY_M_PER_KM = 15;

const T_FRACTION = ZONE_FRACTIONS.T.fast;

/** T pace (s/km) at a VDOT. */
function tPace(vdot: number): number {
  return paceAtFraction(vdot, T_FRACTION);
}

/** % change in T pace from `from` to `to`; positive = faster. */
export function tPacePctChange(fromVdot: number, toVdot: number): number {
  return ((tPace(fromVdot) - tPace(toVdot)) / tPace(fromVdot)) * 100;
}

/** VDOT change (> 0) that makes T pace 1.2% faster at this VDOT. */
export function fitnessStepVdot(vdot: number): number {
  let lo = 0;
  let hi = 5;
  const target = tPace(vdot) * (1 - FITNESS_STEP_PACE_PCT / 100);
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (tPace(vdot + mid) > target) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** Fitness steps between two VDOTs, measured in pace (positive = faster). */
export function stepsBetween(fromVdot: number, toVdot: number): number {
  return tPacePctChange(fromVdot, toVdot) / FITNESS_STEP_PACE_PCT;
}

/** VDOT whose T velocity is `factor` × the T velocity at `vdot` (R-BREAK detraining, §8). */
export function vdotForVelocityFactor(vdot: number, factor: number): number {
  const target = velocityAtFraction(vdot, T_FRACTION) * factor;
  let lo = VDOT_MIN;
  let hi = VDOT_MAX;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (velocityAtFraction(mid, T_FRACTION) < target) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** VDOT after `steps` fitness steps (negative = down), applied one step at a time. */
export function vdotAfterSteps(vdot: number, steps: number): number {
  let v = vdot;
  const n = Math.round(Math.abs(steps));
  for (let i = 0; i < n; i++) v = steps > 0 ? v + fitnessStepVdot(v) : vdotForVelocityFactorDown(v);
  return v;
}

/** One step down: the VDOT whose T pace is 1.2% slower (T velocity × 1/1.012). */
function vdotForVelocityFactorDown(vdot: number): number {
  return vdotForVelocityFactor(vdot, 1 / (1 + FITNESS_STEP_PACE_PCT / 100));
}

// ── race / TT evidence ───────────────────────────────────────────────────────────────────────────

const SNAP_DISTANCES_M = [DISTANCES_M.mile, 3000, 5000, 10000, DISTANCES_M.half, DISTANCES_M.marathon];

export function snapRaceDistance(distanceM: number): number {
  for (const d of SNAP_DISTANCES_M) if (Math.abs(distanceM - d) <= DISTANCE_SNAP * d) return d;
  return distanceM;
}

export interface PerformanceEvidence {
  kind: "race" | "tt";
  activityId: string;
  date: string;
  distanceM: number;
  /** Heat-normalized time, s. */
  timeS: number;
  rawTimeS: number;
  vdot?: number;
  /** Not usable at all (heat > 20 °C WBGT, out of model range, bad GPS). */
  excluded?: string;
  /** Usable for raises, but a slow result is explained (illness, hilly course). */
  explained?: string;
}

export interface TtPiece {
  distanceM: number;
  timeS: number;
}

/**
 * Race or TT evidence for one activity. `ttPiece` is the all-out part of a structured TT (from the
 * work-step lap) when known; otherwise the whole activity is used.
 */
export function performanceEvidence(
  a: Activity,
  kind: "race" | "tt",
  opts: { currentVdot?: number; ttPiece?: TtPiece; illnessWithin7d?: boolean } = {},
): PerformanceEvidence {
  const piece = opts.ttPiece ?? { distanceM: a.distanceM, timeS: a.movingS };
  const distanceM = snapRaceDistance(piece.distanceM);
  const base = { kind, activityId: a.id, date: a.date, distanceM, rawTimeS: piece.timeS };
  if (excludedForHeat(a.wbgtC)) return { ...base, timeS: piece.timeS, excluded: `heat(WBGT ${a.wbgtC}°C>20)` };
  if (a.gpsQuality === "poor" && kind === "tt") return { ...base, timeS: piece.timeS, excluded: "gps" };
  let rawVdot: number;
  try {
    rawVdot = computeVdot(distanceM, piece.timeS);
  } catch (err) {
    if (err instanceof VdotRangeError) return { ...base, timeS: piece.timeS, excluded: "out_of_model_range" };
    throw err;
  }
  const penalty = a.wbgtC !== undefined ? heatPenaltyPct(a.wbgtC, opts.currentVdot ?? rawVdot) : 0;
  const timeS = piece.timeS / (1 + penalty / 100);
  const ev: PerformanceEvidence = { ...base, timeS, vdot: computeVdot(distanceM, timeS) };
  const hilly = a.elevationGainM !== undefined && a.distanceM > 0 && a.elevationGainM / (a.distanceM / 1000) > HILLY_M_PER_KM;
  if (opts.illnessWithin7d) ev.explained = "illness";
  else if (hilly) ev.explained = "course";
  return ev;
}

// ── training evidence ────────────────────────────────────────────────────────────────────────────

export type TrainingEvidenceKind = "session_pace" | "cs" | "hr_pace";

export interface TrainingEvidence {
  kind: TrainingEvidenceKind;
  date: string;
  vdot: number;
  source: string;
}

/** Weight inside the EWMA by evidence rank (D): session paces (R-PERF) > CS > HR–pace. */
export const EVIDENCE_WEIGHT: Record<TrainingEvidenceKind, number> = { session_pace: 1, cs: 0.75, hr_pace: 0.5 };

/** Exponentially weighted mean of training VDOT estimates as of `asOf` (τ = 21 d), over the last 3τ. */
export function trainingEwma(evidence: readonly TrainingEvidence[], asOf: string, tau = FITNESS_EWMA_TAU_DAYS): number | undefined {
  let num = 0;
  let den = 0;
  for (const e of evidence) {
    const age = daysBetween(e.date, asOf);
    if (age < 0 || age > 3 * tau) continue;
    const w = EVIDENCE_WEIGHT[e.kind] * Math.exp(-age / tau);
    num += w * e.vdot;
    den += w;
  }
  return den > 0 ? num / den : undefined;
}

/**
 * HR–pace evidence (§4.6): steady windows → speed at HRmax ≈ vVO2max → VDOT = VO2(v). Only with a
 * MEASURED HRmax; never with the age formula. Excludes heat > 20 °C WBGT.
 */
export function hrPaceEvidence(runs: readonly Activity[], fitness: FitnessState, today: string): TrainingEvidence[] {
  if (fitness.hrMaxSource !== "measured" || fitness.hrMax === undefined) return [];
  const out: TrainingEvidence[] = [];
  for (const r of runs) {
    if (r.sport !== "run" || !r.samples || r.date > today || daysBetween(r.date, today) > 3 * FITNESS_EWMA_TAU_DAYS) continue;
    if (excludedForHeat(r.wbgtC) || r.isRace) continue;
    const clean = cleanSamples(r.samples, { hrMax: fitness.hrMax });
    const fit = hrSpeedFit(steadyWindows(clean), fitness.hrMax);
    if (!fit || fit.n < 5 || fit.r2 < 0.5) continue;
    const vdot = vo2AtVelocity(fit.vAtHrMaxMps * 60);
    if (vdot >= VDOT_MIN && vdot <= VDOT_MAX) out.push({ kind: "hr_pace", date: r.date, vdot, source: r.id });
  }
  return out;
}

// ── the decision ─────────────────────────────────────────────────────────────────────────────────

export type PerfVerdict = "faster" | "slower" | "mixed" | "insufficient";

export interface FitUpdateInput {
  fitness: FitnessState;
  today: string;
  level: Level;
  raceDate?: string;
  performances: readonly PerformanceEvidence[];
  training: readonly TrainingEvidence[];
  /** R-PERF verdict on the last 4 eligible quality sessions. */
  perf?: PerfVerdict;
  /** VDOT implied by the CS fit, for the cross-check. */
  csVdot?: number;
  uth?: UthCheck;
  /** HR-derived evidence dated before this is ignored (7 days after a break/illness). */
  hrIgnoreUntil?: string;
}

export interface FitUpdateResult {
  fitness: FitnessState;
  applied: FitnessChange[];
  proposals: Proposal[];
  changes: ReplanChange[];
  trace: string[];
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

function trusted(status: VdotStatus): boolean {
  return status === "race" || status === "tt";
}

function applyChange(f: FitnessState, c: FitnessChange, anchorM?: number): FitnessState {
  const next: FitnessState = { ...f, vdot: c.toVdot, status: c.status, history: [...f.history, c] };
  if (anchorM !== undefined) next.anchorM = anchorM;
  return next;
}

/** FIT-UPDATE on the evidence available today. Pure; returns the new state and any proposals. */
export function fitnessUpdate(inp: FitUpdateInput): FitUpdateResult {
  let f: FitnessState = { ...inp.fitness, history: [...inp.fitness.history] };
  const applied: FitnessChange[] = [];
  const proposals: Proposal[] = [];
  const changes: ReplanChange[] = [];
  const trace: string[] = [];
  const seen = new Set(f.history.map((h) => h.source));

  // 1. Races and TTs (override everything below).
  const perfs = [...inp.performances].filter((p) => p.date <= inp.today && !seen.has(p.activityId)).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.activityId < b.activityId ? -1 : 1));
  let raceOverride = false;
  for (const p of perfs) {
    const label = p.kind === "race" ? "Race" : "Time trial";
    if (p.excluded || p.vdot === undefined) {
      trace.push(`FIT-UPDATE:${p.kind}_excluded(${p.excluded ?? "no_vdot"})`);
      if (daysBetween(p.date, inp.today) <= 7) changes.push({ rule: "FIT-UPDATE", date: p.date, message: `${label} on ${p.date} not used for fitness: ${describeExclusion(p.excluded)}.` });
      continue;
    }
    if (p.kind === "race" && inp.level === "beginner") {
      trace.push("FIT-UPDATE:beginner_tt_only");
      changes.push({ rule: "FIT-UPDATE", date: p.date, message: `Nice race! In beginner mode only a time trial sets your paces, so they stay as they are.` });
      continue;
    }
    const cur = f.vdot;
    const status: VdotStatus = p.kind === "race" ? "race" : "tt";
    const change = (reason: string): void => {
      const c: FitnessChange = { date: p.date, toVdot: round2(p.vdot as number), status, rule: `FIT-UPDATE:${p.kind}`, source: p.activityId, reason };
      if (cur !== undefined) c.fromVdot = cur;
      f = applyChange(f, c, p.distanceM);
      applied.push(c);
      raceOverride = true;
      trace.push(`FIT-UPDATE:${p.kind}(${cur === undefined ? "none" : cur.toFixed(1)}->${(p.vdot as number).toFixed(1)})`);
    };
    if (cur === undefined || !trusted(f.status)) {
      change(cur === undefined ? "first race/TT result" : "replaces an estimated VDOT");
      changes.push({ rule: "FIT-UPDATE", date: p.date, message: `${label} on ${p.date} set your fitness to VDOT ${(p.vdot as number).toFixed(1)}; paces now come from it.` });
      continue;
    }
    if (p.vdot > cur) {
      change("faster than current fitness");
      changes.push({ rule: "FIT-UPDATE", date: p.date, message: `${label} on ${p.date} was faster than your current fitness: VDOT ${cur.toFixed(1)} → ${(p.vdot).toFixed(1)}, paces updated from today.` });
      continue;
    }
    const steps = -stepsBetween(cur, p.vdot);
    if (steps >= RACE_DROP_PROMPT_STEPS) {
      if (p.explained) {
        trace.push(`FIT-UPDATE:${p.kind}_slow_explained(${p.explained})`);
        changes.push({ rule: "FIT-UPDATE", date: p.date, message: `${label} on ${p.date} was slower than your fitness suggests, explained by ${p.explained === "course" ? "a hilly course" : "recent illness"}; paces unchanged.` });
        continue;
      }
      const id = `vdot:${p.kind}:${p.activityId}`;
      proposals.push({
        id,
        kind: "vdot_change",
        rule: "FIT-UPDATE",
        fromVdot: cur,
        toVdot: round2(p.vdot),
        steps: -Math.round(steps * 10) / 10,
        pacePct: round2(tPacePctChange(cur, p.vdot)),
        evidence: [p.activityId],
        message: `${label} on ${p.date} suggests VDOT ${p.vdot.toFixed(1)}, ${steps.toFixed(1)} steps below ${cur.toFixed(1)}. Lower your paces to match? (Not applied unless you accept.)`,
      });
      trace.push(`FIT-UPDATE:${p.kind}_drop_prompt(${steps.toFixed(1)}steps)`);
      continue;
    }
    trace.push(`FIT-UPDATE:${p.kind}_consistent`);
  }
  if (raceOverride) {
    trace.push("FIT-UPDATE:race_overrides_training");
    return { fitness: f, applied, proposals, changes, trace };
  }
  for (const p of inp.performances) {
    if (!p.excluded && p.date <= inp.today && daysBetween(p.date, inp.today) < FREEZE_DAYS && p.vdot !== undefined) raceOverride = true;
  }
  if (raceOverride) {
    trace.push("FIT-UPDATE:recent_race_or_tt");
    return { fitness: f, applied, proposals, changes, trace };
  }

  // 2. Training-derived evidence: proposals only.
  const cur = f.vdot;
  if (cur === undefined || !trusted(f.status)) {
    trace.push(`FIT-UPDATE:training_blocked(${f.status})`);
    return { fitness: f, applied, proposals, changes, trace };
  }
  if (inp.level === "beginner") {
    trace.push("FIT-UPDATE:beginner_tt_only");
    return { fitness: f, applied, proposals, changes, trace };
  }
  const lastChange = f.history[f.history.length - 1];
  if (lastChange && daysBetween(lastChange.date, inp.today) < FREEZE_DAYS) {
    trace.push(`FIT-UPDATE:freeze_until(${addDays(lastChange.date, FREEZE_DAYS)})`);
    return { fitness: f, applied, proposals, changes, trace };
  }
  const nearRace = inp.raceDate !== undefined && daysBetween(inp.today, inp.raceDate) <= HR_FREEZE_BEFORE_RACE_DAYS;
  const usable = inp.training.filter((e) => {
    if (e.date > inp.today) return false;
    if (e.kind === "hr_pace" && inp.hrIgnoreUntil !== undefined && e.date < inp.hrIgnoreUntil) return false;
    return true;
  });
  const nonHr = usable.filter((e) => e.kind !== "hr_pace");
  // Final 6 weeks: never from HR data alone.
  const pool = nearRace && nonHr.length === 0 ? [] : usable;
  if (nearRace && nonHr.length === 0 && usable.length > 0) trace.push("FIT-UPDATE:hr_only_near_race");
  const recent = pool.filter((e) => daysBetween(e.date, inp.today) <= 2 * FITNESS_EWMA_TAU_DAYS);
  const ewma = trainingEwma(pool, inp.today);
  const step = fitnessStepVdot(cur);
  const dates = [...new Set(recent.map((e) => e.date))].sort();
  const span = dates.length > 1 ? daysBetween(dates[0]!, dates[dates.length - 1]!) : 0;
  const qualifies = recent.length >= MIN_QUALIFYING_RUNS && span >= MIN_QUALIFYING_SPAN_DAYS;
  const lastEvidence = dates[dates.length - 1] ?? inp.today;
  if (ewma !== undefined) trace.push(`FIT-UPDATE:ewma(${ewma.toFixed(2)},gap=${tPacePctChange(cur, ewma).toFixed(1)}%)`);

  // Slower first: decreases trigger more easily (asymmetry, §8 R-PERF 4).
  if (inp.perf === "slower") {
    const to = round2(vdotForVelocityFactorDown(cur));
    proposals.push({
      id: `vdot:-1:${lastEvidence}`,
      kind: "vdot_change",
      rule: "R-PERF",
      fromVdot: cur,
      toVdot: to,
      steps: -1,
      pacePct: round2(tPacePctChange(cur, to)),
      evidence: recent.map((e) => e.source),
      message: `Recent quality sessions were slower than target or felt much harder than expected. Check sleep, heat and how you feel first; if that isn't it, slow your paces by about ${FITNESS_STEP_PACE_PCT}% (VDOT ${cur.toFixed(1)} → ${to.toFixed(1)})?`,
    });
    trace.push("R-PERF:slower(-1)");
    return { fitness: f, applied, proposals, changes, trace };
  }
  if (ewma !== undefined && -stepsBetween(cur, ewma) >= EWMA_DROP_STEPS) {
    const earlier = trainingEwma(pool, addDays(inp.today, -7 * EWMA_DROP_WEEKS));
    if (earlier !== undefined && -stepsBetween(cur, earlier) >= EWMA_DROP_STEPS) {
      const to = round2(ewma);
      proposals.push({
        id: `vdot:ewma_down:${lastEvidence}`,
        kind: "vdot_change",
        rule: "FIT-UPDATE",
        fromVdot: cur,
        toVdot: to,
        steps: -Math.round(-stepsBetween(cur, ewma) * 10) / 10,
        pacePct: round2(tPacePctChange(cur, to)),
        evidence: recent.map((e) => e.source),
        message: `For 3 weeks your training has pointed to lower fitness (about VDOT ${to.toFixed(1)}). Lower your paces to match?`,
      });
      trace.push("FIT-UPDATE:ewma_down");
      return { fitness: f, applied, proposals, changes, trace };
    }
  }

  // Faster: ≥ 3 qualifying runs over ≥ 14 d, EWMA ≥ +1 step in pace, R-PERF not contradicting.
  if (inp.perf === "mixed") {
    trace.push("R-PERF:mixed");
    return { fitness: f, applied, proposals, changes, trace };
  }
  const sessionDriven = recent.some((e) => e.kind === "session_pace");
  if (ewma === undefined || !qualifies || stepsBetween(cur, ewma) < 1) {
    trace.push(`FIT-UPDATE:no_raise(runs=${recent.length},span=${span}d)`);
    return { fitness: f, applied, proposals, changes, trace };
  }
  if (sessionDriven && inp.perf !== "faster") {
    trace.push("FIT-UPDATE:no_raise(R-PERF_not_faster)");
    return { fitness: f, applied, proposals, changes, trace };
  }
  const raisedRecently = f.history
    .filter((h) => daysBetween(h.date, inp.today) < RAISE_CAP_WINDOW_DAYS && h.fromVdot !== undefined && h.toVdot > h.fromVdot)
    .reduce((a, h) => a + stepsBetween(h.fromVdot as number, h.toVdot), 0);
  if (raisedRecently + 1 > RAISE_CAP_STEPS + 1e-6) {
    trace.push("FIT-UPDATE:raise_cap");
    return { fitness: f, applied, proposals, changes, trace };
  }
  const to = round2(cur + step);
  if (inp.csVdot !== undefined && inp.csVdot < to - 2 * fitnessStepVdot(to)) {
    trace.push(`FIT-UPDATE:cs_disagrees(${inp.csVdot.toFixed(1)})`);
    return { fitness: f, applied, proposals, changes, trace };
  }
  if (inp.uth !== undefined && to > inp.uth.cap) {
    trace.push(`FIT-UPDATE:uth_cap(${inp.uth.cap.toFixed(1)})`);
    return { fitness: f, applied, proposals, changes, trace };
  }
  proposals.push({
    id: `vdot:+1:${lastEvidence}`,
    kind: "vdot_change",
    rule: sessionDriven ? "R-PERF" : "FIT-UPDATE",
    fromVdot: cur,
    toVdot: to,
    steps: 1,
    pacePct: round2(tPacePctChange(cur, to)),
    evidence: recent.map((e) => e.source),
    message: `Your last ${recent.length} quality sessions over ${span} days were consistently faster than target at the expected effort. Speed up your paces by about ${FITNESS_STEP_PACE_PCT}% (VDOT ${cur.toFixed(1)} → ${to.toFixed(1)})?`,
  });
  trace.push(`FIT-UPDATE:raise_proposal(+1step)`);
  return { fitness: f, applied, proposals, changes, trace };
}

/** Apply an accepted vdot_change proposal. */
export function acceptVdotProposal(f: FitnessState, p: Extract<Proposal, { kind: "vdot_change" }>, date: string): { fitness: FitnessState; change: FitnessChange } {
  const change: FitnessChange = {
    date,
    fromVdot: p.fromVdot,
    toVdot: p.toVdot,
    status: f.status,
    rule: p.rule,
    source: p.id,
    reason: "accepted by the user",
  };
  return { fitness: applyChange(f, change), change };
}

function describeExclusion(reason: string | undefined): string {
  if (!reason) return "no usable result";
  if (reason.startsWith("heat")) return "too hot (WBGT above 20 °C)";
  if (reason === "gps") return "GPS data was unreliable";
  if (reason === "out_of_model_range") return "duration outside the pace model's range";
  return reason;
}
