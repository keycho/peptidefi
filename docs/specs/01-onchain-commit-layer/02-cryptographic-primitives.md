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
{"completed_at":"2026-05-01T12:00:09.000Z","cycle_id":200,"merkle_root":"0x9c0516afa29a523ee901e26fd372c285d273671b5e08e7be606d6b8e8d22789e","observation_count":118,"started_at":"2026-05-01T12:00:00.000Z","type":"cycle","v":1}
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
| `peptide_code`          | string  | The `peptides.code` value (e.g. `"BPC157"`). Stable identifier, never renamed.           |
| `twap_value`            | string  | The `peptide_twaps.twap_usd_per_mg` value rendered per §2.5. **String, not number.**     |
| `computed_at`           | string  | `peptide_twaps.computed_at` in canonical timestamp form.                                 |
| `window_start`          | string  | `peptide_twaps.window_start` in canonical timestamp form.                                |
| `window_end`            | string  | `peptide_twaps.window_end` in canonical timestamp form.                                  |
| `observation_set_root`  | string  | `0x` + 64 hex. Merkle root over the observations that fed this TWAP — see §2.6.          |

**Example:**

```
{"computed_at":"2026-05-01T12:00:00.000Z","observation_set_root":"0x9c0516afa29a523ee901e26fd372c285d273671b5e08e7be606d6b8e8d22789e","peptide_code":"BPC157","twap_value":"5.998000","type":"twap","v":1,"window_end":"2026-05-01T12:00:00.000Z","window_start":"2026-05-01T11:00:00.000Z"}
```

**Size:** 284 bytes UTF-8 (verified). Same Memo / transaction
budget headroom as cycle commits.

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
`price_usd_per_mg`), availability state, and source attestation
(`scrape_*`, `http_status`, `raw_html_hash`). `raw_html_hash` is
particularly load-bearing — it pins the source of the observation
to a hash of the actual scraped HTML, so a third party can in
principle re-scrape the same vendor URL and check the source matched
what we saw.

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
peptide BPC157 across four suppliers). For brevity I show the
canonical body of leaf 1 in full, then the bytes of all four leaf
hashes and the tree above them. **All hashes here are real
SHA-256 outputs** of the bytes shown — recompute them in any
language to verify.

**Observation 1 canonical form** (sorted keys, no whitespace):

```
{"availability_tier":"in_stock","fx_rate_to_usd":"1.000000","http_status":200,"id":1001,"lead_time_days":null,"observed_at":"2026-05-01T12:00:00.000Z","peptide_id":12,"price_usd_per_mg":"3.633333","raw_availability":"in stock","raw_currency":"USD","raw_html_hash":"0xaaaaaaaa","raw_price":"54.50","scrape_error":null,"scrape_success":true,"scraper_run_id":200,"supplier_id":7,"supplier_product_id":140}
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
| raw_price         | "54.50"                 | "75.00"                 | null                        | null                    |
| raw_currency      | "USD"                   | "USD"                   | "USD"                       | null                    |
| fx_rate_to_usd    | "1.000000"              | "1.000000"              | "1.000000"                  | null                    |
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
L1 = 0x1e16c4304f26d820628da73d43579cb3dd6e5f5a9a47a2cb299ace9ee7330594
L2 = 0x959381874f74d9903fbdeb87ad8c1d77e7b9e3a066abcc0d14b467fb0cbfafde
L3 = 0xee80eadf0626319bf490cd0d7aabae0c737d905c09d6e5e36f645b19cdf221d3
L4 = 0xea784b0d61953f0f61a236f49fa7bbfae729a3b5a874ef9e3dfa140ecc21b567
```

**Inner nodes** (`SHA-256(0x01 || left || right)`, raw bytes
concatenated):

```
N12 = SHA-256(0x01 || L1_bytes || L2_bytes)
    = 0xae4cca3083ad2b4cdd9a444dc20b41861f7c41d8521324d52e8c94a3faf2d0d2

N34 = SHA-256(0x01 || L3_bytes || L4_bytes)
    = 0x0ec68c7f5b4d998218079a2bc8a7ff6f4b29297e9b755cacf051433cb62479d4
```

**Root:**

```
ROOT = SHA-256(0x01 || N12_bytes || N34_bytes)
     = 0x9c0516afa29a523ee901e26fd372c285d273671b5e08e7be606d6b8e8d22789e
```

**Tree visualisation:**

```
                          ROOT
                  9c0516af…d22789e
                 /                \
            N12                    N34
     ae4cca30…faf2d0d2      0ec68c7f…b62479d4
     /        \              /        \
   L1          L2          L3          L4
1e16c430… 95938187…    ee80eadf… ea784b0d…
   |          |           |          |
 obs 1     obs 2       obs 3      obs 4
```

The cycle commit memo for this example would be (cycle_id=200,
observation_count=4):

```
{"completed_at":"2026-05-01T12:00:09.000Z","cycle_id":200,"merkle_root":"0x9c0516afa29a523ee901e26fd372c285d273671b5e08e7be606d6b8e8d22789e","observation_count":4,"started_at":"2026-05-01T12:00:00.000Z","type":"cycle","v":1}
```

A verifier with observation 3 and the cycle commit can ask the API
(§6) for the Merkle proof for `observation_id=1003`. The returned
proof is `[{ position: "left", hash: L4 }, { position: "left", hash:
N12 }]` — by hashing L3 with its sibling at each level (carefully
ordering left/right based on the position field) the verifier
arrives at the same `0x9c0516…` root that was anchored on Solana,
and can confirm the on-chain memo's `merkle_root` matches.

### 4.7 Implementation notes (non-normative)

These don't change the spec but help anyone building it:

- Operate on raw bytes throughout the tree algorithm. Convert to
  hex strings only at API / log boundaries.
- A simple recursive implementation is fine; for our scale (≤ a few
  thousand leaves per cycle), tree construction is microseconds and
  not worth optimizing.
- Test with the worked example above as a regression vector.
  Implementations that don't reproduce `ROOT =
  0x9c0516afa29a523ee901e26fd372c285d273671b5e08e7be606d6b8e8d22789e`
  for the input above are wrong.
- Two convenient libraries: `node:crypto` (Node) and `hashlib`
  (Python). Both produce the same SHA-256 bytes given the same
  input, which is the entire point.
