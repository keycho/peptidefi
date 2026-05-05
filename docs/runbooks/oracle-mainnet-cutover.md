# Oracle devnet → mainnet cutover runbook

Operational walkthrough for promoting the BioHash oracle service from
Solana devnet to mainnet. Companion to **§6 of `docs/operator-setup.md`**
(the higher-level cutover plan); this file is the moment-by-moment
checklist with concrete commands.

| field                | value                                                                            |
| -------------------- | -------------------------------------------------------------------------------- |
| Devnet authority     | `87cxPnkFjyQtimUD62Azvh2vdMT1Da18Li4Yi1SYqYRU`                                   |
| Mainnet authority    | `FmBggsBjzGsHrtMayYG8ix2JzoYhVczrwJaGGKPpNKK7`                                   |
| Mainnet RPC          | `https://mainnet.helius-rpc.com/?api-key=<KEY>`                                  |
| Migration            | `packages/db/migrations/0033_add_cluster.sql`                                    |
| Code feature branch  | `claude/oracle-mainnet-migration` (this commit)                                  |
| Peg coupling         | None — peg stays on devnet, oracle never pushed `update_peg_state`. /reserve mint/burn already returns `TwapStale`. |

**Out of scope:** peg program migration, frontend wallet integration on
`/reserve`. Those don't move with this cutover.

---

## 1. Pre-flight — run all green before scheduling cutover window

Each item is a yes/no gate. Paste output back to confirm before you
schedule the cutover window.

### 1.1 Mainnet authority balance ≥ 5 SOL

```bash
solana balance FmBggsBjzGsHrtMayYG8ix2JzoYhVczrwJaGGKPpNKK7 \
  --url https://api.mainnet-beta.solana.com
```

Currently 0.25 SOL → **top up to 5 SOL minimum, 10 SOL recommended.**
At median priority fees and the current 600 s scraper cadence
(168 tx/day total: 144 cycle commits + 24 TWAP), 5 SOL gives
~3.8 yr median runway / 40 days even under continuous spike pricing.

### 1.2 Helius mainnet RPC reachable

```bash
HELIUS_URL="https://mainnet.helius-rpc.com/?api-key=<KEY>"

curl -s -X POST -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' "$HELIUS_URL"
# expect: {"jsonrpc":"2.0","result":"ok","id":1}

curl -s -X POST -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"getSlot"}' "$HELIUS_URL" | jq .result
# expect: a recent mainnet slot, comparable to api.mainnet-beta.solana.com getSlot

curl -s -X POST -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"getBalance","params":["FmBggsBjzGsHrtMayYG8ix2JzoYhVczrwJaGGKPpNKK7"]}' \
  "$HELIUS_URL" | jq .result.value
# expect: balance in lamports, equal to step 1.1 (× 1e9)
```

### 1.3 Code merged to `main` — oracle still on devnet

```bash
# After this PR merges to main, Railway redeploys oracle + api.
# Oracle env vars unchanged → still on devnet → new commit_cycles
# rows tagged cluster='devnet'.
psql "$ORACLE_DATABASE_URL" -c "
  select cycle_id, cluster, status, completed_at
  from public.commit_cycles
  order by completed_at desc
  limit 3;
"
# expect: top row has cluster='devnet', status='finalized'
```

If the top row's `cluster` is `null` or the column doesn't exist, the
DB migration didn't run. See §1.4.

### 1.4 DB migration applied

`0033_add_cluster.sql` is **additive + reversible**:

- Adds `cluster` column to `commit_cycles` and `twap_commits`, defaults
  to `'devnet'`, `NOT NULL`.
- Backfills existing rows to `'devnet'` (correct — they ARE devnet).
- Updates `register_commit_cycle()` to accept an 8th `p_cluster`
  parameter (default `'devnet'`).
- Adds two indexes for the new cluster-filtered list queries.

Apply via Supabase SQL editor or psql:

```bash
psql "$DATABASE_URL" -f packages/db/migrations/0033_add_cluster.sql
```

Verify:

```bash
psql "$DATABASE_URL" -c "\d commit_cycles" | grep cluster
psql "$DATABASE_URL" -c "\d twap_commits"  | grep cluster
psql "$DATABASE_URL" -c "
  select cluster, count(*)
  from public.commit_cycles
  group by cluster;
"
# expect: one row, cluster='devnet', count=268+ (matches the cycle history)
```

If anything looks off, **run the down block** at the bottom of the
migration file (commented out) before retrying.

### 1.5 API serves cluster-filtered data

```bash
# Existing requests (no ?cluster=) still return rows — backward-compatible.
curl -s "$API_BASE/v1/cycles?limit=2" | jq '.cycles[].cluster'
# expect: "devnet" "devnet"

# Explicit devnet filter.
curl -s "$API_BASE/v1/cycles?limit=2&cluster=devnet" | jq '.cycles[].cluster'
# expect: "devnet" "devnet"

# Explicit mainnet filter — empty until cutover lands first commit.
curl -s "$API_BASE/v1/cycles?limit=2&cluster=mainnet" | jq '.cycles | length'
# expect: 0 (pre-cutover)
```

The API accepts both `mainnet` and `mainnet-beta`; both normalise to
`mainnet-beta` for the DB query.

### 1.6 Rollback dry run on devnet

Before the real cutover, **rehearse the env-var revert**: pick a
non-prod time, change `ORACLE_RPC_URL` on the Railway oracle service
to a deliberately wrong endpoint (e.g. `https://api.devnet.solana.com/`
with a trailing dot), confirm Railway's restart policy bounces the
service, the deploy fails, then revert the env var. This confirms you
know Railway's revert UX before doing it under cutover pressure.

### 1.7 Operator access

| access            | confirmed?                                                        |
| ----------------- | ----------------------------------------------------------------- |
| Railway dashboard | able to edit `oracle` service env vars + redeploy                 |
| Mainnet keypair   | base58 string ready (NOT a file path — Railway env vars are strings) |
| Helius API key    | copied, not in git, scoped to the right Helius account             |
| DB                | `psql` or Supabase SQL editor access                              |
| Solana CLI        | installed locally + Solscan tab open for spot-checking commits   |

---

## 2. Cutover sequence — T+0 is the moment env vars apply

Set a 30-minute active operator window. Open three terminals:

- **T-A**: Railway dashboard tab on oracle service, env-vars panel.
- **T-B**: `psql` connected to production DB.
- **T-C**: shell with `solana`, `curl`, `jq` available; logged into Helius.

### Phase A — preparation (T-1 day → T-0)

| step | T    | action                                                              | rollback                              |
| ---- | ---- | ------------------------------------------------------------------- | ------------------------------------- |
| A.1  | T-1d | All §1 pre-flights green                                            | abort cutover                         |
| A.2  | T-1d | Top up mainnet authority to ≥ 5 SOL                                  | n/a                                    |
| A.3  | T-1d | Apply migration 0033                                                | run down-block at end of 0033 file    |
| A.4  | T-1h | Merge `claude/oracle-mainnet-migration` to `main`. Railway redeploys oracle + api. Verify next commit lands tagged `cluster='devnet'` (still on devnet).            | revert merge commit                   |
| A.5  | T-15m | Drain pending devnet cycles. **Wait** until this returns 0:<br/>```sql<br/>select count(*) from scraper_runs s<br/>where s.status='completed'<br/>  and not exists (select 1 from commit_cycles c where c.cycle_id = s.id);<br/>```<br/>Otherwise the post-cutover oracle would anchor leftover devnet cycles to mainnet. | wait longer / mark stale ones `failed` |

### Phase B — cutover (T+0 → T+30m, hands on keyboard)

| T    | action                                                              | rollback                              |
| ---- | ------------------------------------------------------------------- | ------------------------------------- |
| T+0  | **Terminal T-A**: Railway → oracle service → "Stop deployment". Confirm oracle process exits.                                              | "Resume deployment" — oracle continues on devnet |
| T+1  | **Terminal T-A**: Edit oracle env vars. Stage the changes (don't apply yet) by **screenshotting current values first** for rollback:<br/>• `ORACLE_RPC_URL` → `https://mainnet.helius-rpc.com/?api-key=<KEY>`<br/>• `ORACLE_SOLANA_PRIVATE_KEY` → mainnet keypair (base58 string)<br/>• `SOLANA_CLUSTER` → `mainnet-beta` *(new var; oracle would derive same value from Helius URL but explicit is safer)*<br/>• `PEPTIDE_ORACLE_AUTHORITY_PUBKEY` → `FmBggsBjzGsHrtMayYG8ix2JzoYhVczrwJaGGKPpNKK7` *(must equal pubkey derived from new keypair)*<br/>• `ORACLE_BALANCE_WARN_SOL` → `1.0`<br/>• `ORACLE_BALANCE_CRITICAL_SOL` → `0.5`<br/>• `ORACLE_MIN_STARTUP_BALANCE_SOL` → `0.25`<br/>• Leave `ORACLE_CYCLE_POLL_INTERVAL_MS` and other timing vars unchanged. | revert from screenshot                |
| T+5  | **Terminal T-A**: Apply env changes. Railway auto-deploys.<br/>Watch logs (T-C):<br/>```bash<br/>railway logs --service oracle --follow<br/>```<br/>Expect:<br/>• `[startup] cluster: mainnet-beta`<br/>• `[startup] authority: FmBgg…NKK7`<br/>• `[startup] rpc: helius`<br/>If startup fails (config validation, balance check, etc.), pubkey mismatch, etc. → see §3 rollback. | revert env vars per T+1 screenshot   |
| T+8  | First poll wakes. Watch for the cycle-poller picking up any unanchored cycle. **If there are still pending devnet cycles** (A.5 didn't fully drain), the poller will try to anchor them on mainnet — abort: `update commit_cycles set status='failed' where status='pending' and cluster='devnet'`. | per above                              |
| T+10 | First mainnet cycle commit attempt. Look for `submitted: <signature>` in oracle logs. | if attempt fails repeatedly: revert env vars |
| T+12 | Tx finalises. Verify on-chain (T-C):<br/>```bash<br/>solana confirm <sig> --url mainnet-beta --output json | jq '{status: .confirmationStatus, signer: .transaction.message.accountKeys[0]}'<br/>```<br/>Expect: `confirmationStatus: "finalized"`, `signer: "FmBgg…NKK7"`. | n/a (read-only verification)         |
| T+12 | Verify DB (T-B):<br/>```sql<br/>select cycle_id, cluster, status, solana_signature<br/>from commit_cycles<br/>where cluster='mainnet-beta'<br/>order by completed_at desc<br/>limit 1;<br/>```<br/>Expect: 1 row. | n/a                                   |
| T+13 | Open Solscan: `https://solscan.io/tx/<sig>` (no `?cluster=` → mainnet by default). Verify memo bytes parse cleanly: `{cycle_id, merkle_root, project: "biohash", v: 2, ...}`. | n/a                                    |
| T+15 | Verify API (T-C):<br/>```bash<br/>curl -s "$API_BASE/v1/cycles?cluster=mainnet&limit=1" | jq '.cycles[] | {cycle_id, cluster, status, "solscan": .solana.solscan_url}'<br/>```<br/>Expect: 1 row, `cluster: "mainnet-beta"`, solscan URL with no `?cluster=` suffix. | n/a                                    |
| T+30 | After 2-3 successful cycle commits + ideally 1 TWAP commit on mainnet, declare cutover stable. | n/a                                    |

### Phase C — verification (T+30m → T+6h, less hands-on)

| T+   | action                                                              |
| ---- | ------------------------------------------------------------------- |
| 30m  | Spot-check first 3 cycle commits on Solscan: status=`finalized`, signer matches authority, memo bytes match `commit_cycles.memo_payload` byte-for-byte. |
| 1h   | First TWAP commit lands. Verify same.                                |
| 2h   | Authority balance check — expected drop ≤ 0.001 SOL.                 |
| 6h   | Tail logs for retries / RPC errors / advisory-lock issues. Oracle health endpoint check: `curl $ORACLE_HEALTH/health \| jq .cluster` returns `"mainnet-beta"`. Compare `mint_count` / `update_count` patterns vs. devnet baseline. |

---

## 3. Rollback procedures

### 3.1 Cutover-time failure (mainnet first commit fails within 15 min)

Symptom: oracle logs show repeated send / finalize failures.

```
Terminal T-A:
  1. Railway → oracle service → "Stop deployment".
  2. Restore env-var snapshot from T+1 (screenshot or notes):
       ORACLE_RPC_URL = <previous devnet URL>
       ORACLE_SOLANA_PRIVATE_KEY = <previous devnet keypair>
       SOLANA_CLUSTER = devnet  (or remove env var entirely)
       PEPTIDE_ORACLE_AUTHORITY_PUBKEY = 87cxPnkFjyQtimUD62Azvh2vdMT1Da18Li4Yi1SYqYRU
       ORACLE_BALANCE_WARN_SOL = 0.30
       ORACLE_BALANCE_CRITICAL_SOL = 0.15
       ORACLE_MIN_STARTUP_BALANCE_SOL = 0.05
  3. Apply, Railway redeploys.
  4. Verify oracle resumes devnet commits within 5 minutes:
       psql "$DATABASE_URL" -c "select cycle_id, cluster, status, completed_at \
         from commit_cycles where cluster='devnet' \
         order by completed_at desc limit 1;"
     completed_at should be within 5 min of now().
  5. DB migration stays — additive + harmless.
  6. Code on main stays — SOLANA_CLUSTER=devnet keeps cluster tagging
     correct. No revert needed.
  7. Investigate root cause from saved Railway logs offline before
     retrying cutover.
```

### 3.2 Slow-burn failure (mainnet works for hours, then degrades)

```
Decision tree (in priority order):

- Symptom: Helius rate-limited (HTTP 429 in logs)?
  → Fall back to public RPC:
    ORACLE_RPC_URL = https://api.mainnet-beta.solana.com
  May rate-limit faster but unblocks the immediate stall. Investigate
  Helius credit usage on the Helius dashboard.

- Symptom: send/finalize success rate < 80% over 1 hour?
  → Mainnet congestion. Bump priority fee:
    Currently controlled by hard-coded value or env var (check
    apps/oracle/src/solana/memo-tx.ts). Increase by 5x.

- Symptom: balance < 1 SOL warning?
  → Top up authority. ORACLE_BALANCE_CRITICAL_SOL=0.5 will block
  signing before drainage; you have time.

- Anything else, or symptoms mount across categories?
  → §3.1 full revert to devnet. Root-cause offline.
```

### 3.3 DB migration rollback (only if migration itself broke something)

Run the commented-out down-block at the end of
`packages/db/migrations/0033_add_cluster.sql`. It:

- Drops `register_commit_cycle/8` (with cluster) and recreates `/7` (without).
- Drops the cluster indexes.
- Drops the `cluster` columns.

Code on `main` won't break: the oracle's `registerCommitCycle()` will
fail at the new function signature, but the previous oracle deploy
would have been on the 0032 signature. **Order matters**: revert oracle
code on `main` *before* running the down-block. Otherwise the running
oracle hits a function-not-found error mid-cycle.

---

## 4. Monitoring

### Active (first 6 hours after cutover)

```bash
# Tail oracle logs (Railway CLI; or use the Railway dashboard live view).
railway logs --service oracle --follow

# Authority balance every 15 min — warning if drops > 0.05 SOL/15min
# (would imply ~5 SOL/day burn — check priority fees).
watch -n 900 'solana balance FmBggsBjzGsHrtMayYG8ix2JzoYhVczrwJaGGKPpNKK7 \
  --url https://api.mainnet-beta.solana.com'

# DB sanity every 15 min.
psql "$DATABASE_URL" -c "
  select cluster, count(*), max(completed_at) as latest
  from commit_cycles
  where created_at > now() - interval '6 hours'
  group by cluster
  order by latest desc;
"
# expected progression: mainnet-beta row count grows by 1 per ~10 min
```

### Ongoing (post-stabilisation)

| signal              | threshold                                              | check                                                                                        |
| ------------------- | ------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| Authority balance   | warn < 1 SOL, alert < 0.5 SOL                          | `ORACLE_BALANCE_WARN_SOL` already wired; `/health` surfaces `wallet.balance_low/_critical` |
| Missed cycles       | warn if newest mainnet row > 20 min old                | `/v1/cycles?cluster=mainnet&limit=1` → check `completed_at` vs now                            |
| RPC error rate      | warn > 5% over 10-min window                            | tail logs for `rpc-error:`                                                                     |
| Helius credit usage | warn at 80% of daily quota                              | Helius dashboard                                                                              |
| Cluster drift       | should never see new rows tagged 'devnet' post-cutover  | `select count(*) from commit_cycles where cluster='devnet' and created_at > '<cutover_ts>'`  |

### Solscan spot-check (manual, first day)

Click through to Solscan for the first 5 cycles and the first 2 TWAP
commits. Confirm each:

- `Status: Finalized`
- Signer (first account key): `FmBgg…NKK7`
- Memo decodes to valid v=2 JSON
- Slot is recent (not far in the past)
