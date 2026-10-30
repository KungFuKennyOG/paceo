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
    // Never more than 5 in any 1 s window after the burst.
    for (let i = 5; i < times.length; i++) {
      const inWindow = times.filter((x) => x > (times[i] as number) - 1000 && x <= (times[i] as number)).length;
      expect(inWindow).toBeLessThanOrEqual(6);
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
