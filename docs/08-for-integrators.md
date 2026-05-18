# 08 For Integrators

Three modes of integration with BioHash today:

1. **Read the on-chain index PDA from your own Solana program.** No
   API call, no off-chain dependency. A single account read.
2. **Read the public API or use the TypeScript SDK from a backend or
   frontend.** Lower latency for hot paths, no Solana RPC required.
3. **Pin from IPFS for audit-grade reproducibility.** Use the schema
   1.1 manifest as the source of truth for per-peptide TWAPs and
   their inputs.

This section is the integration view. The wire details are in
[Section 5](./05-the-api.md). The verification model is in
[Section 7](./07-verifying-independently.md).

## Reading the index from your own Solana program

The simplest integration. Your program adds the index PDA as a
read-only account and decodes the level in a CPI-friendly manner.

```rust
use anchor_lang::prelude::*;

const INDEX_PROGRAM_ID: Pubkey =
    pubkey!("HD35yuVU8txZwgary7pTYtNGgoAdtznnFLGoK1huTRqa");

#[derive(Accounts)]
pub struct UsesIndex<'info> {
    /// CHECK: validated by program id check + manual data decode.
    #[account(
        seeds = [b"peptide_index", b"v1"],
        bump,
        seeds::program = INDEX_PROGRAM_ID,
    )]
    pub index_account: AccountInfo<'info>,
}

pub fn handler(ctx: Context<UsesIndex>) -> Result<u64> {
    let info = &ctx.accounts.index_account;
    require_keys_eq!(*info.owner, INDEX_PROGRAM_ID);
    let data = info.try_borrow_data()?;
    // Skip 8-byte discriminator. Layout per Section 3.
    let body = &data[8..];
    let index_level = u64::from_le_bytes(body[56..64].try_into().unwrap());
    let hour_start = i64::from_le_bytes(body[64..72].try_into().unwrap());
    let last_update_slot = u64::from_le_bytes(body[88..96].try_into().unwrap());

    // Stale-read defence: refuse to use the level if it is older than
    // your protocol's tolerance.
    let clock = Clock::get()?;
    let staleness_slots = clock.slot.saturating_sub(last_update_slot);
    require!(staleness_slots <= 15_000, MyError::IndexStale);

    Ok(index_level)
}
```

Notes:

- The PDA owner check is essential. Without it, a malicious caller
  could pass any account at the same address bytes via account
  substitution attacks across forks.
- The level is fixed-point with 4 decimals (`level / 10_000` for the
  display value). A program that does math against the level should
  keep the value in u64 space and divide only at the boundary.
- The on-chain `hour_start_unix` is the cohort-complete UTC hour
  identifier. It is monotonic but not necessarily one-hour-apart
  between updates: an hour where the cohort was incomplete is skipped
  entirely. A consumer should treat the field as an opaque sequence
  identifier, not as a contiguous time series.
- The 15,000-slot staleness bound matches the peg program's
  `max_twap_age_slots` (~2 hours on mainnet). Pick a number that
  matches your protocol's risk tolerance; a riskier downstream
  decision should accept staler data only with care.

The IDL for the index program is at
`apps/oracle/src/index/idl.json`. Generate an Anchor client from it
if you would rather decode via the Anchor `Account` wrapper than read
bytes manually.

## Reading from an SDK or REST client

For a frontend, indexer, or backend service that does not need to
read accounts in a CPI:

```bash
npm install @biohashnetwork/sdk
```

```ts
import { BioHash } from "@biohashnetwork/sdk";

const biohash = new BioHash({ baseUrl: "https://api.biohash.network" });

const peptides = await biohash.peptides.list();
const bpc157 = await biohash.peptides.get("BPC157");
const cycle = await biohash.cycles.get(2005);
const verified = await biohash.verify.observation(123456);

const idx = await biohash.index.getIndex();
const components = await biohash.index.getIndexComponents();
const history = await biohash.index.getIndexHistory({
  from: "2026-05-03T00:00:00Z",
});
```

The SDK is zero-dependency, ESM-and-CJS, Node 18+ and modern browsers.
It returns native types where possible and string-form decimals for
quantities that carry full Postgres `numeric` precision (TWAP values,
prices).

For raw `curl` or any other HTTP client, the wire surface is
documented in [Section 5](./05-the-api.md) and `docs/PUBLIC_API.md`.

## What is the composability story?

BioHash is built so the on-chain primitives can be composed by other
Solana programs without coordination with us. Concretely:

- **Lending collateral.** A money-market protocol that lists a
  tokenised peptide as collateral can use the index level as a market
  benchmark and the per-peptide TWAP as the per-asset price. The
  TWAP commit lives in the SPL Memo program; programs that want
  on-chain price-feed semantics for a specific peptide would read the
  peg state PDA (see [Section 4](./04-tokenised-peptides.md)).
- **Treasury benchmarks.** A treasury holding peptide exposure can
  mark to the index PDA without trusting any vendor.
- **Derivatives.** A futures or options venue that needs a single
  reference value for a peptide basket can use the on-chain index
  PDA as its settlement reference.
- **Prediction markets.** Resolution against the index level for a
  given hour is unambiguous: the level is on chain, the components
  hash is on chain, the underlying TWAPs are on chain with Merkle
  proofs.

The composability story is aspirational where it talks about
specific downstream protocols. Nothing listed above is integrated
today. The point of this section is that the integration shape is
available, and that BioHash will not require any opt-in from us to
make it work; a program that wants the level reads the PDA and
proceeds.

## Signed updates and attestations

Read-only access to the index PDA, the API, the SDK, and the IPFS
manifests is free and unmetered (subject to the rate limits in
Section 5).

If you need something stronger than read-only - for example, a signed
attestation that "the level at hour H was X" delivered out-of-band to
your protocol, or a guarantee about update cadence under SLA, or a
private endpoint exempt from rate limits - that is not part of the
v1 public surface. Reach out via the GitHub repo or the project's
contact channels. Bespoke arrangements are case-by-case.

Note that signed attestations are weaker than the on-chain record.
The signing authority is the same Solana keypair that writes the
Memo commits; an attestation cannot say anything that the chain does
not already say. Read the chain.

## Things to be careful about

- **Authority verification.** Always pin the oracle authority pubkey
  before trusting any commit. The pubkey is published at
  `docs/oracle-authority.md` in this repo, at `/authority` on the
  API, and on the project's social channels. All three should agree.
  If they do not, treat the situation as an incident and refuse to
  verify until reconciled.
- **Devnet legacy commits.** The same database holds devnet cycles
  from before the mainnet cutover. They carry `cluster='devnet'` and
  the API returns `failure_code: DEVNET_LEGACY_AUTHORITY` if you ask
  the verifier to check them against the mainnet authority. Filter
  on `cluster='mainnet-beta'` for any production integration.
- **Protocol version.** Every Memo commit carries a `v` field. Today
  this is 2. A v=3 spec would carry breaking changes (new mandatory
  fields, new memo shape). Verifier libraries must inspect `v` and
  refuse unknown versions. The v=1 commits exist only on devnet.
- **TWAP precision.** Numeric values like `twap_value` are full
  Postgres `numeric` and round-trip as strings on the wire. A naive
  `parseFloat` is fine for display but lossy for math. If you are
  doing on-chain math, work in the fixed-point representation (the
  on-chain peg state uses micro-USDC per mg × 10^6; the on-chain
  index level uses level × 10^4).
- **Cohort changes.** The components hash is sensitive to the cohort.
  A rebaselining would change the hash for every hour going forward.
  The cohort is stable today, but a consumer that pins to a specific
  components hash should be prepared to refresh when the cohort
  changes.
