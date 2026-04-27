# PeptideFi API service — slim runtime image.
#
# Express + jose JWT verification + Supabase service-role client. No
# headless browsers, no scraping. Same Node 20 alpine base + pnpm 10
# pattern as the worker.
#
# Build context is the monorepo root (workspace deps resolve via pnpm
# symlinks at install time):
#
#   docker build -t peptidefi-api -f apps/api/Dockerfile .

FROM node:20-alpine

ENV NODE_ENV=production \
    PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH

RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

WORKDIR /app

# Layer 1: lockfile + manifests. Caches install across source-only changes.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY apps/api/package.json apps/api/
COPY packages/db/package.json packages/db/
COPY packages/shared/package.json packages/shared/

RUN pnpm install --frozen-lockfile --filter @peptidefi/api... --prod=false

# Layer 2: source.
COPY tsconfig.base.json ./
COPY apps/api apps/api
COPY packages/db packages/db
COPY packages/shared packages/shared

WORKDIR /app/apps/api

# Single port: /health and the user-facing routes both live on API_PORT
# so Railway's single-port healthcheck model works. PORT env (Railway
# auto-injects) takes precedence over API_PORT in src/index.ts.
EXPOSE 3000
CMD ["pnpm", "start"]
