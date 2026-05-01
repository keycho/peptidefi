# 05 — Verification flow + API endpoints

Status: **draft**. Sections 5 + 6 of the on-chain commit layer
spec, written together because the verification flow defines the
data contracts that the API endpoints expose, and the API
endpoints define what a third-party verifier has to call. Once the
crypto primitives (§02), schema (§01), and service architecture
(§03) are locked, this section is what makes the oracle
externally usable.

This section depends on:

- §02 (cryptographic primitives) — defines the leaf canonical
  form, the Merkle tree algorithm, and the memo formats. Every
  verification step in §5 references it.
- §01 (database schema) — defines the row shapes the API serves
  and the lookup paths the verifier walks.
- §03 (service architecture) — defines what a "finalized" commit
  means and when a row is verifiable.

It explicitly does **not** decide:

- Cost numbers (§7)
- The frontend explorer's design (separate phase)
- Token-based access control or paid tiers (separate phase)
- The verification library implementation (only its interface, §5.6)

## 5.1 Verification scenarios

Three audiences, three levels of trust required, three workflows.

### 5.1.1 Casual user — explorer-driven, visual

The user lands on an explorer page for a single observation or TWAP
value and clicks a "verify" button. They expect:

- A human-readable result ("Verified ✓ on Solana mainnet, slot
  1,234,567")
- A clickable link to the underlying Solana transaction on
  solscan / solana fm / etc.
- No requirement to install anything, run code, or understand
  Merkle trees

What they're trusting: the explorer (operator-controlled) faithfully
called our API and the API faithfully called Solana. They get a
strong UX signal but no cryptographic guarantee independent of the
operator.

For this audience the value is **discoverability** — the explorer
shows the chain of evidence even if the user doesn't independently
walk it. The "verify" button under the hood calls the server-side
verification helper (§5.5), which does call Solana, but the user
takes the API's word for it.

### 5.1.2 Sophisticated user — independent verification

A researcher, journalist, or competitor wants to verify mathematically
that an observation in our database was anchored on Solana at a
given moment. They:

- Fetch the observation row + cycle commit + Merkle proof from our
  read API
- Fetch the on-chain Memo from a Solana RPC of their choice (not
  ours)
- Recompute the leaf hash from the canonical form (§02.4.2)
- Walk the Merkle proof to the claimed root
- Compare every step against both our DB and the on-chain bytes

What they're trusting: only Solana (the chain itself) and SHA-256.
They're not trusting our API's correctness — they're using our API
as a convenient data source but verifying independently. Mismatch
at any step is grounds for public dispute.

For this audience the value is **independent attestation**. The
spec must give them everything they need to do this without
talking to us.

### 5.1.3 Developer / programmatic integration

A smart contract, an indexer, or a downstream product wants to
consume the oracle's data and have machine-checkable provenance
for every value it acts on. They:

- Call our REST API for the data (TWAP value, commit metadata)
- Use the verification library (§5.6) to recompute proofs as part
  of normal request handling
- Fail closed if verification fails (don't trade on unverified
  data)

What they're trusting: the verification library's correctness and
their chosen Solana RPC. They get cryptographic guarantees with
the ergonomics of an SDK, and decide their own policy for what to
do when a verification fails.

For this audience the value is **integration with strong invariants**
— the library returns a structured `VerificationResult` they can
branch on.

## 5.2 Verification flow for an observation

Given a single `observation_id`, the full verification walks
through the following steps. Anything that fails returns an
explicit failure reason rather than a generic "not verified."

### 5.2.1 The steps

1. **Look up the cycle.** Query `commit_observations` for the row
   with `observation_id = X`. Returns `cycle_id`, `leaf_hash`,
   `leaf_index`. If no row exists: see §5.2.2 (unanchored).
2. **Look up the cycle commit.** Query `commit_cycles` for the row
   with `cycle_id = <result-of-step-1>`. Returns `merkle_root`,
   `solana_signature`, `solana_slot`, `status`, `memo_payload`,
   `observation_count`, timestamps.
3. **Check status.** If `status != 'finalized'`: see §5.2.3
   (in-flight or failed).
4. **Recompute the leaf hash.** Take the observation row from
   `supplier_observations`, build its canonical form per §02.4.2,
   compute `SHA-256(0x00 || canonical_json)`. Compare against
   `commit_observations.leaf_hash`. Mismatch: row was mutated
   after commit (corruption indicator).
5. **Fetch the proof.** Either from the API (`GET .../proof?observation_id=X`)
   or compute locally by loading all leaves for the cycle and
   building the path. The proof is an ordered list of
   `{position, hash}` pairs, one per tree level.
6. **Walk the proof.** Starting from the leaf hash, at each step:

   ```
   if step.position == 'left':
       current = SHA-256(0x01 || step.hash || current)
   else:  # 'right'
       current = SHA-256(0x01 || current || step.hash)
   ```

   After consuming all proof steps, `current` should equal
   `commit_cycles.merkle_root`. Mismatch: proof is malformed or
   row order changed.
7. **Fetch the on-chain memo.** Call Solana
   `getTransaction(solana_signature, { commitment: 'finalized',
   maxSupportedTransactionVersion: 0 })`. Inspect the transaction's
   instructions for the Memo v2 program
   (`MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr`); extract the
   instruction data; UTF-8 decode.
8. **Compare on-chain memo to DB.** The decoded UTF-8 string MUST
   equal `commit_cycles.memo_payload` byte-for-byte. Mismatch:
   either someone tampered with the DB row or someone stole the
   signature (operationally impossible without the keypair).
9. **Confirm finality.** The transaction's slot from
   `getTransaction` must equal `commit_cycles.solana_slot` AND the
   commitment-status field must be `finalized`.
10. **Confirm signer.** The transaction's first signer (fee payer)
    must equal the published oracle public key (see §5.4
    `GET /api/oracle/info`). Defense against an attacker presenting
    a forged tx with the same memo bytes but signed by a different
    key.

If all 10 steps pass: **verified.** The observation existed in our
database with the exact recorded values at the moment of finality
in the recorded slot, signed by the published oracle authority.

### 5.2.2 Unanchored: no `commit_observations` row

The observation exists in `supplier_observations` but has no
corresponding `commit_observations` row. Three sub-cases:

- **Cycle hasn't been committed yet** (the scrape cycle finished
  recently and the committer hasn't picked it up). The observation
  will be anchored within ~30 seconds of the cycle finishing, or
  longer during a backlog. Verifier returns
  `status='pending_commit'` and a hint to retry.
- **Observation was filtered out of the commit** (e.g.,
  `scrape_success=false` rows are excluded per §02.4.8). Verifier
  returns `status='ineligible_for_commit'` with the reason from
  the underlying row.
- **Cycle was deliberately skipped** (zero successful observations
  per §02.4.5; not currently expected to recur). Verifier returns
  `status='cycle_skipped'`.

None of these are "verification failed" — they're "verification
not applicable yet."

### 5.2.3 In-flight or failed cycle commit

The `commit_observations` row exists but the parent
`commit_cycles.status` is not `'finalized'`:

- `status = 'pending'`: committer service has the cycle queued but
  hasn't submitted yet. Return `status='pending'`, expected
  finalization time = "within a few minutes."
- `status = 'submitted'`: tx is on Solana awaiting finalization.
  Return `status='submitted'` with the signature. Verifier may
  optionally call `getSignatureStatuses` themselves to check
  current state.
- `status = 'failed'`: committer exhausted retries. Return
  `status='commit_failed'` with `last_error` so the user knows
  the operational reason. Manual intervention required (per §03.7).

A verifier client should treat `pending` / `submitted` as "retry
later" and `failed` / `cycle_skipped` / `ineligible_for_commit` as
"this observation will not have on-chain provenance unless the
operator takes action."

### 5.2.4 Authority pubkey: the trust-anchor

Step 10 of the verification flow checks that the on-chain
transaction was signed by the **oracle authority pubkey**. This
is the load-bearing assumption of the entire trust model: every
proof we provide is "this commit was signed by the key the oracle
operator publicly committed to." If a verifier accepts the wrong
authority pubkey, every other check is irrelevant — an attacker
could mint counterfeit commits with any memo bytes they want.

This subsection documents how a verifier obtains the authority
pubkey, what assumptions that depends on, and how the trust model
hardens over future protocol versions.

#### v1 — multi-channel publication

The authority pubkey is published in **three** channels for
cross-reference. A diligent verifier checks at least two of them
agree before trusting any commit:

1. **`GET /api/oracle/info`** (§5.4.11). The live API surface.
   Convenient for programmatic verifiers but requires trusting
   that the API itself wasn't compromised — an attacker who
   controls the API host could serve a different pubkey to direct
   verifiers at counterfeit commits they signed themselves.
2. **The project's GitHub repository.** A `docs/oracle-authority.md`
   file (lands with the committer service implementation) commits
   the authority pubkey to a versioned, publicly auditable
   artifact. Git history makes any rotation visible.
3. **Project social channels and documentation site.** Twitter / X
   post pinned to the project account, plus the public
   documentation site, both citing the same pubkey. Multiple
   independent surfaces an attacker would need to compromise
   simultaneously.

**Trust model summary for v1:** verifying a commit requires
trusting that **at least one** of the three channels above has
not been compromised. An attacker attempting to mint counterfeit
commits would need to either steal the actual private key
(see §03.5) or simultaneously poison every channel a careful
verifier would consult — the former is detectable via balance
monitoring, the latter is operationally hard.

This is materially better than "trust whatever pubkey the API
returns" but it is not zero-trust. Sophisticated verifiers (§5.1.2)
should hardcode the pubkey on first contact and refuse to update it
across runs without human review — same pattern SSH uses for host
keys (TOFU + warn-on-change).

#### v2 candidates — toward zero-trust

Two enhancements deferred to v2:

- **Bake the authority pubkey into the versioned verification
  library.** A consumer pinning `@peptide-oracle/verify@1.2.0`
  gets the authority pubkey at build time, not at run time. Library
  releases are signed and reproducibly built; an attacker who
  compromises the API host can't downgrade existing consumers.
  Library updates that change the pubkey require a major version
  bump with explicit operator-side rotation announcement.
- **Anchor the authority pubkey + protocol version via a one-time
  on-chain "genesis" commit.** The oracle's first transaction on
  mainnet is a Memo containing
  `{"v":1,"type":"genesis","authority_pubkey":"...","protocol_version":1,"effective_at":"<iso>"}`.
  Subsequent verifications can reference the genesis signature as
  the bootstrap anchor — verifying any commit becomes "trust
  Solana finality + trust the genesis tx + walk the chain." The
  genesis tx's signature would need to be published in the same
  multi-channel way as the authority pubkey itself, but it
  trades operator-publication trust for chain-history trust on
  every subsequent commit.

Both v2 candidates strengthen the trust model without changing the
v1 cryptographic primitives — they're additive. v1 ships without
them and the spec is honest about the trust assumption it carries.

#### Rotation impact

The §03.5.4 keypair rotation procedure must update **all three
v1 channels in lockstep** when the authority pubkey changes —
otherwise a verifier mid-rotation sees disagreement across
channels and (per the recommended TOFU semantics above) refuses
to verify until the rotation completes. The runbook (§8) will
spell out the rotation order and the expected window of
verifier-side disagreement.

## 5.3 Verification flow for a TWAP value

Given a `(peptide_code, timestamp)` tuple, the verifier walks:

### 5.3.1 The steps

1. **Find the TWAP commit.** Query `twap_commits` for the row with
   `peptide_code = <code>` AND `computed_at <= <timestamp>` AND
   `status = 'finalized'`, ordered `computed_at DESC`, limit 1.
   This is the "TWAP commit relevant to that query."
2. **Fetch the on-chain memo** (same as §5.2 step 7 but using
   `twap_commits.solana_signature`).
3. **Verify the memo against the DB.** Byte-exact compare against
   `twap_commits.memo_payload`. Same as §5.2 step 8.
4. **Look up the source TWAP row.** Query `peptide_twaps` for the
   row with `peptide_id = (lookup by code)` AND `computed_at =
   twap_commits.computed_at`. This is the row that fed the commit;
   its `input_observation_ids` array tells us which observations
   the TWAP was computed from.
5. **For each observation in `input_observation_ids`:**
   a. Run the §5.2 observation verification flow.
   b. Collect the verified observation's canonical leaf hash.
6. **Recompute the observation set Merkle root.** Build a fresh
   Merkle tree per §02.4 over the leaf hashes from step 5b
   (ordered by `observation_id` ascending, same rule as §02.4.5).
   Compare the resulting root against `twap_commits.observation_set_root`
   AND against the `observation_set_root` field in the on-chain
   memo (which was already byte-compared in step 3, so this is
   a sanity check).
7. **(Optional, "full" verification only) Recompute the TWAP value.**
   Read `algo` from the on-chain memo (§02.2.3). Dispatch to the
   matching algorithm implementation:

   ```
   if memo.algo == "filtered_median_v1":
       run filtered_median_v1 over the verified observation set
       compare result to memo.twap_value (string-equality on the
       canonical decimal form — see §02.2.5)
   else:
       refuse: VerificationCheck { name: "twap_recompute",
                                    passed: false,
                                    detail: "unknown algo: <algo>" }
   ```

   Verifier libraries MUST refuse to fall back to a default
   algorithm when `algo` is unknown — silently using the wrong
   algorithm would produce a confident-but-wrong "verified" result.
   `filtered_median_v1` is documented in §03.3.2 and the worker's
   `apps/worker/src/twap.ts`. A mismatch between the recomputed
   value and `memo.twap_value` is operationally significant
   (operator computed the TWAP wrong) but doesn't invalidate the
   on-chain anchoring of the Merkle-root chain of evidence
   (steps 2–6 above).
8. **Confirm finality + signer** (same as §5.2 steps 9–10).

If steps 1–6 + 8 pass: **verified.** The TWAP value the operator
committed on-chain is anchored to a specific set of observations,
each of which is itself anchored via a cycle commit. The chain of
evidence runs from the TWAP all the way down to individual price
observations.

Step 7 is optional because verifying it requires the verifier to
implement the TWAP algorithm, which is a maintenance burden. The
common pattern: trust that the operator's `twap_value` is what the
operator committed (already a strong claim, since it's signed and
finalized), and use step 7 only when investigating disputes.

### 5.3.2 TWAP windows span multiple cycles

A 1-hour TWAP window typically covers ~6 cycle commits (cycles run
every ~10 min). The verifier doesn't need a single Merkle root that
covers the TWAP's input set — that's exactly what
`observation_set_root` provides, computed fresh over the input
observations.

The cross-cycle linkage is: each input observation is verified
against ITS cycle's commit (via §5.2). The TWAP commit doesn't
care which cycles its inputs came from; it only commits to the
observation set as a whole.

This means: if any single contributing cycle commit is `pending` or
`failed` at TWAP commit time, the TWAP's verification status
inherits the worst child status. The committer service is expected
to wait until all contributing cycles are `finalized` before
submitting a TWAP commit (§03.3.3 — TWAP poller skews to `HH:00:30`
exactly so all hourly inputs are anchored first).

### 5.3.3 TWAP algorithm reproducibility

The `algo` field in the TWAP commit memo (§02.2.3, added during
review) makes step 7 deterministic across algorithm changes. v1
ships `"filtered_median_v1"` as the only algorithm. When the
operator ships a future algorithm (e.g., `"filtered_median_v2"`
adding MAD-based outlier filtering), the new commits carry the
new identifier and historical commits keep verifying against
their original algorithm — neither set silently disagrees with
the other.

This isn't a memo schema version bump — `v` (§02.2.3) governs
the JSON schema, `algo` governs the value-production algorithm.
The two evolve independently. A v1 schema commit can carry any
`algo` identifier the operator publishes; a hypothetical v2 schema
bump would document its own constraints on what `algo` values are
allowed.

Verifier libraries should accept new `algo` values as the algorithms
ship (one new pure function added to the library per algorithm),
and MUST refuse — not silently fall back — when they encounter an
identifier they don't recognise.

## 5.4 API endpoints

All endpoints are **public, read-only, no auth required for v1**
(§5.7). All return JSON with `Content-Type: application/json;
charset=utf-8`. Numeric values follow the §02.2.5 convention:
decimals as strings, integers as JSON numbers when ≤ 2⁵³.

Pagination is **cursor-based** (opaque base64-encoded server token,
not raw row IDs). Default page size 50, max 200.

Error responses follow the existing project shape from
`apps/api/src/errors.ts`: `{ code, message, details? }`. Codes
specific to this surface listed in §5.4.13.

### 5.4.1 GET /api/oracle/cycles

List recent cycle commits, paginated, newest first.

| query param | type    | default | meaning                                                          |
| ----------- | ------- | ------- | ---------------------------------------------------------------- |
| `cursor`    | string  | —       | Opaque pagination token from a previous response.                |
| `limit`     | integer | 50      | Page size, 1–200.                                                 |
| `status`    | string  | finalized | Filter by status: `finalized`, `submitted`, `pending`, `failed`, `all`. |

**Response:**

```json
{
  "cycles": [
    {
      "cycle_id": 1042,
      "started_at": "2026-05-01T12:00:00.000Z",
      "completed_at": "2026-05-01T12:00:09.000Z",
      "observation_count": 118,
      "merkle_root": "0x100eeb8fabe2d1cb200324e8ccbcc3ead12cfa18224a744cbe11d813dcb32af8",
      "status": "finalized",
      "solana": {
        "signature": "5VfYTAH...",
        "slot": 287192831,
        "cluster": "mainnet-beta",
        "explorer_url": "https://solscan.io/tx/5VfYTAH..."
      },
      "submitted_at": "2026-05-01T12:00:14.123Z",
      "finalized_at": "2026-05-01T12:00:42.567Z"
    }
  ],
  "next_cursor": "eyJjeWNsZV9pZCI6MTA0MX0="
}
```

`next_cursor` is `null` when no more pages. `cluster` and
`explorer_url` are computed server-side based on which cluster the
oracle deploys to (see `GET /api/oracle/info`).

### 5.4.2 GET /api/oracle/cycles/:cycle_id

Single cycle commit detail. Returns 404 if the cycle has no commit
record (the cycle may exist in `scraper_runs` but never been
committed).

**Response shape:** same as one element of `cycles` in §5.4.1, plus:

```json
{
  ...same fields as §5.4.1...,
  "memo_payload": "{\"completed_at\":\"2026-05-01T12:00:09.000Z\",...}",
  "retry_count": 0,
  "last_error": null
}
```

`memo_payload` is included on the detail endpoint (not on the
list) so verifiers can byte-compare against the on-chain memo
without an extra round trip.

### 5.4.3 GET /api/oracle/cycles/:cycle_id/observations

Observations included in a cycle's Merkle tree, paginated, ordered
by `leaf_index` ascending.

| query param | type    | default | meaning                       |
| ----------- | ------- | ------- | ----------------------------- |
| `cursor`    | string  | —       | Pagination token.             |
| `limit`     | integer | 50      | Page size, 1–200.             |

**Response:**

```json
{
  "cycle_id": 1042,
  "observation_count": 118,
  "observations": [
    {
      "observation_id": 88291,
      "leaf_index": 0,
      "leaf_hash": "0x799fe69ea74165d8...",
      "supplier_id": 7,
      "peptide_id": 12,
      "supplier_product_id": 140,
      "observed_at": "2026-05-01T12:00:00.000Z",
      "price_usd_per_mg": "3.633333",
      "availability_tier": "in_stock",
      "scrape_success": true
    }
  ],
  "next_cursor": null
}
```

A subset of observation fields included for convenience; the full
canonical leaf is reconstructable from `GET /api/oracle/observations/:id`.

### 5.4.4 GET /api/oracle/cycles/:cycle_id/proof

Merkle proof for a specific observation in a cycle.

| query param      | type    | required | meaning                                              |
| ---------------- | ------- | -------- | ---------------------------------------------------- |
| `observation_id` | integer | yes      | The observation to prove. Must be in the cycle.      |

**Response:**

```json
{
  "cycle_id": 1042,
  "observation_id": 88291,
  "leaf_hash": "0x799fe69ea74165d8...",
  "leaf_index": 0,
  "merkle_root": "0x100eeb8fabe2d1cb...",
  "observation_count": 118,
  "proof": [
    { "position": "right", "hash": "0x1eabe587a9f12e9a..." },
    { "position": "right", "hash": "0xe8311c85eda90c26..." }
  ]
}
```

`position` is the position of the **sibling** at each level (not the
target). When walking the proof:

```
current = leaf_hash
for step in proof:
    if step.position == 'left':
        current = SHA-256(0x01 || step.hash || current)
    else:
        current = SHA-256(0x01 || current || step.hash)
verify current == merkle_root
```

The §02.4.6 worked example uses the same `position` convention.

Returns 404 if the observation isn't in the cycle. Returns 409 if
the cycle's status isn't `finalized` (no proof against an unfinalized
root).

### 5.4.5 GET /api/oracle/twap/:peptide_code

Most recent finalized TWAP commit for a peptide, with full
verification metadata.

**Response:**

```json
{
  "peptide_code": "BPC157",
  "algo": "filtered_median_v1",
  "twap_value": "5.998000",
  "computed_at": "2026-05-01T12:00:00.000Z",
  "window_start": "2026-05-01T11:00:00.000Z",
  "window_end": "2026-05-01T12:00:00.000Z",
  "observation_set_root": "0x100eeb8f...",
  "status": "finalized",
  "solana": {
    "signature": "5VfYTAH...",
    "slot": 287192831,
    "cluster": "mainnet-beta",
    "explorer_url": "https://solscan.io/tx/5VfYTAH..."
  },
  "memo_payload": "{\"algo\":\"filtered_median_v1\",\"computed_at\":\"...\",...}",
  "input_observation_ids": [88291, 88317, 88401, 88455]
}
```

Returns 404 if the peptide has no finalized TWAP commits yet (e.g.,
new peptide, first hour after onboarding).

### 5.4.6 GET /api/oracle/twap/:peptide_code/at/:timestamp

TWAP commit covering a specific timestamp. Returns the most recent
finalized commit where `computed_at <= timestamp`.

`:timestamp` is ISO 8601 in the URL (URL-encoded `:` characters).
Example: `/api/oracle/twap/BPC157/at/2026-05-01T12:34:56Z`.

**Response shape:** same as §5.4.5.

Returns 404 if no finalized commit exists at-or-before the
timestamp (e.g., timestamp is before the peptide started being
committed).

### 5.4.7 GET /api/oracle/twap/:peptide_code/history

Paginated history of TWAP commits for a peptide, newest first.

| query param | type    | default | meaning |
| ----------- | ------- | ------- | ------- |
| `cursor`    | string  | —       | Pagination token. |
| `limit`     | integer | 50      | Page size, 1–200. |
| `status`    | string  | finalized | `finalized` (default) or `all`. |

**Response:**

```json
{
  "peptide_code": "BPC157",
  "twaps": [
    { ...same shape as §5.4.5, minus memo_payload... },
    ...
  ],
  "next_cursor": "..."
}
```

`memo_payload` excluded from the list response to keep payload
size bounded; sophisticated callers fetch detail per-row from
§5.4.5 / §5.4.6.

### 5.4.8 GET /api/oracle/peptides

List of tracked peptides with current TWAP. Discovery surface for
clients new to the oracle.

**Response:**

```json
{
  "peptides": [
    {
      "code": "BPC157",
      "display_name": "BPC-157",
      "category": "longevity",
      "current_twap": {
        "twap_value": "5.998000",
        "computed_at": "2026-05-01T12:00:00.000Z",
        "solana_signature": "5VfYTAH..."
      },
      "twap_commits_count": 1247
    }
  ]
}
```

`current_twap` is `null` if the peptide has no finalized TWAP
commits yet. `twap_commits_count` is a cheap aggregate for the
explorer.

### 5.4.9 GET /api/oracle/vendors

List of vendors contributing observations.

**Response:**

```json
{
  "vendors": [
    {
      "code": "PUREHEALTH",
      "display_name": "Pure Health Peptides",
      "homepage_url": "https://purehealthpeptides.com",
      "observations_24h": 2160,
      "observations_total": 528421,
      "last_observed_at": "2026-05-01T12:34:56.789Z"
    }
  ]
}
```

Filters to vendors with `status='active'` AND with observations in
the last 7 days. (BACHEM/SIGMA, per §02.4.8, would be excluded if
status flips to paused; otherwise they appear with low counts.)

### 5.4.10 GET /api/oracle/observations/:observation_id

Single observation, full canonical form, with commit membership.

**Response:**

```json
{
  "observation": {
    "id": 88291,
    "supplier_id": 7,
    "peptide_id": 12,
    "supplier_product_id": 140,
    "scraper_run_id": 1042,
    "observed_at": "2026-05-01T12:00:00.000Z",
    "raw_price": "54.500000",
    "raw_currency": "USD",
    "fx_rate_to_usd": "1.00000000",
    "price_usd_per_mg": "3.633333",
    "raw_availability": "in stock",
    "availability_tier": "in_stock",
    "lead_time_days": null,
    "scrape_success": true,
    "scrape_error": null,
    "http_status": 200,
    "raw_html_hash": "0xaaaaaaaa"
  },
  "canonical_leaf_json": "{\"availability_tier\":\"in_stock\",...}",
  "commit": {
    "cycle_id": 1042,
    "leaf_hash": "0x799fe69ea74165d8...",
    "leaf_index": 0,
    "status": "finalized",
    "solana_signature": "5VfYTAH..."
  }
}
```

`canonical_leaf_json` is the byte-exact UTF-8 string per §02.4.2 —
useful for verifiers who want to recompute `SHA-256(0x00 || it)`
without re-canonicalizing themselves. `commit` is `null` if the
observation isn't in any commit yet (see §5.2.2 sub-cases).

### 5.4.11 GET /api/oracle/info

Discovery endpoint. Returns operational metadata a verifier needs
to confirm what they're talking to.

**Response:**

```json
{
  "service": "peptide-oracle",
  "protocol_version": 1,
  "cluster": "mainnet-beta",
  "oracle_authority_pubkey": "...",
  "memo_program_id": "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
  "spec_url": "https://github.com/<org>/<repo>/blob/main/docs/specs/01-onchain-commit-layer.md",
  "rpc_recommendation": "https://api.mainnet-beta.solana.com (or any public Solana RPC)"
}
```

`oracle_authority_pubkey` is the load-bearing field for §5.2 step
10 and §5.3 step 8. A verifier's first call should be to this
endpoint to learn which signer to expect on every commit
transaction.

### 5.4.12 Caching

| endpoint                                 | cache strategy                                                                            |
| ---------------------------------------- | ----------------------------------------------------------------------------------------- |
| `/cycles` (list)                         | `Cache-Control: public, max-age=30`. New cycles land every ~10 min so a 30s TTL is conservative. |
| `/cycles/:id` (finalized)                | `Cache-Control: public, max-age=86400, immutable`. Finalized rows never change.           |
| `/cycles/:id` (in-flight)                | `Cache-Control: public, max-age=15`. Status may flip to finalized soon.                   |
| `/cycles/:id/observations`               | Same rule as `/cycles/:id` based on parent cycle's status.                                |
| `/cycles/:id/proof`                      | `Cache-Control: public, max-age=86400, immutable`. Proof for a finalized cycle is immutable. |
| `/twap/:code` (current)                  | `Cache-Control: public, max-age=300`. New commits hourly; 5-min TTL trades freshness for hits. |
| `/twap/:code/at/:ts`                     | `Cache-Control: public, max-age=86400, immutable` if `:ts < now() - 1 hour`; else `max-age=60`. |
| `/twap/:code/history`                    | `Cache-Control: public, max-age=300`.                                                     |
| `/peptides`                              | `Cache-Control: public, max-age=60`. Peptide list changes rarely.                         |
| `/vendors`                               | `Cache-Control: public, max-age=60`.                                                      |
| `/observations/:id`                      | `Cache-Control: public, max-age=86400, immutable` if commit is finalized; `max-age=15` otherwise. |
| `/info`                                  | `Cache-Control: public, max-age=300`.                                                     |
| `/verify/*` (POST)                       | `Cache-Control: no-store`. Verification results are run fresh.                            |

Every immutable response also sets `ETag` to a content hash so
clients can revalidate cheaply. Cache headers assume a CDN sits in
front of the API service — Railway's default ingress doesn't cache,
so v1 either accepts the lower hit rate or proxies through Cloudflare
(operator decision flagged in §5.7).

### 5.4.13 Rate limits

Per-IP, simple Express middleware. Three buckets:

| bucket                | endpoints                                                          | rate (req / minute / IP) |
| --------------------- | ------------------------------------------------------------------ | ------------------------ |
| read-light            | `/info`, `/cycles/:id`, `/twap/:code`, `/observations/:id`         | 120                      |
| read-heavy            | `/cycles` (list), `/cycles/:id/observations`, `/twap/:code/history`, `/peptides`, `/vendors` | 60                       |
| verify                | `/cycles/:id/proof`, `/verify/observation`, `/verify/twap`          | 30                       |

Exceeded → HTTP 429 with `Retry-After` header. No auth tier in v1
(§5.7). When we add a paid tier, an API-key-presented request gets
boosted limits without changing the unauthenticated defaults.

### 5.4.14 Error codes

Specific to this surface, on top of the existing project codes
from `apps/api/src/errors.ts`:

| code                              | http | meaning                                                                |
| --------------------------------- | ---- | ---------------------------------------------------------------------- |
| `CYCLE_NOT_FOUND`                 | 404  | No `commit_cycles` row for the given `cycle_id`.                       |
| `OBSERVATION_NOT_FOUND`           | 404  | No `supplier_observations` row for the given `observation_id`.         |
| `OBSERVATION_NOT_IN_CYCLE`        | 404  | The observation exists but isn't in the requested cycle.               |
| `CYCLE_NOT_FINALIZED`             | 409  | Proof requested for a cycle whose status isn't `finalized`.            |
| `TWAP_NOT_FOUND`                  | 404  | No TWAP commit for the peptide / timestamp combination.                |
| `PEPTIDE_NOT_FOUND`               | 404  | No peptide with the given `code`.                                      |
| `INVALID_INPUT`                   | 400  | Malformed query param, bad timestamp format, etc.                      |
| `RATE_LIMITED`                    | 429  | Per-IP rate limit exceeded; `Retry-After` header set.                  |

## 5.5 Verification helper endpoints

Server-side verification helpers. The math is the same as the
client library would do — these exist for clients that don't want
to run the verification themselves and accept that they're
trusting the oracle API's correctness for the verification step.

**Decision: ship in v1.** A clean
"POST observation_id, get back a structured result" API makes the
casual-user explorer surface trivial to build, and the math is
identical to what the client library will do; no extra surface area
to maintain.

### 5.5.1 POST /api/oracle/verify/observation

**Request body:**

```json
{ "observation_id": 88291 }
```

**Response (success):**

```json
{
  "verified": true,
  "observation_id": 88291,
  "cycle_id": 1042,
  "checks": [
    { "name": "observation_exists",        "passed": true },
    { "name": "cycle_anchored",            "passed": true },
    { "name": "cycle_finalized",           "passed": true },
    { "name": "leaf_hash_matches_db",      "passed": true },
    { "name": "merkle_proof_reconstructs", "passed": true },
    { "name": "memo_matches_onchain",      "passed": true },
    { "name": "slot_matches_onchain",      "passed": true },
    { "name": "signer_matches_authority",  "passed": true }
  ],
  "on_chain": {
    "signature": "5VfYTAH...",
    "slot": 287192831,
    "cluster": "mainnet-beta",
    "memo": "{\"completed_at\":\"...\",...}"
  }
}
```

**Response (failure):**

```json
{
  "verified": false,
  "observation_id": 88291,
  "cycle_id": 1042,
  "failure_reason": "leaf_hash_matches_db",
  "failure_detail": "leaf_hash in DB is 0x1e16... but recomputed canonical leaf hashes to 0xa7c3...; observation row may have been mutated post-commit",
  "checks": [
    { "name": "observation_exists",        "passed": true },
    { "name": "cycle_anchored",            "passed": true },
    { "name": "cycle_finalized",           "passed": true },
    { "name": "leaf_hash_matches_db",      "passed": false, "detail": "..." }
  ]
}
```

**Response (not yet verifiable):**

```json
{
  "verified": false,
  "observation_id": 88291,
  "status": "pending_commit",
  "detail": "Observation is in cycle 1042 which has not been committed to Solana yet. Expected within ~30 seconds.",
  "retry_after_seconds": 30
}
```

The response shape distinguishes `verified=false` (a real
verification failure, indicates a bug or tampering) from
`verified=false, status=pending_commit` (verification simply not
applicable yet). Clients should branch on this carefully.

### 5.5.2 POST /api/oracle/verify/twap

**Request body:**

```json
{ "peptide_code": "BPC157", "computed_at": "2026-05-01T12:00:00.000Z" }
```

(Or alternately `{ "twap_commit_id": "<uuid>" }` for a direct lookup.)

**Response:** structurally identical to §5.5.1 but with an
additional `constituent_observations` field listing each input
observation_id with its own pass/fail summary. The full per-observation
checks aren't repeated; the parent's `verified` is `true` iff every
constituent observation verifies AND the TWAP-level checks pass.

```json
{
  "verified": true,
  "twap_commit_id": "...",
  "peptide_code": "BPC157",
  "checks": [
    { "name": "twap_commit_exists",          "passed": true },
    { "name": "twap_commit_finalized",       "passed": true },
    { "name": "memo_matches_onchain",        "passed": true },
    { "name": "constituent_observations",    "passed": true,
      "detail": "4 of 4 contributing observations verified" },
    { "name": "observation_set_root_matches","passed": true },
    { "name": "signer_matches_authority",    "passed": true }
  ],
  "constituent_observations": [
    { "observation_id": 88291, "verified": true,  "cycle_id": 1042 },
    { "observation_id": 88317, "verified": true,  "cycle_id": 1042 },
    { "observation_id": 88401, "verified": true,  "cycle_id": 1043 },
    { "observation_id": 88455, "verified": true,  "cycle_id": 1043 }
  ],
  "on_chain": { "signature": "...", "slot": 287192831, "memo": "..." }
}
```

The TWAP-value-recomputation check (§5.3.1 step 7) is NOT included
in the default response — it's an opt-in via
`{ "recompute_twap": true }` in the request body. Defaults off
because it requires loading the worker's TWAP algorithm and
running it server-side, which is the most expensive verification
operation.

## 5.6 Client-side verification library (interface only)

A future TypeScript library `@peptide-oracle/verify`. This section
specs only the interface — implementation lives in a follow-up
ticket once §03 implementation lands.

### 5.6.1 Core types

```typescript
import type { Connection } from "@solana/web3.js";

/** Canonical observation leaf form per §02.4.2. 17 fields. */
export interface ObservationData {
  id: number;
  supplier_id: number;
  peptide_id: number;
  supplier_product_id: number;
  scraper_run_id: number;
  observed_at: string;          // ISO 8601 ms UTC
  raw_price: string | null;     // decimal string per §02.2.5
  raw_currency: string | null;
  fx_rate_to_usd: string | null;
  price_usd_per_mg: string | null;
  raw_availability: string | null;
  availability_tier: string;
  lead_time_days: number | null;
  scrape_success: boolean;
  scrape_error: string | null;
  http_status: number | null;
  raw_html_hash: string | null;
}

export interface CycleCommitData {
  cycle_id: number;
  merkle_root: string;             // 0x + 64 hex
  observation_count: number;
  started_at: string;
  completed_at: string;
  solana_signature: string;        // base58
  solana_slot: number;
  memo_payload: string;            // canonical JSON, byte-exact
}

export interface TWAPCommitData {
  algo: string;                    // e.g. "filtered_median_v1" — see §02.2.3
  peptide_code: string;
  twap_value: string;
  computed_at: string;
  window_start: string;
  window_end: string;
  observation_set_root: string;
  solana_signature: string;
  solana_slot: number;
  memo_payload: string;
}

export interface MerkleProofStep {
  position: "left" | "right";      // sibling position; see §5.4.4
  hash: string;                    // 0x + 64 hex
}

export interface VerificationCheck {
  name: string;
  passed: boolean;
  detail?: string;
}

export interface VerificationResult {
  verified: boolean;
  failure_reason?: string;          // populated iff verified=false
  failure_detail?: string;
  checks: VerificationCheck[];
  on_chain?: {
    signature: string;
    slot: number;
    cluster: "mainnet-beta" | "devnet" | "testnet";
    memo: string;
    signer: string;                 // base58 fee-payer pubkey
  };
}

export interface VerifyOptions {
  /** Expected oracle authority pubkey (from /api/oracle/info). */
  oracleAuthority: string;
  /** Solana RPC connection — caller's choice; not the oracle's RPC. */
  rpc: Connection;
}
```

### 5.6.2 Function signatures

```typescript
/**
 * Verify a single observation against its cycle's on-chain commit.
 * Performs §5.2 steps 4-10 client-side. Steps 1-3 (DB lookups) are
 * the caller's responsibility — typically by hitting our REST API
 * for the observation, cycle, and proof, or by maintaining their
 * own indexer.
 */
export function verifyObservation(
  observation: ObservationData,
  cycleData: CycleCommitData,
  proof: MerkleProofStep[],
  options: VerifyOptions
): Promise<VerificationResult>;

/**
 * Verify a TWAP commit + every constituent observation.
 * Performs §5.3 steps 2-3 + 6 + 8 client-side, plus
 * verifyObservation() per constituent.
 *
 * recomputeTwap: if true, also re-runs the TWAP algorithm
 * identified by twapCommit.algo over the verified observation
 * set and compares to twapCommit.twap_value (§5.3.1 step 7).
 * Defaults to false — caller opts in for full verification.
 *
 * The library refuses recompute if it doesn't recognise
 * twapCommit.algo (returns a VerificationResult with verified=false
 * and failure_reason='unknown_algo'). It does NOT silently fall back.
 */
export function verifyTWAP(
  twapCommit: TWAPCommitData,
  constituentObservations: ObservationData[],
  cycleCommits: CycleCommitData[],
  observationProofs: MerkleProofStep[][],
  options: VerifyOptions & { recomputeTwap?: boolean }
): Promise<VerificationResult>;

/**
 * Pure-function helpers (no network calls). Useful for clients
 * that want to verify Merkle proofs without doing the whole flow.
 */
export function canonicalLeafJson(observation: ObservationData): string;
export function leafHash(observation: ObservationData): string;        // 0x + 64 hex
export function walkProof(
  leafHash: string,
  proof: MerkleProofStep[]
): string;
```

### 5.6.3 VerificationResult semantics

`verified` is a boolean reflecting the AND of every check. `checks`
is the ordered list of every step the verifier ran, with per-step
pass/fail. `failure_reason` (when `verified=false`) is the `name`
of the first failed check; `failure_detail` is a human-readable
explanation suitable for surfacing in a UI or log line.

`on_chain` is populated whenever a Solana RPC call succeeded,
whether or not subsequent checks passed. Lets the caller display
the on-chain link even on verification failure.

The library never throws on verification failure — it returns a
result with `verified=false`. It throws only on programmer errors
(malformed input data) or network failures from the Solana RPC
that prevent the verification from completing at all.

## 5.7 Decisions to flag for review

1. **Rate limit defaults: 120 / 60 / 30 req/min/IP for read-light,
   read-heavy, verify buckets.** Generous for a research / explorer
   audience, low enough that one bad actor can't trivially exhaust
   our RPC budget. Easy to dial via env vars.
2. **Caching strategy:**
   - Finalized cycle data and historical TWAP commits: long
     `max-age=86400, immutable`
   - Current TWAP: short `max-age=300`
   - Lists: medium `max-age=30–60`
   - Verification responses: `no-store`

   The `immutable` directive depends on a CDN front-end actually
   honoring it. Operator decision: do we put Cloudflare in front
   of the Railway service for v1, or accept the hit rate without?
3. **Pagination: cursor-based, default 50, max 200.** Cursors are
   opaque base64-encoded server tokens, not raw row IDs (so we can
   change the underlying ordering without breaking clients).
4. **Server-side verification helpers (§5.5): ship in v1.** Argued
   above; the math is identical to the client library so no extra
   surface to maintain.
5. **Authentication: none for v1.** All endpoints public, all
   reads. A future paid tier adds API-key auth with boosted rate
   limits but doesn't gate access to the data — the oracle's
   value is in being verifiable, which requires public data.

## 5.8 Out of scope for this section

- Token-based access control (separate phase)
- Frontend explorer UI design (separate phase)
- Verification library implementation (interface only here; impl
  lands once §03 service is built)
- Cost analysis (§7 — references the rate-limit choices here)
- Operational runbook for the API service (§8)
