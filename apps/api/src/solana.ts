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
}

/**
 * Fetch a finalized transaction by signature and extract its Memo
 * instruction data + signers + slot.
 *
 * Returns null if:
 *   - the signature is not found at finalized commitment
 *   - the tx has no Memo instruction
 *   - the Memo's data cannot be decoded as UTF-8 (unlikely; the spec
 *     guarantees canonical JSON UTF-8)
 */
export async function fetchOnChainMemo(
  conn: Connection,
  signature: string,
): Promise<OnChainMemoResult | null> {
  const tx = await conn.getTransaction(signature, {
    commitment: "finalized",
    maxSupportedTransactionVersion: 0,
  });
  if (!tx) return null;

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
  if (!memoBytes) return null;

  const memo = memoBytes.toString("utf-8");

  // Signers are the first numRequiredSignatures account keys per the
  // Solana wire format; they're the ones whose signatures are required
  // for the tx.
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
  };
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
