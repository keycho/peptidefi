/**
 * Canonical TWAP commit memo body per §02.2.3.
 *
 * Pure module: takes the already-canonicalized field values (decimals
 * as strings per §02.5, timestamps as 24-char ms-precision UTC ISO
 * per §02.6) and produces the byte-exact JSON that gets sent on-chain.
 *
 * Determinism guarantees match §02.4.6 cycle memo:
 *   - Sorted keys, alphabetic ascending.
 *   - No whitespace.
 *   - Every field of the §02.2.3 schema always present; null-values
 *     are not allowed (the schema has no nullable fields).
 *
 * `algo` is locked at "filtered_median_v1" for v1 per §02.2.3 — the
 * worker's `apps/worker/src/twap.ts` ships exactly that one
 * algorithm.  A future "filtered_median_v2" (e.g. with MAD-based
 * outlier filtering) would be a separate string passed by the caller.
 */

export interface TwapMemoInput {
  /** v1 algorithm identifier — locked at "filtered_median_v1" for now. */
  algo: string;
  /** Peptide code, stable identifier (e.g. "BPC157"). */
  peptide_code: string;
  /** twap_usd_per_mg rendered per §02.5 (decimal string). */
  twap_value: string;
  /** ISO 8601 UTC ms-precision per §02.6. */
  computed_at: string;
  /** ISO 8601 UTC ms-precision per §02.6. */
  window_start: string;
  /** ISO 8601 UTC ms-precision per §02.6. */
  window_end: string;
  /** "0x" + 64 lowercase hex; Merkle root over observations that fed the TWAP. */
  observation_set_root: string;
}

/** The 9 fields in canonical sorted order. Locked at v=1 per §02.2.4. */
export const TWAP_MEMO_FIELDS = [
  "algo",
  "computed_at",
  "observation_set_root",
  "peptide_code",
  "twap_value",
  "type",
  "v",
  "window_end",
  "window_start",
] as const;

/**
 * Build the canonical UTF-8 JSON form of a TWAP commit memo.
 *
 * Throws on missing fields and on undefined values (use null is not
 * allowed — every field of the §02.2.3 schema is required and
 * non-null).
 */
export function canonicalTwapMemoJson(input: TwapMemoInput): string {
  // Build the full record with the locked literal fields, then
  // emit in canonical sorted order.
  const fields: Record<string, unknown> = {
    algo: input.algo,
    computed_at: input.computed_at,
    observation_set_root: input.observation_set_root,
    peptide_code: input.peptide_code,
    twap_value: input.twap_value,
    type: "twap",
    v: 1,
    window_end: input.window_end,
    window_start: input.window_start,
  };

  const ordered: Record<string, unknown> = {};
  for (const field of TWAP_MEMO_FIELDS) {
    const value = fields[field];
    if (value === undefined) {
      throw new Error(
        `twap canonical: field "${field}" is undefined (required per §02.2.3)`,
      );
    }
    ordered[field] = value;
  }
  return JSON.stringify(ordered);
}
