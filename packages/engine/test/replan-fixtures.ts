/** Synthetic activity history for replanning tests: "the athlete ran the plan as written". */
import {
  addDays,
  flattenSteps,
  generatePlan,
  type Activity,
  type ActivityLap,
  type FitnessState,
  type Plan,
  type PlanInput,
  type PlannedWorkout,
  type ReplanState,
} from "../src/index.js";

export interface RunOptions {
  /** Multiplies the planned distance (and time). */
  volume?: number;
  /** Work-step pace multiplier: 0.97 = 3% faster than the target midpoint. */
  workPace?: number;
  srpe?: number;
  laps?: boolean;
  wbgtC?: number;
}

/** A completed run for a planned workout, with laps 1:1 onto steps. */
export function activityFor(w: PlannedWorkout, o: RunOptions = {}): Activity {
  const volume = o.volume ?? 1;
  const avgPace = w.planned.run_m > 0 ? (w.planned.minutes * 60) / (w.planned.run_m / 1000) : 360;
  const laps: ActivityLap[] = [];
  let t = 0;
  for (const st of flattenSteps(w.steps)) {
    let pace = st.target.type === "pace" ? (st.target.lo_s_per_km + st.target.hi_s_per_km) / 2 : avgPace;
    if (st.kind === "work" && st.target.type === "pace") pace *= o.workPace ?? 1;
    if (st.kind === "walk" || (st.kind === "warmup" && w.type === "RW") || (st.kind === "cooldown" && w.type === "RW")) pace = 600;
    const s = st.duration.type === "time" ? st.duration.s : st.duration.type === "distance" ? (st.duration.m / 1000) * pace : 300;
    const m = st.duration.type === "distance" ? st.duration.m : (s / pace) * 1000;
    laps.push({ startS: t, durationS: Math.round(s * 10) / 10, distanceM: Math.round(m) });
    t += s;
  }
  const a: Activity = {
    id: `act-${w.date}`,
    date: w.date,
    sport: "run",
    distanceM: Math.round(w.planned.run_m * volume),
    movingS: Math.round(w.planned.minutes * 60 * volume),
    isRace: w.type === "RACE",
    srpe: o.srpe ?? w.planned.expected_srpe,
  };
  if (o.laps !== false && volume === 1) a.laps = laps;
  if (o.wbgtC !== undefined) a.wbgtC = o.wbgtC;
  if (w.type === "RW") a.runWalk = true;
  return a;
}

/** Every planned session in [from, toExclusive) done as planned (strength logged too), except `skip`. */
export function ranAsPlanned(plan: Plan, from: string, toExclusive: string, skip: (w: PlannedWorkout) => boolean = () => false, o: (w: PlannedWorkout) => RunOptions = () => ({})): Activity[] {
  const ws = plan.weeks.flatMap((w) => w.workouts).filter((w) => w.type !== "RACE" && w.date >= from && w.date < toExclusive && !skip(w));
  // Locked cross-training (e.g. persona B's paddling) happens too.
  const xt: Activity[] = plan.weeks
    .flatMap((w) => w.crossTraining ?? [])
    .filter((x) => x.date >= from && x.date < toExclusive)
    .map((x) => ({ id: `xt-${x.date}-${x.cls}`, date: x.date, sport: "other" as const, activity: x.activity, distanceM: 0, movingS: x.minutes * 60, isRace: false, srpe: x.expectedSrpe, hard: x.hard }));
  return [...xt, ...ws.map((w) =>
    w.sport === "run"
      ? activityFor(w, o(w))
      : { id: `str-${w.date}`, date: w.date, sport: "strength" as const, distanceM: 0, movingS: w.planned.minutes * 60, isRace: false, srpe: w.planned.expected_srpe },
  )];
}

/** Runs before the plan started, consistent with the persona's entered history. */
export function preHistory(input: PlanInput, weeks = 4): Activity[] {
  const out: Activity[] = [];
  const perWeek = input.runDays;
  for (let wk = weeks; wk >= 1; wk--) {
    const start = addDays(input.today, -7 * wk);
    const longKm = input.longestRun30d.km;
    const rest = (input.currentWeeklyKm - longKm) / Math.max(1, perWeek - 1);
    for (let i = 0; i < perWeek; i++) {
      const isLong = i === perWeek - 1;
      const kmRun = isLong ? longKm : rest;
      const pace = (input.longestRun30d.minutes * 60) / input.longestRun30d.km;
      const date = addDays(start, isLong ? 6 : i * 2);
      out.push({ id: `pre-${date}`, date, sport: "run", distanceM: Math.round(kmRun * 1000), movingS: Math.round(kmRun * pace), isRace: false });
    }
  }
  return out;
}

export function fitnessOf(input: PlanInput): FitnessState {
  const f: FitnessState = { status: input.vdotStatus, history: [] };
  if (input.vdot !== undefined) f.vdot = input.vdot;
  if (input.vdotAnchorM !== undefined) f.anchorM = input.vdotAnchorM;
  return f;
}

export function stateOf(input: PlanInput, activities: Activity[], plan: Plan = generatePlan(input)): ReplanState {
  return { plan, input, fitness: fitnessOf(input), activities };
}

/** Workouts strictly before `date`. */
export function workoutsBefore(plan: Plan, date: string): PlannedWorkout[] {
  return plan.weeks.flatMap((w) => w.workouts).filter((w) => w.date < date);
}
