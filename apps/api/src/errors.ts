import type { Response } from "express";

/**
 * Standard error response shape for the API. Every non-2xx response
 * uses this shape so clients can branch on `code` without parsing
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

/** Generic error helpers used by the read-only oracle endpoints. */
export const errors = {
  invalidInput(res: Response, message: string, details?: Record<string, unknown>) {
    sendError(res, 400, "INVALID_INPUT", message, details);
  },
  notAuthorized(res: Response, message = "not authorized") {
    sendError(res, 403, "NOT_AUTHORIZED", message);
  },
  internal(res: Response, message: string) {
    sendError(res, 500, "INTERNAL", message);
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
