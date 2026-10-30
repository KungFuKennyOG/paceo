import { describe, expect, it } from "vitest";
import {
  activityBestEfforts,
  aerobicDecoupling,
  bestEffortS,
  breakPaceMultiplier,
  cleanSamples,
  computeVdot,
  criticalSpeedFromActivities,
  csPriorFromMarathon,
  DISTANCES_M,
  efficiencyFactor,
  excludedForHeat,
  fitCriticalSpeed,
  formatPace,
  formatPaceRange,
  gapFactor,
  gradeAdjustedPace,
  gradePercents,
  heatAdjustedPace,
  heatNormalizedPace,
  heatPenaltyPct,
  hrSpeedFit,
  marathonFractionOfCs,
  minettiCost,
  raceTimeS,
  steadyWindows,
  tanakaHrMax,
  trainingPaces,
  uthSanityCheck,
  uthVo2max,
  vdotFromCriticalSpeed,
  wbgtFromTempDewPoint,
  type Activity,
  type ActivitySample,
} from "../src/index.js";
import { hms } from "./personas.js";

const constant = (seconds: number, mps: number, hr: (t: number) => number = () => 140, alt?: (d: number) => number): ActivitySample[] =>
  Array.from({ length: seconds + 1 }, (_, t) => {
    const s: ActivitySample = { t, distM: mps * t, hr: hr(t) };
    if (alt) s.altM = alt(mps * t);
    return s;
  });

describe("§4.7 grade-adjusted pace", () => {
  it("Minetti energy cost: 3.6 J/kg/m on the flat, 5.97 at +10%", () => {
    expect(minettiCost(0)).toBeCloseTo(3.6, 6);
    expect(minettiCost(0.1)).toBeCloseTo(5.968214, 5);
  });

  it("engine GAP factor F(g) = 0.0021g² + 0.034g + 1: 1 flat, 1.55 at +10%, minimum ≈ 0.86 at −8%", () => {
    expect(gapFactor(0)).toBe(1);
    expect(gapFactor(10)).toBeCloseTo(1.55, 6);
    expect(gapFactor(-8)).toBeCloseTo(0.8624, 4);
    expect(gapFactor(-8)).toBeLessThan(gapFactor(-6));
    expect(gapFactor(-8)).toBeLessThan(gapFactor(-10));
  });

  it("clamps grade to ±25%", () => {
    expect(gapFactor(40)).toBe(gapFactor(25));
    expect(gapFactor(-40)).toBe(gapFactor(-25));
  });

  it("6:00/km up a 10% grade is worth 3:52/km on the flat", () => {
    expect(formatPace(gradeAdjustedPace(360, 10))).toBe("3:52 /km");
  });

  it("grades come from altitude smoothed over distance", () => {
    const clean = cleanSamples(constant(600, 3, () => 140, (d) => 0.05 * d));
    const g = gradePercents(clean.samples);
    expect(g[300]!).toBeCloseTo(5, 1);
  });
});

describe("§4.8 heat", () => {
  it("spec examples at WBGT 20 °C: persona B goal MP 6:03 → 6:26, persona C HM GP 4:16 → 4:25", () => {
    const vdotB = computeVdot(DISTANCES_M.marathon, hms(4, 24, 0));
    expect(heatPenaltyPct(20, vdotB)).toBeCloseTo(6.5, 6);
    expect(formatPace(hms(4, 15, 0) / 42.195)).toBe("6:03 /km");
    expect(formatPace(heatAdjustedPace(hms(4, 15, 0) / 42.195, 20, vdotB))).toBe("6:26 /km");
    expect(heatPenaltyPct(20, 50)).toBeCloseTo(3.5, 6);
    expect(formatPace(heatAdjustedPace(hms(1, 29, 59) / 21.0975, 20, 50))).toBe("4:25 /km");
  });

  it("slope by level and no penalty at ≤ 10 °C; normalization inverts the adjustment", () => {
    expect(heatPenaltyPct(10, 45)).toBe(0);
    expect(heatPenaltyPct(14, 45)).toBeCloseTo(2, 6);
    expect(heatPenaltyPct(14, 55)).toBeCloseTo(1.4, 6);
    expect(heatNormalizedPace(heatAdjustedPace(300, 18, 45), 18, 45)).toBeCloseTo(300, 6);
    expect(excludedForHeat(20)).toBe(false);
    expect(excludedForHeat(21)).toBe(true);
  });

  it("WBGT approximation rises with temperature and humidity", () => {
    expect(wbgtFromTempDewPoint(30, 20)).toBeCloseTo(30.1, 1);
    expect(wbgtFromTempDewPoint(30, 10)).toBeLessThan(wbgtFromTempDewPoint(30, 20));
  });
});

describe("§4.9 GPS and sensor cleaning", () => {
  // 600 s at 3 m/s; a 200 m GPS spike at t=100; standing still t=301–320; 4 s dropout; 19 s dropout.
  const samples: ActivitySample[] = [];
  for (let t = 0; t <= 600; t++) {
    if ((t >= 401 && t <= 404) || (t > 500 && t < 520)) continue;
    const paused = t > 300 && t <= 320;
    const d = paused ? 900 : 3 * (t <= 300 ? t : t - 20);
    samples.push({ t, distM: d + (t === 100 ? 200 : 0), hr: t === 50 ? 250 : 140 });
  }
  const c = cleanSamples(samples, { hrMax: 190 });

  it("drops the spike, interpolates the short gap, flags the long one", () => {
    expect(c.flags.droppedPoints).toBe(1);
    expect(c.flags.interpolatedS).toBe(5);
    expect(c.flags.longGaps).toEqual([{ fromT: 500, toT: 520 }]);
    expect(c.distanceM).toBeCloseTo(1740, 6);
  });

  it("auto-pause removes the standing time; HR above HRmax + 5 is dropped", () => {
    expect(c.movingS).toBeGreaterThanOrEqual(575);
    expect(c.movingS).toBeLessThanOrEqual(590);
    expect(c.flags.hrDropped).toBe(1);
  });

  it("run/walk keeps walking as moving time", () => {
    expect(cleanSamples(samples, { runWalk: true }).movingS).toBe(600);
  });
});

describe("§4.6 efficiency factor, decoupling and HR–speed", () => {
  it("EF and decoupling on a 40-min run whose HR drifts from 140 to 150", () => {
    const c = cleanSamples(constant(2400, 3, (t) => (t < 1500 ? 140 : 150)));
    expect(efficiencyFactor(c)!).toBeCloseTo(180 / 145, 1);
    const d = aerobicDecoupling(c)!;
    expect(d.pct).toBeCloseTo((1 - 140 / 150) * 100, 1);
    expect(d.good).toBe(false);
  });

  it("decoupling needs ≥ 20 min of steady running after the warm-up skip", () => {
    expect(aerobicDecoupling(cleanSamples(constant(1500, 3)))).toBe(undefined);
  });

  it("HR–speed regression extrapolates to HRmax", () => {
    const s: ActivitySample[] = [];
    const steps = [2.5, 3, 3.5, 4, 3.75, 3.25];
    let d = 0;
    for (let t = 0; t <= 600 + steps.length * 180; t++) {
      const i = Math.max(0, Math.min(steps.length - 1, Math.floor((t - 600) / 180)));
      const v = t < 600 ? 2.5 : steps[i]!;
      d += t === 0 ? 0 : v;
      s.push({ t, distM: d, hr: 130 + (v - 2.5) * 30 });
    }
    const fit = hrSpeedFit(steadyWindows(cleanSamples(s)), 190)!;
    expect(fit.vAtHrMaxMps).toBeCloseTo(4.5, 1);
  });
});

describe("§4.5 critical speed", () => {
  it("best effort on a constant 4 m/s run: 400 m in 100 s", () => {
    expect(bestEffortS(cleanSamples(constant(1300, 4)).samples, 400)).toBeCloseTo(100, 6);
  });

  it("fits D = CS·t + D′ exactly", () => {
    const efforts = [120, 300, 720].map((t) => ({ distanceM: 4 * t + 200, timeS: t }));
    const fit = fitCriticalSpeed(efforts)!;
    expect(fit.csMps).toBeCloseTo(4, 9);
    expect(fit.dPrimeM).toBeCloseTo(200, 6);
    expect(fit.r2).toBeCloseTo(1, 9);
  });

  it("marathon %CS prior: 0.93 at 150 min → 0.789 at ≥ 300 min; personas A 6:17, B 5:09, C 4:02 /km", () => {
    expect(marathonFractionOfCs(150)).toBeCloseTo(0.93, 9);
    expect(marathonFractionOfCs(400)).toBeCloseTo(0.789, 9);
    const cs = (vdot: number) => formatPace(1000 / csPriorFromMarathon(raceTimeS(vdot, DISTANCES_M.marathon)));
    expect(cs(24.8)).toBe("6:17 /km");
    expect(cs(computeVdot(DISTANCES_M.marathon, hms(4, 24, 0)))).toBe("5:09 /km");
    expect(cs(50)).toBe("4:02 /km");
  });

  it("VDOT from CS inverts the prior (cross-check only)", () => {
    expect(vdotFromCriticalSpeed(csPriorFromMarathon(raceTimeS(50, DISTANCES_M.marathon)))!).toBeCloseTo(50, 3);
  });

  it("needs 24 runs in 16 weeks, uses hard efforts only, and is off for beginners", () => {
    const runs: Activity[] = Array.from({ length: 30 }, (_, i) => ({
      id: `r${i}`,
      date: `2026-10-${String(1 + i).padStart(2, "0")}`,
      sport: "run",
      distanceM: 8000,
      movingS: 2400,
      isRace: false,
      laps: i % 3 === 0 ? [{ startS: 0, durationS: 90, distanceM: 400 }, { startS: 90, durationS: 190, distanceM: 800 }, { startS: 280, durationS: 1200, distanceM: 5000 }] : [],
      srpe: i % 3 === 0 ? 8 : 3,
    }));
    expect(criticalSpeedFromActivities(runs, "2026-10-31", "beginner").status).toBe("disabled");
    expect(criticalSpeedFromActivities(runs.slice(0, 10), "2026-10-31", "advanced").status).toBe("insufficient");
    const cs = criticalSpeedFromActivities(runs, "2026-10-31", "advanced");
    expect(cs.status).toBe("ok");
    if (cs.status === "ok") expect(cs.efforts.map((e) => e.distanceM)).toEqual([400, 800, 5000]);
    expect(activityBestEfforts(runs[1]!)).toEqual([]);
  });
});

describe("§4.6 Uth–Sørensen and HRmax (sanity check only)", () => {
  it("15.3 × HRmax/HRrest, with a ±2 SEE consistency band", () => {
    expect(uthVo2max(190, 50)).toBeCloseTo(58.14, 6);
    const c = uthSanityCheck(55, 190, 50, "measured");
    expect(c.consistent).toBe(true);
    expect(c.cap).toBeCloseTo(58.14 + 5.4, 6);
    expect(uthSanityCheck(40, 190, 50, "age_formula").consistent).toBe(false);
    expect(tanakaHrMax(40)).toBe(180);
  });
});

describe("§8 R-BREAK pace table", () => {
  it("interpolates the Daniels table; spec examples for personas B and C", () => {
    expect(breakPaceMultiplier(5, false)).toBe(1);
    expect(breakPaceMultiplier(14, false)).toBeCloseTo(0.973, 9);
    expect(breakPaceMultiplier(12, false)).toBeCloseTo(0.979, 9);
    expect(breakPaceMultiplier(14, true)).toBeCloseTo(0.986, 9);
    expect(breakPaceMultiplier(100, false)).toBe(0.8);
    const mp = hms(4, 15, 0) / 42.195;
    expect(formatPace(mp / breakPaceMultiplier(14, false))).toBe("6:13 /km");
    expect(formatPace(mp / breakPaceMultiplier(21, false))).toBe("6:21 /km");
    const t = trainingPaces(50).T;
    expect(formatPaceRange(t)).toBe("4:28–4:15 /km");
    const m = breakPaceMultiplier(14, false);
    expect(formatPaceRange({ fast: t.fast / m, slow: t.slow / m })).toBe("4:35–4:22 /km");
  });
});
