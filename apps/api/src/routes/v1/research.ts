import type { Request, Response } from 'express';
import { adminClientUntyped } from '../../supabase';
import { solscanUrl, solanaExplorerUrl, type SolanaCluster } from '../../oracle-config';
import { clusterQuerySchema } from '../../validators';
import { sendError } from '../../errors';

/**
 * GET /v1/research/:code — BioHash Peptide Research Index detail page.
 *
 * Joins three layers in one HTTP response:
 *
 *   1. peptide identity        (peptides table)
 *   2. curated research metadata (peptide_research_metadata, migration 0039)
 *   3. live pricing context      (latest finalized twap_commit, 14-day
 *      history, current per-vendor prices in the last 24h)
 *   4. verification anchor      (latest finalized commit_cycle that
 *      contained an observation of this peptide)
 *
 * 404 contract:
 *   - peptide code unknown → 404 NOT_FOUND.
 *   - peptide exists but has no peptide_research_metadata row → 404
 *     NOT_FOUND (with a specific message). The research-index page
 *     is opt-in per peptide; a missing metadata row is the canonical
 *     "not indexed" signal so we don't leak skeleton pages.
 *
 * Cache: public, max-age=300. Pricing fields are 5-minute-stale by
 * design (the underlying TWAP cadence is 30 min so this is fine);
 * curated metadata is effectively immutable between migrations.
 */

const CODE_RE = /^[A-Z0-9]{2,16}$/;
const HISTORY_DAYS = 14;
const HISTORY_MS = HISTORY_DAYS * 24 * 60 * 60 * 1000;
const VENDOR_PRICE_WINDOW_HOURS = 24;
const VENDOR_PRICE_WINDOW_MS = VENDOR_PRICE_WINDOW_HOURS * 60 * 60 * 1000;

function rowCluster(row: { cluster: string | null }): SolanaCluster {
  switch (row.cluster) {
    case 'mainnet-beta':
    case 'devnet':
    case 'testnet':
      return row.cluster;
    case 'mainnet':
      return 'mainnet-beta';
    default:
      return 'devnet';
  }
}

interface ResearchMetadataRow {
  peptide_code: string;
  overview: string;
  mechanism: string | null;
  applications: unknown;
  half_life_estimate: string | null;
  storage: string | null;
  sequence: string | null;
  molecular_weight: number | string | null;
  aliases: unknown;
  full_name: string | null;
  pubmed_citation_count_estimate: number | null;
  research_disclaimer: string;
}

interface VendorEntry {
  vendor_name: string;
  price_usd_per_mg: string;
  observed_at: string;
}

interface ObservationRow {
  supplier_id: number | string;
  scraper_run_id: number | string;
  price_usd_per_mg: string | number;
  observed_at: string;
  suppliers: { display_name: string } | { display_name: string }[] | null;
}

export async function getResearchHandler(req: Request, res: Response): Promise<void> {
  const codeParam = (req.params.code ?? '').trim().toUpperCase();
  if (!CODE_RE.test(codeParam)) {
    sendError(res, 400, 'BAD_REQUEST', 'code must be 2–16 uppercase alphanumeric characters');
    return;
  }

  const parsedCluster = clusterQuerySchema.safeParse(req.query);
  if (!parsedCluster.success) {
    sendError(res, 400, 'BAD_REQUEST', parsedCluster.error.message);
    return;
  }
  const { cluster } = parsedCluster.data;

  const supabase = adminClientUntyped();

  // 1. Peptide row (404 if missing).
  const { data: peptide, error: pErr } = await supabase
    .from('peptides')
    .select('id, code, display_name, full_name, is_active')
    .eq('code', codeParam)
    .maybeSingle();
  if (pErr) {
    sendError(res, 500, 'DB_ERROR', `peptide lookup failed: ${pErr.message}`);
    return;
  }
  if (!peptide) {
    sendError(res, 404, 'NOT_FOUND', `peptide not found: ${codeParam}`);
    return;
  }

  // 2. Curated research metadata (404 if peptide isn't indexed).
  const { data: metaRow, error: mErr } = await supabase
    .from('peptide_research_metadata')
    .select(
      'peptide_code, overview, mechanism, applications, half_life_estimate, storage, sequence, molecular_weight, aliases, full_name, pubmed_citation_count_estimate, research_disclaimer',
    )
    .eq('peptide_code', peptide.code)
    .maybeSingle();
  if (mErr) {
    sendError(res, 500, 'DB_ERROR', `research metadata lookup failed: ${mErr.message}`);
    return;
  }
  if (!metaRow) {
    sendError(
      res,
      404,
      'NOT_FOUND',
      `peptide ${peptide.code} exists but is not indexed in the research surface`,
    );
    return;
  }
  const meta = metaRow as ResearchMetadataRow;

  // 3a. TWAP history — last 14 days, optional cluster filter.
  const since = new Date(Date.now() - HISTORY_MS).toISOString();
  let historyQuery = supabase
    .from('twap_commits')
    .select(
      'id, twap_value, computed_at, window_start, window_end, observation_set_root, status, solana_signature, solana_slot, finalized_at, cluster, ipfs_cid',
    )
    .eq('peptide_code', peptide.code)
    .gte('computed_at', since)
    .order('computed_at', { ascending: false });
  if (cluster !== undefined) historyQuery = historyQuery.eq('cluster', cluster);
  const { data: history, error: hErr } = await historyQuery;
  if (hErr) {
    sendError(res, 500, 'DB_ERROR', `twap history failed: ${hErr.message}`);
    return;
  }
  const historyRows = history ?? [];

  // 3b. Current TWAP — first finalized row (could be elsewhere in
  // the page; cleanest single source is the most recent finalized
  // commit, which may not be the first row above if the latest
  // commit is still 'submitted').
  let currentTwapQuery = supabase
    .from('twap_commits')
    .select('twap_value, computed_at, solana_signature, solana_slot, cluster, ipfs_cid')
    .eq('peptide_code', peptide.code)
    .eq('status', 'finalized')
    .order('computed_at', { ascending: false })
    .limit(1);
  if (cluster !== undefined) currentTwapQuery = currentTwapQuery.eq('cluster', cluster);
  const { data: latestTwapRows, error: ltErr } = await currentTwapQuery;
  if (ltErr) {
    sendError(res, 500, 'DB_ERROR', `current twap query failed: ${ltErr.message}`);
    return;
  }
  const latestTwap = latestTwapRows?.[0] ?? null;

  // 3c. Current per-vendor prices — last 24h, latest per supplier.
  const vendorSince = new Date(Date.now() - VENDOR_PRICE_WINDOW_MS).toISOString();
  const { data: obsRows, error: oErr } = await supabase
    .from('supplier_observations')
    .select('supplier_id, scraper_run_id, price_usd_per_mg, observed_at, suppliers(display_name)')
    .eq('peptide_id', peptide.id)
    .eq('scrape_success', true)
    .not('price_usd_per_mg', 'is', null)
    .gte('observed_at', vendorSince)
    .order('observed_at', { ascending: false });
  if (oErr) {
    sendError(res, 500, 'DB_ERROR', `supplier_observations query failed: ${oErr.message}`);
    return;
  }
  const vendors = reduceVendors((obsRows ?? []) as ObservationRow[]);

  // 4. Verification anchor — the most recent finalized commit_cycle
  // whose cycle_id is at or before the most recent observation for
  // this peptide. We use the peptide's latest observation row to
  // bound the cycle search rather than join through
  // commit_observations (which would be an N-deep JSON traversal in
  // PostgREST). For a healthy peptide this resolves to the very
  // latest cycle anyway; for a quarantined peptide the anchor lags
  // alongside the observations.
  let verification: {
    latest_cycle_id: number | null;
    latest_solana_signature: string | null;
    verified_at_commitment: 'finalized' | null;
    solscan_url: string | null;
  } = {
    latest_cycle_id: null,
    latest_solana_signature: null,
    verified_at_commitment: null,
    solscan_url: null,
  };
  const latestObsRunId = obsRows?.[0]?.scraper_run_id ?? null;
  if (latestObsRunId !== null) {
    const upperBound = typeof latestObsRunId === 'string' ? Number(latestObsRunId) : latestObsRunId;
    let cycleQ = supabase
      .from('commit_cycles')
      .select('cycle_id, solana_signature, status, cluster')
      .eq('status', 'finalized')
      .lte('cycle_id', upperBound)
      .order('cycle_id', { ascending: false })
      .limit(1);
    if (cluster !== undefined) cycleQ = cycleQ.eq('cluster', cluster);
    const { data: cycleRows, error: cErr } = await cycleQ;
    if (cErr) {
      // Non-fatal — verification anchor is best-effort metadata.
      // Falling through with nulls is preferable to surfacing a 500
      // on the research page just because commit_cycles is slow.
      console.warn(
        `[research] commit_cycles lookup failed for ${peptide.code} (non-fatal): ${cErr.message}`,
      );
    } else {
      const c = cycleRows?.[0];
      if (c && c.solana_signature) {
        const cc = rowCluster(c);
        verification = {
          latest_cycle_id: typeof c.cycle_id === 'string' ? Number(c.cycle_id) : c.cycle_id,
          latest_solana_signature: c.solana_signature,
          verified_at_commitment: 'finalized',
          solscan_url: solscanUrl(c.solana_signature, cc),
        };
      }
    }
  }

  // ─── Response ──────────────────────────────────────────────────
  res.set('Cache-Control', 'public, max-age=300');
  res.json({
    peptide: {
      code: peptide.code,
      display_name: peptide.display_name,
      full_name: peptide.full_name,
      aliases: toStringArray(meta.aliases),
      sequence: meta.sequence,
      molecular_weight:
        meta.molecular_weight === null || meta.molecular_weight === undefined
          ? null
          : Number(meta.molecular_weight),
    },
    research: {
      overview: meta.overview,
      mechanism: meta.mechanism,
      applications: toStringArray(meta.applications),
      half_life_estimate: meta.half_life_estimate,
      storage: meta.storage,
      pubmed_citation_count_estimate: meta.pubmed_citation_count_estimate,
      disclaimer: meta.research_disclaimer,
    },
    pricing: {
      current_twap: latestTwap ? shapeCurrentTwap(latestTwap) : null,
      twap_history: historyRows.map(shapeHistoryItem),
      vendor_count: vendors.length,
      vendors,
    },
    verification,
  });
}

/* ─── helpers ──────────────────────────────────────────────────── */

function shapeCurrentTwap(row: {
  twap_value: string | number;
  computed_at: string;
  solana_signature: string | null;
  solana_slot: number | string | null;
  cluster: string | null;
  ipfs_cid?: string | null;
}): {
  twap_value: string;
  computed_at: string;
  solana_signature: string | null;
  solana_slot: number | null;
  cluster: SolanaCluster;
  solscan_url: string | null;
  ipfs_cid: string | null;
} {
  const c = rowCluster(row);
  return {
    twap_value: String(row.twap_value),
    computed_at: row.computed_at,
    solana_signature: row.solana_signature,
    solana_slot:
      row.solana_slot === null || row.solana_slot === undefined
        ? null
        : typeof row.solana_slot === 'string'
          ? Number(row.solana_slot)
          : row.solana_slot,
    cluster: c,
    solscan_url: row.solana_signature ? solscanUrl(row.solana_signature, c) : null,
    // `ipfs_cid` is the audit-trail anchor for this TWAP commit's full
    // observation set. Pinned by the oracle service after Solana
    // finalization (apps/oracle/src/ipfs/). Null when pinning is
    // disabled or has not yet succeeded for this row.
    ipfs_cid: row.ipfs_cid ?? null,
  };
}

function shapeHistoryItem(row: {
  id: string;
  twap_value: string | number;
  computed_at: string;
  window_start: string;
  window_end: string;
  observation_set_root: string;
  status: string;
  solana_signature: string | null;
  solana_slot: number | string | null;
  finalized_at: string | null;
  cluster: string | null;
  ipfs_cid?: string | null;
}): {
  twap_id: string;
  twap_value: string;
  computed_at: string;
  window_start: string;
  window_end: string;
  observation_set_root: string;
  status: string;
  cluster: SolanaCluster;
  solana: {
    signature: string;
    slot: number | null;
    cluster: SolanaCluster;
    solscan_url: string;
    explorer_url: string;
  } | null;
  finalized_at: string | null;
  ipfs_cid: string | null;
} {
  const c = rowCluster(row);
  return {
    twap_id: row.id,
    twap_value: String(row.twap_value),
    computed_at: row.computed_at,
    window_start: row.window_start,
    window_end: row.window_end,
    observation_set_root: row.observation_set_root,
    status: row.status,
    cluster: c,
    solana: row.solana_signature
      ? {
          signature: row.solana_signature,
          slot:
            row.solana_slot === null || row.solana_slot === undefined
              ? null
              : typeof row.solana_slot === 'string'
                ? Number(row.solana_slot)
                : row.solana_slot,
          cluster: c,
          solscan_url: solscanUrl(row.solana_signature, c),
          explorer_url: solanaExplorerUrl(row.solana_signature, c),
        }
      : null,
    finalized_at: row.finalized_at,
    ipfs_cid: row.ipfs_cid ?? null,
  };
}

function reduceVendors(rows: ObservationRow[]): VendorEntry[] {
  const latestPerSupplier = new Map<string | number, VendorEntry>();
  for (const row of rows) {
    if (latestPerSupplier.has(row.supplier_id)) continue;
    const name = extractSupplierName(row.suppliers);
    if (!name) continue;
    latestPerSupplier.set(row.supplier_id, {
      vendor_name: name,
      price_usd_per_mg: String(row.price_usd_per_mg),
      observed_at: row.observed_at,
    });
  }
  return [...latestPerSupplier.values()].sort(
    (a, b) => Number(a.price_usd_per_mg) - Number(b.price_usd_per_mg),
  );
}

function extractSupplierName(s: ObservationRow['suppliers']): string | null {
  if (!s) return null;
  if (Array.isArray(s)) return s[0]?.display_name ?? null;
  return s.display_name ?? null;
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string');
}

/* ─── exports for tests ────────────────────────────────────────── */

export const _internal = {
  CODE_RE,
  HISTORY_DAYS,
  reduceVendors,
  toStringArray,
  shapeCurrentTwap,
  shapeHistoryItem,
  rowCluster,
};
