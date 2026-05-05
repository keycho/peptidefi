import { z } from "zod";

/**
 * Optional min_spread_pct query param on GET /arbitrage. Lets the
 * frontend ask for "only show me opportunities ≥ N%". Coerces the
 * incoming string to a finite number ≥ 0.
 */
export const arbitrageQuerySchema = z.object({
  min_spread_pct: z.coerce.number().finite().min(0).optional(),
});

/**
 * Optional ?cluster= filter, accepted on the list endpoints that read
 * commit_cycles / twap_commits (both have a cluster column from
 * migration 0033). The DB column stores 'devnet' | 'mainnet-beta' |
 * 'testnet'; we accept both 'mainnet' and 'mainnet-beta' on the wire
 * for ergonomics and normalise to the canonical 'mainnet-beta'.
 *
 * Default behaviour when the param is absent: NO FILTER. The API
 * returns rows from every cluster. This is the cutover-safe default —
 * during the gap between "oracle stops on devnet" and "first mainnet
 * commit lands", existing frontends that don't set the param keep
 * seeing devnet history. Once mainnet is healthy, frontend code can
 * explicitly opt in to ?cluster=mainnet-beta. The default may flip in
 * a follow-up once mainnet has stable history.
 */
export type ClusterParam = "devnet" | "mainnet-beta" | "testnet";

export const clusterQuerySchema = z.object({
  cluster: z
    .union([
      z.literal("devnet"),
      z.literal("mainnet"),
      z.literal("mainnet-beta"),
      z.literal("testnet"),
    ])
    .optional()
    .transform((v): ClusterParam | undefined => {
      if (v === undefined) return undefined;
      if (v === "mainnet") return "mainnet-beta";
      return v;
    }),
});
