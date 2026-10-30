import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ActivityListResponse,
  CheckInResponse,
  ConnectionStatus,
  CreateInviteResponse,
  HealthScreenResponse,
  MeResponse,
  PlanPreviewResponse,
  PlanResponse,
  Profile,
  SyncResponse,
  TestWorkoutResponse,
  User,
  VapidKeyResponse,
  WorkoutDetailResponse,
  WorkoutItem,
  WorkoutListResponse,
} from "@paceo/contracts";
import { PlannedWorkoutSchema, addDays } from "@paceo/engine";
import { buildDemoData, demoConnection, demoScreening, demoUser, detailFor, disconnectedConnection, meFor, sampleCheckIns, sundayAfter } from "../src/mock/fixtures";
import { localToday } from "../src/lib/dates";
import { mockTransport, resetMock } from "../src/mock/server";
import { api, ApiError, setTransport, fetchTransport } from "../src/api/client";

const TODAY = "2026-11-02";
const NOW = new Date("2026-11-02T14:00:00Z");

describe("mock fixtures parse against the contract schemas", () => {
  const data = buildDemoData(TODAY, NOW);

  it("profile, me, connection, screening", () => {
    expect(() => Profile.parse(data.profile)).not.toThrow();
    expect(() => User.parse(demoUser)).not.toThrow();
    expect(() => MeResponse.parse(meFor(demoUser, data.profile, demoScreening(NOW), demoConnection(NOW), true))).not.toThrow();
    expect(() => MeResponse.parse(meFor(demoUser, null, null, disconnectedConnection, false))).not.toThrow();
    expect(() => ConnectionStatus.parse(demoConnection(NOW))).not.toThrow();
    expect(() => HealthScreenResponse.parse(demoScreening(NOW))).not.toThrow();
    for (const r of Object.values(sampleCheckIns)) expect(() => CheckInResponse.parse(r)).not.toThrow();
  });

  it("plan response is an engine plan with weeks", () => {
    const parsed = PlanResponse.parse(data.plan);
    expect(parsed.plan.weeks.length).toBeGreaterThan(4);
    expect(parsed.plan.feasibility.status).not.toBe("block");
  });

  it("workout items, details and activities", () => {
    const list = WorkoutListResponse.parse({ items: data.workouts });
    expect(list.items.length).toBeGreaterThan(10);
    for (const item of data.workouts) {
      expect(() => WorkoutItem.parse(item)).not.toThrow();
      expect(() => WorkoutDetailResponse.parse(detailFor(item))).not.toThrow();
      const w = item.workout as Record<string, unknown>;
      // Engine-generated workouts (runs and strength) also satisfy the engine's own DSL schema.
      if (w.type !== "MOBILITY") expect(PlannedWorkoutSchema.safeParse(w).success, String(w.id)).toBe(true);
    }
    expect(() => ActivityListResponse.parse({ items: data.activities })).not.toThrow();
    expect(data.activities.some((a) => a.garminOrigin)).toBe(true);
    expect(data.workouts.some((w) => (w.workout as Record<string, unknown>).type === "STRENGTH")).toBe(true);
    expect(data.workouts.some((w) => w.sink.status === "missing_on_readback")).toBe(true);
  });
});

describe("mock backend responses parse against the contract schemas", () => {
  beforeEach(() => {
    resetMock();
    setTransport((req) => mockTransport(req, { latencyMs: 0 }));
  });
  afterEach(() => {
    resetMock();
    setTransport(fetchTransport);
  });

  it("rejects unauthenticated calls with an ErrorBody", async () => {
    await expect(api.me()).rejects.toMatchObject({ status: 401, code: "unauthorized" });
  });

  it("walks the demo user's main routes", async () => {
    User.parse(await api.login({ email: "demo@paceo.run", password: "x" }));
    const me = MeResponse.parse(await api.me());
    expect(me.onboardingComplete).toBe(true);
    const today = localToday();
    PlanResponse.parse(await api.planCurrent());
    const list = WorkoutListResponse.parse(await api.workouts(addDays(today, -400), addDays(today, 400)));
    const first = list.items[0];
    expect(first).toBeDefined();
    WorkoutDetailResponse.parse(await api.workout(first!.id));
    WorkoutItem.parse(await api.resendWorkout(first!.id));
    CheckInResponse.parse(await api.skipWorkout(first!.id, { reason: "busy" }));
    ActivityListResponse.parse(await api.activities(addDays(today, -400), addDays(today, 400)));
    ConnectionStatus.parse(await api.connectionStatus());
    SyncResponse.parse(await api.sync());
    VapidKeyResponse.parse(await api.vapidKey());
    CreateInviteResponse.parse(await api.createInvite());
    TestWorkoutResponse.parse(await api.testWorkout());
    PlanPreviewResponse.parse(await api.planPreview(me.profile!));
    for (const body of [
      { type: "illness" as const, date: TODAY, aboveNeckOnly: false, fever: true },
      { type: "pain" as const, date: TODAY, location: "Achilles", duringRun: 6, nextMorning: null },
      { type: "cross_training" as const, date: TODAY, activity: "cycling", minutes: 60, rpe: 5 },
      { type: "session_rpe" as const, date: TODAY, rpe: 5, minutes: 40 },
    ]) {
      const r = CheckInResponse.parse(await api.checkIn(body));
      if (body.type === "illness") expect(r.planChanges.length).toBeGreaterThan(0);
    }
  });

  it("covers onboarding: register, screen, connect error states, generate", async () => {
    await expect(api.register({ inviteCode: "EXPIRED", email: "a@b.co", password: "0123456789", displayName: "A" })).rejects.toMatchObject({ code: "invite_invalid" });
    User.parse(await api.register({ inviteCode: "FRIEND", email: "new@paceo.run", password: "0123456789", displayName: "New" }));
    expect(MeResponse.parse(await api.me()).onboardingComplete).toBe(false);

    const yes = HealthScreenResponse.parse(
      await api.healthScreen({ answers: [true, false, false, false, false, false, false], pregnantOrPostpartum: false, recentSeriousInjuryOrSurgery: false }),
    );
    expect(yes).toMatchObject({ outcome: "see_doctor", canProceed: false });
    const cleared = HealthScreenResponse.parse(
      await api.healthScreen({ answers: [true, false, false, false, false, false, false], pregnantOrPostpartum: false, recentSeriousInjuryOrSurgery: false, clearanceConfirmed: true }),
    );
    expect(cleared).toMatchObject({ outcome: "cleared", canProceed: true });

    const bad = await api.connectIntervals({ apiKey: "bad-key-123456" }).catch((e: unknown) => e);
    expect(bad).toBeInstanceOf(ApiError);
    expect((bad as ApiError).code).toBe("key_rejected");
    expect(ConnectionStatus.parse(await api.connectIntervals({ apiKey: "busy-key-123456" })).status).toBe("rate_limited");
    expect(ConnectionStatus.parse(await api.connectIntervals({ apiKey: "empty-key-123456" })).activityCounts).toEqual({});

    expect(await api.planCurrent()).toBeNull();
    const profile = buildDemoData(TODAY, NOW).profile;
    Profile.parse(await api.putProfile({ ...profile, goal: { type: "race", distance: "10k", raceDate: sundayAfter(localToday(), 12), goalTimeS: null } }));
    PlanResponse.parse(await api.planGenerate());
    expect(MeResponse.parse(await api.me()).onboardingComplete).toBe(true);
  });
});
