# biohash-peg

V0.1 scaffold of the BioHash peg smart contract — a single SPL token
(BPC-157) minted and burned against a shared USDC reserve at the
on-chain TWAP pushed by the BioHash oracle.

This crate is **scaffold only** at the time of writing. Every
instruction handler returns `Ok(())` without performing any work, the
account structures and PDA seeds are defined, and `anchor build`
succeeds. The actual mint/burn/update logic lands in a follow-up
implementation phase.

## Spec

The full design lives in
[`/docs/specs/02-peg-mechanism.md`](../../docs/specs/02-peg-mechanism.md).
That document is the source of truth for:

- Account layouts (§4)
- Instruction signatures and intended logic (§5)
- Trust model (§2)
- Tokenomics (§3)
- Failure modes (§7)
- Devnet deployment plan (§8)
- Mainnet upgrade path (§9)

## Layout

```
programs/biohash-peg/
├── Cargo.toml
├── Xargo.toml
├── README.md (this file)
└── src/
    ├── lib.rs                          — #[program] entry, declare_id!
    ├── errors.rs                       — PegError variants
    ├── state/
    │   ├── mod.rs
    │   ├── peg_state.rs                — per-peptide PDA (spec §4.1)
    │   └── reserve_state.rs            — singleton USDC vault state (spec §4.2)
    └── instructions/
        ├── mod.rs
        ├── initialize_reserve_state.rs — one-time reserve init (spec §5.4)
        ├── initialize_peg_state.rs     — per-peptide init (spec §5.4)
        ├── mint.rs                     — mint_peptide_token (spec §5.1)
        ├── burn.rs                     — burn_peptide_token (spec §5.2)
        └── update.rs                   — update_peg_state (spec §5.3)
```

## Building locally

Requires `anchor-cli` 0.31.x and `solana-cli` 1.18+. (See spec §02 §8.1
for the rationale on the 0.31 pin: the 0.30 line transitively pulls in
`block-buffer 0.12` via `solana-program` which requires Rust 1.85+,
incompatible with the Rust 1.79–1.82 that anchor-cli 0.30 itself
expects. The 0.31 release lifts that constraint.)

```bash
# From repo root:
anchor build
```

After the first successful build:

```bash
anchor keys sync   # writes the real keypair-derived program id into Anchor.toml
                   # and src/lib.rs's declare_id!()
```

The placeholder program id `Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS`
in `Anchor.toml` and `src/lib.rs` is the standard Anchor template id —
it gets replaced by `anchor keys sync` after the first build.

## Deployment

See `/docs/specs/02-peg-mechanism.md` §8 for the full devnet
deployment plan and §9.1 for the mainnet cutover procedure. Neither
should run before the design is reviewed.

## Status

| Item                          | Status                          |
| ----------------------------- | ------------------------------- |
| Account layouts               | Implemented                     |
| PDA seed derivations          | Implemented                     |
| Instruction signatures        | Implemented                     |
| Anchor `Accounts` constraints | Implemented                     |
| Instruction handler bodies    | Implemented (V0.1)              |
| Anchor framework version      | 0.31.1 (see §8.1 in the spec)   |
| Integration tests             | Implemented (`tests/biohash-peg.ts`) |
| `cargo check`                 | Clean                           |
| `anchor build` / `anchor test`| Not run in this environment     |
| Devnet deployment scripts     | Not written                     |
| Devnet deployment             | Not performed                   |
| Audit                         | Not started                     |
