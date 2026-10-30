import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { FitParseError, normalizeFitSport, parseFit } from "../../src/integrations/fit/parse.js";
import { makeFitActivity } from "../helpers/fit.js";

const start = new Date("2026-10-28T11:00:00Z");

describe("FIT parsing (@garmin/fitsdk)", () => {
  it("extracts the session summary from an encoder-made activity", () => {
    const bytes = makeFitActivity({ start, distanceM: 8000, timerS: 2700, avgHr: 148, utcOffsetS: -4 * 3600 });
    const s = parseFit(bytes);
    expect(s.startUtc.toISOString()).toBe(start.toISOString());
    expect(s.sport).toBe("run");
    expect(s.distanceM).toBeCloseTo(8000, 0);
    expect(s.movingS).toBeCloseTo(2700, 0);
    expect(s.avgHr).toBe(148);
    expect(s.manufacturer).toBe("garmin");
    expect(s.utcOffsetS).toBe(-4 * 3600);
  });

  it("accepts gzipped FIT", () => {
    const bytes = makeFitActivity({ start, distanceM: 5000, timerS: 1500, avgHr: 150, utcOffsetS: 0 });
    expect(parseFit(gzipSync(bytes)).distanceM).toBeCloseTo(5000, 0);
  });

  it("rejects non-FIT and truncated files", () => {
    expect(() => parseFit(Buffer.from("hello, not a fit file at all"))).toThrow(FitParseError);
    const bytes = makeFitActivity({ start, distanceM: 5000, timerS: 1500, avgHr: 150, utcOffsetS: 0 });
    expect(() => parseFit(bytes.subarray(0, bytes.length - 10))).toThrow(FitParseError);
  });

  it("normalises FIT sports", () => {
    expect(normalizeFitSport("running", "trail")).toBe("run");
    expect(normalizeFitSport("cycling", null)).toBe("ride");
    expect(normalizeFitSport("training", "strengthTraining")).toBe("strength");
    expect(normalizeFitSport("yoga", null)).toBe("other");
  });
});
