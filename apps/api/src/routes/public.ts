/** Routes that do not need a session: health, register, login, logout. */
import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { sql } from "drizzle-orm";
import { HealthResponse, LoginRequest, RegisterRequest, ROUTES, User } from "@paceo/contracts";
import { output, parseInput } from "../http/validate.js";
import { AppError } from "../http/errors.js";
import { AttemptLimiter, endSession, login, register, SESSION_COOKIE, startSession, toUser } from "../services/auth.js";
import type { Services } from "../services/context.js";

export function setSessionCookie(svc: Services, reply: FastifyReply, token: string, expires: Date) {
  reply.setCookie(SESSION_COOKIE, token, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: svc.config.cookieSecure,
    signed: true,
    expires,
  });
}

export function publicRoutes(svc: Services): FastifyPluginAsync {
  const attempts = new AttemptLimiter(10, 10 * 60_000);
  const throttle = (key: string) => {
    if (!attempts.check(key)) throw new AppError(429, "too_many_attempts", "Too many attempts. Wait a few minutes and try again.");
  };

  return async (app) => {
    app.get(ROUTES.health.path, async (_req, reply) => {
      try {
        await svc.db.execute(sql`select 1`);
      } catch {
        return reply.status(503).send({ error: { code: "db_unavailable", message: "Database unavailable." } });
      }
      return output(HealthResponse, { status: "ok", db: true });
    });

    app.post(ROUTES.register.path, async (req, reply) => {
      throttle(`ip:${req.ip}`);
      const body = parseInput(RegisterRequest, req.body);
      const user = await register(svc, body);
      const s = await startSession(svc, user.id);
      setSessionCookie(svc, reply, s.token, s.expiresAt);
      return reply.send(output(User, toUser(user)));
    });

    app.post(ROUTES.login.path, async (req, reply) => {
      const body = parseInput(LoginRequest, req.body);
      throttle(`ip:${req.ip}`);
      throttle(`email:${body.email.toLowerCase()}`);
      const user = await login(svc, body);
      const s = await startSession(svc, user.id);
      setSessionCookie(svc, reply, s.token, s.expiresAt);
      return reply.send(output(User, toUser(user)));
    });

    app.post(ROUTES.logout.path, async (req, reply) => {
      const raw = req.cookies[SESSION_COOKIE];
      if (raw) {
        const un = req.unsignCookie(raw);
        if (un.valid && un.value) await endSession(svc, un.value);
      }
      reply.clearCookie(SESSION_COOKIE, { path: "/" });
      return reply.status(204).send();
    });
  };
}
