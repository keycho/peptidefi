-- 0029_leaderboard_net_pnl.sql
-- Switch the public leaderboard from a "richest user" board (rank by
-- total_equity, includes the 10k starting balance) to a "best trader"
-- board (rank by net P&L = equity - starting_balance). Three changes:
--
--   1. Add net_pnl column = total_equity - 10000. Negative numbers are
--      allowed so a user who's down on the day can still appear, ranked
--      below break-even.
--   2. Re-rank by net_pnl desc (with secondary sort on total_trades desc
--      so a more-active losing trader sits above an inactive one with
--      the same number).
--   3. Filter the board to engaged users only — anyone with at least one
--      position (open or closed) or one prediction bet. This excludes
--      brand-new accounts and admin/test users who have a 10k balance
--      but never used the platform, keeping the board interesting at
--      v0.5 scale.
--
-- Why drop+recreate instead of CREATE OR REPLACE: the column list
-- changes (adding net_pnl + total_bets + total_activity), and PG
-- doesn't allow OR REPLACE that adds columns. No callers (the API
-- queries SELECT *), so dropping is safe.
--
-- Starting balance source of truth: 10000, also hardcoded in
-- public.handle_new_auth_user() (0003 / 0017). If that ever changes,
-- update both places.
--
-- Privacy / RLS: same pattern as 0018 (security_invoker = false,
-- granted to anon + authenticated). The view's own SELECT runs with
-- the view owner's privileges; underlying tables (users, point_balances,
-- positions, peptide_twaps, prediction_bets) keep their RLS unchanged.

drop view if exists public.leaderboard;

create view public.leaderboard
with (security_invoker = false) as
with latest_twaps as (
  -- Latest non-null TWAP per peptide; used to mark-to-market open positions.
  select distinct on (peptide_id)
    peptide_id, twap_usd_per_mg, computed_at
  from public.peptide_twaps
  where twap_usd_per_mg is not null
  order by peptide_id, computed_at desc
),
position_rollups as (
  -- Per-row clamps already applied by close_position(); summing here is
  -- the leaderboard-side aggregation. Same math as 0018:
  --   long  unrealized = size * (twap - entry) / entry
  --   short unrealized = size * (entry - twap) / entry
  --   each clamped at -size so a position can't sink past its stake.
  select
    p.user_id,
    sum(case when p.status = 'closed'
              then coalesce(p.realized_pnl_points, 0)::numeric
              else 0::numeric end) as realized_pnl,
    sum(case when p.status = 'open' and lt.twap_usd_per_mg is not null
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
                end)
              else 0::numeric end) as unrealized_pnl,
    count(*) filter (where p.status = 'open') as open_positions_count,
    count(*)                                   as total_trades,
    max(p.opened_at)                            as latest_opened_at
  from public.positions p
  left join latest_twaps lt on lt.peptide_id = p.peptide_id
  group by p.user_id
),
bet_rollups as (
  -- prediction_bets activity per user. Bet P&L flows through point_ledger
  -- on settlement, so balance already reflects it; we count bets only
  -- to gate the engagement filter (a user with bets but no positions
  -- still appears on the board).
  select user_id,
         count(*)                                        as total_bets,
         count(*) filter (where status = 'open')         as open_bets_count,
         max(created_at)                                  as latest_bet_at
  from public.prediction_bets
  group by user_id
),
user_equity as (
  select
    u.id as user_id,
    u.display_name,
    coalesce(pb.balance, 0)::numeric                as total_balance,
    coalesce(pr.realized_pnl, 0)::numeric           as realized_pnl,
    coalesce(pr.unrealized_pnl, 0)::numeric         as unrealized_pnl,
    greatest(numeric '0',
             coalesce(pb.balance, 0) + coalesce(pr.unrealized_pnl, 0))
                                                     as total_equity,
    coalesce(pr.open_positions_count, 0)::int       as open_positions_count,
    coalesce(pr.total_trades, 0)::int               as total_trades,
    coalesce(br.total_bets, 0)::int                 as total_bets,
    coalesce(br.open_bets_count, 0)::int            as open_bets_count,
    greatest(coalesce(pr.latest_opened_at, u.created_at),
             coalesce(br.latest_bet_at, u.created_at),
             u.created_at)                            as last_active_at
  from public.users u
  left join public.point_balances  pb on pb.user_id = u.id
  left join position_rollups       pr on pr.user_id = u.id
  left join bet_rollups            br on br.user_id = u.id
)
select
  user_id,
  display_name,
  total_balance,
  realized_pnl,
  unrealized_pnl,
  total_equity,
  -- Net P&L: equity relative to the 10k seed grant. Can be negative.
  -- This is the column the API ranks on and the UI colors mint/red.
  (total_equity - 10000::numeric) as net_pnl,
  open_positions_count,
  total_trades,
  total_bets,
  open_bets_count,
  last_active_at,
  rank() over (order by (total_equity - 10000::numeric) desc,
                        total_trades desc,
                        last_active_at desc,
                        user_id asc) as rank
from user_equity
-- Engagement filter: keep only users who have actually used the platform.
-- A brand-new account at exactly 10k balance with 0 trades / 0 bets
-- doesn't belong on a "best trader" board.
where total_trades > 0 or open_positions_count > 0 or total_bets > 0;

grant select on public.leaderboard to anon, authenticated;
