/**
 * App ↔ engine follow-ups against real Postgres:
 * - laps (intervals.icu detail) and 1 Hz samples (original FIT) stored at sync and fed to replan;
 * - proposals: storage (dedupe, expiry), GET/POST routes, decline/accept through a replan, and a real
 *   R-MISS-4 realignment proposal accepted end to end;
 * - a units-only profile change creates no plan row;
 * - no morning push on a rest day.
 * Skipped when TEST_DATABASE_URL is unset.
 */
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addDays, weekdayIndex, type PlannedWorkout, type Proposal as EngineProposal } from "@paceo/engine";
import { ActivitySummary, PlanResponse, ProposalDecisionResponse, ProposalListResponse, type Profile } from "@paceo/contracts";
import { createInvite } from "../../src/services/auth.js";
import { localDate, localParts } from "../../src/lib/time.js";
import { loadReplanInputs, replanUser, storeProposals } from "../../src/services/plan.js";
import { dispatchDaily, notifyToday } from "../../src/jobs/handlers.js";
import { JOB } from "../../src/jobs/queue.js";
import { activitiesRepo, workoutsRepo } from "../../src/repo/index.js";
import { normalizeActivity } from "../../src/integrations/intervals/normalize.js";
import { IcuActivity } from "../../src/integrations/intervals/schemas.js";
import { makeFitRun } from "../helpers/fit.js";
import { GOOD_KEY, multipartFile, sessionCookie, startHarness, TEST_DATABASE_URL, type Harness } from "../helpers/integration.js";

const TZ = "America/Toronto";
const detailFixture = JSON.parse(readFileSync(new URL("../fixtures/intervals/activity-detail.json", import.meta.url), "utf8")) as Record<string, unknown>;

describe.skipIf(!TEST_DATABASE_URL)("engine follow-ups (Postgres)", () => {
  let h: Harness;
  const realNow = () => new Date();
  const today = localDate(new Date(), TZ);

  const req = (cookie: string, method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: unknown) =>
    h.app.inject({
      method,
      url,
      ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
      cookies: { paceo_session: cookie },
    });

  const profileFor = (base: string): Profile => ({
    units: "metric",
    timezone: TZ,
    experienceLevel: "intermediate",
    monthsRunning: 30,
    currentWeeklyKm: 35,
    longestRun30d: { km: 14, minutes: 85 },
    canRun20MinContinuous: true,
    recentResult: { distanceM: 10000, timeS: 50 * 60, date: addDays(base, -20), kind: "race" },
    birthYear: 1992,
    hrMax: 190,
    hrRest: 50,
    injury: "none",
    goal: { type: "race", distance: "half", raceDate: addDays(base, 7 * 16), goalTimeS: null },
    daysAvailable: ["tue", "thu", "sat", "sun"],
    longRunDay: "sun",
    maxMinutesByDay: {},
    longRunMode: "daniels",
    strength: { mode: "off", equipment: "bodyweight", sessionsPerWeek: 0, liftingExperience: "none" },
    crossTraining: [],
    watchBrand: "garmin",
  });

  async function onboard(email: string, base: string): Promise<{ cookie: string; userId: string }> {
    const { code } = await createInvite(h.svc.db, null, realNow());
    const reg = await h.app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { inviteCode: code, email, password: "a-long-password", displayName: email.split("@")[0] ?? "x" },
    });
    expect(reg.statusCode, reg.body).toBe(200);
    const cookie = sessionCookie(reg);
    const userId = (reg.json() as { id: string }).id;
    expect((await req(cookie, "PUT", "/api/profile", profileFor(base))).statusCode).toBe(200);
    const screen = await req(cookie, "POST", "/api/health-screen", {
      answers: [false, false, false, false, false, false, false],
      pregnantOrPostpartum: false,
      recentSeriousInjuryOrSurgery: false,
    });
    expect(screen.statusCode).toBe(200);
    return { cookie, userId };
  }

  beforeAll(async () => {
    h = await startHarness(TEST_DATABASE_URL as string);
  });

  afterAll(async () => {
    if (h) h.svc.clock = realNow;
    await h?.close();
  });

  // ── user A: synced activity detail ────────────────────────────────────────────────────────────
  let a = { cookie: "", userId: "" };
  const runDay = addDays(today, -2);
  const runStart = new Date(`${runDay}T15:00:00Z`);

  it("stores laps (intervals.icu detail) and samples (original FIT) when syncing a run", async () => {
    const listing = IcuActivity.parse({
      ...detailFixture,
      id: "i700",
      start_date_local: `${runDay}T11:00:00`,
      start_date: runStart.toISOString(),
      icu_intervals: undefined,
    });
    const detail = IcuActivity.parse({ ...detailFixture, id: "i700", start_date_local: `${runDay}T11:00:00`, start_date: runStart.toISOString() });
    h.fake.activities.push(normalizeActivity(listing)!);
    h.fake.details.set("i700", normalizeActivity(detail)!);
    h.fake.files.set("i700", makeFitRun({ start: runStart, seconds: 600, speedMps: 3.3, hr: 150, tempC: 22, lapStarts: [0, 300] }));

    a = await onboard("a@example.com", today);
    const conn = await req(a.cookie, "POST", "/api/connections/intervals", { apiKey: GOOD_KEY });
    expect(conn.statusCode, conn.body).toBe(200);

    const rows = await h.database.pool.query(
      "select s.laps_source, s.sample_count, s.laps, s.summary, octet_length(s.samples) as bytes from activity_streams s join activities a on a.id = s.activity_id where a.user_id = $1 and a.source_id = 'i700'",
      [a.userId],
    );
    expect(rows.rows).toHaveLength(1);
    const row = rows.rows[0] as { laps_source: string; sample_count: number; laps: unknown[]; summary: Record<string, unknown>; bytes: number };
    expect(row.laps_source).toBe("intervals_icu");
    expect(row.laps).toHaveLength(3);
    expect(row.sample_count).toBe(601);
    expect(row.bytes).toBeGreaterThan(0);
    expect(row.summary).toMatchObject({ maxHr: 156, environment: "outdoor", altitudeSource: "barometric" });
  });

  it("feeds the synced laps and samples (and profile HR) to the replanner", async () => {
    const gen = await req(a.cookie, "POST", "/api/plan/generate");
    expect(gen.statusCode, gen.body).toBe(200);
    const act = (await activitiesRepo.list(h.svc.db, a.userId, runDay, runDay)).find((r) => r.sourceId === "i700");
    expect(act).toBeDefined();
    const st = await loadReplanInputs(h.svc, a.userId);
    expect(st).not.toBeNull();
    const ea = st!.activities.find((x) => x.id === act!.id);
    expect(ea).toBeDefined();
    expect(ea!.laps?.map((l) => l.startS)).toEqual([0, 900, 1380]);
    expect(ea!.samples).toHaveLength(601);
    expect(ea!.samples?.[60]).toMatchObject({ t: 60, hr: expect.any(Number), tempC: 22 });
    expect(ea!.samples?.[60]?.distM).toBeCloseTo(198, 0);
    expect(ea).toMatchObject({ maxHr: 156, environment: "outdoor", altitudeSource: "barometric", elevationGainM: 42 });
    expect(st!.fitness).toMatchObject({ hrMax: 190, hrMaxSource: "measured", hrRest: 50 });
    // And the engine runs on it.
    expect(["replanned", "skipped"]).toContain(await replanUser(h.svc, a.userId));
  });

  it("stores device laps and samples for an uploaded FIT", async () => {
    const start = new Date(`${addDays(today, -1)}T14:00:00Z`);
    const mp = multipartFile("file", "run.fit", makeFitRun({ start, seconds: 400, speedMps: 3, hr: 140, lapStarts: [0, 100, 200, 300] }));
    const res = await h.app.inject({ method: "POST", url: "/api/activities/upload", payload: mp.payload, headers: mp.headers, cookies: { paceo_session: a.cookie } });
    expect(res.statusCode, res.body).toBe(200);
    const up = ActivitySummary.parse(res.json());
    const st = await loadReplanInputs(h.svc, a.userId);
    const ea = st!.activities.find((x) => x.id === up.id);
    expect(ea?.laps?.map((l) => l.startS)).toEqual([0, 100, 200, 300]);
    expect(ea?.samples).toHaveLength(401);
  });

  it("a units-only profile change creates no plan row", async () => {
    const count = async () => Number((await h.database.pool.query("select count(*)::int as n from plans where user_id = $1", [a.userId])).rows[0].n);
    const before = await count();
    const planId = PlanResponse.parse((await req(a.cookie, "GET", "/api/plan/current")).json()).planId;
    const res = await req(a.cookie, "PUT", "/api/profile", { ...profileFor(today), units: "imperial" });
    expect(res.statusCode).toBe(200);
    expect(await count()).toBe(before);
    expect(PlanResponse.parse((await req(a.cookie, "GET", "/api/plan/current")).json()).planId).toBe(planId);
    expect(h.queue.calls.filter((c) => c.name === JOB.replanUser && c.data.userId === a.userId)).toHaveLength(0);
  });

  // ── proposals: storage and routes ─────────────────────────────────────────────────────────────
  const vdot = (id: string): EngineProposal => ({
    id,
    kind: "vdot_change",
    rule: "FIT-UPDATE",
    message: "Speed up your paces by about 1.2%?",
    fromVdot: 45,
    toVdot: 45.6,
    steps: 1,
    pacePct: 1.2,
    evidence: ["x"],
  });
  const status = async (userId: string, id: string) =>
    (await h.database.pool.query("select status from proposals where user_id = $1 and id = $2", [userId, id])).rows[0]?.status as string | undefined;

  it("stores proposals once per id, expires superseded ones and re-opens re-emitted ones", async () => {
    await storeProposals(h.svc, a.userId, [vdot("vdot:+1:test"), vdot("vdot:+1:test")]);
    let list = ProposalListResponse.parse((await req(a.cookie, "GET", "/api/proposals")).json());
    expect(list.items.filter((p) => p.id === "vdot:+1:test")).toHaveLength(1);
    expect(list.items.find((p) => p.id === "vdot:+1:test")).toMatchObject({ kind: "vdot_change", status: "pending", respondedAt: null, details: { toVdot: 45.6 } });

    await storeProposals(h.svc, a.userId, []);
    expect(await status(a.userId, "vdot:+1:test")).toBe("expired");
    list = ProposalListResponse.parse((await req(a.cookie, "GET", "/api/proposals")).json());
    expect(list.items.some((p) => p.id === "vdot:+1:test")).toBe(false);

    await storeProposals(h.svc, a.userId, [{ ...vdot("vdot:+1:test"), message: "Updated" }]);
    expect(await status(a.userId, "vdot:+1:test")).toBe("pending");
    list = ProposalListResponse.parse((await req(a.cookie, "GET", "/api/proposals")).json());
    expect(list.items.find((p) => p.id === "vdot:+1:test")?.message).toBe("Updated");
  });

  it("declines through POST /api/proposals/:id; the decline is sent on later replans", async () => {
    await storeProposals(h.svc, a.userId, [vdot("vdot:-1:decline-me")]);
    const url = `/api/proposals/${encodeURIComponent("vdot:-1:decline-me")}`;
    expect((await req(a.cookie, "POST", url, { accept: "yes" })).statusCode).toBe(400);
    const res = await req(a.cookie, "POST", url, { accept: false });
    expect(res.statusCode, res.body).toBe(200);
    const body = ProposalDecisionResponse.parse(res.json());
    expect(body.advice.join(" ")).toMatch(/stays as it is/);
    expect(await status(a.userId, "vdot:-1:decline-me")).toBe("declined");
    const again = await req(a.cookie, "POST", url, { accept: true });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe("proposal_closed");
    expect((await req(a.cookie, "POST", `/api/proposals/${encodeURIComponent("nope:1")}`, { accept: true })).statusCode).toBe(404);

    const st = await loadReplanInputs(h.svc, a.userId);
    expect(st!.events).toContainEqual(expect.objectContaining({ type: "proposal_response", proposalId: "vdot:-1:decline-me", accept: false }));
    // Pending proposals the engine didn't emit again were expired by that replan.
    expect(ProposalListResponse.parse((await req(a.cookie, "GET", "/api/proposals")).json()).items.some((p) => p.id === "vdot:+1:test")).toBe(false);
  });

  it("isolates proposals between users", async () => {
    await storeProposals(h.svc, a.userId, [vdot("vdot:+1:mine")]);
    const other = await onboard("other@example.com", today);
    expect(ProposalListResponse.parse((await req(other.cookie, "GET", "/api/proposals")).json()).items).toEqual([]);
    expect((await req(other.cookie, "POST", `/api/proposals/${encodeURIComponent("vdot:+1:mine")}`, { accept: true })).statusCode).toBe(404);
  });

  // ── user B: a real R-MISS-4 realignment, accepted ─────────────────────────────────────────────
  let b = { cookie: "", userId: "" };
  // A Monday about three weeks back: the plan starts there, then half the runs are missed.
  const t0 = addDays(addDays(today, -21), -weekdayIndex(addDays(today, -21)));
  const at = (date: string, utcTime = "16:00:00") => () => new Date(`${date}T${utcTime}Z`);

  it("proposes realignment after missed sessions, and rebuilds when accepted", async () => {
    b = await onboard("b@example.com", t0);
    h.svc.clock = at(t0);
    const gen = await req(b.cookie, "POST", "/api/plan/generate");
    expect(gen.statusCode, gen.body).toBe(200);

    const planned = (await workoutsRepo.range(h.svc.db, b.userId, t0, addDays(t0, 13))).filter((r) => r.sport === "run");
    expect(planned.length, "runs planned in the first two weeks").toBeGreaterThanOrEqual(8);
    const missed: string[] = [];
    for (const [i, r] of planned.entries()) {
      if (i % 2 === 1) {
        missed.push(r.date);
        continue;
      }
      const w = r.workout as PlannedWorkout;
      await activitiesRepo.upsert(h.svc.db, b.userId, {
        source: "fit_upload",
        sourceId: `ran-${r.date}`,
        originPlatform: null,
        startUtc: new Date(`${r.date}T12:00:00Z`),
        localDate: r.date,
        sport: "run",
        distanceM: w.planned.run_m,
        movingS: w.planned.minutes * 60,
        elapsedS: w.planned.minutes * 60,
        avgHr: null,
        isRace: false,
        name: "Run",
        device: null,
        garminOrigin: false,
        stravaDerived: false,
        detail: null,
      });
    }
    expect(missed.length).toBeGreaterThanOrEqual(4);

    h.svc.clock = at(addDays(t0, 14));
    await replanUser(h.svc, b.userId);
    const list = ProposalListResponse.parse((await req(b.cookie, "GET", "/api/proposals")).json());
    const realign = list.items.find((p) => p.kind === "realign");
    expect(realign, `proposals: ${JSON.stringify(list.items)}; missed ${missed.join(",")}`).toBeDefined();
    expect(realign!.message).toMatch(/Rebuild/);

    const plansBefore = Number((await h.database.pool.query("select count(*)::int as n from plans where user_id = $1", [b.userId])).rows[0].n);
    const res = await req(b.cookie, "POST", `/api/proposals/${encodeURIComponent(realign!.id)}`, { accept: true });
    expect(res.statusCode, res.body).toBe(200);
    const body = ProposalDecisionResponse.parse(res.json());
    expect(body.planChanges.join(" ")).toMatch(/Rebuilt your plan/);
    const plans = await h.database.pool.query("select reason from plans where user_id = $1 order by created_at", [b.userId]);
    expect(plans.rows).toHaveLength(plansBefore + 1);
    expect(plans.rows.at(-1)?.reason).toBe("replan_proposal");
    expect(await status(b.userId, realign!.id)).toBe("accepted");

    // The next nightly doesn't bring the answered proposal back.
    await replanUser(h.svc, b.userId);
    expect(await status(b.userId, realign!.id)).toBe("accepted");
    expect(ProposalListResponse.parse((await req(b.cookie, "GET", "/api/proposals")).json()).items.some((p) => p.id === realign!.id)).toBe(false);
  });

  // ── morning push: quiet on rest days ──────────────────────────────────────────────────────────
  it("sends no morning push (and queues no job) on a rest day", async () => {
    const from = addDays(t0, 15);
    const rows = await workoutsRepo.range(h.svc.db, b.userId, from, addDays(from, 20));
    const busy = new Set(rows.map((r) => r.date));
    const runDate = rows.find((r) => r.sport === "run" && r.status === "planned")?.date;
    let restDate: string | undefined;
    for (let i = 0; i <= 20 && !restDate; i++) if (!busy.has(addDays(from, i))) restDate = addDays(from, i);
    expect(runDate).toBeDefined();
    expect(restDate).toBeDefined();

    const sub = { endpoint: "https://push.example.com/b", keys: { p256dh: "p", auth: "a" } };
    expect((await req(b.cookie, "POST", "/api/push/subscriptions", sub)).statusCode).toBe(204);
    const sentToB = () => h.push.sent.filter((s) => s.endpoint === sub.endpoint).length;
    const morningJobsForB = () => h.queue.calls.filter((c) => c.name === JOB.notifyToday && c.data.userId === b.userId).length;

    for (const [date, expectPush] of [
      [restDate!, false],
      [runDate!, true],
    ] as const) {
      const clock = at(date, "16:05:00");
      h.svc.clock = clock;
      h.svc.config.morningPushHour = localParts(clock(), TZ).hour;
      const pushes = sentToB();
      const jobs = morningJobsForB();
      expect(await notifyToday(h.svc, b.userId), date).toBe(expectPush ? 1 : 0);
      await dispatchDaily(h.svc);
      expect(morningJobsForB() - jobs, `morning job on ${date}`).toBe(expectPush ? 1 : 0);
      expect(sentToB() - pushes, `pushes on ${date}`).toBe(expectPush ? 2 : 0);
    }
    h.svc.clock = realNow;
  });
});
