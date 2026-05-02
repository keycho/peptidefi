import type { Request, Response } from "express";
import { loadOracleApiConfig } from "../../oracle-config";

/**
 * GET /authority — oracle authority pubkey + cluster + memo program
 * id + spec URL. Mirrors the §05.4.11 GET /api/oracle/info shape.
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
    service: "peptide-oracle",
    protocol_version: 1,
    cluster: config.cluster,
    oracle_authority_pubkey: config.authorityPubkey,
    memo_program_id: config.memoProgramId,
    spec_url:
      "https://github.com/keycho/peptidefi/blob/main/docs/specs/01-onchain-commit-layer.md",
    rpc_recommendation:
      config.cluster === "mainnet-beta"
        ? "https://api.mainnet-beta.solana.com (or any public Solana RPC)"
        : `https://api.${config.cluster}.solana.com (or any public Solana RPC for ${config.cluster})`,
  });
}
