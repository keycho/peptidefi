# Operator setup — BioHash v1 prerequisites

Working checklist for the eight operational prerequisites in §9.4 of
the on-chain commit layer spec. Designed to be readable offline as
you work through each step.

**Project identity:** as of the v=2 protocol bump, the project is
**BioHash** (URL: `biohash.network`). Internal package names
(`@peptide-oracle/*`) and Railway service names
(`peptide-oracle-*`) retain the legacy "peptide-oracle" identifier
to avoid a disruptive rename — that's a follow-up refactor. Every
human-facing surface (memos, /authority endpoint, this doc) uses
the new name.

This file is a working doc, not part of the locked spec. Update it
inline as you progress; commit changes if anything is wrong or out
of date.

---

## At-a-glance summary

| # | prerequisite                       | independent? | ~time   | wait      | cost                |
| - | ---------------------------------- | ------------ | ------- | --------- | ------------------- |
| 1 | Supabase project provisioned       | yes          | 15 min  | ~2 min    | $25/mo Pro tier     |
| 2 | Helius account + API key           | yes          | 5 min   | email     | free tier           |
| 3 | Oracle keypair generated + funded  | yes          | 30 min  | tx confirm| 1.0 SOL one-time (~$200 @ $200/SOL) |
| 4 | BACHEM/SIGMA suppliers paused      | needs #1     | 2 min   | none      | free                |
| 5 | Railway scraper + oracle + api + worker services | needs #1,2,3 | 90 min  | 4 deploys | $20–30/mo marginal  |
| 6 | Mainnet cutover                    | needs #5 + 7d devnet stable | 30 min hands-on | 3-5 day stability period | mainnet keypair + ~0.005 SOL/day |
| 7 | Better Stack monitoring + status   | needs #5     | 45 min  | SMS test  | free tier           |
| 8 | Authority pubkey publication       | needs #3 + #6 | 30 min  | none      | free                |
| 9 | Documentation site live            | yes          | varies  | depends   | free–$X/mo          |

Dependency graph:

```
   #1 Supabase ──────┐
   #2 Helius   ──────┤
   #3 Keypair  ──────┼──▶  #5 Railway  ──▶  #6 Cutover  ──▶  #7 Better Stack
                     │              │           │
                     │              │           └──▶  #8 publication channels
                     │              │
                     └──▶  #4       ▲
                       BACHEM/SIGMA │
                                    │
                       #9 docs site ┘
```

**Recommended execution: 4 sessions over ~10 days.**

- **Day 1 (parallel):** #1 Supabase, #2 Helius, #3 keypair (devnet), #9 docs site setup. Each can be done independently in any order; #1 + #2 + #3 are the gates for downstream work.
- **Day 2:** #4 BACHEM/SIGMA paused, #5 Railway service config + first deploys (devnet shakedown).
- **Day 3-9:** Devnet observation period — let the four services run for at least 7 days of zero-incident operation before #6.
- **Day 10:** #6 mainnet cutover, #7 Better Stack alerts, #8 authority pubkey publication. The 3-5 day post-cutover stability window then runs before the public-launch announcement.

Once all 9 are green, you're at §9.5 pre-mainnet checklist (final
go/no-go gate before the public launch announcement).

---

## 1. Supabase project provisioned

A fresh Supabase project for the oracle, separate from any existing
biohack.market production database.

**Independent.** Can run on Day 1. No dependencies.

**Time:** ~15 minutes hands-on + ~2 minutes provisioning wait.

**Cost:** Pro tier $25/month. Required for v1 storage projections
in §07.4.2 (free tier 500 MB exhausts within ~3 months at 26-peptide
cycle volume).

### Steps

- [ ] Sign in at https://supabase.com/dashboard. Create an account
      if you don't have one (uses GitHub OAuth or email/password).
- [ ] Click **New project**.
- [ ] **Organization**: pick the org you want this billed to (or
      create one — orgs are free containers; only projects cost).
- [ ] **Project name**: something like `peptide-oracle-prod`. The
      name appears in dashboards and is fine to share publicly.
- [ ] **Database password**: generate via password manager (1Password,
      Bitwarden, etc.). 24+ chars, mixed case + symbols. **Store
      this in your password manager immediately** — Supabase doesn't
      let you view it again after creation.
- [ ] **Region**: pick closest to where your Railway services run
      (US East 1 / Northern Virginia is the default for Railway's
      US deployments). Cross-region adds 30–80ms per query.
- [ ] **Pricing plan**: select **Pro** ($25/month). Free tier won't
      survive the storage projection.
- [ ] Click **Create new project**. Wait ~2 minutes for provisioning.

### Capture credentials

Once provisioning completes, navigate to **Project Settings → API**
and capture three values:

- **Project URL** (under "Project URL"): `https://<ref>.supabase.co`.
  Save as `SUPABASE_URL` in your secrets manager.
- **`service_role` key** (under "API keys"): long string starting
  with `sb_secret_…`. Save as `SUPABASE_SECRET_KEY`. **This is the
  master admin key** — anyone with it can read/write any data.
  Treat like the database password.
- **`anon` (publishable) key**: long string starting with
  `sb_publishable_…`. Save as `SUPABASE_PUBLISHABLE_KEY`. Safe to
  expose in client-side code; gated by Row-Level Security.

### Apply migrations

The repo's migrations need to run against the new project. From
your local clone of the `main` branch:

- [ ] Install the Supabase CLI: https://supabase.com/docs/guides/cli/getting-started
- [ ] Link the local repo to the new project:
      `supabase link --project-ref <ref>` (the ref is the part
      before `.supabase.co` in the project URL).
- [ ] Apply migrations: `supabase db push`. This runs every file in
      `packages/db/migrations/` in numeric order — that includes the
      0030_strip_trading_layer.sql (drops the trading tables that
      were never created on a fresh DB anyway, idempotent) and the
      0031_add_commit_tracking.sql (creates `commit_cycles`,
      `twap_commits`, `commit_observations`).

### Enable Point-in-Time Recovery

Per §08.10.1 disaster recovery — the 7-day daily-backup default is
what you get free; PITR (15-minute granularity) is required for the
recovery time objectives in the runbook.

- [ ] **Project Settings → Database → Point-in-time recovery →
      Enable**. Adds ~$60/month at the smallest retention; check
      Supabase pricing page for current numbers.
- [ ] Note: you can skip PITR for the initial setup and add it
      before the §9.5 pre-mainnet gate. Just don't ship to mainnet
      without it.

### Verification

- [ ] Open the dashboard's SQL Editor, run:

      ```sql
      SELECT count(*) FROM public.peptides;
      SELECT count(*) FROM public.suppliers;
      SELECT count(*) FROM public.commit_cycles;  -- should return 0; table exists
      ```

      All three should run without error. Counts may be 0 if you
      haven't seeded peptide / supplier data yet — that's expected
      on a fresh DB.

- [ ] Confirm RLS is enabled on the new commit-tracking tables:

      ```sql
      SELECT relname, relrowsecurity
      FROM pg_class
      WHERE relname IN ('commit_cycles', 'twap_commits', 'commit_observations');
      ```

      All three should show `relrowsecurity = true`.

### Common failure modes

- **Region mismatch with Railway services.** If Railway is `us-east`
  and Supabase is `eu-west`, every query crosses the Atlantic.
  Pick matching regions even if Supabase has a closer-feeling
  option.
- **Free tier accidentally selected.** The default plan picker may
  show free first. At v1=26 peptides storage hits 500 MB free tier
  in ~3 months; you'll be migrating during a busy moment.
- **Database password not captured.** Supabase only shows it once.
  If you skip the password manager step, you'll need to reset it
  via the dashboard later (which invalidates anything that cached
  it).
- **Migrations applied to the wrong project.** Easy to do if you
  have multiple projects linked. Always verify the link target with
  `supabase status` before `supabase db push`.

---

## 2. Helius account + API key

Helius is the Solana RPC provider chosen in §03.6.1. Free tier
covers v1 with ~8× headroom.

**Independent.** Can run on Day 1.

**Time:** ~5 minutes hands-on. Email confirmation may add 1–5 min wait.

**Cost:** Free tier (100,000 requests/day, sufficient for v1).
Upgrade trigger documented in §07.3.5.

### Steps

- [ ] Go to https://www.helius.dev/.
- [ ] **Sign up** with Google or email/password. Email confirmation
      arrives within a couple of minutes; click the link.
- [ ] Once logged in, the dashboard shows a default API key.
- [ ] **Optionally** rename the default key to something descriptive
      like `peptide-oracle-mainnet`. Click the pencil icon next to
      the key name.
- [ ] **Recommended**: create a second API key named
      `peptide-oracle-devnet` for §9.5.1 devnet testing. Helius free
      tier supports both clusters under one account.

### Capture credentials

The full RPC URL (with the API key embedded) is what you'll set in
Railway. Format:

```
https://mainnet.helius-rpc.com/?api-key=<YOUR_API_KEY>
```

For devnet:

```
https://devnet.helius-rpc.com/?api-key=<YOUR_DEVNET_API_KEY>
```

- [ ] Save the mainnet URL as `ORACLE_RPC_URL` in your secrets
      manager.
- [ ] Save the devnet URL as `ORACLE_RPC_URL_DEVNET` (used during
      §9.5.1 devnet testing only).

### Verification

- [ ] Test the URL works:

      ```bash
      curl -s https://mainnet.helius-rpc.com/?api-key=<YOUR_KEY> \
        -H 'Content-Type: application/json' \
        -d '{"jsonrpc":"2.0","id":1,"method":"getSlot","params":[]}'
      ```

      Should return JSON like
      `{"jsonrpc":"2.0","result":287192831,"id":1}`. The slot number
      will be much larger; just confirm it's a positive integer and
      you didn't get an error.

- [ ] On the Helius dashboard, you should see this request register
      under **Usage**.

### Common failure modes

- **Confusing devnet and mainnet keys.** Both are valid, both look
  identical structurally. If the oracle ever ends up running with
  the devnet key on mainnet (or vice versa), commits silently land
  on the wrong cluster. Always check the URL hostname:
  `mainnet.helius-rpc.com` vs `devnet.helius-rpc.com`.
- **Hardcoding the API key in code.** Always env-var. Helius's
  dashboard does support key rotation if a leak is suspected.
- **Hitting the rate limit during testing.** Free tier is 100k/day,
  but burst limits exist (~10–20 req/sec). If you're scripting
  against Helius repeatedly during setup, slow down.

---

## 3. Oracle keypair generated + funded

**This is the most security-sensitive prerequisite.** Read the whole
section before starting; mistakes here are expensive (lost SOL) or
catastrophic (compromised oracle authority).

**Independent.** Can run on Day 1.

**Time:** ~30 minutes hands-on, plus ~30 seconds for the funding tx
to confirm.

**Cost:** 1.0 SOL one-time fund (~$200 at $200/SOL). Plus ~$0.0001
in transfer fees.

### Why this matters

Per §03.5.1 and §08.10.3 — anyone with this private key can sign
commits as the oracle authority. A compromised key means an
attacker can mint fake commits attributed to your project until you
detect and rotate. The §03.5.1 mitigations (dedicated wallet,
minimal SOL, single-purpose) bound the blast radius but don't
eliminate it.

### Pre-flight: install solana CLI

- [ ] Install solana-cli following https://docs.solana.com/cli/install-solana-cli-tools.
      One-liner for macOS / Linux:

      ```bash
      sh -c "$(curl -sSfL https://release.solana.com/stable/install)"
      ```

- [ ] Verify: `solana --version` shows something like `solana-cli 1.18.x`.

### Generate the keypair (security-conscious procedure)

- [ ] Pick a working directory you control. **Don't use a folder
      synced to iCloud / Dropbox / Google Drive** — those services
      replicate the keyfile to cloud storage you don't fully control.

      ```bash
      mkdir -p ~/oracle-keys && cd ~/oracle-keys
      ```

- [ ] Generate the keypair without a BIP39 passphrase:

      ```bash
      solana-keygen new --no-bip39-passphrase --outfile oracle-mainnet-2026-XX.json
      ```

      Replace `2026-XX` with the current year-month (e.g., `2026-05`).
      Including the date in the filename makes future rotations
      easy to track.

- [ ] **Important note on `--no-bip39-passphrase`:** this skips the
      optional passphrase that would encrypt the keyfile at rest.
      The trade-off:

      - WITH passphrase: file is useless without the passphrase, but
        the passphrase becomes a critical secret that, if lost,
        permanently destroys the keypair. For a hot wallet that
        signs every 10 minutes, the friction of typing a passphrase
        on every restart isn't worth it.
      - WITHOUT passphrase (chosen): file alone is the secret.
        Protected by filesystem permissions and disk encryption.

      Disk encryption is required. Confirm your machine has FileVault
      (macOS) or LUKS / BitLocker (Linux/Windows) enabled before
      proceeding.

- [ ] Lock down filesystem permissions:

      ```bash
      chmod 600 oracle-mainnet-2026-XX.json
      ```

- [ ] Capture the **public key** for publication later (§9.4.7 below):

      ```bash
      solana-keygen pubkey oracle-mainnet-2026-XX.json
      ```

      The output is a 32–44 character base58 string like
      `5VfYTAH...QwErTy`. Save this as `ORACLE_AUTHORITY_PUBKEY` in
      your password manager. **This is safe to share publicly** —
      it's literally what you'll publish in §9.4.7.

- [ ] Convert the secret key to base58 for the Railway env var.
      Solana-keygen produces a JSON array of bytes; the convention
      in the spec (§03.5.1) is base58. One way using Python:

      ```bash
      pip install base58  # one-time install
      python3 -c "
      import json, base58, sys
      with open(sys.argv[1]) as f:
          secret = bytes(json.load(f))
      print(base58.b58encode(secret).decode())
      " oracle-mainnet-2026-XX.json
      ```

      Or with Node.js:

      ```bash
      npm install -g bs58
      node -e "
      const fs = require('fs');
      const bs58 = require('bs58');
      const k = JSON.parse(fs.readFileSync(process.argv[1]));
      console.log(bs58.default.encode(Buffer.from(k)));
      " oracle-mainnet-2026-XX.json
      ```

      Output is an 87–88 character base58 string. **This is the
      `ORACLE_SOLANA_PRIVATE_KEY` value for Railway.** Treat with
      the same care as the keyfile itself.

      Save in your password manager. **Do not paste anywhere
      public, do not commit, do not log.**

### Backup the keyfile

Single point of failure: if you lose the keyfile and the password
manager entry, the keypair is gone forever and you'll need to
follow §08.10.2 (lost authority key without rotation) which is the
hard incident.

- [ ] Copy the keyfile to **at least one** offline location:
      - Encrypted USB drive in a safe / lock box
      - Printed and stored physically (paper backup using a tool
        like https://github.com/paperwallet-org/paperwallet — the
        keyfile is JSON, ~200 chars; readable from print)
- [ ] **Do not** back up to cloud storage or messaging apps.
      Filesystem on the operator's primary machine + one offline
      backup is the right surface area.

### Fund the keypair

- [ ] From your operator funding wallet (Phantom, Backpack,
      Solflare, or the Solana CLI itself), send **1.0 SOL** to the
      `ORACLE_AUTHORITY_PUBKEY` from above.
- [ ] **Triple-check the pubkey before sending.** Solana has no
      "send to wrong address" recovery. Best practice: copy-paste
      the pubkey and visually compare the first 6 and last 4
      characters before clicking confirm.
- [ ] Wait for confirmation (typically <30 seconds).

### Verification

- [ ] Confirm balance via the explorer:

      ```bash
      solana balance <ORACLE_AUTHORITY_PUBKEY> --url mainnet-beta
      ```

      Should show `1 SOL`.

- [ ] Or visit
      `https://solscan.io/account/<ORACLE_AUTHORITY_PUBKEY>` and
      confirm the balance shows.

- [ ] Confirm the address shows zero outgoing transactions (it's
      brand new — only the funding deposit should be visible).

### Common failure modes

- **Sending to wrong address.** Most expensive mistake. The 1.0 SOL
  is gone. Mitigation: copy-paste, never hand-type pubkeys; and
  send a test transaction of 0.001 SOL first to confirm the address
  is reachable.
- **Backing up to cloud sync during use.** iCloud / Dropbox grabs
  the file the moment it's written. Move the keyfile into the
  working directory only AFTER confirming sync exclusions, or work
  in a directory outside synced paths.
- **Forgetting the offline backup.** Single-copy means single point
  of failure. The §08.10.2 lost-key procedure is publicly
  embarrassing and time-sensitive.
- **Confusing public vs private key.** Pubkey starts with random
  base58, ~44 chars. Private key (after base58 conversion) is ~88
  chars. Both look like base58 strings; if you paste the wrong one
  somewhere, the consequences differ enormously.
- **Using `--no-bip39-passphrase` then losing disk encryption.** A
  stolen / lost laptop without disk encryption gives the thief the
  full keyfile. FileVault / BitLocker / LUKS are non-negotiable.

---

## 4. BACHEM / SIGMA suppliers paused

Updates `suppliers.status` from `'active'` to `'paused'` for the two
suppliers whose scrapers never produce successful observations
(per §02.4.8 operational note).

**Depends on #1** (Supabase project + migrations live).

**Time:** ~2 minutes.

**Cost:** Free.

### Steps

- [ ] In the Supabase dashboard, **SQL Editor → New query**.

- [ ] Paste:

      ```sql
      UPDATE public.suppliers
      SET status = 'paused'
      WHERE code IN ('BACHEM', 'SIGMA');
      ```

- [ ] Click **Run**. Two rows should be updated.

### Verification

- [ ] Run:

      ```sql
      SELECT code, status FROM public.suppliers
      WHERE code IN ('BACHEM', 'SIGMA', 'CAYMAN')
      ORDER BY code;
      ```

      Expected: all three show `status = 'paused'`. (CAYMAN was
      already paused per migration 0009.)

- [ ] As a sanity check, confirm at least one of the actively-
      scraping suppliers stayed `active`:

      ```sql
      SELECT code, status FROM public.suppliers
      WHERE code = 'PUREHEALTH';
      ```

      Should show `status = 'active'`.

### Common failure modes

- **Running on the wrong database.** Always confirm the SQL Editor
  in the dashboard is the new oracle Supabase project (check the
  project name in the top-left), not the legacy biohack production
  database.
- **Typo in supplier code.** The codes are case-sensitive and
  uppercase by convention. `'bachem'` won't match.

---

## 5. Railway services configured (scraper + oracle + api + worker)

The scraper, oracle, verification api, and TWAP worker deploy as
**four separate Railway services in one Railway project**, all
built from the `keycho/peptidefi` monorepo. The scraper runs
continuously, writing observation rows to Supabase. The worker also
runs continuously (per-minute), computing time-weighted averages
from those observations and writing `peptide_twaps` rows. The
oracle picks up scrape cycles + the latest `peptide_twaps` rows,
builds the canonical Merkle roots + memos, and submits them to
Solana. The api serves read-only verification endpoints over HTTPS
that let downstream consumers (the frontend, third-party
integrators, paranoid verifiers) walk from any observation back to
its on-chain commit.

The compute layer (worker) is **decoupled** from the commit layer
(oracle). Worker writes `peptide_twaps` continuously at per-minute
cadence; oracle's twap-poller harvests one row per active peptide
per hour at HH:00:30 UTC for on-chain commit. This lets the api
serve a fresh TWAP at any moment (worker's most recent row) while
keeping on-chain footprint bounded (one commit per peptide per
hour). See §3.3 of the spec for the architecture rationale.

**Depends on #1, #2, #3.** (BACHEM/SIGMA pause #4 should also be
done before the scraper starts so the first scrape doesn't waste
time hammering blocked vendors.)

**Time:** ~90 minutes hands-on, plus ~3–5 min per service's first
build.

**Cost:** $20–30/month marginal — Railway's $5/service Hobby tier
× 4 services. Compute is trivial across all four; ingress/egress
is dominated by the Solana submit traffic at ~6 cycle commits/hour
+ ~26 TWAP commits/hour. The api's read traffic is bounded by the
frontend's polling cadence — at v1 volumes (~hundreds of
/v1/cycles requests/day) it's negligible.

**State you should be in before starting #5:**

- New Supabase project from #1 exists at
  `mnquozxfniasbpaavcos.supabase.co`, all migrations 0001–0032
  applied.
- Helius account from #2 exists and you have a working API key
  (the same key works for devnet + mainnet).
- Devnet keypair from #3 exists, base58 secret captured to your
  password manager, devnet pubkey captured separately, and the
  pubkey has been airdropped at least 1 SOL on devnet.
- BACHEM/SIGMA pause from #4 has been applied.

If any of those are missing, finish them before continuing — the
runbook below assumes they're done.

> **Note on the earlier setup.** The previous biohack.market
> Railway deployment (api/scraper/worker against
> `pjsjaspntdjecfitogtc.supabase.co`) was deleted entirely. This
> §5 documents fresh deploys from scratch. The legacy Supabase
> project is preserved read-only — do not point the new services
> at it.

> **Worker service deferred.** The `apps/worker/` service
> (computes `peptide_twaps` from `supplier_observations` every
> minute) is NOT in scope for this §5. Without the worker
> running, no `peptide_twaps` rows are produced, so the oracle's
> TWAP-commit poller will log heartbeats but find nothing to
> commit (cycle commits still flow normally). Add the worker as
> a third Railway service when you're ready to anchor TWAPs;
> env-var shape mirrors the scraper's (same `SUPABASE_URL` +
> `SUPABASE_SECRET_KEY`).

### 5.1 Railway prerequisites

- [ ] **Account.** Sign up at https://railway.com/ if you don't
      have one. The Hobby plan ($5/seat/month) is fine for v1;
      includes $5 of usage per service per month, which covers a
      24/7 scraper + oracle at our cadence. Pro is overkill until
      you need multi-region or higher concurrent build slots.

- [ ] **GitHub OAuth.** From the Railway dashboard top-right →
      **Account Settings → GitHub**, authorize Railway against
      your GitHub account and grant access to the
      `keycho/peptidefi` repo specifically. (Railway can also do
      org-wide install; per-repo is tighter and recommended for
      production secrets-bearing services.)

- [ ] **Create a project.** Dashboard → **New Project →
      Empty Project**. Name it `peptide-oracle` (or whatever you
      already use; the project itself just groups services).

- [ ] **Decide on a deploy branch.** Until the work merges to
      `main`, point both services at
      `claude/peptidefi-season-1-Hae69`. After merge, switch
      both to `main` simultaneously (Railway → service Settings
      → Source → branch).

### 5.2 Scraper service

**Deploy this first.** The oracle cycle-poller has nothing to
pick up until the scraper has written at least one
`scraper_runs` row with `status='completed'` (or `'partial'`)
and ≥1 successful observation. With the scraper already running
when you bring up the oracle, the first oracle tick will
immediately find work.

#### Steps

- [ ] **Project → New Service → Deploy from GitHub repo**.
      Select `keycho/peptidefi` and the branch chosen in §5.1.

- [ ] **Service name**: `peptide-oracle-scraper` (matches the
      historical naming pattern; Railway lets you rename later
      if needed).

- [ ] **Settings → Source**:
      - Root directory: `/` (the monorepo root — the Dockerfile
        needs access to `packages/` and the workspace lockfile).
      - Watch paths (avoid redeploys when the oracle changes):
        - `apps/scraper/**`
        - `packages/**`
        - `pnpm-lock.yaml`
        - `pnpm-workspace.yaml`

- [ ] **Settings → Build**:
      - Builder: Dockerfile
      - Dockerfile path: `apps/scraper/Dockerfile`

- [ ] **Settings → Networking**: the scraper has a `/health`
      endpoint but no public surface beyond that. **Don't
      generate a public domain** unless you specifically want to
      hit `/health` from outside Railway. The Railway internal
      healthcheck (configured by `apps/scraper/railway.json`)
      reaches it on the private network.

#### Set environment variables

In **Settings → Variables**, add the following one by one. Mark
secrets with the lock icon (top-right of each variable's edit
row). The canonical list is in `apps/scraper/.env.example` —
this table is the operator-facing summary.

| variable | value | secret? |
|---|---|---|
| `SUPABASE_URL` | `https://mnquozxfniasbpaavcos.supabase.co` | no |
| `SUPABASE_SECRET_KEY` | service-role key from §1 (`sb_secret_…`) | **YES** |
| `HEALTH_PORT` | `8080` | no |
| `SCRAPER_CYCLE_INTERVAL_MS` | `600000` (10 min recommended for v1; 60000 = 1 min once vendors aren't rate-limiting) | no |
| `SCRAPER_USE_PROXY` | `false` (start without proxy; flip to `true` only if Railway's egress IPs get datacenter-flagged by vendor anti-bot) | no |
| `SCRAPINGANT_API_KEY` | leave unset unless `SCRAPER_USE_PROXY=true` | **YES (when set)** |
| `GIT_SHA` | `${{RAILWAY_GIT_COMMIT_SHA}}` (Railway interpolates the actual commit; recorded in `scraper_runs.git_sha` for incident triage) | no |
| `HOST_OVERRIDE` | optional; leave blank to fall back to `os.hostname()` | no |
| `NODE_ENV` | `production` | no |

#### What you should expect on first boot

Click **Deploy**. Railway pulls the repo, runs `docker build`
against `apps/scraper/Dockerfile`, then `pnpm start`. **Build
time:** ~2–4 min for the cold cache; subsequent builds reuse
layers in ~30–60s.

Healthy startup logs (first few lines):

```
[startup] health endpoint on :8080/health
[startup] scraper looping on 600000ms interval (--once for a single cycle)
[cycle] run=<RUNID> status=completed <S>/<N> ok 0 failed <Xms>ms proxy=off
```

Each cycle line lands every `SCRAPER_CYCLE_INTERVAL_MS` (10 min
default).

#### Verification

- [ ] First cycle completes within ~10 minutes of deploy.

- [ ] In Supabase Dashboard → Table Editor → `scraper_runs`, you
      see at least one row with `status='completed'` (or
      `'partial'` if some vendors block) and `finished_at` set.

- [ ] In Supabase Dashboard → Table Editor →
      `supplier_observations`, you see ≥1 row whose
      `scraper_run_id` matches that scraper_runs row, with
      `scrape_success=true`.

If `status='failed'` or all observations have
`scrape_success=false`, vendors are blocking Railway's egress IP.
Mitigations:

- Try again in an hour (Cloudflare/Sucuri rate-limit windows
  reset).
- Set `SCRAPER_USE_PROXY=true` and add a `SCRAPINGANT_API_KEY`
  (paid plan; ~$25/mo for our cadence).
- Re-deploy the service to a different Railway region (Settings
  → Region) — different egress IP pools.

#### Common failure modes

- **`SUPABASE_URL` typo points at the legacy biohack.market
  project.** Symptom: scraper startup succeeds but writes go to
  the wrong project. Pin `mnquozxfniasbpaavcos` in the env var
  and double-check before saving.
- **`SUPABASE_SECRET_KEY` is the anon key, not service-role.**
  Symptom: writes fail with RLS errors despite the env var being
  set. The service-role key is the one with `service_role` JWT
  claim and bypasses RLS — fetch it from
  Dashboard → Project Settings → API → "service_role secret",
  not the anon-key row.
- **Watch paths too narrow.** Forgetting `packages/**` means a
  shared-package change won't trigger a scraper redeploy. Stale
  `@peptide-oracle/shared` produces hard-to-debug runtime
  errors.

### 5.3 Oracle service

Deploy this **after** the scraper has produced at least one
qualifying `scraper_runs` row. With work already queued, the
oracle's first tick picks it up immediately and you see the
full lifecycle play out within ~30s.

#### Note on deploy state

The oracle service in `apps/oracle/` is implemented and ready to
deploy as of Phase D (cycle commits + TWAP commits both verified
end-to-end on devnet). The Dockerfile at `apps/oracle/Dockerfile`
and the `apps/oracle/railway.json` config (Dockerfile builder,
`pnpm start` start command, `/health` healthcheck) are wired so
Railway can deploy directly from the deploy branch chosen in §5.1.

**Devnet vs mainnet.** Production deployment to mainnet should
come AFTER a sustained devnet run with real scraped data — at
minimum, observe several hours of cycle commits without errors.
For a devnet shakedown deployment, set `ORACLE_RPC_URL` to the
Helius devnet endpoint (see env table below) and **use a
separate keypair from the production-published authority**
(`docs/oracle-authority.md`). Devnet signatures are auditable
on the devnet cluster and should never share a pubkey with the
production attestation key.

#### Steps

- [ ] **Project → New Service → Deploy from GitHub repo**.
      Same repo and branch as the scraper.

- [ ] **Service name**: `peptide-oracle-oracle`.

- [ ] **Settings → Source**:
      - Root directory: `/`.
      - Watch paths: `apps/oracle/**`, `packages/**`,
        `pnpm-lock.yaml`, `pnpm-workspace.yaml`.

- [ ] **Settings → Build**:
      - Builder: Dockerfile
      - Dockerfile path: `apps/oracle/Dockerfile`.

- [ ] **Settings → Networking**:
      - Public Networking → **Generate domain**. Take the default
        `*.up.railway.app` URL or attach a custom domain like
        `oracle.<your-domain>`. The custom domain is preferred
        for the §9.4.7 publication channels — public-facing URL
        stays stable across Railway redeployments.

#### Set environment variables

In **Settings → Variables**, add the following one by one. Mark
secrets with the lock icon as you add them.

| variable                          | value                                                                                                                | secret? |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ------- |
| `ORACLE_SOLANA_PRIVATE_KEY`       | base58 64-byte secret from §3 (devnet shakedown: a SEPARATE devnet-only keypair, NOT the production-published one)   | **YES** |
| `ORACLE_RPC_URL`                  | Helius URL — **devnet:** `https://devnet.helius-rpc.com/?api-key=<KEY>` ; **mainnet:** `https://mainnet.helius-rpc.com/?api-key=<KEY>` | **YES** |
| `SUPABASE_URL`                    | `https://mnquozxfniasbpaavcos.supabase.co` (the new peptide-oracle project from §1)                                  | no      |
| `SUPABASE_SECRET_KEY`             | service-role key from §1 (same value as the scraper's)                                                               | **YES** |
| `ORACLE_DATABASE_URL`             | Supabase **session-mode** Postgres URL (port 5432, NOT pooler-transaction port 6543). Format: `postgresql://postgres.<ref>:<password>@aws-1-<region>.pooler.supabase.com:5432/postgres` | **YES** |
| `HEALTH_PORT`                     | `8080`                                                                                                               | no      |
| `ORACLE_BALANCE_WARN_SOL`         | `0.30` (per §07.2.2 26-peptide tuning)                                                                               | no      |
| `ORACLE_BALANCE_CRITICAL_SOL`     | `0.15`                                                                                                               | no      |
| `ORACLE_MIN_STARTUP_BALANCE_SOL`  | `0.05` (refuse to start below this — catches misconfigured deploys before they generate failure waves)               | no      |
| `ORACLE_MAX_TOTAL_RETRIES`        | `20` (Phase C — hard cap across in-flight + long-tail retries)                                                       | no      |
| `ORACLE_LONG_TAIL_INTERVAL_MS`    | `3600000` (1h — sweep cadence for §3.7.7 long-tail retries)                                                          | no      |
| `PEPTIDE_ORACLE_AUTHORITY_PUBKEY` | the pubkey derived from `ORACLE_SOLANA_PRIVATE_KEY` (used as a startup cross-check; mismatch → service refuses to start) | no      |
| `NODE_ENV`                        | `production`                                                                                                         | no      |

#### What you should expect on first boot

Healthy startup logs:

```
[startup] oracle service starting (node=v20.x.x env=production)
[startup] oracle wallet: <DEVNET PUBKEY>
[startup] rpc=helius supabase=mnquozxfniasbpaavcos.supabase.co
[startup] balance thresholds: warn<0.3 SOL critical<0.15 SOL min-startup<0.05 SOL
[startup] health endpoint on :8080/health
[startup] wallet balance: 1.000000 SOL (>= 0.05 SOL min)
[startup] advisory lock acquired (single-instance enforced)
[cycle-poller] started (interval=30000ms, phase C: full lifecycle pending → submitted → finalized)
[twap-poller] started (tick=60000ms, enqueue at HH:00:30 UTC)
[long-tail] started (interval=3600000ms, maxTotalRetries=20)
```

If the scraper has already committed a cycle row before the
oracle starts, expect the next tick to log the lifecycle:

```
[cycle-poller] cycle_id=<N> obs=<K> root=0x… memo_bytes=224
[cycle-poller] cycle_id=<N> SUBMITTED sig=<SIG> priorityFee=1000µlamports/CU
[cycle-poller] cycle_id=<N> FINALIZED slot=<SLOT> sig=<SIG>
```

**Build time:** ~3–5 min cold; ~30–60s incremental.

#### Verification

- [ ] **Logs** show all four lines from the healthy startup
      transcript above.

- [ ] **`/health` endpoint** responds with HTTP 200:

      ```bash
      curl https://oracle.<domain>/health | jq
      ```

      Should return the §03.9.2 health snapshot with all required
      fields. `wallet.public_key` matches your devnet pubkey,
      `wallet.balance_sol` ≈ 1.0.

- [ ] **`PEPTIDE_ORACLE_AUTHORITY_PUBKEY` env var matches the
      `wallet.public_key` from `/health`.** If this fails the
      service crashes at startup with `[fatal] Authority pubkey
      mismatch` — fix the env var and redeploy.

- [ ] **First cycle commit lands within ~30s of the scraper
      writing a qualifying row.** Verify by polling
      `commit_cycles` in Supabase: a row appears with the same
      `cycle_id` as the scraper run, `status='pending'` first,
      then `'submitted'` with `solana_signature` set, then
      `'finalized'` with `solana_slot` set.

- [ ] **Solscan devnet URL works.** Open
      `https://solscan.io/tx/<SIG>?cluster=devnet` (substitute
      the `solana_signature` from the row); the tx page shows
      one ComputeBudget price ix, one ComputeBudget limit ix,
      and one Memo ix. The Memo ix's "Memo" field is the
      canonical JSON memo body; should byte-exactly match
      `commit_cycles.memo_payload` for that row.

#### Common failure modes

- **Env var not flagged as secret.** `ORACLE_SOLANA_PRIVATE_KEY`,
  `SUPABASE_SECRET_KEY`, `ORACLE_RPC_URL` (because the API key is
  embedded in the URL), and `ORACLE_DATABASE_URL` (database
  password embedded) all need the lock icon. Without it, the
  value appears in plain text in the dashboard and shows up in
  redeploy diff logs.
- **Wrong root directory.** If you set root to `apps/oracle/`,
  the Dockerfile won't find `packages/` and `pnpm-workspace.yaml`,
  and the build fails with module-resolution errors.
- **Watch paths missing `packages/**` or `pnpm-lock.yaml`.** The
  service won't redeploy when shared dependencies change, leading
  to stale-package mysteries during development.
- **`ORACLE_DATABASE_URL` points at port 6543 (transaction-mode
  pooler) instead of 5432 (session-mode).** Symptom: oracle
  startup logs show advisory-lock acquisition succeeded, but
  subsequent ticks log `pg_try_advisory_lock returned false`
  intermittently. Transaction-mode pooler releases the lock
  between statements; the oracle MUST use session-mode (port
  5432).
- **Custom domain DNS not propagated.** A custom domain
  (`oracle.<your-domain>`) needs a CNAME record pointing at
  Railway's edge. Propagation can take 5–60 min. If you publish
  the domain to verifiers before propagation, they get NXDOMAIN
  and refuse to verify.
- **Adding the secret env vars in screen-share / pair-programming
  context.** Don't paste these where someone else can see them.
  Set them solo.
- **Mainnet Helius URL set on a devnet shakedown service.** The
  cluster is implied by the URL — there's no runtime
  cluster-selector flag — so a fat-finger of `mainnet.helius-rpc.com`
  on the devnet shakedown service would submit a real mainnet
  tx signed by your devnet key. Read the URL twice before
  saving.

### 5.4 Verification API service

Deploy this **after** the oracle has finalized at least one cycle
commit. The api is a read-only HTTPS surface over the same Supabase
project + the same Solana cluster the oracle writes to — it has no
signing keys, no DB writes, and its security profile is much lower
than the oracle's. Restart impact is also low: a redeploy briefly
returns 502s but causes no data inconsistency.

#### Note on deploy state

The verification API in `apps/api/` ships nine endpoints per spec
§05.4 + §05.5: trust-anchor (`/authority`), oracle health
(`/v1/status`), discovery + history (`/v1/peptides`,
`/v1/peptides/:id`), commit reads (`/v1/cycles`, `/v1/cycles/:id`,
`/v1/observations/:id`, `/v1/twaps/:id`), and a server-side
end-to-end verifier (`/v1/verify/observation/:id`) that runs all
eight §5.5.1 checks including byte-exact on-chain memo comparison.
The Dockerfile at `apps/api/Dockerfile` and `apps/api/railway.json`
(Dockerfile builder, `pnpm start` start command, `/health`
healthcheck, 30s timeout) are wired to deploy directly from the
deploy branch chosen in §5.1.

The api inherits the oracle's `cluster` choice — if the oracle is
running on devnet, the api should point at devnet too. The
`/authority` endpoint advertises the cluster + signing pubkey
publicly, so a devnet-shakedown api advertises the **devnet** key
(not the production-published one). That's intentional: it lets
verifiers learn the test environment's trust anchor without
manually configuring it.

#### Steps

- [ ] **Project → New Service → Deploy from GitHub repo**.
      Same repo and branch as scraper + oracle.

- [ ] **Service name**: `peptide-oracle-api`.

- [ ] **Settings → Source**:
      - Root directory: `/`.
      - Watch paths: `apps/api/**`, `packages/**`,
        `pnpm-lock.yaml`, `pnpm-workspace.yaml`.

- [ ] **Settings → Build**:
      - Builder: Dockerfile
      - Dockerfile path: `apps/api/Dockerfile`.

- [ ] **Settings → Networking**:
      - Public Networking → **Generate domain**. The api needs a
        public URL — this is what the frontend hits. Take the
        default `*.up.railway.app` URL or attach a custom domain
        like `api.<your-domain>`. Custom domain is preferred long-
        term: it's part of §07 / §09.4.7 publication channels and
        stable across Railway redeploys.

#### Set environment variables

In **Settings → Variables**, add the following one by one. Mark
secrets with the lock icon as you add them.

| variable                          | value                                                                                                                | secret? |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ------- |
| `SUPABASE_URL`                    | `https://mnquozxfniasbpaavcos.supabase.co` (same as scraper / oracle)                                                | no      |
| `SUPABASE_SECRET_KEY`             | service-role key from §1 (same value as scraper / oracle; the api uses it for trusted reads, not writes)             | **YES** |
| `ORACLE_RPC_URL`                  | Same Helius URL as the oracle service. **devnet:** `https://devnet.helius-rpc.com/?api-key=<KEY>` ; **mainnet:** `https://mainnet.helius-rpc.com/?api-key=<KEY>`. The api makes read-only `getTransaction` / `getBalance` / `getSignaturesForAddress` calls — no signing, no submit. | **YES** |
| `PEPTIDE_ORACLE_AUTHORITY_PUBKEY` | Same pubkey as the oracle service's matching env var. The api returns this on `GET /authority` and checks the `signer_matches_authority` step in `/v1/verify/*`. **Mismatch with the oracle** → every verification fails the signer check; the value MUST be identical between services. | no      |
| `API_PORT`                        | `3000` (Railway also auto-injects `PORT`, which takes precedence; setting `API_PORT` keeps the local-dev workflow consistent)                                                                | no      |
| `CORS_ORIGINS`                    | comma-separated extra origins to allow beyond the baked-in localhost + `*.lovable.{app,dev,project.com}` patterns; leave blank for v1 unless you need a staging custom domain | no      |
| `NODE_ENV`                        | `production`                                                                                                         | no      |

⚠ **`PEPTIDE_ORACLE_AUTHORITY_PUBKEY` consistency.** The api and
oracle services need this set to the **same value**. The simplest
operational pattern: when you generate the devnet keypair (§3,
sub-bullet about devnet shakedown), capture the pubkey to your
password manager and paste it into both services. A future Railway
"shared variable" feature would let us reference this from one
place; until then, a single typo on either side breaks every
verification with `signer_matches_authority: false`.

#### What you should expect on first boot

Healthy startup logs:

```
[startup] api listening on :3000, /health on same port, auth=jose-ES256-jwks
```

(Single line — the api has no pollers, no startup checks beyond
binding the port. Express + the lazy supabase / Solana clients
mean the first request triggers actual configuration validation.)

**Build time:** ~2–4 min cold; ~30–60s incremental.

#### Verification

- [ ] **Logs** show the single startup line above.

- [ ] **`/health` responds with HTTP 200** without env-var
      validation:

      ```bash
      curl https://api.<domain>/health
      ```

      Returns the api's CORS + auth metadata snapshot. /health is
      decoupled from the oracle env vars on purpose so a missing
      `ORACLE_RPC_URL` doesn't make the entire service unhealthy
      from Railway's perspective.

- [ ] **`/authority` matches the oracle**:

      ```bash
      curl https://api.<domain>/authority | jq
      ```

      Should return:
      ```json
      {
        "service": "peptide-oracle",
        "protocol_version": 1,
        "cluster": "devnet",          // matches oracle's ORACLE_RPC_URL
        "oracle_authority_pubkey": "...", // matches oracle's authority
        "memo_program_id": "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
        ...
      }
      ```

      Cross-check the `oracle_authority_pubkey` against the oracle
      service's `/health` response (`wallet.public_key` field)
      — they must be identical.

- [ ] **`/v1/status` aggregates work + on-chain reads succeed**:

      ```bash
      curl https://api.<domain>/v1/status | jq
      ```

      Should return cycle + TWAP commit counts (matching the
      oracle's view), the wallet's current balance, and a
      non-null `recent_signatures_count`. If `wallet_balance_sol`
      is null but counts are populated, the Helius RPC URL is
      reachable for reads but maybe rate-limited; non-fatal.

- [ ] **Fetch a known finalized cycle**:

      ```bash
      curl https://api.<domain>/v1/cycles/1 | jq
      ```

      Returns the cycle row + its junction observations + memo
      payload + Solscan URL. Click the Solscan URL — the on-chain
      Memo's text should match the `memo_payload` field byte-exact.

- [ ] **End-to-end verify**:

      Pick an observation from the response above
      (`observations[0].observation_id`), then:

      ```bash
      curl https://api.<domain>/v1/verify/observation/<OBS_ID> | jq
      ```

      Expected: `{"verified": true, ...}` with all 8 §5.5.1 checks
      passing. If any check fails, the response includes
      `failure_reason` + `failure_detail` that points at the
      mismatch (most likely: `signer_matches_authority` false →
      `PEPTIDE_ORACLE_AUTHORITY_PUBKEY` typo).

#### Common failure modes

- **`PEPTIDE_ORACLE_AUTHORITY_PUBKEY` mismatch with the oracle.**
  Symptom: `/v1/verify/observation/:id` returns
  `verified: false, failure_reason: "signer_matches_authority"`
  with `failure_detail` showing the on-chain signers vs the
  configured pubkey. Fix: copy the exact pubkey value from the
  oracle service's env (or its `/health` `wallet.public_key`).

- **`ORACLE_RPC_URL` cluster mismatch with the oracle's signed
  transactions.** Symptom: `/v1/verify/observation/:id` returns
  `failure_reason: "memo_matches_onchain"` with
  `failure_detail: "on-chain tx ... not found at finalized
  commitment"`. The signature was signed for one cluster but the
  api is reading from another. Fix: point both services at the
  same cluster.

- **Service-role key from the wrong project.** Symptom:
  `/v1/cycles` returns 500 with PostgREST errors about missing
  tables. The key authenticates against whichever project's auth
  endpoint it was issued from. Fix: re-fetch from
  `mnquozxfniasbpaavcos` Dashboard → Project Settings → API.

- **`SUPABASE_URL` typo to the legacy biohack.market project.**
  Symptom: queries succeed but return zero rows for everything
  (legacy project doesn't have the new commit_cycles / twap_commits
  tables — schema 0031 / 0032 was never applied there). Fix: pin
  `mnquozxfniasbpaavcos` and double-check before saving.

- **CORS rejects the frontend in prod.** Symptom: browser console
  shows "blocked by CORS policy". The static allow-list covers
  localhost + `*.lovable.{app,dev,project.com}`; if the frontend
  is hosted elsewhere, add the origin to `CORS_ORIGINS` (comma-
  separated list, exact match).

- **Custom domain DNS not propagated.** A custom domain
  (`api.<your-domain>`) needs a CNAME record pointing at
  Railway's edge. Propagation can take 5–60 min. The
  `*.up.railway.app` Railway-assigned URL works during this
  window; just don't bake it into clients you can't update later.

### 5.5 TWAP Worker service

The worker continuously computes per-peptide TWAPs from the
observations the scraper writes, populating `peptide_twaps`. The
oracle's twap-poller (built in §3.3) harvests the latest row per
active peptide at HH:00:30 UTC and submits it on-chain. Without the
worker running, `peptide_twaps` stays empty, the oracle's TWAP
poller logs `skipped_no_twap=N` every hour, and no TWAP commits
land. Cycle commits are unaffected.

#### Service overview

The worker is the simplest of the four services from a security
perspective:

- **No signing keys.** Doesn't touch Solana — reads observations
  from Postgres, writes computed TWAPs back to Postgres.
- **No public network surface.** Only `/health` is exposed for
  Railway's deploy check; no public domain needed.
- **No advisory lock.** The worker is stateless between cycles —
  each per-minute run is independent. A redeploy doesn't have the
  ghost-lock recovery flow that sometimes bites the oracle (§8.5.7).
- **Per-cycle idempotency.** `peptide_twaps` has
  `unique(peptide_id, computed_at)` and `computed_at` is rounded
  to the start of the current UTC minute, so a re-run within the
  same minute is a no-op `INSERT ... ON CONFLICT DO NOTHING`.

#### Cadence + architecture

The actual worker runs **per-minute** (`WORKER_CYCLE_INTERVAL_MS=60000`),
not hourly. Each cycle:

1. For each `is_active=true` peptide, walk every active supplier
   that has any successful observation with a non-null price.
2. Take the SINGLE most-recent successful observation per
   (peptide, supplier) pair, regardless of when it occurred.
3. Drop any observation older than `WORKER_FRESHNESS_CEILING_MS`
   (default **30 minutes**) — beyond that the data is too stale to
   publish; the worker writes a thin-data row with
   `twap_usd_per_mg=NULL` rather than show last-week's prices.
4. If 2+ suppliers reported fresh-enough, compute the median across
   them; otherwise emit a thin-data row.
5. Write to `peptide_twaps`. The oracle's twap-poller picks up the
   row matching the next hour boundary.

The "Option B decoupled" design (per `apps/worker/src/run.ts`
header) means the worker is robust to scrape-cadence changes and
short scraper outages: as long as each supplier produced
SOMETHING within the freshness ceiling, the TWAP gets computed.
Trade-off: write throughput on `peptide_twaps` is high (one row
per active peptide per minute = ~26 rows/min ≈ 37k rows/day at v1
scale).

#### Steps

- [ ] **Project → New Service → Deploy from GitHub repo**.
      Same repo and branch as scraper / oracle / api.

- [ ] **Service name**: `peptide-oracle-worker` (matches the
      historical naming pattern; like the other three, the npm
      package + Railway service names retain the `peptide-oracle`
      identifier — the BioHash rebrand is human-facing only,
      service-level rename is a future refactor).

- [ ] **Settings → Source**:
      - Root directory: `/`.
      - Watch paths (avoid redeploys when sibling services change):
        - `apps/worker/**`
        - `packages/**`
        - `pnpm-lock.yaml`
        - `pnpm-workspace.yaml`

- [ ] **Settings → Build**:
      - Builder: Dockerfile
      - Dockerfile path: `apps/worker/Dockerfile`.

- [ ] **Settings → Networking**: the worker has a `/health`
      endpoint but no public surface beyond that. **Don't generate
      a public domain.** Railway's internal healthcheck (configured
      by `apps/worker/railway.json`) reaches it on the private
      network.

#### Set environment variables

In **Settings → Variables**, add the following one by one. Mark
secrets with the lock icon as you add them. The canonical list is
in `apps/worker/.env.example`; this table is the operator-facing
summary.

| variable                       | value                                                                                                                                                                  | secret? |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| `SUPABASE_URL`                 | `https://mnquozxfniasbpaavcos.supabase.co` (same as scraper / oracle / api)                                                                                            | no      |
| `SUPABASE_SECRET_KEY`          | service-role key from §1 (same value used by the other three services; the worker uses it for trusted reads + writes)                                                  | **YES** |
| `WORKER_CYCLE_INTERVAL_MS`     | `60000` (per-minute compute cadence; matches the worker's default)                                                                                                     | no      |
| `WORKER_FRESHNESS_CEILING_MS`  | `1800000` (30 min — observations older than this are treated as stale; worker emits a thin-data row rather than publishing them)                                       | no      |
| `HEALTH_PORT`                  | `8080`                                                                                                                                                                  | no      |
| `NODE_ENV`                     | `production`                                                                                                                                                            | no      |
| `HOST_OVERRIDE`                | optional; identifies the running container if you ever extend run logging. Falls back to `os.hostname()` when unset.                                                   | no      |
| `SCRAPER_CYCLE_INTERVAL_MS`    | optional; **set to the same value as the scraper service's `SCRAPER_CYCLE_INTERVAL_MS`** so the worker can run a startup sanity check ("worker window narrower than scrape cadence → expect thin-data rows between scrapes") and warn if you've misconfigured. Leave unset to skip the check. | no      |

⚠ **Important: there is NO `ORACLE_RPC_URL`, NO
`PEPTIDE_ORACLE_AUTHORITY_PUBKEY`, NO Solana keypair** for the
worker. If you find yourself adding any Solana-shaped env var to
this service, you've crossed a wire — the worker is database-only.
The on-chain side is the oracle's job (§5.3).

#### What you should expect on first boot

Healthy startup logs (the worker is concise — no advisory lock,
no balance check, no cluster detection):

```
[startup] health endpoint on :8080/health
[startup] worker looping on 60000ms interval (--once for a single cycle)
```

If `SCRAPER_CYCLE_INTERVAL_MS` is set and the worker's window is
narrower, an additional warning fires once at startup:

```
[startup] WARN: worker window may be narrower than scrape cadence; expect thin-data rows between scrapes (WORKER_CYCLE_INTERVAL_MS=60000, SCRAPER_CYCLE_INTERVAL_MS=600000, WORKER_FRESHNESS_CEILING_MS=1800000)
```

After the first cycle (within 60 seconds of startup), per-cycle
log lines appear:

```
[twap] run=… status=success peptides=26 with_twap=24 thin_data=2 inserted=26 dur=234ms
```

`with_twap` is the count of peptides where 2+ suppliers reported
fresh observations and a real TWAP was computed; `thin_data` is
peptides where the worker honestly wrote a NULL row (§3.3.2 thin-
data rule). `inserted` is total rows added to `peptide_twaps`
this cycle.

**Build time:** ~2–4 min cold; ~30–60s incremental.

#### Verification

- [ ] **Service deploys** and Railway's healthcheck reports
      Active / green.

- [ ] **Within 60s of startup**, the worker writes its first
      batch of `peptide_twaps` rows. Verify in Supabase Dashboard
      → Table Editor → `peptide_twaps`:

      ```sql
      SELECT count(*), min(computed_at), max(computed_at)
      FROM public.peptide_twaps
      WHERE computed_at > now() - interval '5 minutes';
      ```

      Should show one row per active peptide per minute.

- [ ] **Subsequent runs every 60s** add new rows without errors.
      The worker logs at INFO level on every cycle; a wave of
      ERROR-level "[twap] FAILED" lines means the worker is hitting
      a real problem (auth, schema mismatch, etc.) — investigate.

- [ ] **At the next HH:00:30 UTC tick after the worker's first
      run**, the oracle's twap-poller picks up the latest
      `peptide_twaps` rows for each active peptide. Watch the
      oracle's logs:

      ```
      [twap-poller] hourBoundary=2026-05-03T16:00:00.000Z enqueue: inserted=26 skipped_no_twap=0 skipped_already_committed=0 errored=0
      ```

      `inserted=26` (or however many active peptides there are)
      with `skipped_no_twap=0` is the green-path signal.

- [ ] **Within ~5 minutes** of the hour boundary, all 26 TWAP
      commits should reach `status='finalized'` on Solana. Verify
      via the api:

      ```bash
      curl https://api.<domain>/v1/peptides | jq '.peptides[].current_twap'
      ```

      Every peptide should have a non-null `current_twap` with a
      `solana_signature` set.

#### Common failure modes

- **Wave of thin-data rows in the first 30 minutes after deploy.**
  If you deploy the worker before the scraper has had time to
  populate observations, OR your `WORKER_FRESHNESS_CEILING_MS` is
  shorter than the scrape cadence, every cycle writes
  `twap_usd_per_mg=NULL` rows. This is **not a worker bug** — it's
  the worker honestly signalling "no fresh data". Fix at the
  scraper layer (faster cadence, or check for vendor blocking).
  The worker keeps running and starts emitting real TWAPs as soon
  as observations land.

- **`peptide_twaps` row count grows fast.** ~26 rows/minute at v1
  scale ≈ 37k rows/day, ~13M rows/year. The table has a
  `(peptide_id, computed_at desc)` index so reads stay fast, but
  if storage cost matters, plan a retention policy: archive or
  delete rows older than ~30 days (none of the on-chain commits
  reference rows older than ~1 hour anyway, so older rows are
  audit-only). Not a v1 blocker — flag for §8 ops review.

- **Worker missed the hour boundary.** If the worker was down at
  HH:00:00 → HH:00:30 UTC, no `peptide_twaps` row exists at that
  exact minute boundary. The oracle's twap-poller looks for the
  most recent row at-or-before the hour boundary, so a row at
  HH-1:59:00 still gets picked up. The on-chain memo's
  `computed_at` will reflect that earlier time honestly. Not a
  silent failure — verifiers see what was anchored.

- **Schema drift on `peptide_twaps`.** If a migration changed the
  column shape and the worker's deployed version was built
  against the old shape, every `INSERT` will fail. Symptom: every
  cycle's log line shows `inserted=0` with a Postgres error in the
  detail. Fix: redeploy the worker against the latest branch.

- **Service-role key from the wrong project.** Same failure mode
  as the other three services: writes fail with PostgREST RLS
  errors despite the env var being set. Re-fetch the
  `service_role` key from Supabase Dashboard → Project Settings
  → API for `mnquozxfniasbpaavcos`.

- **`SUPABASE_URL` typo to the legacy biohack.market project**
  (`pjsjaspntdjecfitogtc`). Symptom: the worker writes
  `peptide_twaps` rows to the legacy project — they don't show up
  in the new project's dashboard, the oracle's twap-poller stays
  silent, and you'll discover it only when the api's
  `/v1/peptides` reports stale or null `current_twap` values.
  Pin `mnquozxfniasbpaavcos` and double-check before saving.

---

## 6. Mainnet cutover

A one-time operational procedure that moves the four BioHash
services from Solana devnet to mainnet. Done correctly: ~30
minutes hands-on plus a 3–5 day post-cutover stability window
before the public-launch announcement.

**Depends on #5** plus at least 7 days of zero-incident devnet
operation. Don't cut over with open issues — every operational
gap will get amplified on mainnet where signing fees are real and
the published authority pubkey is the trust anchor for verifiers
worldwide.

**Time:** ~30 minutes hands-on + 3–5 day observation window.

**Cost:** mainnet keypair + ~0.005 SOL/day at default priority
fees (per §07.1.5; that's roughly ~$1/day at $200/SOL). Fund the
production keypair to ≥0.5 SOL for ~3 months runway, 1.0 SOL for
~6 months.

### 6.1 Prerequisites checklist

Verify each item before pressing any cutover button. The cutover
itself takes ~5 minutes once these are all green; the slow part
is making sure they are.

#### Production keypair exists locally and is NOT in the repo

- [ ] Production keypair file exists at a path under your control
      (not in a git-tracked directory):

      ```bash
      ls ~/.config/solana/biohash-mainnet.json
      ```

- [ ] The keypair was generated air-gapped per the §3.0
      "security-conscious procedure" (offline machine, no clipboard
      transit, written to encrypted backup). If you cut corners on
      this step, **stop and do it again** — the production
      authority key is the trust anchor; a compromise here is
      operationally fatal.

- [ ] The base58-encoded secret form is captured in your password
      manager (the value you'll paste into Railway as
      `ORACLE_SOLANA_PRIVATE_KEY`):

      ```bash
      node -e 'const fs=require("fs"); const bs58=require("bs58").default; \
        console.log(bs58.encode(Uint8Array.from(JSON.parse(fs.readFileSync(process.argv[1],"utf-8"))))); \
      ' ~/.config/solana/biohash-mainnet.json
      ```

      The output is a base58 string. **DO NOT** paste this in
      chat, in a screen-share, or anywhere it could be logged.
      Treat it like a database password.

- [ ] The pubkey derived from this keypair is captured separately:

      ```bash
      solana-keygen pubkey ~/.config/solana/biohash-mainnet.json
      ```

      This is the value you'll paste into Railway as
      `PEPTIDE_ORACLE_AUTHORITY_PUBKEY` AND that you'll publish in
      `docs/oracle-authority.md`. Same value in both places.

- [ ] Confirm the production pubkey is **different** from the
      devnet shakedown pubkey. The devnet keypair must NEVER sign
      mainnet txs — devnet signatures are auditable on the devnet
      cluster and could be confused for "real" oracle attestations.

#### Production keypair is funded on mainnet

- [ ] Mainnet balance ≥ 0.5 SOL (1.0 SOL recommended for ~6
      months runway):

      ```bash
      solana balance <PRODUCTION_PUBKEY> --url mainnet-beta
      ```

      If short, fund from an exchange withdrawal. Allow ~30
      minutes for the funding tx to finalize before proceeding.

- [ ] Verify the same pubkey shows the funded balance via Solscan:

      ```
      https://solscan.io/account/<PRODUCTION_PUBKEY>
      ```

      Cross-checks that the keypair file and the pubkey you
      published match the cluster you're funding.

#### Helius mainnet API key works

- [ ] Mainnet Helius URL responds:

      ```bash
      curl -X POST 'https://mainnet.helius-rpc.com/?api-key=<YOUR_KEY>' \
        -H 'Content-Type: application/json' \
        -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}'
      ```

      Expected response: `{"jsonrpc":"2.0","result":"ok","id":1}`.
      Anything else (rate limit, auth error, timeout) → fix
      Helius dashboard config before proceeding.

- [ ] Confirm your Helius plan covers the projected mainnet traffic.
      Per §03.6.3, ~6,000 requests/day at steady state — well
      within the free tier's 100k/day cap. If your plan is paid,
      verify the billing card on file is current; running out of
      Helius credits mid-day silently degrades the oracle.

#### Devnet stability gate

- [ ] Devnet has been running ≥ 7 days with zero unresolved
      incidents:
      - `/v1/status` shows steady cycle commit + TWAP commit
        counts, no growth in `failed` count.
      - No ghost-lock recovery (§8.5.7) needed in the past 7 days.
      - No `[fatal]` log lines in the oracle service in the past
        7 days.
      - `/v1/verify/observation/<id>` returns `verified: true`
        for at least one observation per peptide.
      - The §3.7.3 INSUFFICIENT_SOL alarm has never fired (i.e.,
        the devnet keypair always had budget).

      If any of these fail, **don't cut over** — operationalise
      first, observe another 7 days, retry.

- [ ] Snapshot the devnet stats for the post-cutover retrospective:

      ```bash
      curl https://api.<your-domain>/v1/status > devnet-snapshot-$(date -u +%F).json
      ```

      Useful when the post-launch retrospective asks "what was the
      delta between devnet end-state and mainnet day 1".

#### biohash.network DNS ready (optional but recommended)

- [ ] If using a custom domain for the api, the DNS record is
      already pointing at Railway's edge. CNAME propagation can
      take 5–60 min — set this up the day before so it's live
      when the api comes back up after the cutover restart.

#### Database snapshot for rollback

- [ ] Take a `pg_dump` of the four oracle tables before the
      cutover deletes anything. This is your only rollback path:

      ```bash
      pg_dump "$ORACLE_DATABASE_URL" \
        --table=public.commit_cycles \
        --table=public.commit_observations \
        --table=public.twap_commits \
        --data-only \
        --inserts \
        > biohash-devnet-snapshot-$(date -u +%F).sql
      ```

      Keep the file off-machine (e.g., copy to your local backup
      drive). If the cutover fails and we need to roll back to
      devnet, this dump restores the deleted rows.

      Note: `scraper_runs` + `supplier_observations` are NOT
      dumped — they're observation history, valuable beyond the
      cutover, and never deleted.

### 6.2 Architectural decision: handling devnet history

This is the load-bearing decision in the cutover. There's no
`cluster` column anywhere in the schema — `commit_cycles` only
stores `solana_signature` + `solana_slot`. The api derives the
cluster from its own `ORACLE_RPC_URL` env var. **After cutover,
the api would label every devnet row as cluster=mainnet** —
verifiers would query mainnet RPC for devnet signatures and get
"transaction not found" errors. That's a real correctness bug.

Two options:

#### Option A (recommended): clean DB reset

Before flipping the oracle env vars, DELETE the devnet rows from
`commit_cycles`, `commit_observations`, and `twap_commits`. The
api starts fresh on mainnet day 1; devnet on-chain commits remain
on Solana devnet for audit-only verification (anyone who really
cares can query devnet RPC directly, and the snapshot dump from
§6.1 lets the operator re-create a devnet-flavoured api instance
if needed for audit later).

**Pros:** simpler to execute (one DELETE statement, no schema
change), cleaner mental model for public ("mainnet day 1 = the
first BioHash commit"), fewer ways for the api to lie.

**Cons:** loses live-API access to devnet history (Solana on-chain
data is preserved forever).

`cycle_id` continuity: PRESERVED. The next cycle commit's
`cycle_id` is whatever the next `scraper_runs.id` value is — the
sequence isn't reset, just the commit_cycles rows are deleted.
So mainnet starts at cycle ~269+ (whatever the next scraper run
produces), not cycle 1. Public copy can frame this honestly:
"BioHash anchored its first mainnet commit at scraper run #N,
following 7+ days of devnet shakedown".

#### Option B: keep history + add a `cluster` column

Add `cluster text not null default 'devnet'` to commit_cycles +
twap_commits via a new migration, backfill existing rows to
'devnet', update oracle to write the current cluster on insert,
update api to use per-row cluster instead of config.

**Pros:** preserves live-API access to the full history (devnet
+ mainnet); a verifier sees "this row is devnet, that row is
mainnet" and can point their RPC accordingly.

**Cons:** ~50 lines of code change + a schema migration + redeploy
of api before cutover; introduces a new field that future
migrations have to keep consistent.

This is the right answer if BioHash treats the devnet history as
public-facing audit data. For v1 launch, Option A is simpler and
the on-chain devnet commits are forever queryable independently
of the api.

**This runbook documents Option A.** If you want Option B,
implement the schema migration as its own ticket BEFORE running
this cutover; the §6.3 cutover steps below assume Option A.

### 6.3 Cutover steps

Total elapsed time once you start: ~5 minutes if everything goes
right; up to 30 if you have to fix a misconfig mid-flight.

#### Step 0: Wait for the oracle to drain in-flight work

- [ ] Confirm `/v1/status` shows zero `pending` and zero
      `submitted` cycle / TWAP commits:

      ```bash
      curl https://api.<your-domain>/v1/status | \
        jq '.cycle_commits.counts, .twap_commits.counts'
      ```

      Expected: `pending=0, submitted=0` for both. Any non-zero
      means a commit is in-flight on devnet — wait for it to
      finalize (or fail and exhaust its retry budget) before
      proceeding. Cutting over with in-flight work risks the new
      mainnet oracle attempting to reconcile a devnet signature
      against mainnet RPC, getting "not found", and re-anchoring
      the same data on mainnet (orphan signature on devnet, valid
      one on mainnet — confusing audit trail).

#### Step 1: Pause the worker

- [ ] In Railway → `peptide-oracle-worker` → click the running
      deployment → Stop. The worker stops writing
      `peptide_twaps` rows; the table state is now frozen for the
      duration of the cutover.

      Worker pause is technically optional (worker writes are
      cluster-independent — they're just observation aggregates)
      but it makes the cutover state easier to reason about. Resume
      in Step 7.

#### Step 2: DELETE devnet history (Option A)

- [ ] Via the Supabase Dashboard → SQL Editor (or Mgmt API), run:

      ```sql
      DELETE FROM public.commit_observations;
      DELETE FROM public.twap_commits;
      DELETE FROM public.commit_cycles;
      ```

      Order matters: `commit_observations` has a FK to
      `commit_cycles` with `ON DELETE CASCADE` (per migration
      0031), so the cascade would delete the junction rows
      automatically — but doing it explicitly first makes the
      operator's intent clear in the audit log.

- [ ] Verify zero rows remain:

      ```sql
      SELECT
        (SELECT count(*) FROM public.commit_cycles) AS cycles,
        (SELECT count(*) FROM public.commit_observations) AS obs,
        (SELECT count(*) FROM public.twap_commits) AS twaps;
      ```

      Expected: `cycles=0, obs=0, twaps=0`.

      `scraper_runs`, `supplier_observations`, and `peptide_twaps`
      are UNTOUCHED — observation history is preserved across the
      cutover.

#### Step 3: Update oracle service env vars

In Railway → `peptide-oracle-oracle` → Variables, change THREE
values. Updating any variable triggers an automatic redeploy:

| variable                          | old value                                                | new value                                                  |
| --------------------------------- | -------------------------------------------------------- | ---------------------------------------------------------- |
| `ORACLE_SOLANA_PRIVATE_KEY`       | base58 of devnet keypair                                 | base58 of **production keypair** from §6.1                 |
| `ORACLE_RPC_URL`                  | `https://devnet.helius-rpc.com/?api-key=<KEY>`           | `https://mainnet.helius-rpc.com/?api-key=<KEY>`            |
| `PEPTIDE_ORACLE_AUTHORITY_PUBKEY` | devnet pubkey                                            | production pubkey (matches the key from `ORACLE_SOLANA_PRIVATE_KEY`) |

⚠ **The keypair env var is `ORACLE_SOLANA_PRIVATE_KEY` (a base58
string), not a file path.** Don't go looking for `ORACLE_KEYPAIR_PATH`
or anything similar; the keypair is stored as a Railway secret env
var, not a file. The value is the base58-encoded 64-byte secret —
solana-keygen's keypair file is a JSON array of bytes; convert via
the bs58 helper from §6.1.

- [ ] Save all three env vars. Mark all three with the lock icon
      (secret).

#### Step 4: Watch oracle restart

The Railway redeploy takes ~30–60s. Watch the oracle service's
logs for the green-path startup transcript:

```
[startup] oracle service starting (node=v20.x.x env=production)
[startup] oracle wallet: <PRODUCTION_PUBKEY>          # ← mainnet pubkey
[startup] rpc=helius supabase=mnquozxfniasbpaavcos.supabase.co
[startup] balance thresholds: warn<0.3 SOL critical<0.15 SOL min-startup<0.05 SOL
[startup] health endpoint on :8080/health
[startup] wallet balance: 0.500000 SOL (>= 0.05 SOL min)   # ← mainnet balance
[startup] advisory lock acquired (single-instance enforced)
[cycle-poller] started (interval=30000ms, phase C: full lifecycle pending → submitted → finalized)
[twap-poller] started (tick=60000ms, enqueue at HH:00:30 UTC)
[long-tail] started (interval=3600000ms, maxTotalRetries=20)
```

If you see `[fatal] Authority pubkey mismatch` — your
`PEPTIDE_ORACLE_AUTHORITY_PUBKEY` doesn't match the pubkey
derived from `ORACLE_SOLANA_PRIVATE_KEY`. Re-derive both from the
same keypair file and try again.

If you see `[fatal] balance ... < min-startup` — the production
keypair isn't funded enough on mainnet. Top up and redeploy.

If you see ghost-lock retry messages — ignore for up to 60s, the
retry-with-backoff (§8.5.7) usually clears the previous instance's
session within that window. If it exhausts the 60s budget, follow
the §8.5.7 manual recovery procedure.

#### Step 5: Update API service env vars

Same change shape, two values (api doesn't sign so no keypair
change):

| variable                          | new value                                            |
| --------------------------------- | ---------------------------------------------------- |
| `ORACLE_RPC_URL`                  | `https://mainnet.helius-rpc.com/?api-key=<KEY>`      |
| `PEPTIDE_ORACLE_AUTHORITY_PUBKEY` | same production pubkey as the oracle service        |

⚠ The api's `PEPTIDE_ORACLE_AUTHORITY_PUBKEY` MUST match the
oracle's. Identical strings, byte-for-byte. A typo here makes
every `/v1/verify/observation/:id` return
`signer_matches_authority: false` even when the on-chain commit
is genuine.

- [ ] Save both. Mark both as secret.

#### Step 6: Watch API restart + verify /authority

Railway redeploys the api (~30s). Then:

```bash
curl https://api.<your-domain>/authority | jq
```

Expected:

```json
{
  "service": "biohash",
  "project_name": "BioHash",
  "protocol_version": 2,
  "cluster": "mainnet-beta",            ← was "devnet"
  "oracle_authority_pubkey": "<PROD>",  ← the production pubkey
  ...
}
```

- [ ] `cluster` is `mainnet-beta`.
- [ ] `oracle_authority_pubkey` matches what the oracle service is
      using (cross-check by querying the oracle's `/health` or by
      inspecting the env var directly).

#### Step 7: Resume the worker

- [ ] In Railway → `peptide-oracle-worker` → Restart. The worker
      resumes its per-minute cycle, writing `peptide_twaps` rows.
      The next time the oracle's twap-poller fires (HH:00:30 UTC),
      it harvests those rows and submits them to mainnet.

#### Step 8: Wait for the first mainnet commits

- [ ] Within ~10 minutes (one scrape cycle + one oracle tick),
      the first mainnet cycle commit lands. Watch the oracle's
      logs:

      ```
      [cycle-poller] cycle_id=<N> obs=<K> root=0x… memo_bytes=270
      [cycle-poller] cycle_id=<N> SUBMITTED sig=<MAINNET_SIG>
      [cycle-poller] cycle_id=<N> FINALIZED slot=<MAINNET_SLOT>
      ```

      `<N>` is whatever the next scraper_runs.id is — likely
      ~269+. `memo_bytes=270` confirms v=2 schema.

- [ ] Click the Solscan URL from `/v1/cycles?limit=1` — it should
      open against `mainnet-beta` (no `?cluster=devnet` query
      string). The on-chain Memo bytes match `memo_payload`
      byte-exact and include `"project":"biohash"` +
      `"url":"biohash.network"`.

- [ ] Within ~1 hour (next HH:00:30 UTC tick), the first mainnet
      TWAP commits land. `/v1/peptides` shows `current_twap` with
      mainnet `solana_signature` for each peptide.

- [ ] Run the end-to-end verifier on a NEW (post-cutover)
      observation:

      ```bash
      curl https://api.<your-domain>/v1/verify/observation/<NEW_OBS_ID> | jq
      ```

      Expected: `{"verified": true, "checks": [8 × passed=true]}`
      with `on_chain.cluster: "mainnet-beta"`.

If all of those green-path: cutover is complete. Move to §6.5.

### 6.4 Common failure modes

- **`/v1/verify` returns `signer_matches_authority: false` for
  every commit.** The api's `PEPTIDE_ORACLE_AUTHORITY_PUBKEY`
  doesn't match the on-chain signers. Re-copy the value from the
  oracle service's env (or the oracle's `/health` `wallet.public_key`
  field) into the api, and redeploy the api.

- **`/v1/verify` returns `memo_matches_onchain: false` with
  `failure_detail: "tx ... not found at finalized commitment"`.**
  Either the api's `ORACLE_RPC_URL` cluster doesn't match the
  oracle's (one of them is still pointing at devnet), or the
  signature is on devnet but the api is on mainnet (you forgot
  Step 2's DELETE — there are still devnet rows in commit_cycles).
  Verify both env vars + re-run the DELETE if needed.

- **Oracle starts but never finalizes a commit.** Insufficient
  mainnet SOL despite passing the startup gate. The 0.05-SOL
  startup floor is intentional minimum; if you're below ~0.5 SOL
  the wallet runs out within days. Top up and watch.

- **Mainnet RPC timeouts on submission.** Mainnet has higher load
  than devnet. The oracle's retry policy (§3.7) absorbs this, but
  if every cycle takes the full 90s confirmation budget, you may
  be hitting Helius free-tier rate limits. Upgrade Helius or add
  `ORACLE_RPC_URL_FALLBACK` per §3.6.2.

- **Helius mainnet rate limit hit.** Symptom: `[cycle-poller]`
  warns `RPC_RATE_LIMITED` repeatedly. The retry policy bumps to
  60s backoff per §3.7.2 but the per-day cap is what you're
  hitting. Check the Helius dashboard's "Requests today" against
  your plan limit; upgrade or accept slower commit cadence until
  the next billing window.

- **Pubkey-mismatch fatal at oracle startup.** `[fatal] Authority
  pubkey mismatch: ORACLE_SOLANA_PRIVATE_KEY derives to <X> but
  PEPTIDE_ORACLE_AUTHORITY_PUBKEY is set to <Y>`. Re-derive the
  pubkey from the secret in §6.1 step 4 and paste it into both
  oracle and api env vars.

- **Ghost-lock at oracle restart, retry budget exhausted.** Same
  failure mode as devnet (§8.5.7) — Supavisor keeping the previous
  oracle's idle backend alive. Apply the manual `pg_terminate_backend`
  recovery from §8.5.7 against the new mainnet-config oracle. Be
  aware the holding session shows `application_name='Supavisor'`,
  `state='idle'` regardless of cluster — the recovery query is
  unchanged from devnet.

### 6.5 Rollback procedure

If the cutover fails in a way that needs hours of debugging
rather than minutes (e.g., persistent mainnet RPC issues, a
schema/code mismatch only visible at scale), roll back to devnet
within 5 minutes and investigate offline.

#### Roll back env vars

- [ ] Revert `ORACLE_SOLANA_PRIVATE_KEY` on the oracle to the
      devnet keypair's base58 secret.
- [ ] Revert `ORACLE_RPC_URL` on both oracle and api to the
      devnet Helius URL.
- [ ] Revert `PEPTIDE_ORACLE_AUTHORITY_PUBKEY` on both oracle and
      api to the devnet pubkey.

Both services auto-redeploy on env-var change.

#### Restore deleted rows from snapshot

- [ ] Apply the `pg_dump` snapshot from §6.1's prerequisites
      checklist:

      ```bash
      psql "$ORACLE_DATABASE_URL" < biohash-devnet-snapshot-<date>.sql
      ```

      The dump is `--data-only --inserts`, so this re-inserts the
      deleted rows. The api comes back online with the full
      devnet history visible.

#### Verify rollback

- [ ] `/authority` returns `cluster: "devnet"` again.
- [ ] `/v1/cycles?limit=5` returns devnet signatures with
      `cluster: "devnet"` Solscan URLs.
- [ ] Oracle is logging the next cycle commit on devnet.

If rollback succeeds you've got time to investigate without the
mainnet stakes. The rollback shouldn't ever produce data loss in
practice — observation history (`scraper_runs`, `supplier_observations`,
`peptide_twaps`) is untouched throughout, and the on-chain
signatures (devnet) were never deleted from Solana.

### 6.6 Post-cutover stability period

3–5 days of zero-incident operation before the public-launch
announcement. The bar:

- [ ] Cycle commits flow every ~10 minutes with no gaps. Verify
      via `/v1/cycles?limit=20` — `created_at` deltas all under
      ~15 min.
- [ ] TWAP commits flow hourly. `/v1/peptides` shows `current_twap`
      timestamps within the last 90 minutes for every peptide.
- [ ] No `[fatal]` log lines in any of the four services.
- [ ] No ghost-lock manual recoveries needed (the `acquireOracleLock`
      retry should absorb everything).
- [ ] SOL balance trending down at the expected rate — at v1
      scale (~6 cycle commits/hour + ~26 TWAP commits/hour) the
      median priority-fee burn is **~0.005 SOL/day** (per §07.1.5).
      A burn rate substantially higher (>0.05 SOL/day) means
      something's misconfigured.
- [ ] `/v1/verify/observation/:id` returns `verified: true`
      against a randomly-sampled observation from each of the
      past three days.

If any of those fail during the 3–5 day window, **do not
announce.** Investigate, fix, restart the 3–5 day clock from
zero.

#### Public launch is gated on this window

The pubkey publication channels (§8) — Twitter pin, GitHub
authority commit, docs site — should all happen in lockstep at
launch announcement, **not** at cutover. A premature publication
means verifiers might pin a pubkey that the operator later has to
rotate (e.g., if a quiet bug shows up during the stability
window). Publish only when you've earned confidence that the
mainnet keypair is the long-term authority.

---

## 7. Better Stack monitoring + status page

Heartbeat monitoring on `/health` plus a public status page at
`status.<your-domain>`.

**Depends on #5** — specifically §5.3 (the oracle service must
have a public domain). The heartbeat target is the Railway oracle
service URL from §5.3.

**Time:** ~45 minutes including SMS alert testing.

**Cost:** Free tier covers v1 (10 monitors, 1 status page).

### Steps

- [ ] Sign up at https://betterstack.com/. The product was
      previously branded "Better Uptime" and "Logtail" separately;
      one consolidated account now.

- [ ] Verify email.

- [ ] In **Better Stack dashboard → Uptime → Create monitor**:
      - **Monitor type**: Heartbeat / HTTP check
      - **URL**: `https://oracle.<your-domain>/health`
      - **Check frequency**: 1 minute
      - **Request method**: GET
      - **Response time threshold**: 5 seconds
      - **Expected status codes**: 200
      - **Response body should contain**: `"ok":true` (this catches
        the case where /health returns 200 but `ok=false`)

- [ ] Add a second monitor for the balance-critical check (this
      requires Better Stack's "JSON path" expression feature, which
      is on the paid tier or available as a workaround on free):
      - On free tier: just rely on the primary heartbeat returning
        non-200 when `balance_critical=true` (the spec says
        unhealthy = 503).
      - On paid tier: JSON path `$.wallet.balance_critical` should
        equal `false`.

### Configure alert routing

- [ ] **Better Stack → Heartbeats → Notification preferences**.
- [ ] **Critical alerts**: SMS + email + (optionally) Slack DM.
      Add your phone number; Better Stack sends a verification SMS.
- [ ] **Warning alerts**: email only.
- [ ] **Info alerts**: Slack channel only (set up the integration
      under **Integrations → Slack** if you want one).

### Set up the public status page

- [ ] **Better Stack → Status pages → Create new**.
- [ ] **Domain**: `status.<your-domain>` (CNAME to Better Stack
      per their setup instructions).
- [ ] Add the heartbeat monitor as a "Service" on the page.
- [ ] Customize branding minimally for v1 (logo + project name); the
      full polish can wait until the project has paying users.

### Test the alert routing

- [ ] **Trigger a fake critical alert.** The cleanest way: in
      Better Stack, **Pause the monitor** for ~3 minutes (longer
      than the failure threshold). The monitor goes red; alerts
      fire.
- [ ] Confirm SMS arrives within ~1 minute on your phone.
- [ ] Confirm email arrives.
- [ ] Confirm the public status page reflects the incident.
- [ ] **Resume the monitor.** Status should return to green within
      a couple of cycles.

### Verification

- [ ] Better Stack dashboard shows the monitor as "Up" with green
      status.
- [ ] Public status page at `status.<your-domain>` is reachable
      and shows the same green.
- [ ] You received the test SMS during alert testing above.

### Common failure modes

- **SMS provider unreachable in your region.** Better Stack uses
  Twilio under the hood (or similar) and SMS to some regions has
  delivery issues. Verify with the live test before declaring this
  step done; if SMS doesn't arrive, switch the critical channel to
  Telegram bot or PagerDuty (Better Stack integrates with both).
- **Status page custom domain DNS not propagated.** Same risk as
  the Railway custom domain — confirm with `dig status.<domain>`
  before publicizing.
- **Heartbeat URL wrong.** Easy to typo when copying from Railway.
  Confirm by visiting the URL in a browser before saving the
  monitor — should return JSON.
- **Free tier doesn't include phone alerting.** Check current
  Better Stack pricing; if phone is paid-only, budget for the
  ~$25/month plan or use a free alternative for the SMS leg
  (SimplePush, ntfy.sh).

---

## 8. Authority pubkey publication channels

Per §05.2.4 trust model. Three channels must agree on the same
pubkey before the §9.5.5 pre-mainnet gate.

**Depends on #3** (need the pubkey).

**Time:** ~30 minutes total across the three channels.

**Cost:** Free.

### Channel A: GitHub repo

- [ ] In the public repo, create
      `docs/oracle-authority.md` on the default branch (`main`).
- [ ] Content (template):

      ```markdown
      # Peptide oracle authority pubkey

      The on-chain commit layer (see
      [docs/specs/01-onchain-commit-layer.md](specs/01-onchain-commit-layer.md))
      anchors data to Solana mainnet using a single hot-wallet
      authority. Verifiers should compare the pubkey below against
      every commit's signer to confirm it was issued by the
      project's authoritative signer.

      ## Current authority

      | field          | value                                      |
      | -------------- | ------------------------------------------ |
      | Pubkey         | `<YOUR_PUBKEY>`                            |
      | Cluster        | `mainnet-beta`                             |
      | Effective from | 2026-XX-XX (initial publication)           |
      | Spec version   | 1                                          |

      ## Rotation history

      No rotations yet.

      _Future rotations will be appended here with old → new pubkey
      mapping, effective date, and rotation reason._

      ## Cross-reference

      The same pubkey is also published at:

      - `GET /api/oracle/info` → `oracle_authority_pubkey`
      - Project Twitter/X: pinned post citing this commit
      - Documentation site: <link to docs page>

      Diligent verifiers should confirm at least two of these
      channels agree before trusting commits.
      ```

- [ ] Commit and push to the public branch verifiers will read
      from. The commit message should be unambiguous:
      `docs: publish oracle authority pubkey for mainnet launch`.

### Channel B: Project social channels

- [ ] Compose a post on the project's X / Twitter account:

      ```
      Peptide oracle is going live on Solana mainnet.

      Authority pubkey: <YOUR_PUBKEY>

      Verifiers: confirm against GitHub
      <https://github.com/keycho/peptidefi/blob/main/docs/oracle-authority.md>
      and our docs <https://docs.<your-domain>/authority>.

      Spec: <https://github.com/keycho/peptidefi/tree/main/docs/specs/01-onchain-commit-layer>
      ```

- [ ] Pin the post to the project account.
- [ ] Save the post URL — you'll reference it from the
      documentation site.

### Channel C: Documentation site

- [ ] Add an `/authority` page to the docs site (covered in #9
      below).
- [ ] Content: the same pubkey, link to the GitHub
      `oracle-authority.md` commit, link to the pinned tweet.

### Cross-check

- [ ] Open all three channels in different browser tabs.
- [ ] Confirm the **same pubkey** appears character-for-character
      across all three. Even one transposed character means
      verifiers refuse to verify.

### Verification

- [ ] Save a screenshot of all three channels showing the matching
      pubkey. File under your operations log; useful evidence if
      anyone ever questions whether the pubkey was published.

### Common failure modes

- **Typo in the pubkey on one channel.** The most common mistake.
  Always copy-paste; never hand-type. Visually compare first 6
  and last 4 characters across channels.
- **Pinning the wrong tweet.** The Twitter UI pin/unpin can be
  fiddly. Verify the pin sticks across a refresh.
- **GitHub commit on the wrong branch.** Always commit to `main`
  (the default branch). Verifiers fetch from default; commits on
  feature branches are invisible to them.

---

## 9. Documentation site published with authority pubkey

The user-facing site for the oracle. Hosts the `/authority` page
referenced in §7 plus broader project documentation.

**Independent.** Can run on Day 1 (the static site itself doesn't
need any of the credentials from #1–#3).

**Time:** highly variable. Minimal version (single static page) ~1
hour. Full docs site (something like Mintlify, Docusaurus,
Astro Starlight) takes a day or more.

**Cost:** free–$X/mo depending on host. Vercel / Netlify / GitHub
Pages all have free tiers sufficient for v1.

### Recommended scope for v1

Don't over-build. The minimum viable docs site is:

- A landing page describing what the oracle is
- An `/authority` page with the pubkey (Channel C from §7 above)
- A `/spec` link pointing to the GitHub spec docs
- A `/status` link pointing to the Better Stack status page (§6)
- A `/verify` page describing how to verify a commit (high-level
  link to `/api/oracle/verify/observation` + the eventual
  `@peptide-oracle/verify` library)

### Path A: minimal (recommended for v1)

A single-page Vercel deployment with a markdown-friendly framework.

- [ ] Use https://astro.build/ (lightweight, fast, free hosting on
      Vercel/Netlify/Cloudflare Pages) or https://www.mintlify.com/
      (purpose-built for docs sites, slightly more polished out of
      the box).
- [ ] Create a new repo `peptide-oracle-docs` (separate from the
      main project repo so docs deploys don't depend on Railway
      redeploys).
- [ ] One landing page + one `/authority` page is enough for the
      §9.5 pre-mainnet gate.
- [ ] Deploy via Vercel: connect GitHub repo → click Deploy.
      Custom domain `docs.<your-domain>` setup as a CNAME.

### Path B: full docs site

If you have time and want polish, use Mintlify or Docusaurus and
build out:

- Architecture overview (link to spec)
- API reference (auto-generated from §05.4)
- Integration guide for downstream consumers
- FAQ + glossary
- Status / changelog pages

This is roughly a week of work and not needed for v1 mainnet
cutover. Prioritize after launch.

### Verification

- [ ] `https://docs.<your-domain>/authority` resolves and shows the
      pubkey.
- [ ] Pubkey on the docs site matches the one published in
      §7 channels A and B.
- [ ] Site renders correctly in mobile + desktop browsers (a
      research-grade verifier might be on a phone).

### Common failure modes

- **Over-investing before launch.** A full docs site is months of
  work for a single operator; the §9.5 gate only needs the
  authority pubkey to be reachable at a stable URL. Don't block
  mainnet on a beautiful site.
- **DNS not propagated.** Same risk as previous DNS-related steps.
- **Site crawler / search-engine indexing surprises.** If the
  oracle is supposed to be discoverable, set up a sitemap.xml and
  robots.txt; if it's deliberately quiet for now, set
  `<meta name="robots" content="noindex">`.

---

## After all 9 are complete

- [ ] Tick off each prerequisite in this checklist (these
      checkboxes become your "done" signal).
- [ ] Capture the §9.4 prerequisites snapshot somewhere durable
      (private operations log) including:
      - Supabase project ref + region + creation date
      - Helius API key creation date
      - Oracle authority pubkey + funding tx signature
      - Railway service deploy URL
      - Better Stack monitor + status page URLs
      - Documentation site URL
- [ ] Move to **§9.5 pre-mainnet checklist** in the spec — devnet
      end-to-end test, /health states, long-tail retry simulation,
      etc. — before pushing to mainnet.

The §9.5 checklist requires the apps/oracle implementation to
exist (now done as of Phase D). Prerequisites #1–#4 are
standalone-completable; #5 (Railway services) requires #1–#3 and
the BACHEM/SIGMA pause from #4; #6 (mainnet cutover) requires #5
plus a 7-day devnet stability window; #7 (Better Stack) and #8
(authority publication) and #9 (docs site) all become meaningful
after #6.

---

## Handoff notes (post-consolidation cleanup)

The repo went through a consolidation pass that left a couple of
loose ends the operator should clean up on a defined schedule.

### Delete `claude/peptidefi-season-1-Hae69` after one week

This branch was the de facto production branch during the
biohack.market era. After the consolidation it's stale and points
to commit `cac7840` (the final biohack-era CORS fix). The week-long
holding period gives time to:

- Confirm nothing in personal notes / external bookmarks references
  the old branch name
- Spot-check that the Railway deploy didn't have any auto-tracked
  ref tied to that branch (it's already been deleted, but worth
  confirming no other infra silently depended on it)
- Let any GitHub Actions / webhooks settled into the new branch
  layout

After the week, delete via:

```
# locally
git branch -D claude/peptidefi-season-1-Hae69

# remotely (via GitHub Settings → Branches, since the local proxy
# in this environment can't push branch deletions; or via gh CLI
# from operator's machine):
gh api -X DELETE repos/keycho/peptidefi/git/refs/heads/claude/peptidefi-season-1-Hae69
```

Document the deletion date in the project's operations log.

### Delete `peptide-oracle-pivot` from origin

This branch was renamed to `main` during the consolidation but the
old `origin/peptide-oracle-pivot` ref still exists (the
sandbox-internal git proxy returned 403 on `--delete`, so it was
left for the operator to clean up). Both refs point to the same
commit; harmless to leave temporarily.

Delete via GitHub Settings → Branches alongside the default-branch
flip, or via:

```
# Once the operator has direct gh CLI access to the renamed repo:
gh api -X DELETE repos/keycho/peptidefi/git/refs/heads/peptide-oracle-pivot
```
