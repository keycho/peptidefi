-- 0012_expand_to_consumer_peptide_market.sql
-- Expands the active set from 3 research-grade peptides + 3 paused suppliers
-- to 14 active consumer-market peptides + 6 active WooCommerce vendors.
-- Cayman is paused (different market tier); NAD is inserted but is_active=false
-- (only one vendor carries it cleanly — needs another before TWAP is meaningful).
--
-- Schema additions:
--   peptides.is_active boolean default true — formal active-set flag
--   (suppliers already has status enum; we use status='paused' for Cayman).

-- Add the active-set flag on peptides.
alter table public.peptides
  add column if not exists is_active boolean not null default true;

-- Pause Cayman: research-grade tier, doesn't belong in consumer-market TWAP.
update public.suppliers
set status = 'paused',
    notes  = 'Paused for Phase 1 — different market tier (research-grade) than Tier 2 vendors. Revisit as separate ''research grade reference'' price feature in Phase 2.'
where code = 'CAYMAN';

-- Re-label GLP-1 to acknowledge the consumer market sells Sema-class GLP-1 RAs.
update public.peptides
set display_name = 'Semaglutide / GLP-1 RA'
where code = 'GLP1';

-- Insert 12 new peptides. NAD is_active=false until a second vendor lists it cleanly.
insert into public.peptides (code, display_name, full_name, description, is_active) values
  ('GHKCU', 'GHK-Cu', 'Glycyl-L-Histidyl-L-Lysine Copper', 'Tripeptide-copper complex; widely studied in skin and tissue repair contexts.', true),
  ('CJC1295', 'CJC-1295 (No-DAC / Mod GRF 1-29)', 'CJC-1295 No-DAC (Modified Growth Hormone Releasing Factor 1-29)', 'GHRH analog; we track the No-DAC variant explicitly across the consumer market.', true),
  ('IPAMO', 'Ipamorelin', 'Ipamorelin', 'Selective growth hormone secretagogue; ghrelin receptor agonist.', true),
  ('EPITHAL', 'Epitalon', 'Epitalon', 'Tetrapeptide; widely studied in telomere / longevity research.', true),
  ('PT141', 'PT-141', 'PT-141 (Bremelanotide)', 'Melanocortin receptor agonist.', true),
  ('NAD', 'NAD+', 'Nicotinamide Adenine Dinucleotide', 'Coenzyme; widely studied in metabolic and longevity contexts.', false),
  ('AOD9604', 'AOD-9604', 'AOD-9604', 'Modified hGH C-terminal fragment.', true),
  ('TESO', 'Tesofensine', 'Tesofensine', 'Triple monoamine reuptake inhibitor.', true),
  ('MOTSC', 'MOTS-c', 'Mitochondrial-derived peptide MOTS-c', 'Mitochondrial-derived peptide; widely studied in metabolic research.', true),
  ('SELANK', 'Selank', 'Selank', 'Synthetic anxiolytic peptide derived from tuftsin.', true),
  ('SEMAX', 'Semax', 'Semax', 'Synthetic peptide derived from ACTH (4-10).', true),
  ('AMINO1MQ', '5-Amino-1MQ', '5-Amino-1-Methylquinolinium', 'Small molecule NNMT inhibitor (technically not a peptide; tracked under the consumer peptide market category).', true);

-- Insert 6 new suppliers. All Tier-2 WooCommerce; status='active' by default.
insert into public.suppliers (code, display_name, homepage_url, scraper_module) values
  ('PUREHEALTH', 'Pure Health Peptides', 'https://purehealthpeptides.com/', 'woocommerce'),
  ('NUSCIENCE', 'NuScience Peptides', 'https://nusciencepeptides.com/', 'woocommerce'),
  ('VERIFIED', 'Verified Peptides', 'https://verifiedpeptides.com/', 'woocommerce'),
  ('LIBERTY', 'Liberty Peptides', 'https://libertypeptides.com/', 'woocommerce'),
  ('GENETIC', 'Genetic Peptide', 'https://geneticpeptide.com/', 'woocommerce'),
  ('PULSE', 'Pulse Peptides', 'https://pulsepeptides.com/', 'woocommerce');

-- Insert supplier_products rows. supplier_sku stores the WooCommerce product id
-- (more stable than slugs across rename events). product_url is the canonical
-- per-vendor URL for human verification.
insert into public.supplier_products
  (supplier_id, peptide_id, supplier_sku, product_url, product_name, mass_per_unit_mg, is_reference_sku, active) values
  ((select id from public.suppliers where code = 'NUSCIENCE'), (select id from public.peptides where code = 'GLP1'), '700', 'https://nusciencepeptides.com/product/glp-1-sm/', 'GLP-1 Sema Research Peptide – 5mg | 10mg | 20mg', 5, true, true),
  ((select id from public.suppliers where code = 'LIBERTY'), (select id from public.peptides where code = 'GLP1'), '45', 'https://libertypeptides.com/product/sema-glp-1-analogue/', 'SemagIutide (GLP-1 Analogue)', 6, true, true),
  ((select id from public.suppliers where code = 'GENETIC'), (select id from public.peptides where code = 'GLP1'), '2432', 'https://geneticpeptide.com/product/glp-1-s-vial-glp-1-analogue-2/', 'GLP-1 (S) Vial (GLP-1 Analogue)', 2, true, true),
  ((select id from public.suppliers where code = 'PUREHEALTH'), (select id from public.peptides where code = 'BPC157'), '33343', 'https://purehealthpeptides.com/product/bpc-157-2/', 'BPC-157', 30, true, true),
  ((select id from public.suppliers where code = 'VERIFIED'), (select id from public.peptides where code = 'BPC157'), '240', 'https://verifiedpeptides.com/product/bpc157/', 'BPC-157 Peptide (10MG)', 10, true, true),
  ((select id from public.suppliers where code = 'LIBERTY'), (select id from public.peptides where code = 'BPC157'), '167', 'https://libertypeptides.com/product/bpc-157-10mg/', 'BPC-157 (10mg)', 10, true, true),
  ((select id from public.suppliers where code = 'GENETIC'), (select id from public.peptides where code = 'BPC157'), '2312', 'https://geneticpeptide.com/product/bpc-157-vial/', 'BPC-157 Vial', 5, true, true),
  ((select id from public.suppliers where code = 'PULSE'), (select id from public.peptides where code = 'BPC157'), '13', 'https://pulsepeptides.com/product/bpc-157/', 'BPC-157', 5, true, true),
  ((select id from public.suppliers where code = 'PUREHEALTH'), (select id from public.peptides where code = 'TB500'), '467', 'https://purehealthpeptides.com/product/tb-500/', 'TB-500', 5, true, true),
  ((select id from public.suppliers where code = 'VERIFIED'), (select id from public.peptides where code = 'TB500'), '253', 'https://verifiedpeptides.com/product/tb500/', 'TB-500 Peptide (TB4) 10MG', 5, true, true),
  ((select id from public.suppliers where code = 'LIBERTY'), (select id from public.peptides where code = 'TB500'), '168', 'https://libertypeptides.com/product/tb-500-thymosin-beta-4/', 'TB-500 (Thymosin Beta-4)', 5, true, true),
  ((select id from public.suppliers where code = 'PULSE'), (select id from public.peptides where code = 'TB500'), '17', 'https://pulsepeptides.com/product/tb-500/', 'TB-500(TB4)', 5, true, true),
  ((select id from public.suppliers where code = 'PUREHEALTH'), (select id from public.peptides where code = 'GHKCU'), '433', 'https://purehealthpeptides.com/product/ghk-cu/', 'GHK-Cu', 50, true, true),
  ((select id from public.suppliers where code = 'LIBERTY'), (select id from public.peptides where code = 'GHKCU'), '304', 'https://libertypeptides.com/product/ghk-cu-copper-peptide/', 'GHK-Cu (Copper Peptide)', 50, true, true),
  ((select id from public.suppliers where code = 'GENETIC'), (select id from public.peptides where code = 'GHKCU'), '2372', 'https://geneticpeptide.com/product/ghk-cu-50mg-copper-peptide-vial/', 'GHK-Cu Copper Peptide Vial', 50, true, true),
  ((select id from public.suppliers where code = 'PULSE'), (select id from public.peptides where code = 'GHKCU'), '23', 'https://pulsepeptides.com/product/ghk-cu/', 'GHK-CU', 50, true, true),
  ((select id from public.suppliers where code = 'PUREHEALTH'), (select id from public.peptides where code = 'CJC1295'), '426', 'https://purehealthpeptides.com/product/cjc-1295/', 'CJC-1295', 5, true, true),
  ((select id from public.suppliers where code = 'NUSCIENCE'), (select id from public.peptides where code = 'CJC1295'), '704', 'https://nusciencepeptides.com/product/cjc-1295-no-dac/', 'CJC-1295 NO-DAC (MOD GRF 1-29) - 5mg & 10mg', 5, true, true),
  ((select id from public.suppliers where code = 'LIBERTY'), (select id from public.peptides where code = 'CJC1295'), '57976', 'https://libertypeptides.com/product/cjc-1295-no-dac-mod-grf-1-29-5mg/', 'CJC-1295 no DAC (Mod GRF 1-29) (5mg)', 5, true, true),
  ((select id from public.suppliers where code = 'GENETIC'), (select id from public.peptides where code = 'CJC1295'), '2353', 'https://geneticpeptide.com/product/cjc-1295-5mg-vial-no-dac-2/', 'CJC-1295 Vial (NO DAC)', 5, true, true),
  ((select id from public.suppliers where code = 'PUREHEALTH'), (select id from public.peptides where code = 'IPAMO'), '438', 'https://purehealthpeptides.com/product/ipamorelin/', 'Ipamorelin', 5, true, true),
  ((select id from public.suppliers where code = 'NUSCIENCE'), (select id from public.peptides where code = 'IPAMO'), '131', 'https://nusciencepeptides.com/product/ipamorelin/', 'Ipamorelin Peptide — 5mg | 10mg', 5, true, true),
  ((select id from public.suppliers where code = 'VERIFIED'), (select id from public.peptides where code = 'IPAMO'), '714', 'https://verifiedpeptides.com/product/ipamorelin/', 'Ipamorelin Peptide (10MG)', 10, true, true),
  ((select id from public.suppliers where code = 'LIBERTY'), (select id from public.peptides where code = 'IPAMO'), '169', 'https://libertypeptides.com/product/ipamorelin-5mg/', 'Ipamorelin (5mg)', 5, true, true),
  ((select id from public.suppliers where code = 'GENETIC'), (select id from public.peptides where code = 'IPAMO'), '2393', 'https://geneticpeptide.com/product/ipamorelin-vial/', 'Ipamorelin Vial', 2, true, true),
  ((select id from public.suppliers where code = 'VERIFIED'), (select id from public.peptides where code = 'EPITHAL'), '10136', 'https://verifiedpeptides.com/product/epitalon/', 'Epitalon Peptide (10MG)', 10, true, true),
  ((select id from public.suppliers where code = 'GENETIC'), (select id from public.peptides where code = 'EPITHAL'), '2365', 'https://geneticpeptide.com/product/epithalon-epitalon-10-mg-vial/', 'Epithalon (Epitalon) Vial', 10, true, true),
  ((select id from public.suppliers where code = 'PUREHEALTH'), (select id from public.peptides where code = 'PT141'), '33354', 'https://purehealthpeptides.com/product/pt-141-2/', 'PT-141', 30, true, true),
  ((select id from public.suppliers where code = 'VERIFIED'), (select id from public.peptides where code = 'PT141'), '724', 'https://verifiedpeptides.com/product/pt141/', 'PT-141 Peptide (10MG)', 10, true, true),
  ((select id from public.suppliers where code = 'LIBERTY'), (select id from public.peptides where code = 'PT141'), '841', 'https://libertypeptides.com/product/pt-141-10mg/', 'PT-141 (10mg)', 10, true, true),
  ((select id from public.suppliers where code = 'PULSE'), (select id from public.peptides where code = 'PT141'), '25', 'https://pulsepeptides.com/product/pt-141/', 'PT-141', 10, true, true),
  ((select id from public.suppliers where code = 'PUREHEALTH'), (select id from public.peptides where code = 'NAD'), '33348', 'https://purehealthpeptides.com/product/nad%e2%81%ba-nicotinamide-adenine-dinucleotide/', 'NAD⁺ (Nicotinamide Adenine Dinucleotide)', 1500, true, true),
  ((select id from public.suppliers where code = 'PUREHEALTH'), (select id from public.peptides where code = 'AOD9604'), '416', 'https://purehealthpeptides.com/product/aod9604/', 'AOD9604', 5, true, true),
  ((select id from public.suppliers where code = 'NUSCIENCE'), (select id from public.peptides where code = 'AOD9604'), '3752', 'https://nusciencepeptides.com/product/aod9604/', 'AOD9604 - 8mg', 8, true, true),
  ((select id from public.suppliers where code = 'LIBERTY'), (select id from public.peptides where code = 'AOD9604'), '2055', 'https://libertypeptides.com/product/aod-9604/', 'AOD-9604 (5mg)', 5, true, true),
  ((select id from public.suppliers where code = 'GENETIC'), (select id from public.peptides where code = 'AOD9604'), '2305', 'https://geneticpeptide.com/product/aod9604-vial-5mg/', 'AOD9604 Vial 5MG', 5, true, true),
  ((select id from public.suppliers where code = 'LIBERTY'), (select id from public.peptides where code = 'TESO'), '11331', 'https://libertypeptides.com/product/tesofensine-500mcg/', 'Tesofensine (500mcg x 30 capsules)', 0.5, true, true),
  ((select id from public.suppliers where code = 'GENETIC'), (select id from public.peptides where code = 'TESO'), '2454', 'https://geneticpeptide.com/product/tesofensine-capsules/', 'Tesofensine Capsules (30 Caps)', 0.5, true, true),
  ((select id from public.suppliers where code = 'PUREHEALTH'), (select id from public.peptides where code = 'MOTSC'), '4680', 'https://purehealthpeptides.com/product/mots-c/', 'MOTS-c', 10, true, true),
  ((select id from public.suppliers where code = 'NUSCIENCE'), (select id from public.peptides where code = 'MOTSC'), '5907', 'https://nusciencepeptides.com/product/mots-c/', 'MOTS-c 20mg | 40mg Peptide', 20, true, true),
  ((select id from public.suppliers where code = 'VERIFIED'), (select id from public.peptides where code = 'MOTSC'), '9433', 'https://verifiedpeptides.com/product/motsc/', 'MOTS-C Peptide (20MG)', 20, true, true),
  ((select id from public.suppliers where code = 'LIBERTY'), (select id from public.peptides where code = 'MOTSC'), '171', 'https://libertypeptides.com/product/mots-c/', 'MOTS-c', 10, true, true),
  ((select id from public.suppliers where code = 'GENETIC'), (select id from public.peptides where code = 'MOTSC'), '2415', 'https://geneticpeptide.com/product/mots-c-vial-10mg/', 'MOTS-c Vial', 10, true, true),
  ((select id from public.suppliers where code = 'PULSE'), (select id from public.peptides where code = 'MOTSC'), '2126', 'https://pulsepeptides.com/product/mots-c/', 'MOTS-c', 10, true, true),
  ((select id from public.suppliers where code = 'PUREHEALTH'), (select id from public.peptides where code = 'SELANK'), '4682', 'https://purehealthpeptides.com/product/selank/', 'Selank', 5, true, true),
  ((select id from public.suppliers where code = 'NUSCIENCE'), (select id from public.peptides where code = 'SELANK'), '18544', 'https://nusciencepeptides.com/product/selank-10mg/', 'Selank NA 10mg', 10, true, true),
  ((select id from public.suppliers where code = 'VERIFIED'), (select id from public.peptides where code = 'SELANK'), '6307', 'https://verifiedpeptides.com/product/n-acetyl-selank/', 'N-Acetyl Selank Peptide', 20, true, true),
  ((select id from public.suppliers where code = 'LIBERTY'), (select id from public.peptides where code = 'SELANK'), '2106', 'https://libertypeptides.com/product/selank-10mg/', 'Selank (10mg)', 10, true, true),
  ((select id from public.suppliers where code = 'GENETIC'), (select id from public.peptides where code = 'SELANK'), '2429', 'https://geneticpeptide.com/product/selank-vial/', 'Selank Vial', 10, true, true),
  ((select id from public.suppliers where code = 'PULSE'), (select id from public.peptides where code = 'SELANK'), '3308', 'https://pulsepeptides.com/product/selank/', 'Selank', 10, true, true),
  ((select id from public.suppliers where code = 'NUSCIENCE'), (select id from public.peptides where code = 'SEMAX'), '18542', 'https://nusciencepeptides.com/product/semax-10mg/', 'Semax NA 10mg', 10, true, true),
  ((select id from public.suppliers where code = 'LIBERTY'), (select id from public.peptides where code = 'SEMAX'), '3373', 'https://libertypeptides.com/product/semx/', 'Semax (30mg)', 30, true, true),
  ((select id from public.suppliers where code = 'GENETIC'), (select id from public.peptides where code = 'SEMAX'), '2436', 'https://geneticpeptide.com/product/semax-vial-30mg/', 'Semax Vial 30MG', 30, true, true),
  ((select id from public.suppliers where code = 'PULSE'), (select id from public.peptides where code = 'SEMAX'), '3222', 'https://pulsepeptides.com/product/semax/', 'Semax', 10, true, true),
  ((select id from public.suppliers where code = 'PUREHEALTH'), (select id from public.peptides where code = 'AMINO1MQ'), '30567', 'https://purehealthpeptides.com/product/5-amino-1mq-2/', '5-Amino-1MQ', 50, true, true),
  ((select id from public.suppliers where code = 'NUSCIENCE'), (select id from public.peptides where code = 'AMINO1MQ'), '35233', 'https://nusciencepeptides.com/product/5-amino-1mq/', '5-Amino-1MQ - 10mg', 4, true, true),
  ((select id from public.suppliers where code = 'VERIFIED'), (select id from public.peptides where code = 'AMINO1MQ'), '79080', 'https://verifiedpeptides.com/product/5-amino-1mq/', '5-Amino 1MQ Peptide (50MG)', 50, true, true),
  ((select id from public.suppliers where code = 'LIBERTY'), (select id from public.peptides where code = 'AMINO1MQ'), '11332', 'https://libertypeptides.com/product/5-amino-1mq-50mg/', '5-Amino-1MQ (50mg x 60 capsules)', 50, true, true),
  ((select id from public.suppliers where code = 'GENETIC'), (select id from public.peptides where code = 'AMINO1MQ'), '110267', 'https://geneticpeptide.com/product/5-amino1mq-10mg-vial/', '5-Amino-1MQ Vial', 10, true, true);

