/**
 * BioHash Peptide Index computer.
 *
 * Computes the equal-weight index level over the v1 cohort. The
 * cohort is the set of peptide_codes in public.index_baselines,
 * loaded once at oracle startup via loadIndexBaselines and frozen
 * into a createIndexComputer() instance. The formula:
 *
 *   contribution_i = (twap_i / baseline_twap_i) * (BASELINE_LEVEL / N)
 *   index_level    = sum over cohort
 *
 * where N is the cohort size at compute time, read from the baselines
 * table so the code stays correct if the cohort ever grows. v1 N is
 * 29 (32 active peptides minus the three excluded by the launch
 * script: GHRP2, RETATRUTIDE, TIRZEPATIDE).
 *
 * components_hash is sha256 (lowercase hex) of the canonical JSON form
 *
 *   [{peptide_code, twap_value, weight: 1/N}, ...]
 *
 * sorted by peptide_code ASC. Same value across all per-peptide rows
 * for a given hour, used by twap_commits.index_components_hash and by
 * index_history.components_hash.
 *
 * If any cohort peptide is missing from twapsByPeptide (or its TWAP
 * is non-finite), computeIndex returns null and logs which cohort
 * peptides were missing. Per spec: partial hours are skipped entirely;
 * we do not compute a partial index.
 */

import { createHash } from 'node:crypto';
import type { SqlClient } from './db/client';

/**
 * Configured baseline level. Hard-coded because it is part of the
 * index identity (an index series with a different baseline level is
 * a different series). Locked to 1000.00.
 */
const BASELINE_LEVEL = 1000;

export interface IndexBaseline {
  peptide_code: string;
  baseline_twap: number;
  baseline_date: Date;
}

export interface IndexResult {
  /** Sum of contributions, e.g. 1023.45. */
  level: number;
  /** sha256 (lowercase hex) of the canonical components vector. */
  components_hash: string;
  /** Configured baseline date, shared across the cohort. */
  baseline_date: Date;
  /** Configured baseline level (1000.00). */
  baseline_level: number;
  /** Wall clock at compute time. */
  computed_at: Date;
}

export interface IndexComputer {
  /**
   * Compute the index for one hour. Returns null and logs a warning
   * if any cohort peptide is missing from twapsByPeptide. hourStart
   * is used for log context only; it is not embedded in the result
   * (the caller knows the hour and writes it to index_history.PK).
   */
  computeIndex(
    hourStart: Date,
    twapsByPeptide: Map<string, number>,
  ): IndexResult | null;
  cohortSize(): number;
  cohortPeptideCodes(): readonly string[];
}

interface CanonicalComponent {
  peptide_code: string;
  twap_value: number;
  weight: number;
}

/**
 * Load the v1 cohort from index_baselines. Called once at oracle
 * startup; the resulting array is passed to createIndexComputer.
 *
 * Ordered by peptide_code ASC for stable consumer iteration. The
 * ::text cast on baseline_twap forces postgres.js to return a string
 * (numeric is string by default, but the explicit cast is defensive
 * against future driver-level mapping changes); the Number()
 * conversion here is the one place float precision matters.
 */
export async function loadIndexBaselines(
  sql: SqlClient,
): Promise<IndexBaseline[]> {
  const rows = await sql<
    {
      peptide_code: string;
      baseline_twap: string;
      baseline_date: Date | string;
    }[]
  >`
    SELECT peptide_code,
           baseline_twap::text AS baseline_twap,
           baseline_date
    FROM   public.index_baselines
    ORDER BY peptide_code ASC
  `;
  return rows.map((r) => ({
    peptide_code: r.peptide_code,
    baseline_twap: Number(r.baseline_twap),
    baseline_date:
      r.baseline_date instanceof Date
        ? r.baseline_date
        : new Date(String(r.baseline_date)),
  }));
}

export function createIndexComputer(
  baselines: IndexBaseline[],
): IndexComputer {
  if (baselines.length === 0) {
    throw new Error(
      'createIndexComputer: refusing to construct with empty cohort. ' +
        'Run apps/oracle/scripts/compute-baseline-twaps.ts --apply first.',
    );
  }
  for (const b of baselines) {
    if (!Number.isFinite(b.baseline_twap) || b.baseline_twap <= 0) {
      throw new Error(
        `createIndexComputer: peptide ${b.peptide_code} has invalid ` +
          `baseline_twap=${b.baseline_twap} (must be a positive finite number)`,
      );
    }
  }
  // All baselines must share a single baseline_date so IndexResult
  // can carry one unambiguous value into the manifest. v1 launches
  // with a uniform 2026-05-03; if a future re-baseline ever rewrites
  // a subset of rows, we want this guard to fire loudly rather than
  // silently emit mixed-baseline manifests.
  const baselineDate = baselines[0]!.baseline_date;
  const baselineDateMs = baselineDate.getTime();
  for (const b of baselines) {
    if (b.baseline_date.getTime() !== baselineDateMs) {
      throw new Error(
        `createIndexComputer: heterogeneous baseline_date across cohort. ` +
          `${b.peptide_code} has ${b.baseline_date.toISOString()}, ` +
          `expected ${baselineDate.toISOString()}.`,
      );
    }
  }
  // Sort by peptide_code (UTF-16 code-unit order) so iteration order
  // is deterministic and matches the components-hash sort convention.
  // localeCompare is intentionally avoided here: it varies by locale.
  const sorted = [...baselines].sort((a, b) =>
    a.peptide_code < b.peptide_code
      ? -1
      : a.peptide_code > b.peptide_code
        ? 1
        : 0,
  );
  const N = sorted.length;
  const weight = 1 / N;
  const baselineByCode = new Map<string, IndexBaseline>();
  for (const b of sorted) baselineByCode.set(b.peptide_code, b);
  const cohortCodes: readonly string[] = sorted.map((b) => b.peptide_code);

  function computeIndex(
    hourStart: Date,
    twapsByPeptide: Map<string, number>,
  ): IndexResult | null {
    const missing: string[] = [];
    for (const code of cohortCodes) {
      const v = twapsByPeptide.get(code);
      if (v === undefined || !Number.isFinite(v)) missing.push(code);
    }
    if (missing.length > 0) {
      console.warn(
        `[index-computer] hour=${hourStart.toISOString()} skipping index ` +
          `(${missing.length}/${N} cohort peptides missing TWAPs): ` +
          missing.join(', '),
      );
      return null;
    }

    const components: CanonicalComponent[] = cohortCodes.map((code) => ({
      peptide_code: code,
      twap_value: twapsByPeptide.get(code)!,
      weight,
    }));

    let level = 0;
    for (const comp of components) {
      const baseline = baselineByCode.get(comp.peptide_code)!;
      level +=
        (comp.twap_value / baseline.baseline_twap) * (BASELINE_LEVEL / N);
    }

    const components_hash = createHash('sha256')
      .update(JSON.stringify(components))
      .digest('hex');

    return {
      level,
      components_hash,
      baseline_date: baselineDate,
      baseline_level: BASELINE_LEVEL,
      computed_at: new Date(),
    };
  }

  return {
    computeIndex,
    cohortSize: () => N,
    cohortPeptideCodes: () => cohortCodes,
  };
}
