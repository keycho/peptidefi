import { describe, expect, it } from 'vitest';
import { buildCycleManifest } from '../ipfs/manifest-builder';

/**
 * Unit tests for buildCycleManifest.
 *
 * The function executes two SQL queries via the `sql` template tag:
 *   1. SELECT FROM peptide_twaps (joined to peptides) — returns the
 *      shell row with twap_id + input_observation_ids + dropped.
 *   2. SELECT FROM supplier_observations (joined to suppliers + products)
 *      — returns one row per observation.
 *
 * We script both queries by serving the next response from a queue
 * and asserting on:
 *   - manifest field shape (matches CycleManifest interface)
 *   - per-observation deviation_from_median_bps math
 *   - included_in_twap=true for input_observation_ids
 *   - included_in_twap=false + generic exclusion_reason for dropped
 *   - stable ordering: included first then dropped, by observation id
 */

function makeSqlMock(responses: unknown[][]): {
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown[]>;
  callCount: () => number;
} {
  let callIndex = 0;
  const sql = (..._: unknown[]): Promise<unknown[]> => {
    const next = responses[callIndex];
    callIndex += 1;
    if (!next) {
      return Promise.reject(new Error(`makeSqlMock: no response queued for call #${callIndex}`));
    }
    return Promise.resolve(next);
  };
  return {
    sql: sql as unknown as (s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown[]>,
    callCount: () => callIndex,
  };
}

describe('buildCycleManifest', () => {
  it('assembles a v1.0 manifest with included + dropped observations and computes deviation_from_median_bps', async () => {
    // peptide_twaps shell row: BPC157, 2 included (ids 1,2), 1 dropped (id 3).
    const shellRows = [
      {
        twap_id: 4242,
        input_observation_ids: [1, 2],
        dropped_observation_ids: [3],
      },
    ];
    // supplier_observations join: 3 rows. Median price ≈ 6.50 (the input
    // set's median, NOT the TWAP — buildCycleManifest uses the args.twap_value
    // for deviation math, which matches what the oracle commits on-chain).
    const obsRows = [
      {
        observation_id: 1,
        observed_at: new Date('2026-05-13T17:55:00.000Z'),
        raw_price: '30.00',
        fx_rate_to_usd: '1.00',
        price_usd_per_mg: '3.000000',
        vendor_code: 'PUREHEALTH',
        vendor_url: 'https://example.com/p1',
        pack_size_mg: '10.000000',
      },
      {
        observation_id: 2,
        observed_at: new Date('2026-05-13T17:56:00.000Z'),
        raw_price: '100.00',
        fx_rate_to_usd: '1.00',
        price_usd_per_mg: '10.000000',
        vendor_code: 'GENETIC',
        vendor_url: 'https://example.com/p2',
        pack_size_mg: '10.000000',
      },
      {
        observation_id: 3,
        observed_at: new Date('2026-05-13T17:57:00.000Z'),
        raw_price: '150.00',
        fx_rate_to_usd: '1.00',
        price_usd_per_mg: '15.000000',
        vendor_code: 'PEPTIDELABS',
        vendor_url: 'https://example.com/p3',
        pack_size_mg: '10.000000',
      },
    ];
    const { sql, callCount } = makeSqlMock([shellRows, obsRows]);

    const m = await buildCycleManifest(sql as never, {
      peptide_code: 'BPC157',
      computed_at: new Date('2026-05-13T18:00:00.000Z'),
      twap_value: '6.500000',
      observation_set_root: '0xaabbccddeeff00112233445566778899aabbccddeeff00112233445566778899',
      solana_signature: '3tYeH9wTcDfo',
      solana_slot: 419467611,
    });

    expect(callCount()).toBe(2);
    expect(m.version).toBe('1.0');
    expect(m.peptide_code).toBe('BPC157');
    expect(m.cycle_id).toBe(4242);
    expect(m.algorithm).toBe('filtered_median_v1');
    expect(m.twap_unit).toBe('USD/mg');
    expect(m.twap_value).toBeCloseTo(6.5);
    expect(m.solana_signature).toBe('3tYeH9wTcDfo');
    expect(m.solana_slot).toBe(419467611);
    expect(m.merkle_root).toBe(
      '0xaabbccddeeff00112233445566778899aabbccddeeff00112233445566778899',
    );
    expect(m.computed_at).toBe('2026-05-13T18:00:00.000Z');

    // Stable ordering: included first (ids 1, 2 ascending), then dropped (id 3).
    expect(m.observations).toHaveLength(3);
    expect(m.observations.map((o) => o.vendor_code)).toEqual([
      'PUREHEALTH',
      'GENETIC',
      'PEPTIDELABS',
    ]);

    // included_in_twap flags + exclusion_reason
    expect(m.observations[0]).toMatchObject({
      included_in_twap: true,
      exclusion_reason: null,
    });
    expect(m.observations[1]).toMatchObject({
      included_in_twap: true,
      exclusion_reason: null,
    });
    expect(m.observations[2]).toMatchObject({
      included_in_twap: false,
      exclusion_reason: 'excluded_by_filtered_median_v1',
    });

    // deviation_from_median_bps math:
    //   twap = 6.5
    //   obs1: |3.0 - 6.5| / 6.5 = 0.5384...  → 5385 bps
    //   obs2: |10.0 - 6.5| / 6.5 = 0.5384... → 5385 bps
    //   obs3: |15.0 - 6.5| / 6.5 = 1.3076... → 13077 bps
    expect(m.observations[0]!.deviation_from_median_bps).toBe(5385);
    expect(m.observations[1]!.deviation_from_median_bps).toBe(5385);
    expect(m.observations[2]!.deviation_from_median_bps).toBe(13077);

    // vendor_url + price_usd_per_mg passthrough
    expect(m.observations[0]).toMatchObject({
      vendor_url: 'https://example.com/p1',
      price_usd_per_mg: 3,
      pack_size_mg: 10,
      raw_price_usd: 30,
      observed_at: '2026-05-13T17:55:00.000Z',
    });
  });

  it('returns deviation_from_median_bps=null when twap_value is zero (degenerate)', async () => {
    const shellRows = [{ twap_id: 1, input_observation_ids: [1], dropped_observation_ids: [] }];
    const obsRows = [
      {
        observation_id: 1,
        observed_at: new Date('2026-05-13T17:55:00.000Z'),
        raw_price: '0',
        fx_rate_to_usd: '1',
        price_usd_per_mg: '0.000000',
        vendor_code: 'X',
        vendor_url: 'https://x.example',
        pack_size_mg: '1',
      },
    ];
    const { sql } = makeSqlMock([shellRows, obsRows]);

    const m = await buildCycleManifest(sql as never, {
      peptide_code: 'X',
      computed_at: new Date('2026-05-13T18:00:00.000Z'),
      twap_value: '0',
      observation_set_root: '0x' + '00'.repeat(32),
      solana_signature: 'sig',
      solana_slot: 1,
    });
    expect(m.observations[0]!.deviation_from_median_bps).toBeNull();
  });

  it('throws if peptide_twaps row is missing (schema corruption)', async () => {
    const { sql } = makeSqlMock([[]]); // empty shell rows
    await expect(
      buildCycleManifest(sql as never, {
        peptide_code: 'MISSING',
        computed_at: new Date('2026-05-13T18:00:00.000Z'),
        twap_value: '1',
        observation_set_root: '0x' + '00'.repeat(32),
        solana_signature: 'sig',
        solana_slot: 1,
      }),
    ).rejects.toThrow(/no peptide_twaps row/);
  });

  it('handles postgres text-array shape for id arrays ({1001,1002})', async () => {
    const shellRows = [
      {
        twap_id: 1,
        input_observation_ids: '{10,20}',
        dropped_observation_ids: '{}',
      },
    ];
    const obsRows = [
      {
        observation_id: 10,
        observed_at: new Date('2026-05-13T17:55:00.000Z'),
        raw_price: '10',
        fx_rate_to_usd: '1',
        price_usd_per_mg: '1.000000',
        vendor_code: 'A',
        vendor_url: 'https://a.example',
        pack_size_mg: '10',
      },
      {
        observation_id: 20,
        observed_at: new Date('2026-05-13T17:55:00.000Z'),
        raw_price: '20',
        fx_rate_to_usd: '1',
        price_usd_per_mg: '2.000000',
        vendor_code: 'B',
        vendor_url: 'https://b.example',
        pack_size_mg: '10',
      },
    ];
    const { sql } = makeSqlMock([shellRows, obsRows]);
    const m = await buildCycleManifest(sql as never, {
      peptide_code: 'Z',
      computed_at: new Date('2026-05-13T18:00:00.000Z'),
      twap_value: '1.5',
      observation_set_root: '0x' + '00'.repeat(32),
      solana_signature: 'sig',
      solana_slot: 1,
    });
    expect(m.observations).toHaveLength(2);
    expect(m.observations.every((o) => o.included_in_twap)).toBe(true);
  });
});
