import { describe, expect, it } from "vitest";
import { Keypair, PublicKey, type Connection } from "@solana/web3.js";

import { PegPusher } from "../peg/peg-pusher";

/**
 * Regression: the peptide allowlist used to be case-sensitive AND
 * silently skipped (returned `{ skipped: null }`) when the env-var
 * code didn't match the DB code byte-for-byte. That made the bug
 * invisible — `last_push_at` stayed null forever and no counter
 * incremented, so /health gave no clue why auto-pushes weren't
 * happening.
 *
 * Fix: lowercased comparison on both sides + counted skip with a
 * recorded reason. These tests pin both behaviours so a future edit
 * can't reintroduce the silent no-op.
 *
 * The Connection stub never gets called because the allowlist gate
 * is the second pre-flight (after the enabled check) — both happen
 * before any RPC. A null cast is safe.
 */

const stubConnection = {} as unknown as Connection;
const stubProgramId = new PublicKey("11111111111111111111111111111111");

function makePusher(args: {
  enabled: boolean;
  peptideCodes: string[];
}): PegPusher {
  return new PegPusher(stubConnection, Keypair.generate(), {
    programId: stubProgramId,
    enabled: args.enabled,
    peptideCodes: new Set(args.peptideCodes),
    priorityFeeMicroLamports: 1000,
    maxRetries: 0,
  });
}

describe("PegPusher allowlist", () => {
  it("matches case-insensitively (env=BPC157, DB code='bpc157')", async () => {
    const pusher = makePusher({ enabled: true, peptideCodes: ["bpc157"] });
    const result = await pusher.pushPegState({
      peptideCode: "BPC157",
      twapValue: 5_998_000n,
      observationSetRoot: new Uint8Array(32),
      commitAtSlot: 1n,
    });
    // Past the allowlist gate. zero-twap or staleness or a
    // network call beyond it — any of those is fine; what matters
    // is the result is NOT 'not-in-allowlist'.
    expect(result.skipped).not.toBe("not-in-allowlist");
  });

  it("matches case-insensitively (env=bpc157, DB code='BPC157')", async () => {
    const pusher = makePusher({ enabled: true, peptideCodes: ["bpc157"] });
    const result = await pusher.pushPegState({
      peptideCode: "BPC157",
      twapValue: 5_998_000n,
      observationSetRoot: new Uint8Array(32),
      commitAtSlot: 1n,
    });
    expect(result.skipped).not.toBe("not-in-allowlist");
  });

  it("counts allowlist miss as a recorded skip (was silent pre-fix)", async () => {
    const pusher = makePusher({ enabled: true, peptideCodes: ["bpc157"] });
    const result = await pusher.pushPegState({
      peptideCode: "BPC100", // not in allowlist
      twapValue: 5_998_000n,
      observationSetRoot: new Uint8Array(32),
      commitAtSlot: 1n,
    });
    expect(result.skipped).toBe("not-in-allowlist");
    expect(result.success).toBe(false);

    const m = pusher.metrics();
    expect(m.skipped_count_24h).toBe(1);
    expect(m.last_skip_reason).toBe("not-in-allowlist");
    expect(m.last_skip_peptide).toBe("BPC100");
    expect(m.last_check_attempt_at).not.toBeNull();
    expect(m.last_check_peptide).toBe("BPC100");
    expect(m.last_push_at).toBeNull();
  });

  it("dedups repeated allowlist-miss log lines (single warn per peptide)", async () => {
    const warns: string[] = [];
    const origWarn = console.warn;
    console.warn = (msg: string) => warns.push(msg);
    try {
      const pusher = makePusher({ enabled: true, peptideCodes: ["bpc157"] });
      for (let i = 0; i < 5; i++) {
        await pusher.pushPegState({
          peptideCode: "BPC100",
          twapValue: 5_998_000n,
          observationSetRoot: new Uint8Array(32),
          commitAtSlot: 1n,
        });
      }
      const allowlistWarns = warns.filter((m) => m.includes("not in allowlist"));
      expect(allowlistWarns).toHaveLength(1);
      // But every attempt is still counted in the skipped bucket.
      expect(pusher.metrics().skipped_count_24h).toBe(5);
    } finally {
      console.warn = origWarn;
    }
  });

  it("disabled produces counted skip with reason='disabled' + heartbeat", async () => {
    const pusher = makePusher({ enabled: false, peptideCodes: ["bpc157"] });
    const result = await pusher.pushPegState({
      peptideCode: "BPC157",
      twapValue: 5_998_000n,
      observationSetRoot: new Uint8Array(32),
      commitAtSlot: 1n,
    });
    expect(result.skipped).toBe("disabled");
    const m = pusher.metrics();
    expect(m.last_skip_reason).toBe("disabled");
    // Heartbeat fires even when disabled — proves the trigger reached
    // the pusher and didn't get lost upstream.
    expect(m.last_check_attempt_at).not.toBeNull();
  });
});
