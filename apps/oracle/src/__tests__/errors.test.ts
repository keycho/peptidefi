import { describe, expect, it } from "vitest";
import { classifyError } from "../solana/errors";

/**
 * Error classifier coverage. Each Solana / web3.js / Helius error
 * shape we expect to encounter must map to the right §3.7.2 class.
 *
 * The classifier is pattern-matched on the message string rather
 * than instanceof checks because the underlying error types vary
 * across the web3.js, fetch, and validator stacks. Test inputs use
 * realistic message strings sampled from production traces / docs.
 */

describe("classifyError", () => {
  it.each([
    ["Blockhash not found", "BLOCKHASH_EXPIRED"],
    ["block height exceeded", "BLOCKHASH_EXPIRED"],
    ["Blockhash expired before processing", "BLOCKHASH_EXPIRED"],
  ])("BLOCKHASH_EXPIRED: %s", (msg, cls) => {
    expect(classifyError(new Error(msg)).class).toBe(cls);
  });

  it.each([
    ["insufficient lamports for transaction", "INSUFFICIENT_SOL"],
    ["account has insufficient funds", "INSUFFICIENT_SOL"],
    [
      "Attempt to debit an account but found no record of a prior credit",
      "INSUFFICIENT_SOL",
    ],
  ])("INSUFFICIENT_SOL: %s", (msg, cls) => {
    expect(classifyError(new Error(msg)).class).toBe(cls);
  });

  it.each([
    ["This transaction has already been processed", "SIGNATURE_ALREADY_EXISTS"],
    ["duplicate transaction", "SIGNATURE_ALREADY_EXISTS"],
    ["transaction is already in flight", "SIGNATURE_ALREADY_EXISTS"],
  ])("SIGNATURE_ALREADY_EXISTS: %s", (msg, cls) => {
    expect(classifyError(new Error(msg)).class).toBe(cls);
  });

  it.each([
    ["Invalid signature on the transaction", "INVALID_TRANSACTION"],
    ["transaction signature verification failure", "INVALID_TRANSACTION"],
    ["Transaction too large", "INVALID_TRANSACTION"],
  ])("INVALID_TRANSACTION: %s", (msg, cls) => {
    expect(classifyError(new Error(msg)).class).toBe(cls);
  });

  it.each([
    ["429 Too Many Requests", "RPC_RATE_LIMITED"],
    ["rate limit hit", "RPC_RATE_LIMITED"],
  ])("RPC_RATE_LIMITED: %s", (msg, cls) => {
    expect(classifyError(new Error(msg)).class).toBe(cls);
  });

  it.each([
    ["Connection timeout while sending", "RPC_TRANSIENT"],
    ["ECONNRESET", "RPC_TRANSIENT"],
    ["503 Service Unavailable", "RPC_TRANSIENT"],
    ["network request failed", "RPC_TRANSIENT"],
  ])("RPC_TRANSIENT: %s", (msg, cls) => {
    expect(classifyError(new Error(msg)).class).toBe(cls);
  });

  it("UNKNOWN for unrecognized errors", () => {
    expect(classifyError(new Error("something completely different")).class).toBe(
      "UNKNOWN",
    );
  });

  it("countsAgainstBudget=false for BLOCKHASH_EXPIRED + SIGNATURE_ALREADY_EXISTS", () => {
    expect(classifyError(new Error("Blockhash not found")).countsAgainstBudget).toBe(
      false,
    );
    expect(
      classifyError(new Error("already been processed")).countsAgainstBudget,
    ).toBe(false);
  });

  it("countsAgainstBudget=true for INSUFFICIENT_SOL + RPC_TRANSIENT + UNKNOWN", () => {
    expect(
      classifyError(new Error("insufficient lamports")).countsAgainstBudget,
    ).toBe(true);
    expect(classifyError(new Error("ECONNRESET")).countsAgainstBudget).toBe(true);
    expect(classifyError(new Error("???")).countsAgainstBudget).toBe(true);
  });

  it("handles RPC error envelope shape ({ error: { message } })", () => {
    expect(
      classifyError({ error: { message: "Blockhash not found", code: -32002 } })
        .class,
    ).toBe("BLOCKHASH_EXPIRED");
  });

  it("handles plain string errors", () => {
    expect(classifyError("ETIMEDOUT").class).toBe("RPC_TRANSIENT");
  });

  it("preserves the original message in the classified result", () => {
    const result = classifyError(new Error("Blockhash not found here"));
    expect(result.message).toBe("Blockhash not found here");
  });
});
