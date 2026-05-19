# @biohashnetwork/cli

On-chain peptide price discovery, from your terminal.

```bash
npm install -g @biohashnetwork/cli
```

## Commands

```bash
biohash                              # splash
biohash index                        # current index level
biohash index --history 7d           # last 7 days, with sparkline
biohash peptide bpc157               # current TWAP price
biohash peptide bpc157 --vendors     # per-vendor breakdown
biohash peptides                     # full market view, all tracked peptides
biohash verify --cycle 1899          # verify a TWAP cycle on mainnet + IPFS
biohash account ATfqMUB3...75Y7mko   # inspect any Solana account
biohash account ATfqMUB3...75Y7mko --cluster devnet
```

## What this does

BioHash is an on-chain oracle for peptide pricing. The CLI is a thin wrapper around the public read paths:

- `index`, `peptide`, and history commands hit `api.biohash.network`
- `verify` checks the cycle's signature against Solana mainnet directly
- `account` makes a raw `getAccountInfo` call to any cluster

The BioHash Peptide Index is a singleton PDA at `ATfqMUB3NoiSjTrjiAUzYqZVywu8CfeCKs9Mc75Y7mko` (devnet, mainnet migration in progress). `biohash account` decodes it natively using the program's IDL schema.

## Environment

```bash
BIOHASH_API_URL=https://api.biohash.network   # default
BIOHASH_MAINNET_RPC=https://api.mainnet-beta.solana.com
BIOHASH_DEVNET_RPC=https://api.devnet.solana.com
```

## Links

- Network: https://biohash.network
- Solscan (index PDA): https://solscan.io/account/ATfqMUB3NoiSjTrjiAUzYqZVywu8CfeCKs9Mc75Y7mko?cluster=devnet
- Solscan (program): https://solscan.io/account/DAaKqMVMVAYSJiXwc5byLFuLKkXwjae7a7f9TUV2dwBd?cluster=devnet
