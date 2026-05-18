# BioHash Base mirror

Solidity contracts for the Base side of the cross-chain index mirror.
Receives BioHash Peptide Index updates from Solana via LayerZero V2.

Status: **strawman**. The contract structure is complete. The exact
OAppReceiver imports depend on the LayerZero V2 EVM SDK version
pinned in `foundry.toml` remappings. Install + version-pin the
LayerZero deps before building for mainnet.

## Setup

```bash
# From repo root, change to programs/base.
cd programs/base

# Install LayerZero V2 OApp EVM, OpenZeppelin v5, and forge-std.
# Pin versions; LayerZero V2 OApp has evolved and the public mainnet
# version should be confirmed against the LayerZero docs before
# building.
forge install LayerZero-Labs/devtools
forge install OpenZeppelin/openzeppelin-contracts@v5.0.2
forge install foundry-rs/forge-std
```

The `foundry.toml` remappings expect the LayerZero install to expose
the OAppReceiver under `@layerzerolabs/oapp-evm/contracts/oapp/`. If
the SDK lays out paths differently, adjust the `remappings` entry.

## Build

```bash
forge build
```

## Test

```bash
forge test -vvv
```

The test suite in `test/BioHashIndexMirror.t.sol` covers:

- Receiving a valid message and storing it in `latest()` + `entries`.
- Rejecting out-of-order messages (`OutOfOrderHour`).
- Rejecting messages from a different srcEid or sender (the OApp's
  peer validation).
- Rejecting calls from any address other than the LayerZero endpoint.
- Rejecting malformed payloads.
- Gas measurement of one `lzReceive` call (sanity floor at 200k gas).
- `getEntries` returns a contiguous window with zero-initialised
  slots for hours with no data.

## Deploy

```bash
# Dry-run first.
BASE_LZ_ENDPOINT=0x... \
SOLANA_EID=30168 \
SOLANA_PEER_BYTES32=0x... \
LZ_DELEGATE=0x...000000000000000000000000000000dEaD \
forge script script/DeployMirror.s.sol --rpc-url $BASE_RPC_URL

# Live broadcast.
forge script script/DeployMirror.s.sol \
  --rpc-url $BASE_RPC_URL \
  --private-key $DEPLOYER_PRIVATE_KEY \
  --broadcast --verify
```

The contract renounces ownership in the constructor, so the peer is
locked at deploy time. To complete the lockdown, the deployer should
also call `endpoint.setDelegate(0xdEaD)` post-deploy as the original
delegate.

## Contract surface

```solidity
struct IndexEntry {
    uint64 level;            // index level, fixed point with 4 decimals
    uint64 hourStart;        // UTC hour identifier, matches Solana hour_start_unix
    bytes32 componentsHash;  // sha256 of the canonical components vector
    uint64 slot;             // Solana slot at which the source PDA was written
    uint64 receivedAt;       // Base block timestamp when _lzReceive ran
}

function latest() external view returns (IndexEntry memory);
function getEntry(uint64 hourStart) external view returns (IndexEntry memory);
function getEntries(uint64 startHour, uint64 endHour) external view returns (IndexEntry[] memory);

event IndexMirrored(
    uint64 indexed hourStart,
    uint64 level,
    bytes32 componentsHash,
    uint64 slot,
    uint64 receivedAt
);
```

Public reads are free. Writes flow exclusively through LayerZero
`lzReceive`; no admin path exists.

## Trust model

The mirror is correct if and only if (1) the source Solana PDA is
correct, (2) the configured DVN set verified the message, and (3)
the LayerZero executor delivered the message without modification.
v1 ships with LayerZero Labs DVN as the only DVN. Consumers wanting
stronger guarantees should read the Solana PDA directly. See
`docs/v1/10-base-mirror.md`.
