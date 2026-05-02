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
  const { data: cycle, error: cErr } = await supabase
    .from("commit_cycles")
    .select(
      "cycle_id, merkle_root, observation_count, memo_payload, status, solana_signature, solana_slot",
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

  const memoMatches = onChain.memo === cycle.memo_payload;
  const dbSlot =
    cycle.solana_slot === null
      ? null
      : typeof cycle.solana_slot === "string"
        ? Number(cycle.solana_slot)
        : cycle.solana_slot;
  const slotMatches = dbSlot !== null && onChain.slot === dbSlot;
  const signerMatches = onChain.signers.includes(config.authorityPubkey);

  if (!memoMatches) {
    res.json({
      verified: false,
      observation_id: observationId,
      cycle_id: junction.cycle_id,
      failure_reason: "memo_matches_onchain",
      failure_detail:
        "on-chain memo bytes differ from commit_cycles.memo_payload — DB record was mutated post-commit, or wrong signature is referenced",
      checks: [
        ...checks,
        check("memo_matches_onchain", false),
        { name: "slot_matches_onchain", passed: slotMatches },
        { name: "signer_matches_authority", passed: signerMatches },
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

  if (!slotMatches) {
    res.json({
      verified: false,
      observation_id: observationId,
      cycle_id: junction.cycle_id,
      failure_reason: "slot_matches_onchain",
      failure_detail: `commit_cycles.solana_slot=${dbSlot} but on-chain reports slot=${onChain.slot}`,
      checks: [
        ...checks,
        check("slot_matches_onchain", false),
        { name: "signer_matches_authority", passed: signerMatches },
      ],
    });
    return;
  }
  checks.push(check("slot_matches_onchain", true));

  if (!signerMatches) {
    res.json({
      verified: false,
      observation_id: observationId,
      cycle_id: junction.cycle_id,
      failure_reason: "signer_matches_authority",
      failure_detail: `on-chain signers ${onChain.signers.join(", ")} do not include the configured authority pubkey ${config.authorityPubkey}`,
      checks: [...checks, check("signer_matches_authority", false)],
    });
    return;
  }
  checks.push(check("signer_matches_authority", true));

  // ─── All checks passed ──────────────────────────────────────────
  res.json({
    verified: true,
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
      solscan_url: solscanUrl(cycle.solana_signature!, config.cluster),
      explorer_url: solanaExplorerUrl(cycle.solana_signature!, config.cluster),
    },
    checks,
  });
}
