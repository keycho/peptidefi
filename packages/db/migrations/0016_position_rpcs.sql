-- 0016_position_rpcs.sql
-- Atomic open/close position primitives.
--
-- Why functions instead of API-side transactions: PostgREST exposes
-- SQL only as one statement per request, so atomicity for "deduct
-- balance + insert position + append ledger row" needs a wrapping
-- function. This also lets us SELECT … FOR UPDATE the user's balance
-- row inside the same transaction as the insert, which is the actual
-- guard against concurrent double-spend.
--
-- Both functions are SECURITY DEFINER + search_path=public (no shell
-- injection surface) and are granted only to service_role. The API uses
-- the secret key, which has BYPASSRLS in Supabase, so RLS isn't a
-- concern inside these functions.
--
-- Both return JSON so PostgREST round-trips cleanly without us having
-- to enumerate every column.
--
-- Idempotency:
--   - open_position uses the existing (user_id, idempotency_key) unique
--     constraint on positions. If a row with the key already exists for
--     this user, the function returns it as-is (with idempotent=true)
--     instead of re-executing — caller compares the body fields against
--     the returned position and surfaces IDEMPOTENCY_KEY_REUSED if they
--     differ.
--   - close_position is naturally idempotent: locking the position row
--     and checking status='closed' lets us return the prior result with
--     no balance side effect.
--
-- Bounded-loss clamp:
--   current_value = max(0, entry_size + pnl). For long positions PnL is
--   bounded naturally by entry_twap → 0 (value→0). For shorts the
--   formula goes negative when current_twap > 2× entry; the GREATEST(0)
--   call clamps so users never owe more than their stake.
--
-- Ledger linkage: positions.id is uuid but point_ledger.reference_id
-- is bigint. We can't store the uuid there. Instead, the ledger row
-- gets idempotency_key='position_open:<uuid>' or 'position_close:<uuid>'
-- which both encodes the link and dedupes the ledger insert if the
-- function ever re-runs against the same position.

-- ─── open_position ──────────────────────────────────────────────────────────
create or replace function public.open_position(
  p_user_id                uuid,
  p_peptide_id             bigint,
  p_direction              public.position_direction,
  p_size_points            numeric,
  p_entry_twap             numeric,
  p_entry_peptide_twap_id  bigint,
  p_idempotency_key        text
) returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existing public.positions;
  v_balance  numeric(20, 6);
  v_position public.positions;
begin
  -- Idempotency short-circuit: if a position already exists for
  -- (user, key), return it without doing any work.
  select * into v_existing
    from public.positions
    where user_id = p_user_id and idempotency_key = p_idempotency_key
    limit 1;
  if found then
    select balance into v_balance from public.point_balances
      where user_id = p_user_id;
    return json_build_object(
      'position',    row_to_json(v_existing),
      'new_balance', coalesce(v_balance, 0),
      'idempotent',  true
    );
  end if;

  -- Lock the user's balance row to serialize concurrent opens. Any other
  -- concurrent open_position call for the same user blocks here until we
  -- commit.
  select balance into v_balance
    from public.point_balances
    where user_id = p_user_id
    for update;

  if not found then
    raise exception 'BALANCE_ROW_MISSING' using errcode = 'P0001';
  end if;
  if v_balance < p_size_points then
    raise exception 'INSUFFICIENT_BALANCE balance=% requested=%',
      v_balance, p_size_points using errcode = 'P0001';
  end if;

  -- Create the position row first so we have its uuid for the ledger
  -- idempotency key.
  insert into public.positions
    (user_id, peptide_id, direction, entry_size_points,
     entry_twap_usd_per_mg, entry_peptide_twap_id, status, idempotency_key)
  values
    (p_user_id, p_peptide_id, p_direction, p_size_points,
     p_entry_twap, p_entry_peptide_twap_id, 'open', p_idempotency_key)
  returning * into v_position;

  -- Decrement balance.
  update public.point_balances
    set balance         = balance - p_size_points,
        last_updated_at = now()
    where user_id = p_user_id;

  -- Append append-only ledger entry. Idempotency key encodes the
  -- position uuid so a re-run can't double-debit.
  insert into public.point_ledger
    (user_id, amount, reason, reference_kind, reference_id, idempotency_key)
  values
    (p_user_id, -p_size_points, 'trade_open', 'positions', null,
     'position_open:' || v_position.id::text);

  return json_build_object(
    'position',    row_to_json(v_position),
    'new_balance', v_balance - p_size_points,
    'idempotent',  false
  );
end;
$$;

revoke all on function public.open_position(uuid, bigint, public.position_direction, numeric, numeric, bigint, text) from public;
grant execute on function public.open_position(uuid, bigint, public.position_direction, numeric, numeric, bigint, text) to service_role;

-- ─── close_position ─────────────────────────────────────────────────────────
create or replace function public.close_position(
  p_user_id               uuid,
  p_position_id           uuid,
  p_exit_twap             numeric,
  p_exit_peptide_twap_id  bigint
) returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_position    public.positions;
  v_balance     numeric(20, 6);
  v_pct         numeric(40, 18);
  v_pnl         numeric(40, 18);
  v_value       numeric(20, 6);
  v_realized    numeric(20, 6);
begin
  -- Lock the position row. POSITION_NOT_FOUND covers both "no such
  -- row" and "row exists but not yours" — caller MUST NOT distinguish
  -- between them in the response, to avoid leaking existence.
  select * into v_position
    from public.positions
    where id = p_position_id
    for update;

  if not found or v_position.user_id <> p_user_id then
    raise exception 'POSITION_NOT_FOUND' using errcode = 'P0001';
  end if;

  -- Idempotent close: if already closed, return the prior result with
  -- no balance side-effect.
  if v_position.status = 'closed' then
    select balance into v_balance from public.point_balances
      where user_id = p_user_id;
    return json_build_object(
      'position',            row_to_json(v_position),
      'new_balance',         coalesce(v_balance, 0),
      'realized_pnl_points', v_position.realized_pnl_points,
      'idempotent',          true
    );
  end if;

  -- P&L math. Use numeric(40,18) intermediates to keep precision until
  -- the final cast back to numeric(20,6) for storage.
  v_pct := (p_exit_twap - v_position.entry_twap_usd_per_mg)
           / v_position.entry_twap_usd_per_mg;
  if v_position.direction = 'long' then
    v_pnl := v_position.entry_size_points * v_pct;
  else
    v_pnl := v_position.entry_size_points * (-v_pct);
  end if;
  -- Bounded-loss clamp: user can never owe more than their entry stake.
  v_value    := greatest(numeric '0', v_position.entry_size_points + v_pnl);
  v_realized := v_value - v_position.entry_size_points;

  -- Update the position row atomically with the close-side fields. The
  -- positions_status_consistency CHECK enforces we set all of them.
  update public.positions
    set status               = 'closed',
        closed_at            = now(),
        exit_twap_usd_per_mg = p_exit_twap,
        exit_peptide_twap_id = p_exit_peptide_twap_id,
        realized_pnl_points  = v_realized
    where id = p_position_id
    returning * into v_position;

  -- Lock and credit the balance. SELECT FOR UPDATE here is a no-op
  -- (we'd already serialize on the position lock) but keeps the
  -- pattern consistent with open_position.
  select balance into v_balance
    from public.point_balances
    where user_id = p_user_id
    for update;
  update public.point_balances
    set balance         = balance + v_value,
        last_updated_at = now()
    where user_id = p_user_id;

  insert into public.point_ledger
    (user_id, amount, reason, reference_kind, reference_id, idempotency_key)
  values
    (p_user_id, v_value, 'trade_close', 'positions', null,
     'position_close:' || v_position.id::text);

  return json_build_object(
    'position',            row_to_json(v_position),
    'new_balance',         coalesce(v_balance, 0) + v_value,
    'realized_pnl_points', v_realized,
    'idempotent',          false
  );
end;
$$;

revoke all on function public.close_position(uuid, uuid, numeric, bigint) from public;
grant execute on function public.close_position(uuid, uuid, numeric, bigint) to service_role;
