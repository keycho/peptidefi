import { describe, expect, it } from "vitest";
import { Keypair } from "@solana/web3.js";
import { buildSignedMemoTx, MEMO_PROGRAM_ID } from "../solana/memo-tx";
import { SPEC_CYCLE_MEMO_JSON } from "./fixtures";

/**
 * Memo transaction construction tests.
 *
 * Verifies that buildSignedMemoTx:
 *   - produces a Transaction whose Memo instruction's data bytes
 *     are the canonical UTF-8 of the memo string (BYTE-EXACT — this
 *     is the on-chain attestation, can't drift)
 *   - includes the Memo program id in the instruction's programId
 *   - includes the payer pubkey as a signer on the Memo instruction
 *   - has the ComputeBudget price + limit instructions before Memo
 *   - is signed (transaction.signature is non-null)
 *   - serializes to a non-empty Buffer
 *
 * Ed25519 signing is deterministic, so we also assert that two
 * builds with the same inputs produce identical signatures (catches
 * accidental nondeterminism upstream — e.g., if someone added a
 * timestamp to the canonical body).
 */

function fixedKeypair(): Keypair {
  // 64-byte secret derived from a fixed seed so the tests reproduce
  // signatures byte-exact.
  const seed = new Uint8Array(32);
  for (let i = 0; i < 32; i++) seed[i] = i + 1;
  return Keypair.fromSeed(seed);
}

const FAKE_BLOCKHASH = "EETubP5AKHgjPAhzPAFcb8BAY1hMH639CWCFTqi3hq1k";
const FAKE_VALID_HEIGHT = 123_456_789;

describe("buildSignedMemoTx", () => {
  it("includes the Memo program id and the canonical memo bytes", () => {
    const signed = buildSignedMemoTx({
      memo: SPEC_CYCLE_MEMO_JSON,
      blockhash: FAKE_BLOCKHASH,
      lastValidBlockHeight: FAKE_VALID_HEIGHT,
      payer: fixedKeypair(),
      priorityFeeMicroLamports: 1000,
      cuLimit: 500,
    });

    // Re-deserialize the tx so the test reads the same shape that
    // would land on-chain.
    const Transaction = require("@solana/web3.js").Transaction;
    const tx = Transaction.from(signed.serialized);

    // The 3rd instruction (index 2) is the Memo; preceded by
    // ComputeBudget price (0) + ComputeBudget limit (1).
    expect(tx.instructions).toHaveLength(3);
    const memoIx = tx.instructions[2];
    expect(memoIx.programId.equals(MEMO_PROGRAM_ID)).toBe(true);
    expect(Buffer.from(memoIx.data).toString("utf-8")).toBe(SPEC_CYCLE_MEMO_JSON);
  });

  it("attaches the payer as a signer on the Memo instruction", () => {
    const kp = fixedKeypair();
    const signed = buildSignedMemoTx({
      memo: SPEC_CYCLE_MEMO_JSON,
      blockhash: FAKE_BLOCKHASH,
      lastValidBlockHeight: FAKE_VALID_HEIGHT,
      payer: kp,
      priorityFeeMicroLamports: 1000,
    });
    const Transaction = require("@solana/web3.js").Transaction;
    const tx = Transaction.from(signed.serialized);
    const memoIx = tx.instructions[2];
    expect(memoIx.keys).toHaveLength(1);
    expect(memoIx.keys[0].isSigner).toBe(true);
    expect(memoIx.keys[0].pubkey.equals(kp.publicKey)).toBe(true);
  });

  it("returns a non-empty signature and serialized payload", () => {
    const signed = buildSignedMemoTx({
      memo: "test memo",
      blockhash: FAKE_BLOCKHASH,
      lastValidBlockHeight: FAKE_VALID_HEIGHT,
      payer: fixedKeypair(),
      priorityFeeMicroLamports: 0,
    });
    expect(signed.signature.length).toBeGreaterThan(80); // base58 sig ~= 88 chars
    expect(signed.serialized.length).toBeGreaterThan(0);
  });

  it("ed25519 is deterministic: same inputs → same signature", () => {
    const args = {
      memo: SPEC_CYCLE_MEMO_JSON,
      blockhash: FAKE_BLOCKHASH,
      lastValidBlockHeight: FAKE_VALID_HEIGHT,
      payer: fixedKeypair(),
      priorityFeeMicroLamports: 1000,
      cuLimit: 500,
    };
    const a = buildSignedMemoTx(args);
    const b = buildSignedMemoTx(args);
    expect(a.signature).toBe(b.signature);
    expect(Buffer.compare(a.serialized, b.serialized)).toBe(0);
  });

  it("changes signature when memo content changes (catches canonical drift)", () => {
    const args = {
      blockhash: FAKE_BLOCKHASH,
      lastValidBlockHeight: FAKE_VALID_HEIGHT,
      payer: fixedKeypair(),
      priorityFeeMicroLamports: 1000,
      cuLimit: 500,
    };
    const a = buildSignedMemoTx({ ...args, memo: "memo a" });
    const b = buildSignedMemoTx({ ...args, memo: "memo b" });
    expect(a.signature).not.toBe(b.signature);
  });
});
