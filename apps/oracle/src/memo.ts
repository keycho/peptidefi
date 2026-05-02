import { buildMerkleTree, bytesToHex0x } from "@peptide-oracle/shared";
import type { Observation } from "@peptide-oracle/shared";

/**
 * Cycle commit memo construction per §02.2.2.
 *
 * Pure module: takes the cycle metadata + a Merkle root (or, via the
 * convenience helper, raw observations) and produces the canonical
 * UTF-8 JSON byte string that gets embedded in a Solana Memo program
 * instruction.
 *
 * Canonicalization rules from §02.1:
 *   - sorted keys (ascending)
 *   - no whitespace
 *   - integers as JSON numbers, strings as JSON strings
 *   - protocol version v always 1 in this module
 *
 * The reference example in §02.2.2 produces 226 bytes UTF-8. Different
 * cycle_id values shift the byte count by ±a few characters; the test
 * suite asserts the reference example specifically.
 */

/** Protocol version locked at v=1 per §02.2.4. */
const MEMO_VERSION = 1 as const;

export interface CycleMemoInput {
  /** scraper_runs.id of the cycle being committed. */
  cycle_id: number;
  /** Number of leaves in the Merkle tree (== count of in-leaf observations). */
  observation_count: number;
  /** 0x + 64 lowercase hex from buildMerkleTree(). */
  merkle_root: string;
  /** Canonical timestamp string (24-char ms-precision UTC ISO; §02.6). */
  started_at: string;
  /** Same canonical format. */
  completed_at: string;
}

/**
 * Build the canonical cycle memo JSON. Returns the UTF-8 string that
 * goes into the Memo program instruction's data field.
 *
 * Field order matters for canonicalization; building the object literal
 * with explicit key order + JSON.stringify with no replacer gives us a
 * deterministic byte-exact result. (V8 / SpiderMonkey / JSC all preserve
 * insertion order for non-integer string keys per ECMA-262.)
 */
export function buildCycleMemo(input: CycleMemoInput): string {
  if (input.observation_count <= 0) {
    throw new Error(
      "memo: observation_count must be > 0 " +
        "(§02.4.5 — zero-observation cycles aren't committed)",
    );
  }
  if (!Number.isInteger(input.cycle_id) || input.cycle_id < 0) {
    throw new Error(`memo: cycle_id must be a non-negative integer, got ${input.cycle_id}`);
  }
  if (!Number.isInteger(input.observation_count) || input.observation_count < 0) {
    throw new Error(
      `memo: observation_count must be a non-negative integer, got ${input.observation_count}`,
    );
  }
  if (!/^0x[0-9a-f]{64}$/.test(input.merkle_root)) {
    throw new Error(
      `memo: merkle_root must be 0x + 64 lowercase hex chars, got "${input.merkle_root}"`,
    );
  }
  // Caller is responsible for §02.6-formatted timestamps; we trust the
  // shape here and let any malformed-timestamp bug surface in the
  // hash mismatch downstream.

  const ordered = {
    completed_at: input.completed_at,
    cycle_id: input.cycle_id,
    merkle_root: input.merkle_root,
    observation_count: input.observation_count,
    started_at: input.started_at,
    type: "cycle",
    v: MEMO_VERSION,
  };
  return JSON.stringify(ordered);
}

/**
 * Convenience: build the full memo from raw observations + cycle
 * metadata in one call. Used by the cycle poller (Phase B).
 */
export function buildCycleCommitFromObservations(args: {
  cycle_id: number;
  started_at: string;
  completed_at: string;
  observations: Observation[];
}): { memo: string; root: Buffer; rootHex: string } {
  const tree = buildMerkleTree(args.observations);
  const rootHex = bytesToHex0x(tree.root);
  const memo = buildCycleMemo({
    cycle_id: args.cycle_id,
    observation_count: args.observations.length,
    merkle_root: rootHex,
    started_at: args.started_at,
    completed_at: args.completed_at,
  });
  return { memo, root: tree.root, rootHex };
}
