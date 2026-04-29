-- 0027_vendor_arbitrage.sql
-- Public view surfacing the cheapest-vs-most-expensive vendor for every
-- active peptide that has 2+ in-stock observations. Powers the
-- "biggest arbitrage opportunities right now" surface and the per-row
-- cheapest/priciest BUY-link comparison.
--
-- One row per qualifying peptide; ordered by spread_pct desc so the
-- biggest opportunities sit on top when the API queries with the
-- default ordering.
--
-- Inclusion rules
-- ---------------
--   * suppliers.status = 'active'    (paused/blocked vendors excluded)
--   * peptides.is_active = true       (registry-only peptides excluded)
--   * supplier_observations:
--       scrape_success = true
--       availability_tier = 'in_stock' (no comparison to out-of-stock
--                                       or 'unknown' rows — those don't
--                                       represent a real buying option)
--       price_usd_per_mg is not null
--   * latest in-stock obs per (supplier, peptide) is the comparison
--     point — older obs are stale even from the same vendor
--   * peptides with fewer than 2 such obs are excluded (no arbitrage
--     opportunity if only one source has it in stock)
--
-- Tie-breaking
-- ------------
-- When two suppliers list the same lowest (or highest) price, we pick
-- the one with the smaller supplier_id deterministically so the view
-- is stable across queries.
--
-- supplier_url
-- ------------
-- Joined from supplier_products.product_url (the canonical /product/
-- /<slug>/ link, not the supplier's homepage). 0023 already opened
-- supplier_products SELECT to anon, so this view reading it bypasses
-- any RLS issue, but security_invoker=false would handle it anyway.
--
-- Privacy
-- -------
-- Same pattern as 0018/0020/0024: security_invoker=false, granted to
-- anon + authenticated. All exposed columns are derived from public
-- vendor pages.

drop view if exists public.vendor_arbitrage;

create view public.vendor_arbitrage
with (security_invoker = false) as
with
latest_obs as (
  -- Most-recent in-stock priced observation per (supplier, peptide).
  select distinct on (o.supplier_id, o.peptide_id)
    o.supplier_id, o.peptide_id, o.price_usd_per_mg, o.observed_at
  from public.supplier_observations o
  where o.scrape_success = true
    and o.availability_tier = 'in_stock'
    and o.price_usd_per_mg is not null
  order by o.supplier_id, o.peptide_id, o.observed_at desc
),
filtered as (
  -- Restrict to active suppliers + active peptides.
  select lo.peptide_id, lo.supplier_id, lo.price_usd_per_mg, lo.observed_at
  from latest_obs lo
  join public.suppliers s on s.id = lo.supplier_id and s.status = 'active'
  join public.peptides  p on p.id = lo.peptide_id  and p.is_active = true
),
agg as (
  -- Per-peptide aggregate; keep only peptides with ≥2 in-stock obs.
  select peptide_id,
         count(*)         as n_suppliers,
         min(price_usd_per_mg) as min_price,
         max(price_usd_per_mg) as max_price,
         max(observed_at)  as last_updated_at
  from filtered
  group by peptide_id
  having count(*) >= 2
),
cheapest as (
  -- Pick a single cheapest supplier per peptide; ties broken by id.
  select distinct on (peptide_id)
    peptide_id, supplier_id, price_usd_per_mg
  from filtered
  order by peptide_id, price_usd_per_mg asc, supplier_id asc
),
priciest as (
  -- Pick a single most-expensive supplier per peptide; ties broken by id.
  select distinct on (peptide_id)
    peptide_id, supplier_id, price_usd_per_mg
  from filtered
  order by peptide_id, price_usd_per_mg desc, supplier_id asc
)
select
  p.id                                  as peptide_id,
  p.code                                as peptide_code,
  p.display_name                        as peptide_display_name,
  p.category                            as peptide_category,

  sc.code                               as cheapest_supplier_code,
  sc.display_name                       as cheapest_supplier_display_name,
  c.price_usd_per_mg                    as cheapest_price_per_mg,
  spc.product_url                       as cheapest_supplier_url,

  sm.code                               as most_expensive_supplier_code,
  sm.display_name                       as most_expensive_supplier_display_name,
  pr.price_usd_per_mg                   as most_expensive_price_per_mg,
  spm.product_url                       as most_expensive_supplier_url,

  (pr.price_usd_per_mg - c.price_usd_per_mg)                              as spread_dollars,
  case when c.price_usd_per_mg > 0
       then ((pr.price_usd_per_mg - c.price_usd_per_mg) / c.price_usd_per_mg) * 100
       else null end                                                      as spread_pct,
  agg.n_suppliers                                                          as n_suppliers_in_comparison,
  agg.last_updated_at
from agg
join public.peptides  p   on p.id  = agg.peptide_id
join cheapest         c   on c.peptide_id  = agg.peptide_id
join priciest         pr  on pr.peptide_id = agg.peptide_id
join public.suppliers sc  on sc.id = c.supplier_id
join public.suppliers sm  on sm.id = pr.supplier_id
left join public.supplier_products spc
  on spc.supplier_id = c.supplier_id
 and spc.peptide_id  = c.peptide_id
 and spc.active = true
left join public.supplier_products spm
  on spm.supplier_id = pr.supplier_id
 and spm.peptide_id  = pr.peptide_id
 and spm.active = true
order by spread_pct desc nulls last;

grant select on public.vendor_arbitrage to anon, authenticated;
