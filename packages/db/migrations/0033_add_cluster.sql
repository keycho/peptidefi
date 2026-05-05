-- 0033_add_cluster.sql
-- Cluster tagging for commit_cycles + twap_commits ahead of the
-- devnet → mainnet oracle migration.
--
-- Reversible. Existing rows are tagged 'devnet' (correct — they ARE
-- devnet history; the oracle has been on devnet since the project
-- shipped). New rows take the cluster value passed by the oracle
-- service from its SOLANA_CLUSTER env var.
--
-- Why tag in the DB rather than implying from the API's
-- ORACLE_RPC_URL: after cutover, mainnet rows and devnet rows coexist
-- in one table forever. Verifying any historical commit needs to know
-- which Solana cluster to ask for the transaction. Stamping the
-- cluster on the row at write time means every read endpoint can
-- surface the correct Solscan / explorer URL without operator-side
-- bookkeeping.
--
-- Migration ordering with the oracle code change:
--   1. Apply this migration (default 'devnet' on new rows is safe
--      while the oracle is still on devnet — even if the oracle
--      hasn't shipped its code change yet, every row inserted is
--      correctly tagged).
--   2. Deploy oracle code that reads SOLANA_CLUSTER and passes it
--      through register_commit_cycle (still SOLANA_CLUSTER='devnet').
--   3. Cutover: flip SOLANA_CLUSTER='mainnet-beta' (and the other
--      env vars) on the Railway oracle service. New rows now tagged
--      'mainnet-beta'.
--
-- See docs/operator-setup.md §6 for the full cutover runbook.

-- ── up ─────────────────────────────────────────────────────────────

-- 1. commit_cycles.cluster
alter table public.commit_cycles
  add column if not exists cluster text;

update public.commit_cycles
  set cluster = 'devnet'
  where cluster is null;

alter table public.commit_cycles
  alter column cluster set not null,
  alter column cluster set default 'devnet';

-- 2. twap_commits.cluster
alter table public.twap_commits
  add column if not exists cluster text;

update public.twap_commits
  set cluster = 'devnet'
  where cluster is null;

alter table public.twap_commits
  alter column cluster set not null,
  alter column cluster set default 'devnet';

-- 3. Indexes for cluster-filtered list queries (the API's main read pattern).
create index if not exists idx_commit_cycles_cluster_completed_at
  on public.commit_cycles (cluster, completed_at desc);

create index if not exists idx_twap_commits_cluster_computed_at
  on public.twap_commits (cluster, computed_at desc);

-- 4. Update register_commit_cycle to accept cluster.
-- Drop-and-recreate (the old signature has 7 args; new has 8). Inside
-- a single transaction so concurrent oracle writes either see all-old
-- or all-new — no torn-shape window.
begin;

drop function if exists public.register_commit_cycle(
  bigint, timestamptz, timestamptz, integer, text, text, jsonb
);

create or replace function public.register_commit_cycle(
  p_cycle_id          bigint,
  p_started_at        timestamptz,
  p_completed_at      timestamptz,
  p_observation_count integer,
  p_merkle_root       text,
  p_memo_payload      text,
  p_leaves            jsonb,
  p_cluster           text default 'devnet'
) returns void
language plpgsql
security definer
set search_path = public
as $func$
declare
  v_leaf_count integer;
begin
  v_leaf_count := jsonb_array_length(p_leaves);
  if v_leaf_count <> p_observation_count then
    raise exception
      'register_commit_cycle: observation_count=% but received % leaves',
      p_observation_count, v_leaf_count
      using errcode = 'P0001';
  end if;
  if v_leaf_count = 0 then
    raise exception
      'register_commit_cycle: refusing to register zero-observation cycle (§02.4.5)'
      using errcode = 'P0001';
  end if;

  insert into public.commit_cycles (
    cycle_id,
    started_at,
    completed_at,
    observation_count,
    merkle_root,
    memo_payload,
    cluster
  ) values (
    p_cycle_id,
    p_started_at,
    p_completed_at,
    p_observation_count,
    p_merkle_root,
    p_memo_payload,
    p_cluster
  );

  insert into public.commit_observations
    (observation_id, cycle_id, leaf_hash, leaf_index)
  select
    (elem->>'observation_id')::bigint,
    p_cycle_id,
    elem->>'leaf_hash',
    (elem->>'leaf_index')::integer
  from jsonb_array_elements(p_leaves) as elem;
end;
$func$;

grant execute on function public.register_commit_cycle(
  bigint, timestamptz, timestamptz, integer, text, text, jsonb, text
) to service_role;

comment on function public.register_commit_cycle(
  bigint, timestamptz, timestamptz, integer, text, text, jsonb, text
) is
  'Atomic commit-cycle registration. Same as 0032 plus p_cluster (default ''devnet'') stamping the row''s Solana cluster.';

commit;

-- ── down (reversal block — run only on rollback) ──────────────────
-- begin;
-- drop function if exists public.register_commit_cycle(
--   bigint, timestamptz, timestamptz, integer, text, text, jsonb, text
-- );
-- -- Recreate the 0032 signature (without cluster).
-- create or replace function public.register_commit_cycle(
--   p_cycle_id          bigint,
--   p_started_at        timestamptz,
--   p_completed_at      timestamptz,
--   p_observation_count integer,
--   p_merkle_root       text,
--   p_memo_payload      text,
--   p_leaves            jsonb
-- ) returns void
-- language plpgsql
-- security definer
-- set search_path = public
-- as $func$
-- declare
--   v_leaf_count integer;
-- begin
--   v_leaf_count := jsonb_array_length(p_leaves);
--   if v_leaf_count <> p_observation_count then
--     raise exception 'register_commit_cycle: observation_count=% but received % leaves',
--       p_observation_count, v_leaf_count using errcode = 'P0001';
--   end if;
--   if v_leaf_count = 0 then
--     raise exception 'register_commit_cycle: refusing to register zero-observation cycle (§02.4.5)'
--       using errcode = 'P0001';
--   end if;
--   insert into public.commit_cycles (
--     cycle_id, started_at, completed_at, observation_count, merkle_root, memo_payload
--   ) values (
--     p_cycle_id, p_started_at, p_completed_at, p_observation_count, p_merkle_root, p_memo_payload
--   );
--   insert into public.commit_observations (observation_id, cycle_id, leaf_hash, leaf_index)
--   select
--     (elem->>'observation_id')::bigint,
--     p_cycle_id,
--     elem->>'leaf_hash',
--     (elem->>'leaf_index')::integer
--   from jsonb_array_elements(p_leaves) as elem;
-- end;
-- $func$;
-- grant execute on function public.register_commit_cycle(
--   bigint, timestamptz, timestamptz, integer, text, text, jsonb
-- ) to service_role;
-- drop index if exists idx_commit_cycles_cluster_completed_at;
-- drop index if exists idx_twap_commits_cluster_computed_at;
-- alter table public.commit_cycles drop column if exists cluster;
-- alter table public.twap_commits  drop column if exists cluster;
-- commit;
