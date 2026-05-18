# 04 Tokenised Peptides

This section is v1. It covers what is publicly verifiable on chain
today. The deployed peg program's full instruction set is not yet
documented here. Section 4 will expand in v1.1 once the instruction
surface is mapped from on-chain transactions.

## What is deployed?

| Field | Value |
| ----- | ----- |
| Peg program | `2cKMtgXPQt1zT8aWzBAh9LkH3Cf11ris6NDBjrq9J8s7` ([Solscan](https://solscan.io/account/2cKMtgXPQt1zT8aWzBAh9LkH3Cf11ris6NDBjrq9J8s7)) |
| Peg state PDA (BPC-157) | `3iBdy1xHpvUdcRwXDVboFLXEbhJLEk83DN1GNE4jPLrv` ([Solscan](https://solscan.io/account/3iBdy1xHpvUdcRwXDVboFLXEbhJLEk83DN1GNE4jPLrv)) |
| $bBPC157 SPL mint | `2NK6tdGZ7C6m9GQN6LP8yU8TQGPELeQ8qYsyTAhPAKmp` ([Solscan](https://solscan.io/account/2NK6tdGZ7C6m9GQN6LP8yU8TQGPELeQ8qYsyTAhPAKmp)) |
| Reserve state PDA | `4n5sDmtGkHKpQy6NBCXoT2obpwEdqzaVqXA9oYs2eB5q` ([Solscan](https://solscan.io/account/4n5sDmtGkHKpQy6NBCXoT2obpwEdqzaVqXA9oYs2eB5q)) |
| Reserve USDC vault | `HYKqsEnmAMCKBjbDQBK15zcgAhh6yvd7sY94mEBULLn1` ([Solscan](https://solscan.io/account/HYKqsEnmAMCKBjbDQBK15zcgAhh6yvd7sY94mEBULLn1)) |
| Underlying USDC mint | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` |
| $bBPC157 decimals | 6 |
| $bBPC157 freeze authority | None (immutable) |
| Update authority on peg state | `FmBggsBjzGsHrtMayYG8ix2JzoYhVczrwJaGGKPpNKK7` (oracle authority) |

The peg state PDA is derived from seeds `["peg_state",
peptide_code_padded_to_16_bytes]` under the peg program. The reserve
state PDA is derived from the constant seed `["reserve_state"]`.

## How is mint and burn gated?

The $bBPC157 SPL mint at
`2NK6tdGZ7C6m9GQN6LP8yU8TQGPELeQ8qYsyTAhPAKmp` has its
`mint_authority` set to the peg state PDA. Because only the peg
program can sign as that PDA (it owns the seeds), the only way new
$bBPC157 supply can be created is through a peg-program instruction
that calls `mintTo` via CPI under the PDA signer. There is no human
keypair anywhere that can mint $bBPC157.

The same authority binding is the burn gate: burning $bBPC157 back to
USDC has to flow through the program in order for the reserve vault
at `HYKqsEnmAMCKBjbDQBK15zcgAhh6yvd7sY94mEBULLn1` to release USDC,
because the reserve vault's authority is also a PDA owned by the
program (`reserve_vault_authority`, derived from seeds
`["reserve_vault"]`).

What this means in practice:

- $bBPC157 supply moves only when the peg program executes. As of
  this writing the circulating supply is small (single-digit tens of
  tokens), consistent with launch-phase activity.
- The TWAP value the program references for any mint or burn is the
  one most recently pushed to the peg state by
  `update_peg_state`. That instruction is invoked by the oracle's
  peg pusher after every finalised TWAP commit. See
  `apps/oracle/src/peg/peg-pusher.ts` and
  `docs/runbooks/peg-pusher.md`.
- The reserve model is USDC-backed: the program holds USDC in the
  reserve vault and issues $bBPC157 against it. The exact ratio at
  mint and the redemption mechanics on burn are part of the
  instruction set documented in v1.1.

## What instructions are confirmed?

Three instructions are confirmed deployed because the script that
deployed them is in the repo at `scripts/initialize-peg-mainnet.ts`
and the resulting state is on chain:

- `initialize_reserve_state(usdc_mint)` (one-time)
- `initialize_peg_state(peptide_code, update_authority, peptide_token_mint, max_twap_age_slots, max_twap_step_bps)` (per peptide, one-time)
- `update_peg_state(new_twap, observation_set_root)` (per finalised TWAP, by the oracle authority)

The program holds additional instructions for mint and burn that are
known to be deployed (because $bBPC157 supply is moving and only the
program can mint), but their exact names and argument shapes are not
captured in the on-file IDL at `scripts/idl/biohash_peg.json`. The
on-file IDL is the oracle-side surface only. v1.1 will document the
mint and burn instructions once they are decoded from recent
mainnet transactions.

If you need the full deployed instruction surface today, decode any
recent transaction that minted or burned $bBPC157 via Solscan: the
`Instructions` block will show the discriminator and account list,
which together identify the instruction. Cross-reference against the
peg program in your local copy of the source when it lands.

## What is on the peg state today?

The peg state at `3iBdy1xHpvUdcRwXDVboFLXEbhJLEk83DN1GNE4jPLrv`
carries (per the layout in
`scripts/idl/biohash_peg.json#types.PegState`):

- `peptide_code` ASCII-padded "BPC157"
- `peptide_token_mint` = $bBPC157
- `update_authority` = oracle authority pubkey
- `current_twap`, `current_twap_slot`, `current_twap_updated_at`,
  `current_twap_observation_set_root` (most recent TWAP push)
- `max_twap_age_slots` (staleness bound on the cached TWAP)
- `max_twap_step_bps` (per-push cap on TWAP change). The deployed
  value is configured at peg-state initialization; the current
  on-chain value is documented in v1.1.
- `mint_fee_bps`, `burn_fee_bps` (fee fields, default zero unless
  the program writes them on init). Active value documented in v1.1.
- `total_minted`, `total_burned`, `mint_count`, `burn_count`,
  `update_count` (running counters)

A reader who wants the current numeric state can decode the PDA bytes
directly via `getAccountInfo`. The Anchor account discriminator for
`PegState` is `[100, 166, 10, 181, 119, 220, 240, 156]`.

## Composability

A Solana program that wants the most recent BPC-157 TWAP can read it
directly from the peg state PDA, the same way a downstream consumer
reads the index PDA from the index program (see Section 8). The peg
state's `current_twap` is the per-peptide reference value the rest of
the peg program uses for mint and burn.

If your protocol mints, burns, holds, or settles against $bBPC157,
treat the peg state PDA as the canonical oracle for the per-peptide
price; treat the index PDA as the canonical oracle for the basket
benchmark.

## What's deferred to v1.1

Items intentionally out of scope for v1 of this doc:

- Full instruction-by-instruction reference for the peg program
  (mint, burn, fee-distribution, reserve-management instructions).
  The on-file IDL covers the oracle-side surface only.
- Current deployed values of `max_twap_step_bps`, `mint_fee_bps`,
  `burn_fee_bps`. These will be added after decoding the live peg
  state bytes.
- Fee distribution mechanics. Whether fees accrue to the protocol,
  to stakers, to a treasury, or are zero today.
- Staking. Not deployed. Whether $bBPC157 holders can stake against
  the index, and the contract structure, are open.
- Distribution. How $bBPC157 will reach holders at scale (LP,
  airdrop, bond, direct sale) is undecided.
- Slippage protection at mint and burn time. The IDL hints at it
  (the `SlippageExceeded` error code), but the user-side parameter
  is documented in v1.1.

When the v1.1 update lands, this section will be replaced with a
full per-instruction reference plus the live numeric state.
