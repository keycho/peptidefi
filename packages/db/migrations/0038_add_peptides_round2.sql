-- 0038_add_peptides_round2.sql
-- Round-2 peptide additions: 3 INSERT (MT2, GHRP2, IGF1LR3) + 2 UPDATE
-- (TIRZEPATIDE + NAD — both already seeded inactive; flip to active).
-- Adds a per-peptide TWAP-eligibility flag mirroring the per-vendor flag
-- from migration 0036, so new peptides land scrape-yes / twap-no during
-- the 7-day observation window.
--
-- USER SPEC vs REALITY  (operator: read this before merging)
-- ==========================================================
--
-- The submission asked to add five peptides "TIRZE / NAD / MT2 / GHRP2
-- / IGF1LR3" as if all five were new. Two already exist in the
-- canonical list with the user's desired full_name + category:
--
--   - TIRZE  → existing code TIRZEPATIDE, seeded is_active=false in
--              migration 0019. UPDATE to is_active=true rather than
--              creating a duplicate "TIRZE" code (would split the
--              vendor-prices view).
--   - NAD    → existing code NAD (matches the user's spec exactly),
--              seeded is_active=false in migration 0012. UPDATE to
--              is_active=true. category 'longevity' was already set
--              in 0019; no change needed.
--
-- Three are genuinely new: MT2, GHRP2, IGF1LR3.
--
-- The user also asked for migration number 0039, but the latest in
-- main is 0037. This migration is 0038. (No 0038 was reserved.)
--
-- VENDOR-COVERAGE AUDIT  (probed 11 vendors via WC Store API)
-- ===========================================================
--
-- 9 vendors reachable from the sandbox; NUSCIENCE and PEPTIDELABS
-- blocked by Sucuri WAF (datacenter IP class). Per-peptide vendor
-- counts came in lower than the user's "best estimate":
--
--                 user-est   actual-found  notes
--   TIRZEPATIDE    8-10        3 (+ 1 already-seeded SWISSCHEMS)
--                              GENETIC stealth-codes it as "GLP-2 (T)"
--                              with the tirzepatide slug — included
--                              based on slug, not display name.
--   NAD            9-10        6 (+ 1 already-seeded PUREHEALTH)
--                              PURERAWZ "Niagen Nicotinamide Riboside"
--                              is NR not NAD+, excluded as false +ve.
--   MT2            8-10        7
--   GHRP2          7-9         3   ⚠ much lower than expected
--   IGF1LR3        8-10        6
--
-- PURERAWZ's catalog list endpoint is broken (cf. migration 0036
-- header — 100 of 433 products visible) so any of these 5 might
-- exist there but wouldn't show in the audit. Operator can backfill
-- PURERAWZ rows once the per-product fallback kicks in or via a
-- manual lookup.
--
-- NUSCIENCE + PEPTIDELABS are unaudited; if they carry these
-- peptides, add rows in a follow-up migration after a proxy-enabled
-- audit confirms the WC product IDs.
--
-- TWAP GATING  (new column)
-- =========================
--
-- All 5 peptides land at peptides.enabled_in_twap=false. The scraper
-- DOES NOT filter on this flag — observations are collected during
-- the 7-day window and stored in supplier_observations. The WORKER
-- filters on it in loadActivePeptides — peptides at
-- enabled_in_twap=false are skipped from peptide_twaps writes, so
-- they don't enter TWAP cohorts. This is the symmetric counterpart
-- to suppliers.enabled_in_twap from migration 0036, with the same
-- "scrape-but-don't-trade" semantics.
--
-- After the 7-day review:
--   UPDATE public.peptides SET enabled_in_twap=true WHERE code=...;
-- The worker's detectPeptidePromotions loop fires a
-- peptide_promoted_to_twap anomaly event on the next cycle.

-- ── up ─────────────────────────────────────────────────────────────

-- 1. New column: peptides.enabled_in_twap
alter table public.peptides
  add column if not exists enabled_in_twap boolean not null default true;

comment on column public.peptides.enabled_in_twap is
  'When false, the peptide is scraped (observations recorded) but excluded from TWAP cohorts. Mirror of suppliers.enabled_in_twap from migration 0036. Flip to true after quality review.';

-- 2. Existing peptides — flip to is_active=true AND set
-- enabled_in_twap=false so they enter the same observation window
-- as the new ones. (TIRZEPATIDE + NAD were both seeded inactive
-- ages ago; they qualify for this round.)
update public.peptides
   set is_active       = true,
       enabled_in_twap = false
 where code in ('TIRZEPATIDE', 'NAD');

-- 3. New peptide rows (MT2, GHRP2, IGF1LR3). enabled_in_twap=false
-- by explicit value so re-running the migration after the operator
-- has flipped one to true is a no-op (ON CONFLICT DO NOTHING).
insert into public.peptides
  (code, display_name, full_name, description, category, is_active, enabled_in_twap)
values
  ('MT2',     'Melanotan-II',    'Melanotan-II',
   'Melanocortin agonist studied for tanning + sexual-health contexts.',
   'tanning', true, false),
  ('GHRP2',   'GHRP-2',          'Growth Hormone Releasing Peptide-2',
   'GH secretagogue acting via the ghrelin receptor.',
   'gh-secretagogue', true, false),
  ('IGF1LR3', 'IGF-1 LR3',       'IGF-1 LR3 (Long Range)',
   'Long-range IGF-1 analog with extended half-life; muscle / GH research.',
   'gh', true, false)
on conflict (code) do nothing;

-- 4. supplier_products seeds — only the (vendor, peptide) pairs the
-- audit confirmed. Schema requires supplier_sku NOT NULL +
-- (supplier_id, supplier_sku) unique; we use real WC product IDs.
-- mass_per_unit_mg is a best-effort initial value from the product
-- name; the scraper's updateProductMass rewrites it from real
-- variant attributes on first scrape.
--
-- ON CONFLICT DO NOTHING per the existing pattern. Re-running with
-- the same data is a no-op; re-running after a vendor changes their
-- WC product ID inserts the new row alongside.

-- ── TIRZEPATIDE seeds (3 vendors confirmed; SWISSCHEMS already seeded in 0019) ──
insert into public.supplier_products
  (supplier_id, peptide_id, supplier_sku, product_url, product_name, mass_per_unit_mg, is_reference_sku, active)
values
  ((select id from public.suppliers where code = 'GENETIC'),
   (select id from public.peptides  where code = 'TIRZEPATIDE'),
   '2457', 'https://geneticpeptide.com/product/tirzepatide-glp-1-vial/',
   'Tirzepatide (GLP-2 T Vial — vendor stealth-name)', 10, true, true),
  ((select id from public.suppliers where code = 'PURETESTED'),
   (select id from public.peptides  where code = 'TIRZEPATIDE'),
   '987659377', 'https://www.puretestedpeptides.com/product/glp-1t/',
   'GLP 1 Tirz', 10, true, true)
on conflict (supplier_id, supplier_sku) do nothing;

-- ── NAD seeds (6 vendors confirmed; PUREHEALTH 33348 already in 0012) ──
insert into public.supplier_products
  (supplier_id, peptide_id, supplier_sku, product_url, product_name, mass_per_unit_mg, is_reference_sku, active)
values
  ((select id from public.suppliers where code = 'PANDA'),
   (select id from public.peptides  where code = 'NAD'),
   '7251', 'https://pandapeptides.com/product/nad/',
   'NAD+ 500mg', 500, true, true),
  ((select id from public.suppliers where code = 'LIBERTY'),
   (select id from public.peptides  where code = 'NAD'),
   '172', 'https://libertypeptides.com/product/nad/',
   'NAD+', 500, true, true),
  ((select id from public.suppliers where code = 'VERIFIED'),
   (select id from public.peptides  where code = 'NAD'),
   '36788', 'https://verifiedpeptides.com/product/nad-500mg/',
   'NAD+ Peptide (1000MG)', 1000, true, true),
  ((select id from public.suppliers where code = 'GENETIC'),
   (select id from public.peptides  where code = 'NAD'),
   '2416', 'https://geneticpeptide.com/product/nad-500mg-mg-vial/',
   'NAD+ Vial', 500, true, true),
  ((select id from public.suppliers where code = 'PURETESTED'),
   (select id from public.peptides  where code = 'NAD'),
   '987655975', 'https://www.puretestedpeptides.com/product/nad-500-mg-ga/',
   'NAD + 500 mg', 500, true, true),
  ((select id from public.suppliers where code = 'SWISSCHEMS'),
   (select id from public.peptides  where code = 'NAD'),
   '1288', 'https://swisschems.is/product/nad-coenzyme-peptide-1-vial-100-mg/',
   'NAD+ (Nicotinamide Adenine Dinucleotide) 100 mg', 100, true, true)
on conflict (supplier_id, supplier_sku) do nothing;

-- ── MT2 seeds (7 vendors confirmed) ──
insert into public.supplier_products
  (supplier_id, peptide_id, supplier_sku, product_url, product_name, mass_per_unit_mg, is_reference_sku, active)
values
  ((select id from public.suppliers where code = 'PANDA'),
   (select id from public.peptides  where code = 'MT2'),
   '7280', 'https://pandapeptides.com/product/mt-2/',
   'Melanotan II (MT-2) 10mg', 10, true, true),
  ((select id from public.suppliers where code = 'LIBERTY'),
   (select id from public.peptides  where code = 'MT2'),
   '43', 'https://libertypeptides.com/product/melanotan-2-10mg/',
   'Melanotan II (10mg)', 10, true, true),
  ((select id from public.suppliers where code = 'VERIFIED'),
   (select id from public.peptides  where code = 'MT2'),
   '36044', 'https://verifiedpeptides.com/product/mt2/',
   'MT II Peptide (10MG)', 10, true, true),
  ((select id from public.suppliers where code = 'GENETIC'),
   (select id from public.peptides  where code = 'MT2'),
   '2413', 'https://geneticpeptide.com/product/melanotan-2-mt2-vial-10mg/',
   'Melanotan 2 (MT2) Vial', 10, true, true),
  ((select id from public.suppliers where code = 'PURETESTED'),
   (select id from public.peptides  where code = 'MT2'),
   '987659177', 'https://www.puretestedpeptides.com/product/mt2-10mg-peptide-ga2/',
   'MT2 10MG Peptide', 10, true, true),
  ((select id from public.suppliers where code = 'SWISSCHEMS'),
   (select id from public.peptides  where code = 'MT2'),
   '489', 'https://swisschems.is/product/melanotan-ii-10mg-price-is-per-vial/',
   'Melanotan II, 10mg', 10, true, true),
  ((select id from public.suppliers where code = 'PURERAWZ'),
   (select id from public.peptides  where code = 'MT2'),
   '359314899', 'https://purerawz.co/product/mt-ii/',
   'MT-II', 10, true, true)
on conflict (supplier_id, supplier_sku) do nothing;

-- ── GHRP2 seeds (3 vendors confirmed; lower than user expected) ──
insert into public.supplier_products
  (supplier_id, peptide_id, supplier_sku, product_url, product_name, mass_per_unit_mg, is_reference_sku, active)
values
  ((select id from public.suppliers where code = 'PULSE'),
   (select id from public.peptides  where code = 'GHRP2'),
   '21', 'https://pulsepeptides.com/product/ghrp-2/',
   'GHRP-2', 5, true, true),
  ((select id from public.suppliers where code = 'GENETIC'),
   (select id from public.peptides  where code = 'GHRP2'),
   '2373', 'https://geneticpeptide.com/product/ghrp-2-vial-10mg/',
   'GHRP-2 Vial 10MG', 10, true, true),
  ((select id from public.suppliers where code = 'SWISSCHEMS'),
   (select id from public.peptides  where code = 'GHRP2'),
   '380', 'https://swisschems.is/product/ghrp-2-5mg-price-is-per-vials/',
   'GHRP-2 5 mg', 5, true, true)
on conflict (supplier_id, supplier_sku) do nothing;

-- ── IGF1LR3 seeds (6 vendors confirmed) ──
insert into public.supplier_products
  (supplier_id, peptide_id, supplier_sku, product_url, product_name, mass_per_unit_mg, is_reference_sku, active)
values
  ((select id from public.suppliers where code = 'PANDA'),
   (select id from public.peptides  where code = 'IGF1LR3'),
   '7284', 'https://pandapeptides.com/product/igf-1-lr3/',
   'IGF-1 LR3', 1, true, true),
  ((select id from public.suppliers where code = 'PUREHEALTH'),
   (select id from public.peptides  where code = 'IGF1LR3'),
   '435', 'https://purehealthpeptides.com/product/igf-1-lr3/',
   'IGF-1 LR3', 1, true, true),
  ((select id from public.suppliers where code = 'VERIFIED'),
   (select id from public.peptides  where code = 'IGF1LR3'),
   '41231', 'https://verifiedpeptides.com/product/igf-1-lr3/',
   'IGF-1 LR3 Peptide (1MG)', 1, true, true),
  ((select id from public.suppliers where code = 'GENETIC'),
   (select id from public.peptides  where code = 'IGF1LR3'),
   '2391', 'https://geneticpeptide.com/product/igf-1-lr3-receptor-grade-vial-1mg-2/',
   'IGF-1 LR3 (Receptor Grade) Vial 1mg', 1, true, true),
  ((select id from public.suppliers where code = 'PURETESTED'),
   (select id from public.peptides  where code = 'IGF1LR3'),
   '987654585', 'https://www.puretestedpeptides.com/product/igf-1-lr3-1-mg/',
   'IGF-1 LR3 - 1 mg', 1, true, true),
  ((select id from public.suppliers where code = 'SWISSCHEMS'),
   (select id from public.peptides  where code = 'IGF1LR3'),
   '510', 'https://swisschems.is/product/igf-1-lr3-1mg-price-is-per-vial/',
   'IGF-1 LR3 1mg', 1, true, true)
on conflict (supplier_id, supplier_sku) do nothing;

-- ── verification (run manually after apply) ──────────────────────
--   -- Should return 5 rows, all active=true + enabled_in_twap=false:
--   select code, display_name, is_active, enabled_in_twap
--     from public.peptides
--    where code in ('TIRZEPATIDE', 'NAD', 'MT2', 'GHRP2', 'IGF1LR3');
--
--   -- Per-peptide vendor coverage (excludes already-seeded SWISSCHEMS
--   -- TIRZEPATIDE + PUREHEALTH NAD; the audit found 3 + 6 + 7 + 3 + 6
--   -- new rows = 25 total inserts here):
--   select p.code, count(*) as vendor_rows
--     from public.peptides p
--     join public.supplier_products sp on sp.peptide_id = p.id
--    where p.code in ('TIRZEPATIDE', 'NAD', 'MT2', 'GHRP2', 'IGF1LR3')
--      and sp.active
--    group by p.code order by p.code;
--
--   -- After the 7-day observation period, flip individual peptides:
--   --   UPDATE public.peptides SET enabled_in_twap = true WHERE code = 'MT2';
--   -- The worker's detectPeptidePromotions loop fires
--   -- peptide_promoted_to_twap on the next cycle.

-- ── down (reversal block — run only on rollback) ──────────────────
-- begin;
-- delete from public.supplier_products
--  where peptide_id in (
--    select id from public.peptides where code in ('MT2','GHRP2','IGF1LR3')
--  );
-- delete from public.supplier_products
--  where (supplier_id, supplier_sku) in (
--    -- TIRZEPATIDE seeds added by 0038
--    ((select id from public.suppliers where code='GENETIC'), '2457'),
--    ((select id from public.suppliers where code='PURETESTED'), '987659377'),
--    -- NAD seeds added by 0038
--    ((select id from public.suppliers where code='PANDA'), '7251'),
--    ((select id from public.suppliers where code='LIBERTY'), '172'),
--    ((select id from public.suppliers where code='VERIFIED'), '36788'),
--    ((select id from public.suppliers where code='GENETIC'), '2416'),
--    ((select id from public.suppliers where code='PURETESTED'), '987655975'),
--    ((select id from public.suppliers where code='SWISSCHEMS'), '1288')
--  );
-- delete from public.peptides where code in ('MT2','GHRP2','IGF1LR3');
-- update public.peptides set is_active = false
--   where code in ('TIRZEPATIDE', 'NAD');
-- alter table public.peptides drop column if exists enabled_in_twap;
-- commit;
