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
  version: '1.1',
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
  index_snapshot: null,
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
      pinataContent: { peptide_code: 'BPC157', cycle_id: 4242, version: '1.1' },
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
describe('pinCycleToIPFS - Buffer body transport (U+2028 regression)', () => {
  it('passes the body as a Buffer (Uint8Array), NOT a string -- bypasses ByteString coercion', async () => {
    process.env.PINATA_JWT = 'eyJ.test.token';
    let capturedBody: unknown;
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      capturedBody = init?.body;
      return jsonResponse(200, {
        IpfsHash: 'bafycid',
        PinSize: 100,
        Timestamp: '2026-05-13T18:00:00.000Z',
      });
    });

    await pinCycleToIPFS(SAMPLE_MANIFEST, {
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    // The body MUST be a typed-array view, not a string. If it ever
    // regresses to `body: bodyJson`, the production ByteString crash
    // returns. This is the core invariant of hotfix #2.
    expect(typeof capturedBody).not.toBe('string');
    expect(capturedBody).toBeInstanceOf(Uint8Array);
  });

  it('Buffer body round-trips through utf-8 to the original manifest (U+2028 in vendor_url)', async () => {
    process.env.PINATA_JWT = 'eyJ.test.token';
    let capturedBuf: Buffer | undefined;
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      capturedBuf = init?.body as Buffer;
      return jsonResponse(200, { IpfsHash: 'bafycid', PinSize: 100 });
    });

    const manifest: typeof SAMPLE_MANIFEST = {
      ...SAMPLE_MANIFEST,
      observations: [
        {
          ...SAMPLE_MANIFEST.observations[0]!,
          // The exact bug-trigger character. Pre-fix, this crashed with
          // "value of 8232" at the index where it landed in the JSON.
          vendor_url: 'https://example.com/p\u2028page',
        },
      ],
    };
    await pinCycleToIPFS(manifest, {
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(capturedBuf).toBeDefined();
    // UTF-8 encoding of U+2028 is the three-byte sequence E2 80 A8.
    // We expect those bytes to appear verbatim in the body -- i.e. we
    // did NOT escape, we passed raw UTF-8 bytes.
    const u2028 = Buffer.from('\u2028', 'utf-8');
    expect(u2028.equals(Buffer.from([0xe2, 0x80, 0xa8]))).toBe(true);
    expect(capturedBuf!.includes(u2028)).toBe(true);
    // Round-trip integrity: decode + parse recovers the original field.
    const decoded = capturedBuf!.toString('utf-8');
    const parsed = JSON.parse(decoded) as {
      pinataContent: { observations: Array<{ vendor_url: string }> };
    };
    expect(parsed.pinataContent.observations[0]!.vendor_url).toBe(
      'https://example.com/p\u2028page',
    );
  });

  it('U+2029 PARAGRAPH SEPARATOR is transported intact via Buffer', async () => {
    process.env.PINATA_JWT = 'eyJ.test.token';
    let capturedBuf: Buffer | undefined;
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      capturedBuf = init?.body as Buffer;
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
    expect(capturedBuf!.includes(Buffer.from('\u2029', 'utf-8'))).toBe(true);
    const parsed = JSON.parse(capturedBuf!.toString('utf-8')) as {
      pinataContent: { observations: Array<{ vendor_url: string }> };
    };
    expect(parsed.pinataContent.observations[0]!.vendor_url).toBe('https://example.com/p\u2029x');
  });

  it('mixed non-ASCII (accents + em-dash) round-trips through Buffer transport', async () => {
    process.env.PINATA_JWT = 'eyJ.test.token';
    let capturedBuf: Buffer | undefined;
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      capturedBuf = init?.body as Buffer;
      return jsonResponse(200, { IpfsHash: 'bafycid', PinSize: 1 });
    });
    const original = 'https://ex\u00e1mple.com/pept\u00edde\u2014\u00e9clair';
    const m: typeof SAMPLE_MANIFEST = {
      ...SAMPLE_MANIFEST,
      observations: [
        {
          ...SAMPLE_MANIFEST.observations[0]!,
          vendor_code: 'PURE_HEALTH',
          vendor_url: original,
        },
      ],
    };
    await pinCycleToIPFS(m, { fetchImpl: fetchMock as unknown as typeof fetch });
    const parsed = JSON.parse(capturedBuf!.toString('utf-8')) as {
      pinataContent: { observations: Array<{ vendor_url: string }> };
    };
    expect(parsed.pinataContent.observations[0]!.vendor_url).toBe(original);
  });

  it('hand-rolled ByteString fetch mock: pin succeeds because body is not a string', async () => {
    process.env.PINATA_JWT = 'eyJ.test.token';
    // Stand-in fetch that performs the same ByteString check Node's
    // real fetch does -- but ONLY when the body is a string. Buffer /
    // Uint8Array paths skip the check (matches Node's BodyInit
    // handling). Pre-fix (string body) this would throw the production
    // TypeError; post-fix (Buffer body) it resolves cleanly.
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = init?.body;
      if (typeof body === 'string') {
        for (let i = 0; i < body.length; i++) {
          const code = body.charCodeAt(i);
          if (code > 255) {
            throw new TypeError(
              `Cannot convert argument to a ByteString because the character at index ${i} has a value of ${code} which is greater than 255.`,
            );
          }
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
    await expect(
      pinCycleToIPFS(m, { fetchImpl: fetchMock as unknown as typeof fetch }),
    ).resolves.toMatchObject({ cid: 'bafycid' });
  });

  it('emits diagnostic log lines (length + head + window around index 692)', async () => {
    process.env.PINATA_JWT = 'eyJ.test.token';
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const fetchMock = vi.fn(async () => jsonResponse(200, { IpfsHash: 'bafycid', PinSize: 1 }));
    await pinCycleToIPFS(SAMPLE_MANIFEST, {
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    const joined = log.mock.calls.map((c) => String(c[0])).join('\n');
    expect(joined).toMatch(/\[ipfs\] body length: \d+ chars \/ \d+ bytes \(utf-8\)/);
    expect(joined).toMatch(/\[ipfs\] body head\[0\.\.50\]: /);
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
