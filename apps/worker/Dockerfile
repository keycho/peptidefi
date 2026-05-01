# PeptideFi TWAP worker — slim runtime image.
#
# Pure compute service: only talks to Supabase, no headless browsers, no
# vendor scraping. Same Node 20 alpine base as the scraper for consistency.
#
# Build context is the monorepo root (workspace deps resolve via pnpm
# symlinks at install time):
#
#   docker build -t peptide-oracle-worker -f apps/worker/Dockerfile .

FROM node:20-alpine

ENV NODE_ENV=production \
    PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH

RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

WORKDIR /app

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY apps/worker/package.json apps/worker/
COPY packages/db/package.json packages/db/
COPY packages/shared/package.json packages/shared/

RUN pnpm install --frozen-lockfile --filter @peptide-oracle/worker... --prod=false

COPY tsconfig.base.json ./
COPY apps/worker apps/worker
COPY packages/db packages/db
COPY packages/shared packages/shared

WORKDIR /app/apps/worker

EXPOSE 8080
CMD ["pnpm", "start"]
