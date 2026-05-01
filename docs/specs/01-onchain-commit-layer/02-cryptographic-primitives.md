# 02 — Cryptographic primitives

Status: **draft**. Sections 2 (Memo format) and 4 (Merkle tree) of the
on-chain commit layer spec, written together because they jointly
define the on-chain contract — once anything in this file ships,
changing it breaks every commit that came before. Treat as immutable
unless we explicitly bump the protocol version (see §2.4).

This file specifies WHAT goes on-chain and HOW it's computed. WHERE
the data comes from, WHO submits it, and WHEN — those are the next
sections (database schema, service architecture). Verification flow
also lives in a later section, but the verification is mechanical
once §2 + §4 are fixed: recompute the leaf hash, walk the tree,
check the on-chain Memo matches the database record.

---

## 2. Memo format specifications

### 2.1 Common rules (apply to every memo)

Every memo is a single JSON object, serialized in **canonical form**:

1. **Sorted keys** — object keys in ASCII-lexicographic ascending
   order at every level of nesting.
2. **No whitespace** — no spaces, tabs, or newlines anywhere outside
   string values. (Inside string values, characters are preserved
   verbatim and JSON-escaped per RFC 8259.)
3. **UTF-8 encoding** — the byte string written to the Memo
   instruction is the UTF-8 encoding of the canonical JSON text.
4. **No trailing newline.**
5. **No comments.**

These rules are the JSON Canonicalization Scheme (JCS, RFC 8785)
restricted to our allowed types — strings, integers, the literals
`true` / `false` / `null`. We do **not** allow JSON floats,
exponents, or non-integer numeric literals: every numeric value
that could be ambiguous (decimals, ids that might exceed 2⁵³) is
serialized as a **string**. This sidesteps every "did the encoder
round-trip the same number?" failure mode that has burned every
canonical-JSON spec ever written.

The first instruction of every commit transaction is the SPL Memo
instruction (`MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr` on
mainnet, v2 program). The instruction's data is the canonical JSON
bytes — no length prefix, no envelope. A verifier reading the
transaction can take the raw instruction data, parse as JSON, and
compare against the database record byte-for-byte after
re-canonicalizing.

### 2.2 Cycle Merkle root commit memo

**Purpose:** anchor a single 10-minute scrape cycle. One per
`scraper_runs` row that completed successfully and produced ≥1
observation.

**Schema:**

| field               | type            | meaning                                                                  |
| ------------------- | --------------- | ------------------------------------------------------------------------ |
| `v`                 | integer         | Protocol version. Always `1` in this document.                           |
| `type`              | string          | Always the literal `"cycle"`.                                            |
| `cycle_id`          | integer         | The `scraper_runs.id` value. Bigint in DB; safe as JSON int (well under 2⁵³). |
| `merkle_root`       | string          | `0x` + 64 lowercase hex chars. The 32-byte SHA-256 root from §4.        |
| `observation_count` | integer         | Number of `supplier_observations` rows hashed into the tree.            |
| `started_at`        | string          | `scraper_runs.started_at` in canonical timestamp form (§2.3).           |
| `completed_at`      | string          | `scraper_runs.finished_at` in canonical timestamp form (§2.3).          |

**Example** (canonical, byte-exact):

```
{"completed_at":"2026-05-01T12:00:09.000Z","cycle_id":200,"merkle_root":"0x100eeb8fabe2d1cb200324e8ccbcc3ead12cfa18224a744cbe11d813dcb32af8","observation_count":118,"started_at":"2026-05-01T12:00:00.000Z","type":"cycle","v":1}
```

**Size:** 226 bytes UTF-8 (verified). Solana Memo program v2 accepts
up to 566 bytes per memo, and the whole transaction must fit in
1232 bytes (legacy) / 1644 bytes (versioned). Comfortably within all
limits. The Merkle root is the only field whose size grows with
data; everything else is bounded.

### 2.3 TWAP commit memo

**Purpose:** anchor a single hourly TWAP value for one peptide. One
per `peptide_twaps` row we choose to commit (the v1 set is decided
in the open-questions section of the parent doc — likely the active
peptide subset).

**Schema:**

| field                   | type    | meaning                                                                                  |
| ----------------------- | ------- | ---------------------------------------------------------------------------------------- |
| `v`                     | integer | Protocol version. Always `1`.                                                            |
| `type`                  | string  | Always the literal `"twap"`.                                                             |
| `algo`                  | string  | Algorithm identifier. v1 ships a single algorithm: `"filtered_median_v1"` — see below.   |
| `peptide_code`          | string  | The `peptides.code` value (e.g. `"BPC157"`). Stable identifier, never renamed.           |
| `twap_value`            | string  | The `peptide_twaps.twap_usd_per_mg` value rendered per §2.5. **String, not number.**     |
| `computed_at`           | string  | `peptide_twaps.computed_at` in canonical timestamp form.                                 |
| `window_start`          | string  | `peptide_twaps.window_start` in canonical timestamp form.                                |
| `window_end`            | string  | `peptide_twaps.window_end` in canonical timestamp form.                                  |
| `observation_set_root`  | string  | `0x` + 64 hex. Merkle root over the observations that fed this TWAP — see §2.6.          |

**About `algo`** (added during review): the field identifies which
TWAP algorithm produced `twap_value`. v1 ships a single algorithm,
named `"filtered_median_v1"`. "Filtered" refers to the **input
filtering** the worker applies before computing the median —
latest-per-supplier-within-freshness-ceiling, `scrape_success=true`,
`availability_tier='in_stock'`. The median itself is unfiltered
(no outlier removal); the v1 design is documented in
`apps/worker/src/twap.ts` and §03.3.2.

Why ship `algo` in v1 rather than waiting for a v2 protocol bump:
keeps historical verifications deterministic forever. If we ever
ship a `"filtered_median_v2"` (e.g. adding MAD-based outlier
filtering), commits made under v1 still verify against the v1
algorithm and commits made under v2 verify against v2. Without
the field, every algorithm change would silently invalidate
previous TWAP-value-recomputation checks. The same `v` field still
governs memo schema versioning (§2.4); `algo` governs the value-
production algorithm independently.

A verifier MUST inspect `algo` and refuse to recompute the TWAP
value if it doesn't recognise the identifier (per §05.3 step 7).
The Merkle-root chain of evidence (§5.3 steps 2–6) doesn't depend
on `algo` and verifies regardless.

**Example** (canonical, byte-exact):

```
{"algo":"filtered_median_v1","computed_at":"2026-05-01T12:00:00.000Z","observation_set_root":"0x100eeb8fabe2d1cb200324e8ccbcc3ead12cfa18224a744cbe11d813dcb32af8","peptide_code":"BPC157","twap_value":"5.998000","type":"twap","v":1,"window_end":"2026-05-01T12:00:00.000Z","window_start":"2026-05-01T11:00:00.000Z"}
```

**Size:** 312 bytes UTF-8 (verified). Up from 284 in the pre-`algo`
draft; ~28 extra bytes for the `"algo":"filtered_median_v1",`
fragment. Same Memo / transaction budget headroom as cycle
commits — Memo program v2 caps at 566 bytes per memo and the full
transaction stays well under both 1232 (legacy) and 1644
(versioned) byte ceilings.

### 2.4 Versioning

The `v` field is a single positive integer that names the protocol
version of this document. **v=1 is the version specified here.**

**Rules:**

- Any future change to memo schemas, canonicalization rules, leaf
  formats, hash function, tree construction, or domain-separation
  bytes — anything that would change the byte-for-byte output for
  the same input — **must** bump `v` and ship under a new spec
  document (e.g. `02-cryptographic-primitives-v2.md`).
- A verifier MUST inspect `v` first and dispatch to the appropriate
  version logic. If `v` is unknown, the verifier MUST refuse to
  verify and MUST surface this as an explicit "unsupported protocol
  version" error rather than a generic mismatch.
- Old commits (v=1 commits already on-chain) remain verifiable
  forever under v1 rules. There is no in-place upgrade.
- A single memo MUST contain commits of exactly one protocol
  version. Mixed-version memos are not defined.

**Backward-compatibility expectation:** we don't promise that a v2
verifier can read v1 commits with v2 code paths. Verifiers that need
to handle both versions MUST keep both implementations side-by-side
and dispatch on `v`. The benefit is that v1 commits are forever
self-contained — no migration step can invalidate proofs that were
already anchored.

### 2.5 Decimal value representation

`twap_value`, `raw_price`, `fx_rate_to_usd`, `price_usd_per_mg` —
every numeric column with a fractional part — is rendered as a
**JSON string**, not a JSON number.

**Why string, not number:**

- JSON's number type is conceptually a 64-bit float, and parsers
  implement it as such by default. Round-tripping a Postgres
  `numeric(20, 6)` through `JSON.parse` / `JSON.stringify` in any
  major language can quietly lose precision (e.g. `5.998000` becomes
  `5.998` becomes `"5.998"` in re-canonicalization, and the hash
  doesn't match).
- We can't ban "use BigDecimal in your JSON parser" because we don't
  control the verifier's stack. But we can ban floats from the wire.
- Strings are byte-identical across every parser. The verifier
  reads the exact characters we wrote.

**Rendering rule:** the canonical string form of a Postgres `numeric`
column is exactly what Postgres returns for `column::text` —
fixed-point, no scientific notation, no trailing-zero stripping.
Examples:

| DB value (numeric) | canonical string |
| ------------------ | ---------------- |
| `5`                | `"5"`            |
| `5.0`              | `"5.0"`          |
| `5.998`            | `"5.998"`        |
| `5.998000`         | `"5.998000"`     |
| `-0.000001`        | `"-0.000001"`    |
| `0`                | `"0"`            |
| `null`             | `null` (JSON literal, not the string `"null"`) |

The committer reads each numeric column as `column::text` from the
DB and uses that string verbatim. The verifier does the same. Any
caller that wants to normalize ("strip trailing zeros") for display
does that **after** verification — never before.

`numeric(20,6)` columns will always have exactly 6 decimal places
when rendered this way; that's fine and stable. Columns whose
scale isn't fixed (the bare `numeric` ones) carry whatever scale
the inserter wrote.

### 2.6 Timestamp representation

Every timestamp field is **ISO 8601 UTC with millisecond precision**
and a literal `Z` suffix. Format: `YYYY-MM-DDTHH:MM:SS.sssZ`.

- 24 characters always, fixed width. No timezone offsets, no
  variable fractional precision, no `+00:00` instead of `Z`.
- Source values from Postgres `timestamptz` get coerced to UTC,
  truncated to millisecond precision, and rendered with exactly 3
  digits of fractional seconds (zero-padded). A value with finer
  precision in the DB is **truncated, not rounded** — we want bit
  exactness with the source.
- A value with coarser precision in the DB is zero-padded
  (`12:00:00` → `12:00:00.000`).

The committer reads timestamps as `to_char(column AT TIME ZONE 'UTC',
'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')` from Postgres, or equivalent in
the application layer. The verifier reproduces the same format from
the same source row.

### 2.7 NULL handling

JSON `null` is a distinct value from a missing field. **A field that
the schema declares MUST always be present, even when its value is
null.** Omitting an optional field would let the prover hide data
from the verifier — so we don't allow optional fields.

In §2.2 / §2.3 every field is required. In §4 (leaf canonicalization)
every observation field is required: a column with no value is
serialized as JSON `null`.

---

## 4. Merkle tree construction

### 4.1 Goal

Every `supplier_observations` row from a single scrape cycle becomes
exactly one leaf in a binary Merkle tree. The 32-byte root of that
tree is what the cycle commit memo (§2.2) anchors on-chain. A
third party with the row data can recompute the leaf, ask the API
for a Merkle proof (§5 / §6), and verify the proof against the
on-chain root.

The whole point is determinism: anyone with the same input rows
recomputes the same root, byte-exact, in any language.

### 4.2 Observation canonical form

Every leaf is a canonical JSON object (per §2.1) containing
exactly these 17 fields, every one always present:

| field                  | source column                                  | type in JSON                       |
| ---------------------- | ---------------------------------------------- | ---------------------------------- |
| `id`                   | `supplier_observations.id`                     | integer                            |
| `supplier_id`          | `supplier_observations.supplier_id`            | integer                            |
| `peptide_id`           | `supplier_observations.peptide_id`             | integer                            |
| `supplier_product_id`  | `supplier_observations.supplier_product_id`    | integer                            |
| `scraper_run_id`       | `supplier_observations.scraper_run_id`         | integer                            |
| `observed_at`          | `supplier_observations.observed_at`            | timestamp string (§2.6)            |
| `raw_price`            | `supplier_observations.raw_price`              | decimal string (§2.5) or `null`    |
| `raw_currency`         | `supplier_observations.raw_currency`           | string or `null`                   |
| `fx_rate_to_usd`       | `supplier_observations.fx_rate_to_usd`         | decimal string (§2.5) or `null`    |
| `price_usd_per_mg`     | `supplier_observations.price_usd_per_mg`       | decimal string (§2.5) or `null`    |
| `raw_availability`     | `supplier_observations.raw_availability`       | string or `null`                   |
| `availability_tier`    | `supplier_observations.availability_tier`      | string (enum value)                |
| `lead_time_days`       | `supplier_observations.lead_time_days`         | integer or `null`                  |
| `scrape_success`       | `supplier_observations.scrape_success`         | boolean                            |
| `scrape_error`         | `supplier_observations.scrape_error`           | string or `null`                   |
| `http_status`          | `supplier_observations.http_status`            | integer or `null`                  |
| `raw_html_hash`        | `supplier_observations.raw_html_hash`          | string or `null`                   |

**Excluded** from the leaf: `created_at` (DB write timestamp; differs
from `observed_at` and adds noise without provenance value).

**Field selection rationale:** included everything that describes
**what we observed**: identity (5 ids), when (`observed_at`),
provenance for the price (`raw_*`, `fx_rate_to_usd`,
`price_usd_per_mg`), availability state, and the scraper's own
self-report (`scrape_*`, `http_status`, `raw_html_hash`).

**About `raw_html_hash`** (important — the column name is misleading):
in v1, this field is a **128-bit truncated SHA-256 fingerprint of
already-parsed observation fields**, not a hash of any raw HTML or
HTTP response body. The WooCommerce scrapers compute it from
`{id, price, currency, in_stock, variant}` (see
`apps/scraper/src/suppliers/woocommerce.ts:287-297`); the Cayman
adapter uses the response payload but Cayman is `status='paused'`
and produces no observations. Including this field in the leaf
serves only as a **tamper-detection checksum for the parsed row** —
if any of the five inputs are altered after the observation is
written, the stored hash mismatches. It does **not** serve as a
re-scrapable source attestation. A verifier holding the row's parsed
fields can trivially recompute the hash; conversely, an attacker who
can mutate the row can also mutate the hash. The cryptographic
property the v1 leaf delivers is **database-integrity attestation**,
not vendor-page attestation. See §4.7 for the full trust-model
discussion and §4.7.2 for the v2 roadmap on real source attestation.

**Integer ids** fit safely in JSON's 2⁵³ budget for our scale and
are written as JSON integers, not strings. If we ever cross 2⁵³ for
any id column (we won't, but for completeness), the protocol must
bump to v2 with strings.

**Canonicalization** then applies §2.1 (sorted keys, no whitespace,
UTF-8). Same canonical form whether the leaf is being computed at
commit time or at verification time.

### 4.3 Leaf hashing

```
leaf_hash = SHA-256( 0x00 || canonical_json_utf8 )
```

Where:

- `0x00` is a single byte (the literal value zero), prepended for
  domain separation between leaves and internal nodes (§4.4).
- `canonical_json_utf8` is the UTF-8 byte string from §4.2.
- `||` is byte concatenation.
- `SHA-256` is the standard hash, NIST FIPS 180-4. Output is 32 raw
  bytes.

The leaf hash is held internally as raw bytes during tree
construction and rendered to `0x` + 64 hex chars only at API
boundaries (Merkle proof responses, log lines).

### 4.4 Domain separation

Leaves and internal nodes use distinct one-byte prefixes before the
SHA-256 input:

- Leaves:           `0x00`
- Internal nodes:   `0x01`

This is the RFC 6962 (Certificate Transparency) construction. It
prevents a class of second-preimage attacks where an internal node
hash could be presented as a leaf (or vice versa) to forge a proof.
Without the prefix, `SHA-256(left || right)` could collide with
some leaf hash by accident; with the prefix, leaves and internal
nodes live in disjoint hash spaces.

### 4.5 Tree construction

**Order leaves** by `id` ascending. The DB is the source of truth
for ordering — there are no ties (`id` is bigint primary key) and
the ordering is stable across re-runs.

**Pair adjacent nodes at each level** to produce the next level:

```
inner_hash = SHA-256( 0x01 || left_hash || right_hash )
```

Both `left_hash` and `right_hash` are 32-byte SHA-256 outputs (raw
bytes), so the input to the inner hash is exactly 65 bytes.

**Odd-count handling at any level:** duplicate the last node and
pair it with itself. This is the Bitcoin-style construction (rather
than RFC 6962's more rigorous handling). The trade-off: duplication
admits a small edge case where a 2*n*-leaf tree and an *n*-leaf tree
where each leaf is paired-with-itself at the last level could
produce equal roots — but combined with our `0x00`/`0x01` domain
separation and the fact that we always commit the
`observation_count` alongside the root in the cycle memo, the
ambiguity is resolvable: a verifier checks
`observation_count == leaf_count` before accepting any proof.

**Termination:** recurse until exactly one node remains. That node
is the **root**. Output: 32 raw bytes; rendered as `0x` + 64
lowercase hex chars wherever it appears in JSON.

**Edge cases:**

- **Zero observations.** A scrape cycle that ran but produced zero
  rows is **not committed**. The committer skips and logs. There is
  no defined "empty tree" root in v1 — committing zero data would
  be paying a transaction fee for nothing.
- **One observation.** Root = leaf hash itself. No internal nodes.
  Proof for that single observation is the empty list `[]`, and the
  verifier compares the leaf hash directly against the root.

### 4.6 Worked example

Four real observations from a hypothetical cycle (cycle_id=200,
peptide BPC157 across four suppliers). Three are successful scrapes
(obs 1, 2, 3) and **one is a failed scrape (obs 4, vendor returned
403)** — included deliberately to demonstrate canonical handling of
failed-scrape rows. Per §4.8, the committer commits ALL observations
in a cycle, successful or not; failed scrapes are themselves
informational and the canonical leaf is well-defined when their
nullable fields are `null` (per §2.7 NULL handling). An
implementation that filters out failed-scrape rows before tree
construction will produce a different root for this input set and
is non-conformant with the trust-maximalist position §4.8 takes.

For brevity I show the canonical body of leaf 1 in full, then the
bytes of all four leaf hashes and the tree above them. **All hashes
here are real SHA-256 outputs** of the bytes shown — recompute them
in any language to verify.

**Note on decimal scales:** the `raw_price`, `fx_rate_to_usd`, and
`price_usd_per_mg` strings below reflect schema migration 0004
(`numeric(20,6)`, `numeric(20,8)`, `numeric(20,6)` respectively).
Per §2.5 the canonical decimal string is whatever Postgres returns
for `column::text`; a fixed-scale numeric column always renders
with that exact scale, so e.g. `54.5` stored in a `numeric(20,6)`
column canonicalizes as `"54.500000"`. The canonicalization rule
itself is unchanged from the v1 spec — only the example strings
below were corrected to match the schema's actual scales.

**Observation 1 canonical form** (sorted keys, no whitespace):

```
{"availability_tier":"in_stock","fx_rate_to_usd":"1.00000000","http_status":200,"id":1001,"lead_time_days":null,"observed_at":"2026-05-01T12:00:00.000Z","peptide_id":12,"price_usd_per_mg":"3.633333","raw_availability":"in stock","raw_currency":"USD","raw_html_hash":"0xaaaaaaaa","raw_price":"54.500000","scrape_error":null,"scrape_success":true,"scraper_run_id":200,"supplier_id":7,"supplier_product_id":140}
```

**Observations 2 / 3 / 4** follow the same shape with the values
shown in the table below. (Full canonical bodies are mechanically
derivable from these inputs and §2.1.)

| field             | obs 1                   | obs 2                   | obs 3                       | obs 4                   |
| ----------------- | ----------------------- | ----------------------- | --------------------------- | ----------------------- |
| id                | 1001                    | 1002                    | 1003                        | 1004                    |
| supplier_id       | 7                       | 4                       | 6                           | 1                       |
| peptide_id        | 12                      | 12                      | 12                          | 12                      |
| supplier_product_id | 140                   | 141                     | 142                         | 143                     |
| scraper_run_id    | 200                     | 200                     | 200                         | 200                     |
| observed_at       | 2026-05-01T12:00:00.000Z | 2026-05-01T12:00:01.000Z | 2026-05-01T12:00:02.000Z | 2026-05-01T12:00:03.000Z |
| raw_price         | "54.500000"             | "75.000000"             | null                        | null                    |
| raw_currency      | "USD"                   | "USD"                   | "USD"                       | null                    |
| fx_rate_to_usd    | "1.00000000"            | "1.00000000"            | "1.00000000"                | null                    |
| price_usd_per_mg  | "3.633333"              | "5.000000"              | null                        | null                    |
| raw_availability  | "in stock"              | "in stock"              | "sold out"                  | null                    |
| availability_tier | "in_stock"              | "in_stock"              | "out_of_stock"              | "unknown"               |
| lead_time_days    | null                    | null                    | null                        | null                    |
| scrape_success    | true                    | true                    | true                        | false                   |
| scrape_error      | null                    | null                    | null                        | "403 Forbidden"         |
| http_status       | 200                     | 200                     | 200                         | 403                     |
| raw_html_hash     | "0xaaaaaaaa"            | "0xbbbbbbbb"            | "0xcccccccc"                | null                    |

**Leaf hashes** (`SHA-256(0x00 || canonical_json_utf8)`):

```
L1 = 0x799fe69ea74165d8321268f25d560e3ed48f57ab4d0552a9d866acda15238db5
L2 = 0x1eabe587a9f12e9a7cce5e0d601146e2e4011100961f19d2e11c8759f52f72b2
L3 = 0x8c02334f0c170326a91dd6d64b27a44b48ff67d2dbc1afb9986ec7ba2eb6db23
L4 = 0xea784b0d61953f0f61a236f49fa7bbfae729a3b5a874ef9e3dfa140ecc21b567
```

**Inner nodes** (`SHA-256(0x01 || left || right)`, raw bytes
concatenated):

```
N12 = SHA-256(0x01 || L1_bytes || L2_bytes)
    = 0xab602f7b7e6eafb0c9a8d67d372a05df930f4236b8188467f61aa01055f0fbdb

N34 = SHA-256(0x01 || L3_bytes || L4_bytes)
    = 0xe8311c85eda90c265477f52a679554cebfff67611144f1a52f16a1a753d232b8
```

**Root:**

```
ROOT = SHA-256(0x01 || N12_bytes || N34_bytes)
     = 0x100eeb8fabe2d1cb200324e8ccbcc3ead12cfa18224a744cbe11d813dcb32af8
```

**Tree visualisation:**

```
                          ROOT
                  100eeb8f…cb32af8
                 /                \
            N12                    N34
     ab602f7b…55f0fbdb      e8311c85…53d232b8
     /        \              /        \
   L1          L2          L3          L4
799fe69e… 1eabe587…    8c02334f… ea784b0d…
   |          |           |          |
 obs 1     obs 2       obs 3      obs 4
```

The cycle commit memo for this example would be (cycle_id=200,
observation_count=4):

```
{"completed_at":"2026-05-01T12:00:09.000Z","cycle_id":200,"merkle_root":"0x100eeb8fabe2d1cb200324e8ccbcc3ead12cfa18224a744cbe11d813dcb32af8","observation_count":4,"started_at":"2026-05-01T12:00:00.000Z","type":"cycle","v":1}
```

A verifier with observation 3 (in its current Postgres form) and
the cycle commit can ask the API (§6) for the Merkle proof for
`observation_id=1003`. The returned proof is
`[{ position: "left", hash: L4 }, { position: "left", hash: N12 }]`
— by hashing L3 with its sibling at each level (carefully ordering
left/right based on the position field) the verifier arrives at the
same `0x9c0516…` root that was anchored on Solana, and can confirm
the on-chain memo's `merkle_root` matches.

What this proves: **the row in the database today is byte-for-byte
the row that was committed at the time of the cycle commit.** What
it does not prove: that the underlying vendor page actually said
what we recorded. The `raw_html_hash` field in the leaf is a
parsed-fields checksum (see §4.2 caveat and §4.7), not a re-scrapable
artifact. v1 anchors database state; vendor-page attestation is a
candidate v2 protocol bump (§4.7.2).

### 4.7 Trust model and v2 roadmap

This section nails down what v1 commits actually prove, what they
don't, and what we'd need to change to extend the trust property.
Worth being explicit so consumers of the oracle (a smart contract,
a UI, an auditor) calibrate how much they're trusting.

#### 4.7.1 What v1 attests: database integrity

After a cycle commit lands on Solana, anyone holding the
`supplier_observations` rows for that cycle can prove that the rows
in the database **are byte-for-byte the rows that existed at the
moment of the commit**. The Merkle root binds the canonical leaf
form of each row; the on-chain memo binds the root, the
`observation_count`, and the cycle timestamps. If any field of any
included row is altered post-commit (price changed, timestamp
backdated, supplier swapped, anything), the leaf hash changes, the
root changes, and the on-chain Memo doesn't match.

Symmetrically: if anyone — including the operator — wanted to
**rewrite history**, they'd need to forge a Solana signature and
backdate the slot, both of which are infeasible given the chain's
tamper-evidence guarantees.

So v1 protects against:
- Silent post-hoc edits to observation rows
- Selective deletion of inconvenient observations from a committed cycle
- Re-ordering the dataset to influence downstream TWAPs
- Operator equivocation (different rows shown to different consumers)

#### 4.7.2 What v1 does NOT attest: vendor-page truth

v1 commits do **not** prove that the rows we wrote down accurately
reflect what the vendor's website said. The `raw_html_hash` field
in the leaf — despite the name — is a 128-bit truncated SHA-256
over a small JSON of parsed fields (`id`, `price`, `currency`,
`in_stock`, `variant`), not a hash of the actual HTTP response body.
A third party can't take a vendor URL, fetch it, hash the response,
and check it against `raw_html_hash` because the two values aren't
derived from the same input.

Source attestation is the natural v2 protocol bump. The shape would
be: replace or supplement `raw_html_hash` with a `raw_response_hash`
that's the SHA-256 (full 256 bits) of the canonicalized HTTP response
body the scraper saw. "Canonicalized" because vendor responses
include variable elements (session ids, server timestamps, ads) that
need stripping before hashing or every fetch produces a different
hash. WooCommerce JSON responses (`/wp-json/wc/store/v1/products/<id>`)
are far more deterministic than HTML and are a reasonable starting
point — a v2 design pass would specify exactly which response fields
go into the canonical form, mirroring §4.2's approach for
observations. Until that lands, v1 callers should not advertise
"verifiable against vendor pages" as a property of the oracle.

#### 4.7.3 Truncation and collision resistance

`raw_html_hash` is **128 bits** (32 hex characters), produced by
truncating a full 256-bit SHA-256 output. Collision resistance for
a 128-bit hash is bounded at roughly `2^64` operations under the
birthday bound — i.e. an attacker would need on the order of 18
quintillion hash computations to find any collision. That's
comfortably above any plausible attacker budget at our scale, and
adequate for the tamper-detection role this field plays in §4.7.1.

If v2 promotes the field to a real source attestation, it should
also widen the hash to the full 256 bits. The 128-bit truncation
exists in v1 only to keep the legacy `supplier_observations` schema
compact; once we're committing source bytes, the storage cost of a
real 256-bit hash is trivial.

The Merkle leaf hash (§4.3) and tree node hash (§4.4) are the **full**
256-bit SHA-256 outputs. Only `raw_html_hash` is truncated; the
crypto-anchoring primitives are full-width.

### 4.8 Operational note: vendor status hygiene

**This section flags an operational concern, not a protocol rule —
but it affects what shows up in commits, so it's worth pinning here
so the database schema and committer-service specs don't paper over
it.**

Two suppliers — `BACHEM` and `SIGMA` — have `suppliers.status =
'active'` but produce **zero successful observations** because of
anti-bot blocks from datacenter IPs. Last 24h: 363 attempts each,
all failed (no `raw_html_hash`, no price, no availability). They've
been documented as "paused" in `apps/scraper/src/suppliers/index.ts`
comments since 0019, but the database column wasn't updated.

Consequences if left as-is:

- The committer's "active vendor" filter (when computing things like
  cycle observation counts or vendor leaderboards) sees them as
  contributors and reports thin or zero coverage from them.
- The cycle commit memo's `observation_count` is unaffected (it
  counts actual rows, not expected rows), but downstream analytics
  may misreport.
- BACHEM/SIGMA do appear in cycle commits as failure attestations.
  Their failed-scrape rows commit with `raw_html_hash=null`,
  `scrape_success=false`, and `scrape_error` populated. This is the
  trust-maximalist position: the operator MUST NOT be able to hide
  vendor failures (or anti-bot blocks) from the on-chain record. A
  403 at a given timestamp is itself an attestation that the oracle
  attempted the scrape — material evidence about vendor reachability
  that downstream consumers (and the operator's own auditors) need
  to see. The canonical leaf is well-defined for failed rows: every
  field is still present, with `null` for the columns that have no
  value (`raw_html_hash`, `raw_price`, `raw_currency`,
  `fx_rate_to_usd`, `price_usd_per_mg`, `raw_availability`).

Cleanup before the committer ships:

1. `update public.suppliers set status = 'paused' where code in
   ('BACHEM', 'SIGMA');` — bring the DB in line with the operational
   reality. Cayman is already paused; same treatment for the other
   two. **Note:** pausing a supplier stops the scraper from generating
   *new* observations for it, but does not exclude the supplier's
   historical or in-flight rows from cycle commits — those remain
   eligible per §4.6.

2. The committer's `fetchCycleObservations` query (§3.2.2) MUST NOT
   filter on `scrape_success`. The cycle's `observation_count` in
   the memo is the total row count for the cycle, including failures.
   `commit_observations` is therefore an *all-rows* junction.

### 4.9 Implementation notes (non-normative)

These don't change the spec but help anyone building it:

- Operate on raw bytes throughout the tree algorithm. Convert to
  hex strings only at API / log boundaries.
- A simple recursive implementation is fine; for our scale (≤ a few
  thousand leaves per cycle), tree construction is microseconds and
  not worth optimizing.
- Test with the worked example above as a regression vector.
  Implementations that don't reproduce `ROOT =
  0x100eeb8fabe2d1cb200324e8ccbcc3ead12cfa18224a744cbe11d813dcb32af8`
  for the input above are wrong.
- Two convenient libraries: `node:crypto` (Node) and `hashlib`
  (Python). Both produce the same SHA-256 bytes given the same
  input, which is the entire point.
