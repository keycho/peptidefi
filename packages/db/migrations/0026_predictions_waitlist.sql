-- 0026_predictions_waitlist.sql
-- Email-collection table for the /predictions page form. Same shape as
-- 0025_api_waitlist but with an extra question_id column so signups
-- can be attributed to the specific prediction question that prompted
-- them (used for "notify me when this resolves" or "notify me about
-- this market"-style flows).
--
-- Numbering: 0022 = peptides expansion, 0023 = supplier_products RLS,
-- 0024 = vendor_leaderboard, 0025 = api_waitlist. 0026 is next free.
--
-- RLS pattern matches 0025: anon can INSERT, anon cannot SELECT, so a
-- visitor can't enumerate other people's emails. service_role bypasses
-- RLS for admin export.
--
-- PostgREST gotcha (also documented on 0025): the Lovable form must
-- NOT chain .select() after .insert() — that triggers an implicit
-- RETURNING * which requires a SELECT policy and fails. Working
-- pattern:
--   await supabase.from('predictions_waitlist').insert({
--     email, question_id: questionId || null
--   });
-- For a waitlist, the form only needs success/error feedback, not the
-- inserted row back.

create table public.predictions_waitlist (
  id          uuid        primary key default gen_random_uuid(),
  email       text        not null
                check (email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  question_id text,
  created_at  timestamptz default now()
);

create unique index predictions_waitlist_email_unique
  on public.predictions_waitlist (lower(email));

alter table public.predictions_waitlist enable row level security;

-- Anon (and authenticated) can INSERT. with_check=true defers all
-- gating to the table-level CHECK constraints — keeps the policy tiny
-- and surfaces validation errors as PG check_violation rather than RLS
-- denial, which is more debuggable from the client.
create policy "predictions_waitlist_anon_insert"
  on public.predictions_waitlist for insert
  to anon, authenticated
  with check (true);

-- Deliberately no SELECT/UPDATE/DELETE policies — emails are not
-- publicly readable, and there's no client-side reason to update or
-- delete (admin can do both via service_role).

grant insert on public.predictions_waitlist to anon, authenticated;
