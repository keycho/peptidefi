-- 0009_cayman_urls.sql
-- Replace the three TODO Cayman supplier_products sentinels with real SKUs,
-- product URLs, and product names so the scraper can hit them.
--
-- Idempotent: each UPDATE is keyed by supplier+peptide and is safe to re-run.
-- Untouched columns: is_reference_sku, active, mass_per_unit_mg (the scraper
-- writes the real mass on its first successful scrape via UPDATE elsewhere).
--
-- TB500 note: Cayman lists two thymosin products. SKU 45081 is the 7-aa
-- "TB-500 (acetate)" fragment; SKU 28605 is the full-length 43-aa Thymosin β4
-- that matches Bachem 4043020 and Sigma SRP3324. We use 28605 to keep
-- cross-supplier TWAP comparisons apples-to-apples.

update public.supplier_products
set
  supplier_sku = '15069',
  product_url  = 'https://www.caymanchem.com/product/15069/glp-1-(7-36)-amide-(human,-bovine,-guinea-pig,-mouse,-rat)-(trifluoroacetate-salt)',
  product_name = 'GLP-1 (7-36) amide (human, bovine, guinea pig, mouse, rat) (trifluoroacetate salt)'
where supplier_id = (select id from public.suppliers where code = 'CAYMAN')
  and peptide_id  = (select id from public.peptides  where code = 'GLP1');

update public.supplier_products
set
  supplier_sku = '30989',
  product_url  = 'https://www.caymanchem.com/product/30989/bpc-157-(acetate)',
  product_name = 'BPC 157 (acetate)'
where supplier_id = (select id from public.suppliers where code = 'CAYMAN')
  and peptide_id  = (select id from public.peptides  where code = 'BPC157');

update public.supplier_products
set
  supplier_sku = '28605',
  product_url  = 'https://www.caymanchem.com/product/28605',
  product_name = 'Thymosin β4 (human, mouse, rat, porcine, bovine) (acetate)'
where supplier_id = (select id from public.suppliers where code = 'CAYMAN')
  and peptide_id  = (select id from public.peptides  where code = 'TB500');
