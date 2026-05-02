import { bytesToHex0x, hex0xToBytes, innerHash, type MerkleTree } from "./merkle";

/**
 * Merkle proof generation + verification per §05.4.4.
 *
 * A proof is the ordered list of sibling hashes a verifier needs to
 * walk from a single leaf up to the root. Each step records both the
 * sibling's hash AND its position relative to the current node
 * (`left` or `right`) — without that, an attacker could permute hash
 * inputs and forge a different root.
 *
 * Position semantics (matches §05.4.4):
 *   - At each level, look at the current node's index. If even, the
 *     sibling is the next index (right). If odd, the sibling is the
 *     previous index (left). Bitcoin-style odd-count handling means a
 *     last-element-with-no-right-sibling pairs with itself; in that
 *     case the proof step records `position='right', hash=<self>`.
 *   - Verifier replays:
 *
 *       current = leaf_hash
 *       for step in proof:
 *         if step.position == 'left':  current = inner(step.hash, current)
 *         else (right):                current = inner(current, step.hash)
 *
 * `inner` here is `innerHash(left, right)` from ./merkle, which is
 * `SHA-256(0x01 || left || right)` (RFC 6962 domain separation).
 *
 * The proof's length equals the tree depth (== ⌈log₂(leaves)⌉). For a
 * 4-leaf tree, every proof has length 2; for a 1-leaf tree, length 0
 * (root == leaf).
 */

export interface MerkleProofStep {
  position: "left" | "right";
  /** "0x" + 64 hex chars; the sibling's hash at this level. */
  hash: string;
}

/**
 * Generate the Merkle proof for the leaf at `leafIndex` in `tree`.
 *
 * `leafIndex` must be in `[0, tree.leaves.length)`; otherwise throws.
 * Returns an empty array when the tree has a single leaf (no inner
 * nodes; root == leaf hash).
 */
export function generateProof(
  tree: MerkleTree,
  leafIndex: number,
): MerkleProofStep[] {
  if (!Number.isInteger(leafIndex) || leafIndex < 0 || leafIndex >= tree.leaves.length) {
    throw new Error(
      `merkle-proof: leafIndex ${leafIndex} out of range ` +
        `[0, ${tree.leaves.length})`,
    );
  }
  if (tree.leaves.length === 1) {
    return [];
  }

  const proof: MerkleProofStep[] = [];
  let idx = leafIndex;
  // Walk every level except the topmost (which contains only the root,
  // and the root has no sibling).
  for (let level = 0; level < tree.levels.length - 1; level++) {
    const nodes = tree.levels[level]!;
    const isRightChild = idx % 2 === 1;
    let siblingIdx: number;
    if (isRightChild) {
      siblingIdx = idx - 1;
    } else {
      // Left child. Sibling is at idx+1 if it exists, else self
      // (Bitcoin-style odd-count duplication per §02.4.5).
      siblingIdx = idx + 1 < nodes.length ? idx + 1 : idx;
    }
    const siblingHash = nodes[siblingIdx]!;
    proof.push({
      position: isRightChild ? "left" : "right",
      hash: bytesToHex0x(siblingHash),
    });
    idx = Math.floor(idx / 2);
  }
  return proof;
}

/**
 * Verify a Merkle proof. Replays the proof against the leaf hash and
 * checks the result equals the expected root. Returns
 * `{ verified: true, computedRoot }` on a match, or
 * `{ verified: false, computedRoot }` on a mismatch — the
 * `computedRoot` is exposed in both cases so a failing call can still
 * surface "what we got" alongside "what we expected" for diagnostics.
 *
 * Throws on malformed inputs (bad hex, wrong byte lengths) — those
 * indicate a caller bug, not a verification failure.
 */
export interface VerifyProofArgs {
  /** "0x" + 64 hex; the leaf's hash. */
  leafHash: string;
  proof: MerkleProofStep[];
  /** "0x" + 64 hex; the expected Merkle root. */
  expectedRoot: string;
}

export interface VerifyProofResult {
  verified: boolean;
  /** "0x" + 64 hex; the root the proof actually computes to. */
  computedRoot: string;
}

export function verifyProof(args: VerifyProofArgs): VerifyProofResult {
  let current = hex0xToBytes(args.leafHash);
  for (const step of args.proof) {
    const sibling = hex0xToBytes(step.hash);
    if (step.position === "left") {
      current = innerHash(sibling, current);
    } else if (step.position === "right") {
      current = innerHash(current, sibling);
    } else {
      throw new Error(
        `merkle-proof: invalid step.position "${step.position}" — ` +
          `must be "left" or "right"`,
      );
    }
  }
  const computedRoot = bytesToHex0x(current);
  return {
    verified: computedRoot === args.expectedRoot,
    computedRoot,
  };
}
