-- 0014_amm_positions.sql
-- Phase 5 — synthetic spot speculation engine.
--
-- Despite the lingering "AMM" naming on this directory, this is NOT a
-- constant-product or virtual-reserves AMM. Each position tracks a
-- peptide's TWAP 1:1 from the entry tick, with the user's PnL computed
-- live from (current_twap - entry_twap) / entry_twap. No slippage, no
-- price impact, no liquidity dynamics. The legacy public.amm_pools and
-- public.amm_trades tables from 0005 stay untouched (still empty) and
-- can host a real AMM later if we go that direction.
--
-- This migration:
--   1. DROPs the placeholder positions table from 0005 (composite PK
--      user_id+peptide_id allowed only one position per pair — wrong for
--      this model where a user can hold multiple long+short positions on
--      the same peptide simultaneously). Empty table, no data loss.
--   2. Adds two enums: position_status and position_direction.
--   3. CREATEs the new positions table with uuid PK + idempotency.
--   4. CREATEs position_settlements — the worker writes one row per
--      (open position × new peptide_twap) so we get a free per-position
--      value-over-time history for charts. Position itself stays
--      "stateless" between open and close — current value is always
--      derivable from the latest TWAP.
--   5. RLS: SELF SELECT policies for both tables. All writes go through
--      the API service-role key (bypasses RLS), never user-side.

-- ─── reset old positions table from 0005 ────────────────────────────────────
-- DROP CASCADE removes the SELF SELECT policy from 0008 too; we re-create
-- the new policies below.
drop table if exists public.positions cascade;

-- ─── new enums ──────────────────────────────────────────────────────────────
create type public.position_status as enum ('open', 'closed');
create type public.position_direction as enum ('long', 'short');

-- ─── positions ─────────────────────────────────────────────────────────────
-- One row per user trade. opened_at and entry_* are immutable post-create;
-- closed_at + exit_* + realized_pnl_points get filled atomically on close.
--
-- Bounded loss invariant (enforced by the API, documented here):
--   - Long  positions: value = entry_size * (1 + pct_change). At TWAP→0,
--     value→0. Naturally bounded — no clamp needed.
--   - Short positions: value = entry_size * (1 - pct_change). At TWAP=2×
--     entry, value=0. At TWAP>2× entry, the formula goes negative, so the
--     API clamps current_value_points and realized_pnl_points so that the
--     user can never owe more than entry_size_points. Realistically not a
--     concern given peptide TWAP volatility, but defensive.
create table public.positions (
  id                       uuid not null default gen_random_uuid() primary key,
  user_id                  uuid not null references public.users(id) on delete restrict,
  peptide_id               bigint not null references public.peptides(id) on delete restrict,
  direction                public.position_direction not null,
  entry_size_points        numeric(20, 6) not null,
  entry_twap_usd_per_mg    numeric(20, 6) not null,
  opened_at                timestamptz not null default now(),
  closed_at                timestamptz,
  exit_twap_usd_per_mg     numeric(20, 6),
  realized_pnl_points      numeric(20, 6),
  status                   public.position_status not null default 'open',
  idempotency_key          text not null,

  constraint positions_entry_size_positive
    check (entry_size_points > 0),
  constraint positions_entry_twap_positive
    check (entry_twap_usd_per_mg > 0),
  constraint positions_exit_twap_positive
    check (exit_twap_usd_per_mg is null or exit_twap_usd_per_mg > 0),

  -- status / closed_at / exit_* / realized_pnl move together in one atomic
  -- transition. Either we're open (all close-side fields null) or we're
  -- closed (all close-side fields set). No half-states.
  constraint positions_status_consistency check (
    (status = 'open'
       and closed_at is null
       and exit_twap_usd_per_mg is null
       and realized_pnl_points is null)
    or
    (status = 'closed'
       and closed_at is not null
       and exit_twap_usd_per_mg is not null
       and realized_pnl_points is not null)
  ),

  -- Per-user idempotency on open. The /positions/open endpoint inserts
  -- the row with a client-supplied key; the unique violation cleanly
  -- short-circuits a retry into "fetch and return existing position".
  constraint positions_user_idem_unique
    unique (user_id, idempotency_key)
);

-- List a user's positions, hot path for /positions GET.
create index positions_user_status_idx
  on public.positions (user_id, status);

-- Settlement fan-out: find every OPEN position for a peptide on each
-- new peptide_twap. Partial index because the worker only ever queries
-- status='open' rows.
create index positions_peptide_open_idx
  on public.positions (peptide_id)
  where status = 'open';

-- Time-ordered list within a user (for the user-facing history view).
create index positions_user_opened_idx
  on public.positions (user_id, opened_at desc);

-- ─── position_settlements ──────────────────────────────────────────────────
-- One row per (open position × new peptide_twap). Worker writes these
-- after each TWAP cycle. Position itself isn't updated — the live UI
-- always re-derives current value from the latest TWAP — these rows
-- exist purely so we can render "your BPC-157 long over time" charts.
--
-- Idempotency via unique (position_id, peptide_twap_id): if the worker's
-- settlement pass re-runs for any reason, ON CONFLICT DO NOTHING keeps
-- the table clean.
create table public.position_settlements (
  id                       bigint generated by default as identity primary key,
  position_id              uuid not null references public.positions(id) on delete cascade,
  peptide_twap_id          bigint not null references public.peptide_twaps(id) on delete cascade,
  settled_at               timestamptz not null default now(),
  twap_usd_per_mg          numeric(20, 6) not null,
  unrealized_pnl_points    numeric(20, 6) not null,
  current_value_points     numeric(20, 6) not null,

  constraint position_settlements_value_nonneg
    check (current_value_points >= 0),
  constraint position_settlements_unique
    unique (position_id, peptide_twap_id)
);

-- Time-series read pattern: latest N settlements for a single position.
create index position_settlements_position_settled_idx
  on public.position_settlements (position_id, settled_at desc);

-- For the worker's settlement pass: "find settlements I already wrote
-- for this peptide_twap" / "what positions still need a row".
create index position_settlements_twap_idx
  on public.position_settlements (peptide_twap_id);

-- ─── RLS ────────────────────────────────────────────────────────────────────
-- Both tables enable RLS. The API uses the service-role key for INSERTs
-- and UPDATEs (bypasses RLS); only SELECT policies are needed for the
-- user-facing read path through Lovable / Supabase JS client with the
-- publishable key.
alter table public.positions             enable row level security;
alter table public.position_settlements  enable row level security;

create policy "positions_select_self"
  on public.positions for select
  to anon, authenticated
  using (auth.uid() = user_id);

-- Settlement rows scope through the parent position. EXISTS is preferred
-- over a join here because PostgREST can short-circuit the lookup against
-- the positions PK.
create policy "position_settlements_select_self"
  on public.position_settlements for select
  to anon, authenticated
  using (
    exists (
      select 1
      from public.positions p
      where p.id = position_settlements.position_id
        and p.user_id = auth.uid()
    )
  );
