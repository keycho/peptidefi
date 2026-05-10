import type { Response } from "express";

/**
 * Standard error response shape for the API. Every non-2xx response
 * uses this shape so clients can branch on `code` without parsing
 * `message` text.
 *
 * Wire-contract pinned in docs/PUBLIC_API.md. Three required fields
 * (code, message, status); optional retry_after_seconds for
 * RATE_LIMITED + SERVICE_UNAVAILABLE; optional details for diagnostic
 * context. `details` deliberately excludes stack traces — see the
 * global error handler in index.ts for the production safety check.
 */
export interface ApiErrorBody {
  code: string;
  message: string;
  status: number;
  retry_after_seconds?: number;
  details?: Record<string, unknown>;
}

export function sendError(
  res: Response,
  status: number,
  code: string,
  message: string,
  details?: Record<string, unknown>,
): void {
  const body: ApiErrorBody = { code, message, status };
  if (details) body.details = details;
  res.status(status).json(body);
}

/** Generic error helpers used by the read-only oracle endpoints. */
export const errors = {
  invalidInput(res: Response, message: string, details?: Record<string, unknown>) {
    sendError(res, 400, "BAD_REQUEST", message, details);
  },
  notAuthorized(res: Response, message = "not authorized") {
    sendError(res, 403, "NOT_AUTHORIZED", message);
  },
  notFound(res: Response, message = "not found") {
    sendError(res, 404, "NOT_FOUND", message);
  },
  internal(res: Response, message: string) {
    sendError(res, 500, "INTERNAL_ERROR", message);
  },
  serviceUnavailable(
    res: Response,
    reason: string,
    retryAfterSeconds: number,
  ) {
    res.set("Retry-After", String(retryAfterSeconds));
    res.status(503).json({
      code: "SERVICE_UNAVAILABLE",
      message: reason,
      status: 503,
      retry_after_seconds: retryAfterSeconds,
    } satisfies ApiErrorBody);
  },
  rateLimited(
    res: Response,
    reason: string,
    retryAfterSeconds: number,
    extra?: Record<string, unknown>,
  ) {
    res.set("Retry-After", String(retryAfterSeconds));
    res.status(429).json({
      code: "RATE_LIMITED",
      message: `${reason}. Retry after ${retryAfterSeconds}s`,
      status: 429,
      retry_after_seconds: retryAfterSeconds,
      ...(extra ? { details: extra } : {}),
    } satisfies ApiErrorBody);
  },
};
