# 09 Roadmap

This is the public roadmap. Items here are committed only if they are
under "Shipped". Everything else is intent, not promise. Specific
dates are not given for unshipped work.

## Shipped

- **Per-peptide hourly TWAPs on Solana mainnet.** Live since the
  mainnet cutover in early May 2026, roughly two weeks before the
  index launch. 32 peptides currently active for TWAP commits. More
  than 2000 hourly commits have landed since launch. The mainnet
  authority is `FmBggsBjzGsHrtMayYG8ix2JzoYhVczrwJaGGKPpNKK7`. Cutover
  documented in `docs/runbooks/oracle-mainnet-cutover.md`.
- **Aggregate BioHash Peptide Index on Solana mainnet.** Index
  program deployed at
  `HD35yuVU8txZwgary7pTYtNGgoAdtznnFLGoK1huTRqa` on 2026-05-17, with
  the first on-chain `update_index` landing the same day (cycle
  2034). Singleton PDA at
  `8SZwocjHyuYvK8TvF1Rbjt6Cj2YWMZcU74deumXvGguh`. 29-peptide cohort,
  baseline level 1000 on 2026-05-03, equal weight per peptide.
- **Schema 1.1 IPFS manifests.** Every cohort manifest carries an
  `index_snapshot` block with `level`, `components_hash`,
  `baseline_date`, `baseline_level`, `computed_at`. Pin-twice flow
  ensures the post-cohort-completion manifest is the long-lived
  reference.
- **Public REST API at api.biohash.network.** /v1 namespace with
  endpoints for peptides, cycles, observations, TWAPs, index, vendor
  prices, price history, anomalies, and an end-to-end verifier.
  Documented in [Section 5](./05-the-api.md) and in `docs/PUBLIC_API.md`.
- **@biohashnetwork/sdk v0.2.1.** Official TypeScript SDK,
  zero-dependency, with accessors for every API endpoint including
  the index.
- **@biohashnetwork/cli v0.1.1.** Command-line tool with a bundled
  snapshot fixture (cycle 2005). Snapshot mode only.
- **Peg program deployed.** At
  `2cKMtgXPQt1zT8aWzBAh9LkH3Cf11ris6NDBjrq9J8s7`. Per-peptide state
  initialised for BPC-157. Push-twap from the oracle authority is
  live. Mint and burn flows are not deployed in the on-file IDL;
  see Section 4 for the deployed surface and open questions.

## Near-term (active or queued)

These items have a concrete shape and are being worked on or are next
in line. They are not committed dates.

- **Cohort expansion to 32 peptides.** GHRP2, RETATRUTIDE, and
  TIRZEPATIDE were excluded from the v1 cohort because they had
  fewer than the threshold number of vendor observations at the
  baseline date. Once each has 7+ days of finalised TWAPs from above
  the threshold number of vendors, the cohort can be rebaselined to
  include them. Rebaselining changes the components hash for every
  hour going forward.
- **Vendor reliability scoring.** Today the TWAP algorithm is a
  straight median over included vendors. The `deviation_from_median_bps`
  metric is computed per observation but is not yet used as a
  reliability score. The intent is a per-vendor confidence weight
  that feeds into a MAD-style filter (`filtered_median_v2`). The
  manifest schema already accommodates `excluded_by_*` reasons per
  observation.
- **Per-peptide confidence scores.** A derived per-peptide quantity
  surfacing how thin or wide the observation set was for the hour.
  Plumbed at the manifest level (`deviation_from_median_bps` per
  observation) but not yet exposed as a single per-peptide score.
- **CLI v0.2 wired to the live API.** Same command shape as v0.1,
  network-backed data source instead of the bundled snapshot. See
  [Section 6](./06-the-cli.md).
- **Dashboard reading from chain.** The current dashboard reads from
  the API. Moving it to read from the index PDA via RPC is straight-
  forward (see [Section 8](./08-for-integrators.md)) and makes the
  trust story end-to-end without ever calling the API.
- **Paid API tiers.** The public surface is free today and unmetered
  beyond per-IP rate limits. Tiered access for higher limits and
  additional endpoints is on the roadmap; the shape (rate limit
  ceiling, what additional endpoints, what price) is undecided.
- **BigInt repin fix.** A BigInt serialization error in the cohort-
  completion repin path is currently causing all 29 manifest re-pins
  per cohort hour to fail. On-chain commits and IPFS first-pins are
  unaffected; the bug only blocks the final-pin step that adds the
  `index_snapshot` block to manifests. Fix queued.
- **IPFS repin loop hardening.** The cohort-completion repin loop in
  `apps/oracle/src/index-history-runner.ts:303-338` logs per-row
  failures but does not retry. Adding exponential backoff and a
  per-peptide retry budget is the companion change to the BigInt
  fix above.
- **Index mirror on Base via LayerZero V2.** A Solana OApp emitter
  program plus a Base receiver contract relay each cohort-complete
  index update to Base. The Solana side remains the canonical record;
  the Base mirror is a convenience for EVM developers. Trust model
  on Base is "trust the configured DVN set"; verification is
  "compare to the Solana PDA". v1 ships with LayerZero Labs DVN. See
  [Section 10](./10-base-mirror.md). Strawman code on
  `feat/base-mirror-via-lz`; on-chain deployment pending.

## Longer-term (aspirational)

These items are direction, not plan.

- **More tokenised peptides.** $bBPC157 is the first. The shape of
  the second and subsequent depends on what we learn from the
  first; expect the cohort to grow but at a deliberate pace.
- **Integrator licensing program.** For protocols that want a
  bespoke relationship beyond the free public surface: dedicated
  endpoints, signed attestations, custom SLAs. No prices or
  structures decided.
- **Possible governance token.** Not decided. If we ever do this,
  it will be after the protocol has obvious utility and demand
  rather than as a launch event. Treat any current speculation as
  uninformed.

## Items the prompt asked about, but are undecided

The brief for this documentation explicitly flagged some items as
"undecided, ask before writing as fact". They remain undecided as of
the writing of this doc:

- **Token economics.** The peg program has `mint_fee_bps` and
  `burn_fee_bps` fields in PegState; they are not set by the
  current initialisation script (default 0). Whether they stay at
  zero, are positive, who collects them, and how distribution
  works are open.
- **Staking.** Not deployed. Whether $bBPC157 holders can stake,
  whether the index level participates in any staking yield, and
  the contract structure are open.
- **Distribution.** Whether tokenised peptides are sold, airdropped,
  bonded, or distributed through some other channel at scale is
  open.
- **Entity structure.** LLC vs foundation, jurisdiction, fiscal
  sponsor relationships are not yet settled enough to publish.

When these items move from undecided to decided, this section will
update with the specifics.
