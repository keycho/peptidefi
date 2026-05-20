-- 0046_expand_scraping_coverage.sql
-- Data layer expansion: add 14 new peptides to scraping coverage.
-- The index basket (29 peptides via public.index_baselines) is NOT
-- modified by this migration. New peptides land at
-- is_active=true, enabled_in_twap=false, matching the canonical
-- 7-day quality-review pattern established in migration 0038.
--
-- VENDOR-COVERAGE AUDIT (probed via WC Store API on 2026-05-18)
-- =============================================================
-- 8 vendors probed: LIBERTY, GENETIC, PUREHEALTH, VERIFIED,
-- SWISSCHEMS, PURETESTED, EZPEP, OPTIPEP. PANDA and PULSE probed
-- but contributed few novel candidates. NUSCIENCE + PEPTIDELABS
-- not probed (Sucuri WAF blocks datacenter IPs; backfill via
-- proxy-enabled audit in a follow-up migration).
--
-- Per-peptide vendor counts (standalone product only, blends
-- excluded). Restricted to >=3-vendor coverage per operator
-- decision:
--   KPV          7  PINEALON     6  GHRP6        4
--   OXYTOCIN     7  ARA290       6  ADIPOTIDE    4
--   CJC1295DAC   7  VIP          5  GONADORELIN  4
--   SURVODUTIDE  3  MGF          3  PEGMGF       3
--   DIHEXA       3  MK677        3
--
-- Excluded from this round (1-vendor coverage today): MT1,
-- CARTALAX, VILON, LIVAGEN. Add when coverage grows.
--
-- FORM HETEROGENEITY NOTE
-- =======================
-- Three of the 14 peptides have heterogeneous vendor forms:
--   - KPV: SWISSCHEMS ships oral capsules (250mcg x 60 caps),
--          everyone else ships injectable vials.
--   - DIHEXA: LIBERTY and SWISSCHEMS ship oral capsules,
--             GENETIC ships injectable vials.
--   - MK677: every confirmed vendor ships oral capsules.
-- The TWAP algorithm treats each observation as USD/mg regardless
-- of form. Oral capsule observations may drift higher than
-- injectable due to a form premium (capsule shell + filler labor +
-- distinct supply chain). Acceptable for the data layer in this
-- round; future enhancement to split oral and injectable into
-- separate peptide codes is tracked in
-- docs/follow-ups/oral-vs-injectable-form-split.md.
--
-- INDEX BASKET (out of scope for this migration)
-- ==============================================
-- Per operator instruction: this migration expands the DATA layer.
-- The headline BioHash Peptide Index continues to compute over the
-- 29-peptide cohort in public.index_baselines. New peptides will
-- be candidates for the index only after they meet the >=4 vendor /
-- >=7 day finalised TWAP rule AND the operator runs a separate
-- chaining-aware boundary script (not yet built).
--
-- Three peptides explicitly excluded by operator instruction:
-- GHRP2, RETATRUTIDE, TIRZEPATIDE. Already in the peptides table
-- (migrations 0036/0038), already at enabled_in_twap=false, already
-- excluded from the v1 cohort. No new rows here.

-- == up ============================================================

-- 1. peptide rows. All 14 land at is_active=true, enabled_in_twap=false.
insert into public.peptides
  (code, display_name, full_name, description, category, is_active, enabled_in_twap)
values
  ('KPV',          'KPV',                  'Lysine-Proline-Valine (KPV)',
   'Anti-inflammatory tripeptide derived from alpha-MSH. Studied in IBD and skin inflammation models.',
   'longevity', true, false),
  ('OXYTOCIN',     'Oxytocin',             'Oxytocin',
   'Posterior pituitary nonapeptide. Hormonal / social-behavior research.',
   'hormonal', true, false),
  ('CJC1295DAC',   'CJC-1295 (with DAC)',  'CJC-1295 with DAC',
   'CJC-1295 conjugated to a drug affinity complex (DAC) for extended half-life. Distinct from CJC-1295 No-DAC / Mod GRF 1-29 tracked under CJC1295.',
   'growth', true, false),
  ('PINEALON',     'Pinealon',             'Pinealon (Khavinson bioregulator)',
   'Tripeptide from the Khavinson bioregulator family; pineal-derived.',
   'longevity', true, false),
  ('ARA290',       'ARA-290',              'ARA-290 (Cibinetide)',
   'Erythropoietin-derived 11-mer. Neuroprotective and tissue-repair research.',
   'longevity', true, false),
  ('VIP',          'VIP',                  'Vasoactive Intestinal Peptide',
   '28-amino-acid neuropeptide. Anti-inflammatory and vasodilatory research contexts.',
   'longevity', true, false),
  ('GHRP6',        'GHRP-6',               'Growth Hormone Releasing Peptide-6',
   'GH secretagogue, ghrelin receptor agonist. Counterpart to the tracked GHRP-2.',
   'gh-secretagogue', true, false),
  ('ADIPOTIDE',    'Adipotide',            'Adipotide (FTPP)',
   'Pro-apoptotic body-composition research peptide. Also marketed as FTPP.',
   'metabolic', true, false),
  ('GONADORELIN',  'Gonadorelin',          'Gonadorelin (GnRH)',
   'Gonadotropin-releasing hormone decapeptide. Reproductive endocrinology research.',
   'hormonal', true, false),
  ('SURVODUTIDE',  'Survodutide',          'Survodutide',
   'Glucagon / GLP-1 dual agonist. Newer GLP-1-family research peptide.',
   'metabolic', true, false),
  ('MGF',          'MGF',                  'Mechano Growth Factor (IGF-1 EC)',
   'Splice variant of IGF-1 expressed under mechanical loading. Muscle / GH research.',
   'gh', true, false),
  ('PEGMGF',       'PEG-MGF',              'PEGylated Mechano Growth Factor',
   'PEGylated MGF with extended half-life. Distinct pharmacokinetics from base MGF.',
   'gh', true, false),
  ('DIHEXA',       'Dihexa',               'Dihexa (PNB-0408)',
   'Hexapeptide HGF mimetic. Nootropic / synaptogenic research. Mixed vendor forms (oral capsules + injectable vials); see oral-vs-injectable-form-split follow-up.',
   'cognitive', true, false),
  ('MK677',        'MK-677',               'MK-677 (Ibutamoren)',
   'Oral growth hormone secretagogue. Non-peptide MK-class molecule, tracked alongside peptide GHS for cohort consistency. Sold exclusively as oral capsules by confirmed vendors; see oral-vs-injectable-form-split follow-up.',
   'gh-secretagogue', true, false)
on conflict (code) do nothing;

-- 2. supplier_products seeds.
-- One INSERT per peptide for readability; the conflict guard makes
-- each block idempotent. mass_per_unit_mg is a best-effort initial
-- value from the product name; the scraper's updateProductMass
-- rewrites it from real variant attributes on first scrape.

-- ── KPV ──
insert into public.supplier_products
  (supplier_id, peptide_id, supplier_sku, product_url, product_name, mass_per_unit_mg, is_reference_sku, active)
values
  ((select id from public.suppliers where code = 'LIBERTY'),
   (select id from public.peptides where code = 'KPV'),
   '66701', 'https://libertypeptides.com/product/kpv-10mg/',
   'KPV (10mg)', 10, true, true),
  ((select id from public.suppliers where code = 'GENETIC'),
   (select id from public.peptides where code = 'KPV'),
   '2400', 'https://geneticpeptide.com/product/kpv-vial-5mg-2/',
   'KPV Vial 5MG', 5, true, true),
  ((select id from public.suppliers where code = 'PUREHEALTH'),
   (select id from public.peptides where code = 'KPV'),
   '9920', 'https://purehealthpeptides.com/product/kpv/',
   'KPV', 5, true, true),
  ((select id from public.suppliers where code = 'VERIFIED'),
   (select id from public.peptides where code = 'KPV'),
   '60280', 'https://verifiedpeptides.com/product/kpv/',
   'KPV Peptide (10MG)', 10, true, true),
  ((select id from public.suppliers where code = 'SWISSCHEMS'),
   (select id from public.peptides where code = 'KPV'),
   '1329', 'https://swisschems.is/product/kpv-lysine-proline-valine-250mcg-60caps/',
   'KPV (Lysine-Proline-Valine) 250mcg / 60 caps (oral)', 15, true, true),
  ((select id from public.suppliers where code = 'PURETESTED'),
   (select id from public.peptides where code = 'KPV'),
   '987659239', 'https://www.puretestedpeptides.com/product/kpv-10mg-peptide/',
   'KPV 10MG peptide', 10, true, true),
  ((select id from public.suppliers where code = 'PANDA'),
   (select id from public.peptides where code = 'KPV'),
   '7292', 'https://pandapeptides.com/product/kpv/',
   'KPV 10mg', 10, true, true)
on conflict (supplier_id, supplier_sku) do nothing;

-- ── OXYTOCIN ──
insert into public.supplier_products
  (supplier_id, peptide_id, supplier_sku, product_url, product_name, mass_per_unit_mg, is_reference_sku, active)
values
  ((select id from public.suppliers where code = 'LIBERTY'),
   (select id from public.peptides where code = 'OXYTOCIN'),
   '46457', 'https://libertypeptides.com/product/oxytocin-10mg/',
   'Oxytocin (10mg)', 10, true, true),
  ((select id from public.suppliers where code = 'GENETIC'),
   (select id from public.peptides where code = 'OXYTOCIN'),
   '2418', 'https://geneticpeptide.com/product/oxytocin-5mg-3000iu-vial-2/',
   'Oxytocin Vial', 5, true, true),
  ((select id from public.suppliers where code = 'PUREHEALTH'),
   (select id from public.peptides where code = 'OXYTOCIN'),
   '454', 'https://purehealthpeptides.com/product/oxytocin/',
   'Oxytocin', 5, true, true),
  ((select id from public.suppliers where code = 'VERIFIED'),
   (select id from public.peptides where code = 'OXYTOCIN'),
   '59315', 'https://verifiedpeptides.com/product/oxytocin/',
   'Oxytocin Peptide (10MG)', 10, true, true),
  ((select id from public.suppliers where code = 'SWISSCHEMS'),
   (select id from public.peptides where code = 'OXYTOCIN'),
   '1048', 'https://swisschems.is/product/oxytocin-2-mg-1-vial/',
   'Oxytocin 2mg (1 vial)', 2, true, true),
  ((select id from public.suppliers where code = 'EZPEP'),
   (select id from public.peptides where code = 'OXYTOCIN'),
   '60795', 'https://ezpeptides.com/product/oxytocin-10mg/',
   'Oxytocin 10MG', 10, true, true),
  ((select id from public.suppliers where code = 'OPTIPEP'),
   (select id from public.peptides where code = 'OXYTOCIN'),
   '3647', 'https://optimalpep.com/product/oxytocin-5mg/',
   'OXYTOCIN 5MG', 5, true, true)
on conflict (supplier_id, supplier_sku) do nothing;

-- ── CJC1295DAC ──
insert into public.supplier_products
  (supplier_id, peptide_id, supplier_sku, product_url, product_name, mass_per_unit_mg, is_reference_sku, active)
values
  ((select id from public.suppliers where code = 'LIBERTY'),
   (select id from public.peptides where code = 'CJC1295DAC'),
   '34', 'https://libertypeptides.com/product/cjc-1295-dac/',
   'CJC-1295 + DAC', 5, true, true),
  ((select id from public.suppliers where code = 'GENETIC'),
   (select id from public.peptides where code = 'CJC1295DAC'),
   '2355', 'https://geneticpeptide.com/product/cjc-1295-vial-with-dac/',
   'CJC-1295 Vial (WITH DAC)', 5, true, true),
  ((select id from public.suppliers where code = 'PUREHEALTH'),
   (select id from public.peptides where code = 'CJC1295DAC'),
   '427', 'https://purehealthpeptides.com/product/cjc-1295-dac/',
   'CJC-1295 (DAC)', 5, true, true),
  ((select id from public.suppliers where code = 'VERIFIED'),
   (select id from public.peptides where code = 'CJC1295DAC'),
   '711', 'https://verifiedpeptides.com/product/cjc1295/',
   'CJC-1295 DAC Peptide (5MG)', 5, true, true),
  ((select id from public.suppliers where code = 'SWISSCHEMS'),
   (select id from public.peptides where code = 'CJC1295DAC'),
   '475', 'https://swisschems.is/product/cjc-1295-with-dac-2mg-price-is-per-vial/',
   'CJC-1295 with DAC, 2mg', 2, true, true),
  ((select id from public.suppliers where code = 'PURETESTED'),
   (select id from public.peptides where code = 'CJC1295DAC'),
   '987656649', 'https://www.puretestedpeptides.com/product/cjc-1295-with-dac-5mg-ga4/',
   'CJC-1295 with DAC 5MG', 5, true, true),
  ((select id from public.suppliers where code = 'PANDA'),
   (select id from public.peptides where code = 'CJC1295DAC'),
   '7297', 'https://pandapeptides.com/product/cjc-1295-with-dac/',
   'CJC-1295 (WITH DAC) 5mg', 5, true, true)
on conflict (supplier_id, supplier_sku) do nothing;

-- ── PINEALON ──
insert into public.supplier_products
  (supplier_id, peptide_id, supplier_sku, product_url, product_name, mass_per_unit_mg, is_reference_sku, active)
values
  ((select id from public.suppliers where code = 'LIBERTY'),
   (select id from public.peptides where code = 'PINEALON'),
   '46460', 'https://libertypeptides.com/product/pinealon-20mg/',
   'Pinealon (20mg)', 20, true, true),
  ((select id from public.suppliers where code = 'GENETIC'),
   (select id from public.peptides where code = 'PINEALON'),
   '2420', 'https://geneticpeptide.com/product/pinealon-5mg-vial-bioregulator-2/',
   'Pinealon Vial (Bioregulator)', 5, true, true),
  ((select id from public.suppliers where code = 'PUREHEALTH'),
   (select id from public.peptides where code = 'PINEALON'),
   '13100', 'https://purehealthpeptides.com/product/pinealon/',
   'Pinealon', 20, true, true),
  ((select id from public.suppliers where code = 'VERIFIED'),
   (select id from public.peptides where code = 'PINEALON'),
   '60281', 'https://verifiedpeptides.com/product/pinealon/',
   'Pinealon Peptide (20MG)', 20, true, true),
  ((select id from public.suppliers where code = 'SWISSCHEMS'),
   (select id from public.peptides where code = 'PINEALON'),
   '177155', 'https://swisschems.is/product/pinealon-20mg/',
   'Pinealon, 20mg', 20, true, true),
  ((select id from public.suppliers where code = 'PURETESTED'),
   (select id from public.peptides where code = 'PINEALON'),
   '987656004', 'https://www.puretestedpeptides.com/product/pinealon-10mg-peptide/',
   'Pinealon 10mg peptide', 10, true, true)
on conflict (supplier_id, supplier_sku) do nothing;

-- ── ARA290 ──
insert into public.supplier_products
  (supplier_id, peptide_id, supplier_sku, product_url, product_name, mass_per_unit_mg, is_reference_sku, active)
values
  ((select id from public.suppliers where code = 'LIBERTY'),
   (select id from public.peptides where code = 'ARA290'),
   '3369', 'https://libertypeptides.com/product/ara-290/',
   'ARA-290 (16mg)', 16, true, true),
  ((select id from public.suppliers where code = 'GENETIC'),
   (select id from public.peptides where code = 'ARA290'),
   '108796', 'https://geneticpeptide.com/product/ara-290-5mg/',
   'ARA 290', 5, true, true),
  ((select id from public.suppliers where code = 'PUREHEALTH'),
   (select id from public.peptides where code = 'ARA290'),
   '20745', 'https://purehealthpeptides.com/product/ara-290/',
   'ARA-290', 5, true, true),
  ((select id from public.suppliers where code = 'VERIFIED'),
   (select id from public.peptides where code = 'ARA290'),
   '63899', 'https://verifiedpeptides.com/product/ara-290/',
   'ARA-290 Peptide (12MG)', 12, true, true),
  ((select id from public.suppliers where code = 'SWISSCHEMS'),
   (select id from public.peptides where code = 'ARA290'),
   '876', 'https://swisschems.is/product/ara-290-16mg-price-is-per-kit-10vials-160mg/',
   'Cibinitide ARA-290 16mg (per vial, kit of 10)', 16, true, true),
  ((select id from public.suppliers where code = 'EZPEP'),
   (select id from public.peptides where code = 'ARA290'),
   '30339', 'https://ezpeptides.com/product/ara-290-10mg/',
   'ARA-290 10mg', 10, true, true)
on conflict (supplier_id, supplier_sku) do nothing;

-- ── VIP ──
insert into public.supplier_products
  (supplier_id, peptide_id, supplier_sku, product_url, product_name, mass_per_unit_mg, is_reference_sku, active)
values
  ((select id from public.suppliers where code = 'LIBERTY'),
   (select id from public.peptides where code = 'VIP'),
   '56957', 'https://libertypeptides.com/product/vip-5mg/',
   'VIP (5mg)', 5, true, true),
  ((select id from public.suppliers where code = 'GENETIC'),
   (select id from public.peptides where code = 'VIP'),
   '2466', 'https://geneticpeptide.com/product/vip-vial-5mg/',
   'VIP Vial 5MG', 5, true, true),
  ((select id from public.suppliers where code = 'PUREHEALTH'),
   (select id from public.peptides where code = 'VIP'),
   '9903', 'https://purehealthpeptides.com/product/vip/',
   'VIP', 5, true, true),
  ((select id from public.suppliers where code = 'PURETESTED'),
   (select id from public.peptides where code = 'VIP'),
   '987657454', 'https://www.puretestedpeptides.com/product/vip-peptide-10mg-for-sale/',
   'VIP 10mg', 10, true, true),
  ((select id from public.suppliers where code = 'EZPEP'),
   (select id from public.peptides where code = 'VIP'),
   '60804', 'https://ezpeptides.com/product/vip-10mg/',
   'VIP 10MG', 10, true, true)
on conflict (supplier_id, supplier_sku) do nothing;

-- ── GHRP6 ──
insert into public.supplier_products
  (supplier_id, peptide_id, supplier_sku, product_url, product_name, mass_per_unit_mg, is_reference_sku, active)
values
  ((select id from public.suppliers where code = 'LIBERTY'),
   (select id from public.peptides where code = 'GHRP6'),
   '52654', 'https://libertypeptides.com/product/ghrp-6-5mg/',
   'GHRP-6 (5mg)', 5, true, true),
  ((select id from public.suppliers where code = 'GENETIC'),
   (select id from public.peptides where code = 'GHRP6'),
   '2374', 'https://geneticpeptide.com/product/ghrp-6-vial-5mg/',
   'GHRP-6 Vial', 5, true, true),
  ((select id from public.suppliers where code = 'SWISSCHEMS'),
   (select id from public.peptides where code = 'GHRP6'),
   '369', 'https://swisschems.is/product/ghrp-6-5mg-price-is-per-vial/',
   'GHRP-6 5mg', 5, true, true),
  ((select id from public.suppliers where code = 'OPTIPEP'),
   (select id from public.peptides where code = 'GHRP6'),
   '2750', 'https://optimalpep.com/product/ghrp-6-10mg/',
   'GHRP-6 10MG', 10, true, true)
on conflict (supplier_id, supplier_sku) do nothing;

-- ── ADIPOTIDE ──
insert into public.supplier_products
  (supplier_id, peptide_id, supplier_sku, product_url, product_name, mass_per_unit_mg, is_reference_sku, active)
values
  ((select id from public.suppliers where code = 'GENETIC'),
   (select id from public.peptides where code = 'ADIPOTIDE'),
   '109233', 'https://geneticpeptide.com/product/adipotide-5-mg/',
   'Adipotide 5MG', 5, true, true),
  ((select id from public.suppliers where code = 'PUREHEALTH'),
   (select id from public.peptides where code = 'ADIPOTIDE'),
   '9895', 'https://purehealthpeptides.com/product/adipotide/',
   'Adipotide', 5, true, true),
  ((select id from public.suppliers where code = 'SWISSCHEMS'),
   (select id from public.peptides where code = 'ADIPOTIDE'),
   '589', 'https://swisschems.is/product/ftpp-adipotide-5mg-price-is-per-vial/',
   'FTPP (Adipotide) 5mg', 5, true, true),
  ((select id from public.suppliers where code = 'PURETESTED'),
   (select id from public.peptides where code = 'ADIPOTIDE'),
   '987654363', 'https://www.puretestedpeptides.com/product/adipotide-5mg-buy-adipotide-online/',
   'Adipotide 5mg', 5, true, true)
on conflict (supplier_id, supplier_sku) do nothing;

-- ── GONADORELIN ──
insert into public.supplier_products
  (supplier_id, peptide_id, supplier_sku, product_url, product_name, mass_per_unit_mg, is_reference_sku, active)
values
  ((select id from public.suppliers where code = 'LIBERTY'),
   (select id from public.peptides where code = 'GONADORELIN'),
   '27527', 'https://libertypeptides.com/product/gonadorelin-10mg/',
   'Gonadorelin (10mg)', 10, true, true),
  ((select id from public.suppliers where code = 'GENETIC'),
   (select id from public.peptides where code = 'GONADORELIN'),
   '2378', 'https://geneticpeptide.com/product/gonadorelin-vial/',
   'Gonadorelin Vial', 5, true, true),
  ((select id from public.suppliers where code = 'PUREHEALTH'),
   (select id from public.peptides where code = 'GONADORELIN'),
   '25736', 'https://purehealthpeptides.com/product/gonadorelin/',
   'Gonadorelin', 5, true, true),
  ((select id from public.suppliers where code = 'SWISSCHEMS'),
   (select id from public.peptides where code = 'GONADORELIN'),
   '552', 'https://swisschems.is/product/gonadorelin-2mg-price-is-per-vial/',
   'Gonadorelin 2mg', 2, true, true)
on conflict (supplier_id, supplier_sku) do nothing;

-- ── SURVODUTIDE ──
insert into public.supplier_products
  (supplier_id, peptide_id, supplier_sku, product_url, product_name, mass_per_unit_mg, is_reference_sku, active)
values
  ((select id from public.suppliers where code = 'LIBERTY'),
   (select id from public.peptides where code = 'SURVODUTIDE'),
   '32339', 'https://libertypeptides.com/product/survodutide-5mg/',
   'Survodutide (5mg)', 5, true, true),
  ((select id from public.suppliers where code = 'GENETIC'),
   (select id from public.peptides where code = 'SURVODUTIDE'),
   '130256', 'https://geneticpeptide.com/product/survodutide-vial/',
   'Survodutide Vial', 5, true, true),
  ((select id from public.suppliers where code = 'EZPEP'),
   (select id from public.peptides where code = 'SURVODUTIDE'),
   '30349', 'https://ezpeptides.com/product/survodutide-10mg/',
   'Survodutide 10mg', 10, true, true)
on conflict (supplier_id, supplier_sku) do nothing;

-- ── MGF ──
insert into public.supplier_products
  (supplier_id, peptide_id, supplier_sku, product_url, product_name, mass_per_unit_mg, is_reference_sku, active)
values
  ((select id from public.suppliers where code = 'GENETIC'),
   (select id from public.peptides where code = 'MGF'),
   '109277', 'https://geneticpeptide.com/product/mgf-10-mg/',
   'MGF 10 MG Vial', 10, true, true),
  ((select id from public.suppliers where code = 'PUREHEALTH'),
   (select id from public.peptides where code = 'MGF'),
   '25755', 'https://purehealthpeptides.com/product/mgf-mechano-growth-factor/',
   'MGF (Mechano Growth Factor)', 5, true, true),
  ((select id from public.suppliers where code = 'SWISSCHEMS'),
   (select id from public.peptides where code = 'MGF'),
   '443', 'https://swisschems.is/product/mgfc-terminal-2mg-price-is-per-vial/',
   'MGF without PEG 2mg', 2, true, true)
on conflict (supplier_id, supplier_sku) do nothing;

-- ── PEGMGF ──
insert into public.supplier_products
  (supplier_id, peptide_id, supplier_sku, product_url, product_name, mass_per_unit_mg, is_reference_sku, active)
values
  ((select id from public.suppliers where code = 'GENETIC'),
   (select id from public.peptides where code = 'PEGMGF'),
   '2419', 'https://geneticpeptide.com/product/peg-mgf-5mg-vial-2/',
   'PEG MGF Vial', 5, true, true),
  ((select id from public.suppliers where code = 'PUREHEALTH'),
   (select id from public.peptides where code = 'PEGMGF'),
   '9916', 'https://purehealthpeptides.com/product/peg-mgf/',
   'PEG-MGF', 5, true, true),
  ((select id from public.suppliers where code = 'SWISSCHEMS'),
   (select id from public.peptides where code = 'PEGMGF'),
   '455', 'https://swisschems.is/product/peg-mgf-2mg-price-is-per-vial/',
   'PEG MGF 2mg', 2, true, true)
on conflict (supplier_id, supplier_sku) do nothing;

-- ── DIHEXA ──
insert into public.supplier_products
  (supplier_id, peptide_id, supplier_sku, product_url, product_name, mass_per_unit_mg, is_reference_sku, active)
values
  ((select id from public.suppliers where code = 'LIBERTY'),
   (select id from public.peptides where code = 'DIHEXA'),
   '63128', 'https://libertypeptides.com/product/dihexa-5mg-x-60-capsules/',
   'Dihexa 5mg x 60 capsules (oral)', 300, true, true),
  ((select id from public.suppliers where code = 'GENETIC'),
   (select id from public.peptides where code = 'DIHEXA'),
   '105695', 'https://geneticpeptide.com/product/dihexa-10mg/',
   'Dihexa Vial', 10, true, true),
  ((select id from public.suppliers where code = 'SWISSCHEMS'),
   (select id from public.peptides where code = 'DIHEXA'),
   '1210', 'https://swisschems.is/product/dihexa-capsules-300mg-5mg-per-capsule/',
   'Dihexa 5mg/cap x 60 capsules (oral)', 300, true, true)
on conflict (supplier_id, supplier_sku) do nothing;

-- ── MK677 ──
insert into public.supplier_products
  (supplier_id, peptide_id, supplier_sku, product_url, product_name, mass_per_unit_mg, is_reference_sku, active)
values
  ((select id from public.suppliers where code = 'LIBERTY'),
   (select id from public.peptides where code = 'MK677'),
   '5996', 'https://libertypeptides.com/product/ibutamoren-12-5mg-x-60-capsules/',
   'Ibutamoren 12.5mg x 60 capsules (oral)', 750, true, true),
  ((select id from public.suppliers where code = 'GENETIC'),
   (select id from public.peptides where code = 'MK677'),
   '2414', 'https://geneticpeptide.com/product/mk-677-ibutamoren-15mg-capsules-2/',
   'MK-677 (Ibutamoren) 15mg x 100 capsules (oral)', 1500, true, true),
  ((select id from public.suppliers where code = 'SWISSCHEMS'),
   (select id from public.peptides where code = 'MK677'),
   '690', 'https://swisschems.is/product/mk-677-ibutamoren-380mg-10mg-60-caps/',
   'MK-677 (Ibutamoren) 10mg/cap x 60 capsules (oral)', 600, true, true)
on conflict (supplier_id, supplier_sku) do nothing;

-- == verification (run manually after apply) =======================
-- -- Should return 14 rows, all is_active=true + enabled_in_twap=false:
-- SELECT code, display_name, is_active, enabled_in_twap, category
--   FROM public.peptides
--  WHERE code IN ('KPV','OXYTOCIN','CJC1295DAC','PINEALON','ARA290',
--                 'VIP','GHRP6','ADIPOTIDE','GONADORELIN','SURVODUTIDE',
--                 'MGF','PEGMGF','DIHEXA','MK677')
--  ORDER BY code;
--
-- -- Per-peptide vendor coverage (expect 7/7/7/6/6/5/4/4/4/3/3/3/3/3 = 65):
-- SELECT p.code, count(*) AS vendor_rows
--   FROM public.peptides p
--   JOIN public.supplier_products sp ON sp.peptide_id = p.id
--  WHERE p.code IN ('KPV','OXYTOCIN','CJC1295DAC','PINEALON','ARA290',
--                   'VIP','GHRP6','ADIPOTIDE','GONADORELIN','SURVODUTIDE',
--                   'MGF','PEGMGF','DIHEXA','MK677')
--    AND sp.active
--  GROUP BY p.code ORDER BY p.code;

-- == down (reversal block, run only on rollback) ===================
-- BEGIN;
-- DELETE FROM public.supplier_products
--  WHERE peptide_id IN (
--    SELECT id FROM public.peptides WHERE code IN (
--      'KPV','OXYTOCIN','CJC1295DAC','PINEALON','ARA290',
--      'VIP','GHRP6','ADIPOTIDE','GONADORELIN','SURVODUTIDE',
--      'MGF','PEGMGF','DIHEXA','MK677'
--    )
--  );
-- DELETE FROM public.peptides
--  WHERE code IN (
--    'KPV','OXYTOCIN','CJC1295DAC','PINEALON','ARA290',
--    'VIP','GHRP6','ADIPOTIDE','GONADORELIN','SURVODUTIDE',
--    'MGF','PEGMGF','DIHEXA','MK677'
--  );
-- COMMIT;
