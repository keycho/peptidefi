# Glossary

Plain definitions for the terms used across the BioHash documentation.
Where a term has a concrete on-chain or in-database meaning, the
definition cites the canonical reference.

## Anchor program

A Solana program written using Anchor, a framework on top of the
Solana SDK that adds account validation, IDL generation, and
discriminator-based dispatch. BioHash has two Anchor programs: the
index program (`programs/biohash_index/`) and the peg program
(deployed bytecode only; IDL at `apps/oracle/src/peg/idl.json`).

## Anomaly log

The append-only system event log surfaced at `/api/anomalies`. Records
scrape failures, vendor outages, oracle pipeline events. Has RSS 2.0
and JSON Feed 1.1 outputs.

## Authority

The Solana keypair that signs every commit. For BioHash mainnet:
`FmBggsBjzGsHrtMayYG8ix2JzoYhVczrwJaGGKPpNKK7`. Recorded in
`docs/oracle-authority.md`. Stored as the `authority` field on the
index PDA and as the `update_authority` field on the peg state PDA.

## Baseline

The index calibration point. v1 baseline date is 2026-05-03, baseline
level is 1000. Each cohort peptide has a `baseline_twap` value
recorded in `public.index_baselines` from that date (or its earliest
finalised TWAP if the peptide started observation later, captured by
`actual_baseline_date`). The index level on date D is the sum of
`(twap_i / baseline_twap_i) * (1000 / N)` over the cohort.

## Cluster

A Solana network: `mainnet-beta`, `devnet`, or `testnet`. BioHash
commits to `mainnet-beta`. Devnet commits from before the cutover
are kept in the database with `cluster='devnet'` for historical
audit.

## Cohort

The set of peptide codes whose TWAPs feed the equal-weight BioHash
Peptide Index. v1 has 29 peptides. The cohort is locked at index
launch by the rows in `public.index_baselines`. Membership and
ordering are stable.

## Components hash

A 32-byte sha256 of the canonical JSON serialisation of the cohort's
inputs for a given hour. Derivation in
[Section 2 "How is the components hash derived?"](./02-the-oracle.md#how-is-the-components-hash-derived).
Stored on chain (`PeptideIndexAccount.components_hash`), in Postgres
(`twap_commits.index_components_hash`, `index_history.components_hash`),
and inside every cohort manifest (`index_snapshot.components_hash`).
All four are byte-identical for a given hour.

## Cycle

One pass of the scraper over the supplier set. Today every ~10
minutes. Produces one row in `scraper_runs` and one row per supplier
in `supplier_observations` (success or fail). The cycle commit
anchors all observations from one cycle in one Solana transaction
via a single Merkle root.

## Cycle commit

A Memo transaction containing a Merkle root over every observation a
cycle produced, plus identifying metadata. Schema v=2.

## Discriminator

The 8-byte prefix that Anchor adds to every account's stored data and
every instruction's argument bytes. Used to disambiguate which type
or instruction a piece of data represents.

## Filtered_median_v1

The TWAP algorithm in production. Straight median across included
vendor observations for the window. No outlier filter today.
Pluggable for future variants (`filtered_median_v2` would be the
next iteration if a MAD-based filter ships).

## Hour identifier

The opaque sequence identifier `hour_start_unix` (on chain) /
`hour_start` (database). Comes from `twap_commits.computed_at`, which
is the close-of-window timestamp the worker recorded for the hour.
Monotonic but not necessarily contiguous: an hour where the cohort
was incomplete is skipped from `index_history` and does not appear
on chain.

## Index level

The equal-weight aggregate over the 29-peptide cohort. Baseline 1000
on 2026-05-03. Stored on chain as a u64 scaled by 10^4 (display value
times ten thousand). Stored in Postgres as `numeric`.

## Index program

The Anchor program at
`HD35yuVU8txZwgary7pTYtNGgoAdtznnFLGoK1huTRqa`. Owns one PDA at
`8SZwocjHyuYvK8TvF1Rbjt6Cj2YWMZcU74deumXvGguh`. Two instructions:
`initialize_index_account`, `update_index`.

## Index PDA

The singleton account that holds the latest cohort-complete index
level. Address `8SZwocjHyuYvK8TvF1Rbjt6Cj2YWMZcU74deumXvGguh`.
Derived from seeds `["peptide_index", "v1"]` under the index
program.

## Index snapshot

The block on a schema-1.1 manifest that pins the index hour to that
manifest: `{level, baseline_date, baseline_level, components_hash,
computed_at}`. Null when the cohort was incomplete for the hour.

## IPFS manifest

The schema-1.1 JSON document the oracle pins to Pinata after every
finalised TWAP commit. Carries every observation that fed the TWAP,
the Merkle root, the Solana anchor, and (for cohort hours) the index
snapshot. Defined in `apps/oracle/src/ipfs/pinata.ts` as
`CycleManifest`.

## Manifest schema 1.1

The current version of the IPFS manifest format. Adds `index_snapshot`
at the top level versus schema 1.0. Defined as
`CycleManifest.version: "1.1"`.

## Memo program

The Solana SPL Memo program. Mainnet ID
`MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr`. BioHash uses Memo
v2; the cycle and TWAP commits are Memo instructions whose `data`
field is the canonical JSON memo bytes.

## Observation

One supplier's price for one peptide at one moment in time. Rows in
`supplier_observations`. Anchored on chain via the cycle commit's
Merkle root.

## PDA

Program-Derived Address. A Solana account address deterministically
derived from a program ID plus a set of seeds, in such a way that the
program is the only signer who can write to it. BioHash uses PDAs for
the index account and for per-peptide peg state.

## Peg program

The Anchor program at
`2cKMtgXPQt1zT8aWzBAh9LkH3Cf11ris6NDBjrq9J8s7`. Holds per-peptide
peg state used by the tokenised-peptide design. The deployed surface
in the on-file IDL covers `initialize_reserve_state`,
`initialize_peg_state`, and `update_peg_state`. See
[Section 4](./04-tokenised-peptides.md).

## Peg state

The per-peptide PDA owned by the peg program. Derived from seeds
`["peg_state", peptide_code_padded_to_16_bytes]`. Carries the most
recent TWAP pushed by the oracle, the update authority, and various
configurable bounds (`max_twap_age_slots`, `max_twap_step_bps`,
`mint_fee_bps`, `burn_fee_bps`).

## Peg pusher

The oracle subsystem that invokes `update_peg_state` after each
finalised TWAP commit, subject to a 60-second per-peptide rate limit,
a staleness guard, and a max-step guard. Source:
`apps/oracle/src/peg/peg-pusher.ts`. Runbook:
`docs/runbooks/peg-pusher.md`.

## Reserve state

The singleton PDA owned by the peg program that holds the USDC reserve
configuration. Initialised once via `initialize_reserve_state`. Used
by mint and burn flows (where deployed).

## Schema 1.1

See "Manifest schema 1.1" above.

## Scraper

The TWAP input layer (`apps/scraper/`). One adapter per vendor.
Writes one row per supplier per scrape attempt to
`supplier_observations`, whether the scrape succeeded or not.

## TWAP

Time-weighted average price. For BioHash, a one-hour rolling median
of vendor prices in USD per milligram for one peptide. Computed by
the worker (`apps/worker/src/`), committed to Solana via a TWAP memo
transaction. The "weighted" in TWAP is misleading for the v1
algorithm (`filtered_median_v1`), which is a straight median; the
name is conventional.

## TWAP commit

A Memo transaction containing one peptide's TWAP value for one hour,
the canonical observation_set_root, and identifying metadata. Schema
v=2.

## Update authority

The signing key that can call `update_peg_state` (peg program) or
`update_index` (index program). For BioHash mainnet, both equal the
oracle authority `FmBggsBjzGsHrtMayYG8ix2JzoYhVczrwJaGGKPpNKK7`.

## v=1, v=2

The memo protocol version. v=1 was the launch schema, devnet only,
cycles 1 through 63. v=2 is the current schema, used since the
BioHash rebrand. A future v=3 would be a breaking change. Verifier
libraries must inspect `v` and refuse unknown versions.

## Window start, window end, computed_at

The three timestamps on a TWAP row. `window_start` and `window_end`
bound the observation window the median was taken over. `computed_at`
is the moment the worker computed the TWAP; it is the index hour
identifier on `twap_commits` and on `index_history`. See
[Section 2 "How is a TWAP computed?"](./02-the-oracle.md#how-is-a-twap-computed).

## Worker

The TWAP computation layer (`apps/worker/`). Reads from
`supplier_observations`, writes to `peptide_twaps`. Every hour, for
every active peptide, computes one TWAP row. The oracle then
commits that row to Solana.
