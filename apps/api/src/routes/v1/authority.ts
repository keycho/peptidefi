import type { Request, Response } from "express";
import { BIOHASH_PROJECT, BIOHASH_URL } from "@peptide-oracle/shared";
import { loadOracleApiConfig } from "../../oracle-config";

/**
 * GET /authority — oracle authority pubkey + cluster + memo program
 * id + spec URL. Mirrors the §05.4.11 GET /api/oracle/info shape with
 * BioHash v=2 protocol identity:
 *
 *   service:           "biohash"            (matches `project` in v=2 memos)
 *   project_name:      "BioHash"            (human-readable)
 *   protocol_version:  2                    (memo schema version; bumped at the
 *                                            BioHash rebrand from 1 → 2 — see
 *                                            §02.2.4)
 *   url:               "https://biohash.network"
 *
 * This is the trust-anchor endpoint: a verifier's first call should
 * land here to learn which Solana cluster + which signing pubkey to
 * expect on every commit transaction. The pubkey returned MUST match
 * docs/oracle-authority.md (production deployments) and the on-chain
 * signers of every commit tx.
 *
 * The endpoint is a pure config dump — no DB or RPC calls — so it
 * stays available even when the oracle process is down.
 */
export function authorityHandler(_req: Request, res: Response): void {
  const config = loadOracleApiConfig();
  res.json({
    service: BIOHASH_PROJECT,
    project_name: "BioHash",
    protocol_version: 2,
    cluster: config.cluster,
    oracle_authority_pubkey: config.authorityPubkey,
    memo_program_id: config.memoProgramId,
    url: `https://${BIOHASH_URL}`,
    spec_url:
      "https://github.com/keycho/peptidefi/blob/main/docs/specs/01-onchain-commit-layer.md",
    rpc_recommendation:
      config.cluster === "mainnet-beta"
        ? "https://api.mainnet-beta.solana.com (or any public Solana RPC)"
        : `https://api.${config.cluster}.solana.com (or any public Solana RPC for ${config.cluster})`,
  });
}
