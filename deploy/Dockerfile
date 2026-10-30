# syntax=docker/dockerfile:1.7
# Paceo: API + jobs + the built PWA in one small image. Build from the repo root:
#   docker build -f deploy/Dockerfile -t paceo-api .
# (docker compose in deploy/ does this for you.)

ARG NODE_IMAGE=node:22-alpine

# ── base: pnpm via corepack (version pinned by the root package.json "packageManager") ──
FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH COREPACK_ENABLE_DOWNLOAD_PROMPT=0 CI=true
RUN corepack enable
WORKDIR /repo

# ── build: full install, bundle the API, build the web app if present ──
FROM base AS build
COPY . .
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    if [ -f pnpm-lock.yaml ]; then pnpm install --frozen-lockfile; else pnpm install --no-frozen-lockfile; fi
RUN pnpm --filter @paceo/api build \
 && if [ -f apps/web/package.json ]; then pnpm --filter @paceo/web build; fi \
 && mkdir -p apps/web/dist

# ── prod-deps: only the API's runtime dependencies (workspace packages are bundled into dist) ──
FROM base AS prod-deps
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* ./
COPY packages/engine/package.json packages/engine/
COPY packages/contracts/package.json packages/contracts/
COPY apps/api/package.json apps/api/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --prod --filter @paceo/api --no-frozen-lockfile --ignore-scripts

# ── runtime ──
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    WEB_DIST_DIR=/repo/apps/web/dist \
    PACEO_MIGRATIONS_DIR=/repo/apps/api/drizzle \
    NODE_OPTIONS=--max-old-space-size=256
WORKDIR /repo/apps/api
COPY --from=prod-deps --chown=node:node /repo/node_modules /repo/node_modules
COPY --from=prod-deps --chown=node:node /repo/apps/api/node_modules ./node_modules
COPY --from=build --chown=node:node /repo/apps/api/package.json ./package.json
COPY --from=build --chown=node:node /repo/apps/api/dist ./dist
COPY --from=build --chown=node:node /repo/apps/api/drizzle ./drizzle
COPY --from=build --chown=node:node /repo/apps/web/dist /repo/apps/web/dist
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]
