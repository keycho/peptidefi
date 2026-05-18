# 01 What is BioHash?

BioHash is an on-chain reference layer for the peptide market. The
oracle scrapes peptide prices from vendors, computes a per-peptide
hourly time-weighted average (TWAP), commits each TWAP to Solana via
the SPL Memo program with a Merkle proof of its inputs, aggregates the
TWAPs into a single equal-weight peptide index, and writes that index
level to a singleton on-chain account once per UTC hour. The on-chain
record is the canonical truth. The API and IPFS layer exist to make
the same record convenient to read and audit.

## Three primitives

BioHash exposes three on-chain primitives. They share an authority and
a data pipeline, but solve different problems.

### Per-peptide TWAPs on chain

For every active peptide in the cohort, the oracle commits an hourly
TWAP value to Solana. The commit is a Memo instruction. The memo
payload includes the peptide code, the TWAP value, the time window
covered, the Merkle root of the observation set that fed the TWAP, and
a small set of identification fields (project, protocol version, URL).

The problem this solves: price discovery. Peptides do not trade on
exchanges. There is no Coingecko ticker. Vendor prices vary by 3x or
more for the same molecule between Tier 1 vendors. A consumer trying
to evaluate "is this price fair" had no neutral reference. BioHash
gives that reference, with a cryptographic chain of evidence down to
the individual vendor observation that fed it.

### Aggregate index on chain

The 29-peptide cohort feeds an equal-weight index. Each peptide
contributes `1/N` of the index level, where N is the cohort size. The
index level is the sum of `(current_twap / baseline_twap) * (1000 / N)`
over the cohort. Baseline level is 1000 on 2026-05-03.

The oracle writes the index to a singleton PDA at
`8SZwocjHyuYvK8TvF1Rbjt6Cj2YWMZcU74deumXvGguh`. Any Solana program,
wallet, or indexer can read it directly with `getAccountInfo`. No
trusted API needed.

The problem this solves: a composable reference. Lending protocols
that want to accept tokenised peptides as collateral need a single
benchmark price. Treasury operators tracking peptide exposure need a
single number to mark to. Derivatives need an oracle that cannot be
unilaterally rewritten. The on-chain PDA gives all three.

### Tokenised peptides

The peg program at `2cKMtgXPQt1zT8aWzBAh9LkH3Cf11ris6NDBjrq9J8s7`
holds per-peptide state anchored to the on-chain TWAP. The first
peptide brought up under the program is bBPC-157, a synthetic
SPL token whose mint authority is the peg state PDA.

Current deployment is limited to peg-state initialization and
TWAP-push. Mint, burn, and reserve flows are in active design.
Section 4 documents only what is on-chain.

The problem this is designed to solve: on-chain exposure to peptide
markets. A wallet that holds $bBPC157 (when fully shipped) is exposed
to BPC-157 spot pricing without holding physical peptide. Protocols
that integrate peptide tokens get a price oracle they can trust
because the same oracle authority writes both the TWAP and the index.

## Who BioHash is for

- **Dispensary operators and vendors** who want a fair-pricing
  reference and a public record of what their market looked like at a
  given hour.
- **Researchers and harm-reduction organisations** who need a
  defensible source for "what did peptide X cost on day Y" when
  reporting on the gray market.
- **Solana protocols** that want a single peptide-market benchmark
  they can call from a CPI. Anything that touches lending, prediction
  markets, treasury accounting, or derivatives.
- **Auditors and journalists** who want to verify a claim about the
  peptide market without trusting any single source. Every BioHash
  number is reproducible from raw vendor inputs, with a cryptographic
  chain of evidence on Solana.

## Current state

BioHash v1 is live on Solana mainnet.

- Per-peptide hourly TWAPs have been committing to mainnet since the
  oracle's mainnet cutover earlier in May 2026. The cluster cutover
  is documented in `docs/runbooks/oracle-mainnet-cutover.md`. The
  oracle authority is
  `FmBggsBjzGsHrtMayYG8ix2JzoYhVczrwJaGGKPpNKK7`. Commits older than
  the cutover live in the same database but carry `cluster='devnet'`.
- The aggregate index program was deployed and initialised on
  2026-05-17 at `HD35yuVU8txZwgary7pTYtNGgoAdtznnFLGoK1huTRqa`. The
  singleton PDA at `8SZwocjHyuYvK8TvF1Rbjt6Cj2YWMZcU74deumXvGguh`
  receives an `update_index` call once per cohort-complete UTC hour.
- The peg program is deployed at
  `2cKMtgXPQt1zT8aWzBAh9LkH3Cf11ris6NDBjrq9J8s7`. The peg state for
  BPC-157 is initialized. The mint, burn, and reserve flows are in
  active design. Section 4 covers the deployed surface only.
- The public REST API runs at `https://api.biohash.network` with a
  Railway origin at
  `https://peptidefi-production-c6d9.up.railway.app`. The /v1 namespace
  is the durable surface; some legacy routes outside /v1 are documented
  in Section 5.
- The TypeScript SDK is published as `@biohashnetwork/sdk` (v0.2.1
  at time of writing) and is the easiest way to consume the API.
- The CLI is published as `@biohashnetwork/cli@0.1.1` and reads from
  a fixture (snapshot of cycle 2005). The live-API wiring is in v0.2,
  not yet released.

The cohort has 29 peptides. There are 32 peptides tracked in the
oracle, of which 3 (GHRP2, RETATRUTIDE, TIRZEPATIDE) are excluded
from the index because they had fewer than the threshold number of
vendor observations at the index baseline date. They remain tracked
for TWAP commits and are candidates for index inclusion once their
vendor coverage stabilises.
