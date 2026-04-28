-- 0021_market_summary_sparklines.sql
-- Bake a downsampled 7-day sparkline into market_summary so the markets
-- page can render charts in a single round trip.
--
-- Why: Lovable's markets page fetches sparkline points per peptide. The
-- raw peptide_twaps table holds ~1,100 non-null rows per peptide per
-- 24h (one TWAP every ~1m × 22 active peptides ≈ 24k rows over 7 days).
-- Reading that directly hits PostgREST's default row limit (1000) and
-- streams way more data than a sparkline needs.
--
-- Approach: per peptide, bucket the last 7 days into 1-hour windows,
-- take the latest non-null TWAP in each bucket, and emit as a JSON array
-- of {t, v} tuples. That gives at most 168 points per peptide × 22
-- peptides ≈ 3,700 tuples ≈ ~270 kB total — one PostgREST GET, no
-- truncation, no per-peptide round trips.
--
-- New peptides with shorter history get whatever buckets exist (a
-- peptide that's been live for 25h gets ~25 points). The sparkline
-- component should render whatever array length is given.
--
-- Bucket alignment uses a fixed origin (2026-01-01 UTC) so buckets
-- don't shift by clock skew between calls. date_bin requires PG14+;
-- Supabase is on PG15+.

drop view if exists public.market_summary;

create view public.market_summary
with (security_invoker = false) as
with current_twap as (
  select distinct on (peptide_id)
    peptide_id,
    twap_usd_per_mg,
    computed_at,
    suppliers_used,
    suppliers_dropped
  from public.peptide_twaps
  where twap_usd_per_mg is not null
  order by peptide_id, computed_at desc
),
baseline_twap as (
  select distinct on (peptide_id)
    peptide_id,
    twap_usd_per_mg,
    computed_at
  from public.peptide_twaps
  where twap_usd_per_mg is not null
    and computed_at <= now() - interval '22 hours'
    and computed_at >= now() - interval '26 hours'
  order by peptide_id, computed_at desc
),
sparkline_buckets as (
  -- Latest non-null TWAP per (peptide, 1h-bucket) over the last 7 days.
  select distinct on (peptide_id, bucket_start)
    peptide_id,
    bucket_start,
    twap_usd_per_mg
  from (
    select
      peptide_id,
      twap_usd_per_mg,
      computed_at,
      date_bin('1 hour', computed_at, timestamp '2026-01-01 00:00:00') as bucket_start
    from public.peptide_twaps
    where computed_at >= now() - interval '7 days'
      and twap_usd_per_mg is not null
  ) s
  order by peptide_id, bucket_start, computed_at desc
),
sparkline as (
  select
    peptide_id,
    json_agg(
      json_build_object('t', bucket_start, 'v', twap_usd_per_mg)
      order by bucket_start
    ) as recent_twaps
  from sparkline_buckets
  group by peptide_id
)
select
  p.id            as peptide_id,
  p.code,
  p.display_name,
  p.full_name,
  p.description,
  p.category,
  p.is_active,
  c.twap_usd_per_mg              as current_twap_usd_per_mg,
  c.computed_at                  as current_twap_at,
  c.suppliers_used               as current_suppliers_used,
  c.suppliers_dropped            as current_suppliers_dropped,
  b.twap_usd_per_mg              as baseline_twap_usd_per_mg,
  b.computed_at                  as baseline_twap_at,
  case when b.computed_at is not null
       then round(extract(epoch from (now() - b.computed_at))::numeric / 3600, 2)
       else null end             as baseline_age_hours,
  case when b.twap_usd_per_mg is not null
        and c.twap_usd_per_mg is not null
        and b.twap_usd_per_mg <> 0
       then ((c.twap_usd_per_mg - b.twap_usd_per_mg) / b.twap_usd_per_mg) * 100
       else null end             as change_24h_pct,
  coalesce(s.recent_twaps, '[]'::json) as recent_twaps
from public.peptides p
left join current_twap     c on c.peptide_id = p.id
left join baseline_twap    b on b.peptide_id = p.id
left join sparkline        s on s.peptide_id = p.id;

grant select on public.market_summary to anon, authenticated;
