# Fork notes: from biohack.market → peptide-oracle

Internal record of the strip-and-rename pass. Not for public reading.
The placeholder name `peptide-oracle` is used throughout; final
branding lands in a separate pass.

## What this repo is

A pared-back fork of the biohack.market codebase, kept structurally
similar but with the trading / prediction / points / user-leaderboard
surfaces stripped out. What remains:

- vendor scrapers (WooCommerce + Cayman) and the per-supplier adapter
  contract in `apps/scraper`
- the TWAP computation engine in `apps/worker`
- the public read-only API in `apps/api` (`/vendors/leaderboard`,
  `/arbitrage`, `/health`)
- shared numeric / pricing / mass / fx / supabase-admin / scraper-types
  helpers in `packages/shared`
- the full SQL migration history in `packages/db/migrations/` plus a
  new `0030_strip_trading_layer.sql` that drops everything we stripped

This is intended as the foundation for an on-chain peptide oracle
product. The Anchor program, on-chain commit backend, and any new
read surfaces are *not* in scope for this pass.

## What was kept

### apps

- `apps/scraper` — entire app. Untouched.
- `apps/worker` — kept; `maybeFlagPredictions` and its env var
  (`PREDICTIONS_FLAG_INTERVAL_MS`) removed from `src/index.ts`.
- `apps/api` — skeleton kept; only `routes/arbitrage.ts` and
  `routes/vendors.ts` survive.

### packages

- `packages/shared` — entire package. Renamed
  `@peptidefi/shared` → `@peptide-oracle/shared`.
- `packages/db` — all 29 inherited migrations + new
  `0030_strip_trading_layer.sql`.

### infra

- `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json` kept.
  Workspace name `peptidefi` → `peptide-oracle`. Subpackage names
  `@peptidefi/*` → `@peptide-oracle/*`.
- Dockerfiles for scraper / worker / api kept; image tags renamed
  in their header comments.
- `RAILWAY_DEPLOYMENT.md` kept; service names + repo references
  updated.

## What was removed

### apps

- `apps/web` — entire Next.js app. Was already shelved in the upstream
  project (Lovable is the production frontend). Removing it cleans up
  the dependency surface.
- `apps/api/src/routes/balance.ts`
- `apps/api/src/routes/leaderboard.ts`
- `apps/api/src/routes/positions.ts`
- `apps/api/src/routes/predictions.ts`
- `apps/api/src/routes/profile.ts`

### code in still-present files

- `apps/api/src/index.ts` — all imports + `app.use()` calls for the
  removed routes; the `biohack.market` static origins comment.
- `apps/api/src/errors.ts` — error helpers specific to trading /
  predictions (`insufficientBalance`, `peptideNotFound`,
  `positionNotFound`, `marketDataStale`, `idempotencyKeyReused`,
  `displayNameTaken`, `marketNotFound`, `marketNotOpen`,
  `marketClosed`, `marketNotResolvable`, `belowMinBet`,
  `exceedsUserLimit`, `invalidOutcome`,
  `idempotencyKeyReusedDifferentParams`). Kept the generic
  `invalidInput` / `notAuthorized` / `internal` / `rateLimited` —
  they'll be useful again as soon as we add protected oracle endpoints.
- `apps/api/src/validators.ts` — schemas for trading/predictions/
  display-name/leaderboard/profile. Kept `arbitrageQuerySchema`
  (used by the arbitrage route).
- `apps/api/src/cors-config.ts` — `https://biohack.market` and
  `https://www.biohack.market` removed from `STATIC_ALLOWED`. The
  500-on-rejected-origin fix from the upstream project is preserved.
- `apps/worker/src/index.ts` — `maybeFlagPredictions()`, the
  `PREDICTIONS_FLAG_INTERVAL_MS` env, and the call site in the main
  loop.

### database (handled by 0030_strip_trading_layer.sql)

- Trading: `positions`, `position_settlements`, `open_position` /
  `close_position` RPCs, `position_status` / `position_direction`
  enums.
- Predictions v0.5: `prediction_markets`, `prediction_bets`,
  `prediction_resolution_suggestions`, `prediction_market_stats` view,
  `place_bet` / `resolve_market` /
  `flag_markets_ready_for_resolution` RPCs, plus the three prediction
  enums. Also `predictions_waitlist` (specific to that surface).
- User leaderboard: `leaderboard` view (the *vendor* leaderboard view
  is **kept** — different surface, useful for an oracle product).
- Points economy: `point_balances`, `point_ledger`, `point_grants`.
- AMM scaffolding (built in 0005, never used): `amm_pools`,
  `amm_trades`, `amm_pool_status` enum.
- Event bridge / treasury (built in 0007, never used):
  `event_activations`, `treasury`, `leaderboard_snapshots`.
- The bespoke display-name uniqueness helper `generate_unique_display_name()`.

### kept-but-vestigial

- `public.users.display_name`, `display_name_changed_at`, `is_admin`
  — the columns survive (the auth trigger sets them). Harmless. A
  follow-up migration can drop them once the new product's user model
  is decided.
- `apps/api/src/auth.ts` — JWT verification middleware preserved for
  future protected endpoints (admin commits, paid API tiers). Not
  imported by any route today.

## Migration strategy

Applying `packages/db/migrations/0001..0030` in order against a fresh
Supabase project lands the kept-only schema. The first 29 migrations
build the full upstream schema; `0030_strip_trading_layer.sql` then
drops everything we don't want. This is wasteful (DB does
build-and-tear-down for tables it'll never use) but preserves the
audit trail and avoids retrofit-editing historical files.

A future cleanup pass can consolidate `0001..0030` into a single
fresh "create the kept schema" migration once the new project's
schema has stabilized.

The strip migration is **idempotent** (every drop uses `IF EXISTS`)
so it's safe to apply against any state.

**This migration was NOT applied to the biohack.market production
database.** It is purely for the new repo's future deployment to a
new Supabase project.

## Decisions made during the fork

- **`vendor_leaderboard` view kept** even though "leaderboard" was on
  the strip list, because it's a vendor-side ranking (which suppliers
  are best on price / freshness / coverage), not a user-side one. It
  stays useful for an oracle explorer surface.
- **`api_waitlist` table kept** (general email collection — survives
  any product pivot). `predictions_waitlist` dropped (specific to the
  predictions feature).
- **Dropped `apps/web` rather than salvaging** — was already shelved
  upstream (Lovable replaced it), and dragging dead Next.js code into
  a fresh project would be more cleanup work than a future rebuild.
- **Vestigial columns on `public.users`** kept (display_name etc.) so
  the auth trigger keeps working without an immediate schema rewrite.
- **No production CORS origins in `STATIC_ALLOWED`** — the new
  product's domain is undecided; new origins land via the
  `CORS_ORIGINS` env var until a permanent domain is settled.

## Verification

```
pnpm install                                     # clean
pnpm --filter @peptide-oracle/api      typecheck # passes
pnpm --filter @peptide-oracle/scraper  typecheck # passes
pnpm --filter @peptide-oracle/worker   typecheck # passes
pnpm --filter @peptide-oracle/shared   typecheck # passes
```

Functional verification (scraping against test data, TWAP correctness,
end-to-end against a populated DB) requires a Supabase project to
point at. Do that as part of the first deploy.

## Open questions / follow-ups

- Decide whether to consolidate `0001..0030` into a fresh `0001`-only
  schema migration. Cleaner long-term; loses the upstream audit trail.
- Decide the new product's user model. If the oracle reads stay
  fully public, the `auth.users` trigger and the vestigial columns on
  `public.users` can be removed entirely. If there's a paid /
  authenticated tier, keep them and decide whether `is_admin` stays.
- Add the Anchor program scaffold + on-chain commit backend in a
  separate pass.
- Final branding: replace `peptide-oracle` placeholder once the
  product name lands.
- Set up the GitHub remote and push the initial commit (this fork
  was created locally; no remote configured).
- Configure a fresh Supabase project + Railway services with the
  scraper / worker / api Dockerfiles + the renamed env vars.
