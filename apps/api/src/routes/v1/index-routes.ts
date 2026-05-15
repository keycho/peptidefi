import type { Request, Response } from 'express';
import { z } from 'zod';
import { adminClientUntyped } from '../../supabase';
import { sendError } from '../../errors';

/**
 * GET /v1/index/current
 * GET /v1/index/history
 * GET /v1/index/components
 *
 * BioHash Peptide Index public read surface. The index level is
 * computed once per UTC hour by the oracle and stored in
 * public.index_history (see migration 0043 + apps/oracle/src/
 * index-history-runner.ts). Per-peptide contributions are
 * recoverable from public.twap_commits via the same hour_start key.
 *
 * Auth / rate-limit / cache: these endpoints inherit the /v1 limiter
 * mounted in app.ts (60 req/min/IP with X-Admin-Token bypass). Cache
 * TTL is set at the route-mount layer in app.ts so the same
 * convention as /v1/peptides / /v1/cycles applies; current=30s,
 * history=60s, components=30s, matching the source data's churn rate.
 */

const FROM_TO_SCHEMA = z
  .object({
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
  })
  .strict();

/** Inclusive. Public spec defaults to 30 days, caps at 365. */
const HISTORY_DEFAULT_DAYS = 30;
const HISTORY_MAX_DAYS = 365;

/**
 * GET /v1/index/current
 *
 * Latest row from index_history. Returns 200 with `index: null` when
 * the table is empty (pre-launch or first hour not yet complete). The
 * shape mirrors /v1/index/history items so consumers can reuse parsers.
 */
export async function getIndexCurrentHandler(
  _req: Request,
  res: Response,
): Promise<void> {
  const supabase = adminClientUntyped();
  const { data, error } = await supabase
    .from('index_history')
    .select(
      'hour_start, level, components_hash, computed_at, baseline_date, baseline_level, ipfs_cids',
    )
    .order('hour_start', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    sendError(res, 500, 'DB_ERROR', `index_history query failed: ${error.message}`);
    return;
  }
  res.json({
    index: data ? shapeIndexRow(data) : null,
  });
}

/**
 * GET /v1/index/history?from=&to=
 *
 * Time series of index levels. Defaults to the last 30 days, caps the
 * requested window at 365 days. `from` and `to` are ISO 8601 UTC.
 * Returns rows in ascending hour_start order (chart-friendly).
 */
export async function getIndexHistoryHandler(
  req: Request,
  res: Response,
): Promise<void> {
  const parsed = FROM_TO_SCHEMA.safeParse(req.query);
  if (!parsed.success) {
    sendError(res, 400, 'BAD_REQUEST', parsed.error.message);
    return;
  }
  const now = new Date();
  const requestedTo = parsed.data.to ? new Date(parsed.data.to) : now;
  const requestedFrom = parsed.data.from
    ? new Date(parsed.data.from)
    : new Date(requestedTo.getTime() - HISTORY_DEFAULT_DAYS * 24 * 60 * 60 * 1000);

  if (Number.isNaN(requestedFrom.getTime()) || Number.isNaN(requestedTo.getTime())) {
    sendError(res, 400, 'BAD_REQUEST', 'from/to must be valid ISO 8601 timestamps');
    return;
  }
  if (requestedFrom.getTime() > requestedTo.getTime()) {
    sendError(res, 400, 'BAD_REQUEST', 'from must be <= to');
    return;
  }
  // Cap the window at HISTORY_MAX_DAYS by trimming `from` forward if
  // the caller asked for too wide a range. Easier than 400-ing.
  const maxSpanMs = HISTORY_MAX_DAYS * 24 * 60 * 60 * 1000;
  const effectiveFrom =
    requestedTo.getTime() - requestedFrom.getTime() > maxSpanMs
      ? new Date(requestedTo.getTime() - maxSpanMs)
      : requestedFrom;

  const supabase = adminClientUntyped();
  const { data, error } = await supabase
    .from('index_history')
    .select(
      'hour_start, level, components_hash, computed_at, baseline_date, baseline_level, ipfs_cids',
    )
    .gte('hour_start', effectiveFrom.toISOString())
    .lte('hour_start', requestedTo.toISOString())
    .order('hour_start', { ascending: true });
  if (error) {
    sendError(res, 500, 'DB_ERROR', `index_history query failed: ${error.message}`);
    return;
  }
  res.json({
    history: (data ?? []).map(shapeIndexRow),
    window: {
      from: effectiveFrom.toISOString(),
      to: requestedTo.toISOString(),
      // Echo the cap back so clients know if their requested range
      // was trimmed.
      max_days: HISTORY_MAX_DAYS,
    },
  });
}

/**
 * GET /v1/index/components
 *
 * Per-peptide breakdown of the most recently computed index level.
 * For each cohort peptide, returns:
 *   - peptide_code
 *   - baseline_twap (from index_baselines)
 *   - current_twap (from the latest finalized twap_commits row at
 *     the same hour_start as index_history's latest row)
 *   - weight (1/N, decimal)
 *   - contribution ((current/baseline) * (baseline_level/N), the
 *     same per-peptide contribution that summed to index_history.level)
 *
 * Returns 200 with `components: []` when no index_history row exists.
 */
export async function getIndexComponentsHandler(
  _req: Request,
  res: Response,
): Promise<void> {
  const supabase = adminClientUntyped();
  const { data: latest, error: latestErr } = await supabase
    .from('index_history')
    .select('hour_start, level, components_hash, computed_at, baseline_date, baseline_level')
    .order('hour_start', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (latestErr) {
    sendError(res, 500, 'DB_ERROR', `index_history query failed: ${latestErr.message}`);
    return;
  }
  if (!latest) {
    res.json({ index: null, components: [] });
    return;
  }

  const { data: baselines, error: bErr } = await supabase
    .from('index_baselines')
    .select('peptide_code, baseline_twap, baseline_date, actual_baseline_date')
    .order('peptide_code', { ascending: true });
  if (bErr) {
    sendError(res, 500, 'DB_ERROR', `index_baselines query failed: ${bErr.message}`);
    return;
  }
  if (!baselines || baselines.length === 0) {
    res.json({ index: shapeIndexRow(latest), components: [] });
    return;
  }
  const N = baselines.length;
  const baselineLevel = Number(latest.baseline_level);
  const perWeight = 1 / N;
  const perBucket = baselineLevel / N;

  const { data: twaps, error: tErr } = await supabase
    .from('twap_commits')
    .select('peptide_code, twap_value')
    .eq('status', 'finalized')
    .eq('computed_at', latest.hour_start);
  if (tErr) {
    sendError(res, 500, 'DB_ERROR', `twap_commits query failed: ${tErr.message}`);
    return;
  }
  const twapByCode = new Map<string, number>();
  for (const t of twaps ?? []) {
    twapByCode.set(t.peptide_code, Number(t.twap_value));
  }

  const components = baselines.map((b) => {
    const baselineTwap = Number(b.baseline_twap);
    const currentTwap = twapByCode.get(b.peptide_code);
    const contribution =
      currentTwap !== undefined &&
      Number.isFinite(currentTwap) &&
      Number.isFinite(baselineTwap) &&
      baselineTwap > 0
        ? (currentTwap / baselineTwap) * perBucket
        : null;
    return {
      peptide_code: b.peptide_code,
      baseline_twap: String(b.baseline_twap),
      baseline_date: b.baseline_date,
      actual_baseline_date: b.actual_baseline_date,
      current_twap: currentTwap === undefined ? null : currentTwap,
      weight: perWeight,
      contribution,
    };
  });

  res.json({
    index: shapeIndexRow(latest),
    components,
  });
}

function shapeIndexRow(row: {
  hour_start: string;
  level: number | string;
  components_hash: string;
  computed_at: string;
  baseline_date: string;
  baseline_level: number | string;
  ipfs_cids?: string[] | null;
}): {
  hour_start: string;
  level: number;
  components_hash: string;
  computed_at: string;
  baseline_date: string;
  baseline_level: number;
  ipfs_cids: string[] | null;
} {
  return {
    hour_start: row.hour_start,
    level: Number(row.level),
    components_hash: row.components_hash,
    computed_at: row.computed_at,
    baseline_date: row.baseline_date,
    baseline_level: Number(row.baseline_level),
    ipfs_cids: row.ipfs_cids ?? null,
  };
}
