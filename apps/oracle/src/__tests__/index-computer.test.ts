import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  createIndexComputer,
  type IndexBaseline,
} from '../index-computer';

/**
 * Unit tests for createIndexComputer. Deterministic by construction:
 * we never touch the database, and every baseline + current TWAP is a
 * value chosen to be exactly representable in IEEE 754 binary so the
 * level math is exact (no toBeCloseTo fudge required).
 */

const BASELINE_DATE = new Date('2026-05-03T00:00:00Z');

describe('createIndexComputer', () => {
  /**
   * Hand-calculation reference for the 4-peptide cohort below.
   *
   *   N = 4, weight = 1/N = 0.25, BASELINE_LEVEL/N = 250
   *
   *   A: baseline=100, current=200 -> (200/100) * 250 = 500
   *   B: baseline=200, current=100 -> (100/200) * 250 = 125
   *   C: baseline= 50, current= 25 -> ( 25/50)  * 250 = 125
   *   D: baseline= 25, current= 50 -> ( 50/25)  * 250 = 500
   *
   *   index level = 500 + 125 + 125 + 500 = 1250
   */
  const cohortBaselines: IndexBaseline[] = [
    { peptide_code: 'A', baseline_twap: 100, baseline_date: BASELINE_DATE },
    { peptide_code: 'B', baseline_twap: 200, baseline_date: BASELINE_DATE },
    { peptide_code: 'C', baseline_twap: 50, baseline_date: BASELINE_DATE },
    { peptide_code: 'D', baseline_twap: 25, baseline_date: BASELINE_DATE },
  ];
  const cohortTwaps = new Map<string, number>([
    ['A', 200],
    ['B', 100],
    ['C', 25],
    ['D', 50],
  ]);
  const HOUR = new Date('2026-05-15T00:00:00Z');

  it('computes level=1250 exactly for the hand-verified cohort', () => {
    const computer = createIndexComputer(cohortBaselines);
    const result = computer.computeIndex(HOUR, cohortTwaps);
    expect(result).not.toBeNull();
    expect(result!.level).toBe(1250);
  });

  it('emits a sha256 components_hash matching the canonical JSON shape', () => {
    const computer = createIndexComputer(cohortBaselines);
    const result = computer.computeIndex(HOUR, cohortTwaps);
    // Canonical shape: peptide_code-sorted ASC, object keys
    // {peptide_code, twap_value, weight} in that order, weight = 1/N
    // serialized as a JS number (0.25 for N=4).
    const canonicalJson =
      '[{"peptide_code":"A","twap_value":200,"weight":0.25},' +
      '{"peptide_code":"B","twap_value":100,"weight":0.25},' +
      '{"peptide_code":"C","twap_value":25,"weight":0.25},' +
      '{"peptide_code":"D","twap_value":50,"weight":0.25}]';
    const expected = createHash('sha256')
      .update(canonicalJson)
      .digest('hex');
    expect(result!.components_hash).toBe(expected);
    expect(result!.components_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('produces the same hash on repeat invocations with the same inputs', () => {
    const computer = createIndexComputer(cohortBaselines);
    const a = computer.computeIndex(HOUR, cohortTwaps);
    const b = computer.computeIndex(HOUR, cohortTwaps);
    expect(a!.components_hash).toBe(b!.components_hash);
    expect(a!.level).toBe(b!.level);
  });

  it('passes through baseline_date and baseline_level on the result', () => {
    const computer = createIndexComputer(cohortBaselines);
    const result = computer.computeIndex(HOUR, cohortTwaps);
    expect(result!.baseline_date).toEqual(BASELINE_DATE);
    expect(result!.baseline_level).toBe(1000);
  });

  it('sets computed_at to a wall-clock timestamp inside the call window', () => {
    const computer = createIndexComputer(cohortBaselines);
    const before = Date.now();
    const result = computer.computeIndex(HOUR, cohortTwaps);
    const after = Date.now();
    expect(result!.computed_at.getTime()).toBeGreaterThanOrEqual(before);
    expect(result!.computed_at.getTime()).toBeLessThanOrEqual(after);
  });

  it('ignores extra TWAPs not in the cohort', () => {
    const computer = createIndexComputer(cohortBaselines);
    const twapsWithExtra = new Map(cohortTwaps);
    twapsWithExtra.set('NOT_IN_COHORT', 999);
    const result = computer.computeIndex(HOUR, twapsWithExtra);
    expect(result!.level).toBe(1250);
  });

  it('returns null and logs a warning naming missing cohort peptides', () => {
    const computer = createIndexComputer(cohortBaselines);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = computer.computeIndex(
        HOUR,
        new Map([
          ['A', 200],
          ['D', 50],
        ]),
      );
      expect(result).toBeNull();
      expect(warn).toHaveBeenCalledOnce();
      const msg = String(warn.mock.calls[0]![0]);
      expect(msg).toContain('B');
      expect(msg).toContain('C');
      expect(msg).toContain('hour=2026-05-15T00:00:00.000Z');
      expect(msg).toContain('2/4 cohort peptides missing');
    } finally {
      warn.mockRestore();
    }
  });

  it('treats non-finite TWAP values as missing', () => {
    const computer = createIndexComputer([
      { peptide_code: 'A', baseline_twap: 100, baseline_date: BASELINE_DATE },
      { peptide_code: 'B', baseline_twap: 200, baseline_date: BASELINE_DATE },
    ]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = computer.computeIndex(
        HOUR,
        new Map([
          ['A', 200],
          ['B', NaN],
        ]),
      );
      expect(result).toBeNull();
      expect(String(warn.mock.calls[0]![0])).toContain('B');
    } finally {
      warn.mockRestore();
    }
  });

  it('refuses to construct with an empty cohort', () => {
    expect(() => createIndexComputer([])).toThrow(/empty cohort/);
  });

  it('refuses to construct with a non-positive baseline_twap', () => {
    expect(() =>
      createIndexComputer([
        { peptide_code: 'A', baseline_twap: 0, baseline_date: BASELINE_DATE },
      ]),
    ).toThrow(/baseline_twap/);
    expect(() =>
      createIndexComputer([
        { peptide_code: 'A', baseline_twap: -1, baseline_date: BASELINE_DATE },
      ]),
    ).toThrow(/baseline_twap/);
    expect(() =>
      createIndexComputer([
        {
          peptide_code: 'A',
          baseline_twap: Number.NaN,
          baseline_date: BASELINE_DATE,
        },
      ]),
    ).toThrow(/baseline_twap/);
  });

  it('refuses to construct with heterogeneous baseline_date across the cohort', () => {
    expect(() =>
      createIndexComputer([
        {
          peptide_code: 'A',
          baseline_twap: 100,
          baseline_date: BASELINE_DATE,
        },
        {
          peptide_code: 'B',
          baseline_twap: 200,
          baseline_date: new Date('2026-06-01T00:00:00Z'),
        },
      ]),
    ).toThrow(/heterogeneous baseline_date/);
  });

  it('exposes cohortSize and cohortPeptideCodes sorted ASC', () => {
    const computer = createIndexComputer([
      {
        peptide_code: 'BPC157',
        baseline_twap: 6.7,
        baseline_date: BASELINE_DATE,
      },
      {
        peptide_code: 'AOD9604',
        baseline_twap: 1.2,
        baseline_date: BASELINE_DATE,
      },
    ]);
    expect(computer.cohortSize()).toBe(2);
    expect(computer.cohortPeptideCodes()).toEqual(['AOD9604', 'BPC157']);
  });

  /**
   * Smoke test against the v1 N=29 cohort size to confirm the
   * algorithm doesn't drift catastrophically when weight (1/29 =
   * 0.0344827586206...) and BASELINE_LEVEL/N (~34.4827...) are not
   * exactly representable. We expect the level to be within 1e-9 of
   * BASELINE_LEVEL when every current TWAP equals its baseline.
   */
  it('produces level=1000 (within 1e-9) when N=29 and every twap equals its baseline', () => {
    const baselines: IndexBaseline[] = [];
    const twaps = new Map<string, number>();
    for (let i = 0; i < 29; i++) {
      const code = `P${String(i).padStart(2, '0')}`;
      const baselineTwap = 1 + i * 0.5;
      baselines.push({
        peptide_code: code,
        baseline_twap: baselineTwap,
        baseline_date: BASELINE_DATE,
      });
      twaps.set(code, baselineTwap);
    }
    const computer = createIndexComputer(baselines);
    const result = computer.computeIndex(HOUR, twaps);
    expect(result).not.toBeNull();
    expect(Math.abs(result!.level - 1000)).toBeLessThan(1e-9);
  });

  /**
   * Mixed-drift test against the v1 N=29 cohort. 14 peptides moved
   * +5% from baseline, 15 are unchanged. The expected level is the
   * weighted average:
   *
   *   level = sum_i (twap_i / baseline_i) * (1000 / 29)
   *         = (14 * 1.05 + 15 * 1.00) * (1000 / 29)
   *         = 29.7 * (1000 / 29)
   *         = 29700 / 29
   *         = 1024.137931034482...
   *
   * Tolerance is 1e-9 to absorb the (1000/29) imprecision; the
   * algebra above is exact, the float arithmetic is not.
   */
  it('produces the expected weighted average for a 14/15 split mixed-drift cohort at N=29', () => {
    const baselines: IndexBaseline[] = [];
    const twaps = new Map<string, number>();
    for (let i = 0; i < 29; i++) {
      const code = `P${String(i).padStart(2, '0')}`;
      const baselineTwap = 1 + i * 0.5;
      baselines.push({
        peptide_code: code,
        baseline_twap: baselineTwap,
        baseline_date: BASELINE_DATE,
      });
      // First 14 drifted +5%, remaining 15 unchanged.
      const driftMultiplier = i < 14 ? 1.05 : 1.0;
      twaps.set(code, baselineTwap * driftMultiplier);
    }
    const computer = createIndexComputer(baselines);
    const result = computer.computeIndex(HOUR, twaps);
    expect(result).not.toBeNull();
    const expectedLevel = (29700 / 29);
    expect(Math.abs(result!.level - expectedLevel)).toBeLessThan(1e-9);
    // Sanity: level must sit between the two anchors (1000 if no drift,
    // 1050 if every peptide moved +5%).
    expect(result!.level).toBeGreaterThan(1000);
    expect(result!.level).toBeLessThan(1050);
  });
});
