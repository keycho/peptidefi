import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';

/**
 * Tests for GET /v1/research/:code (BioHash Peptide Research Index).
 *
 * Pinned contracts:
 *   1. 400 for codes that don't match the ^[A-Z0-9]{2,16}$ pattern.
 *   2. 404 when the peptide code is unknown.
 *   3. 404 when the peptide exists but has no research_metadata row
 *      (a missing row is the canonical "not indexed" signal — we
 *      explicitly do NOT want to leak skeleton pages).
 *   4. 200 + the documented shape when both the peptide and its
 *      metadata exist; the response merges curated metadata,
 *      pricing context, and a verification anchor.
 *   5. Cache-Control: public, max-age=300 on every 200.
 *
 * The handler is exercised with a hand-rolled supabase mock that
 * scripts the per-table responses in the order the handler calls
 * them. The shape of the mock mirrors the established pattern in
 * anomalies-stats.test.ts.
 */

vi.mock('../supabase', () => {
  return {
    adminClientUntyped: () => ({
      from(table: string) {
        const builder: Record<string, unknown> = {
          // chainable builders — every method returns the builder so
          // any call ordering inside the handler is supported.
          select(_cols: string) {
            return builder;
          },
          eq(_col: string, _val: unknown) {
            return builder;
          },
          gte(_col: string, _val: unknown) {
            return builder;
          },
          lte(_col: string, _val: unknown) {
            return builder;
          },
          not(_col: string, _op: string, _val: unknown) {
            return builder;
          },
          order(_col: string, _opts: unknown) {
            return builder;
          },
          limit(_n: number) {
            return builder;
          },
          maybeSingle() {
            // maybeSingle returns the row from globalThis.__researchResolver
            // for tables where the handler uses .maybeSingle().
            return Promise.resolve(globalThis.__researchResolver!(table));
          },
          then(onF: (v: { data: unknown; error: unknown }) => unknown) {
            // Plain await on a builder — used for the list-style
            // queries (history, observations, current twap, cycle
            // lookup).
            return Promise.resolve(globalThis.__researchResolver!(table)).then(onF);
          },
        };
        return builder;
      },
    }),
  };
});

declare global {
  // eslint-disable-next-line no-var
  var __researchResolver: ((table: string) => { data: unknown; error: unknown }) | undefined;
}

function setResolver(fn: (table: string) => { data: unknown; error: unknown }): void {
  globalThis.__researchResolver = fn;
}

beforeEach(() => {
  globalThis.__researchResolver = undefined;
});

afterEach(() => {
  globalThis.__researchResolver = undefined;
});

function makeReq(code: string, query: Record<string, string> = {}): Request {
  return {
    params: { code },
    query,
  } as unknown as Request;
}

function makeRes(): {
  res: Response;
  status: () => number | undefined;
  body: () => Record<string, unknown> | undefined;
  headers: () => Record<string, string>;
} {
  let statusCode: number | undefined;
  let payload: Record<string, unknown> | undefined;
  const headers: Record<string, string> = {};
  const res = {
    status(code: number) {
      statusCode = code;
      return this;
    },
    set(name: string, value: string) {
      headers[name.toLowerCase()] = value;
      return this;
    },
    json(b: Record<string, unknown>) {
      payload = b;
      return this;
    },
  } as unknown as Response;
  return {
    res,
    status: () => statusCode,
    body: () => payload,
    headers: () => headers,
  };
}

const PEPTIDE_ROW = {
  id: 2,
  code: 'BPC157',
  display_name: 'BPC-157',
  full_name: 'Body Protection Compound 157',
  is_active: true,
};

const META_ROW = {
  peptide_code: 'BPC157',
  overview: 'BPC-157 is a synthetic 15-amino-acid peptide ...',
  mechanism: 'Studies suggest BPC-157 may interact with NO signaling ...',
  applications: ['Tendon and ligament repair research', 'Gastrointestinal mucosal research'],
  half_life_estimate: 'Half-life in rodent serum has been reported ...',
  storage: 'Lyophilized powder typically stored at -20°C ...',
  sequence: 'GEPPPGKPADDAGLV',
  molecular_weight: '1419.53',
  aliases: ['Body Protection Compound 157', 'BPC 157'],
  full_name: 'Body Protection Compound 157',
  pubmed_citation_count_estimate: 400,
  research_disclaimer:
    'For research and informational purposes only. Not medical advice. Not for human consumption unless prescribed by a licensed physician.',
};

const HISTORY_ROW = {
  id: '11111111-1111-4111-8111-111111111111',
  twap_value: '6.699',
  computed_at: '2026-05-11T15:00:00+00:00',
  window_start: '2026-05-11T14:30:00+00:00',
  window_end: '2026-05-11T15:00:00+00:00',
  observation_set_root: '0xroot',
  status: 'finalized',
  solana_signature: 'sig-history',
  solana_slot: 419063387,
  finalized_at: '2026-05-11T15:03:00Z',
  cluster: 'mainnet-beta',
};

const LATEST_TWAP_ROW = {
  twap_value: '6.699',
  computed_at: '2026-05-11T15:00:00+00:00',
  solana_signature: 'sig-current',
  solana_slot: 419063387,
  cluster: 'mainnet-beta',
};

const OBS_ROW = {
  supplier_id: 7,
  scraper_run_id: 1259,
  price_usd_per_mg: '5.20',
  observed_at: '2026-05-11T15:26:58.22+00:00',
  suppliers: { display_name: 'Liberty Peptides' },
};

const CYCLE_ROW = {
  cycle_id: 1259,
  solana_signature: 'sig-cycle',
  status: 'finalized',
  cluster: 'mainnet-beta',
};

describe('research handler — input validation', () => {
  it('400 for code with invalid characters', async () => {
    const { getResearchHandler } = await import('../routes/v1/research');
    setResolver(() => ({ data: null, error: null }));
    const { res, status, body } = makeRes();
    await getResearchHandler(makeReq('bp c'), res);
    expect(status()).toBe(400);
    expect((body() as { code: string }).code).toBe('BAD_REQUEST');
  });

  it('400 for code too short', async () => {
    const { getResearchHandler } = await import('../routes/v1/research');
    setResolver(() => ({ data: null, error: null }));
    const { res, status } = makeRes();
    await getResearchHandler(makeReq('X'), res);
    expect(status()).toBe(400);
  });

  it('uppercases :code before lookup (case-insensitive entry)', async () => {
    const { getResearchHandler } = await import('../routes/v1/research');
    setResolver((table) => {
      if (table === 'peptides') return { data: PEPTIDE_ROW, error: null };
      if (table === 'peptide_research_metadata') return { data: META_ROW, error: null };
      if (table === 'supplier_observations') return { data: [OBS_ROW], error: null };
      if (table === 'commit_cycles') return { data: [CYCLE_ROW], error: null };
      if (table === 'twap_commits') return { data: [LATEST_TWAP_ROW], error: null };
      return { data: null, error: null };
    });
    const { res, status, body } = makeRes();
    await getResearchHandler(makeReq('bpc157'), res);
    expect(status()).toBeUndefined(); // 200 default (we don't call .status)
    expect((body() as { peptide: { code: string } }).peptide.code).toBe('BPC157');
  });
});

describe('research handler — 404 contracts', () => {
  it('returns 404 when peptide code is unknown', async () => {
    const { getResearchHandler } = await import('../routes/v1/research');
    setResolver((table) => {
      if (table === 'peptides') return { data: null, error: null };
      return { data: null, error: null };
    });
    const { res, status, body } = makeRes();
    await getResearchHandler(makeReq('ZZZZ'), res);
    expect(status()).toBe(404);
    const b = body() as { code: string; message: string };
    expect(b.code).toBe('NOT_FOUND');
    expect(b.message).toContain('ZZZZ');
  });

  it('returns 404 when peptide exists but has no research_metadata row', async () => {
    const { getResearchHandler } = await import('../routes/v1/research');
    setResolver((table) => {
      if (table === 'peptides') return { data: PEPTIDE_ROW, error: null };
      if (table === 'peptide_research_metadata') return { data: null, error: null };
      return { data: null, error: null };
    });
    const { res, status, body } = makeRes();
    await getResearchHandler(makeReq('BPC157'), res);
    expect(status()).toBe(404);
    const b = body() as { code: string; message: string };
    expect(b.code).toBe('NOT_FOUND');
    expect(b.message).toContain('not indexed');
  });
});

describe('research handler — happy path response shape', () => {
  function fullResolver(table: string): { data: unknown; error: unknown } {
    if (table === 'peptides') return { data: PEPTIDE_ROW, error: null };
    if (table === 'peptide_research_metadata') return { data: META_ROW, error: null };
    if (table === 'twap_commits') return { data: [HISTORY_ROW], error: null };
    // Latest TWAP query also hits twap_commits but with .limit(1); our
    // resolver returns the same fixture for both — the handler reads
    // [0] for current, the full array for history.
    if (table === 'supplier_observations') return { data: [OBS_ROW], error: null };
    if (table === 'commit_cycles') return { data: [CYCLE_ROW], error: null };
    return { data: null, error: null };
  }

  it('returns 200 with the documented shape for BPC157', async () => {
    const { getResearchHandler } = await import('../routes/v1/research');
    setResolver(fullResolver);
    const { res, body, headers } = makeRes();
    await getResearchHandler(makeReq('BPC157'), res);

    const b = body() as {
      peptide: {
        code: string;
        display_name: string;
        full_name: string;
        aliases: string[];
        sequence: string | null;
        molecular_weight: number | null;
      };
      research: {
        overview: string;
        applications: string[];
        pubmed_citation_count_estimate: number | null;
        disclaimer: string;
      };
      pricing: {
        current_twap: { twap_value: string; cluster: string } | null;
        twap_history: unknown[];
        vendor_count: number;
        vendors: Array<{ vendor_name: string }>;
      };
      verification: {
        latest_cycle_id: number;
        latest_solana_signature: string;
        verified_at_commitment: string;
        solscan_url: string;
      };
    };
    expect(b).toBeDefined();
    expect(b.peptide.code).toBe('BPC157');
    expect(b.peptide.display_name).toBe('BPC-157');
    expect(b.peptide.full_name).toBe('Body Protection Compound 157');
    expect(b.peptide.sequence).toBe('GEPPPGKPADDAGLV');
    expect(b.peptide.molecular_weight).toBe(1419.53);
    expect(b.peptide.aliases).toEqual(['Body Protection Compound 157', 'BPC 157']);

    expect(typeof b.research.overview).toBe('string');
    expect(b.research.applications).toEqual([
      'Tendon and ligament repair research',
      'Gastrointestinal mucosal research',
    ]);
    expect(b.research.pubmed_citation_count_estimate).toBe(400);
    expect(b.research.disclaimer).toContain('research');

    expect(b.pricing.current_twap?.twap_value).toBe('6.699');
    expect(b.pricing.current_twap?.cluster).toBe('mainnet-beta');
    expect(b.pricing.twap_history).toHaveLength(1);
    expect(b.pricing.vendor_count).toBe(1);
    expect(b.pricing.vendors[0]!.vendor_name).toBe('Liberty Peptides');

    expect(b.verification.latest_cycle_id).toBe(1259);
    expect(b.verification.latest_solana_signature).toBe('sig-cycle');
    expect(b.verification.verified_at_commitment).toBe('finalized');
    expect(b.verification.solscan_url).toContain('solscan.io/tx/sig-cycle');

    // Cache-Control pin.
    expect(headers()['cache-control']).toBe('public, max-age=300');
  });

  it('verification block is null-shaped when no observations exist for the peptide', async () => {
    const { getResearchHandler } = await import('../routes/v1/research');
    setResolver((table) => {
      if (table === 'peptides') return { data: PEPTIDE_ROW, error: null };
      if (table === 'peptide_research_metadata') return { data: META_ROW, error: null };
      if (table === 'twap_commits') return { data: [], error: null };
      if (table === 'supplier_observations') return { data: [], error: null };
      if (table === 'commit_cycles') return { data: [], error: null };
      return { data: null, error: null };
    });
    const { res, body } = makeRes();
    await getResearchHandler(makeReq('BPC157'), res);
    const b = body() as { verification: Record<string, unknown> };
    expect(b.verification.latest_cycle_id).toBeNull();
    expect(b.verification.latest_solana_signature).toBeNull();
    expect(b.verification.verified_at_commitment).toBeNull();
    expect(b.verification.solscan_url).toBeNull();
  });
});

describe('research handler — pure helpers', () => {
  it('reduceVendors keeps the latest observation per supplier and sorts by price asc', async () => {
    const { _internal } = await import('../routes/v1/research');
    const { reduceVendors } = _internal;
    const reduced = reduceVendors([
      // Two obs for supplier 1 — the first (newest) should win
      {
        supplier_id: 1,
        scraper_run_id: 100,
        price_usd_per_mg: 10,
        observed_at: '2026-05-11T15:00:00Z',
        suppliers: { display_name: 'Vendor A' },
      },
      {
        supplier_id: 1,
        scraper_run_id: 99,
        price_usd_per_mg: 99,
        observed_at: '2026-05-11T14:00:00Z',
        suppliers: { display_name: 'Vendor A' },
      },
      {
        supplier_id: 2,
        scraper_run_id: 100,
        price_usd_per_mg: 5,
        observed_at: '2026-05-11T15:00:00Z',
        suppliers: { display_name: 'Vendor B' },
      },
    ]);
    expect(reduced).toHaveLength(2);
    expect(reduced[0]!.vendor_name).toBe('Vendor B'); // 5 < 10
    expect(reduced[1]!.vendor_name).toBe('Vendor A');
    expect(reduced[1]!.price_usd_per_mg).toBe('10'); // kept the newest row
  });

  it('toStringArray defends against null / non-array jsonb shapes', async () => {
    const { _internal } = await import('../routes/v1/research');
    const { toStringArray } = _internal;
    expect(toStringArray(null)).toEqual([]);
    expect(toStringArray(undefined)).toEqual([]);
    expect(toStringArray('not an array')).toEqual([]);
    expect(toStringArray(['a', 1, 'b'])).toEqual(['a', 'b']);
  });

  it("rowCluster normalises 'mainnet' to 'mainnet-beta'", async () => {
    const { _internal } = await import('../routes/v1/research');
    const { rowCluster } = _internal;
    expect(rowCluster({ cluster: 'mainnet' })).toBe('mainnet-beta');
    expect(rowCluster({ cluster: 'mainnet-beta' })).toBe('mainnet-beta');
    expect(rowCluster({ cluster: 'devnet' })).toBe('devnet');
    expect(rowCluster({ cluster: null })).toBe('devnet');
  });
});

/* ─── IPFS CID surfacing ──────────────────────────────────────────
 *
 * After migration 0042, every twap_commits row carries an `ipfs_cid`
 * column (nullable). The research handler must surface it on both
 * pricing.current_twap and every pricing.twap_history[] entry so
 * verifiers can fetch the off-chain manifest without going through
 * the DB. Null when pinning is disabled / pending — both states are
 * normal under the spec.
 */
describe('research handler — ipfs_cid contract', () => {
  it('exposes ipfs_cid on current_twap and twap_history rows', async () => {
    const { getResearchHandler } = await import('../routes/v1/research');
    const CID = 'bafytestcurrentcidexampleexampleexampleexample';
    const HISTORY_CID = 'bafytesthistorycidexampleexampleexampleexample';
    setResolver((table) => {
      if (table === 'peptides') return { data: PEPTIDE_ROW, error: null };
      if (table === 'peptide_research_metadata') return { data: META_ROW, error: null };
      if (table === 'twap_commits')
        return {
          data: [{ ...HISTORY_ROW, ipfs_cid: HISTORY_CID }],
          error: null,
        };
      if (table === 'supplier_observations') return { data: [OBS_ROW], error: null };
      if (table === 'commit_cycles') return { data: [CYCLE_ROW], error: null };
      return { data: null, error: null };
    });
    const { res, body } = makeRes();
    await getResearchHandler(makeReq('BPC157'), res);
    const b = body() as {
      pricing: {
        current_twap: { ipfs_cid: string | null };
        twap_history: Array<{ ipfs_cid: string | null }>;
      };
    };
    // current_twap fetches the same fixture row (resolver returns the same
    // shape for the limit(1) query); historical rows pass through the
    // history mapper.
    expect(b.pricing.current_twap.ipfs_cid).toBe(HISTORY_CID);
    expect(b.pricing.twap_history[0]?.ipfs_cid).toBe(HISTORY_CID);
  });

  it('returns ipfs_cid: null when the column is absent on the row', async () => {
    const { getResearchHandler } = await import('../routes/v1/research');
    setResolver((table) => {
      if (table === 'peptides') return { data: PEPTIDE_ROW, error: null };
      if (table === 'peptide_research_metadata') return { data: META_ROW, error: null };
      if (table === 'twap_commits') return { data: [HISTORY_ROW], error: null };
      if (table === 'supplier_observations') return { data: [OBS_ROW], error: null };
      if (table === 'commit_cycles') return { data: [CYCLE_ROW], error: null };
      return { data: null, error: null };
    });
    const { res, body } = makeRes();
    await getResearchHandler(makeReq('BPC157'), res);
    const b = body() as {
      pricing: {
        current_twap: { ipfs_cid: string | null };
        twap_history: Array<{ ipfs_cid: string | null }>;
      };
    };
    expect(b.pricing.current_twap.ipfs_cid).toBeNull();
    expect(b.pricing.twap_history[0]?.ipfs_cid).toBeNull();
  });
});
