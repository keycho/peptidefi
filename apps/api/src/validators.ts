import { z } from "zod";

/**
 * Optional min_spread_pct query param on GET /arbitrage. Lets the
 * frontend ask for "only show me opportunities ≥ N%". Coerces the
 * incoming string to a finite number ≥ 0.
 */
export const arbitrageQuerySchema = z.object({
  min_spread_pct: z.coerce.number().finite().min(0).optional(),
});
