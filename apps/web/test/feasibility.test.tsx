import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Feasibility } from "@paceo/engine";
import { checkFeasibility } from "@paceo/engine";
import { FeasibilityPanel } from "../src/components/Feasibility";

const WARN: Feasibility = {
  status: "block",
  reasons: [
    { code: "goal_edge", status: "info", message: "Goal needs +1.2 VDOT." },
    { code: "min_weeks", status: "block", message: "A marathon needs at least 12 weeks; you have 8." },
    { code: "reachability", status: "warn", message: "Long runs can only reach 78% of the target." },
  ],
  alternatives: [
    { kind: "shorter_distance", rank: 2, distance: "half", message: "Race a half on the same date." },
    { kind: "later_date", rank: 1, raceDate: "2027-03-07", message: "Race on 2027-03-07 instead." },
    { kind: "base_block", rank: 3, baseWeeks: 8, message: "Build a base for 8 weeks first, then re-check." },
  ],
  reach: { peakLongRunKm: 22, l1TargetKm: 28, ratio: 0.78 },
};

describe("feasibility alternatives rendering", () => {
  it("shows the status, block/warn reasons first, and alternatives in rank order", () => {
    render(<FeasibilityPanel feasibility={WARN} onPick={() => undefined} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Not safe as set");
    const reasons = within(screen.getByRole("list", { name: "Reasons" })).getAllByRole("listitem");
    expect(reasons.map((r) => r.textContent)).toEqual([
      expect.stringContaining("at least 12 weeks"),
      expect.stringContaining("78%"),
      expect.stringContaining("+1.2 VDOT"),
    ]);
    const alts = screen.getAllByTestId("alternative");
    expect(alts).toHaveLength(3);
    expect(alts[0]).toHaveTextContent("#1 · Later race");
    expect(alts[1]).toHaveTextContent("#2 · Shorter distance");
    expect(alts[1]).toHaveTextContent("Half marathon on the same date");
    expect(alts[2]).toHaveTextContent("#3 · Build a base first");
  });

  it("lets the user pick an alternative and marks the applied one", async () => {
    const onPick = vi.fn();
    const { rerender } = render(<FeasibilityPanel feasibility={WARN} onPick={onPick} />);
    const second = screen.getAllByTestId("alternative")[1]!;
    await userEvent.click(within(second).getByRole("button", { name: "Use this" }));
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ kind: "shorter_distance", distance: "half" }));
    rerender(<FeasibilityPanel feasibility={WARN} onPick={onPick} selectedKind="shorter_distance" />);
    const applied = screen.getAllByTestId("alternative")[1]!;
    expect(applied).toHaveTextContent("Applied");
    expect(within(applied).getByRole("button", { name: "Using this" })).toBeDisabled();
  });

  it("renders a real engine result for an infeasible marathon", () => {
    const f = checkFeasibility({
      level: "novice",
      runDays: 4,
      longRunDay: "sun",
      today: "2026-11-02",
      raceDate: "2026-12-27",
      goal: { distance: "marathon" },
      currentWeeklyKm: 20,
      longestRun30d: { km: 8, minutes: 50 },
      vdotStatus: "none",
      injuryFlag: false,
      heavyCrossTraining: false,
      longRunMode: "daniels",
      canRun20MinContinuous: true,
      monthsRunning: 8,
    });
    expect(f.status).not.toBe("ok");
    render(<FeasibilityPanel feasibility={f} onPick={() => undefined} />);
    expect(screen.getAllByTestId("alternative").length).toBeGreaterThan(0);
  });
});
