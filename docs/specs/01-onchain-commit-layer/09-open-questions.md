# 09 — Open questions consolidation

Status: **the closing section of the spec**. Pulls every decision
flagged across §01–§08 into a single review checklist, plus the
operational and pre-mainnet prerequisites that need to be in place
before implementation begins.

This file is meant to be re-read once before implementation kicks
off. Anything in §9.2 (pending) needs explicit confirmation;
anything in §9.4 / §9.5 needs to actually happen in operator-land.

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

## 9.2 Pending decisions

These have a recommended answer in the spec but haven't been
explicitly confirmed during review. Each needs a thumbs-up before
implementation begins. Listed in roughly the order they'd come up
during build-out.

### 9.2.1 Active peptide subset for v1 TWAP commits

- **Question**: which peptides does the committer issue hourly TWAP
  commits for?
- **Recommended**: all `peptides.is_active = true` (currently 26).
  Allow-list filter via env var if we want a smaller launch set.
- **Status**: pending
- **Source**: §03.3.4
- **Impact**: drives daily TWAP-commit count (24 × N peptides). At
  N=26 we hit ~624/day (~768/day total with cycle commits) instead
  of 264/day at v1 = 5 peptides as costed in §07.5. SOL annual
  cost climbs roughly 2.5× but stays under $500/year at $200/SOL.

### 9.2.2 Verification API rate limits: 120 / 60 / 30 req/min/IP

- **Question**: what default per-IP rate limits for the three buckets
  (read-light / read-heavy / verify)?
- **Recommended**: 120 / 60 / 30 as in §05.4.13
- **Status**: pending
- **Source**: §05.7 decision 1
- **Impact**: defines the public API's concurrency ceiling. Env-var
  tunable; can be raised once we observe real traffic.

### 9.2.3 Caching strategy with `immutable` directive

- **Question**: do we put Cloudflare in front of the API service in
  v1, or accept the lower hit rate on Railway's default ingress?
- **Recommended**: defer Cloudflare until verification API traffic
  warrants (§08.8). v1 ships with the cache headers set per
  §05.4.12 even without a CDN — modern browsers + downstream CDNs
  honor them.
- **Status**: pending
- **Source**: §05.7 decision 2 + §08.8
- **Impact**: at v1 scale, no CDN is fine. Adding Cloudflare later
  is a DNS change + cache-rule config; no application changes.

### 9.2.4 Pagination: cursor-based, default 50, max 200

- **Question**: page-size defaults for list endpoints?
- **Recommended**: 50 / 200 with opaque base64 cursors
- **Status**: pending
- **Source**: §05.7 decision 3
- **Impact**: server-side bounds on response size and DB load.
  Easy to dial.

### 9.2.5 Server-side verification helpers ship in v1

- **Question**: do `POST /api/oracle/verify/observation` and
  `/verify/twap` exist in v1, or wait for the client library?
- **Recommended**: ship in v1
- **Status**: pending
- **Source**: §05.5 + §05.7 decision 4
- **Impact**: makes the casual-user explorer button trivial; same
  math as the client library so no extra surface to maintain.
  Without these, the explorer must do the verification client-side
  before any client library exists.

### 9.2.6 Authentication: none for v1

- **Question**: are oracle reads behind any auth?
- **Recommended**: no — all public read.
- **Status**: pending
- **Source**: §05.7 decision 5
- **Impact**: aligns with "the oracle's value is in being verifiable."
  Future paid tier adds API-key auth with boosted rate limits but
  doesn't gate access to data.

### 9.2.7 SOL pre-purchase cadence: quarterly

- **Question**: cadence for restocking the operator's funding wallet?
- **Recommended**: quarterly (every 90 days), buy 0.5–1.0 SOL
- **Status**: pending
- **Source**: §07.7 decision 3 + §08.4.1
- **Impact**: amortizes exchange fees, matches normal financial
  review cadence. Tighter cadence (monthly) is fine if operator
  prefers.

### 9.2.8 Track Helius RPC usage as a separate metric

- **Question**: do we monitor Helius daily request count
  proactively, or wait for rate-limit hits to learn about it?
- **Recommended**: weekly review during v1 rollout, monthly after
  stabilization (§08.2.1 / §08.3.2)
- **Status**: pending
- **Source**: §07.7 decision 4
- **Impact**: gives advance warning before we hit the upgrade
  threshold. The operator burden is low (one dashboard view per
  week).

### 9.2.9 TWAP backfill: NO, document gaps

- **Question**: when commits stop for an extended period, do we
  backfill missed TWAP commits or document the gap?
- **Recommended**: document gaps (in `docs/oracle-gaps.md`); do not
  backfill TWAP commits (cycle commits CAN be caught up via the
  normal poll, since they anchor a finished historical event).
- **Status**: pending — **most consequential decision in §9.2**
- **Source**: §08.7.3 + §08.12 decision 1
- **Impact**: continuous TWAP coverage in the on-chain audit trail
  vs cleaner trust narrative ("if we say it was committed at time T,
  it was actually committed at time T"). Verifiers can recompute
  historical TWAPs from cycle-anchored observations during gaps,
  so users aren't blocked. Open for revision in v2.

### 9.2.10 Status-page tooling: Better Stack

- **Question**: which status-page provider for the operator's
  uptime + status page?
- **Recommended**: Better Stack (free tier, single vendor for
  monitoring + status page, Railway-native)
- **Status**: pending
- **Source**: §08.9.1 + §08.12 decision 2
- **Impact**: alternative is custom `/status` on docs site (more
  control, more maintenance). Switching providers later is a
  DNS change + reconfigure; not load-bearing.

### 9.2.11 Post-mortem threshold: §08.11.3 conditions

- **Question**: when do we publish a post-incident write-up?
- **Recommended**: §08.11.3 conditions (>30min downtime, >10
  failed commits, rotation, external mismatch, downstream
  comms required)
- **Status**: pending
- **Source**: §08.12 decision 3
- **Impact**: balances honesty (publish failures) against operator
  fatigue (write-up for every blip). Write-up-everything is
  unsustainable for a single operator; write-up-only-major risks
  trust loss.

### 9.2.12 Incident communication SLAs: 15 min / 1h / 4h / 5d

- **Question**: time targets for status-page updates, public
  Twitter posts, post-mortem publication?
- **Recommended**: 15 min status-page → "investigating", 1h →
  "identified", 4h Twitter for major incidents, 5 business days
  for post-mortem.
- **Status**: pending
- **Source**: §08.11.2 + §08.12 decision 4
- **Impact**: aggressive but doable for a single operator. Tighter
  SLAs require a second on-call person.

### 9.2.13 Routine keypair rotation: every 12 months

- **Question**: do we rotate the authority keypair on a schedule
  even without incident?
- **Recommended**: yes, annually
- **Status**: pending
- **Source**: §08.6.1 + §08.12 decision 5
- **Impact**: limits blast radius of undetected key compromise.
  Adds operational overhead (full §08.6 procedure + 14-day advance
  notice + 3-channel publication update) once per year. Alternative
  is rotate-on-incident-only — less ops overhead, more risk.

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
