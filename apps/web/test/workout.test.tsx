import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import type { WorkoutItem } from "@paceo/contracts";
import { WorkoutBody } from "../src/components/WorkoutSteps";
import { WorkoutCard } from "../src/components/WorkoutCard";
import { toViewWorkout, typeLabel, flattenSteps } from "../src/lib/workout";
import { renderWithProviders, STRENGTH_WORKOUT, T_WORKOUT } from "./helpers";

function item(workout: Record<string, unknown>, extra: Partial<WorkoutItem> = {}): WorkoutItem {
  return {
    id: String(workout.id),
    date: String(workout.date),
    workout: workout as WorkoutItem["workout"],
    status: "planned",
    matchedActivity: null,
    sink: { provider: "intervals_icu", externalId: "x", eventId: "e", lastPushedAt: "2026-11-16T08:00:00Z", status: "pushed" },
    ...extra,
  };
}

describe("workout steps: T workout", () => {
  it("renders warm-up, a 4 × repeat with pace targets, and cool-down in metric", () => {
    render(<WorkoutBody w={toViewWorkout(T_WORKOUT)} units="metric" hrMax={190} />);
    expect(screen.getByText("4 ×")).toBeInTheDocument();
    const steps = screen.getAllByTestId("step");
    expect(steps).toHaveLength(4); // warmup, work, recovery, cooldown (repeat renders its inner steps once)
    expect(steps[0]).toHaveTextContent("Warm-up");
    expect(steps[0]).toHaveTextContent("65–79% HRmax (124–150 bpm)");
    expect(steps[0]).toHaveTextContent("15 min");
    expect(steps[1]).toHaveTextContent("Work");
    expect(steps[1]).toHaveTextContent("6:07–5:50 /km");
    expect(steps[1]).toHaveTextContent("or 88–92% HRmax");
    expect(steps[1]).toHaveTextContent("RPE 7–8");
    expect(steps[1]).toHaveTextContent("8 min");
    expect(steps[2]).toHaveTextContent("Recovery");
    expect(steps[3]).toHaveTextContent("Cool-down");
  });

  it("shows target paces in the user's units (imperial)", () => {
    render(<WorkoutBody w={toViewWorkout(T_WORKOUT)} units="imperial" />);
    expect(screen.getByText("9:51–9:23 /mi")).toBeInTheDocument();
    expect(screen.queryByText(/\/km/)).not.toBeInTheDocument();
  });

  it("unrolls repeats for follow-in-app mode", () => {
    const flat = flattenSteps(toViewWorkout(T_WORKOUT).steps);
    expect(flat).toHaveLength(1 + 4 * 2 + 1);
    expect(flat[1]?.repLabel).toBe("Rep 1 of 4");
    expect(flat[8]?.repLabel).toBe("Rep 4 of 4");
  });

  it("renders the full card with sync status and why-this-workout", () => {
    renderWithProviders(<WorkoutCard item={item(T_WORKOUT)} units="metric" />);
    const card = screen.getByTestId("workout-card");
    expect(within(card).getByText("Threshold")).toBeInTheDocument();
    expect(within(card).getByText("Key session")).toBeInTheDocument();
    expect(within(card).getByText("Cruise intervals 4 × 8 min @ T")).toBeInTheDocument();
    expect(within(card).getByText("10.5 km · 1 h 2 min")).toBeInTheDocument();
    expect(within(card).getByText("On your watch calendar")).toBeInTheDocument();
    expect(within(card).getByRole("button", { name: "Re-send to watch" })).toBeInTheDocument();
    expect(within(card).getByText("Why this workout")).toBeInTheDocument();
    expect(within(card).getByRole("button", { name: "Done" })).toBeInTheDocument();
  });

  it("shows Garmin attribution for a Garmin-origin matched activity", () => {
    const activity = {
      id: "a1",
      source: "intervals_icu" as const,
      originPlatform: "garmin",
      startUtc: "2026-11-17T11:00:00Z",
      localDate: "2026-11-17",
      sport: "Run",
      distanceM: 10600,
      movingS: 3700,
      avgHr: 152,
      isRace: false,
      name: "Morning run",
      garminOrigin: true,
    };
    renderWithProviders(<WorkoutCard item={item(T_WORKOUT, { status: "completed", matchedActivity: activity })} units="metric" />);
    expect(screen.getByText(/Garmin · data recorded on a Garmin device/)).toBeInTheDocument();
    expect(screen.getByText("Done")).toBeInTheDocument();
  });
});

describe("workout steps: strength workout", () => {
  it("renders exercises with sets × reps, RPE, loads and cues", () => {
    const w = toViewWorkout(STRENGTH_WORKOUT);
    expect(w.exercises).toHaveLength(3); // the malformed entry is dropped
    render(<WorkoutBody w={w} units="imperial" />);
    const ex = screen.getAllByTestId("exercise");
    expect(ex).toHaveLength(3);
    expect(ex[0]).toHaveTextContent("Heavy goblet squat");
    expect(ex[0]).toHaveTextContent("3 × 6–8 @ RPE 7");
    expect(ex[0]).toHaveTextContent("55 lb");
    expect(ex[0]).toHaveTextContent("Chest up");
    expect(ex[1]).toHaveTextContent("3 × 12");
    expect(ex[2]).toHaveTextContent("Side plank");
    expect(screen.queryByTestId("step")).not.toBeInTheDocument();
  });

  it("strength cards skip the watch sync controls", () => {
    renderWithProviders(<WorkoutCard item={item(STRENGTH_WORKOUT)} units="metric" />);
    expect(screen.getByText("Strength")).toBeInTheDocument();
    expect(screen.queryByTestId("sync-status")).not.toBeInTheDocument();
    expect(screen.getAllByTestId("exercise")).toHaveLength(3);
  });
});

describe("unknown workout types", () => {
  it("render gracefully with a humanised label", () => {
    const odd = { id: "m1", date: "2026-11-19", sport: "mobility", type: "MOBILITY_FLOW", name: "Mobility", steps: [{ kind: "teleport" }], planned: { run_m: 0, minutes: 20 } };
    expect(typeLabel("MOBILITY_FLOW")).toBe("Mobility flow");
    renderWithProviders(<WorkoutCard item={item(odd)} units="metric" />);
    expect(screen.getByText("Mobility flow")).toBeInTheDocument();
    expect(screen.getByText(/No structured steps/)).toBeInTheDocument();
    expect(screen.getByText(/1 step\(s\) use a format/)).toBeInTheDocument();
    expect(screen.queryByTestId("sync-status")).not.toBeInTheDocument();
  });
});
