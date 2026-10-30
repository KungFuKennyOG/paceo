/**
 * End-to-end API flow against real Postgres: register → login → profile → screen → connect →
 * preview → generate (+14-day push) → workouts → detail → resend → nightly re-send → skip →
 * check-ins → FIT upload → sync → push subscriptions → admin invites → tenancy → nightly → logout.
 * Skipped when TEST_DATABASE_URL is unset.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addDays } from "@paceo/engine";
import {
  ActivityListResponse,
  ActivitySummary,
  CheckInResponse,
  ConnectionStatus,
  CreateInviteResponse,
  MeResponse,
  PlanPreviewResponse,
  PlanResponse,
  User,
  WorkoutDetailResponse,
  WorkoutItem,
  WorkoutListResponse,
  type Profile,
} from "@paceo/contracts";
import { createInvite } from "../../src/services/auth.js";
import { localDate } from "../../src/lib/time.js";
import { resendMissing } from "../../src/services/push-workouts.js";
import { createHandlers } from "../../src/jobs/handlers.js";
import { JOB } from "../../src/jobs/queue.js";
import { makeFitActivity } from "../helpers/fit.js";
import { BAD_KEY, GOOD_KEY, multipartFile, sessionCookie, startHarness, TEST_DATABASE_URL, type Harness } from "../helpers/integration.js";

const TZ = "America/Toronto";

describe.skipIf(!TEST_DATABASE_URL)("API flow (Postgres)", () => {
  let h: Harness;
  let cookie = "";
  let userId = "";
  const today = localDate(new Date(), TZ);

  const req = (method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: unknown, c: string | null = cookie) =>
    h.app.inject({
      method,
      url,
      ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
      ...(c ? { cookies: { paceo_session: c } } : {}),
    });

  const profile = (): Profile => ({
    units: "metric",
    timezone: TZ,
    experienceLevel: "intermediate",
    monthsRunning: 30,
    currentWeeklyKm: 35,
    longestRun30d: { km: 14, minutes: 85 },
    canRun20MinContinuous: true,
    recentResult: { distanceM: 10000, timeS: 50 * 60, date: addDays(today, -20), kind: "race" },
    birthYear: 1992,
    hrMax: null,
    hrRest: null,
    injury: "none",
    goal: { type: "race", distance: "half", raceDate: addDays(today, 7 * 16), goalTimeS: null },
    daysAvailable: ["tue", "thu", "sat", "sun"],
    longRunDay: "sun",
    maxMinutesByDay: {},
    longRunMode: "daniels",
    strength: { mode: "running", equipment: "bodyweight", sessionsPerWeek: 2, liftingExperience: "none" },
    crossTraining: [{ activity: "dragon boat", days: ["mon"], typicalMinutes: 60, typicalSrpe: 5, locked: true }],
    watchBrand: "garmin",
  });

  beforeAll(async () => {
    h = await startHarness(TEST_DATABASE_URL as string);
    h.fake.activities.push({
      sourceId: "i500",
      originPlatform: "garmin",
      startUtc: new Date(`${addDays(today, -2)}T12:00:00Z`),
      localDate: addDays(today, -2),
      sport: "run",
      distanceM: 8000,
      movingS: 2700,
      elapsedS: 2800,
      avgHr: 145,
      isRace: false,
      name: "Easy run",
      device: "Garmin Forerunner 265",
      garminOrigin: true,
      raw: { id: "i500" },
    });
    h.fake.hiddenStrava = 2;
  });

  afterAll(async () => {
    await h?.close();
  });

  it("health is public", async () => {
    const res = await req("GET", "/api/health", undefined, null);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok", db: true });
  });

  it("registers the first user as admin with a CLI-style invite", async () => {
    const { code } = await createInvite(h.svc.db, null, new Date());
    const res = await req("POST", "/api/auth/register", { inviteCode: code.toLowerCase(), email: "Kenny@Example.com", password: "a-long-password", displayName: "Kenny" }, null);
    expect(res.statusCode).toBe(200);
    const user = User.parse(res.json());
    expect(user).toMatchObject({ email: "kenny@example.com", isAdmin: true });
    userId = user.id;
    const setCookie = String(res.headers["set-cookie"]);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);

    const again = await req("POST", "/api/auth/register", { inviteCode: code, email: "other@example.com", password: "a-long-password", displayName: "O" }, null);
    expect(again.statusCode).toBe(400);
    expect(again.json().error.code).toBe("invite_invalid");
  });

  it("logs in and rejects bad passwords", async () => {
    const bad = await req("POST", "/api/auth/login", { email: "kenny@example.com", password: "wrong-password" }, null);
    expect(bad.statusCode).toBe(401);
    expect(bad.json().error.code).toBe("invalid_credentials");
    const ok = await req("POST", "/api/auth/login", { email: "kenny@example.com", password: "a-long-password" }, null);
    expect(ok.statusCode).toBe(200);
    cookie = sessionCookie(ok);
  });

  it("requires a valid session", async () => {
    expect((await req("GET", "/api/me", undefined, null)).statusCode).toBe(401);
    expect((await req("GET", "/api/me", undefined, "forged.value")).statusCode).toBe(401);
    const me = MeResponse.parse((await req("GET", "/api/me")).json());
    expect(me).toMatchObject({ profile: null, screening: null, connection: null, onboardingComplete: false });
  });

  it("validates bodies with the contract schemas", async () => {
    const res = await req("PUT", "/api/profile", { units: "metric" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("validation");
  });

  it("gates plan generation on profile and screening", async () => {
    expect((await req("POST", "/api/plan/generate")).json().error.code).toBe("profile_required");
    const put = await req("PUT", "/api/profile", profile());
    expect(put.statusCode).toBe(200);
    expect((await req("GET", "/api/profile")).json().timezone).toBe(TZ);
    const gen = await req("POST", "/api/plan/generate");
    expect(gen.statusCode).toBe(403);
    expect(gen.json().error.code).toBe("screening_required");
    const screen = await req("POST", "/api/health-screen", {
      answers: [false, false, false, false, false, false, false],
      pregnantOrPostpartum: false,
      recentSeriousInjuryOrSurgery: false,
    });
    expect(screen.statusCode).toBe(200);
    expect(screen.json()).toMatchObject({ outcome: "ok", canProceed: true });
  });

  it("connects intervals.icu, rejecting a bad key", async () => {
    const bad = await req("POST", "/api/connections/intervals", { apiKey: BAD_KEY });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe("key_rejected");
    const mismatch = await req("POST", "/api/connections/intervals", { apiKey: GOOD_KEY, athleteId: "i999" });
    expect(mismatch.json().error.code).toBe("athlete_mismatch");

    const res = await req("POST", "/api/connections/intervals", { apiKey: GOOD_KEY, athleteId: "i42" });
    expect(res.statusCode).toBe(200);
    const status = ConnectionStatus.parse(res.json());
    expect(status).toMatchObject({ provider: "intervals_icu", connected: true, athleteName: "Test Athlete" });
    expect(status.activityCounts).toMatchObject({ run: 1, strava_hidden: 2 });
    expect(status.message).toMatch(/Strava/);
    expect(JSON.stringify(status)).not.toContain(GOOD_KEY);

    // The setup sync ran (inline queue) and ingested the activity.
    const acts = ActivityListResponse.parse((await req("GET", "/api/activities")).json());
    expect(acts.items.map((a) => a.name)).toContain("Easy run");
    const row = await h.database.pool.query("select secret_enc from credentials where user_id = $1", [userId]);
    expect(String(row.rows[0]?.secret_enc)).not.toContain(GOOD_KEY);
  });

  it("previews a plan without storing it", async () => {
    const res = await req("POST", "/api/plan/preview", { profile: profile() });
    expect(res.statusCode).toBe(200);
    const preview = PlanPreviewResponse.parse(res.json());
    expect(preview.plan.weeks.length).toBeGreaterThan(10);
    expect(preview.paces).toHaveProperty("E");
    expect((await req("GET", "/api/plan/current")).statusCode).toBe(404);
  });

  let planId = "";
  it("generates, stores and pushes the next 14 days", async () => {
    const res = await req("POST", "/api/plan/generate");
    expect(res.statusCode).toBe(200);
    const plan = PlanResponse.parse(res.json());
    planId = plan.planId;
    expect(PlanResponse.parse((await req("GET", "/api/plan/current")).json()).planId).toBe(planId);

    expect(h.queue.calls.some((c) => c.name === JOB.pushWorkouts)).toBe(true);
    const window = addDays(today, 13);
    const list = WorkoutListResponse.parse((await req("GET", `/api/workouts?from=${today}&to=${window}`)).json());
    expect(list.items.length).toBeGreaterThan(0);
    for (const item of list.items) {
      expect(item.sink.status).toBe("pushed");
      expect(item.sink.externalId).toBe(`${userId}:${item.id}:0`);
      expect(item.sink.eventId).not.toBeNull();
    }
    const events = [...h.fake.calendar.values()];
    expect(events.length).toBe(list.items.length);
    // Strength goes as WeightTraining with an exercise list, never as run steps.
    const strength = events.filter((e) => e.sport === "strength");
    for (const e of strength) expect(e.description.split("\n").some((l) => l.startsWith("-"))).toBe(false);
    // Nothing beyond 14 days was pushed.
    expect(events.every((e) => e.date <= window)).toBe(true);
  });

  let firstId = "";
  it("returns workout detail with explanation and device text", async () => {
    const list = WorkoutListResponse.parse((await req("GET", `/api/workouts?from=${today}&to=${addDays(today, 13)}`)).json());
    const run = list.items.find((i) => i.workout.type !== "STRENGTH") as (typeof list.items)[number];
    firstId = run.id;
    const res = await req("GET", `/api/workouts/${firstId}`);
    expect(res.statusCode).toBe(200);
    const detail = WorkoutDetailResponse.parse(res.json());
    expect(detail.explanation.length).toBeGreaterThan(0);
    expect(detail.deviceText).toBeTruthy();
    expect((await req("GET", "/api/workouts/not-a-uuid")).statusCode).toBe(404);
  });

  it("re-sends a workout with rev + 1", async () => {
    const res = await req("POST", `/api/workouts/${firstId}/resend`);
    expect(res.statusCode).toBe(200);
    const item = WorkoutItem.parse(res.json());
    expect(item.sink.externalId).toBe(`${userId}:${firstId}:1`);
    expect(item.sink.status).toBe("pushed");
    expect(h.fake.calendar.has(`${userId}:${firstId}:0`)).toBe(false);
    expect(h.fake.calendar.has(`${userId}:${firstId}:1`)).toBe(true);
  });

  it("nightly re-send restores workouts missing on read-back in the next 3 days", async () => {
    const soon = WorkoutListResponse.parse((await req("GET", `/api/workouts?from=${today}&to=${addDays(today, 2)}`)).json());
    if (soon.items.length === 0) return; // rest days only; nothing to check
    const victim = soon.items[0] as (typeof soon.items)[number];
    h.fake.calendar.delete(victim.sink.externalId as string);
    const r = await resendMissing(h.svc, userId);
    expect(r.resent).toBeGreaterThanOrEqual(1);
    const after = WorkoutItem.parse((await req("POST", `/api/workouts/${victim.id}/resend`)).json());
    expect(after.sink.status).toBe("pushed");
  });

  it("skips a workout and takes it off the watch", async () => {
    const res = await req("POST", `/api/workouts/${firstId}/skip`, { reason: "busy" });
    expect(res.statusCode).toBe(200);
    const body = CheckInResponse.parse(res.json());
    expect(body.planChanges[0]).toMatch(/^Skipped /);
    const detail = WorkoutDetailResponse.parse((await req("GET", `/api/workouts/${firstId}`)).json());
    expect(detail.item.status).toBe("skipped");
    expect(detail.item.sink.status).toBe("not_pushed");
    expect([...h.fake.calendar.keys()].some((k) => k.includes(firstId))).toBe(false);
  });

  it("records check-ins", async () => {
    const rpe = await req("POST", "/api/checkins", { type: "session_rpe", date: today, rpe: 5, minutes: 40 });
    expect(rpe.statusCode).toBe(200);
    expect(CheckInResponse.parse(rpe.json()).planChanges).toEqual([]);
    const ill = CheckInResponse.parse(
      (await req("POST", "/api/checkins", { type: "illness", date: today, aboveNeckOnly: false, fever: true })).json(),
    );
    expect(ill.advice.join(" ")).toMatch(/doctor/);
    const pain = CheckInResponse.parse(
      (await req("POST", "/api/checkins", { type: "pain", date: today, location: "left knee", duringRun: 4, nextMorning: null })).json(),
    );
    expect(pain.advice.join(" ")).toMatch(/easy/);
    const xt = await req("POST", "/api/checkins", { type: "cross_training", date: today, activity: "cycling", minutes: 45, rpe: 4 });
    expect(xt.statusCode).toBe(200);
  });

  it("uploads a FIT file", async () => {
    const fit = makeFitActivity({ start: new Date(`${addDays(today, -1)}T14:00:00Z`), distanceM: 6000, timerS: 2100, avgHr: 150, utcOffsetS: -4 * 3600 });
    const mp = multipartFile("file", "run.fit", fit);
    const res = await h.app.inject({ method: "POST", url: "/api/activities/upload", payload: mp.payload, headers: mp.headers, cookies: { paceo_session: cookie } });
    expect(res.statusCode).toBe(200);
    const a = ActivitySummary.parse(res.json());
    expect(a).toMatchObject({ source: "fit_upload", sport: "run", garminOrigin: true, localDate: addDays(today, -1) });
    // Same file again is idempotent.
    const again = await h.app.inject({ method: "POST", url: "/api/activities/upload", payload: mp.payload, headers: mp.headers, cookies: { paceo_session: cookie } });
    expect(again.json().id).toBe(a.id);
    const junk = multipartFile("file", "x.fit", Buffer.from("definitely not a FIT file"));
    const bad = await h.app.inject({ method: "POST", url: "/api/activities/upload", payload: junk.payload, headers: junk.headers, cookies: { paceo_session: cookie } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe("invalid_fit");
  });

  it("queues a manual sync", async () => {
    const res = await req("POST", "/api/sync");
    expect(res.json()).toMatchObject({ queued: true });
  });

  it("manages push subscriptions and sends today's workout", async () => {
    expect((await req("GET", "/api/push/vapid-public-key")).json()).toEqual({ publicKey: "BTestVapidPublicKey" });
    const sub = { endpoint: "https://push.example.com/abc", keys: { p256dh: "p", auth: "a" } };
    expect((await req("POST", "/api/push/subscriptions", sub)).statusCode).toBe(204);
    await createHandlers(h.svc)[JOB.notifyToday]?.({ userId });
    expect((await req("DELETE", "/api/push/subscriptions", { endpoint: sub.endpoint })).statusCode).toBe(204);
  });

  it("lets only the admin create invites, and isolates users", async () => {
    const inv = CreateInviteResponse.parse((await req("POST", "/api/admin/invites")).json());
    const reg = await req("POST", "/api/auth/register", { inviteCode: inv.code, email: "friend@example.com", password: "another-long-pw", displayName: "Friend" }, null);
    expect(User.parse(reg.json()).isAdmin).toBe(false);
    const friend = sessionCookie(reg);
    expect((await req("POST", "/api/admin/invites", undefined, friend)).statusCode).toBe(403);
    expect((await req("GET", `/api/workouts/${firstId}`, undefined, friend)).statusCode).toBe(404);
    expect((await req("POST", `/api/workouts/${firstId}/resend`, undefined, friend)).statusCode).toBe(404);
    const theirs = WorkoutListResponse.parse((await req("GET", "/api/workouts", undefined, friend)).json());
    expect(theirs.items).toEqual([]);
    expect(ActivityListResponse.parse((await req("GET", "/api/activities", undefined, friend)).json()).items).toEqual([]);
    expect(ConnectionStatus.parse((await req("GET", "/api/connections/intervals", undefined, friend)).json()).status).toBe("disconnected");
  });

  it("runs the nightly job without churning an unchanged plan", async () => {
    await createHandlers(h.svc)[JOB.nightlyUser]?.({ userId });
    expect(PlanResponse.parse((await req("GET", "/api/plan/current")).json()).planId).toBe(planId);
    const me = MeResponse.parse((await req("GET", "/api/me")).json());
    expect(me.onboardingComplete).toBe(true);
  });

  it("does not re-plan on a units-only change", async () => {
    const res = await req("PUT", "/api/profile", { ...profile(), units: "imperial" });
    expect(res.statusCode).toBe(200);
    expect(PlanResponse.parse((await req("GET", "/api/plan/current")).json()).planId).toBe(planId);
  });

  it("re-plans on a profile change", async () => {
    const res = await req("PUT", "/api/profile", { ...profile(), daysAvailable: ["tue", "wed", "thu", "sat", "sun"] });
    expect(res.statusCode).toBe(200);
    expect(PlanResponse.parse((await req("GET", "/api/plan/current")).json()).planId).not.toBe(planId);
  });

  it("disconnects and logs out", async () => {
    expect((await req("DELETE", "/api/connections/intervals")).statusCode).toBe(204);
    expect(ConnectionStatus.parse((await req("GET", "/api/connections/intervals")).json()).status).toBe("disconnected");
    expect((await req("POST", "/api/auth/logout")).statusCode).toBe(204);
    expect((await req("GET", "/api/me")).statusCode).toBe(401);
  });
});
