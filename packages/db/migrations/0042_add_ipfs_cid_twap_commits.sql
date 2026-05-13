-- 0042_add_ipfs_cid_twap_commits.sql
-- IPFS audit-trail anchor for TWAP commits.
--
-- Adds an `ipfs_cid` column to public.twap_commits so that each
-- finalized TWAP commit can also reference the IPFS-pinned manifest
-- (full observation set + per-observation deviation metric + Solana
-- attestation) that records its provenance.
--
-- The relationship in v1 is:
--   Solana signature  →  on-chain commitment (cheap, ordered, censorable)
--   IPFS CID          →  off-chain audit trail (full body, content-addressed,
--                                              re-fetchable by any client)
--
-- See `apps/oracle/src/ipfs/pinata.ts` for the pin path. The pin is
-- fire-and-forget AFTER Solana finalization, so the column is
-- nullable: a row can be solana_signature populated + ipfs_cid null
-- when (a) pinning is disabled (no PINATA_JWT), or (b) the pin call
-- failed and is awaiting a retry queue (not implemented in this
-- migration; the column simply stays null until a future writer
-- backfills it).
--
-- Reversible. Down block at the bottom drops the index and column.

-- ── up ────────────────────────────────────────────────────────────

alter table public.twap_commits
  add column if not exists ipfs_cid text;

-- IPFS CIDv1 base32: starts with 'b' + ~58 base32 chars (length ~59);
-- CIDv0 base58btc: starts with 'Qm' + 44 chars (length 46). The
-- check tolerates both shapes so we don't have to migrate again if
-- Pinata changes default CID version. cidVersion: 1 is what the
-- oracle requests today.
alter table public.twap_commits
  add constraint twap_commits_ipfs_cid_shape
  check (
    ipfs_cid is null
    or ipfs_cid ~ '^[A-Za-z0-9]{40,80}$'
  );

-- Partial index — only the rows that have a CID matter for lookup.
-- Stays small even as twap_commits grows since CID is null until
-- pinning succeeds and never repopulates if pinning is disabled.
create index if not exists idx_twap_commits_ipfs_cid
  on public.twap_commits (ipfs_cid)
  where ipfs_cid is not null;

comment on column public.twap_commits.ipfs_cid is
  'IPFS content identifier (CIDv1 base32) of the cycle manifest pinned via Pinata after Solana finalization. NULL when pinning is disabled (no PINATA_JWT) or has not yet succeeded. Fetch the manifest at https://ipfs.io/ipfs/<cid> or any IPFS gateway. See docs/PUBLIC_API.md §IPFS for the manifest schema.';

-- ── down (reversal block — run only on rollback) ──────────────────
-- begin;
-- drop index if exists public.idx_twap_commits_ipfs_cid;
-- alter table public.twap_commits drop constraint if exists twap_commits_ipfs_cid_shape;
-- alter table public.twap_commits drop column if exists ipfs_cid;
-- commit;
