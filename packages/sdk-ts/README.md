# @biohash/sdk

Official TypeScript SDK for the [BioHash](https://biohash.network) public REST API — a Solana-anchored peptide-market oracle.

- TypeScript-first, full response typing
- Zero runtime dependencies (uses native `fetch`)
- Works in Node.js 18+ and modern browsers
- Dual ESM / CJS build
- Automatic retries on 5xx and network errors with exponential backoff
- Honors `Retry-After` on 429 responses

## Install

```bash
npm install @biohash/sdk
# or
pnpm add @biohash/sdk
# or
yarn add @biohash/sdk
```

## Quickstart

```ts
import { BioHash } from "@biohash/sdk";

const client = new BioHash({
  baseUrl: "https://api.biohash.network", // default
});

// List every tracked peptide
const { peptides } = await client.peptides.list();
console.log(peptides.map((p) => `${p.code} → ${p.current_twap?.twap_value ?? "(no twap)"}`));

// Verify an observation against the on-chain Merkle commit
const result = await client.verify.observation(12345);
if (result.verified) {
  console.log(`✓ verified, merkle_root=${result.merkle_root}`);
} else {
  console.log(`✗ ${result.failure_reason ?? result.status}`);
}
```

## Configuration

```ts
new BioHash({
  // Where to send requests. Defaults to https://api.biohash.network.
  baseUrl: "https://api.biohash.network",

  // Custom fetch — useful in tests and edge runtimes.
  fetch: globalThis.fetch,

  // Per-request timeout, ms. Default 30_000. 0 disables the SDK timeout.
  timeoutMs: 30_000,

  // Max retries on 5xx / network errors. Default 3 (so up to 4 calls total).
  // Note: 429 is retried separately, honoring Retry-After, and doesn't count.
  maxRetries: 3,

  // Initial backoff for the exponential schedule. Default 250 (→ 250/500/1000ms).
  retryBackoffMs: 250,

  // Extra headers attached to every request. Useful for X-Admin-Token to bypass
  // public rate limits on trusted callers.
  headers: { "X-Admin-Token": process.env.BIOHASH_ADMIN_TOKEN! },

  // User-Agent header. Default `@biohash/sdk/<version>`. Ignored in browsers.
  userAgent: "myapp/1.2.3",
});
```

All request methods accept an optional `{ signal }` for cancellation:

```ts
const ctrl = new AbortController();
setTimeout(() => ctrl.abort(), 5000);
const peptides = await client.peptides.list({ signal: ctrl.signal });
```

## API reference

### `client.peptides`

#### `peptides.list()` → `PeptidesListResponse`
Hits `GET /v1/peptides`. Returns every active peptide and its most recent finalized TWAP commit.

```ts
const { peptides, count } = await client.peptides.list();
```

#### `peptides.get(codeOrId)` → `PeptideDetailResponse`
Hits `GET /v1/peptides/:id`. Accepts the stable peptide code (e.g. `"BPC157"`) or the numeric id. Returns the peptide plus the last 7 days of TWAP commits.

```ts
const detail = await client.peptides.get("BPC157");
for (const h of detail.twap_history) {
  console.log(h.computed_at, h.twap_value, h.solana?.solscan_url);
}
```

#### `peptides.vendorPrices(code)` → `VendorPricesResponse`
Hits `GET /v1/peptides/:code/vendor-prices`. Returns the freshest per-vendor price per active supplier alongside the current TWAP.

```ts
const { vendors, twap_value } = await client.peptides.vendorPrices("BPC157");
```

### `client.twaps`

#### `twaps.get(twapId)` → `TwapDetail`
Hits `GET /v1/twaps/:id`. `:id` is the `twap_commits.id` UUID.

```ts
const twap = await client.twaps.get("a0b1c2d3-...");
console.log(twap.memo_payload, twap.solana?.solscan_url);
```

### `client.observations`

#### `observations.get(observationId)` → `ObservationDetailResponse`
Hits `GET /v1/observations/:id`. Returns the observation in canonical form, the leaf hash, the commit reference (if anchored), and a reproducible Merkle proof (if the cycle is finalized).

```ts
const obs = await client.observations.get(987654);
console.log(obs.computed_leaf_hash);
console.log(obs.proof?.merkle_root);
```

### `client.cycles`

#### `cycles.list(params?)` → `CyclesListResponse`
Hits `GET /v1/cycles`. Paginated by `cursor` (the previous response's `next_cursor`, which is the smallest `cycle_id` of the page).

```ts
const page1 = await client.cycles.list({ limit: 50, status: "finalized" });
const page2 = page1.next_cursor !== null
  ? await client.cycles.list({ limit: 50, cursor: page1.next_cursor })
  : null;
```

Params: `{ limit?: number; cursor?: number; status?: "pending" | "submitted" | "finalized" | "failed" | "all" }`.

#### `cycles.get(cycleId)` → `CycleDetail`
Hits `GET /v1/cycles/:id`. Includes the full `memo_payload` plus every observation reference (leaf index + leaf hash).

```ts
const cycle = await client.cycles.get(1165);
console.log(cycle.observation_count, cycle.memo_payload);
```

### `client.verify`

#### `verify.observation(observationId)` → `VerifyObservationResponse`
Hits `GET /v1/verify/observation/:id`. Runs every end-to-end check a client-side verifier would (canonical leaf hash → Merkle proof → on-chain memo byte-compare → slot + signer match), and returns a discriminated union.

```ts
const result = await client.verify.observation(987654);

if (result.verified === true) {
  // result.merkle_root, result.proof, result.on_chain, result.checks
} else if (result.status === "pending_commit") {
  // Not yet anchored. Retry after result.retry_after_seconds.
} else {
  // Real failure. result.failure_reason names the first check that failed,
  // result.failure_detail explains why.
}
```

### `client.vendors`

#### `vendors.leaderboard()` → `VendorsLeaderboardResponse`
Hits `GET /vendors/leaderboard`. Returns every active vendor ranked by composite score (coverage, freshness, price vs TWAP).

```ts
const { vendors } = await client.vendors.leaderboard();
```

### `client.anomalies`

#### `anomalies.list(params?)` → `AnomaliesListResponse`
Hits `GET /api/anomalies`. Paginated append-only event log: TWAP submissions, vendor outages, scraper failures, on-chain commit lifecycle, etc.

```ts
const events = await client.anomalies.list({
  severity: "warning",
  event_type: "vendor_offline",
  limit: 100,
});
```

Params: `{ limit?; cursor?; severity?; event_type?; service?; vendor_id?; peptide_id?; since?; until? }`.

## Error handling

Every non-recoverable failure throws a `BioHashApiError`. Inspect `code`, `status`, and (where present) `retryAfterSeconds`/`details`:

```ts
import { BioHash, BioHashApiError } from "@biohash/sdk";

try {
  await client.peptides.get("ZZZ");
} catch (err) {
  if (err instanceof BioHashApiError) {
    if (err.status === 404) {
      // peptide not found
    } else if (err.code === "RATE_LIMITED") {
      // The SDK already retried per Retry-After; this is the final failure.
      console.log("backoff hint:", err.retryAfterSeconds);
    } else if (err.code === "NETWORK_ERROR") {
      // All retries exhausted — `err.cause` carries the underlying error.
    }
  }
}
```

The SDK never coerces a verified API "failure" response (e.g. `verified: false` from `/v1/verify`) into a thrown error — those are well-defined business states and you handle them by inspecting the typed return value.

## Numeric precision

Some response fields (`twap_value`, `price_usd_per_mg`, leaderboard ratios) are returned as `string` to preserve full Postgres `numeric` precision. The SDK does not coerce them to `number`. Parse at the call site:

```ts
const twap = parseFloat(detail.twap_history[0].twap_value);
// or use a decimal library if precision matters for your use case
```

## License

MIT
