# 09 — Open questions consolidation

Status: **closed — spec is fully locked.** All decisions from the
spec review pass have been confirmed. §9.2 (pending) is empty —
preserved as an empty section for symmetry and future review
passes. §9.4 and §9.5 remain operator-actionable and gate the
mainnet cutover.

Section 9 read order:

- §9.1: 29 confirmed decisions (immutable for v1)
- §9.2: empty (no pending decisions)
- §9.3: 9 deferred-to-v2 items
- §9.4: implementation prerequisites (operator setup)
- §9.5: pre-mainnet checklist (devnet → mainnet gate)

## 9.1 Confirmed decisions

These were explicitly approved during spec review. Each entry
notes the commit where the decision was locked in. Treat as
immutable for v1 — changing one of these now means revisiting the
spec rather than tweaking implementation.

### 9.1.1 Solana commitment level: `finalized`

- **Confirmed**: yes (review pass, commit `51fa329`)
- **Source**: §03.4.5
- **Impact**: ~13s typical / ~30–45s worst-case latency per commit
  vs ~3–5s for `confirmed`. Eliminates re-org risk entirely. Drove
  the §03.4.6 timeout bump (60s → 90s) and the §3.7.6 simplification
  (no re-org detection in v1).

### 9.1.2 Commit-status enum value: `'finalized'` (renamed from `'confirmed'`)

- **Confirmed**: yes (commit `34a9bbc`)
- **Source**: §01.4 enum block + migration `0031_add_commit_tracking.sql`
- **Impact**: lifecycle reads `pending → submitted → finalized | failed`
  consistently across migration, schema spec, service architecture,
  and overview. Column `confirmed_at` also renamed to `finalized_at`
  for consistency. Migration not yet applied — rename can still be
  reverted easily if needed.

### 9.1.3 `algo` field in TWAP commit memo

- **Confirmed**: yes (commit `462a1f0`)
- **Source**: §02.2.3 schema + §05.3.1 step 7 dispatch
- **Impact**: TWAP memo grows 284 → 312 bytes (still well under
  Memo program limits). v1 ships `"filtered_median_v1"` as the only
  algorithm. Future algorithm changes (`filtered_median_v2` etc.)
  bump `algo` independently of the schema-version `v` field;
  historical verifications stay deterministic forever. Verifier
  libraries MUST refuse — not silently fall back — when `algo` is
  unknown.

### 9.1.4 Authority pubkey trust model: multi-channel publication

- **Confirmed**: yes (commit `462a1f0`)
- **Source**: §05.2.4
- **Impact**: v1 trust assumption is "verifier trusts at least one
  of the three publication channels (`/api/oracle/info`, GitHub repo,
  social/docs) has not been compromised." Stronger than "trust the
  API," weaker than zero-trust. Sophisticated verifiers should
  hardcode the pubkey on first contact (TOFU + warn-on-change).

### 9.1.5 Hashes stored as `text`, not bytea

- **Confirmed**: yes (commit `0db4e43`)
- **Source**: §01.7.1
- **Impact**: ~6 MB/year extra storage at v1 scale. Direct string-match
  comparisons against on-chain memo bytes; readable in psql + logs;
  CHECK constraint enforces format at the DB layer.

### 9.1.6 Partial index on non-terminal commit status

- **Confirmed**: yes (commit `0db4e43`)
- **Source**: §01.7.2
- **Impact**: bounded-size partial index for the committer's polling
  query. Stays small as the table grows; in-flight rows fall out
  on terminal-status update.

### 9.1.7 No deletes; `status='failed'` is the audit signal

- **Confirmed**: yes (commit `0db4e43`)
- **Source**: §01.7.3
- **Impact**: failed commit attempts accumulate forever. Long-tail
  retry job (§03.7.7) re-attempts; manual storage-pressure pruning
  is a future operator decision.

### 9.1.8 RPC provider: Helius free tier

- **Confirmed**: yes (review pass, commit `51fa329`)
- **Source**: §03.6.1, §07.3
- **Impact**: ~12× headroom on the moderate verification scenario
  at v1 scale. Upgrade triggers documented in §07.3.5.

### 9.1.9 Polling cadences: 30s cycles, 60s TWAPs

- **Confirmed**: yes (review pass)
- **Source**: §03.2.1 + §03.3.1
- **Impact**: 30s upper bound on cycle detection latency vs
  10-min cycle cadence. TWAP poller wakes at `HH:00:30` UTC for
  hourly commits. Tunable via env var.

### 9.1.10 Priority fee: dynamic via Helius API, capped at 50,000 µlamports/CU

- **Confirmed**: yes (review pass)
- **Source**: §03.4.4
- **Impact**: per-tx worst case 30,000 lamports = 0.00003 SOL; v1
  annual cap ~2.89 SOL. Static fallback documented but not chosen.

### 9.1.11 Keypair storage: Railway env var

- **Confirmed**: yes (review pass, commit `51fa329`)
- **Source**: §03.5.1 — three normative operational requirements
- **Impact**: requires (a) restricted Railway access, (b) secret-
  flagged env var, (c) ~30-day SOL buffer with manual refills only.
  Worst-case key compromise drains ≤ 30 days of operating cost.

### 9.1.12 /health endpoint required-field contract

- **Confirmed**: yes (review pass, commit `51fa329`)
- **Source**: §03.9.2 normative table
- **Impact**: monitoring tooling has a stable contract. Adding extra
  fields is fine; removing or renaming any required field is a
  breaking change to the operational contract.

### 9.1.13 Bitcoin-style odd-node duplication in Merkle tree

- **Confirmed**: implicit (locked in §02.4.5 narrative); no review pushback
- **Source**: §02.4.5
- **Impact**: simpler than RFC 6962's no-duplication scheme. The
  ambiguity from duplicating last node is resolved by always
  co-committing `observation_count` in the cycle memo.

### 9.1.14 Domain separation: `0x00` for leaves, `0x01` for inner nodes

- **Confirmed**: implicit (RFC 6962 convention; §02.4.4)
- **Source**: §02.4.4
- **Impact**: prevents the second-preimage attack class where an
  inner-node hash could be passed off as a leaf.

### 9.1.15 v1 protocol version locked at `v=1`

- **Confirmed**: implicit (§02.2.4 versioning)
- **Source**: §02.2.4
- **Impact**: any byte-level memo format change requires a v2 spec
  document. Verifiers MUST inspect `v` and refuse unknown versions.

### 9.1.16 No re-org detection in v1

- **Confirmed**: yes (consequence of §9.1.1 finalized commitment)
- **Source**: §03.7.6
- **Impact**: no programmatic action on the unprecedented case of a
  finalized slot being re-orged. Manual audit-trail recovery if it
  ever occurs.

### 9.1.17 Active peptide subset: all `is_active=true` peptides

- **Confirmed**: yes (this review pass)
- **Source**: §03.3.4
- **Impact**: v1 commits hourly TWAPs for every active peptide
  (currently 26). Drives daily TWAP-commit count to 624/day
  (~768/day total with cycle commits) and pushes annual SOL spend
  to ~2.80 SOL median / ~8.41 SOL high cap. The §07 cost analysis
  is rebased onto this baseline; total v1 monthly operating cost
  ~$54 at median priority fees. The §03.3.4 env-var allow-list
  filter remains available for trimming the subset later if user-
  facing cost ever needs reducing.

### 9.1.18 Server-side verification helpers ship in v1

- **Confirmed**: yes (this review pass)
- **Source**: §05.5 + §05.7 decision 4
- **Impact**: `POST /api/oracle/verify/observation` and
  `/verify/twap` are part of the v1 API surface. Required for the
  explorer's "verify" button to function without forcing client-
  side library use. Same math as the future client library, so no
  extra surface area to maintain.

### 9.1.19 No TWAP backfill on outages — document gaps instead

- **Confirmed**: yes (this review pass)
- **Source**: §08.7.3 + §08.12 decision 1
- **Impact**: when commits stop for an extended period, the
  committer service does NOT backfill missed TWAP commits.
  Cycle commits CAN catch up via the normal poll (they anchor a
  finished historical event). TWAP gaps go into
  `docs/oracle-gaps.md` for verifiers to inspect. Preserves the
  trust narrative that on-chain commit timestamps reflect actual
  commit time, not retroactive recomputation. Verifiers can still
  reconstruct historical TWAPs from cycle-anchored observations
  during gaps if they need continuous coverage.

### 9.1.20 Keypair rotation: incident-only for v1

- **Confirmed**: yes (this review pass)
- **Source**: §08.6.1 + §08.12 decision 5
- **Impact**: at single-operator scale, scheduled annual rotation
  adds operational overhead without enough recurring drill value
  to justify the cost. v1 rotates only on incident (compromise,
  operator change, post-mismatch root-cause). Full §8.6 procedure
  remains documented so it's runnable under incident pressure.
  Scheduled annual rotation deferred to v2 — see §9.3.9 — for when
  a multi-person team makes the drill cadence worthwhile.

### 9.1.21 Verification API rate limits: 120 / 60 / 30 req/min/IP

- **Confirmed**: yes (this review pass — accepted as recommended)
- **Source**: §05.4.13 + §05.7 decision 1
- **Impact**: defines the public API's concurrency ceiling per-IP
  across the three endpoint buckets (read-light / read-heavy /
  verify). Env-var tunable; can be raised after observing real
  traffic.

### 9.1.22 Caching strategy: defer Cloudflare to traffic-warrants

- **Confirmed**: yes (this review pass — accepted as recommended)
- **Source**: §05.4.12 + §05.7 decision 2 + §08.8
- **Impact**: v1 ships with `Cache-Control` headers set per the
  §05.4.12 matrix (`immutable` for finalized cycle / historical
  TWAP, short TTLs for current state). No CDN fronting Railway in
  v1; modern browsers + downstream CDNs honor the headers. Adding
  Cloudflare later is a DNS change + cache-rule config without
  application changes.

### 9.1.23 Pagination: cursor-based, default 50, max 200

- **Confirmed**: yes (this review pass — accepted as recommended)
- **Source**: §05.4 + §05.7 decision 3
- **Impact**: list endpoints use opaque base64 server-token
  cursors with default page size 50 and ceiling 200. Bounds
  response sizes and DB load; easy to dial.

### 9.1.24 No authentication for v1; all reads public

- **Confirmed**: yes (this review pass — accepted as recommended)
- **Source**: §05.7 decision 5
- **Impact**: aligns with "the oracle's value is in being
  verifiable" — gating reads would defeat the trust story. Future
  paid tier adds API-key auth with boosted rate limits without
  gating access to the data itself.

### 9.1.25 SOL pre-purchase cadence: quarterly at 1.0 SOL refill

- **Confirmed**: yes (this review pass — accepted as recommended,
  refill amount bumped from 0.5 → 1.0 SOL to cover the 26-peptide
  baseline at high priority fees)
- **Source**: §07.2.3 + §07.7 decision 3 + §08.4.1
- **Impact**: top up the operator's funding wallet to 1.0 SOL
  every 90 days. Annualized SOL spend ~$561 at $200/SOL median.
  Tighten to monthly if sustained priority fees stay near the
  cap (early signal: §08.2.1 weekly Helius dashboard review).

### 9.1.26 Track Helius RPC usage as a separate metric

- **Confirmed**: yes (this review pass — accepted as recommended)
- **Source**: §07.7 decision 4 + §08.2.1 / §08.3.2
- **Impact**: weekly Helius dashboard review during v1 rollout,
  monthly after stabilization. Gives advance warning of the 50%
  free-tier upgrade trigger. Operator burden is one dashboard
  view per week.

### 9.1.27 Status-page tooling: Better Stack

- **Confirmed**: yes (this review pass — accepted as recommended)
- **Source**: §08.9.1 + §08.12 decision 2
- **Impact**: single vendor for heartbeat monitoring + public
  status page on Better Stack's free tier. Railway-native
  integration. Switching providers later is a DNS change +
  reconfigure; not load-bearing.

### 9.1.28 Post-mortem threshold: §08.11.3 conditions

- **Confirmed**: yes (this review pass — accepted as recommended)
- **Source**: §08.11.3 + §08.12 decision 3
- **Impact**: write-up qualifying conditions are >30 min downtime
  OR >10 failed commits OR keypair rotation OR external
  verification mismatch OR downstream-integration coordination
  required. Balances honesty against operator fatigue at single-
  maintainer scale.

### 9.1.29 Incident communication SLAs: 15 min / 1h / 4h / 5d

- **Confirmed**: yes (this review pass — accepted as recommended)
- **Source**: §08.11.2 + §08.12 decision 4
- **Impact**: status page → "investigating" within 15 min of
  detection; → "identified" within 1h; Twitter post within 4h for
  major incidents; full post-mortem within 5 business days.
  Aggressive but doable for a single operator. Tighter SLAs would
  require a second on-call person.

## 9.2 Pending decisions

**No pending decisions. All §9.1 entries confirmed during the
review pass that closed the spec.**

This section is preserved as an empty placeholder so future review
passes (e.g. v2 protocol bumps, user-facing change requests, etc.)
have a stable anchor for new pending items. If anything appears
here in the future, treat as "not yet confirmed; needs an explicit
operator thumbs-up before implementation."

## 9.3 Deferred to v2

Decisions explicitly punted to a future protocol version. None of
these are required for v1 to ship; they're listed here so the
spec is honest about the trust assumptions v1 carries.

### 9.3.1 Source attestation via `raw_response_hash`

- **Question**: does the leaf hash anchor to the actual vendor HTTP
  response (re-scrapable proof), or to a parsed-fields fingerprint
  (tamper-detection only)?
- **Decision**: v1 anchors a parsed-fields fingerprint. Real source
  attestation is a v2 protocol bump.
- **Source**: §02.4.7 (specifically §4.7.2)
- **Impact**: v1 trust property is "database-integrity attestation,"
  not "vendor-page truth." When v2 ships, it requires (a) modifying
  scrapers to hash canonicalised HTTP response bodies, (b) adding
  a `raw_response_hash` column to `supplier_observations`, (c) a
  spec bump of the leaf canonical form, (d) verifier libraries to
  dispatch on protocol version.

### 9.3.2 Full 256-bit hash for source attestation

- **Question**: when v2 ships source attestation, should the hash
  be 128 bits truncated (current `raw_html_hash` length) or full
  256 bits?
- **Decision**: full 256 bits in v2. The 128-bit truncation in v1
  exists only because of the legacy `supplier_observations` schema.
- **Source**: §02.4.7.3
- **Impact**: storage delta is trivial (32 bytes vs 16 bytes per
  obs). Strengthens collision resistance from ~2⁶⁴ to ~2¹²⁸.

### 9.3.3 Authority pubkey baked into versioned verification library

- **Question**: how do verifier libraries learn the authority pubkey?
- **Decision**: v1 publishes via three external channels (§5.2.4
  v1 model). v2 candidate: pin the pubkey at build time inside the
  versioned `@peptide-oracle/verify` library so consumers pinned
  to a specific library version are immune to runtime pubkey
  substitution.
- **Source**: §05.2.4 v2 candidates
- **Impact**: hardens the trust model from "trust at least one
  channel" toward zero-trust. Library updates that change the
  pubkey require a major version bump.

### 9.3.4 On-chain "genesis" commit announcing authority + protocol version

- **Question**: do we anchor the project's setup metadata on Solana
  itself (rather than just publishing it off-chain)?
- **Decision**: deferred to v2.
- **Source**: §05.2.4 v2 candidates
- **Impact**: a one-time genesis Memo containing
  `{authority_pubkey, protocol_version, effective_at}` becomes the
  bootstrap anchor. Trades operator-publication trust for chain-
  history trust on every subsequent commit. Recommended pairing
  with §9.3.3 since both strengthen the same property.

### 9.3.5 Custom Anchor program (vs Memo program)

- **Question**: does the on-chain commit layer use Solana's SPL
  Memo program or a custom Anchor program?
- **Decision**: v1 uses Memo. Custom program deferred.
- **Source**: parent spec §0 brief — "we're using Memo transactions
  for first version"
- **Impact**: a custom program would let us validate memo bytes
  on-chain (e.g., enforce JSON canonicalization), emit events
  with structured fields, and gate writes through program-derived
  authorities. Bigger surface to audit; not justified at v1 scale.

### 9.3.6 Multi-sig signing

- **Question**: does the committer use multisig instead of a
  single hot wallet?
- **Decision**: v1 single authority. Multisig deferred.
- **Source**: parent spec §0 brief — "single authority for first
  version"
- **Impact**: removes the single-key-compromise blast radius
  documented in §08.10.3. Adds operational complexity (signing
  ceremony per commit), latency, and likely a custom Anchor program
  to coordinate. Worth revisiting if/when the project's commits
  carry meaningful financial value (e.g., they're pulled into smart
  contracts that pay out based on the value).

### 9.3.7 Arweave permanent storage of memos

- **Question**: do we mirror commit memos to Arweave for permanent
  off-chain storage?
- **Decision**: deferred (optional future enhancement noted in
  parent brief).
- **Source**: parent spec §0
- **Impact**: Solana history is technically pruneable beyond the
  current epoch's full retention. Arweave provides a guaranteed-
  permanent mirror at low cost. Not v1-required because Solana
  archive nodes provide sufficient retention for our use case;
  worth revisiting if downstream auditors require offline, indefinite
  proof.

### 9.3.8 TWAP recompute as default verification step

- **Question**: does §05.5.2 `/verify/twap` recompute the TWAP value
  by default, or only when `recompute_twap=true` is requested?
- **Decision**: opt-in for v1 (off by default).
- **Source**: §05.5.2 + §05.3.3
- **Impact**: full TWAP recompute is O(N_observations) work and
  requires implementing the worker's algorithm server-side. Default-
  on would slow down the casual-user explorer button. Default-off
  + opt-in keeps the common case fast while supporting full
  verification when needed.

### 9.3.9 Scheduled annual keypair rotation

- **Question**: do we rotate the authority keypair on a schedule
  even without incident?
- **Decision**: deferred to v2. v1 ships rotation-on-incident only
  (§9.1.20).
- **Source**: §08.6.1 + §08.12 decision 5
- **Impact**: annual scheduled rotation limits the blast-radius
  window of an undetected key compromise from "until next incident"
  to "≤ 12 months." It costs the full §08.6 procedure once per
  year (14-day advance notice + 3-channel publication update +
  drill cost). At single-operator scale the drill value isn't
  enough to justify the cost; v1 defers. The trigger for promoting
  to v1.x: a multi-person team where the drill has training value
  beyond just the rotation itself, OR a clear external compliance
  requirement.

## 9.4 Implementation prerequisites

These need to happen in the operator's hands before any code
implementation kicks off. None are technical decisions; they're
operational setup.

### 9.4.1 Provision a fresh Supabase project

- [ ] Create a new Supabase project for the oracle (separate from
      biohack.market production)
- [ ] Pro tier ($25/month) — covers the storage projections in §07.4.2
- [ ] Enable Point-in-Time Recovery (15-min granularity) — supports
      the §08.10.1 disaster recovery procedure
- [ ] Apply migrations 0001–0030 (existing schema + strip)
- [ ] Apply migration 0031 (commit tracking — currently committed
      to repo but not applied anywhere)
- [ ] Capture `SUPABASE_URL` + `SUPABASE_SECRET_KEY` for env vars

### 9.4.2 BACHEM/SIGMA supplier status update

Per §02.4.8 operational note:

```sql
UPDATE public.suppliers
SET status = 'paused'
WHERE code IN ('BACHEM', 'SIGMA');
```

- [ ] Apply against the new Supabase project (per §9.4.1)
- [ ] Confirm the committer's eligibility filter (§3.2.2)
      consistently excludes their failed-scrape rows

### 9.4.3 Helius account setup

- [ ] Create Helius account at helius.xyz
- [ ] Generate API key for mainnet (and a separate key for devnet
      if testing per §9.5)
- [ ] Capture key for `ORACLE_RPC_URL` env var
- [ ] Bookmark the dashboard for §08.2.1 weekly RPC review

### 9.4.4 Generate + fund oracle keypair

- [ ] Generate keypair offline:
      `solana-keygen new --no-bip39-passphrase --outfile oracle-mainnet.json`
- [ ] Record the public key (will be published per §9.4.7)
- [ ] Fund with 0.5 SOL from operator's funding wallet
- [ ] Securely store the keyfile until §9.4.5 picks it up

### 9.4.5 Configure Railway oracle service

- [ ] Add a fourth Railway service to the existing project:
      `peptide-oracle-oracle`
- [ ] Set source repo + branch (peptide-oracle-pivot) + watch path
      `apps/oracle/**` per §03.1.2 + RAILWAY_DEPLOYMENT.md
- [ ] Set env vars:
  - `ORACLE_SOLANA_PRIVATE_KEY` (base58-encoded secret bytes from
    §9.4.4 keyfile) — **mark as secret in Railway UI** per §03.5.1
  - `ORACLE_RPC_URL` (Helius URL from §9.4.3)
  - `SUPABASE_URL`, `SUPABASE_SECRET_KEY` (from §9.4.1)
  - `HEALTH_PORT` (default 8080)
  - Other tunables per §03.5.3, §03.7, §03.9.2 (most have sensible
    defaults; override only if needed)
- [ ] Audit Railway access list per §03.5.1 requirement (a)
- [ ] Verify env var is masked in dashboard per §03.5.1 requirement (b)

### 9.4.6 Configure Better Stack monitoring + status page

Per §08.9.1:

- [ ] Better Stack account + project for the oracle
- [ ] Heartbeat monitor on `https://oracle.<domain>/health`,
      1-minute interval, 5s response time threshold
- [ ] Failure conditions: HTTP non-200 OR `"ok":false` OR
      `"balance_critical":true`
- [ ] Public status page hosted at `status.<domain>`
- [ ] Alert routing per §08.9.3 (SMS + email for critical, email for
      warning, Slack for info)
- [ ] Test alert delivery (simulate a /health failure to confirm
      SMS arrives)

### 9.4.7 Authority pubkey publication channels

Per §05.2.4 multi-channel publication. **All three must be live
before the first mainnet commit:**

- [ ] **GitHub**: create `docs/oracle-authority.md` in the public
      repo with the mainnet pubkey + initial-publication date
- [ ] **Project social channels**: pinned tweet on the project X
      account citing the pubkey + link to GitHub commit
- [ ] **Documentation site**: stable page citing the pubkey
- [ ] Cross-check all three agree (will become the §08.4.2
      quarterly review item)

The `/api/oracle/info` endpoint serves as the fourth channel
automatically once the API service is running.

### 9.4.8 Operations log + incident folder

- [ ] Create `docs/incidents/` folder in the public repo
      (empty until first incident)
- [ ] Create a private operations log file or notebook for the
      operator's weekly/monthly review notes (§08.2 / §08.3) —
      doesn't need to be public

## 9.5 Pre-mainnet checklist

Before the oracle service starts submitting commits to **mainnet**,
all of the following should be verified. Devnet testing comes
first.

### 9.5.1 Devnet end-to-end test

- [ ] Spin up a separate Railway service pointed at devnet
      (different `ORACLE_RPC_URL`, different `ORACLE_SOLANA_PRIVATE_KEY`,
      different Supabase project or schema)
- [ ] Fund the devnet wallet (devnet faucet is free)
- [ ] Apply migrations 0001–0031 against the devnet Supabase project
- [ ] Trigger a single cycle commit and confirm:
  - [ ] Row appears in `commit_cycles` with `status='pending'`
  - [ ] Row transitions to `submitted` with signature populated
  - [ ] Row transitions to `finalized` with slot populated
  - [ ] On-chain Memo bytes match `memo_payload` byte-for-byte
        (fetch via `getTransaction(signature)`, compare)
- [ ] Trigger a TWAP commit; same end-to-end checks
- [ ] Run a verification through `/api/oracle/verify/observation`
      against the devnet commit; confirm all 10 checks pass
- [ ] Run `/api/oracle/verify/twap` against the devnet TWAP commit;
      confirm constituent observations all verify

### 9.5.2 /health states tested

- [ ] Green state: normal operation, all required fields present
- [ ] Yellow state: simulate by manually setting balance below
      `ORACLE_BALANCE_WARN_SOL`; confirm `balance_low=true` and
      HTTP 200 still
- [ ] Red state: simulate by stopping the service; confirm Better
      Stack alert fires and status page reflects
- [ ] Stale state: simulate by halting the cycle poller for >30 min;
      confirm `cycle.last_commit_at` staleness triggers HTTP 503

### 9.5.3 Long-tail retry tested

- [ ] Simulate an outage: temporarily set `ORACLE_RPC_URL` to a
      bad endpoint so commits fail
- [ ] Confirm cycle commits transition to `failed` after the 5-attempt
      retry budget (§03.7.1)
- [ ] Restore the RPC URL
- [ ] Confirm the long-tail retry job (§03.7.7) re-attempts the
      failed rows on the next hourly tick and they reach `finalized`
- [ ] Confirm `failed_count_24h` returns to 0 in `/health` once
      backlog drains

### 9.5.4 §03.5.1 operational requirements verified for mainnet deploy

- [ ] Railway access list contains only trusted operators
      (re-audit immediately before mainnet cutover)
- [ ] `ORACLE_SOLANA_PRIVATE_KEY` is secret-flagged in Railway UI
      (open the Variables page and confirm the lock icon)
- [ ] Mainnet wallet funded with 0.5 SOL
- [ ] §08.1.2 alert thresholds set as documented (or env-overridden)

### 9.5.5 §9.4.7 publication channels live

- [ ] `docs/oracle-authority.md` committed and pushed to public
      repo branch consumers will read from
- [ ] Pinned tweet visible on the project X account citing the pubkey
- [ ] Documentation site updated with the pubkey
- [ ] All three channels cite the **same** pubkey (final cross-check)

### 9.5.6 Documentation cross-checks

- [ ] `docs/specs/01-onchain-commit-layer.md` overview and all
      subsections committed and pushed (the work product of this
      spec phase)
- [ ] `docs/oracle-gaps.md` exists as an empty-but-published file
      so verifiers know where to look during outages (per §08.7.3)
- [ ] Verifier-facing README explaining how to run a verification
      (links to §05 spec + future client library)

### 9.5.7 Communication readiness

Per §08.11.1 channels:

- [ ] Status page (Better Stack from §9.4.6) is live and publicly
      accessible
- [ ] Operator's phone number is registered with Better Stack for
      SMS alerts (§9.4.6 alert routing test passed)
- [ ] Twitter / X account is reachable and has posting credentials
      stored somewhere the operator can access at 3am
- [ ] An "incident response" doc lives in operator-private notes
      with quick links to: Railway dashboard, Supabase dashboard,
      Helius dashboard, Solscan, Better Stack, Twitter login

### 9.5.8 Final go/no-go

Once §9.5.1 through §9.5.7 are checked:

- [ ] All §9.2 pending decisions explicitly confirmed
- [ ] Mainnet deploy: bump Railway env vars from devnet to mainnet
      (`ORACLE_RPC_URL`, `ORACLE_SOLANA_PRIVATE_KEY`)
- [ ] Restart oracle service
- [ ] Watch logs for first commit on mainnet
- [ ] Verify first mainnet commit end-to-end via
      `/api/oracle/verify/cycles/<id>/observations` + Solscan
- [ ] Public announcement: "oracle is live on mainnet" with
      authority pubkey + link to spec + link to verification API

After 9.5.8: the spec phase is closed. Operations transitions to
the §08 runbook cadence. Implementation tickets get filed against
the locked spec; future protocol-level changes go through a v2
spec document rather than retrofitting v1.
