# 01 — On-chain Commit Layer

Status: **draft, overview only**. The detailed sections listed in the
table of contents below will be written in follow-up passes (one
section per prompt) so each can be reviewed and adjusted in isolation
before any code is written.

## Goal

Anchor the peptide market data produced by the existing scraper +
TWAP pipeline into Solana mainnet by committing cryptographic proofs
(Merkle roots and TWAP digests) to the chain via the Memo program.
Anyone holding the underlying Supabase row data should be able to
independently verify it matches what was committed on-chain — without
needing to trust the operator.

## High-level architecture

A new committer service polls the existing scraper / worker pipeline
for completed cycles and computed TWAPs, builds a canonical digest of
each, and submits a single Solana Memo transaction per digest. Hashes
go on-chain; full row data stays in Supabase. A single hot wallet on
the server signs and submits autonomously (no multisig in v1, no
custom Anchor program in v1). Submission state — Solana signature,
slot, status, error — is recorded back into new commit-tracking
tables so the verification API can correlate any database row with
its on-chain proof. Read endpoints expose the cycle commits, TWAP
commits, and per-observation Merkle proofs so a third party can
verify "yes, this row was anchored to the chain at this signature."

## Two commit types

### Cycle Merkle root commit

After every scrape cycle (currently every 10 minutes), the committer
takes every `supplier_observations` row produced by that cycle,
canonically serializes each one, hashes them into Merkle leaves, and
combines them into a single 32-byte root. The root + cycle metadata
(cycle id, timestamps, observation count) is written into a Memo
instruction and sent to Solana. This anchors the entire batch in one
transaction. To prove a single observation later, the verifier
recomputes the leaf hash, walks the proof up to the committed root,
and checks the Memo on-chain matches the database record.

### TWAP commit

Every hour, for each tracked peptide, the committer takes the most
recently computed `peptide_twaps` row and writes its key fields —
peptide code, twap value (full numeric precision), the time window
it covers, and the Merkle root of the observation set that fed it —
into a Memo and submits to Solana. This anchors the canonical TWAP
the project publishes, so any consumer (a smart contract, a UI, an
auditor) can fetch the on-chain TWAP at time T and confirm it
matches the value stored off-chain. The `observation_set_root` field
links each TWAP commit back to the cycle commits whose observations
contributed, so the chain of evidence runs all the way down to
individual price observations.

## Table of contents (sections to be drafted separately)

Each section below will land as its own follow-up doc edit. Numbers
are stable so cross-references in implementation work later won't
break if sections grow.

1. **Database schema** —
   `commit_cycles`, `twap_commits`, `commit_observations`. Migration
   SQL drafted but not applied (`packages/db/migrations/0031_add_commit_tracking.sql`).
2. **Memo format specifications** —
   exact canonical JSON layout for each commit type, ordering rules,
   size budget, version field semantics.
3. **Backend service architecture** —
   where the committer lives in the workspace (new `apps/oracle` vs
   inside `apps/worker`), polling vs event model for cycle detection,
   keypair handling, RPC choice, retry strategy, write-then-update
   pattern for the "Solana confirmed but DB write failed" race.
4. **Merkle tree construction** —
   canonical observation serialization, hash function, leaf/internal
   domain separation, ordering, odd-count handling, output format.
   The whole point is determinism — anyone with the same row data
   recomputes the same root.
5. **Verification flow** —
   end-to-end story: how a third party with an observation row
   reproduces the leaf, fetches the proof, walks to the root, and
   confirms the Memo on Solana matches the database record.
6. **API endpoints** —
   `GET /api/commits/cycles/:cycle_id`,
   `GET /api/commits/cycles/:cycle_id/proof?observation_id=X`,
   `GET /api/commits/twap?peptide_code=X&at=<timestamp>`.
   Response shapes and error codes.
7. **Cost analysis** —
   144 cycle commits/day + 24 TWAP commits/day per tracked peptide
   × N peptides; base fee + priority fee; daily / annual SOL +
   USD figures with a sensitivity table for fee scenarios.
8. **Operational runbook** —
   keypair provisioning + rotation, balance monitoring + alert
   thresholds, devnet → mainnet promotion, backfill procedure for
   missed commits, what to do if the RPC provider goes down.
9. **Open questions / decisions needed from you** —
   choices that affect the spec and need a call before implementation
   starts (priority-fee policy, RPC provider, peptide subset for v1
   TWAP commits, etc.).

## Out of scope for this phase (carried forward from the brief)

- Frontend explorer
- Peptide token contracts
- Reserve wallet infrastructure
- Pump.fun integration
- Custom Anchor program
- Multi-sig signing
- Arweave permanent storage
