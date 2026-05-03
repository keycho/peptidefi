# BioHash oracle authority pubkey

This file is the canonical record of the public key that signs every
on-chain commit issued by the **BioHash** oracle service
(`biohash.network`). Any commit not signed by the pubkey below is
**not** an authentic BioHash commit — disregard it regardless of
memo contents.

## Current authority

```
FmBggsBjzGsHrtMayYG8ix2JzoYhVczrwJaGGKPpNKK7
```

| field             | value                                   |
| ----------------- | --------------------------------------- |
| Project           | BioHash (`biohash.network`)             |
| Pubkey            | `FmBggsBjzGsHrtMayYG8ix2JzoYhVczrwJaGGKPpNKK7` |
| Solana cluster    | `mainnet-beta`                          |
| Protocol version  | 2 (memo schema; v=1 used for legacy devnet cycles 1–63) |
| Effective from    | 2026-05-01 (initial publication)        |
| Last reviewed     | 2026-05-01                              |

## Trust model

The on-chain commit layer's verification flow assumes a verifier
can independently confirm that the transaction signing each commit
was issued by this authority pubkey. Per **§5.2.4 of the on-chain
commit layer spec**
([docs/specs/01-onchain-commit-layer/05-verification-and-api.md](specs/01-onchain-commit-layer/05-verification-and-api.md)),
the v1 trust model relies on multi-channel cross-reference: this
file (GitHub), the live `GET /api/oracle/info` endpoint, and the
project's social and documentation channels should all agree on the
same pubkey. If any one channel disagrees, **assume something is
wrong and refuse to verify** until the discrepancy is resolved.

Sophisticated verifiers should treat this file as the trust-on-first-use
anchor (TOFU semantics — same pattern SSH uses for host keys).
Pin the pubkey on first contact, refuse to update across runs
without human review, and warn when a change is detected.

## How to verify a Solana commit was signed by this authority

Given any signature `S` from `commit_cycles.solana_signature` or
`twap_commits.solana_signature` (or pulled from `GET /api/oracle/cycles/...`):

1. Fetch the transaction from any Solana RPC. Using the public RPC:

   ```bash
   curl -s https://api.mainnet-beta.solana.com \
     -H 'Content-Type: application/json' \
     -d '{
       "jsonrpc":"2.0",
       "id":1,
       "method":"getTransaction",
       "params":["<S>",{"encoding":"json","commitment":"finalized","maxSupportedTransactionVersion":0}]
     }' | jq
   ```

   Or via the solana CLI:

   ```bash
   solana confirm <S> --output json --url mainnet-beta
   ```

2. Inspect `result.transaction.message.accountKeys[0]` — that's the
   fee payer and first signer of the transaction.

3. **Verify it equals the pubkey above byte-for-byte:**
   `FmBggsBjzGsHrtMayYG8ix2JzoYhVczrwJaGGKPpNKK7`.

   Any other value means the commit was not issued by this
   authority. The full §5.2 verification flow has more checks
   beyond the signer (memo contents match the database record,
   Merkle proof reconstructs to the on-chain root, etc.) — see the
   spec.

4. Confirm the commitment status is `finalized`. Anything less
   than `finalized` (`processed`, `confirmed`) is in-flight, not
   anchored — don't treat it as a valid commit yet.

The full multi-step verification flow lives in
**§5.2 of the spec**
([docs/specs/01-onchain-commit-layer/05-verification-and-api.md](specs/01-onchain-commit-layer/05-verification-and-api.md)).
This file specifically anchors step 10 (signer matches authority).

## Cross-reference

The same pubkey must appear at all of:

- this file (GitHub)
- `GET https://oracle.<domain>/api/oracle/info` →
  `oracle_authority_pubkey` field, served by the live oracle
  service
- the project's pinned post on Twitter / X
- the project documentation site's `/authority` page

Any divergence between these surfaces is an incident; report it via
the project's standard channels and assume the pubkey shown here is
authoritative until cross-referenced clearance is published.

## Rotation history

No rotations to date.

Future rotations will be appended here in reverse-chronological
order with old → new pubkey mapping, the rotation effective slot
on Solana, and the rotation reason (compromise / operator change /
post-mismatch root-cause). Per §9.1.20 of the spec, v1 ships
rotation-on-incident only — no scheduled cadence.
