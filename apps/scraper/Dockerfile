# PeptideFi scraper service — slim runtime image.
#
# WC Store API path uses plain fetch only; no headless browser is invoked
# at runtime (CAYMAN module is paused; BACHEM/SIGMA modules don't ship in
# this branch). The `playwright` npm package stays as a workspace dep for
# when we re-introduce browser-driven modules later, but we skip the
# chromium binary download to keep the image tiny.
#
# When we add browser-needing modules back, either bump this image's base
# to mcr.microsoft.com/playwright:v1.x.x-jammy OR move those modules to a
# separate "browser-scraper" service so the lean ones stay lean.
#
# Build context is the monorepo root (workspace deps resolve via pnpm
# symlinks at install time):
#
#   docker build -t peptidefi-scraper -f apps/scraper/Dockerfile .

FROM node:20-alpine

ENV NODE_ENV=production \
    PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

# Pin pnpm to the workspace's major via corepack so the lockfile resolves
# identically to local dev.
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

WORKDIR /app

# Layer 1: lockfile + manifests only. Caches the install layer across
# source-only changes.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY apps/scraper/package.json apps/scraper/
COPY packages/db/package.json packages/db/
COPY packages/shared/package.json packages/shared/

RUN pnpm install --frozen-lockfile --filter @peptidefi/scraper... --prod=false

# Layer 2: source. Cheap to invalidate.
COPY tsconfig.base.json ./
COPY apps/scraper apps/scraper
COPY packages/db packages/db
COPY packages/shared packages/shared

WORKDIR /app/apps/scraper

# Tini-style PID 1 signal handling: Node already handles SIGTERM via our
# graceful-shutdown handler in src/index.ts, but using the default exec
# form keeps signals routed correctly.
EXPOSE 8080
CMD ["pnpm", "start"]
