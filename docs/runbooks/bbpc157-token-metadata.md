# $bBPC157 token metadata — operator runbook

Adds Metaplex Token Metadata to the deployed $bBPC157 mint so it
displays as a proper named token in Phantom, Solscan, Jupiter, and
DEX aggregators. This requires upgrading the on-chain peg program
to add a `create_token_metadata` instruction, then invoking it once.

| field | value |
| ----- | ----- |
| Mainnet peg program | `2cKMtgXPQt1zT8aWzBAh9LkH3Cf11ris6NDBjrq9J8s7` |
| $bBPC157 mint | `2NK6tdGZ7C6m9GQN6LP8yU8TQGPELeQ8qYsyTAhPAKmp` |
| Mint authority | peg_state PDA `3iBdy1xHpvUdcRwXDVboFLXEbhJLEk83DN1GNE4jPLrv` |
| Upgrade authority | peg deployer `CZLc84DSqQ9pDYLa5nJQ3AfXa5NgayJLMWK4QpUoptEC` |
| Metadata update authority (post-deploy) | same peg deployer |
| Metaplex Token Metadata program | `metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s` |
| Metadata account (PDA) | derived from `[b"metadata", METAPLEX_PID, mint]` |

---

## 0. Sequencing — read once before starting

The operation is **two distinct steps**, signed by **two different
keypairs**, with a critical pre-flight in between:

```
┌──────────────────────────────┐    ┌──────────────────────────────┐
│ Step A: anchor deploy        │    │ Step B: create_token_metadata│
│ (program upgrade)            │    │ (one-shot script invocation) │
│                              │    │                              │
│ Signed by: upgrade authority │    │ Signed by: peg deployer      │
│   (CZLc84…ptEC)              │    │   (CZLc84…ptEC — same key)   │
│ Cost: ~0.005 SOL             │    │ Cost: ~0.0028 SOL rent + fee │
│ Reversible: NO (irreversible │    │ Reversible: YES (close       │
│   without redeploy of the    │    │   metadata account via       │
│   prior binary)              │    │   Metaplex Burn instruction) │
└──────────────────────────────┘    └──────────────────────────────┘
            │                                       │
            └────── pre-flight: §3 binary-size ─────┘
              size delta against the current on-chain
              data length must fit in the existing
              program-data account (or we reallocate
              first via solana program extend)
```

The pre-flight in §3 catches the most common upgrade failure mode —
new binary larger than the program-data account's allocated bytes.
Without that check, `anchor deploy` fails partway with the upgrade
already half-applied.

If at any point Step A succeeds but Step B fails, the program is
upgraded but no metadata exists. Re-running Step B is safe (the
script is idempotent + the on-chain instruction reverts on duplicate
creation).

---

## 1. Prerequisites

| tool / artefact | required for | install / source |
| --------------- | ------------ | ---------------- |
| `rust` 1.79+ | Step A | `rustup default stable` |
| `anchor-cli` 0.31.1 | Step A | `avm install 0.31.1 && avm use 0.31.1` |
| `solana-cli` 1.18+ (or 2.x / 3.x Agave) | Step A + B | already installed |
| `pnpm` | Step B | already installed |
| Deployer keypair (`CZLc84…ptEC`) | Step A + B | local file, ≥ 0.1 SOL |
| `claude/bbpc157-metadata` branch checked out | Step A + B | `git checkout claude/bbpc157-metadata` |
| `peg-binary-verification` runbook PASSED | Step A | see `docs/runbooks/peg-binary-verification.md` |

If verification PASSED via Method 1, regular `anchor build` is
sufficient. If it required `anchor build --verifiable`, use that for
Step A as well.

If verification FAILED entirely, **don't run Step A**. The
fresh-program redeploy path in §6 of the verification runbook
applies; come back to this runbook after that's done.

---

## 2. Logo + metadata-JSON hosting (do BEFORE Step B)

The on-chain metadata's `uri` field points at
`https://biohash.network/token-metadata/bbpc157.json`. Phantom and
Solscan fetch that URL after seeing the on-chain entry. If the URL
404s when they fetch, they fall back to "Unknown Token" rendering
even though the on-chain name/symbol are correct.

Host both files from the frontend repo (`peptide-ledger-blueprint`):

```bash
# In the frontend repo:
cp <peptidefi-checkout>/scripts/bbpc157-metadata.json \
   public/token-metadata/bbpc157.json
cp <peptidefi-checkout>/scripts/bbpc157-logo.svg \
   public/assets/bbpc157-logo.svg

git add public/token-metadata/bbpc157.json public/assets/bbpc157-logo.svg
git commit -m "feat(assets): add bBPC157 token metadata + logo"
git push
```

Wait for Lovable's auto-deploy to land, then verify both URLs are live:

```bash
curl -s -o /dev/null -w "%{http_code}\n" \
  https://biohash.network/token-metadata/bbpc157.json
# Expect: 200

curl -s -o /dev/null -w "%{http_code}\n" \
  https://biohash.network/assets/bbpc157-logo.svg
# Expect: 200
```

If either is 404, **don't proceed to Step B yet** — the on-chain
metadata is mutable (`is_mutable=true`), so we can update the URI
later, but it's cleaner to set it once correctly than chase down
broken display state.

### Image format note

Metaplex token metadata accepts SVG and PNG. Phantom + Solflare both
render SVG natively. Older aggregators (some Jupiter token-list
clients) only render raster. If you want belt-and-braces:

```bash
# Convert SVG → PNG (any of these works):
rsvg-convert -w 512 -h 512 \
  scripts/bbpc157-logo.svg -o scripts/bbpc157-logo.png

# Or use an online converter, or Figma export. 512x512, transparent
# background NOT recommended for metadata images (some renderers
# composite weirdly).
```

If you ship both, change the metadata JSON's `image` field from
`.svg` to `.png` and re-host. Run Step B after the URL is live.

---

## 3. Pre-flight: binary-size check (CRITICAL)

The on-chain program-data account was allocated at first-deploy time
to fit the original binary plus a small headroom (Solana
Playground's deploy default is exactly the binary size — no
headroom). Adding the Metaplex CPI grows the binary; if the new
binary exceeds the existing allocation, the upgrade fails with
`ProgramDataAccountTooSmall`.

```bash
# 1. Measure on-chain allocation.
solana program show 2cKMtgXPQt1zT8aWzBAh9LkH3Cf11ris6NDBjrq9J8s7 \
  --url https://api.mainnet-beta.solana.com \
  | grep "Data Length"
# Output: Data Length: <ON_CHAIN_BYTES> (...)

# 2. Build new binary locally.
git checkout claude/bbpc157-metadata
anchor build
# Or if verification §3 was needed: anchor build --verifiable

ls -l target/deploy/biohash_peg.so
# Output: <NEW_BYTES>

# 3. Compare.
echo "On-chain allocation: <ON_CHAIN_BYTES>"
echo "New binary:           <NEW_BYTES>"
echo "Delta:                $(( NEW_BYTES - ON_CHAIN_BYTES )) bytes"
```

**Decision:**

- If `NEW_BYTES <= ON_CHAIN_BYTES`: upgrade fits in place. Proceed
  to §4.
- If `NEW_BYTES > ON_CHAIN_BYTES`: extend the program-data account
  before the upgrade tx. The cost is rent for the additional bytes
  (~0.0007 SOL per 100 bytes added):

  ```bash
  solana program extend 2cKMtgXPQt1zT8aWzBAh9LkH3Cf11ris6NDBjrq9J8s7 \
    <DELTA_BYTES_PLUS_HEADROOM> \
    --url https://api.mainnet-beta.solana.com
  ```

  Use `<DELTA_BYTES> + 4096` as the extend amount — gives 4 KB of
  headroom for the next minor change without re-extending. Verify
  with another `solana program show` that Data Length grew.

  Then proceed to §4.

Empirical expectation: adding `mpl-token-metadata` via the
`anchor-spl[metadata]` feature pulls in maybe ~50–100 KB of code.
The original V0.1 binary is ~250 KB. Likely needing extension if
Playground deployed at exactly the original size.

---

## 4. Step A — upgrade the peg program

```bash
# 1. Source on the metadata branch.
git checkout claude/bbpc157-metadata
git log -1 --oneline
# Expect: <hash> feat(peg): create_token_metadata instruction

# 2. Confirm declare_id is mainnet (the cherry-pick branch sets this;
# verify nothing in your working tree changed it).
grep declare_id programs/biohash-peg/src/lib.rs
# Expect: declare_id!("2cKMtgXPQt1zT8aWzBAh9LkH3Cf11ris6NDBjrq9J8s7");

# 3. Build (skip if already built in §3).
anchor build

# 4. Confirm Anchor's program-keypair file exists at the path Anchor
# expects. If you deployed from Solana Playground originally, this
# file may not exist locally — you need to either export it from
# Playground or generate a placeholder file with the program ID.
ls -l target/deploy/biohash_peg-keypair.json
# If missing: see §4.1 below.

# 5. Deploy the upgrade.
anchor deploy \
  --provider.cluster mainnet \
  --provider.wallet ~/peg-deployer-keypair.json
# Or, equivalently, the lower-level form:
solana program deploy \
  target/deploy/biohash_peg.so \
  --program-id 2cKMtgXPQt1zT8aWzBAh9LkH3Cf11ris6NDBjrq9J8s7 \
  --upgrade-authority ~/peg-deployer-keypair.json \
  --url https://api.mainnet-beta.solana.com

# 6. Verify the upgrade landed.
solana program show 2cKMtgXPQt1zT8aWzBAh9LkH3Cf11ris6NDBjrq9J8s7 \
  --url https://api.mainnet-beta.solana.com
# Expect: Last Deployed In Slot: <new slot, recent>
#         Authority:             CZLc84DSqQ9pDYLa5nJQ3AfXa5NgayJLMWK4QpUoptEC

# 7. Compare new on-chain binary hash to the local build.
solana program dump 2cKMtgXPQt1zT8aWzBAh9LkH3Cf11ris6NDBjrq9J8s7 \
  ./onchain-after-upgrade.so \
  --url https://api.mainnet-beta.solana.com
shasum -a 256 ./onchain-after-upgrade.so target/deploy/biohash_peg.so
# Expect: same hash on both lines.
```

### 4.1 Recovery: program-keypair file missing

If `anchor deploy` complains about a missing
`target/deploy/biohash_peg-keypair.json`, you need to provide one
that matches the program ID. Two paths:

**A. Export from Solana Playground** (preferred if you still have
access to the original Playground project):

1. Open the project at https://beta.solpg.io.
2. Click the "Build & Deploy" sidebar.
3. Find the program keypair download — saves a JSON file.
4. Save to `target/deploy/biohash_peg-keypair.json`.
5. Verify: `solana address -k target/deploy/biohash_peg-keypair.json`
   should output `2cKMtgXPQt1zT8aWzBAh9LkH3Cf11ris6NDBjrq9J8s7`.

**B. Use `solana program deploy` directly (bypasses Anchor's keypair
expectation):**

```bash
solana program deploy \
  target/deploy/biohash_peg.so \
  --program-id 2cKMtgXPQt1zT8aWzBAh9LkH3Cf11ris6NDBjrq9J8s7 \
  --upgrade-authority ~/peg-deployer-keypair.json \
  --url https://api.mainnet-beta.solana.com
```

The `--program-id` flag accepts either a keypair file OR a base58
pubkey string. Passing the pubkey works for upgrades because the
upgrade-authority signature alone is sufficient — no program-keypair
needed.

### 4.2 Rollback: if Step A fails

If `anchor deploy` errors out, the upgrade is atomic at the runtime
level: either the new binary is the program data, or the prior one
is. There's no half-state. Common failure modes:

- **"Program data account too small":** §3 pre-flight skipped or
  `solana program extend` not run. Run `solana program extend` and
  retry.
- **"Authority mismatch":** wrong keypair file at
  `--upgrade-authority`. Double-check `solana address -k` matches
  `CZLc84…ptEC`.
- **"Insufficient funds":** deployer balance < ~0.005 SOL plus any
  extension rent. Top up.
- **"Account in use":** transient. Wait 5s and retry.

**There is no rollback to "the prior binary" path** — once an upgrade
lands, the prior binary is gone unless you have a `target/deploy/...so`
of the prior version saved. Save a copy before deploying:

```bash
# Before Step A:
solana program dump 2cKMtgXPQt1zT8aWzBAh9LkH3Cf11ris6NDBjrq9J8s7 \
  ./prior-binary-backup.so \
  --url https://api.mainnet-beta.solana.com
# Keep this file. If the upgrade introduces a regression, redeploy
# the backup as a manual rollback.
```

If a regression IS detected post-deploy:

```bash
solana program deploy \
  ./prior-binary-backup.so \
  --program-id 2cKMtgXPQt1zT8aWzBAh9LkH3Cf11ris6NDBjrq9J8s7 \
  --upgrade-authority ~/peg-deployer-keypair.json \
  --url https://api.mainnet-beta.solana.com
```

---

## 5. Step B — invoke `create_token_metadata`

```bash
# 1. Dry-run first.
PEG_DEPLOYER_KEYPAIR=~/peg-deployer-keypair.json \
HELIUS_API_KEY=<your-helius-key> \
  pnpm tsx scripts/create-token-metadata.ts --dry-run

# Inspect output:
#   - cluster guard:   ✓ mainnet-beta
#   - program guard:   ✓ deployed + executable
#   - peg_state PDA:   3iBdy1xHpvUdcRwXDVboFLXEbhJLEk83DN1GNE4jPLrv
#   - metadata PDA:    <derived address>
#   - metadata exists: ✗ — will create
#   - metadata.name / symbol / uri printed back
#   [dry-run] skipping submit

# 2. Live run.
PEG_DEPLOYER_KEYPAIR=~/peg-deployer-keypair.json \
HELIUS_API_KEY=<your-helius-key> \
  pnpm tsx scripts/create-token-metadata.ts
# Per-step Ctrl+C-in-5s prompt. Ctrl+C aborts cleanly.

# 3. After success, the script prints the signature + Solscan link.
# Output journal at scripts/bbpc157-metadata-output.json (gitignored).
```

### 5.1 Verify Step B post-creation

```bash
# 1. Confirm the metadata account exists.
solana account <METADATA_PDA_FROM_OUTPUT> \
  --url https://api.mainnet-beta.solana.com
# Expect: account data ~679 bytes (Metaplex's MAX_METADATA_LEN).

# 2. Solscan check.
open "https://solscan.io/token/2NK6tdGZ7C6m9GQN6LP8yU8TQGPELeQ8qYsyTAhPAKmp"
# Expect, within ~2 minutes:
#   - Token name: "BioHash Pegged BPC-157"
#   - Symbol:     "bBPC157"
#   - Image:      the logo (SVG renders inline if you used Path A in §2)

# 3. Phantom check (optional).
# Open Phantom → search "2NK6tdGZ…" → expect the token to show with
# name + symbol + image. May take 5-15 minutes for Phantom's CDN to
# pick up the metadata + image.

# 4. Re-run the script to confirm idempotency.
PEG_DEPLOYER_KEYPAIR=~/peg-deployer-keypair.json \
  pnpm tsx scripts/create-token-metadata.ts --dry-run
# Expect:
#   metadata exists: ✓ — already created (sig=<the one from step 2>)
#   Nothing to do. Exit 0.
```

### 5.2 Recovery: if Step B fails

The script is best-effort and will fail loudly. Common causes:

- **`PEG_DEPLOYER_KEYPAIR` env not set:** script bails with a clear
  error before any submission. Set + retry.
- **Genesis hash mismatch:** RPC URL points at devnet/testnet/local.
  Set `--rpc-url` to a mainnet URL or fix the default Helius env.
- **`AccountNotInitialized` (peg_state PDA missing):** the peg state
  for BPC157 wasn't initialised. Run
  `pnpm tsx scripts/initialize-peg-mainnet.ts` first.
- **`MintAuthorityMismatch` (program error 6008):** the peg_state
  PDA is not the mint authority for `2NK6tdGZ…`. Means the wrong
  program is targeting the wrong mint, or the mint was created with
  a different authority than expected. **Stop. Investigate.** Don't
  retry blindly.
- **`AccountAlreadyExists` (Metaplex's revert on duplicate):** the
  metadata was already created in a prior run. Script's pre-flight
  should have caught this; if it didn't, the on-chain check still
  did. Safe — just confirm with `solana account <METADATA_PDA>`.

### 5.3 Updating metadata later

The `is_mutable=true` flag set at creation lets you update name,
symbol, URI, or any other field via Metaplex's `UpdateMetadataAccountV2`
instruction. The signer must be the metadata's `update_authority`,
which we set to the deployer wallet — same key as the upgrade
authority. **No peg-program upgrade needed for metadata updates.**

A separate small script for updates is not in scope for this branch.
The Metaplex JS SDK's update flow is a one-liner; if you need to
update before that script lands, use `mpl-token-metadata`'s CLI:

```bash
metaboss update uri \
  --account 2NK6tdGZ7C6m9GQN6LP8yU8TQGPELeQ8qYsyTAhPAKmp \
  --new-uri https://new.url \
  --keypair ~/peg-deployer-keypair.json \
  --rpc <mainnet-rpc>
```

---

## 6. Final state

After both steps complete:

| artifact | location |
| -------- | -------- |
| Upgraded peg program | mainnet `2cKMtg…J8s7`, slot ~recent |
| Metadata account | derived PDA off `metaqbxx…518x1s` for the mint |
| Metadata JSON | `https://biohash.network/token-metadata/bbpc157.json` |
| Logo | `https://biohash.network/assets/bbpc157-logo.svg` |
| Display in wallets | "BioHash Pegged BPC-157" / `bBPC157` |
| Update authority for metadata | peg deployer (`CZLc84…ptEC`) |

The outstanding follow-up is replacing the placeholder logo with a
designed asset; do that by updating `bbpc157-logo.svg` (or `.png`) in
the frontend repo. The metadata's `uri` continues to point at
`bbpc157.json`; if you want to swap from `.svg` to `.png` (or change
URLs entirely), use the metaboss `update uri` command above.
