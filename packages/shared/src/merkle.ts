import { createHash } from "node:crypto";
import { canonicalObservationJson, type Observation } from "./canonical";

/**
 * Merkle tree construction per §02.4.
 *
 * Pure module. Takes Observations in canonical form, returns the tree's
 * root + all level hashes (the level data is structured for future proof
 * generation; the v1 commit lifecycle only needs the root).
 *
 * Domain separation (§02.4.4) is RFC 6962:
 *   leaf  = SHA-256( 0x00 || canonical_json_utf8 )
 *   inner = SHA-256( 0x01 || left_bytes || right_bytes )
 *
 * Tree shape (§02.4.5):
 *   - Binary, ordered by observation id ascending.
 *   - Odd levels duplicate the last node (Bitcoin-style; ambiguity is
 *     resolved by the cycle memo always co-committing observation_count).
 *   - Recurse until exactly one node remains; that's the root.
 *
 * Edge cases:
 *   - Zero observations: refuse. Spec §02.4.5 says zero-observation
 *     cycles aren't committed in v1; the committer skips and logs.
 *   - One observation: root == leaf hash; the single-leaf tree has no
 *     internal nodes.
 */

const LEAF_PREFIX = Uint8Array.from([0x00]);
const INNER_PREFIX = Uint8Array.from([0x01]);

/**
 * Compute the leaf hash for one observation.
 *
 * Returns 32 raw bytes. Wrap with bytesToHex0x() at API/log boundaries.
 */
export function leafHash(obs: Observation): Buffer {
  const json = canonicalObservationJson(obs);
  return createHash("sha256")
    .update(LEAF_PREFIX)
    .update(Buffer.from(json, "utf-8"))
    .digest();
}

/**
 * Combine two child hashes into their parent inner-node hash.
 *
 * Both inputs must be 32 bytes (raw SHA-256 output). The inner-node
 * domain separation byte 0x01 distinguishes inner-node hashes from
 * leaf hashes; collisions across the disjoint hash spaces are
 * cryptographically infeasible.
 */
export function innerHash(left: Buffer, right: Buffer): Buffer {
  if (left.length !== 32 || right.length !== 32) {
    throw new Error(
      `merkle: innerHash inputs must be 32 bytes each ` +
        `(got left=${left.length}, right=${right.length})`,
    );
  }
  return createHash("sha256")
    .update(INNER_PREFIX)
    .update(left)
    .update(right)
    .digest();
}

export interface MerkleTree {
  /** 32-byte SHA-256 root. */
  root: Buffer;
  /** Leaf hashes in ordered position (index 0 is the lowest observation id). */
  leaves: Buffer[];
  /**
   * All levels, bottom-up. levels[0] is the leaf level (== leaves);
   * levels[N-1] is a single-node array containing the root.
   *
   * Useful for proof generation (a future ticket): given leaf_index, walk
   * each level taking the sibling hash + its position relative to current.
   * For odd-count levels, the last node was paired with itself, so the
   * sibling at odd indices may be the same as current (Bitcoin-style).
   */
  levels: Buffer[][];
}

/**
 * Build the full Merkle tree from a set of observations.
 *
 * Sorts a defensive copy by id ascending; doesn't mutate the input.
 * Throws on zero observations (§02.4.5).
 */
export function buildMerkleTree(observations: Observation[]): MerkleTree {
  if (observations.length === 0) {
    throw new Error(
      "merkle: refusing to build tree from zero observations " +
        "(§02.4.5 — zero-observation cycles are not committed in v1)",
    );
  }

  // Order leaves by observation id ascending (§02.4.5). Defensive copy
  // so callers can pass any order without their data being mutated.
  const sorted = [...observations].sort((a, b) => {
    if (a.id === b.id) {
      throw new Error(
        `merkle: duplicate observation id ${a.id} in input set; ` +
          "Merkle leaf order would be ambiguous",
      );
    }
    return a.id - b.id;
  });

  const leaves = sorted.map(leafHash);

  if (leaves.length === 1) {
    // Single-leaf tree: root == leaf hash, no inner nodes.
    return { root: leaves[0]!, leaves, levels: [leaves] };
  }

  const levels: Buffer[][] = [leaves];
  let current = leaves;
  while (current.length > 1) {
    const next: Buffer[] = [];
    for (let i = 0; i < current.length; i += 2) {
      const left = current[i]!;
      // Bitcoin-style odd-node duplication: pair last with itself.
      const right = i + 1 < current.length ? current[i + 1]! : current[i]!;
      next.push(innerHash(left, right));
    }
    levels.push(next);
    current = next;
  }
  return { root: current[0]!, leaves, levels };
}

/**
 * Render a 32-byte hash as the canonical "0x" + 64 lowercase hex string
 * used everywhere we cross an API or log boundary (§02.4.5 output format).
 */
export function bytesToHex0x(buf: Buffer): string {
  if (buf.length !== 32) {
    throw new Error(`merkle: bytesToHex0x expects 32 bytes, got ${buf.length}`);
  }
  return "0x" + buf.toString("hex");
}

/**
 * Inverse of bytesToHex0x. Validates format; throws on anything that
 * isn't exactly 0x + 64 lowercase hex chars.
 */
export function hex0xToBytes(hex: string): Buffer {
  if (!/^0x[0-9a-f]{64}$/.test(hex)) {
    throw new Error(
      `merkle: hex0xToBytes expected 0x+64 lowercase hex chars, got "${hex}"`,
    );
  }
  return Buffer.from(hex.slice(2), "hex");
}
