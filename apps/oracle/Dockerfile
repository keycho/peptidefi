# peptide-oracle on-chain commit service — slim runtime image.
#
# Pure compute service: polls Postgres for ready cycles + TWAPs, signs
# Memo transactions, submits to a Solana RPC, records confirmation
# state. Same Node 20 alpine base as the worker for consistency.
#
# Build context is the monorepo root (workspace deps resolve via pnpm
# symlinks at install time):
#
#   docker build -t peptide-oracle-oracle -f apps/oracle/Dockerfile .

FROM node:20-alpine

ENV NODE_ENV=production \
    PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH

RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

WORKDIR /app

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY apps/oracle/package.json apps/oracle/
COPY packages/db/package.json packages/db/
COPY packages/shared/package.json packages/shared/

RUN pnpm install --frozen-lockfile --filter @peptide-oracle/oracle... --prod=false

COPY tsconfig.base.json ./
COPY apps/oracle apps/oracle
COPY packages/db packages/db
COPY packages/shared packages/shared

WORKDIR /app/apps/oracle

EXPOSE 8080
CMD ["pnpm", "start"]
