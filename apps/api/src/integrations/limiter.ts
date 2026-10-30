/**
 * Token bucket shared by every call to one external platform (spec §2.2, §3.2): all users' calls come
 * from one server IP, and intervals.icu allows 10 req/s per IP, so the app stays at ≤ 5 req/s.
 * Clock and sleep are injectable so tests run on virtual time.
 */
export interface LimiterOptions {
  /** Tokens added per second. */
  ratePerSec: number;
  /** Bucket size (max burst). Defaults to ratePerSec. */
  burst?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class TokenBucket {
  private tokens: number;
  private last: number;
  private readonly rate: number;
  private readonly burst: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  /** FIFO so waiters are served in order. */
  private chain: Promise<void> = Promise.resolve();
  /** Not before this time (ms), set by a Retry-After from the platform. */
  private blockedUntil = 0;

  constructor(opts: LimiterOptions) {
    if (!(opts.ratePerSec > 0)) throw new RangeError("ratePerSec must be > 0");
    this.rate = opts.ratePerSec;
    this.burst = opts.burst ?? Math.max(1, Math.floor(opts.ratePerSec));
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? realSleep;
    this.tokens = this.burst;
    this.last = this.now();
  }

  private refill(): void {
    const t = this.now();
    const elapsed = Math.max(0, t - this.last) / 1000;
    this.tokens = Math.min(this.burst, this.tokens + elapsed * this.rate);
    this.last = t;
  }

  /** Resolves when one request may be sent. */
  take(): Promise<void> {
    const next = this.chain.then(() => this.acquire());
    // Keep the chain alive even if a waiter throws.
    this.chain = next.catch(() => undefined);
    return next;
  }

  /** A 429 with Retry-After pauses everyone using this bucket. */
  pauseFor(ms: number): void {
    this.blockedUntil = Math.max(this.blockedUntil, this.now() + ms);
  }

  private async acquire(): Promise<void> {
    for (;;) {
      const wait = this.blockedUntil - this.now();
      if (wait > 0) {
        await this.sleep(wait);
        continue;
      }
      this.refill();
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      await this.sleep(Math.ceil(((1 - this.tokens) / this.rate) * 1000));
    }
  }
}
