import { Keypair } from "@solana/web3.js";

/**
 * Construct the oracle's signing Keypair from the raw 64-byte secret
 * decoded by config.ts.
 *
 * The secret is the standard solana-keygen layout:
 *   bytes[0..32]   = ed25519 seed (private key)
 *   bytes[32..64]  = ed25519 public key
 *
 * Keypair.fromSecretKey accepts the full 64-byte array — it derives
 * the public key from the seed and asserts it matches the trailing
 * 32 bytes (catches a corrupted secret).
 *
 * Kept as a one-liner module so the keypair-construction call site
 * is searchable and future hardware-wallet / KMS integrations have
 * a single place to swap in.
 */
export function loadOracleKeypair(secretBytes: Uint8Array): Keypair {
  if (secretBytes.length !== 64) {
    throw new Error(
      `solana/keypair: expected 64-byte secret, got ${secretBytes.length}`,
    );
  }
  return Keypair.fromSecretKey(secretBytes);
}
