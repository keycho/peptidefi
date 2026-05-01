/**
 * Error classification per §3.7.2.
 *
 * Solana RPC + web3.js errors are heterogeneous (some are HTTP
 * status codes, some are RPC error objects, some are stringly-typed
 * message bodies). This module collapses them into a single
 * exhaustive union the retry policy can switch on.
 *
 * The classifier never throws — unrecognized errors map to UNKNOWN,
 * which the policy treats conservatively (retryable, full backoff).
 *
 * The implementation is deliberately pattern-matched on string
 * substrings rather than instanceof checks: web3.js's error types
 * change across versions, and what we actually want to gate on is
 * the human-readable message that bubbles up from the validator.
 */

export type ErrorClass =
  | "RPC_TRANSIENT"
  | "RPC_RATE_LIMITED"
  | "BLOCKHASH_EXPIRED"
  | "INSUFFICIENT_SOL"
  | "INVALID_TRANSACTION"
  | "CONFIRMATION_TIMEOUT"
  | "SIGNATURE_ALREADY_EXISTS"
  | "UNKNOWN";

export interface ClassifiedError {
  class: ErrorClass;
  /** The original error message (or a stringified shape). */
  message: string;
  /** Optional: whether the retry budget should advance on this class. */
  countsAgainstBudget: boolean;
}

export function classifyError(err: unknown): ClassifiedError {
  const message = errMessage(err);
  const lower = message.toLowerCase();

  // BLOCKHASH_EXPIRED → refresh + retry without burning a budget slot
  if (
    lower.includes("blockhash not found") ||
    lower.includes("block height exceeded") ||
    lower.includes("blockhash expired")
  ) {
    return {
      class: "BLOCKHASH_EXPIRED",
      message,
      countsAgainstBudget: false,
    };
  }

  // INSUFFICIENT_SOL → terminal (§3.7.3)
  if (
    lower.includes("insufficient lamports") ||
    lower.includes("insufficient funds") ||
    lower.includes("attempt to debit an account but found no record")
  ) {
    return {
      class: "INSUFFICIENT_SOL",
      message,
      countsAgainstBudget: true,
    };
  }

  // SIGNATURE_ALREADY_EXISTS → reconcile (§3.7.5)
  if (
    lower.includes("already been processed") ||
    lower.includes("duplicate transaction") ||
    lower.includes("already in flight")
  ) {
    return {
      class: "SIGNATURE_ALREADY_EXISTS",
      message,
      countsAgainstBudget: false,
    };
  }

  // INVALID_TRANSACTION → terminal; structural problem
  if (
    lower.includes("invalid signature") ||
    lower.includes("transaction signature verification failure") ||
    lower.includes("invalid blockhash") ||
    lower.includes("transaction too large")
  ) {
    return {
      class: "INVALID_TRANSACTION",
      message,
      countsAgainstBudget: true,
    };
  }

  // RPC_RATE_LIMITED → longer initial backoff
  if (
    lower.includes("429") ||
    lower.includes("too many requests") ||
    lower.includes("rate limit")
  ) {
    return {
      class: "RPC_RATE_LIMITED",
      message,
      countsAgainstBudget: true,
    };
  }

  // RPC_TRANSIENT → standard retry
  if (
    lower.includes("timeout") ||
    lower.includes("etimedout") ||
    lower.includes("econnreset") ||
    lower.includes("econnrefused") ||
    lower.includes("network request failed") ||
    /\b5\d\d\b/.test(message) // 500/502/503/504 etc.
  ) {
    return {
      class: "RPC_TRANSIENT",
      message,
      countsAgainstBudget: true,
    };
  }

  return {
    class: "UNKNOWN",
    message,
    countsAgainstBudget: true,
  };
}

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  if (err && typeof err === "object") {
    // RPC error envelope shapes
    const anyErr = err as Record<string, unknown>;
    if (typeof anyErr.message === "string") return anyErr.message;
    if (
      anyErr.error &&
      typeof anyErr.error === "object" &&
      typeof (anyErr.error as Record<string, unknown>).message === "string"
    ) {
      return String((anyErr.error as Record<string, unknown>).message);
    }
    try {
      return JSON.stringify(err);
    } catch {
      return String(err);
    }
  }
  return String(err);
}
