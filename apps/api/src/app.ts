/**
 * Fastify app. Routes are exactly the contract ROUTES table (packages/contracts); request bodies are
 * parsed with the contract schemas and responses checked against them (src/http/validate.ts).
 */
import { existsSync } from "node:fs";
import path from "node:path";
import Fastify, { type FastifyError, type FastifyInstance, type FastifyServerOptions } from "fastify";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import { ZodError } from "zod";
import { AppError } from "./http/errors.js";
import type { UserRow } from "./repo/index.js";
import type { Services } from "./services/context.js";
import { publicRoutes } from "./routes/public.js";
import { protectedRoutes } from "./routes/protected.js";

declare module "fastify" {
  interface FastifyRequest {
    user: UserRow | null;
  }
}

export interface BuildAppOptions {
  services: Services;
  sessionSecret: string;
  webDistDir?: string | null;
  logger?: FastifyServerOptions["logger"];
}

/** pino redaction: never log credentials, cookies or API keys (§12.2). */
export const LOG_REDACT = [
  "req.headers.authorization",
  "req.headers.cookie",
  'res.headers["set-cookie"]',
  "apiKey",
  "*.apiKey",
  "body.apiKey",
  "password",
  "*.password",
];

export async function buildApp(opts: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger ?? false,
    // Behind cloudflared or Caddy on the same host.
    trustProxy: true,
    bodyLimit: 1024 * 1024,
  });

  await app.register(cookie, { secret: opts.sessionSecret, hook: "onRequest" });
  await app.register(multipart, { limits: { fileSize: 25 * 1024 * 1024, files: 1, fields: 5 } });
  app.decorateRequest("user", null);

  app.setErrorHandler((err: FastifyError | AppError | ZodError | Error, req, reply) => {
    if (err instanceof AppError) {
      if (err.statusCode >= 500) req.log.error({ code: err.code, details: err.details }, err.message);
      const body: { error: { code: string; message: string; details?: unknown } } = {
        error: { code: err.code, message: err.message },
      };
      if (err.details !== undefined) body.error.details = err.details;
      return reply.status(err.statusCode).send(body);
    }
    if (err instanceof ZodError) {
      return reply.status(400).send({ error: { code: "validation", message: "Invalid request.", details: err.flatten() } });
    }
    const status = (err as FastifyError).statusCode;
    if (typeof status === "number" && status >= 400 && status < 500) {
      const code = status === 413 ? "too_large" : status === 415 ? "unsupported_media_type" : "bad_request";
      return reply.status(status).send({ error: { code, message: err.message } });
    }
    req.log.error({ err }, "unhandled error");
    return reply.status(500).send({ error: { code: "internal", message: "Something went wrong." } });
  });

  await app.register(publicRoutes(opts.services));
  await app.register(protectedRoutes(opts.services));

  const webDist = opts.webDistDir ? path.resolve(opts.webDistDir) : null;
  const serveWeb = webDist !== null && existsSync(path.join(webDist, "index.html"));
  if (serveWeb) {
    await app.register(fastifyStatic, {
      root: webDist,
      prefix: "/",
      setHeaders(res, filePath) {
        const base = path.basename(filePath);
        // Service workers and the app shell must revalidate so updates reach installed PWAs.
        if (base === "index.html" || base.endsWith("sw.js") || base === "registerSW.js" || base.endsWith(".webmanifest")) {
          res.header("Cache-Control", "no-cache");
        } else if (filePath.includes(`${path.sep}assets${path.sep}`)) {
          res.header("Cache-Control", "public, max-age=31536000, immutable");
        }
      },
    });
  }

  app.setNotFoundHandler((req, reply) => {
    const url = req.url.split("?")[0] ?? "/";
    if (serveWeb && req.method === "GET" && !url.startsWith("/api/") && url !== "/api") {
      // SPA fallback: client-side routes get index.html.
      return reply.header("Cache-Control", "no-cache").sendFile("index.html");
    }
    return reply.status(404).send({ error: { code: "not_found", message: `No route for ${req.method} ${url}` } });
  });

  return app;
}
