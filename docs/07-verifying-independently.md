# 07 Verifying BioHash Independently

The defining property of BioHash is that you do not have to trust the
API. The API exists for convenience. Every number it returns is
reproducible from raw inputs that are anchored on Solana mainnet and
mirrored on IPFS. A verifier with internet access and a public Solana
RPC can independently confirm any claim BioHash makes.

This section walks the three verification paths a reader can take,
in increasing order of completeness. All three should agree. If any
two disagree, treat the result as untrustworthy and investigate.

## Why this matters

A peptide TWAP that nobody can verify is just another vendor's claim.
A peptide index that depends on the index publisher's continued good
behaviour is a centralised database wearing a token costume.

BioHash signs every commit with a single Solana keypair documented in
`docs/oracle-authority.md`. The on-chain transactions are the
canonical record. The API and the IPFS layer exist to make that
record easy to query and audit. None of them need to be present for
the on-chain record to remain valid.

The trust model assumes a verifier can confirm the authority pubkey
through at least one of three publication channels: this repo's
`docs/oracle-authority.md`, the `/authority` API endpoint, and the
project's social channels. Sophisticated verifiers should pin the
pubkey on first contact (trust-on-first-use) and warn on any later
change.

## Path 1: Read the index PDA directly via Solana RPC

The lowest-friction verification path. Get the current index level
from chain in one RPC call, without ever asking the BioHash API.

```ts
import { Connection, PublicKey } from "@solana/web3.js";

const PROGRAM_ID = new PublicKey(
  "HD35yuVU8txZwgary7pTYtNGgoAdtznnFLGoK1huTRqa",
);
const [INDEX_PDA] = PublicKey.findProgramAddressSync(
  [Buffer.from("peptide_index"), Buffer.from("v1")],
  PROGRAM_ID,
);

// 8SZwocjHyuYvK8TvF1Rbjt6Cj2YWMZcU74deumXvGguh on mainnet.
console.log("PDA:", INDEX_PDA.toBase58());

const rpc = new Connection("https://api.mainnet-beta.solana.com", "finalized");
const info = await rpc.getAccountInfo(INDEX_PDA, "finalized");
if (!info) throw new Error("index PDA not initialised");

// Validate the program owns the PDA. If a different program owns it
// (mainnet equivalent of a substitution attack), refuse to trust it.
if (!info.owner.equals(PROGRAM_ID)) {
  throw new Error(
    `unexpected owner ${info.owner.toBase58()}, refusing to trust`,
  );
}

const body = info.data.subarray(8);
const authority = new PublicKey(body.subarray(8, 40));

// The authority on-chain MUST match the pubkey from docs/oracle-authority.md.
const expected = "FmBggsBjzGsHrtMayYG8ix2JzoYhVczrwJaGGKPpNKK7";
if (authority.toBase58() !== expected) {
  throw new Error(`authority mismatch: got ${authority.toBase58()}`);
}

const indexLevelRaw = body.readBigUInt64LE(56);
const hourStartUnix = body.readBigInt64LE(64);
const componentsHash = body.subarray(88, 120).toString("hex");

console.log({
  level: Number(indexLevelRaw) / 10_000,
  hour: new Date(Number(hourStartUnix) * 1000).toISOString(),
  componentsHash,
});
```

After this script runs without throwing, you know:

- The PDA exists and is owned by the canonical program.
- The signing authority on the PDA matches the published value.
- The most recently written level, the hour it represents, and the
  components hash that pins its inputs.

What you do not know yet: that the inputs to the level are what
BioHash says they are. Paths 2 and 3 cover that.

## Path 2: Cross-check against the public API

The API surface is documented in [Section 5](./05-the-api.md). The
`/v1/index/current` endpoint exposes the same level, components hash,
and hour the chain holds.

```bash
curl -s "https://api.biohash.network/v1/index/current" | jq '{
  level, components_hash, hour_start, computed_at
}'
```

Compare against the on-chain values from Path 1:

| On-chain field | API field |
| -------------- | --------- |
| `index_level / 10000` | `level` |
| `hour_start_unix` (as UTC ISO) | `hour_start` |
| `components_hash` (hex) | `components_hash` |

These must match. The API does not write to chain; the oracle does.
The API reads the same authoritative database the oracle writes, and
the database row is written in the same transaction that submits the
on-chain `update_index`. A discrepancy means either the database is
behind the chain, the chain is behind the database (the oracle
crashed between insert and commit), or someone changed the API
response without changing chain state.

For per-peptide cross-check:

```bash
curl -s "https://api.biohash.network/v1/peptides/BPC157" \
  | jq '.twap_history[0] | { twap_value, computed_at, solana_signature, solana_slot }'
```

Then fetch the transaction from any Solana RPC and decode the memo:

```bash
SIG="<solana_signature from above>"
curl -s https://api.mainnet-beta.solana.com \
  -H 'Content-Type: application/json' \
  -d "{
    \"jsonrpc\": \"2.0\",
    \"id\": 1,
    \"method\": \"getTransaction\",
    \"params\": [\"$SIG\", { \"encoding\": \"json\", \"commitment\": \"finalized\", \"maxSupportedTransactionVersion\": 0 }]
  }" | jq '.result.transaction.message.instructions'
```

The instruction whose `programId` matches the SPL Memo program
(`MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr`) holds the canonical
TWAP memo. Its `data` field is the canonical JSON bytes, base64- or
base58-encoded depending on the RPC. The same canonical JSON is
stored alongside the database row in `twap_commits.memo_payload`.
The two should be byte-identical.

## Path 3: Pull the per-peptide TWAP from the IPFS manifest

The deepest verification. The manifest contains every supplier
observation that fed the TWAP, including the dropped rows (currently
empty under `filtered_median_v1`). With the manifest in hand, you can
recompute the TWAP from raw vendor prices.

```bash
# 1. Find the CID for the latest BPC-157 TWAP.
CID=$(curl -s "https://api.biohash.network/v1/peptides/BPC157" \
  | jq -r '.twap_history[0].final_ipfs_cid // .twap_history[0].ipfs_cid')
echo "CID: $CID"

# 2. Pull the manifest from any IPFS gateway.
curl -s "https://ipfs.io/ipfs/$CID" | jq '.'

# Equivalently:
# curl -s "https://gateway.pinata.cloud/ipfs/$CID" | jq '.'
```

The manifest is schema 1.1 (see
[Section 2 "What is the IPFS manifest?"](./02-the-oracle.md#what-is-the-ipfs-manifest)).
The fields that matter for verification:

- `merkle_root` should equal the on-chain Memo's
  `observation_set_root`.
- `solana_signature` and `solana_slot` should match the database row.
- `observations[]` should have one entry per included observation,
  plus one entry per dropped observation. Each entry's
  `price_usd_per_mg` is the vendor input.
- `index_snapshot` (non-null on cohort hours) carries the cohort's
  `level`, `components_hash`, and `baseline_*` fields.

To reproduce the TWAP value:

```python
import json

with open("manifest.json") as f:
    m = json.load(f)

included = [o["price_usd_per_mg"] for o in m["observations"]
            if o["included_in_twap"]]
included.sort()
n = len(included)
median = (included[n // 2] if n % 2
          else (included[n // 2 - 1] + included[n // 2]) / 2)

assert abs(median - m["twap_value"]) < 1e-6, "TWAP mismatch"
```

To reproduce the components hash, fetch the manifests for all 29
cohort peptides for the same hour, extract their `twap_value` and
`baseline_twap` (from `index_snapshot`), and run the verifier in
[Section 3 "How is the components hash derived?"](./02-the-oracle.md#how-is-the-components-hash-derived).

If the recomputed components hash matches the on-chain
`components_hash` from Path 1, you have closed the loop: from raw
vendor prices, to per-peptide TWAPs, to the aggregate level on chain.

## What `biohash verify --cycle` does under the hood

The CLI's `verify --cycle <id>` command runs the equivalent of Paths
2 and 3 for a single commit cycle. The steps:

1. Fetch the cycle row from the API (or the bundled fixture, in
   v0.1). Extract the database fields: `merkle_root`, `cluster`,
   `solana_signature`, `confirmed_slot`, `memo_payload`,
   `authority_pubkey`.
2. Fetch the on-chain transaction from a Solana RPC. Confirm the fee
   payer (signer index 0) equals the published oracle authority.
3. Find the SPL Memo instruction in the transaction. Decode the data
   bytes as canonical JSON. Confirm those bytes are byte-identical to
   `memo_payload` from the database.
4. Confirm the memo's `merkle_root` matches the database column.
5. Confirm the on-chain `slot` matches `confirmed_slot`.
6. Confirm the commitment status of the transaction is `finalized`,
   not `processed` or `confirmed`.

Any deviation produces a structured failure with a machine-readable
code matching the 9 verifier failure codes documented in
`docs/PUBLIC_API.md`:

- Memo drift: `ONCHAIN_MEMO_MISSING`, `ONCHAIN_DRIFT_FROM_ATTESTATION`,
  `INTENT_DRIFT_FROM_ATTESTATION`, `LEGACY_MEMO_NOT_BACKFILLED`.
- Slot drift: `SLOT_DRIFT_FROM_ATTESTATION`, `LEGACY_SLOT_NOT_BACKFILLED`.
- Signer drift: `SIGNER_DRIFT_FROM_ATTESTATION`,
  `DEVNET_LEGACY_AUTHORITY`, `LEGACY_AUTHORITY_NOT_BACKFILLED`.

The same machine-readable codes are returned by
`GET /v1/verify/observation/:id` so an integrator can write a thin
client that branches on the specific failure mode.

## A complete one-page verification

Everything above, in one script (TypeScript, Node 20+):

```ts
import { Connection, PublicKey } from "@solana/web3.js";
import { createHash } from "node:crypto";

const PROGRAM_ID = new PublicKey(
  "HD35yuVU8txZwgary7pTYtNGgoAdtznnFLGoK1huTRqa",
);
const EXPECTED_AUTHORITY = "FmBggsBjzGsHrtMayYG8ix2JzoYhVczrwJaGGKPpNKK7";
const API = "https://api.biohash.network";
const RPC = "https://api.mainnet-beta.solana.com";

// --- Path 1: read PDA from chain.
const [PDA] = PublicKey.findProgramAddressSync(
  [Buffer.from("peptide_index"), Buffer.from("v1")],
  PROGRAM_ID,
);
const conn = new Connection(RPC, "finalized");
const info = await conn.getAccountInfo(PDA, "finalized");
if (!info || !info.owner.equals(PROGRAM_ID))
  throw new Error("PDA owner check failed");
const body = info.data.subarray(8);
const chainAuthority = new PublicKey(body.subarray(8, 40)).toBase58();
if (chainAuthority !== EXPECTED_AUTHORITY)
  throw new Error(`unexpected authority ${chainAuthority}`);
const chainLevel = Number(body.readBigUInt64LE(56)) / 10_000;
const chainHour = Number(body.readBigInt64LE(64));
const chainHash = body.subarray(88, 120).toString("hex");

// --- Path 2: cross-check against the API.
const apiRes = await fetch(`${API}/v1/index/current`).then((r) => r.json());
const apiLevel = Number(apiRes.level);
const apiHash = apiRes.components_hash;
if (Math.abs(apiLevel - chainLevel) > 0.0001)
  throw new Error(`level mismatch: chain=${chainLevel} api=${apiLevel}`);
if (apiHash !== chainHash)
  throw new Error(`hash mismatch: chain=${chainHash} api=${apiHash}`);

// --- Path 3: recompute the components hash from per-peptide TWAPs.
const components = await fetch(`${API}/v1/index/components`).then((r) =>
  r.json(),
);
const N = components.cohort_size;
const vector = components.components
  .map((c: { peptide_code: string; current_twap: string }) => ({
    peptide_code: c.peptide_code,
    twap_value: Number(c.current_twap),
    weight: 1 / N,
  }))
  .sort((a: any, b: any) =>
    a.peptide_code < b.peptide_code ? -1 : a.peptide_code > b.peptide_code ? 1 : 0,
  );
const recomputed = createHash("sha256")
  .update(JSON.stringify(vector))
  .digest("hex");
if (recomputed !== chainHash)
  throw new Error(
    `components hash recompute failed: got ${recomputed}, want ${chainHash}`,
  );

console.log("OK", { chainLevel, chainHour, chainHash });
```

Save the result of this script. The next time the index updates,
re-run it. If the level moved but the components hash did not, the
cohort changed; investigate.
