import { describe, expect, it } from "vitest";
import {
  computeVdot,
  DISTANCES_M,
  defaultFadeExponent,
  fadedRaceTimeS,
  raceTimeS,
  trainingPaces,
  pacePercentPerVdotPoint,
  VdotRangeError,
} from "../src/index.js";

const hms = (h: number, m: number, s: number) => h * 3600 + m * 60 + s;

describe("Daniels–Gilbert VDOT (spec §4.1)", () => {
  it("matches Daniels' published VDOT 50 table within 10 s", () => {
    // Table: 5K 19:57, marathon 3:10:49. Spec computed: 19:56 and 3:10:39.7.
    expect(raceTimeS(50, DISTANCES_M["5k"])).toBeCloseTo(1196, -1);
    expect(Math.abs(raceTimeS(50, DISTANCES_M["5k"]) - hms(0, 19, 57))).toBeLessThan(10);
    expect(Math.abs(raceTimeS(50, DISTANCES_M.marathon) - hms(3, 10, 49))).toBeLessThan(10);
    expect(raceTimeS(50, DISTANCES_M.marathon)).toBeCloseTo(11439.7, 0);
  });

  it("round-trips: VDOT from a race, then race time from that VDOT", () => {
    const t = hms(4, 24, 0);
    const v = computeVdot(DISTANCES_M.marathon, t);
    expect(raceTimeS(v, DISTANCES_M.marathon)).toBeCloseTo(t, 3);
  });

  it("rejects out-of-range race durations", () => {
    expect(() => computeVdot(400, 60)).toThrow(VdotRangeError);
    expect(() => computeVdot(100000, hms(7, 0, 0))).toThrow(VdotRangeError);
  });
});

describe("persona fixtures (spec §4.3)", () => {
  it("Persona A: 3K time trial 21:00 → VDOT 24.8", () => {
    const v = computeVdot(3000, hms(0, 21, 0));
    expect(v).toBeCloseTo(24.8, 1);
    const p = trainingPaces(v);
    expect(p.E.slow).toBeCloseTo(601, -0.5); // 10:01 /km
    expect(p.T.fast).toBeCloseTo(446, -0.5); // 7:26 /km
  });

  it("Persona B: marathon 4:24:00 → VDOT 33.7 with the spec's zone paces", () => {
    const v = computeVdot(DISTANCES_M.marathon, hms(4, 24, 0));
    expect(v).toBeCloseTo(33.7, 1);
    const p = trainingPaces(v);
    expect(p.E.slow).toBeCloseTo(478, -0.5); // 7:58
    expect(p.M.source).toBe("race_solution");
    expect(p.M.pace).toBeCloseTo(375.4, 0); // 6:15 — the real race pace
    expect(p.mBand.slow).toBeCloseTo(397, -0.5); // band edges 6:37–6:04
    expect(p.T.slow).toBeCloseTo(367, -0.5); // 6:07
    expect(p.T.fast).toBeCloseTo(350, -0.5); // 5:50
    expect(p.I.slow).toBeCloseTo(329.6, 0); // corrected I lower bound (5:30 displayed)
    expect(p.I.fast).toBeCloseTo(316, -0.5); // 5:16
    expect(p.R).toBeCloseTo(309, -0.5); // 5:09
  });

  it("Persona B goal: 4:15 is +1.48 (not flagged), 4:10 is flagged", () => {
    const v = computeVdot(DISTANCES_M.marathon, hms(4, 24, 0));
    const ok = trainingPaces(v, { distanceM: DISTANCES_M.marathon, timeS: hms(4, 15, 0) });
    expect(ok.M.source).toBe("goal_time");
    expect(ok.M.pace).toBeCloseTo(362.6, 0); // 6:03 /km
    expect(ok.goalVdotDelta).toBeCloseTo(1.48, 1);
    expect(ok.aggressiveGoal).toBe(false);
    // E/T/I are not re-derived from the goal
    expect(ok.T.fast).toBeCloseTo(trainingPaces(v).T.fast, 6);

    const hot = trainingPaces(v, { distanceM: DISTANCES_M.marathon, timeS: hms(4, 10, 0) });
    expect(hot.aggressiveGoal).toBe(true);
  });

  it("Persona C: HM 1:31:31 ≈ VDOT 50; sub-1:30 needs ~51.0", () => {
    const v = computeVdot(DISTANCES_M.half, hms(1, 31, 31));
    expect(v).toBeCloseTo(50.0, 1);
    const p = trainingPaces(50, { distanceM: DISTANCES_M.half, timeS: hms(1, 29, 59) });
    expect(p.goalVdot).toBeCloseTo(51.0, 1);
    expect(p.aggressiveGoal).toBe(false);
    expect(p.M.source).toBe("race_solution"); // half goal doesn't redefine M
    expect(p.goalPace).toBeCloseTo(255.9, 0); // 4:16 /km
  });
});

describe("level sensitivity and PACE-FADE (spec §4.1, §4.4)", () => {
  it("one VDOT point ≈ 3.0% pace at 25, 2.3% at 34, 1.65% at 50, 1.4% at 60", () => {
    expect(pacePercentPerVdotPoint(25)).toBeCloseTo(3.0, 0);
    expect(pacePercentPerVdotPoint(34)).toBeCloseTo(2.3, 0);
    expect(pacePercentPerVdotPoint(50)).toBeCloseTo(1.65, 0);
    expect(pacePercentPerVdotPoint(60)).toBeCloseTo(1.4, 0);
  });

  it("Persona C: HM 1:31:31 fades to ~3:18:09 marathon with k ≈ 1.114", () => {
    const k = defaultFadeExponent(50);
    expect(k).toBeCloseTo(1.114, 2);
    const t = fadedRaceTimeS(DISTANCES_M.half, hms(1, 31, 31), DISTANCES_M.marathon, k);
    expect(Math.abs(t - hms(3, 18, 9))).toBeLessThan(30);
  });
});
