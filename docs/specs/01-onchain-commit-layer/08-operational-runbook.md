# 08 — Operational runbook

Status: **draft**. The runbook for the operator running the
on-chain commit layer in production. Written to be useful at 3am
during an incident, not during a leisurely architecture review —
sections are short, action-oriented, and cross-reference the
detailed-design specs only when necessary.

This section depends on every other section of the spec for the
underlying mechanics; here we just spell out what the operator
does, when, and in what order.

Ownership for v1: a single operator (the project's founder /
sole maintainer). Procedures below assume one person on call —
everything that requires human judgment is queued for that person
rather than auto-executed.

## 8.1 Daily operations

### 8.1.1 Routine health check

Once per working day (or whenever you start a session), check the
oracle's `/health` endpoint:

```
curl https://oracle.<domain>/health | jq
```

The endpoint shape is normative — see §03.9.2 for the full table of
required fields. The condensed at-a-glance interpretation:

| state           | indicator                                                 | action                                                       |
| --------------- | --------------------------------------------------------- | ------------------------------------------------------------ |
| **Green**       | HTTP 200, `ok=true`, `wallet.balance_low=false`           | none — read the metrics, move on                             |
| **Yellow**      | HTTP 200, `ok=true`, `wallet.balance_low=true` OR `cycle.failed_count_24h > 0` | review failed commits (§8.2.2) or schedule SOL refill (§8.1.2) |
| **Red**         | HTTP 503 OR `ok=false`                                    | immediately follow §8.5 incident response                    |

Field-by-field summary of what you're looking at:

- `wallet.balance_sol` — SOL on the hot wallet. **Should be > 0.1**
  for green, action threshold 0.05 SOL.
- `cycle.last_commit_at` — timestamp of last successful cycle
  commit. **Should be within the last 30 minutes.** If older,
  something's wrong.
- `twap.last_commit_at` — last TWAP commit. **Should be within the
  last 90 minutes** (the TWAP cadence is hourly + skew).
- `cycle.in_flight_count` and `twap.in_flight_count` — pending +
  submitted commits. **Steady state should be 0 or 1.** Persistent
  values >5 indicate backlog (§8.5.5).
- `cycle.failed_count_24h` and `twap.failed_count_24h` — failed
  commits in last 24h. **Should be 0** in normal operation. Any
  non-zero value warrants §8.2.2 review.
- `rpc.last_error_at` and `rpc.last_error_class` — most recent RPC
  error. Set automatically by the committer; cleared after sustained
  success.

### 8.1.2 SOL balance check

Manual check via the explorer (Solscan, Solana FM, or solana CLI):

```
solana balance <ORACLE_AUTHORITY_PUBKEY>
```

(The pubkey is in `/health` as `wallet.public_key` and on GitHub as
`docs/oracle-authority.md`.)

**Refill triggers** (in priority order):

| balance      | action                                                  | urgency  |
| ------------ | ------------------------------------------------------- | -------- |
| > 0.3 SOL    | none — well above 30-day buffer per §03.5.1             | normal   |
| 0.1–0.3 SOL  | schedule refill within 7 days                            | warning  |
| < 0.1 SOL    | refill immediately; commits will start failing within ~3 days at high priority fees | urgent   |
| < 0.02 SOL   | red incident — see §8.5.3                               | critical |

Refill procedure: send 0.5 SOL from operator's funding wallet to
the oracle authority pubkey. Confirm balance updated via
`/health` after the next 5-minute balance-check tick.

## 8.2 Weekly operations

### 8.2.1 RPC usage review

Per §07.7 decision 4. Once per week, log into the Helius dashboard
and check:

- **Daily request count over the last 7 days.** Sustained
  > 50,000/day → start planning the paid-tier upgrade per §07.3.5.
- **Hourly distribution.** Bursty traffic that hits rate limits even
  below the daily cap is its own trigger.
- **Error rate.** Unusual spikes in 4xx / 5xx from Helius indicate
  network or auth issues worth investigating.

If usage is < 20,000/day, no action. If 20,000–50,000/day, monitor
weekly. Above 50,000/day, file a ticket to schedule the upgrade.

### 8.2.2 Failed commits review

```sql
SELECT cycle_id, status, retry_count, last_error, created_at
FROM   public.commit_cycles
WHERE  status = 'failed'
  AND  created_at > now() - interval '7 days'
ORDER BY created_at DESC;
```

Same query for `twap_commits` (replace cycle_id with id).

**Triage:**

- **`INSUFFICIENT_SOL`**: refill (§8.1.2), then the long-tail retry
  (§03.7.7) picks them up automatically.
- **`RPC_TRANSIENT` / `RPC_RATE_LIMITED`**: usually self-recovering.
  If the same cycle has hit retry cap with these errors, manually
  reset `status` to `pending` and `retry_count` to 0; long-tail
  retry will re-attempt.
- **`INVALID_TRANSACTION`**: bug. Investigate against the spec's
  memo format (§02.2). Don't auto-retry — the same input will fail
  again.
- **`BLOCKHASH_EXPIRED` past retry cap**: the network was congested
  for longer than our retry window. Reset to `pending`, retry will
  succeed once it picks fresh blockhash.

For each failed commit you triage, add a brief note to an
operations log (a markdown file in the GitHub repo) noting cycle_id,
diagnosis, and resolution.

### 8.2.3 Storage growth check

Supabase dashboard → Database → Reports. Check storage size growth
week-over-week:

- **Steady-state v1 (5 peptides)**: ~3 MB/week growth, dominated
  by `commit_observations`. Anything significantly higher
  (e.g. 20+ MB/week) suggests row bloat or unintended data.
- **Pro tier headroom**: 8 GB total. At v1 rate we use ~150 MB/year.
  Even at 50 peptides we use ~5 GB/year.

Flag for §8.3.4 monthly review if growth deviates from projection.

### 8.2.4 Backlog review

```sql
SELECT cycle_id, status, retry_count, created_at,
       (now() - created_at) as age
FROM   public.commit_cycles
WHERE  status IN ('pending', 'submitted')
ORDER BY created_at;
```

**Healthy state**: 0–1 rows, age < 5 minutes.
**Warning state**: 2–5 rows, age < 30 minutes.
**Stuck**: any row > 1 hour old in `pending`/`submitted` →
investigate per §8.5.5.

## 8.3 Monthly operations

### 8.3.1 Cost review

Compute the previous month's actual costs against the §07
projection:

| line item              | how to measure                                                             |
| ---------------------- | -------------------------------------------------------------------------- |
| Solana fees            | Solscan / Solana FM transaction history for the authority pubkey            |
| Helius RPC             | Helius dashboard → Usage → previous month                                   |
| Railway                | Railway dashboard → Usage                                                   |
| Supabase               | Supabase dashboard → Usage                                                  |

Compare against §07.5 projections. If actual cost exceeds projection
by > 50% in any line item, document the cause in the ops log.

### 8.3.2 Helius tier evaluation

Even if RPC usage is well under 50k/day, periodically check whether
the use case has shifted:

- Are we relying on `getPriorityFeeEstimate` (Helius-specific)? Yes
  per §03.4.4.
- Are we still on free tier? Document the date we'd hit the 50%
  threshold at current growth rate.
- Have we needed WebSocket subscriptions yet? If considering, that
  alone is the upgrade trigger.

### 8.3.3 Quarterly SOL refill (when due)

If 90 days have elapsed since last refill, execute §8.1.2 refill
procedure to bring balance back to ~0.5 SOL. Log the date in the
ops log.

If you've refilled mid-quarter due to balance alerts, reset the
quarter from the most recent refill date.

### 8.3.4 Audit log review

Once per month, scan recent commit history for anomalies:

```sql
SELECT date_trunc('day', created_at) as day,
       count(*) as commits,
       count(*) filter (where status = 'finalized') as finalized,
       count(*) filter (where status = 'failed')   as failed,
       avg(retry_count)                              as avg_retries
FROM   public.commit_cycles
WHERE  created_at > now() - interval '30 days'
GROUP BY 1
ORDER BY 1;
```

Look for:

- **Days with abnormally low commit counts** (< 140 cycle commits;
  steady-state is 144). Suggests scraper outages or committer
  downtime.
- **Days with high `avg_retries`** (> 0.2). Indicates RPC stress;
  may justify the Helius upgrade earlier than the daily-quota
  trigger.
- **Sustained `failed` rates** (> 0.5% of attempts). Should be
  rare in healthy operation.

Cross-reference any anomalies against the ops log and any incident
write-ups.

## 8.4 Quarterly operations

### 8.4.1 SOL pre-purchase

Per §07.7 decision 3. Every 90 days, top up the operator's funding
wallet from a fiat exchange so refills (§8.3.3) don't require
last-minute exchange interactions. Buy 0.5–1.0 SOL in one
transaction; document the rate.

### 8.4.2 Authority pubkey publication channel review

Per §05.2.4, the authority pubkey is published in three channels.
Once per quarter, verify each is still accurate and consistent:

- **`GET /api/oracle/info`**: hit the endpoint, confirm
  `oracle_authority_pubkey` matches the live keypair.
- **GitHub repo `docs/oracle-authority.md`**: read the file, confirm
  the pubkey value and last-updated date are correct.
- **Project social channels and documentation site**: open the most
  recent publication referencing the pubkey, confirm it matches.

If any channel diverges, that's an incident — fix immediately and
write up the discrepancy. A divergence between channels is exactly
what verifiers would notice and refuse to verify against.

### 8.4.3 Operational requirements verification

Per §03.5.1, confirm the three requirements still hold:

1. **Restricted Railway access list.** Open Railway → Project
   Settings → Members. Confirm the list matches the documented
   trusted operators. Remove anyone who's left the project.
2. **Env var still flagged as secret.** Open Railway →
   Variables → `ORACLE_SOLANA_PRIVATE_KEY`. Confirm the lock icon
   is present and the value is masked.
3. **SOL balance within ~30-day buffer.** Cross-reference against
   §07.2.2 — at current spend rate, the buffer should be 0.1–0.5 SOL.
   Adjust thresholds if peptide count has grown.

## 8.5 Incident response runbooks

Each subsection follows the same structure: Detection → Triage →
Recovery → Post-incident.

### 8.5.1 Committer service down

**Detection.**

- `/health` returns HTTP 503 or doesn't respond at all
- External monitor fires alert (§8.9)
- Both `cycle.last_commit_at` and `twap.last_commit_at` are
  staler than thresholds

**Triage.**

1. Open Railway dashboard → oracle service → Deployments. Is the
   service running? When was it last restarted?
2. Open Railway logs. Look for the most recent error patterns:
   - `[fatal]` lines indicate process crash
   - `[startup] FATAL: another oracle instance is running` indicates
     advisory-lock contention from a botched redeploy (§3.8)
   - Repeated RPC errors point to §8.5.2
3. Check if there's a deployment in progress that failed.

**Recovery.**

- Service crashed: restart via Railway dashboard. Pending cycles
  are picked up by the recovery poll (§3.2.3) on next startup; the
  long-tail retry job (§3.7.7) handles backlog.
- Stuck deployment: roll back to last known-good deployment.
- Advisory-lock contention: kill any phantom container in the
  Railway dashboard, redeploy.

Verify recovery: `/health` returns 200 with `cycle.last_commit_at`
within 15 minutes of recovery.

**Post-incident.** §8.11 communication, §8.11 write-up if downtime
> 5 minutes.

### 8.5.2 Solana RPC outage

**Detection.**

- `rpc.last_error_at` keeps advancing in `/health` snapshots
- Logs show `RPC_TRANSIENT` or `RPC_RATE_LIMITED` repeating
- Helius status page (status.helius.dev) confirms an incident

**Triage.**

1. Check Helius status page. If they've declared an incident, the
   ETA they publish is your ETA.
2. Check `ORACLE_RPC_URL_FALLBACK` env var (§3.6.2). Is one
   configured? If yes, manually fail over by toggling the fallback
   priority.
3. Confirm Solana mainnet itself is healthy (status.solana.com,
   compass.pickaxe.xyz). RPC outages and chain outages need
   different responses.

**Recovery.**

- Helius outage with our fallback configured: automatic.
- Helius outage without fallback: wait. The committer's retry
  schedule (§3.7.1) gives commits up to ~42 minutes of retry
  budget; long-tail retry (§3.7.7) handles longer outages.
- Solana mainnet outage (rare but real, e.g. April 2024 incident):
  no commits possible until the chain restarts. Commits queue as
  `failed` after retry exhaustion; long-tail retry picks them up
  on chain recovery.

**Post-incident.** Write-up if outage > 30 min. Cross-reference the
upstream provider's incident report.

### 8.5.3 SOL balance exhausted

**Detection.**

- `wallet.balance_critical=true` in `/health`
- `cycle.failed_count_24h` climbing
- Logs show `INSUFFICIENT_SOL` failure class repeated
- External alert fired on balance threshold

**Triage.**

1. Confirm via Solana explorer:
   `solana balance <pubkey>` or visit `https://solscan.io/account/<pubkey>`
2. Identify whether this is unexpected drain (low priority fees but
   balance dropped fast) vs expected depletion (we forgot to refill).

**Recovery.**

1. Send 0.5 SOL from operator's funding wallet to the authority
   pubkey.
2. Wait for the next 5-minute balance check tick (`/health`
   refresh) to confirm the new balance.
3. Long-tail retry job picks up the failed commits in the next
   hourly tick. Confirm via spot-checking `commit_cycles` for any
   remaining `status='failed'` rows and triggering a manual reset
   if needed:

```sql
UPDATE public.commit_cycles
SET    status = 'pending', retry_count = 0, last_error = NULL
WHERE  status = 'failed'
  AND  last_error LIKE '%INSUFFICIENT_SOL%';
```

**Post-incident.** If unexpected drain, investigate priority-fee
spikes via Helius dashboard. If forgotten refill, document the
miss and consider tightening §3.5.3 alert thresholds.

### 8.5.4 DB write failure after Solana confirmation

The race in §3.7.5. Almost always handled automatically by the
recovery poll; manual intervention is rare.

**Detection.**

- `commit_cycles` row with `status='submitted'`, signature populated,
  age > 10 minutes
- Logs show no recent `recovery_reconcile` entries for that signature
- The Solana tx (visible by signature on Solscan) is `finalized`

**Triage.**

1. Confirm on-chain status:
   ```
   solana confirm <signature>
   ```
2. Confirm the slot from `solana confirm` matches what should be in
   `solana_slot` (currently NULL if we got here).

**Recovery.**

```sql
UPDATE public.commit_cycles
SET    status        = 'finalized',
       solana_slot   = <slot from chain>,
       finalized_at  = <timestamp from chain>
WHERE  cycle_id      = <cycle_id>
  AND  solana_signature = <signature>;
```

Same shape for `twap_commits`. Document the manual reconcile in the
ops log.

**Post-incident.** This procedure being needed indicates the
recovery poll itself is broken. Investigate why the automated path
didn't reconcile (logs, advisory-lock state, restart history).

### 8.5.5 Stuck pending cycles

**Detection.**

- §8.2.4 backlog query shows rows aged > 1 hour
- `cycle.in_flight_count` in `/health` is persistent and high

**Triage.**

1. Are there stuck rows in `pending` (no signature) or `submitted`
   (signature recorded)?
   - `pending` no signature: never submitted. Why isn't the cycle
     poller picking them up?
   - `submitted` with signature: recovery-poll case (§8.5.4)
2. Inspect the cycle row to confirm the data is well-formed:
   - `started_at` and `completed_at` set?
   - `observation_count > 0`?
   - `merkle_root` matches `^0x[0-9a-f]{64}$`?
3. Cross-reference against the committer logs at the cycle's
   `created_at` time.

**Recovery.**

- Pending without signature, valid data: bump `retry_count` and
  reset to `pending` to force re-pickup.
- Submitted with signature: §8.5.4 reconcile.
- Malformed data: don't try to commit. Mark `failed` with
  explanatory `last_error`, document, and investigate the upstream
  data corruption.

**Post-incident.** If the same cycle keeps getting stuck after
manual intervention, treat as a code bug — file an issue, write up
findings, fix.

### 8.5.6 Verification mismatch reported

A user (or downstream integration) reports that an observation
fails verification.

**Detection.** External report (email, GitHub issue, Twitter DM).

**Triage.**

1. Get the specific `observation_id` and `cycle_id` from the
   reporter.
2. Run the §05.5.1 server-side verification helper:
   ```
   curl -X POST https://oracle.<domain>/api/oracle/verify/observation \
        -H 'content-type: application/json' \
        -d '{"observation_id": <id>}'
   ```
3. Inspect the `checks` array. Identify the first failed check.

   - `leaf_hash_matches_db`: row was mutated post-commit. Severe.
     Check audit logs / row history if available.
   - `merkle_proof_reconstructs`: bug in proof-generation code or
     stored leaf order.
   - `memo_matches_onchain`: very severe — either DB tamper or a
     signing bug. Investigate the on-chain memo via Solscan
     directly.
   - `slot_matches_onchain`: re-orgs (impossible at finalized,
     §3.7.6) or DB tamper. Check chain.
   - `signer_matches_authority`: someone is asking the verifier to
     check against the wrong pubkey, or the operator has rotated
     and one of the publication channels is stale (§8.4.2 review).

**Recovery.**

- Real bug: ack the reporter, hot-fix, re-verify, post a write-up.
- Documentation drift (e.g. stale pubkey on social): fix the
  channel, ack the reporter, no code change.
- Operator error during a manual reconcile (§8.5.4): treat as bug,
  document, fix.

**Post-incident.** Always write up — verification mismatches are
exactly the kind of incident that erodes trust if handled silently.

### 8.5.7 Ghost advisory lock after ungraceful shutdown

**Symptom.** The oracle service fails to start with:

```
[fatal] advisory-lock: another oracle instance is already running
(pg_try_advisory_lock returned false). If you're sure no other
instance exists, the previous process may have crashed without
releasing — restart Postgres or kill the holding session via
pg_stat_activity.
```

There is no other oracle process running (you can confirm via
Railway dashboard → service Deployments — only one is active).

**Why it happens.** The oracle holds the §3.8.1 single-instance
advisory lock on a connection reserved from the postgres.js pool
(`apps/oracle/src/advisory-lock.ts`). When the oracle exits
cleanly via SIGTERM, its shutdown path calls
`pg_advisory_unlock` and releases the connection — the lock is
freed immediately.

When the oracle exits **without** the SIGTERM path running
(uncaught exception, OOM, Railway force-kill exceeding the grace
window), the TCP connection from the oracle to Supabase's
**Supavisor pooler** dies — but Supavisor keeps the underlying
PG backend alive in its pool for connection reuse. The session
sits idle, but the advisory lock is session-scoped and stays
held. The next oracle startup's `pg_try_advisory_lock` returns
false, and the new instance refuses to start.

The startup retry-with-backoff added in commit `<COMMIT-SHA>`
covers brief Supavisor cleanup windows (Supavisor closes idle
sessions after ~15 minutes by default), so a fresh redeploy in
the middle of an old session's idle timeout will normally
self-resolve. The procedure below is the manual escalation when
you don't want to wait for Supavisor's idle cleanup.

**Recovery — three SQL statements via the Supabase Management API
or Dashboard SQL Editor.** The advisory-lock keys are
`(0xC0117EE5, 0xC0117EE5)` (`apps/oracle/src/advisory-lock.ts`).
`pg_locks.classid` and `pg_locks.objid` are `oid` columns
(unsigned 32-bit), so the WHERE clause compares against the
unsigned decimal `3222372069::oid`. `objsubid=2` selects the
two-int4 advisory-lock variant (variant 1 is the
single-bigint form that we don't use).

**Step 1 — identify the holder:**

```sql
SELECT a.pid, a.usename, a.application_name, a.state,
       a.backend_start, a.state_change, l.granted
FROM   pg_stat_activity a
JOIN   pg_locks l ON l.pid = a.pid
WHERE  l.locktype = 'advisory'
  AND  l.classid  = 3222372069::oid
  AND  l.objid    = 3222372069::oid
  AND  l.objsubid = 2;
```

Expected row: `application_name='Supavisor'`, `state='idle'`,
`backend_start` matches the previous failed deploy's startup
time. If this returns ZERO rows, the lock isn't actually held —
the symptom is something else; investigate elsewhere.

**Step 2 — terminate the holder:**

```sql
SELECT l.pid, pg_terminate_backend(l.pid) AS terminated
FROM   pg_locks l
WHERE  l.locktype = 'advisory'
  AND  l.classid  = 3222372069::oid
  AND  l.objid    = 3222372069::oid
  AND  l.objsubid = 2;
```

`pg_terminate_backend` returns `true` on success. The PG backend
is killed; Supavisor's pool entry is dropped; the
session-scoped advisory lock is released.

**Step 3 — verify the lock is gone:**

```sql
SELECT count(*)::int AS remaining
FROM   pg_locks
WHERE  locktype = 'advisory'
  AND  classid  = 3222372069::oid
  AND  objid    = 3222372069::oid
  AND  objsubid = 2;
```

Expected: `remaining = 0`. (Allow ~1–2 seconds between Step 2
and Step 3 — Supavisor's bookkeeping isn't synchronous.)

**Then redeploy the oracle in Railway.** Startup
`pg_try_advisory_lock` will succeed and the pollers start.

**Common pitfalls.**

- **Wrong type cast.** Filtering on `classid = 0xC0117EE5` (or
  the signed-int4 form) returns zero rows because PG's `oid` is
  unsigned 32-bit. Always use `::oid` in the comparison.
- **Wrong objsubid.** `objsubid=1` is the
  `pg_try_advisory_lock(bigint)` variant; we use the two-int4
  form (`objsubid=2`). Filtering on `objsubid=1` returns zero
  rows.
- **Querying a different DB.** The Mgmt API connects to the
  project's primary; if you're inspecting a read replica via
  some other route the locks won't appear.

**Post-incident.** Always investigate why the previous oracle
shutdown was ungraceful:

- Railway logs for the previous deployment: was there a SIGKILL
  (force exit), an uncaught exception, or an OOMKilled signal?
- If repeated: bump the Railway service's "stop signal grace
  period" (Settings → Deploy → Stop Signal) to 60s so SIGTERM
  has time to drain the cycle poller's 90s confirmation
  polling. The cycle poller's tick is interruptible; the
  in-flight confirmation polling is the slow part.
- File an issue if the root cause is in oracle code (a code
  path that doesn't return on `abortSignal.aborted`, e.g.).

## 8.6 Keypair rotation procedure

Reference §03.5.4 for the short version; this section is the full
operational walk-through.

### 8.6.1 When to rotate

**v1 policy: rotation-on-incident only.** No scheduled cadence.
Rotation is triggered exclusively by one of:

- **Compromise suspected.** Any of: balance drops without our
  authorization; commits appear that we didn't initiate; Railway
  access logs show unauthorized session; operator suspects laptop
  malware.
- **Operator change.** Anyone who had Railway access leaves the
  project. Per §03.5.1, Railway access = key access.
- **After §8.5.6 verification mismatch** if the root cause is a
  signing-side compromise.

**Why no routine cadence in v1:** with a single operator, scheduled
rotation adds operational overhead (full §8.6 procedure + 14-day
advance notice + 3-channel publication update) without enough
recurring drill value to justify the cost. The full procedure
below is documented so it's runnable under incident pressure when
it's needed.

**Deferred to v2 (§9.3):** scheduled annual rotation. Worth
introducing once the project has a multi-person team that benefits
from drilling the procedure regularly — at that point the routine
cadence pays off both in muscle memory and in shrinking the
blast-radius window of an undetected compromise.

### 8.6.2 Pre-rotation checklist

1. Snapshot current state: balance, latest cycle_id, latest
   twap_commit timestamp. Note in ops log.
2. **All v1 rotations are incident-driven** (§8.6.1) — execute
   immediately; communication post-rotation per §8.11. The
   "14-day advance notice for routine" pattern doesn't apply at
   v1; it returns when scheduled rotation moves from §9.3
   deferred-to-v2 into the live policy.
3. If the rotation is in response to suspected compromise (vs
   operator change), follow the §8.10.3 escalated procedure
   instead — drain the old keypair to dead-letter address
   immediately rather than waiting the §8.6.7 24-hour stability
   window.
4. Confirm operator has access to all three publication channels
   before starting (the rotation isn't done until all three are
   updated in lockstep — §8.6.6).

### 8.6.3 Generate the new keypair

**Air-gapped if possible** for operator-change or post-mismatch
rotations where time pressure is moderate. For emergency compromise
rotation (suspected active key theft) the operator's local laptop
with disk encryption is acceptable — speed beats air-gap when an
attacker may already be using the key.

```
solana-keygen new --no-bip39-passphrase --outfile new-oracle-<DATE>.json
solana-keygen pubkey new-oracle-<DATE>.json   # record this; you'll need it
```

Verify the file's permissions are restrictive (`chmod 600`).
Keep the file off cloud sync for the duration of the rotation.

### 8.6.4 Fund the new keypair

Send 0.5 SOL from the operator's funding wallet to the new pubkey.
Confirm via Solana explorer.

```
solana balance <new-pubkey>
```

Don't proceed if balance is below 0.5 SOL — the new keypair must
land with full operating buffer or the §3.5.1 startup balance
check will refuse to come up.

### 8.6.5 Update Railway and restart

1. Open Railway → oracle service → Variables.
2. Update `ORACLE_SOLANA_PRIVATE_KEY` with the **base58-encoded
   secret bytes** of the new keypair (use
   `solana-keygen` with the keyfile to extract; not the JSON file
   contents directly).
3. Save (does not auto-restart).
4. Trigger redeploy.
5. Watch logs for the startup sequence:
   - `[startup] oracle wallet: <NEW PUBKEY>`
   - `[startup] balance: 0.5XXX SOL`
   - `[startup] balance check passed; starting pollers`
6. Confirm `/health` reports the new pubkey under `wallet.public_key`.
7. Wait for the next cycle commit. Confirm it lands with
   `solana_signature` populated and `status='finalized'` (within
   ~5 minutes of cycle completion).

### 8.6.6 Update publication channels in lockstep

Verifiers TOFU-pinned to the old pubkey will refuse new commits
until they see the rotation announced consistently. Update all
three channels within the same hour:

1. **`GET /api/oracle/info`** — automatic via §8.6.5 restart.
   Cross-check the response.
2. **GitHub repo `docs/oracle-authority.md`**:
   - Append an entry: `2026-XX-XX — rotated. Old: <OLD>. New: <NEW>. Reason: <routine | compromise>.`
   - Commit and push to the public default branch.
3. **Project social/docs**:
   - Twitter: pinned tweet citing the new pubkey + link to the
     GitHub commit.
   - Documentation site: update the pubkey on the relevant page.

The old pubkey stays in the docs as historical context — verifiers
checking old commits still need to know who signed them.

### 8.6.7 Drain the old keypair

After 24 hours of stable operation on the new key:

```
solana transfer <DEAD-LETTER-ADDRESS> ALL --keypair old-oracle.json
```

Where `<DEAD-LETTER-ADDRESS>` is a vault wallet the operator
controls (not the funding wallet — keep the trail clean).

Then:

```
shred -uvz old-oracle-<DATE>.json   # GNU shred, or equivalent
```

Confirm the file is gone. **Do not retain the old keypair file**
unless required by an external audit policy.

### 8.6.8 Public announcement

Within 24 hours of rotation completion (or immediately for
compromise rotations), post:

- A pinned thread on the project Twitter / X
- A blog post or GitHub release note documenting:
  - Reason for rotation (routine, compromise, operator change)
  - Old → new pubkey mapping
  - Effective date and slot
  - Any commits during the transition window that may need re-verification

For compromise rotations, also include: timeline of detection, what
we know about the compromise, what observations or commits (if any)
are at risk.

## 8.7 Backfill / catchup procedures

### 8.7.1 Short outages — automatic

Outages up to ~24 hours are handled automatically by the long-tail
retry job (§3.7.7). The operator's role is to confirm the backlog
drains:

1. Once the outage is resolved (RPC restored, SOL refilled, etc.),
   watch `/health` for `cycle.in_flight_count` and `cycle.failed_count_24h`.
2. Within the next hourly long-tail retry tick, failed cycles
   should re-enter `pending` → `submitted` → `finalized`.
3. Backlog is fully drained when both `in_flight_count` and
   `failed_count_24h` return to 0.

### 8.7.2 Long outages — manual cycle-commit catchup

If the outage exceeds 24 hours OR we've manually decided to skip
the long-tail retry (e.g. RPC was misconfigured for hours):

1. Identify the cycle_ids that lack commit rows:

   ```sql
   SELECT sr.id, sr.started_at, sr.finished_at
   FROM   public.scraper_runs sr
   LEFT JOIN public.commit_cycles cc ON cc.cycle_id = sr.id
   WHERE  cc.cycle_id IS NULL
     AND  sr.finished_at IS NOT NULL
     AND  sr.status IN ('completed', 'partial')
     AND  EXISTS (SELECT 1 FROM public.supplier_observations o
                  WHERE o.scraper_run_id = sr.id
                    AND o.scrape_success = true)
   ORDER BY sr.id;
   ```

2. The committer's normal poll picks these up automatically as
   long as the service is healthy. There is no separate "backfill
   mode" — the polling query (§3.2.2) processes these rows in
   order.

3. Monitor `/health` until `cycle.last_commit_at` advances past
   the outage's end time. Backlog drainage is the same as §8.7.1
   but takes proportionally longer.

### 8.7.3 TWAP commit gaps — DO NOT backfill

**Decision: missed TWAP commits are documented gaps, not backfilled.**

Rationale:

- TWAP commits anchor a value computed for a specific historical
  hour window. Backfilling retroactively (e.g. committing
  yesterday's 14:00–15:00 window today) creates a memo whose
  `computed_at` is in the past while the on-chain timestamp is
  in the present. Verifiers see a time-shifted commit that looks
  retroactively-anchored, which weakens the trust narrative even
  if the underlying math is correct.
- The cycle commits anchor the underlying observations regardless;
  a verifier can compute the TWAP themselves from the cycle-anchored
  observations even if no TWAP commit landed for that hour.

Procedure on detecting a gap:

1. Identify which `(peptide_code, computed_at)` hours lack
   `twap_commits` rows:

   ```sql
   SELECT pt.peptide_id, pt.computed_at, pt.twap_usd_per_mg
   FROM   public.peptide_twaps pt
   LEFT JOIN public.twap_commits tc
          ON tc.peptide_code = (SELECT code FROM public.peptides p WHERE p.id = pt.peptide_id)
         AND tc.computed_at  = pt.computed_at
   WHERE  pt.computed_at BETWEEN <outage_start> AND <outage_end>
     AND  pt.twap_usd_per_mg IS NOT NULL
     AND  tc.id IS NULL
   ORDER BY pt.peptide_id, pt.computed_at;
   ```

2. **Do not insert backfill rows.** The committer service skips
   past hours on its hourly poll (§3.3.1).

3. Document the gap in `docs/oracle-gaps.md` (a public file in the
   GitHub repo): the affected peptide_codes, the time range, the
   reason (RPC outage / SOL exhaustion / etc.), the cycle commits
   that DID anchor during the gap (so users can recompute TWAPs
   themselves if needed).

4. Mention the gap in the next post-incident write-up (§8.11).

This decision is open for revision in v2 (§8.12) if user demand
for continuous TWAP coverage outweighs the cleaner trust story.

### 8.7.4 Very long outages — operator judgement

If commits have been down for multiple weeks, two questions:

1. Are the underlying scraped observations still trustworthy
   (vendor sites haven't changed, data wasn't corrupted)?
2. Does the historical cycle catchup add real value to verifiers,
   or are we just paying SOL for backfilled audit trail?

For routine multi-week outages: catch up cycle commits per §8.7.2;
document the gap for TWAP commits. For pathological cases
(e.g., a 6-month operational pause) revisit at the time — there's
no point pre-deciding policy for a scenario we hope never to hit.

## 8.8 CDN configuration

Per §05.7, this is an operator decision rather than a v1 hard
requirement. **Recommended: deploy when verification API traffic
warrants** (e.g., when daily request volume on the read endpoints
exceeds ~10k or when a downstream integration starts polling
heavily).

### 8.8.1 Recommended setup: Cloudflare in front of Railway

- **DNS**: point the API hostname (e.g. `oracle.<domain>`) to a
  Cloudflare proxy.
- **Origin**: Railway's public service URL.
- **Origin protection**: enable Cloudflare's origin certificate so
  Railway only accepts requests proxied through Cloudflare (deny
  direct origin access).

### 8.8.2 Cache rules

Use Cloudflare's "Cache Rules" feature with the matrix from §05.4.12:

| pattern                                    | edge cache TTL | notes                                                |
| ------------------------------------------ | -------------- | ---------------------------------------------------- |
| `/api/oracle/cycles/:id` (finalized)       | 86400 s        | Honor `Cache-Control: immutable`                     |
| `/api/oracle/cycles/:id/observations`      | 86400 s        | Same                                                 |
| `/api/oracle/cycles/:id/proof`             | 86400 s        | Same                                                 |
| `/api/oracle/twap/:code/at/:ts` (immutable)| 86400 s        | Same                                                 |
| `/api/oracle/twap/:code` (current)         | 300 s          | New commits hourly                                   |
| `/api/oracle/cycles` (list)                | 30 s           | Origin handles freshness                             |
| `/api/oracle/twap/:code/history`           | 300 s          | Origin handles freshness                             |
| `/api/oracle/peptides`, `/vendors`, `/info`| 60 s           | Lists / discovery                                    |
| `/api/oracle/observations/:id` (finalized) | 86400 s        | Honor `Cache-Control: immutable`                     |
| `/api/oracle/verify/*` (POST)              | bypass cache   | Verification responses are always fresh              |

### 8.8.3 Edge rate limiting

Cloudflare rate limits stack with the per-process limits from
§05.4.13:

- Anonymous: 600 req/min/IP across all paths (loose enough that
  legitimate readers never trip; bots will)
- Verification endpoints (POST): 60 req/min/IP

The application's per-process limits remain the authoritative gate
— Cloudflare's role is to absorb traffic spikes that the origin
shouldn't even see.

## 8.9 Monitoring and alerting

### 8.9.1 Monitoring tooling

**Recommendation: Better Stack** (formerly Better Uptime + Logtail).
Single vendor, free tier covers small project, supports Railway
healthcheck integration natively, includes a public status page.

Setup:

1. Create a Better Stack account.
2. Add a "Heartbeat" monitor pointing at
   `https://oracle.<domain>/health` with check interval 1 minute,
   response time threshold 5 seconds.
3. Configure failure conditions: HTTP non-200 OR response includes
   `"ok":false`.
4. Add a JSON-field check for
   `wallet.balance_critical=true` → critical alert.
5. Configure the public status page at
   `status.<domain>` reflecting the heartbeat.

### 8.9.2 Alert thresholds

| metric                                         | warn     | critical | source                           |
| ---------------------------------------------- | -------- | -------- | -------------------------------- |
| `/health` HTTP status                          | non-200  | non-200 (2 consecutive)| §3.9.2                           |
| Wallet balance                                 | < 0.1 SOL| < 0.05 SOL (~7-day buffer) | §3.5.3                           |
| Cycle `last_commit_at` staleness               | > 30 min | > 60 min | §3.9.2                           |
| TWAP `last_commit_at` staleness                | > 90 min | > 180 min| §3.9.2                           |
| `cycle.failed_count_24h`                       | > 3      | > 10     | §3.9.3                           |
| `twap.failed_count_24h`                        | > 3      | > 10     | §3.9.3                           |
| Helius daily RPC                               | > 50,000 | > 90,000 | §7.7                             |
| Supabase storage                               | > 6.4 GB (80% Pro) | > 7.6 GB (95%) | §7.4.2                  |

The 7-day buffer threshold for SOL critical alerts is intentionally
tighter than the 30-day operational target — gives the operator a
week to refill before commits start failing.

### 8.9.3 Alert routing

| severity  | channel                                     | response time |
| --------- | ------------------------------------------- | ------------- |
| Critical  | SMS + email + Slack DM                       | within 30 min |
| Warning   | Email + Slack channel                        | within 4 hours |
| Info      | Slack channel only                           | next-day review |

Operator confirms quarterly that alert routing still reaches the
right person (§8.4.3 ops review).

## 8.10 Disaster recovery

### 8.10.1 Complete loss of Supabase database

**Detection.** Supabase project shows as deleted/suspended;
service can't connect; entire database gone.

**Response.**

1. Pause the oracle service (Railway → stop deployment) so it
   can't write to a partial restore.
2. Initiate Supabase restore from latest backup. Supabase Pro
   provides daily backups with 7-day retention; Point-in-Time
   Recovery (15-minute granularity) is available as an add-on.
3. Restore to a fresh project if the original is unrecoverable;
   update `SUPABASE_URL` env vars on every Railway service.
4. Restart oracle service. Recovery poll picks up any in-flight
   rows that survived the restore.

**Communication.** Critical incident — public announcement within
1 hour of confirmed data loss. Status page updates every 30 min
during recovery.

**Recovery time objective**: 4 hours from confirmation of loss to
restored service (Supabase backup restore typically takes 30–90
min; the rest is verification time).

### 8.10.2 Loss of authority keypair without rotation

The operator loses the private key (laptop destroyed, file
corrupted, etc.) without having rotated to a new key first.

**This is a hard incident.** The data already on chain stays
verifiable forever (signatures don't disappear). But the operator
can't sign new commits until a new keypair takes over, and there's
no on-chain mechanism to "transfer authority" — every verifier
that validates commits will need to learn about the new key
out-of-band.

**Response.**

1. Generate a new keypair per §8.6.3.
2. Fund and deploy per §8.6.4–§8.6.5.
3. Update all three publication channels per §8.6.6 with explicit
   "previous key compromised/lost; commits after slot N are signed
   by NEW pubkey" framing.
4. Public announcement per §8.6.8 with full timeline.

**Effect on verifiers.** Anyone TOFU-pinned to the old pubkey will
refuse to verify new commits until they manually update their
pin. The recommended procedure for verifier libraries (§5.2.4) is
warn-on-change, so this should surface as a deliberate manual
step rather than silent acceptance.

### 8.10.3 Compromise of authority keypair

Same procedure as §8.5.6 escalated, plus:

1. **Drain the old keypair to dead-letter address immediately**
   (don't wait the 24-hour stability window from §8.6.7) — the
   attacker may also be trying to drain it.
2. Audit recent commits for any submitted by the attacker. Any
   memo published by the compromised key during the compromise
   window has the same on-chain validity as a legitimate commit;
   verifiers will accept them. Operator must post a public list
   of disputed commits in the post-incident write-up.
3. If any disputed commits affected published TWAP values, the
   operator may need to coordinate with downstream integrations
   to re-pull and re-verify.

**This scenario is the worst case the project plans for.** Every
mitigation in §3.5.1 (dedicated wallet, minimal SOL, single-purpose
signing) reduces blast radius — but doesn't eliminate it.

### 8.10.4 Sustained Solana network outage (>24h)

Solana mainnet has historically had multi-hour outages a handful
of times. >24h is rarer but plausible.

**Response.**

1. Pause expectations of new commits. Document the gap
   (§8.7.3 procedure for TWAP, similar for cycles).
2. Watch status.solana.com for restoration ETA.
3. On restoration, the long-tail retry job picks up failed commits
   automatically.
4. If the outage exceeded 7 days, manually catch up cycle commits
   per §8.7.2; TWAP gaps per §8.7.3.

**Communication.** Status page reflects upstream Solana incident.
No application-level write-up needed unless the outage lasted
> 7 days or affected verification users materially.

## 8.11 Communication protocols

### 8.11.1 Channels

- **Status page**: Better Stack, hosted at `status.<domain>`.
  Source of truth for current operational state.
- **Twitter / X**: project account. For announcements,
  major-incident updates, key rotations.
- **GitHub repo**: long-form post-incident write-ups in
  `docs/incidents/<YYYY-MM-DD>-<slug>.md`.
- **Documentation site**: stable reference for the authority
  pubkey, spec, and historical context.

### 8.11.2 Cadence

| event                                    | when to communicate                                  | where                              |
| ---------------------------------------- | ---------------------------------------------------- | ---------------------------------- |
| Routine maintenance                      | 24h advance notice                                   | Status page + Twitter              |
| Incident detected                        | within 15 min: status page → "investigating"         | Status page                        |
| Incident classified                      | within 1h: status page → "identified"                | Status page                        |
| Incident resolved                        | when stable: status page → "resolved" + brief note   | Status page                        |
| Major incident (downtime > 1h or affects verification) | within 4h of detection: Twitter post     | Status page + Twitter              |
| Post-incident write-up (qualifying)      | within 5 business days                               | GitHub repo + link from Twitter    |
| Authority pubkey rotation (incident)     | within 1h of completion                              | All four channels in coordination  |

### 8.11.3 What qualifies for a post-incident write-up

Write up if **any** holds:

- Total downtime (cycle-commit gap) > 30 minutes
- > 10 commits failed and required manual intervention
- Required keypair rotation
- Verification mismatch reported externally (§8.5.6)
- Required communication to downstream integrations

Skip the write-up for purely transient incidents that recovered
automatically (e.g., a single failed commit retried successfully).
The threshold balances honesty (we publish our outages) against
fatigue (a write-up for every blip burns out the operator).

## 8.12 Decisions to flag

1. **Backfill missed TWAP commits: NO. Document gaps instead.**
   Recommended in §8.7.3. Keeps the on-chain trust story honest
   (no retroactive timestamps); verifiers can recompute from
   anchored cycle observations if continuous TWAP coverage matters
   to them. Open for revision in v2 if user demand outweighs the
   cleaner trust story.
2. **Status page tooling: Better Stack.** Single vendor, free
   tier, Railway-native, public status page. Alternative: a custom
   `/status` page on the project's docs site (more control, more
   maintenance).
3. **Post-incident write-up threshold: §8.11.3 conditions.**
   Threshold-based rather than write-up-everything (operator
   fatigue) or write-up-only-major (trust loss). The §8.11.3
   conditions cover "anything a verifier might notice."
4. **Incident communication time targets: 15 min status-page,
   1h classification, 4h Twitter for major incidents, 5 business
   days for write-up.** Aggressive but doable for a single
   operator. Tighter SLAs would require a second on-call person.
5. **Keypair rotation: incident-only for v1** (§8.6.1). No
   scheduled cadence at single-operator scale. Scheduled annual
   rotation deferred to v2 per §9.3 — re-introduce when a
   multi-person team benefits from drilling the procedure
   regularly.
