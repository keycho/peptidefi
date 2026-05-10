import type { Request, Response } from "express";
import {
  bytesToHex0x,
  buildMerkleTree,
  generateProof,
  leafHash,
  verifyProof,
} from "@peptide-oracle/shared";
import { adminClientUntyped } from "../../supabase";
import {
  loadOracleApiConfig,
  solscanUrl,
  solanaExplorerUrl,
} from "../../oracle-config";
import { fetchOnChainMemo, getConnection } from "../../solana";
import { rowToObservationLike } from "../../observation-shape";
import { sendError } from "../../errors";

/**
 * GET /v1/verify/observation/:id — server-side end-to-end verifier.
 *
 * Per §05.5.1, runs every check a client-side verifier would, plus
 * the on-chain Memo byte-compare. The eight checks (in order; first
 * failure terminates):
 *
 *   1. observation_exists       — observation_id is in supplier_observations
 *   2. cycle_anchored           — observation has a row in commit_observations
 *   3. cycle_finalized          — that cycle's commit_cycles.status = 'finalized'
 *   4. leaf_hash_matches_db     — recomputing the canonical leaf from
 *                                 the observation row hashes to the
 *                                 leaf_hash stored in commit_observations
 *   5. merkle_proof_reconstructs — generated proof + leaf_hash hash up
 *                                  to commit_cycles.merkle_root
 *   6. memo_matches_onchain     — getTransaction(signature) returns a
 *                                  Memo whose UTF-8 bytes equal
 *                                  commit_cycles.memo_payload byte-for-byte
 *   7. slot_matches_onchain     — the on-chain tx's slot equals
 *                                  commit_cycles.solana_slot
 *   8. signer_matches_authority — the on-chain tx's signers include
 *                                  the authority pubkey from /authority
 *
 * Returns the Solscan + Explorer URLs alongside the verification
 * result so the operator can drill into the explorer if any check
 * fails.
 *
 * The "pending_commit" case (observation exists but isn't anchored
 * yet, or the cycle is in-flight) returns `verified: false` with
 * `status: "pending_commit"` and a `retry_after_seconds` hint, per
 * §05.5.1's three-way response shape.
 */

interface CheckResult {
  name: string;
  passed: boolean;
  detail?: string;
}

function check(name: string, passed: boolean, detail?: string): CheckResult {
  return detail !== undefined ? { name, passed, detail } : { name, passed };
}

export async function verifyObservationHandler(
  req: Request,
  res: Response,
): Promise<void> {
  const idParam = req.params.id;
  if (!idParam || !/^\d+$/.test(idParam)) {
    sendError(res, 400, "BAD_REQUEST", "observation_id must be a positive integer");
    return;
  }
  const observationId = Number(idParam);
  const supabase = adminClientUntyped();
  const config = loadOracleApiConfig();
  const checks: CheckResult[] = [];

  // ─── Check 1: observation_exists ────────────────────────────────
  const { data: obsRow, error: oErr } = await supabase
    .from("supplier_observations")
    .select(
      "id, supplier_id, peptide_id, supplier_product_id, scraper_run_id, observed_at, raw_price, raw_currency, fx_rate_to_usd, price_usd_per_mg, raw_availability, availability_tier, lead_time_days, scrape_success, scrape_error, http_status, raw_html_hash",
    )
    .eq("id", observationId)
    .maybeSingle();
  if (oErr) {
    sendError(res, 500, "DB_ERROR", `obs lookup: ${oErr.message}`);
    return;
  }
  checks.push(check("observation_exists", !!obsRow));
  if (!obsRow) {
    res.status(404).json({
      verified: false,
      observation_id: observationId,
      failure_reason: "observation_exists",
      failure_detail: `observation_id ${observationId} not found in supplier_observations`,
      checks,
    });
    return;
  }

  // ─── Check 2: cycle_anchored ────────────────────────────────────
  const { data: junction, error: jErr } = await supabase
    .from("commit_observations")
    .select("cycle_id, leaf_hash, leaf_index")
    .eq("observation_id", observationId)
    .maybeSingle();
  if (jErr) {
    sendError(res, 500, "DB_ERROR", `junction lookup: ${jErr.message}`);
    return;
  }
  if (!junction) {
    // Special case: observation exists but isn't anchored yet. The
    // §05.5.1 response shape distinguishes "real failure" from "not
    // yet verifiable" via the status field.
    res.json({
      verified: false,
      observation_id: observationId,
      status: "pending_commit",
      detail:
        "Observation is not yet anchored. The cycle that owns this observation either hasn't been committed to Solana yet, or the cycle never qualified for commit.",
      retry_after_seconds: 30,
      checks: [...checks, check("cycle_anchored", false)],
    });
    return;
  }
  checks.push(check("cycle_anchored", true));

  // ─── Check 3: cycle_finalized ───────────────────────────────────
  // Pull the migration-0037 attestation columns alongside the legacy
  // ones. New cycles have all three populated at finalization;
  // legacy cycles (pre-0037, or finalization-time RPC failures) have
  // them null and the verifier falls back to the legacy comparison
  // path with a specific failure code.
  // `cluster` is needed to detect devnet-era cycles for the legacy
  // authority failure code.
  const { data: cycle, error: cErr } = await supabase
    .from("commit_cycles")
    .select(
      "cycle_id, merkle_root, observation_count, memo_payload, status, solana_signature, solana_slot, cluster, onchain_memo_bytes, authority_pubkey, confirmed_slot",
    )
    .eq("cycle_id", junction.cycle_id)
    .maybeSingle();
  if (cErr) {
    sendError(res, 500, "DB_ERROR", `cycle lookup: ${cErr.message}`);
    return;
  }
  if (!cycle) {
    // Unusual: junction row points at a non-existent cycle. Treat
    // as a hard failure.
    res.status(500).json({
      verified: false,
      observation_id: observationId,
      cycle_id: junction.cycle_id,
      failure_reason: "cycle_finalized",
      failure_detail: `commit_observations references cycle_id ${junction.cycle_id} but no commit_cycles row exists. Junction integrity violated.`,
      checks: [...checks, check("cycle_finalized", false)],
    });
    return;
  }
  if (cycle.status !== "finalized") {
    res.json({
      verified: false,
      observation_id: observationId,
      cycle_id: junction.cycle_id,
      status: "pending_commit",
      detail: `Cycle ${junction.cycle_id} is in status '${cycle.status}'; verifiable once finalized.`,
      retry_after_seconds: cycle.status === "submitted" ? 30 : 60,
      checks: [...checks, check("cycle_finalized", false, `status='${cycle.status}'`)],
    });
    return;
  }
  checks.push(check("cycle_finalized", true));

  // ─── Check 4: leaf_hash_matches_db ──────────────────────────────
  let recomputedLeafHash: string;
  try {
    const obs = rowToObservationLike(obsRow);
    recomputedLeafHash = bytesToHex0x(leafHash(obs));
  } catch (err) {
    res.status(500).json({
      verified: false,
      observation_id: observationId,
      cycle_id: junction.cycle_id,
      failure_reason: "leaf_hash_matches_db",
      failure_detail: `canonical-form adapter failed: ${(err as Error).message}`,
      checks: [...checks, check("leaf_hash_matches_db", false)],
    });
    return;
  }
  if (recomputedLeafHash !== junction.leaf_hash) {
    res.json({
      verified: false,
      observation_id: observationId,
      cycle_id: junction.cycle_id,
      failure_reason: "leaf_hash_matches_db",
      failure_detail: `recomputed canonical leaf hash is ${recomputedLeafHash} but commit_observations.leaf_hash is ${junction.leaf_hash}; observation row may have been mutated post-commit`,
      checks: [
        ...checks,
        check(
          "leaf_hash_matches_db",
          false,
          `recomputed=${recomputedLeafHash} db=${junction.leaf_hash}`,
        ),
      ],
    });
    return;
  }
  checks.push(check("leaf_hash_matches_db", true));

  // ─── Check 5: merkle_proof_reconstructs ─────────────────────────
  // Rebuild the tree from all of the cycle's observations, generate
  // the proof for our leaf, replay it.
  const { data: cycleObs, error: lErr } = await supabase
    .from("supplier_observations")
    .select(
      "id, supplier_id, peptide_id, supplier_product_id, scraper_run_id, observed_at, raw_price, raw_currency, fx_rate_to_usd, price_usd_per_mg, raw_availability, availability_tier, lead_time_days, scrape_success, scrape_error, http_status, raw_html_hash",
    )
    .eq("scraper_run_id", junction.cycle_id)
    .order("id", { ascending: true });
  if (lErr || !cycleObs) {
    sendError(res, 500, "DB_ERROR", `cycle obs fetch: ${lErr?.message}`);
    return;
  }
  const observations = cycleObs.map(rowToObservationLike);
  const tree = buildMerkleTree(observations);
  const proof = generateProof(tree, junction.leaf_index);
  const verify = verifyProof({
    leafHash: junction.leaf_hash,
    proof,
    expectedRoot: cycle.merkle_root,
  });
  if (!verify.verified) {
    res.json({
      verified: false,
      observation_id: observationId,
      cycle_id: junction.cycle_id,
      failure_reason: "merkle_proof_reconstructs",
      failure_detail: `proof did not reconstruct to merkle_root. db=${cycle.merkle_root} computed=${verify.computedRoot}`,
      checks: [...checks, check("merkle_proof_reconstructs", false)],
      proof,
    });
    return;
  }
  checks.push(check("merkle_proof_reconstructs", true));

  // ─── Checks 6/7/8: on-chain memo + slot + signer ────────────────
  const conn = getConnection(config.rpcUrl);
  let onChain;
  try {
    onChain = cycle.solana_signature
      ? await fetchOnChainMemo(conn, cycle.solana_signature)
      : null;
  } catch (err) {
    res.status(502).json({
      verified: false,
      observation_id: observationId,
      cycle_id: junction.cycle_id,
      failure_reason: "memo_matches_onchain",
      failure_detail: `RPC error fetching on-chain tx: ${(err as Error).message}`,
      checks: [...checks, check("memo_matches_onchain", false)],
    });
    return;
  }
  if (!onChain) {
    res.json({
      verified: false,
      observation_id: observationId,
      cycle_id: junction.cycle_id,
      failure_reason: "memo_matches_onchain",
      failure_detail: cycle.solana_signature
        ? `on-chain tx ${cycle.solana_signature} not found at finalized commitment, or has no Memo instruction`
        : "commit_cycles.solana_signature is null despite status='finalized' (DB integrity issue)",
      checks: [...checks, check("memo_matches_onchain", false)],
    });
    return;
  }

  // ─── Checks 6/7/8: attestation comparison ───────────────────────
  //
  // Each check now has THREE possible states:
  //   - PASS:    attestation column populated (migration 0037) and
  //              matches the live RPC fetch.
  //   - LEGACY:  attestation column null (cycle predates 0037 or
  //              the post-finalization RPC fetch failed). Fall back
  //              to the original comparison against memo_payload /
  //              solana_slot / current authorityPubkey, but report
  //              a specific failure code so the operator can tell
  //              "this needs backfill" from "the chain disagrees".
  //   - FAIL:    attestation column populated but doesn't match the
  //              live fetch — real integrity violation.
  //
  // Helpers below encapsulate the three-way decision per check.

  const memoCheck = decideMemoCheck({
    onChainMemo: onChain.memo,
    intentMemo: cycle.memo_payload,
    attestedMemo: cycle.onchain_memo_bytes ?? null,
  });
  const slotCheck = decideSlotCheck({
    onChainSlot: onChain.slot,
    legacySlot: coerceSlot(cycle.solana_slot),
    attestedSlot: coerceSlot(cycle.confirmed_slot),
  });
  const signerCheck = decideSignerCheck({
    onChainSigners: onChain.signers,
    attestedAuthority: cycle.authority_pubkey ?? null,
    currentAuthority: config.authorityPubkey,
    cycleCluster: cycle.cluster ?? null,
    apiCluster: config.cluster,
  });

  if (memoCheck.outcome !== "pass") {
    res.json({
      verified: false,
      observation_id: observationId,
      cycle_id: junction.cycle_id,
      failure_reason: "memo_matches_onchain",
      failure_code: memoCheck.code,
      failure_detail: memoCheck.detail,
      checks: [
        ...checks,
        check("memo_matches_onchain", false, memoCheck.code),
        { name: "slot_matches_onchain", passed: slotCheck.outcome === "pass" },
        { name: "signer_matches_authority", passed: signerCheck.outcome === "pass" },
      ],
      on_chain: {
        signature: cycle.solana_signature,
        slot: onChain.slot,
        cluster: config.cluster,
        memo: onChain.memo,
      },
    });
    return;
  }
  checks.push(check("memo_matches_onchain", true));

  if (slotCheck.outcome !== "pass") {
    res.json({
      verified: false,
      observation_id: observationId,
      cycle_id: junction.cycle_id,
      failure_reason: "slot_matches_onchain",
      failure_code: slotCheck.code,
      failure_detail: slotCheck.detail,
      checks: [
        ...checks,
        check("slot_matches_onchain", false, slotCheck.code),
        { name: "signer_matches_authority", passed: signerCheck.outcome === "pass" },
      ],
    });
    return;
  }
  checks.push(check("slot_matches_onchain", true));

  if (signerCheck.outcome !== "pass") {
    res.json({
      verified: false,
      observation_id: observationId,
      cycle_id: junction.cycle_id,
      failure_reason: "signer_matches_authority",
      failure_code: signerCheck.code,
      failure_detail: signerCheck.detail,
      checks: [
        ...checks,
        check("signer_matches_authority", false, signerCheck.code),
      ],
    });
    return;
  }
  checks.push(check("signer_matches_authority", true));

  // ─── All checks passed ──────────────────────────────────────────
  res.json({
    verified: true,
    // Commitment level the on-chain fetch hit. 'finalized' is the
    // default; 'confirmed' is the fallback fetchOnChainMemo() uses
    // when finalized returns null (older cycles fall outside some
    // RPCs' finalized-tx cache window). A client can render
    // "verified at confirmed commitment" in the latter case — the
    // tx is still cryptographically valid, just retrieved at a
    // weaker commitment level.
    verified_at_commitment: onChain.commitmentUsed,
    observation_id: observationId,
    cycle_id: junction.cycle_id,
    leaf_index: junction.leaf_index,
    leaf_hash: junction.leaf_hash,
    merkle_root: cycle.merkle_root,
    proof,
    on_chain: {
      signature: cycle.solana_signature,
      slot: onChain.slot,
      cluster: config.cluster,
      memo: onChain.memo,
      block_time: onChain.blockTime,
      commitment_used: onChain.commitmentUsed,
      solscan_url: solscanUrl(cycle.solana_signature!, config.cluster),
      explorer_url: solanaExplorerUrl(cycle.solana_signature!, config.cluster),
    },
    checks,
  });
}

// ─── Three-way attestation decision helpers ───────────────────────
//
// Pure, testable, exported via _internal so the regression tests
// can pin every (PASS / LEGACY / FAIL) branch.
//
// Failure codes are meant to be machine-readable: a Lovable client
// can branch on `failure_code` to render different UI for "we need
// to run the backfill" vs "the chain genuinely disagrees with our DB".

type CheckOutcome =
  | { outcome: "pass" }
  | { outcome: "fail"; code: string; detail: string };

/**
 * memo: prefer the captured attestation column (cycle.onchain_memo_bytes,
 * stored at finalization in migration 0037). If present, all three —
 * intent (memo_payload), attestation (onchain_memo_bytes), and the
 * live RPC fetch (onChainMemo) — must match. If the attestation is
 * null, fall back to the legacy intent-vs-RPC compare and return
 * LEGACY_MEMO_NOT_BACKFILLED on mismatch.
 */
function decideMemoCheck(args: {
  onChainMemo: string | null;
  intentMemo: string | null;
  attestedMemo: string | null;
}): CheckOutcome {
  if (args.onChainMemo === null) {
    return {
      outcome: "fail",
      code: "ONCHAIN_MEMO_MISSING",
      detail: "live RPC fetch returned no memo (tx may lack a Memo instruction)",
    };
  }
  if (args.attestedMemo !== null) {
    // Strong path: attestation captured at finalization. Both
    // intent and live fetch must match the attestation.
    if (args.attestedMemo !== args.onChainMemo) {
      return {
        outcome: "fail",
        code: "ONCHAIN_DRIFT_FROM_ATTESTATION",
        detail:
          "live RPC memo differs from the attestation captured at finalization — RPC may be returning a reorganized result, or the attestation column was tampered with",
      };
    }
    if (args.intentMemo !== args.attestedMemo) {
      return {
        outcome: "fail",
        code: "INTENT_DRIFT_FROM_ATTESTATION",
        detail:
          "memo_payload (oracle's intended memo at submission) differs from the attestation — DB was mutated post-commit, or the encoder version changed between memo_payload generation and tx submission",
      };
    }
    return { outcome: "pass" };
  }
  // Legacy path: no attestation column. Fall back to intent-vs-RPC
  // compare. Mismatches here are genuinely indistinguishable from
  // "needs backfill" — surface a specific code.
  if (args.intentMemo !== args.onChainMemo) {
    return {
      outcome: "fail",
      code: "LEGACY_MEMO_NOT_BACKFILLED",
      detail:
        "memo_payload differs from live on-chain memo, and onchain_memo_bytes is null. Either run the backfill (scripts/backfill-cycle-onchain.ts) to capture the canonical attestation, or this is a real DB-vs-chain drift that needs investigation",
    };
  }
  return { outcome: "pass" };
}

/**
 * slot: prefer cycle.confirmed_slot (from getTransaction at
 * finalization) over cycle.solana_slot (from getSignatureStatus,
 * which can drift by 1–2 slots near finality boundaries).
 */
function decideSlotCheck(args: {
  onChainSlot: number;
  legacySlot: number | null;
  attestedSlot: number | null;
}): CheckOutcome {
  if (args.attestedSlot !== null) {
    if (args.attestedSlot !== args.onChainSlot) {
      return {
        outcome: "fail",
        code: "SLOT_DRIFT_FROM_ATTESTATION",
        detail: `confirmed_slot=${args.attestedSlot} but live getTransaction reports slot=${args.onChainSlot}. RPC reorg or attestation tamper.`,
      };
    }
    return { outcome: "pass" };
  }
  // Legacy: no confirmed_slot. Fall back to solana_slot, with the
  // "needs backfill" code if it disagrees.
  if (args.legacySlot === null) {
    return {
      outcome: "fail",
      code: "LEGACY_SLOT_NOT_BACKFILLED",
      detail:
        "neither confirmed_slot nor solana_slot is populated. Run scripts/backfill-cycle-onchain.ts to backfill from on-chain.",
    };
  }
  if (args.legacySlot !== args.onChainSlot) {
    return {
      outcome: "fail",
      code: "LEGACY_SLOT_NOT_BACKFILLED",
      detail: `solana_slot=${args.legacySlot} but live on-chain slot=${args.onChainSlot}. solana_slot is the slot observed at finalization-tick (estimate); confirmed_slot (from getTransaction) is canonical. Run the backfill.`,
    };
  }
  return { outcome: "pass" };
}

/**
 * signer: prefer cycle.authority_pubkey (the signer captured at
 * finalization, i.e. the actual signer for this cycle) over the
 * current global config.authorityPubkey (which would be wrong for
 * any cycle signed before the most recent authority rotation, and
 * for any devnet-era cycle).
 */
function decideSignerCheck(args: {
  onChainSigners: string[];
  attestedAuthority: string | null;
  currentAuthority: string;
  cycleCluster: string | null;
  apiCluster: string;
}): CheckOutcome {
  if (args.attestedAuthority !== null) {
    if (!args.onChainSigners.includes(args.attestedAuthority)) {
      return {
        outcome: "fail",
        code: "SIGNER_DRIFT_FROM_ATTESTATION",
        detail: `attested authority ${args.attestedAuthority} is not in on-chain signers ${args.onChainSigners.join(", ")}. Either the attestation was tampered with or RPC returned a reorganized tx.`,
      };
    }
    return { outcome: "pass" };
  }
  // Legacy path: explicit signal for the cross-cluster case.
  // A devnet-era commit_cycle (cluster='devnet') being verified
  // against a mainnet authority will never pass; surface that
  // distinctly so the client can render a "legacy / not verifiable
  // on this cluster" state.
  if (args.cycleCluster && args.cycleCluster !== args.apiCluster) {
    return {
      outcome: "fail",
      code: "DEVNET_LEGACY_AUTHORITY",
      detail: `cycle was committed on cluster='${args.cycleCluster}' but the verifier API runs on cluster='${args.apiCluster}'. Pre-cutover devnet cycles cannot be verified against the mainnet authority. authority_pubkey is null — run the backfill if you want a per-cycle authority record.`,
    };
  }
  if (!args.onChainSigners.includes(args.currentAuthority)) {
    return {
      outcome: "fail",
      code: "LEGACY_AUTHORITY_NOT_BACKFILLED",
      detail: `on-chain signers ${args.onChainSigners.join(", ")} do not include the current authority ${args.currentAuthority}, and authority_pubkey is null. The cycle may have been signed by a previous authority before rotation. Run scripts/backfill-cycle-onchain.ts to capture the actual signer per cycle.`,
    };
  }
  return { outcome: "pass" };
}

/** Slot column may come back as string or number from PostgREST. */
function coerceSlot(raw: number | string | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  const n = typeof raw === "string" ? Number(raw) : raw;
  return Number.isFinite(n) ? n : null;
}

/** Test-only export of the pure decision helpers + slot coercion. */
export const _internal = {
  decideMemoCheck,
  decideSlotCheck,
  decideSignerCheck,
  coerceSlot,
};
