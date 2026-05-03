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
| 5 | Railway scraper + oracle + api services | needs #1,2,3 | 75 min  | 3 deploys | $15–25/mo marginal  |
| 6 | Better Stack monitoring + status   | needs #5     | 45 min  | SMS test  | free tier           |
| 7 | Authority pubkey publication       | needs #3     | 30 min  | none      | free                |
| 8 | Documentation site live            | yes          | varies  | depends   | free–$X/mo          |

Dependency graph:

```
   #1 Supabase ──────┐
   #2 Helius   ──────┤
   #3 Keypair  ──────┼──▶  #5 Railway  ──▶  #6 Better Stack
                     │              │
                     │              └──▶  #7 publication channels
                     │              ▲
                     └──▶  #4       │
                       BACHEM/SIGMA │
                                    │
                       #8 docs site ┘
```

**Recommended execution: 3 sessions over ~3 days.**

- **Day 1 (parallel):** #1 Supabase, #2 Helius, #3 keypair, #8 docs site setup. Each can be done independently in any order; #1 + #2 + #3 are the gates for downstream work.
- **Day 2:** #4 BACHEM/SIGMA paused, #5 Railway service config + first deploy, #7 authority pubkey publication.
- **Day 3:** #6 Better Stack alerts and full hookup.

Once all 8 are green, you're at §9.5 pre-mainnet checklist (devnet
testing → final go/no-go gate).

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

## 5. Railway services configured (scraper + oracle + api)

The scraper, oracle, and verification api deploy as **three separate
Railway services in one Railway project**, all built from the
`keycho/peptidefi` monorepo. The scraper runs continuously, writing
observation rows to Supabase. The oracle picks those up, builds the
canonical Merkle root + memo, and submits to Solana. The api serves
read-only verification endpoints over HTTPS that let downstream
consumers (the frontend, third-party integrators, paranoid verifiers)
walk from any observation back to its on-chain commit.

**Depends on #1, #2, #3.** (BACHEM/SIGMA pause #4 should also be
done before the scraper starts so the first scrape doesn't waste
time hammering blocked vendors.)

**Time:** ~75 minutes hands-on, plus ~3–5 min per service's first
build.

**Cost:** $15–25/month marginal — Railway's $5/service Hobby tier
× 3 services. Compute is trivial; ingress/egress is dominated by
the Solana submit traffic at ~6 cycle commits/hour. The api's
read traffic is bounded by the frontend's polling cadence — at v1
volumes (~hundreds of /v1/cycles requests/day) it's negligible.

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

---

## 6. Better Stack monitoring + status page

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

## 7. Authority pubkey publication channels

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

- [ ] Add an `/authority` page to the docs site (covered in #8
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

## 8. Documentation site published with authority pubkey

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

## After all 8 are complete

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
exist, so #5 (Railway service) won't be fully testable until
implementation tickets are done. Until then, prerequisites #1–#4
and #6–#8 are all standalone-completable.

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
