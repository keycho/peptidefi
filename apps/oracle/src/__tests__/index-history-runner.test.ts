import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { _canonicalComponentsHashForTests } from '../index-history-runner';
import { createIndexComputer, type IndexBaseline } from '../index-computer';

/**
 * Pinned auditor reproducibility test (docs/PUBLIC_API.md, "Manifest
 * schema version 1.1", verifier example).
 *
 * If the canonical components-vector construction ever drifts from
 * the documented recipe (sort by peptide_code ASC, key order
 * {peptide_code, twap_value, weight}, ECMA-262 number serialization),
 * the expectation here would fail and the docs example becomes wrong.
 */

const BASELINE_DATE = new Date('2026-05-03T00:00:00Z');

describe('index-history-runner canonical components hash', () => {
  it('matches the byte-equal sha256 of the documented JSON shape', () => {
    const components = [
      { peptide_code: 'A', twap_value: 200, weight: 0.5 },
      { peptide_code: 'B', twap_value: 25, weight: 0.5 },
    ];
    const canonicalJson =
      '[{"peptide_code":"A","twap_value":200,"weight":0.5},' +
      '{"peptide_code":"B","twap_value":25,"weight":0.5}]';
    const expected = createHash('sha256').update(canonicalJson).digest('hex');
    expect(_canonicalComponentsHashForTests(components)).toBe(expected);
  });

  it('agrees with the components_hash that createIndexComputer emits for the same input', () => {
    const baselines: IndexBaseline[] = [
      { peptide_code: 'A', baseline_twap: 100, baseline_date: BASELINE_DATE },
      { peptide_code: 'B', baseline_twap: 50, baseline_date: BASELINE_DATE },
    ];
    const computer = createIndexComputer(baselines);
    const result = computer.computeIndex(
      new Date('2026-05-15T00:00:00Z'),
      new Map([
        ['A', 200],
        ['B', 25],
      ]),
    );
    expect(result).not.toBeNull();
    // Components that the computer hashes internally must match the
    // helper's view of the canonical JSON shape (the helper is the
    // test seam exposed by index-history-runner for this exact check).
    const components = [
      { peptide_code: 'A', twap_value: 200, weight: 0.5 },
      { peptide_code: 'B', twap_value: 25, weight: 0.5 },
    ];
    expect(result!.components_hash).toBe(
      _canonicalComponentsHashForTests(components),
    );
  });
});
