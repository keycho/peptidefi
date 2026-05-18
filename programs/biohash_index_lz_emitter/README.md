# biohash_index_lz_emitter

A LayerZero V2 Solana OApp that emits each cohort-complete BioHash
index update to a configured remote chain (Base mainnet for v1). This
program is the Solana side of the cross-chain mirror documented in
`docs/v1/10-base-mirror.md`.

Status: **strawman**. The LayerZero V2 Solana SDK specifics (endpoint
CPI account list, options encoding, quote() integration) are sketched
against the framework's documented patterns but the exact imports
and CPI call site are marked TODO. Verify against
https://docs.layerzero.network/v2/developers/solana before building
for mainnet.

## What this program does

After every cohort-complete UTC hour, the BioHash oracle:

1. Writes the index level to the singleton PDA owned by the existing
   `biohash_index` program (separate program at
   `HD35yuVU8txZwgary7pTYtNGgoAdtznnFLGoK1huTRqa`).
2. Calls `emit_index_update` on **this** program (the LZ emitter)
   with the same level, hour, components hash, and the Solana slot of
   the index PDA write.

This program then validates monotonicity, packs the payload, and
invokes the LayerZero V2 endpoint's send instruction to relay the
message to Base.

The two on-chain writes are independent. The Solana index PDA remains
the canonical source of truth. Base is the mirror.

## Instructions

- `init_oapp_store(endpoint_program)` - one-time, by the authority.
  Allocates the singleton OApp store PDA, captures the authority
  pubkey and the endpoint program ID.
- `init_peer(dst_eid, peer_address)` - by the authority. Records the
  Base mirror's contract address (zero-padded to 32 bytes) for the
  destination EID.
- `emit_index_update(dst_eid, level, hour_start_unix, components_hash, slot, max_fee_lamports)` -
  every cohort-complete UTC hour, by the authority. Validates the
  monotonic hour, packs the payload, calls LayerZero send.

## PDAs

| Name | Seeds | Purpose |
| ---- | ----- | ------- |
| OAppStore | `[b"oapp_store"]` | Singleton state, holds authority + endpoint program + last emitted hour |
| Peer | `[b"Peer", oapp_store, dst_eid_le_bytes]` | Per-remote-EID destination peer |

## Payload format

56 bytes, big-endian, in the order LayerZero EVM consumers can decode
with `abi.decode`:

| Offset | Bytes | Field | Type |
| -----: | ----: | ----- | ---- |
| 0 | 8 | `level` | `uint64`, fixed-point with 4 decimals |
| 8 | 8 | `hour_start_unix` | `int64` |
| 16 | 32 | `components_hash` | `bytes32` |
| 48 | 8 | `slot` | `uint64`, Solana slot of source PDA write |

The same packing is mirrored on the Base side by
`BioHashIndexMirror._lzReceive` in `programs/base/contracts/`.

## Build

```bash
anchor build
```

The build will pull `anchor-lang 0.31.1` from cargo and the LayerZero
V2 Solana SDK once the dep is uncommented in `Cargo.toml`. The CPI
call site in `src/lib.rs` is marked with `TODO(layerzero)` blocks
that must be filled in against the SDK before the program is fit for
deploy.

## Test

```bash
anchor test
```

The test suite (TBD) exercises:

- `init_oapp_store` succeeds once, fails on second call.
- `init_peer` writes the peer PDA; re-running on the same dst_eid
  overwrites.
- `emit_index_update` succeeds on a fresh hour, fails with
  `NonMonotonicHour` on replay, fails with `FeeCapExceeded` when
  quote exceeds the cap, fails with `PeerNotConfigured` when the
  passed peer's dst_eid doesn't match the argument.

## Deploy

See `scripts/deploy.ts` (one-shot mainnet initialisation, mirrors
the pattern of `scripts/initialize-peg-mainnet.ts`).

## Open items

- Lock the LayerZero V2 Solana SDK crate path and version in
  `Cargo.toml`.
- Fill in the `TODO(layerzero)` block in `src/lib.rs` with the actual
  `endpoint_cpi::quote` + `endpoint_cpi::send` calls.
- Confirm the executor options encoding (gas limit on Base) and the
  DVN configuration for v1 (LayerZero Labs DVN, single DVN).
- Lock the Base endpoint ID (30184) and the Solana endpoint program
  ID against the LayerZero V2 deployed-endpoints table.
- Write the anchor test fixtures against a local LayerZero
  validator harness.
