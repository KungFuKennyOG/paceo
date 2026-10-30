/**
 * In-memory mock backend for VITE_MOCK=1. Implements every route in ROUTES with plausible behaviour,
 * including the §2.5 connect error states and the §2.4 screening outcomes, so the whole UI can be
 * demoed without apps/api. State lives in memory (the session id is remembered in localStorage).
 *
 * Demo login: demo@paceo.run with any password (fully onboarded, admin).
 * Register with any invite code (≥ 4 chars, except "EXPIRED") to walk through onboarding.
 * Connect-step API keys: include "bad" → rejected, "busy" → rate limited, "empty" → no activities.
 */
import {
  CheckInRequest,
  ConnectIntervalsRequest,
  HealthScreenRequest,
  LoginRequest,
  PlanPreviewRequest,
  Profile,
  PushSubscribeRequest,
  RegisterRequest,
  SkipWorkoutRequest,
  type ActivitySummary,
  type CheckInResponse,
  type ConnectionStatus,
  type HealthScreenResponse,
  type PlanResponse,
  type User,
  type WorkoutItem,
} from "@paceo/contracts";
import { addDays, type Plan } from "@paceo/engine";
import type { TransportRequest, TransportResponse } from "../api/client";
import { localToday } from "../lib/dates";
import {
  buildDemoData,
  buildPlanResponse,
  demoConnection,
  demoScreening,
  demoUser,
  DEMO_EMAIL,
  DEMO_VAPID_PUBLIC_KEY,
  detailFor,
  disconnectedConnection,
  meFor,
  workoutsForPlan,
} from "./fixtures";

interface Account {
  user: User;
  profile: Profile | null;
  screening: HealthScreenResponse | null;
  connection: ConnectionStatus;
  plan: PlanResponse | null;
  workouts: WorkoutItem[];
  activities: ActivitySummary[];
}

const SESSION_KEY = "paceo.mock.session";
const accounts = new Map<string, Account>();
let seeded = false;
let checkinSeq = 1;

function today(): string {
  return localToday();
}

function seed(): void {
  if (seeded) return;
  seeded = true;
  const now = new Date();
  const data = buildDemoData(today(), now);
  accounts.set(DEMO_EMAIL, {
    user: demoUser,
    profile: data.profile,
    screening: demoScreening(now),
    connection: demoConnection(now),
    plan: data.plan,
    workouts: data.workouts,
    activities: data.activities,
  });
}

function getSession(): string | null {
  try {
    return window.localStorage.getItem(SESSION_KEY);
  } catch {
    return memorySession;
  }
}
let memorySession: string | null = null;
function setSession(email: string | null): void {
  memorySession = email;
  try {
    if (email) window.localStorage.setItem(SESSION_KEY, email);
    else window.localStorage.removeItem(SESSION_KEY);
  } catch {
    /* private mode: memory only */
  }
}

const json = (status: number, body: unknown): TransportResponse => ({ status, json: body });
const noContent = (): TransportResponse => ({ status: 204 });
const fail = (status: number, code: string, message: string, details?: unknown): TransportResponse =>
  json(status, { error: details === undefined ? { code, message } : { code, message, details } });

function current(): Account | null {
  const email = getSession();
  if (!email) return null;
  return accounts.get(email) ?? null;
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

type Handler = (req: TransportRequest, params: Record<string, string>, query: URLSearchParams) => TransportResponse;

const routes: Array<{ method: string; pattern: RegExp; keys: string[]; auth: boolean; handler: Handler }> = [];

function route(method: string, path: string, handler: Handler, auth = true): void {
  const keys: string[] = [];
  const pattern = new RegExp(
    "^" +
      path.replace(/:[a-zA-Z]+/g, (m) => {
        keys.push(m.slice(1));
        return "([^/]+)";
      }) +
      "$",
  );
  routes.push({ method, pattern, keys, auth, handler });
}

function acct(): Account {
  const a = current();
  if (!a) throw new Error("unreachable: auth checked by router");
  return a;
}

// ── auth ──────────────────────────────────────────────────────────────────────────────────────────
route("GET", "/api/health", () => json(200, { ok: true }), false);

route(
  "POST",
  "/api/auth/register",
  (req) => {
    const p = RegisterRequest.safeParse(req.body);
    if (!p.success) return fail(400, "validation", "Check the highlighted fields.", p.error.issues);
    if (p.data.inviteCode.toUpperCase() === "EXPIRED") return fail(400, "invite_invalid", "That invite code is invalid or has expired.");
    if (accounts.has(p.data.email)) return fail(409, "email_taken", "An account with that email already exists.");
    const user: User = { id: `u_${accounts.size + 1}`, email: p.data.email, displayName: p.data.displayName, isAdmin: false };
    accounts.set(user.email, {
      user,
      profile: null,
      screening: null,
      connection: disconnectedConnection,
      plan: null,
      workouts: [],
      activities: [],
    });
    setSession(user.email);
    return json(201, user);
  },
  false,
);

route(
  "POST",
  "/api/auth/login",
  (req) => {
    const p = LoginRequest.safeParse(req.body);
    if (!p.success) return fail(400, "validation", "Enter your email and password.");
    const a = accounts.get(p.data.email);
    if (!a) return fail(401, "invalid_credentials", "Email or password is wrong.");
    setSession(a.user.email);
    return json(200, a.user);
  },
  false,
);

route("POST", "/api/auth/logout", () => {
  setSession(null);
  return noContent();
});

route("POST", "/api/admin/invites", () => {
  if (!acct().user.isAdmin) return fail(403, "forbidden", "Only admins can create invites.");
  const code = `PACEO-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
  return json(201, { code, expiresAt: new Date(Date.now() + 14 * 86_400_000).toISOString() });
});

route("GET", "/api/me", () => {
  const a = acct();
  return json(200, meFor(a.user, a.profile, a.screening, a.connection, a.plan !== null));
});

// ── health screen ────────────────────────────────────────────────────────────────────────────────
route("POST", "/api/health-screen", (req) => {
  const p = HealthScreenRequest.safeParse(req.body);
  if (!p.success) return fail(400, "validation", "Answer every question.", p.error.issues);
  const anyYes = p.data.answers.some(Boolean);
  const scope = p.data.pregnantOrPostpartum || p.data.recentSeriousInjuryOrSurgery;
  let outcome: HealthScreenResponse["outcome"] = "ok";
  const notes: string[] = [];
  if (scope) {
    outcome = p.data.clearanceConfirmed ? "cleared_conservative" : "out_of_scope";
  } else if (anyYes) {
    outcome = p.data.clearanceConfirmed ? "cleared" : "see_doctor";
  }
  if (outcome === "see_doctor") notes.push("A yes answer means a doctor or qualified exercise professional should clear you before you start.");
  if (outcome === "out_of_scope") notes.push("Pregnancy, postpartum and return from serious injury or surgery need professional guidance that Paceo can't give.");
  if (outcome === "cleared_conservative") {
    notes.push("Paceo will use its most conservative settings: beginner caps, no plyometrics and no heavy strength work.");
  }
  if (outcome === "cleared") notes.push("Clearance recorded today. Paceo will ask these questions again in 12 months.");
  const a = acct();
  a.screening = {
    outcome,
    canProceed: outcome === "ok" || outcome === "cleared" || outcome === "cleared_conservative",
    notes,
    screenedAt: new Date().toISOString(),
  };
  return json(200, a.screening);
});

// ── profile ──────────────────────────────────────────────────────────────────────────────────────
route("GET", "/api/profile", () => {
  const a = acct();
  return a.profile ? json(200, a.profile) : fail(404, "not_found", "No profile yet.");
});

route("PUT", "/api/profile", (req) => {
  const p = Profile.safeParse(req.body);
  if (!p.success) return fail(400, "validation", "Some profile fields are invalid.", p.error.issues);
  acct().profile = p.data;
  return json(200, p.data);
});

// ── connections ──────────────────────────────────────────────────────────────────────────────────
route("POST", "/api/connections/intervals", (req) => {
  const p = ConnectIntervalsRequest.safeParse(req.body);
  if (!p.success) return fail(400, "validation", "That doesn't look like an intervals.icu API key.");
  const key = p.data.apiKey.toLowerCase();
  const a = acct();
  if (key.includes("bad")) {
    a.connection = { ...disconnectedConnection, status: "invalid", message: "Key not accepted — copy it again from Developer Settings." };
    return fail(400, "key_rejected", "Key not accepted — copy it again from Developer Settings.");
  }
  if (p.data.athleteId && !/^i\d+$/i.test(p.data.athleteId.trim())) {
    return fail(400, "athlete_mismatch", "That athlete ID doesn't match the key. It looks like i12345 in Developer Settings.");
  }
  const now = new Date().toISOString();
  if (key.includes("busy")) {
    a.connection = {
      provider: "intervals_icu",
      connected: true,
      status: "rate_limited",
      athleteName: "Mock Athlete",
      lastSyncAt: null,
      activityCounts: null,
      message: "intervals.icu is busy. Your key is saved and Paceo will finish the first sync shortly.",
    };
  } else if (key.includes("empty")) {
    a.connection = {
      provider: "intervals_icu",
      connected: true,
      status: "ok",
      athleteName: "Mock Athlete",
      lastSyncAt: now,
      activityCounts: {},
      message: null,
    };
  } else {
    a.connection = { ...demoConnection(new Date()), athleteName: "Mock Athlete", lastSyncAt: now };
  }
  return json(200, a.connection);
});

route("DELETE", "/api/connections/intervals", () => {
  acct().connection = disconnectedConnection;
  return noContent();
});

route("GET", "/api/connections/intervals", () => json(200, acct().connection));

route("POST", "/api/connections/intervals/test-workout", () => {
  if (!acct().connection.connected) return fail(409, "not_connected", "Connect intervals.icu first.");
  return json(201, { externalId: "paceo-setup-test", date: addDays(today(), 1) });
});

route("DELETE", "/api/connections/intervals/test-workout", () => noContent());

// ── plan ─────────────────────────────────────────────────────────────────────────────────────────
function previewFor(profile: Profile): TransportResponse {
  if (profile.goal.type !== "race") {
    return fail(422, "not_supported", "General-fitness plans aren't available in the mock backend yet.");
  }
  const r = buildPlanResponse(profile, today(), new Date());
  if (!r) return fail(422, "preview_failed", "Couldn't build a preview for that profile.");
  return json(200, { plan: r.plan, paces: r.paces });
}

route("POST", "/api/plan/preview", (req) => {
  const p = PlanPreviewRequest.safeParse(req.body);
  if (!p.success) return fail(400, "validation", "Some profile fields are invalid.", p.error.issues);
  return previewFor(p.data.profile);
});

route("POST", "/api/plan/generate", () => {
  const a = acct();
  if (!a.profile) return fail(409, "no_profile", "Finish your profile first.");
  if (!a.screening?.canProceed) return fail(409, "screening_required", "Complete the health screen first.");
  const now = new Date();
  const plan = buildPlanResponse(a.profile, today(), now, `plan_${Date.now().toString(36)}`);
  if (!plan) return fail(422, "plan_failed", "Couldn't build a plan for that profile.");
  if (plan.plan.feasibility.status === "block") return fail(422, "infeasible", "This goal is blocked. Pick one of the suggested alternatives.");
  a.plan = plan;
  const w = workoutsForPlan(plan.plan as unknown as Plan, today(), now, false);
  a.workouts = w.workouts;
  return json(201, plan);
});

route("GET", "/api/plan/current", () => {
  const a = acct();
  return a.plan ? json(200, a.plan) : fail(404, "not_found", "No plan yet.");
});

// ── workouts ─────────────────────────────────────────────────────────────────────────────────────
function inRange(date: string, q: URLSearchParams): boolean {
  const from = q.get("from");
  const to = q.get("to");
  return (!from || date >= from) && (!to || date <= to);
}

function findWorkout(id: string): WorkoutItem | undefined {
  return acct().workouts.find((w) => w.id === id);
}

route("GET", "/api/workouts", (_req, _p, q) => json(200, { items: acct().workouts.filter((w) => inRange(w.date, q)) }));

route("GET", "/api/workouts/:id", (_req, p) => {
  const w = findWorkout(p.id ?? "");
  return w ? json(200, detailFor(w)) : fail(404, "not_found", "Workout not found.");
});

route("POST", "/api/workouts/:id/resend", (_req, p) => {
  const w = findWorkout(p.id ?? "");
  if (!w) return fail(404, "not_found", "Workout not found.");
  if (!acct().connection.connected) return fail(409, "not_connected", "Connect intervals.icu to send workouts to your watch.");
  w.sink = {
    provider: "intervals_icu",
    externalId: w.sink.externalId ?? `paceo-${w.date}`,
    eventId: `evt-${Date.now().toString(36)}`,
    lastPushedAt: new Date().toISOString(),
    status: "pushed",
  };
  return json(200, w);
});

route("POST", "/api/workouts/:id/skip", (req, p) => {
  const w = findWorkout(p.id ?? "");
  if (!w) return fail(404, "not_found", "Workout not found.");
  const b = SkipWorkoutRequest.safeParse(req.body);
  if (!b.success) return fail(400, "validation", "Pick a reason.");
  w.status = "skipped";
  const res: CheckInResponse = { id: `ci_${checkinSeq++}`, planChanges: [], advice: [] };
  if (b.data.reason === "sick") res.advice.push("Log an illness check-in so the plan can adapt. A fever means no running.");
  else if (b.data.reason === "injured") res.advice.push("Log a pain check-in so the plan can adapt.");
  else res.planChanges.push("Skipped. The rest of the week stays as planned (R-MISS: one missed easy run needs no change).");
  return json(200, res);
});

// ── check-ins ────────────────────────────────────────────────────────────────────────────────────
route("POST", "/api/checkins", (req) => {
  const p = CheckInRequest.safeParse(req.body);
  if (!p.success) return fail(400, "validation", "Some check-in fields are invalid.", p.error.issues);
  const c = p.data;
  const res: CheckInResponse = { id: `ci_${checkinSeq++}`, planChanges: [], advice: [] };
  switch (c.type) {
    case "session_rpe": {
      const w = c.workoutId ? findWorkout(c.workoutId) : undefined;
      if (w && w.status === "planned") w.status = "completed";
      if (c.rpe >= 8) res.advice.push("That felt hard. If easy days keep feeling this way, Paceo will suggest slowing your paces.");
      break;
    }
    case "illness":
      if (c.fever || !c.aboveNeckOnly) {
        res.planChanges.push("No running until you're fever-free and below-neck symptoms are gone. The next 3 days are cleared.");
        res.planChanges.push("Your first run back will be a 10–20 min easy check-in run.");
        res.advice.push("If symptoms last more than 7 days or get worse, see a doctor.");
      } else {
        res.planChanges.push("Today's run is now optional: easy, at most 50–70% of the planned time.");
        res.planChanges.push("No quality sessions until symptoms clear.");
      }
      break;
    case "pain": {
      const red = c.duringRun > 5 || (c.nextMorning !== null && c.nextMorning > 5);
      const amber = !red && (c.duringRun >= 3 || (c.nextMorning !== null && c.nextMorning >= 2));
      if (red) {
        res.planChanges.push("No running for 2–3 days, then a 20–30 min easy test run.");
        res.advice.push("If pain is above 5/10 again on the test run, see a physio. Sharp pain in one spot on a bone: stop and see a doctor.");
      } else if (amber) {
        res.planChanges.push("Your next 2–3 runs are easy only. Weekly km and the long run are frozen.");
        res.planChanges.push("Intervals, hills and plyos are removed for now.");
      } else {
        res.advice.push("Pain at this level is fine if it settles by tomorrow morning. Log the morning score if you can.");
      }
      break;
    }
    case "cross_training":
      res.advice.push("Logged. It counts toward your training load, not your running km.");
      acct().activities.push({
        id: `act-xt-${Date.now()}`,
        source: "fit_upload",
        originPlatform: null,
        startUtc: `${c.date}T12:00:00Z`,
        localDate: c.date,
        sport: c.activity,
        distanceM: null,
        movingS: c.minutes * 60,
        avgHr: null,
        isRace: false,
        name: `${c.activity} (manual)`,
        garminOrigin: false,
      });
      break;
  }
  return json(201, res);
});

// ── activities & sync ────────────────────────────────────────────────────────────────────────────
route("GET", "/api/activities", (_req, _p, q) => json(200, { items: acct().activities.filter((a) => inRange(a.localDate, q)) }));

route("POST", "/api/activities/upload", (req) => {
  const file = req.form?.get("file");
  const name = file instanceof File ? file.name : "upload.fit";
  if (!name.toLowerCase().endsWith(".fit")) return fail(400, "not_fit", "That isn't a .fit file.");
  const a: ActivitySummary = {
    id: `act-up-${Date.now()}`,
    source: "fit_upload",
    originPlatform: null,
    startUtc: new Date().toISOString(),
    localDate: today(),
    sport: "Run",
    distanceM: 8000,
    movingS: 2700,
    avgHr: 150,
    isRace: false,
    name: name.replace(/\.fit$/i, ""),
    garminOrigin: false,
  };
  acct().activities.push(a);
  return json(201, a);
});

route("POST", "/api/sync", () => {
  const a = acct();
  if (!a.connection.connected) return fail(409, "not_connected", "Connect intervals.icu first.");
  a.connection = { ...a.connection, lastSyncAt: new Date().toISOString() };
  return json(202, { queued: true, jobId: `job_${Date.now().toString(36)}` });
});

// ── push ─────────────────────────────────────────────────────────────────────────────────────────
route("GET", "/api/push/vapid-public-key", () => json(200, { publicKey: DEMO_VAPID_PUBLIC_KEY }));
route("POST", "/api/push/subscriptions", (req) =>
  PushSubscribeRequest.safeParse(req.body).success ? noContent() : fail(400, "validation", "Invalid subscription."),
);
route("DELETE", "/api/push/subscriptions", () => noContent());

/** Entry point used by the API client's transport in mock mode. */
export async function mockTransport(req: TransportRequest, opts: { latencyMs?: number } = {}): Promise<TransportResponse> {
  seed();
  await delay(opts.latencyMs ?? 250);
  const url = new URL(req.url, "http://mock.local");
  for (const r of routes) {
    if (r.method !== req.method) continue;
    const m = url.pathname.match(r.pattern);
    if (!m) continue;
    if (r.auth && !current()) return fail(401, "unauthorized", "Please sign in.");
    const params: Record<string, string> = {};
    r.keys.forEach((k, i) => {
      params[k] = decodeURIComponent(m[i + 1] ?? "");
    });
    try {
      return r.handler(req, params, url.searchParams);
    } catch (err) {
      console.error("[mock]", err);
      return fail(500, "internal", "The mock backend crashed.");
    }
  }
  return fail(404, "not_found", `No mock route for ${req.method} ${url.pathname}`);
}

/** Test helper: reset all state. */
export function resetMock(): void {
  accounts.clear();
  seeded = false;
  setSession(null);
}
