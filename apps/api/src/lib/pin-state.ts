/**
 * Pin-state coalescing helpers for the public API.
 *
 * The BioHash Peptide Index schema 1.1 introduces a pin-twice flow
 * (see migration 0044, apps/oracle/src/index-history-runner.ts):
 *
 *   - twap_commits.ipfs_cid       = first-pin CID; manifest carries
 *                                   index_snapshot: null.
 *   - twap_commits.final_ipfs_cid = final-pin CID; manifest carries
 *                                   index_snapshot populated (only
 *                                   written after the 29-of-29 cohort
 *                                   completes for the hour).
 *
 * Public API consumers should always see the BEST AVAILABLE CID --
 * the final one if it exists, otherwise the first-pin CID. They also
 * need to know which they're looking at so a verifier knows whether
 * to expect a populated or null `index_snapshot` in the pinned body.
 *
 * resolvePinFields() encapsulates the coalesce. Every endpoint that
 * exposes a twap_commits row to the public surface should pass the
 * row through this function and use the returned {ipfs_cid, pin_state}
 * verbatim in its response body. This keeps the coalesce rule in one
 * file -- if we ever change it (e.g., add a third pin state), we
 * update here and every endpoint follows.
 */

export type PinState = 'pre_cohort' | 'final';

export interface PinFields {
  /** COALESCE(final_ipfs_cid, ipfs_cid). */
  ipfs_cid: string | null;
  /**
   * 'final' when the CID points to a schema 1.1 manifest with
   * index_snapshot populated, 'pre_cohort' when the CID points to a
   * schema 1.1 manifest with index_snapshot=null, null when no pin
   * has succeeded yet for this row.
   */
  pin_state: PinState | null;
}

export function resolvePinFields(row: {
  ipfs_cid?: string | null;
  final_ipfs_cid?: string | null;
}): PinFields {
  const final = row.final_ipfs_cid ?? null;
  const first = row.ipfs_cid ?? null;
  if (final !== null) return { ipfs_cid: final, pin_state: 'final' };
  if (first !== null) return { ipfs_cid: first, pin_state: 'pre_cohort' };
  return { ipfs_cid: null, pin_state: null };
}
