import { describe, expect, it } from "vitest";

import { _internal } from "../routes/v1/verify";

const { decideMemoCheck, decideSlotCheck, decideSignerCheck, coerceSlot } =
  _internal;

/**
 * Three-way decision helpers for verifier checks 6/7/8 (memo / slot /
 * signer). Each helper has THREE possible outcomes:
 *
 *   - PASS:    attestation column populated and matches the live
 *              RPC fetch.
 *   - LEGACY:  attestation column null (cycle predates migration
 *              0037 or the post-finalization RPC fetch failed).
 *              Falls back to the original comparison and returns a
 *              specific failure_code so the operator can tell
 *              "needs backfill" from "real drift".
 *   - DRIFT:   attestation column populated but doesn't match the
 *              live fetch — real integrity violation.
 *
 * These tests pin every branch + every failure_code string so a
 * Lovable client can reliably switch on `failure_code` to render
 * different UI per case.
 */

describe("decideMemoCheck", () => {
  it("PASS when intent / attestation / live all match", () => {
    const r = decideMemoCheck({
      onChainMemo: '{"v":2}',
      intentMemo: '{"v":2}',
      attestedMemo: '{"v":2}',
    });
    expect(r.outcome).toBe("pass");
  });

  it("DRIFT (live vs attestation) — code ONCHAIN_DRIFT_FROM_ATTESTATION", () => {
    const r = decideMemoCheck({
      onChainMemo: '{"v":2,"reorg":true}',
      intentMemo: '{"v":2}',
      attestedMemo: '{"v":2}',
    });
    expect(r.outcome).toBe("fail");
    if (r.outcome === "fail") {
      expect(r.code).toBe("ONCHAIN_DRIFT_FROM_ATTESTATION");
    }
  });

  it("DRIFT (intent vs attestation) — code INTENT_DRIFT_FROM_ATTESTATION", () => {
    const r = decideMemoCheck({
      onChainMemo: '{"v":2}',
      intentMemo: '{"v":2,"mutated":true}',
      attestedMemo: '{"v":2}',
    });
    expect(r.outcome).toBe("fail");
    if (r.outcome === "fail") {
      expect(r.code).toBe("INTENT_DRIFT_FROM_ATTESTATION");
    }
  });

  it("LEGACY: attestation null + intent matches live — passes (legacy compare)", () => {
    const r = decideMemoCheck({
      onChainMemo: '{"v":1}',
      intentMemo: '{"v":1}',
      attestedMemo: null,
    });
    expect(r.outcome).toBe("pass");
  });

  it("LEGACY: attestation null + intent disagrees — code LEGACY_MEMO_NOT_BACKFILLED", () => {
    const r = decideMemoCheck({
      onChainMemo: '{"v":2,"actual":true}',
      intentMemo: '{"v":1,"old_format":true}',
      attestedMemo: null,
    });
    expect(r.outcome).toBe("fail");
    if (r.outcome === "fail") {
      expect(r.code).toBe("LEGACY_MEMO_NOT_BACKFILLED");
      expect(r.detail).toContain("scripts/backfill-cycle-onchain.ts");
    }
  });

  it("ONCHAIN_MEMO_MISSING when live RPC returned no Memo instruction", () => {
    const r = decideMemoCheck({
      onChainMemo: null,
      intentMemo: '{"v":2}',
      attestedMemo: '{"v":2}',
    });
    expect(r.outcome).toBe("fail");
    if (r.outcome === "fail") {
      expect(r.code).toBe("ONCHAIN_MEMO_MISSING");
    }
  });
});

describe("decideSlotCheck", () => {
  it("PASS when confirmed_slot matches on-chain", () => {
    const r = decideSlotCheck({
      onChainSlot: 12345,
      legacySlot: 12343, // estimate from finalization tick is allowed to drift
      attestedSlot: 12345,
    });
    expect(r.outcome).toBe("pass");
  });

  it("DRIFT when confirmed_slot disagrees with live — code SLOT_DRIFT_FROM_ATTESTATION", () => {
    const r = decideSlotCheck({
      onChainSlot: 12345,
      legacySlot: null,
      attestedSlot: 99999,
    });
    expect(r.outcome).toBe("fail");
    if (r.outcome === "fail") {
      expect(r.code).toBe("SLOT_DRIFT_FROM_ATTESTATION");
    }
  });

  it("LEGACY: both confirmed and legacy null — code LEGACY_SLOT_NOT_BACKFILLED", () => {
    const r = decideSlotCheck({
      onChainSlot: 12345,
      legacySlot: null,
      attestedSlot: null,
    });
    expect(r.outcome).toBe("fail");
    if (r.outcome === "fail") {
      expect(r.code).toBe("LEGACY_SLOT_NOT_BACKFILLED");
    }
  });

  it("LEGACY: solana_slot present but disagrees — code LEGACY_SLOT_NOT_BACKFILLED", () => {
    // The user-reported failure mode: solana_slot recorded at the
    // finalization tick is an estimate; getTransaction reports a
    // different (canonical) slot. Pre-fix this surfaced as
    // generic SIGNER_MISMATCH; now it surfaces specifically.
    const r = decideSlotCheck({
      onChainSlot: 12345,
      legacySlot: 12340,
      attestedSlot: null,
    });
    expect(r.outcome).toBe("fail");
    if (r.outcome === "fail") {
      expect(r.code).toBe("LEGACY_SLOT_NOT_BACKFILLED");
      expect(r.detail).toContain("backfill");
    }
  });

  it("LEGACY: solana_slot matches on-chain — passes (legacy compare)", () => {
    // For lucky cycles where the finalization-tick estimate happened
    // to match the canonical slot, the legacy path still passes.
    const r = decideSlotCheck({
      onChainSlot: 12345,
      legacySlot: 12345,
      attestedSlot: null,
    });
    expect(r.outcome).toBe("pass");
  });
});

describe("decideSignerCheck", () => {
  const CURRENT = "FmBggsBjzGsHrtMayYG8ix2JzoYhVczrwJaGGKPpNKK7";
  const OLD = "OldDevnetAuthority1111111111111111111111111";

  it("PASS when attested authority is in on-chain signers", () => {
    const r = decideSignerCheck({
      onChainSigners: [CURRENT],
      attestedAuthority: CURRENT,
      currentAuthority: CURRENT,
      cycleCluster: "mainnet-beta",
      apiCluster: "mainnet-beta",
    });
    expect(r.outcome).toBe("pass");
  });

  it("PASS when attested authority differs from current (rotation case)", () => {
    // After a future rotation, OLD signed historical cycles. The
    // verifier reads OLD from the attestation column and confirms
    // the on-chain signer is OLD — even though config.authorityPubkey
    // is now CURRENT. This is the whole point of per-cycle attestation.
    const r = decideSignerCheck({
      onChainSigners: [OLD],
      attestedAuthority: OLD,
      currentAuthority: CURRENT,
      cycleCluster: "mainnet-beta",
      apiCluster: "mainnet-beta",
    });
    expect(r.outcome).toBe("pass");
  });

  it("DRIFT: attested authority not in signers — code SIGNER_DRIFT_FROM_ATTESTATION", () => {
    const r = decideSignerCheck({
      onChainSigners: ["SomeoneElse111111111111111111111111111111"],
      attestedAuthority: CURRENT,
      currentAuthority: CURRENT,
      cycleCluster: "mainnet-beta",
      apiCluster: "mainnet-beta",
    });
    expect(r.outcome).toBe("fail");
    if (r.outcome === "fail") {
      expect(r.code).toBe("SIGNER_DRIFT_FROM_ATTESTATION");
    }
  });

  it("DEVNET_LEGACY_AUTHORITY: cycle on different cluster than the API", () => {
    // Cycle was committed to devnet pre-cutover. Verifier API runs
    // on mainnet. Pre-fix this surfaced as a generic mismatch; now
    // it returns DEVNET_LEGACY_AUTHORITY so the client can render
    // "this cycle is from a previous cluster" cleanly.
    const r = decideSignerCheck({
      onChainSigners: [OLD],
      attestedAuthority: null, // not yet backfilled
      currentAuthority: CURRENT,
      cycleCluster: "devnet",
      apiCluster: "mainnet-beta",
    });
    expect(r.outcome).toBe("fail");
    if (r.outcome === "fail") {
      expect(r.code).toBe("DEVNET_LEGACY_AUTHORITY");
      expect(r.detail).toContain("devnet");
      expect(r.detail).toContain("mainnet-beta");
    }
  });

  it("LEGACY: same cluster, no attestation, current matches — passes", () => {
    const r = decideSignerCheck({
      onChainSigners: [CURRENT],
      attestedAuthority: null,
      currentAuthority: CURRENT,
      cycleCluster: "mainnet-beta",
      apiCluster: "mainnet-beta",
    });
    expect(r.outcome).toBe("pass");
  });

  it("LEGACY: same cluster, no attestation, current does NOT match — code LEGACY_AUTHORITY_NOT_BACKFILLED", () => {
    // Same cluster, but the on-chain signer is from a previous key
    // (e.g. pre-rotation). Pre-fix this was a generic
    // signer_matches_authority failure; now it specifically tells
    // the operator to run the backfill so per-cycle authority can
    // be captured.
    const r = decideSignerCheck({
      onChainSigners: [OLD],
      attestedAuthority: null,
      currentAuthority: CURRENT,
      cycleCluster: "mainnet-beta",
      apiCluster: "mainnet-beta",
    });
    expect(r.outcome).toBe("fail");
    if (r.outcome === "fail") {
      expect(r.code).toBe("LEGACY_AUTHORITY_NOT_BACKFILLED");
      expect(r.detail).toContain("backfill");
    }
  });

  it("PASS when on-chain has multiple signers and authority is one of them", () => {
    const r = decideSignerCheck({
      onChainSigners: [CURRENT, "FeePayer11111111111111111111111111111111111"],
      attestedAuthority: CURRENT,
      currentAuthority: CURRENT,
      cycleCluster: "mainnet-beta",
      apiCluster: "mainnet-beta",
    });
    expect(r.outcome).toBe("pass");
  });
});

describe("coerceSlot — PostgREST returns slot as string OR number", () => {
  it("number passes through", () => {
    expect(coerceSlot(12345)).toBe(12345);
  });
  it("string parses to number", () => {
    expect(coerceSlot("12345")).toBe(12345);
  });
  it("null and undefined → null", () => {
    expect(coerceSlot(null)).toBeNull();
    expect(coerceSlot(undefined)).toBeNull();
  });
  it("non-numeric string → null", () => {
    expect(coerceSlot("not-a-number")).toBeNull();
  });
});
