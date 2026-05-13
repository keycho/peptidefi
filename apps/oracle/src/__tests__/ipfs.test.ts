import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import {
  _resetPinataWarningStateForTests,
  isPinataConfigured,
  pinCycleToIPFS,
  type CycleManifest,
} from '../ipfs/pinata';

/**
 * Unit tests for the Pinata IPFS client.
 *
 * Covers:
 *   1. Successful pin returns {cid, size, pinnedAt}.
 *   2. Pinata error response throws with status + body context.
 *   3. Missing PINATA_JWT throws a clear "not set" error.
 *   4. isPinataConfigured() reads env and emits one-time warning.
 *   5. Request shape: Authorization header, JSON content-type,
 *      pinataMetadata + pinataOptions + pinataContent body.
 *   6. Malformed Pinata response (no IpfsHash) throws.
 *
 * A gated INTEGRATION test (real HTTP to Pinata) lives at the bottom
 * of this file behind `it.skipIf(!process.env.PINATA_JWT)` so CI runs
 * the mock-based tests offline and any contributor with PINATA_JWT in
 * .env catches integration regressions the mocks can't see (wrong
 * URL, wrong auth header format, wrong response field names).
 */

const SAMPLE_MANIFEST: CycleManifest = {
  version: '1.0',
  peptide_code: 'BPC157',
  cycle_id: 4242,
  computed_at: '2026-05-13T18:00:00.000Z',
  twap_value: 6.699,
  twap_unit: 'USD/mg',
  algorithm: 'filtered_median_v1',
  merkle_root: '0x1111111111111111111111111111111111111111111111111111111111111111',
  solana_signature: '3tYeH9wTcDfo3WHX6S2s3JhLTkgP289s8jbUoXWsx1hX',
  solana_slot: 419467611,
  observations: [
    {
      vendor_code: 'PUREHEALTH',
      vendor_url: 'https://example.com/products/bpc157-5mg',
      raw_price_usd: 18.0,
      pack_size_mg: 5,
      price_usd_per_mg: 3.6,
      observed_at: '2026-05-13T17:55:00.000Z',
      included_in_twap: true,
      exclusion_reason: null,
      deviation_from_median_bps: 4612,
    },
  ],
};

beforeEach(() => {
  vi.restoreAllMocks();
  _resetPinataWarningStateForTests();
  // Each test sets its own JWT state to avoid leaking between tests.
  delete process.env.PINATA_JWT;
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.PINATA_JWT;
});

describe('isPinataConfigured', () => {
  it('returns false when PINATA_JWT is unset', () => {
    expect(isPinataConfigured()).toBe(false);
  });

  it('returns false on empty string', () => {
    process.env.PINATA_JWT = '';
    expect(isPinataConfigured()).toBe(false);
  });

  it('returns true on a non-empty JWT', () => {
    process.env.PINATA_JWT = 'eyJ.test.token';
    expect(isPinataConfigured()).toBe(true);
  });

  it('emits a one-time warning on the first unset probe per process', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(isPinataConfigured()).toBe(false);
    expect(isPinataConfigured()).toBe(false);
    expect(isPinataConfigured()).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatch(/PINATA_JWT not set/);
  });
});

describe('pinCycleToIPFS — happy path', () => {
  it('POSTs to the documented Pinata URL with Bearer JWT and returns the parsed CID', async () => {
    process.env.PINATA_JWT = 'eyJ.test.token';
    const fetchMock = vi.fn(async () =>
      jsonResponse(200, {
        IpfsHash: 'bafyfakecidforunittest',
        PinSize: 1234,
        Timestamp: '2026-05-13T18:05:00.000Z',
      }),
    );

    const result = await pinCycleToIPFS(SAMPLE_MANIFEST, {
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(result).toEqual({
      cid: 'bafyfakecidforunittest',
      size: 1234,
      pinnedAt: '2026-05-13T18:05:00.000Z',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    // vi.fn() returns calls typed as unknown[][]; cast through to read.
    const call = (fetchMock.mock.calls[0] as unknown as [unknown, RequestInit])!;
    const [url, init] = call;
    expect(url).toBe('https://api.pinata.cloud/pinning/pinJSONToIPFS');
    expect(init?.method).toBe('POST');
    const headers = init?.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer eyJ.test.token');
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('body includes pinataContent, pinataMetadata (name + keyvalues), pinataOptions cidVersion=1', async () => {
    process.env.PINATA_JWT = 'eyJ.test.token';
    let captured: unknown = null;
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      captured = JSON.parse(String(init?.body ?? '{}'));
      return jsonResponse(200, {
        IpfsHash: 'bafycid',
        PinSize: 100,
        Timestamp: '2026-05-13T18:00:00.000Z',
      });
    });

    await pinCycleToIPFS(SAMPLE_MANIFEST, {
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(captured).toMatchObject({
      pinataContent: { peptide_code: 'BPC157', cycle_id: 4242, version: '1.0' },
      pinataMetadata: {
        name: 'biohash-cycle-4242-BPC157',
        keyvalues: {
          app: 'biohash',
          type: 'oracle_cycle',
          peptide: 'BPC157',
          cycle_id: '4242',
        },
      },
      pinataOptions: { cidVersion: 1 },
    });
  });

  it('falls back to new Date().toISOString() when Pinata omits Timestamp', async () => {
    process.env.PINATA_JWT = 'eyJ.test.token';
    const fetchMock = vi.fn(async () =>
      jsonResponse(200, {
        IpfsHash: 'bafycid',
        PinSize: 100,
        // No Timestamp field.
      }),
    );

    const before = Date.now();
    const result = await pinCycleToIPFS(SAMPLE_MANIFEST, {
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    const after = Date.now();
    const t = Date.parse(result.pinnedAt);
    expect(t).toBeGreaterThanOrEqual(before);
    expect(t).toBeLessThanOrEqual(after);
  });
});

/*
 * Regression: in production we hit
 *   TypeError: Cannot convert argument to a ByteString because the
 *   character at index N has a value of M which is greater than 255.
 * whenever a vendor URL or display string contained a non-Latin-1
 * character — most commonly U+2028 LINE SEPARATOR, U+2029 PARAGRAPH
 * SEPARATOR, em-dashes, accented characters. Node's `fetch` body
 * coercion to ByteString rejects any code point > 255. The fix is
 * to escape every non-ASCII code point as `\uXXXX` before sending.
 * These tests pin that behaviour so we never regress to a transport
 * that throws on real-world vendor data.
 */
describe('pinCycleToIPFS — non-ASCII body transport (U+2028 regression)', () => {
  it('escapes U+2028 LINE SEPARATOR in vendor_url so the body is ASCII-safe', async () => {
    process.env.PINATA_JWT = 'eyJ.test.token';
    let capturedBody: string | undefined;
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      capturedBody = String(init?.body ?? '');
      return jsonResponse(200, {
        IpfsHash: 'bafycid',
        PinSize: 100,
        Timestamp: '2026-05-13T18:00:00.000Z',
      });
    });

    const manifest: typeof SAMPLE_MANIFEST = {
      ...SAMPLE_MANIFEST,
      observations: [
        {
          ...SAMPLE_MANIFEST.observations[0]!,
          // The bug-trigger character — embedded in a vendor URL the
          // scraper might have pulled from a site whose page header
          // included a LINE SEPARATOR.
          vendor_url: 'https://example.com/p\u2028page',
        },
      ],
    };

    await pinCycleToIPFS(manifest, {
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(capturedBody).toBeDefined();
    // No literal U+2028 byte in the transport body.
    expect(capturedBody!.includes(' ')).toBe(false);
    // The escaped form appears instead.
    expect(capturedBody!.includes('\\u2028')).toBe(true);
    // Every byte in the body is 7-bit ASCII (charCode <= 127).
    for (let i = 0; i < capturedBody!.length; i++) {
      expect(capturedBody!.charCodeAt(i)).toBeLessThanOrEqual(127);
    }
    // The body is still valid JSON, and a JSON-aware parser recovers
    // the original character (which is what Pinata does server-side).
    const parsed = JSON.parse(capturedBody!) as {
      pinataContent: { observations: Array<{ vendor_url: string }> };
    };
    expect(parsed.pinataContent.observations[0]!.vendor_url).toBe(
      'https://example.com/p\u2028page',
    );
  });

  it('escapes U+2029 PARAGRAPH SEPARATOR (the sibling of U+2028)', async () => {
    process.env.PINATA_JWT = 'eyJ.test.token';
    let capturedBody: string | undefined;
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      capturedBody = String(init?.body ?? '');
      return jsonResponse(200, { IpfsHash: 'bafycid', PinSize: 1 });
    });
    const m: typeof SAMPLE_MANIFEST = {
      ...SAMPLE_MANIFEST,
      observations: [
        {
          ...SAMPLE_MANIFEST.observations[0]!,
          vendor_url: 'https://example.com/p\u2029x',
        },
      ],
    };
    await pinCycleToIPFS(m, { fetchImpl: fetchMock as unknown as typeof fetch });
    expect(capturedBody!.includes(' ')).toBe(false);
    expect(capturedBody!.includes('\\u2029')).toBe(true);
  });

  it('escapes accented characters (é, ñ, em-dash) in vendor display strings', async () => {
    process.env.PINATA_JWT = 'eyJ.test.token';
    let capturedBody: string | undefined;
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      capturedBody = String(init?.body ?? '');
      return jsonResponse(200, { IpfsHash: 'bafycid', PinSize: 1 });
    });
    const m: typeof SAMPLE_MANIFEST = {
      ...SAMPLE_MANIFEST,
      // Stash assorted non-Latin-1 noise on multiple fields to confirm
      // the escape is comprehensive, not just U+2028-specific.
      peptide_code: 'BPC157', // keep code ASCII (real codes are)
      observations: [
        {
          ...SAMPLE_MANIFEST.observations[0]!,
          vendor_code: 'PURE_HEALTH',
          vendor_url: 'https://ex\u00e1mple.com/pept\u00edde\u2014\u00e9clair',
        },
      ],
    };
    await pinCycleToIPFS(m, { fetchImpl: fetchMock as unknown as typeof fetch });
    // Body is pure ASCII.
    for (let i = 0; i < capturedBody!.length; i++) {
      expect(capturedBody!.charCodeAt(i)).toBeLessThanOrEqual(127);
    }
    const parsed = JSON.parse(capturedBody!) as {
      pinataContent: { observations: Array<{ vendor_url: string }> };
    };
    // Round-trip integrity preserved.
    expect(parsed.pinataContent.observations[0]!.vendor_url).toBe(
      'https://ex\u00e1mple.com/pept\u00edde\u2014\u00e9clair',
    );
  });

  it('actual Node fetch accepts the escaped body (smoke test against the real coercion)', async () => {
    process.env.PINATA_JWT = 'eyJ.test.token';
    // The real bug surfaced because Node's fetch tries to coerce the
    // string body to a ByteString. We don't need a network — we just
    // need to confirm a stand-in fetch that performs ByteString
    // coercion (same algorithm as Node's) doesn't throw on the body
    // we produce. Easiest way: hand-roll the same coercion check.
    let capturedBody: string | undefined;
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      capturedBody = String(init?.body ?? '');
      // Reproduce Node's ByteString check.
      for (let i = 0; i < capturedBody.length; i++) {
        const code = capturedBody.charCodeAt(i);
        if (code > 255) {
          throw new TypeError(
            `Cannot convert argument to a ByteString because the character at index ${i} has a value of ${code} which is greater than 255.`,
          );
        }
      }
      return jsonResponse(200, { IpfsHash: 'bafycid', PinSize: 1 });
    });

    const m: typeof SAMPLE_MANIFEST = {
      ...SAMPLE_MANIFEST,
      observations: [
        {
          ...SAMPLE_MANIFEST.observations[0]!,
          vendor_url: 'https://example.com/\u2028',
        },
      ],
    };
    // Must NOT throw — exactly the production crash we're fixing.
    await expect(
      pinCycleToIPFS(m, { fetchImpl: fetchMock as unknown as typeof fetch }),
    ).resolves.toMatchObject({ cid: 'bafycid' });
  });
});

describe('pinCycleToIPFS — error paths', () => {
  it('throws a config error when PINATA_JWT is unset', async () => {
    await expect(
      pinCycleToIPFS(SAMPLE_MANIFEST, {
        fetchImpl: vi.fn() as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/PINATA_JWT is not set/);
  });

  it('throws when Pinata returns a non-2xx with detail', async () => {
    process.env.PINATA_JWT = 'eyJ.test.token';
    const fetchMock = vi.fn(async () =>
      jsonResponse(401, { error: { reason: 'AUTH_ERROR', details: 'bad jwt' } }, 'Unauthorized'),
    );
    await expect(
      pinCycleToIPFS(SAMPLE_MANIFEST, {
        fetchImpl: fetchMock as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/pin failed: HTTP 401 Unauthorized — .*AUTH_ERROR/);
  });

  it('throws on a network error', async () => {
    process.env.PINATA_JWT = 'eyJ.test.token';
    const fetchMock = vi.fn(async () => {
      throw new Error('ECONNRESET');
    });
    await expect(
      pinCycleToIPFS(SAMPLE_MANIFEST, {
        fetchImpl: fetchMock as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/network error: ECONNRESET/);
  });

  it('throws when the response is missing IpfsHash', async () => {
    process.env.PINATA_JWT = 'eyJ.test.token';
    const fetchMock = vi.fn(async () => jsonResponse(200, { PinSize: 100, Timestamp: 'x' }));
    await expect(
      pinCycleToIPFS(SAMPLE_MANIFEST, {
        fetchImpl: fetchMock as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/missing or empty IpfsHash/);
  });

  it('throws when PinSize is not a number', async () => {
    process.env.PINATA_JWT = 'eyJ.test.token';
    const fetchMock = vi.fn(async () => jsonResponse(200, { IpfsHash: 'bafy', PinSize: 'huge' }));
    await expect(
      pinCycleToIPFS(SAMPLE_MANIFEST, {
        fetchImpl: fetchMock as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/PinSize is not a non-negative number/);
  });
});

/* ─── Gated integration test ───────────────────────────────────────
 *
 * Performs a REAL pin to Pinata if PINATA_JWT is set in the
 * environment. Uses a tiny payload (`{test: "biohash-ci", timestamp,
 * commit}`), not a real cycle manifest, so the IPFS network doesn't
 * get polluted with synthetic oracle data.
 *
 * Skipped when PINATA_JWT is absent — CI without secrets stays green.
 *
 * This catches the categories of bugs the mock-based tests cannot:
 *   - Wrong endpoint URL (different path, wrong host)
 *   - Wrong Authorization header format (e.g. "Token " vs "Bearer ")
 *   - Renamed Pinata response fields
 *   - JWT format the gateway rejects
 *
 * Cleanup: we DON'T unpin. The payload is small, content-addressed,
 * and harmless. Operators can unpin manually from the Pinata
 * dashboard if needed.
 */
describe('pinCycleToIPFS — gated integration', () => {
  const hasJwt = !!process.env.PINATA_JWT;
  it.skipIf(!hasJwt)(
    '(integration, PINATA_JWT required) pins a tiny test payload and returns a real CID',
    async () => {
      // Use a non-manifest body — we're testing the transport, not the
      // manifest builder, and the smaller payload keeps the test from
      // adding fake oracle data to IPFS.
      const payload = {
        test: 'biohash-ci',
        timestamp: new Date().toISOString(),
        commit: 'ipfs-integration-test',
      } as unknown as CycleManifest;
      // The signature requires the CycleManifest shape, but the network
      // call doesn't introspect the body. Cast through unknown to keep
      // the test minimal.
      const result = await pinCycleToIPFS(payload);
      expect(result.cid).toMatch(/^[A-Za-z0-9]{40,80}$/);
      expect(result.size).toBeGreaterThan(0);
      expect(Date.parse(result.pinnedAt)).toBeGreaterThan(0);
      // Surface the CID so the operator running this test locally can
      // inspect / unpin it.
      // eslint-disable-next-line no-console
      console.log(
        `[ipfs.integration] pinned test payload — cid=${result.cid} ` +
          `size=${result.size}B (manually unpin from Pinata dashboard if desired)`,
      );
    },
    30_000, // Network can be slow; allow 30s.
  );
});

/* ─── helpers ──────────────────────────────────────────────────── */

function jsonResponse(
  status: number,
  body: unknown,
  statusText: string = status === 200 ? 'OK' : 'Error',
): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText,
    headers: { 'Content-Type': 'application/json' },
  });
}
