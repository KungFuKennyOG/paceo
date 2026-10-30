/**
 * Activity analysis (spec §4.5–4.9): sensor cleaning, grade-adjusted pace, heat, efficiency factor
 * and decoupling, best efforts, critical speed, Uth–Sørensen and HRmax.
 * Pure functions on SI inputs (m, s, m/s, bpm, °C). Nothing here changes VDOT by itself; FIT-UPDATE
 * (fitness-update.ts) decides what evidence is used.
 */
import type { Activity, ActivitySample } from "./activity.js";
import { computeVdot, DISTANCES_M, VdotRangeError } from "./vdot.js";
import { addDays } from "./dates.js";

// ── §4.9 GPS and sensor cleaning (all D) ─────────────────────────────────────────────────────────

export const GPS_MAX_SPEED_MPS = 8;
export const GPS_MAX_ACCEL_MPS2 = 4.5;
export const GPS_MAX_ACCURACY_M = 25;
/** Gaps shorter than this are interpolated; longer ones are flagged (§4.9). */
export const GAP_INTERPOLATE_MAX_S = 10;
export const SPEED_MEDIAN_WINDOW_S = 7;
export const SPEED_MEAN_WINDOW_S = 5;
/** Auto-pause: moving at ≥ 0.9 m/s; stopped after 4 s below (§4.9 0.8–1.0 m/s, 3–5 s). */
export const MOVING_SPEED_MPS = 0.9;
export const STOP_AFTER_S = 4;
export const HR_MIN_BPM = 40;
export const HR_MAX_MARGIN_BPM = 5;
/** Consecutive rejected points with a self-consistent speed → accept them as a distance offset (D). */
const REBASE_AFTER_POINTS = 3;

export interface CleanSample {
  t: number;
  distM: number;
  /** Smoothed speed (median then mean), m/s. Splits and laps never use it: they use Δdist/Δtime. */
  speedMps: number;
  altM?: number;
  hr?: number;
  tempC?: number;
  moving: boolean;
  interpolated: boolean;
}

export interface CleanResult {
  samples: CleanSample[];
  movingS: number;
  distanceM: number;
  flags: {
    droppedPoints: number;
    interpolatedS: number;
    /** Gaps ≥ 10 s, left as-is (§4.9 "flag longer ones"). */
    longGaps: Array<{ fromT: number; toT: number }>;
    hrDropped: number;
  };
}

export interface CleanOptions {
  /** HR samples above HRmax + 5 are dropped (§4.9). */
  hrMax?: number;
  /** Run/walk sessions keep walk segments as moving time (§4.9). */
  runWalk?: boolean;
}

interface RawPoint {
  t: number;
  d: number;
  altM?: number;
  hr?: number;
  tempC?: number;
  accuracyM?: number;
}

/** Cumulative distance per sample: device distance if present, else integrated speed. */
function toRawPoints(samples: readonly ActivitySample[]): { points: RawPoint[]; dropped: number } {
  const sorted = [...samples].filter((s) => Number.isFinite(s.t)).sort((a, b) => a.t - b.t);
  const points: RawPoint[] = [];
  let dropped = samples.length - sorted.length;
  let integrated = 0;
  const hasDist = sorted.some((s) => s.distM !== undefined);
  for (const s of sorted) {
    const prev = points[points.length - 1];
    if (prev && s.t <= prev.t) {
      dropped++;
      continue;
    }
    let d: number | undefined;
    if (hasDist) d = s.distM;
    else if (s.speedMps !== undefined) {
      integrated += prev ? s.speedMps * (s.t - prev.t) : 0;
      d = integrated;
    }
    if (d === undefined || !Number.isFinite(d)) {
      dropped++;
      continue;
    }
    const p: RawPoint = { t: s.t, d };
    if (s.altM !== undefined) p.altM = s.altM;
    if (s.hr !== undefined) p.hr = s.hr;
    if (s.tempC !== undefined) p.tempC = s.tempC;
    if (s.accuracyM !== undefined) p.accuracyM = s.accuracyM;
    points.push(p);
  }
  return { points, dropped };
}

/** Point rejection: implied speed > 8 m/s, |accel| > 4.5 m/s², accuracy > 25 m, backwards distance. */
function rejectPoints(points: readonly RawPoint[]): { kept: RawPoint[]; dropped: number } {
  const kept: RawPoint[] = [];
  let dropped = 0;
  let offset = 0;
  let prevV = 0;
  let pending: RawPoint[] = [];
  for (const raw of points) {
    const p = { ...raw, d: raw.d - offset };
    const prev = kept[kept.length - 1];
    if (!prev) {
      kept.push(p);
      continue;
    }
    if (p.accuracyM !== undefined && p.accuracyM > GPS_MAX_ACCURACY_M) {
      dropped++;
      continue;
    }
    const dt = p.t - prev.t;
    const v = (p.d - prev.d) / dt;
    const accel = Math.abs(v - prevV) / dt;
    const bad = v < -1e-6 || v > GPS_MAX_SPEED_MPS || (dt <= 5 && accel > GPS_MAX_ACCEL_MPS2 && v > 0);
    if (!bad) {
      kept.push(p);
      prevV = Math.max(0, v);
      pending = [];
      continue;
    }
    // A run of rejected points that move at a normal speed among themselves is a permanent distance
    // jump (GPS re-acquisition): drop the jump, keep the points.
    pending.push(p);
    if (pending.length >= REBASE_AFTER_POINTS && consistent(pending)) {
      const first = pending[0] as RawPoint;
      const jump = first.d - prev.d - prevV * (first.t - prev.t);
      offset += jump;
      for (const q of pending) kept.push({ ...q, d: q.d - jump });
      dropped -= pending.length - 1; // the first one stays counted as the glitch
      pending = [];
      continue;
    }
    dropped++;
  }
  return { kept, dropped };
}

function consistent(ps: readonly RawPoint[]): boolean {
  for (let i = 1; i < ps.length; i++) {
    const a = ps[i - 1] as RawPoint;
    const b = ps[i] as RawPoint;
    const v = (b.d - a.d) / (b.t - a.t);
    if (v < 0 || v > GPS_MAX_SPEED_MPS) return false;
  }
  return true;
}

function lerp(a: number, b: number, f: number): number {
  return a + (b - a) * f;
}

function lerpOpt(a: number | undefined, b: number | undefined, f: number): number | undefined {
  return a !== undefined && b !== undefined ? lerp(a, b, f) : undefined;
}

function rollingMedian(xs: readonly number[], window: number): number[] {
  const half = Math.floor(window / 2);
  return xs.map((_, i) => {
    const w = xs.slice(Math.max(0, i - half), i + half + 1).sort((a, b) => a - b);
    const m = Math.floor(w.length / 2);
    return w.length % 2 ? (w[m] as number) : ((w[m - 1] as number) + (w[m] as number)) / 2;
  });
}

function rollingMean(xs: readonly number[], window: number): number[] {
  const half = Math.floor(window / 2);
  return xs.map((_, i) => {
    const w = xs.slice(Math.max(0, i - half), i + half + 1);
    return w.reduce((a, b) => a + b, 0) / w.length;
  });
}

/** §4.9 cleaning pipeline: reject → interpolate short gaps at 1 Hz → smooth speed → auto-pause → HR. */
export function cleanSamples(samples: readonly ActivitySample[], opts: CleanOptions = {}): CleanResult {
  const raw = toRawPoints(samples);
  const rej = rejectPoints(raw.points);
  const flags: CleanResult["flags"] = {
    droppedPoints: raw.dropped + rej.dropped,
    interpolatedS: 0,
    longGaps: [],
    hrDropped: 0,
  };
  const pts = rej.kept;
  type Pt = RawPoint & { interpolated: boolean };
  const filled: Pt[] = [];
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i] as RawPoint;
    const prev = pts[i - 1];
    if (prev) {
      const dt = p.t - prev.t;
      if (dt > GAP_INTERPOLATE_MAX_S) flags.longGaps.push({ fromT: prev.t, toT: p.t });
      else {
        for (let k = 1; k < dt; k++) {
          const f = k / dt;
          const q: Pt = { t: prev.t + k, d: lerp(prev.d, p.d, f), interpolated: true };
          const alt = lerpOpt(prev.altM, p.altM, f);
          const hr = lerpOpt(prev.hr, p.hr, f);
          const temp = lerpOpt(prev.tempC, p.tempC, f);
          if (alt !== undefined) q.altM = alt;
          if (hr !== undefined) q.hr = hr;
          if (temp !== undefined) q.tempC = temp;
          filled.push(q);
          flags.interpolatedS++;
        }
      }
    }
    filled.push({ ...p, interpolated: false });
  }

  const rawSpeed = filled.map((p, i) => {
    const prev = filled[i - 1];
    if (!prev) {
      const next = filled[1];
      return next ? Math.max(0, (next.d - p.d) / (next.t - p.t)) : 0;
    }
    return Math.max(0, (p.d - prev.d) / (p.t - prev.t));
  });
  const speed = rollingMean(rollingMedian(rawSpeed, SPEED_MEDIAN_WINDOW_S), SPEED_MEAN_WINDOW_S);

  const hrCeiling = opts.hrMax !== undefined ? opts.hrMax + HR_MAX_MARGIN_BPM : Infinity;
  const out: CleanSample[] = [];
  let belowS = 0;
  let movingS = 0;
  filled.forEach((p, i) => {
    const v = speed[i] as number;
    const prev = filled[i - 1];
    const dt = prev ? p.t - prev.t : 0;
    belowS = v < MOVING_SPEED_MPS ? belowS + Math.max(1, dt) : 0;
    const moving = opts.runWalk === true || belowS < STOP_AFTER_S;
    if (moving && prev) movingS += dt;
    const s: CleanSample = { t: p.t, distM: p.d, speedMps: v, moving, interpolated: p.interpolated };
    if (p.altM !== undefined) s.altM = p.altM;
    if (p.tempC !== undefined) s.tempC = p.tempC;
    if (p.hr !== undefined) {
      if (p.hr < HR_MIN_BPM || p.hr > hrCeiling) flags.hrDropped++;
      else s.hr = p.hr;
    }
    out.push(s);
  });
  const first = out[0];
  const last = out[out.length - 1];
  return { samples: out, movingS, distanceM: first && last ? last.distM - first.distM : 0, flags };
}

// ── §4.7 grade-adjusted pace ─────────────────────────────────────────────────────────────────────

/** Minetti 2002 energy cost of running, J·kg⁻¹·m⁻¹, at gradient i (fraction, e.g. 0.1 = 10%). E. Energy cost only. */
export function minettiCost(i: number): number {
  return 155.4 * i ** 5 - 30.4 * i ** 4 - 43.3 * i ** 3 + 46.3 * i ** 2 + 19.5 * i + 3.6;
}

export const GAP_GRADE_CLAMP_PCT = 25;
/** Grade from elevation smoothed over 50–100 m (§4.7): 75 m (D). */
export const GAP_GRADE_WINDOW_M = 75;

/** Engine GAP factor (Ultrapacer quadratic, C/D): F(g) = 0.0021g² + 0.034g + 1, g in %, clamped ±25%. */
export function gapFactor(gradePct: number): number {
  const g = Math.max(-GAP_GRADE_CLAMP_PCT, Math.min(GAP_GRADE_CLAMP_PCT, gradePct));
  return 0.0021 * g * g + 0.034 * g + 1;
}

/** GAP speed = speed × F(g). */
export function gradeAdjustedSpeed(speedMps: number, gradePct: number): number {
  return speedMps * gapFactor(gradePct);
}

/** GAP pace (s/km) for an actual pace (s/km) on a grade. */
export function gradeAdjustedPace(paceSPerKm: number, gradePct: number): number {
  return paceSPerKm / gapFactor(gradePct);
}

/** §4.7: barometric altitude only, outdoors (not track or treadmill). */
export function gapAvailable(a: Pick<Activity, "altitudeSource" | "environment">): boolean {
  return a.altitudeSource === "barometric" && (a.environment ?? "outdoor") === "outdoor";
}

/** Altitude at cumulative distance `d` (linear between samples). Samples must have non-decreasing distM. */
function altAt(samples: readonly CleanSample[], alts: readonly number[], d: number): number {
  let lo = 0;
  let hi = samples.length - 1;
  if (d <= (samples[0] as CleanSample).distM) return alts[0] as number;
  if (d >= (samples[hi] as CleanSample).distM) return alts[hi] as number;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if ((samples[mid] as CleanSample).distM <= d) lo = mid;
    else hi = mid;
  }
  const a = samples[lo] as CleanSample;
  const b = samples[hi] as CleanSample;
  const span = b.distM - a.distM;
  return span > 0 ? lerp(alts[lo] as number, alts[hi] as number, (d - a.distM) / span) : (alts[lo] as number);
}

/** Per-sample grade (%) over a centred distance window; 0 where altitude is missing. */
export function gradePercents(samples: readonly CleanSample[], windowM = GAP_GRADE_WINDOW_M): number[] {
  if (samples.length === 0 || samples.some((s) => s.altM === undefined)) return samples.map(() => 0);
  const alts = samples.map((s) => s.altM as number);
  const d0 = (samples[0] as CleanSample).distM;
  const d1 = (samples[samples.length - 1] as CleanSample).distM;
  return samples.map((s) => {
    const a = Math.max(d0, s.distM - windowM / 2);
    const b = Math.min(d1, s.distM + windowM / 2);
    if (b - a < 10) return 0;
    const g = ((altAt(samples, alts, b) - altAt(samples, alts, a)) / (b - a)) * 100;
    return Math.max(-GAP_GRADE_CLAMP_PCT, Math.min(GAP_GRADE_CLAMP_PCT, g));
  });
}

/** Time-weighted mean GAP speed over moving samples, or undefined when GAP is disabled (§4.7). */
export function activityGapSpeed(clean: CleanResult, a: Pick<Activity, "altitudeSource" | "environment">): number | undefined {
  if (!gapAvailable(a) || clean.samples.length < 2) return undefined;
  const g = gradePercents(clean.samples);
  let dist = 0;
  let time = 0;
  clean.samples.forEach((s, i) => {
    const prev = clean.samples[i - 1];
    if (!prev || !s.moving) return;
    const dt = s.t - prev.t;
    dist += (s.distM - prev.distM) * gapFactor(g[i] as number);
    time += dt;
  });
  return time > 0 ? dist / time : undefined;
}

// ── §4.8 heat ────────────────────────────────────────────────────────────────────────────────────

export const HEAT_PENALTY_START_WBGT_C = 10;
/** Runs above this WBGT are excluded from fitness updates (§4.8, D on Gasparetto). */
export const HEAT_EXCLUDE_WBGT_C = 20;

/** Rule HEAT slope, %/°C (D, scaled from Ely 2007 by level). */
export function heatSlopePctPerC(vdot: number): number {
  if (vdot >= 50) return 0.35;
  if (vdot >= 40) return 0.5;
  return 0.65;
}

/** Pace penalty in % for a WBGT: 0 at ≤ 10 °C, else slope × (WBGT − 10). */
export function heatPenaltyPct(wbgtC: number, vdot: number): number {
  return wbgtC <= HEAT_PENALTY_START_WBGT_C ? 0 : heatSlopePctPerC(vdot) * (wbgtC - HEAT_PENALTY_START_WBGT_C);
}

/** Slow a prescribed pace (s/km) for forecast heat. */
export function heatAdjustedPace(paceSPerKm: number, wbgtC: number, vdot: number): number {
  return paceSPerKm * (1 + heatPenaltyPct(wbgtC, vdot) / 100);
}

/** Normalize a completed run's pace (s/km) to cool conditions before fitness estimation. */
export function heatNormalizedPace(actualPaceSPerKm: number, wbgtC: number, vdot: number): number {
  return actualPaceSPerKm / (1 + heatPenaltyPct(wbgtC, vdot) / 100);
}

export function excludedForHeat(wbgtC: number | undefined): boolean {
  return wbgtC !== undefined && wbgtC > HEAT_EXCLUDE_WBGT_C;
}

/**
 * Shade WBGT from air temperature and dew point (°C), Australian Bureau of Meteorology approximation
 * (C): WBGT ≈ 0.567·T + 0.393·e + 3.94, e = vapour pressure (hPa). Dew point is the low-evidence term (§4.8).
 */
export function wbgtFromTempDewPoint(tempC: number, dewPointC: number): number {
  const e = 6.105 * Math.exp((17.27 * dewPointC) / (237.7 + dewPointC));
  return 0.567 * tempC + 0.393 * e + 3.94;
}

// ── §4.6 efficiency factor, decoupling, HR–speed ─────────────────────────────────────────────────

/** Skip the first 10 min for EF and regression (§4.9 "5–10 min"). */
export const EF_SKIP_S = 600;
export const STEADY_MIN_S = 20 * 60;
export const DECOUPLING_GOOD_PCT = 5;

interface Seg {
  dt: number;
  dd: number;
  hr: number;
  grade: number;
}

function steadySegments(clean: CleanResult, skipS: number, grades?: readonly number[]): Seg[] {
  const t0 = clean.samples[0]?.t ?? 0;
  const out: Seg[] = [];
  clean.samples.forEach((s, i) => {
    const prev = clean.samples[i - 1];
    if (!prev || !s.moving || s.hr === undefined || s.t - t0 < skipS) return;
    out.push({ dt: s.t - prev.t, dd: s.distM - prev.distM, hr: s.hr, grade: grades?.[i] ?? 0 });
  });
  return out;
}

function efOf(segs: readonly Seg[], useGap: boolean): number | undefined {
  let dist = 0;
  let time = 0;
  let hrTime = 0;
  for (const s of segs) {
    dist += s.dd * (useGap ? gapFactor(s.grade) : 1);
    time += s.dt;
    hrTime += s.hr * s.dt;
  }
  if (time <= 0 || hrTime <= 0) return undefined;
  return (dist / time) * 60 / (hrTime / time); // (m/min) per bpm
}

export interface EfOptions {
  skipS?: number;
  /** Use grade-adjusted speed (needs `gapAvailable`). */
  grades?: readonly number[];
}

/** Efficiency factor = normalized graded speed (m/min) / average HR (§4.6, TrainingPeaks, C). */
export function efficiencyFactor(clean: CleanResult, opts: EfOptions = {}): number | undefined {
  return efOf(steadySegments(clean, opts.skipS ?? EF_SKIP_S, opts.grades), opts.grades !== undefined);
}

export interface Decoupling {
  ef1: number;
  ef2: number;
  /** (EF1 − EF2) / EF1 × 100. Positive = HR drifted up relative to speed. */
  pct: number;
  good: boolean;
}

/** Aerobic decoupling, steady efforts of ≥ 20 min after the skip only (§4.6). */
export function aerobicDecoupling(clean: CleanResult, opts: EfOptions = {}): Decoupling | undefined {
  const segs = steadySegments(clean, opts.skipS ?? EF_SKIP_S, opts.grades);
  const total = segs.reduce((a, s) => a + s.dt, 0);
  if (total < STEADY_MIN_S) return undefined;
  let acc = 0;
  let split = segs.length;
  for (let i = 0; i < segs.length; i++) {
    acc += (segs[i] as Seg).dt;
    if (acc >= total / 2) {
      split = i + 1;
      break;
    }
  }
  const gap = opts.grades !== undefined;
  const ef1 = efOf(segs.slice(0, split), gap);
  const ef2 = efOf(segs.slice(split), gap);
  if (ef1 === undefined || ef2 === undefined) return undefined;
  const pct = ((ef1 - ef2) / ef1) * 100;
  return { ef1, ef2, pct, good: pct < DECOUPLING_GOOD_PCT };
}

export interface SteadyWindow {
  startT: number;
  speedMps: number;
  hr: number;
}

/** 60-s windows with speed CV < 8% and HR CV < 5%, after the warm-up skip (§4.9 qualifying steady segment). */
export function steadyWindows(clean: CleanResult, skipS = EF_SKIP_S, windowS = 60): SteadyWindow[] {
  const s = clean.samples;
  const t0 = s[0]?.t ?? 0;
  const out: SteadyWindow[] = [];
  let i = 0;
  while (i < s.length) {
    const start = s[i] as CleanSample;
    if (start.t - t0 < skipS) {
      i++;
      continue;
    }
    const win: CleanSample[] = [];
    let j = i;
    while (j < s.length && (s[j] as CleanSample).t < start.t + windowS) win.push(s[j++] as CleanSample);
    if (win.length >= windowS * 0.8 && win.every((x) => x.moving && x.hr !== undefined)) {
      const sp = win.map((x) => x.speedMps);
      const hr = win.map((x) => x.hr as number);
      if (cv(sp) < 0.08 && cv(hr) < 0.05) out.push({ startT: start.t, speedMps: mean(sp), hr: mean(hr) });
    }
    i = j;
  }
  return out;
}

export interface HrSpeedFit {
  /** speed = a + b·HR */
  a: number;
  b: number;
  r2: number;
  n: number;
  /** Extrapolated speed at HRmax (≈ vVO2max), m/s. */
  vAtHrMaxMps: number;
}

/**
 * HR–speed regression on steady windows with HR > 70% HRmax, extrapolated to HRmax (§4.6, D,
 * unvalidated). Requires a MEASURED HRmax: the caller must not pass an age-formula value.
 */
export function hrSpeedFit(windows: readonly SteadyWindow[], hrMaxMeasured: number): HrSpeedFit | undefined {
  const w = windows.filter((x) => x.hr > 0.7 * hrMaxMeasured);
  if (w.length < 3) return undefined;
  const fit = linearFit(w.map((x) => x.hr), w.map((x) => x.speedMps));
  if (!fit || fit.slope <= 0) return undefined;
  return { a: fit.intercept, b: fit.slope, r2: fit.r2, n: w.length, vAtHrMaxMps: fit.intercept + fit.slope * hrMaxMeasured };
}

// ── best efforts and critical speed (§4.5) ───────────────────────────────────────────────────────

export const BEST_EFFORT_DISTANCES_M = [400, 800, 1000, 1500, 3000, 5000] as const;
export const CS_WINDOW_DAYS = 16 * 7;
export const CS_MIN_ACTIVITIES = 24;
/** Best subset in Smyth & Muniz-Pumares (E). */
export const CS_PREFERRED_DISTANCES_M = [400, 800, 5000] as const;

/** Fastest elapsed time (s) to cover `distanceM` anywhere in the activity, interpolated; undefined if too short. */
export function bestEffortS(samples: readonly CleanSample[], distanceM: number): number | undefined {
  let best = Infinity;
  let j = 0;
  for (let i = 0; i < samples.length; i++) {
    const start = samples[i] as CleanSample;
    const goal = start.distM + distanceM;
    if (j < i) j = i;
    while (j < samples.length && (samples[j] as CleanSample).distM < goal) j++;
    if (j >= samples.length) break;
    const b = samples[j] as CleanSample;
    const a = samples[j - 1] as CleanSample;
    const span = b.distM - a.distM;
    const tAt = span > 0 ? a.t + ((goal - a.distM) / span) * (b.t - a.t) : b.t;
    best = Math.min(best, tAt - start.t);
  }
  return Number.isFinite(best) ? best : undefined;
}

export interface Effort {
  distanceM: number;
  timeS: number;
  activityId?: string;
  date?: string;
}

/** Best efforts for one activity: from samples when present, else laps and the whole run within ±3% of a distance. */
export function activityBestEfforts(a: Activity, distances: readonly number[] = BEST_EFFORT_DISTANCES_M): Effort[] {
  const out: Effort[] = [];
  const tag = { activityId: a.id, date: a.date };
  if (a.samples && a.samples.length > 1) {
    const clean = cleanSamples(a.samples, a.runWalk ? { runWalk: true } : {});
    for (const d of distances) {
      const t = bestEffortS(clean.samples, d);
      if (t !== undefined) out.push({ distanceM: d, timeS: t, ...tag });
    }
    return out;
  }
  const pieces = [...(a.laps ?? []).map((l) => ({ m: l.distanceM, s: l.durationS })), { m: a.distanceM, s: a.movingS }];
  for (const d of distances) {
    let best = Infinity;
    for (const p of pieces) if (p.m > 0 && Math.abs(p.m - d) <= 0.03 * d) best = Math.min(best, (p.s * d) / p.m);
    if (Number.isFinite(best)) out.push({ distanceM: d, timeS: best, ...tag });
  }
  return out;
}

export interface LinearFit {
  slope: number;
  intercept: number;
  r2: number;
}

export function linearFit(xs: readonly number[], ys: readonly number[]): LinearFit | undefined {
  const n = xs.length;
  if (n < 2 || ys.length !== n) return undefined;
  const mx = mean(xs);
  const my = mean(ys);
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = (xs[i] as number) - mx;
    const dy = (ys[i] as number) - my;
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
  }
  if (sxx === 0) return undefined;
  const slope = sxy / sxx;
  const r2 = syy === 0 ? 1 : (sxy * sxy) / (sxx * syy);
  return { slope, intercept: my - slope * mx, r2 };
}

export interface CriticalSpeedFit {
  /** m/s */
  csMps: number;
  /** D′, m */
  dPrimeM: number;
  r2: number;
  efforts: Effort[];
}

/** Linear model D = CS·t + D′ fitted by least squares (§4.5). Needs ≥ 2 efforts of different duration. */
export function fitCriticalSpeed(efforts: readonly Effort[]): CriticalSpeedFit | undefined {
  const fit = linearFit(efforts.map((e) => e.timeS), efforts.map((e) => e.distanceM));
  if (!fit || fit.slope <= 0) return undefined;
  return { csMps: fit.slope, dPrimeM: fit.intercept, r2: fit.r2, efforts: [...efforts] };
}

export type CriticalSpeedResult =
  | ({ status: "ok"; activities: number } & CriticalSpeedFit)
  | { status: "disabled" | "insufficient"; reason: string; activities: number };

/**
 * CS from training (§4.5): best efforts in the trailing 16 weeks, ≥ 24 runs, 400/800/5000 m when all
 * exist (else every available distance). Disabled for beginners: their efforts are rarely maximal.
 * Efforts are not grade-adjusted in this slice (D: flat-course assumption, see report).
 */
export function criticalSpeedFromActivities(
  activities: readonly Activity[],
  today: string,
  level: string,
  /** Only genuinely hard efforts feed the fit (§4.5): races, TTs, quality sessions. Default: races/TTs/sRPE ≥ 7. */
  isHard: (a: Activity) => boolean = (a) => a.isRace || a.isTimeTrial === true || (a.srpe ?? 0) >= 7,
): CriticalSpeedResult {
  const from = addDays(today, -CS_WINDOW_DAYS);
  const runs = activities.filter((a) => a.sport === "run" && a.date > from && a.date <= today);
  if (level === "beginner") return { status: "disabled", reason: "beginner", activities: runs.length };
  if (runs.length < CS_MIN_ACTIVITIES) {
    return { status: "insufficient", reason: `${runs.length}<${CS_MIN_ACTIVITIES} runs in 16 weeks`, activities: runs.length };
  }
  const best = new Map<number, Effort>();
  for (const a of runs.filter(isHard)) {
    for (const e of activityBestEfforts(a)) {
      const cur = best.get(e.distanceM);
      if (!cur || e.timeS < cur.timeS) best.set(e.distanceM, e);
    }
  }
  const preferred = CS_PREFERRED_DISTANCES_M.every((d) => best.has(d));
  const use = (preferred ? CS_PREFERRED_DISTANCES_M : BEST_EFFORT_DISTANCES_M)
    .map((d) => best.get(d))
    .filter((e): e is Effort => e !== undefined);
  const fit = use.length >= 3 ? fitCriticalSpeed(use) : undefined;
  if (!fit) return { status: "insufficient", reason: "fewer than 3 hard best-effort distances", activities: runs.length };
  return { status: "ok", activities: runs.length, ...fit };
}

/** Marathon %CS prior (§4.5, E → D): 0.93 at ≤ 150 min → 0.789 at ≥ 300 min, linear. */
export function marathonFractionOfCs(marathonMin: number): number {
  const f = 0.93 + ((marathonMin - 150) / 150) * (0.789 - 0.93);
  return Math.max(0.789, Math.min(0.93, f));
}

/** CS prior from a marathon time: CS ≈ v_M / f(T_M) (§4.5). */
export function csPriorFromMarathon(marathonS: number): number {
  return DISTANCES_M.marathon / marathonS / marathonFractionOfCs(marathonS / 60);
}

/**
 * VDOT implied by a CS, through the same Smyth relation: the marathon time T with
 * 42195/T = f(T)·CS, then VDOT(42195 m, T). Cross-check only (§4.5 "not a driver").
 */
export function vdotFromCriticalSpeed(csMps: number): number | undefined {
  let lo = 120 * 60;
  let hi = 420 * 60;
  const g = (t: number) => DISTANCES_M.marathon / t - marathonFractionOfCs(t / 60) * csMps;
  if (g(lo) < 0 || g(hi) > 0) return undefined;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (g(mid) > 0) lo = mid;
    else hi = mid;
  }
  try {
    return computeVdot(DISTANCES_M.marathon, (lo + hi) / 2);
  } catch (err) {
    if (err instanceof VdotRangeError) return undefined;
    throw err;
  }
}

// ── §4.6 Uth–Sørensen and HRmax ──────────────────────────────────────────────────────────────────

/** VO2max ≈ 15.3 × HRmax/HRrest (Uth 2004, E). Sanity check and fallback cap only. */
export function uthVo2max(hrMax: number, hrRest: number): number {
  return (15.3 * hrMax) / hrRest;
}

export type HrMaxSource = "measured" | "age_formula";

/** SEE 2.7 ml/kg/min with measured HRmax, 4.7 with age-predicted (Uth 2004). */
export function uthSee(source: HrMaxSource): number {
  return source === "measured" ? 2.7 : 4.7;
}

export interface UthCheck {
  estimate: number;
  see: number;
  /** |VDOT − estimate| ≤ 2·SEE. Outside → flag for review, never change VDOT from this alone. */
  consistent: boolean;
  /** VDOT may not be raised above this on training evidence alone (estimate + 2·SEE). */
  cap: number;
}

export function uthSanityCheck(vdot: number, hrMax: number, hrRest: number, source: HrMaxSource): UthCheck {
  const estimate = uthVo2max(hrMax, hrRest);
  const see = uthSee(source);
  return { estimate, see, consistent: Math.abs(vdot - estimate) <= 2 * see, cap: estimate + 2 * see };
}

/** Tanaka 2001: 208 − 0.7·age (E). Guidance only: never used to change VDOT (§4.6). */
export function tanakaHrMax(age: number): number {
  return 208 - 0.7 * age;
}

export const HRMAX_LOOKBACK_DAYS = 183;

/** Peak 30-s HR per run in the last 6 months; HRmax = 99th percentile of those peaks (§4.6, D). */
export function measuredHrMax(activities: readonly Activity[], today: string): number | undefined {
  const from = addDays(today, -HRMAX_LOOKBACK_DAYS);
  const peaks: number[] = [];
  for (const a of activities) {
    if (a.sport !== "run" || a.date <= from || a.date > today || !a.samples) continue;
    const clean = cleanSamples(a.samples);
    const hr = clean.samples.filter((s) => s.hr !== undefined);
    if (hr.length < 30) continue;
    let peak = 0;
    for (let i = 0; i + 30 <= hr.length; i++) peak = Math.max(peak, mean(hr.slice(i, i + 30).map((s) => s.hr as number)));
    peaks.push(peak);
  }
  if (peaks.length === 0) return undefined;
  peaks.sort((a, b) => a - b);
  return peaks[Math.max(0, Math.ceil(0.99 * peaks.length) - 1)];
}

// ── small helpers ────────────────────────────────────────────────────────────────────────────────

function mean(xs: readonly number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

function cv(xs: readonly number[]): number {
  const m = mean(xs);
  if (m === 0) return Infinity;
  const v = mean(xs.map((x) => (x - m) ** 2));
  return Math.sqrt(v) / m;
}
