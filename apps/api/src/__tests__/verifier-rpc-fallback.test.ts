import { describe, expect, it, vi } from "vitest";
import type { Connection } from "@solana/web3.js";
import bs58 from "bs58";

import { fetchOnChainMemo } from "../solana";

/**
 * Regression test for the cycle-1165 verifier outage.
 *
 * Symptom: `/v1/verify/observation/:id` returned
 *   failure_reason: "memo_matches_onchain"
 *   failure_detail: "on-chain tx ... not found at finalized commitment, or has no Memo instruction"
 *
 * For cycle 1165, signature
 *   Sc37PbtHSi9oFboAgP7tfspf427q2w2iZVFZHjwWc2fFfAGh5h5ysjyvVbxHDWxxqFzrLzAgbgYsPzpkTfBfovz
 *
 * The tx WAS confirmed finalized at slot 418895292 — verified
 * out-of-band via public RPC's getSignatureStatuses. But the
 * verifier's getTransaction(commitment: "finalized") returned null
 * because the cluster RPC's finalized-tx cache window doesn't
 * extend back ~4 months. The same RPC, queried at
 * commitment: "confirmed", returns the tx fine.
 *
 * The fix in apps/api/src/solana.ts: try finalized first, fall
 * back to confirmed if the first attempt returns null. The
 * returned object now carries `commitmentUsed` so the verifier
 * surfaces the distinction in its response.
 *
 * These tests pin the fallback behaviour so a future edit can't
 * silently regress to finalized-only.
 */

const CYCLE_1165_SIGNATURE =
  "Sc37PbtHSi9oFboAgP7tfspf427q2w2iZVFZHjwWc2fFfAGh5h5ysjyvVbxHDWxxqFzrLzAgbgYsPzpkTfBfovz";
const CYCLE_1165_SLOT = 418895292;
const ORACLE_AUTHORITY = "FmBggsBjzGsHrtMayYG8ix2JzoYhVczrwJaGGKPpNKK7";
const MEMO_PROGRAM_ID = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";

/**
 * Build a fake `getTransaction` return value that matches the
 * shape @solana/web3.js's TS types expect for a v0 versioned tx.
 * The verifier's decode logic looks for:
 *   - tx.transaction.message.compiledInstructions / instructions
 *   - tx.transaction.message.staticAccountKeys / accountKeys
 *   - tx.transaction.message.header.numRequiredSignatures
 *   - tx.slot, tx.blockTime
 */
function fakeTx(args: {
  slot: number;
  signer: string;
  memoUtf8: string;
}): unknown {
  const memoBytes = new Uint8Array(Buffer.from(args.memoUtf8, "utf-8"));
  return {
    slot: args.slot,
    blockTime: 1715000000,
    transaction: {
      message: {
        header: { numRequiredSignatures: 1, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: 1 },
        staticAccountKeys: [
          // Signer (oracle authority)
          { toBase58: () => args.signer },
          // Memo program
          { toBase58: () => MEMO_PROGRAM_ID },
        ],
        compiledInstructions: [
          {
            programIdIndex: 1, // → MEMO_PROGRAM_ID
            accountKeyIndexes: [],
            data: memoBytes,
          },
        ],
      },
    },
    meta: { err: null, fee: 5000, blockTime: 1715000000 },
  };
}

/**
 * Helper to build a stub Connection. Returns a mock and a vitest
 * spy on getTransaction so each test can configure the per-call
 * return values.
 */
function stubConnection(): {
  conn: Connection;
  getTransactionMock: ReturnType<typeof vi.fn>;
} {
  const getTransactionMock = vi.fn();
  const conn = { getTransaction: getTransactionMock } as unknown as Connection;
  return { conn, getTransactionMock };
}

describe("fetchOnChainMemo — cycle 1165 regression", () => {
  it("falls back to confirmed when finalized returns null (the cycle 1165 case)", async () => {
    const { conn, getTransactionMock } = stubConnection();
    // First call (finalized) returns null — Helius's finalized-tx
    // cache doesn't have this 4-month-old slot.
    getTransactionMock.mockResolvedValueOnce(null);
    // Second call (confirmed) returns the actual tx.
    getTransactionMock.mockResolvedValueOnce(
      fakeTx({
        slot: CYCLE_1165_SLOT,
        signer: ORACLE_AUTHORITY,
        memoUtf8: '{"v":2,"cycle_id":1165,"merkle_root":"0xabc"}',
      }),
    );

    const result = await fetchOnChainMemo(conn, CYCLE_1165_SIGNATURE);

    expect(result).not.toBeNull();
    expect(result!.memo).toBe('{"v":2,"cycle_id":1165,"merkle_root":"0xabc"}');
    expect(result!.slot).toBe(CYCLE_1165_SLOT);
    expect(result!.signers).toEqual([ORACLE_AUTHORITY]);
    expect(result!.commitmentUsed).toBe("confirmed");

    // Pin BOTH commitment levels were tried, in the correct order.
    expect(getTransactionMock).toHaveBeenCalledTimes(2);
    expect(getTransactionMock.mock.calls[0]![1]).toMatchObject({
      commitment: "finalized",
      maxSupportedTransactionVersion: 0,
    });
    expect(getTransactionMock.mock.calls[1]![1]).toMatchObject({
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
  });

  it("uses finalized result on first hit; doesn't waste a second RPC call", async () => {
    const { conn, getTransactionMock } = stubConnection();
    getTransactionMock.mockResolvedValueOnce(
      fakeTx({
        slot: CYCLE_1165_SLOT,
        signer: ORACLE_AUTHORITY,
        memoUtf8: '{"v":2}',
      }),
    );
    const result = await fetchOnChainMemo(conn, CYCLE_1165_SIGNATURE);
    expect(result).not.toBeNull();
    expect(result!.commitmentUsed).toBe("finalized");
    expect(getTransactionMock).toHaveBeenCalledTimes(1);
  });

  it("returns null when BOTH commitments fail (tx truly unknown to RPC)", async () => {
    const { conn, getTransactionMock } = stubConnection();
    getTransactionMock.mockResolvedValueOnce(null);
    getTransactionMock.mockResolvedValueOnce(null);
    const result = await fetchOnChainMemo(conn, CYCLE_1165_SIGNATURE);
    expect(result).toBeNull();
    expect(getTransactionMock).toHaveBeenCalledTimes(2);
  });

  it("returns null when tx exists but has no Memo instruction (no second attempt)", async () => {
    // If the tx is found but has no Memo, retrying at confirmed
    // would find the same tx with the same lack of memo. Don't
    // waste an RPC call.
    const { conn, getTransactionMock } = stubConnection();
    getTransactionMock.mockResolvedValueOnce({
      slot: CYCLE_1165_SLOT,
      blockTime: null,
      transaction: {
        message: {
          header: { numRequiredSignatures: 1, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: 1 },
          staticAccountKeys: [
            { toBase58: () => ORACLE_AUTHORITY },
            // No memo program here — only a system program ix or similar.
            { toBase58: () => "11111111111111111111111111111111" },
          ],
          compiledInstructions: [
            { programIdIndex: 1, accountKeyIndexes: [], data: new Uint8Array(0) },
          ],
        },
      },
      meta: { err: null, fee: 5000 },
    });
    const result = await fetchOnChainMemo(conn, CYCLE_1165_SIGNATURE);
    expect(result).toBeNull();
    expect(getTransactionMock).toHaveBeenCalledTimes(1);
  });

  it("decodes legacy-format (base58 string) instruction data correctly", async () => {
    // Pre-v0 transactions encode instruction data as a base58
    // string rather than Uint8Array. Both code paths should work.
    const memoUtf8 = '{"v":1,"legacy":true}';
    const memoBase58 = bs58.encode(Buffer.from(memoUtf8, "utf-8"));
    const { conn, getTransactionMock } = stubConnection();
    getTransactionMock.mockResolvedValueOnce({
      slot: CYCLE_1165_SLOT,
      blockTime: null,
      transaction: {
        message: {
          header: { numRequiredSignatures: 1, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: 1 },
          // Legacy uses `accountKeys` not `staticAccountKeys`
          accountKeys: [
            { toBase58: () => ORACLE_AUTHORITY },
            { toBase58: () => MEMO_PROGRAM_ID },
          ],
          // Legacy uses `instructions` not `compiledInstructions`
          instructions: [
            { programIdIndex: 1, accounts: [], data: memoBase58 },
          ],
        },
      },
      meta: { err: null, fee: 5000 },
    });
    const result = await fetchOnChainMemo(conn, CYCLE_1165_SIGNATURE);
    expect(result).not.toBeNull();
    expect(result!.memo).toBe(memoUtf8);
  });
});
