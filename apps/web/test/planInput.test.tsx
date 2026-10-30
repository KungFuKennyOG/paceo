import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { buildDemoData } from "../src/mock/fixtures";
import { clientPreview, deriveLevel, effectiveLevel, profileToPlanInput } from "../src/lib/planInput";
import { PlanSummaryStats } from "../src/components/PlanViews";

const TODAY = "2026-11-02";
const profile = buildDemoData(TODAY, new Date("2026-11-02T12:00:00Z")).profile;

describe("profile → engine input (client preview)", () => {
  it("derives the level as min(self-report, derived) (§2.3)", () => {
    expect(deriveLevel({ monthsRunning: 2, currentWeeklyKm: 20, canRun20MinContinuous: true })).toBe("beginner");
    expect(deriveLevel({ monthsRunning: 8, currentWeeklyKm: 20, canRun20MinContinuous: true })).toBe("novice");
    expect(effectiveLevel({ ...profile, experienceLevel: "advanced" })).toBe("intermediate");
  });

  it("passes strength, every cross-training entry and conservative mode", () => {
    const r = profileToPlanInput({ ...profile, crossTraining: [{ activity: "dragon boat", days: ["mon", "thu"], typicalMinutes: 90, typicalSrpe: 7, locked: false }] }, TODAY, {
      conservative: true,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.input.strength).toEqual({ mode: "running", equipment: "dumbbells", sessionsPerWeek: 2, liftingExperience: "novice" });
    expect(r.input.lockedEvents).toHaveLength(2);
    expect(r.input.lockedEvents?.[0]).toMatchObject({ weekday: "mon", activity: "dragon boat", minutes: 90, srpe: 7, locked: false });
    expect(r.input.conservative).toBe(true);
  });

  it("builds race plans with strength sessions and cross-training", () => {
    const r = clientPreview(profile, TODAY);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const all = r.preview.plan.weeks.flatMap((w) => w.workouts);
    expect(all.some((w) => w.sport === "strength" && (w.exercises?.length ?? 0) > 0)).toBe(true);
    expect(r.preview.plan.weeks.some((w) => (w.crossTraining ?? []).length > 0)).toBe(true);
  });

  it("previews general-fitness plans without a race countdown", () => {
    const gf = { ...profile, goal: { type: "general_fitness" as const, targetWeeklyMinutes: 240 } };
    const r = clientPreview(gf, TODAY);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.preview.plan.summary.mode).toBe("general_fitness");
    expect(r.preview.plan.weeks.length).toBeGreaterThan(0);
    render(<PlanSummaryStats plan={r.preview.plan} units="metric" today={TODAY} />);
    expect(screen.queryByTestId("countdown")).not.toBeInTheDocument();
    expect(screen.getByText("General fitness")).toBeInTheDocument();
  });
});
