# Railway deployment — scraper + worker

Tomorrow's checklist for deploying the two backend services to Railway.
This branch is `claude/peptidefi-season-1-Hae69`.

The scraper and worker are two **separate Railway services** in one
Railway project, both built from this monorepo. The web app
(`apps/web`) is shelved for now — Lovable is the production frontend.

## One-time Railway project setup

1. Create a new Railway project from the GitHub repo
   `keycho/peptidefi`, branch `claude/peptidefi-season-1-Hae69`.
2. Create **two empty services** inside that project:
   - `peptidefi-scraper`
   - `peptidefi-worker`
3. For each service, in Settings → **Source**:
   - **Repository**: keycho/peptidefi
   - **Root Directory**: `/` (the monorepo root — the Dockerfiles need
     access to `packages/` and the workspace lockfile, so we never set
     this to `apps/scraper` or `apps/worker`)
   - **Watch Paths** (so a change to one service doesn't redeploy the
     other):
     - scraper service: `apps/scraper/**`, `packages/**`,
       `pnpm-lock.yaml`, `pnpm-workspace.yaml`
     - worker service: `apps/worker/**`, `packages/**`,
       `pnpm-lock.yaml`, `pnpm-workspace.yaml`
   - **Config-as-Code Path**:
     - scraper service: `apps/scraper/railway.json`
     - worker service: `apps/worker/railway.json`
4. The `railway.json` files already specify `Dockerfile` builder,
   `pnpm start` start command, and `/health` healthcheck path with a 30s
   timeout. No further build settings needed in the dashboard.

## Environment variables — per service

The two services share Supabase credentials but are otherwise
independent. Set the variables marked **required** before deploying.
Optional variables have sensible defaults — set only if you want to
override.

### Both services

| variable | required? | description | where to get it |
|---|---|---|---|
| `SUPABASE_URL` | **required** | `https://pjsjaspntdjecfitogtc.supabase.co` (the active project URL) | Supabase dashboard → Project Settings → API |
| `SUPABASE_SECRET_KEY` | **required** | Service-role key. Bypasses RLS. Never ship to the browser. | Supabase dashboard → Project Settings → API → secret key. **Rotate after Railway deploy** since it's also pasted into our chat history. |
| `HEALTH_PORT` | optional | HTTP port for `/health`. Default `8080`. Railway exposes this internally for the healthcheck. | — |
| `GIT_SHA` | optional | Written to `scraper_runs.git_sha` for incident triage. | Railway sets `RAILWAY_GIT_COMMIT_SHA` automatically — point to it: `GIT_SHA=$RAILWAY_GIT_COMMIT_SHA`. |
| `HOST_OVERRIDE` | optional | Identifies the running container in `scraper_runs.host`. Falls back to `os.hostname()`. Set to something descriptive if multiple replicas. | — |

### Scraper service only

| variable | required? | description |
|---|---|---|
| `SCRAPER_CYCLE_INTERVAL_MS` | optional | Milliseconds between cycles. Default `60000` (1 min). For ScrapingAnt free tier, set `600000` (10 min) so the 10k credit pool stretches ~7 days at ~6 credits/cycle. |
| `SCRAPER_USE_PROXY` | optional | `true` to route every WC catalog fetch through ScrapingAnt; `false` (default) for direct fetch. From Railway's datacenter IPs you almost certainly want `true` — direct fetches get rate-limited by Sucuri / Cloudflare on the vendor sites. |
| `SCRAPINGANT_API_KEY` | required if `SCRAPER_USE_PROXY=true` | ScrapingAnt API key. Get from https://app.scrapingant.com/ → Dashboard → API key. |

### Worker service only

| variable | required? | description |
|---|---|---|
| `WORKER_CYCLE_INTERVAL_MS` | optional | Milliseconds between cycles. Default `60000` (1 min). |
| `WORKER_FRESHNESS_CEILING_MS` | optional | Maximum age (ms) of a `supplier_observation` the worker will consider. Default `1800000` (30 min — three current scrape cycles of headroom). Beyond that, the supplier is treated as silent for that peptide and may produce thin-data rows. |
| `SCRAPER_CYCLE_INTERVAL_MS` | optional | **Set this in the worker too** even though the worker doesn't use it directly. The startup sanity check warns if `WORKER_CYCLE_INTERVAL_MS < SCRAPER_CYCLE_INTERVAL_MS && freshness_ceiling < scrape_interval` — caught the 2026-04-27 03:39 UTC null-row regression. |

## Before the first deploy — a few sanity checks

```bash
# 1. Make sure the lockfile + manifests in HEAD are consistent
pnpm install --frozen-lockfile

# 2. Type-check both services (would catch any drift in shared types)
pnpm --filter @peptidefi/scraper typecheck
pnpm --filter @peptidefi/worker typecheck

# 3. Optional: build both Docker images locally to surface any
#    Dockerfile / lockfile drift before Railway burns build minutes
docker build -t peptidefi-scraper -f apps/scraper/Dockerfile .
docker build -t peptidefi-worker  -f apps/worker/Dockerfile  .
```

## After the first deploy — verification steps

1. **Healthchecks pass.** Both services should reach the `READY` state
   in Railway within ~60s of the deploy. If they don't, check Settings →
   Healthcheck for the failing endpoint URL — should be
   `:8080/health` returning JSON with `"ok": true`.

2. **Logs show clean startup.**
   - Scraper: `[startup] scraper looping on 600000ms interval`
     followed by `[cycle] run=N status=success 58/64 ok 6 failed
     XXXXXms proxy=on credits_session=N`.
   - Worker: `[startup] worker looping on 60000ms interval` followed by
     `[twap] processed=14 with_twap=14 thin=0 inserted=14
     skipped_idempotent=0 XXXXms` once a minute.

3. **DB freshness.** From the Supabase dashboard SQL editor:
   ```sql
   select (now() - max(observed_at))  as obs_age,
          (select now() - max(computed_at) from peptide_twaps) as twap_age
   from supplier_observations where scrape_success;
   ```
   Expected: `obs_age` < the scraper interval, `twap_age` < 2 minutes.

4. **No SIGTERM-stuck rows.** After a deploy (which Railway implements
   as SIGTERM → spin-up new container → SIGTERM old):
   ```sql
   select id, started_at, status from scraper_runs
   where status = 'running' and started_at < now() - interval '5 minutes';
   ```
   Should always return zero rows. If we see rows here, the graceful
   shutdown handler isn't completing the in-flight cycle before exit.

## Operational notes

- **ScrapingAnt credit budget.** The scraper logs cumulative session
  credits in the `[cycle]` line. Tail the Railway logs after a few
  cycles to confirm the burn rate matches expectations
  (~6 credits/cycle on Wave-1 vendors). Track free-tier remaining at
  https://app.scrapingant.com/.

- **Stop the sandbox-running services.** Once the Railway services are
  green, kill the sandbox-running scraper and worker so we're not
  burning ScrapingAnt credits twice and not racing on the shared
  `peptide_twaps` upsert table. (In practice the upsert's unique
  `(peptide_id, computed_at)` constraint makes the race a no-op via
  `ON CONFLICT DO NOTHING`, but it's still wasted compute.)

- **Bachem / Sigma / Cayman are paused.** Their `supplier_products`
  rows are kept in the DB (`active=true`) but the scraper still emits
  6 failure rows per cycle for the 3 BACHEM + 3 SIGMA stub modules
  that aren't implemented yet. This shows up as `6 failed` in every
  cycle log — expected, not an alert. Cayman is `status='paused'` so
  its 3 rows are filtered out.

- **Wave-2 vendors (Limitless, Particle).** Not in this branch. Adding
  them is a separate scraper module each — see the recon report on the
  `claude/peptidefi-season-1-Hae69` branch for the platform notes
  (BigCommerce + PrestaShop respectively).
