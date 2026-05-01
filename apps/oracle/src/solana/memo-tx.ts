import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";

/**
 * Build + sign the cycle/twap commit transaction per §3.4.1.
 *
 * Shape (legacy, single-signer):
 *
 *   ComputeBudgetProgram.setComputeUnitPrice(priorityFeeMicroLamports)
 *   ComputeBudgetProgram.setComputeUnitLimit(cuLimit)
 *   Memo(programId=MemoSq4..., data=memo_utf8, signer=payer)
 *
 * The signer is included as a writable signer account on the Memo
 * instruction (Memo v2 takes one signer in its accounts list);
 * web3.js then knows to require its signature on the transaction.
 *
 * Why include the signer in the Memo accounts list explicitly:
 * Memo v2 supports passing one or more signing pubkeys; including
 * the oracle's pubkey makes it auditable on-chain that this memo
 * was "spoken" by the oracle authority, not just paid for by it.
 * (The fee-payer signature alone would be enough for tx validity,
 * but the §3.5.4 rotation procedure uses the Memo signer field as
 * the authority attestation.)
 */

/** SPL Memo v2 program id (mainnet + devnet, identical address). */
export const MEMO_PROGRAM_ID = new PublicKey(
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
);

export interface BuildMemoTxArgs {
  /** UTF-8 memo body (canonical JSON from buildCycleMemo / buildTwapMemo). */
  memo: string;
  /** Recent blockhash from getLatestBlockhash. */
  blockhash: string;
  /** Validator-enforced expiry slot for the blockhash (§3.7.4). */
  lastValidBlockHeight: number;
  /** The oracle's signing keypair (also serves as fee payer). */
  payer: Keypair;
  /** Priority fee per CU in micro-lamports (§3.4.4 Helius estimate, capped). */
  priorityFeeMicroLamports: number;
  /** CU limit; 500 per §3.4.4 buffer. */
  cuLimit?: number;
}

export interface SignedMemoTx {
  /** Base58 signature string — captured before send for the DB. */
  signature: string;
  /** The pre-signed serialized payload, ready for sendRawTransaction. */
  serialized: Buffer;
  /** Mirrors the input — exposed so the caller can persist alongside. */
  lastValidBlockHeight: number;
}

export function buildSignedMemoTx(args: BuildMemoTxArgs): SignedMemoTx {
  const memoBytes = Buffer.from(args.memo, "utf-8");

  const computePriceIx = ComputeBudgetProgram.setComputeUnitPrice({
    microLamports: args.priorityFeeMicroLamports,
  });
  const computeLimitIx = ComputeBudgetProgram.setComputeUnitLimit({
    units: args.cuLimit ?? 500,
  });

  const memoIx = new TransactionInstruction({
    programId: MEMO_PROGRAM_ID,
    keys: [
      // Signer account on the Memo instruction. Memo v2 reads the
      // signers as the "authors" of the memo; the payer is also a
      // signer (for the tx fee), so this attaches the same pubkey
      // in both roles.
      { pubkey: args.payer.publicKey, isSigner: true, isWritable: false },
    ],
    data: memoBytes,
  });

  const tx = new Transaction({
    feePayer: args.payer.publicKey,
    recentBlockhash: args.blockhash,
  })
    .add(computePriceIx)
    .add(computeLimitIx)
    .add(memoIx);

  tx.sign(args.payer);
  // After tx.sign the signature is populated on the Transaction
  // object; serialize() will fail later if it isn't, so capture it
  // up-front and assert non-null.
  const sigBuf = tx.signature;
  if (!sigBuf) {
    throw new Error(
      "memo-tx: tx.signature is null after signing — keypair / blockhash likely invalid",
    );
  }
  // Solana signatures are base58 by convention everywhere off-chain.
  const signature = base58Encode(sigBuf);
  const serialized = tx.serialize();

  return {
    signature,
    serialized,
    lastValidBlockHeight: args.lastValidBlockHeight,
  };
}

// ─── Helpers ───────────────────────────────────────────────────────────

/**
 * Lightweight base58 encoder for the signature output. We avoid
 * pulling in bs58 here just to keep the module's import surface
 * narrow — config.ts already depends on bs58, but memo-tx is meant
 * to be transactionally pure (no I/O, no extra deps).
 *
 * web3.js exposes `bs58` as part of @solana/web3.js's transitive
 * deps, but reaching for it through the package surface is brittle.
 * The implementation below is the standard Bitcoin alphabet variant
 * Solana uses.
 */
function base58Encode(bytes: Uint8Array | Buffer): string {
  const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  // Count leading zero bytes — they map to leading '1's in base58.
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;

  // Convert big-endian bytes -> base58 digits. Operate on a mutable
  // copy so we can do the long-division in place.
  const buf = Array.from(bytes);
  const out: number[] = [];
  let start = zeros;
  while (start < buf.length) {
    let remainder = 0;
    for (let i = start; i < buf.length; i++) {
      const acc = remainder * 256 + (buf[i]! & 0xff);
      buf[i] = Math.floor(acc / 58);
      remainder = acc % 58;
    }
    out.push(remainder);
    if (buf[start] === 0) start++;
  }

  let result = "";
  for (let i = 0; i < zeros; i++) result += ALPHABET[0];
  for (let i = out.length - 1; i >= 0; i--) result += ALPHABET[out[i]!];
  return result;
}
