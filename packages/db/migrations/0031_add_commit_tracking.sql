-- 0031_add_commit_tracking.sql
-- Tables that record on-chain commit attempts for the peptide-oracle
-- on-chain commit layer.
--
-- ⚠️ NOT APPLIED to any database at the time this file lands. The
-- peptide-oracle-pivot branch currently shares biohack.market's
-- production Supabase database; running this migration there would
-- pollute production with tables that no committer service writes
-- to. This migration runs when the new direction has its own
-- Supabase project (or when we explicitly decide to add the tables
-- to the existing one).
--
-- Three tables + one enum:
--   public.commit_status         enum (pending | submitted | confirmed | failed)
--   public.commit_cycles         one row per scrape cycle anchored on Solana
--   public.twap_commits          one row per TWAP commit
--   public.commit_observations   junction: observation ↔ cycle + leaf hash
--
-- See docs/specs/01-onchain-commit-layer/01-database-schema.md for
-- the rationale behind every column, index, and policy.
--
-- The migration is strictly additive: nothing is dropped, no
-- existing schema is mutated. It depends on the existing
--   public.scraper_runs              (created in 0004)
--   public.supplier_observations     (created in 0004)
-- both of which are kept by the strip migration in 0030.

-- ─── 1. commit_status enum ────────────────────────────────────
do $$
begin
  if not exists (select 1 from pg_type where typname = 'commit_status') then
    create type public.commit_status as enum (
      'pending',     -- row inserted, no submission attempt yet
      'submitted',   -- tx sent to RPC, awaiting confirmation
      'confirmed',   -- landed in a slot; signature + slot populated
      'failed'       -- exhausted retry budget; last_error populated
    );
  end if;
end$$;

-- ─── 2. commit_cycles ──────────────────────────────────────────
-- One row per scrape cycle that is anchored on Solana via a Memo
-- transaction. Cycles with zero successful observations are not
-- committed (per spec §02.4.5) and never get a row here.
create table if not exists public.commit_cycles (
  cycle_id           bigint primary key
                     references public.scraper_runs(id) on delete restrict,
  started_at         timestamptz not null,
  completed_at       timestamptz not null,
  observation_count  integer not null check (observation_count > 0),
  merkle_root        text not null
                     check (merkle_root ~ '^0x[0-9a-f]{64}$'),
  memo_payload       text not null,
  solana_signature   text
                     check (solana_signature is null
                            or length(solana_signature) between 64 and 128),
  solana_slot        bigint
                     check (solana_slot is null or solana_slot > 0),
  status             public.commit_status not null default 'pending',
  submitted_at       timestamptz,
  confirmed_at       timestamptz,
  retry_count        integer not null default 0 check (retry_count >= 0),
  last_error         text,
  created_at         timestamptz not null default now()
);

create index if not exists idx_commit_cycles_status
  on public.commit_cycles (status);
create index if not exists idx_commit_cycles_completed_at
  on public.commit_cycles (completed_at desc);
-- Partial index on non-terminal rows for the committer's polling
-- query. Stays bounded to in-flight work; confirmed/failed rows
-- fall out automatically on update.
create index if not exists idx_commit_cycles_pending_work
  on public.commit_cycles (created_at)
  where status in ('pending', 'submitted');

alter table public.commit_cycles enable row level security;
drop policy if exists "commit_cycles_select_public" on public.commit_cycles;
create policy "commit_cycles_select_public"
  on public.commit_cycles for select
  to anon, authenticated using (true);
grant select on public.commit_cycles to anon, authenticated;

-- ─── 3. twap_commits ───────────────────────────────────────────
-- One row per TWAP commit. v1 cadence: hourly per active peptide.
-- The unique constraint on (peptide_code, computed_at) provides
-- idempotency: re-running the committer for the same hour returns
-- the existing row instead of inserting a duplicate.
create table if not exists public.twap_commits (
  id                    uuid primary key default gen_random_uuid(),
  peptide_code          text not null,
  twap_value            numeric not null,
  computed_at           timestamptz not null,
  window_start          timestamptz not null,
  window_end            timestamptz not null
                        check (window_end > window_start),
  observation_set_root  text not null
                        check (observation_set_root ~ '^0x[0-9a-f]{64}$'),
  memo_payload          text not null,
  solana_signature      text
                        check (solana_signature is null
                               or length(solana_signature) between 64 and 128),
  solana_slot           bigint
                        check (solana_slot is null or solana_slot > 0),
  status                public.commit_status not null default 'pending',
  submitted_at          timestamptz,
  confirmed_at          timestamptz,
  retry_count           integer not null default 0 check (retry_count >= 0),
  last_error            text,
  created_at            timestamptz not null default now()
);

create index if not exists idx_twap_commits_peptide_computed_at
  on public.twap_commits (peptide_code, computed_at desc);
create index if not exists idx_twap_commits_status
  on public.twap_commits (status);
create index if not exists idx_twap_commits_observation_set_root
  on public.twap_commits (observation_set_root);
create index if not exists idx_twap_commits_pending_work
  on public.twap_commits (created_at)
  where status in ('pending', 'submitted');

create unique index if not exists uniq_twap_commits_peptide_computed_at
  on public.twap_commits (peptide_code, computed_at);

alter table public.twap_commits enable row level security;
drop policy if exists "twap_commits_select_public" on public.twap_commits;
create policy "twap_commits_select_public"
  on public.twap_commits for select
  to anon, authenticated using (true);
grant select on public.twap_commits to anon, authenticated;

-- ─── 4. commit_observations ────────────────────────────────────
-- Junction table linking each successful observation that was
-- anchored on-chain to the cycle commit that anchored it. Stores
-- the leaf hash and ordered position in the Merkle tree so proof
-- generation doesn't need to recanonicalize and rehash.
create table if not exists public.commit_observations (
  observation_id  bigint not null
                  references public.supplier_observations(id) on delete restrict,
  cycle_id        bigint not null
                  references public.commit_cycles(cycle_id) on delete cascade,
  leaf_hash       text not null
                  check (leaf_hash ~ '^0x[0-9a-f]{64}$'),
  leaf_index      integer not null check (leaf_index >= 0),
  primary key (observation_id, cycle_id)
);

create index if not exists idx_commit_observations_cycle_id
  on public.commit_observations (cycle_id, leaf_index);
create index if not exists idx_commit_observations_observation_id
  on public.commit_observations (observation_id);

alter table public.commit_observations enable row level security;
drop policy if exists "commit_observations_select_public" on public.commit_observations;
create policy "commit_observations_select_public"
  on public.commit_observations for select
  to anon, authenticated using (true);
grant select on public.commit_observations to anon, authenticated;

-- ─── 5. Comments (for psql \d+ readability) ────────────────────
comment on table public.commit_cycles is
  'One row per scrape cycle anchored on Solana via Memo transaction. See docs/specs/01-onchain-commit-layer/01-database-schema.md.';
comment on table public.twap_commits is
  'One row per TWAP commit on Solana via Memo transaction. Hourly per active peptide.';
comment on table public.commit_observations is
  'Junction table linking individual observations to the cycle commit that anchored them. Stores leaf hash + ordered tree position for proof generation.';
comment on column public.commit_cycles.merkle_root is
  '32-byte SHA-256 root; format: 0x followed by 64 lowercase hex chars.';
comment on column public.commit_cycles.memo_payload is
  'Canonical JSON memo body sent on-chain; stored verbatim for verification.';
comment on column public.twap_commits.observation_set_root is
  'Merkle root over the observations that fed this TWAP. Not necessarily equal to a cycle merkle_root since TWAP windows can span multiple cycles.';
comment on column public.commit_observations.leaf_index is
  '0-indexed position in the ordered Merkle tree. Used to derive the proof path.';
