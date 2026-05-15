-- 0044_add_final_ipfs_cid_twap_commits.sql
-- BioHash Peptide Index pin-twice support.
--
-- Migration 0042 added `ipfs_cid` as the per-peptide manifest pin
-- written under the existing fire-and-forget pattern: TWAP finalizes
-- on Solana, manifest gets pinned within seconds, CID lands here.
-- Schema 1.0 manifests carry per-peptide TWAP data only.
--
-- Schema 1.1 (introduced by migration 0043 + the index-computer)
-- embeds the equal-weight BioHash Peptide Index level into every
-- per-peptide manifest. The level cannot be known at the time of
-- the FIRST pin -- it requires all cohort peptides to have finalized
-- for the same UTC hour. We resolve this with a pin-twice design:
--
--   1. First pin (existing path): runs at TWAP finalize time, manifest
--      carries `index_snapshot: null`. CID lands in `ipfs_cid` exactly
--      as today, preserving the existing seconds-after-finalize SLA.
--   2. Final pin (new path): runs once the cohort completes for the
--      hour, manifest carries the populated `index_snapshot`. CID
--      lands in `final_ipfs_cid` (this column).
--
-- API consumers receive `COALESCE(final_ipfs_cid, ipfs_cid)` plus a
-- new `pin_state: 'pre_cohort' | 'final'` flag so a verifier reading
-- the manifest at the surfaced CID knows whether to expect the
-- populated `index_snapshot` or null. See docs/PUBLIC_API.md.
--
-- This migration is ADDITIVE ONLY. The shape CHECK + partial index
-- mirror migration 0042's `ipfs_cid` pattern exactly, so dashboard
-- queries that filter by the existing pin column generalise naturally.
-- Reversible. Down block at the bottom drops the new objects.

-- == up ============================================================

alter table public.twap_commits
  add column if not exists final_ipfs_cid text;

-- Same shape tolerance as `ipfs_cid` in 0042: accepts CIDv1 base32
-- (length ~59) and CIDv0 base58btc (length 46). We do not want a
-- second pin shape regression if Pinata flips default CID version
-- between v1 and v2.
alter table public.twap_commits
  add constraint twap_commits_final_ipfs_cid_shape
  check (
    final_ipfs_cid is null
    or final_ipfs_cid ~ '^[A-Za-z0-9]{40,80}$'
  );

-- Partial index. Same rationale as idx_twap_commits_ipfs_cid in 0042:
-- only rows with a final CID matter for lookup. Stays small because
-- the column is null until the cohort completes and never repopulates
-- for hours where pinning is disabled.
create index if not exists idx_twap_commits_final_ipfs_cid
  on public.twap_commits (final_ipfs_cid)
  where final_ipfs_cid is not null;

comment on column public.twap_commits.final_ipfs_cid is
  'IPFS content identifier (CIDv1 base32) of the schema 1.1 cycle manifest pinned AFTER the cohort completes for this row''s hour and the index_snapshot can be populated. NULL when (a) the cohort has not yet completed for this hour, (b) pinning is disabled (no PINATA_JWT), or (c) the final pin attempt failed. The first-pin CID lives in ipfs_cid (migration 0042). API consumers surface COALESCE(final_ipfs_cid, ipfs_cid). See docs/PUBLIC_API.md, the index-history-runner, and migration 0043.';

-- == down (reversal block, run only on rollback) ===================
-- begin;
-- drop index if exists public.idx_twap_commits_final_ipfs_cid;
-- alter table public.twap_commits drop constraint if exists twap_commits_final_ipfs_cid_shape;
-- alter table public.twap_commits drop column if exists final_ipfs_cid;
-- commit;
