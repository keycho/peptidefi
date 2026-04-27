-- 0017_user_display_names.sql
-- Adds the display_name + rate-limit infrastructure for the leaderboard
-- and the /profile/display-name endpoint.
--
-- Why we extend public.users instead of creating a new user_profiles
-- table: public.users already has a `display_name text` column from
-- migration 0003 — it just lacks constraints + the auto-generation. One
-- fewer table, one fewer JOIN at every read site, the existing
-- handle_new_auth_user trigger already touches this row at signup.
--
-- Privacy model: public.users keeps its existing SELF-only RLS policy
-- (auth.uid() = id). The leaderboard view in migration 0018 uses
-- security_invoker = false so its owner (postgres) bypasses RLS for
-- reads, projecting ONLY display_name + computed financial columns —
-- never email, wallet, admin flag, etc.
--
-- Steps in this file:
--   1. Add display_name_changed_at column for rate limiting (1 change /
--      24h enforced by the API).
--   2. Backfill display_names for any existing users where it's NULL
--      using the trader_NNNN convention with collision retry. After
--      this step, every public.users row has a non-null display_name.
--   3. Add the CHECKs (length 3-24, regex ^[a-zA-Z0-9_-]+$).
--   4. Add the case-insensitive unique index on lower(display_name).
--   5. Make display_name NOT NULL (now that backfill is done).
--   6. Update handle_new_auth_user() to generate a fresh display_name
--      whenever a new auth.users row lands.

-- ─── 1. Rate-limit timestamp column ─────────────────────────────────────────
alter table public.users
  add column if not exists display_name_changed_at timestamptz;

-- ─── 2. Backfill ────────────────────────────────────────────────────────────
-- Helper: generate a unique trader_NNNN, retrying up to 10 times. If the
-- 10k-name space is exhausted we fall back to a UUID prefix.
create or replace function public.generate_unique_display_name()
returns text
language plpgsql
as $$
declare
  v_candidate text;
  v_attempts  int := 0;
begin
  loop
    -- 4-digit suffix; floor(random()*9000)+1000 → 1000..9999 → "trader_1000"..
    v_candidate := 'trader_' || lpad((floor(random() * 9000) + 1000)::int::text, 4, '0');
    if not exists (
      select 1 from public.users where lower(display_name) = lower(v_candidate)
    ) then
      return v_candidate;
    end if;
    v_attempts := v_attempts + 1;
    if v_attempts >= 10 then
      -- Pathological case: 10 collisions in a row. Use a UUID-based suffix
      -- to guarantee uniqueness without further retries.
      return 'trader_' || substring(replace(gen_random_uuid()::text, '-', '') from 1 for 8);
    end if;
  end loop;
end;
$$;

-- Backfill anyone without a display_name. Loop because each generate_*()
-- call needs to see the names committed by previous iterations.
do $$
declare
  v_user_id uuid;
  v_name    text;
begin
  for v_user_id in
    select id from public.users where display_name is null order by created_at
  loop
    v_name := public.generate_unique_display_name();
    update public.users set display_name = v_name where id = v_user_id;
  end loop;
end $$;

-- ─── 3. Format checks ───────────────────────────────────────────────────────
alter table public.users
  add constraint users_display_name_length
    check (display_name is null or char_length(display_name) between 3 and 24);

alter table public.users
  add constraint users_display_name_format
    check (display_name is null or display_name ~ '^[a-zA-Z0-9_-]+$');

-- ─── 4. Case-insensitive uniqueness ─────────────────────────────────────────
-- Plain `unique` on display_name would let "Trader_1234" and "trader_1234"
-- coexist. Functional unique on lower() is the standard fix.
create unique index users_display_name_lower_unique
  on public.users (lower(display_name))
  where display_name is not null;

-- ─── 5. NOT NULL ─────────────────────────────────────────────────────────────
alter table public.users
  alter column display_name set not null;

-- ─── 6. Trigger update — auto-generate display_name on signup ───────────────
-- Replaces the function from 0003. Same atomic semantics (one transaction
-- creates users + point_balances + point_grants + point_ledger + the
-- auto-generated display_name).
create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_signup_grant   numeric(20, 6) := 10000;
  v_referral_code  text;
  v_display_name   text;
  v_grant_id       bigint;
  v_attempts       int := 0;
begin
  -- Referral code (8-char base32-ish), retry on collision.
  loop
    v_referral_code := upper(substring(replace(gen_random_uuid()::text, '-', ''), 1, 8));
    exit when not exists (select 1 from public.users where referral_code = v_referral_code);
    v_attempts := v_attempts + 1;
    if v_attempts > 5 then
      v_referral_code := null;
      exit;
    end if;
  end loop;

  -- Display name via the helper. The helper itself retries up to 10x and
  -- falls back to a UUID-derived suffix.
  v_display_name := public.generate_unique_display_name();

  insert into public.users (id, email, referral_code, display_name)
  values (new.id, new.email, v_referral_code, v_display_name);

  insert into public.point_balances (user_id, balance, last_updated_at)
  values (new.id, v_signup_grant, now());

  insert into public.point_grants (user_id, grant_kind, amount, granted_for_date)
  values (new.id, 'signup', v_signup_grant, null)
  returning id into v_grant_id;

  insert into public.point_ledger
    (user_id, amount, reason, reference_kind, reference_id, idempotency_key)
  values
    (new.id, v_signup_grant, 'signup_grant', 'point_grants', v_grant_id, 'signup');

  return new;
end;
$$;

-- Trigger itself was created in 0003; re-binding it here just in case.
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_auth_user();
