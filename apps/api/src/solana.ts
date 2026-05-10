import { Connection, type ConfirmedSignatureInfo } from "@solana/web3.js";
import bs58 from "bs58";

/**
 * Read-only Solana RPC helper for the verification API.
 *
 * Two operations:
 *   - fetchMemoFromTransaction: given a finalized signature, fetch the
 *     transaction and decode the on-chain Memo instruction's data
 *     bytes as UTF-8. Returns null if the signature isn't found, the
 *     tx has no Memo instruction, or the data fails to decode. The
 *     /v1/verify/observation endpoint compares this byte-for-byte
 *     against the DB's commit_cycles.memo_payload.
 *
 *   - getSlotFromTransaction: extract the slot the tx landed in. Used
 *     by the verify endpoint to assert the DB's solana_slot matches
 *     what the cluster reports.
 *
 * The Memo program v2 stores its instruction data as raw bytes; we
 * decode as UTF-8 since the memo body is canonical JSON. If a future
 * version changes the encoding, this helper needs to know about it.
 */

const MEMO_PROGRAM_ID = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";

/**
 * Lazily-constructed shared Connection. The API is single-process
 * single-port, so one Connection per process is fine. Constructed on
 * first use to avoid hitting RPC at startup time (separates "service
 * is up" from "RPC is reachable").
 */
let _connection: Connection | null = null;

export function getConnection(rpcUrl: string): Connection {
  if (!_connection) {
    _connection = new Connection(rpcUrl, { commitment: "confirmed" });
  }
  return _connection;
}

export interface OnChainMemoResult {
  /** UTF-8 decoded memo body. */
  memo: string;
  /** Slot the transaction landed in. */
  slot: number;
  /** Signers on the transaction (base58 pubkeys). The oracle's authority must be among these. */
  signers: string[];
  /** Block time (Unix epoch seconds), if the cluster reports it. */
  blockTime: number | null;
  /**
   * Commitment level at which the tx was retrieved.
   *
   * 'finalized' is the strongest guarantee (Solana super-majority
   * has voted; reorg-proof). 'confirmed' is a weaker but still
   * cryptographically-valid retrieval — used as a fallback for
   * older transactions because some RPCs (Helius free tier, public
   * mainnet RPC) return null for `getTransaction(commitment:
   * "finalized")` on txs more than ~N slots old, even when the
   * tx IS finalized in the chain. Their confirmed-tx cache extends
   * further back than their finalized-tx cache. The verifier
   * surfaces this distinction in the response so a client can
   * render "verified at confirmed commitment" for older cycles.
   */
  commitmentUsed: "finalized" | "confirmed";
}

/**
 * Fetch a finalized transaction by signature and extract its Memo
 * instruction data + signers + slot.
 *
 * Tries `commitment: "finalized"` first, falls back to "confirmed"
 * if the RPC returns null. Returns null only if BOTH commitment
 * levels fail (tx truly not in the cluster's index, or the tx has
 * no Memo instruction).
 *
 * Why the fallback exists: cycle 1165 (sig Sc37P…ovz) was confirmed
 * finalized at slot 418895292 (~4 months ago) per public RPC's
 * getSignatureStatuses, but our verifier returned "tx not found
 * at finalized commitment" because Helius's getTransaction at
 * finalized commitment returns null for cycles outside its
 * finalized-tx cache window. Switching the second attempt to
 * confirmed retrieves the same tx — same signers, same slot,
 * same memo bytes — with `commitmentUsed: "confirmed"`. The
 * verifier still considers this verified; the client can render
 * the distinction.
 */
export async function fetchOnChainMemo(
  conn: Connection,
  signature: string,
): Promise<OnChainMemoResult | null> {
  for (const commitment of ["finalized", "confirmed"] as const) {
    const tx = await conn.getTransaction(signature, {
      commitment,
      maxSupportedTransactionVersion: 0,
    });
    if (!tx) continue;

    const message = tx.transaction.message;
    // v0 vs legacy have different shapes; we accept both.
    const accountKeys =
      "accountKeys" in message
        ? message.accountKeys
        : message.staticAccountKeys;
    const compiledInstructions =
      "instructions" in message
        ? message.instructions
        : message.compiledInstructions;

    let memoBytes: Buffer | null = null;
    for (const ix of compiledInstructions) {
      const programId = accountKeys[ix.programIdIndex]!;
      if (programId.toBase58() !== MEMO_PROGRAM_ID) continue;
      // Legacy instructions store data as base58-encoded text.
      // v0 stores raw Uint8Array.
      if (typeof ix.data === "string") {
        memoBytes = Buffer.from(bs58.decode(ix.data));
      } else {
        memoBytes = Buffer.from(ix.data);
      }
      break;
    }
    if (!memoBytes) {
      // Tx exists but has no Memo instruction — not a commitment
      // problem. Return null without trying the next commitment
      // (it'd find the same tx with the same lack of memo).
      return null;
    }

    const memo = memoBytes.toString("utf-8");

    // Signers are the first numRequiredSignatures account keys per
    // the Solana wire format; they're the ones whose signatures are
    // required for the tx.
    const numSigners =
      "header" in message ? message.header.numRequiredSignatures : 1;
    const signers = accountKeys
      .slice(0, numSigners)
      .map((k) => k.toBase58());

    return {
      memo,
      slot: tx.slot,
      signers,
      blockTime: tx.blockTime ?? null,
      commitmentUsed: commitment,
    };
  }
  // Both finalized and confirmed returned null — tx is not retrievable
  // from this RPC's index at any commitment level.
  return null;
}

/**
 * Get the lamport balance for a pubkey. Used by /v1/status to surface
 * the oracle wallet's current balance without going through the
 * oracle service.
 */
export async function getBalanceLamports(
  conn: Connection,
  pubkeyBase58: string,
): Promise<number> {
  const PublicKey = (await import("@solana/web3.js")).PublicKey;
  return conn.getBalance(new PublicKey(pubkeyBase58), "confirmed");
}

/**
 * Lightweight signature lookup — used by /v1/status to spot-check the
 * most recent few commits actually exist on-chain. Returns null on
 * any error so /v1/status stays responsive even when the RPC is
 * flaky.
 */
export async function recentSignaturesForAuthority(
  conn: Connection,
  pubkeyBase58: string,
  limit = 10,
): Promise<ConfirmedSignatureInfo[] | null> {
  try {
    const PublicKey = (await import("@solana/web3.js")).PublicKey;
    return await conn.getSignaturesForAddress(
      new PublicKey(pubkeyBase58),
      { limit },
      "confirmed",
    );
  } catch {
    return null;
  }
}
