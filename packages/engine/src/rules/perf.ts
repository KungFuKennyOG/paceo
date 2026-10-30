/**
 * R-PERF: performance-based pace changes (spec §8, all D modelled on Runna's Pace Insights, C).
 *   1. Eligible: fully completed T or I sessions whose laps map onto the steps, good GPS, WBGT ≤ 20 °C
 *      (10–20 °C normalized by HEAT), ≤ 15 m/km of climbing, no illness/pain flag in the prior 3 days,
 *      not in the first 7 days after a break, VDOT from a race or TT (estimated → only a TT counts).
 *   2. Per rep: delta = (target − actual)/target; reps with |delta| > 10% are discarded. Session score
 *      = median delta, plus sRPE vs the session's expected sRPE.
 *   3. Faster: ≥ 3 of the last 4 eligible sessions spanning ≥ 14 days at delta ≥ +2% and sRPE ≤ expected.
 *   4. Slower: ≥ 2 of the last 4 at delta ≤ −2% or sRPE ≥ expected + 2 (triggers more easily).
 *   5. Anything else: no change. 6/7 (freeze, race override) live in FIT-UPDATE.
 * Turning the verdict into a proposal (and its +1 / −1 step) is FIT-UPDATE's job (fitness-update.ts).
 */
import type { Activity } from "../activity.js";
import { heatNormalizedPace } from "../analysis.js";
import { addDays, daysBetween } from "../dates.js";
import { HILLY_M_PER_KM, type PerfVerdict, type TrainingEvidence } from "../fitness-update.js";
import { pacePercentPerVdotPoint } from "../paces.js";
import { flaggedWithin, type RuleContext } from "../replan-context.js";

export const PERF_TYPES: ReadonlySet<string> = new Set(["T", "I"]);
export const REP_OUTLIER = 0.1;
export const PERF_THRESHOLD = 0.02;
export const PERF_WINDOW = 4;
export const PERF_FASTER_MIN = 3;
export const PERF_SLOWER_MIN = 2;
export const PERF_SPAN_DAYS = 14;
export const PERF_LOOKBACK_DAYS = 42;
export const PERF_FLAG_DAYS = 3;
export const PERF_AFTER_BREAK_DAYS = 7;

export interface SessionScore {
  workoutId: string;
  activityId: string;
  date: string;
  type: string;
  eligible: boolean;
  reason?: string;
  /** Median rep delta (fraction; + = faster than target). */
  delta?: number;
  repDeltas: number[];
  srpe?: number;
  expectedSrpe: number;
  impliedVdot?: number;
}

function median(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2;
}

export function scoreSessions(ctx: RuleContext): SessionScore[] {
  const out: SessionScore[] = [];
  const vdot = ctx.fitness.vdot;
  const from = addDays(ctx.today, -PERF_LOOKBACK_DAYS);
  for (const m of ctx.match.workouts) {
    if (!PERF_TYPES.has(m.type) || m.date < from || m.date > ctx.today) continue;
    if (m.status !== "completed" || m.activityIds.length !== 1) continue;
    const w = ctx.workouts.find((x) => x.id === m.workoutId);
    const a = ctx.activities.find((x) => x.id === m.activityIds[0]) as Activity;
    if (!w) continue;
    const s: SessionScore = { workoutId: w.id, activityId: a.id, date: m.date, type: m.type, eligible: false, repDeltas: [], expectedSrpe: w.planned.expected_srpe };
    if (a.srpe !== undefined) s.srpe = a.srpe;
    const reject = (reason: string): void => {
      s.reason = reason;
      out.push(s);
    };
    if (ctx.fitness.status !== "race" && ctx.fitness.status !== "tt") { reject(`vdot_${ctx.fitness.status}`); continue; }
    if (!m.steps) { reject("no_lap_mapping"); continue; }
    if (a.gpsQuality === "poor") { reject("gps"); continue; }
    if (a.wbgtC !== undefined && a.wbgtC > 20) { reject("heat"); continue; }
    if (a.elevationGainM !== undefined && a.distanceM > 0 && a.elevationGainM / (a.distanceM / 1000) > HILLY_M_PER_KM) { reject("elevation"); continue; }
    if (flaggedWithin(ctx, addDays(m.date, -1), PERF_FLAG_DAYS - 1)) { reject("illness_or_pain_flag"); continue; }
    if (ctx.brk && m.date >= ctx.brk.returnDate && daysBetween(ctx.brk.returnDate, m.date) < PERF_AFTER_BREAK_DAYS) { reject("after_break"); continue; }
    for (const st of m.steps) {
      if (st.kind !== "work" || st.delta === undefined || st.actualPaceSPerKm === undefined || st.targetLoSPerKm === undefined) continue;
      const mid = (st.targetLoSPerKm + (st.targetHiSPerKm as number)) / 2;
      const actual = a.wbgtC !== undefined && vdot !== undefined ? heatNormalizedPace(st.actualPaceSPerKm, a.wbgtC, vdot) : st.actualPaceSPerKm;
      const d = (mid - actual) / mid;
      if (Math.abs(d) <= REP_OUTLIER) s.repDeltas.push(d);
    }
    if (s.repDeltas.length === 0) { reject("no_valid_reps"); continue; }
    s.delta = median(s.repDeltas);
    s.eligible = true;
    if (vdot !== undefined) s.impliedVdot = vdot + (s.delta * 100) / pacePercentPerVdotPoint(vdot);
    out.push(s);
  }
  return out.sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : 0));
}

export function perfVerdict(scores: readonly SessionScore[]): { verdict: PerfVerdict; used: SessionScore[] } {
  const used = scores.filter((s) => s.eligible).slice(-PERF_WINDOW);
  const slower = used.filter((s) => (s.delta as number) <= -PERF_THRESHOLD || (s.srpe !== undefined && s.srpe >= s.expectedSrpe + 2));
  if (slower.length >= PERF_SLOWER_MIN) return { verdict: "slower", used };
  const faster = used.filter((s) => (s.delta as number) >= PERF_THRESHOLD && (s.srpe === undefined || s.srpe <= s.expectedSrpe));
  if (faster.length >= PERF_FASTER_MIN) {
    const span = daysBetween((faster[0] as SessionScore).date, (faster[faster.length - 1] as SessionScore).date);
    if (span >= PERF_SPAN_DAYS) return { verdict: "faster", used };
  }
  return { verdict: used.length >= PERF_FASTER_MIN ? "mixed" : "insufficient", used };
}

/** Eligible sessions as training evidence for the FIT-UPDATE EWMA. */
export function sessionEvidence(scores: readonly SessionScore[]): TrainingEvidence[] {
  return scores.flatMap((s) => (s.eligible && s.impliedVdot !== undefined ? [{ kind: "session_pace" as const, date: s.date, vdot: s.impliedVdot, source: s.activityId }] : []));
}
