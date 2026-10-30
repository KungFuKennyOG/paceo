/**
 * Demo data for VITE_MOCK=1, built from the real engine so the UI shows realistic plans.
 * Pure functions of (today, now): the fixture test parses all of it against the contract schemas.
 */
import type {
  ActivitySummary,
  CheckInResponse,
  ConnectionStatus,
  HealthScreenResponse,
  MeResponse,
  PlanResponse,
  Profile,
  Proposal,
  ProposalDecisionResponse,
  User,
  WorkoutDetailResponse,
  WorkoutItem,
} from "@paceo/contracts";
import {
  addDays,
  generatePlan,
  stepsToIntervalsText,
  weekdayIndex,
  weekdayOf,
  type PlannedWorkout,
  type Plan,
} from "@paceo/engine";
import { clientPreview, profileToPlanInput } from "../lib/planInput";

export const DEMO_EMAIL = "demo@paceo.run";
export const DEMO_VAPID_PUBLIC_KEY = "BH8nBWfm47hJmeBxfsO2KsV9JAdUocbVTGR1Wms1yfd3XNeGSfhIJ_tvED4fCn_gxOtXuCbu0R6_DG7U43r9hJM";

export const demoUser: User = { id: "u_demo", email: DEMO_EMAIL, displayName: "Demo Runner", isAdmin: true };

/** First Sunday at least `weeks` weeks after `today`. */
export function sundayAfter(today: string, weeks: number): string {
  const target = addDays(today, 7 * weeks);
  return addDays(target, 6 - weekdayIndex(target));
}

export function demoProfile(today: string): Profile {
  return {
    units: "metric",
    timezone: "America/Toronto",
    experienceLevel: "intermediate",
    monthsRunning: 30,
    currentWeeklyKm: 38,
    longestRun30d: { km: 16, minutes: 95 },
    canRun20MinContinuous: true,
    recentResult: { distanceM: 10000, timeS: 48 * 60 + 30, date: addDays(today, -42), kind: "race" },
    birthYear: 1994,
    hrMax: 192,
    hrRest: 52,
    injury: "none",
    goal: { type: "race", distance: "half", raceDate: sundayAfter(today, 14), goalTimeS: 105 * 60 },
    daysAvailable: ["tue", "wed", "thu", "sat", "sun"],
    longRunDay: "sun",
    maxMinutesByDay: { tue: 75, thu: 75 },
    longRunMode: "daniels",
    strength: { mode: "running", equipment: "dumbbells", sessionsPerWeek: 2, liftingExperience: "novice" },
    crossTraining: [{ activity: "cycling", days: ["mon"], typicalMinutes: 60, typicalSrpe: 5, locked: true }],
    watchBrand: "garmin",
  };
}

export const demoScreening = (now: Date): HealthScreenResponse => ({
  outcome: "ok",
  canProceed: true,
  notes: [],
  screenedAt: new Date(now.getTime() - 20 * 86_400_000).toISOString(),
});

export const demoConnection = (now: Date): ConnectionStatus => ({
  provider: "intervals_icu",
  connected: true,
  status: "ok",
  athleteName: "Demo Runner",
  lastSyncAt: new Date(now.getTime() - 42 * 60_000).toISOString(),
  activityCounts: { run: 42, ride: 9, swim: 2 },
  message: null,
});

export const disconnectedConnection: ConnectionStatus = {
  provider: "intervals_icu",
  connected: false,
  status: "disconnected",
  athleteName: null,
  lastSyncAt: null,
  activityCounts: null,
  message: null,
};

/** A type the UI doesn't know yet: it must render gracefully. */
function mobilityWorkout(date: string): Record<string, unknown> {
  return {
    id: `me-mob-${date}`,
    user_id: "me",
    date,
    sport: "mobility",
    type: "MOBILITY",
    name: "Mobility flow",
    prescription_mode: "time_rpe",
    steps: [],
    planned: { run_m: 0, minutes: 20, expected_srpe: 2 },
    rule_trace: [],
  };
}

export interface DemoData {
  profile: Profile;
  plan: PlanResponse;
  workouts: WorkoutItem[];
  activities: ActivitySummary[];
}

function sinkFor(date: string, today: string, now: Date, missing: boolean): WorkoutItem["sink"] {
  const horizon = addDays(today, 14);
  if (date > horizon) {
    return { provider: "intervals_icu", externalId: null, eventId: null, lastPushedAt: null, status: "not_pushed" };
  }
  return {
    provider: "intervals_icu",
    externalId: `paceo-${date}`,
    eventId: `evt-${date.replace(/-/g, "")}`,
    lastPushedAt: new Date(now.getTime() - 3 * 3_600_000).toISOString(),
    status: missing ? "missing_on_readback" : "pushed",
  };
}

function activityFor(w: { id: string; date: string; name: string; planned: { run_m: number; minutes: number } }, i: number): ActivitySummary {
  const factor = 1 + ((i % 5) - 2) / 100;
  return {
    id: `act-${w.date}`,
    source: "intervals_icu",
    originPlatform: "garmin",
    startUtc: `${w.date}T11:30:00Z`,
    localDate: w.date,
    sport: "Run",
    distanceM: Math.round(w.planned.run_m * factor),
    movingS: Math.round(w.planned.minutes * 60 * factor),
    avgHr: 140 + (i % 4) * 6,
    isRace: false,
    name: w.name,
    garminOrigin: true,
  };
}

export function buildPlanResponse(profile: Profile, today: string, now: Date, planId = "plan_demo", conservative = false): PlanResponse | null {
  const r = clientPreview(profile, today, { conservative });
  if (!r.ok) return null;
  return {
    planId,
    generatedAt: now.toISOString(),
    plan: r.preview.plan as unknown as PlanResponse["plan"],
    paces: r.preview.paces as unknown as PlanResponse["paces"],
  };
}

/** Workout items for a plan: past ones completed (one missed, one skipped), the next 14 days pushed. */
export function workoutsForPlan(plan: Plan, today: string, now: Date, extras = true): { workouts: WorkoutItem[]; activities: ActivitySummary[] } {
  const items: WorkoutItem[] = [];
  const activities: ActivitySummary[] = [];
  const all = plan.weeks.flatMap((w) => w.workouts);
  let pastIndex = 0;
  let missingMarked = false;
  for (const w of all) {
    const past = w.date < today;
    let status: WorkoutItem["status"] = "planned";
    let matched: ActivitySummary | null = null;
    if (past) {
      pastIndex++;
      if (pastIndex === 3) status = "missed";
      else if (pastIndex === 5) status = "skipped";
      else {
        status = "completed";
        if (w.sport === "run") {
          matched = activityFor(w, pastIndex);
          activities.push(matched);
        }
      }
    }
    const isRun = w.sport === "run";
    const missing = isRun && !missingMarked && w.date > addDays(today, 1) && w.date <= addDays(today, 5);
    if (missing) missingMarked = true;
    items.push({
      id: w.id,
      date: w.date,
      workout: w as unknown as WorkoutItem["workout"],
      status,
      matchedActivity: matched,
      sink: isRun ? sinkFor(w.date, today, now, missing) : { provider: null, externalId: null, eventId: null, lastPushedAt: null, status: "not_pushed" },
    });
  }
  if (extras && all.length > 0) {
    const start = all[0]!.date;
    // Logged rides on Mondays (the demo profile's cross-training day).
    for (let d = start; d < today; d = addDays(d, 1)) {
      if (weekdayOf(d) === "mon") {
        activities.push({
          id: `act-ride-${d}`,
          source: "intervals_icu",
          originPlatform: "garmin",
          startUtc: `${d}T22:00:00Z`,
          localDate: d,
          sport: "Ride",
          distanceM: 28_500,
          movingS: 3_600,
          avgHr: 128,
          isRace: false,
          name: "Evening ride",
          garminOrigin: true,
        });
      }
    }
    const mob = addDays(today, 2);
    const mw = mobilityWorkout(mob);
    items.push({
      id: String(mw.id),
      date: mob,
      workout: mw as unknown as WorkoutItem["workout"],
      status: "planned",
      matchedActivity: null,
      sink: { provider: null, externalId: null, eventId: null, lastPushedAt: null, status: "not_pushed" },
    });
    activities.push({
      id: "act-coros-swim",
      source: "fit_upload",
      originPlatform: "coros",
      startUtc: `${addDays(today, -4)}T12:00:00Z`,
      localDate: addDays(today, -4),
      sport: "Swim",
      distanceM: 1500,
      movingS: 1_920,
      avgHr: null,
      isRace: false,
      name: "Pool swim",
      garminOrigin: false,
    });
  }
  items.sort((a, b) => (a.date === b.date ? a.id.localeCompare(b.id) : a.date.localeCompare(b.date)));
  activities.sort((a, b) => a.startUtc.localeCompare(b.startUtc));
  return { workouts: items, activities };
}

/** The demo user's data: a half-marathon plan that started 10 days ago. */
export function buildDemoData(today: string, now: Date): DemoData {
  const planStart = addDays(today, -10);
  const profile = demoProfile(today);
  const input = profileToPlanInput(profile, planStart);
  if (!input.ok) throw new Error(input.reason);
  const plan = generatePlan(input.input);
  const preview = clientPreview(profile, planStart);
  const paces = preview.ok ? preview.preview.paces : {};
  const { workouts, activities } = workoutsForPlan(plan, today, now);
  return {
    profile,
    plan: {
      planId: "plan_demo",
      generatedAt: new Date(now.getTime() - 10 * 86_400_000).toISOString(),
      plan: plan as unknown as PlanResponse["plan"],
      paces: paces as unknown as PlanResponse["paces"],
    },
    workouts,
    activities,
  };
}

const TRACE_TEXT: Array<[RegExp, (m: RegExpMatchArray) => string]> = [
  [/^P3:(\w+):(\w+):(\w+)/, (m) => `${phaseName(m[1] ?? "")} phase of a ${m[2]} plan: ${m[3]} work is the main stimulus right now (Daniels).`],
  [/^I2:(\w+):(\d)d/, (m) => `At ${m[1]} level on ${m[2]} run days you get this many quality sessions a week.`],
  [/^V1:ok\(([\d.]+)<=([\d.]+)\)/, (m) => `Within the long-run spike limit: ${m[1]} km against a cap of ${m[2]} km.`],
  [/^W-T:prog\+(\d+)min/, (m) => `It's ${m[1]} min longer than last week's threshold session.`],
  [/^ST:running/, () => "Running-focused strength: lower body and calves, plyos first while fresh."],
  [/^ST-7/, () => "Placed at least 48 h before your next key run."],
  [/^RACE/, () => "Race day. Trust the taper."],
];

const PHASE_NAMES: Record<string, string> = {
  BASE: "Base",
  FI: "Foundation",
  EQ: "Early Quality",
  TQ: "Transition Quality",
  FQ: "Final Quality",
};

function phaseName(code: string): string {
  return PHASE_NAMES[code] ?? code;
}

/** Mock stand-in for the server's explain() (§11.4). */
export function mockExplain(trace: string[]): string[] {
  const lines: string[] = [];
  for (const t of trace) {
    for (const [re, fn] of TRACE_TEXT) {
      const m = t.match(re);
      if (m) {
        lines.push(fn(m));
        break;
      }
    }
  }
  if (lines.length === 0) lines.push("An easy aerobic day: it keeps volume up without adding fatigue before your next key session.");
  return lines;
}

export function detailFor(item: WorkoutItem): WorkoutDetailResponse {
  const w = item.workout as Record<string, unknown>;
  const trace = Array.isArray(w.rule_trace) ? w.rule_trace.filter((x): x is string => typeof x === "string") : [];
  let deviceText: string | null = null;
  if (w.sport === "run" && Array.isArray(w.steps) && item.sink.status !== "not_pushed") {
    try {
      deviceText = stepsToIntervalsText(w.steps as PlannedWorkout["steps"]);
    } catch {
      deviceText = null;
    }
  }
  return { item, explanation: mockExplain(trace), deviceText };
}

export function meFor(user: User, profile: Profile | null, screening: HealthScreenResponse | null, connection: ConnectionStatus | null, hasPlan: boolean): MeResponse {
  return {
    user,
    profile,
    screening,
    connection,
    onboardingComplete: profile !== null && screening !== null && screening.canProceed && hasPlan,
  };
}

export const sampleCheckIns: Record<string, CheckInResponse> = {
  fever: {
    id: "ci_1",
    planChanges: ["No running until you're fever-free. The next 3 days are cleared.", "Quality sessions pause until symptoms are gone."],
    advice: ["If symptoms last more than 7 days or get worse, see a doctor."],
  },
  green: { id: "ci_2", planChanges: [], advice: ["Pain at this level is fine if it settles by tomorrow morning."] },
};

/** Pending replan proposals for the demo user (§8): a pace bump from recent quality sessions. */
export function demoProposals(today: string, now: Date): Proposal[] {
  return [
    {
      id: `vdot:+1:${addDays(today, -1)}`,
      kind: "vdot_change",
      message:
        "Your last 3 quality sessions over 16 days were consistently faster than target at the expected effort. Speed up your paces by about 1.2% (VDOT 44.1 → 44.7)?",
      status: "pending",
      createdAt: new Date(now.getTime() - 6 * 3_600_000).toISOString(),
      respondedAt: null,
      details: { id: `vdot:+1:${addDays(today, -1)}`, kind: "vdot_change", rule: "R-PERF", fromVdot: 44.1, toVdot: 44.7, steps: 1, pacePct: 1.2, evidence: [] },
    },
  ];
}

/** Mock answer to a proposal: what the API returns after the immediate replan. */
export function proposalDecision(p: Proposal, accept: boolean): ProposalDecisionResponse {
  if (!accept) return { planChanges: [], advice: ["Okay, your plan stays as it is."] };
  const d = p.details as { fromVdot?: number; toVdot?: number };
  if (p.kind === "vdot_change" && typeof d.fromVdot === "number" && typeof d.toVdot === "number") {
    return { planChanges: [`Paces updated: VDOT ${d.fromVdot.toFixed(1)} → ${d.toVdot.toFixed(1)}, from today.`], advice: [] };
  }
  if (p.kind === "realign") return { planChanges: ["Rebuilt your plan from today to race day, starting from the 24.0 km/week you've actually averaged over the last 3 weeks."], advice: [] };
  if (p.kind === "goal_change") return { planChanges: [], advice: ["To change your goal, edit it in Settings; the plan rebuilds from it."] };
  return { planChanges: [], advice: ["Accepted. There was nothing to change in your plan right now."] };
}
