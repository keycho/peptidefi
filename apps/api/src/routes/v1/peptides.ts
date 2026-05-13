import type { Request, Response } from 'express';
import { adminClientUntyped } from '../../supabase';
import { solscanUrl, solanaExplorerUrl, type SolanaCluster } from '../../oracle-config';
import { clusterQuerySchema } from '../../validators';
import { sendError } from '../../errors';

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

/**
 * GET /v1/peptides — discovery endpoint listing tracked peptides.
 *
 * Returns all peptides where `is_active=true` plus their most recent
 * finalized TWAP (if any). Mirrors §05.4.8 with two operator-friendly
 * additions: a peptide_id alongside the code (for clients that find
 * it easier to key off), and the Solscan URL for the latest TWAP
 * commit (saves a round-trip on the explorer page).
 *
 * GET /v1/peptides/:id — single peptide detail with last 7 days of
 * TWAP commits.
 *
 * `:id` accepts either the numeric `peptides.id` or the stable
 * `peptides.code` (e.g. "BPC157"). The code form is preferred since
 * it's the canonical cross-reference used in TWAP memos and on-chain
 * data; the numeric form is supported as a convenience.
 */

interface CurrentTwap {
  twap_value: string;
  computed_at: string;
  solana_signature: string | null;
  solana_slot: number | null;
  cluster: SolanaCluster | null;
  solscan_url: string | null;
  /** IPFS CID of the pinned cycle manifest (oracle service, fire-and-forget
   *  after Solana finalization). Null when pinning is disabled or pending. */
  ipfs_cid: string | null;
}

interface PeptideListItem {
  peptide_id: number;
  code: string;
  display_name: string;
  full_name: string;
  current_twap: CurrentTwap | null;
  twap_commits_count: number;
}

export async function listPeptidesHandler(req: Request, res: Response): Promise<void> {
  const parsedCluster = clusterQuerySchema.safeParse(req.query);
  if (!parsedCluster.success) {
    sendError(res, 400, 'BAD_REQUEST', parsedCluster.error.message);
    return;
  }
  const { cluster } = parsedCluster.data;
  const supabase = adminClientUntyped();

  // 1. Active peptides (one query).
  const { data: peptides, error: pErr } = await supabase
    .from('peptides')
    .select('id, code, display_name, full_name')
    .eq('is_active', true)
    .order('id', { ascending: true });
  if (pErr) {
    sendError(res, 500, 'DB_ERROR', `peptides query failed: ${pErr.message}`);
    return;
  }

  // 2. Latest finalized TWAP commit per peptide_code (one query;
  //    Postgres groups efficiently). We fetch all finalized rows then
  //    reduce in JS — Supabase's PostgREST has no DISTINCT ON helper
  //    surfaced in the JS client.
  let twapQuery = supabase
    .from('twap_commits')
    .select(
      'peptide_code, twap_value, computed_at, solana_signature, solana_slot, cluster, ipfs_cid',
    )
    .eq('status', 'finalized')
    .order('computed_at', { ascending: false });
  if (cluster !== undefined) {
    twapQuery = twapQuery.eq('cluster', cluster);
  }
  const { data: twaps, error: tErr } = await twapQuery;
  if (tErr) {
    sendError(res, 500, 'DB_ERROR', `twap_commits query failed: ${tErr.message}`);
    return;
  }
  const latestByCode = new Map<string, NonNullable<typeof twaps>[number]>();
  for (const t of twaps ?? []) {
    if (!latestByCode.has(t.peptide_code)) latestByCode.set(t.peptide_code, t);
  }

  // 3. Total commit count per peptide_code (one count query each
  //    would be N+1; use a single aggregated query via group).
  //    Postgres-via-PostgREST doesn't expose group-by directly, so
  //    we count from the same `twaps` array we already fetched.
  const countByCode = new Map<string, number>();
  for (const t of twaps ?? []) {
    countByCode.set(t.peptide_code, (countByCode.get(t.peptide_code) ?? 0) + 1);
  }

  const items: PeptideListItem[] = (peptides ?? []).map((p) => {
    const latest = latestByCode.get(p.code);
    const latestCluster = latest ? rowCluster(latest) : null;
    return {
      peptide_id: p.id,
      code: p.code,
      display_name: p.display_name,
      full_name: p.full_name,
      twap_commits_count: countByCode.get(p.code) ?? 0,
      current_twap: latest
        ? {
            twap_value: String(latest.twap_value),
            computed_at: latest.computed_at,
            solana_signature: latest.solana_signature,
            solana_slot: latest.solana_slot,
            cluster: latestCluster,
            solscan_url:
              latest.solana_signature && latestCluster
                ? solscanUrl(latest.solana_signature, latestCluster)
                : null,
            ipfs_cid: (latest as { ipfs_cid?: string | null }).ipfs_cid ?? null,
          }
        : null,
    };
  });

  res.json({ peptides: items, count: items.length });
}

export async function getPeptideHandler(req: Request, res: Response): Promise<void> {
  const idParam = req.params.id;
  if (!idParam) {
    sendError(res, 400, 'BAD_REQUEST', 'missing :id path parameter');
    return;
  }
  const parsedCluster = clusterQuerySchema.safeParse(req.query);
  if (!parsedCluster.success) {
    sendError(res, 400, 'BAD_REQUEST', parsedCluster.error.message);
    return;
  }
  const { cluster } = parsedCluster.data;
  const supabase = adminClientUntyped();

  // Resolve :id — accept either numeric id or the code string.
  const numericId = /^\d+$/.test(idParam) ? Number(idParam) : null;
  const query = supabase.from('peptides').select('id, code, display_name, full_name, is_active');
  const { data: peptide, error: pErr } = await (numericId !== null
    ? query.eq('id', numericId).maybeSingle()
    : query.eq('code', idParam).maybeSingle());
  if (pErr) {
    sendError(res, 500, 'DB_ERROR', `peptide lookup failed: ${pErr.message}`);
    return;
  }
  if (!peptide) {
    sendError(res, 404, 'NOT_FOUND', `peptide not found: ${idParam}`);
    return;
  }

  // TWAP history — last 7 days.
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  let historyQuery = supabase
    .from('twap_commits')
    .select(
      'id, peptide_code, twap_value, computed_at, window_start, window_end, observation_set_root, status, solana_signature, solana_slot, finalized_at, cluster, ipfs_cid',
    )
    .eq('peptide_code', peptide.code)
    .gte('computed_at', sevenDaysAgo)
    .order('computed_at', { ascending: false });
  if (cluster !== undefined) {
    historyQuery = historyQuery.eq('cluster', cluster);
  }
  const { data: history, error: hErr } = await historyQuery;
  if (hErr) {
    sendError(res, 500, 'DB_ERROR', `twap history failed: ${hErr.message}`);
    return;
  }

  res.json({
    peptide: {
      peptide_id: peptide.id,
      code: peptide.code,
      display_name: peptide.display_name,
      full_name: peptide.full_name,
      is_active: peptide.is_active,
    },
    twap_history: (history ?? []).map((t) => {
      const rowC = rowCluster(t);
      return {
        twap_id: t.id,
        twap_value: String(t.twap_value),
        computed_at: t.computed_at,
        window_start: t.window_start,
        window_end: t.window_end,
        observation_set_root: t.observation_set_root,
        status: t.status,
        cluster: rowC,
        solana: t.solana_signature
          ? {
              signature: t.solana_signature,
              slot: t.solana_slot,
              cluster: rowC,
              solscan_url: solscanUrl(t.solana_signature, rowC),
              explorer_url: solanaExplorerUrl(t.solana_signature, rowC),
            }
          : null,
        finalized_at: t.finalized_at,
        ipfs_cid: (t as { ipfs_cid?: string | null }).ipfs_cid ?? null,
      };
    }),
    history_window: { start: sevenDaysAgo, end: new Date().toISOString() },
  });
}
