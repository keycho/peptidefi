-- 0043_biohash_peptide_index.sql
-- BioHash Peptide Index, hourly equal-weight level over the 32 tracked peptides.
--
-- Companion to migration 0042 (ipfs_cid). Adds two columns to
-- twap_commits so every per-peptide row records the index level
-- computed for the same hour it belongs to, and two new tables that
-- store the per-hour index history and the per-peptide baseline TWAP
-- snapshot used as the denominator in the index formula.
--
-- Design summary (locked decisions, see §BioHash Index spec):
--
--   - Equal weight: each of the 32 peptides contributes 1/32 of the
--     index level, regardless of market cap.
--   - Baseline date: 2026-03-01. Baseline level: 1000.00. Each peptide
--     stores a baseline_twap snapshot from that date (or its earliest
--     finalized TWAP if the peptide started observation later, captured
--     by index_baselines.actual_baseline_date).
--   - Hourly cadence: the index is computed for hour H only when all
--     32 peptides have a finalized TWAP for hour H. Partial hours are
--     skipped entirely. No retroactive re-pinning of past manifests.
--   - Manifest schema bumps to 1.1 in app code, see
--     apps/oracle/src/ipfs/manifest-builder.ts. The same level value
--     written to twap_commits.index_level is embedded in each of the
--     32 manifests pinned for that hour, so the cryptographic record
--     in IPFS includes the index level alongside the per-peptide TWAP.
--
-- This migration is ADDITIVE ONLY. It does not modify columns added
-- by 0042 or any earlier migration, and the new columns on
-- twap_commits are nullable so historical rows remain untouched.
-- Reversible. Down block at the bottom drops the new objects.

-- == up ============================================================

-- 1. Per-row hourly index attribution on twap_commits.
--
-- index_level is the equal-weight index value for the same hour as
-- this row's computed_at. Populated for all 32 rows of a given hour
-- in a single transaction once the 32nd peptide finalizes. NULL when
-- the hour was skipped (fewer than 32 finalized) or when the row was
-- written before this feature shipped.
--
-- index_components_hash is sha256(JSON.stringify(sorted [{peptide_code,
-- twap_value, weight}])) for the components vector used to compute
-- index_level. Same value across all 32 rows for a given hour. Lets a
-- client reconstruct the components vector deterministically from a
-- manifest without trusting our API.

alter table public.twap_commits
  add column if not exists index_level numeric;

alter table public.twap_commits
  add column if not exists index_components_hash text;

-- Hash is sha256 hex (64 lowercase hex chars). Permissive shape
-- check, mirroring the ipfs_cid pattern from 0042.
alter table public.twap_commits
  add constraint twap_commits_index_components_hash_shape
  check (
    index_components_hash is null
    or index_components_hash ~ '^[0-9a-f]{64}$'
  );

-- Partial index. Same rationale as idx_twap_commits_ipfs_cid in 0042:
-- only rows with a computed index level matter for lookup, and the
-- column stays NULL for skipped hours and for historical rows.
create index if not exists idx_twap_commits_index_level
  on public.twap_commits (index_level)
  where index_level is not null;

comment on column public.twap_commits.index_level is
  'Equal-weight BioHash Peptide Index level (baseline 1000.00 on 2026-03-01) for the hour this TWAP commit belongs to. Written for all 32 rows of a given hour in one transaction once the 32nd peptide finalizes. NULL when the hour was skipped (fewer than 32 finalized) or the row predates the index feature. See migration 0043 and apps/oracle/src/index-computer.ts.';

comment on column public.twap_commits.index_components_hash is
  'sha256 (lowercase hex) of the components vector used to compute index_level: JSON.stringify of a sorted array of {peptide_code, twap_value, weight: 1/32}. Same value across all 32 rows of a given hour. Lets auditors reconstruct the index components deterministically from an IPFS-pinned manifest. NULL when index_level is NULL.';

-- 2. Per-hour index history.
--
-- One row per UTC hour for which all 32 peptides finalized. hour_start
-- is a timestamptz pinned to the top of the hour, matching the same
-- semantics as twap_commits.computed_at (also top-of-hour timestamptz)
-- so the index computer + writer never needs an epoch-seconds
-- conversion at the boundary. The CHECK constraint enforces the
-- truncation invariant in the database itself, so a malformed insert
-- fails fast rather than silently storing a sub-hour offset.
--
-- ipfs_cids is the array of the 32 CIDs pinned for the hour, in
-- peptide_code-sorted order so a client can deterministically match
-- an index row to its manifests.
--
-- computed_at is the wall-clock timestamp at which the row itself was
-- written (i.e. when the 32nd peptide finalized and the computer ran).
-- The PK on hour_start serves all time-range queries; no secondary
-- index on computed_at is needed.

create table if not exists public.index_history (
  hour_start      timestamptz   primary key,
  level           numeric       not null,
  components_hash text          not null,
  computed_at     timestamptz   not null,
  baseline_date   date          not null,
  baseline_level  numeric       not null,
  ipfs_cids       text[]        null,
  constraint index_history_components_hash_shape
    check (components_hash ~ '^[0-9a-f]{64}$'),
  constraint index_history_hour_start_truncated
    check (date_trunc('hour', hour_start) = hour_start)
);

comment on table public.index_history is
  'BioHash Peptide Index per-hour history. One row per UTC hour for which all 32 active peptides had a finalized TWAP. Equal-weight, baseline 1000.00 on 2026-03-01. See migration 0043 and apps/oracle/src/index-computer.ts.';

comment on column public.index_history.hour_start is
  'Top-of-hour UTC timestamp, matching twap_commits.computed_at semantics. CHECK constraint enforces date_trunc(''hour'', hour_start) = hour_start so the truncation invariant is guaranteed at the storage layer.';

comment on column public.index_history.level is
  'Index level at this hour. Sum over 32 peptides of (current_twap / baseline_twap) * (1000 / 32).';

comment on column public.index_history.components_hash is
  'sha256 (lowercase hex) of the components vector used to compute level. Matches twap_commits.index_components_hash on every row for this hour.';

comment on column public.index_history.computed_at is
  'Wall-clock timestamp at which this row was written, i.e. when the 32nd peptide finalized and the index was computed. Distinct from hour_start (which is the index hour itself).';

comment on column public.index_history.ipfs_cids is
  'CIDs of the 32 cycle manifests pinned for this hour, in peptide_code-sorted order. NULL when pinning was disabled (no PINATA_JWT) for any of the 32 rows. Manifests embed the same level in their index_snapshot field.';

-- 3. Per-peptide baseline TWAP snapshot.
--
-- Filled once by apps/oracle/scripts/compute-baseline-twaps.ts during
-- the index launch. Read-only thereafter (the oracle never rewrites
-- baselines). actual_baseline_date differs from baseline_date when
-- the peptide started observation after 2026-03-01 and the script
-- fell back to that peptide's earliest finalized TWAP.

create table if not exists public.index_baselines (
  peptide_code          text        primary key,
  baseline_twap         numeric     not null,
  baseline_date         date        not null,
  actual_baseline_date  date        not null
);

comment on table public.index_baselines is
  'Per-peptide baseline TWAP snapshot for the BioHash Peptide Index denominator. Filled once by apps/oracle/scripts/compute-baseline-twaps.ts. Read-only after launch.';

comment on column public.index_baselines.baseline_date is
  'Configured baseline date for the index, currently 2026-03-01 across all peptides.';

comment on column public.index_baselines.actual_baseline_date is
  'Date of the finalized TWAP whose value is recorded in baseline_twap. Equal to baseline_date when the peptide had a finalized TWAP on that date; otherwise the earliest finalized TWAP date observed for that peptide.';

-- == down (reversal block, run only on rollback) ===================
-- begin;
-- drop table if exists public.index_baselines;
-- drop table if exists public.index_history;
-- drop index if exists public.idx_twap_commits_index_level;
-- alter table public.twap_commits drop constraint if exists twap_commits_index_components_hash_shape;
-- alter table public.twap_commits drop column if exists index_components_hash;
-- alter table public.twap_commits drop column if exists index_level;
-- commit;
