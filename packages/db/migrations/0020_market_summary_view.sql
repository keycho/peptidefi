-- 0020_market_summary_view.sql
-- Public read-only market summary used by the markets page.
--
-- Why a view: Lovable's markets page wants per-peptide current TWAP +
-- 24h change. Doing this client-side requires two queries per peptide
-- (now + 24h-ago), each with brittle "latest before cutoff" semantics.
-- The strict `computed_at <= now() - 24h` approach also breaks during
-- the first ~24h of a system's life (and again whenever a new peptide
-- is added) because the boundary sits in a gap before the first row.
--
-- This view encapsulates the lookup with a tolerance window so the
-- frontend gets a stable shape:
--
--   current_twap_*       latest non-null TWAP per peptide
--   baseline_twap_*      latest non-null TWAP in [now-26h, now-22h]
--                        — i.e. ±2h tolerance around the 24h target.
--                        Honest NULL when the peptide has < ~22h of
--                        history; the markets UI should render "—"
--                        for those rather than fake a change.
--   baseline_age_hours   age of the baseline at query time (so the UI
--                        can label the chip "24h" vs "23h" vs "26h"
--                        if it wants — at the edges of the tolerance
--                        window the comparison isn't exactly 24h).
--   change_24h_pct       (current - baseline) / baseline * 100, or
--                        NULL when baseline is NULL.
--
-- Privacy / RLS: same pattern as 0018_leaderboard_view — security_invoker
-- = false (legacy default, set explicitly), runs with the view owner's
-- privileges, then granted SELECT to anon + authenticated. The underlying
-- tables (peptides, peptide_twaps) are already public-readable per 0010
-- so this is mostly a convenience wrapper, not a privacy boundary.

drop view if exists public.market_summary;

create view public.market_summary
with (security_invoker = false) as
with current_twap as (
  -- Latest non-null TWAP per peptide.
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
  -- Closest non-null TWAP in [now-26h, now-22h]. Prefer the newest
  -- (i.e. closest-to-but-not-after the 22h boundary) so the comparison
  -- leans toward "exactly 24h ago" when both edges of the window have
  -- data.
  select distinct on (peptide_id)
    peptide_id,
    twap_usd_per_mg,
    computed_at
  from public.peptide_twaps
  where twap_usd_per_mg is not null
    and computed_at <= now() - interval '22 hours'
    and computed_at >= now() - interval '26 hours'
  order by peptide_id, computed_at desc
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
       else null end             as change_24h_pct
from public.peptides p
left join current_twap  c on c.peptide_id = p.id
left join baseline_twap b on b.peptide_id = p.id;

grant select on public.market_summary to anon, authenticated;
