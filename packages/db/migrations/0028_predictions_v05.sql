-- 0028_predictions_v05.sql
-- Pool-based (parimutuel) prediction markets, manual resolution by admin.
-- Auto-flagging via cron of markets ready to resolve. v0.5: no user-created
-- markets, no auto-resolve, no notifications.
--
-- Structure
-- ---------
--   1. Enums
--   2. prediction_markets        (questions; admin-only writes)
--   3. prediction_bets           (user bets; RPC-only writes)
--   4. prediction_resolution_suggestions (cron output; service_role only)
--   5. prediction_market_stats   (public view with aggregates)
--   6. place_bet RPC             (atomic bet placement)
--   7. resolve_market RPC        (atomic settlement; admin-only)
--   8. flag_markets_ready_for_resolution (cron-callable closer + suggester)
--   9. Seed 10 launch markets
--
-- Conventions matching the rest of the project
-- ---------------------------------------------
--   * SECURITY DEFINER RPCs granted only to service_role; the API verifies
--     the JWT and passes the user_id as a parameter (positions pattern).
--   * Idempotency uniqueness is per-user (user_id, idempotency_key) — the
--     spec said "unique(idempotency_key)" but the project convention is
--     per-user (positions, point_ledger), so I'm following that for
--     consistency.
--   * point_ledger.reference_id is bigint and prediction_bets.id is uuid,
--     so they can't be joined directly — ledger entries set
--     reference_kind='prediction_bet' and reuse the bet's idempotency_key
--     in ledger.idempotency_key for the audit chain. Settlement entries
--     suffix the key (':payout' / ':refund') to stay unique.
--
-- Settlement math (parimutuel with seed)
-- --------------------------------------
-- Each side starts at yes_pool=no_pool=100 (seed liquidity). User stakes
-- add to their side. On YES resolution, each YES bettor receives:
--   payout = stake + (stake / yes_pool) * no_pool
-- where the pools include the seed. The seed effectively becomes a small
-- house edge on lopsided markets — defensible for v0.5 thin liquidity.
-- The "no money lost or created" smoke-test verifies winners_gain ≈
-- losers_loss − seed_residual. Documented; not a bug.

-- ─── 0. Drop v0 prediction system ──────────────────────────────────────
-- Migration 0006 created an LMSR-style prediction_markets/positions/
-- trades schema that was never used (verified zero rows across all
-- four v0 tables incl. event_activations from 0007). The v0.5 design
-- here is a different shape (uuid PKs, parimutuel pools, status enum
-- replaces 'state', auto/manual resolution split). Cleaner to drop the
-- v0 tables + their cross-references than to bolt v0.5 columns on.
--
-- event_activations was the v0 bridge from prediction markets to AMM
-- fee-tier acceleration; v0.5 doesn't have that coupling, so dropping
-- it removes the FK that would otherwise block the prediction_markets
-- drop. No app code references event_activations.

drop table if exists public.event_activations    cascade;
drop table if exists public.prediction_trades    cascade;
drop table if exists public.prediction_positions cascade;
drop table if exists public.prediction_markets   cascade;

drop type if exists public.prediction_market_state cascade;
drop type if exists public.prediction_market_type  cascade;
drop type if exists public.resolution_tier         cascade;

-- ─── 1. Enums ───────────────────────────────────────────────────────────
do $$
begin
  if not exists (select 1 from pg_type where typname = 'prediction_market_status') then
    create type prediction_market_status as enum (
      'open',           -- accepting bets
      'closed',         -- bets locked, awaiting resolution
      'resolved_yes',   -- resolved YES, settlements paid
      'resolved_no',    -- resolved NO, settlements paid
      'voided'          -- bets refunded
    );
  end if;
  if not exists (select 1 from pg_type where typname = 'prediction_bet_side') then
    create type prediction_bet_side as enum ('yes', 'no');
  end if;
  if not exists (select 1 from pg_type where typname = 'prediction_bet_status') then
    create type prediction_bet_status as enum ('open', 'won', 'lost', 'refunded');
  end if;
end$$;

-- ─── 2. prediction_markets ─────────────────────────────────────────────
create table if not exists public.prediction_markets (
  id                       uuid primary key default gen_random_uuid(),
  slug                     text not null unique,
  question                 text not null,
  category                 text not null,
  resolution_criteria      text not null,
  resolution_data_source   text,                                -- 'auto' | 'manual'
  resolution_sql           text,                                -- nullable: bool-returning SQL for auto markets
  resolution_date          timestamptz not null,
  closes_at                timestamptz not null,
  yes_pool                 numeric(20,6) not null default 100,
  no_pool                  numeric(20,6) not null default 100,
  status                   prediction_market_status not null default 'open',
  resolved_at              timestamptz,
  resolved_by_user_id      uuid references auth.users(id),
  resolution_notes         text,
  min_bet_points           numeric(20,6) not null default 100,
  max_bet_points_per_user  numeric(20,6) not null default 5000,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

create index if not exists idx_prediction_markets_status          on public.prediction_markets(status);
create index if not exists idx_prediction_markets_resolution_date on public.prediction_markets(resolution_date);

alter table public.prediction_markets enable row level security;
drop policy if exists "prediction_markets_select_public" on public.prediction_markets;
create policy "prediction_markets_select_public"
  on public.prediction_markets for select
  to anon, authenticated using (true);
-- No INSERT/UPDATE policies → only service_role mutates. RPC functions
-- (security definer, granted to service_role) handle pool updates and
-- resolution; admin endpoints in the API gate on users.is_admin.

-- ─── 3. prediction_bets ─────────────────────────────────────────────────
create table if not exists public.prediction_bets (
  id                       uuid primary key default gen_random_uuid(),
  market_id                uuid not null references public.prediction_markets(id) on delete restrict,
  user_id                  uuid not null references auth.users(id) on delete restrict,
  side                     prediction_bet_side not null,
  stake_points             numeric(20,6) not null check (stake_points >= 100),
  yes_pool_at_bet          numeric(20,6) not null,
  no_pool_at_bet           numeric(20,6) not null,
  implied_yes_probability  numeric(5,4) not null,
  status                   prediction_bet_status not null default 'open',
  payout_points            numeric(20,6),
  settled_at               timestamptz,
  idempotency_key          text not null,
  created_at               timestamptz not null default now(),
  -- per-user idempotency (project convention; see header note)
  unique (user_id, idempotency_key)
);

create index if not exists idx_prediction_bets_user   on public.prediction_bets(user_id);
create index if not exists idx_prediction_bets_market on public.prediction_bets(market_id);
create index if not exists idx_prediction_bets_status on public.prediction_bets(status);

alter table public.prediction_bets enable row level security;
drop policy if exists "prediction_bets_select_self" on public.prediction_bets;
create policy "prediction_bets_select_self"
  on public.prediction_bets for select
  to authenticated using (auth.uid() = user_id);
-- No INSERT policy → only service_role inserts via place_bet RPC.
-- Public aggregate visibility is via prediction_market_stats view.

-- ─── 4. prediction_resolution_suggestions ──────────────────────────────
create table if not exists public.prediction_resolution_suggestions (
  id                  uuid primary key default gen_random_uuid(),
  market_id           uuid not null references public.prediction_markets(id),
  suggested_outcome   text not null check (suggested_outcome in ('yes', 'no', 'inconclusive')),
  sql_returned        jsonb,
  reviewed_by_admin   boolean not null default false,
  created_at          timestamptz not null default now()
);
create index if not exists idx_prediction_resolution_suggestions_market on public.prediction_resolution_suggestions(market_id);

alter table public.prediction_resolution_suggestions enable row level security;
-- No policies → service_role only (admin dashboard reads via service_role).

-- ─── 5. prediction_market_stats view ───────────────────────────────────
drop view if exists public.prediction_market_stats;
create view public.prediction_market_stats
with (security_invoker = false) as
select
  pm.id,
  pm.slug,
  pm.question,
  pm.category,
  pm.resolution_criteria,
  pm.resolution_date,
  pm.closes_at,
  pm.yes_pool,
  pm.no_pool,
  (pm.yes_pool + pm.no_pool) as total_pool,
  case when (pm.yes_pool + pm.no_pool) = 0 then 0.5
       else round(pm.yes_pool / (pm.yes_pool + pm.no_pool), 4)
  end as implied_yes_probability,
  case when (pm.yes_pool + pm.no_pool) = 0 then 0.5
       else round(pm.no_pool / (pm.yes_pool + pm.no_pool), 4)
  end as implied_no_probability,
  pm.status,
  pm.resolved_at,
  pm.min_bet_points,
  pm.max_bet_points_per_user,
  (select count(*)::int           from public.prediction_bets pb where pb.market_id = pm.id and pb.status = 'open') as total_bet_count,
  (select count(distinct user_id)::int from public.prediction_bets pb where pb.market_id = pm.id and pb.status = 'open') as unique_better_count
from public.prediction_markets pm
where pm.status in ('open', 'closed', 'resolved_yes', 'resolved_no');

grant select on public.prediction_market_stats to anon, authenticated;

-- ─── 6. place_bet RPC ──────────────────────────────────────────────────
create or replace function public.place_bet(
  p_user_id          uuid,
  p_market_id        uuid,
  p_side             prediction_bet_side,
  p_stake_points     numeric,
  p_idempotency_key  text
) returns jsonb
language plpgsql security definer set search_path = public
as $func$
declare
  v_market               record;
  v_balance              numeric;
  v_existing_bet         record;
  v_existing_user_total  numeric;
  v_new_pool_yes         numeric;
  v_new_pool_no          numeric;
  v_implied_yes          numeric;
  v_bet_id               uuid;
  v_now                  timestamptz := now();
begin
  -- Idempotency: same key+params → return existing; same key, different
  -- params → conflict. We check by (user_id, idempotency_key) so two
  -- different users can use the same key.
  select * into v_existing_bet
  from prediction_bets
  where user_id = p_user_id and idempotency_key = p_idempotency_key;

  if found then
    if v_existing_bet.market_id   = p_market_id
       and v_existing_bet.side    = p_side
       and v_existing_bet.stake_points = p_stake_points then
      return jsonb_build_object(
        'idempotent', true,
        'bet_id',     v_existing_bet.id,
        'market_id',  v_existing_bet.market_id,
        'side',       v_existing_bet.side,
        'stake_points', v_existing_bet.stake_points,
        'status',     v_existing_bet.status
      );
    else
      raise exception 'IDEMPOTENCY_KEY_REUSED_DIFFERENT_PARAMS' using errcode = 'P0021';
    end if;
  end if;

  -- Lock market row
  select * into v_market from prediction_markets where id = p_market_id for update;
  if not found then
    raise exception 'MARKET_NOT_FOUND' using errcode = 'P0022';
  end if;
  if v_market.status <> 'open' then
    raise exception 'MARKET_NOT_OPEN' using errcode = 'P0023';
  end if;
  if v_market.closes_at <= v_now then
    raise exception 'MARKET_CLOSED' using errcode = 'P0024';
  end if;

  -- Validate stake against market floor
  if p_stake_points < v_market.min_bet_points then
    raise exception 'BELOW_MIN_BET' using errcode = 'P0025';
  end if;

  -- User-level cap: existing-open + new <= cap
  select coalesce(sum(stake_points), 0) into v_existing_user_total
  from prediction_bets
  where market_id = p_market_id and user_id = p_user_id and status = 'open';

  if v_existing_user_total + p_stake_points > v_market.max_bet_points_per_user then
    raise exception 'EXCEEDS_USER_LIMIT' using errcode = 'P0026';
  end if;

  -- Lock balance row + verify funds
  select balance into v_balance from point_balances where user_id = p_user_id for update;
  if not found or v_balance < p_stake_points then
    raise exception 'INSUFFICIENT_BALANCE' using errcode = 'P0027';
  end if;

  -- Compute new pool snapshot for the bet record + market update
  if p_side = 'yes' then
    v_new_pool_yes := v_market.yes_pool + p_stake_points;
    v_new_pool_no  := v_market.no_pool;
  else
    v_new_pool_yes := v_market.yes_pool;
    v_new_pool_no  := v_market.no_pool + p_stake_points;
  end if;
  v_implied_yes := round(v_new_pool_yes / (v_new_pool_yes + v_new_pool_no), 4);

  update prediction_markets
     set yes_pool   = v_new_pool_yes,
         no_pool    = v_new_pool_no,
         updated_at = v_now
   where id = p_market_id;

  update point_balances
     set balance         = balance - p_stake_points,
         last_updated_at = v_now
   where user_id = p_user_id;

  insert into prediction_bets (
    market_id, user_id, side, stake_points,
    yes_pool_at_bet, no_pool_at_bet, implied_yes_probability,
    idempotency_key
  ) values (
    p_market_id, p_user_id, p_side, p_stake_points,
    v_new_pool_yes, v_new_pool_no, v_implied_yes,
    p_idempotency_key
  ) returning id into v_bet_id;

  insert into point_ledger (user_id, amount, reason, reference_kind, idempotency_key)
  values (p_user_id, -p_stake_points, 'prediction_bet', 'prediction_bet', p_idempotency_key);

  return jsonb_build_object(
    'idempotent',   false,
    'bet_id',       v_bet_id,
    'market_id',    p_market_id,
    'side',         p_side,
    'stake_points', p_stake_points,
    'yes_pool',     v_new_pool_yes,
    'no_pool',      v_new_pool_no,
    'implied_yes_probability', v_implied_yes
  );
end;
$func$;

grant execute on function public.place_bet(uuid, uuid, prediction_bet_side, numeric, text) to service_role;

-- ─── 7. resolve_market RPC ─────────────────────────────────────────────
create or replace function public.resolve_market(
  p_market_id   uuid,
  p_outcome     text,
  p_resolver_id uuid,
  p_notes       text
) returns jsonb
language plpgsql security definer set search_path = public
as $func$
declare
  v_market         record;
  v_is_admin       boolean;
  v_winning_side   prediction_bet_side;
  v_losing_side    prediction_bet_side;
  v_winning_pool   numeric;
  v_losing_pool    numeric;
  v_n_winners      int := 0;
  v_n_losers       int := 0;
  v_total_payout   numeric := 0;
  v_now            timestamptz := now();
  r                record;
  v_payout         numeric;
  v_new_status     prediction_market_status;
begin
  if p_outcome not in ('yes', 'no', 'void') then
    raise exception 'INVALID_OUTCOME' using errcode = 'P0031';
  end if;

  select is_admin into v_is_admin from public.users where id = p_resolver_id;
  if v_is_admin is null or not v_is_admin then
    raise exception 'NOT_AUTHORIZED' using errcode = 'P0032';
  end if;

  select * into v_market from prediction_markets where id = p_market_id for update;
  if not found then
    raise exception 'MARKET_NOT_FOUND' using errcode = 'P0033';
  end if;
  if v_market.status not in ('open', 'closed') then
    raise exception 'MARKET_NOT_RESOLVABLE' using errcode = 'P0034';
  end if;

  if p_outcome = 'void' then
    v_new_status := 'voided';
    for r in
      select id, user_id, stake_points, idempotency_key
        from prediction_bets
       where market_id = p_market_id and status = 'open'
       for update
    loop
      update point_balances
         set balance         = balance + r.stake_points,
             last_updated_at = v_now
       where user_id = r.user_id;
      update prediction_bets
         set status        = 'refunded',
             payout_points = r.stake_points,
             settled_at    = v_now
       where id = r.id;
      insert into point_ledger (user_id, amount, reason, reference_kind, idempotency_key)
      values (r.user_id, r.stake_points, 'prediction_bet_refund', 'prediction_bet',
              r.idempotency_key || ':refund');
      v_total_payout := v_total_payout + r.stake_points;
    end loop;
  else
    v_winning_side := p_outcome::prediction_bet_side;
    v_losing_side  := case when p_outcome = 'yes' then 'no'::prediction_bet_side else 'yes'::prediction_bet_side end;
    v_winning_pool := case when p_outcome = 'yes' then v_market.yes_pool else v_market.no_pool end;
    v_losing_pool  := case when p_outcome = 'yes' then v_market.no_pool  else v_market.yes_pool end;
    v_new_status   := case when p_outcome = 'yes' then 'resolved_yes'::prediction_market_status
                                                   else 'resolved_no'::prediction_market_status end;

    for r in
      select id, user_id, stake_points, idempotency_key
        from prediction_bets
       where market_id = p_market_id and status = 'open' and side = v_winning_side
       for update
    loop
      v_payout := r.stake_points + (r.stake_points / v_winning_pool) * v_losing_pool;
      update point_balances
         set balance         = balance + v_payout,
             last_updated_at = v_now
       where user_id = r.user_id;
      update prediction_bets
         set status        = 'won',
             payout_points = v_payout,
             settled_at    = v_now
       where id = r.id;
      insert into point_ledger (user_id, amount, reason, reference_kind, idempotency_key)
      values (r.user_id, v_payout, 'prediction_bet_payout', 'prediction_bet',
              r.idempotency_key || ':payout');
      v_n_winners    := v_n_winners + 1;
      v_total_payout := v_total_payout + v_payout;
    end loop;

    for r in
      select id from prediction_bets
       where market_id = p_market_id and status = 'open' and side = v_losing_side
       for update
    loop
      update prediction_bets
         set status        = 'lost',
             payout_points = 0,
             settled_at    = v_now
       where id = r.id;
      v_n_losers := v_n_losers + 1;
    end loop;
  end if;

  update prediction_markets
     set status              = v_new_status,
         resolved_at         = v_now,
         resolved_by_user_id = p_resolver_id,
         resolution_notes    = p_notes,
         updated_at          = v_now
   where id = p_market_id;

  return jsonb_build_object(
    'market_id',     p_market_id,
    'outcome',       p_outcome,
    'n_winners',     v_n_winners,
    'n_losers',      v_n_losers,
    'total_payout',  v_total_payout,
    'new_status',    v_new_status::text
  );
end;
$func$;

grant execute on function public.resolve_market(uuid, text, uuid, text) to service_role;

-- ─── 8. flag_markets_ready_for_resolution ──────────────────────────────
-- Cron-callable. Closes any open market past its closes_at, then for
-- 'auto' markets attempts the resolution_sql and inserts a suggestion
-- row for admin review. Manual markets just get flipped to 'closed'.
-- Never resolves on its own (per spec).
--
-- Security note: resolution_sql is set by admin at market creation
-- (service_role insert), never user-supplied. EXECUTE on it is wrapped
-- in BEGIN/EXCEPTION so a malformed query produces 'inconclusive'
-- instead of aborting the whole batch.
create or replace function public.flag_markets_ready_for_resolution()
returns jsonb
language plpgsql security definer set search_path = public
as $func$
declare
  v_count    int := 0;
  v_market   record;
  v_result   boolean;
  v_outcome  text;
  v_raw      jsonb;
begin
  for v_market in
    select * from prediction_markets
     where status = 'open' and closes_at < now()
     for update
  loop
    update prediction_markets
       set status = 'closed', updated_at = now()
     where id = v_market.id;
    v_count := v_count + 1;

    if v_market.resolution_data_source = 'auto' and v_market.resolution_sql is not null then
      begin
        execute v_market.resolution_sql into v_result;
        v_outcome := case
          when v_result is true  then 'yes'
          when v_result is false then 'no'
          else 'inconclusive'
        end;
        v_raw := jsonb_build_object('result', v_result);
      exception when others then
        v_outcome := 'inconclusive';
        v_raw := jsonb_build_object('error', sqlerrm);
      end;

      insert into prediction_resolution_suggestions (market_id, suggested_outcome, sql_returned)
      values (v_market.id, v_outcome, v_raw);
    end if;
  end loop;

  return jsonb_build_object('flagged_count', v_count);
end;
$func$;

grant execute on function public.flag_markets_ready_for_resolution() to service_role;

-- ─── 9. Seed 10 launch markets ─────────────────────────────────────────
-- Spec note: original seed SQL referenced suppliers.is_active, but the
-- column is suppliers.status (enum). Fixed inline. Spread_pct in
-- vendor_arbitrage is already numeric, so the CAST AS NUMERIC was a
-- no-op — kept for clarity.

insert into public.prediction_markets (
  slug, question, category, resolution_criteria,
  resolution_data_source, resolution_sql,
  resolution_date, closes_at
) values

-- 1: TIRZEPATIDE goes from 1 supplier (SWISSCHEMS) to ≥2
('tirzepatide-2-vendors-may15',
 'Will Tirzepatide become tradeable (≥2 active vendors) by May 15, 2026?',
 'vendor',
 'Resolves YES if ≥2 active suppliers carry TIRZEPATIDE in supplier_products as of resolution date.',
 'auto',
 $sql$
   select (
     select count(*) from public.supplier_products sp
     join public.peptides  p on p.id = sp.peptide_id
     join public.suppliers s on s.id = sp.supplier_id
     where p.code = 'TIRZEPATIDE' and sp.active = true and s.status = 'active'
   ) >= 2
 $sql$,
 '2026-05-15 23:59:59+00', '2026-05-15 23:59:59+00'),

-- 2: BPC-157 TWAP < $5/mg any time
('bpc157-below-5-may31',
 'Will BPC-157 TWAP close below $5/mg on any day before May 31, 2026?',
 'price',
 'Resolves YES if at any point between now and May 31, BPC-157 TWAP drops below $5/mg.',
 'auto',
 $sql$
   select exists (
     select 1 from public.peptide_twaps pt
     join public.peptides p on p.id = pt.peptide_id
     where p.code = 'BPC157' and pt.twap_usd_per_mg < 5.00
       and pt.computed_at > now() - interval '60 days'
   )
 $sql$,
 '2026-05-31 23:59:59+00', '2026-05-31 23:59:59+00'),

-- 3: GHKCU spread closes < 500%
('ghkcu-spread-below-500-jun1',
 'Will GHKCU spread close below 500% before June 1, 2026?',
 'spread',
 'Resolves YES if vendor_arbitrage spread_pct for GHKCU drops below 500% on any check before June 1.',
 'auto',
 $sql$
   select exists (
     select 1 from public.vendor_arbitrage
     where peptide_code = 'GHKCU' and spread_pct < 500
   )
 $sql$,
 '2026-06-01 23:59:59+00', '2026-06-01 23:59:59+00'),

-- 4: any of the 8 active vendors goes inactive
('vendor-shutdown-jul1',
 'Will any current active vendor go inactive before July 1, 2026?',
 'vendor',
 'Resolves YES if any of the 8 currently-active suppliers (PUREHEALTH, NUSCIENCE, VERIFIED, LIBERTY, GENETIC, PULSE, PURERAWZ, SWISSCHEMS) becomes status != ''active'' before July 1.',
 'auto',
 $sql$
   select exists (
     select 1 from public.suppliers
     where code in ('PUREHEALTH','NUSCIENCE','VERIFIED','LIBERTY','GENETIC','PULSE','PURERAWZ','SWISSCHEMS')
       and status <> 'active'
   )
 $sql$,
 '2026-07-01 23:59:59+00', '2026-07-01 23:59:59+00'),

-- 5: RETATRUTIDE 1 → ≥2 vendors
('retatrutide-2-vendors-jul1',
 'Will Retatrutide become tradeable (≥2 active vendors) by July 1, 2026?',
 'vendor',
 'Resolves YES if ≥2 active suppliers carry RETATRUTIDE in supplier_products as of resolution date.',
 'auto',
 $sql$
   select (
     select count(*) from public.supplier_products sp
     join public.peptides  p on p.id = sp.peptide_id
     join public.suppliers s on s.id = sp.supplier_id
     where p.code = 'RETATRUTIDE' and sp.active = true and s.status = 'active'
   ) >= 2
 $sql$,
 '2026-07-01 23:59:59+00', '2026-07-01 23:59:59+00'),

-- 6: GLP-1 TWAP > $20/mg
('glp1-above-20-jun15',
 'Will GLP-1 (Semaglutide) TWAP exceed $20/mg before June 15, 2026?',
 'price',
 'Resolves YES if GLP1 TWAP exceeds $20/mg on any single day check before June 15.',
 'auto',
 $sql$
   select exists (
     select 1 from public.peptide_twaps pt
     join public.peptides p on p.id = pt.peptide_id
     where p.code = 'GLP1' and pt.twap_usd_per_mg > 20.00
       and pt.computed_at > now() - interval '60 days'
   )
 $sql$,
 '2026-06-15 23:59:59+00', '2026-06-15 23:59:59+00'),

-- 7: 30+ active peptides on the platform
('30-active-peptides-jun1',
 'Will biohack.market track 30+ active peptides by June 1, 2026?',
 'platform',
 'Resolves YES if COUNT of peptides where is_active=true reaches 30 or more before June 1.',
 'auto',
 $sql$
   select (select count(*) from public.peptides where is_active = true) >= 30
 $sql$,
 '2026-06-01 23:59:59+00', '2026-06-01 23:59:59+00'),

-- 8: any peptide spread > 2000% (currently top is GHKCU at ~1088%)
('spread-above-2000-may31',
 'Will any peptide reach >2000% spread before May 31, 2026?',
 'spread',
 'Resolves YES if any peptide in vendor_arbitrage hits spread_pct above 2000% on any check.',
 'auto',
 $sql$
   select exists (select 1 from public.vendor_arbitrage where spread_pct > 2000)
 $sql$,
 '2026-05-31 23:59:59+00', '2026-05-31 23:59:59+00'),

-- 9: FDA PCAC — manual resolution
('fda-pcac-bpc157-jul23',
 'Will FDA PCAC meeting (July 23) result in BPC-157 reclassification?',
 'regulatory',
 'Resolves manually based on FDA announcements following July 23, 2026 PCAC meeting. Resolves YES if BPC-157 is reclassified from Category 2 to Category 1.',
 'manual',
 null,
 '2026-08-01 23:59:59+00', '2026-07-23 23:59:59+00'),

-- 10: 100 unique traders
('100-traders-jun1',
 'Will biohack.market have 100+ unique traders by June 1, 2026?',
 'platform',
 'Resolves YES if COUNT(DISTINCT user_id) from positions table reaches 100+ before June 1.',
 'auto',
 $sql$
   select (select count(distinct user_id) from public.positions) >= 100
 $sql$,
 '2026-06-01 23:59:59+00', '2026-06-01 23:59:59+00')

on conflict (slug) do nothing;
