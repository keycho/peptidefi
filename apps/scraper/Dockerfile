# PeptideFi scraper service
#
# Base image ships with Chromium + system deps preinstalled, so the build is
# small (no apt-get for fonts, libnss3, etc.) and reliable on Railway.
#
# Build context is the monorepo root, NOT apps/scraper — pnpm workspaces
# resolve via symlinks at install time and need to see the whole tree.
# Build with:
#
#   docker build -t peptidefi-scraper -f apps/scraper/Dockerfile .

FROM mcr.microsoft.com/playwright:v1.49.0-jammy

ENV NODE_ENV=production \
    PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH

# Install pnpm. We pin to the same major as the workspace (10.x) via corepack
# so the lockfile resolves identically.
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

WORKDIR /app

# Copy workspace manifests first so pnpm install can be cached on Docker layers.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY apps/scraper/package.json apps/scraper/
COPY packages/db/package.json packages/db/
COPY packages/shared/package.json packages/shared/

RUN pnpm install --frozen-lockfile --filter @peptidefi/scraper... --prod=false

# Now bring in the source. Order matters less here since deps are already
# installed.
COPY tsconfig.base.json ./
COPY apps/scraper apps/scraper
COPY packages/db packages/db
COPY packages/shared packages/shared

WORKDIR /app/apps/scraper

# Service-role key + URL are injected by Railway at runtime. Loop forever.
CMD ["pnpm", "start"]
