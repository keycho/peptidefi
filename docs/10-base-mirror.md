# 10 The Base mirror via LayerZero V2

Status: **rolling out**. The Solana side of the bridge is in
deployment. The Base contract is in deployment. Both deployed
addresses are listed as TBD below and will be filled in once the
first end-to-end relay confirms. The TypeScript and Solidity reading
examples are correct against the deployed shape once addresses land.

The Base mirror is a convenience for EVM developers. The Solana index
PDA remains the canonical source of truth. Read this section before
you build against the Base contract; the trust model differs from
reading the Solana PDA directly.

## What is the architecture?

```
Solana (canonical)                LayerZero V2                  Base (mirror)
─────────────────                 ─────────────                 ─────────────

oracle authority signs            DVN(s) verify the             BioHashIndexMirror
update_index(level, hour,         message off-chain             contract receives
components_hash)                       │                        the message via
        │                              │                        _lzReceive() and
        ▼                              ▼                        updates its state
biohash_index program              Executor delivers to              │
writes the index PDA               the Base contract                 ▼
        │                                                       latest() returns
        ▼                                                       (level, hour,
biohash_index_lz_emitter           lag ≈ 1-2 minutes            componentsHash,
program is called from              between Solana commit       slot, receivedAt)
the same oracle process,           and Base receipt
calls LayerZero send()
to relay to Base
```

The Solana write to the index PDA and the LayerZero emit are two
separate transactions from the oracle, each best-effort. If the
Solana write succeeds and the LayerZero emit fails, the Solana PDA
is up to date and Base lags by one hour. If the emit succeeds but
the Solana write fails, the emitter program rejects the call (its
monotonic guard matches the index program's), so this case cannot
occur in practice. The oracle does not retry the LayerZero emit on
failure; the next hour's emit is the next opportunity.

## What is on Base?

| Field | Value |
| ----- | ----- |
| Network | Base mainnet |
| Contract | `BioHashIndexMirror` |
| Address | TBD (rolling out) |
| Source path in repo | `programs/base/contracts/BioHashIndexMirror.sol` |
| Verification | Basescan source verification at deploy time |

What the contract exposes:

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
function getEntries(uint64 startHour, uint64 endHour)
    external view returns (IndexEntry[] memory);

event IndexMirrored(
    uint64 indexed hourStart,
    uint64 level,
    bytes32 componentsHash,
    uint64 slot,
    uint64 receivedAt
);
```

The contract has no setter functions for end users. The only path to
update its state is via `_lzReceive`, which only the configured
LayerZero endpoint can invoke and which validates the source peer
matches the Solana emitter program.

## How do I read the mirror from another Base contract?

```solidity
interface IBioHashIndexMirror {
    struct IndexEntry {
        uint64 level;
        uint64 hourStart;
        bytes32 componentsHash;
        uint64 slot;
        uint64 receivedAt;
    }
    function latest() external view returns (IndexEntry memory);
}

contract MyProtocol {
    IBioHashIndexMirror public constant BIOHASH =
        IBioHashIndexMirror(address(0xTBD)); // address pending deploy

    function getBioHashLevel() external view returns (uint256) {
        IBioHashIndexMirror.IndexEntry memory entry = BIOHASH.latest();
        // 4-decimal fixed point. 9804600 means 980.46.
        require(
            block.timestamp - entry.receivedAt < 2 hours,
            "BioHash mirror stale"
        );
        return entry.level;
    }
}
```

Notes:

- `level / 10000` is the display value, identical to the Solana side.
- `hourStart` is opaque sequence identifier. Cohort-incomplete hours
  are skipped on Solana, so consecutive `hourStart` values are not
  necessarily 3600 seconds apart.
- `slot` is the Solana slot at which the source PDA was updated. It
  lets a Base consumer cross-reference back to a specific Solana
  transaction.
- `receivedAt` is the Base block timestamp at the moment LayerZero
  delivered the message. Use `block.timestamp - entry.receivedAt`
  for staleness checks; do not use the Solana hour for this because
  LayerZero delivery lag can push `block.timestamp - hourStart` to
  arbitrary values.

## How do I read the mirror from a web client?

```ts
import { createPublicClient, http } from "viem";
import { base } from "viem/chains";

const client = createPublicClient({ chain: base, transport: http() });

const MIRROR_ADDRESS = "0xTBD"; // address pending deploy

const ABI = [
  {
    type: "function",
    name: "latest",
    stateMutability: "view",
    inputs: [],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "level", type: "uint64" },
          { name: "hourStart", type: "uint64" },
          { name: "componentsHash", type: "bytes32" },
          { name: "slot", type: "uint64" },
          { name: "receivedAt", type: "uint64" },
        ],
      },
    ],
  },
] as const;

const entry = await client.readContract({
  address: MIRROR_ADDRESS,
  abi: ABI,
  functionName: "latest",
});

console.log({
  level: Number(entry.level) / 10_000,
  hour: new Date(Number(entry.hourStart) * 1000).toISOString(),
  componentsHash: entry.componentsHash,
  solanaSlot: entry.slot.toString(),
  receivedAt: new Date(Number(entry.receivedAt) * 1000).toISOString(),
});
```

Equivalent ethers v6:

```ts
import { ethers } from "ethers";

const provider = new ethers.JsonRpcProvider("https://mainnet.base.org");
const mirror = new ethers.Contract("0xTBD", ABI, provider);
const entry = await mirror.latest();
console.log({
  level: Number(entry.level) / 10_000,
  hour: new Date(Number(entry.hourStart) * 1000).toISOString(),
  componentsHash: entry.componentsHash,
});
```

## What is the expected lag?

End-to-end timing from the Solana PDA update to the Base mirror
update is dominated by LayerZero's DVN verification and executor
delivery. Typical numbers:

| Stage | Typical |
| ----- | ------- |
| Solana commit finalises (oracle authority signs `update_index`) | ~13s |
| LayerZero emit on Solana (one tx later from the same oracle) | ~13s |
| DVN verification (LayerZero Labs DVN) | 30-60s |
| Base executor delivers and `_lzReceive` runs | 5-15s |
| **Total Solana commit to Base state** | **~1-2 minutes** |

Allow up to 5 minutes worst-case before treating absence as a
problem. A staleness window of 2 hours on the consuming Base contract
is a reasonable safety bound and matches the index program's
implicit cadence (one update per cohort-complete UTC hour).

## What is the trust model on Base?

Reading the Base mirror is not equivalent to reading the Solana PDA.
The Base contract holds whatever value LayerZero delivered. That
value is correct iff:

1. The Solana index PDA at hour H is correct (the BioHash trust
   property: signed by the oracle authority, anchored to vendor
   observations).
2. Every DVN in the configured set verified the message correctly.
3. The LayerZero executor delivered the verified message to Base
   without modification.

Assumption 1 is the same trust property the rest of BioHash
documents. Assumptions 2 and 3 are the LayerZero security model.

The DVN set configured for v1 is **LayerZero Labs DVN**, single DVN.
This is the minimum trust configuration LayerZero supports for V2.
A protocol that wants stronger guarantees should compose its own
multi-DVN configuration on its own OApp; we ship single-DVN for
operational simplicity and because the canonical record is on
Solana, not Base.

If you need a stronger guarantee than "the LayerZero Labs DVN
relayed correctly," read the Solana PDA directly. Section 3 and
Section 7 document how. The Base mirror exists to make integration
easy for EVM developers who do not want to run a Solana RPC client;
it does not exist to be a stronger trust statement than Solana.

## How do I verify a Base mirror entry against Solana?

The mirror entry carries `slot`, the Solana slot at which the source
PDA was updated. With that:

```ts
import { Connection } from "@solana/web3.js";

// Read the Base mirror's latest entry per the snippet above.
// const entry = await mirror.latest();

const conn = new Connection("https://api.mainnet-beta.solana.com");
const tx = await conn.getTransaction(
  // Look up the signature that wrote the PDA at the given slot.
  // Easiest path: hit api.biohash.network/v1/index/history filtered
  // by hour to recover the signature.
  signature,
  { commitment: "finalized", maxSupportedTransactionVersion: 0 },
);

// Compare:
// - The level field on Solana matches Base entry.level
// - The hour_start matches Base entry.hourStart
// - The components_hash matches Base entry.componentsHash
// - The slot matches Base entry.slot
```

If any field disagrees, do not trust the mirror entry. File an
incident.

## Operational notes

- The mirror is updated on every cohort-complete UTC hour, mirroring
  the Solana index cadence. Skipped hours on Solana are skipped on
  Base too.
- The Base contract is **immutable**. There is no owner, no upgrade
  path, no admin function. If we need to change the trusted peer or
  the message format, we redeploy.
- The configured Solana peer (the emitter program address) is set
  at deploy time and cannot be changed. A different OApp pretending
  to be the BioHash emitter cannot write to the Base contract.
- The LayerZero per-message fee is paid in SOL from the oracle's
  existing wallet. Fee scale at LayerZero Labs DVN + 200k gas limit
  on Base: roughly 0.001-0.005 SOL per message at current Base gas,
  i.e. 0.024-0.12 SOL/day at the v1 commit cadence. The actual
  per-message fee is queryable via the emitter program's `quote()`
  function.

## Deployment status checklist

| Item | Status |
| ---- | ------ |
| Solana OApp emitter program written | Strawman in `programs/biohash_index_lz_emitter/`, pending LayerZero SDK validation |
| Base mirror contract written | Strawman in `programs/base/contracts/BioHashIndexMirror.sol`, pending Forge build |
| Solana program deployed to mainnet | Pending |
| Base contract deployed to Base mainnet | Pending |
| Solana peer configured on Base contract | Pending |
| Base peer configured on Solana program | Pending |
| LayerZero DVN set configured | Pending |
| Oracle TS module wired into cohort runner | Strawman in `apps/oracle/src/lz/index-lz-emitter.ts`, pending end-to-end test |
| First end-to-end relay verified | Pending |
| Section 10 addresses filled in | Pending |

When the addresses land, this section will update with concrete
values and the "rolling out" status will move to "live".
