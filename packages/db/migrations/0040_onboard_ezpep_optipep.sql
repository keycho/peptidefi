-- 0040_onboard_ezpep_optipep.sql
-- Onboard two new WooCommerce vendors:
--   EZPEP    (ezpeptides.com)
--   OPTIPEP  (optimalpep.com)
--
-- Both follow the vanilla-WC pattern established in migration 0036
-- (PANDA / PURETESTED / PEPTIDELABS) — single-line registration in
-- apps/scraper/src/suppliers/index.ts, no custom parser, no proxy
-- requirement (both confirmed reachable from datacenter IPs during
-- onboarding probe).
--
-- KEY DESIGN POINT — TWAP gating (carry-over from 0036):
--   Both new vendors land with `enabled_in_twap=false`. The operator
--   spec mentioned a "24-hour observation period" before promotion;
--   the existing convention from 0036 was 7 days. The flag value is
--   the same either way — flip via a follow-up migration when ready.
--   In-the-meantime: observations are recorded, but excluded from TWAP
--   cohorts. vendor_promoted_to_twap anomaly event fires on false→true
--   transition.
--
-- KEY DESIGN POINT — Impostor-domain pinning:
--   EZPEP's canonical domain is ezpeptides.com. Impostor sites
--   ezpeps.com and ezpeptidesofficial.com exist; the homepage_url
--   is pinned to the exact canonical and the scraper module is
--   registered with host='ezpeptides.com'. Any future drift between
--   the two requires an explicit migration to update — the host is
--   not a runtime config knob.
--
-- KEY DESIGN POINT — Per-vendor coverage actually attainable:
--   The user requested 15 peptides per vendor. Live WC-catalog probe
--   (one shared per-vendor /wp-json/wc/store/v1/products?per_page=100
--   call against each domain, 75 products on EZPEP, 36 on OPTIPEP)
--   showed not every peptide is stocked as a standalone SKU. Coverage:
--
--     EZPEP    12 active SKUs (BPC157, TB500, GHKCU, SEMAX, EPITHAL,
--              MOTSC, KISSPEPTIN, CJC1295, AOD9604, TA1, SERMORELIN,
--              TESAMORELIN). NOT stocked: GLP1 (blend-only EZP-3P),
--              TIRZEPATIDE (no SKU), HEXARELIN (no SKU).
--     OPTIPEP  11 active SKUs (BPC157, TB500, GHKCU, GLP1, SEMAX,
--              MOTSC, AOD9604, TA1, HEXARELIN, SERMORELIN,
--              TESAMORELIN) + 1 PENDING (TIRZEPATIDE candidate).
--              NOT stocked: EPITHAL, KISSPEPTIN, CJC1295 (blend-only).
--
--   Both come in at 12/15 effective coverage.
--
-- KEY DESIGN POINT — OPTIPEP TIRZEPATIDE 'glp-2-tz-30mg' provisional:
--   OPTIPEP names GLP-family compounds with coded initials:
--     glp-1-sm-10mg     = semaglutide        (active here)
--     glp-3-rt-15mg     = retatrutide        (not seeded — RETATRUTIDE not in spec)
--     glp-2-tz-30mg     = tirzepatide?       (active=false; operator confirms)
--   The TZ initials + 30mg mass + GLP-family categorisation strongly
--   suggest tirzepatide, but we don't seed against a guess. The row
--   lands with supplier_sku='3023', active=false, mass_per_unit_mg=30.
--   After the operator reads the product page (or asks the vendor):
--     UPDATE public.supplier_products
--        SET active = true
--      WHERE supplier_id = (select id from public.suppliers where code='OPTIPEP')
--        AND peptide_id  = (select id from public.peptides where code='TIRZEPATIDE');
--   No backfill of supplier_sku needed — the WC id 3023 was confirmed
--   to exist + return a price during onboarding probe.
--
-- KEY DESIGN POINT — EZPEP AOD9604 small-pack premium:
--   EZPEP stocks AOD-9604 only as a 2 mg vial; price-per-mg lands
--   at ~$19/mg vs the cohort TWAP of ~$8/mg. This is a real small-pack
--   premium, not a parser error — verified against the live WC Store
--   API response. enabled_in_twap=false will quarantine this from the
--   cohort during the observation period; if the per-mg outlier
--   persists once enabled, the operator should either skip AOD9604
--   for EZPEP (mark active=false) or include it knowing the AOD9604
--   TWAP will widen.

-- ── up ─────────────────────────────────────────────────────────────

-- 1. Insert 2 new vendors. enabled_in_twap=false. status='active' so
--    the scraper picks them up. ON CONFLICT (code) DO NOTHING for
--    re-run idempotency.
insert into public.suppliers
  (code, display_name, homepage_url, scraper_module, status, enabled_in_twap, notes)
values
  ('EZPEP',   'EZ Peptides',     'https://ezpeptides.com/',  'woocommerce', 'active', false,
   'Onboarded migration 0040. Vanilla WooCommerce; reachable from datacenter IPs. Canonical domain ezpeptides.com — impostors ezpeps.com / ezpeptidesofficial.com exist, do not redirect. enabled_in_twap=false pending quality review.'),
  ('OPTIPEP', 'Optimal Peptide', 'https://optimalpep.com/',  'woocommerce', 'active', false,
   'Onboarded migration 0040. Vanilla WooCommerce; reachable from datacenter IPs. Uses coded GLP-family naming (glp-1-sm=semaglutide, glp-2-tz=tirzepatide candidate, glp-3-rt=retatrutide). enabled_in_twap=false pending quality review.')
on conflict (code) do nothing;

-- 2. supplier_products seeds.
--
-- mass_per_unit_mg is set from the WC catalog probe; the scraper's
-- updateProductMass() rewrites it from the real variant attribute on
-- the first successful scrape, so the seed value is a starting hint
-- rather than authoritative.
--
-- is_reference_sku=true on every row — each (vendor, peptide) pair
-- has exactly one SKU per the existing schema unique constraint.

-- ── EZPEP seeds (12 peptides, all confirmed via WC Store API probe) ──
insert into public.supplier_products
  (supplier_id, peptide_id, supplier_sku, product_url, product_name, mass_per_unit_mg, is_reference_sku, active)
values
  ((select id from public.suppliers where code='EZPEP'),
   (select id from public.peptides  where code='BPC157'),
   '4662',  'https://ezpeptides.com/product/bpc-157-10mg/',                       'BPC-157 10mg',                      10, true, true),
  ((select id from public.suppliers where code='EZPEP'),
   (select id from public.peptides  where code='TB500'),
   '30351', 'https://ezpeptides.com/product/tb-500-frag-17-23-10mg/',             'TB-500 Frag 17-23 10mg',            10, true, true),
  ((select id from public.suppliers where code='EZPEP'),
   (select id from public.peptides  where code='GHKCU'),
   '29644', 'https://ezpeptides.com/product/ghk-cu-50mg/',                        'GHK-Cu 50mg',                       50, true, true),
  ((select id from public.suppliers where code='EZPEP'),
   (select id from public.peptides  where code='SEMAX'),
   '29656', 'https://ezpeptides.com/product/semax-10mg/',                         'Semax 10mg',                        10, true, true),
  ((select id from public.suppliers where code='EZPEP'),
   (select id from public.peptides  where code='EPITHAL'),
   '29642', 'https://ezpeptides.com/product/epitalon-10mg/',                      'Epitalon 10mg',                     10, true, true),
  ((select id from public.suppliers where code='EZPEP'),
   (select id from public.peptides  where code='MOTSC'),
   '29972', 'https://ezpeptides.com/product/mots-c-10mg/',                        'MOTS-c 10mg',                       10, true, true),
  ((select id from public.suppliers where code='EZPEP'),
   (select id from public.peptides  where code='KISSPEPTIN'),
   '60801', 'https://ezpeptides.com/product/kisspeptin-10mg/',                    'Kisspeptin 10MG',                   10, true, true),
  ((select id from public.suppliers where code='EZPEP'),
   (select id from public.peptides  where code='CJC1295'),
   '29934', 'https://ezpeptides.com/product/cjc-1295-no-dac-5mg/',                'CJC-1295 No DAC 5mg',                5, true, true),
  ((select id from public.suppliers where code='EZPEP'),
   (select id from public.peptides  where code='AOD9604'),
   '31503', 'https://ezpeptides.com/product/aod-9604-2mg-research-grade-compound/','AOD-9604 2mg',                       2, true, true),
  ((select id from public.suppliers where code='EZPEP'),
   (select id from public.peptides  where code='TA1'),
   '34813', 'https://ezpeptides.com/product/thymosin-alpha-1-10mg/',              'Thymosin Alpha-1 10mg',             10, true, true),
  ((select id from public.suppliers where code='EZPEP'),
   (select id from public.peptides  where code='SERMORELIN'),
   '29931', 'https://ezpeptides.com/product/sermorelin-5mg/',                     'Sermorelin 5mg',                     5, true, true),
  ((select id from public.suppliers where code='EZPEP'),
   (select id from public.peptides  where code='TESAMORELIN'),
   '29927', 'https://ezpeptides.com/product/tesamorelin-10mg/',                   'Tesamorelin 10mg',                  10, true, true)
on conflict (supplier_id, supplier_sku) do nothing;

-- ── OPTIPEP seeds (11 active + 1 pending) ──
insert into public.supplier_products
  (supplier_id, peptide_id, supplier_sku, product_url, product_name, mass_per_unit_mg, is_reference_sku, active)
values
  ((select id from public.suppliers where code='OPTIPEP'),
   (select id from public.peptides  where code='BPC157'),
   '2901', 'https://optimalpep.com/product/bpc-157-5mg/',         'BPC-157 5MG',           5, true, true),
  ((select id from public.suppliers where code='OPTIPEP'),
   (select id from public.peptides  where code='TB500'),
   '2924', 'https://optimalpep.com/product/tb-500-10mg/',         'TB-500 10MG',          10, true, true),
  ((select id from public.suppliers where code='OPTIPEP'),
   (select id from public.peptides  where code='GHKCU'),
   '509',  'https://optimalpep.com/product/ghk-cu/',              'GHK-Cu',              100, true, true),
  ((select id from public.suppliers where code='OPTIPEP'),
   (select id from public.peptides  where code='GLP1'),
   '3638', 'https://optimalpep.com/product/glp-1-sm-10mg/',       'GLP-1 (SM) 10MG',      10, true, true),
  ((select id from public.suppliers where code='OPTIPEP'),
   (select id from public.peptides  where code='SEMAX'),
   '2109', 'https://optimalpep.com/product/semax-10mg/',          'SEMAX 10MG',           10, true, true),
  ((select id from public.suppliers where code='OPTIPEP'),
   (select id from public.peptides  where code='MOTSC'),
   '511',  'https://optimalpep.com/product/mots-c/',              'MOTS-c',               10, true, true),
  ((select id from public.suppliers where code='OPTIPEP'),
   (select id from public.peptides  where code='AOD9604'),
   '3648', 'https://optimalpep.com/product/aod-9604-5mg/',        'AOD-9604 5MG',          5, true, true),
  ((select id from public.suppliers where code='OPTIPEP'),
   (select id from public.peptides  where code='TA1'),
   '3649', 'https://optimalpep.com/product/thymosin-alpha-1-10mg/','Thymosin Alpha-1 10MG',10, true, true),
  ((select id from public.suppliers where code='OPTIPEP'),
   (select id from public.peptides  where code='HEXARELIN'),
   '3646', 'https://optimalpep.com/product/hexarelin-10mg/',      'HEXARELIN 10MG',       10, true, true),
  ((select id from public.suppliers where code='OPTIPEP'),
   (select id from public.peptides  where code='SERMORELIN'),
   '2909', 'https://optimalpep.com/product/sermorelin-5mg/',      'Sermorelin 5MG',        5, true, true),
  ((select id from public.suppliers where code='OPTIPEP'),
   (select id from public.peptides  where code='TESAMORELIN'),
   '507',  'https://optimalpep.com/product/tesamoreline/',        'Tesamoreline',         10, true, true),
  -- Pending — operator confirms whether GLP-2 (TZ) is actually
  -- tirzepatide. Active=false until then; the row exists so the
  -- promotion is a single-column flip, not a fresh insert.
  ((select id from public.suppliers where code='OPTIPEP'),
   (select id from public.peptides  where code='TIRZEPATIDE'),
   '3023', 'https://optimalpep.com/product/glp-2-tz-30mg/',       'GLP-2 (TZ) 30MG',      30, true, false)
on conflict (supplier_id, supplier_sku) do nothing;

-- ── verification (run manually after apply) ──────────────────────
--
--   -- Should return 13 existing + 2 new = 15 active suppliers, with
--   -- the 2 new ones at enabled_in_twap=false:
--   select code, status, enabled_in_twap
--     from public.suppliers
--    where status = 'active'
--    order by enabled_in_twap, code;
--
--   -- Per-vendor active product counts: EZPEP 12, OPTIPEP 11 (pending row inactive)
--   select s.code as vendor,
--          count(*) filter (where sp.active) as active_rows,
--          count(*) filter (where not sp.active) as inactive_rows
--     from public.suppliers s
--     join public.supplier_products sp on sp.supplier_id = s.id
--    where s.code in ('EZPEP', 'OPTIPEP')
--    group by s.code;
--
--   -- Smoke-test a real scrape after deploy (single supplier, single peptide):
--   --   ENABLE_VENDOR=EZPEP ENABLE_PEPTIDE=BPC157 pnpm --filter @peptide-oracle/scraper start --once
--   -- Then:
--   select s.code as vendor, p.code as peptide, o.price_usd_per_mg, o.observed_at
--     from public.supplier_observations o
--     join public.suppliers s on s.id = o.supplier_id
--     join public.peptides  p on p.id = o.peptide_id
--    where s.code in ('EZPEP', 'OPTIPEP')
--    order by o.observed_at desc
--    limit 25;

-- ── down (reversal block — run only on rollback) ──────────────────
-- begin;
-- delete from public.supplier_products
--  where supplier_id in (
--    select id from public.suppliers
--    where code in ('EZPEP', 'OPTIPEP')
--  );
-- delete from public.suppliers
--  where code in ('EZPEP', 'OPTIPEP');
-- commit;
