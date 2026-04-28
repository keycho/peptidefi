-- 0023_supplier_products_anon_select.sql
-- Open SELECT on public.supplier_products to the anon role so the
-- /vendors page (and any future per-supplier UI) can render BUY links.
--
-- Background: 0008 enabled RLS on supplier_products and intentionally
-- attached NO policies — listed in 0008's "LOCKED tables" comment as
-- service-role-only. That decision pre-dated the /vendors page, which
-- needs per-(peptide, supplier) product URLs and names to render the
-- BUY-link grid. With RLS on and no policies, anon SELECTs return zero
-- rows, so the BUY links render blank.
--
-- This migration adds a SELECT policy gated on `active = true`. The
-- exposed columns (supplier_id, peptide_id, supplier_sku, product_url,
-- product_name, mass_per_unit_mg) are all derived from public vendor
-- pages — anyone browsing the vendor's storefront sees the same data —
-- so making them publicly readable is consistent with the rest of the
-- public-by-default storefront (peptides, suppliers, peptide_twaps,
-- amm_pools, prediction_markets, leaderboard_snapshots, all opened in
-- 0010). Inactive rows (active=false) stay hidden to anon so retired
-- SKUs don't pollute the UI.
--
-- IMPORTANT: column is `active`, not `is_active`. peptides has
-- `is_active`; supplier_products predates that convention.
--
-- RLS is already enabled per 0008; the alter below is idempotent.

alter table public.supplier_products enable row level security;

drop policy if exists "supplier_products_select_public" on public.supplier_products;

create policy "supplier_products_select_public"
  on public.supplier_products for select
  to anon, authenticated
  using (active = true);
