import { describe, expect, it } from "vitest";
import { formatPace, formatPaceRange } from "@paceo/engine";
import {
  formatKm,
  formatLoad,
  formatLongRunDistance,
  formatPaceTarget,
  formatRepDistance,
  kmToUnit,
  parseDuration,
  unitToKm,
  defaultUnits,
} from "../src/lib/units";
import { describeDuration, describeTarget } from "../src/lib/workout";

describe("pace formatting in imperial (§5)", () => {
  it("converts s/km to min/mi", () => {
    // 300 s/km × 1.609344 = 482.8 s/mi → 8:03
    expect(formatPace(300, "imperial")).toBe("8:03 /mi");
    expect(formatPace(300, "metric")).toBe("5:00 /km");
  });

  it("rounds pace ranges outward and shows slow–fast", () => {
    // T band from the §3.8 example: 350–367 s/km → 9:23.3–9:50.6 /mi → 9:51–9:23
    expect(formatPaceTarget(350, 367, "imperial")).toBe("9:51–9:23 /mi");
    expect(formatPaceTarget(350, 367, "metric")).toBe("6:07–5:50 /km");
    expect(formatPaceRange({ fast: 350, slow: 367 }, "imperial")).toBe("9:51–9:23 /mi");
  });

  it("is order-insensitive for lo/hi", () => {
    expect(formatPaceTarget(367, 350, "imperial")).toBe("9:51–9:23 /mi");
  });

  it("describes a pace step target in imperial", () => {
    expect(describeTarget({ type: "pace", lo_s_per_km: 350, hi_s_per_km: 367 }, { units: "imperial" })).toBe("9:51–9:23 /mi");
  });
});

describe("distance display (§5)", () => {
  it("keeps metric track units for reps with mile equivalents", () => {
    expect(formatRepDistance(800, "imperial")).toBe("800 m (½ mi)");
    expect(formatRepDistance(400, "imperial")).toBe("400 m (¼ mi)");
    expect(formatRepDistance(1000, "imperial")).toBe("1 km (0.62 mi)");
    expect(formatRepDistance(800, "metric")).toBe("800 m");
    expect(describeDuration({ type: "distance", m: 800 }, { units: "imperial", inRepeat: true })).toBe("800 m (½ mi)");
  });

  it("rounds long runs to 0.5 of the unit", () => {
    expect(formatLongRunDistance(16_200, "metric")).toBe("16 km");
    expect(formatLongRunDistance(16_300, "metric")).toBe("16.5 km");
    expect(formatLongRunDistance(16_093.44, "imperial")).toBe("10 mi");
  });

  it("round-trips km and miles", () => {
    expect(kmToUnit(unitToKm(26.2, "imperial"), "imperial")).toBeCloseTo(26.2, 10);
    expect(formatKm(42.195, "imperial")).toBe("26.2 mi");
  });

  it("converts loads with 5 lb / 2.5 lb steps", () => {
    expect(formatLoad(24, "imperial")).toBe("55 lb");
    expect(formatLoad(12, "imperial", true)).toBe("27.5 lb");
    expect(formatLoad(24, "metric")).toBe("25 kg");
  });
});

describe("helpers", () => {
  it("parses durations", () => {
    expect(parseDuration("1:45:00")).toBe(6300);
    expect(parseDuration("48:30")).toBe(2910);
    expect(parseDuration("45")).toBe(2700);
    expect(parseDuration("1:75")).toBeNull();
    expect(parseDuration("abc")).toBeNull();
  });

  it("defaults US locale to imperial", () => {
    expect(defaultUnits("en-US")).toBe("imperial");
    expect(defaultUnits("en-CA")).toBe("metric");
    expect(defaultUnits("fr-CA")).toBe("metric");
  });
});
