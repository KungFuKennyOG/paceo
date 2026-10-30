import { describe, expect, it } from "vitest";
import { TokenBucket } from "../../src/integrations/limiter.js";

/** Virtual clock: sleep advances time instantly. */
function virtualTime() {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
    get t() {
      return t;
    },
  };
}

describe("TokenBucket", () => {
  it("allows a burst, then paces at the rate", async () => {
    const vt = virtualTime();
    const b = new TokenBucket({ ratePerSec: 5, now: vt.now, sleep: vt.sleep });
    const times: number[] = [];
    for (let i = 0; i < 15; i++) {
      await b.take();
      times.push(vt.t);
    }
    expect(times.slice(0, 5)).toEqual([0, 0, 0, 0, 0]);
    // 10 more tokens at 5/s ≈ 2 s.
    expect(times[14]).toBeGreaterThanOrEqual(1990);
    expect(times[14]).toBeLessThanOrEqual(2100);
    // Burst + rate: never more than 10 in any 1 s window (intervals.icu allows 10 req/s per IP),
    // and once the burst is spent, at most 5 per second.
    for (let i = 0; i < times.length; i++) {
      const t = times[i] as number;
      expect(times.filter((x) => x > t - 1000 && x <= t).length).toBeLessThanOrEqual(10);
    }
    const afterBurst = times.slice(5);
    for (let i = 0; i < afterBurst.length; i++) {
      const t = afterBurst[i] as number;
      expect(afterBurst.filter((x) => x > t - 1000 && x <= t).length).toBeLessThanOrEqual(5);
    }
  });

  it("serves concurrent waiters in order", async () => {
    const vt = virtualTime();
    const b = new TokenBucket({ ratePerSec: 2, burst: 1, now: vt.now, sleep: vt.sleep });
    const order: number[] = [];
    await Promise.all([0, 1, 2, 3].map((i) => b.take().then(() => order.push(i))));
    expect(order).toEqual([0, 1, 2, 3]);
    expect(vt.t).toBeGreaterThanOrEqual(1500);
  });

  it("pauses everyone after a Retry-After", async () => {
    const vt = virtualTime();
    const b = new TokenBucket({ ratePerSec: 5, now: vt.now, sleep: vt.sleep });
    await b.take();
    b.pauseFor(3000);
    await b.take();
    expect(vt.t).toBeGreaterThanOrEqual(3000);
  });

  it("rejects a non-positive rate", () => {
    expect(() => new TokenBucket({ ratePerSec: 0 })).toThrow();
  });
});
