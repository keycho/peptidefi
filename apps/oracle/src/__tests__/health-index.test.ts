import { describe, expect, it } from 'vitest';
import { buildInitialState, isHealthy } from '../health';

/**
 * Step 8 healthcheck rule: when the BioHash Peptide Index cohort is
 * loaded (cohort_size > 0), zero successful index_history INSERTs in
 * the last 24 hours flips /health to 503. Skipped entirely when
 * cohort_size = 0 (pre-launch) so the oracle can boot and ship
 * per-peptide TWAPs before the baseline backfill has been run.
 */

function newState() {
  return buildInitialState({
    publicKey: 'BASE58ORACLEPUBKEY',
    rpcLabel: 'helius:devnet',
    startedAt: new Date(Date.now() - 60 * 60 * 1000),
    cluster: 'devnet',
  });
}

const liveness = {
  startedAt: new Date(Date.now() - 60 * 60 * 1000),
  warmupMs: 5 * 60 * 1000,
  staleThresholdMs: 30 * 60 * 1000,
  twapStalenessMultiplier: 3,
  failedCountThreshold: 5,
};

function freshTimestamps(state: ReturnType<typeof newState>) {
  const now = new Date().toISOString();
  state.cycle.last_commit_at = now;
  state.twap.last_commit_at = now;
}

describe('isHealthy index degradation rule', () => {
  it('is healthy when cohort_size=0 regardless of index.last_commit_at', () => {
    const s = newState();
    freshTimestamps(s);
    s.index.cohort_size = 0;
    s.index.last_commit_at = null;
    expect(isHealthy(s, liveness)).toBe(true);
  });

  it('is unhealthy when cohort is loaded but no index has ever committed', () => {
    const s = newState();
    freshTimestamps(s);
    s.index.cohort_size = 29;
    s.index.last_commit_at = null;
    expect(isHealthy(s, liveness)).toBe(false);
  });

  it('is unhealthy when index.last_commit_at is older than 24 hours', () => {
    const s = newState();
    freshTimestamps(s);
    s.index.cohort_size = 29;
    s.index.last_commit_at = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    expect(isHealthy(s, liveness)).toBe(false);
  });

  it('is healthy when index.last_commit_at is within the 24-hour budget', () => {
    const s = newState();
    freshTimestamps(s);
    s.index.cohort_size = 29;
    s.index.last_commit_at = new Date(Date.now() - 23 * 60 * 60 * 1000).toISOString();
    expect(isHealthy(s, liveness)).toBe(true);
  });

  it('respects warm-up: index staleness is ignored during the warmup window', () => {
    const s = newState();
    const warmLiveness = {
      ...liveness,
      // warmup covers a full day so the index check should be skipped
      warmupMs: 25 * 60 * 60 * 1000,
      startedAt: new Date(),
    };
    s.index.cohort_size = 29;
    s.index.last_commit_at = null;
    // also clear cycle/twap timestamps so the only constraint that
    // could fire is the warmup short-circuit
    s.cycle.last_commit_at = null;
    s.twap.last_commit_at = null;
    expect(isHealthy(s, warmLiveness)).toBe(true);
  });
});
