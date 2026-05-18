# 05 The API

The BioHash public REST API lives at `https://api.biohash.network`.
The underlying Railway origin is
`https://peptidefi-production-c6d9.up.railway.app`; the two host
names are interchangeable, but the canonical surface is the
biohash.network domain.

Source code: `apps/api/src/`. The canonical wire contract is
`docs/PUBLIC_API.md` in this repo, pinned by the integration test
`apps/api/src/__tests__/public-api-hardening.test.ts`. This section
is the high-level integration view; for every field and every error
code on every route, read `docs/PUBLIC_API.md`.

## What is public, what isn't?

Every endpoint under `/v1/*`, `/authority`, `/health`,
`/vendors/leaderboard`, `/arbitrage`, and `/api/anomalies` is public.
No keys, no signatures, no JWT.

Two endpoint classes need authentication:

- `POST /api/leads/*` requires a Solana ed25519 signature in the
  request body (canonical signed message, 5-minute timestamp
  tolerance, server checks the signature).
- `/api/admin/*` requires an `Authorization: Bearer <token>` header.
  The same token sent via `X-Admin-Token` on a public endpoint
  bypasses per-IP rate limits, useful for the dashboard.

Tiered access for the public reads (paid plans with higher rate
limits and additional endpoints) is on the roadmap; nothing is
shipped or priced yet.

## What are the rate limits?

Per-IP, sliding window. `X-RateLimit-*` headers (IETF draft-7) are
emitted on every response.

| Class | Limit | Window | Applies to |
| ----- | ----- | ------ | ---------- |
| public-read | 60 | 1 min | `/v1/*`, `/authority`, `/vendors/*`, `/arbitrage`, `/api/anomalies` |
| public-write | 10 | 1 min | `/api/leads/*` |
| submit-strict | 5 | 1 hour | `POST /api/leads/submit` (in addition to public-write) |

`Retry-After` is set on 429 responses.

## Versioning

The durable surface is `/v1/*`. The vendor and arbitrage routes
(`/vendors/leaderboard`, `/arbitrage`) live outside the prefix for
backward-compatibility with earlier integrators. Treat them as part
of the v1 surface.

A `/v2` will land if the response shapes need a breaking change. Until
then, every change to existing endpoints is additive (new fields,
nullable additions only) and the integration test enforces it.

## What is the error shape?

Every non-2xx response uses:

```json
{
  "code": "RATE_LIMITED",
  "message": "rate limit exceeded (60/window)",
  "status": 429,
  "retry_after_seconds": 42
}
```

Standard `code` values: `BAD_REQUEST` (400), `NOT_AUTHORIZED` (403),
`NOT_FOUND` (404), `RATE_LIMITED` (429), `INTERNAL_ERROR` (500),
`SERVICE_UNAVAILABLE` (503), `DB_ERROR` (500).

Route-specific codes (e.g. `DEVNET_LEGACY_AUTHORITY`,
`COHORT_FULL`, `SIGNATURE_EXPIRED`) are documented under each route
in `docs/PUBLIC_API.md`.

## Endpoint map

The full set with response shapes is in `docs/PUBLIC_API.md`. The map
here is the integration view: what each endpoint is for.

### System

| Path | Purpose |
| ---- | ------- |
| `GET /` | Liveness ping |
| `GET /health` | Operational liveness (version, uptime, auth status) |
| `GET /authority` | Trust anchor: oracle pubkey, cluster, memo program, spec URL |

### The Index

| Path | Purpose |
| ---- | ------- |
| `GET /v1/index/current` | Latest cohort-complete hour: level, components_hash, baseline, computed_at |
| `GET /v1/index/history` | Per-hour history with `?from=&to=` filtering |
| `GET /v1/index/components` | Per-peptide breakdown for the latest hour: code, baseline_twap, current_twap, contribution |

### Per-peptide

| Path | Purpose |
| ---- | ------- |
| `GET /v1/peptides` | All active peptides with their current TWAP |
| `GET /v1/peptides/:id` | Detail by id or code, plus 7-day TWAP history |
| `GET /v1/peptides/:code/vendor-prices` | Latest per-vendor prices |
| `GET /v1/peptides/:code/price-history` | Per-vendor and TWAP time series, configurable window |
| `GET /v1/research/:code` | Research metadata (overview, mechanism, applications) for indexed peptides |

### Verification

| Path | Purpose |
| ---- | ------- |
| `GET /v1/cycles` | Recent commit cycles |
| `GET /v1/cycles/:id` | One cycle plus all observations and merkle proof material |
| `GET /v1/observations/:id` | One supplier observation |
| `GET /v1/twaps/:id` | One TWAP commit |
| `GET /v1/verify/observation/:id` | End-to-end 8-check verification of one observation against its on-chain commit |

### Markets

| Path | Purpose |
| ---- | ------- |
| `GET /vendors/leaderboard` | Vendor ranking |
| `GET /arbitrage` | Cross-vendor arbitrage opportunities |

### Operations

| Path | Purpose |
| ---- | ------- |
| `GET /api/anomalies` | Append-only system event log |
| `GET /api/anomalies/feed.xml` / `.json` | RSS 2.0 / JSON Feed 1.1 of recent events |
| `GET /api/anomalies/stats` | Severity counts (24h / 7d / all-time) |

## Examples

### What is the current index level?

```bash
curl -s "https://api.biohash.network/v1/index/current" | jq
```

```json
{
  "hour_start": "2026-05-17T23:00:00.000Z",
  "level": "1023.456",
  "components_hash": "aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899",
  "baseline_date": "2026-05-03",
  "baseline_level": "1000.00",
  "cohort_size": 29,
  "computed_at": "2026-05-17T23:00:30.512Z"
}
```

### What is BPC-157 priced at?

```bash
curl -s "https://api.biohash.network/v1/peptides/BPC157" | jq '{
  code: .peptide.code,
  current_twap: .twap_history[0].twap_value,
  computed_at: .twap_history[0].computed_at,
  solscan: .twap_history[0].solana.solscan_url
}'
```

### Where are the per-vendor prices?

```bash
curl -s "https://api.biohash.network/v1/peptides/BPC157/vendor-prices" | jq
```

### Verifying one observation

```bash
curl -s "https://api.biohash.network/v1/verify/observation/123456" | jq '{
  verified,
  failure_code,
  signer_check: .checks[] | select(.name == "signer_matches_authority"),
  on_chain_signature: .on_chain.signature
}'
```

The verifier runs 8 deterministic checks and returns
`verified: true` only if all pass. Failure responses include a
machine-readable `failure_code` so an integrator can branch on the
specific reason.

### Reading the trust anchor first

A verifier's first call should be `/authority`, to learn the oracle
pubkey and cluster:

```bash
curl -s "https://api.biohash.network/authority" | jq
```

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
  "rpc_recommendation": "https://api.mainnet-beta.solana.com (or any public Solana RPC)"
}
```

Cross-check the `oracle_authority_pubkey` against the published value
in `docs/oracle-authority.md`. Any mismatch is an incident; treat the
GitHub file as authoritative until reconciled.

## CORS

| Endpoint class | Allowed origin |
| -------------- | -------------- |
| Public reads | `*` (no credentials) |
| Writes and admin | Strict allowlist: `biohash.network`, `*.lovable.app/dev/lovableproject.com`, plus `CORS_ORIGINS` env list |

`OPTIONS` preflight is handled automatically.

## Caching

Response `Cache-Control` headers per endpoint:

| Class | Header |
| ----- | ------ |
| Latest state (e.g. `/v1/peptides`) | `public, max-age=300` |
| Index current | `public, max-age=60` |
| Historical, finalised (single cycle, single twap) | `public, max-age=3600` |
| Verify | `public, max-age=3600` (deterministic for finalised commits) |
| Health | `Cache-Control: no-store` |

Modern browsers honour these. There is no CDN in front today; adding
one is a DNS change without application changes.

## Known limitations

The `docs/PUBLIC_API.md` section "Known limitations" is the
authoritative list. The high-level ones:

- Cycles committed before the mainnet cutover carry `cluster='devnet'`.
  Verifying them against the mainnet authority returns
  `failure_code: DEVNET_LEGACY_AUTHORITY` rather than a generic
  signer mismatch.
- Some attestation columns
  (`onchain_memo_bytes`, `authority_pubkey`, `confirmed_slot`) are
  backfilled by a one-time script. Until the backfill completes,
  older cycles may return `LEGACY_*_NOT_BACKFILLED` failure codes
  on verify.
- The anomaly stats endpoint is in-memory cached 60s; worst-case
  staleness is ~2 minutes including edge cache.
