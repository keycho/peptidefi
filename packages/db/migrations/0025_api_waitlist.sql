-- 0025_api_waitlist.sql
-- Email-collection table for the /api page (and any future "coming soon"
-- waitlist surfaces). Anon callers can INSERT (the public form posts via
-- PostgREST with the publishable key); anon callers cannot SELECT, so a
-- visitor can't enumerate other people's emails by hitting
-- /rest/v1/api_waitlist.
--
-- Numbering: original collision report referenced 0022/0024, but both
-- those slots are now occupied (0022 = peptides expansion, 0023 =
-- supplier_products RLS, 0024 = vendor_leaderboard). Using 0025 — the
-- next free slot — so this migration is the one that actually applies.
--
-- Schema choices
-- --------------
--   email     stored case-preserved but uniqueness enforced on lower(email)
--             so "User@Example.com" and "user@example.com" don't both land.
--             A simple regex in the CHECK keeps malformed addresses out at
--             the DB layer; the UI should still validate first for UX.
--   source    free-text tag identifying which page the signup came from
--             ('api_page', 'research_page', etc.) so we can split funnels
--             later without another migration.
--   meta      jsonb catch-all for non-PII metadata (referrer, locale,
--             optional company / use-case answers). Keeps the migration
--             surface small if /api adds a "what would you use it for?"
--             field later.
--
-- RLS
-- ---
--   - INSERT for anon + authenticated, gated by the same email + source
--     CHECK as the table constraint (defense in depth).
--   - No SELECT policy for anon → anon SELECT returns zero rows.
--   - service_role bypasses RLS so admin export / Retool / dashboards
--     work without an extra policy.
--
-- PostgREST gotcha
-- ----------------
-- An INSERT with `Prefer: return=representation` triggers an implicit
-- `RETURNING *` which itself requires a SELECT policy — and there
-- isn't one for anon, so the whole transaction rolls back as an RLS
-- violation even though the row would have passed the WITH CHECK.
-- Client code (Lovable form) must NOT request representation:
--   await supabase.from('api_waitlist').insert({email, source})
-- (no chained .select(), no `returning: 'representation'`). The
-- default supabase-js behavior already does this.

create table if not exists public.api_waitlist (
  id          bigserial primary key,
  email       text        not null,
  source      text        not null default 'api_page',
  meta        jsonb       not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  constraint api_waitlist_email_format
    check (email ~* '^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$'),
  constraint api_waitlist_source_nonempty
    check (length(source) > 0 and length(source) <= 64)
);

-- Case-insensitive uniqueness on email. We keep both "casefolded for
-- uniqueness" + "preserved as typed for display" the way most signup
-- tables do.
create unique index if not exists api_waitlist_email_lower_uidx
  on public.api_waitlist (lower(email));

create index if not exists api_waitlist_created_at_idx
  on public.api_waitlist (created_at desc);

alter table public.api_waitlist enable row level security;

-- Anon (and authenticated) can INSERT. The WITH CHECK clause re-states
-- the email + source constraints so a malicious caller can't bypass
-- them via a future schema change that loosens the table-level CHECK.
drop policy if exists "api_waitlist_insert_anon" on public.api_waitlist;
create policy "api_waitlist_insert_anon"
  on public.api_waitlist for insert
  to anon, authenticated
  with check (
    email ~* '^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$'
    and length(source) > 0 and length(source) <= 64
  );

-- No SELECT, UPDATE, or DELETE policies for anon/authenticated.
-- Without a SELECT policy, any read attempt returns zero rows even
-- though the row exists — so visitor X can't enumerate visitor Y's
-- email by querying /rest/v1/api_waitlist with the publishable key.
-- service_role still has full access (it bypasses RLS).

grant insert on public.api_waitlist                  to anon, authenticated;
grant usage,  select on sequence api_waitlist_id_seq to anon, authenticated;
