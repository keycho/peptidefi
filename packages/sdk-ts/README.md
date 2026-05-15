# @biohashnetwork/sdk

Official TypeScript SDK for the [BioHash](https://biohash.network) public REST API — a Solana-anchored peptide-market oracle.

- TypeScript-first, full response typing
- Zero runtime dependencies (uses native `fetch`)
- Works in Node.js 18+ and modern browsers
- Dual ESM / CJS build
- Automatic retries on 5xx and network errors with exponential backoff
- Honors `Retry-After` on 429 responses
- List methods unwrap the JSON envelope so you get the array directly

## Install

```bash
npm install @biohashnetwork/sdk
# or
pnpm add @biohashnetwork/sdk
# or
yarn add @biohashnetwork/sdk
```

## Quickstart

```ts
import { BioHash } from "@biohashnetwork/sdk";

const client = new BioHash({
  baseUrl: "https://api.biohash.network", // default
});

// List every tracked peptide (returns an array, not an envelope).
const peptides = await client.peptides.list();
console.log(peptides.map((p) => `${p.code} → ${p.current_twap?.twap_value ?? "(no twap)"}`));

// Verify an observation against the on-chain Merkle commit.
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

  // User-Agent header. Default `@biohashnetwork/sdk/<version>`. Ignored in browsers.
  userAgent: "myapp/1.2.3",
});
```

All request methods accept an optional `{ signal }` for cancellation:

```ts
const ctrl = new AbortController();
setTimeout(() => ctrl.abort(), 5000);
const peptides = await client.peptides.list({ signal: ctrl.signal });
```

## Envelope unwrapping

For list endpoints the SDK unwraps the JSON envelope and returns the inner array directly. The full envelope (with pagination cursors etc.) is still available via a parallel `.listPage()` method on paginated endpoints.

| Method                       | Returns                          | Raw envelope via      |
| ---------------------------- | -------------------------------- | --------------------- |
| `peptides.list()`            | `PeptideListItem[]`              | — (single page)       |
| `vendors.leaderboard()`      | `VendorLeaderboardEntry[]`       | — (single page)       |
| `cycles.list(params?)`       | `CycleSummary[]`                 | `cycles.listPage()`   |
| `cycles.get(id)`             | `CycleDetail`                    | — (single item)       |
| `anomalies.list(params?)`    | `AnomalyEvent[]`                 | `anomalies.listPage()`|
| `peptides.get(codeOrId)`     | `PeptideDetailResponse`          | — (multi-field)       |
| `peptides.vendorPrices(code)`| `VendorPricesResponse`           | — (multi-field)       |
| `observations.get(id)`       | `ObservationDetailResponse`      | — (multi-field)       |
| `twaps.get(id)`              | `TwapDetail`                     | — (single item)       |
| `verify.observation(id)`     | `VerifyObservationResponse`      | — (union)             |

## API reference

### `client.peptides`

#### `peptides.list()` → `PeptideListItem[]`
Hits `GET /v1/peptides`. Returns every active peptide and its most recent finalized TWAP commit, as an array.

```ts
const peptides = await client.peptides.list();
```

Each item:
```ts
{
  peptide_id: number;
  code: string;
  display_name: string;
  full_name: string;
  twap_commits_count: number;
  current_twap: {
    twap_value: string;
    computed_at: string;
    solana_signature: string | null;
    solana_slot: number | null;
    cluster: SolanaCluster;
    solscan_url: string | null;
  } | null;
}
```

#### `peptides.get(codeOrId)` → `PeptideDetailResponse`
Hits `GET /v1/peptides/:id`. Accepts the stable peptide code (e.g. `"BPC157"`) or the numeric id. Returns the peptide plus a window of TWAP commits.

```ts
const detail = await client.peptides.get("BPC157");
for (const h of detail.twap_history) {
  console.log(h.computed_at, h.twap_value, h.solana?.solscan_url);
}
```

#### `peptides.vendorPrices(code)` → `VendorPricesResponse`
Hits `GET /v1/peptides/:code/vendor-prices`. Returns the current TWAP, every recent per-vendor price, and the min/max/variance spread across vendors.

```ts
const { twap, vendors, spread } = await client.peptides.vendorPrices("BPC157");
//   twap:    { value_usd_per_mg, computed_at, cluster }
//   vendors: { vendor_name, price_usd_per_mg, observed_at }[]
//   spread:  { min, max, variance_pct }
```

#### `peptides.priceHistory(code, params?)` → `PeptidePriceHistoryResponse`
Hits `GET /v1/peptides/:code/price-history`. Per-vendor price history (daily or hourly buckets) plus the TWAP series over the same window.

```ts
const hist = await client.peptides.priceHistory("BPC157", {
  days: 30,             // 1..90, default 14
  aggregation: "daily", // "daily" | "hourly"
  vendor: "PUREHEALTH", // optional, narrows the response to one series
});

for (const v of hist.vendors) {
  console.log(v.vendor_code, v.points.length, "buckets");
}
for (const t of hist.twap_series) {
  console.log(t.timestamp, t.twap_value_usd_per_mg, "n=", t.cycle_count);
}
```

`points[].price_usd_per_mg` is a `number` (rounded to 4 decimal places — the endpoint averages per bucket). Bucket timestamps are UTC ISO 8601 strings at the start of the day (daily) or hour (hourly). Peptides currently in the observation phase return a 200 with `twap_series: []` rather than a 404.

### `client.twaps`

#### `twaps.get(twapId)` → `TwapDetail`
Hits `GET /v1/twaps/:id`. `:id` is the `twap_commits.id` UUID.

```ts
const twap = await client.twaps.get("a0b1c2d3-...");
console.log(twap.memo_payload, twap.solana?.solscan_url);
```

### `client.observations`

#### `observations.get(observationId)` → `ObservationDetailResponse`
Hits `GET /v1/observations/:id`. Returns the observation in canonical form (note: the row's PK is exposed as `id`, not `observation_id`), the leaf hash, the commit reference (if anchored), and a reproducible Merkle proof (if the cycle is finalized).

```ts
const obs = await client.observations.get(987654);
console.log(obs.observation.id);          // ← `id`, not observation_id
console.log(obs.computed_leaf_hash);
console.log(obs.proof?.merkle_root);
```

### `client.cycles`

#### `cycles.list(params?)` → `CycleSummary[]`
Hits `GET /v1/cycles`. Returns the array of cycles directly.

```ts
const cycles = await client.cycles.list({ limit: 50, status: "finalized" });
```

#### `cycles.listPage(params?)` → `CyclesListEnvelope`
Same endpoint, but returns the raw envelope `{ cycles, next_cursor }` so you can drive cursor pagination.

```ts
let cursor: number | undefined = undefined;
do {
  const page = await client.cycles.listPage({ limit: 50, cursor, status: "finalized" });
  for (const cycle of page.cycles) {
    // ...
  }
  cursor = page.next_cursor ?? undefined;
} while (cursor !== undefined);
```

Params: `{ limit?: number; cursor?: number; status?: "pending" | "submitted" | "finalized" | "failed" | "all" }`.

#### `cycles.get(cycleId)` → `CycleDetail`
Hits `GET /v1/cycles/:id`. Includes the full `memo_payload` plus every observation reference (leaf index + leaf hash).

```ts
const cycle = await client.cycles.get(1259);
console.log(cycle.observation_count, cycle.memo_payload, cycle.cluster);
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

#### `vendors.leaderboard()` → `VendorLeaderboardEntry[]`
Hits `GET /vendors/leaderboard`. Returns every active vendor ranked by composite score (coverage, freshness, price vs TWAP), as an array.

```ts
const vendors = await client.vendors.leaderboard();
```

### `client.anomalies`

#### `anomalies.list(params?)` → `AnomalyEvent[]`
Hits `GET /api/anomalies`. Returns the array of events directly.

```ts
const events = await client.anomalies.list({
  severity: "warning",
  event_type: "vendor_offline",
  limit: 100,
});
```

#### `anomalies.listPage(params?)` → `AnomaliesListEnvelope`
Same endpoint, with the raw envelope so you can paginate. `next_cursor` is an opaque string of the form `${timestamp}_${id}`; pass it back as the `cursor` param.

```ts
let cursor: string | undefined = undefined;
do {
  const page = await client.anomalies.listPage({ limit: 100, cursor });
  for (const event of page.events) {
    // ...
  }
  cursor = page.next_cursor ?? undefined;
} while (cursor !== undefined);
```

Params: `{ limit?; cursor?: string; severity?; event_type?; vendor_id?; peptide_id?; since?; until? }`.

### `client.index` (v0.2.1+)

BioHash Peptide Index, hourly equal-weight level over the v1 29-peptide cohort. Baseline date 2026-05-03, baseline level 1000. See `docs/PUBLIC_API.md` in the repo for the components-hash reproducibility recipe.

#### `index.getIndex()` → `IndexCurrentResponse`
Hits `GET /v1/index/current`. Returns the latest hour. `index` is null until the first cohort hour completes.

```ts
const { index } = await client.index.getIndex();
if (index) {
  console.log(`level=${index.level} at ${index.hour_start}`);
  console.log(`components_hash=${index.components_hash}`);
}
```

`client.getIndex()` is a convenience alias for the same call.

#### `index.getIndexHistory({ from?, to? })` → `IndexHistoryResponse`
Hits `GET /v1/index/history`. Time series, ascending. Default window is the last 30 days; the server caps requested ranges at 365 days. Accepts `Date | string` for both bounds.

```ts
const lastWeek = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
const { history, window } = await client.index.getIndexHistory({ from: lastWeek });
console.log(`${history.length} hourly points between ${window.from} and ${window.to}`);
```

#### `index.getIndexComponents()` → `IndexComponentsResponse`
Hits `GET /v1/index/components`. Per-peptide breakdown of the most recent index level, including each peptide's contribution and weight.

```ts
const { index, components } = await client.index.getIndexComponents();
const sorted = [...components].sort((a, b) => (b.contribution ?? 0) - (a.contribution ?? 0));
for (const c of sorted.slice(0, 5)) {
  console.log(`${c.peptide_code}: contribution=${c.contribution?.toFixed(2)} weight=${c.weight.toFixed(6)}`);
}
```

### Pin state on existing endpoints (v0.2.1+)

Schema 1.1 introduces a pin-twice flow: each TWAP commit may have a "pre-cohort" pin (manifest with `index_snapshot: null`) followed by a "final" pin (manifest with `index_snapshot` populated) once the cohort completes for the hour. The SDK surfaces the best available CID and a `pin_state` discriminator on every existing endpoint that exposes `ipfs_cid`:

```ts
const peptides = await client.peptides.list();
for (const p of peptides) {
  if (p.current_twap?.ipfs_cid) {
    console.log(`${p.code}: ${p.current_twap.ipfs_cid} (${p.current_twap.pin_state})`);
  }
}
```

`pin_state` is `'final'` when the manifest at that CID carries the populated `index_snapshot`, `'pre_cohort'` when it carries `null`. Verifiers should branch on this if they need to recompute the index from the manifest contents.

## Error handling

Every non-recoverable failure throws a `BioHashApiError`. Inspect `code`, `status`, and (where present) `retryAfterSeconds`/`details`:

```ts
import { BioHash, BioHashApiError } from "@biohashnetwork/sdk";

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
