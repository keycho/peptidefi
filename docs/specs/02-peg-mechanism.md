# 02 — Peg mechanism (Phase II)

Status: **V0.1 implemented**. All five instruction handlers in
`programs/biohash-peg/src/instructions/` carry the logic specified
below — `cargo check` is clean and the integration tests in
`/tests/biohash-peg.ts` cover every `PegError` variant except
`ArithmeticOverflow`. The Anchor framework is pinned to 0.31.1 (see
§8.1). Devnet deployment is the next phase and has not happened yet.

This spec covers BioHash's V0.1 peg smart contract: a single
SPL token (BPC-157) minted and burned against a shared USDC reserve,
with the mint/burn rate driven by the on-chain TWAP authority
established in spec §01 (the BioHash oracle, signer pubkey
`FmBggsBjzGsHrtMayYG8ix2JzoYhVczrwJaGGKPpNKK7`).

The on-chain commit layer (spec §01) anchors a **price**. This
program turns that anchored price into a **redeemable peg**: holders
can mint a peptide token by depositing USDC at the current TWAP, or
burn the token to withdraw USDC at the current TWAP. The program
itself holds the USDC reserve in a PDA-owned token account; no
operator wallet ever touches user funds.

---

## 1. System overview and V0.1 scope

### 1.1 What V0.1 ships

- One Anchor program: `biohash-peg` (a single `programs/biohash-peg/`
  crate in this monorepo).
- One peptide token: BPC-157 (`peptides.code = 'BPC157'`). The
  program is written generically — it stores `peptide_code` in
  `PegState` and is designed to support multiple peptides — but the
  V0.1 deployment instantiates exactly one `PegState` PDA.
- One shared USDC reserve PDA (`ReserveState`). All mint/burn flows
  for any future peptide route through the same reserve account.
- Three instructions: `mint_peptide_token`, `burn_peptide_token`,
  `update_peg_state`.
- Devnet first; mainnet after the stability period defined in
  §8.5 below.

### 1.2 What V0.1 does not ship

- No multi-peptide reserves (one `ReserveState` covers everything).
- No per-peptide reserve allocation accounting (the reserve is
  fungible USDC; the program does not track which deposits funded
  which mints).
- No fee accrual, fee withdrawal instruction, or fee distribution
  beyond a static basis-point setting in `PegState` (collected fees
  remain in the reserve PDA in V0.1 and grow the reserve).
- No on-chain ed25519 verification of the TWAP push (`update_peg_state`
  authenticates by Solana signer-check; see §2.3).
- No automated TWAP push (the BioHash oracle calls `update_peg_state`
  as a separate transaction; see §5.2).
- No peg defense, mint pause, circuit breakers beyond the simple
  staleness check in §6.2.
- No governance or upgrade authority transfer instruction.
- No Pump.fun, AMM, or LP incentives.

### 1.3 Token mechanics in one paragraph

A user holding 1 USDC who calls `mint_peptide_token` with the current
on-chain TWAP at 5.998 USD/mg receives **(1 / 5.998) ≈ 0.166722 BPC157
tokens**, where 1 BPC157 token = 1 mg of peptide notional. The 1 USDC
moves from the user's token account into the reserve PDA, and the
program mints fresh BPC157 to the user. A user holding 0.5 BPC157
tokens who calls `burn_peptide_token` at the same TWAP receives
**(0.5 × 5.998) = 2.999 USDC** from the reserve and the program burns
the 0.5 BPC157. Both flows route through the program; no AMM, no
liquidity pool, no slippage other than the time delta between the
last TWAP push and the user's transaction.

### 1.4 Why mint/burn against a reserve

The brief considered three structures (mint/burn-against-reserve, AMM
pool, oracle-priced LP). Mint/burn was chosen because:

- **Battle-tested**: this is the same mechanism stable-coin protocols
  have shipped since 2020 (MakerDAO PSM, Frax, Synthetix sUSD-USDC).
  The failure modes are well-understood and the code surface is small.
- **Predictable**: redemption value is exactly the on-chain TWAP at
  burn time, no AMM curve to model, no slippage from depth.
- **Smallest code surface**: the V0.1 program is roughly 4 instructions
  totaling ~600 lines of Rust. An AMM with the same trust model would
  ship 3–5× the code and the same number of audit findings.
- **Shared-reserve economics**: future peptides slot into the same
  reserve without redesigning anything — `peg_state` PDAs are derived
  per peptide code, but they all reference the singleton reserve.

---

## 2. Trust model

### 2.1 Custody model

User USDC sits in `reserve_state.usdc_vault` — a PDA-owned SPL token
account. The PDA's seeds (`["reserve_vault"]`, see §4.2.2) make the
reserve transferrable only by the program itself, never by an
operator key. This is the **same custody model** as MakerDAO's
PSM and every credible mint-and-burn stablecoin: there is no
"operator can rug" path, only "program can rug if its instructions
have a bug."

The peptide token mint authority (`bpc157_mint.mint_authority`) is
also a PDA — `["peg_state", "BPC157"]`. The program is the only
account that can mint or burn supply.

### 2.2 Update authority

Exactly **one** ed25519 keypair is allowed to call `update_peg_state`:
the BioHash oracle authority pubkey
`FmBggsBjzGsHrtMayYG8ix2JzoYhVczrwJaGGKPpNKK7` (recorded canonically
in `docs/oracle-authority.md`, served live by `GET /api/v1/authority`).
The authority value is stored in `peg_state.update_authority` at
account initialisation and immutable thereafter in V0.1 (no rotation
instruction; rotation requires a program upgrade — see §9.2).

The check is a Solana signer-check on the transaction's fee payer:
`peg_state.update_authority` must equal the `Signer<'info>` account
passed in the `update_peg_state` `Accounts` struct, which Anchor
validates against the transaction's signed `accountKeys`. This is the
same primitive that protects every PDA-authority pattern on Solana.

We deliberately do **not** verify a second ed25519 signature over the
TWAP value embedded in the instruction data. The signer-check on the
authority pubkey already proves that the BioHash authority signed the
transaction containing the new TWAP — adding a second signature
would be redundant, would consume compute units, and would force the
oracle service to maintain two signing pipelines.

### 2.3 What the program trusts the oracle for

`update_peg_state` accepts the new TWAP value as instruction data.
The program does not, on-chain, verify:

- That the TWAP value was actually computed from anchored
  `commit_observations` rows (the proof-of-anchoring lives in the
  separate spec §01 commit memo).
- That the value is consistent with the off-chain `peptide_twaps`
  table.
- That the algorithm identifier matches `filtered_median_v1`.

The trust delegation is: **the program trusts the authority pubkey
to push correct TWAP values, and trusts the off-chain oracle to be
the only thing holding the authority private key.** Anyone wanting
stronger guarantees can verify each `update_peg_state` transaction
off-chain by reconciling its TWAP value against the corresponding
`twap_commits` Memo transaction (see §5.4 of spec §01) — both
transactions are signed by the same authority pubkey, so their
correlation is a Solana `getSignaturesForAddress` query away.

### 2.4 Failure assumption: oracle compromise

If the authority private key is compromised, an attacker can push
arbitrary TWAP values and drain the reserve via `burn_peptide_token`
at an inflated TWAP. The mitigations in V0.1:

- The TWAP staleness check (§6.2) limits the impact window — pushed
  values older than the stale threshold are rejected.
- The maximum-step check (§6.3) bounds how far one push can move the
  peg in a single update.
- Operationally, the oracle authority key is held in Railway env vars
  scoped to one service (the oracle), with the same incident-response
  procedure documented in spec §01 §08.5 (rotate authority,
  re-deploy program with new `update_authority`).

Compromise of the **program upgrade authority** is the catastrophic
case. V0.1 ships with the program upgrade authority set to a
hardware-wallet-backed cold key held by the operator; rotation to a
multisig is on the roadmap (§9.3) but not in scope for V0.1.

---

## 3. Tokenomics and units

### 3.1 BPC-157 token

| field            | value                                                                    |
| ---------------- | ------------------------------------------------------------------------ |
| Symbol           | `bpcBPC157` (on-chain SPL Mint name; user-facing UIs render as `BPC157`) |
| Decimals         | 6                                                                        |
| Mint authority   | `peg_state` PDA (`["peg_state", "BPC157"]`)                              |
| Freeze authority | `None` (no freeze capability)                                            |
| Initial supply   | 0 (all supply minted via `mint_peptide_token`)                           |
| Notional unit    | 1 token = 1 milligram of BPC-157 peptide                                 |

**Why 6 decimals.** USDC uses 6 decimals on Solana. Matching the
collateral's decimal precision avoids rounding asymmetry: the smallest
mintable token (1 base unit = 1 microgram) is priced exactly at the
smallest USDC unit (1 micro-USDC = $0.000001). Mismatched decimals
introduce dust-rounding bias toward one side (the protocol or the
user) on every trade.

**Why 1 token = 1 mg.** Peptide market prices are quoted as USD per
milligram. `peptide_twaps.twap_usd_per_mg` is the canonical unit
across the entire pipeline. Defining 1 token = 1 mg means the on-chain
TWAP value can be used as a price multiplier directly without
unit conversion in the program.

### 3.2 Reserve asset

USDC on Solana mainnet (`EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`) /
devnet (`4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`).

The program is hard-coded to USDC for V0.1. Other stablecoins are not
supported. (Multi-asset reserves are §9.6 future work.)

### 3.3 Numeric units inside the program

The program represents:

| domain         | unit                                                     | type  |
| -------------- | -------------------------------------------------------- | ----- |
| BPC-157 amount | base units (1 base unit = 1 microgram = 10⁻⁶ mg)         | `u64` |
| USDC amount    | base units (1 base unit = 1 micro-USDC = 10⁻⁶ USD)       | `u64` |
| TWAP value     | micro-USDC per microgram (i.e., `twap_usd_per_mg × 10⁰`) | `u64` |
| Slot numbers   | Solana slot                                              | `u64` |

The TWAP unit warrants a worked example. The off-chain
`twap_usd_per_mg` value `5.998000` (numeric(20,6) in Postgres) is
encoded for the program as `5_998_000`:

```
twap_usd_per_mg = 5.998000 USD/mg
                = 5_998_000 micro-USD/mg
                = 5_998_000 micro-USD / 10^6 microgram
                = 5_998_000 / 10^6 micro-USD/microgram
                ≈ 5.998 micro-USD/microgram (loses precision if rounded)
```

To keep the encoding exact and avoid fractional micro-USD, the unit
on-chain is **micro-USDC per microgram, scaled by 10⁶** — equivalently,
the integer `5_998_000` represents `5.998000 USD per mg` directly,
because `micro-USDC × 10⁶ / microgram` cancels the milligram-to-microgram
factor:

```
on_chain_twap = twap_usd_per_mg × 10^6
              = 5.998 × 10^6
              = 5_998_000 (u64)
```

**Mint computation:**

```
tokens_minted_base_units = (usdc_in_base_units × 10^6) / on_chain_twap
```

For `usdc_in = 1_000_000` (1 USDC) and `on_chain_twap = 5_998_000`:

```
tokens_minted = (1_000_000 × 10^6) / 5_998_000
              = 1_000_000_000_000 / 5_998_000
              = 166_722  (base units = 0.166722 BPC157, i.e. ~0.166722 mg)
```

**Burn computation:**

```
usdc_out_base_units = (tokens_in_base_units × on_chain_twap) / 10^6
```

For `tokens_in = 500_000` (0.5 BPC157) and `on_chain_twap = 5_998_000`:

```
usdc_out = (500_000 × 5_998_000) / 10^6
         = 2_999_000_000_000 / 10^6
         = 2_999_000 (base units = 2.999000 USDC)
```

Both formulas use integer division (truncation, not rounding) — the
truncated dust accrues to the reserve. This is intentional and
matches every PSM-style design.

**Overflow safety.** The intermediate `usdc_in × 10^6` fits in `u128`
for any reasonable USDC input (`u64::MAX × 10^6` overflows `u64` but
not `u128`). All arithmetic in the program uses `checked_mul` /
`checked_div` and reverts on overflow with `PegError::ArithmeticOverflow`
(§7.4).

### 3.4 Fees (V0.1 placeholder)

`PegState` carries a `mint_fee_bps: u16` and `burn_fee_bps: u16`
field. V0.1 hard-codes both to `0` at initialisation. The handlers
include the fee-deduction code path so we can ship non-zero fees in
a future upgrade without an instruction-set change, but no V0.1 deploy
will set them above zero. Collected fees (when enabled) accrue to the
reserve and grow it; there is no separate fee vault and no fee
withdrawal instruction in V0.1.

---

## 4. Account structures

All account discriminators are Anchor-managed (8 bytes prefix). Sizes
below are the data payload, exclusive of the discriminator and the
Solana account header.

### 4.1 `PegState`

PDA. One per peptide. V0.1 instantiates exactly one (`BPC157`).

**Seeds:** `[b"peg_state", peptide_code.as_bytes()]` where
`peptide_code` is the 6-byte ASCII string `"BPC157"`.

```rust
#[account]
pub struct PegState {
    pub peptide_code: [u8; 16],          // ASCII, zero-padded right
    pub peptide_token_mint: Pubkey,      // 32 — BPC-157 SPL Mint address
    pub update_authority: Pubkey,        // 32 — BioHash oracle pubkey

    // Latest TWAP push.
    pub current_twap: u64,               // 8 — micro-USDC per microgram × 10⁶
    pub current_twap_slot: u64,          // 8 — Solana slot of the update_peg_state tx
    pub current_twap_updated_at: i64,    // 8 — clock.unix_timestamp at push
    pub current_twap_observation_set_root: [u8; 32], // 32 — Merkle root from §01 §2.3

    // Staleness + step bounds.
    pub max_twap_age_slots: u64,         // 8 — staleness ceiling (default 15_000 ≈ 2h)
    pub max_twap_step_bps: u16,          // 2 — max move per push, default 5_000 (50%)

    // Fee placeholders (V0.1: both 0).
    pub mint_fee_bps: u16,               // 2
    pub burn_fee_bps: u16,               // 2

    // Cumulative counters (telemetry; not used in pricing logic).
    pub total_minted: u128,              // 16 — lifetime mint volume in tokens
    pub total_burned: u128,              // 16 — lifetime burn volume in tokens
    pub mint_count: u64,                 // 8
    pub burn_count: u64,                 // 8
    pub update_count: u64,               // 8

    pub bump: u8,                        // 1 — canonical PDA bump
    pub _reserved: [u8; 64],             // 64 — forward-compat slack
}
```

**Size:** 16 + 32 + 32 + 8 + 8 + 8 + 32 + 8 + 2 + 2 + 2 + 16 + 16 + 8

- 8 + 8 + 1 + 64 = **271 bytes** + 8-byte discriminator = **279 bytes**
  on-chain.

### 4.2 `ReserveState`

PDA. Singleton. Holds the canonical reference to the USDC vault and
program-wide totals across all peptides.

**Seeds:** `[b"reserve_state"]`.

```rust
#[account]
pub struct ReserveState {
    pub usdc_mint: Pubkey,                // 32 — USDC mint (mainnet/devnet)
    pub usdc_vault: Pubkey,               // 32 — PDA-owned token account holding USDC
    pub vault_authority_bump: u8,         // 1 — bump for ["reserve_vault"] PDA
    pub reserve_state_bump: u8,           // 1 — bump for ["reserve_state"] PDA

    // Cumulative counters (telemetry).
    pub total_usdc_in: u128,              // 16 — lifetime USDC deposited (mints)
    pub total_usdc_out: u128,             // 16 — lifetime USDC withdrawn (burns)
    pub _reserved: [u8; 64],              // 64
}
```

**Size:** 32 + 32 + 1 + 1 + 16 + 16 + 64 = **162 bytes** + 8-byte
discriminator = **170 bytes**.

#### 4.2.1 `usdc_vault` token account

The reserve token account (a standard SPL Token Account, owned by the
SPL Token program) is created at program initialisation as an
**Associated Token Account** of the **`reserve_vault` PDA**:

**Vault authority seeds:** `[b"reserve_vault"]`.

The split between `reserve_state` (data PDA) and `reserve_vault`
(authority PDA) follows the standard Anchor pattern: the data PDA is
the canonical lookup, and a separate authority PDA owns the token
account so that token transfers are signed by the program with a
minimal seed set.

### 4.3 `PeptideTokenMint`

This is **not** a custom account; it is the standard SPL Mint owned
by the SPL Token program. The peg program never reads or writes the
mint account directly — it only invokes SPL Token CPI to mint/burn
supply. The mint authority is the `peg_state` PDA (see §4.1
`peptide_token_mint` field).

The mint is created off-chain (one-time, via a deployment script —
see §8.3) and its address is recorded into `peg_state.peptide_token_mint`
at `initialize_peg_state` time. The deployment script runs:

```bash
spl-token create-token --decimals 6 --mint-authority <peg_state_pda>
```

Then `initialize_peg_state` is called with the resulting mint address.
After init, the mint authority can never be changed back to a
non-PDA key (the SPL Token program enforces this via its standard
`SetAuthority` semantics).

### 4.4 PDA seed summary

| account             | seeds                       | derived address rotates?    |
| ------------------- | --------------------------- | --------------------------- |
| `PegState` (BPC157) | `[b"peg_state", b"BPC157"]` | only with program-id change |
| `ReserveState`      | `[b"reserve_state"]`        | only with program-id change |
| Reserve vault auth  | `[b"reserve_vault"]`        | only with program-id change |

The bumps are stored in the PDA's own account so we never re-derive at
runtime. Anchor's `#[account(seeds = ..., bump = field.bump)]`
constraint enforces this.

### 4.5 Why a separate `ReserveState` instead of folding it into `PegState`

The shared-reserve design means future peptides need to point at the
same USDC vault. If `usdc_vault` lived in each `PegState`, adding a
second peptide would either duplicate the reserve (defeats the point)
or require a migration to a separate reserve account anyway. Splitting
the reserve out from the per-peptide state is the smaller change to
make once.

---

## 5. Instruction set

V0.1 ships exactly four instructions: three runtime instructions
(`mint_peptide_token`, `burn_peptide_token`, `update_peg_state`) plus
one initialization instruction (`initialize_peg_state` — and a sibling
`initialize_reserve_state`) that runs once per deployment.

Initialisation instructions are listed in §5.4 below. The runtime
instructions are §5.1–§5.3.

### 5.1 `mint_peptide_token`

**Purpose:** user deposits USDC into the reserve and receives newly
minted BPC-157 tokens at the current TWAP rate.

**Anchor signature:**

```rust
pub fn mint_peptide_token(
    ctx: Context<MintPeptideToken>,
    usdc_amount_in: u64,
    min_tokens_out: u64,
) -> Result<()>
```

**Parameters:**

- `usdc_amount_in` — exact USDC base units to deposit. Must be > 0.
- `min_tokens_out` — slippage protection; the user's minimum
  acceptable BPC-157 base units. If the computed `tokens_out` from
  the current TWAP is less than `min_tokens_out`, the instruction
  reverts with `PegError::SlippageExceeded`.

**Accounts (`MintPeptideToken<'info>`):**

| name                 | constraints                                                                                      |
| -------------------- | ------------------------------------------------------------------------------------------------ |
| `user`               | `Signer<'info>`                                                                                  |
| `peg_state`          | `#[account(mut, seeds = [b"peg_state", peg_state.peptide_code_slice()], bump = peg_state.bump)]` |
| `reserve_state`      | `#[account(mut, seeds = [b"reserve_state"], bump = reserve_state.reserve_state_bump)]`           |
| `peptide_token_mint` | `#[account(mut, address = peg_state.peptide_token_mint)]`                                        |
| `user_usdc_account`  | `#[account(mut, token::mint = reserve_state.usdc_mint, token::authority = user)]`                |
| `reserve_usdc_vault` | `#[account(mut, address = reserve_state.usdc_vault)]`                                            |
| `user_token_account` | `#[account(mut, token::mint = peg_state.peptide_token_mint, token::authority = user)]`           |
| `clock`              | `Sysvar<'info, Clock>`                                                                           |
| `token_program`      | `Program<'info, Token>`                                                                          |

**Logic (intended; not implemented in scaffold):**

1. Reject if `peg_state.current_twap == 0` (program never received an
   `update_peg_state`) → `PegError::NoTwapSet`.
2. Reject if the TWAP is stale: if `clock.slot -
peg_state.current_twap_slot > peg_state.max_twap_age_slots`,
   revert with `PegError::TwapStale`.
3. Reject if `usdc_amount_in == 0` → `PegError::ZeroAmount`.
4. Compute the post-fee USDC available for minting:
   `usdc_for_mint = usdc_amount_in - (usdc_amount_in * mint_fee_bps / 10_000)`.
   In V0.1 with `mint_fee_bps = 0`, this is just `usdc_amount_in`.
5. Compute `tokens_out = (usdc_for_mint × 10^6) / current_twap`,
   using `u128` checked arithmetic; revert on overflow.
6. Reject if `tokens_out < min_tokens_out` → `PegError::SlippageExceeded`.
7. CPI to SPL Token `transfer`: move `usdc_amount_in` from
   `user_usdc_account` to `reserve_usdc_vault`.
8. CPI to SPL Token `mint_to`: mint `tokens_out` to
   `user_token_account`, signed by `peg_state` PDA.
9. Update telemetry counters: `peg_state.total_minted +=
tokens_out as u128`, `peg_state.mint_count += 1`,
   `reserve_state.total_usdc_in += usdc_amount_in as u128`.
10. Emit `MintEvent` (see §7.5).

**Compute budget estimate.** ~30k CU (one CPI to transfer, one CPI
to mint_to, three account writes). Default Solana transaction
budget (200k CU) is comfortably sufficient; no `ComputeBudget`
instruction needed.

### 5.2 `burn_peptide_token`

**Purpose:** user burns BPC-157 tokens and receives USDC from the
reserve at the current TWAP rate.

**Anchor signature:**

```rust
pub fn burn_peptide_token(
    ctx: Context<BurnPeptideToken>,
    tokens_in: u64,
    min_usdc_out: u64,
) -> Result<()>
```

**Parameters:**

- `tokens_in` — exact BPC-157 base units to burn. Must be > 0.
- `min_usdc_out` — slippage protection; minimum USDC base units the
  user is willing to receive.

**Accounts (`BurnPeptideToken<'info>`):**

Same as `MintPeptideToken` plus the reserve vault authority PDA:

| name                      | constraints                                                                         |
| ------------------------- | ----------------------------------------------------------------------------------- |
| `user`                    | `Signer<'info>`                                                                     |
| `peg_state`               | `#[account(mut, seeds = [...], bump = peg_state.bump)]`                             |
| `reserve_state`           | `#[account(mut, seeds = [b"reserve_state"], bump = ...)]`                           |
| `reserve_vault_authority` | `#[account(seeds = [b"reserve_vault"], bump = reserve_state.vault_authority_bump)]` |
| `peptide_token_mint`      | `#[account(mut, address = peg_state.peptide_token_mint)]`                           |
| `user_token_account`      | `#[account(mut, token::mint = ..., token::authority = user)]`                       |
| `user_usdc_account`       | `#[account(mut, token::mint = reserve_state.usdc_mint, token::authority = user)]`   |
| `reserve_usdc_vault`      | `#[account(mut, address = reserve_state.usdc_vault)]`                               |
| `clock`                   | `Sysvar<'info, Clock>`                                                              |
| `token_program`           | `Program<'info, Token>`                                                             |

**Logic (intended; not implemented in scaffold):**

1. Reject if `current_twap == 0`, `tokens_in == 0`, or TWAP is stale
   (same checks as §5.1 steps 1–3).
2. Compute `usdc_gross = (tokens_in × current_twap) / 10^6`,
   `u128` checked arithmetic.
3. Compute `usdc_fee = usdc_gross × burn_fee_bps / 10_000`. V0.1: 0.
4. `usdc_out = usdc_gross - usdc_fee`.
5. Reject if `usdc_out < min_usdc_out` → `PegError::SlippageExceeded`.
6. **Reserve sufficiency check**: if `reserve_usdc_vault.amount <
usdc_out`, revert with `PegError::InsufficientReserve`. This is
   the "burn under reserve insufficiency: revert with clear error"
   semantic from the architectural decision pinned at design start.
   No partial fill, no IOU, no graceful degradation in V0.1.
7. CPI to SPL Token `burn`: burn `tokens_in` from
   `user_token_account`, signed by user.
8. CPI to SPL Token `transfer`: move `usdc_out` from
   `reserve_usdc_vault` to `user_usdc_account`, signed by
   `reserve_vault_authority` PDA.
9. Update telemetry: `peg_state.total_burned += tokens_in as u128`,
   `peg_state.burn_count += 1`,
   `reserve_state.total_usdc_out += usdc_out as u128`.
10. Emit `BurnEvent` (see §7.5).

**Compute budget estimate.** ~30k CU.

### 5.3 `update_peg_state`

**Purpose:** the BioHash oracle pushes a new TWAP into `PegState`.
This is the only state-mutating instruction the program exposes to
the oracle authority.

**Anchor signature:**

```rust
pub fn update_peg_state(
    ctx: Context<UpdatePegState>,
    new_twap: u64,
    observation_set_root: [u8; 32],
) -> Result<()>
```

**Parameters:**

- `new_twap` — the new TWAP value in micro-USDC per milligram (i.e.,
  `twap_usd_per_mg × 10^6`). Must be > 0.
- `observation_set_root` — the same 32-byte Merkle root the oracle
  embedded in the corresponding TWAP commit memo (§01 §2.3). Stored
  in `peg_state.current_twap_observation_set_root` so off-chain
  verifiers can correlate the on-chain peg state with the off-chain
  TWAP commit.

**Accounts (`UpdatePegState<'info>`):**

| name        | constraints                                                                         |
| ----------- | ----------------------------------------------------------------------------------- |
| `authority` | `Signer<'info>`                                                                     |
| `peg_state` | `#[account(mut, seeds = [...], bump = peg_state.bump, has_one = update_authority)]` |
| `clock`     | `Sysvar<'info, Clock>`                                                              |

The `has_one = update_authority` constraint binds the `Signer`
account to `peg_state.update_authority` and reverts otherwise with
Anchor's `ConstraintHasOne` (which we surface to callers as
`PegError::UnauthorizedUpdater`).

**Logic (intended; not implemented in scaffold):**

1. Anchor's `has_one` constraint already enforces signer == authority.
   No additional check needed beyond the constraint.
2. Reject `new_twap == 0` → `PegError::ZeroAmount`.
3. **Maximum-step check**: if `peg_state.current_twap > 0`
   (i.e., not the first push), compute the bps delta:
   `delta_bps = |new_twap - current_twap| × 10_000 / current_twap`.
   If `delta_bps > peg_state.max_twap_step_bps`, revert with
   `PegError::TwapStepTooLarge`. The default
   `max_twap_step_bps = 5_000` (50%) is generous enough to accommodate
   the volatile early peptide market but tight enough to bound the
   damage from a single compromised push.
4. Update `peg_state.current_twap = new_twap`,
   `current_twap_slot = clock.slot`,
   `current_twap_updated_at = clock.unix_timestamp`,
   `current_twap_observation_set_root = observation_set_root`,
   `update_count += 1`.
5. Emit `TwapUpdateEvent` (see §7.5).

**Compute budget estimate.** ~5k CU (no CPIs, just account write).

**Decoupled-push design rationale.** The oracle service publishes the
TWAP commit memo (§01 §2.3) in one transaction and calls
`update_peg_state` in a separate transaction. We deliberately do
**not** bundle them via CPI for two reasons:

- The TWAP commit memo is a passive anchor that succeeds or fails
  independent of the peg program. If the peg program reverts (e.g.,
  `TwapStepTooLarge`), the underlying TWAP value is still anchored
  on-chain via the memo and remains queryable.
- The two transactions can be sent in any order; verifiers correlate
  them via `observation_set_root` (which appears in both the memo
  and the `update_peg_state` instruction data).

The off-chain oracle is responsible for sending both. A failure to
push the peg update is logged by the oracle but does not block the
underlying TWAP from being anchored.

### 5.4 Initialisation instructions

Both initialisation instructions run **once per deployment** (the
`init` constraints prevent re-initialisation). They are intentionally
permissionless to call so the deployer doesn't need to coordinate
ownership of the `payer` account with the `update_authority` —
`update_authority` is set as an explicit parameter rather than
inferred from the signer.

#### `initialize_reserve_state`

```rust
pub fn initialize_reserve_state(
    ctx: Context<InitializeReserveState>,
    usdc_mint: Pubkey,
) -> Result<()>
```

Creates `ReserveState` PDA + USDC vault token account (owned by
`reserve_vault_authority` PDA). One call, ever; subsequent calls
revert with Anchor's `Initialized` constraint.

#### `initialize_peg_state`

```rust
pub fn initialize_peg_state(
    ctx: Context<InitializePegState>,
    peptide_code: [u8; 16],
    update_authority: Pubkey,
    peptide_token_mint: Pubkey,
    max_twap_age_slots: u64,
    max_twap_step_bps: u16,
) -> Result<()>
```

Creates a new `PegState` PDA for the given peptide code. The
`peptide_token_mint` parameter must reference an SPL Mint whose
mint authority equals the freshly-derived `peg_state` PDA — the
handler verifies this via a token account introspection check before
finalising (`PegError::MintAuthorityMismatch` otherwise). Reverts on
re-init (Anchor's `Initialized` constraint).

The deployment runbook (§8.3) walks through how to do this without
catching an "uninitialized mint" race: create the mint with a
temporary authority, derive the `peg_state` PDA address ahead of
time, transfer mint authority to the PDA, then call
`initialize_peg_state`.

### 5.5 What is **not** an instruction in V0.1

- `set_update_authority` — no rotation in V0.1; rotation requires a
  program upgrade (§9.2).
- `pause_mint` / `pause_burn` — no circuit breakers in V0.1 beyond
  the staleness check (§6.2) and step-bps check (§6.3).
- `withdraw_fees` — no fee accrual in V0.1 (§3.4).
- `close_peg_state` — no shutdown path; if a peptide is delisted
  in the future it stays initialised but with `current_twap = 0`
  (which prevents any new mints/burns).

---

## 6. Oracle integration

### 6.1 End-to-end flow

```
┌─────────────────┐    1. compute      ┌─────────────────┐
│ apps/worker     │  twap_usd_per_mg   │ peptide_twaps   │
│ (per-minute)    │ ─────────────────► │ table (DB)      │
└─────────────────┘                    └─────────────────┘
                                                │
                                                │ 2. hourly harvest
                                                ▼
┌─────────────────┐    3a. publish     ┌─────────────────┐
│ apps/oracle     │   TWAP commit memo │ Solana mainnet  │
│ (HH:00:30 UTC)  │ ─────────────────► │ Memo program    │
└─────────────────┘                    └─────────────────┘
        │                                       │
        │ 3b. push update_peg_state             │
        ▼                                       │
┌─────────────────┐                             │
│ biohash-peg     │ ◄───────────────────────────┘
│ on Solana       │   verify both txs by
└─────────────────┘   observation_set_root
```

The oracle service (existing — `apps/oracle`) owns both the TWAP
commit memo (`twap_commits` row → on-chain memo, per spec §01) and
the `update_peg_state` push. After §01's TWAP commit lands and
finalises, the oracle issues a separate `update_peg_state` call with
the same `twap_value` (encoded per §3.3) and `observation_set_root`.

### 6.2 Staleness check (`max_twap_age_slots`)

`PegState.max_twap_age_slots` is the sliding window during which the
last `current_twap` is treated as fresh enough to mint or burn
against. V0.1 default: **15,000 slots ≈ 2 hours** at the canonical
500ms slot time.

Why 2 hours: the oracle's TWAP commit cadence is hourly (HH:00:30
UTC). 2 hours covers one missed commit cycle — enough for a single
oracle restart, RPC outage, or transient signature failure to
recover without locking out users. A second consecutive missed cycle
takes the program offline (mint/burn revert with `TwapStale`) until
the oracle catches up — which is the desired behaviour: better to
refuse trades against stale data than to settle them at an outdated
price.

The threshold is mutable in V0.1 only via program upgrade (no setter
instruction). If we observe sustained oracle outages in the wild,
we'll bump the default in v0.2 — see §9.4.

### 6.3 Maximum-step check (`max_twap_step_bps`)

Caps how far a single `update_peg_state` can move the peg from the
previous value, in basis points. V0.1 default: **5,000 bps = 50%**.

A 50% cap means:

- Worst-case attack damage from a single compromised push is bounded
  to 50% reserve drain (an attacker could push the TWAP 50% lower
  than reality and burn-redeem at the depressed price).
- Real peptide market moves can swing >20% intra-day; 50% leaves
  headroom for legitimate volatility while still blocking pathological
  pushes.

The first `update_peg_state` (when `current_twap == 0`) bypasses the
step check — there's no "previous value" to compute a delta against.
This is the bootstrap moment: the deployer is responsible for ensuring
the initial value matches reality.

### 6.4 Off-chain reconciliation

A verifier wanting to confirm that `peg_state.current_twap` corresponds
to a real, anchored TWAP follows this flow:

1. Read `peg_state.current_twap_observation_set_root` from the
   on-chain account.
2. Query the off-chain `twap_commits` table (or the
   `GET /api/v1/twaps?peptide_code=BPC157` endpoint) for the row
   whose `observation_set_root` matches.
3. Verify the corresponding TWAP commit memo is anchored on Solana,
   per spec §01 §5.4 verification flow.
4. Confirm `twap_value` from that row, when encoded per §3.3
   (i.e., `× 10^6` and truncated), equals
   `peg_state.current_twap`.

This is a four-call check that can be implemented as a single
endpoint extension to the existing verification API (§9.5).

---

## 7. Failure modes and recovery

### 7.1 TWAP stale

**Trigger:** `clock.slot - current_twap_slot > max_twap_age_slots`.

**User experience:** any `mint_peptide_token` or `burn_peptide_token`
call reverts with `PegError::TwapStale`. The peg is paused for new
trades but reserve funds and outstanding token supply are untouched.

**Recovery:** the oracle catches up by sending an `update_peg_state`
with a fresh value. Once that lands, mint/burn resume immediately
(no admin intervention needed).

**Operational alert:** the oracle's existing `peptide_twaps` health
endpoint (§01 §08.4) covers the upstream signal. Add a derived alert
on `peg_state.current_twap_slot` falling more than `max_twap_age_slots

- 1000` behind current slot (i.e., warn when within ~8 minutes of
  the staleness ceiling).

### 7.2 Reserve insufficient

**Trigger:** a `burn_peptide_token` request exceeds
`reserve_usdc_vault.amount`.

**User experience:** the burn reverts with `PegError::InsufficientReserve`.
The user keeps their tokens; no partial fill.

**Recovery:** wait for new mints to refill the reserve, or the
operator manually replenishes the reserve by transferring USDC into
`reserve_usdc_vault`. **Note:** `reserve_usdc_vault` is a standard
SPL token account — anyone can transfer USDC into it; the program
itself doesn't track or care where the USDC came from.

**Architectural note.** Because mints and burns are at the same TWAP,
the reserve cannot run dry from arbitrage alone — every USDC out
came from a USDC in at a higher-or-equal TWAP, and reverse holds
when TWAP rises. The reserve only goes negative-equity when the TWAP
moves against outstanding circulating supply (e.g., TWAP doubles
while the reserve has only 1× of outstanding redemption value). This
is the same risk profile as algorithmic stablecoins — V0.1 ships
without a defense; §9.7 documents the threat for future iterations.

### 7.3 Slippage exceeded

**Trigger:** `mint_peptide_token` produces fewer tokens than
`min_tokens_out` (the TWAP moved against the user between transaction
construction and execution), or `burn_peptide_token` produces less
USDC than `min_usdc_out`.

**User experience:** revert with `PegError::SlippageExceeded`. User
keeps their input.

**Recovery:** the user retries with looser slippage tolerance or
waits for the next TWAP push.

### 7.4 Arithmetic overflow

**Trigger:** any intermediate computation overflows `u128`. In
practice this requires a TWAP value or input amount well outside
plausible market values, but the check is unconditional.

**User experience:** revert with `PegError::ArithmeticOverflow`.

**Recovery:** none needed — the program rejects the input and the
tx fails atomically.

### 7.5 Events

The program emits the following Anchor events (logged via Solana's
program log mechanism; consumed by indexers and downstream UIs):

```rust
#[event]
pub struct MintEvent {
    pub user: Pubkey,
    pub peptide_code: [u8; 16],
    pub usdc_in: u64,
    pub tokens_out: u64,
    pub twap_used: u64,
    pub slot: u64,
}

#[event]
pub struct BurnEvent {
    pub user: Pubkey,
    pub peptide_code: [u8; 16],
    pub tokens_in: u64,
    pub usdc_out: u64,
    pub twap_used: u64,
    pub slot: u64,
}

#[event]
pub struct TwapUpdateEvent {
    pub peptide_code: [u8; 16],
    pub previous_twap: u64,
    pub new_twap: u64,
    pub observation_set_root: [u8; 32],
    pub slot: u64,
}
```

### 7.6 Catastrophic recovery: oracle authority compromise

If the BioHash oracle authority private key is compromised (the
incident scenario from §2.4):

1. **Operator action**: rotate the off-chain authority per spec §01
   §08.5 (revoke compromised key, generate new keypair, update
   `docs/oracle-authority.md` + `/api/v1/authority`).
2. **On-chain action**: the V0.1 program does **not** support
   rotating `peg_state.update_authority` via instruction. Recovery
   requires a program upgrade that either (a) hard-codes the new
   authority and migrates the existing PDA, or (b) introduces a
   `set_update_authority` instruction (§9.2 future work). Because
   this is the catastrophic path, it intentionally requires the
   highest-friction response.
3. **User-facing**: pause trading off-chain (UI banner, withdraw
   liquidity from any AMM listings) until the program upgrade lands.
   On-chain mint/burn continue to function but at the
   attacker-pushed TWAP — the staleness check (§6.2) will eventually
   freeze trading after `max_twap_age_slots` slots if the legitimate
   oracle stops pushing.

V0.1 ships with the program upgrade authority (separate from
`update_authority`) on a hardware wallet held by the operator. The
upgrade-authority key is the **most critical** secret in the system.

---

## 8. Devnet deployment plan

### 8.1 Prerequisites

- `solana-cli` ≥ 1.18 installed locally.
- `anchor-cli` 0.31.x installed locally. (We pin to 0.31 not 0.30
  because anchor 0.30's transitive `solana-program` pulls in
  `block-buffer 0.12` which requires Rust 1.85+, while anchor-cli
  0.30 itself wants Rust 1.79–1.82. Anchor 0.31 lifts that
  constraint and builds cleanly under any Rust ≥ 1.79.)
- A Solana CLI keypair funded with ≥ 5 devnet SOL for the
  deployment + initialisation.
- The BioHash oracle authority pubkey
  (`FmBggsBjzGsHrtMayYG8ix2JzoYhVczrwJaGGKPpNKK7`) — used as the
  `update_authority` parameter for `initialize_peg_state`.
- Devnet USDC mint address: `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`.

### 8.2 Build + deploy

```bash
cd /home/user/peptidefi
anchor build                 # produces target/deploy/biohash_peg.so
anchor deploy --provider.cluster devnet
# capture program id from output → record in Anchor.toml [programs.devnet]
```

Record the deployed program id in two places:

- `Anchor.toml` `[programs.devnet]`
- `docs/specs/02-peg-mechanism.md` (a §10 amendment to this file
  added at deploy time)

### 8.3 Initialise reserve and peg state

The order matters: reserve first (since `peg_state` doesn't depend
on it but the deployment script reads `reserve_state.usdc_mint`
from the same file we generate), then mint creation, then peg state.

```bash
# 1. Initialise the shared reserve.
ts-node scripts/init-reserve.ts \
  --usdc-mint 4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU

# 2. Create the BPC-157 SPL Mint with PDA-as-mint-authority.
#    The script computes the peg_state PDA, creates the mint with
#    a temporary authority, transfers mint authority to the PDA,
#    then prints the mint address.
ts-node scripts/create-peptide-mint.ts \
  --peptide-code BPC157 \
  --decimals 6

# 3. Initialise the BPC-157 PegState.
ts-node scripts/init-peg-state.ts \
  --peptide-code BPC157 \
  --update-authority FmBggsBjzGsHrtMayYG8ix2JzoYhVczrwJaGGKPpNKK7 \
  --peptide-token-mint <from step 2> \
  --max-twap-age-slots 15000 \
  --max-twap-step-bps 5000
```

These scripts are **not** in the V0.1 scaffold — they ship with the
implementation phase.

### 8.4 Smoke test

After init:

1. Manual `update_peg_state` from a test keypair using the same
   pubkey as `update_authority` (devnet only — for mainnet, this is
   the production oracle). Push `new_twap = 5_998_000` and
   `observation_set_root = [0u8; 32]` as a smoke-test bootstrap.
2. Mint test: 1 USDC in → expect ~0.166722 BPC157 out. Verify
   `MintEvent` was emitted via `solana confirm <sig> --output json`.
3. Burn test: burn the just-minted tokens; expect ~1 USDC back
   (minus any rounding dust).
4. Slippage test: re-mint with deliberately tight `min_tokens_out`
   that exceeds the actual output; expect `SlippageExceeded`.
5. Stale test: wait 15,000 slots without an `update_peg_state`,
   then attempt mint; expect `TwapStale`.
6. Insufficient reserve test: pre-burn the reserve down (transfer
   most USDC out via a mint+burn cycle), then attempt to burn an
   amount exceeding what's left; expect `InsufficientReserve`.

### 8.5 Stability period

Run on devnet for **a minimum of 14 days** with the production
oracle service pushing `update_peg_state` against a real
`twap_commits` feed. Track:

- Push success rate (% of `twap_commits` rows that get a corresponding
  `update_peg_state` within 5 minutes of the memo finalising).
- Mint/burn success rate (target: >99% of attempts complete without
  reverting on anything other than user-side errors like
  `SlippageExceeded`).
- Reserve drift: cumulative `total_usdc_in - total_usdc_out` should
  match the `reserve_usdc_vault.amount` at all times.

Ship to mainnet only after 14 consecutive days with no on-chain
reverts attributable to the program (slippage and stale rejections
don't count; arithmetic overflow or unexpected reverts do).

---

## 9. Mainnet upgrade path and future work

### 9.1 Mainnet cutover

Procedure follows the same shape as the §01 mainnet cutover (in
`docs/operator-setup.md` §6):

1. Generate a fresh program keypair for mainnet (do not reuse the
   devnet keypair; mainnet program ids are derived from the
   keypair).
2. Set Anchor's `[programs.mainnet]` entry to the new id.
3. `anchor deploy --provider.cluster mainnet` from a hardware-wallet-
   backed deployer keypair. Cost: ~3-5 SOL for a ~600KB program.
4. Re-run §8.3 initialisation against mainnet with the production
   `update_authority` and the mainnet USDC mint
   (`EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`).
5. Set the program upgrade authority to a hardware wallet:
   `solana program set-upgrade-authority <PROGRAM_ID> --new-upgrade-authority <HW_WALLET>`.
6. Manually push the bootstrap `update_peg_state` with the current
   live TWAP from production.
7. Open mint/burn to the public.

### 9.2 v0.2 — `set_update_authority` instruction

Adds an instruction to rotate `peg_state.update_authority` without
a program upgrade. Reduces the friction of routine key rotation
from "redeploy program" to "send one tx". The instruction is signed
by the **upgrade authority**, not the current `update_authority`,
to handle the compromise case where the current authority is
already in attacker hands.

### 9.3 v0.2 — multisig upgrade authority

Migrate the program upgrade authority from a single hardware wallet
to a 2-of-3 Squads multisig. Standard Solana DeFi practice;
eliminates the single-key-loss catastrophic failure mode.

### 9.4 v0.2 — `max_twap_age_slots` setter

Adds a setter instruction (signed by `update_authority`) to tune
the staleness threshold without a program upgrade. The hard-coded
default is conservative; we'll likely want to tighten or loosen
it based on real-world oracle uptime patterns.

### 9.5 v0.2 — peg-state verification API endpoint

Add `GET /api/v1/peg/state?peptide_code=BPC157` to the existing
verification API (apps/api). Returns the on-chain `PegState`
account decoded into JSON, plus the corresponding `twap_commits`
row by `observation_set_root`. Lets any UI confirm that the
on-chain peg matches the off-chain TWAP without writing decoder
code.

### 9.6 v0.3 — multi-asset reserves

Support USDT and DAI in addition to USDC. Requires:

- `ReserveState` becomes a per-asset PDA
  (`["reserve_state", reserve_mint]`).
- Each `PegState` declares which reserve(s) it accepts.
- Mint/burn instructions take a `reserve_mint` parameter.

Not a minor change — pushed to v0.3 to avoid bloating V0.1.

### 9.7 v0.4 — reserve-coverage defense

Address the algorithmic-stablecoin failure mode flagged in §7.2: if
TWAP rises faster than reserve grows, outstanding circulating
supply exceeds reserve value. Possible mitigations include:

- Mint/burn fee that grows as reserve coverage drops below 100%
  (creates organic incentive to refill).
- Hard mint cap pegged to reserve coverage (refuses new mints when
  `reserve_value / outstanding_supply_value < threshold`).
- Insurance fund accruing from mint fees, callable on coverage shortfall.

This is research work, not a minor upgrade. Ship V0.1 first to
learn the actual user-flow shape before designing the defense.

### 9.8 v0.x — additional peptides

The shared-reserve design means adding a peptide is two steps:
deploy a new SPL mint with `peg_state` PDA as authority, then call
`initialize_peg_state` for the new peptide code. No program upgrade,
no schema migration, no oracle changes (the oracle already publishes
TWAPs for every active peptide).

---

## 10. Cross-references

- **Spec §01** (`docs/specs/01-onchain-commit-layer.md` and
  `docs/specs/01-onchain-commit-layer/`) — the on-chain commit layer
  this peg builds on. Specifically:
  - §01 §2.3 — TWAP commit memo schema (the `observation_set_root`
    this peg references).
  - §01 §3 — oracle service architecture.
  - §01 §5 — verification flow + API endpoints.
- **`docs/oracle-authority.md`** — canonical record of the
  `update_authority` pubkey.
- **`docs/operator-setup.md` §6** — mainnet cutover runbook for
  spec §01; the peg cutover (§9.1) follows the same template.
- **`programs/biohash-peg/`** — the Anchor program scaffold this
  spec describes.
