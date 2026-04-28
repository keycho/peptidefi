-- 0022_add_dsip_humanin_follistatin_ss31_thymulin.sql
-- Adds 5 popular peptides currently tracked by competitor aggregators:
--   DSIP, HUMANIN, FOLLISTATIN-344, SS-31 (Elamipretide), THYMULIN.
--
-- 4 are is_active=true (≥2 vendors). THYMULIN has zero vendor coverage at
-- insertion time and is registered as is_active=false so a future vendor
-- listing can light it up without a schema change (same pattern as NAD).
--
-- Hard skips (matcher logic, in addition to 0019's existing list):
--   PUREHEALTH/FOLLISTATIN-315 isoform (we target FST-344 specifically);
--   NUSCIENCE/SS31 product is flagged 'Soon to be Discontinued' on the
--     vendor page — paused to avoid seeding a vanishing SKU.
--
-- Borderline matches: none. Matcher returned a clean 17-row result.

-- ─── insert 5 new peptides ────────────────────────────────────────────────
insert into public.peptides (code, display_name, full_name, description, category, is_active) values
  ('DSIP', 'DSIP', 'Delta Sleep-Inducing Peptide', 'Nonapeptide first isolated from rabbit cerebral venous blood; widely studied in sleep regulation.', 'cognitive', true),
  ('HUMANIN', 'Humanin', 'Humanin', '24-amino-acid mitochondrial-derived peptide studied in cellular stress and longevity contexts.', 'longevity', true),
  ('FOLLISTATIN', 'Follistatin-344', 'Follistatin-344', 'Glycoprotein that binds and neutralises myostatin; FST-344 is the secreted serum isoform.', 'growth', true),
  ('SS31', 'SS-31', 'SS-31 (Elamipretide / MTP-131)', 'Mitochondria-targeted tetrapeptide investigated in mitochondrial dysfunction research.', 'longevity', true),
  ('THYMULIN', 'Thymulin', 'Thymulin (Zn-FTS)', 'Zinc-bound nonapeptide secreted by thymic epithelial cells; immune-modulator research peptide.', 'immune', false);

-- ─── insert 17 supplier_products rows ────────────────────────────
-- supplier_sku stores the WooCommerce numeric product id (stable across
-- product renames). product_url is the canonical /product/<slug>/ link.
-- mass_per_unit_mg starts at the matcher-extracted value; the scraper
-- updates it on every successful scrape.
insert into public.supplier_products
  (supplier_id, peptide_id, supplier_sku, product_url, product_name, mass_per_unit_mg, is_reference_sku, active) values
  ((select id from public.suppliers where code = 'PUREHEALTH'), (select id from public.peptides  where code = 'DSIP'), '429', 'https://purehealthpeptides.com/product/dsip/', 'DSIP', 5, true, true),
  ((select id from public.suppliers where code = 'PUREHEALTH'), (select id from public.peptides  where code = 'HUMANIN'), '13089', 'https://purehealthpeptides.com/product/humanin/', 'Humanin', 5, true, true),
  ((select id from public.suppliers where code = 'PUREHEALTH'), (select id from public.peptides  where code = 'FOLLISTATIN'), '21553', 'https://purehealthpeptides.com/product/follistatin-344/', 'Follistatin 344', 1, true, true),
  ((select id from public.suppliers where code = 'NUSCIENCE'), (select id from public.peptides  where code = 'DSIP'), '32869', 'https://nusciencepeptides.com/product/dsip/', 'DSIP - 5mg', 5, true, true),
  ((select id from public.suppliers where code = 'VERIFIED'), (select id from public.peptides  where code = 'DSIP'), '28557', 'https://verifiedpeptides.com/product/dsip/', 'DSIP Peptide (10MG)', 10, true, true),
  ((select id from public.suppliers where code = 'LIBERTY'), (select id from public.peptides  where code = 'DSIP'), '655', 'https://libertypeptides.com/product/dsip-5mg/', 'DSIP (5mg)', 5, true, true),
  ((select id from public.suppliers where code = 'LIBERTY'), (select id from public.peptides  where code = 'SS31'), '46477', 'https://libertypeptides.com/product/ss-31-30mg/', 'SS-31 (30mg)', 30, true, true),
  ((select id from public.suppliers where code = 'GENETIC'), (select id from public.peptides  where code = 'DSIP'), '2363', 'https://geneticpeptide.com/product/dsip-5mg-vial/', 'DSIP  Vial', 5, true, true),
  ((select id from public.suppliers where code = 'GENETIC'), (select id from public.peptides  where code = 'HUMANIN'), '109285', 'https://geneticpeptide.com/product/humanin-5-mg/', 'Humanin 5 MG', 5, true, true),
  ((select id from public.suppliers where code = 'GENETIC'), (select id from public.peptides  where code = 'FOLLISTATIN'), '109237', 'https://geneticpeptide.com/product/fst-1-mg/', 'Follistatin-344 (FST) - 1 MG', 1, true, true),
  ((select id from public.suppliers where code = 'GENETIC'), (select id from public.peptides  where code = 'SS31'), '105567', 'https://geneticpeptide.com/product/ss-31/', 'SS-31 Vial', 10, true, true),
  ((select id from public.suppliers where code = 'PULSE'), (select id from public.peptides  where code = 'DSIP'), '2199', 'https://pulsepeptides.com/product/dsip/', 'DSIP', 5, true, true),
  ((select id from public.suppliers where code = 'PURERAWZ'), (select id from public.peptides  where code = 'HUMANIN'), '358807554', 'https://purerawz.co/product/humanin/', 'Humanin', 5, true, true),
  ((select id from public.suppliers where code = 'PURERAWZ'), (select id from public.peptides  where code = 'FOLLISTATIN'), '358831059', 'https://purerawz.co/product/follistatin/', 'Follistatin', 1, true, true),
  ((select id from public.suppliers where code = 'SWISSCHEMS'), (select id from public.peptides  where code = 'DSIP'), '606', 'https://swisschems.is/product/dsip-2mg-price-is-per-vial/', 'Delta Sleep-Inducing Peptide (DSIP) 2 mg (1 vial)', 2, true, true),
  ((select id from public.suppliers where code = 'SWISSCHEMS'), (select id from public.peptides  where code = 'FOLLISTATIN'), '569', 'https://swisschems.is/product/follistatin-344-1mg-price-is-per-vial/', 'Follistatin-344 1 mg  (1 vial)', 1, true, true),
  ((select id from public.suppliers where code = 'SWISSCHEMS'), (select id from public.peptides  where code = 'SS31'), '254365', 'https://swisschems.is/product/ss31-elamipretide/', 'SS31 (Elamipretide)', 5, true, true);

