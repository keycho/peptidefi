# Changelog

## 0.2.1

BioHash Peptide Index (schema 1.1) surface.

Added

- `client.index.getIndex()` / `client.getIndex()` -- fetches the latest
  hour from `/v1/index/current`. Returns `{ index: IndexHistoryRow | null }`.
- `client.index.getIndexHistory({ from?, to? })` /
  `client.getIndexHistory()` -- time series from `/v1/index/history`.
  Accepts `Date | string` for `from` / `to`; defaults to the last 30
  days, server caps the requested range at 365 days.
- `client.index.getIndexComponents()` / `client.getIndexComponents()`
  -- per-peptide breakdown of the most recent index level from
  `/v1/index/components`. Includes `baseline_twap`, `current_twap`,
  `weight = 1/N`, and `contribution = (current/baseline) * (baseline_level/N)`.
- New types: `IndexHistoryRow`, `IndexCurrentResponse`,
  `IndexHistoryResponse`, `IndexComponentEntry`, `IndexComponentsResponse`,
  `IndexHistoryParams`, `PinState`.
- Pin-state-aware fields on existing types (optional, additive):
  - `PeptideCurrentTwap.ipfs_cid` / `pin_state`
  - `PeptideTwapHistoryItem.ipfs_cid` / `pin_state` / `index_level`
  - `TwapHistoryPoint.ipfs_cid` / `pin_state`

  `ipfs_cid` reflects the server's `COALESCE(final_ipfs_cid, ipfs_cid)`
  rule under the schema 1.1 pin-twice flow. `pin_state` discriminates
  between `'pre_cohort'` (manifest carries `index_snapshot: null`)
  and `'final'` (manifest carries the populated `index_snapshot`).

No breaking changes. All new fields are optional; existing 0.2.0
consumers continue to compile and work without modification.

## 0.2.0

Initial public release.
