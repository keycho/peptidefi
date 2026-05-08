-- 0034_anomalies.sql
-- Public, append-only operational log for the BioHash oracle pipeline.
-- Every error, retry, manual action, and config change in the
-- scraper/oracle/peg-pusher/worker stack records here. Consumers
-- (Lovable frontend, RSS readers, future webhook fanout) read via the
-- public API at /api/anomalies/*.
--
-- Append-only contract (the credibility argument depends on this):
--
--   - SELECT: open to anon + authenticated (this is a public log).
--   - INSERT: only the service_role can insert (pipeline writers only).
--   - UPDATE: NO policy → blocked for every role under RLS.
--   - DELETE: NO policy → blocked for every role under RLS.
--
-- A manual UPDATE or DELETE attempt from the Supabase dashboard (which
-- runs as authenticated, NOT as the postgres owner) must fail. If it
-- ever succeeds, the operational-log credibility argument is broken
-- and the migration should be re-applied. Verification SQL is in the
-- block comment at the bottom.
--
-- Resolution linkage:
--   resolved_by → anomalies(id) lets a follow-up event reference the
--   original. Pattern: a "peg_pusher_lock_stuck" event of severity
--   'error' gets a "peg_pusher_lock_released" event later with
--   resolved_by = stuck.id and resolved_at populated. The frontend
--   can then render the stuck → released arc as a single resolved
--   incident. Self-FK is intentional and safe because INSERT is the
--   only mutation; a row can't be deleted out from under a referrer.
--
-- Foreign keys to scraper/oracle entities (vendor_id, peptide_id,
-- observation_id, cycle_id) are deliberately TEXT/BIGINT WITHOUT FKs.
-- The log is meant to outlive any of those entities — if a vendor is
-- decommissioned and its row vanishes, the historical anomaly entries
-- about it must remain. peptide_id / vendor_id are stable codes
-- (e.g. "BPC157", "VENDOR_X") rather than numeric ids for the same
-- reason: codes are public-stable, ids are internal.

-- ── up ─────────────────────────────────────────────────────────────

create table if not exists public.anomalies (
  id              bigserial primary key,
  occurred_at     timestamptz not null default now(),
  severity        text not null check (severity in ('info', 'warn', 'error', 'critical')),
  event_type      text not null,
  vendor_id       text,
  peptide_id      text,
  observation_id  bigint,
  cycle_id        bigint,
  description     text not null,
  context         jsonb,
  resolved_at     timestamptz,
  resolved_by     bigint references public.anomalies(id),
  created_at      timestamptz not null default now()
);

-- Time-descending list query (the API's primary read).
create index if not exists anomalies_occurred_at_idx
  on public.anomalies (occurred_at desc);

-- Severity + event-type filters (severity + event_type combo is the
-- common Lovable-frontend filter; separate single-column indexes
-- combine cheaply at query time).
create index if not exists anomalies_severity_idx
  on public.anomalies (severity);

create index if not exists anomalies_event_type_idx
  on public.anomalies (event_type);

-- Partial indexes for entity-scoped filters (vendor / peptide). Most
-- rows have at least one of these null (a config-change event has
-- neither; a vendor-recovered event has only vendor_id), so partial
-- indexes save ~half the storage vs. unconditional.
create index if not exists anomalies_vendor_idx
  on public.anomalies (vendor_id) where vendor_id is not null;

create index if not exists anomalies_peptide_idx
  on public.anomalies (peptide_id) where peptide_id is not null;

-- ── RLS: append-only contract ─────────────────────────────────────

alter table public.anomalies enable row level security;

-- Public read.
drop policy if exists "anomalies_select_public" on public.anomalies;
create policy "anomalies_select_public"
  on public.anomalies for select
  to anon, authenticated using (true);

-- Service-role insert. Other roles (anon, authenticated, dashboard
-- user) have no INSERT policy and therefore cannot write under RLS.
drop policy if exists "anomalies_insert_service_role" on public.anomalies;
create policy "anomalies_insert_service_role"
  on public.anomalies for insert
  to service_role with check (true);

-- No UPDATE, no DELETE policy on purpose. RLS denies by default; this
-- makes the table append-only for every role, including service_role.
-- Re-running the migration is safe: the missing policies are not
-- recreated, so deny-by-default holds.

-- Grant raw table privileges aligned with the policies. (`grant
-- select on table to anon` is required in addition to the SELECT
-- policy — RLS gates rows visible per-policy, but the basic table
-- privilege still has to be granted.)
grant select on public.anomalies to anon, authenticated;
grant insert on public.anomalies to service_role;
grant usage, select on sequence public.anomalies_id_seq to service_role;

comment on table public.anomalies is
  'Append-only operational log. RLS: public read, service_role insert, no update/delete. See migration 0034 header for the credibility contract.';

-- ── verification (run manually after apply) ──────────────────────
-- Both of these MUST fail when run from the Supabase dashboard SQL
-- editor (which runs as authenticated). If either succeeds, the
-- append-only contract is broken — re-check the policies above.
--
--   -- Should fail: no UPDATE policy.
--   update public.anomalies set description = 'tampered' where id = 1;
--
--   -- Should fail: no DELETE policy.
--   delete from public.anomalies where id = 1;
--
-- A service-role insert (run via the API or oracle's logger) must
-- succeed. Anon SELECT must succeed.

-- ── down (reversal block — run only on rollback) ──────────────────
-- begin;
-- drop policy if exists "anomalies_select_public"        on public.anomalies;
-- drop policy if exists "anomalies_insert_service_role"  on public.anomalies;
-- alter table public.anomalies disable row level security;
-- drop index if exists anomalies_peptide_idx;
-- drop index if exists anomalies_vendor_idx;
-- drop index if exists anomalies_event_type_idx;
-- drop index if exists anomalies_severity_idx;
-- drop index if exists anomalies_occurred_at_idx;
-- drop table if exists public.anomalies;
-- commit;
