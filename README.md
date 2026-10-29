# Paceo

An adaptive running-plan app for a small group of friends: evidence-based plans, paces from your race results, plans that adjust when life happens, strength and cross-training that count toward fatigue, and workouts delivered to your watch through [intervals.icu](https://intervals.icu).

The full design lives in [`docs/spec.md`](docs/spec.md).

## Status

| Part | State |
|---|---|
| `packages/engine` — pace model (VDOT, race equivalence, training paces, goal checks, fade), units, workout DSL, intervals.icu text compiler | ✅ first slice |
| `scripts/spike-push-workout.ts` — test that pace workouts reach your watch | ✅ ready to run |
| Plan generator, scheduler, replanning, strength | ⏳ next |
| `apps/api` (Fastify + Postgres + pg-boss) | ⏳ |
| `apps/web` (React PWA) | ⏳ |
| Deployment (Docker Compose + Cloudflare Tunnel) | ⏳ |

## Stack

TypeScript pnpm monorepo:

- `packages/engine`: pure, deterministic training logic shared by the API and the PWA
- `apps/api`: Node, Fastify, Postgres (Drizzle), pg-boss jobs, web push
- `apps/web`: React, Vite, PWA

## Getting started

Requires Node ≥ 22.12 and pnpm 10.

```bash
pnpm install
pnpm test
pnpm typecheck
```

## First thing to try: the watch spike

Before building the full app, check that a pace workout pushed through intervals.icu shows up on your watch **with pace targets**. One report says API-made workouts arrive as duration only.

1. In intervals.icu, connect your Garmin/COROS, turn on **Upload planned workouts**, and set your **threshold pace** under Settings → Run.
2. `cp .env.example .env` and paste your API key from intervals.icu → Settings → Developer Settings.
3. Run `pnpm spike:push` (or `pnpm spike:push --pace 5:50-6:07`).
4. Sync your watch and open tomorrow's "Paceo test" workout. Do the reps show a pace target?
5. Clean up with `pnpm spike:push --delete`.

Report back what the script printed and what the watch showed. That decides how the app encodes workouts.
