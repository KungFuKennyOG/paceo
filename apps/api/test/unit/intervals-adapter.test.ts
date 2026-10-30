import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { IntervalsClient, IntervalsError, parseRetryAfter, type FetchLike } from "../../src/integrations/intervals/client.js";
import { decodeOriginal, IntervalsIcuAccount } from "../../src/integrations/intervals/account.js";
import { normalizeSport, originPlatform } from "../../src/integrations/intervals/normalize.js";
import { TokenBucket } from "../../src/integrations/limiter.js";

const fixture = (name: string) => readFileSync(new URL(`../fixtures/intervals/${name}`, import.meta.url), "utf8");
const KEY = "secret-key-abcdef123456";

interface Call {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: unknown;
}

type Responder = (call: Call) => Response;

function mockFetch(responders: Responder[]) {
  const calls: Call[] = [];
  const fetch: FetchLike = async (input, init) => {
    const call: Call = {
      method: init.method ?? "GET",
      url: new URL(input),
      headers: init.headers as Record<string, string>,
      body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    const r = responders.shift();
    if (!r) throw new Error(`unexpected call ${call.method} ${call.url}`);
    return r(call);
  };
  return { fetch, calls };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

function account(responders: Responder[]) {
  // Virtual time: sleeping advances the clock the limiter reads.
  let t = 0;
  const sleeps: number[] = [];
  const sleep = async (ms: number) => {
    sleeps.push(ms);
    t += ms;
  };
  const limiter = new TokenBucket({ ratePerSec: 1000, now: () => t, sleep });
  const { fetch, calls } = mockFetch(responders);
  const client = new IntervalsClient({
    apiKey: KEY,
    baseUrl: "https://intervals.icu/api/v1",
    userAgent: "Mozilla/5.0 test",
    limiter,
    fetch,
    sleep,
  });
  return { acct: new IntervalsIcuAccount(client), calls, sleeps, client, limiter };
}

describe("intervals.icu adapter", () => {
  it("sends Basic API_KEY auth, athlete 0 and a browser-like User-Agent", async () => {
    const { acct, calls } = account([() => json(JSON.parse(fixture("athlete.json")))]);
    const athlete = await acct.verify();
    expect(athlete).toEqual({ id: "i123456", name: "Kenny Runner" });
    const c = calls[0] as Call;
    expect(c.url.pathname).toBe("/api/v1/athlete/0");
    expect(c.headers.Authorization).toBe("Basic " + Buffer.from(`API_KEY:${KEY}`).toString("base64"));
    expect(c.headers["User-Agent"]).toMatch(/^Mozilla\//);
  });

  it("lists activities, normalises them and counts hidden Strava stubs", async () => {
    const { acct, calls } = account([() => json(JSON.parse(fixture("activities.json")))]);
    const res = await acct.source.listActivities("2026-07-02", "2026-10-30");
    const c = calls[0] as Call;
    expect(c.url.pathname).toBe("/api/v1/athlete/0/activities");
    expect(c.url.searchParams.get("oldest")).toBe("2026-07-02");
    expect(c.url.searchParams.get("newest")).toBe("2026-10-30");
    expect(res.hiddenStravaCount).toBe(1);
    expect(res.activities.map((a) => a.sourceId)).toEqual(["i9001", "i9002", "i9004"]);
    const run = res.activities[0];
    expect(run).toMatchObject({
      sport: "run",
      localDate: "2026-10-28",
      distanceM: 10012.4,
      movingS: 3010,
      avgHr: 146,
      originPlatform: "garmin",
      garminOrigin: true,
    });
    expect(run?.startUtc.toISOString()).toBe("2026-10-28T11:01:02.000Z");
    expect(res.activities[1]).toMatchObject({ sport: "ride", originPlatform: "coros", garminOrigin: false });
    expect(res.activities[2]).toMatchObject({ sport: "strength", originPlatform: null });
  });

  it("fetches activity detail with intervals and the original (gzipped) FIT file", async () => {
    const fit = Buffer.concat([Buffer.from([14, 16, 0, 0, 0, 0, 0, 0]), Buffer.from(".FIT"), Buffer.alloc(8)]);
    const { acct, calls } = account([
      () => json(JSON.parse(fixture("activities.json"))[0]),
      () => new Response(gzipSync(fit), { status: 200, headers: { "content-type": "application/octet-stream" } }),
      () => json({ status: 404 }, 404),
    ]);
    const detail = await acct.source.getActivityDetail("i9001");
    expect(calls[0]?.url.pathname).toBe("/api/v1/activity/i9001");
    expect(calls[0]?.url.searchParams.get("intervals")).toBe("true");
    expect(detail?.sport).toBe("run");
    const file = await acct.source.getOriginalFile("i9001");
    expect(calls[1]?.url.pathname).toBe("/api/v1/activity/i9001/file");
    expect(file?.contentType).toBe("application/vnd.ant.fit");
    expect(file?.bytes.equals(fit)).toBe(true);
    expect(await acct.source.getOriginalFile("missing")).toBeNull();
  });

  it("bulk-upserts events with external ids, bulk-deletes and reads the calendar back", async () => {
    const { acct, calls } = account([() => json([]), () => json({}), () => json(JSON.parse(fixture("events.json")))]);
    await acct.sink.upsertWorkouts([
      { externalId: "u1:w1:0", date: "2026-11-02", sport: "run", name: "Easy run", description: "- 30m 65-79% HR" },
      { externalId: "u1:w2:0", date: "2026-11-03", sport: "strength", name: "Strength A", description: "1. Squat" },
    ]);
    const up = calls[0] as Call;
    expect(up.method).toBe("POST");
    expect(up.url.pathname).toBe("/api/v1/athlete/0/events/bulk");
    expect(up.url.searchParams.get("upsert")).toBe("true");
    expect(up.body).toEqual([
      { category: "WORKOUT", start_date_local: "2026-11-02T00:00:00", type: "Run", name: "Easy run", description: "- 30m 65-79% HR", external_id: "u1:w1:0" },
      { category: "WORKOUT", start_date_local: "2026-11-03T00:00:00", type: "WeightTraining", name: "Strength A", description: "1. Squat", external_id: "u1:w2:0" },
    ]);

    await acct.sink.deleteWorkouts(["u1:w1:0"]);
    const del = calls[1] as Call;
    expect(del.method).toBe("PUT");
    expect(del.url.pathname).toBe("/api/v1/athlete/0/events/bulk-delete");
    expect(del.body).toEqual([{ external_id: "u1:w1:0" }]);

    const events = await acct.sink.listEvents("2026-11-02", "2026-11-15");
    expect(calls[2]?.url.pathname).toBe("/api/v1/athlete/0/events");
    expect(events[0]).toEqual({ eventId: "70001", externalId: "u1:w1:0", date: "2026-11-02", name: "Easy run" });
    expect(events[1]?.externalId).toBeNull();
  });

  it("skips the network for empty upserts/deletes", async () => {
    const { acct, calls } = account([]);
    await acct.sink.upsertWorkouts([]);
    await acct.sink.deleteWorkouts([]);
    expect(calls).toHaveLength(0);
  });

  it("backs off on 429 using Retry-After, then succeeds", async () => {
    const { acct, calls, sleeps } = account([
      () => json({ error: "slow down" }, 429, { "retry-after": "2" }),
      () => json(JSON.parse(fixture("athlete.json"))),
    ]);
    await acct.verify();
    expect(calls).toHaveLength(2);
    expect(sleeps.some((ms) => ms >= 2000)).toBe(true);
  });

  it("gives up after repeated 429s with a rate_limited error", async () => {
    const r = () => json({}, 429, { "retry-after": "1" });
    const { acct } = account([r, r, r, r]);
    await expect(acct.verify()).rejects.toMatchObject({ kind: "rate_limited" });
  });

  it("maps 401 and JSON 403 to auth errors, and a Cloudflare HTML 403 to blocked", async () => {
    const a = account([() => json({ status: 401 }, 401)]);
    await expect(a.acct.verify()).rejects.toMatchObject({ kind: "auth", status: 401 });
    const b = account([() => json({ error: "Forbidden" }, 403)]);
    await expect(b.acct.verify()).rejects.toMatchObject({ kind: "auth", status: 403 });
    const c = account([
      () => new Response("<!DOCTYPE html><html><title>Just a moment...</title>cf-ray</html>", { status: 403, headers: { "content-type": "text/html" } }),
    ]);
    await expect(c.acct.verify()).rejects.toMatchObject({ kind: "blocked" });
  });

  it("retries 5xx and network errors", async () => {
    const { acct, calls } = account([
      () => json({}, 503),
      () => {
        throw new TypeError("fetch failed");
      },
      () => json(JSON.parse(fixture("athlete.json"))),
    ]);
    await acct.verify();
    expect(calls).toHaveLength(3);
  });

  it("never puts the key in errors or serialised clients", async () => {
    const { acct, client } = account([() => json({}, 500), () => json({}, 500), () => json({}, 500), () => json({}, 500)]);
    const err = await acct.verify().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IntervalsError);
    const text = `${(err as Error).message} ${(err as Error).stack} ${JSON.stringify(err)} ${JSON.stringify(client)}`;
    expect(text).not.toContain(KEY);
    expect(text).not.toContain(Buffer.from(`API_KEY:${KEY}`).toString("base64"));
  });
});

describe("intervals.icu helpers", () => {
  it("parses Retry-After seconds and dates", () => {
    expect(parseRetryAfter("3", 0)).toBe(3000);
    expect(parseRetryAfter(new Date(10_000).toUTCString(), 4_000)).toBe(6000);
    expect(parseRetryAfter(null, 0)).toBeNull();
    expect(parseRetryAfter("soon", 0)).toBeNull();
  });

  it("normalises sports and platforms", () => {
    expect(normalizeSport("VirtualRun")).toBe("run");
    expect(normalizeSport("TrailRun")).toBe("run");
    expect(normalizeSport("GravelRide")).toBe("ride");
    expect(normalizeSport("WeightTraining")).toBe("strength");
    expect(normalizeSport("Yoga")).toBe("other");
    expect(originPlatform("GARMIN_CONNECT", null)).toBe("garmin");
    expect(originPlatform("UPLOAD", "Suunto Race")).toBe("suunto");
    expect(originPlatform("STRAVA", null)).toBe("strava");
  });

  it("detects GPX/TCX originals", () => {
    expect(decodeOriginal(Buffer.from('<?xml version="1.0"?><gpx>')).contentType).toBe("application/gpx+xml");
    expect(decodeOriginal(Buffer.from("<TrainingCenterDatabase>")).contentType).toBe("application/vnd.garmin.tcx+xml");
  });
});
