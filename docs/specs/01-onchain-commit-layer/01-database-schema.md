# 01 — Database schema (commit tracking)

Status: **draft, not applied**. The migration file
`packages/db/migrations/0031_add_commit_tracking.sql` is committed
to the repo for review but is **NOT** applied to any database. The
peptide-oracle-pivot branch currently shares biohack.market's
production Supabase database; running this migration there would
add commit-tracking tables that no committer service writes to,
polluting production.

Three new tables and one enum, all in the `public` schema. They
sit downstream of the existing `scraper_runs` and
`supplier_observations` tables — every commit references rows that
already exist in those — and are written to exclusively by the
committer service (specified in §3, the next section to land).

## Why this section is mostly mechanical

The cryptographic primitives spec (§02) already locked the on-chain
contract: what a memo looks like, what fields a leaf hashes, what
the Merkle root is. Most columns here just record the values from
that contract alongside the Solana submission state (signature,
slot, status). The schema's job is "remember every commit attempt
in enough detail to serve verification queries and recover from
failures."

## Decision summary

Three decisions the brief asked for, settled below in §1.7. Quick
version:

1. **Hashes stored as `text` (`0x` + 64 lowercase hex)**, not bytea.
   Storage cost difference is negligible at our scale (~2 MB/year);
   the operational benefits — direct-match queries, byte-identical
   comparison with on-chain memo strings, easy log readability —
   outweigh it.
2. **Yes, partial index on non-terminal status.** One partial index
   per commit table: `WHERE status IN ('pending', 'submitted')`.
   Stays bounded to in-flight rows (typically dozens, rarely more),
   keeps committer polling cheap as the table grows.
3. **No deletes; `status='failed'` is the soft-delete signal.** The
   tables are an audit trail. A failed commit attempt is data —
   it tells us when commits didn't make it on-chain. Truncating
   would erase exactly the evidence we'd want during incident
   review.

## 1.1 commit_cycles

One row per scrape cycle that we anchor on Solana. Cycles with
zero successful observations or that we deliberately skip never
get a row here (per §02.4.5: zero-observation cycles aren't
committed in v1).

| column              | type                  | notes                                                                            |
| ------------------- | --------------------- | -------------------------------------------------------------------------------- |
| `cycle_id`          | bigint, PK            | FK → `scraper_runs.id`. The scraper's own cycle id is the natural key. ON DELETE RESTRICT. |
| `started_at`        | timestamptz, not null | Mirror of `scraper_runs.started_at`. Stored locally so the committer can build the memo without re-joining. |
| `completed_at`      | timestamptz, not null | Mirror of `scraper_runs.finished_at`.                                            |
| `observation_count` | integer, not null     | `CHECK (> 0)`. Number of leaves in the Merkle tree.                              |
| `merkle_root`       | text, not null        | `CHECK (~ '^0x[0-9a-f]{64}$')`. The 32-byte SHA-256 root from §02.4.5.           |
| `memo_payload`      | text, not null        | Canonical JSON memo body that was sent on-chain (per §02.2.2). Stored verbatim for verification: a third party can re-canonicalize and compare. |
| `solana_signature`  | text, nullable        | Base58 transaction signature. NULL until submitted.                              |
| `solana_slot`       | bigint, nullable      | Slot the transaction reached finality in. NULL until finalized.                  |
| `status`            | enum `commit_status`  | `pending` → `submitted` → `finalized` \| `failed`. Default `pending`.            |
| `submitted_at`      | timestamptz, nullable | Set when the committer hands the signed tx to the RPC.                           |
| `finalized_at`      | timestamptz, nullable | Set when on-chain finality is reached (per §03.4.5).                             |
| `retry_count`       | integer, not null     | `CHECK (>= 0)`. Default 0. Increments on each retry attempt.                     |
| `last_error`        | text, nullable        | Most recent error message, freeform. Cleared on successful finalization.         |
| `created_at`        | timestamptz, not null | Default `now()`.                                                                 |

**Indexes:**

```
PRIMARY KEY (cycle_id)
INDEX        (status)
INDEX        (completed_at DESC)
PARTIAL IDX  (created_at) WHERE status IN ('pending', 'submitted')
```

The partial index handles the committer's "give me the oldest
non-terminal commit" poll. As rows transition to `finalized` or
`failed` they drop out of the index, so it stays bounded by
in-flight work.

**memo_payload column rationale (added beyond the brief):** at
verification time, a third party hits `GET /api/commits/cycles/:id`
and we need to return what we sent on-chain so they can compare it
against the on-chain Memo (which they fetch independently from
Solana RPC). We *could* recompute the canonical JSON from the row's
other columns, but that doubles the canonicalization surface — any
bug in the recomputation breaks verification. Storing the exact
bytes we sent removes that risk.

## 1.2 twap_commits

One row per TWAP commit. v1 cadence: hourly per active peptide
(the active subset is the open question in §9 of the parent doc).

| column                 | type                  | notes                                                                                       |
| ---------------------- | --------------------- | ------------------------------------------------------------------------------------------- |
| `id`                   | uuid, PK              | Default `gen_random_uuid()`. Same shape as `prediction_bets.id` was in the upstream pivot.  |
| `peptide_code`         | text, not null        | E.g. `"BPC157"`. No FK to `peptides.code` — the commit table outlives any future renames.   |
| `twap_value`           | numeric, not null     | Full Postgres `numeric` precision; `column::text` form is the canonical wire form (§02.2.5). |
| `computed_at`          | timestamptz, not null | The TWAP's authoritative timestamp (mirrors `peptide_twaps.computed_at`).                   |
| `window_start`         | timestamptz, not null | TWAP window lower bound.                                                                    |
| `window_end`           | timestamptz, not null | `CHECK (window_end > window_start)`.                                                        |
| `observation_set_root` | text, not null        | `CHECK (~ '^0x[0-9a-f]{64}$')`. Merkle root over the observations that fed this TWAP.       |
| `memo_payload`         | text, not null        | Canonical JSON memo body sent on-chain (§02.2.3).                                           |
| `solana_signature`     | text, nullable        | Same shape as `commit_cycles`.                                                              |
| `solana_slot`          | bigint, nullable      |                                                                                             |
| `status`               | enum `commit_status`  | Same enum, same defaults.                                                                   |
| `submitted_at`         | timestamptz, nullable |                                                                                             |
| `finalized_at`         | timestamptz, nullable |                                                                                             |
| `retry_count`          | integer, not null     | Default 0.                                                                                  |
| `last_error`           | text, nullable        |                                                                                             |
| `created_at`           | timestamptz, not null | Default `now()`.                                                                            |

**Indexes:**

```
PRIMARY KEY (id)
INDEX       (peptide_code, computed_at DESC)
INDEX       (status)
INDEX       (observation_set_root)
PARTIAL IDX (created_at) WHERE status IN ('pending', 'submitted')
UNIQUE      (peptide_code, computed_at)
```

The unique constraint on `(peptide_code, computed_at)` is
**idempotency**. The committer's job for any given hour is to
commit one TWAP per peptide. If the committer crashes after
inserting the row and before submitting the transaction, restart
should re-find the row by `(peptide_code, computed_at)` and pick
up where it left off rather than insert a duplicate. The same
constraint also protects against accidental double-commits if the
hourly tick fires twice.

**`observation_set_root` is NOT a foreign key** to
`commit_cycles.merkle_root`. Two reasons: (1) a TWAP window is
typically 1 hour, which spans ~6 cycles, so the TWAP's
`observation_set_root` is computed fresh over the window's
contributing observations and won't equal any single cycle's root.
(2) Even if a TWAP ever happened to cover exactly one cycle's
worth of observations, the same root could legitimately recur
(e.g. zero-observation edge cases) — making it FK'd would force
artificial uniqueness. The verification flow (§5) walks via the
junction table instead of an FK.

**No `cycle_id` column either.** A TWAP doesn't belong to a single
cycle. The verifier's path is: TWAP commit →
`peptide_twaps.input_observation_ids` (already in the schema) →
`commit_observations` rows for those observation_ids → cycle
commits anchoring each. This is documented in §05 (verification
flow) and is fine without a denormalized `cycle_id` column.

## 1.3 commit_observations

Junction table. One row per (observation, cycle) pair where the
observation was a leaf in that cycle's Merkle tree. In v1 each
observation belongs to exactly one cycle, so this is effectively
1:1, but the (observation_id, cycle_id) composite primary key
keeps the schema honest if a future protocol ever re-anchors an
observation under multiple cycles (e.g. corrective re-commits).

| column           | type                | notes                                                              |
| ---------------- | ------------------- | ------------------------------------------------------------------ |
| `observation_id` | bigint, not null    | FK → `supplier_observations(id)`. ON DELETE RESTRICT.              |
| `cycle_id`       | bigint, not null    | FK → `commit_cycles(cycle_id)`. ON DELETE CASCADE.                 |
| `leaf_hash`      | text, not null      | `CHECK (~ '^0x[0-9a-f]{64}$')`. SHA-256 of the canonical leaf (§02.4.3). Stored so proof requests don't need to recanonicalize and rehash. |
| `leaf_index`     | integer, not null   | `CHECK (>= 0)`. Position in the ordered tree (0-indexed). Used to derive the Merkle proof path. |

```
PRIMARY KEY (observation_id, cycle_id)
INDEX       (cycle_id, leaf_index)
INDEX       (observation_id)
```

The `(cycle_id, leaf_index)` composite index serves Merkle proof
construction: given a `cycle_id`, fetch all leaves in order to walk
the tree. The `(observation_id)` index serves the reverse lookup
("which cycle was this observation anchored in?") for the
`/api/commits/cycles/:cycle_id/proof` and verification flows.

ON DELETE behavior: RESTRICT on `observation_id` (we never want a
historical observation to vanish from a row that's been anchored
on-chain — that'd break verification). CASCADE on `cycle_id` is
mostly a defensive default; in practice cycle commit rows aren't
deleted either.

## 1.4 commit_status enum

```
CREATE TYPE commit_status AS ENUM (
  'pending',     -- row inserted, no submission attempt yet
  'submitted',   -- tx sent to RPC, awaiting finalization
  'finalized',   -- finality reached on-chain; signature + slot populated
  'failed'       -- exhausted retry budget; last_error populated
);
```

State transitions (no other transitions are valid):

```
   pending ──▶ submitted ──▶ finalized   (happy path)
      │           │
      │           └─▶ pending             (retry: finalization timeout)
      │
      └─▶ failed                          (after retry budget exhausted)
```

The `submitted → pending` transition is for the case where a
transaction was sent but never reached finality within the timeout.
The committer reverts to `pending`, increments `retry_count`,
refreshes the recent blockhash, and tries again. After N retries
(the value lives in the service spec in §3), terminal `failed` is
set.

## 1.5 RLS policy

These tables hold cryptographic commit state, not user data. Every
field is derivable from `scraper_runs` + `supplier_observations` +
`peptide_twaps` (which are already publicly readable per migrations
0010 and 0023) plus the on-chain Memo (which is already public on
Solana). Making them publicly readable lets the verification API
work without a service-role client. No risk surface.

Policies in the migration:

```
ENABLE ROW LEVEL SECURITY on all three tables;
CREATE POLICY commit_cycles_select_public        ... TO anon, authenticated USING (true);
CREATE POLICY twap_commits_select_public         ... TO anon, authenticated USING (true);
CREATE POLICY commit_observations_select_public  ... TO anon, authenticated USING (true);
GRANT SELECT to anon, authenticated;
```

No INSERT/UPDATE/DELETE policies — only the committer service
(running with service-role) writes. Same pattern as
`peptide_twaps` and `supplier_observations`.

## 1.6 Migration file

`packages/db/migrations/0031_add_commit_tracking.sql`. Idempotent
(`IF NOT EXISTS` everywhere). Drops nothing — strictly additive on
top of the existing `scraper_runs` + `supplier_observations` schema.

The migration is shipped as a draft for review. **Do not apply to
the production database** until either (a) the new direction has
its own Supabase project, or (b) we've explicitly decided to add
the tables to biohack.market's database (deferred decision).

## 1.7 Decisions addressed

### 1.7.1 bytea vs text for hashes

**Decision: text.** Specifically, `text` columns with a CHECK
constraint enforcing the format `0x` + 64 lowercase hex characters.

Pros for text (chosen):
- Direct match with the on-chain memo format (§02.2.2 / §02.2.3 spec
  the on-wire string as `0x` + 64 hex). A verifier can pull a
  `commit_cycles` row, fetch the on-chain Memo, and compare strings
  byte-for-byte without any binary↔hex marshalling.
- Readable in psql, log lines, and supabase-js queries by default.
  bytea returns either `\x...` escape-encoded strings or hex via a
  driver-specific path, both of which add friction.
- The `CHECK (~ '^0x[0-9a-f]{64}$')` constraint catches any
  malformed write at the database layer — better than a bytea
  column where a 31-byte or 33-byte value could sneak in.

Pros for bytea (rejected):
- 32 bytes vs 66 chars on disk — saves ~34 bytes per hash. At our
  scale (144 cycle rows/day × ~3 hashes per row average + ~120
  twap_commits rows/day × 2 hashes per row, all year) that's ~6
  MB/year of storage. Trivial.
- Slightly faster comparison, but the indexed comparisons here are
  exact-match anyway and PG hashes both representations efficiently.

The storage savings don't justify the operational friction.

### 1.7.2 Partial index on non-terminal status

**Decision: yes, one partial index per commit table.**

```
CREATE INDEX idx_commit_cycles_pending_work
  ON public.commit_cycles (created_at)
  WHERE status IN ('pending', 'submitted');
```

(Same shape on `twap_commits`.)

Rationale:

- The committer service polls these tables every 10 minutes (cycle
  cadence) and every hour (TWAP cadence). The polling query is
  effectively `SELECT * FROM <table> WHERE status IN ('pending',
  'submitted') ORDER BY created_at LIMIT N`. A partial index on
  exactly that predicate makes the poll a tight index scan
  regardless of how big the historical table grows.
- The index stays small: at any moment, in-flight commits are
  typically a handful (one per cycle that hasn't finalized yet, plus
  any failures being retried). Finalized and failed rows fall out of
  the index automatically when their status updates.
- Combined with the full status index, queries that filter on
  `status='finalized'` for read paths still get an index plan via
  the non-partial index.

The split (partial for hot poll path + full for read paths) is
worth the redundant write cost. Both indexes cost a few microseconds
on each commit-row update; we update each row at most ~5 times in
its lifetime (insert + submit + confirm, plus retries).

### 1.7.3 Soft-delete vs hard-delete for failed cycles

**Decision: never delete; `status='failed'` is the audit signal.**

The whole point of these tables is to record commit attempts. If
commits stop landing, the audit trail is what we use to figure out
why — slow RPC, exhausted SOL, bad keypair, whatever. Hard-deleting
failed rows would hide exactly the evidence the postmortem would
need.

Operational policy:

- Failed rows accumulate forever in v1.
- A retry job (§3) periodically scans `failed` rows and tries again
  on a generous backoff (e.g. once an hour for the first day, then
  daily). When such a retry succeeds, the row transitions
  `failed → pending → submitted → finalized` (incrementing
  `retry_count`); `last_error` is cleared on finalization.
- If we ever need to actually delete (storage pressure, data
  retention policy), do it as an explicit operator action with a
  date cutoff — not as part of the committer's normal flow.

## 1.8 Cross-table integrity

Things this schema does NOT enforce structurally, with notes on
how the committer service is expected to keep the invariants:

- **`commit_cycles.observation_count` ==
  `count(commit_observations) WHERE cycle_id = X`**. The committer
  inserts the cycle row and the junction rows in the same
  transaction (§3 will spell out the write order: junction first,
  then cycle row, then submit). A mismatch would imply a partial
  write — the cycle insert is done **inside** a transaction that
  also writes all junction rows.
- **`commit_cycles.merkle_root` == root computed over
  `commit_observations` rows for that cycle**. Verification enforces
  this at read time; the committer enforces it at write time. No
  trigger to recompute on the DB side — that would couple the DB
  to the SHA-256 algorithm and add migration risk.
- **`twap_commits.observation_set_root` == root computed over
  `peptide_twaps.input_observation_ids` for the matching
  `peptide_twaps` row**. Same approach — the committer is the
  source of truth.

## 1.9 Open questions deferred to later sections

These touch the schema but their resolution lives elsewhere:

- **Active peptide subset for v1 TWAP commits.** Affects how many
  rows/day land in `twap_commits`. Lives in §9 (open questions).
- **Cycle commit eligibility filter.** The committer must filter
  `supplier_observations` by `scrape_success = true` before
  building the leaf set (§02.4.8 covers this, BACHEM/SIGMA flagged).
  Schema-level: `observation_count` reflects only successful rows.
- **Retry budget exact value.** Affects when status transitions to
  `failed`. Lives in §3 (service architecture).
- **Backfill / replay procedure.** If we discover a bug in the
  committer that produced a wrong `merkle_root`, can we ever amend
  on-chain commits? Lives in §8 (operational runbook). Schema-side:
  preserves the existing commit, adds a new one with a
  `replaces_cycle_id` reference (which would need a new column —
  not in v1).
