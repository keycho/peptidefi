-- 0037_verification_attestation_columns.sql
-- Three new columns on commit_cycles + twap_commits, populated at
-- finalization from getTransaction(signature). The verifier compares
-- intent (memo_payload, oracle's intended memo at submission) against
-- attestation (the new *_at_finalization columns, fetched directly
-- from the chain). This makes every verification a
-- "intent-vs-on-chain" check instead of a "live-RPC-vs-stored" check,
-- and covers three failure modes the original design missed:
--
--   1. memo_payload was stored differently from what the tx actually
--      submitted (key-order drift across encoder versions, retroactive
--      JSON re-canonicalization, etc.). The verifier's check #6 was
--      `memo_payload == fetchOnChainMemo()` — so a corrupted
--      memo_payload always failed even when the chain was correct.
--      With onchain_memo_bytes captured AT FINALIZATION, the verifier
--      can now distinguish "the chain was right; memo_payload was
--      mutated" from "the chain itself doesn't match what we
--      submitted".
--
--   2. solana_slot was set from `getSignatureStatus().slot` at the
--      tick that observed finalization. That's normally correct but
--      empirically diverges from `getTransaction().slot` for some
--      cycles (network jitter, validator reorgs at finality boundary).
--      `confirmed_slot` is the canonical slot from getTransaction —
--      the same primitive the verifier reads.
--
--   3. authority_pubkey was nowhere — the verifier compared on-chain
--      signers against the CURRENT global PEPTIDE_ORACLE_AUTHORITY_
--      PUBKEY env var. Older devnet-era cycles signed by a different
--      keypair would always fail check #8 because the authority has
--      since been rotated. Stamping the actual signer at finalization
--      time gives the verifier a per-cycle reference, and lets a
--      future authority rotation not break verification of past
--      cycles.
--
-- All three columns are NULLABLE — existing rows stay null until a
-- backfill job populates them (see scripts/backfill-cycle-onchain.ts
-- in this PR). The verifier reads from the new columns when
-- present and falls back to the legacy columns for un-backfilled
-- rows, returning a specific failure code so an operator can tell
-- "verification failed" from "not yet backfilled".

-- ── up ─────────────────────────────────────────────────────────────

-- 1. commit_cycles
alter table public.commit_cycles
  add column if not exists onchain_memo_bytes text,
  add column if not exists authority_pubkey   text,
  add column if not exists confirmed_slot     bigint;

comment on column public.commit_cycles.onchain_memo_bytes is
  'UTF-8 memo bytes fetched from getTransaction at finalization. Verifier compares this against memo_payload to detect post-commit DB mutation. Null on legacy / unbackfilled rows.';
comment on column public.commit_cycles.authority_pubkey is
  'Base58 signer pubkey fetched from getTransaction at finalization. Verifier checks on-chain signers include this. Null on legacy / unbackfilled rows.';
comment on column public.commit_cycles.confirmed_slot is
  'Canonical slot from getTransaction at finalization. solana_slot remains the slot observed via getSignatureStatus at the finalization tick (kept for diagnostic comparison). Null on legacy / unbackfilled rows.';

-- 2. twap_commits — same three columns, same semantics
alter table public.twap_commits
  add column if not exists onchain_memo_bytes text,
  add column if not exists authority_pubkey   text,
  add column if not exists confirmed_slot     bigint;

comment on column public.twap_commits.onchain_memo_bytes is
  'UTF-8 memo bytes fetched from getTransaction at finalization. See commit_cycles.onchain_memo_bytes.';
comment on column public.twap_commits.authority_pubkey is
  'Base58 signer pubkey fetched from getTransaction at finalization. See commit_cycles.authority_pubkey.';
comment on column public.twap_commits.confirmed_slot is
  'Canonical slot from getTransaction at finalization. See commit_cycles.confirmed_slot.';

-- ── verification (run manually after apply) ──────────────────────
--   -- All three columns exist and default null:
--   select column_name, is_nullable from information_schema.columns
--    where table_schema='public' and table_name in ('commit_cycles','twap_commits')
--      and column_name in ('onchain_memo_bytes','authority_pubkey','confirmed_slot');
--
--   -- All existing finalized rows currently null on the new columns:
--   select count(*) from public.commit_cycles
--    where status='finalized' and (onchain_memo_bytes is null or authority_pubkey is null or confirmed_slot is null);
--   -- Operator runs scripts/backfill-cycle-onchain.ts to populate.

-- ── down (reversal block — run only on rollback) ──────────────────
-- begin;
-- alter table public.commit_cycles
--   drop column if exists confirmed_slot,
--   drop column if exists authority_pubkey,
--   drop column if exists onchain_memo_bytes;
-- alter table public.twap_commits
--   drop column if exists confirmed_slot,
--   drop column if exists authority_pubkey,
--   drop column if exists onchain_memo_bytes;
-- commit;
