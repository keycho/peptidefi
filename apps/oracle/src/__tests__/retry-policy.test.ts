import { describe, expect, it, vi } from "vitest";
import {
  IN_FLIGHT_MAX_RETRIES,
  longTailBackoffMs,
  nextInFlightBackoff,
} from "../solana/retry-policy";

/**
 * Retry policy schedule + jitter coverage.
 *
 * The §3.7.1 in-flight schedule is canonical:
 *   attempt 1 (priorRetryCount=0): 0s
 *   attempt 2 (priorRetryCount=1): 30s ± 10s
 *   attempt 3 (priorRetryCount=2): 2m  ± 30s
 *   attempt 4 (priorRetryCount=3): 10m ± 2m
 *   attempt 5 (priorRetryCount=4): 30m ± 5m
 *   priorRetryCount >= 5         : isLastAttempt=true (no more in-flight)
 *
 * The §3.7.7 long-tail schedule:
 *   1st (priorLongTailRetries=0): 1h ± 10m
 *   2nd (priorLongTailRetries=1): 4h ± 30m
 *   3rd+ (priorLongTailRetries>=2): 24h ± 1h
 *
 * Jitter is tested by stubbing Math.random with both extremes.
 */

function withRandom<T>(value: number, fn: () => T): T {
  const spy = vi.spyOn(Math, "random").mockReturnValue(value);
  try {
    return fn();
  } finally {
    spy.mockRestore();
  }
}

describe("nextInFlightBackoff — schedule", () => {
  it("attempt 1 (priorRetryCount=0): no wait, counts against budget", () => {
    const r = nextInFlightBackoff(0, "RPC_TRANSIENT");
    expect(r.waitMs).toBe(0);
    expect(r.countAgainstBudget).toBe(true);
  });

  it("attempt 2 (priorRetryCount=1): 30s ± 10s", () => {
    // Math.random() = 0.5  →  centered (no jitter offset).
    withRandom(0.5, () => {
      const r = nextInFlightBackoff(1, "RPC_TRANSIENT");
      expect(r.waitMs).toBe(30_000);
    });
    // Math.random() = 0  →  centerMs - jitterMs = 20_000
    withRandom(0, () => {
      const r = nextInFlightBackoff(1, "RPC_TRANSIENT");
      expect(r.waitMs).toBe(20_000);
    });
    // Math.random() = 1  →  centerMs + jitterMs = 40_000
    withRandom(1, () => {
      const r = nextInFlightBackoff(1, "RPC_TRANSIENT");
      expect(r.waitMs).toBe(40_000);
    });
  });

  it("attempt 3 (priorRetryCount=2): 2m ± 30s", () => {
    withRandom(0.5, () => {
      expect(nextInFlightBackoff(2, "RPC_TRANSIENT").waitMs).toBe(120_000);
    });
  });

  it("attempt 4 (priorRetryCount=3): 10m ± 2m", () => {
    withRandom(0.5, () => {
      expect(nextInFlightBackoff(3, "RPC_TRANSIENT").waitMs).toBe(600_000);
    });
  });

  it("attempt 5 (priorRetryCount=4): isLastAttempt=true", () => {
    const r = nextInFlightBackoff(4, "RPC_TRANSIENT");
    expect(r.isLastAttempt).toBe(true);
    expect(r.countAgainstBudget).toBe(true);
  });

  it("priorRetryCount >= MAX: budget exhausted, isLastAttempt=true", () => {
    const r = nextInFlightBackoff(IN_FLIGHT_MAX_RETRIES, "RPC_TRANSIENT");
    expect(r.isLastAttempt).toBe(true);
    expect(r.countAgainstBudget).toBe(true);
  });
});

describe("nextInFlightBackoff — class-specific behavior", () => {
  it("BLOCKHASH_EXPIRED: 0 wait, no budget burn", () => {
    const r = nextInFlightBackoff(2, "BLOCKHASH_EXPIRED");
    expect(r.waitMs).toBe(0);
    expect(r.countAgainstBudget).toBe(false);
  });

  it("SIGNATURE_ALREADY_EXISTS: 0 wait, no budget burn (reconciliation)", () => {
    const r = nextInFlightBackoff(2, "SIGNATURE_ALREADY_EXISTS");
    expect(r.waitMs).toBe(0);
    expect(r.countAgainstBudget).toBe(false);
  });

  it("RPC_RATE_LIMITED bumps the initial backoff to ≥60s", () => {
    // priorRetryCount=1 normally → 20-40s window; rate-limited
    // override pushes to 50-70s.
    withRandom(0.5, () => {
      const r = nextInFlightBackoff(1, "RPC_RATE_LIMITED");
      expect(r.waitMs).toBeGreaterThanOrEqual(50_000);
      expect(r.waitMs).toBeLessThanOrEqual(70_000);
    });
  });
});

describe("longTailBackoffMs", () => {
  it("1st long-tail (priorLongTailRetries=0): 1h ± 10m", () => {
    withRandom(0.5, () => {
      expect(longTailBackoffMs(0)).toBe(3_600_000);
    });
    withRandom(0, () => {
      expect(longTailBackoffMs(0)).toBe(3_000_000);
    });
    withRandom(1, () => {
      expect(longTailBackoffMs(0)).toBe(4_200_000);
    });
  });

  it("2nd long-tail: 4h ± 30m", () => {
    withRandom(0.5, () => {
      expect(longTailBackoffMs(1)).toBe(14_400_000);
    });
  });

  it("3rd onwards: clamps to the 24h ± 1h spec", () => {
    withRandom(0.5, () => {
      expect(longTailBackoffMs(2)).toBe(86_400_000);
      expect(longTailBackoffMs(10)).toBe(86_400_000);
    });
  });
});
