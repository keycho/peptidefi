-- 0008_rls_policies.sql
-- Enable Row-Level Security on every table and add the SELECT policies the
-- frontend needs.
--
-- Policy model for week one:
--   - All writes happen via the service_role key from backend services
--     (scraper, worker, Next.js server actions). service_role bypasses RLS.
--   - The frontend uses the publishable key + an authenticated session;
--     it can only SELECT, never INSERT/UPDATE/DELETE.
--
-- Two read tiers:
--   PUBLIC (any authenticated user can SELECT all rows):
--     peptides, suppliers, peptide_twaps, amm_pools,
--     prediction_markets, leaderboard_snapshots
--
--   SELF (authenticated user can SELECT only their own rows):
--     users, point_balances, point_ledger, positions,
--     prediction_positions, amm_trades, prediction_trades
--
--   LOCKED (no SELECT policy → service_role only):
--     supplier_products, supplier_observations, supplier_twaps,
--     scraper_runs, outlier_log, availability_events,
--     point_grants, event_activations, treasury
--
-- Anon (unauthenticated) users get no access to anything; the home page
-- requires login and the policies use `to authenticated` exclusively.
--
-- The handle_new_auth_user() trigger (0003) is SECURITY DEFINER owned by the
-- postgres role, which has BYPASSRLS — so it continues to write into users,
-- point_balances, point_grants, and point_ledger after RLS lands here.

-- ─── enable RLS on every table ──────────────────────────────────────────────
alter table public.peptides              enable row level security;
alter table public.suppliers             enable row level security;
alter table public.supplier_products     enable row level security;
alter table public.users                 enable row level security;
alter table public.point_ledger          enable row level security;
alter table public.point_balances        enable row level security;
alter table public.point_grants          enable row level security;
alter table public.scraper_runs          enable row level security;
alter table public.supplier_observations enable row level security;
alter table public.supplier_twaps        enable row level security;
alter table public.peptide_twaps         enable row level security;
alter table public.outlier_log           enable row level security;
alter table public.availability_events   enable row level security;
alter table public.amm_pools             enable row level security;
alter table public.amm_trades            enable row level security;
alter table public.positions             enable row level security;
alter table public.prediction_markets    enable row level security;
alter table public.prediction_positions  enable row level security;
alter table public.prediction_trades     enable row level security;
alter table public.event_activations     enable row level security;
alter table public.treasury              enable row level security;
alter table public.leaderboard_snapshots enable row level security;

-- ─── PUBLIC read policies (any authenticated user) ──────────────────────────
create policy "peptides_select_authenticated"
  on public.peptides for select
  to authenticated using (true);

create policy "suppliers_select_authenticated"
  on public.suppliers for select
  to authenticated using (true);

create policy "peptide_twaps_select_authenticated"
  on public.peptide_twaps for select
  to authenticated using (true);

create policy "amm_pools_select_authenticated"
  on public.amm_pools for select
  to authenticated using (true);

create policy "prediction_markets_select_authenticated"
  on public.prediction_markets for select
  to authenticated using (true);

create policy "leaderboard_snapshots_select_authenticated"
  on public.leaderboard_snapshots for select
  to authenticated using (true);

-- ─── SELF read policies (auth.uid() must match owning column) ───────────────
create policy "users_select_self"
  on public.users for select
  to authenticated using (auth.uid() = id);

create policy "point_balances_select_self"
  on public.point_balances for select
  to authenticated using (auth.uid() = user_id);

create policy "point_ledger_select_self"
  on public.point_ledger for select
  to authenticated using (auth.uid() = user_id);

create policy "positions_select_self"
  on public.positions for select
  to authenticated using (auth.uid() = user_id);

create policy "prediction_positions_select_self"
  on public.prediction_positions for select
  to authenticated using (auth.uid() = user_id);

create policy "amm_trades_select_self"
  on public.amm_trades for select
  to authenticated using (auth.uid() = user_id);

create policy "prediction_trades_select_self"
  on public.prediction_trades for select
  to authenticated using (auth.uid() = user_id);

-- LOCKED tables (supplier_products, supplier_observations, supplier_twaps,
-- scraper_runs, outlier_log, availability_events, point_grants,
-- event_activations, treasury) intentionally have RLS enabled but no policies
-- attached — only service_role can read/write them. Frontend code that tries
-- to query them with the publishable key returns an empty result set.
