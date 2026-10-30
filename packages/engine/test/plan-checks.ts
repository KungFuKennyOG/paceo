/**
 * Plan-level invariants shared by the plan tests. Each throws (via expect) on the first breach.
 * They re-derive the rules from the output alone, independent of the generator's internals.
 */
import { expect } from "vitest";
import {
  fromDayNumber,
  isLowerStrength,
  planPaces,
  prescriptionFor,
  strengthTaperDays,
  toDayNumber,
  weekdayOf,
  weeklyLoad,
  type CrossTrainingSession,
  type Plan,
  type PlanInput,
  type PlannedWorkout,
  type Step,
} from "../src/index.js";

const QUALITY = new Set(["T", "I", "R", "H", "M", "TT"]);
export const isQuality = (w: PlannedWorkout): boolean => QUALITY.has(w.type);
export const allWorkouts = (p: Plan): PlannedWorkout[] => p.weeks.flatMap((w) => w.workouts);
/** Run sessions only (strength shares days with runs). */
export const runWorkouts = (p: Plan): PlannedWorkout[] => allWorkouts(p).filter((w) => w.sport === "run");
export const strengthWorkouts = (p: Plan): PlannedWorkout[] => allWorkouts(p).filter((w) => w.sport === "strength");
export const crossTraining = (p: Plan): CrossTrainingSession[] => p.weeks.flatMap((w) => w.crossTraining ?? []);
const runs = (p: Plan) => runWorkouts(p).filter((w) => w.type !== "RACE");

/**
 * V1 (§6.5): every run ≤ 1.10 × the longest non-race run in the prior 30 days, seeded with the
 * entered longest run (dated yesterday) and rolled forward with planned runs; races excluded.
 * Run/walk counts by duration; in time mode the duration limit applies to every run too.
 */
export function expectV1(p: Plan, input: PlanInput): void {
  const hist: Array<{ day: number; km?: number; min: number }> = [
    { day: toDayNumber(input.today) - 1, km: input.longestRun30d.km, min: input.longestRun30d.minutes },
  ];
  const timeMode = prescriptionFor(input.level, input.vdotStatus, planPaces(input)).longBy === "time";
  for (const r of runs(p)) {
    const day = toDayNumber(r.date);
    const win = hist.filter((h) => h.day >= day - 30 && h.day < day);
    const kms = win.flatMap((h) => (h.km === undefined ? [] : [h.km]));
    const refKm = kms.length > 0 ? Math.max(...kms) : input.longestRun30d.km;
    const refMin = Math.max(0, ...win.map((h) => h.min)) || input.longestRun30d.minutes;
    if (r.type === "RW") {
      expect(r.planned.minutes, `V1 run/walk ${r.date}`).toBeLessThanOrEqual(1.1 * refMin + 1e-6);
      hist.push({ day, min: r.planned.minutes });
      continue;
    }
    const km = r.planned.run_m / 1000;
    expect(km, `V1 ${r.date} ${r.name}`).toBeLessThanOrEqual(1.1 * refKm + 1e-3);
    if (timeMode) expect(r.planned.minutes, `V1 time ${r.date}`).toBeLessThanOrEqual(1.1 * refMin + 1e-3);
    hist.push({ day, km, min: r.planned.minutes });
  }
}

/** §7.1 hard constraints, the 48 h rule, one run a day, and ≤ 3 key sessions a week (§6.4). */
export function expectSchedule(p: Plan): void {
  const byDay = new Map<number, PlannedWorkout>();
  for (const w of runWorkouts(p)) {
    const day = toDayNumber(w.date);
    expect(byDay.has(day), `one session on ${w.date}`).toBe(false);
    byDay.set(day, w);
  }
  for (const [day, w] of byDay) {
    const next = byDay.get(day + 1);
    if (!next) continue;
    if (isQuality(w)) expect(isQuality(next), `consecutive quality ${w.date}`).toBe(false);
    if (next.type === "L") expect(w.flags.key_session, `day before LR ${w.date}`).toBe(false);
    if (w.type === "L") expect(next.flags.key_session, `day after LR ${next.date}`).toBe(false);
    if (w.flags.key_session) expect(next.flags.key_session, `48 h after ${w.date}`).toBe(false);
  }
  for (const wk of p.weeks) {
    const keys = wk.workouts.filter((x) => x.flags.key_session && x.type !== "RACE").length;
    expect(keys, `week ${wk.index} key sessions`).toBeLessThanOrEqual(3);
  }
}

const weekMinutes = (w: Plan["weeks"][number]) =>
  w.workouts.filter((x) => x.sport === "run").reduce((a, x) => a + x.planned.minutes, 0);

/**
 * V2 "never above 30%" week to week. Weeks after a ladder week are compared by session time:
 * run/walk volume counts by duration (§6.5) and its km count running only.
 */
export function expectWeeklyGrowth(p: Plan): void {
  for (let i = 1; i < p.weeks.length; i++) {
    const prev = p.weeks[i - 1]!;
    const cur = p.weeks[i]!;
    if (prev.isLadder) {
      expect(weekMinutes(cur), `ladder week ${cur.index}`).toBeLessThanOrEqual(weekMinutes(prev) * 1.3 + 0.5);
    } else if (prev.plannedKm > 0) {
      expect(cur.plannedKm, `week ${cur.index}`).toBeLessThanOrEqual(prev.plannedKm * 1.3 + 0.05);
    }
  }
}

/** Race on race day, every workout dated inside the plan with a rule trace. */
export function expectBasics(p: Plan, input: PlanInput): void {
  const races = allWorkouts(p).filter((w) => w.type === "RACE");
  expect(races).toHaveLength(1);
  expect(races[0]!.date).toBe(input.raceDate);
  for (const w of allWorkouts(p)) {
    expect(w.date >= input.today && w.date <= input.raceDate).toBe(true);
    expect(w.rule_trace.length).toBeGreaterThan(0);
    expect(w.planned.minutes).toBeGreaterThan(0);
  }
}

/** The long run is ≥ every other non-race run in its week, except in taper and TT weeks. */
export function expectLongRunIsLongest(p: Plan): void {
  for (const wk of p.weeks) {
    if (wk.isTaper || wk.workouts.some((x) => x.type === "TT")) continue;
    const lr = wk.workouts.find((x) => x.type === "L");
    if (!lr) continue;
    for (const x of wk.workouts) {
      if (x === lr || x.type === "RACE") continue;
      expect(x.planned.run_m, `week ${wk.index}: ${x.name} vs LR`).toBeLessThanOrEqual(lr.planned.run_m);
    }
  }
}

/** Planned km within ±15% of target, unless the summary flags the week with a recorded cap. */
export function expectTargetTracking(p: Plan): void {
  for (const wk of p.weeks.filter((w) => !w.isLadder)) {
    const flag = p.summary.volumeFlags.find((f) => f.week === wk.index);
    if (flag) expect(flag.reasons, `week ${wk.index} flag`).not.toContain("unexplained");
    if (Math.abs(wk.plannedKm - wk.targetKm) > 0.15 * wk.targetKm) {
      expect(flag, `week ${wk.index}: planned ${wk.plannedKm} vs target ${wk.targetKm}`).toBeDefined();
    }
  }
}

/** Non-taper weeks after any ladder keep ≥ 90% of the entry volume (unless the run days can't hold it). */
export function expectNoDetraining(p: Plan, input: PlanInput): void {
  if (p.summary.notes.some((n) => n.startsWith("V3:start_capped_to_run_days"))) return;
  for (const wk of p.weeks.filter((w) => !w.isLadder && !w.isTaper)) {
    expect(wk.plannedKm, `week ${wk.index} vs entry`).toBeGreaterThanOrEqual(0.9 * input.currentWeeklyKm - 1e-9);
  }
}

/** Running km at work pace inside a session's "work" steps (pace targets only). */
export function workKm(w: PlannedWorkout): number {
  const one = (st: Step): number => {
    if (st.kind === "repeat") return st.count * st.steps.reduce((a, x) => a + one(x), 0);
    if (st.kind !== "work") return 0;
    if (st.duration.type === "distance") return st.duration.m / 1000;
    if (st.duration.type === "time" && st.target.type === "pace") {
      return st.duration.s / ((st.target.lo_s_per_km + st.target.hi_s_per_km) / 2);
    }
    return 0;
  };
  return w.steps.reduce((a, x) => a + one(x), 0);
}

/** Daniels caps (§6.10) in normal build weeks: T ≤ 10%, I/H ≤ 8%, R ≤ 5%, M ≤ 20%; low-volume floor below 30 km. */
export function expectDanielsCaps(p: Plan): void {
  const cap: Record<string, number> = { T: 0.1, I: 0.08, R: 0.05, H: 0.08, M: 0.2 };
  for (const wk of p.weeks.filter((w) => !w.isCutback && !w.isTaper && !w.isLadder)) {
    for (const w of wk.workouts) {
      const c = cap[w.type];
      if (c === undefined || w.prescription_mode !== "pace") continue;
      const floor = wk.targetKm < 30 ? 4 : 0;
      expect(workKm(w), `${w.date} ${w.name}`).toBeLessThanOrEqual(c * wk.targetKm + floor + 0.15);
    }
  }
}

/** Whole weeks between the last long run at the plan's peak distance and race day. */
export function peakLongRunWeeksOut(p: Plan): number {
  const lrs = allWorkouts(p).filter((w) => w.type === "L");
  const peak = Math.max(...lrs.map((w) => w.planned.run_m));
  const last = lrs.filter((w) => w.planned.run_m === peak).at(-1)!;
  return Math.floor((toDayNumber(p.summary.raceDate) - toDayNumber(last.date)) / 7);
}

const days = (ws: readonly { date: string }[]) => new Set(ws.map((w) => toDayNumber(w.date)));
const lrDaysOf = (p: Plan) => days(runWorkouts(p).filter((w) => w.type === "L" || w.type === "RACE"));
const qualityDaysOf = (p: Plan) => days(runWorkouts(p).filter((w) => w.flags.key_session && w.type !== "L" && w.type !== "RACE"));

/**
 * §9.5 ST rules on every app strength session with lower-body content, plus §9.4 race proximity,
 * and the shape of every strength workout. External lower/full lifting counts for ST-5.
 */
export function expectStrengthRules(p: Plan): void {
  const lr = lrDaysOf(p);
  const quality = qualityDaysOf(p);
  const xt = crossTraining(p);
  const hardXt = days(xt.filter((x) => x.hard));
  const teamDays = days(xt.filter((x) => x.cls === "team_sport" || x.cls === "hiit"));
  const extLower = [...days(xt.filter((x) => x.lift !== undefined && x.lift !== "upper"))];
  const raceDay = p.summary.mode === "general_fitness" ? undefined : toDayNumber(p.summary.raceDate);
  const window = strengthTaperDays(p.summary.distance);

  for (const w of strengthWorkouts(p)) {
    expect(w.type, w.id).toBe("STRENGTH");
    expect(w.planned.run_m, w.id).toBe(0);
    expect(w.planned.minutes, w.id).toBeGreaterThan(0);
    expect(w.planned.expected_srpe, w.id).toBeGreaterThan(0);
    expect((w.exercises ?? []).length, w.id).toBeGreaterThan(0);
    for (const e of w.exercises ?? []) expect(e.cues.length, `${w.id} ${e.id} cues`).toBeGreaterThan(0);
    const d = toDayNumber(w.date);
    if (raceDay !== undefined) {
      expect(raceDay - d, `${w.date}: strength in race −3`).toBeGreaterThan(window.none);
      const light = w.rule_trace.includes("§9.4:light");
      if (!light) expect(raceDay - d, `${w.date}: heavy inside the last-heavy window`).toBeGreaterThanOrEqual(window.heavy);
      if ((w.exercises ?? []).some((e) => e.slot === "PLYO")) expect(raceDay - d, `${w.date}: plyo too close`).toBeGreaterThanOrEqual(window.plyo);
    }
    if (!isLowerStrength(w)) {
      expect(hardXt.has(d) && quality.has(d), `${w.date} ST-7 (upper)`).toBe(false);
      continue;
    }
    expect(lr.has(d) || lr.has(d + 1) || lr.has(d + 2), `${w.date} ST-3`).toBe(false);
    expect(quality.has(d + 1), `${w.date} ST-4`).toBe(false);
    expect(hardXt.has(d) && quality.has(d), `${w.date} ST-7`).toBe(false);
    expect(teamDays.has(d), `${w.date} team-sport day`).toBe(false);
  }
  // ST-5: ≥ 48 h between lower sessions; an add-on sits on its own external session's day.
  const lower = [
    ...strengthWorkouts(p).filter((w) => isLowerStrength(w) && !w.id.endsWith("-addon")).map((w) => toDayNumber(w.date)),
    ...extLower,
  ].sort((a, b) => a - b);
  const extSet = new Set(extLower);
  for (let i = 1; i < lower.length; i++) {
    const a = lower[i - 1]!;
    const b = lower[i]!;
    if (extSet.has(a) && extSet.has(b)) continue; // two external sessions: reported as a conflict, not ours to move
    expect(b - a, `ST-5 ${fromDayNumber(a)} → ${fromDayNumber(b)}`).toBeGreaterThanOrEqual(2);
  }
  // At most one app strength session a day.
  const perDay = new Map<string, number>();
  for (const w of strengthWorkouts(p)) perDay.set(w.date, (perDay.get(w.date) ?? 0) + 1);
  for (const [date, n] of perDay) expect(n, `strength sessions on ${date}`).toBe(1);
}

/**
 * §7.1 / §10.2 cross-training rules: no quality run on the day of or within 24 h after a hard,
 * team-sport or HIIT session; no hard session the day before the LR unless the plan reports it
 * (locked sessions aren't moved).
 */
export function expectCrossTrainingRules(p: Plan): void {
  const lr = lrDaysOf(p);
  const quality = qualityDaysOf(p);
  const reported = new Set((p.summary.conflicts ?? []).filter((c) => c.code === "XT:hard_day_before_LR").map((c) => c.weekday));
  for (const x of crossTraining(p)) {
    const d = toDayNumber(x.date);
    expect(x.load, `${x.date} ${x.name} load`).toBeCloseTo(x.expectedSrpe * x.minutes, 6);
    if (x.blocksNextDayQuality) {
      expect(quality.has(d), `${x.date}: quality on a ${x.name} day`).toBe(false);
      expect(quality.has(d + 1), `${x.date}: quality within 24 h after ${x.name}`).toBe(false);
    }
    if (x.hard && lr.has(d + 1)) expect(reported.has(x.weekday), `${x.date}: hard ${x.name} before the LR, unreported`).toBe(true);
  }
}

/** §6.4: key runs (race excluded) + ½ per hard cross-training day ≤ 3, unless the LR is the only key run. */
export function expectKeyBudget(p: Plan): void {
  for (const wk of p.weeks) {
    const quality = wk.workouts.filter((w) => w.sport === "run" && w.flags.key_session && w.type !== "L" && w.type !== "RACE");
    if (quality.length === 0) continue;
    expect(weeklyLoad(wk).keySessions, `week ${wk.index} key sessions incl. ½ per hard cross-training`).toBeLessThanOrEqual(3);
  }
}

/** Every locked event appears on every matching date of the plan (race day excepted), with 0 running km. */
export function expectLockedEventsListed(p: Plan, input: Pick<PlanInput, "lockedEvents">): void {
  const events = input.lockedEvents ?? [];
  if (p.weeks.length === 0) return;
  const xt = crossTraining(p);
  const first = toDayNumber(p.weeks[0]!.startDate);
  const last = toDayNumber(p.weeks.at(-1)!.startDate) + 6;
  const raceDay = p.summary.mode === "general_fitness" ? undefined : toDayNumber(p.summary.raceDate);
  for (let d = first; d <= last; d++) {
    if (d === raceDay) continue;
    const wd = weekdayOf(fromDayNumber(d));
    const want = events.filter((e) => e.weekday === wd).length;
    expect(xt.filter((x) => toDayNumber(x.date) === d).length, `locked events on ${fromDayNumber(d)}`).toBe(want);
  }
  for (const wk of p.weeks) expect(weeklyLoad(wk).runningKm).toBeGreaterThanOrEqual(0);
}
