/**
 * Low-level intervals.icu HTTP client (spec §3.2).
 * - Basic auth "API_KEY:<key>", athlete id 0 = the key's own athlete.
 * - Browser-like User-Agent (Cloudflare may challenge library user agents).
 * - Every request takes a token from the shared limiter; 429 honours Retry-After and pauses the
 *   whole bucket; 5xx and network errors retry with exponential backoff.
 * - The key never appears in errors or logs: messages carry only method, path and status.
 */
import type { TokenBucket } from "../limiter.js";
import { realSleep } from "../limiter.js";

export type IntervalsErrorKind = "auth" | "blocked" | "rate_limited" | "not_found" | "http" | "network";

export class IntervalsError extends Error {
  constructor(
    readonly kind: IntervalsErrorKind,
    message: string,
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = "IntervalsError";
  }
}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface IntervalsClientOptions {
  apiKey: string;
  baseUrl: string;
  userAgent: string;
  limiter: TokenBucket;
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  /** Retries for 429/5xx/network errors. */
  maxRetries?: number;
  /** Upper bound on a single Retry-After wait. */
  maxRetryAfterMs?: number;
}

export interface RequestOptions {
  query?: Record<string, string | number | boolean>;
  body?: unknown;
}

/** Retry-After is either delta-seconds or an HTTP date. */
export function parseRetryAfter(value: string | null, nowMs: number): number | null {
  if (!value) return null;
  const secs = Number(value.trim());
  if (Number.isFinite(secs) && secs >= 0) return Math.round(secs * 1000);
  const at = Date.parse(value);
  if (Number.isFinite(at)) return Math.max(0, at - nowMs);
  return null;
}

export class IntervalsClient {
  private readonly fetchFn: FetchLike;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxRetries: number;
  private readonly maxRetryAfterMs: number;
  private readonly authHeader: string;

  constructor(private readonly opts: IntervalsClientOptions) {
    this.fetchFn = opts.fetch ?? ((input, init) => fetch(input, init));
    this.sleep = opts.sleep ?? realSleep;
    this.maxRetries = opts.maxRetries ?? 3;
    this.maxRetryAfterMs = opts.maxRetryAfterMs ?? 120_000;
    this.authHeader = "Basic " + Buffer.from(`API_KEY:${opts.apiKey}`).toString("base64");
  }

  /** Redacted view for debugging; never includes the key. */
  toJSON() {
    return { baseUrl: this.opts.baseUrl, apiKey: "[redacted]" };
  }

  private url(path: string, query?: RequestOptions["query"]): string {
    const u = new URL(this.opts.baseUrl.replace(/\/$/, "") + path);
    for (const [k, v] of Object.entries(query ?? {})) u.searchParams.set(k, String(v));
    return u.toString();
  }

  private async send(method: string, path: string, opts: RequestOptions, accept: string): Promise<Response> {
    const url = this.url(path, opts.query);
    const headers: Record<string, string> = {
      Authorization: this.authHeader,
      "User-Agent": this.opts.userAgent,
      Accept: accept,
    };
    let body: string | undefined;
    if (opts.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(opts.body);
    }
    const label = `${method} ${path}`;

    for (let attempt = 0; ; attempt++) {
      await this.opts.limiter.take();
      let res: Response;
      try {
        res = await this.fetchFn(url, body === undefined ? { method, headers } : { method, headers, body });
      } catch (err) {
        if (attempt < this.maxRetries) {
          await this.sleep(backoffMs(attempt));
          continue;
        }
        const cause = err instanceof Error ? err.message : String(err);
        throw new IntervalsError("network", `${label}: network error (${cause})`);
      }

      if (res.status === 429) {
        const wait = Math.min(
          parseRetryAfter(res.headers.get("retry-after"), Date.now()) ?? backoffMs(attempt),
          this.maxRetryAfterMs,
        );
        await drain(res);
        this.opts.limiter.pauseFor(wait);
        if (attempt < this.maxRetries) continue;
        throw new IntervalsError("rate_limited", `${label}: rate limited (429)`, 429);
      }
      if (res.status === 401) {
        await drain(res);
        throw new IntervalsError("auth", `${label}: key not accepted (401)`, 401);
      }
      if (res.status === 403) {
        const ct = res.headers.get("content-type") ?? "";
        const text = await res.text().catch(() => "");
        // A Cloudflare challenge is an HTML page; a rejected key is JSON/plain text.
        if (ct.includes("text/html") || /<html|cloudflare|cf-ray/i.test(text.slice(0, 2000))) {
          throw new IntervalsError("blocked", `${label}: blocked by Cloudflare challenge (403)`, 403);
        }
        throw new IntervalsError("auth", `${label}: key not accepted (403)`, 403);
      }
      if (res.status === 404) {
        await drain(res);
        throw new IntervalsError("not_found", `${label}: not found (404)`, 404);
      }
      if (res.status >= 500 && attempt < this.maxRetries) {
        await drain(res);
        await this.sleep(backoffMs(attempt));
        continue;
      }
      if (!res.ok) {
        await drain(res);
        throw new IntervalsError("http", `${label}: HTTP ${res.status}`, res.status);
      }
      return res;
    }
  }

  async json<T = unknown>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
    const res = await this.send(method, path, opts, "application/json");
    const text = await res.text();
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new IntervalsError("http", `${method} ${path}: response was not JSON`, res.status);
    }
  }

  async bytes(method: string, path: string, opts: RequestOptions = {}): Promise<{ bytes: Buffer; contentType: string }> {
    const res = await this.send(method, path, opts, "*/*");
    const buf = Buffer.from(await res.arrayBuffer());
    return { bytes: buf, contentType: res.headers.get("content-type") ?? "application/octet-stream" };
  }
}

function backoffMs(attempt: number): number {
  return Math.min(30_000, 500 * 2 ** attempt);
}

async function drain(res: Response): Promise<void> {
  try {
    await res.arrayBuffer();
  } catch {
    /* ignore */
  }
}
