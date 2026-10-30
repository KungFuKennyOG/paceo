import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { InlineQueue } from "../../src/jobs/queue.js";
import { ruleTraceExplainer } from "../../src/plan/explain.js";
import { silentLogger, type Services } from "../../src/services/context.js";

/** Static PWA serving + SPA fallback; no database is touched by these routes. */
describe("web app serving", () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "paceo-web-"));
    writeFileSync(path.join(dir, "index.html"), "<!doctype html><title>Paceo</title>");
    writeFileSync(path.join(dir, "sw.js"), "self.addEventListener('install',()=>{})");
    mkdirSync(path.join(dir, "assets"));
    writeFileSync(path.join(dir, "assets", "app-abc123.js"), "console.log(1)");
    const svc = {
      jobs: new InlineQueue(false),
      explainer: ruleTraceExplainer,
      clock: () => new Date(),
      log: silentLogger,
      push: null,
      config: { cookieSecure: false, sessionTtlDays: 1, publicUrl: "http://x", vapidPublicKey: null, morningPushHour: 7, nightlyHour: 3 },
    } as unknown as Services;
    app = await buildApp({ services: svc, sessionSecret: "y".repeat(48), webDistDir: dir });
  });
  afterAll(async () => {
    await app.close();
  });

  it("serves index.html at / and for client-side routes", async () => {
    const root = await app.inject({ method: "GET", url: "/" });
    expect(root.statusCode).toBe(200);
    expect(root.body).toContain("<title>Paceo</title>");
    const deep = await app.inject({ method: "GET", url: "/plan/week/3" });
    expect(deep.statusCode).toBe(200);
    expect(deep.body).toContain("<title>Paceo</title>");
    expect(deep.headers["cache-control"]).toBe("no-cache");
  });

  it("serves assets with long caching and the service worker without", async () => {
    const asset = await app.inject({ method: "GET", url: "/assets/app-abc123.js" });
    expect(asset.statusCode).toBe(200);
    expect(asset.headers["cache-control"]).toContain("immutable");
    const sw = await app.inject({ method: "GET", url: "/sw.js" });
    expect(sw.headers["cache-control"]).toBe("no-cache");
  });

  it("keeps unknown /api paths as JSON 404s and protects API routes", async () => {
    const res = await app.inject({ method: "GET", url: "/api/nope" });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("not_found");
    const me = await app.inject({ method: "GET", url: "/api/me" });
    expect(me.statusCode).toBe(401);
    expect(me.json().error.code).toBe("unauthorized");
  });
});
