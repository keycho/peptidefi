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
 * Cycle manifest schema — version 1.1.
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
 * 1.0 -> 1.1 (BioHash Peptide Index, migration 0043):
 *
 *   Adds the top-level `index_snapshot` field carrying the equal-weight
 *   index level computed for the same UTC hour as this commit. The
 *   level is null when fewer than the cohort-size peptides finalized
 *   for the hour (per spec: partial hours are skipped, the index is
 *   not computed). When non-null, the same {level, components_hash}
 *   appears in every per-peptide manifest pinned for that hour, and
 *   matches the row written to public.index_history.
 *
 *   See apps/oracle/src/index-computer.ts for the formula and the
 *   canonical-JSON convention used by components_hash. Auditors can
 *   reproduce the hash byte-for-byte in any language by:
 *     (1) loading the cohort's per-peptide TWAPs for the hour;
 *     (2) sorting by peptide_code (UTF-16 / ASCII byte order);
 *     (3) building objects with keys {peptide_code, twap_value,
 *         weight: 1/N} in that order, where N is the cohort size;
 *     (4) JSON-serializing without whitespace and using the shortest
 *         round-trip decimal for each Number (the ECMA-262 §6.1.6.1.13
 *         algorithm, also produced by Python repr(), Go strconv with
 *         'g' / -1, Rust {} format);
 *     (5) sha256 of the resulting bytes, lowercase hex.
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
  version: '1.1';
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
  /**
   * Equal-weight BioHash Peptide Index snapshot for the UTC hour this
   * commit belongs to. Null when fewer than the cohort-size peptides
   * finalized for the hour (per spec: partial hours are skipped, no
   * partial index). The same {level, components_hash} appears in
   * every per-peptide manifest pinned for the same hour and matches
   * the row in public.index_history.
   */
  index_snapshot: IndexSnapshot | null;
}

/**
 * Top-level snapshot of the equal-weight BioHash Peptide Index level
 * for the same UTC hour as the enclosing CycleManifest.
 *
 *   level             — sum over cohort of (twap_i / baseline_i) *
 *                       (baseline_level / N).
 *   baseline_date     — ISO date (YYYY-MM-DD) of the configured
 *                       baseline, shared across the cohort.
 *   baseline_level    — Configured baseline level, currently 1000.00.
 *   components_hash   — sha256 hex of the canonical components vector
 *                       (see CycleManifest header comment for the
 *                       exact serialization).
 *   computed_at       — ISO timestamp when the level was computed
 *                       (when the last cohort peptide finalized for
 *                       the hour).
 */
export interface IndexSnapshot {
  level: number;
  baseline_date: string;
  baseline_level: number;
  components_hash: string;
  computed_at: string;
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

  // Hotfix #2 (after #22 / b8f705d): the regex-escape approach in #22
  // did NOT resolve the production crash. That fix transformed every
  // non-ASCII code point to a \uXXXX JSON escape, which produces a
  // pure-ASCII string -- that *should* have satisfied Node's ByteString
  // coercion. We did not finish proving exactly why the escape did not
  // take effect under Railway's runtime; rather than chase it, switch
  // to a transport that bypasses ByteString coercion entirely.
  //
  // Pass a `Buffer` (a Uint8Array subclass). When `BodyInit` is a
  // typed-array view, Node's fetch reads the bytes verbatim -- no
  // string -> ByteString step, no >255 code-point check, no chance of
  // tripping over U+2028 / U+2029 / accented characters in any field.
  //
  // The wire payload is unchanged: Buffer.from(json, 'utf-8') produces
  // exactly the bytes Pinata's parser sees, the resulting CID is
  // byte-identical to what an unescaped send would have produced if
  // ByteString coercion had never been in the way.
  const bodyJson = JSON.stringify(body);
  const bodyBytes = Buffer.from(bodyJson, 'utf-8');

  // Diagnostic logging -- runs on every pin so the next production
  // failure (if any) tells us EXACTLY which field and code point are
  // involved. Window around position 692 is calibrated to the original
  // crash index so the log line is directly comparable to the report.
  logBodyDiagnostic(bodyJson, bodyBytes);

  let resp: Response;
  try {
    resp = await fetchImpl(PINATA_PIN_JSON_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${jwt}`,
      },
      // CRITICAL: pass the Buffer directly. Calling .toString(),
      // wrapping in String(...), or using a template literal would
      // re-introduce the ByteString coercion this fix exists to avoid.
      body: bodyBytes,
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

/**
 * Pre-fetch diagnostic. Always runs (no env-gate) — these are the
 * lines the next production failure (if any) will be diagnosed from.
 * Logs:
 *
 *   - JSON string length in CHARS  (what JS sees / what the previous
 *                                   regex was iterating over)
 *   - UTF-8 byte length             (what fetch will transport)
 *   - first 50 chars of the JSON    (sanity that we're sending what
 *                                   we think we're sending)
 *   - window around CHAR index 692  (the position from the original
 *                                   crash report) with char codes so
 *                                   any non-ASCII is unambiguous
 *
 * The 692 probe is informational only — if the crash recurs at a
 * different index, the failure log will surface the new index and
 * we can pivot.
 */
function logBodyDiagnostic(bodyJson: string, bodyBytes: Buffer): void {
  const PROBE = 692;
  const head = bodyJson.slice(0, 50);
  console.log(`[ipfs] body length: ${bodyJson.length} chars / ${bodyBytes.length} bytes (utf-8)`);
  console.log(`[ipfs] body head[0..50]: ${JSON.stringify(head)}`);

  if (bodyJson.length > PROBE - 10) {
    const lo = Math.max(0, PROBE - 10);
    const hi = Math.min(bodyJson.length, PROBE + 20);
    const window = bodyJson.slice(lo, hi);
    const codes: string[] = [];
    for (let i = lo; i < hi; i++) {
      const code = bodyJson.charCodeAt(i);
      codes.push(`${i}:U+${code.toString(16).padStart(4, '0').toUpperCase()}`);
    }
    console.log(`[ipfs] body[${lo}..${hi}] snippet: ${JSON.stringify(window)}`);
    console.log(`[ipfs] body[${lo}..${hi}] codes: ${codes.join(' ')}`);
  }
}

/** Test hook to reset the one-time warning latch between tests. */
export function _resetPinataWarningStateForTests(): void {
  warnedMissingJwt = false;
}
