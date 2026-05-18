# 04 Tokenised Peptides

This section is a placeholder.

The peg program is deployed at
`2cKMtgXPQt1zT8aWzBAh9LkH3Cf11ris6NDBjrq9J8s7`
([Solscan](https://solscan.io/account/2cKMtgXPQt1zT8aWzBAh9LkH3Cf11ris6NDBjrq9J8s7)).
The deployed instruction set in the IDL on file
(`scripts/idl/biohash_peg.json`) is:

- `initialize_reserve_state` (one-time, USDC reserve setup)
- `initialize_peg_state` (per-peptide state)
- `update_peg_state` (called by the oracle authority after every
  finalized TWAP commit)

Mint, burn, fee distribution, and staking are documented as design
intent across the codebase (PegState carries `mint_fee_bps`,
`burn_fee_bps`, `total_minted`, `total_burned`, `mint_count`,
`burn_count`; the `ReserveState` account exists with USDC vault
fields; the error space includes `SlippageExceeded`,
`InsufficientReserve`, and `MintAuthorityMismatch`). The corresponding
instructions are not in the on-file IDL and have not been verified
against deployed program bytecode at the time of writing.

Until Conrad confirms what is in the deployed program, this section
will not document mint, burn, fee, or staking mechanics. The section
will be filled in once the deployed surface is verified.

What is known to be deployed and is documented elsewhere:

- The peg state for BPC-157 is initialised on mainnet. The state PDA
  is derived from seeds `["peg_state", peptide_code_padded_to_16]`
  under the peg program. The oracle's peg pusher invokes
  `update_peg_state` after every finalised BPC-157 TWAP, subject to a
  60-second per-peptide rate limit, a staleness guard, and a max-step
  guard. See `docs/runbooks/peg-pusher.md` for the operational
  surface.
- The on-chain `max_twap_step_bps` and `max_twap_age_slots` values
  were set by `scripts/initialize-peg-mainnet.ts` (10% step cap,
  15000 slots staleness cap, approximately 2 hours on mainnet).
- The peg authority is the same key as the oracle authority:
  `FmBggsBjzGsHrtMayYG8ix2JzoYhVczrwJaGGKPpNKK7`.

Open questions to resolve before this section is fleshed out:

- What does the deployed program actually do beyond push-twap? Are
  mint and burn instructions in the bytecode but absent from the
  on-file IDL, or are they not yet shipped?
- What is the deployed `$bBPC157` SPL mint pubkey? The init script
  generates a fresh keypair the first time it runs and writes it to
  a gitignored file; the deployed pubkey is not in the repo.
- What is the fee structure: are `mint_fee_bps` and `burn_fee_bps`
  zero today, planned to be zero, or planned to be positive?
- What is the reserve model: full collateralisation in USDC,
  fractional, dynamic?
- Where will liquidity for $bBPC157 sit at launch?
- Is a staking primitive part of v1 or deferred?

Until these answers land, treat the peg program as the on-chain
target of the oracle's TWAP pushes and nothing more. The composability
story for tokenised peptides is in Section 8; the design intent is
real, but Section 4 will be specific only when the deployed surface
is concrete.
