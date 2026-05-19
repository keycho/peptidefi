// All endpoints and on-chain addresses in one place.
// Override at runtime via env vars (BIOHASH_API_URL etc) for staging or local testing.

export const config = {
  // API base url. Production reads from mainnet TWAP commits.
  apiUrl: process.env.BIOHASH_API_URL ?? "https://api.biohash.network",

  // Solana endpoints
  mainnetRpc:
    process.env.BIOHASH_MAINNET_RPC ?? "https://api.mainnet-beta.solana.com",
  devnetRpc: process.env.BIOHASH_DEVNET_RPC ?? "https://api.devnet.solana.com",

  // On-chain addresses (devnet for the new aggregate index PDA)
  // These will gain mainnet equivalents at migration; CLI v0.2 will pick the
  // right one based on a --cluster flag.
  indexProgram: "DAaKqMVMVAYSJiXwc5byLFuLKkXwjae7a7f9TUV2dwBd",
  indexPda: "ATfqMUB3NoiSjTrjiAUzYqZVywu8CfeCKs9Mc75Y7mko",

  // Peg program on mainnet (existing infra, not new)
  pegProgram: "2cKMtgXPQt1zT8aWzBAh9LkH3Cf11ris6NDBjrq9J8s7",

  // Defaults
  defaultCluster: "mainnet-beta" as "mainnet-beta" | "devnet",
  fetchTimeoutMs: 8000,
};

// Trim a Solana address for display: first 8 chars + ellipsis + last 7
export function trimAddr(addr: string, head = 8, tail = 7): string {
  if (addr.length <= head + tail + 1) return addr;
  return `${addr.slice(0, head)}…${addr.slice(-tail)}`;
}

// Trim a tx signature for display
export function trimSig(sig: string): string {
  return trimAddr(sig, 7, 4);
}

// Format a USD price per mg
export function fmtPrice(value: number, decimals = 3): string {
  return `$${value.toFixed(decimals)}/mg`;
}

// Format a level number with thousands separators and N decimals
export function fmtLevel(value: number, decimals = 2): string {
  return value.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

// Format a percentage with sign and 2 decimals
export function fmtPct(value: number): string {
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(2)}%`;
}

// Convert a scaled integer (e.g. 9633900 at 4 decimals) to its human form
export function unscale(scaled: number, decimals = 4): number {
  return scaled / 10 ** decimals;
}
