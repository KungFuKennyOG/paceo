import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ActivitySample } from "@paceo/engine";
import {
  altitudeSourceOf,
  buildStreams,
  decodeSamples,
  encodeSamples,
  environmentOf,
  lapsFromIntervalsIcu,
  looksLikeRace,
} from "../../src/plan/activity-streams.js";
import { parseFitStreams } from "../../src/integrations/fit/parse.js";
import { normalizeActivity } from "../../src/integrations/intervals/normalize.js";
import { IcuActivity } from "../../src/integrations/intervals/schemas.js";
import { toEngineActivity, toFitnessState } from "../../src/plan/replan-state.js";
import { morningWorkout } from "../../src/jobs/handlers.js";
import type { PlannedWorkoutRow } from "../../src/repo/index.js";
import { makeFitActivity, makeFitRun } from "../helpers/fit.js";

const detail = JSON.parse(readFileSync(new URL("../fixtures/intervals/activity-detail.json", import.meta.url), "utf8")) as unknown;
const start = new Date("2026-10-27T11:00:00Z");

describe("laps from the intervals.icu detail (GET /activity/{id}?intervals=true)", () => {
  it("maps icu_intervals to engine laps, sorted, skipping unusable entries", () => {
    expect(lapsFromIntervalsIcu(detail)).toEqual([
      { startS: 0, durationS: 898, distanceM: 2350.5, avgHr: 138 },
      { startS: 900, durationS: 480, distanceM: 1650.2, avgHr: 168 },
      { startS: 1380, durationS: 60, distanceM: 120, avgHr: 150 },
    ]);
    expect(lapsFromIntervalsIcu({})).toEqual([]);
    expect(lapsFromIntervalsIcu(null)).toEqual([]);
    expect(lapsFromIntervalsIcu({ icu_intervals: [{ start_time: 5, end_time: 65 }] })).toEqual([{ startS: 5, durationS: 60, distanceM: 0 }]);
  });
});

describe("FIT laps and samples", () => {
  const fit = makeFitRun({ start, seconds: 600, speedMps: 3.2, hr: 140, tempC: 24, lapStarts: [0, 200, 400] });

  it("reads 1 Hz samples with distance, altitude, speed, HR and temperature", () => {
    const s = parseFitStreams(fit);
    expect(s.samples.length).toBe(601);
    expect(s.samples[0]).toMatchObject({ t: 0, distM: 0, hr: 140, tempC: 24 });
    expect(s.samples[100]?.distM).toBeCloseTo(320, 0);
    expect(s.samples[100]?.speedMps).toBeCloseTo(3.2, 1);
    expect(s.samples[100]?.altM).toBeDefined();
    expect(s.hasAltitude).toBe(true);
    expect(s.maxHr).toBe(146);
    expect(s.elevationGainM).toBe(42);
    expect(s.manufacturer).toBe("garmin");
  });

  it("reads device laps relative to the start", () => {
    const s = parseFitStreams(fit);
    expect(s.laps.map((l) => l.startS)).toEqual([0, 200, 400]);
    expect(s.laps[1]).toMatchObject({ durationS: 200, avgHr: 143 });
    expect(s.laps[1]?.distanceM).toBeCloseTo(640, 0);
  });

  it("copes with a minimal FIT (two records, no laps)", () => {
    const s = parseFitStreams(makeFitActivity({ start, distanceM: 5000, timerS: 1500, avgHr: 150, utcOffsetS: 0 }));
    expect(s.samples).toHaveLength(2);
    expect(s.laps).toEqual([]);
  });
});

describe("streams: build, store format, mapping", () => {
  it("prefers intervals.icu laps, falls back to FIT laps, and collects extras", () => {
    const fit = parseFitStreams(makeFitRun({ start, seconds: 300, speedMps: 3, hr: 150, lapStarts: [0, 150] }));
    const both = buildStreams(detail, fit);
    expect(both.lapsSource).toBe("intervals_icu");
    expect(both.laps).toHaveLength(3);
    expect(both.samples).toHaveLength(301);
    expect(both.summary).toEqual({ maxHr: 156, elevationGainM: 42, environment: "outdoor", altitudeSource: "barometric" });

    const fitOnly = buildStreams(null, fit);
    expect(fitOnly.lapsSource).toBe("fit");
    expect(fitOnly.laps.map((l) => l.startS)).toEqual([0, 150]);

    const detailOnly = buildStreams(detail, null);
    expect(detailOnly.samples).toEqual([]);
    expect(detailOnly.summary).toEqual({ maxHr: 178, elevationGainM: 61.2, environment: "outdoor", altitudeSource: "none" });
    expect(buildStreams(null, null)).toEqual({ laps: [], lapsSource: null, samples: [], summary: { environment: "outdoor", altitudeSource: "none" } });
  });

  it("environment and altitude source", () => {
    expect(environmentOf({ type: "VirtualRun" }, null)).toBe("treadmill");
    expect(environmentOf({ trainer: true }, null)).toBe("treadmill");
    expect(environmentOf(null, "treadmill")).toBe("treadmill");
    expect(environmentOf(null, "track")).toBe("track");
    expect(environmentOf({ type: "Run" }, "trail")).toBe("outdoor");
    expect(altitudeSourceOf({ hasAltitude: true, manufacturer: "garmin" })).toBe("barometric");
    expect(altitudeSourceOf({ hasAltitude: true, manufacturer: "development" })).toBe("gps");
    expect(altitudeSourceOf({ hasAltitude: false, manufacturer: "garmin" })).toBe("none");
  });

  it("round-trips samples through the compact block (rounded), including missing channels", () => {
    const samples: ActivitySample[] = [
      { t: 0, distM: 0, altM: 101.23, speedMps: 3.214, hr: 139, tempC: 21 },
      { t: 1, distM: 3.2, altM: 101.3, speedMps: 3.2, hr: 140 },
      { t: 2, hr: 141 },
      { t: 5, distM: 12.86, speedMps: 3.3 },
    ];
    const bytes = encodeSamples(samples);
    expect(bytes).not.toBeNull();
    expect(decodeSamples(bytes)).toEqual([
      { t: 0, distM: 0, altM: 101.2, speedMps: 3.21, hr: 139, tempC: 21 },
      { t: 1, distM: 3.2, altM: 101.3, speedMps: 3.2, hr: 140 },
      { t: 2, hr: 141 },
      { t: 5, distM: 12.9, speedMps: 3.3 },
    ]);
    expect(encodeSamples([])).toBeNull();
    expect(decodeSamples(null)).toEqual([]);
  });

  it("keeps an hour at 1 Hz compact", () => {
    const fit = parseFitStreams(makeFitRun({ start, seconds: 3600, speedMps: 3.1, hr: 145, tempC: 18 }));
    const bytes = encodeSamples(fit.samples) as Buffer;
    expect(fit.samples).toHaveLength(3601);
    expect(bytes.length).toBeLessThan(40_000);
    expect(decodeSamples(bytes)).toHaveLength(3601);
  });

  it("maps a stored activity + streams to the engine Activity", () => {
    const fit = parseFitStreams(makeFitRun({ start, seconds: 300, speedMps: 3, hr: 150, tempC: 26, subSport: "track" }));
    const built = buildStreams(detail, fit);
    const a = toEngineActivity(
      { id: "a1", localDate: "2026-10-27", sport: "run", distanceM: 900, movingS: 300, elapsedS: 310, avgHr: 153, isRace: false, name: "Cruise intervals" },
      built,
    );
    expect(a).toMatchObject({ id: "a1", sport: "run", avgHr: 153, maxHr: 156, isRace: false, environment: "track", altitudeSource: "barometric", elevationGainM: 42 });
    expect(a.laps).toHaveLength(3);
    expect(a.samples).toHaveLength(301);
    expect(a.samples?.[10]?.tempC).toBe(26);
    // Without streams: the summary-only mapping.
    expect(toEngineActivity({ id: "a2", localDate: "2026-10-27", sport: "run", distanceM: 5000, movingS: 1500, elapsedS: 1500, avgHr: null, isRace: false, name: "Parkrun" })).toEqual({
      id: "a2",
      date: "2026-10-27",
      sport: "run",
      distanceM: 5000,
      movingS: 1500,
      isRace: true,
    });
  });

  it("passes the profile's HRmax / HRrest into the fitness state", () => {
    expect(toFitnessState(undefined, { vdot: 45, vdotStatus: "race" }, { hrMax: 188, hrRest: 48 })).toEqual({
      vdot: 45,
      status: "race",
      hrMax: 188,
      hrMaxSource: "measured",
      hrRest: 48,
      history: [],
    });
    expect(toFitnessState(undefined, { vdotStatus: "none" }, { hrMax: null, hrRest: null })).toEqual({ status: "none", history: [] });
  });
});

describe("race flag", () => {
  it("narrow name heuristic", () => {
    for (const n of ["Parkrun", "Spring 10K Race", "Race day!", "Toronto Waterfront Half - race"]) expect(looksLikeRace(n), n).toBe(true);
    for (const n of ["Race pace intervals", "Post-race shakeout", "Warm up before race", "Morning Run", "Marathon pace long run", "Racecourse loop", null]) {
      expect(looksLikeRace(n), String(n)).toBe(false);
    }
  });

  it("intervals.icu race flag or name", () => {
    const base = { id: "1", start_date_local: "2026-10-27T07:00:00", type: "Run" };
    const norm = (x: Record<string, unknown>) => normalizeActivity(IcuActivity.parse({ ...base, ...x }))?.isRace;
    expect(norm({ race: true, name: "Morning Run" })).toBe(true);
    expect(norm({ sub_type: "RACE" })).toBe(true);
    expect(norm({ name: "Saturday parkrun" })).toBe(true);
    expect(norm({ name: "Race pace 3 x 2 km" })).toBe(false);
  });
});

describe("morning push: quiet without a workout", () => {
  const row = (sport: string, status = "planned") => ({ id: `${sport}-${status}`, sport, status }) as unknown as PlannedWorkoutRow;
  it("picks the run, skips rest days, skipped and already-done sessions", () => {
    expect(morningWorkout([], [])).toBeUndefined();
    expect(morningWorkout([row("strength"), row("run")], [])?.sport).toBe("run");
    expect(morningWorkout([row("run", "skipped")], [])).toBeUndefined();
    expect(morningWorkout([row("run")], ["run"])).toBeUndefined();
    expect(morningWorkout([row("run"), row("strength")], ["run"])?.sport).toBe("strength");
    expect(morningWorkout([row("strength")], ["ride"])?.sport).toBe("strength");
  });
});
