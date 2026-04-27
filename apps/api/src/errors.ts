import type { Response } from "express";

/**
 * Standard error response shape for the API. Every non-2xx response
 * uses this shape so Lovable can branch on `code` without parsing
 * `message` text.
 */
export interface ApiErrorBody {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export function sendError(
  res: Response,
  status: number,
  code: string,
  message: string,
  details?: Record<string, unknown>,
): void {
  const body: ApiErrorBody = { code, message };
  if (details) body.details = details;
  res.status(status).json(body);
}

/** Convenience constructors for the codes used by trading endpoints. */
export const errors = {
  invalidInput(res: Response, message: string, details?: Record<string, unknown>) {
    sendError(res, 400, "INVALID_INPUT", message, details);
  },
  insufficientBalance(res: Response, currentBalance: string, requestedAmount: string) {
    sendError(res, 402, "INSUFFICIENT_BALANCE",
      `Balance ${currentBalance} is below requested amount ${requestedAmount}`,
      { current_balance: currentBalance, requested_amount: requestedAmount });
  },
  peptideNotFound(res: Response, peptideCode: string) {
    sendError(res, 404, "PEPTIDE_NOT_FOUND",
      `No active peptide with code "${peptideCode}"`,
      { peptide_code: peptideCode });
  },
  positionNotFound(res: Response) {
    // Same response whether the position doesn't exist or belongs to
    // another user — never leak existence.
    sendError(res, 404, "POSITION_NOT_FOUND", "No such position");
  },
  marketDataStale(
    res: Response,
    peptideCode: string,
    latestTwapAgeSeconds: number,
    latestTwapComputedAt: string | null,
  ) {
    sendError(res, 409, "MARKET_DATA_STALE",
      `Latest TWAP for ${peptideCode} is ${latestTwapAgeSeconds}s old; trading paused until ≤ 300s`,
      {
        peptide_code: peptideCode,
        latest_twap_age_seconds: latestTwapAgeSeconds,
        latest_twap_computed_at: latestTwapComputedAt,
      });
  },
  idempotencyKeyReused(res: Response, conflictingFields: Record<string, unknown>) {
    sendError(res, 409, "IDEMPOTENCY_KEY_REUSED",
      "Idempotency key was previously used for a different request body",
      { conflicting_fields: conflictingFields });
  },
  internal(res: Response, message: string) {
    sendError(res, 500, "INTERNAL", message);
  },
  displayNameTaken(res: Response, displayName: string) {
    sendError(res, 409, "DISPLAY_NAME_TAKEN",
      `display_name "${displayName}" is already in use`,
      { display_name: displayName });
  },
  rateLimited(
    res: Response,
    reason: string,
    retryAfterSeconds: number,
    extra?: Record<string, unknown>,
  ) {
    res.set("Retry-After", String(retryAfterSeconds));
    sendError(res, 429, "RATE_LIMITED",
      `${reason}. Retry after ${retryAfterSeconds}s`,
      { retry_after_seconds: retryAfterSeconds, ...(extra ?? {}) });
  },
};
