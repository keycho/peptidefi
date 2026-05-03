import {
  BIOHASH_PROJECT,
  BIOHASH_URL,
  buildMerkleTree,
  bytesToHex0x,
} from "@peptide-oracle/shared";
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
 *
 * Protocol versions:
 *
 *   v=1 (legacy, devnet cycles 1-63): the original 7-field shape
 *     (completed_at, cycle_id, merkle_root, observation_count,
 *     started_at, type, v).
 *
 *   v=2 (current; BioHash rebrand): adds two static project-identity
 *     fields (project="biohash", url="biohash.network"), bringing
 *     the field count to 9. Sorts alphabetically: project after
 *     observation_count, url after type.
 *
 * Default is v=2 for new commits. The v parameter is exposed so
 * tests can byte-exact reproduce historical v=1 fixtures (we don't
 * rebuild on-chain commits — they're immutable — so a v=1 builder is
 * for backward-compat regression coverage only).
 *
 * The reference example in §02.2.2 produces 226 bytes UTF-8 at v=1.
 * At v=2, the same input produces 256 bytes (added bytes:
 * `,"project":"biohash"` = 20 bytes, `,"url":"biohash.network"` = 23
 * bytes, plus 2 from `:1` → `:2`; net ~30 bytes per memo). Different
 * cycle_id values shift the byte count by ±a few characters.
 */

/** Default protocol version for new commits. */
export const MEMO_VERSION_DEFAULT = 2 as const;

export type MemoVersion = 1 | 2;

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
  /**
   * Protocol version. Defaults to 2 (current). Pass 1 for backward-
   * compat regression tests against historical fixtures. v=1 emits
   * the legacy 7-field shape; v=2 adds project+url.
   */
  v?: MemoVersion;
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
  const v: MemoVersion = input.v ?? MEMO_VERSION_DEFAULT;

  if (v === 1) {
    // Legacy 7-field shape — used by tests for backward-compat
    // assertions against devnet cycles 1-63.
    const ordered = {
      completed_at: input.completed_at,
      cycle_id: input.cycle_id,
      merkle_root: input.merkle_root,
      observation_count: input.observation_count,
      started_at: input.started_at,
      type: "cycle",
      v: 1,
    };
    return JSON.stringify(ordered);
  }
  // v=2 (current): adds project + url; alphabetical ordering puts
  // project after observation_count and url after type.
  const ordered = {
    completed_at: input.completed_at,
    cycle_id: input.cycle_id,
    merkle_root: input.merkle_root,
    observation_count: input.observation_count,
    project: BIOHASH_PROJECT,
    started_at: input.started_at,
    type: "cycle",
    url: BIOHASH_URL,
    v: 2,
  };
  return JSON.stringify(ordered);
}

/**
 * Convenience: build the full memo from raw observations + cycle
 * metadata in one call. Used by the cycle poller. Always emits the
 * default protocol version (v=2 currently).
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
