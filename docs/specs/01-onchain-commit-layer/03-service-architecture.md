# 03 — Backend service architecture

Status: **draft**. Architecture spec for the committer service. No
code in this document — the file structure, module breakdown, and
operational behavior described here become implementation tickets
once approved.

This section depends on §01 (database schema, locked) and §02
(cryptographic primitives, locked). It pre-decides:

- Where the service lives in the workspace
- How it detects ready-to-commit work
- What happens between "row appears in DB" and "tx confirmed on Solana"
- How failures are retried, recovered, and bounded
- How the keypair is stored, monitored, and rotated
- What the operator sees when something goes wrong

It explicitly does **not** decide:

- The verification API endpoints (§5/§6)
- Cost numbers (§7, but a working figure is referenced here for context)
- The full operator runbook (§8)
- Open questions still up for review (§9)

## 3.1 Service location and structure

### 3.1.1 New app, not a worker module

**Decision: a new `apps/oracle` workspace package, not a module inside
`apps/worker`.** Three reasons:

1. **Independent failure domain.** The TWAP worker is mission-critical
   for fresh data; if Solana RPC is down or the hot wallet runs out
   of SOL, that should not block the worker from continuing to
   compute and persist TWAPs into Postgres. Coupling them in the
   same process means one's outage takes down the other.
2. **Different external dependencies.** The worker only needs
   Postgres + supabase-js. The oracle additionally needs
   `@solana/web3.js` (or equivalent), an RPC URL, and a private
   key. Keeping the surfaces separate keeps the worker's attack
   surface and dependency footprint small.
3. **Different lifecycle cadence.** The worker ticks every minute on
   a fixed schedule. The oracle has two distinct loops at different
   cadences (cycle poll every 30s, TWAP poll every 60s aligned to
   hour boundaries) plus reactive submit/confirm work. Cleaner as
   its own program.

Cost of the split: one more Railway service, one more set of env
vars, one more `pnpm` workspace package. Acceptable.

### 3.1.2 File structure

```
apps/oracle/
├── package.json                  # @peptide-oracle/oracle
├── tsconfig.json
├── Dockerfile
├── .env.example
└── src/
    ├── index.ts                  # entry point, main loops, shutdown
    ├── config.ts                 # env loading, validation
    ├── health.ts                 # /health endpoint state object
    │
    ├── canonical/
    │   ├── observation.ts        # canonical leaf JSON for §02.4.2
    │   ├── memo-cycle.ts         # canonical cycle memo per §02.2.2
    │   └── memo-twap.ts          # canonical TWAP memo per §02.2.3
    │
    ├── merkle/
    │   ├── tree.ts               # SHA-256 tree per §02.4.3-§02.4.5
    │   └── proof.ts              # Merkle proof generation (used by API)
    │
    ├── solana/
    │   ├── client.ts             # RPC client + blockhash cache
    │   ├── memo-program.ts       # SPL Memo v2 instruction builder
    │   ├── keypair.ts            # private-key load + balance checks
    │   ├── priority-fee.ts       # Helius getPriorityFeeEstimate adapter
    │   └── submit.ts             # send + confirm tx, retries inside
    │
    ├── pollers/
    │   ├── cycle-poller.ts       # finds unanchored scraper_runs, commits
    │   └── twap-poller.ts        # hourly per-peptide TWAP commit
    │
    └── persist/
        ├── cycle.ts              # commit_cycles + commit_observations writes
        └── twap.ts               # twap_commits writes
```

### 3.1.3 Entry point and main loops

`src/index.ts` does:

1. Load + validate config (env vars, RPC URL, keypair, balance threshold)
2. Acquire a Postgres advisory lock (§3.8) — refuse to start if held
3. Start the standalone health server (port `HEALTH_PORT`, default 8080)
4. Start the cycle poller and TWAP poller as concurrent async loops
5. On `SIGTERM`/`SIGINT`: signal both pollers to drain their current
   commit (if any) and exit cleanly
6. Release the advisory lock on exit

The two pollers share an `AbortSignal` for shutdown. The pattern
mirrors the existing `apps/worker` shutdown handling.

## 3.2 Cycle detection

### 3.2.1 Polling, not triggers

**Decision: database polling.** Every 30 seconds the cycle poller
runs the query below to find scrape cycles that are completed and
not yet committed. A 30s upper bound on detection latency is
negligible relative to the 10-minute cycle cadence.

Alternatives considered and rejected:

- **`LISTEN`/`NOTIFY`.** Elegant in theory, fragile in practice —
  needs a long-lived DB connection that survives Postgres restarts,
  network blips, and Supabase pooler reconnects. The complexity
  isn't justified at our cadence.
- **External job queue (Redis, SQS).** Overkill. Would add another
  piece of infrastructure for a once-every-10-minutes signal.

### 3.2.2 The detection query

```sql
SELECT sr.id AS cycle_id,
       sr.started_at,
       sr.finished_at AS completed_at
FROM   public.scraper_runs sr
LEFT JOIN public.commit_cycles cc ON cc.cycle_id = sr.id
WHERE  sr.finished_at IS NOT NULL
  AND  sr.status IN ('completed', 'partial')
  AND  cc.cycle_id IS NULL                          -- not yet anchored
  AND  EXISTS (
         SELECT 1 FROM public.supplier_observations o
         WHERE o.scraper_run_id = sr.id
           AND o.scrape_success = true
       )                                             -- has at least 1 leaf
ORDER BY sr.id ASC
LIMIT 1;
```

Returns at most one row per poll. The poller processes cycles
sequentially — committing a single transaction at a time keeps the
hot wallet's nonce-equivalent (recent blockhash) easy to reason
about. If the queue grows (e.g. after a Solana outage), each poll
shaves one row off the front; backlog drains in 30s × N polls.

The `EXISTS` check on successful observations is what enforces the
"zero-observation cycles aren't committed" rule from §02.4.5 and
§02.4.8. BACHEM/SIGMA's all-failed runs don't qualify.

### 3.2.3 Recovery poll for in-flight rows

A second query, run alongside the detection query, picks up rows
that were partially processed before a previous crash:

```sql
SELECT cycle_id, status, solana_signature, retry_count, last_error
FROM   public.commit_cycles
WHERE  status IN ('pending', 'submitted')
ORDER BY created_at ASC
LIMIT 5;
```

Hits the `idx_commit_cycles_pending_work` partial index from §01.7.2.
The poller reconciles each in-flight row against Solana state
(§3.7) before going back to the detection query.

## 3.3 TWAP commit scheduling

### 3.3.1 Hour boundary

**Decision: top-of-hour UTC + 30s skew.** The TWAP poller wakes at
`HH:00:30` UTC and commits one row per active peptide for the hour
that just ended.

Why the 30s skew: the worker writes `peptide_twaps` rows at the end
of each minute, so by `HH:00:30` we're guaranteed to have a row
whose `computed_at` falls exactly at the hour boundary or
immediately before it. The committer doesn't compute its own TWAP;
it picks up the worker's most recent row.

Implementation: the poller sleeps until the next `HH:00:30` mark,
runs the commit batch, sleeps again. Crash recovery on startup
re-checks the current hour: if no commit exists for `(peptide_code,
computed_at = current-hour-boundary)`, it runs the commit immediately.

### 3.3.2 What gets committed

For each peptide where `peptides.is_active = true`:

```sql
SELECT pt.id,
       pt.peptide_id,
       pt.computed_at,
       pt.window_start,
       pt.window_end,
       pt.twap_usd_per_mg,
       pt.input_observation_ids,
       p.code AS peptide_code
FROM   public.peptide_twaps pt
JOIN   public.peptides p ON p.id = pt.peptide_id
WHERE  p.is_active = true
  AND  p.code = $1
  AND  pt.computed_at <= $2                       -- hour boundary
  AND  pt.twap_usd_per_mg IS NOT NULL             -- skip thin-data rows
ORDER BY pt.computed_at DESC
LIMIT 1;
```

The `twap_usd_per_mg IS NOT NULL` filter handles the thin-data case
from §13 of the original spec — peptides with fewer than 2 reporting
suppliers in the window have NULL TWAPs, which we don't commit.
That row is logged as "no TWAP available, skipped" and the poller
moves to the next peptide.

### 3.3.3 Order of operations per peptide

1. Resolve the latest qualifying `peptide_twaps` row
2. Skip if `twap_usd_per_mg` is NULL
3. Compute Merkle root over `input_observation_ids` per §02.4
4. Build canonical TWAP memo per §02.2.3
5. Insert `twap_commits` row (status=`pending`) inside a DB transaction
6. Submit Solana tx (§3.4)
7. Update row to `submitted`, set `solana_signature`
8. Wait for confirmation
9. Update row to `confirmed`, set `solana_slot` and `confirmed_at`

The unique constraint on `(peptide_code, computed_at)` (§01.2) makes
step 5 idempotent: a re-run after crash hits the existing row, and
the poller transitions to recovery mode (§3.7.5) for that row.

### 3.3.4 Active peptide subset

This is one of the open questions in §9 of the parent doc. Two
plausible v1 behaviors:

- **All `is_active = true` peptides** — currently 26. Simple, no
  config drift between the worker's "active" set and the oracle's
  "what we anchor" set.
- **An explicit allow-list** — config-driven, e.g.
  `ORACLE_TWAP_PEPTIDE_CODES=BPC157,GLP1,TB500`. Useful if we want
  to launch with a small premium subset.

Recommendation: start with all active peptides. Cost is bounded
(§7). If we need to dial back later, an env-var allow-list filter
is a 5-line change.

## 3.4 Solana transaction lifecycle

### 3.4.1 Transaction shape

A single instruction: SPL Memo v2 program on mainnet:

```
program id: MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr
accounts:   [hot wallet (signer, fee payer)]
data:       UTF-8 bytes of canonical JSON memo
```

Transaction structure:

```
Header
  signatures (1: hot wallet)
  message
    accountKeys[0] = hot wallet pubkey (signer + fee payer)
    accountKeys[1] = Memo program id (read-only)
    recentBlockhash
    instructions[0]
      programIdIndex = 1
      accounts = []
      data = canonical_memo_utf8
```

Compute-budget instructions added inline (set CU price + CU limit)
to handle priority fee — see §3.4.4.

### 3.4.2 Transaction size

Cycle memo:  226 bytes (§02.2.2)
TWAP memo:   284 bytes (§02.2.3)
Memo instruction overhead: ~6 bytes
Compute-budget instructions: ~24 bytes (two instructions, ~12 each)
Transaction overhead: ~96 bytes
  (1 sig × 64 bytes, header 3 bytes, blockhash 32 bytes, fee payer
   already counted in sig; 4-byte length prefix on instructions
   array; etc.)

Total worst case: ~410 bytes. Well under the 1232-byte legacy
transaction limit and the 1644-byte versioned transaction limit.

We use **legacy transactions** for v1 — Memo v2 doesn't benefit
from versioned tx features, and legacy keeps the integration
narrow. If v2 ever needs Lookup Tables (it won't for a single
Memo instruction), we revisit.

### 3.4.3 Recent blockhash management

Solana blockhashes expire after ~150 slots (~60 seconds). The
client caches the latest blockhash returned by
`getLatestBlockhash()` and refreshes:

- **Lazy:** if the cached value is older than 25 seconds at submit
  time, fetch a fresh one before signing
- **On error:** if the validator returns "blockhash not found" or
  "blockhash expired", invalidate cache and refetch immediately

The 25s threshold leaves a safety margin between cache age + RPC
round-trip + submission + confirmation polling. Keeps the typical
path to one `getLatestBlockhash` call per ~30s instead of per tx.

### 3.4.4 Priority fees

**Decision: dynamic priority fees from Helius's
`getPriorityFeeEstimate` API, capped.**

Static fees (e.g. always 1000 micro-lamports per CU) work fine in
calm conditions but get our txs dropped during congestion. Helius
returns a percentile-distribution estimate; we use the **75th
percentile** by default. Capped at **50,000 micro-lamports per CU**
to bound worst-case cost.

Compute-unit limit: a single Memo instruction uses ~200 CU (per
empirical Solana metrics). We set CU limit = 500 to buffer against
program changes. Total priority fee per tx = 500 CU × fee_per_CU.

Worst case at the cap: 500 × 50,000 micro-lamports = 25,000,000
micro-lamports = 25,000 lamports = 0.000025 SOL. Add the 5,000
lamport base fee; total worst-case per tx is 0.00003 SOL. Even at
that ceiling, daily cost stays under 0.01 SOL — see §7.

### 3.4.5 Confirmation commitment level

**Decision: `finalized`.**

Three options on Solana:

| level       | semantics                              | typical latency | reorg risk          |
| ----------- | -------------------------------------- | --------------- | ------------------- |
| `processed` | latest cluster state                   | < 1s            | high (may roll back)|
| `confirmed` | voted on by 2/3 of validators          | ~3–5s           | very low            |
| `finalized` | 31+ blocks deep                        | ~13s            | none (cryptoeconomic finality) |

For an oracle service whose value proposition is cryptographic
integrity, the trade-off favors zero reorg risk over marginal
latency. The 8–10s additional latency vs. `confirmed` is negligible
relative to the 30-second polling cadence (§3.2.1) and the
10-minute upstream cycle cadence — at finality our commits land
well before the next cycle even starts. Anchoring against
`finalized` slots means a verifier who fetches the on-chain Memo
later **never** has to worry about the slot having been re-orged
out from under them.

The latency budget for confirmation polling (§3.4.6) is sized to
accommodate finalization comfortably even under congestion.

### 3.4.6 Confirmation polling

Solana's web3.js `confirmTransaction` blocks on a WebSocket
subscription. We use HTTP polling instead — simpler, more robust
across reconnects, easier to bound:

```
while not_finalized and (now - submit_time) < CONFIRMATION_TIMEOUT:
    sleep(CONFIRMATION_POLL_INTERVAL)
    status = getSignatureStatuses([signature])
    if status.confirmationStatus == 'finalized':
        return Confirmed(slot=status.slot)
    if status.err != null:
        return Failed(error=status.err)
return Timeout
```

Defaults: `CONFIRMATION_TIMEOUT = 90s`, `CONFIRMATION_POLL_INTERVAL = 3s`.
A 90s budget covers `finalized` comfortably even under congestion —
typical latency is ~13s, observed worst case during heavy load is
~30–45s. The `'confirmed'` short-circuit return is intentionally
omitted; we wait for full finality before transitioning the row's
`status` column to `confirmed` in the DB. (The DB enum value
`'confirmed'` is reused here to mean "finality reached on-chain";
it's a bit of a name collision but renaming it would churn §01 +
§02 cross-references for no semantic gain.)

## 3.5 Keypair management

### 3.5.1 Storage

**Decision: Railway environment variable** named
`ORACLE_SOLANA_PRIVATE_KEY`. Value: base58-encoded 64-byte secret
key (the format `solana-keygen` produces).

Why env var over alternatives:

| option              | considered                                                          |
| ------------------- | ------------------------------------------------------------------- |
| Env var (chosen)    | Railway encrypts at rest; simple operator workflow; no extra infra |
| Encrypted file      | Needs another secret to decrypt — recursion problem                 |
| AWS/GCP KMS         | Overkill for v1; adds a non-Railway dependency                      |
| Solana SQS / vault  | No mature pattern for hot-wallet signing on Solana yet              |

Trade-off: anyone with Railway access can read the key. Mitigated
by:

- The committer's wallet is **dedicated to this service only** —
  not a personal wallet, not used for anything else
- **Single-purpose** — only ever signs Memo program txs to a known
  program ID; an attacker stealing the key can drain SOL but not
  much else
- A Railway secret is no different from a database password from
  an attack-surface standpoint, and we already accept that exposure
  for `SUPABASE_SECRET_KEY`

**Operational requirements (normative for v1 deployment):**

The env-var storage choice is acceptable only when all three of
the following hold. If any one is not true, escalate to a stronger
storage mechanism (KMS or hardware signer) before going to mainnet.

1. **Restricted Railway access.** Project-level Railway access is
   limited to trusted operators. Adding a teammate to the Railway
   project is treated as the same trust action as handing them the
   private key directly. Audit the access list before launch and
   on any team change.
2. **Marked as a secret in Railway.** The `ORACLE_SOLANA_PRIVATE_KEY`
   variable is set with Railway's "secret" toggle enabled — masks
   the value in the dashboard, excludes it from logs and from any
   redeploy diff. Confirm this in the Railway UI immediately after
   the variable is first set.
3. **Minimal SOL, ~30-day buffer, manually refilled.** Initial fund
   is sized for ~30 days of expected commit cost (current §7
   projection: ~0.4 SOL covers 30 days of cycle + TWAP commits at
   the dynamic-fee cap with comfortable headroom). Refills happen
   manually based on the §3.5.3 balance alerts. Never auto-refill
   from a larger reserve wallet — that would expose the larger
   wallet to whatever compromise scenario takes the hot wallet.

The combined effect: a worst-case key compromise drains ≤ 30 days
of operating cost, gives the attacker no other capability (Memo
txs only), and is detectable within minutes via the balance alarms.

### 3.5.2 Loading

At service startup:

```
1. Read ORACLE_SOLANA_PRIVATE_KEY
2. base58.decode → expect 64 bytes
3. Construct Keypair from secretKey
4. Log: "[startup] oracle wallet: <publicKey base58>"
5. Fetch balance via getBalance
6. Log: "[startup] balance: 0.4732 SOL"
7. Refuse to start if balance < ORACLE_MIN_STARTUP_BALANCE_SOL (default 0.05)
```

The startup balance check fails fast on a misconfigured deploy
rather than letting the service come up and silently fail every
submit attempt.

### 3.5.3 Balance monitoring

The cycle poller checks balance every 5 minutes (configurable via
`ORACLE_BALANCE_CHECK_INTERVAL_MS`):

- Balance < `ORACLE_BALANCE_WARN_SOL` (default 0.1 SOL): log warn,
  surface in `/health` as `balance_low: true`
- Balance < `ORACLE_BALANCE_CRITICAL_SOL` (default 0.02 SOL): log
  error, surface `balance_critical: true`. Service continues to
  attempt commits; they may start failing with insufficient SOL.

`/health` exposes `balance_sol` as a numeric so external monitoring
can alert on it directly without parsing logs.

### 3.5.4 Rotation procedure

Manual, documented as a runbook:

```
1. Generate new keypair locally:
     solana-keygen new --no-bip39-passphrase --outfile new-oracle.json
2. Fund new keypair with 0.5 SOL from a personal wallet
3. In Railway dashboard, update ORACLE_SOLANA_PRIVATE_KEY env var
   on the oracle service. Save (does not auto-restart).
4. Trigger a redeploy of the oracle service.
5. After redeploy, verify /health shows the new public key and
   non-zero balance.
6. Sweep the old wallet to a dead-letter address:
     solana transfer <dead-letter> ALL --keypair old-oracle.json
7. Securely delete old-oracle.json.
```

The procedure is captured here so the operational runbook (§8)
can cross-reference it.

## 3.6 RPC strategy

### 3.6.1 Primary RPC

**Decision: Helius for v1.** Reasons:

- Free tier covers our usage (100,000 requests/day; we project
  ~10,000/day — see §7 and §3.6.3)
- Provides `getPriorityFeeEstimate` (§3.4.4) which the public
  Solana RPC doesn't
- Reliable enough to anchor against; SLA 99.9% on paid tiers, and
  the free tier track record has been stable
- Easy to upgrade to a paid plan if we outgrow the free tier without
  changing application code

Configured via env var:

```
ORACLE_RPC_URL=https://mainnet.helius-rpc.com/?api-key=<key>
```

Alternatives considered:

| provider             | notes                                                            |
| -------------------- | ---------------------------------------------------------------- |
| Helius (chosen)      | Best fit for our profile (priority fee API, free tier headroom)  |
| QuickNode            | Comparable; paid-only for production-grade. Acceptable backup.   |
| Triton One           | Enterprise-tier; overkill at our volume                          |
| Public Solana RPC    | Heavily rate-limited, no priority fee API. Last-resort fallback. |

### 3.6.2 Fallback handling

For v1, **single-RPC operation with manual failover.** A secondary
RPC URL can be configured via `ORACLE_RPC_URL_FALLBACK`; on
sustained failure of the primary (3 consecutive errors over 60s),
the client switches to the fallback and logs a warning. The
fallback is for outage continuity, not load balancing — we don't
shard traffic.

Multi-RPC concurrent submission isn't worth it at our cadence.
Once-every-30-seconds tolerates a single provider's hiccups via
retries (§3.7).

### 3.6.3 Rate-limit budget

Helius free tier: 100,000 requests/day = ~70 req/min.

Our projected usage:

| operation                    | rate                | req/min |
| ---------------------------- | ------------------- | ------- |
| Cycle poller `getLatestBlockhash` | 1 per 30s         | 2       |
| Cycle poller `sendTransaction`    | ~6 per hour       | 0.1     |
| Confirmation polling per submit   | ~5 calls per submit | ~0.5  |
| TWAP poller submission            | ~26 per hour      | 0.4     |
| Priority fee estimate per submit  | ~32 per hour      | 0.5     |
| Balance check                     | every 5 min       | 0.2     |
| Recovery polls (in-flight rows)   | included in cycle | -       |
| **Total**                         |                     | **~4** |

About 6,000 requests/day at steady state. Comfortably within
Helius's free tier (100k/day), with ~16x headroom for traffic
spikes or scale-up.

## 3.7 Retry and failure handling

### 3.7.1 Retry budget

**5 attempts per commit, exponential backoff with jitter.**

| attempt | wait before | cumulative time |
| ------- | ----------- | --------------- |
| 1       | 0           | 0s              |
| 2       | 30s ± 10s   | ~30s            |
| 3       | 2m ± 30s    | ~2m 30s         |
| 4       | 10m ± 2m    | ~12m 30s        |
| 5       | 30m ± 5m    | ~42m 30s        |

After attempt 5: status transitions to `failed`, `last_error`
populated, `retry_count = 5`. A separate retry job picks these up
on a much longer backoff (§3.7.7).

### 3.7.2 Error class taxonomy

Every error from the submit/confirm flow is classified before
deciding the retry path:

| class                       | example                                          | retry behavior                                          |
| --------------------------- | ------------------------------------------------ | ------------------------------------------------------- |
| `RPC_TRANSIENT`             | 5xx, timeout, connection reset                    | retry per §3.7.1                                       |
| `RPC_RATE_LIMITED`          | 429 / "Too Many Requests"                         | retry with longer initial backoff (60s instead of 30s) |
| `BLOCKHASH_EXPIRED`         | "BlockhashNotFound" from validator                | refresh blockhash, immediate retry (no count increment) |
| `INSUFFICIENT_SOL`          | hot wallet balance can't cover fee                | NO retry — immediate `failed` + critical alert         |
| `INVALID_TRANSACTION`       | malformed tx, signature verification failure      | NO retry — immediate `failed` + page operator         |
| `CONFIRMATION_TIMEOUT`      | tx submitted but not finalized within 90s        | reconcile (see §3.7.4); may transition to `confirmed`   |
| `SIGNATURE_ALREADY_EXISTS`  | duplicate submission detected                     | reconcile (see §3.7.5)                                  |

The committer logs the original error, its classification, and
which retry path was taken. The `last_error` column captures both
the classification and a human-readable summary.

### 3.7.3 Insufficient SOL is fatal, not retryable

A retry that fails for the same lack-of-funds reason just burns
poll cycles. As soon as we hit `INSUFFICIENT_SOL`:

1. Mark the row `failed` with `last_error = 'INSUFFICIENT_SOL: balance=<X> SOL'`
2. Surface in `/health` as `last_failure_class = 'insufficient_sol'`
3. Stop attempting new commits until the operator refills (subsequent
   pollers see the low balance and refuse to submit; documented in §3.5.3)

When balance is refilled, the retry job (§3.7.7) picks up the
failed rows and re-attempts.

### 3.7.4 Confirmation timeout reconciliation

A tx that doesn't finalize within 90s could be:

(a) Dropped by the cluster (never landed)
(b) Confirmed but our polling missed it
(c) Still in flight, slow

We don't blindly resubmit — that risks a double-commit (the same
memo would be anchored twice with different signatures, polluting
the audit trail). Reconciliation:

```
1. Call getSignatureStatuses([signature]) one more time
2. If confirmationStatus is 'confirmed' or 'finalized':
     transition to confirmed, record slot
3. If not found AND the blockhash has expired:
     classify as dropped
     transition status back to 'pending', clear signature
     retry per §3.7.1 (with fresh blockhash)
4. If not found AND the blockhash is still valid:
     wait one more 90s window, retry from step 1
```

This avoids the "we resubmitted but the original landed too" double-commit hazard.

### 3.7.5 Race: Solana confirmed but DB write failed

The pivotal race condition. Sequence the writes so this is
recoverable:

```
1. INSERT commit_cycles row, status='pending', signature=NULL
   (committed to DB before the network call)
2. Build + sign tx
3. UPDATE row: signature='<sig>', status='submitted'
   (DB now knows the signature even before we know if it landed)
4. sendTransaction
5. Poll for confirmation
6. UPDATE row: status='confirmed', solana_slot=<slot>, confirmed_at=now()
```

If step 6 fails (Postgres unreachable, oracle process killed):

- Row is left at status='submitted' with the signature recorded
- On next poll, the recovery query (§3.2.3) picks it up
- Reconciliation calls `getSignatureStatuses([signature])`
  - Confirmed on chain → UPDATE row to 'confirmed', done
  - Not found / expired blockhash → handle per §3.7.4 (the tx
    was probably dropped between submit and DB write)

If step 4 fails:

- Row is at status='submitted' with signature, but the tx never
  hit the cluster
- Reconciliation sees "signature not found, blockhash expired" →
  treats as dropped → re-submits (§3.7.4)
- The new attempt has a different signature; `last_error` records
  the old one before overwriting

Idempotency at the DB layer makes this safe:

- `commit_cycles.cycle_id` is unique (PK + FK to scraper_runs.id),
  so step 1 cannot insert twice for the same cycle
- `twap_commits` has `unique(peptide_code, computed_at)`, same
  property

### 3.7.6 Re-orgs (not a concern at our commitment level)

Per §3.4.5, every commit waits for `finalized` before transitioning
to `confirmed` in the database. By the time we record the slot,
that slot is 31+ blocks deep and has cryptoeconomic finality —
re-orgs at this depth would require a violation of Solana's safety
guarantees, which has never occurred on mainnet. We do not need
re-org detection or recovery logic in v1.

For completeness: if a finalized slot were ever re-orged out (a
network-level catastrophe well beyond v1 scope), the audit trail
of memo + signature + slot in `commit_cycles` is sufficient evidence
for an operator-led recovery. The committer service itself takes
no action on this scenario.

### 3.7.7 Long-tail retry job

A separate periodic job inside the same service runs once per hour
and re-attempts any `status='failed'` rows whose
`retry_count < ORACLE_MAX_TOTAL_RETRIES` (default 20). Backoff:

- First long-tail retry: 1 hour after last failure
- Second: 4 hours
- Third onwards: 24 hours

This handles the "RPC was down for 3 hours" scenario where every
in-flight commit hits the retry cap and gets marked failed. Once
the RPC recovers, the long-tail job finishes them off.

## 3.8 Concurrent operation safety

### 3.8.1 Single-instance enforcement

**Two committer instances must not run concurrently** in v1 — they
would race to claim the same `pending` row, both submit, and either
double-spend SOL or violate the unique constraints (and one of them
would crash with a duplicate-key error).

Enforcement: PostgreSQL **session-level advisory lock** acquired at
startup.

```sql
SELECT pg_try_advisory_lock(0xC0117EE5C0117EE5);   -- "ORACLE OK"
```

If the call returns `false`, another instance is holding the lock.
The new instance logs `[startup] FATAL: another oracle instance is
running; refusing to start` and exits.

The lock is released automatically on session disconnect (process
crash, network partition, or graceful shutdown).

### 3.8.2 Crash recovery on restart

On a clean restart with the advisory lock acquired:

1. Run the recovery poll (§3.2.3) to find `pending`/`submitted` rows
2. For each:
   - `submitted` with signature: reconcile against Solana (§3.7.5)
   - `pending` with no signature: skip (will be re-picked by main poll)
   - `pending` with signature: very rare (race between sign and DB
     write); reconcile via signature lookup
3. Resume normal poll loop

If the previous instance crashed mid-transaction-build, the row is
either in `pending` (no signature, no submitted_at) or doesn't
exist — no on-chain artifact to reconcile.

### 3.8.3 Single-cycle locking

Inside a single instance, the cycle poller and TWAP poller run
concurrently as separate async loops. They can't conflict on rows
because they write to different tables. They share the RPC client
(blockhash cache, priority fee adapter) but those are read-mostly
and lock-free.

If both pollers want to submit at the same instant, they queue
through the RPC client's internal serialization — Solana
sequencing is per-account (the hot wallet), and submitting two txs
in the same slot from the same fee-payer is fine.

## 3.9 Observability

### 3.9.1 Logs

Every commit attempt logs a structured record:

- `cycle_commit_started cycle_id=<n> observation_count=<n>`
- `cycle_commit_root_computed cycle_id=<n> root=<0x...>`
- `cycle_commit_submitted cycle_id=<n> signature=<sig> retry=<n>`
- `cycle_commit_confirmed cycle_id=<n> signature=<sig> slot=<n> elapsed_ms=<n>`
- `cycle_commit_failed cycle_id=<n> class=<class> error=<msg> retry=<n>/5`

Same shape for `twap_commit_*` events. Plus:

- `balance_check public_key=<pk> balance_sol=<x>`
- `rpc_error op=<op> error=<msg> latency_ms=<n>`
- `recovery_reconcile cycle_id=<n> outcome=<confirmed|dropped|stuck>`

JSON-structured logs make grepping in Railway's log view tolerable;
the project has been using plain key=value pairs elsewhere so we
match that.

### 3.9.2 /health endpoint contents

Exposed at `GET /health` on `HEALTH_PORT` (default 8080). v1 has
no separate Prometheus endpoint — adding one is a §8 follow-up.

**Required fields (normative).** Every field below MUST be present
on every response. Adding extra fields is fine; removing or
renaming any of these is a breaking change to the operational
contract that monitoring will rely on.

| field                              | type           | meaning                                                      |
| ---------------------------------- | -------------- | ------------------------------------------------------------ |
| `service`                          | string         | Always `"oracle"`. Lets a generic monitor distinguish services. |
| `ok`                               | boolean        | Aggregate health flag. Drives the HTTP status code.          |
| `uptime_seconds`                   | integer        | Process uptime; useful to spot crash loops.                  |
| `wallet.public_key`                | string         | Hot wallet public key (base58). Verifiable against Solana.   |
| `wallet.balance_sol`               | string         | Decimal string. Current SOL balance — **required**.          |
| `wallet.balance_low`               | boolean        | True when balance < `ORACLE_BALANCE_WARN_SOL`.               |
| `wallet.balance_critical`          | boolean        | True when balance < `ORACLE_BALANCE_CRITICAL_SOL`.           |
| `cycle.last_commit_at`             | ISO 8601 \| null | Timestamp of last successful cycle commit — **required**.  |
| `cycle.last_committed_cycle_id`    | integer \| null | The `cycle_id` of that commit; null until first success.    |
| `cycle.in_flight_count`            | integer        | Pending + submitted cycle commits — **required**.            |
| `cycle.failed_count_24h`           | integer        | Failed cycle commits in last 24h — **required**.             |
| `twap.last_commit_at`              | ISO 8601 \| null | Timestamp of last successful TWAP commit — **required**.   |
| `twap.last_hour_committed_count`   | integer        | TWAP commits that succeeded in the most recent hourly batch. |
| `twap.last_hour_skipped_count`     | integer        | TWAP commits that were skipped (NULL TWAP, etc.) in that batch. |
| `twap.in_flight_count`             | integer        | Pending + submitted TWAP commits — **required**.             |
| `twap.failed_count_24h`            | integer        | Failed TWAP commits in last 24h — **required**.              |
| `rpc.primary`                      | string         | Identifier of the primary RPC ("helius" / "quicknode" / etc.). |
| `rpc.last_error_at`                | ISO 8601 \| null | Most recent RPC error timestamp; null if none.             |
| `rpc.last_error_class`             | string \| null  | Error class from §3.7.2; null if none.                      |
| `rpc.blockhash_age_seconds`        | integer        | Age of the cached blockhash; debugging aid.                  |

**Example response (healthy):**

```json
{
  "service": "oracle",
  "ok": true,
  "uptime_seconds": 3600,
  "wallet": {
    "public_key": "...",
    "balance_sol": "0.4127",
    "balance_low": false,
    "balance_critical": false
  },
  "cycle": {
    "last_commit_at": "2026-05-01T12:34:56.789Z",
    "last_committed_cycle_id": 1042,
    "in_flight_count": 0,
    "failed_count_24h": 0
  },
  "twap": {
    "last_commit_at": "2026-05-01T12:00:30.123Z",
    "last_hour_committed_count": 26,
    "last_hour_skipped_count": 0,
    "in_flight_count": 0,
    "failed_count_24h": 0
  },
  "rpc": {
    "primary": "helius",
    "last_error_at": null,
    "last_error_class": null,
    "blockhash_age_seconds": 8
  }
}
```

**Health rule.** `ok` is `true` AND HTTP status is `200` iff **all
of the following** hold:

- `wallet.balance_critical` is `false`
- `cycle.last_commit_at` is within the last 30 minutes (configurable
  via `ORACLE_HEALTH_STALE_THRESHOLD_MS`)
- `twap.last_commit_at` is within the last 90 minutes
  (TWAP cadence is hourly + skew + buffer; allows one missed slot
  before degrading)
- `cycle.failed_count_24h` < 5
- `twap.failed_count_24h` < 5

Otherwise `ok` is `false` and HTTP status is `503` — Railway's
healthcheck flips the service's status pill, and external monitors
(§3.9.3) page based on the same signal.

The first-boot edge case where `cycle.last_commit_at` and
`twap.last_commit_at` are `null`: the staleness check skips them
during a configurable warm-up window (default 60 minutes after
`uptime_seconds=0`) so a fresh deploy isn't immediately reported
unhealthy.

### 3.9.3 Alerts

Configured externally (Better Uptime, Railway's healthcheck,
whatever — out of scope here). The signals to alert on:

| condition                                          | severity  |
| -------------------------------------------------- | --------- |
| `/health` returns 503                              | critical  |
| `balance_critical: true`                           | critical  |
| `cycle.last_commit_at` > 30 minutes ago            | warning   |
| `cycle.in_flight_count` > 5 (backlog growing)      | warning   |
| `failed_count_24h` > 3                             | warning   |
| `balance_low: true` (and not critical)             | info      |
| `rpc.last_error_class = 'INSUFFICIENT_SOL'`        | critical  |

## 3.10 Decisions to flag for review

Decisions in this section that have been **explicitly confirmed**
during review:

- **RPC provider: Helius (free tier).** Confirmed.
- **Polling cadences: 30s for cycles, 60s aligned for TWAPs.**
  Confirmed.
- **Confirmation level: `finalized`.** Confirmed (§3.4.5 was flipped
  from `confirmed` during review). Eliminates re-org risk entirely
  at the cost of ~8–10s additional latency, which is negligible
  relative to the 30-second polling cadence.
- **Priority fee strategy: dynamic via Helius's API, capped at
  50,000 micro-lamports/CU.** Confirmed.
- **Keypair storage: Railway env var.** Confirmed for v1, subject
  to the three operational requirements added to §3.5.1 during
  review (restricted Railway access, secret-flagged variable,
  ~30-day SOL buffer with manual refills only).
- **/health endpoint contents.** Confirmed; required-field table
  in §3.9.2 is normative.

No decisions remain open at the section-3 level. Open questions
that touch this section but are resolved elsewhere live in §9.

## 3.11 Out of scope for this section

- Verification API endpoints (§5/§6)
- Final cost numbers (§7 — references §3.4.4 and §3.6.3)
- Operator runbook detail (§8 — references §3.5.4 rotation procedure)
- Frontend explorer (separate phase)
