# 02 How does the oracle work?

The oracle is a single Node.js service deployed on Railway. Its job is
to turn vendor pages into on-chain records. It runs three concurrent
loops (cycle, TWAP, long-tail retry), holds a Solana keypair, and
talks to one Postgres database and one IPFS pinning provider.

Source code: `apps/oracle/src/`.

## What is the pipeline?

```
scrapers ──> supplier_observations (per vendor, per peptide)
                │
                ▼
           cycle commit (every ~10 min)
           Memo tx with Merkle root over all observations
                │
                ▼
            worker computes TWAP per peptide per hour
            (filtered_median_v1 over the window)
                │
                ▼
            TWAP commit (hourly, per peptide)
            Memo tx with TWAP value and observation_set_root
                │
                ▼
            when the 29th cohort peptide finalizes for an hour:
                │
                ├──> compute index level + components_hash
                ├──> insert into public.index_history
                ├──> stamp index_level on all 29 twap_commits rows
                ├──> repin all 29 IPFS manifests with schema 1.1 index_snapshot
                └──> update_index() on the on-chain PDA
```

The oracle never writes anything that is not anchored. Every database
row that names an on-chain identifier has a corresponding Solana
transaction whose signature is stored alongside it.

## What is in the cohort?

The cohort is the set of peptides whose TWAPs feed the equal-weight
index. It is locked at index launch by the rows in
`public.index_baselines`. The v1 cohort has 29 peptides.

A peptide is added to the cohort if and only if it has a finalized
TWAP at-or-after the baseline date (2026-05-03) and meets the vendor
coverage threshold. GHRP2, RETATRUTIDE, and TIRZEPATIDE were excluded
at launch because they had fewer than the threshold number of
finalized observations at baseline. They are tracked as candidates
for inclusion once their vendor coverage rises above threshold.

There are 32 peptides currently active in the oracle (i.e. they get
hourly TWAP commits). The 3 non-cohort peptides commit TWAPs to Solana
the same way as the cohort peptides; they simply do not contribute to
the index level.

"Active" means `peptides.is_active = true` and `enabled_in_twap = true`
in the database. A peptide is promoted from observation phase to
active by an operator-applied migration. The migration that promoted
NAD, MT2, and IGF1LR3 is `packages/db/migrations/0041_activate_nad_mt2_igf1lr3.sql`.

## Where do the prices come from?

The oracle scrapes a set of vendor websites. The scraper
(`apps/scraper/src/`) has one adapter per vendor; each adapter writes
one `supplier_observations` row per scrape attempt, whether the scrape
succeeded or not. Failures are first-class observations.

Active vendors (Tier 1, consumer-grade):
PUREHEALTH, NUSCIENCE, VERIFIED, LIBERTY, GENETIC, PULSE, PURERAWZ,
SWISSCHEMS, PANDA, PURETESTED, PEPTIDELABS, EZPEP, OPTIPEP. There are
no others enabled at TWAP-time as of this writing.

Paused vendors (Tier 2 or anti-bot blocks):
BACHEM, SIGMA, CAYMAN, MODERNAMINOS.

Deferred vendors (need custom parsers):
LIMITLESS (BigCommerce), PARTICLE (PrestaShop).

The oracle does not yet ship a per-vendor reliability score. The
TWAP algorithm is a straight median (`filtered_median_v1`) over the
included observations for the window. The
`deviation_from_median_bps` metric is computed and stored per
observation, surfacing the spread of every input even if no row is
dropped today. Outlier filtering is plumbed for a future MAD-based
algorithm but not enabled.

## How is a TWAP computed?

For each active peptide, the worker (`apps/worker/src/`) takes the
most-recent successful observation per vendor inside a rolling
hourly window and computes the median price in USD per milligram. The
window is one hour ending at the top of each UTC hour.

Three fields together identify a TWAP row in the database:

- `window_start` is the start of the rolling window. Typically
  `HH-1:00:00` UTC.
- `window_end` is the end of the rolling window. Typically `HH:00:00`
  UTC, i.e. the boundary between two hours.
- `computed_at` is the wall-clock moment the worker ran. Typically
  near `HH:00:00` UTC plus the worker's tick latency.

The Postgres column `twap_commits.computed_at` is the index hour
identifier. A row with `computed_at = '2026-05-15T15:00:00Z'` belongs
to the index hour `2026-05-15T15:00:00Z` regardless of its
`window_start`. The hour identifier on `index_history.hour_start`
matches this convention.

The TWAP value is stored as a numeric with full precision. On the wire
it is rendered as a string (`"5.998000"`) to avoid float drift; in
canonical Solana memo form it is a string as well.

## What gets committed to Solana?

Two kinds of commits, both via the SPL Memo program:

### Cycle commit

After every scrape cycle (~10 min), the oracle takes every observation
that cycle produced, canonically serialises each one, hashes them into
Merkle leaves with `0x00` leaf domain separation and `0x01` inner
domain separation (RFC 6962 convention with Bitcoin-style odd-node
duplication), and packs the root into a Memo. The Merkle root anchors
the entire batch in one transaction. To verify a single observation
later, recompute the leaf hash, walk the proof to the on-chain root,
and check the memo on Solana matches the database row.

Cycle memo at v=2, 9 fields, ~270 bytes:

```json
{"completed_at":"2026-05-01T12:00:09.000Z","cycle_id":200,"merkle_root":"0x100eeb8fabe2d1cb200324e8ccbcc3ead12cfa18224a744cbe11d813dcb32af8","observation_count":118,"project":"biohash","started_at":"2026-05-01T12:00:00.000Z","type":"cycle","url":"biohash.network","v":2}
```

### TWAP commit

Every hour, per active peptide, the oracle writes the peptide code,
TWAP value, the window covered, the algorithm name, and the
observation set Merkle root into a Memo. The `observation_set_root`
links a TWAP commit back to the cycle commits whose observations fed
it.

TWAP memo at v=2, 11 fields, ~356 bytes:

```json
{"algo":"filtered_median_v1","computed_at":"2026-05-01T12:00:00.000Z","observation_set_root":"0x100eeb8fabe2d1cb200324e8ccbcc3ead12cfa18224a744cbe11d813dcb32af8","peptide_code":"BPC157","project":"biohash","twap_value":"5.998000","type":"twap","url":"biohash.network","v":2,"window_end":"2026-05-01T12:00:00.000Z","window_start":"2026-05-01T11:00:00.000Z"}
```

Canonicalisation: JSON object with keys sorted ASCII-ascending, no
whitespace, no trailing newline, UTF-8 encoded. Both the on-chain
memo bytes and the database column store the same canonical form, so
they compare byte-for-byte.

The protocol version `v` is 2. Legacy devnet cycles 1 through 63 are
v=1 with fewer fields. Any verifier must inspect `v` and refuse
unknown versions.

## How does the index aggregation work?

When the 29th cohort peptide finalises its TWAP commit for an hour,
the oracle runs the cohort-completion handler
(`apps/oracle/src/index-history-runner.ts`). The handler is
fire-and-forget from the TWAP poller, so a pin failure or RPC blip
never blocks the next tick.

The handler does five things:

1. Compute the index level and components hash from the 29 TWAPs.
2. Insert a row into `public.index_history` with
   `ON CONFLICT (hour_start) DO NOTHING`. Exactly one observer wins
   this race.
3. Stamp `index_level` and `index_components_hash` on all 29
   `twap_commits` rows for the hour. Guarded by `WHERE index_level
   IS NULL` so a second observer no-ops.
4. Repin all 29 IPFS manifests at schema 1.1, this time with a
   non-null `index_snapshot`. The original (pre-cohort-completion)
   pin had `index_snapshot: null`. Snapshot the resulting CIDs into
   `index_history.ipfs_cids`.
5. Call `update_index(level, hour_start_unix, components_hash)` on
   the index program, writing the new level to the singleton PDA.

The index account write uses a fixed-point conversion: a JS number
like `980.4567` becomes the u64 `9804567`, which is the level scaled
by 10^4. See `apps/oracle/src/solana/index-account-writer.ts`.

## How is the components hash derived?

`components_hash` is the cryptographic fingerprint of the inputs that
produced the index level. It appears in three places, always equal:

- `twap_commits.index_components_hash` on every cohort row for the
  hour.
- `index_history.components_hash` for the hour.
- The 32 bytes written to the on-chain PDA on `update_index`.

Derivation, from `apps/oracle/src/index-computer.ts`:

1. Load the cohort from `public.index_baselines`. Take the peptide
   codes in the cohort.
2. Build an array of objects, one per cohort peptide:
   `{peptide_code, twap_value, weight}` in exactly that key order.
   `weight = 1 / N`, where N is the cohort size (29 at v1 launch).
3. Sort the array by `peptide_code` ascending. Use simple
   code-unit-ordered comparison, not locale-aware comparison.
4. Serialise with `JSON.stringify` (no whitespace, no key sorting
   beyond what the input array already imposes, ECMA-262 shortest-
   round-trip number formatting).
5. Take `sha256` of the UTF-8 bytes. Render lowercase hex.

The same fingerprint is reproducible from a single IPFS-pinned
manifest. Manifest schema 1.1 carries the cohort's `level` and
`components_hash` in its `index_snapshot` block.

Verifier in Python:

```python
import hashlib, json

# twaps_by_peptide must contain all N cohort codes.
N = 29
components = sorted(
    [{"peptide_code": code, "twap_value": twap, "weight": 1 / N}
     for code, twap in twaps_by_peptide.items()],
    key=lambda c: c["peptide_code"],
)
canonical = json.dumps(components, separators=(",", ":"))
expected_hash = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
```

The hash is sensitive to the cohort. A rebaselining (a different
set of peptides, or different baseline TWAPs) produces a different
hash for every hour, by design.

## What is the IPFS manifest?

After every TWAP commit, the oracle pins a JSON manifest to IPFS via
Pinata. The manifest is schema 1.1, defined as the TypeScript
`CycleManifest` interface in `apps/oracle/src/ipfs/pinata.ts`.

It carries everything an auditor needs to reproduce the TWAP from raw
inputs:

```jsonc
{
  "version": "1.1",
  "peptide_code": "BPC157",
  "cycle_id": 4242,
  "computed_at": "2026-05-13T18:00:00.000Z",
  "twap_value": 6.699,
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
  ],
  "index_snapshot": {
    "level": 1024.137931,
    "baseline_date": "2026-05-03",
    "baseline_level": 1000,
    "components_hash": "aabbccddeeff...",
    "computed_at": "2026-05-13T18:00:30.000Z"
  }
}
```

The CID is written into `twap_commits.ipfs_cid` (initial pin) and
`twap_commits.final_ipfs_cid` (repin after cohort completion). The
API returns whichever is most recent. The Solana commit is
authoritative; the manifest is the audit-trail-quality detail.

## Schema 1.1: what changed?

Schema 1.0 manifests had every field above except `index_snapshot`.
Schema 1.1 added the `index_snapshot` block at the top level, present
on every cohort manifest. The same `level` and `components_hash`
appear in every cohort manifest for a given hour.

When the cohort is incomplete for an hour (fewer than 29 finalised),
`index_snapshot` is `null` but the manifest still pins. That hour is
skipped from `index_history` per spec; the partial-hour rule has no
retroactive recompute.

## What happens when a vendor goes down?

The scraper writes a row with `scrape_success = false` and a reason.
The cycle commit anchors that row the same way as a successful one.
That row does not enter the TWAP candidate set for the window. If
enough vendors fail for a peptide that the worker has only one or
zero observations to work with, the TWAP row is written with
`kind = thin_data` and the on-chain commit does not happen for that
peptide that hour.

The anomaly log surfaces vendor failures at `/api/anomalies`. The
RSS / JSON Feed forms make it diffable.

## What happens when a peptide has insufficient observations?

The worker writes a `peptide_twaps` row with `twap_usd_per_mg = NULL`
and an `algorithm_state` of `thin_data`. The TWAP poller filters
`pt.twap_usd_per_mg IS NOT NULL`, so no Solana commit fires for that
peptide that hour. If the peptide is a cohort member, the cohort is
incomplete for the hour, the index for that hour is skipped, and no
update lands on the on-chain PDA.

The on-chain PDA's `hour_start_unix` is therefore a strictly-monotonic
sequence of cohort-complete hours, not a contiguous time series. A
reader should not assume "next hour" means `hour_start_unix + 3600`.

## What happens when Pinata fails?

Pin failures are logged but do not block the Solana commit. The TWAP
commit is still written to `twap_commits` with whatever CID exists
(possibly NULL). The cohort-completion handler tries to repin every
manifest at schema 1.1 once the index is known; if a repin fails, the
per-peptide error is now surfaced individually as a structured
`repin_failed` log line carrying the Pinata error body.

Known bug: the repin loop in
`apps/oracle/src/index-history-runner.ts:303-338` uses
`Promise.allSettled` over the 29 manifests and logs per-row failures,
but it has no exponential backoff and no per-peptide retry cap. If
Pinata is rate-limiting or down, the entire hour's repin attempt is
lost; the snapshot UPDATE then writes `ipfs_cids = ARRAY[...]` with
whatever CIDs already exist on the rows (initial pins). Conrad has
flagged this for fixing.

The Solana commit remains authoritative when this happens. The IPFS
layer is additive, not blocking.
