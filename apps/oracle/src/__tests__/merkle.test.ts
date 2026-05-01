import { describe, expect, it } from "vitest";
import {
  bytesToHex0x,
  buildMerkleTree,
  hex0xToBytes,
  innerHash,
  leafHash,
} from "../merkle";
import {
  SPEC_INNER_HASHES,
  SPEC_LEAF_HASHES,
  SPEC_OBS_1,
  SPEC_OBS_2,
  SPEC_OBS_3,
  SPEC_OBS_4,
  SPEC_ROOT,
} from "./fixtures";

describe("leafHash", () => {
  it("reproduces all four spec leaf hashes (§02.4.6)", () => {
    expect(bytesToHex0x(leafHash(SPEC_OBS_1))).toBe(SPEC_LEAF_HASHES.L1);
    expect(bytesToHex0x(leafHash(SPEC_OBS_2))).toBe(SPEC_LEAF_HASHES.L2);
    expect(bytesToHex0x(leafHash(SPEC_OBS_3))).toBe(SPEC_LEAF_HASHES.L3);
    expect(bytesToHex0x(leafHash(SPEC_OBS_4))).toBe(SPEC_LEAF_HASHES.L4);
  });

  it("returns 32 raw bytes", () => {
    expect(leafHash(SPEC_OBS_1)).toHaveLength(32);
  });
});

describe("innerHash", () => {
  it("reproduces the spec's N12 from L1 + L2", () => {
    const l1 = hex0xToBytes(SPEC_LEAF_HASHES.L1);
    const l2 = hex0xToBytes(SPEC_LEAF_HASHES.L2);
    expect(bytesToHex0x(innerHash(l1, l2))).toBe(SPEC_INNER_HASHES.N12);
  });

  it("reproduces the spec's N34 from L3 + L4", () => {
    const l3 = hex0xToBytes(SPEC_LEAF_HASHES.L3);
    const l4 = hex0xToBytes(SPEC_LEAF_HASHES.L4);
    expect(bytesToHex0x(innerHash(l3, l4))).toBe(SPEC_INNER_HASHES.N34);
  });

  it("rejects non-32-byte inputs", () => {
    const ok = hex0xToBytes(SPEC_LEAF_HASHES.L1);
    const short = Buffer.alloc(31);
    expect(() => innerHash(short, ok)).toThrow(/32 bytes/);
    expect(() => innerHash(ok, short)).toThrow(/32 bytes/);
  });
});

describe("buildMerkleTree", () => {
  const SPEC_OBS = [SPEC_OBS_1, SPEC_OBS_2, SPEC_OBS_3, SPEC_OBS_4] as const;

  it("reproduces the §02.4.6 worked-example root from the 4-obs set", () => {
    const tree = buildMerkleTree([...SPEC_OBS]);
    expect(bytesToHex0x(tree.root)).toBe(SPEC_ROOT);
  });

  it("produces leaves in id-ascending order regardless of input order", () => {
    // Shuffled input
    const tree = buildMerkleTree([SPEC_OBS_4, SPEC_OBS_2, SPEC_OBS_3, SPEC_OBS_1]);
    expect(bytesToHex0x(tree.root)).toBe(SPEC_ROOT);
    expect(bytesToHex0x(tree.leaves[0]!)).toBe(SPEC_LEAF_HASHES.L1);
    expect(bytesToHex0x(tree.leaves[1]!)).toBe(SPEC_LEAF_HASHES.L2);
    expect(bytesToHex0x(tree.leaves[2]!)).toBe(SPEC_LEAF_HASHES.L3);
    expect(bytesToHex0x(tree.leaves[3]!)).toBe(SPEC_LEAF_HASHES.L4);
  });

  it("exposes per-level hashes for proof generation", () => {
    const tree = buildMerkleTree([...SPEC_OBS]);
    expect(tree.levels).toHaveLength(3); // leaf level + N-pair level + root
    expect(tree.levels[0]).toHaveLength(4);
    expect(tree.levels[1]).toHaveLength(2);
    expect(tree.levels[2]).toHaveLength(1);
    expect(bytesToHex0x(tree.levels[1]![0]!)).toBe(SPEC_INNER_HASHES.N12);
    expect(bytesToHex0x(tree.levels[1]![1]!)).toBe(SPEC_INNER_HASHES.N34);
    expect(bytesToHex0x(tree.levels[2]![0]!)).toBe(SPEC_ROOT);
  });

  it("does not mutate the input array", () => {
    const input = [SPEC_OBS_4, SPEC_OBS_3, SPEC_OBS_2, SPEC_OBS_1];
    const before = [...input];
    buildMerkleTree(input);
    expect(input).toEqual(before);
  });

  it("single-leaf tree: root == leaf hash", () => {
    const tree = buildMerkleTree([SPEC_OBS_1]);
    expect(bytesToHex0x(tree.root)).toBe(SPEC_LEAF_HASHES.L1);
    expect(tree.levels).toHaveLength(1);
    expect(tree.leaves).toHaveLength(1);
  });

  it("odd-count tree (3 leaves): pairs the last leaf with itself", () => {
    // Build a 3-leaf tree manually + verify the implementation matches.
    // Bitcoin-style: at the leaf level, [L1, L2, L3] becomes
    //   N12 = inner(L1, L2)
    //   N33 = inner(L3, L3)
    // Then the next level [N12, N33] becomes
    //   ROOT = inner(N12, N33)
    const tree = buildMerkleTree([SPEC_OBS_1, SPEC_OBS_2, SPEC_OBS_3]);
    const l1 = leafHash(SPEC_OBS_1);
    const l2 = leafHash(SPEC_OBS_2);
    const l3 = leafHash(SPEC_OBS_3);
    const n12 = innerHash(l1, l2);
    const n33 = innerHash(l3, l3);
    const expectedRoot = innerHash(n12, n33);
    expect(bytesToHex0x(tree.root)).toBe(bytesToHex0x(expectedRoot));
    expect(tree.levels).toHaveLength(3);
    expect(tree.levels[1]).toHaveLength(2);
  });

  it("refuses zero-observation input (§02.4.5)", () => {
    expect(() => buildMerkleTree([])).toThrow(
      /refusing to build tree from zero observations/,
    );
  });

  it("refuses duplicate observation ids (would make leaf order ambiguous)", () => {
    const dup = { ...SPEC_OBS_2, id: 1001 };
    expect(() => buildMerkleTree([SPEC_OBS_1, dup])).toThrow(
      /duplicate observation id/,
    );
  });
});

describe("bytesToHex0x / hex0xToBytes", () => {
  it("round-trips a 32-byte buffer", () => {
    const buf = leafHash(SPEC_OBS_1);
    const hex = bytesToHex0x(buf);
    expect(hex).toBe(SPEC_LEAF_HASHES.L1);
    expect(hex0xToBytes(hex).equals(buf)).toBe(true);
  });

  it("rejects non-32-byte inputs in bytesToHex0x", () => {
    expect(() => bytesToHex0x(Buffer.alloc(31))).toThrow(/32 bytes/);
  });

  it("rejects malformed hex strings in hex0xToBytes", () => {
    expect(() => hex0xToBytes("0xZZZZ")).toThrow(/expected 0x.*hex/);
    expect(() => hex0xToBytes(SPEC_LEAF_HASHES.L1.toUpperCase())).toThrow(
      /expected 0x.*hex/,
    );
    expect(() => hex0xToBytes(SPEC_LEAF_HASHES.L1.slice(2))).toThrow(/expected 0x/);
  });
});
