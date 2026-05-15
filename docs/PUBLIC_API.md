# BioHash Public API

Public, read-mostly REST surface for the BioHash oracle. Source of
truth for endpoint paths, request/response shapes, rate limits, and
cache TTLs. Every route below is implemented in `apps/api/src/`.

**Base URL** (production): `https://peptidefi-production-c6d9.up.railway.app`

---

## Authentication

Three classes of auth, in increasing privilege:

1. **None.** Every endpoint under `/v1/*`, `/authority`, `/health`,
   `/vendors/leaderboard`, `/arbitrage`, and `/api/anomalies` is
   open. No keys, no signatures.
2. **Wallet signature.** `POST /api/leads/*` requires a Solana
   ed25519 signature over a canonical message. See `POST /api/leads/submit`
   below for the body shape.
3. **Admin bearer token.** `/api/admin/*` requires
   `Authorization: Bearer <ADMIN_API_TOKEN>`. Same token can also be
   sent via `X-Admin-Token` header to **bypass per-IP rate limits**
   on any public endpoint (useful when our own dashboard hits the
   API under load).

---

## Error response shape

Every non-2xx response uses this body:

```json
{
  "code": "RATE_LIMITED",
  "message": "rate limit exceeded (60/window)",
  "status": 429,
  "retry_after_seconds": 42
}
```

Required fields: `code`, `message`, `status`.
Optional: `retry_after_seconds` (set on `RATE_LIMITED` and
`SERVICE_UNAVAILABLE`); `details` (diagnostic context — never
contains stack traces in production).

Standard `code` values:
- `BAD_REQUEST` (400) — input validation
- `NOT_AUTHORIZED` (403) — wrong wallet sig / admin token
- `NOT_FOUND` (404) — no such route, or row not in DB
- `RATE_LIMITED` (429) — per-IP throttle hit; honor `Retry-After`
- `INTERNAL_ERROR` (500) — server bug; check anomaly log
- `SERVICE_UNAVAILABLE` (503) — env misconfig / dependency down
- `DB_ERROR` (500) — upstream Postgres / PostgREST error

Route-specific codes (e.g. `INVALID_WALLET_ADDRESS`,
`SIGNATURE_EXPIRED`, `COHORT_FULL`, `DEVNET_LEGACY_AUTHORITY`) are
documented under the relevant endpoint.

---

## Rate limits

Per-IP, sliding window. `X-RateLimit-*` headers (IETF draft-7) are
emitted on every response. `Retry-After` is set when the limit is
hit.

| Class | Limit | Window | Endpoints |
|---|---|---|---|
| public-read | 60 | 1 min | `/v1/*`, `/authority`, `/vendors/*`, `/arbitrage`, `/api/anomalies` |
| public-write | 10 | 1 min | `/api/leads/*` (POST + GET) |
| submit-strict | 5 | 1 hour | `POST /api/leads/submit` (composes with public-write) |
| admin | — | — | `/api/admin/*` (gated by bearer token, no rate limit) |

**X-Admin-Token bypass**: any request with this header set to the
admin token skips per-IP rate limiting. The admin endpoint gating
is unchanged — that still requires `Authorization: Bearer`.

---

## CORS

| Endpoint class | `Access-Control-Allow-Origin` |
|---|---|
| Public reads (`/v1/*`, `/authority`, `/vendors/*`, `/arbitrage`, `/api/anomalies`, `/`, `/health`) | `*` (no credentials) |
| Everything else (POST `/api/leads/*`, `/api/admin/*`) | strict allowlist: `biohash.network`, `*.lovable.app`/`.dev`/`.lovableproject.com`, plus comma-separated `CORS_ORIGINS` env var |

`OPTIONS` preflight is handled automatically for both classes.

---

## Endpoints

### Service / system

#### `GET /`

Basic liveness ping. No auth, no rate limit (system-level).

```json
{ "service": "biohash-api", "ok": true }
```

#### `GET /health`

Used by Railway healthcheck + external monitors. `Cache-Control: no-store`.

```json
{
  "status": "ok",
  "uptime_seconds": 12345,
  "version": "a1b2c3d4e5f6",
  "ok": true,
  "service": "api",
  "started_at": "2026-05-10T14:00:00.000Z",
  "auth": "jose-ES256-jwks",
  "cors": { "lovable_pattern": true, "static_origins": ["..."], "env_extra_count": 0 }
}
```

`version` is the first 12 chars of `RAILWAY_GIT_COMMIT_SHA` (or
`GIT_SHA`, or `"dev"`).

#### `GET /authority`

Trust anchor for verifiers. The `oracle_authority_pubkey` here is
what verifiers compare against on-chain signers. Public, no auth.

- **Rate limit**: 60/min/IP (public-read)
- **Cache**: `public, max-age=600`

```json
{
  "service": "biohash",
  "project_name": "BioHash",
  "protocol_version": 2,
  "cluster": "mainnet-beta",
  "oracle_authority_pubkey": "FmBggsBjzGsHrtMayYG8ix2JzoYhVczrwJaGGKPpNKK7",
  "memo_program_id": "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
  "url": "https://biohash.network",
  "spec_url": "https://github.com/keycho/peptidefi/blob/main/docs/specs/01-onchain-commit-layer.md",
  "rpc_recommendation": "..."
}
```

### Peptides + observations

#### `GET /v1/peptides`

Lists active peptides with current TWAP.

- **Query**: `?cluster=mainnet-beta|devnet|testnet` (optional)
- **Rate limit**: 60/min/IP
- **Cache**: `public, max-age=300` (5 min)

```json
{
  "peptides": [
    {
      "peptide_id": 1,
      "code": "BPC157",
      "display_name": "BPC-157",
      "full_name": "Body Protection Compound 157",
      "twap_commits_count": 47,
      "current_twap": {
        "twap_value": "5.998000",
        "computed_at": "2026-05-10T12:00:00.000Z",
        "solana_signature": "5J3K…aBcD",
        "solana_slot": 347823901,
        "cluster": "mainnet-beta",
        "solscan_url": "https://solscan.io/tx/5J3K…aBcD"
      }
    }
  ],
  "count": 26
}
```

#### `GET /v1/peptides/:id`

Single peptide detail + last 7d of TWAP commits. `:id` accepts
either the numeric `peptides.id` or the stable code (e.g. `BPC157`).

- **Query**: `?cluster=mainnet-beta|devnet|testnet`
- **Rate limit**: 60/min/IP
- **Cache**: `public, max-age=300`

```json
{
  "peptide": {
    "peptide_id": 1,
    "code": "BPC157",
    "display_name": "BPC-157",
    "full_name": "Body Protection Compound 157",
    "is_active": true
  },
  "twap_history": [
    {
      "twap_id": "uuid",
      "twap_value": "5.998000",
      "computed_at": "2026-05-10T12:00:00.000Z",
      "window_start": "2026-05-10T11:00:00.000Z",
      "window_end": "2026-05-10T12:00:00.000Z",
      "status": "finalized",
      "cluster": "mainnet-beta",
      "solana": { "signature": "5J3K…", "slot": 347823901, "solscan_url": "...", "explorer_url": "..." }
    }
  ],
  "history_window": { "start": "...", "end": "..." }
}
```

Errors: `404 NOT_FOUND` for unknown id/code.

#### `GET /v1/peptides/:code/vendor-prices`

Per-vendor latest prices for a peptide. Used by Lovable's price
comparison view.

- **Rate limit**: 60/min/IP
- **Cache**: `public, max-age=60`

#### `GET /v1/peptides/:code/price-history`

Per-vendor price history over a configurable window, plus the TWAP
series for the same window. Powers historical-trajectory views
(e.g. BioHash Oracle Lab) and downstream analytics. Aggregation is
JS-side over `supplier_observations`; PostgREST does not surface
Postgres `date_trunc` grouping.

- **Rate limit**: 60/min/IP (inherits the wildcard `/v1/*` limit)
- **Cache**: `public, max-age=300, s-maxage=300`
- **Auth**: none — public GET, CORS `*`
- **Path param**: `:code` — peptide code, normalised to upper-case.
  Validated `^[A-Z0-9]{2,16}$`.
- **Query**:
  - `?days=` — integer 1..90, default 14
  - `?aggregation=` — `daily` (default) | `hourly`
  - `?vendor=` — optional supplier code (e.g. `PUREHEALTH`).
    Validated `^[A-Z0-9_]{2,32}$`.

**404 cases**:
- `peptide not found: <code>` — `:code` doesn't exist
- `vendor not found: <code>` — `?vendor=` doesn't match any
  `suppliers.code`

Response shape (200):

```json
{
  "peptide_code": "BPC157",
  "peptide_display_name": "BPC-157",
  "window_start": "2026-04-29T11:51:00.000Z",
  "window_end": "2026-05-13T11:51:00.000Z",
  "aggregation": "daily",
  "vendors": [
    {
      "vendor_code": "GENETIC",
      "vendor_display_name": "Genetic Peptide",
      "points": [
        { "timestamp": "2026-04-29T00:00:00.000Z", "price_usd_per_mg": 11.0, "observation_count": 4 },
        { "timestamp": "2026-04-30T00:00:00.000Z", "price_usd_per_mg": 11.0, "observation_count": 4 }
      ]
    },
    {
      "vendor_code": "PUREHEALTH",
      "vendor_display_name": "Pure Health Peptides",
      "points": [
        { "timestamp": "2026-04-29T00:00:00.000Z", "price_usd_per_mg": 3.633, "observation_count": 4 }
      ]
    }
  ],
  "twap_series": [
    { "timestamp": "2026-04-29T00:00:00.000Z", "twap_value_usd_per_mg": 6.699, "cycle_count": 24 }
  ]
}
```

Notes:
- Vendors are returned sorted by `vendor_display_name` ascending; the
  per-vendor `points` array is sorted by `timestamp` ascending.
- `timestamp` values are zero-padded UTC bucket-start ISO 8601 strings:
  - `daily` → `YYYY-MM-DDT00:00:00.000Z`
  - `hourly` → `YYYY-MM-DDTHH:00:00.000Z`
- `price_usd_per_mg` is a `number` rounded to 4 decimal places (this
  endpoint averages per bucket, so full Postgres `numeric` precision
  isn't meaningful — clients wanting the raw per-observation rows
  should use `/v1/observations/:id`).
- Peptides currently in the observation phase (no finalized TWAPs in
  the window) return `200` with `twap_series: []` rather than `404`.

Example:

```bash
curl -sS "https://api.biohash.network/v1/peptides/BPC157/price-history?days=14&aggregation=daily" \
  | jq '{ vendors: .vendors | length, twap_points: .twap_series | length, first_vendor: .vendors[0].vendor_code }'
# → { "vendors": 6, "twap_points": 14, "first_vendor": "GENETIC" }

curl -sS "https://api.biohash.network/v1/peptides/BPC157/price-history?vendor=PUREHEALTH&days=30" \
  | jq '.vendors[0].points | map({timestamp, price_usd_per_mg, observation_count}) | .[0:3]'
```

#### `GET /v1/research/:code`

Peptide Research Index detail page. Combines curated scientific
metadata (overview, mechanism, applications, sequence, MW, aliases,
half-life note, storage note, disclaimer) with live BioHash pricing
(current TWAP, 14-day history, current per-vendor prices) and a
verification anchor (latest finalized commit cycle that contained
an observation of this peptide).

- **Rate limit**: 60/min/IP (inherits the wildcard `/v1/*` limit)
- **Cache**: `public, max-age=300`
- **Auth**: none — public GET, CORS `*`
- **Path param**: `:code` — peptide code, normalised to upper-case.
  Validated `^[A-Z0-9]{2,16}$`.
- **Query**: `?cluster=` — optional; applies to pricing + verification
  blocks. Accepts `mainnet` | `mainnet-beta` | `devnet` | `testnet`.

The research surface is opt-in per peptide. A peptide code is
"indexed" iff it has a row in `peptide_research_metadata` (seeded
via migration 0039). Round-1 launch covers 5 peptides: BPC157,
TB500, GHKCU, GLP1, TIRZEPATIDE. Other codes that exist in the
peptides table but are not yet in the research index return 404
NOT_FOUND so the page can grow incrementally without leaking
skeleton entries.

- **404 cases**:
  - `peptide not found: <code>` — `:code` doesn't exist in the
    `peptides` table.
  - `peptide <code> exists but is not indexed in the research
    surface` — peptide exists but has no `peptide_research_metadata`
    row.

Response shape (200):

```json
{
  "peptide": {
    "code": "BPC157",
    "display_name": "BPC-157",
    "full_name": "Body Protection Compound 157",
    "aliases": ["Body Protection Compound 157", "BPC 157"],
    "sequence": "GEPPPGKPADDAGLV",
    "molecular_weight": 1419.53
  },
  "research": {
    "overview": "BPC-157 (Body Protection Compound 157) is a synthetic 15-amino-acid peptide ...",
    "mechanism": "Studies suggest BPC-157 may interact with the nitric oxide (NO) signaling pathway ...",
    "applications": [
      "Tendon and ligament repair research",
      "Gastrointestinal mucosal research",
      "Vascular and angiogenesis models",
      "Soft-tissue injury research"
    ],
    "half_life_estimate": "Half-life in rodent serum has been reported in the ~30 minute range ...",
    "storage": "Lyophilized powder typically stored at -20°C ...",
    "pubmed_citation_count_estimate": 400,
    "disclaimer": "For research and informational purposes only. Not medical advice. Not for human consumption unless prescribed by a licensed physician."
  },
  "pricing": {
    "current_twap": {
      "twap_value": "6.699",
      "computed_at": "2026-05-11T15:00:00+00:00",
      "solana_signature": "5j9q3mdfBVqAn4Fph39pRivDx...",
      "solana_slot": 419063387,
      "cluster": "mainnet-beta",
      "solscan_url": "https://solscan.io/tx/5j9q3mdfBVqAn4Fph39pRivDx..."
    },
    "twap_history": [
      { "twap_id": "...", "twap_value": "6.699", "computed_at": "...", "window_start": "...", "window_end": "...", "observation_set_root": "0x...", "status": "finalized", "cluster": "mainnet-beta", "solana": { ... }, "finalized_at": "..." }
    ],
    "vendor_count": 6,
    "vendors": [
      { "vendor_name": "Pure Health Peptides", "price_usd_per_mg": "3.633333", "observed_at": "..." }
    ]
  },
  "verification": {
    "latest_cycle_id": 1259,
    "latest_solana_signature": "3fZ17fX4nUtFiH7bYa4HTjpgd...",
    "verified_at_commitment": "finalized",
    "solscan_url": "https://solscan.io/tx/3fZ17fX4nUtFiH7bYa4HTjpgd..."
  }
}
```

The `verification.*` block is best-effort metadata. If `commit_cycles`
lookup fails or no observation has been anchored yet, the four
fields return `null` rather than 500. `verified_at_commitment` is
always `"finalized"` when populated — the research surface only
anchors against finalized cycles.

### IPFS audit trail (`ipfs_cid`)

Every finalized TWAP commit carries an `ipfs_cid` field on the wire
(nullable). When non-null, the CID points to a content-addressed
manifest of the full observation set + per-observation deviation
metric + Solana attestation that produced the commit. The manifest
is fetchable from any IPFS gateway:

```
https://ipfs.io/ipfs/{cid}
https://gateway.pinata.cloud/ipfs/{cid}
```

Relationship to the Solana signature:

| Anchor                | Records                                   | Cost            | Re-fetchable     |
| --------------------- | ----------------------------------------- | --------------- | ---------------- |
| `solana_signature`    | TWAP value + observation_set_root         | On-chain (Memo) | Yes (Solscan)    |
| `ipfs_cid`            | Full observation set + deviation metric   | Off-chain pin   | Yes (any gateway)|

The Solana commitment is the canonical "this happened at this slot"
signal; the IPFS manifest is the audit-trail-quality detail any
verifier needs to recompute the merkle root from raw inputs.

`ipfs_cid` is `null` when:
- The oracle's `PINATA_JWT` is unset (pinning disabled by config); or
- A pin attempt failed and has not yet been retried (no backfill in v1).

In both cases the Solana commit is still authoritative — the IPFS
layer is additive, not blocking.

**Manifest schema (version 1.1)**:

```jsonc
{
  "version": "1.1",
  "peptide_code": "BPC157",
  "cycle_id": 4242,
  "computed_at": "2026-05-13T18:00:00.000Z",
  "twap_value": 6.6990,
  "twap_unit": "USD/mg",
  "algorithm": "filtered_median_v1",
  "merkle_root": "0x...",
  "solana_signature": "3tYeH9w...",
  "solana_slot": 419467611,
  "observations": [
    {
      "vendor_code": "PUREHEALTH",
      "vendor_url": "https://...",
      "raw_price_usd": 18.0,
      "pack_size_mg": 5,
      "price_usd_per_mg": 3.6,
      "observed_at": "2026-05-13T17:55:00.000Z",
      "included_in_twap": true,
      "exclusion_reason": null,
      "deviation_from_median_bps": 4612
    }
    // ... one entry per supplier_observation in the input + dropped sets
  ],
  "index_snapshot": {
    "level": 1024.137931,
    "baseline_date": "2026-05-03",
    "baseline_level": 1000,
    "components_hash": "aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899",
    "computed_at": "2026-05-13T18:00:30.000Z"
  }
}
```

**`index_snapshot` (added in 1.1)**: equal-weight BioHash Peptide Index
level for the same UTC hour as this commit. Null when fewer than the
cohort-size peptides finalized for the hour (per spec, partial hours
are skipped). When non-null, the same `{level, components_hash}`
appears in every per-peptide manifest pinned for the same hour and
matches the row in `public.index_history`.

`components_hash` is reproducible byte-for-byte in any language:

1. Load the cohort's per-peptide TWAPs for the hour. The cohort is the
   set of `peptide_code` values in `public.index_baselines`, locked at
   index launch.
2. Sort by `peptide_code` ASC. For ASCII-only codes (the v1 cohort),
   any byte-lexicographic sort works. JavaScript uses UTF-16
   code-unit order via `<`/`>`; Python `sorted(...)`, Go
   `sort.Slice(...)`, Rust `sort_by_key(...)` produce the same order.
3. Build objects with the keys `{peptide_code, twap_value, weight}` in
   that exact order, where `weight = 1 / N` and N is the cohort size
   (29 at v1 launch).
4. JSON-serialize without whitespace. Numbers use the shortest
   round-trip decimal representation (ECMA-262 §6.1.6.1.13). Python
   `repr()`, Go `strconv.FormatFloat(x, 'g', -1, 64)`, and Rust
   `format!("{}", x)` produce the same string.
5. `sha256` of the resulting bytes, lowercase hex.

Verifier example (Python, N=29 cohort, single non-trivial peptide):

```python
import hashlib, json
components = sorted(
    [{"peptide_code": code, "twap_value": twap, "weight": 1/29}
     for code, twap in twaps_by_peptide.items()],
    key=lambda c: c["peptide_code"],
)
canonical = json.dumps(components, separators=(",", ":"))
h = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
assert h == manifest["index_snapshot"]["components_hash"]
```

`deviation_from_median_bps` is `round(|price − twap_value| / twap_value × 10_000)`,
matching the metric used by the worker's filtered_median_v1 algorithm
(`apps/worker/src/twap.ts#maxDeviationBps`). Null when `twap_value` is
zero (degenerate prices). Surfaced per-observation so an auditor can
see the spread of every input — kept or dropped — without having to
recompute.

`exclusion_reason` is `null` for observations that fed the TWAP and
the literal string `"excluded_by_filtered_median_v1"` for any
observations dropped by the worker's outlier filter. Today's
`filtered_median_v1` is a straight median (no filtering), so
`included_in_twap` is currently always `true` in production — the
manifest schema captures the dropped-row case ahead of time so we
don't have to bump version when MAD-based filtering ships.

### Cycles / observations / TWAPs (verification layer)

#### `GET /v1/cycles`

List recent commit cycles.

- **Query**: `?cluster=`, `?limit=` (default 50, max 200)
- **Rate limit**: 60/min/IP
- **Cache**: `public, max-age=30`

#### `GET /v1/cycles/:id`

Single cycle with all observations + merkle proof material.

- **Rate limit**: 60/min/IP
- **Cache**: `public, max-age=3600` (immutable once finalized)

#### `GET /v1/observations/:id`

Single supplier observation row.

- **Rate limit**: 60/min/IP
- **Cache**: `public, max-age=3600`

#### `GET /v1/twaps/:id`

Single TWAP commit.

- **Rate limit**: 60/min/IP
- **Cache**: `public, max-age=3600`

#### `GET /v1/verify/observation/:id`

End-to-end verifier: 8 checks against the on-chain commit. Returns
`verified: true` on success, or `verified: false` with a specific
`failure_code` per check.

- **Rate limit**: 60/min/IP
- **Cache**: `public, max-age=3600` (verification is deterministic
  for finalized observations)

```json
{
  "verified": true,
  "observation_id": 123456,
  "cycle_id": 1149,
  "leaf_index": 7,
  "leaf_hash": "0xa1b2…",
  "merkle_root": "0xc3d4…",
  "proof": ["0x…", "0x…"],
  "on_chain": {
    "signature": "5J3K…",
    "slot": 347823901,
    "cluster": "mainnet-beta",
    "memo": "{\"v\":2,…}",
    "block_time": 1715000000,
    "solscan_url": "...",
    "explorer_url": "..."
  },
  "checks": [
    {"name":"observation_exists","passed":true},
    {"name":"cycle_anchored","passed":true},
    {"name":"cycle_finalized","passed":true},
    {"name":"leaf_hash_matches_db","passed":true},
    {"name":"merkle_proof_reconstructs","passed":true},
    {"name":"memo_matches_onchain","passed":true},
    {"name":"slot_matches_onchain","passed":true},
    {"name":"signer_matches_authority","passed":true}
  ]
}
```

Failure response shape (one of 8 checks failed):

```json
{
  "verified": false,
  "observation_id": 123456,
  "cycle_id": 1149,
  "failure_reason": "signer_matches_authority",
  "failure_code": "DEVNET_LEGACY_AUTHORITY",
  "failure_detail": "cycle was committed on cluster='devnet' but the verifier API runs on cluster='mainnet-beta'…",
  "checks": [/* … */]
}
```

`failure_code` values (machine-readable):

- **Memo**: `ONCHAIN_MEMO_MISSING`, `ONCHAIN_DRIFT_FROM_ATTESTATION`, `INTENT_DRIFT_FROM_ATTESTATION`, `LEGACY_MEMO_NOT_BACKFILLED`
- **Slot**: `SLOT_DRIFT_FROM_ATTESTATION`, `LEGACY_SLOT_NOT_BACKFILLED`
- **Signer**: `SIGNER_DRIFT_FROM_ATTESTATION`, `DEVNET_LEGACY_AUTHORITY`, `LEGACY_AUTHORITY_NOT_BACKFILLED`

### Vendor market reads

#### `GET /vendors/leaderboard`

Ranks active vendors. Note path is `/vendors/leaderboard`, NOT
`/v1/vendors` — kept under its historical path per the no-URL-
restructuring constraint.

- **Rate limit**: 60/min/IP
- **Cache**: `public, max-age=600`

#### `GET /arbitrage`

Cross-vendor arbitrage opportunities.

- **Rate limit**: 60/min/IP
- **Cache**: `public, max-age=60`

### Operational log

#### `GET /api/anomalies`

Paginated append-only log of pipeline events.

- **Query**: `?severity=info,warn,error,critical` (csv),
  `?event_type=`, `?vendor_id=`, `?peptide_id=`, `?since=`,
  `?until=`, `?limit=` (default 50, max 200), `?cursor=`
- **Rate limit**: 60/min/IP
- **Cache**: `public, max-age=30`

```json
{
  "events": [
    {
      "id": 1234,
      "occurred_at": "2026-05-10T14:32:00Z",
      "severity": "error",
      "event_type": "scrape_failed",
      "vendor_id": "NUSCIENCE",
      "peptide_id": "BPC157",
      "description": "...",
      "context": { /* ... */ },
      "resolved_at": null,
      "resolved_by": null
    }
  ],
  "next_cursor": "2026-05-10T14:31:00Z_1233"
}
```

#### `GET /api/anomalies/:id`

Single event by id (permalinks).

- **Rate limit**: 60/min/IP
- **Cache**: `public, max-age=60`

#### `GET /api/anomalies/feed.xml`, `GET /api/anomalies/feed.json`

RSS 2.0 / JSON Feed 1.1 of the last 100 events.

- **Rate limit**: 60/min/IP
- **Cache**: `public, max-age=60`

#### `GET /api/anomalies/stats`

Severity counts (24h / 7d / all-time). In-memory cached 60s.

- **Rate limit**: 60/min/IP
- **Cache**: `public, max-age=60`

### Vendor-lead submission (wallet-authed)

All `/api/leads/*` POSTs take a wallet signature in the body:

```ts
{
  wallet_address: string,       // base58 Solana pubkey
  signed_message: string,       // "I am submitting a lead to BioHash at <ISO8601>"
  wallet_signature: string,     // base58 ed25519 signature
  // … endpoint-specific fields …
}
```

The signed message timestamp must be within 5 minutes of server
time (replay protection).

#### `POST /api/leads/submit`

Submit a new vendor lead.

- **Rate limit**: 5 per hour per IP + 10 per min per IP umbrella
- **CORS**: strict allowlist (NOT wildcard)

Body extra fields:

```json
{
  "vendor_name": "Example Peptides",
  "vendor_url": "https://example.com",
  "reason_for_relevance": "min 50 chars … why this vendor matters",
  "legitimacy_evidence": {
    "has_third_party_testing": true,
    "testing_provider": "Janoshik",
    "operating_months": 24,
    "has_independent_reviews": true,
    "has_clear_business_presence": true
  },
  "suggested_tier": "verified_listing",
  "submitter_relationship": "no_relationship",
  "has_personal_contact": false
}
```

Response: `201 Created` with `{ lead_id, status, submitter_id }`.

Errors: `400 BAD_REQUEST`, `401 INVALID_*` / `SIGNATURE_*`,
`403 SUBMITTER_NOT_ACTIVE | COHORT_FULL`, `409 VENDOR_ALREADY_IN_PIPELINE`,
`429 ACTIVE_LEAD_QUOTA | MONTHLY_QUOTA | RATE_LIMITED`.

#### `POST /api/leads/my-leads`

Submitter's own leads + payouts. POST (not GET) because the wallet
signature lives in the body.

- **Rate limit**: 10/min/IP

#### `POST /api/leads/check-vendor`

Pre-flight URL check before form submission.

- **Rate limit**: 10/min/IP

#### `GET /api/leads/pipeline-status`

Public counts. No wallet sig.

- **Rate limit**: 10/min/IP
- **Cache**: `public, max-age=60`

#### `GET /api/leads/leaderboard`

Ranked submitters. No wallet sig.

- **Rate limit**: 10/min/IP
- **Cache**: `public, max-age=60`

### Admin

All under `/api/admin/*`. Requires `Authorization: Bearer <ADMIN_API_TOKEN>`.

- `GET  /api/admin/leads/queue`
- `POST /api/admin/leads/:id/review`
- `POST /api/admin/leads/:id/progress`
- `POST /api/admin/submitters/:id/violation`

Auth fail-closed: if `ADMIN_API_TOKEN` env var is unset or
<16 chars, every admin endpoint returns `503 ADMIN_TOKEN_NOT_CONFIGURED`.

---

## Endpoints in the launch spec that don't exist

The launch checklist listed a handful of endpoints that don't ship.
Documented here so the public docs don't promise them:

| Spec path | Reality |
|---|---|
| `GET /v1/peptides/:code/twap` | Use `GET /v1/peptides/:code` (carries TWAP history) or `GET /v1/twaps/:id` (single commit). |
| `GET /v1/peptides/:code/observations` | Use `GET /v1/observations/:id` (single observation) or `GET /v1/peptides/:code/vendor-prices` (per-vendor cohort). |
| `GET /v1/vendors` | Lives at `GET /vendors/leaderboard` (no `/v1` prefix — kept for backward compat). |
| `GET /v1/cycles/recent` | Use `GET /v1/cycles` (list, sorted recent-first). |
| `POST /api/vendor-leads` | Wallet-authed POST is at `/api/leads/submit`. |
| `POST /api/vendor-onboarding` | Not implemented. Lead-onboarding is admin-side via `POST /api/admin/leads/:id/review`. |

---

## Known limitations

- **Devnet-era cycles return `DEVNET_LEGACY_AUTHORITY`.** Cycles
  committed before the mainnet cutover live in the same
  `commit_cycles` table with `cluster='devnet'`. Verifying them
  against a mainnet authority returns
  `failure_code: DEVNET_LEGACY_AUTHORITY` rather than a generic
  signer mismatch. This is expected, not a bug.
- **Attestation backfill in flight.** Migration 0037 added three
  per-cycle attestation columns (`onchain_memo_bytes`,
  `authority_pubkey`, `confirmed_slot`) populated at finalization.
  Existing cycles get backfilled by
  `scripts/backfill-cycle-onchain.ts`. Until the backfill
  completes, older cycles may return
  `LEGACY_MEMO_NOT_BACKFILLED` / `LEGACY_SLOT_NOT_BACKFILLED` /
  `LEGACY_AUTHORITY_NOT_BACKFILLED` failure codes — same semantic
  as "verifiable but needs a one-time backfill pass".
- **Anomaly stats are eventually consistent.** `/api/anomalies/stats`
  is in-memory cached 60s. The HTTP `Cache-Control` adds another
  60s edge cache. Worst-case staleness ≤ 2 min.
- **PEPTIDELABS scraping requires the proxy.** Independent of the
  API surface, but visible via the anomaly log: PEPTIDELABS is
  behind a Sucuri WAF that blocks Railway's datacenter IPs.
  Production needs `SCRAPER_USE_PROXY=true`. Without it, the vendor
  shows as offline in the observation log.
- **/api/leads/leaderboard wallet anonymisation.** Wallets are
  truncated to `4..4` (e.g. `Abc1…xyz9`). This is a privacy
  trade-off, not a leak — the full address is recoverable from
  on-chain payout history.
- **No /v1 version on `/vendors/*` or `/arbitrage`.** Historical;
  not under `/v1` prefix. Keeping them where they are per the no-
  URL-restructuring constraint. A future `/v2` could consolidate.

---

## Operator notes

- **Adding a CORS origin**: set `CORS_ORIGINS` (comma-separated) on
  the api Railway service. Reloaded at process start.
- **Rotating the admin token**: update `ADMIN_API_TOKEN` (≥16 chars
  required; fails closed otherwise). Affects both
  `Authorization: Bearer` gating on `/api/admin/*` AND the
  `X-Admin-Token` rate-limit bypass.
- **Reading version in production**: `curl /health | jq .version`.
  Railway injects `RAILWAY_GIT_COMMIT_SHA` automatically; first
  12 chars become `version`.

---

*This document is the canonical wire contract. Endpoint paths,
response shapes, and error codes documented here are pinned in
`apps/api/src/__tests__/public-api-hardening.test.ts`. Pre-launch
changes to either side should update both.*
