import { describe, expect, it } from "vitest";
import {
  formatDuration,
  formatPace,
  formatPaceRange,
  stepsToIntervalsText,
  toIntervalsEvent,
  PlannedWorkoutSchema,
} from "../src/index.js";

describe("units (spec §5)", () => {
  it("formats pace in metric and imperial", () => {
    expect(formatPace(375.4)).toBe("6:15 /km");
    expect(formatPace(375.4, "imperial")).toBe("10:04 /mi");
  });

  it("rounds ranges outward so they never narrow", () => {
    expect(formatPaceRange({ fast: 349.6, slow: 366.6 })).toBe("6:07–5:49 /km");
  });

  it("formats durations", () => {
    expect(formatDuration(15840)).toBe("4:24:00");
    expect(formatDuration(1196)).toBe("19:56");
  });
});

describe("intervals.icu workout text (spec §3.7, syntax unverified)", () => {
  const workout = PlannedWorkoutSchema.parse({
    id: "wk-1",
    user_id: "u1",
    date: "2026-11-17",
    sport: "run",
    type: "T",
    name: "Cruise intervals 4 × 8 min @ T",
    prescription_mode: "pace",
    steps: [
      { kind: "warmup", duration: { type: "time", s: 900 }, target: { type: "hr_pct_max", lo: 65, hi: 79 } },
      {
        kind: "repeat",
        count: 4,
        steps: [
          { kind: "work", duration: { type: "time", s: 480 }, target: { type: "pace", lo_s_per_km: 350, hi_s_per_km: 367 } },
          { kind: "recovery", duration: { type: "time", s: 60 }, target: { type: "open" } },
        ],
      },
      { kind: "work", duration: { type: "distance", m: 400 }, target: { type: "pace", lo_s_per_km: 316, hi_s_per_km: 330 } },
      { kind: "cooldown", duration: { type: "time", s: 600 }, target: { type: "open" } },
    ],
    planned: { run_m: 10500, minutes: 62, expected_srpe: 6 },
  });

  it("compiles steps to builder text", () => {
    expect(stepsToIntervalsText(workout.steps)).toBe(
      [
        "- Warmup 15m 65-79% HR",
        "",
        "4x",
        "- 8m 6:07-5:50/km Pace",
        "- Recovery 1m",
        "",
        "- 400mtr 5:30-5:16/km Pace",
        "",
        "- Cooldown 10m",
      ].join("\n"),
    );
  });

  it("builds an events/bulk payload with a stable external_id", () => {
    const e = toIntervalsEvent(workout, 2);
    expect(e.external_id).toBe("u1:wk-1:2");
    expect(e.start_date_local).toBe("2026-11-17T00:00:00");
    expect(e.type).toBe("Run");
  });
});
