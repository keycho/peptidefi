/**
 * Build a CycleManifest from a finalized TWAP commit.
 *
 * Pulls together everything required for an IPFS-pinnable provenance
 * record:
 *
 *   - the `peptide_twaps` row that this `twap_commits` finalized
 *     (joined by peptide_code + computed_at — the same key Worker
 *     uses to write peptide_twaps and that twap-detection.ts uses
 *     to find them)
 *   - every observation in both `input_observation_ids` (included
 *     in the median) and `dropped_observation_ids` (currently empty
 *     under filtered_median_v1, but plumbed so a future MAD filter
 *     surfaces dropped rows automatically)
 *   - per-observation join to `suppliers` (vendor_code) and
 *     `supplier_products` (vendor_url, pack_size_mg)
 *
 * Pure-ish: takes a SqlClient + the TWAP commit fields, returns the
 * shape pinCycleToIPFS expects. No env reads, no Solana RPC.
 *
 * Failure mode: throws if the peptide_twaps row can't be found (the
 * twap_commits row points at it via the unique (peptide_code,
 * computed_at) key, so a missing row means schema corruption). The
 * caller in the TWAP poller catches this in the fire-and-forget
 * wrapper, so an oracle in the wild that hits this case still
 * finalizes Solana commits — only the pin is skipped.
 */

import type { SqlClient } from '../db/client';
import type { CycleManifest, ManifestObservation } from './pinata';
import { TWAP_ALGO_V1 } from './pinata';

const EXCLUSION_REASON_FOR_DROPPED = `excluded_by_${TWAP_ALGO_V1}`;

/** Inputs needed to build the manifest, all available at finalize time. */
export interface BuildManifestArgs {
  peptide_code: string;
  computed_at: Date;
  /** twap_commits.twap_value as decimal string (PG numeric). */
  twap_value: string;
  observation_set_root: string;
  solana_signature: string;
  solana_slot: number;
}

/**
 * Row shape from the peptide_twaps + supplier_observations +
 * suppliers + supplier_products join. One row per observation.
 */
interface JoinedObservationRow {
  observation_id: bigint | number;
  observed_at: Date | string;
  raw_price: string | null;
  fx_rate_to_usd: string | null;
  price_usd_per_mg: string | null;
  vendor_code: string;
  vendor_url: string;
  pack_size_mg: string;
}

interface PeptideTwapShell {
  twap_id: bigint | number;
  input_ids: (bigint | number)[];
  dropped_ids: (bigint | number)[];
}

export async function buildCycleManifest(
  sql: SqlClient,
  args: BuildManifestArgs,
): Promise<CycleManifest> {
  // 1. Resolve peptide_twaps.id + the two id arrays. The twap_commits
  //    row references this row implicitly via (peptide_code, computed_at).
  const shellRows = await sql<
    {
      twap_id: bigint | number;
      input_observation_ids: (bigint | number)[] | string;
      dropped_observation_ids: (bigint | number)[] | string;
    }[]
  >`
    SELECT pt.id              AS twap_id,
           pt.input_observation_ids,
           pt.dropped_observation_ids
    FROM   public.peptide_twaps pt
    JOIN   public.peptides p ON p.id = pt.peptide_id
    WHERE  p.code        = ${args.peptide_code}
      AND  pt.computed_at = ${args.computed_at}
    LIMIT 1
  `;
  const shellRow = shellRows[0];
  if (!shellRow) {
    throw new Error(
      `manifest-builder: no peptide_twaps row for ` +
        `peptide_code=${args.peptide_code} computed_at=${args.computed_at.toISOString()} ` +
        `— refusing to build a manifest for a TWAP commit whose source row is missing`,
    );
  }
  const shell: PeptideTwapShell = {
    twap_id: shellRow.twap_id,
    input_ids: toIdArray(shellRow.input_observation_ids),
    dropped_ids: toIdArray(shellRow.dropped_observation_ids),
  };

  // 2. Hydrate every referenced observation. `latest_product` =
  //    the supplier_products row referenced by supplier_observations.
  //    `pack_size_mg` is mass_per_unit_mg (canonical column name in
  //    schema 0002). Joins are inner — a missing supplier or product
  //    is schema corruption, not a recoverable case.
  // Coerce to number[] (postgres.js ANY() needs a homogeneous typed array;
  // bigint elements break the tagged-template type inference).
  const allIds = [...shell.input_ids, ...shell.dropped_ids].map(idToNumber);
  let rows: JoinedObservationRow[] = [];
  if (allIds.length > 0) {
    const result = await sql<JoinedObservationRow[]>`
      SELECT so.id                        AS observation_id,
             so.observed_at,
             so.raw_price,
             so.fx_rate_to_usd,
             so.price_usd_per_mg,
             s.code                       AS vendor_code,
             sp.product_url               AS vendor_url,
             sp.mass_per_unit_mg::text    AS pack_size_mg
      FROM   public.supplier_observations so
      JOIN   public.suppliers          s  ON s.id  = so.supplier_id
      JOIN   public.supplier_products  sp ON sp.id = so.supplier_product_id
      WHERE  so.id = ANY(${allIds})
    `;
    rows = result as unknown as JoinedObservationRow[];
  }
  const byId = new Map<number, JoinedObservationRow>();
  for (const r of rows) {
    byId.set(idToNumber(r.observation_id), r);
  }

  // 3. Build observation entries with deviation_from_median_bps.
  const twapValueNum = Number(args.twap_value);
  const twapZero = !Number.isFinite(twapValueNum) || twapValueNum === 0;
  const observations: ManifestObservation[] = [];
  // Stable order: included first (by observation_id ascending), then dropped.
  const orderedIncluded = [...shell.input_ids].map(idToNumber).sort((a, b) => a - b);
  const orderedDropped = [...shell.dropped_ids].map(idToNumber).sort((a, b) => a - b);
  for (const id of orderedIncluded) {
    const row = byId.get(id);
    if (!row) continue;
    observations.push(toManifestObservation(row, true, null, twapValueNum, twapZero));
  }
  for (const id of orderedDropped) {
    const row = byId.get(id);
    if (!row) continue;
    observations.push(
      toManifestObservation(row, false, EXCLUSION_REASON_FOR_DROPPED, twapValueNum, twapZero),
    );
  }

  return {
    version: '1.0',
    peptide_code: args.peptide_code,
    cycle_id: idToNumber(shell.twap_id),
    computed_at: args.computed_at.toISOString(),
    twap_value: twapValueNum,
    twap_unit: 'USD/mg',
    algorithm: TWAP_ALGO_V1,
    merkle_root: args.observation_set_root,
    solana_signature: args.solana_signature,
    solana_slot: args.solana_slot,
    observations,
  };
}

/* ─── helpers ─────────────────────────────────────────────────── */

function toManifestObservation(
  row: JoinedObservationRow,
  includedInTwap: boolean,
  exclusionReason: string | null,
  twapValueNum: number,
  twapZero: boolean,
): ManifestObservation {
  const priceUsdPerMg = Number(row.price_usd_per_mg ?? '0');
  const rawPrice = Number(row.raw_price ?? '0');
  const fx = Number(row.fx_rate_to_usd ?? '1');
  const rawPriceUsd = Number.isFinite(rawPrice * fx) ? rawPrice * fx : 0;
  const packSizeMg = Number(row.pack_size_mg ?? '0');

  let deviationBps: number | null = null;
  if (!twapZero && Number.isFinite(priceUsdPerMg)) {
    const ratio = Math.abs(priceUsdPerMg - twapValueNum) / twapValueNum;
    if (Number.isFinite(ratio)) {
      deviationBps = Math.round(ratio * 10_000);
    }
  }

  return {
    vendor_code: row.vendor_code,
    vendor_url: row.vendor_url,
    raw_price_usd: roundCurrency(rawPriceUsd),
    pack_size_mg: roundCurrency(packSizeMg),
    price_usd_per_mg: Number.isFinite(priceUsdPerMg) ? priceUsdPerMg : 0,
    observed_at:
      row.observed_at instanceof Date ? row.observed_at.toISOString() : String(row.observed_at),
    included_in_twap: includedInTwap,
    exclusion_reason: exclusionReason,
    deviation_from_median_bps: deviationBps,
  };
}

function roundCurrency(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 1_000_000) / 1_000_000;
}

function toIdArray(value: (bigint | number)[] | string): (bigint | number)[] {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    // Postgres array text shape: "{1001,1002,1003}".
    const trimmed = value.replace(/^\{|\}$/g, '');
    if (trimmed === '') return [];
    return trimmed.split(',').map((s) => Number(s));
  }
  return [];
}

function idToNumber(v: bigint | number): number {
  return typeof v === 'bigint' ? Number(v) : v;
}
