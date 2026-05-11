import { describe, expect, it, vi } from "vitest";
import { BioHash } from "../index";

/**
 * Happy-path coverage for each resource method: verify it hits the
 * right HTTP method + path and returns the parsed body unchanged. The
 * detailed HTTP behavior (retries, errors, etc.) lives in http.test.ts.
 */

function makeFetch(body: unknown): {
  fetch: typeof fetch;
  calls: string[];
} {
  const calls: string[] = [];
  const fetchImpl = vi.fn(
    (input: Parameters<typeof fetch>[0]): Promise<Response> => {
      calls.push(String(input));
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    },
  ) as unknown as typeof fetch;
  return { fetch: fetchImpl, calls };
}

const BASE = "https://x.test";

describe("BioHash — resource routing", () => {
  it("peptides.list → GET /v1/peptides", async () => {
    const body = { peptides: [{ peptide_id: 1, code: "BPC157" }], count: 1 };
    const { fetch: fetchImpl, calls } = makeFetch(body);
    const client = new BioHash({ baseUrl: BASE, fetch: fetchImpl });
    const res = await client.peptides.list();
    expect(calls[0]).toBe(`${BASE}/v1/peptides`);
    expect(res.count).toBe(1);
  });

  it("peptides.get(code) → GET /v1/peptides/:code", async () => {
    const { fetch: fetchImpl, calls } = makeFetch({
      peptide: { peptide_id: 1, code: "BPC157" },
      twap_history: [],
      history_window: { start: "x", end: "y" },
    });
    const client = new BioHash({ baseUrl: BASE, fetch: fetchImpl });
    await client.peptides.get("BPC157");
    expect(calls[0]).toBe(`${BASE}/v1/peptides/BPC157`);
  });

  it("peptides.get(numeric id) → GET /v1/peptides/:id", async () => {
    const { fetch: fetchImpl, calls } = makeFetch({
      peptide: { peptide_id: 1, code: "BPC157" },
      twap_history: [],
      history_window: { start: "x", end: "y" },
    });
    const client = new BioHash({ baseUrl: BASE, fetch: fetchImpl });
    await client.peptides.get(1);
    expect(calls[0]).toBe(`${BASE}/v1/peptides/1`);
  });

  it("peptides.vendorPrices → GET /v1/peptides/:code/vendor-prices", async () => {
    const { fetch: fetchImpl, calls } = makeFetch({
      peptide_code: "BPC157",
      twap_value: "1.00",
      twap_computed_at: "2025-01-01T00:00:00Z",
      vendors: [],
      count: 0,
    });
    const client = new BioHash({ baseUrl: BASE, fetch: fetchImpl });
    await client.peptides.vendorPrices("BPC157");
    expect(calls[0]).toBe(`${BASE}/v1/peptides/BPC157/vendor-prices`);
  });

  it("twaps.get → GET /v1/twaps/:id", async () => {
    const { fetch: fetchImpl, calls } = makeFetch({
      twap_id: "00000000-0000-0000-0000-000000000000",
      peptide_code: "BPC157",
      algo: "filtered_median_v1",
      twap_value: "1.00",
      computed_at: "x",
      window_start: "x",
      window_end: "x",
      observation_set_root: "0xdead",
      status: "finalized",
      solana: null,
      memo_payload: "{}",
      submitted_at: null,
      finalized_at: null,
      retry_count: 0,
      last_error: null,
      input_observation_ids: [],
    });
    const client = new BioHash({ baseUrl: BASE, fetch: fetchImpl });
    await client.twaps.get("00000000-0000-0000-0000-000000000000");
    expect(calls[0]).toBe(
      `${BASE}/v1/twaps/00000000-0000-0000-0000-000000000000`,
    );
  });

  it("observations.get → GET /v1/observations/:id", async () => {
    const { fetch: fetchImpl, calls } = makeFetch({
      observation: { observation_id: 99 },
      canonical_leaf_json: "{}",
      computed_leaf_hash: "0xdead",
      commit: null,
      proof: null,
    });
    const client = new BioHash({ baseUrl: BASE, fetch: fetchImpl });
    await client.observations.get(99);
    expect(calls[0]).toBe(`${BASE}/v1/observations/99`);
  });

  it("cycles.list with no params → GET /v1/cycles", async () => {
    const { fetch: fetchImpl, calls } = makeFetch({
      cycles: [],
      next_cursor: null,
    });
    const client = new BioHash({ baseUrl: BASE, fetch: fetchImpl });
    await client.cycles.list();
    expect(calls[0]).toBe(`${BASE}/v1/cycles`);
  });

  it("cycles.list with params → GET /v1/cycles?...", async () => {
    const { fetch: fetchImpl, calls } = makeFetch({
      cycles: [],
      next_cursor: null,
    });
    const client = new BioHash({ baseUrl: BASE, fetch: fetchImpl });
    await client.cycles.list({ limit: 10, status: "all" });
    expect(calls[0]).toBe(`${BASE}/v1/cycles?limit=10&status=all`);
  });

  it("cycles.get → GET /v1/cycles/:id", async () => {
    const { fetch: fetchImpl, calls } = makeFetch({
      cycle_id: 1165,
      started_at: "x",
      completed_at: "x",
      observation_count: 0,
      merkle_root: "0xdead",
      status: "finalized",
      solana: null,
      submitted_at: null,
      finalized_at: null,
      memo_payload: "{}",
      retry_count: 0,
      last_error: null,
      observations: [],
    });
    const client = new BioHash({ baseUrl: BASE, fetch: fetchImpl });
    await client.cycles.get(1165);
    expect(calls[0]).toBe(`${BASE}/v1/cycles/1165`);
  });

  it("verify.observation → GET /v1/verify/observation/:id", async () => {
    const { fetch: fetchImpl, calls } = makeFetch({
      verified: true,
      observation_id: 42,
      cycle_id: 1,
      leaf_index: 0,
      leaf_hash: "0xdead",
      merkle_root: "0xdead",
      proof: [],
      on_chain: {
        signature: "sig",
        slot: 1,
        cluster: "mainnet-beta",
        memo: "{}",
      },
      checks: [],
    });
    const client = new BioHash({ baseUrl: BASE, fetch: fetchImpl });
    const res = await client.verify.observation(42);
    expect(calls[0]).toBe(`${BASE}/v1/verify/observation/42`);
    expect(res.verified).toBe(true);
  });

  it("vendors.leaderboard → GET /vendors/leaderboard", async () => {
    const { fetch: fetchImpl, calls } = makeFetch({ vendors: [] });
    const client = new BioHash({ baseUrl: BASE, fetch: fetchImpl });
    await client.vendors.leaderboard();
    expect(calls[0]).toBe(`${BASE}/vendors/leaderboard`);
  });

  it("anomalies.list → GET /api/anomalies?... with all params", async () => {
    const { fetch: fetchImpl, calls } = makeFetch({
      events: [],
      next_cursor: null,
    });
    const client = new BioHash({ baseUrl: BASE, fetch: fetchImpl });
    await client.anomalies.list({
      limit: 100,
      severity: "warning",
      event_type: "vendor_offline",
      since: "2025-01-01T00:00:00Z",
    });
    expect(calls[0]).toContain(`${BASE}/api/anomalies?`);
    expect(calls[0]).toContain("limit=100");
    expect(calls[0]).toContain("severity=warning");
    expect(calls[0]).toContain("event_type=vendor_offline");
    expect(calls[0]).toContain("since=2025-01-01T00%3A00%3A00Z");
  });
});

describe("BioHash — custom headers + AbortSignal", () => {
  it("forwards extra headers to every request", async () => {
    const calls: RequestInit[] = [];
    const fetchImpl = vi.fn(
      (_url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> => {
        if (init) calls.push(init);
        return Promise.resolve(
          new Response(JSON.stringify({ peptides: [], count: 0 }), {
            status: 200,
          }),
        );
      },
    ) as unknown as typeof fetch;
    const client = new BioHash({
      baseUrl: BASE,
      fetch: fetchImpl,
      headers: { "X-Admin-Token": "secret" },
    });
    await client.peptides.list();
    const h = calls[0]!.headers as Record<string, string>;
    expect(h["X-Admin-Token"]).toBe("secret");
    expect(h["Accept"]).toBe("application/json");
  });

  it("aborts in-flight request when caller AbortController fires", async () => {
    // never resolve so the abort path is the only way out
    const fetchImpl = vi.fn(
      (_url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new Error("aborted"));
          });
        }),
    ) as unknown as typeof fetch;
    const client = new BioHash({ baseUrl: BASE, fetch: fetchImpl });
    const ctrl = new AbortController();
    const p = client.peptides.list({ signal: ctrl.signal });
    queueMicrotask(() => ctrl.abort());
    await expect(p).rejects.toMatchObject({ code: "ABORTED" });
  });
});

describe("BioHash — baseUrl getter", () => {
  it("exposes the trimmed baseUrl", () => {
    const client = new BioHash({
      baseUrl: "https://x.test///",
      fetch: globalThis.fetch ?? (vi.fn() as unknown as typeof fetch),
    });
    expect(client.baseUrl).toBe("https://x.test");
  });
});
