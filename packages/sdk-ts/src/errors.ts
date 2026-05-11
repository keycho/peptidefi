/**
 * Error thrown by the BioHash SDK for any non-2xx API response that
 * the retry layer did not (or could not) recover from. Also thrown
 * for malformed responses and network failures after all retries are
 * exhausted.
 *
 * The shape mirrors the public BioHash error envelope:
 *
 *   { code, message, status, retry_after_seconds?, details? }
 *
 * with two extra non-wire fields populated by the SDK:
 *   - `url`: the absolute URL the request hit
 *   - `cause`: the underlying error (network failure, JSON parse, etc.)
 */
export class BioHashApiError extends Error {
  public override readonly name = "BioHashApiError";

  /** HTTP status code (0 for network failures with no response). */
  public readonly status: number;

  /** Stable machine-readable error code from the API envelope. */
  public readonly code: string;

  /** Hint from the server for 429 / pending_commit responses. */
  public readonly retryAfterSeconds?: number;

  /** Optional structured detail payload from the API envelope. */
  public readonly details?: unknown;

  /** Absolute URL that produced the error. */
  public readonly url?: string;

  /** Underlying error, if any (e.g. fetch network failure, JSON parse). */
  public override readonly cause?: unknown;

  constructor(init: {
    message: string;
    status: number;
    code: string;
    retryAfterSeconds?: number;
    details?: unknown;
    url?: string;
    cause?: unknown;
  }) {
    super(init.message);
    this.status = init.status;
    this.code = init.code;
    if (init.retryAfterSeconds !== undefined) {
      this.retryAfterSeconds = init.retryAfterSeconds;
    }
    if (init.details !== undefined) {
      this.details = init.details;
    }
    if (init.url !== undefined) {
      this.url = init.url;
    }
    if (init.cause !== undefined) {
      this.cause = init.cause;
    }
  }
}
