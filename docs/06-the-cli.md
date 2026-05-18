# 06 The CLI

The BioHash CLI is `@biohashnetwork/cli`, published on npm.

```bash
npm install -g @biohashnetwork/cli
biohash --help
```

## What version is shipped?

The current published version is `@biohashnetwork/cli@0.1.1`.

v0.1.x is a snapshot tool. It reads from a bundled fixture (a frozen
snapshot of cycle 2005). Numbers shown by v0.1 are the numbers in that
snapshot, not the live network. The point of v0.1 is to give
integrators a working command surface they can script against and to
make verification examples runnable without network access.

v0.2 is planned and will wire the CLI to the live API at
`api.biohash.network`. v0.2 has not been released. Section 9 tracks
the roadmap.

The CLI source lives at `apps/cli/` in this repository. Until v0.2
ships, treat the published v0.1.1 as the canonical reference for
what the tool does today.

## What commands does it expose?

Run `biohash --help` after install for the authoritative list. The
command surface in v0.1.x is shaped around the verification workflow:
fetch a cycle or TWAP, inspect its on-chain anchor, walk a Merkle
proof, recompute a components hash, all against the bundled fixture.

A typical session against the snapshot:

```bash
biohash --version
biohash cycles ls
biohash cycle 2005
biohash verify --cycle 2005
biohash verify --observation 123456
biohash index components
```

The exact flag names and outputs are governed by the published
package; consult `biohash <command> --help` for the canonical surface.

## Why a snapshot in v0.1?

Two reasons.

First, the verification story is the headline of BioHash. The whole
point is "you do not need to trust our API". A CLI that reads only
from the API is a worse demonstration of that property than one that
reads from a fixture and from chain. v0.1 trains an integrator to
think of the API as one of several sources, not the only one.

Second, shipping a tool wired to live network surface area is a
larger surface area to break. v0.1.x exists to lock the command
shape; v0.2 swaps the data source without renaming flags.

## Where do I report issues?

The CLI source is in this repository at `apps/cli/`. File issues
against the same GitHub repo as the rest of BioHash. The published
package's `bugs` field points at the same tracker.

## v0.2 and beyond

What v0.2 will add (planned, not committed):

- Live API as the default data source. The fixture remains as
  `--snapshot` for reproducible examples.
- `biohash index current` to read the on-chain index PDA directly via
  the configured RPC, not through the API.
- `biohash verify --on-chain` to do the full off-chain verification
  end-to-end (fetch the transaction, decode the memo, walk the
  Merkle proof, recompute the components hash).

Section 9 is the source of truth for roadmap commitments. Treat the
list above as "what shape v0.2 will probably take", not a release
plan.
