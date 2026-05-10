import { describe, expect, it } from "vitest";
import { generateKeyPairSync, sign } from "node:crypto";
import bs58 from "bs58";

import {
  extractMessageTimestamp,
  SIGNATURE_TTL_MS,
  verifyWalletSignature,
} from "../lib/wallet-auth";

/**
 * End-to-end test of the wallet-signature auth path. Generates a
 * real ed25519 key pair via Node native crypto, signs a canonical
 * message, base58-encodes the signature, and feeds it through
 * verifyWalletSignature. Covers the happy path + every failure
 * branch that gates /api/leads/* requests.
 */

function makeKeyPair(): {
  rawPubKey: Uint8Array;
  base58PubKey: string;
  sign: (message: string) => string;
} {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  // Extract the raw 32-byte pubkey from the SPKI DER (last 32 bytes).
  const der = publicKey.export({ format: "der", type: "spki" });
  const raw = der.subarray(der.length - 32);
  return {
    rawPubKey: raw,
    base58PubKey: bs58.encode(raw),
    sign: (message: string) => {
      const sig = sign(null, Buffer.from(message, "utf-8"), privateKey);
      return bs58.encode(sig);
    },
  };
}

function canonicalMessage(at: Date = new Date()): string {
  return `I am submitting a lead to BioHash at ${at.toISOString()}`;
}

describe("extractMessageTimestamp", () => {
  it("parses the canonical format", () => {
    const ts = extractMessageTimestamp(
      "I am submitting a lead to BioHash at 2026-05-09T12:00:00.000Z",
    );
    expect(ts?.toISOString()).toBe("2026-05-09T12:00:00.000Z");
  });

  it("returns null on a malformed prefix", () => {
    expect(
      extractMessageTimestamp("submitting a lead at 2026-05-09T12:00:00Z"),
    ).toBeNull();
  });

  it("returns null on an unparseable timestamp", () => {
    expect(
      extractMessageTimestamp("I am submitting a lead to BioHash at not-a-date"),
    ).toBeNull();
  });

  it("tolerates surrounding whitespace", () => {
    const ts = extractMessageTimestamp(
      "  I am submitting a lead to BioHash at 2026-05-09T12:00:00Z  ",
    );
    expect(ts).not.toBeNull();
  });
});

describe("verifyWalletSignature", () => {
  it("accepts a valid signature on a fresh canonical message", () => {
    const kp = makeKeyPair();
    const msg = canonicalMessage();
    const result = verifyWalletSignature({
      wallet_address: kp.base58PubKey,
      signed_message: msg,
      wallet_signature: kp.sign(msg),
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.walletAddress).toBe(kp.base58PubKey);
  });

  it("rejects a tampered message body (signature won't match)", () => {
    const kp = makeKeyPair();
    const original = canonicalMessage();
    const sig = kp.sign(original);
    const result = verifyWalletSignature({
      wallet_address: kp.base58PubKey,
      // Same timestamp but different prefix — sig was over `original`
      // string; verifying over a different string fails.
      signed_message: original.replace("submitting", "verifying"),
      wallet_signature: sig,
    });
    // Will fail at INVALID_MESSAGE_FORMAT (prefix doesn't match)
    // before reaching the crypto check; both are correct denials.
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(["INVALID_MESSAGE_FORMAT", "SIGNATURE_MISMATCH"]).toContain(
        result.code,
      );
    }
  });

  it("rejects a signature signed by a DIFFERENT key", () => {
    const real = makeKeyPair();
    const attacker = makeKeyPair();
    const msg = canonicalMessage();
    const result = verifyWalletSignature({
      wallet_address: real.base58PubKey, // claim to be `real`
      signed_message: msg,
      wallet_signature: attacker.sign(msg), // but signed by attacker
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("SIGNATURE_MISMATCH");
  });

  it("rejects an expired timestamp (>5min old)", () => {
    const kp = makeKeyPair();
    const past = new Date(Date.now() - SIGNATURE_TTL_MS - 60_000);
    const msg = canonicalMessage(past);
    const result = verifyWalletSignature({
      wallet_address: kp.base58PubKey,
      signed_message: msg,
      wallet_signature: kp.sign(msg),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("SIGNATURE_EXPIRED");
  });

  it("rejects a future-dated timestamp (>5min ahead, clock drift attack)", () => {
    const kp = makeKeyPair();
    const future = new Date(Date.now() + SIGNATURE_TTL_MS + 60_000);
    const msg = canonicalMessage(future);
    const result = verifyWalletSignature({
      wallet_address: kp.base58PubKey,
      signed_message: msg,
      wallet_signature: kp.sign(msg),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("SIGNATURE_EXPIRED");
  });

  it("rejects malformed wallet_address (bad base58)", () => {
    const result = verifyWalletSignature({
      wallet_address: "not-base58-!@#",
      signed_message: canonicalMessage(),
      wallet_signature: "x",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("INVALID_WALLET_ADDRESS");
  });

  it("rejects wrong-length pubkey (16 bytes instead of 32)", () => {
    const tooShort = bs58.encode(new Uint8Array(16));
    const result = verifyWalletSignature({
      wallet_address: tooShort,
      signed_message: canonicalMessage(),
      wallet_signature: bs58.encode(new Uint8Array(64)),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("INVALID_WALLET_ADDRESS");
  });

  it("rejects wrong-length signature", () => {
    const kp = makeKeyPair();
    const tooShort = bs58.encode(new Uint8Array(32));
    const result = verifyWalletSignature({
      wallet_address: kp.base58PubKey,
      signed_message: canonicalMessage(),
      wallet_signature: tooShort,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("INVALID_SIGNATURE");
  });
});
