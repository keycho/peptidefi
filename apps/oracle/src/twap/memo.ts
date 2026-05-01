import { buildMerkleTree, bytesToHex0x } from "../merkle";
import type { Observation } from "../canonical";
import { canonicalTwapMemoJson, type TwapMemoInput } from "./canonical";

/**
 * High-level helper: build a §02.2.3 TWAP commit memo for a peptide
 * given the observations the worker used to compute the TWAP.
 *
 * The `observation_set_root` is computed via the same Phase A
 * Merkle primitive as cycle commits — leaves are full 17-field
 * canonical observations (§02.4.2), domain-separated SHA-256
 * (§02.4.3), Bitcoin-style odd duplication (§02.4.5). Reusing the
 * cycle-commit Merkle leaf shape means a verifier needs only one
 * hashing function for both commit kinds — the leaf bytes
 * canonicalize identically across cycle and TWAP roots.
 *
 * Spec ambiguity resolved (Phase D): §02.2.3 cross-referenced §2.6
 * for the "Merkle root over the observations that fed this TWAP"
 * but §2.6 is the timestamp section. The intent is clearly §02.4
 * — same Merkle construction as cycle commits. This module fixes
 * that interpretation; the spec text is corrected in the same
 * commit that lands this code.
 */

/** v1 algorithm identifier; matches `apps/worker/src/twap.ts`. */
export const TWAP_ALGO_V1 = "filtered_median_v1";

export interface BuildTwapCommitArgs {
  /** Peptide stable code (e.g. "BPC157"). */
  peptide_code: string;
  /** twap_usd_per_mg as decimal string per §02.5. */
  twap_value: string;
  /** ISO 8601 UTC ms-precision per §02.6. */
  computed_at: string;
  window_start: string;
  window_end: string;
  /**
   * Observations that fed this TWAP — i.e. the rows referenced by
   * peptide_twaps.input_observation_ids, in canonical Observation
   * form (already adapter-converted from PG rows). Order doesn't
   * matter to the caller; buildMerkleTree sorts by id ASC per
   * §02.4.5.
   */
  observations: Observation[];
  /** Override the algo identifier; defaults to "filtered_median_v1". */
  algo?: string;
}

export interface TwapCommitOutput {
  /** Canonical memo body — the bytes that go on-chain (UTF-8). */
  memo: string;
  /** "0x" + 64 hex; Merkle root over `observations`. */
  observationSetRootHex: string;
}

export function buildTwapCommit(args: BuildTwapCommitArgs): TwapCommitOutput {
  if (args.observations.length === 0) {
    throw new Error(
      "twap memo: observations[] is empty — refusing to build a TWAP " +
        "commit with no source observations (§02.2.3 requires a non-empty set)",
    );
  }

  const tree = buildMerkleTree(args.observations);
  const observationSetRootHex = bytesToHex0x(tree.root);

  const input: TwapMemoInput = {
    algo: args.algo ?? TWAP_ALGO_V1,
    peptide_code: args.peptide_code,
    twap_value: args.twap_value,
    computed_at: args.computed_at,
    window_start: args.window_start,
    window_end: args.window_end,
    observation_set_root: observationSetRootHex,
  };

  return {
    memo: canonicalTwapMemoJson(input),
    observationSetRootHex,
  };
}
