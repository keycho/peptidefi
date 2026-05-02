/**
 * Cluster + URL helpers for the verification API.
 *
 * The oracle's cluster (devnet vs mainnet-beta) is implied by
 * ORACLE_RPC_URL — the API has no separate "cluster" config; we
 * derive it from the URL string and serve it on every response that
 * includes Solana metadata.
 *
 * Helius URL convention:
 *   mainnet:  https://mainnet.helius-rpc.com/?api-key=...
 *   devnet:   https://devnet.helius-rpc.com/?api-key=...
 *
 * Public Solana RPC also works for devnet/mainnet:
 *   https://api.devnet.solana.com
 *   https://api.mainnet-beta.solana.com
 */

export type SolanaCluster = "devnet" | "mainnet-beta" | "testnet" | "unknown";

export function clusterFromRpcUrl(url: string): SolanaCluster {
  const lower = url.toLowerCase();
  if (lower.includes("devnet")) return "devnet";
  if (lower.includes("testnet")) return "testnet";
  if (lower.includes("mainnet")) return "mainnet-beta";
  return "unknown";
}

export function solscanUrl(signature: string, cluster: SolanaCluster): string {
  const suffix = cluster === "mainnet-beta" ? "" : `?cluster=${cluster}`;
  return `https://solscan.io/tx/${signature}${suffix}`;
}

export function solanaExplorerUrl(
  signature: string,
  cluster: SolanaCluster,
): string {
  const suffix = cluster === "mainnet-beta" ? "" : `?cluster=${cluster}`;
  return `https://explorer.solana.com/tx/${signature}${suffix}`;
}

/**
 * Read required oracle-related env vars at API startup. Throws if a
 * required var is missing — refuses to serve verification endpoints
 * with incomplete configuration. Optional vars (RPC fallback) are not
 * checked here.
 */
export interface OracleApiConfig {
  rpcUrl: string;
  cluster: SolanaCluster;
  authorityPubkey: string;
  /** Memo program id; identical on devnet + mainnet. */
  memoProgramId: string;
}

const MEMO_PROGRAM_ID = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";

export function loadOracleApiConfig(): OracleApiConfig {
  const rpcUrl = process.env.ORACLE_RPC_URL;
  const authorityPubkey = process.env.PEPTIDE_ORACLE_AUTHORITY_PUBKEY;
  if (!rpcUrl) {
    throw new Error(
      "loadOracleApiConfig: ORACLE_RPC_URL is required for verification endpoints",
    );
  }
  if (!authorityPubkey) {
    throw new Error(
      "loadOracleApiConfig: PEPTIDE_ORACLE_AUTHORITY_PUBKEY is required (the oracle's signing pubkey, used by /v1/verify/* and /authority)",
    );
  }
  return {
    rpcUrl,
    cluster: clusterFromRpcUrl(rpcUrl),
    authorityPubkey,
    memoProgramId: MEMO_PROGRAM_ID,
  };
}
