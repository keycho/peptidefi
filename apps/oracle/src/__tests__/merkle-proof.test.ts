import { describe, expect, it } from "vitest";
import {
  bytesToHex0x,
  buildMerkleTree,
  generateProof,
  leafHash,
  verifyProof,
} from "@peptide-oracle/shared";
import {
  SPEC_INNER_HASHES,
  SPEC_LEAF_HASHES,
  SPEC_OBS_1,
  SPEC_OBS_2,
  SPEC_OBS_3,
  SPEC_OBS_4,
  SPEC_ROOT,
} from "./fixtures";

/**
 * Merkle-proof tests against the §02.4.6 worked example. The fixtures
 * give us a known 4-leaf tree (L1, L2, L3, L4 → ROOT) so we can both
 * generate proofs by hand and assert generateProof produces the same
 * shape.
 *
 * Tree topology (from §02.4.6):
 *
 *                   ROOT
 *                  /     \
 *                N12      N34
 *               /  \     /  \
 *              L1  L2   L3  L4
 *             idx 0  1   2   3
 *
 * Proofs (sibling at each level, position relative to current node):
 *   L1 (idx 0) → [ {right, L2}, {right, N34} ]
 *   L2 (idx 1) → [ {left, L1},  {right, N34} ]
 *   L3 (idx 2) → [ {right, L4}, {left,  N12} ]
 *   L4 (idx 3) → [ {left, L3},  {left,  N12} ]
 */

const tree = buildMerkleTree([SPEC_OBS_1, SPEC_OBS_2, SPEC_OBS_3, SPEC_OBS_4]);

describe("generateProof — §02.4.6 4-leaf tree", () => {
  it("L1 (idx 0): [right L2, right N34]", () => {
    expect(generateProof(tree, 0)).toEqual([
      { position: "right", hash: SPEC_LEAF_HASHES.L2 },
      { position: "right", hash: SPEC_INNER_HASHES.N34 },
    ]);
  });

  it("L2 (idx 1): [left L1, right N34]", () => {
    expect(generateProof(tree, 1)).toEqual([
      { position: "left", hash: SPEC_LEAF_HASHES.L1 },
      { position: "right", hash: SPEC_INNER_HASHES.N34 },
    ]);
  });

  it("L3 (idx 2): [right L4, left N12]", () => {
    expect(generateProof(tree, 2)).toEqual([
      { position: "right", hash: SPEC_LEAF_HASHES.L4 },
      { position: "left", hash: SPEC_INNER_HASHES.N12 },
    ]);
  });

  it("L4 (idx 3): [left L3, left N12]", () => {
    expect(generateProof(tree, 3)).toEqual([
      { position: "left", hash: SPEC_LEAF_HASHES.L3 },
      { position: "left", hash: SPEC_INNER_HASHES.N12 },
    ]);
  });

  it("rejects out-of-range leafIndex", () => {
    expect(() => generateProof(tree, -1)).toThrow(/out of range/);
    expect(() => generateProof(tree, 4)).toThrow(/out of range/);
    expect(() => generateProof(tree, 1.5)).toThrow(/out of range/);
  });

  it("returns empty array for a single-leaf tree (root == leaf)", () => {
    const oneLeaf = buildMerkleTree([SPEC_OBS_1]);
    expect(generateProof(oneLeaf, 0)).toEqual([]);
  });

  it("3-leaf tree: last leaf's sibling is itself (Bitcoin-style odd duplication)", () => {
    const threeLeaf = buildMerkleTree([SPEC_OBS_1, SPEC_OBS_2, SPEC_OBS_3]);
    const proof = generateProof(threeLeaf, 2);
    // L3 at level 0 has no sibling → pairs with itself
    expect(proof[0]).toEqual({
      position: "right",
      hash: SPEC_LEAF_HASHES.L3,
    });
  });
});

describe("verifyProof — round-trip against generateProof", () => {
  it.each([0, 1, 2, 3])("leaf at index %d verifies to SPEC_ROOT", (idx) => {
    const proof = generateProof(tree, idx);
    const leaf = bytesToHex0x(tree.leaves[idx]!);
    const result = verifyProof({
      leafHash: leaf,
      proof,
      expectedRoot: SPEC_ROOT,
    });
    expect(result.verified).toBe(true);
    expect(result.computedRoot).toBe(SPEC_ROOT);
  });

  it("returns verified=false (not throw) when the leaf hash is wrong", () => {
    const proof = generateProof(tree, 0);
    const wrongLeaf =
      "0x" +
      "00".repeat(32); // not L1
    const result = verifyProof({
      leafHash: wrongLeaf,
      proof,
      expectedRoot: SPEC_ROOT,
    });
    expect(result.verified).toBe(false);
    // Computed root is non-empty + clearly different from SPEC_ROOT.
    expect(result.computedRoot).not.toBe(SPEC_ROOT);
    expect(result.computedRoot).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("returns verified=false when a sibling hash is tampered with", () => {
    const proof = generateProof(tree, 0);
    const tampered = [...proof];
    // Flip last byte of the first sibling.
    const siblingHex = tampered[0]!.hash;
    const flipped = siblingHex.slice(0, -2) + "ff";
    tampered[0] = { ...tampered[0]!, hash: flipped };
    const result = verifyProof({
      leafHash: SPEC_LEAF_HASHES.L1,
      proof: tampered,
      expectedRoot: SPEC_ROOT,
    });
    expect(result.verified).toBe(false);
  });

  it("returns verified=false when a position is flipped (left ↔ right)", () => {
    const proof = generateProof(tree, 0);
    const tampered = [...proof];
    tampered[0] = { ...tampered[0]!, position: "left" };
    const result = verifyProof({
      leafHash: SPEC_LEAF_HASHES.L1,
      proof: tampered,
      expectedRoot: SPEC_ROOT,
    });
    expect(result.verified).toBe(false);
  });

  it("single-leaf tree: empty proof verifies leaf as root", () => {
    const oneLeaf = buildMerkleTree([SPEC_OBS_1]);
    const result = verifyProof({
      leafHash: SPEC_LEAF_HASHES.L1,
      proof: [],
      expectedRoot: bytesToHex0x(oneLeaf.root),
    });
    expect(result.verified).toBe(true);
    expect(result.computedRoot).toBe(SPEC_LEAF_HASHES.L1);
  });

  it("byte-exact: leaf hash from leafHash() + generated proof verifies", () => {
    // Round trip: compute the leaf from the canonical Observation,
    // generate the proof, verify against SPEC_ROOT.
    const idx = 0;
    const leaf = bytesToHex0x(leafHash(SPEC_OBS_1));
    expect(leaf).toBe(SPEC_LEAF_HASHES.L1);
    const proof = generateProof(tree, idx);
    expect(
      verifyProof({ leafHash: leaf, proof, expectedRoot: SPEC_ROOT }).verified,
    ).toBe(true);
  });

  it("throws on malformed proof step position", () => {
    expect(() =>
      verifyProof({
        leafHash: SPEC_LEAF_HASHES.L1,
        proof: [{ position: "middle" as "left", hash: SPEC_LEAF_HASHES.L2 }],
        expectedRoot: SPEC_ROOT,
      }),
    ).toThrow(/invalid step\.position/);
  });
});
