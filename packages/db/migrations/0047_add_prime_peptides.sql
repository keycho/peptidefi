-- 0047_add_prime_peptides.sql
-- Vendor panel expansion (batch 1): add Prime Peptides as the
-- 13th active scraper supplier. WooCommerce-backed; reachable
-- from datacenter IPs with no Cloudflare challenge and no
-- account-required gate.
--
-- VENDOR EVALUATION (2026-05-18)
-- =============================
-- Site:       https://primepeptides.co
-- Platform:   WooCommerce REST (publicly accessible /wp-json/wc/store/v1/products)
-- Probe:      curl https://primepeptides.co/ -> 200 (no Cloudflare interstitial)
-- robots.txt: standard WC (blocks /wp-admin and add-to-cart params only);
--             no anti-scraping directives; no GPTBot disallow.
-- Account:    not required to view prices (homepage + product pages
--             load directly without any registration form).
-- Catalog:    100 products page 1, 21 page 2 (121 total observed);
--             strict single-molecule single-vial filter matches 14
--             of the 46 tracked peptide codes.
--
-- The other two Strategy-A targets from the same batch (Mile High
-- Compounds and Felix Chem) were deferred during recon: both gate
-- the human-facing site behind account registration, matching the
-- ruo.bio criterion the operator established in
-- docs/follow-ups/vendor-expansion.md. They are tracked there for
-- a future session after operator ToS review.
--
-- CANONICAL PATTERN
-- =================
-- Follows the migration 0036 / 0038 / 0046 pattern:
--   - New supplier row at status='active', enabled_in_twap=false
--     (7-day quality-review gate; flip to enabled_in_twap=true via
--     a one-line UPDATE after the worker has observed at least 7
--     days of finalized TWAPs).
--   - Per-peptide supplier_products rows keyed by the WC product
--     id (numeric). The scraper module looks up by id.
--   - mass_per_unit_mg is a best-effort initial value of 10mg; the
--     existing scraper updates the row from real variant attributes
--     on first scrape.
--   - ON CONFLICT DO NOTHING on both inserts. Re-run is a no-op.

-- == up ============================================================

-- 1. Supplier row.
insert into public.suppliers
  (code, display_name, homepage_url, scraper_module, status, enabled_in_twap, notes)
values
  ('PRIME', 'Prime Peptides', 'https://primepeptides.co/', 'woocommerce', 'active', false,
   'Onboarded migration 0047. 4.5 community rating, 50K+ orders. Reachable from datacenter IPs without Cloudflare. No account-required gate (per recon 2026-05-18). enabled_in_twap=false pending 7-day quality review.')
on conflict (code) do nothing;

-- 2. supplier_products seeds.
insert into public.supplier_products
  (supplier_id, peptide_id, supplier_sku, product_url, product_name, mass_per_unit_mg, is_reference_sku, active)
values
  ((select id from public.suppliers where code = 'PRIME'),
   (select id from public.peptides where code = 'AOD9604'),
   '258', 'https://primepeptides.co/products/aod-9604/',
   'AOD 9604', 10, true, true),
  ((select id from public.suppliers where code = 'PRIME'),
   (select id from public.peptides where code = 'BPC157'),
   '260', 'https://primepeptides.co/products/bpc-157/',
   'BPC-157', 10, true, true),
  ((select id from public.suppliers where code = 'PRIME'),
   (select id from public.peptides where code = 'GHKCU'),
   '254', 'https://primepeptides.co/products/ghk-cu/',
   'GHK-Cu', 10, true, true),
  ((select id from public.suppliers where code = 'PRIME'),
   (select id from public.peptides where code = 'GLP1'),
   '270', 'https://primepeptides.co/products/semaglutide/',
   'Semaglutide', 10, true, true),
  ((select id from public.suppliers where code = 'PRIME'),
   (select id from public.peptides where code = 'GLUTATHIONE'),
   '63837', 'https://primepeptides.co/products/glutathione/',
   'Glutathione', 10, true, true),
  ((select id from public.suppliers where code = 'PRIME'),
   (select id from public.peptides where code = 'IPAMO'),
   '251', 'https://primepeptides.co/products/ipamorelin/',
   'Ipamorelin', 10, true, true),
  ((select id from public.suppliers where code = 'PRIME'),
   (select id from public.peptides where code = 'MOTSC'),
   '246', 'https://primepeptides.co/products/mots-c/',
   'MOTS-c', 10, true, true),
  ((select id from public.suppliers where code = 'PRIME'),
   (select id from public.peptides where code = 'MT2'),
   '27243', 'https://primepeptides.co/products/melanotan-2/',
   'Melanotan II', 10, true, true),
  ((select id from public.suppliers where code = 'PRIME'),
   (select id from public.peptides where code = 'NAD'),
   '256', 'https://primepeptides.co/products/nad/',
   'NAD+', 10, true, true),
  ((select id from public.suppliers where code = 'PRIME'),
   (select id from public.peptides where code = 'RETATRUTIDE'),
   '268', 'https://primepeptides.co/products/retatrutide/',
   'Retatrutide', 10, true, true),
  ((select id from public.suppliers where code = 'PRIME'),
   (select id from public.peptides where code = 'SEMAX'),
   '74423', 'https://primepeptides.co/products/semax/',
   'Semax', 10, true, true),
  ((select id from public.suppliers where code = 'PRIME'),
   (select id from public.peptides where code = 'SERMORELIN'),
   '63573', 'https://primepeptides.co/products/sermorelin/',
   'Sermorelin', 10, true, true),
  ((select id from public.suppliers where code = 'PRIME'),
   (select id from public.peptides where code = 'TB500'),
   '261', 'https://primepeptides.co/products/tb-500/',
   'TB-500 (TB4)', 10, true, true),
  ((select id from public.suppliers where code = 'PRIME'),
   (select id from public.peptides where code = 'TESAMORELIN'),
   '20084', 'https://primepeptides.co/products/tesamorelin/',
   'Tesamorelin', 10, true, true)
on conflict (supplier_id, supplier_sku) do nothing;

-- == verification (run manually after apply) =======================
-- -- Should return 1 row, active + enabled_in_twap=false:
-- SELECT code, display_name, scraper_module, status, enabled_in_twap
--   FROM public.suppliers WHERE code = 'PRIME';
--
-- -- Should return 14 rows:
-- SELECT p.code, sp.supplier_sku, sp.product_name, sp.mass_per_unit_mg
--   FROM public.supplier_products sp
--   JOIN public.peptides p ON p.id = sp.peptide_id
--   JOIN public.suppliers s ON s.id = sp.supplier_id
--  WHERE s.code = 'PRIME' AND sp.active
--  ORDER BY p.code;

-- == down (reversal block, run only on rollback) ===================
-- BEGIN;
-- DELETE FROM public.supplier_products
--  WHERE supplier_id = (SELECT id FROM public.suppliers WHERE code = 'PRIME');
-- DELETE FROM public.suppliers WHERE code = 'PRIME';
-- COMMIT;
