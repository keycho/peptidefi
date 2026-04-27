import { z } from "zod";

/**
 * Decimal-string schema for monetary inputs. Accepts unsigned decimals
 * with optional fractional part (e.g. "1000", "1000.50"). We reject
 * scientific notation and signs so the wire format stays unambiguous.
 */
const decimalString = z
  .string()
  .regex(/^\d+(\.\d+)?$/, "must be a non-negative decimal string");

export const openPositionSchema = z.object({
  peptide_code: z.string().min(1).max(32),
  direction: z.enum(["long", "short"]),
  size_points: decimalString,
  idempotency_key: z.string().min(1).max(128),
});
export type OpenPositionInput = z.infer<typeof openPositionSchema>;

export const listPositionsQuerySchema = z.object({
  status: z.enum(["open", "closed", "all"]).default("open"),
});

/** UUID validator for path params. */
export const uuidParamSchema = z.object({
  id: z.string().uuid(),
});
