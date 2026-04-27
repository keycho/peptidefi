-- 0010_public_anon_read.sql
-- Open the 6 public-read tables to the anon role so unauthenticated visitors
-- can browse the platform. The product is public-by-default with gated
-- mutations (Hyperliquid / Polymarket / Uniswap pattern), so the storefront
-- (charts, AMM screens, prediction markets, leaderboard) must render without
-- a session.
--
-- 0008 attached SELECT policies for `to authenticated` only; this migration
-- drops those and re-creates them as `to anon, authenticated`. SELF-scoped
-- policies (auth.uid() = user_id) and the 9 LOCKED tables are unchanged —
-- a logged-out visitor still cannot see anyone's portfolio, ledger, etc.

-- peptides
drop policy if exists "peptides_select_authenticated" on public.peptides;
create policy "peptides_select_public"
  on public.peptides for select
  to anon, authenticated using (true);

-- suppliers
drop policy if exists "suppliers_select_authenticated" on public.suppliers;
create policy "suppliers_select_public"
  on public.suppliers for select
  to anon, authenticated using (true);

-- peptide_twaps
drop policy if exists "peptide_twaps_select_authenticated" on public.peptide_twaps;
create policy "peptide_twaps_select_public"
  on public.peptide_twaps for select
  to anon, authenticated using (true);

-- amm_pools
drop policy if exists "amm_pools_select_authenticated" on public.amm_pools;
create policy "amm_pools_select_public"
  on public.amm_pools for select
  to anon, authenticated using (true);

-- prediction_markets
drop policy if exists "prediction_markets_select_authenticated" on public.prediction_markets;
create policy "prediction_markets_select_public"
  on public.prediction_markets for select
  to anon, authenticated using (true);

-- leaderboard_snapshots
drop policy if exists "leaderboard_snapshots_select_authenticated" on public.leaderboard_snapshots;
create policy "leaderboard_snapshots_select_public"
  on public.leaderboard_snapshots for select
  to anon, authenticated using (true);
