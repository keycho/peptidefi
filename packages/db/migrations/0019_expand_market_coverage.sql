-- 0019_expand_market_coverage.sql
-- Doubles peptide and supplier coverage:
--   - Adds peptides.category column (text) and backfills the 15 existing peptides.
--   - Inserts 11 new peptides. 8 are is_active=true (multi-vendor coverage).
--     3 are is_active=false (single-vendor only — TIRZEPATIDE / RETATRUTIDE on
--     SWISSCHEMS, CEREBROLYSIN on NUSCIENCE; same treatment as NAD).
--   - Inserts 2 new WooCommerce suppliers: PURERAWZ + SWISSCHEMS.
--   - Inserts 57 supplier_products rows (combinations of new peptides x existing
--     suppliers AND existing peptides x new suppliers; never duplicates an
--     already-present (supplier, peptide) pair).
--
-- Hard-skipped per the 0012 review: PUREHEALTH/GLP1 (unidentified '(C)' form),
--   NUSCIENCE/TB500 (17-23 fragment, not full-length), VERIFIED/GHKCU (bulk
--   1000mg powder, different market tier), VERIFIED/AOD9604 (quirky 4mg pack
--   inflates per-mg). PURERAWZ ships most peptides as nasal sprays (Form attribute);
--   those rows are filtered as non-base.

-- ─── add category column to peptides ──────────────────────────────────────
alter table public.peptides add column if not exists category text;

-- ─── backfill categories for existing peptides ────────────────────────────
update public.peptides set category = 'metabolic' where code = 'GLP1';
update public.peptides set category = 'longevity' where code = 'BPC157';
update public.peptides set category = 'longevity' where code = 'TB500';
update public.peptides set category = 'longevity' where code = 'GHKCU';
update public.peptides set category = 'growth' where code = 'CJC1295';
update public.peptides set category = 'growth' where code = 'IPAMO';
update public.peptides set category = 'longevity' where code = 'EPITHAL';
update public.peptides set category = 'hormonal' where code = 'PT141';
update public.peptides set category = 'longevity' where code = 'NAD';
update public.peptides set category = 'metabolic' where code = 'AOD9604';
update public.peptides set category = 'metabolic' where code = 'TESO';
update public.peptides set category = 'longevity' where code = 'MOTSC';
update public.peptides set category = 'cognitive' where code = 'SELANK';
update public.peptides set category = 'cognitive' where code = 'SEMAX';
update public.peptides set category = 'longevity' where code = 'AMINO1MQ';

-- ─── insert 11 new peptides ────────────────────────────────────────────────
insert into public.peptides (code, display_name, full_name, description, category, is_active) values
  ('TIRZEPATIDE', 'Tirzepatide', 'Tirzepatide (LY3298176)', 'Dual GLP-1 / GIP receptor agonist; major metabolic peptide.', 'metabolic', false),
  ('RETATRUTIDE', 'Retatrutide', 'Retatrutide (LY3437943)', 'Triple GLP-1 / GIP / glucagon receptor agonist.', 'metabolic', false),
  ('TESAMORELIN', 'Tesamorelin', 'Tesamorelin', 'GHRH analog; widely studied in growth hormone research.', 'growth', true),
  ('SERMORELIN', 'Sermorelin', 'Sermorelin', 'GHRH 1-29 analog.', 'growth', true),
  ('CAGRILINTIDE', 'Cagrilintide', 'Cagrilintide', 'Long-acting amylin analog.', 'metabolic', true),
  ('CEREBROLYSIN', 'Cerebrolysin', 'Cerebrolysin', 'Neurotrophic peptide mixture studied in cognitive contexts.', 'cognitive', false),
  ('GLUTATHIONE', 'Glutathione', 'L-Glutathione', 'Antioxidant tripeptide (Glu-Cys-Gly).', 'longevity', true),
  ('TA1', 'Thymosin α-1', 'Thymosin Alpha-1', '28-amino-acid peptide; immune-modulator research peptide.', 'immune', true),
  ('HEXARELIN', 'Hexarelin', 'Hexarelin', 'Hexapeptide growth hormone secretagogue.', 'growth', true),
  ('KISSPEPTIN', 'Kisspeptin-10', 'Kisspeptin-10', 'Hypothalamic peptide; widely studied in reproductive endocrinology.', 'hormonal', true),
  ('LL37', 'LL-37', 'LL-37 (CAP-18)', 'Cathelicidin antimicrobial peptide.', 'immune', true);

-- ─── insert 2 new suppliers ────────────────────────────────────────────────
insert into public.suppliers (code, display_name, homepage_url, scraper_module, status) values
  ('PURERAWZ', 'PureRawz', 'https://purerawz.co/', 'woocommerce', 'active'),
  ('SWISSCHEMS', 'Swiss Chems', 'https://swisschems.is/', 'woocommerce', 'active');

-- ─── insert 57 supplier_products rows ────────────────────────────
-- supplier_sku stores the WooCommerce numeric product id (stable across
-- product renames). product_url is the canonical /product/<slug>/ link for
-- human verification. mass_per_unit_mg starts at the matcher-extracted value;
-- the scraper updates it on every successful scrape, with MASS_CHANGE_DETECTED
-- logged when delta > 5%.
insert into public.supplier_products
  (supplier_id, peptide_id, supplier_sku, product_url, product_name, mass_per_unit_mg, is_reference_sku, active) values
  ((select id from public.suppliers where code = 'PUREHEALTH'), (select id from public.peptides  where code = 'GLUTATHIONE'), '479', 'https://purehealthpeptides.com/product/glutathione/', 'Glutathione', 600, true, true),
  ((select id from public.suppliers where code = 'PUREHEALTH'), (select id from public.peptides  where code = 'TA1'), '473', 'https://purehealthpeptides.com/product/thymosin-alpha-1/', 'Thymosin Alpha-1', 5, true, true),
  ((select id from public.suppliers where code = 'PUREHEALTH'), (select id from public.peptides  where code = 'HEXARELIN'), '434', 'https://purehealthpeptides.com/product/hexarelin/', 'Hexarelin', 5, true, true),
  ((select id from public.suppliers where code = 'PUREHEALTH'), (select id from public.peptides  where code = 'KISSPEPTIN'), '439', 'https://purehealthpeptides.com/product/kispeptin-10/', 'Kisspeptin-10', 5, true, true),
  ((select id from public.suppliers where code = 'PUREHEALTH'), (select id from public.peptides  where code = 'LL37'), '423', 'https://purehealthpeptides.com/product/ll-37/', 'LL-37', 5, true, true),
  ((select id from public.suppliers where code = 'NUSCIENCE'), (select id from public.peptides  where code = 'TESAMORELIN'), '772', 'https://nusciencepeptides.com/product/tesamorelin/', 'Tesamorelin - 10mg', 10, true, true),
  ((select id from public.suppliers where code = 'NUSCIENCE'), (select id from public.peptides  where code = 'SERMORELIN'), '696', 'https://nusciencepeptides.com/product/sermorelin/', 'Sermorelin - 5mg', 5, true, true),
  ((select id from public.suppliers where code = 'NUSCIENCE'), (select id from public.peptides  where code = 'CAGRILINTIDE'), '13865', 'https://nusciencepeptides.com/product/cagrilintide/', 'Cagrilintide - 5mg', 5, true, true),
  ((select id from public.suppliers where code = 'NUSCIENCE'), (select id from public.peptides  where code = 'CEREBROLYSIN'), '30188', 'https://nusciencepeptides.com/product/cerebrolysin/', 'Cerebrolysin 1200mg', 1200, true, true),
  ((select id from public.suppliers where code = 'NUSCIENCE'), (select id from public.peptides  where code = 'GLUTATHIONE'), '28338', 'https://nusciencepeptides.com/product/glutathione/', 'Glutathione Peptide (GSH) – 600mg | 1500mg', 600, true, true),
  ((select id from public.suppliers where code = 'NUSCIENCE'), (select id from public.peptides  where code = 'TA1'), '1129', 'https://nusciencepeptides.com/product/thymosin-alpha-1/', 'Thymosin Alpha 1 - 10mg', 10, true, true),
  ((select id from public.suppliers where code = 'NUSCIENCE'), (select id from public.peptides  where code = 'HEXARELIN'), '699', 'https://nusciencepeptides.com/product/hexarelin/', 'Hexarelin - 2mg', 2, true, true),
  ((select id from public.suppliers where code = 'NUSCIENCE'), (select id from public.peptides  where code = 'KISSPEPTIN'), '25002', 'https://nusciencepeptides.com/product/kisspeptin/', 'Kisspeptin - 10mg', 10, true, true),
  ((select id from public.suppliers where code = 'VERIFIED'), (select id from public.peptides  where code = 'GLUTATHIONE'), '68649', 'https://verifiedpeptides.com/product/glutathione/', 'Glutathione 1500MG', 1500, true, true),
  ((select id from public.suppliers where code = 'VERIFIED'), (select id from public.peptides  where code = 'TA1'), '10144', 'https://verifiedpeptides.com/product/thymosinalpha/', 'Thymosin Alpha-1 Peptide (10MG)', 10, true, true),
  ((select id from public.suppliers where code = 'VERIFIED'), (select id from public.peptides  where code = 'KISSPEPTIN'), '79075', 'https://verifiedpeptides.com/product/kisspeptin/', 'Kisspeptin Peptide (10MG)', 10, true, true),
  ((select id from public.suppliers where code = 'VERIFIED'), (select id from public.peptides  where code = 'LL37'), '60277', 'https://verifiedpeptides.com/product/ll37/', 'LL-37 Peptide (5MG)', 5, true, true),
  ((select id from public.suppliers where code = 'LIBERTY'), (select id from public.peptides  where code = 'TESAMORELIN'), '654', 'https://libertypeptides.com/product/tesamorelin-10mg-2/', 'Tesamorelin (10mg)', 10, true, true),
  ((select id from public.suppliers where code = 'LIBERTY'), (select id from public.peptides  where code = 'SERMORELIN'), '164', 'https://libertypeptides.com/product/sermorelin-5mg/', 'Sermorelin (5mg)', 5, true, true),
  ((select id from public.suppliers where code = 'LIBERTY'), (select id from public.peptides  where code = 'CAGRILINTIDE'), '6009', 'https://libertypeptides.com/product/cagrilintide-5mg/', 'Cagrilintide (5mg)', 5, true, true),
  ((select id from public.suppliers where code = 'LIBERTY'), (select id from public.peptides  where code = 'GLUTATHIONE'), '31736', 'https://libertypeptides.com/product/l-glutathione-600mg/', 'L-Glutathione (600mg)', 600, true, true),
  ((select id from public.suppliers where code = 'LIBERTY'), (select id from public.peptides  where code = 'TA1'), '3372', 'https://libertypeptides.com/product/thymosin-alpha-1/', 'Thymosin Alpha-1 (10mg)', 10, true, true),
  ((select id from public.suppliers where code = 'LIBERTY'), (select id from public.peptides  where code = 'KISSPEPTIN'), '831', 'https://libertypeptides.com/product/kisspeptin-10/', 'Kisspeptin-10 (10mg)', 10, true, true),
  ((select id from public.suppliers where code = 'LIBERTY'), (select id from public.peptides  where code = 'LL37'), '60146', 'https://libertypeptides.com/product/ll-37-5mg/', 'LL-37 (5mg)', 5, true, true),
  ((select id from public.suppliers where code = 'GENETIC'), (select id from public.peptides  where code = 'TB500'), '2441', 'https://geneticpeptide.com/product/tb-500-thymosin-beta-4-43aa/', 'TB-500 (Thymosin Beta-4) (43aa)', 2, true, true),
  ((select id from public.suppliers where code = 'GENETIC'), (select id from public.peptides  where code = 'PT141'), '2421', 'https://geneticpeptide.com/product/pt-141-vial-10mg/', 'PT-141 Vial 10MG', 10, true, true),
  ((select id from public.suppliers where code = 'GENETIC'), (select id from public.peptides  where code = 'TESAMORELIN'), '2447', 'https://geneticpeptide.com/product/tesamorelin-vial/', 'Tesamorelin Vial', 2, true, true),
  ((select id from public.suppliers where code = 'GENETIC'), (select id from public.peptides  where code = 'SERMORELIN'), '2437', 'https://geneticpeptide.com/product/sermorelin-vial-2mg/', 'Sermorelin Vial 2MG', 2, true, true),
  ((select id from public.suppliers where code = 'GENETIC'), (select id from public.peptides  where code = 'CAGRILINTIDE'), '2349', 'https://geneticpeptide.com/product/cagrilintide-vial/', 'Cagrilintide Vial', 5, true, true),
  ((select id from public.suppliers where code = 'GENETIC'), (select id from public.peptides  where code = 'GLUTATHIONE'), '2401', 'https://geneticpeptide.com/product/l-glutathione-vial-600mg/', 'L-Glutathione Vial', 100, true, true),
  ((select id from public.suppliers where code = 'GENETIC'), (select id from public.peptides  where code = 'TA1'), '2456', 'https://geneticpeptide.com/product/thymosin-alpha-1-vial/', 'Thymosin Alpha-1 Vial', 5, true, true),
  ((select id from public.suppliers where code = 'GENETIC'), (select id from public.peptides  where code = 'HEXARELIN'), '2387', 'https://geneticpeptide.com/product/kpv-vial-5mg-copy/', 'Hexarelin Vial', 5, true, true),
  ((select id from public.suppliers where code = 'GENETIC'), (select id from public.peptides  where code = 'KISSPEPTIN'), '2399', 'https://geneticpeptide.com/product/kisspeptin-10-vial-10mg/', 'Kisspeptin-10 Vial', 5, true, true),
  ((select id from public.suppliers where code = 'GENETIC'), (select id from public.peptides  where code = 'LL37'), '109239', 'https://geneticpeptide.com/product/ll37-10-mg/', 'LL37 Vial', 5, true, true),
  ((select id from public.suppliers where code = 'PULSE'), (select id from public.peptides  where code = 'TESAMORELIN'), '2202', 'https://pulsepeptides.com/product/tesamorelin/', 'Tesamorelin', 5, true, true),
  ((select id from public.suppliers where code = 'PULSE'), (select id from public.peptides  where code = 'TA1'), '3938', 'https://pulsepeptides.com/product/thymosin-alpha-1/', 'Thymosin Alpha-1', 5, true, true),
  ((select id from public.suppliers where code = 'PURERAWZ'), (select id from public.peptides  where code = 'PT141'), '358938899', 'https://purerawz.co/product/n-acetyl-pt-141/', 'N-Acetyl PT 141', 10, true, true),
  ((select id from public.suppliers where code = 'PURERAWZ'), (select id from public.peptides  where code = 'TA1'), '358806967', 'https://purerawz.co/product/thymosin-alpha-1/', 'Thymosin Alpha 1', 5, true, true),
  ((select id from public.suppliers where code = 'PURERAWZ'), (select id from public.peptides  where code = 'LL37'), '358807359', 'https://purerawz.co/product/ll-37-cap-18/', 'LL-37 (CAP-18)', 5, true, true),
  ((select id from public.suppliers where code = 'SWISSCHEMS'), (select id from public.peptides  where code = 'BPC157'), '1151', 'https://swisschems.is/product/bpc-157-5mg/', 'BPC-157 5mg (1 vial)', 5, true, true),
  ((select id from public.suppliers where code = 'SWISSCHEMS'), (select id from public.peptides  where code = 'TB500'), '716', 'https://swisschems.is/product/tb-500-thymosin-beta-4-10-mg-per-vial/', 'TB-500 (Thymosin Beta-4)', 2, true, true),
  ((select id from public.suppliers where code = 'SWISSCHEMS'), (select id from public.peptides  where code = 'GHKCU'), '287762', 'https://swisschems.is/product/ghk-cu-copper-peptide/', 'GHK-Cu Copper Peptide', 10, true, true),
  ((select id from public.suppliers where code = 'SWISSCHEMS'), (select id from public.peptides  where code = 'IPAMO'), '389', 'https://swisschems.is/product/ipamorelin-2mg-price-is-per-vial/', 'Ipamorelin 2 mg', 2, true, true),
  ((select id from public.suppliers where code = 'SWISSCHEMS'), (select id from public.peptides  where code = 'EPITHAL'), '620', 'https://swisschems.is/product/epitalon-10mg-price-is-per-vial/', 'Epitalon 10 mg', 10, true, true),
  ((select id from public.suppliers where code = 'SWISSCHEMS'), (select id from public.peptides  where code = 'PT141'), '560', 'https://swisschems.is/product/pt-141-10mg-price-is-per-vial/', 'PT-141 (Bremenalotide), 10mg', 10, true, true),
  ((select id from public.suppliers where code = 'SWISSCHEMS'), (select id from public.peptides  where code = 'MOTSC'), '863', 'https://swisschems.is/product/mots-c-10mg-price-is-per-vial/', 'MOTS-C 10mg', 10, true, true),
  ((select id from public.suppliers where code = 'SWISSCHEMS'), (select id from public.peptides  where code = 'SELANK'), '596', 'https://swisschems.is/product/selank-5mg-price-is-per-vial/', 'Selank 5 mg (1 vial)', 5, true, true),
  ((select id from public.suppliers where code = 'SWISSCHEMS'), (select id from public.peptides  where code = 'SEMAX'), '732', 'https://swisschems.is/product/semax-30mg-price-is-per-vial/', 'Semax 30mg (1 vial)', 30, true, true),
  ((select id from public.suppliers where code = 'SWISSCHEMS'), (select id from public.peptides  where code = 'TIRZEPATIDE'), '1247', 'https://swisschems.is/product/tirzepatide-glp-1-analogue-5-mg-1-vial/', 'Tirzepatide (LY3298176) 5 mg (1 vial)', 5, true, true),
  ((select id from public.suppliers where code = 'SWISSCHEMS'), (select id from public.peptides  where code = 'RETATRUTIDE'), '316883', 'https://swisschems.is/product/glp1-trpl-5m10k/', 'Retatrutide (LY-3437943)', 5, true, true),
  ((select id from public.suppliers where code = 'SWISSCHEMS'), (select id from public.peptides  where code = 'TESAMORELIN'), '707', 'https://swisschems.is/product/tesamorelin-2mg-price-is-per-vial/', 'Tesamorelin, 2mg', 2, true, true),
  ((select id from public.suppliers where code = 'SWISSCHEMS'), (select id from public.peptides  where code = 'SERMORELIN'), '411', 'https://swisschems.is/product/sermorelin-2mg-price-is-per-vial/', 'Sermorelin, 2mg', 2, true, true),
  ((select id from public.suppliers where code = 'SWISSCHEMS'), (select id from public.peptides  where code = 'GLUTATHIONE'), '359', 'https://swisschems.is/product/injectable-glutathione-600mg/', 'Glutathione, 600mg', 600, true, true),
  ((select id from public.suppliers where code = 'SWISSCHEMS'), (select id from public.peptides  where code = 'TA1'), '167576', 'https://swisschems.is/product/thymosin-alpha-1/', 'Thymosin Alpha 1', 5, true, true),
  ((select id from public.suppliers where code = 'SWISSCHEMS'), (select id from public.peptides  where code = 'HEXARELIN'), '401', 'https://swisschems.is/product/hexarelin-examorelin-2mg-price-is-per-vial/', 'Hexarelin (Examorelin) 2mg (1 vial)', 2, true, true),
  ((select id from public.suppliers where code = 'SWISSCHEMS'), (select id from public.peptides  where code = 'KISSPEPTIN'), '737', 'https://swisschems.is/product/kisspeptin-10-5mg-price-is-per-kit/', 'Kisspeptin-10 10mg (1 vial)', 5, true, true),
  ((select id from public.suppliers where code = 'SWISSCHEMS'), (select id from public.peptides  where code = 'LL37'), '1181', 'https://swisschems.is/product/ll-37-cap-18-5mg-kit-10vials/', 'LL-37 (CAP-18) 5 mg (1 vial)', 5, true, true);

