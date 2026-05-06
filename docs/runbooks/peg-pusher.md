# Peg-pusher operator guide

The peg pusher is an oracle subsystem that calls `update_peg_state`
on the BioHash peg program after each TWAP commit reaches `finalized`
status. Its job is to keep `peg_state.current_twap` fresh enough that
mint and burn instructions don't revert with `TwapStale`.

| field                       | value                                                                       |
| --------------------------- | --------------------------------------------------------------------------- |
| Default state               | **off** (`PEG_PUSHER_ENABLED` unset → no peg pushes happen)                 |
| Trigger                     | After each `twap_commits` row reaches `status='finalized'`                  |
| Cadence                     | Hourly per active peptide (matches TWAP commit cadence)                     |
| On-chain instruction        | `update_peg_state(new_twap: u64, observation_set_root: [u8; 32])`           |
| Authority                   | Same Solana keypair the oracle uses for memo commits (`ORACLE_SOLANA_PRIVATE_KEY`) |
| Per-tx cost                 | ~0.00002 SOL (median) / ~0.0008 SOL (spike) — tiny CU footprint              |
| Source                      | `apps/oracle/src/peg/peg-pusher.ts`                                          |
| IDL                         | `apps/oracle/src/peg/idl.json` (update_peg_state surface only)               |
| /health field               | `peg_pusher.{enabled,peptides,last_push_*,push_count_24h,failed_count_24h,skipped_count_24h}` |

---

## 1. Enabling the pusher (after the peg program is deployed)

Set four env vars on the Railway `oracle` service. Apply them
together; Railway redeploys, oracle starts, the `[startup] peg pusher
enabled` line confirms.

```
PEG_PUSHER_ENABLED=true
PEG_PROGRAM_ID=<peg program id on the same cluster as ORACLE_RPC_URL>
PEG_PEPTIDES=BPC157            # comma-separated for multi-peptide
PEG_PUSH_PRIORITY_FEE_LAMPORTS=1000   # optional; default 1000 microlamports/CU
PEG_PUSH_MAX_RETRIES=3                # optional; default 3
```

**Pre-flight checks** before flipping `PEG_PUSHER_ENABLED=true`:

1. **Same cluster, same authority.** The peg program's
   `peg_state.update_authority` must equal the oracle's signing
   pubkey (the on-chain `has_one = update_authority` rejects
   otherwise with `UnauthorizedUpdater`). Verify with:

   ```bash
   solana account <PEG_STATE_PDA> --url <cluster> --output json \
     | jq -r '.account.data[0]' | base64 -d | xxd | head
   # ... or fetch via Anchor IDL deserialize
   ```

   Compare bytes 56..88 (the `update_authority` field) against the
   oracle wallet pubkey. If they don't match, **don't enable** —
   you'll burn fees on rejected txs until you re-init the peg
   state with the right authority.

2. **Peg state initialised on-chain.** Run
   `solana account <PEG_STATE_PDA>` and confirm it returns data
   (not "Account not found"). If it's not there, the pusher logs
   a `peg PDA missing` warn once and skips every push until init —
   no harm done, but you're collecting nothing.

3. **Initial TWAP set.** A peg state with `current_twap = 0` will
   accept the first push without the step-cap check (V0.1 §5.3).
   That's the bootstrap moment. Subsequent pushes are bounded by
   `max_twap_step_bps = 5000` (50%); a spike from $5 → $20 between
   hourly pushes would revert with `TwapStepTooLarge`.

4. **Authority balance ≥ 1 SOL.** Each push burns ~0.00002 SOL at
   median priority. Hourly cadence = ~0.0005 SOL/day; even a
   prolonged priority-fee spike caps below 0.001 SOL/day. The
   existing `ORACLE_BALANCE_WARN_SOL` covers this.

---

## 2. Operational signals

### `/health` block

```json
"peg_pusher": {
  "enabled": true,
  "peptides": ["BPC157"],
  "last_push_at": "2026-05-06T22:00:14.512Z",
  "last_push_peptide": "BPC157",
  "last_push_signature": "5JxK...QaP",
  "push_count_24h": 24,
  "failed_count_24h": 0,
  "skipped_count_24h": 1
}
```

| field                 | meaning                                                                     | typical value                       |
| --------------------- | --------------------------------------------------------------------------- | ----------------------------------- |
| `enabled`             | env var read at startup; restart to flip                                    | `true` after rollout                |
| `peptides`            | sorted set of codes the pusher considers; restart to mutate                 | `["BPC157"]` for V0.1               |
| `last_push_at`        | ISO timestamp of the most recent successful push                            | within the last hour                |
| `last_push_peptide`   | code of that push                                                            | one of `peptides`                   |
| `last_push_signature` | the Solana signature                                                        | base58                              |
| `push_count_24h`      | successful pushes in the last 24 h (rolling window)                         | `24` × len(peptides) when healthy   |
| `failed_count_24h`    | pushes that exhausted retries OR returned a non-retryable program revert    | `0` when healthy                    |
| `skipped_count_24h`   | deliberate skips (rate-limit, staleness, max-step, missing PDA, zero TWAP)  | `0` ideal, low non-zero acceptable  |

**Skip vs. fail semantics matters.** A "skip" means the pusher chose
not to call the program; the chain wasn't asked. A "fail" means we
called and the chain (or RPC) rejected. Counters are deliberately
separated so a high `skipped_count_24h` doesn't trigger the same
alarm as `failed_count_24h`.

### Logs

Healthy hourly cycle (per peptide):

```
[twap-poller] peptide=BPC157 FINALIZED slot=347823901 sig=5J…
[peg-pusher]  peptide=BPC157 pushed sig=4xN…fGw at=2026-05-06T22:00:14.512Z
```

Common skip lines (informational, not errors):

```
[peg-pusher] peptide=BPC157 skipped: rate-limited (last push 35s ago, min 60s)
[peg-pusher] peptide=BPC157 skipped: commit-slot 347800000 is 23901 slots behind current 347823901 (max 15000)
[peg-pusher] peptide=BPC157 skipped: would exceed max_twap_step_bps (prev=5998000 new=15000000, cap=5000bps)
[peg-pusher] peptide=BPC157 peg PDA missing (Eq3t…4ms); skipping. Will dedup further warns until restart or first successful push.
```

Failures (worth attention):

```
[peg-pusher] peptide=BPC157 non-retryable program error: ... TwapStepTooLarge
[peg-pusher] peptide=BPC157 retries exhausted (4 attempts): blockhash not found
```

---

## 3. Failure modes

### 3.1 `TwapStepTooLarge` on every push

Means the on-chain peg state's `current_twap` is so far from the
oracle's most recent TWAP that the 50% step cap rejects every
attempt. Causes:

- The peg was initialised with a stale value and the market has
  moved 2× since.
- The pusher was disabled long enough that several TWAP cycles
  passed, and the cumulative move now exceeds 50%.

**Recovery:** there's no soft-update path on V0.1 — the on-chain
cap is enforced unconditionally. Two options:

1. **Wait for the market to mean-revert** (rarely helpful).
2. **Re-initialise the peg state** with a value close to the
   current TWAP. Requires a redeploy of `initialize_peg_state`
   for that peptide. Document the operator decision.

### 3.2 Peg PDA missing

The peptide is listed in `PEG_PEPTIDES` but the on-chain peg state
hasn't been initialised yet. Pusher logs a single warn line,
increments `skipped_count_24h`, and continues. **Not a failure.**

**Recovery:** run `initialize_peg_state` for that peptide from your
deploy machine, then either (a) wait for the next TWAP commit which
auto-resumes pushing, or (b) restart the oracle to clear the dedup
log set.

### 3.3 `UnauthorizedUpdater`

The peg state's `update_authority` doesn't match the oracle's
signing pubkey. **Configuration error**, not a transient failure.

**Recovery:** stop the pusher (set `PEG_PUSHER_ENABLED=false`,
redeploy), figure out which side is wrong, fix it, re-enable.

### 3.4 Authority balance depleted

Same wallet as the memo commits, so the existing
`ORACLE_BALANCE_WARN_SOL` / `_CRITICAL_SOL` thresholds cover this.
Critical-balance triggers refuse to start; warn-balance keeps the
service running but flags `wallet.balance_low` on `/health`.

### 3.5 Helius / RPC degraded

Pusher uses the same `ORACLE_RPC_URL` as the rest of the oracle.
Retryable network errors (rate limits, `blockhash expired`, etc.)
trigger up to `PEG_PUSH_MAX_RETRIES` attempts with priority-fee
doubling between attempts (capped at 1_000_000 microlamports/CU).
After exhaustion → `failed_count_24h++`.

---

## 4. Rollback / disable

To turn the pusher off without disrupting TWAP commits:

```
Railway oracle service → env vars → set PEG_PUSHER_ENABLED=false
                                  → Apply (Railway redeploys)
```

The oracle starts with `[startup] peg pusher disabled`. TWAP and
cycle commits continue exactly as before. Peg state will go stale
at the next `max_twap_age_slots` boundary (~2 h on mainnet), but
that's the same behaviour as before the pusher existed.

---

## 5. Multi-peptide rollout

The pusher is keyed off the env-var allowlist; adding a peptide is
a two-step operator change:

1. **On-chain**: deploy `initialize_peg_state` for the new peptide
   (separate Anchor invocation).
2. **Oracle**: append the code to `PEG_PEPTIDES`, redeploy.

The pusher will pick up the new peptide on the next TWAP commit
that finalises for it. No DB migration, no code change.

---

## 6. Known follow-ups

| item                                                 | rationale                                                          |
| ---------------------------------------------------- | ------------------------------------------------------------------ |
| DB-driven `peg_peptides` table instead of env var    | Avoids a restart per peptide add. Defer until > ~3 peptides live.  |
| Startup catch-up push of latest finalized TWAP        | Reduces the dead window after a long oracle outage. Add only if we observe operational pain — V0.1 leaves this off intentionally. |
| Track peg `current_twap` from a `getAccountInfo` poll | Lets `/health` surface "actual on-chain peg state" alongside the pusher's outbound counters. Useful but not blocking V0.1. |
| Split the pusher into its own Railway service         | If we ever want to push pegs on a different cluster than memo commits (cross-cluster split). Out of scope for V0.1. |

---

## 7. Code surface (for reference)

| file                                          | purpose                                                          |
| --------------------------------------------- | ---------------------------------------------------------------- |
| `apps/oracle/src/peg/peg-pusher.ts`           | `PegPusher` class, retry + skip semantics, 24h metrics           |
| `apps/oracle/src/peg/idl.json`                | Anchor IDL (update_peg_state instruction + PegState account)     |
| `apps/oracle/src/config.ts`                   | env-var parsing + `OracleConfig.pegPusher`                        |
| `apps/oracle/src/index.ts`                    | construction + wiring into twap-poller, `/health` snapshot fold   |
| `apps/oracle/src/pollers/twap-poller.ts`      | `invokePegPusherBestEffort` hook on both finalization branches    |
| `apps/oracle/src/db/twap-state.ts`            | `findNextSubmittedTwap` widened with `twap_value` + `observation_set_root` |
| `apps/oracle/src/health.ts`                   | `peg_pusher` field on `OracleHealthState`                         |
