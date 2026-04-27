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

/**
 * Display-name input. Mirrors the DB CHECK constraints from migration
 * 0017 so we surface zod-shaped errors before the DB rejects the
 * insert.
 */
export const displayNameSchema = z
  .string()
  .min(3, "display_name must be at least 3 characters")
  .max(24, "display_name must be at most 24 characters")
  .regex(
    /^[a-zA-Z0-9_-]+$/,
    "display_name may only contain a-z, A-Z, 0-9, underscore, hyphen",
  );

export const updateDisplayNameSchema = z.object({
  display_name: displayNameSchema,
});

/**
 * Optional include_user query param on GET /leaderboard. Accept either
 * absent or a valid UUID — no other shapes.
 */
export const leaderboardQuerySchema = z.object({
  include_user: z.string().uuid().optional(),
});
