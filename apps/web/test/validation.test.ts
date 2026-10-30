import { describe, expect, it } from "vitest";
import { applyAlternative, defaultProfileDraft, emptyHealth, profileFromDraft, type WizardDraft } from "../src/onboarding/draft";
import { STEP_IDS, isStepValid, validateStep } from "../src/onboarding/validation";

const TODAY = "2026-11-02";

function validDraft(): WizardDraft {
  const profile = {
    ...defaultProfileDraft(),
    units: "metric" as const,
    timezone: "America/Toronto",
    experienceLevel: "intermediate" as const,
    monthsRunning: 24,
    currentWeeklyKm: 35,
    longestRunKm: 14,
    longestRunMinutes: 85,
    canRun20MinContinuous: true,
    goalType: "race" as const,
    distance: "half" as const,
    raceDate: "2027-02-28",
    watchBrand: "garmin" as const,
  };
  return {
    version: 1,
    step: 0,
    profile,
    health: { answers: [false, false, false, false, false, false, false], pregnantOrPostpartum: false, recentSeriousInjuryOrSurgery: false, clearanceConfirmed: false },
    screening: { outcome: "ok", canProceed: true, notes: [], screenedAt: "2026-11-02T12:00:00Z" },
    connect: { connected: true, skipped: false },
    appliedAlternative: null,
  };
}

const ctx = { today: TODAY };

describe("wizard step validation", () => {
  it("accepts a complete draft on every step", () => {
    const d = validDraft();
    for (const step of STEP_IDS) expect(validateStep(step, d, ctx), step).toEqual({});
    expect(profileFromDraft(d.profile).ok).toBe(true);
  });

  it("health: requires every answer, then a screening that allows proceeding", () => {
    const d = validDraft();
    expect(validateStep("health", { ...d, health: emptyHealth() }, ctx)).toHaveProperty("answers");
    expect(validateStep("health", { ...d, screening: null }, ctx)).toHaveProperty("screening");
    const blocked = { ...d, screening: { outcome: "see_doctor" as const, canProceed: false, notes: [], screenedAt: "2026-11-02T12:00:00Z" } };
    expect(validateStep("health", blocked, ctx).screening).toMatch(/clearance/i);
    const cleared = { ...d, screening: { outcome: "cleared" as const, canProceed: true, notes: [], screenedAt: "2026-11-02T12:00:00Z" } };
    expect(isStepValid("health", cleared, ctx)).toBe(true);
  });

  it("connect: needs a brand and either a connection or an explicit skip", () => {
    const d = validDraft();
    expect(validateStep("connect", { ...d, profile: { ...d.profile, watchBrand: null } }, ctx)).toHaveProperty("watchBrand");
    expect(validateStep("connect", { ...d, connect: { connected: false, skipped: false } }, ctx)).toHaveProperty("connection");
    expect(isStepValid("connect", { ...d, connect: { connected: false, skipped: true } }, ctx)).toBe(true);
  });

  it("profile: range checks and cross-field rules from §2.3", () => {
    const d = validDraft();
    const p = d.profile;
    expect(validateStep("profile", { ...d, profile: { ...p, experienceLevel: null } }, ctx)).toHaveProperty("experienceLevel");
    expect(validateStep("profile", { ...d, profile: { ...p, currentWeeklyKm: 300 } }, ctx)).toHaveProperty("currentWeeklyKm");
    expect(validateStep("profile", { ...d, profile: { ...p, longestRunKm: 46 } }, ctx)).toHaveProperty("longestRunKm");
    expect(validateStep("profile", { ...d, profile: { ...p, longestRunKm: 40, currentWeeklyKm: 30 } }, ctx).longestRunKm).toMatch(/weekly volume/);
    expect(validateStep("profile", { ...d, profile: { ...p, canRun20MinContinuous: null } }, ctx)).toHaveProperty("canRun20MinContinuous");
    expect(validateStep("profile", { ...d, profile: { ...p, birthYear: 2010 } }, ctx).birthYear).toMatch(/18\+/);
    expect(validateStep("profile", { ...d, profile: { ...p, hrMax: 230 } }, ctx)).toHaveProperty("hrMax");
    const badResult = { ...p, hasRecentResult: true, recentResult: { distanceM: 1000, timeS: null, date: "2027-01-01", kind: "race" as const } };
    const e = validateStep("profile", { ...d, profile: badResult }, ctx);
    expect(Object.keys(e).sort()).toEqual(["recentDate", "recentDistance", "recentTime"]);
  });

  it("goal: race date must be in the future; general fitness minutes 60–600", () => {
    const d = validDraft();
    expect(validateStep("goal", { ...d, profile: { ...d.profile, raceDate: "" } }, ctx)).toHaveProperty("raceDate");
    expect(validateStep("goal", { ...d, profile: { ...d.profile, raceDate: TODAY } }, ctx)).toHaveProperty("raceDate");
    const gf = { ...d.profile, goalType: "general_fitness" as const, targetWeeklyMinutes: 30 };
    expect(validateStep("goal", { ...d, profile: gf }, ctx)).toHaveProperty("targetWeeklyMinutes");
    expect(isStepValid("goal", { ...d, profile: { ...gf, targetWeeklyMinutes: null } }, ctx)).toBe(true);
  });

  it("schedule: 3+ days for a race (2+ for general), long-run day inside the days", () => {
    const d = validDraft();
    expect(validateStep("schedule", { ...d, profile: { ...d.profile, daysAvailable: ["tue", "sun"] } }, ctx)).toHaveProperty("daysAvailable");
    const gf = { ...d.profile, goalType: "general_fitness" as const, daysAvailable: ["tue" as const, "sun" as const] };
    expect(isStepValid("schedule", { ...d, profile: gf }, ctx)).toBe(true);
    expect(validateStep("schedule", { ...d, profile: { ...d.profile, longRunDay: "mon" } }, ctx)).toHaveProperty("longRunDay");
    expect(validateStep("schedule", { ...d, profile: { ...d.profile, maxMinutesByDay: { tue: 10 } } }, ctx)).toHaveProperty("max_tue");
  });

  it("cross-training: each entry needs days, 5–600 min and RPE 1–10", () => {
    const d = validDraft();
    const bad = { activity: "", days: [], typicalMinutes: 2, typicalSrpe: 11, locked: false };
    const e = validateStep("cross", { ...d, profile: { ...d.profile, crossTraining: [bad] } }, ctx);
    expect(Object.keys(e).sort()).toEqual(["xt_0_activity", "xt_0_days", "xt_0_minutes", "xt_0_srpe"]);
  });

  it("review: a blocked feasibility stops the wizard", () => {
    const d = validDraft();
    expect(validateStep("review", d, { today: TODAY, feasibilityStatus: "block" })).toHaveProperty("feasibility");
    expect(isStepValid("review", d, { today: TODAY, feasibilityStatus: "warn" })).toBe(true);
  });
});

describe("applyAlternative (§6.2)", () => {
  it("applies each alternative kind to the draft", () => {
    const p = { ...validDraft().profile, goalTimeS: 6000 };
    expect(applyAlternative(p, { kind: "later_date", rank: 1, message: "", raceDate: "2027-04-04" }).raceDate).toBe("2027-04-04");
    expect(applyAlternative(p, { kind: "shorter_distance", rank: 2, message: "", distance: "10k" }).distance).toBe("10k");
    expect(applyAlternative(p, { kind: "finish_goal", rank: 3, message: "" }).goalTimeS).toBeNull();
    expect(applyAlternative(p, { kind: "slower_goal", rank: 3, message: "", goalTimeS: 6300 }).goalTimeS).toBe(6300);
    expect(applyAlternative(p, { kind: "base_block", rank: 3, message: "", baseWeeks: 8 }).goalType).toBe("general_fitness");
  });
});
