/**
 * Pinata IPFS pinning client for the BioHash oracle.
 *
 * Pins a finalized TWAP commit's full manifest (observation set + per-obs
 * deviation metric + Solana attestation) to IPFS via Pinata's
 * `/pinning/pinJSONToIPFS` endpoint, returning the resulting CID for
 * persistence on `twap_commits.ipfs_cid`.
 *
 * Position in the pipeline (§3.7 + apps/oracle/src/pollers/twap-poller.ts):
 *
 *     Solana submit → confirm → FINALIZE (markFinalizedTwap)
 *                                  │
 *                                  └── pinCycleToIPFS  ← this module
 *                                         (fire-and-forget)
 *                                  └── invokePegPusherBestEffort
 *
 * Failure semantics: this module THROWS on any non-2xx Pinata response,
 * on missing JWT, and on malformed responses. The caller in the TWAP
 * poller wraps the call in `.then().catch()` (never awaits) so a pin
 * failure can't break the oracle's commit pipeline — the Solana row
 * stays finalized, `ipfs_cid` stays null, and the next poller tick is
 * unaffected.
 *
 * Configuration: PINATA_JWT environment variable. When unset, the
 * caller is expected to skip pinning entirely (see isPinataConfigured).
 * We log a one-time warning on first call attempt against an unset
 * JWT so operators know the column will stay null.
 */

const PINATA_PIN_JSON_URL = 'https://api.pinata.cloud/pinning/pinJSONToIPFS';

/** Algorithm identifier matching apps/worker/src/twap.ts. */
export const TWAP_ALGO_V1 = 'filtered_median_v1';

/**
 * Cycle manifest schema — version 1.0.
 *
 * Pinned per-finalized-TWAP-commit. Every field here is recoverable
 * from the oracle's DB at the moment of finalization; the IPFS body
 * is purely a content-addressed snapshot of that record, useful for
 * auditors who want to verify a Solana commit's provenance without
 * trusting our API.
 *
 * `cycle_id` is the `peptide_twaps.id` (bigint) — i.e. the row in the
 * worker's TWAP table that this commit anchors. Not the same as
 * `commit_cycles.cycle_id` (which is per-scrape, not per-TWAP).
 *
 * Forward-compat note (re: included_in_twap / exclusion_reason):
 *
 *   filtered_median_v1 (apps/worker/src/twap.ts) is, in current
 *   production, a STRAIGHT median over the candidate set — every
 *   input survives and `peptide_twaps.dropped_observation_ids` is
 *   always empty. That means every observation in the manifest will
 *   have included_in_twap=true / exclusion_reason=null until a future
 *   outlier filter (MAD-based, see twap.ts header for rationale)
 *   ships. The manifest schema captures the dropped-row case ahead
 *   of time so we don't have to bump version when filtering arrives —
 *   the consumer surface stays stable, and `deviation_from_median_bps`
 *   already gives auditors a per-row "how outlier-ish" signal even
 *   for kept rows.
 */
export interface CycleManifest {
  version: '1.0';
  peptide_code: string;
  cycle_id: number;
  computed_at: string;
  twap_value: number;
  twap_unit: 'USD/mg';
  algorithm: string;
  merkle_root: string;
  solana_signature: string;
  solana_slot: number;
  observations: ManifestObservation[];
}

export interface ManifestObservation {
  vendor_code: string;
  vendor_url: string;
  raw_price_usd: number;
  pack_size_mg: number;
  price_usd_per_mg: number;
  observed_at: string;
  included_in_twap: boolean;
  exclusion_reason: string | null;
  /**
   * |obs - twap_median| / twap_median × 10_000, rounded to the nearest
   * basis point. Same metric `apps/worker/src/twap.ts#maxDeviationBps`
   * computes for the kept set, but here it's surfaced per-observation
   * so an auditor can see the spread of every input — kept or dropped.
   * Null when twap_value is zero (degenerate). Never negative.
   */
  deviation_from_median_bps: number | null;
}

export interface PinResult {
  cid: string;
  size: number;
  pinnedAt: string;
}

/* ─── Configuration probe ─────────────────────────────────────────── */

let warnedMissingJwt = false;

/**
 * Read-only check for `PINATA_JWT`. The TWAP poller calls this before
 * building a manifest so it can skip the manifest build + pin entirely
 * when pinning is disabled — saves the join cost on every finalize.
 *
 * The first time the function returns false in a process lifetime we
 * also emit a one-line console warning so operators don't have to grep
 * for "ipfs_cid is null" to discover the pin path is off.
 */
export function isPinataConfigured(): boolean {
  if (process.env.PINATA_JWT && process.env.PINATA_JWT.length > 0) return true;
  if (!warnedMissingJwt) {
    warnedMissingJwt = true;
    console.warn(
      '[ipfs] PINATA_JWT not set — TWAP commit pinning disabled. ' +
        'Oracle will continue to finalize Solana commits; ipfs_cid stays null. ' +
        'Set PINATA_JWT to enable.',
    );
  }
  return false;
}

/* ─── Pin a manifest ──────────────────────────────────────────────── */

/**
 * POST the manifest to Pinata. Resolves to `{cid, size, pinnedAt}` on
 * success; throws on any failure (missing JWT, network error, non-2xx
 * Pinata response, malformed response body).
 *
 * The caller MUST treat this as fire-and-forget — see
 * apps/oracle/src/pollers/twap-poller.ts for the .then/.catch pattern.
 *
 * The pinata metadata is the operator-readable index: `name` follows
 * `biohash-cycle-{cycleId}-{peptideCode}` so listing pins from Pinata's
 * dashboard groups by peptide, and `keyvalues` give the standard
 * filterable axes (app, type, peptide, cycle_id) used by any IPFS
 * tooling that surfaces Pinata metadata.
 */
export async function pinCycleToIPFS(
  manifest: CycleManifest,
  opts: { fetchImpl?: typeof fetch } = {},
): Promise<PinResult> {
  const jwt = process.env.PINATA_JWT;
  if (!jwt || jwt.length === 0) {
    throw new Error('pinCycleToIPFS: PINATA_JWT is not set — call isPinataConfigured() first');
  }

  const body = {
    pinataContent: manifest,
    pinataMetadata: {
      name: `biohash-cycle-${manifest.cycle_id}-${manifest.peptide_code}`,
      keyvalues: {
        app: 'biohash',
        type: 'oracle_cycle',
        peptide: manifest.peptide_code,
        // Pinata keyvalues are stringly-typed in the dashboard's filter UI.
        cycle_id: String(manifest.cycle_id),
      },
    },
    pinataOptions: {
      cidVersion: 1,
    },
  };

  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error('pinCycleToIPFS: global fetch is unavailable. Node >= 18 is required.');
  }

  let resp: Response;
  try {
    resp = await fetchImpl(PINATA_PIN_JSON_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${jwt}`,
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`pinCycleToIPFS: network error: ${msg}`);
  }

  if (!resp.ok) {
    // Pinata returns JSON {error:{reason,details}} on errors, but
    // fall back to text() for the rare 5xx HTML response.
    let detail = '';
    try {
      const text = await resp.text();
      detail = text.slice(0, 500);
    } catch {
      detail = '(no body)';
    }
    throw new Error(
      `pinCycleToIPFS: pin failed: HTTP ${resp.status} ${resp.statusText} — ${detail}`,
    );
  }

  let json: unknown;
  try {
    json = await resp.json();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`pinCycleToIPFS: malformed response JSON: ${msg}`);
  }

  // Pinata's documented success shape:
  //   { IpfsHash: string, PinSize: number, Timestamp: ISO string, isDuplicate?: boolean }
  if (typeof json !== 'object' || json === null) {
    throw new Error('pinCycleToIPFS: malformed response: not an object');
  }
  const obj = json as Record<string, unknown>;
  const cid = obj.IpfsHash;
  const size = obj.PinSize;
  const timestamp = obj.Timestamp;
  if (typeof cid !== 'string' || cid.length === 0) {
    throw new Error(
      `pinCycleToIPFS: malformed response: missing or empty IpfsHash (got ${JSON.stringify(obj).slice(0, 200)})`,
    );
  }
  if (typeof size !== 'number' || !Number.isFinite(size) || size < 0) {
    throw new Error(
      `pinCycleToIPFS: malformed response: PinSize is not a non-negative number (got ${JSON.stringify(size)})`,
    );
  }
  const pinnedAt =
    typeof timestamp === 'string' && timestamp.length > 0 ? timestamp : new Date().toISOString();

  return { cid, size, pinnedAt };
}

/** Test hook to reset the one-time warning latch between tests. */
export function _resetPinataWarningStateForTests(): void {
  warnedMissingJwt = false;
}
