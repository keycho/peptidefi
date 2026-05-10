-- 0036_new_vendors_and_peptides.sql
-- Add three new WooCommerce vendors (PANDA, PURETESTED, PEPTIDELABS)
-- and seed their initial supplier_products. Activates the previously-
-- inactive RETATRUTIDE peptide so all five user-requested peptides
-- (GHK-Cu, MOTS-c, PT-141, Tesamorelin, Retatrutide) have a canonical
-- code that scraper rows can reference.
--
-- KEY DESIGN POINT — TWAP gating:
--   New `suppliers.enabled_in_twap` column. Existing 8 vendors backfill
--   to TRUE (default). The 3 new vendors get FALSE — their observations
--   are scraped + recorded but EXCLUDED from TWAP cohorts until the
--   operator flips the flag after a 7-day quality review. This decouples
--   "vendor is being scraped" from "vendor's price contributes to the
--   on-chain peg". Worker's loadLatestObservationsPerSupplier filters
--   on this column; flipping false→true on a later cycle fires a
--   vendor_promoted_to_twap anomaly event so the operations log captures
--   the full lifecycle: onboarded → observed → promoted → producing prices.
--
-- KEY DESIGN POINT — PEPTIDELABS deferred SKUs:
--   peptidelabsinc.com is behind a Sucuri WAF that blocks datacenter
--   IPs (verified via sandbox curl: HTTP 202 + sgcaptcha challenge).
--   Production needs SCRAPER_USE_PROXY=true (commit d2c4788) to scrape
--   it. Sandbox can't probe product IDs without burning a proxy credit,
--   so PEPTIDELABS supplier_products rows are seeded with:
--     - supplier_sku = 'PENDING_<peptide_code>' (sentinel; the schema
--       requires NOT NULL + (supplier_id, supplier_sku) unique, so a
--       per-peptide suffix avoids collisions)
--     - active = false
--     - product_url = best-guess URL based on the BPC-157 pattern the
--       operator described (/product/<peptide>-<mg>mg/)
--   Operator backfills the real WC product IDs after the first proxy
--   scrape and flips active=true in a follow-up. Until then, the
--   scraper's loadActiveProducts() filter (active=true) skips them
--   cleanly — no parser_failure spam.
--
-- KEY DESIGN POINT — PURETESTED GHK-Cu skipped:
--   PureTested doesn't sell standalone GHK-Cu — only blends (KLOW,
--   GLOW). Per operator decision, we skip rather than seed against a
--   blend SKU (would pollute the price signal — can't decompose blend
--   pricing into per-peptide components without making assumptions).
--   PANDA + PEPTIDELABS both stock standalone GHK-Cu; coverage isn't
--   lost.
--
-- KEY DESIGN POINT — Tesa ambiguity on PureTested:
--   PureTested sells both Tesamorelin (slug 'tesa-*') and Tesofensine
--   (slug 'tesofensine-*'). They're DIFFERENT peptides. We bind the
--   TESAMORELIN seed to id=987658986 ('tesa-peptide-ga1', name 'Tesa
--   10MG Peptide') explicitly. No alias resolver — per-vendor SKU
--   binding sidesteps the ambiguity.
--
-- KEY DESIGN POINT — Per-vendor canonical = lyophilised injectable:
--   Where multiple formats exist (vial vs nasal spray vs blend), pick
--   the lyophilised injectable vial as the canonical SKU per operator
--   decision. Format-specific tracking is a future migration.

-- ── up ─────────────────────────────────────────────────────────────

-- 1. Schema: enabled_in_twap on suppliers
alter table public.suppliers
  add column if not exists enabled_in_twap boolean not null default true;

comment on column public.suppliers.enabled_in_twap is
  'When false, the vendor is scraped (observations recorded) but excluded from TWAP cohorts. Flip to true after quality review. See migration 0036.';

-- 2. Activate RETATRUTIDE (was seeded is_active=false in migration 0019)
-- Note: peptides has both `status` (enum, original) and `is_active`
-- (boolean added in migration 0012). Runtime gates use `is_active`;
-- see migration 0023 comment for the full convention.
update public.peptides
   set is_active = true
 where code = 'RETATRUTIDE';

-- 3. Insert 3 new vendors. enabled_in_twap=false so they don't enter
-- TWAP cohorts on first scrape. status='active' so the scraper picks
-- them up. ON CONFLICT (code) DO NOTHING for re-run idempotency.
insert into public.suppliers
  (code, display_name, homepage_url, scraper_module, status, enabled_in_twap, notes)
values
  ('PANDA',       'Panda Peptides',       'https://pandapeptides.com/',         'woocommerce', 'active', false,
   'Onboarded migration 0036. CA-based, Janoshik-tested. enabled_in_twap=false pending 7-day quality review.'),
  ('PURETESTED',  'Pure Tested Peptides', 'https://www.puretestedpeptides.com/', 'woocommerce', 'active', false,
   'Onboarded migration 0036. www subdomain required. enabled_in_twap=false pending 7-day quality review.'),
  ('PEPTIDELABS', 'Peptide Labs',         'https://peptidelabsinc.com/',        'woocommerce', 'active', false,
   'Onboarded migration 0036. Behind Sucuri — requires SCRAPER_USE_PROXY=true. Default unit is "kit of 10 vials"; seeds use per-vial slugs explicitly. enabled_in_twap=false pending 7-day quality review.')
on conflict (code) do nothing;

-- 4. supplier_products seeds.
--
-- mass_per_unit_mg is a best-effort initial estimate from the WC
-- catalog name; the scraper's updateProductMass() rewrites it from
-- the real variant attribute on the first successful scrape.
--
-- is_reference_sku=true on every row — each (vendor, peptide) pair
-- has exactly one SKU per the existing schema unique constraint.

-- ── PANDA seeds (5 peptides, all confirmed via sandbox curl) ──────
insert into public.supplier_products
  (supplier_id, peptide_id, supplier_sku, product_url, product_name, mass_per_unit_mg, is_reference_sku, active)
values
  ((select id from public.suppliers where code = 'PANDA'),
   (select id from public.peptides  where code = 'GHKCU'),
   '7250', 'https://pandapeptides.com/product/ghk-cu/',          'GHK-Cu',           50, true, true),
  ((select id from public.suppliers where code = 'PANDA'),
   (select id from public.peptides  where code = 'MOTSC'),
   '7252', 'https://pandapeptides.com/product/mots-c/',          'MOTS-c',           10, true, true),
  ((select id from public.suppliers where code = 'PANDA'),
   (select id from public.peptides  where code = 'PT141'),
   '7269', 'https://pandapeptides.com/product/pt-141/',          'PT-141 10mg',      10, true, true),
  ((select id from public.suppliers where code = 'PANDA'),
   (select id from public.peptides  where code = 'TESAMORELIN'),
   '7290', 'https://pandapeptides.com/product/tesamorelin/',     'Tesamorelin 10mg', 10, true, true),
  ((select id from public.suppliers where code = 'PANDA'),
   (select id from public.peptides  where code = 'RETATRUTIDE'),
   '7196', 'https://pandapeptides.com/product/glp-3/',           'GLP-3',            10, true, true)
on conflict (supplier_id, supplier_sku) do nothing;

-- ── PURETESTED seeds (4 peptides — NO GHKCU per operator decision) ──
insert into public.supplier_products
  (supplier_id, peptide_id, supplier_sku, product_url, product_name, mass_per_unit_mg, is_reference_sku, active)
values
  ((select id from public.suppliers where code = 'PURETESTED'),
   (select id from public.peptides  where code = 'MOTSC'),
   '987658569',
   'https://www.puretestedpeptides.com/product/mots-c-40mg-peptide-for-sale-ga3/',
   'MOTS-c 40MG peptide for sale', 40, true, true),
  ((select id from public.suppliers where code = 'PURETESTED'),
   (select id from public.peptides  where code = 'PT141'),
   '987658266',
   'https://www.puretestedpeptides.com/product/buy-pt-141-peptide-10mg-99-pure-melanocortin-agonist/',
   'Buy PT-141 Peptide 10mg', 10, true, true),
  ((select id from public.suppliers where code = 'PURETESTED'),
   (select id from public.peptides  where code = 'TESAMORELIN'),
   '987658986',
   'https://www.puretestedpeptides.com/product/tesa-peptide-ga1/',
   'Tesa 10MG Peptide', 10, true, true),
  ((select id from public.suppliers where code = 'PURETESTED'),
   (select id from public.peptides  where code = 'RETATRUTIDE'),
   '987658536',
   'https://www.puretestedpeptides.com/product/glp3-r-10mg-peptide/',
   'GLP-3 R 10Mg peptide', 10, true, true)
on conflict (supplier_id, supplier_sku) do nothing;

-- ── PEPTIDELABS seeds (5 peptides, supplier_sku=PENDING + active=false) ──
-- Operator: after first proxy scrape confirms IDs, run:
--   UPDATE public.supplier_products
--      SET supplier_sku = '<real-wc-id>', active = true
--    WHERE supplier_id = (select id from public.suppliers where code = 'PEPTIDELABS')
--      AND peptide_id  = (select id from public.peptides  where code = '<peptide>');
-- Per-vial slug used (NOT kit-of-10 default) per operator decision —
-- /product/<peptide>-<mg>mg/ pattern from the operator-confirmed
-- /product/bpc-157-10mg/ example. URLs are best-guesses; verify
-- before flipping active.
insert into public.supplier_products
  (supplier_id, peptide_id, supplier_sku, product_url, product_name, mass_per_unit_mg, is_reference_sku, active)
values
  ((select id from public.suppliers where code = 'PEPTIDELABS'),
   (select id from public.peptides  where code = 'GHKCU'),
   'PENDING_GHKCU',       'https://peptidelabsinc.com/product/ghk-cu-50mg/',      'GHK-Cu 50mg (per-vial)',     50, true, false),
  ((select id from public.suppliers where code = 'PEPTIDELABS'),
   (select id from public.peptides  where code = 'MOTSC'),
   'PENDING_MOTSC',       'https://peptidelabsinc.com/product/mots-c-10mg/',      'MOTS-c 10mg (per-vial)',     10, true, false),
  ((select id from public.suppliers where code = 'PEPTIDELABS'),
   (select id from public.peptides  where code = 'PT141'),
   'PENDING_PT141',       'https://peptidelabsinc.com/product/pt-141-10mg/',      'PT-141 10mg (per-vial)',     10, true, false),
  ((select id from public.suppliers where code = 'PEPTIDELABS'),
   (select id from public.peptides  where code = 'TESAMORELIN'),
   'PENDING_TESAMORELIN', 'https://peptidelabsinc.com/product/tesamorelin-10mg/', 'Tesamorelin 10mg (per-vial)', 10, true, false),
  ((select id from public.suppliers where code = 'PEPTIDELABS'),
   (select id from public.peptides  where code = 'RETATRUTIDE'),
   'PENDING_RETATRUTIDE', 'https://peptidelabsinc.com/product/retatrutide-10mg/', 'Retatrutide 10mg (per-vial)', 10, true, false)
on conflict (supplier_id, supplier_sku) do nothing;

-- ── verification (run manually after apply) ──────────────────────
--   -- Should return 11 (existing) + 3 (new) = 14 active suppliers, with the
--   -- 3 new ones at enabled_in_twap=false:
--   select code, status, enabled_in_twap from public.suppliers
--    where status = 'active' order by enabled_in_twap, code;
--
--   -- Should return 9 active rows for PANDA+PURETESTED (5+4) and 5 inactive
--   -- rows for PEPTIDELABS:
--   select s.code as vendor, count(*) filter (where sp.active) as active_rows,
--          count(*) filter (where not sp.active) as inactive_rows
--     from public.suppliers s
--     join public.supplier_products sp on sp.supplier_id = s.id
--    where s.code in ('PANDA', 'PURETESTED', 'PEPTIDELABS')
--    group by s.code;
--
--   -- Should return RETATRUTIDE active=true:
--   select code, status from public.peptides where code = 'RETATRUTIDE';

-- ── down (reversal block — run only on rollback) ──────────────────
-- begin;
-- delete from public.supplier_products
--  where supplier_id in (
--    select id from public.suppliers
--    where code in ('PANDA', 'PURETESTED', 'PEPTIDELABS')
--  );
-- delete from public.suppliers
--  where code in ('PANDA', 'PURETESTED', 'PEPTIDELABS');
-- update public.peptides set is_active = false where code = 'RETATRUTIDE';
-- alter table public.suppliers drop column if exists enabled_in_twap;
-- commit;
