# 07 — Cost analysis

Status: **draft**. Cost projections for the on-chain commit layer
at v1 scale (5 peptides) with scaling scenarios up to 50 peptides.
Numbers are derived from the architectural decisions in §03 — if
those change, this section is the first thing that needs to be
re-evaluated.

This section depends on:

- §02.2.2 / §02.2.3 — memo byte sizes (226 bytes cycle, 312 bytes
  TWAP after `algo` field)
- §03.4.4 — priority fee strategy (dynamic via Helius, capped at
  50,000 µlamports/CU)
- §03.6 — RPC choice (Helius free tier)
- §03.5.1 — keypair operational requirement of ~30-day SOL buffer
- §05.4.13 — API rate-limit buckets (which feed into RPC budget
  for the verification API)

Out of scope:

- Frontend explorer hosting (separate phase)
- Token contract / smart-contract deployment costs (separate phase)
- Marketing or growth-driven traffic scenarios (the projections
  here assume operator + early-adopter use, not scale)

## 7.1 Solana transaction costs

### 7.1.1 Cost components per transaction

Every Memo transaction the committer submits has two cost components:

**Base fee.** Solana charges 5,000 lamports per signature. Our
transactions have exactly one signature (the hot wallet, which is
both fee payer and Memo signer). So:

```
base_fee = 5,000 lamports = 0.000005 SOL
```

This is fixed across all transactions and unaffected by memo size,
network conditions, or commit type.

**Priority fee.** Per §03.4.4, the committer adds compute-budget
instructions setting:

- Compute unit limit: 500 CU (Memo program uses ~200 CU; 500 buffers
  for program changes)
- Compute unit price: dynamic from Helius's `getPriorityFeeEstimate`
  API at the 75th percentile, capped at 50,000 µlamports/CU

```
priority_fee = compute_units × compute_unit_price (in µlamports)
```

At our 500-CU budget:

| network state    | CU price (µlamports) | priority fee   | total per tx (incl. base) |
| ---------------- | -------------------- | -------------- | ------------------------- |
| Calm (low)       | 1,000                | 500 lamports   | 5,500 lamports            |
| Median (75th %)  | 10,000               | 5,000 lamports | 10,000 lamports           |
| High (cap)       | 50,000               | 25,000 lamports| 30,000 lamports           |

In SOL: 0.0000055 / 0.00001 / 0.00003 SOL per tx for low / median / high.

### 7.1.2 Memo size doesn't materially change cost

Solana's fee model is per-signature, not per-byte. The size
difference between a cycle commit memo (226 bytes) and a TWAP
commit memo (312 bytes) doesn't affect the base fee, and the
Memo program's CU consumption doesn't scale meaningfully with
payload size for our small payloads — both stay around 200 CU.
For costing purposes, **all commits are priced identically**.

### 7.1.3 Cycle commits

- **Frequency**: every 10 minutes = 144/day = 52,560/year
- **Memo size**: 226 bytes (§02.2.2)
- **Per-commit cost** (median priority fee): 10,000 lamports = 0.00001 SOL

Daily cycle-commit cost (median): 144 × 10,000 = 1,440,000 lamports
= **0.00144 SOL/day** ($0.29 @ $200/SOL).

### 7.1.4 TWAP commits

- **Frequency**: 24/day per peptide × N peptides
- **At v1 (N=5)**: 120/day = 43,800/year
- **Memo size**: 312 bytes (§02.2.3, post-`algo`)
- **Per-commit cost** (median priority fee): 10,000 lamports = 0.00001 SOL

Daily TWAP-commit cost at N=5 (median): 120 × 10,000 = 1,200,000
lamports = **0.0012 SOL/day** ($0.24 @ $200/SOL).

### 7.1.5 Daily totals

At v1 (5 peptides), 264 transactions/day:

| scenario            | per-tx cost     | daily SOL    | daily USD @ $100 | daily USD @ $200 | daily USD @ $300 |
| ------------------- | --------------- | ------------ | ---------------- | ---------------- | ---------------- |
| Low (calm)          | 5,500 lamports  | 0.001452 SOL | $0.15            | $0.29            | $0.44            |
| **Median (75th %)** | 10,000 lamports | 0.00264 SOL  | **$0.26**        | **$0.53**        | **$0.79**        |
| High (cap)          | 30,000 lamports | 0.00792 SOL  | $0.79            | $1.58            | $2.38            |

Median is the planning baseline; all subsequent figures use it
unless noted.

## 7.2 Annual cost projection

### 7.2.1 At v1 (5 peptides)

- Annual transaction count: 264 × 365 = **96,360 tx/year**
- Annual SOL @ median: 96,360 × 10,000 lamports ≈ **0.964 SOL/year**
- Annual SOL @ high (cap): ≈ 2.89 SOL/year

USD annual at $200/SOL:

| scenario | annual cost |
| -------- | ----------- |
| Low      | $29         |
| **Median**| **$193**   |
| High     | $578        |

Even at the worst-case priority-fee cap and pessimistic SOL price
($300), annual Solana fees stay under **$870** at v1 scale. The
order of magnitude is "research-budget rounding error," not "line
item that needs board approval."

### 7.2.2 SOL keypair buffer recommendation

Per §03.5.1's operational requirement of a ~30-day buffer on the
hot wallet:

| priority fee scenario | 30-day SOL needed | recommended buffer | days at buffer |
| --------------------- | ------------------ | ------------------- | -------------- |
| Low (calm)            | 0.044 SOL          | 0.10 SOL            | ~70 days       |
| Median (75th %)       | 0.080 SOL          | 0.30 SOL            | ~110 days      |
| High (cap)            | 0.240 SOL          | 0.50 SOL            | ~63 days       |

**Recommendation: initial fund of 0.5 SOL.** Covers ~6 months at
median priority fees, ~2 months at the worst-case cap. The §03.5.3
balance alarms (warn at 0.1 SOL, critical at 0.02 SOL) leave plenty
of operator response time before commits start failing.

### 7.2.3 Refill cadence

**Recommendation: quarterly refills** (top up to 0.5 SOL every 90
days). At median priority fees, each refill costs ~0.24 SOL = ~$48
@ $200/SOL. Annualized: ~$192 in actual SOL spend, which matches
the §7.2.1 median annual figure.

Why quarterly rather than monthly:

- Manual operator action (per §03.5.1 — never auto-refill from a
  larger reserve), so fewer touches is better
- 90 days lines up with normal financial review cadences
- Buffer comfortably covers a missed refill (the warn threshold
  triggers ~30 days before depletion)

Why not annual or semi-annual:

- Larger one-time fund increases the worst-case-key-compromise loss
  proportionally
- §03.5.1 specifies "minimal SOL, ~30-day buffer." Quarterly with
  0.5 SOL gives roughly 30 days of headroom past the warn threshold,
  not multiples.

## 7.3 RPC costs

### 7.3.1 Per-commit RPC consumption

Each commit makes the following Solana RPC calls:

| call                                | per-commit count | notes                                                  |
| ----------------------------------- | ---------------- | ------------------------------------------------------ |
| `getLatestBlockhash`                | ~0.5             | Cached for 25s (§03.4.3); refreshed lazily             |
| `getPriorityFeeEstimate` (Helius)   | 1                | One per submit; can't be cached usefully               |
| `sendTransaction`                   | 1                | The submission itself                                  |
| `getSignatureStatuses` (poll)       | ~5               | 90s timeout @ 3s interval = max 30, typical 5–8        |
| `getTransaction` (verification only)| 0                | Only on retry-reconcile path; rare                     |
| **Total per commit**                | **~7.5**         |                                                        |

Plus periodic background calls:

| call                          | rate            | per day |
| ----------------------------- | --------------- | ------- |
| `getBalance` (balance check)  | every 5 min     | 288     |
| Recovery poll reconciliation  | rare            | <50     |

### 7.3.2 Daily committer RPC consumption

At v1 (264 commits/day):

```
264 commits × 7.5 calls = 1,980
balance checks            =   288
recovery reconcile        =    50
                          ──────
                            ~2,300 RPC calls/day
```

Helius free tier: 100,000 requests/day. **Committer uses ~2.3% of
the free tier.** ~43× headroom for traffic growth, retries, or
verification API consumption.

### 7.3.3 Verification API RPC consumption

The verification API endpoints in §05.5 call Solana RPC during
verification. Per-request RPC cost:

- `POST /verify/observation` → 1 `getTransaction` call
- `POST /verify/twap` → 1 + N calls (1 for the TWAP commit's tx,
  N for each constituent observation's cycle commit). Typical N
  for v1 is 4–8 observations per TWAP.

**Assumed traffic for v1** (operator + early-adopter audience, not
viral scale):

| scenario   | verifications/day | RPC calls/day | as % of free tier |
| ---------- | ----------------- | ------------- | ----------------- |
| Light      | 100               | ~600          | 0.6%              |
| **Moderate** | **1,000**       | **~6,000**    | **6%**            |
| Heavy      | 10,000            | ~60,000       | 60%               |

Adding verification API traffic to committer consumption, the
moderate scenario lands at **~8,300 calls/day** — comfortably
within the free tier with ~12× headroom.

### 7.3.4 Free-tier headroom analysis

Total daily Solana RPC at v1 (5 peptides), moderate traffic:

```
committer:           2,300
verification API:    6,000
                    ──────
                     8,300/day  (8.3% of 100k free tier)
```

Free tier is comfortable for v1. Triggers for upgrade documented
in §7.3.5.

### 7.3.5 Triggers for paid-tier upgrade

Helius Developer tier: **$49/month**. Includes 1M req/day, WebSocket
subscriptions, dedicated infrastructure SLA.

Upgrade when **any** of the following hold:

1. **Sustained daily RPC > 50k.** 50% of free-tier limit. Gives
   buffer for traffic spikes before hitting hard rate-limit. At
   the v1 trajectory we'd hit this around 10× the moderate
   verification scenario or ~25× peptide count.
2. **Need real-time WebSocket subscriptions.** The free tier is
   HTTP-only. If we add account-change subscriptions for the
   verification flow (e.g., to detect when a slot finalizes
   without polling), we need the paid tier. Out of scope for v1.
3. **Repeated rate-limit hits.** 429 responses from Helius indicate
   we're being throttled even before exhausting the daily quota.
   Means traffic is bursty enough that rate limiting is the
   binding constraint, not daily cap.
4. **SLA is needed for production usage.** Free tier has no
   guaranteed uptime; if the oracle has paying customers, the
   SLA on the paid tier ($49/month) is worth the cost.

The upgrade path is straightforward: change `ORACLE_RPC_URL` env
var to the paid endpoint, redeploy. No application-level changes.

## 7.4 Hosting costs

### 7.4.1 Railway (existing)

Three services already running: `peptide-oracle-api`,
`peptide-oracle-scraper`, `peptide-oracle-worker`. The new
`peptide-oracle-oracle` service (per §03.1.1) is a fourth Railway
service in the same project.

**Estimated resource needs for the oracle service:**

- CPU: minimal. Two async polling loops + occasional crypto / RPC
  calls. <10% of a single vCPU at steady state.
- Memory: ~256 MB. Node.js baseline + supabase-js + @solana/web3.js
  + small in-memory queue for in-flight commits.
- Network: small. ~10 KB/commit out (Memo + tx envelope), ~10 KB/commit
  in (RPC responses). At 264 commits/day = ~5 MB/day egress.

**Marginal Railway cost: ~$5–10/month.** Railway charges by
container-hour and gigabyte-month; a 256 MB always-on Node service
sits in the lower bucket.

### 7.4.2 Supabase database growth

Three new tables (per §01). Estimated row sizes:

| table                | bytes/row (est) | rows/day at v1 | annual rows  | annual storage |
| -------------------- | ---------------- | -------------- | ------------ | -------------- |
| `commit_cycles`      | ~600             | 144            | 52,560       | ~32 MB         |
| `twap_commits`       | ~700             | 120            | 43,800       | ~31 MB         |
| `commit_observations`| ~150             | ~17,000*       | ~6.2M        | ~930 MB        |

\* Cycle commit row count × observations per cycle. v1 has ~26 active
peptides × ~5 suppliers each ≈ 118 supplier_products. So 144 cycles
× 118 obs ≈ 17,000 junction rows/day.

**`commit_observations` is the dominant growth driver** by an order
of magnitude. ~1 GB/year at v1 scale.

The row-size estimates account for:

- Hex-encoded merkle_root / leaf_hash (66 chars text)
- ISO timestamps (~40 chars each)
- `memo_payload` text columns on commit tables (200–300 chars)
- Postgres row overhead, FK indexes, partial indexes

**Supabase tier sizing:**

- Free tier: 500 MB. Insufficient for v1 from day one.
- **Pro tier ($25/month): 8 GB included.** Comfortably covers v1
  through year ~7 with all three tables. Already where the project
  sits today.

Existing Pro tier covers the new tables without an upgrade. Storage
growth is monitorable via Supabase's dashboard; the §8 runbook will
include a "review storage every 6 months" item.

### 7.4.3 Hosting total

| component                      | annual cost |
| ------------------------------ | ----------- |
| Railway oracle service         | $60–120     |
| Supabase Pro (already running) | $0 marginal |
| **Total marginal hosting**     | **$60–120/year** |

## 7.5 Total cost of operation

At v1 (5 peptides), median priority fees, $200/SOL, moderate
verification API traffic:

| component                    | annual    | monthly equivalent |
| ---------------------------- | --------- | ------------------ |
| Solana fees (96k tx/year)    | ~$193     | ~$16               |
| Helius RPC (free tier)       | $0        | $0                 |
| Railway oracle service       | ~$90      | ~$8                |
| Supabase Pro (marginal)      | $0        | $0                 |
| **Total**                    | **~$283** | **~$24**           |

**Order of magnitude: $20–25/month for v1 oracle operation.** That
rises to ~$30/month if we conservatively use the high priority fee
cap, ~$80/month if we add Helius Developer tier ($49/month) without
needing it.

For comparison: the existing scraper + worker + API services on
Railway run at roughly the same monthly cost. The oracle layer
roughly doubles the project's hosted-infrastructure operating
expense — but adds the entire on-chain attestation surface, which
is the main user-facing differentiator for the new direction.

## 7.6 Cost scaling scenarios

### 7.6.1 Scaling matrix

| metric                    | v1 (5)    | 10        | 25        | 50        |
| ------------------------- | --------- | --------- | --------- | --------- |
| Cycle commits/day         | 144       | 144       | 144       | 144       |
| TWAP commits/day          | 120       | 240       | 600       | 1,200     |
| Total tx/day              | 264       | 384       | 744       | 1,344     |
| Annual tx                 | 96k       | 140k      | 272k      | 491k      |
| Annual SOL @ median       | 0.96      | 1.40      | 2.72      | 4.91      |
| Annual SOL @ high         | 2.89      | 4.20      | 8.16      | 14.7      |
| Annual fees @ $200 median | $193      | $280      | $544      | $982      |
| Annual fees @ $200 high   | $578      | $840      | $1,632    | $2,940    |
| Daily committer RPC       | ~2,300    | ~3,300    | ~6,400    | ~11,500   |
| Annual `commit_observations` storage | ~930 MB | ~930 MB | ~2.3 GB | ~4.6 GB |

### 7.6.2 What scales linearly vs sub-linearly

**Linear in peptide count** (each new peptide adds proportional cost):

- TWAP commits per day (24 per peptide)
- Annual SOL fees (because TWAP commits dominate at high N)
- Verification API RPC calls (more peptides → more potential targets)

**Constant** (independent of peptide count at our scale):

- Cycle commits (144/day regardless — driven by scrape cadence)
- Hosting (Railway oracle service stays under one container's worth
  even at 50 peptides; Supabase storage well within Pro tier)
- Helius free tier consumption (still has headroom at 50 peptides
  with moderate verification traffic)

**Sub-linear** (each new peptide adds *some* cost but not full
proportion):

- `commit_observations` storage growth — driven by supplier_products
  count, which doesn't grow exactly 1:1 with peptide count (some
  peptides have 8 vendors, some have 2)
- SOL keypair refill cadence — quarterly cadence holds up to
  ~50 peptides; only needs shortening past that scale

### 7.6.3 Upgrade thresholds

| trigger                                | activates at           | action                          |
| -------------------------------------- | ---------------------- | ------------------------------- |
| Helius free tier becomes tight         | ~50k daily RPC         | upgrade to Developer ($49/mo)   |
| Refill cadence too long                | annual SOL > 2 SOL     | shorten to monthly refills      |
| Supabase Pro tier exhausted            | 8 GB total             | upgrade to Team ($599/mo) — far away |
| Railway service hits memory limit      | ~512 MB peak           | bump container size, $5–10/mo extra |
| Verification API rate limits binding   | sustained 429s         | upgrade Helius OR add CDN front |

The Helius upgrade is the closest threshold by an order of magnitude.
At 50 peptides we'd hit ~12k committer + verification API in the
moderate scenario — still well under 50k. Realistically the
verification API traffic would have to grow ~6× over moderate
before triggering the upgrade.

The Supabase tier change is so far away (estimated 30+ peptides
× 5 years) that it's not a v1 planning concern.

## 7.7 Decisions to flag

1. **Helius free tier from day one.** Recommended. ~12× headroom
   on the moderate verification scenario. Budget the Developer tier
   ($49/month) as a planned upgrade once daily RPC sustains above
   50k or verification API needs WebSocket subscriptions. No
   application changes needed for the upgrade.
2. **Budget alerts on Solana keypair balance.** Recommended,
   already specified by §03.5.3 + §03.9.2. The /health endpoint's
   `wallet.balance_low` and `wallet.balance_critical` flags drive
   external monitoring; thresholds default to 0.1 SOL warn / 0.02
   SOL critical, override-able via env.
3. **Pre-purchase SOL quarterly.** Recommended. Refill 0.5 SOL
   every 90 days; amortizes any one-time exchange fees across
   ~25,000 transactions and matches normal financial review
   cadences. The §03.5.4 rotation procedure also assumes a
   quarterly touch.
4. **Track RPC usage as a separate metric for upgrade-trigger
   monitoring.** Recommended. Helius's dashboard reports daily
   request counts; the operator should review weekly during v1
   rollout, then monthly after stabilization. The /health endpoint
   adds an `rpc_daily_used` field as part of §3.9.2 (call out to
   the runbook §8 for the exact monitoring procedure).

## 7.8 Sensitivity to SOL price

The dollar projections above assume $200/SOL. Actual SOL has ranged
roughly $20–$300 in the trailing 24 months. Sensitivity at v1 scale
(median priority fees, ~0.96 SOL/year):

| SOL price | annual fees | monthly equivalent |
| --------- | ----------- | ------------------ |
| $50       | $48         | $4                 |
| $100      | $96         | $8                 |
| **$200**  | **$193**    | **$16**            |
| $300      | $289        | $24                |
| $500      | $482        | $40                |

The oracle operating cost is dominated by hosting and (eventually)
RPC tier — even at $500/SOL, Solana fees are only ~2× the Railway
hosting line. Operationally this means: **the project's exposure
to SOL price volatility is not a planning concern at v1 scale**,
but it becomes one at 50+ peptides where annual SOL spend climbs
into the multi-thousand-dollar range.
