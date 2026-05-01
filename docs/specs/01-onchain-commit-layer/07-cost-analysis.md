# 07 — Cost analysis

Status: **draft**. Cost projections for the on-chain commit layer
at v1 scale (26 peptides) with scaling scenarios up to 250 peptides.
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
- **At v1 (N=26)**: 624/day = 227,760/year. The active-peptide
  subset for v1 is "all `peptides.is_active = true`" per the §9.2.1
  decision — no allow-list restriction. Every active peptide gets
  hourly TWAP commits.
- **Memo size**: 312 bytes (§02.2.3, post-`algo`)
- **Per-commit cost** (median priority fee): 10,000 lamports = 0.00001 SOL

Daily TWAP-commit cost at N=26 (median): 624 × 10,000 = 6,240,000
lamports = **0.00624 SOL/day** ($1.25 @ $200/SOL).

### 7.1.5 Daily totals

At v1 (26 peptides), 768 transactions/day (144 cycle + 624 TWAP):

| scenario            | per-tx cost     | daily SOL    | daily USD @ $100 | daily USD @ $200 | daily USD @ $300 |
| ------------------- | --------------- | ------------ | ---------------- | ---------------- | ---------------- |
| Low (calm)          | 5,500 lamports  | 0.00422 SOL  | $0.42            | $0.84            | $1.27            |
| **Median (75th %)** | 10,000 lamports | 0.00768 SOL  | **$0.77**        | **$1.54**        | **$2.30**        |
| High (cap)          | 30,000 lamports | 0.02304 SOL  | $2.30            | $4.61            | $6.91            |

Median is the planning baseline; all subsequent figures use it
unless noted. Note that the 26-peptide active set is ~2.9× the
total transaction count of an early-spec 5-peptide baseline —
the cycle commits (144/day) don't scale with peptide count, so
total cost grows less than the TWAP-only ratio of 5.2×.

## 7.2 Annual cost projection

### 7.2.1 At v1 (26 peptides)

- Annual transaction count: 768 × 365 = **280,320 tx/year**
- Annual SOL @ median: 280,320 × 10,000 lamports ≈ **2.80 SOL/year**
- Annual SOL @ high (cap): ≈ 8.41 SOL/year

USD annual at $200/SOL:

| scenario | annual cost |
| -------- | ----------- |
| Low      | $84         |
| **Median**| **$561**   |
| High     | $1,682      |

Even at the worst-case priority-fee cap and pessimistic SOL price
($300), annual Solana fees stay under **$2,525** at v1 scale.
That's a real line item — significantly higher than the 5-peptide
projections in earlier drafts of this spec — but still
"line-item-on-a-quarterly-budget" rather than "needs separate
funding round." The §7.5 total-cost rollup remains under
$60/month even at the median planning baseline.

### 7.2.2 SOL keypair buffer recommendation

Per §03.5.1's operational requirement of a ~30-day buffer on the
hot wallet, at v1 = 26 peptides:

| priority fee scenario | 30-day SOL needed | recommended buffer | days at buffer |
| --------------------- | ------------------ | ------------------- | -------------- |
| Low (calm)            | 0.13 SOL           | 0.50 SOL            | ~120 days      |
| Median (75th %)       | 0.23 SOL           | 1.00 SOL            | ~130 days      |
| High (cap)            | 0.69 SOL           | 1.00 SOL            | ~43 days       |

**Recommendation: initial fund of 1.0 SOL** (revised up from the
0.5 SOL recommendation that applied at the earlier 5-peptide
baseline). Covers ~4 months at median priority fees, ~6 weeks at
the worst-case cap. The §03.5.3 default balance alarms (warn at
0.1 SOL, critical at 0.02 SOL) are now **tight at high priority
fees** — at v1 = 26 peptides + cap-priced txs, 0.1 SOL is only
~4 days remaining and 0.02 SOL is < 1 day. Operators should
consider raising both thresholds via env var to maintain the
intended buffer:

```
ORACLE_BALANCE_WARN_SOL      = 0.30   # ~13 days at high cap
ORACLE_BALANCE_CRITICAL_SOL  = 0.15   # ~7 days at high cap
```

These are env-var defaults; changing them is a one-line Railway
config update without restart impact.

### 7.2.3 Refill cadence

**Recommendation: quarterly refills** (top up to 1.0 SOL every 90
days). At median priority fees, each refill costs ~0.7 SOL =
~$140 @ $200/SOL. Annualized: ~$561 in actual SOL spend, which
matches the §7.2.1 median annual figure.

Why quarterly rather than monthly:

- Manual operator action (per §03.5.1 — never auto-refill from a
  larger reserve), so fewer touches is better
- 90 days lines up with normal financial review cadences
- Buffer comfortably covers a missed refill at median priority
  fees (~130 days at 1.0 SOL initial)

Why not annual or semi-annual:

- Larger one-time fund increases the worst-case-key-compromise loss
  proportionally
- §03.5.1 specifies "minimal SOL, ~30-day buffer." Quarterly with
  1.0 SOL gives roughly 30 days of headroom past the warn threshold
  even at the high-priority-fee cap.

**Tighten to monthly if** sustained priority fees stay near the cap
(which would deplete a 1.0 SOL fund in ~6 weeks). The §08.2.1
weekly Helius dashboard review is the early signal for this.

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

At v1 (768 commits/day):

```
768 commits × 7.5 calls = 5,760
balance checks            =   288
recovery reconcile        =    50
                          ──────
                            ~6,100 RPC calls/day
```

Helius free tier: 100,000 requests/day. **Committer uses ~6.1% of
the free tier.** ~16× headroom for traffic growth, retries, or
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
moderate scenario lands at **~12,100 calls/day** — comfortably
within the free tier with ~8× headroom.

### 7.3.4 Free-tier headroom analysis

Total daily Solana RPC at v1 (26 peptides), moderate traffic:

```
committer:           6,100
verification API:    6,000
                    ──────
                    12,100/day  (12.1% of 100k free tier)
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

At v1 (26 peptides), median priority fees, $200/SOL, moderate
verification API traffic:

| component                    | annual    | monthly equivalent |
| ---------------------------- | --------- | ------------------ |
| Solana fees (280k tx/year)   | ~$561     | ~$47               |
| Helius RPC (free tier)       | $0        | $0                 |
| Railway oracle service       | ~$90      | ~$8                |
| Supabase Pro (marginal)      | $0        | $0                 |
| **Total**                    | **~$651** | **~$54**           |

**Order of magnitude: ~$50–55/month for v1 oracle operation at the
median priority-fee scenario.** That rises to ~$150/month if
priority fees sustain at the cap (worst-case-but-bounded), and
to ~$100/month if we add Helius Developer tier ($49/month) when
verification traffic eventually outgrows the free tier.

For comparison: the existing scraper + worker + API services on
Railway run at roughly $25–35/month combined. The oracle layer
roughly **doubles** the project's hosted-infrastructure operating
expense — but adds the entire on-chain attestation surface, which
is the main user-facing differentiator for the new direction.

The 26-peptide v1 baseline is materially more expensive than the
5-peptide projections in earlier drafts of this spec (~$24/month).
The added cost is honest scaling — every new peptide means an
extra 24 TWAP commits/day. If user-facing cost ever needs trimming,
the lever is the §03.3.4 active-peptide allow-list filter (env
var, no code change).

## 7.6 Cost scaling scenarios

### 7.6.1 Scaling matrix

| metric                    | **v1 (26)** | 50        | 100       | 250       |
| ------------------------- | ----------- | --------- | --------- | --------- |
| Cycle commits/day         | 144         | 144       | 144       | 144       |
| TWAP commits/day          | 624         | 1,200     | 2,400     | 6,000     |
| Total tx/day              | 768         | 1,344     | 2,544     | 6,144     |
| Annual tx                 | 280k        | 491k      | 929k      | 2.24M     |
| Annual SOL @ median       | 2.80        | 4.91      | 9.29      | 22.4      |
| Annual SOL @ high         | 8.41        | 14.7      | 27.9      | 67.3      |
| Annual fees @ $200 median | **$561**    | $982      | $1,857    | $4,485    |
| Annual fees @ $200 high   | **$1,682**  | $2,940    | $5,571    | $13,455   |
| Daily committer RPC       | ~6,500      | ~11,500   | ~21,500   | ~52,000   |
| Annual `commit_observations` storage | ~2.4 GB | ~4.6 GB | ~9.2 GB | ~23 GB    |

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

**At v1 = 26 peptides** the committer alone burns ~6,500 RPC/day,
leaving ~93,500/day of free-tier headroom for the verification
API. At 50 peptides total RPC consumption would land around
~17,000/day with moderate verification traffic — still well under
50,000.

**The Helius upgrade is closer than originally projected** (when
the spec assumed v1=5). At 100+ peptides the committer alone
would push ~22k/day, and verification traffic at "heavy" scale
would breach the 50k upgrade threshold. The 50% trigger lives in
the 100-peptide column, not the 50-peptide column.

**The Supabase tier change** moves to ~year-3 at the v1=26 baseline
(8 GB Pro tier ÷ 2.4 GB/year ≈ 3.3 years). At 50 peptides it's
~year-1.5. Storage growth is now a real planning concern, not the
distant non-issue it was at v1=5; the §08.2.3 weekly storage check
becomes load-bearing.

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
(26 peptides, median priority fees, ~2.80 SOL/year):

| SOL price | annual fees | monthly equivalent |
| --------- | ----------- | ------------------ |
| $50       | $140        | $12                |
| $100      | $280        | $23                |
| **$200**  | **$561**    | **$47**            |
| $300      | $841        | $70                |
| $500      | $1,402      | $117               |

At the 26-peptide v1 baseline, Solana fees are now the **largest
single line item** in the operating budget (vs ~equal to hosting
at the original 5-peptide projection). Operationally this means:
**SOL price volatility is a real planning concern at v1 scale**,
not deferred to 50+ peptides as the earlier spec drafts suggested.
A 2× swing in SOL price moves monthly cost by ~$50 either direction
— meaningful but absorbable.

If sustained SOL price > $400 makes the line item uncomfortable,
levers in priority order: (a) restrict the active-peptide
allow-list per §03.3.4 to the highest-value subset, (b) lower the
priority-fee cap from 50k → 20k µlamports/CU (accepting some
dropped-tx risk during congestion), (c) drop TWAP commit cadence
from hourly to bi-hourly (halves TWAP-commit count).
