-- 0024_vendor_leaderboard.sql
-- Public vendor leaderboard ranking active suppliers by a composite
-- score that reflects "best vendor to buy from" across price
-- competitiveness, stock reliability, freshness, and catalog coverage.
--
-- One row per active supplier (suppliers.status = 'active'), ranked by
-- composite_score desc. The view is built bottom-up via small CTEs so
-- the contributing metrics can be inspected independently.
--
-- Metrics
-- -------
--   coverage_count       distinct active peptides this supplier lists
--                        (supplier_products.active = true).
--   in_stock_rate        share of last-24h observations whose
--                        availability_tier = 'in_stock'. Per spec this
--                        is a strict count (numerator) / count (*) ratio,
--                        so suppliers whose scraper never reports stock
--                        state (e.g. BACHEM/SIGMA, all 'unknown') get 0
--                        — that's accurate from a buyer-perception POV.
--   update_frequency     observations in the last 24h.
--   cheapest_pct         per peptide this supplier lists, what fraction
--                        of the time are they the cheapest? Uses the
--                        latest in-stock observation per (supplier,
--                        peptide); ties broken by supplier_id.
--   avg_spread_vs_twap   avg of (latest_price - latest_twap) / latest_twap
--                        across the supplier's listings. Negative values
--                        mean consistently cheaper than median; positive
--                        means more expensive. NULL when no peptide they
--                        list has a current TWAP (e.g. brand-new vendors).
--   freshness_seconds    seconds since the supplier's most recent
--                        successful observation. Lower is better.
--   composite_score      weighted blend in [0,1]:
--                          0.25 × coverage_count / max(coverage_count)
--                          0.25 × in_stock_rate
--                          0.20 × cheapest_pct
--                          0.15 × (1 - normalized avg_spread_vs_twap)
--                          0.15 × (1 - normalized freshness_seconds)
--                        Spread/freshness use min-max normalization
--                        across active vendors; the (1 - x) means
--                        cheapest/freshest = 1.0, most expensive/stalest
--                        = 0.0. Degenerate cases (single vendor, identical
--                        values, NULL spread) fall back to 0.5 (neutral)
--                        so the term doesn't push or pull the score.
--   rank                 RANK() OVER (composite desc, coverage desc, id asc).
--
-- Privacy
-- -------
-- Same pattern as 0018_leaderboard_view + 0020_market_summary_view:
-- security_invoker = false (legacy default, set explicitly), runs with
-- the view owner's privileges, granted SELECT to anon + authenticated.
-- All underlying tables it reads are already public-readable per 0010
-- and 0023; this view is just a convenience aggregation.
--
-- logo_url
-- --------
-- public.suppliers has no logo_url column today; emit null::text so
-- the API contract is stable when one is added later (just point a
-- column reference at it without changing the view shape).

drop view if exists public.vendor_leaderboard;

create view public.vendor_leaderboard
with (security_invoker = false) as
with
active_suppliers as (
  select id, code, display_name, homepage_url
  from public.suppliers
  where status = 'active'
),
coverage as (
  select sp.supplier_id,
         count(distinct sp.peptide_id) as coverage_count
  from public.supplier_products sp
  where sp.active = true
  group by sp.supplier_id
),
recent_obs as (
  select supplier_id,
         count(*)                                                            as update_frequency,
         (count(*) filter (where availability_tier = 'in_stock'))::numeric
           / nullif(count(*), 0)                                             as in_stock_rate
  from public.supplier_observations
  where observed_at > now() - interval '24 hours'
  group by supplier_id
),
freshness as (
  select supplier_id,
         floor(extract(epoch from (now() - max(observed_at))))::bigint as freshness_seconds
  from public.supplier_observations
  where scrape_success = true
  group by supplier_id
),
latest_obs_per_supplier_peptide as (
  -- Latest in-stock priced observation per (supplier, peptide) pair.
  -- Used both for cheapest_pct and avg_spread_vs_twap — picking from
  -- in-stock observations only avoids penalizing a supplier whose
  -- last "data point" was an out-of-stock placeholder.
  select distinct on (supplier_id, peptide_id)
    supplier_id, peptide_id, price_usd_per_mg
  from public.supplier_observations
  where scrape_success = true
    and price_usd_per_mg is not null
    and availability_tier = 'in_stock'
  order by supplier_id, peptide_id, observed_at desc
),
cheapest_per_peptide as (
  -- Per peptide, which supplier currently has the lowest in-stock price.
  -- Tied prices break by supplier_id (deterministic, view is stable).
  select distinct on (peptide_id)
    peptide_id, supplier_id as cheapest_supplier_id
  from latest_obs_per_supplier_peptide
  order by peptide_id, price_usd_per_mg asc, supplier_id asc
),
cheapest_counts as (
  select s.id as supplier_id,
         coalesce(c.cheapest_count, 0)::numeric / nullif(cov.coverage_count, 0) as cheapest_pct
  from active_suppliers s
  left join coverage cov on cov.supplier_id = s.id
  left join (
    select cheapest_supplier_id, count(*) as cheapest_count
    from cheapest_per_peptide
    group by cheapest_supplier_id
  ) c on c.cheapest_supplier_id = s.id
),
latest_twaps as (
  select distinct on (peptide_id)
    peptide_id, twap_usd_per_mg
  from public.peptide_twaps
  where twap_usd_per_mg is not null
  order by peptide_id, computed_at desc
),
spreads as (
  select lo.supplier_id,
         avg((lo.price_usd_per_mg - lt.twap_usd_per_mg) / nullif(lt.twap_usd_per_mg, 0)) as avg_spread_vs_twap
  from latest_obs_per_supplier_peptide lo
  join latest_twaps lt on lt.peptide_id = lo.peptide_id
  group by lo.supplier_id
),
raw as (
  select
    s.id as supplier_id, s.code, s.display_name, s.homepage_url,
    coalesce(cov.coverage_count, 0)               as coverage_count,
    coalesce(ro.in_stock_rate, 0::numeric)        as in_stock_rate,
    coalesce(ro.update_frequency, 0)              as update_frequency,
    coalesce(cc.cheapest_pct, 0::numeric)         as cheapest_pct,
    sp.avg_spread_vs_twap                          as avg_spread_vs_twap,
    -- Suppliers with no successful observation ever (rare) get a large
    -- sentinel so they sort to the bottom of the freshness component.
    coalesce(fr.freshness_seconds, 999999::bigint) as freshness_seconds
  from active_suppliers s
  left join coverage         cov on cov.supplier_id = s.id
  left join recent_obs       ro  on ro.supplier_id  = s.id
  left join cheapest_counts  cc  on cc.supplier_id  = s.id
  left join spreads          sp  on sp.supplier_id  = s.id
  left join freshness        fr  on fr.supplier_id  = s.id
),
bounds as (
  select
    nullif(max(coverage_count), 0)::numeric                             as max_coverage,
    min(avg_spread_vs_twap)                                              as min_spread,
    max(avg_spread_vs_twap)                                              as max_spread,
    min(freshness_seconds)::numeric                                      as min_fresh,
    max(freshness_seconds)::numeric                                      as max_fresh
  from raw
),
scored as (
  select
    r.*,
      0.25 * coalesce(r.coverage_count::numeric / b.max_coverage, 0)
    + 0.25 * r.in_stock_rate
    + 0.20 * r.cheapest_pct
    + 0.15 * (
        case
          when r.avg_spread_vs_twap is null
            or b.max_spread is null or b.min_spread is null
            or (b.max_spread - b.min_spread) = 0 then 0.5::numeric
          else 1 - greatest(0::numeric, least(1::numeric,
                 (r.avg_spread_vs_twap - b.min_spread) / (b.max_spread - b.min_spread)))
        end
      )
    + 0.15 * (
        case
          when (b.max_fresh - b.min_fresh) = 0 then 0.5::numeric
          else 1 - greatest(0::numeric, least(1::numeric,
                 (r.freshness_seconds::numeric - b.min_fresh) / (b.max_fresh - b.min_fresh)))
        end
      ) as composite_score
  from raw r cross join bounds b
)
select
  supplier_id,
  code                                  as supplier_code,
  display_name                           as supplier_display_name,
  null::text                             as logo_url,
  coverage_count,
  round(in_stock_rate, 4)                as in_stock_rate,
  update_frequency,
  round(cheapest_pct, 4)                 as cheapest_pct,
  round(avg_spread_vs_twap, 6)           as avg_spread_vs_twap,
  freshness_seconds,
  round(composite_score, 4)              as composite_score,
  rank() over (order by composite_score desc, coverage_count desc, supplier_id asc) as rank
from scored;

grant select on public.vendor_leaderboard to anon, authenticated;
