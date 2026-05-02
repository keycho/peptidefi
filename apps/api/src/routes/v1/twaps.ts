import type { Request, Response } from "express";
import { adminClientUntyped } from "../../supabase";
import {
  loadOracleApiConfig,
  solscanUrl,
  solanaExplorerUrl,
} from "../../oracle-config";
import { sendError } from "../../errors";

/**
 * GET /v1/twaps/:id — single TWAP commit detail.
 *
 * `:id` is the twap_commits.id UUID. Mirrors §05.4.5 with the
 * `input_observation_ids` looked up via the source peptide_twaps row
 * (twap_commits doesn't store the array directly — a TWAP commit's
 * provenance walks back to the peptide_twaps row that produced it
 * via `(peptide_id, computed_at)`).
 *
 * Returns 404 if the UUID isn't found.
 */
export async function getTwapHandler(req: Request, res: Response): Promise<void> {
  const id = req.params.id;
  if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
    sendError(res, 400, "BAD_REQUEST", "twap id must be a UUID");
    return;
  }
  const supabase = adminClientUntyped();
  const config = loadOracleApiConfig();

  const { data: twap, error: tErr } = await supabase
    .from("twap_commits")
    .select(
      "id, peptide_code, twap_value, computed_at, window_start, window_end, observation_set_root, memo_payload, status, solana_signature, solana_slot, submitted_at, finalized_at, retry_count, last_error",
    )
    .eq("id", id)
    .maybeSingle();
  if (tErr) {
    sendError(res, 500, "DB_ERROR", `twap lookup failed: ${tErr.message}`);
    return;
  }
  if (!twap) {
    sendError(res, 404, "NOT_FOUND", `twap commit ${id} not found`);
    return;
  }

  // Resolve the input_observation_ids by joining back to peptide_twaps
  // via (peptide_code → peptide_id) + computed_at.
  const { data: peptideRow } = await supabase
    .from("peptides")
    .select("id")
    .eq("code", twap.peptide_code)
    .maybeSingle();
  let inputObservationIds: number[] = [];
  if (peptideRow?.id !== undefined) {
    const { data: ptRow } = await supabase
      .from("peptide_twaps")
      .select("input_observation_ids")
      .eq("peptide_id", peptideRow.id)
      .eq("computed_at", twap.computed_at)
      .maybeSingle();
    if (ptRow?.input_observation_ids) {
      inputObservationIds = (ptRow.input_observation_ids as unknown[]).map((v) =>
        typeof v === "string" ? Number(v) : (v as number),
      );
    }
  }

  res.json({
    twap_id: twap.id,
    peptide_code: twap.peptide_code,
    algo: "filtered_median_v1", // locked at v=1 per §02.2.3
    twap_value: String(twap.twap_value),
    computed_at: twap.computed_at,
    window_start: twap.window_start,
    window_end: twap.window_end,
    observation_set_root: twap.observation_set_root,
    status: twap.status,
    solana: twap.solana_signature
      ? {
          signature: twap.solana_signature,
          slot:
            twap.solana_slot === null
              ? null
              : typeof twap.solana_slot === "string"
                ? Number(twap.solana_slot)
                : twap.solana_slot,
          cluster: config.cluster,
          solscan_url: solscanUrl(twap.solana_signature, config.cluster),
          explorer_url: solanaExplorerUrl(twap.solana_signature, config.cluster),
        }
      : null,
    memo_payload: twap.memo_payload,
    submitted_at: twap.submitted_at,
    finalized_at: twap.finalized_at,
    retry_count: twap.retry_count ?? 0,
    last_error: twap.last_error ?? null,
    input_observation_ids: inputObservationIds,
  });
}
