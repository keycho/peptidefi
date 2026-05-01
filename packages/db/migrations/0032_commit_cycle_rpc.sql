-- 0032_commit_cycle_rpc.sql
-- Server-side function that atomically registers a cycle commit:
-- inserts the commit_cycles row + all commit_observations junction
-- rows in a single PG-side transaction. Returns nothing on success;
-- raises on any constraint violation (caller sees the error).
--
-- Why a function and not just two client-side inserts: supabase-js /
-- PostgREST has no transaction support; it issues one HTTP request per
-- statement. A partial write (cycle row inserted, junction rows fail)
-- would leave a 'pending' row with no observations, which would
-- confuse the cycle poller's recovery logic. Wrapping in a function
-- gives us atomicity for free — PG functions are implicit transactions.
--
-- Status of the inserted commit_cycles row is 'pending' (the default;
-- the column has a default of 'pending' so we don't pass it). Phase C
-- of the implementation transitions it to 'submitted' and 'finalized'
-- as the Solana submission progresses.
--
-- Granted EXECUTE to service_role only — the API service role calls
-- this directly via supabase-js rpc(); the oracle service calls it via
-- the postgres npm package using the same SECURITY DEFINER privileges.

create or replace function public.register_commit_cycle(
  p_cycle_id          bigint,
  p_started_at        timestamptz,
  p_completed_at      timestamptz,
  p_observation_count integer,
  p_merkle_root       text,
  p_memo_payload      text,
  p_leaves            jsonb
) returns void
language plpgsql
security definer
set search_path = public
as $func$
declare
  v_leaf_count integer;
begin
  -- Cross-check: the leaf array length must match the declared
  -- observation_count. Catches a class of caller bugs where the
  -- root was computed over a different set than what's in p_leaves.
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

  -- Cycle row first. The CHECK on observation_count > 0 in
  -- commit_cycles will already block the v_leaf_count = 0 case
  -- redundantly, but the explicit check above gives a clearer error.
  insert into public.commit_cycles (
    cycle_id,
    started_at,
    completed_at,
    observation_count,
    merkle_root,
    memo_payload
    -- status defaults to 'pending'
    -- created_at defaults to now()
  ) values (
    p_cycle_id,
    p_started_at,
    p_completed_at,
    p_observation_count,
    p_merkle_root,
    p_memo_payload
  );

  -- Junction rows — observation_id, leaf_hash, leaf_index per leaf.
  -- jsonb_array_elements explodes p_leaves into one row per element;
  -- ::bigint and ::integer casts validate the field types.
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
  bigint, timestamptz, timestamptz, integer, text, text, jsonb
) to service_role;

comment on function public.register_commit_cycle(
  bigint, timestamptz, timestamptz, integer, text, text, jsonb
) is
  'Atomic commit-cycle registration: inserts commit_cycles row + commit_observations junction rows in one transaction. p_leaves is a jsonb array of {observation_id, leaf_hash, leaf_index}. Throws if leaf count mismatches observation_count.';
