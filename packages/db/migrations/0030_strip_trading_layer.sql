-- 0030_strip_trading_layer.sql
-- Drop everything that the upstream project built on top of the
-- scraping / TWAP layer: trading positions, prediction markets, the
-- points economy, the user leaderboard, and the AMM scaffolding that
-- was never used. The new project keeps only the read-only oracle
-- surface (peptides / suppliers / supplier_products / supplier_obs /
-- peptide_twaps / market_summary / vendor_arbitrage / vendor_leaderboard).
--
-- Why this lives at the END of the migration sequence, not the start
-- ----------------------------------------------------------------------
-- The migrations 0001..0029 were inherited as-is from the upstream
-- project. Re-running them on a fresh database builds the original
-- schema (including the parts we're throwing away here). This single
-- strip migration then deletes the parts we don't want.
--
-- That's wasteful — the fresh DB ends up doing a build-and-tear-down
-- for tables it'll never use — but it preserves the audit trail and
-- means we don't have to retrofit-edit historical migrations. A
-- future cleanup pass can consolidate 0001..0030 into a single fresh
-- "create the kept schema" migration once the new project's schema
-- has stabilized.
--
-- Idempotency: every drop uses IF EXISTS, so this migration is safe
-- to apply against any state — fresh DB with full upstream schema, or
-- a partially-stripped DB.
--
-- DROP CASCADE is used liberally because the upstream design has many
-- cross-references (FKs from event_activations to amm_pools etc.).
-- We've already verified no app code still imports any of these
-- surfaces in this repo.
--
-- What's KEPT (do not touch):
--   tables   peptides, suppliers, supplier_products, supplier_observations,
--            supplier_twaps, peptide_twaps, scraper_runs, outlier_log,
--            availability_events, api_waitlist, public.users
--   views    market_summary, vendor_arbitrage, vendor_leaderboard
--   types    availability_tier, peptide_status, supplier_status,
--            vault_status, event_type
--   trigger  handle_new_auth_user (still creates a public.users row;
--            the display_name + is_admin columns it sets are vestigial
--            after this migration, but harmless)

-- ─── Trading: positions ────────────────────────────────────────────────
drop function if exists public.open_position(uuid, bigint, public.position_direction, numeric, numeric, bigint, text) cascade;
drop function if exists public.close_position(uuid, uuid, numeric, bigint) cascade;
drop table if exists public.position_settlements cascade;
drop table if exists public.positions            cascade;
drop type  if exists public.position_status      cascade;
drop type  if exists public.position_direction   cascade;

-- ─── Predictions v0.5 ──────────────────────────────────────────────────
drop function if exists public.place_bet(uuid, uuid, public.prediction_bet_side, numeric, text) cascade;
drop function if exists public.resolve_market(uuid, text, uuid, text)                            cascade;
drop function if exists public.flag_markets_ready_for_resolution()                                cascade;
drop view  if exists public.prediction_market_stats cascade;
drop table if exists public.prediction_resolution_suggestions cascade;
drop table if exists public.prediction_bets                  cascade;
drop table if exists public.prediction_markets               cascade;
drop type  if exists public.prediction_bet_status     cascade;
drop type  if exists public.prediction_bet_side       cascade;
drop type  if exists public.prediction_market_status  cascade;
-- predictions_waitlist is a sign-up table specifically for the
-- predictions feature; drop with the rest of that surface.
drop table if exists public.predictions_waitlist cascade;

-- ─── User leaderboard ──────────────────────────────────────────────────
-- The vendor_leaderboard view (added in 0024) is *kept* — it's a vendor-
-- side ranking and stays useful for an oracle product.
drop view if exists public.leaderboard cascade;

-- ─── Points economy ────────────────────────────────────────────────────
drop table if exists public.point_ledger   cascade;
drop table if exists public.point_grants   cascade;
drop table if exists public.point_balances cascade;

-- ─── Display-name helpers (leaderboard support) ────────────────────────
-- The display_name + is_admin + display_name_changed_at columns on
-- public.users are kept (cheap, vestigial). The bespoke uniqueness
-- helper added in 0017 is dropped — it'll get re-added by a future
-- migration if the new project needs it.
drop function if exists public.generate_unique_display_name() cascade;

-- ─── AMM scaffolding (was built in 0005, never went live) ──────────────
drop table if exists public.amm_trades cascade;
drop table if exists public.amm_pools  cascade;
drop type  if exists public.amm_pool_status cascade;

-- ─── Treasury singleton + event bridge (0007) ─────────────────────────
drop table if exists public.event_activations cascade;
drop table if exists public.treasury          cascade;

-- ─── Leaderboard snapshots (defined in 0007 alongside treasury) ────────
drop table if exists public.leaderboard_snapshots cascade;
