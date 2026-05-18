# BioHash documentation

This is the BioHash protocol documentation. Audience: builders who want
to integrate against BioHash, investors evaluating it, and people who
want to contribute. Sophisticated readers, comfortable with Solana,
TWAPs, and oracle design. New to BioHash specifically.

BioHash is on Solana mainnet. The aggregate on-chain index account went
live on 2026-05-17. Per-peptide TWAP commits have been writing to
mainnet since the mainnet cutover earlier in May.

## Contents

| Section | What it covers |
| ------- | -------------- |
| [01 Overview](./01-overview.md) | What BioHash is, the three primitives, who it is for, current state |
| [02 The Oracle](./02-the-oracle.md) | Scrape, observe, TWAP, commit, aggregate, pin, write on-chain |
| [03 The Index Program](./03-the-index-program.md) | The Anchor program that holds the on-chain index level |
| [04 Tokenised Peptides](./04-tokenised-peptides.md) | The peg program and the $bBPC157 mint (design intent and current deployment) |
| [05 The API](./05-the-api.md) | The public REST surface at api.biohash.network |
| [06 The CLI](./06-the-cli.md) | The `biohash` command-line tool |
| [07 Verifying BioHash Independently](./07-verifying-independently.md) | How to confirm a level or a TWAP without trusting the API |
| [08 For Integrators](./08-for-integrators.md) | Reading the index from your own Solana program, CPI examples, composability |
| [09 Roadmap](./09-roadmap.md) | What is shipped, what is near-term, what is longer-term |
| [Glossary](./glossary.md) | TWAP, cohort, PDA, components hash, peg, manifest, schema 1.1 |

## Canonical identifiers

These are the source-of-truth values for BioHash v1 on Solana mainnet.
Any document, library, or surface that disagrees with these is wrong.

| Field | Value |
| ----- | ----- |
| Index program | `HD35yuVU8txZwgary7pTYtNGgoAdtznnFLGoK1huTRqa` |
| Index PDA (singleton, seeds `["peptide_index", "v1"]`) | `8SZwocjHyuYvK8TvF1Rbjt6Cj2YWMZcU74deumXvGguh` |
| Peg program | `2cKMtgXPQt1zT8aWzBAh9LkH3Cf11ris6NDBjrq9J8s7` |
| Oracle authority pubkey | `FmBggsBjzGsHrtMayYG8ix2JzoYhVczrwJaGGKPpNKK7` |
| SPL Memo program (v2) | `MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr` |
| USDC mint | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` |
| Cluster | `mainnet-beta` |
| Index cohort size | 29 |
| Index baseline date | 2026-05-03 |
| Index baseline level | 1000 |
| Memo protocol version | 2 |
| Manifest schema | 1.1 |
| Public API base URL | `https://api.biohash.network` |
| Public SDK package | `@biohashnetwork/sdk` (npm) |
| Public CLI package | `@biohashnetwork/cli` (npm) |
| Authority record (GitHub) | [docs/oracle-authority.md](./oracle-authority.md) |

## Document conventions

- Every program ID and PDA above links cleanly to Solscan with the URL
  `https://solscan.io/account/<address>`.
- Transaction signatures link to `https://solscan.io/tx/<signature>`.
- Code examples are runnable. TypeScript examples assume Node.js 20+
  and the public packages installed. Rust examples assume an Anchor
  workspace.
- Where something is not yet built, the section says so explicitly.
- Where something is decided design intent but not deployed, the
  section says that too.

## Working from the source

The canonical source-of-truth files in the repo:

| Concern | File |
| ------- | ---- |
| Index program | `programs/biohash_index/src/lib.rs` |
| Index program IDL | `apps/oracle/src/index/idl.json` |
| Peg program IDL | `scripts/idl/biohash_peg.json` |
| Oracle service | `apps/oracle/src/` |
| Public API | `apps/api/src/` |
| TypeScript SDK | `packages/sdk-ts/src/` |
| Database schema | `packages/db/migrations/` |
| Memo and TWAP canonical form | `apps/oracle/src/memo.ts`, `apps/oracle/src/twap/canonical.ts` |
| Manifest builder | `apps/oracle/src/ipfs/manifest-builder.ts` |
| Components hash derivation | `apps/oracle/src/index-computer.ts` |
| Authority pubkey of record | `docs/oracle-authority.md` |
