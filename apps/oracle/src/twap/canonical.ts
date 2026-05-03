import { BIOHASH_PROJECT, BIOHASH_URL } from "@peptide-oracle/shared";

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
 * `algo` is locked at "filtered_median_v1" for v=1 of the algo per
 * §02.2.3 — the worker's `apps/worker/src/twap.ts` ships exactly that
 * one algorithm. A future "filtered_median_v2" (e.g. with MAD-based
 * outlier filtering) would be a separate string passed by the caller.
 *
 * Protocol versions:
 *
 *   v=1 (legacy): 9 fields — algo, computed_at, observation_set_root,
 *     peptide_code, twap_value, type, v, window_end, window_start.
 *
 *   v=2 (current; BioHash rebrand): adds project="biohash" +
 *     url="biohash.network", bringing the field count to 11.
 *     Alphabetical ordering puts project after peptide_code and
 *     url after type.
 *
 * Default is v=2. The v parameter on TwapMemoInput is exposed for
 * backward-compat regression tests.
 */

export type MemoVersion = 1 | 2;

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
  /**
   * Memo protocol version. Defaults to 2 (current — adds project +
   * url). Pass 1 only for backward-compat regression tests against
   * historical fixtures.
   */
  v?: MemoVersion;
}

/**
 * Build the canonical UTF-8 JSON form of a TWAP commit memo.
 *
 * Throws on missing fields and on undefined values — every field of
 * the §02.2.3 schema is required and non-null.
 */
export function canonicalTwapMemoJson(input: TwapMemoInput): string {
  const v: MemoVersion = input.v ?? 2;
  if (v === 1) {
    const ordered = {
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
    return JSON.stringify(ordered);
  }
  // v=2 (current): adds project + url. Alphabetical ordering puts
  // project after peptide_code and url after type.
  const ordered = {
    algo: input.algo,
    computed_at: input.computed_at,
    observation_set_root: input.observation_set_root,
    peptide_code: input.peptide_code,
    project: BIOHASH_PROJECT,
    twap_value: input.twap_value,
    type: "twap",
    url: BIOHASH_URL,
    v: 2,
    window_end: input.window_end,
    window_start: input.window_start,
  };
  return JSON.stringify(ordered);
}
