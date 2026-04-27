-- 0018_leaderboard_view.sql
-- Public read-only leaderboard.
--
-- Privacy: the view runs WITH (security_invoker = false), so its
-- queries against the underlying tables (public.users,
-- public.point_balances, public.positions, public.peptide_twaps)
-- execute with the VIEW OWNER's privileges (postgres / supabase_admin
-- — both have BYPASSRLS in Supabase). Callers reading from this view
-- (anon, authenticated) thus see all rows even though the underlying
-- tables have SELF-only RLS. We project ONLY display_name + the
-- computed financial columns — no email, no wallet, no admin flag.
--
-- security_invoker=false is the legacy default, but PG 15 added the
-- explicit option and we set it to be unambiguous.
--
-- Math:
--   - realized_pnl    = SUM(realized_pnl_points) across status='closed'
--                        positions. Already clamped per-row by
--                        close_position() (RPC's bounded-loss clamp).
--   - unrealized_pnl  = SUM(per-row clamped unrealized PnL) across
--                        status='open' positions, joined to the latest
--                        non-null peptide_twap for each peptide. Per-row
--                        formula:
--                          long:  size * (twap - entry_twap) / entry_twap
--                          short: size * (entry_twap - twap) / entry_twap
--                          clamped at -size  (so a position can lose at
--                                             most its entry stake).
--                        If a peptide has no TWAP at all, that position
--                        contributes 0.
--   - total_equity    = max(0, balance + unrealized_pnl). Defensive
--                        clamp — the per-row clamps above already
--                        guarantee this, but a stray data corruption
--                        couldn't push the leaderboard negative.
--
-- Rank: RANK() OVER (ORDER BY total_equity DESC, total_trades DESC).
-- Ties on equity are broken by who's traded more (more skin in the
-- game), then by user_id implicitly.

drop view if exists public.leaderboard;

create view public.leaderboard
with (security_invoker = false) as
with latest_twaps as (
  -- DISTINCT ON: latest non-null TWAP per peptide.
  select distinct on (peptide_id)
    peptide_id,
    twap_usd_per_mg,
    computed_at
  from public.peptide_twaps
  where twap_usd_per_mg is not null
  order by peptide_id, computed_at desc
),
position_rollups as (
  select
    p.user_id,
    sum(
      case when p.status = 'closed'
        then coalesce(p.realized_pnl_points, 0)::numeric
        else 0::numeric end
    ) as realized_pnl,
    sum(
      case when p.status = 'open' and lt.twap_usd_per_mg is not null
        then greatest(
          -p.entry_size_points,
          case
            when p.direction = 'long'
              then p.entry_size_points
                   * (lt.twap_usd_per_mg - p.entry_twap_usd_per_mg)
                   / p.entry_twap_usd_per_mg
            when p.direction = 'short'
              then p.entry_size_points
                   * (p.entry_twap_usd_per_mg - lt.twap_usd_per_mg)
                   / p.entry_twap_usd_per_mg
          end
        )
        else 0::numeric end
    ) as unrealized_pnl,
    count(*) filter (where p.status = 'open') as open_positions_count,
    count(*)                                   as total_trades,
    max(p.opened_at)                            as latest_opened_at
  from public.positions p
  left join latest_twaps lt on lt.peptide_id = p.peptide_id
  group by p.user_id
),
user_equity as (
  select
    u.id           as user_id,
    u.display_name,
    coalesce(pb.balance, 0)::numeric                    as total_balance,
    coalesce(pr.realized_pnl, 0)::numeric               as realized_pnl,
    coalesce(pr.unrealized_pnl, 0)::numeric             as unrealized_pnl,
    greatest(
      numeric '0',
      coalesce(pb.balance, 0) + coalesce(pr.unrealized_pnl, 0)
    )                                                    as total_equity,
    coalesce(pr.open_positions_count, 0)::int           as open_positions_count,
    coalesce(pr.total_trades, 0)::int                   as total_trades,
    greatest(coalesce(pr.latest_opened_at, u.created_at), u.created_at)
                                                          as last_active_at
  from public.users u
  left join public.point_balances pb on pb.user_id = u.id
  left join position_rollups       pr on pr.user_id = u.id
)
select
  user_id,
  display_name,
  total_balance,
  realized_pnl,
  unrealized_pnl,
  total_equity,
  open_positions_count,
  total_trades,
  last_active_at,
  rank() over (order by total_equity desc, total_trades desc) as rank
from user_equity;

-- Public read access. The view's security_invoker=false means anon's
-- read happens with the view owner's privileges, which bypass RLS on
-- the underlying tables — so anon sees the leaderboard for all users
-- without exposing those tables directly.
grant select on public.leaderboard to anon, authenticated;
