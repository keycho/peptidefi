import { describe, expect, it, vi } from "vitest";
import { BioHash, BioHashApiError } from "../index";

/**
 * Tests the HTTP layer behavior through the public BioHash entrypoint
 * so the wiring stays exercised end-to-end. We stub `fetch` per-test
 * to script the request/response sequence.
 */

interface ScriptedResponse {
  status: number;
  body?: unknown;
  /** Optional Retry-After header value. Used only for 429s. */
  retryAfter?: string;
  /** Force the fetch call to reject (network error). */
  throwError?: Error;
}

function makeFetch(responses: ScriptedResponse[]): {
  fetch: typeof fetch;
  calls: Array<{ url: string; init: RequestInit | undefined }>;
} {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  let i = 0;
  const fetchImpl = vi.fn(
    (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> => {
      calls.push({ url: String(input), init });
      const r = responses[i++];
      if (!r) throw new Error(`fetch called more times than scripted (${i})`);
      if (r.throwError) return Promise.reject(r.throwError);
      const headers = new Headers({ "Content-Type": "application/json" });
      if (r.retryAfter !== undefined) {
        headers.set("Retry-After", r.retryAfter);
      }
      const body =
        r.body === undefined
          ? ""
          : typeof r.body === "string"
            ? r.body
            : JSON.stringify(r.body);
      return Promise.resolve(
        new Response(body, { status: r.status, headers }),
      );
    },
  ) as unknown as typeof fetch;
  return { fetch: fetchImpl, calls };
}

describe("BioHash HTTP layer — happy path", () => {
  it("hits the configured baseUrl and parses JSON", async () => {
    const { fetch: fetchImpl, calls } = makeFetch([
      { status: 200, body: { peptides: [], count: 0 } },
    ]);
    const client = new BioHash({
      baseUrl: "https://api.example.com/",
      fetch: fetchImpl,
    });
    const res = await client.peptides.list();
    // Unwrapped: list returns the inner array, not the envelope.
    expect(res).toEqual([]);
    // Trailing slash trimmed.
    expect(calls[0]!.url).toBe("https://api.example.com/v1/peptides");
  });

  it("defaults to https://api.biohash.network", async () => {
    const { fetch: fetchImpl, calls } = makeFetch([
      { status: 200, body: { peptides: [], count: 0 } },
    ]);
    const client = new BioHash({ fetch: fetchImpl });
    await client.peptides.list();
    expect(calls[0]!.url.startsWith("https://api.biohash.network/")).toBe(true);
  });

  it("encodes path params (codes with slashes etc.)", async () => {
    const { fetch: fetchImpl, calls } = makeFetch([
      { status: 200, body: { peptide: {}, twap_history: [], history_window: { start: "", end: "" } } },
    ]);
    const client = new BioHash({
      baseUrl: "https://x.test",
      fetch: fetchImpl,
    });
    await client.peptides.get("BP C/157");
    expect(calls[0]!.url).toBe(
      "https://x.test/v1/peptides/BP%20C%2F157",
    );
  });

  it("serialises list params to URL query string", async () => {
    const { fetch: fetchImpl, calls } = makeFetch([
      { status: 200, body: { cycles: [], next_cursor: null } },
    ]);
    const client = new BioHash({
      baseUrl: "https://x.test",
      fetch: fetchImpl,
    });
    await client.cycles.list({ limit: 25, cursor: 1234, status: "finalized" });
    expect(calls[0]!.url).toBe(
      "https://x.test/v1/cycles?limit=25&cursor=1234&status=finalized",
    );
  });

  it("drops undefined query params, keeps no '?' if empty", async () => {
    const { fetch: fetchImpl, calls } = makeFetch([
      { status: 200, body: { cycles: [], next_cursor: null } },
    ]);
    const client = new BioHash({
      baseUrl: "https://x.test",
      fetch: fetchImpl,
    });
    await client.cycles.list({});
    expect(calls[0]!.url).toBe("https://x.test/v1/cycles");
  });
});

describe("BioHash HTTP layer — retries on 5xx", () => {
  it("retries 5xx 3 times then succeeds", async () => {
    const { fetch: fetchImpl, calls } = makeFetch([
      { status: 503, body: { code: "UNAVAILABLE", message: "down" } },
      { status: 503, body: { code: "UNAVAILABLE", message: "down" } },
      { status: 200, body: { peptides: [], count: 0 } },
    ]);
    const client = new BioHash({
      baseUrl: "https://x.test",
      fetch: fetchImpl,
      retryBackoffMs: 1, // keep test fast
    });
    const res = await client.peptides.list();
    expect(res).toEqual([]);
    expect(calls).toHaveLength(3);
  });

  it("throws BioHashApiError when 5xx retries are exhausted", async () => {
    const { fetch: fetchImpl, calls } = makeFetch([
      { status: 500, body: { code: "DB_ERROR", message: "db down" } },
      { status: 500, body: { code: "DB_ERROR", message: "db down" } },
      { status: 500, body: { code: "DB_ERROR", message: "db down" } },
      { status: 500, body: { code: "DB_ERROR", message: "db down" } },
    ]);
    const client = new BioHash({
      baseUrl: "https://x.test",
      fetch: fetchImpl,
      retryBackoffMs: 1,
    });
    await expect(client.peptides.list()).rejects.toBeInstanceOf(
      BioHashApiError,
    );
    // 1 original + 3 retries = 4 calls
    expect(calls).toHaveLength(4);
  });

  it("retries on network errors (fetch rejection)", async () => {
    const { fetch: fetchImpl, calls } = makeFetch([
      { status: 0, throwError: new Error("ECONNRESET") },
      { status: 0, throwError: new Error("ECONNRESET") },
      { status: 200, body: { peptides: [], count: 0 } },
    ]);
    const client = new BioHash({
      baseUrl: "https://x.test",
      fetch: fetchImpl,
      retryBackoffMs: 1,
    });
    const res = await client.peptides.list();
    expect(res).toEqual([]);
    expect(calls).toHaveLength(3);
  });
});

describe("BioHash HTTP layer — 429 honors Retry-After", () => {
  it("respects Retry-After seconds (integer)", async () => {
    const { fetch: fetchImpl, calls } = makeFetch([
      { status: 429, retryAfter: "0", body: { code: "RATE_LIMITED", message: "slow" } },
      { status: 200, body: { peptides: [], count: 0 } },
    ]);
    const client = new BioHash({
      baseUrl: "https://x.test",
      fetch: fetchImpl,
    });
    const t0 = Date.now();
    const res = await client.peptides.list();
    const elapsed = Date.now() - t0;
    expect(res).toEqual([]);
    expect(calls).toHaveLength(2);
    // Should be near-instant since Retry-After=0.
    expect(elapsed).toBeLessThan(500);
  });

  it("falls back to exponential backoff when Retry-After is missing", async () => {
    const { fetch: fetchImpl, calls } = makeFetch([
      { status: 429, body: { code: "RATE_LIMITED", message: "slow" } },
      { status: 200, body: { peptides: [], count: 0 } },
    ]);
    const client = new BioHash({
      baseUrl: "https://x.test",
      fetch: fetchImpl,
      retryBackoffMs: 5,
    });
    await client.peptides.list();
    expect(calls).toHaveLength(2);
  });
});

describe("BioHash HTTP layer — 4xx errors throw immediately", () => {
  it("404 throws without retry, surfaces envelope fields", async () => {
    const { fetch: fetchImpl, calls } = makeFetch([
      {
        status: 404,
        body: { code: "NOT_FOUND", message: "peptide not found: ZZZ" },
      },
    ]);
    const client = new BioHash({
      baseUrl: "https://x.test",
      fetch: fetchImpl,
    });
    try {
      await client.peptides.get("ZZZ");
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(BioHashApiError);
      const e = err as BioHashApiError;
      expect(e.status).toBe(404);
      expect(e.code).toBe("NOT_FOUND");
      expect(e.message).toBe("peptide not found: ZZZ");
    }
    expect(calls).toHaveLength(1);
  });

  it("400 with non-JSON body still throws BioHashApiError", async () => {
    const { fetch: fetchImpl } = makeFetch([
      { status: 400, body: "plain text bad request" },
    ]);
    const client = new BioHash({
      baseUrl: "https://x.test",
      fetch: fetchImpl,
    });
    try {
      await client.peptides.get("BPC157");
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(BioHashApiError);
      const e = err as BioHashApiError;
      expect(e.status).toBe(400);
      expect(e.code).toBe("HTTP_400");
    }
  });

  it("exposes retry_after_seconds from the envelope on pending_commit", async () => {
    // /v1/verify returns 200 with verified=false + retry_after_seconds
    // for pending_commit. That's not an error — verify the success path.
    const { fetch: fetchImpl } = makeFetch([
      {
        status: 200,
        body: {
          verified: false,
          observation_id: 42,
          status: "pending_commit",
          detail: "not yet anchored",
          retry_after_seconds: 30,
          checks: [],
        },
      },
    ]);
    const client = new BioHash({
      baseUrl: "https://x.test",
      fetch: fetchImpl,
    });
    const res = await client.verify.observation(42);
    expect(res.verified).toBe(false);
    if (res.verified === false) {
      expect(res.status).toBe("pending_commit");
      expect(res.retry_after_seconds).toBe(30);
    }
  });
});

describe("BioHash HTTP layer — error details", () => {
  it("surfaces details payload from the envelope", async () => {
    const { fetch: fetchImpl } = makeFetch([
      {
        status: 422,
        body: {
          code: "VALIDATION_FAILED",
          message: "bad input",
          details: { field: "limit", reason: "must be <=200" },
        },
      },
    ]);
    const client = new BioHash({
      baseUrl: "https://x.test",
      fetch: fetchImpl,
    });
    try {
      await client.cycles.list({ limit: 99999 });
      expect.fail("should have thrown");
    } catch (err) {
      const e = err as BioHashApiError;
      expect(e.code).toBe("VALIDATION_FAILED");
      expect(e.details).toEqual({ field: "limit", reason: "must be <=200" });
    }
  });

  it("includes the URL on the error", async () => {
    const { fetch: fetchImpl } = makeFetch([
      { status: 0, throwError: new Error("DNS NXDOMAIN") },
      { status: 0, throwError: new Error("DNS NXDOMAIN") },
      { status: 0, throwError: new Error("DNS NXDOMAIN") },
      { status: 0, throwError: new Error("DNS NXDOMAIN") },
    ]);
    const client = new BioHash({
      baseUrl: "https://nope.invalid",
      fetch: fetchImpl,
      retryBackoffMs: 1,
    });
    try {
      await client.peptides.list();
      expect.fail("should have thrown");
    } catch (err) {
      const e = err as BioHashApiError;
      expect(e.code).toBe("NETWORK_ERROR");
      expect(e.url).toBe("https://nope.invalid/v1/peptides");
    }
  });
});
