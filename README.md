# Paceo

An adaptive running-plan app for a small group of friends: evidence-based plans, paces from your race results, plans that adjust when life happens, strength and cross-training that count toward fatigue, and workouts delivered to your watch through [intervals.icu](https://intervals.icu).

The full design lives in [`docs/spec.md`](docs/spec.md).

## Status

Everything below is built and covered by CI: unit tests, API integration tests against Postgres 16, and a Docker smoke test that builds the production image and walks register → profile → plan → workouts.

| Part | What's in it |
|---|---|
| `packages/engine` | Pace model (VDOT, race equivalence, fade, goal checks), plan generator (feasibility, phases, volume and cutbacks, long-run caps, taper, quality budget, workout library, run/walk ladder), weekly scheduler (any weekdays, per-day time limits), strength (§9), cross-training and load model (§10), general-fitness mode, HR targets, adaptive replanning (§8: missed runs, breaks, illness, pain, performance, load, HRV, race-date protection), activity analysis (GAP, heat, critical speed, decoupling), fitness updates, "why this workout" explanations |
| `packages/contracts` | Zod schemas for every HTTP request/response, shared by the API and the web app |
| `apps/api` | Fastify + Postgres (Drizzle) + pg-boss: invite-only accounts, health screen, profile, intervals.icu sync (activities, laps, FIT streams) and workout push, FIT upload, plan generation and nightly replanning, check-ins, fitness proposals, web push |
| `apps/web` | React PWA: onboarding wizard with guided intervals.icu setup, Today, Week, Plan, workout detail with follow-in-app mode, check-ins, proposals, settings. Mock mode for demos. |
| `deploy/` | Dockerfile, Docker Compose (api + Postgres), Cloudflare Tunnel or Caddy, backups, laptop setup guide, smoke test |
| `scripts/spike-push-workout.ts` | Checks that pace workouts reach your watch with their targets |

### Not verified yet (needs a real account and watch)

- intervals.icu workout text syntax (pace and bpm targets) and whether targets survive the trip to Garmin/COROS. Run the watch spike below.
- Live intervals.icu API responses. Adapters are tested against fixtures written from the docs.
- Real web-push delivery on iOS and Android.

## Stack

TypeScript pnpm monorepo:

- `packages/engine`: pure, deterministic training logic shared by the API and the PWA
- `packages/contracts`: the HTTP contract
- `apps/api`: Node, Fastify, Postgres (Drizzle), pg-boss jobs, web push
- `apps/web`: React, Vite, PWA

## Getting started

Requires Node ≥ 22.12 and pnpm 10.

```bash
pnpm install
pnpm test
pnpm typecheck
```

**Click through the app without a backend:**

```bash
pnpm --filter @paceo/web dev:mock
```

Log in as `demo@paceo.run` with any password, or register with any invite code to see onboarding.

**Run the real thing locally** (needs Postgres 16):

```bash
export DATABASE_URL=postgres://paceo:paceo@localhost:5432/paceo
export SESSION_SECRET=$(openssl rand -base64 48) PACEO_ENCRYPTION_KEY=$(openssl rand -base64 32)
pnpm --filter @paceo/api admin:create-invite   # prints your first invite code (first user = admin)
pnpm --filter @paceo/api dev                    # API on :3000
pnpm --filter @paceo/web dev                    # web app, proxies /api to :3000
```

**Deploy on a home laptop or small VM:** see [`deploy/README.md`](deploy/README.md).

## The watch spike

Check that a pace workout pushed through intervals.icu shows up on your watch **with pace targets**. One report says API-made workouts arrive as duration only.

1. In intervals.icu, connect your Garmin/COROS, turn on **Upload planned workouts**, and set your **threshold pace** under Settings → Run.
2. `cp .env.example .env` and paste your API key from intervals.icu → Settings → Developer Settings.
3. Run `pnpm spike:push` (or `pnpm spike:push --pace 5:50-6:07`).
4. Sync your watch and open tomorrow's "Paceo test" workout. Do the reps show a pace target?
5. Clean up with `pnpm spike:push --delete`.
