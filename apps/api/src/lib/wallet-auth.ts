import { createPublicKey, verify } from "node:crypto";
import bs58 from "bs58";

/**
 * Solana wallet-signature authentication for the /api/leads/* surface.
 *
 * Flow:
 *   1. Client constructs a canonical message:
 *        "I am submitting a lead to BioHash at <iso8601-timestamp>"
 *   2. Client signs the message bytes with their wallet's ed25519 secret
 *      key, base58-encodes the 64-byte signature.
 *   3. Server receives { wallet_address, signed_message, wallet_signature }.
 *   4. verifyWalletSignature() validates:
 *        a) wallet_address parses as a 32-byte ed25519 public key.
 *        b) signed_message ends with a parseable ISO timestamp within
 *           SIGNATURE_TTL_MS of now (replay protection).
 *        c) ed25519 signature over signed_message bytes matches the
 *           public key.
 *
 * Why we don't include the endpoint name in the message: spec asked for
 * the generic format. A v2 hardening would scope each signature to a
 * specific action (e.g. "BioHash:submit:<timestamp>") so a /submit
 * signature can't be replayed against /my-leads in the brief TTL window.
 * Tracked as a known limitation; not an MVP blocker.
 *
 * Why we use Node's native crypto over tweetnacl:
 *   - Node 18+ supports ed25519 via createPublicKey + verify.
 *   - Avoids adding tweetnacl as an explicit dep (it's transitive
 *     via @solana/web3.js but the module-resolver doesn't always
 *     surface it cleanly).
 *   - createPublicKey requires DER-encoded SPKI input; Solana
 *     pubkeys are raw 32 bytes. We prepend the fixed 12-byte SPKI
 *     header for ed25519 to bridge the formats.
 */

export const SIGNATURE_TTL_MS = 5 * 60 * 1000;

/**
 * SPKI DER prefix for ed25519 keys. Followed by the raw 32-byte
 * public key gives a valid SubjectPublicKeyInfo Node can import.
 *
 *   30 2a   SEQUENCE, length 42
 *   30 05   SEQUENCE, length 5  (AlgorithmIdentifier)
 *   06 03   OID, length 3
 *   2b 65 70   ed25519 OID (1.3.101.112)
 *   03 21   BIT STRING, length 33
 *   00      0 unused bits prefix
 */
const ED25519_SPKI_PREFIX = Buffer.from(
  "302a300506032b6570032100",
  "hex",
);

export interface WalletAuthInput {
  wallet_address: string;
  signed_message: string;
  wallet_signature: string;
}

export type WalletAuthResult =
  | { ok: true; walletAddress: string }
  | { ok: false; code: string; message: string };

/**
 * Returns the timestamp encoded in a canonical signed message, or
 * null if the message is malformed. The format is fixed per the
 * spec: "I am submitting a lead to BioHash at <ISO8601>". Loose
 * trailing whitespace is tolerated.
 */
export function extractMessageTimestamp(message: string): Date | null {
  const m = message
    .trim()
    .match(/^I am submitting a lead to BioHash at (.+)$/);
  if (!m) return null;
  const iso = m[1]!.trim();
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  return new Date(ms);
}

/**
 * Verify a wallet signature. Pure (no DB, no network). Returns a
 * tagged-union result so the caller can branch on a specific
 * failure code without parsing message strings.
 */
export function verifyWalletSignature(
  input: WalletAuthInput,
  now: Date = new Date(),
): WalletAuthResult {
  // 1. Parse public key.
  let pubKeyBytes: Uint8Array;
  try {
    pubKeyBytes = bs58.decode(input.wallet_address);
  } catch {
    return {
      ok: false,
      code: "INVALID_WALLET_ADDRESS",
      message: "wallet_address is not valid base58",
    };
  }
  if (pubKeyBytes.length !== 32) {
    return {
      ok: false,
      code: "INVALID_WALLET_ADDRESS",
      message: `wallet_address must decode to 32 bytes (got ${pubKeyBytes.length})`,
    };
  }

  // 2. Validate message timestamp (replay protection).
  const ts = extractMessageTimestamp(input.signed_message);
  if (!ts) {
    return {
      ok: false,
      code: "INVALID_MESSAGE_FORMAT",
      message:
        'signed_message must be: "I am submitting a lead to BioHash at <ISO8601-timestamp>"',
    };
  }
  const ageMs = Math.abs(now.getTime() - ts.getTime());
  if (ageMs > SIGNATURE_TTL_MS) {
    return {
      ok: false,
      code: "SIGNATURE_EXPIRED",
      message: `signed_message timestamp is ${Math.round(ageMs / 1000)}s out of window (max ${SIGNATURE_TTL_MS / 1000}s)`,
    };
  }

  // 3. Parse signature.
  let sigBytes: Uint8Array;
  try {
    sigBytes = bs58.decode(input.wallet_signature);
  } catch {
    return {
      ok: false,
      code: "INVALID_SIGNATURE",
      message: "wallet_signature is not valid base58",
    };
  }
  if (sigBytes.length !== 64) {
    return {
      ok: false,
      code: "INVALID_SIGNATURE",
      message: `wallet_signature must decode to 64 bytes (got ${sigBytes.length})`,
    };
  }

  // 4. ed25519 verify via Node native.
  let pubKey;
  try {
    pubKey = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(pubKeyBytes)]),
      format: "der",
      type: "spki",
    });
  } catch (err) {
    // Defensive — should never trigger after the length check above.
    return {
      ok: false,
      code: "INVALID_WALLET_ADDRESS",
      message: `pubkey import failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const messageBytes = Buffer.from(input.signed_message, "utf-8");
  const verified = verify(null, messageBytes, pubKey, Buffer.from(sigBytes));
  if (!verified) {
    return {
      ok: false,
      code: "SIGNATURE_MISMATCH",
      message: "ed25519 signature does not match wallet_address over signed_message",
    };
  }
  return { ok: true, walletAddress: input.wallet_address };
}
