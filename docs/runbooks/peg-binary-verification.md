# Peg program binary verification

Verify the deployed mainnet peg program matches the source on
`claude/peptidefi-season-1-Hae69` **before** running any upgrade tx.

If the deployed binary diverges from the source we'd build from, an
`anchor deploy --program-id <id>` will replace the live program with
something else — possibly bricking existing mint/burn flows if account
discriminators or layouts differ. This is a one-way operation.

This runbook walks through three escalating checks. Run them in
order; stop at the first one that PASSES (the source is verified).
If all three FAIL, jump to the recovery section.

| field | value |
| ----- | ----- |
| Mainnet peg program | `2cKMtgXPQt1zT8aWzBAh9LkH3Cf11ris6NDBjrq9J8s7` |
| Source branch claimed | `claude/peptidefi-season-1-Hae69` (HEAD = `72a2cd0`) |
| Build tool | Anchor 0.31.1 |
| Deploy tool | Solana Playground (per operator) |
| RPC | `https://api.mainnet-beta.solana.com` (or your Helius URL) |

---

## 0. Install prerequisites (one-time on the deploy machine)

You said you have `pnpm`, `solana-cli`, and `node` already. You're missing
`rust` and `anchor`. Install both:

### Rust

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
# Accept defaults. Adds ~/.cargo/bin to your PATH.
source "$HOME/.cargo/env"
rustup default stable
rustc --version
# Expect: rustc 1.79+ (anchor 0.31.1 requires ≥ 1.79)
```

### Anchor (via avm — Anchor Version Manager)

```bash
cargo install --git https://github.com/coral-xyz/anchor avm --force
# avm installs into ~/.cargo/bin

avm install 0.31.1
avm use 0.31.1
anchor --version
# Expect: anchor-cli 0.31.1
```

### Docker (only needed for the verifiable-build check in §3)

```bash
# macOS:
# 1. Install Docker Desktop from https://www.docker.com/products/docker-desktop/
# 2. Start it. Wait for the whale icon to settle.
docker info
# Expect: server info, no errors.
```

If you skip Docker now, you can still run §1 and §2 below; only §3
needs it.

### Solana CLI sanity check

```bash
solana --version
# Anchor 0.31.1 was tested against Solana 1.18 / 2.x. If you have
# 3.1.14 (Agave), it should work — newer Agave is backward-compat
# with the BPF loader programs Anchor produces. If anchor build
# emits target errors, fall back to:
#     sh -c "$(curl -sSfL https://release.anza.xyz/v2.0.21/install)"
```

---

## 1. Quick metadata check (always run)

This is sanity, not verification. Establishes that the program exists,
the upgrade authority matches, and gives us the data length to compare
against a local build.

```bash
solana program show 2cKMtgXPQt1zT8aWzBAh9LkH3Cf11ris6NDBjrq9J8s7 \
  --url https://api.mainnet-beta.solana.com
```

Expected output:

```
Program Id:           2cKMtgXPQt1zT8aWzBAh9LkH3Cf11ris6NDBjrq9J8s7
Owner:                BPFLoaderUpgradeab1e11111111111111111111111
ProgramData Address:  <some pubkey>
Authority:            CZLc84DSqQ9pDYLa5nJQ3AfXa5NgayJLMWK4QpUoptEC
Last Deployed In Slot: <slot>
Data Length:          <bytes — record this number>
Balance:              <SOL>
```

**Pass criteria for this step:**

- `Authority` equals `CZLc84DSqQ9pDYLa5nJQ3AfXa5NgayJLMWK4QpUoptEC` (the
  peg deployer wallet — anything else and we have a different problem).
- `Owner` is the BPFLoaderUpgradeable program (not BPFLoader2 — Anchor
  always uses upgradeable).
- Note `Data Length` for §2.

If the authority is wrong, **stop**. The deployment is not yours and
nothing else in this runbook applies.

---

## 2. Hash comparison via regular `anchor build` (Method 1)

Most likely to succeed quickly. Anchor's regular build is reasonably
deterministic when the toolchain version is pinned.

### 2.1 Pre-build edits (REQUIRED — verification-only, do NOT commit)

The source on `claude/peptidefi-season-1-Hae69` has the **Anchor
placeholder program ID** in `declare_id!()`:

```rust
declare_id!("Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS");
```

`declare_id!()` embeds the program ID as 32 bytes in the binary. Solana
Playground would have updated this to the actual mainnet ID before
deploying. **If you skip this step, your local build's binary will
differ from the deployed binary by exactly 32 bytes** even when the
source is otherwise identical — Method 1 will report MISMATCH for the
wrong reason.

**Edit two files** (verification-only; we'll revert after):

```bash
# 1. lib.rs — replace placeholder with mainnet ID.
# (mac) sed has different in-place semantics than gnu sed; use `gsed`
# if you've installed coreutils, otherwise use the `-i ''` form below.
sed -i '' \
  's|Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS|2cKMtgXPQt1zT8aWzBAh9LkH3Cf11ris6NDBjrq9J8s7|g' \
  programs/biohash-peg/src/lib.rs

# 2. Anchor.toml — same replacement, plus add a [programs.mainnet] entry.
sed -i '' \
  's|Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS|2cKMtgXPQt1zT8aWzBAh9LkH3Cf11ris6NDBjrq9J8s7|g' \
  Anchor.toml

# 3. Verify the edits landed.
grep -n declare_id programs/biohash-peg/src/lib.rs
# Expect: declare_id!("2cKMtgXPQt1zT8aWzBAh9LkH3Cf11ris6NDBjrq9J8s7");
grep -n biohash_peg Anchor.toml
# Expect: biohash_peg = "2cKMtgXPQt1zT8aWzBAh9LkH3Cf11ris6NDBjrq9J8s7" lines
```

**Don't commit these edits** — they're scratch state for verification.
Phase C of the metadata work will land them properly on a clean branch.

### 2.2 Build

```bash
# 1. Source still on the verification checkout (after 2.1 edits).
git log -1 --oneline
# Expect: 72a2cd0 fix(peg): box Account fields...

# 2. Build.
anchor build
# Output: target/deploy/biohash_peg.so

# 3. Compare size to on-chain Data Length from §1:
ls -l target/deploy/biohash_peg.so
# Local size and on-chain Data Length should be EQUAL or within
# ~100 bytes (Anchor pads). Wildly different = source diverged.
```

### 2.3 Hash compare

```bash
# 4. Hash the local build.
shasum -a 256 target/deploy/biohash_peg.so
# Record this hash.

# 5. Dump the on-chain binary.
solana program dump 2cKMtgXPQt1zT8aWzBAh9LkH3Cf11ris6NDBjrq9J8s7 \
  ./onchain.so \
  --url https://api.mainnet-beta.solana.com
shasum -a 256 ./onchain.so

# 6. Compare.
if [ "$(shasum -a 256 target/deploy/biohash_peg.so | cut -d' ' -f1)" = \
     "$(shasum -a 256 ./onchain.so | cut -d' ' -f1)" ]; then
  echo "PASSED: source matches deployed binary"
else
  echo "MISMATCH: hashes differ — proceed to §3"
fi
```

**If hashes match (`PASSED`):** source is verified. **Stop here.** The
upgrade is safe.

**If hashes differ:** per the operator decision, **skip Methods 2 and 3
(Docker / `anchor verify`) and go straight to fresh-program redeploy in
§5 Option B**. The toolchain rabbithole isn't worth chasing when the
recovery path is cheap (no minted supply, ~95% rent recovery). Methods
2 and 3 below remain as documentation for future operators with
different constraints.

### 2.4 Cleanup (revert verification edits)

After Method 1 completes — pass or fail — revert the §2.1 edits so
your working tree matches the original commit. The metadata branch
(Phase C) will land the declare_id update properly on a clean commit.

```bash
git checkout -- programs/biohash-peg/src/lib.rs Anchor.toml
# Or, if you also want to clean the build artifacts:
git checkout -- programs/biohash-peg/src/lib.rs Anchor.toml
rm -rf target/
```

---

## 3. Verifiable build comparison (Method 2)

Uses Anchor's Docker-based reproducible build. Same source + same
container = same binary every time. If Solana Playground's build
output matches a verifiable build, your source is verified even if
Method 1 hashes diverged.

```bash
# Requires Docker running (see §0).

# 1. Same checkout as §2 — claude/peptidefi-season-1-Hae69.
# 2. Verifiable build.
anchor build --verifiable
# Pulls projectserum/build:v0.31.1 if not cached. Takes a few min.
# Output: target/verifiable/biohash_peg.so

shasum -a 256 target/verifiable/biohash_peg.so

# 3. Compare against on-chain (already dumped in §2 as ./onchain.so).
if [ "$(shasum -a 256 target/verifiable/biohash_peg.so | cut -d' ' -f1)" = \
     "$(shasum -a 256 ./onchain.so | cut -d' ' -f1)" ]; then
  echo "PASSED: verifiable build matches deployed binary"
else
  echo "MISMATCH: even verifiable build differs — proceed to §4"
fi
```

**If hashes match:** source is verified. **Stop here.**

**If hashes differ:** the source on `claude/peptidefi-season-1-Hae69`
is NOT what Playground deployed. Continue to §4.

---

## 4. `anchor verify` (Method 3 — last automated check)

Anchor has a single-command verify that does the work of §3 plus an
explicit on-chain comparison.

```bash
anchor verify 2cKMtgXPQt1zT8aWzBAh9LkH3Cf11ris6NDBjrq9J8s7 \
  --provider.cluster mainnet
```

Expected on success:

```
Verification PASSED
```

If this also fails, the source has diverged. Jump to §5.

---

## 5. Recovery — when verification fails

You have three options, in order of preference.

### Option A — locate the actual Playground source

Solana Playground saves projects either in browser localStorage or
under a share URL. If you opened the project once, check:

1. **Browser**: open https://beta.solpg.io and look at the project
   list in the sidebar. Your project may still be there.
2. **Share URL**: search your password manager / chat history / git
   commits for any URL that starts with `solpg.io`.
3. **GitHub**: Playground sometimes auto-saves to a connected GitHub
   account; check `keycho/*` repos for any "playground-*" or
   "biohash-peg-*" repo.

Once you have the Playground source:

```bash
# Diff against the git source.
diff -ru <playground-export>/programs/biohash-peg/src \
         <git-checkout>/programs/biohash-peg/src

# Reconcile: either commit Playground's diffs to a new branch, or
# determine that the divergence is benign (whitespace, comments) and
# update the git branch to match.
```

After reconciling, re-run §2 / §3 to confirm hashes match.

### Option B — deploy a new program with metadata

Recommended if no $bBPC157 supply has been minted yet. **Cost: ~3 SOL
for new program rent + 0.005 SOL for re-init transactions.** No user
funds at risk because there are no users yet.

Pre-check:

```bash
# Confirm zero supply on $bBPC157 mint.
spl-token supply 2NK6tdGZ7C6m9GQN6LP8yU8TQGPELeQ8qYsyTAhPAKmp \
  --url https://api.mainnet-beta.solana.com
# Expect: 0
```

If supply is zero, abandoning the current program is safe:

1. Build the peg program from your verified source (after the metadata
   instruction is added — Phase C of the metadata work):

   ```bash
   anchor build --verifiable
   ```

2. Generate a fresh program keypair:

   ```bash
   solana-keygen new --outfile target/deploy/biohash_peg-keypair-v2.json --no-bip39-passphrase
   solana address -k target/deploy/biohash_peg-keypair-v2.json
   # Record the new program ID.
   ```

3. Update `Anchor.toml` `[programs.mainnet]` with the new ID + update
   `declare_id!()` in `programs/biohash-peg/src/lib.rs`.

4. Rebuild + deploy:

   ```bash
   anchor build --verifiable
   solana program deploy target/deploy/biohash_peg.so \
     --program-id target/deploy/biohash_peg-keypair-v2.json \
     --upgrade-authority ~/peg-deployer-keypair.json \
     --url https://api.mainnet-beta.solana.com
   ```

5. Re-run `scripts/initialize-peg-mainnet.ts` (it picks up the new
   program ID from `scripts/idl/biohash_peg.json` — update that
   file's `address` field first).

6. Update Railway oracle env: `PEG_PROGRAM_ID=<new>`.

7. Update `peptide-ledger-blueprint` constants: `PEG_PROGRAM_ID`,
   `PEG_STATE` (new PDA). Push frontend.

8. The old program at `2cKMtgXPQt1zT8aWzBAh9LkH3Cf11ris6NDBjrq9J8s7`
   becomes orphaned. The 3-5 SOL of program data is unrecoverable
   without the upgrade authority closing the program account
   (`solana program close`); since you have the upgrade authority,
   you CAN close it and recover ~95% of the SOL:

   ```bash
   solana program close 2cKMtgXPQt1zT8aWzBAh9LkH3Cf11ris6NDBjrq9J8s7 \
     --bypass-warning \
     --upgrade-authority ~/peg-deployer-keypair.json \
     --url https://api.mainnet-beta.solana.com
   ```

   `--bypass-warning` is required because closing a program is
   irreversible. **Only run this AFTER the new program is verified
   working with at least one mint/burn round-trip.**

### Option C — pause and consult

If Options A and B both look problematic (Playground gone AND non-zero
supply already minted), don't attempt the upgrade. Open an issue
documenting the divergence and pause the metadata work.

The metadata-on-mint cosmetic problem is small compared to bricking a
deployed peg with live state. We can ship $bBPC157 without on-chain
metadata; users see "Unknown Token (decimals=6)" in Phantom but mint
and burn still work. Solscan will show the mint address in lieu of a
name. Off-chain registries (Jupiter token list, Solflare manual list)
can fill the display gap as a stopgap.

---

## 6. After verification PASSES

Tell me which method passed (Method 1 hash, Method 2 hash, or `anchor
verify`). I'll proceed with **Phase B**: cherry-pick the four Phase II
peg commits onto `claude/peg-program-source-to-main`, push for your
review.

After you merge that PR, **Phase C**: branch `claude/bbpc157-metadata`
off the new main, add the `create_token_metadata` instruction, push for
your review.

The verification result also gates which build command you'll use for
the upgrade itself:

- If **Method 1** passed: `anchor build` is sufficient for the upgrade.
- If **Method 2 / 3** passed: use `anchor build --verifiable` for the
  upgrade so the upgrade binary is itself reproducible.

---

## Appendix — reading anchor build output

Common warnings that are NOT verification failures:

- `warning: unexpected cfg condition value: anchor-debug` — Anchor's
  own macros emit conditional cfgs; safe to ignore.
- `warning: ambiguous glob re-exports` — see commit 1845b26's notes;
  cosmetic, doesn't change codegen.
- `warning: use of deprecated method ... realloc` — anchor-spl 0.31's
  internal use of a deprecated solana-program API; doesn't affect us.

If you see any of these, ignore. If you see anything labelled `error:`
or anything that mentions `solana-program 1.x` ↔ `solana-program 2.x`
mismatch, stop and consult.
