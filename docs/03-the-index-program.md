# 03 The Index Program

The BioHash Peptide Index lives in a single Anchor program at
`HD35yuVU8txZwgary7pTYtNGgoAdtznnFLGoK1huTRqa`
([Solscan](https://solscan.io/account/HD35yuVU8txZwgary7pTYtNGgoAdtznnFLGoK1huTRqa)).
The program owns one PDA. The PDA holds the latest hourly index level.
The PDA is read-free for any program, wallet, or indexer via
`getAccountInfo`.

Source code: `programs/biohash_index/src/lib.rs`.
IDL: `apps/oracle/src/index/idl.json`.

## What is the PDA address?

Seeds: `["peptide_index", "v1"]` derived under program
`HD35yuVU8txZwgary7pTYtNGgoAdtznnFLGoK1huTRqa`.

Address: `8SZwocjHyuYvK8TvF1Rbjt6Cj2YWMZcU74deumXvGguh`
([Solscan](https://solscan.io/account/8SZwocjHyuYvK8TvF1Rbjt6Cj2YWMZcU74deumXvGguh)).

The version seed is frozen at `"v1"`. A future schema-breaking change
would derive a new PDA at a new version seed (`"v2"`), not reallocate
this one. The current PDA's layout is therefore stable for as long as
the v1 series runs.

## What is the account layout?

`PeptideIndexAccount` is 160 bytes total: 8 bytes of Anchor
discriminator plus 152 bytes of body. Byte-exact layout:

| Offset | Bytes | Field | Type | Notes |
| ------:| -----:| ----- | ---- | ----- |
| 0 | 8 | discriminator | `[u8; 8]` | Anchor account discriminator |
| 8 | 1 | `version` | `u8` | Schema version. Currently 1 |
| 9 | 1 | `bump` | `u8` | PDA bump |
| 10 | 1 | `cohort_size` | `u8` | Number of peptides in the cohort (29 at v1) |
| 11 | 5 | `_pad` | `[u8; 5]` | Padding to align next field |
| 16 | 32 | `authority` | `Pubkey` | The only signer accepted by `update_index` |
| 48 | 8 | `baseline_level` | `u64` | Index baseline (1000 at v1) |
| 56 | 8 | `baseline_timestamp` | `i64` | Baseline date as unix seconds |
| 64 | 8 | `index_level` | `u64` | Current level, scaled by 10^4 |
| 72 | 8 | `hour_start_unix` | `i64` | UTC hour identifier of the current level |
| 80 | 8 | `last_update_timestamp` | `i64` | Wall-clock of the last write |
| 88 | 8 | `last_update_slot` | `u64` | Solana slot of the last write |
| 96 | 32 | `components_hash` | `[u8; 32]` | sha256 of the canonical components vector |
| 128 | 32 | `_reserved` | `[u8; 32]` | Reserved for v1 |

The 8-byte discriminator for `PeptideIndexAccount` is
`[82, 173, 0, 70, 202, 181, 249, 3]`.

`index_level` is a fixed-point integer. To get the display value,
divide by 10000. For example, a level of `9804600` on chain renders
as `980.46`.

`hour_start_unix` is the close-of-window timestamp from
`twap_commits.computed_at`. The minute and second fields are not
necessarily zero (the oracle's hour boundary depends on the worker
tick). Treat it as an opaque identifier for "the hour that finalised
when this update fired", not as `HH:00:00`.

## What instructions does the program expose?

Two. The full IDL is at `apps/oracle/src/index/idl.json`.

### initialize_index_account

One-time setup, called by the authority at program deploy time.

```rust
pub fn initialize_index_account(
    ctx: Context<InitializeIndexAccount>,
    baseline_level: u64,
    baseline_timestamp: i64,
    cohort_size: u8,
) -> Result<()>
```

Allocates the PDA at the canonical seeds, sets the immutable fields
(`version`, `bump`, `authority`, `baseline_level`, `baseline_timestamp`,
`cohort_size`), and seeds the mutable fields (`index_level` and
`hour_start_unix`) to the baseline. The seeding step exists so the
first `update_index` call passes the strict-greater-than guard, and so
a reader before the first cycle gets a meaningful answer rather than
zeros.

The `init` constraint on the PDA causes a second call to fail with
`AccountAlreadyInitialized`. The instruction is therefore safe to
re-run during recovery; it will no-op via a hard error.

There is no `set_authority` instruction. Key rotation requires a
program redeploy with a new constant or a fresh PDA via a new version
seed. Pinned upgrade authority practice for the program is in
`docs/oracle-authority.md`.

### update_index

Called once per cohort-complete UTC hour by the oracle authority.

```rust
pub fn update_index(
    ctx: Context<UpdateIndex>,
    level: u64,
    hour_start_unix: i64,
    components_hash: [u8; 32],
) -> Result<()>
```

Replaces the current level with the new one. The strict-greater-than
check on `hour_start_unix` rejects replays and out-of-order writes:

```rust
require!(
    hour_start_unix > account.hour_start_unix,
    IndexError::NonMonotonicHour
);
```

A startup-recovery batch that processed hours out of order will see
the older calls fail with `NonMonotonicHour` (error code 6000). This
is intentional. The oracle catches `non_monotonic_hour` and logs but
does not retry.

`has_one = authority` enforces that the signer matches the stored
authority. A signer who is not the configured authority fails with
`ConstraintHasOne`.

Emits `IndexUpdated`:

```rust
#[event]
pub struct IndexUpdated {
    pub previous_level: u64,
    pub new_level: u64,
    pub hour_start_unix: i64,
    pub components_hash: [u8; 32],
    pub slot: u64,
}
```

Indexers can subscribe to this event for an event-driven time series
rather than polling `getAccountInfo`.

## How do I read the level from chain?

### TypeScript

```ts
import { Connection, PublicKey } from "@solana/web3.js";

const INDEX_PROGRAM_ID = new PublicKey(
  "HD35yuVU8txZwgary7pTYtNGgoAdtznnFLGoK1huTRqa",
);

// Derive the PDA from canonical seeds. The result equals
// 8SZwocjHyuYvK8TvF1Rbjt6Cj2YWMZcU74deumXvGguh on mainnet.
const [INDEX_PDA] = PublicKey.findProgramAddressSync(
  [Buffer.from("peptide_index"), Buffer.from("v1")],
  INDEX_PROGRAM_ID,
);

const connection = new Connection("https://api.mainnet-beta.solana.com");

const info = await connection.getAccountInfo(INDEX_PDA, "confirmed");
if (!info) throw new Error("index account not initialised");

const data = info.data;
// Skip the 8-byte Anchor discriminator.
const body = data.subarray(8);

// Layout: u8 version, u8 bump, u8 cohort_size, [u8;5] pad,
//         pubkey authority, u64 baseline_level, i64 baseline_timestamp,
//         u64 index_level, i64 hour_start_unix,
//         i64 last_update_timestamp, u64 last_update_slot,
//         [u8;32] components_hash, [u8;32] reserved.
const version = body.readUInt8(0);
const cohortSize = body.readUInt8(2);
const authority = new PublicKey(body.subarray(8, 40));
const baselineLevel = body.readBigUInt64LE(40);
const baselineTimestamp = body.readBigInt64LE(48);
const indexLevelRaw = body.readBigUInt64LE(56);
const hourStartUnix = body.readBigInt64LE(64);
const lastUpdateTs = body.readBigInt64LE(72);
const lastUpdateSlot = body.readBigUInt64LE(80);
const componentsHash = body.subarray(88, 120).toString("hex");

console.log({
  version,
  cohortSize,
  authority: authority.toBase58(),
  baselineLevel: baselineLevel.toString(),
  baselineDate: new Date(Number(baselineTimestamp) * 1000).toISOString(),
  indexLevel: Number(indexLevelRaw) / 10_000, // fixed-point with 4 decimals
  hourStartUnix: new Date(Number(hourStartUnix) * 1000).toISOString(),
  lastUpdate: new Date(Number(lastUpdateTs) * 1000).toISOString(),
  lastUpdateSlot: lastUpdateSlot.toString(),
  componentsHash,
});
```

### Rust (Anchor consumer)

```rust
use anchor_lang::prelude::*;
use anchor_client::{Client, Cluster};
use biohash_index_program::PeptideIndexAccount;
use std::rc::Rc;

let payer = read_keypair_file("./id.json").unwrap();
let client = Client::new_with_options(
    Cluster::Mainnet,
    Rc::new(payer),
    CommitmentConfig::confirmed(),
);
let program = client.program(biohash_index_program::ID)?;

let (pda, _bump) = Pubkey::find_program_address(
    &[b"peptide_index", b"v1"],
    &biohash_index_program::ID,
);

let account: PeptideIndexAccount = program.account(pda)?;
println!(
    "level = {}.{:04}  hour = {}  cohort = {}",
    account.index_level / 10_000,
    account.index_level % 10_000,
    account.hour_start_unix,
    account.cohort_size,
);
```

### Raw JSON-RPC

```bash
curl -s https://api.mainnet-beta.solana.com \
  -H 'Content-Type: application/json' \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "getAccountInfo",
    "params": [
      "8SZwocjHyuYvK8TvF1Rbjt6Cj2YWMZcU74deumXvGguh",
      { "encoding": "base64", "commitment": "finalized" }
    ]
  }' | jq -r '.result.value.data[0]' | base64 -d | xxd
```

## How do I verify a level off chain?

A complete verification of one cohort-complete hour H. The objective:
confirm the on-chain level for hour H corresponds to the 29 per-peptide
TWAPs that finalised for the same hour, and to the IPFS manifests that
the API serves for those peptides.

1. Read the PDA. Decode `index_level`, `hour_start_unix`, and
   `components_hash` as in the TypeScript example above.
2. Hit the API to confirm BioHash's published level for the same hour
   matches what the chain says:
   ```bash
   curl -s "https://api.biohash.network/v1/index/current" | jq
   ```
   The `level` and `components_hash` should match the on-chain values.
3. For each of the 29 cohort peptides, fetch the manifest CID for
   hour H. The API row carries `ipfs_cid` (initial pin) and
   `final_ipfs_cid` (after cohort-completion repin). Prefer
   `final_ipfs_cid`.
   ```bash
   curl -s "https://api.biohash.network/v1/peptides/BPC157" | jq '.twap_history[0]'
   ```
4. For each manifest, fetch from IPFS and verify the
   `index_snapshot.components_hash` field matches. All 29 should
   carry the same value.
   ```bash
   curl -s "https://ipfs.io/ipfs/<cid>" | jq '.index_snapshot'
   ```
5. Recompute the components hash locally from the 29 manifests using
   the Python verifier in Section 7. It should equal the on-chain
   `components_hash`.
6. Recompute the level locally. Sum
   `(twap_value / baseline_twap_i) * (1000 / 29)` over the cohort
   using `baseline_twap` values from any one of the 29 manifests'
   `index_snapshot` block, or query `/v1/index/components`.

If any of these steps disagree, do not trust the level. File an
incident report via the project's standard channels (see
[oracle-authority.md](./oracle-authority.md)).

## Errors

The program defines one error code today:

| Code | Name | Message |
| ----:| ---- | ------- |
| 6000 | `NonMonotonicHour` | `hour_start_unix must be strictly greater than the stored value` |

Anchor's standard errors (`ConstraintHasOne`, `AccountNotInitialized`,
`AccountAlreadyInitialized`) also apply.

## Why a separate program instead of more memo commits?

The TWAP and cycle Memo commits remain the primitive record for
per-peptide and per-observation provenance. They are append-only
history. The index PDA is the latest-known-good for a derived quantity
that other Solana programs need to read in a single
`getAccountInfo`. Asking a consumer program to walk N TWAP memos and
recompute the index is impractical inside a CPI; a single PDA read is
trivial.

The program does the minimum amount of state to expose the level. It
does not store history (`index_history` rows live in Postgres + IPFS).
It does not do CPI mints, transfers, or any other state changes. The
authority is a single Solana keypair held by the oracle service; v1
does not multisig.
