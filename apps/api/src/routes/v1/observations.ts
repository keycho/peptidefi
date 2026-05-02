import type { Request, Response } from "express";
import {
  bytesToHex0x,
  buildMerkleTree,
  canonicalObservationJson,
  generateProof,
  leafHash,
  type Observation,
} from "@peptide-oracle/shared";
import { adminClientUntyped } from "../../supabase";
import {
  loadOracleApiConfig,
  solscanUrl,
  solanaExplorerUrl,
} from "../../oracle-config";
import { sendError } from "../../errors";
import { rowToObservationLike } from "../../observation-shape";

/**
 * GET /v1/observations/:id — single observation, full canonical
 * form, with commit reference + reproducible Merkle proof.
 *
 * Per §05.4.10 the response carries the canonical_leaf_json so a
 * verifier can recompute SHA-256(0x00 || it) without re-canonicalizing
 * themselves. We extend that shape with the Merkle proof for the
 * observation's cycle (when the cycle is finalized) so a verifier
 * can complete §5.2 steps 4–6 in one call.
 *
 * Returns 404 if the observation_id doesn't exist. Returns the
 * observation with `commit: null` if it exists but isn't anchored
 * (the cycle never produced a commit_cycles row, or the cycle is
 * still in-flight).
 */
export async function getObservationHandler(
  req: Request,
  res: Response,
): Promise<void> {
  const idParam = req.params.id;
  if (!idParam || !/^\d+$/.test(idParam)) {
    sendError(res, 400, "BAD_REQUEST", "observation_id must be a positive integer");
    return;
  }
  const obsId = Number(idParam);
  const supabase = adminClientUntyped();
  const config = loadOracleApiConfig();

  // 1. Observation row (all 17 leaf fields + the FKs).
  const { data: obsRow, error: oErr } = await supabase
    .from("supplier_observations")
    .select(
      "id, supplier_id, peptide_id, supplier_product_id, scraper_run_id, observed_at, raw_price, raw_currency, fx_rate_to_usd, price_usd_per_mg, raw_availability, availability_tier, lead_time_days, scrape_success, scrape_error, http_status, raw_html_hash",
    )
    .eq("id", obsId)
    .maybeSingle();
  if (oErr) {
    sendError(res, 500, "DB_ERROR", `observation lookup failed: ${oErr.message}`);
    return;
  }
  if (!obsRow) {
    sendError(res, 404, "NOT_FOUND", `observation ${obsId} not found`);
    return;
  }

  // 2. Convert to canonical Observation form. We can't import the
  //    oracle's rowToObservation directly (that lives in apps/oracle/
  //    and uses the postgres.js row shape; supabase-js returns slightly
  //    different shapes — numeric-as-number vs string, etc.). The
  //    rowToObservationLike helper handles the supabase-js shape.
  let obs: Observation;
  try {
    obs = rowToObservationLike(obsRow);
  } catch (err) {
    sendError(
      res,
      500,
      "ADAPTER_ERROR",
      `observation could not be canonicalized: ${(err as Error).message}`,
    );
    return;
  }
  const canonicalJson = canonicalObservationJson(obs);
  const computedLeafHash = bytesToHex0x(leafHash(obs));

  // 3. Commit-membership lookup: did this observation make it into a
  //    cycle commit? Returns at most one row (cycle_id+observation_id
  //    is the PK).
  const { data: junction, error: jErr } = await supabase
    .from("commit_observations")
    .select("cycle_id, leaf_hash, leaf_index")
    .eq("observation_id", obsId)
    .maybeSingle();
  if (jErr) {
    sendError(res, 500, "DB_ERROR", `junction lookup failed: ${jErr.message}`);
    return;
  }

  // 4. If anchored, fetch the cycle to surface its status + signature
  //    and (when finalized) reproduce the Merkle proof.
  let commitOut: Record<string, unknown> | null = null;
  let proofOut: unknown = null;
  if (junction) {
    const { data: cycle, error: cErr } = await supabase
      .from("commit_cycles")
      .select(
        "cycle_id, merkle_root, observation_count, status, solana_signature, solana_slot",
      )
      .eq("cycle_id", junction.cycle_id)
      .maybeSingle();
    if (cErr) {
      sendError(res, 500, "DB_ERROR", `cycle lookup failed: ${cErr.message}`);
      return;
    }
    if (cycle) {
      commitOut = {
        cycle_id: typeof cycle.cycle_id === "string" ? Number(cycle.cycle_id) : cycle.cycle_id,
        leaf_hash: junction.leaf_hash,
        leaf_index: junction.leaf_index,
        merkle_root: cycle.merkle_root,
        status: cycle.status,
        solana_signature: cycle.solana_signature,
        solana_slot:
          cycle.solana_slot === null
            ? null
            : typeof cycle.solana_slot === "string"
              ? Number(cycle.solana_slot)
              : cycle.solana_slot,
        solscan_url: cycle.solana_signature
          ? solscanUrl(cycle.solana_signature, config.cluster)
          : null,
        explorer_url: cycle.solana_signature
          ? solanaExplorerUrl(cycle.solana_signature, config.cluster)
          : null,
      };

      // 5. If finalized, reconstruct the Merkle proof. We need every
      //    observation in the cycle (their canonical leaves), in id-asc
      //    order, to rebuild the tree. With ~150 obs per cycle this is
      //    a few-hundred-row fetch + a few ms of hashing; acceptable
      //    on the verification path.
      if (cycle.status === "finalized") {
        const { data: cycleObs, error: lErr } = await supabase
          .from("supplier_observations")
          .select(
            "id, supplier_id, peptide_id, supplier_product_id, scraper_run_id, observed_at, raw_price, raw_currency, fx_rate_to_usd, price_usd_per_mg, raw_availability, availability_tier, lead_time_days, scrape_success, scrape_error, http_status, raw_html_hash",
          )
          .eq("scraper_run_id", junction.cycle_id)
          .order("id", { ascending: true });
        if (lErr) {
          sendError(res, 500, "DB_ERROR", `cycle obs fetch failed: ${lErr.message}`);
          return;
        }
        const observations = (cycleObs ?? []).map(rowToObservationLike);
        const tree = buildMerkleTree(observations);
        const proof = generateProof(tree, junction.leaf_index);
        proofOut = {
          merkle_root: bytesToHex0x(tree.root),
          proof,
        };
      }
    }
  }

  res.json({
    observation: obs,
    canonical_leaf_json: canonicalJson,
    computed_leaf_hash: computedLeafHash,
    commit: commitOut,
    proof: proofOut,
  });
}
