import { describe, expect, it, vi } from "vitest";
import { BioHash } from "../index";

/**
 * Happy-path coverage for each resource method: verify it hits the
 * right HTTP method + path and returns the parsed body unchanged
 * (or the unwrapped array, for list endpoints). The detailed HTTP
 * behavior (retries, errors, etc.) lives in http.test.ts.
 *
 * Response bodies in these tests are deliberately the real shapes
 * returned by api.biohash.network so the unwrap layer stays exercised.
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

describe("BioHash — peptides", () => {
  it("peptides.list → GET /v1/peptides, unwraps to PeptideListItem[]", async () => {
    const envelope = {
      peptides: [
        {
          peptide_id: 1,
          code: "BPC157",
          display_name: "BPC-157",
          full_name: "Body Protection Compound 157",
          twap_commits_count: 39,
          current_twap: {
            twap_value: "6.699",
            computed_at: "2026-05-11T15:00:00+00:00",
            solana_signature: "sig",
            solana_slot: 419063387,
            cluster: "mainnet-beta",
            solscan_url: "https://solscan.io/tx/sig",
          },
        },
        {
          peptide_id: 9,
          code: "NAD",
          display_name: "NAD+",
          full_name: "Nicotinamide Adenine Dinucleotide",
          twap_commits_count: 0,
          current_twap: null,
        },
      ],
      count: 2,
    };
    const { fetch: fetchImpl, calls } = makeFetch(envelope);
    const client = new BioHash({ baseUrl: BASE, fetch: fetchImpl });
    const peptides = await client.peptides.list();
    expect(calls[0]).toBe(`${BASE}/v1/peptides`);
    // Unwrapped: result is the array, not the envelope.
    expect(Array.isArray(peptides)).toBe(true);
    expect(peptides).toHaveLength(2);
    expect(peptides[0]!.code).toBe("BPC157");
    expect(peptides[0]!.current_twap?.cluster).toBe("mainnet-beta");
    expect(peptides[1]!.current_twap).toBeNull();
  });

  it("peptides.get(code) → GET /v1/peptides/:code, returns wrapped detail", async () => {
    const body = {
      peptide: {
        peptide_id: 2,
        code: "BPC157",
        display_name: "BPC-157",
        full_name: "Body Protection Compound 157",
        is_active: true,
      },
      twap_history: [
        {
          twap_id: "uuid-1",
          twap_value: "6.699",
          computed_at: "2026-05-11T15:00:00+00:00",
          window_start: "2026-05-11T14:30:00+00:00",
          window_end: "2026-05-11T15:00:00+00:00",
          observation_set_root: "0xroot",
          status: "finalized",
          cluster: "mainnet-beta",
          solana: {
            signature: "sig",
            slot: 1,
            cluster: "mainnet-beta",
            solscan_url: "https://solscan.io/tx/sig",
            explorer_url: "https://explorer.solana.com/tx/sig",
          },
          finalized_at: "2026-05-11T15:03:00Z",
        },
      ],
      history_window: {
        start: "2026-05-04T15:00:00Z",
        end: "2026-05-11T15:00:00Z",
      },
    };
    const { fetch: fetchImpl, calls } = makeFetch(body);
    const client = new BioHash({ baseUrl: BASE, fetch: fetchImpl });
    const res = await client.peptides.get("BPC157");
    expect(calls[0]).toBe(`${BASE}/v1/peptides/BPC157`);
    expect(res.peptide.code).toBe("BPC157");
    expect(res.twap_history[0]!.cluster).toBe("mainnet-beta");
    expect(res.history_window.start).toBeTruthy();
  });

  it("peptides.get(numeric id) → GET /v1/peptides/:id", async () => {
    const { fetch: fetchImpl, calls } = makeFetch({
      peptide: {
        peptide_id: 1,
        code: "GLP1",
        display_name: "GLP-1",
        full_name: "GLP-1",
        is_active: true,
      },
      twap_history: [],
      history_window: { start: "x", end: "y" },
    });
    const client = new BioHash({ baseUrl: BASE, fetch: fetchImpl });
    await client.peptides.get(1);
    expect(calls[0]).toBe(`${BASE}/v1/peptides/1`);
  });

  it("peptides.vendorPrices → returns the new {peptide_code, twap, vendors, spread} shape", async () => {
    const body = {
      peptide_code: "BPC157",
      twap: {
        value_usd_per_mg: "6.699",
        computed_at: "2026-05-11T15:00:00+00:00",
        cluster: "mainnet-beta",
      },
      vendors: [
        {
          vendor_name: "Pure Health Peptides",
          price_usd_per_mg: "3.633333",
          observed_at: "2026-05-11T15:26:58.22+00:00",
        },
      ],
      spread: { min: "3.633333", max: "11", variance_pct: 202.8 },
    };
    const { fetch: fetchImpl, calls } = makeFetch(body);
    const client = new BioHash({ baseUrl: BASE, fetch: fetchImpl });
    const res = await client.peptides.vendorPrices("BPC157");
    expect(calls[0]).toBe(`${BASE}/v1/peptides/BPC157/vendor-prices`);
    expect(res.peptide_code).toBe("BPC157");
    expect(res.twap.value_usd_per_mg).toBe("6.699");
    expect(res.vendors[0]!.vendor_name).toBe("Pure Health Peptides");
    expect(res.spread.variance_pct).toBe(202.8);
  });
});

describe("BioHash — twaps", () => {
  it("twaps.get → GET /v1/twaps/:id with cluster field", async () => {
    const body = {
      twap_id: "uuid-2",
      peptide_code: "BPC157",
      algo: "filtered_median_v1",
      twap_value: "6.699",
      computed_at: "2026-05-11T15:00:00+00:00",
      window_start: "2026-05-11T14:30:00+00:00",
      window_end: "2026-05-11T15:00:00+00:00",
      observation_set_root: "0xroot",
      status: "finalized",
      cluster: "mainnet-beta",
      solana: null,
      memo_payload: "{}",
      submitted_at: null,
      finalized_at: null,
      retry_count: 0,
      last_error: null,
      input_observation_ids: [1, 2, 3],
    };
    const { fetch: fetchImpl, calls } = makeFetch(body);
    const client = new BioHash({ baseUrl: BASE, fetch: fetchImpl });
    const res = await client.twaps.get("uuid-2");
    expect(calls[0]).toBe(`${BASE}/v1/twaps/uuid-2`);
    expect(res.cluster).toBe("mainnet-beta");
    expect(res.input_observation_ids).toEqual([1, 2, 3]);
  });
});

describe("BioHash — observations", () => {
  it("observations.get returns observation with `id` field (not observation_id)", async () => {
    const body = {
      observation: {
        id: 163871,
        supplier_id: 1,
        peptide_id: 2,
        supplier_product_id: 10,
        scraper_run_id: 1259,
        observed_at: "2026-05-11T15:26:58.22+00:00",
        raw_price: "20.00",
        raw_currency: "USD",
        fx_rate_to_usd: "1.00000000",
        price_usd_per_mg: "3.633333",
        raw_availability: "in stock",
        availability_tier: "in_stock",
        lead_time_days: null,
        scrape_success: true,
        scrape_error: null,
        http_status: 200,
        raw_html_hash: "0xhash",
      },
      canonical_leaf_json: "{\"availability_tier\":\"in_stock\",\"id\":163871}",
      computed_leaf_hash: "0xleaf",
      commit: {
        cycle_id: 1259,
        leaf_hash: "0xleaf",
        leaf_index: 0,
        merkle_root: "0xroot",
        status: "finalized",
        solana_signature: "sig",
        solana_slot: 100,
        solscan_url: "https://solscan.io/tx/sig",
        explorer_url: "https://explorer.solana.com/tx/sig",
      },
      proof: {
        merkle_root: "0xroot",
        proof: [{ position: "right", hash: "0xsibling" }],
      },
    };
    const { fetch: fetchImpl, calls } = makeFetch(body);
    const client = new BioHash({ baseUrl: BASE, fetch: fetchImpl });
    const res = await client.observations.get(163871);
    expect(calls[0]).toBe(`${BASE}/v1/observations/163871`);
    expect(res.observation.id).toBe(163871);
    expect(res.commit?.cycle_id).toBe(1259);
    expect(res.proof?.proof[0]!.position).toBe("right");
  });
});

describe("BioHash — cycles", () => {
  it("cycles.list with no params → unwraps to CycleSummary[]", async () => {
    const envelope = {
      cycles: [
        {
          cycle_id: 1259,
          started_at: "2026-05-11T15:26:50.221+00:00",
          completed_at: "2026-05-11T15:28:17.26+00:00",
          observation_count: 165,
          merkle_root: "0xroot",
          status: "finalized",
          cluster: "mainnet-beta",
          solana: {
            signature: "sig",
            slot: 1,
            cluster: "mainnet-beta",
            solscan_url: "https://solscan.io/tx/sig",
            explorer_url: "https://explorer.solana.com/tx/sig",
          },
          submitted_at: "2026-05-11T15:29:08.751+00:00",
          finalized_at: "2026-05-11T15:29:39.589+00:00",
        },
      ],
      next_cursor: 1258,
    };
    const { fetch: fetchImpl, calls } = makeFetch(envelope);
    const client = new BioHash({ baseUrl: BASE, fetch: fetchImpl });
    const cycles = await client.cycles.list();
    expect(calls[0]).toBe(`${BASE}/v1/cycles`);
    expect(Array.isArray(cycles)).toBe(true);
    expect(cycles[0]!.cycle_id).toBe(1259);
    expect(cycles[0]!.cluster).toBe("mainnet-beta");
  });

  it("cycles.listPage → returns the full envelope with next_cursor", async () => {
    const envelope = {
      cycles: [],
      next_cursor: 1258,
    };
    const { fetch: fetchImpl, calls } = makeFetch(envelope);
    const client = new BioHash({ baseUrl: BASE, fetch: fetchImpl });
    const page = await client.cycles.listPage({ limit: 10, status: "all" });
    expect(calls[0]).toBe(`${BASE}/v1/cycles?limit=10&status=all`);
    expect(page.next_cursor).toBe(1258);
    expect(page.cycles).toEqual([]);
  });

  it("cycles.list with params serialises query", async () => {
    const { fetch: fetchImpl, calls } = makeFetch({
      cycles: [],
      next_cursor: null,
    });
    const client = new BioHash({ baseUrl: BASE, fetch: fetchImpl });
    await client.cycles.list({ limit: 10, status: "finalized" });
    expect(calls[0]).toBe(`${BASE}/v1/cycles?limit=10&status=finalized`);
  });

  it("cycles.get → GET /v1/cycles/:id with cluster + memo_payload", async () => {
    const body = {
      cycle_id: 1259,
      started_at: "x",
      completed_at: "x",
      observation_count: 165,
      merkle_root: "0xroot",
      status: "finalized",
      cluster: "mainnet-beta",
      solana: null,
      submitted_at: null,
      finalized_at: null,
      memo_payload: "{}",
      retry_count: 0,
      last_error: null,
      observations: [
        { observation_id: 100, leaf_index: 0, leaf_hash: "0xa" },
      ],
    };
    const { fetch: fetchImpl, calls } = makeFetch(body);
    const client = new BioHash({ baseUrl: BASE, fetch: fetchImpl });
    const res = await client.cycles.get(1259);
    expect(calls[0]).toBe(`${BASE}/v1/cycles/1259`);
    expect(res.cluster).toBe("mainnet-beta");
    expect(res.observations[0]!.observation_id).toBe(100);
  });
});

describe("BioHash — verify", () => {
  it("verify.observation success", async () => {
    const body = {
      verified: true,
      observation_id: 42,
      cycle_id: 1,
      leaf_index: 0,
      leaf_hash: "0xleaf",
      merkle_root: "0xroot",
      proof: [{ position: "right", hash: "0xsibling" }],
      on_chain: {
        signature: "sig",
        slot: 1,
        cluster: "mainnet-beta",
        memo: "{}",
      },
      checks: [{ name: "observation_exists", passed: true }],
    };
    const { fetch: fetchImpl, calls } = makeFetch(body);
    const client = new BioHash({ baseUrl: BASE, fetch: fetchImpl });
    const res = await client.verify.observation(42);
    expect(calls[0]).toBe(`${BASE}/v1/verify/observation/42`);
    expect(res.verified).toBe(true);
    if (res.verified === true) {
      expect(res.proof[0]!.position).toBe("right");
    }
  });

  it("verify.observation failure with detailed checks", async () => {
    const body = {
      verified: false,
      observation_id: 163871,
      cycle_id: 1259,
      failure_reason: "memo_matches_onchain",
      failure_detail: "on-chain tx ... not found at finalized commitment",
      checks: [
        { name: "observation_exists", passed: true },
        { name: "memo_matches_onchain", passed: false },
      ],
    };
    const { fetch: fetchImpl } = makeFetch(body);
    const client = new BioHash({ baseUrl: BASE, fetch: fetchImpl });
    const res = await client.verify.observation(163871);
    expect(res.verified).toBe(false);
    if (res.verified === false) {
      expect(res.failure_reason).toBe("memo_matches_onchain");
      expect(res.cycle_id).toBe(1259);
    }
  });
});

describe("BioHash — vendors", () => {
  it("vendors.leaderboard → unwraps to VendorLeaderboardEntry[]", async () => {
    const envelope = {
      vendors: [
        {
          rank: 1,
          supplier_code: "LIBERTY",
          supplier_display_name: "Liberty Peptides",
          logo_url: null,
          coverage_count: 24,
          in_stock_rate: "0.6469",
          update_frequency: 2682,
          cheapest_pct: "0.2917",
          avg_spread_vs_twap: "-0.157282",
          freshness_seconds: 623,
          composite_score: "0.6907",
        },
      ],
    };
    const { fetch: fetchImpl, calls } = makeFetch(envelope);
    const client = new BioHash({ baseUrl: BASE, fetch: fetchImpl });
    const vendors = await client.vendors.leaderboard();
    expect(calls[0]).toBe(`${BASE}/vendors/leaderboard`);
    expect(Array.isArray(vendors)).toBe(true);
    expect(vendors[0]!.supplier_code).toBe("LIBERTY");
  });
});

describe("BioHash — anomalies", () => {
  it("anomalies.list → unwraps to AnomalyEvent[]", async () => {
    const envelope = {
      events: [
        {
          id: 9953,
          occurred_at: "2026-05-11T15:28:17.594327+00:00",
          severity: "error",
          event_type: "parser_failure",
          vendor_id: "PURERAWZ",
          peptide_id: "PT141",
          observation_id: 164030,
          cycle_id: null,
          description: "PURERAWZ ...",
          context: { http_status: 200 },
          resolved_at: null,
          resolved_by: null,
        },
      ],
      next_cursor: "2026-05-11T15:28:17.153702+00:00_9952",
    };
    const { fetch: fetchImpl, calls } = makeFetch(envelope);
    const client = new BioHash({ baseUrl: BASE, fetch: fetchImpl });
    const events = await client.anomalies.list({
      limit: 1,
      severity: "error",
    });
    expect(calls[0]).toBe(`${BASE}/api/anomalies?limit=1&severity=error`);
    expect(Array.isArray(events)).toBe(true);
    expect(events[0]!.event_type).toBe("parser_failure");
    expect(events[0]!.observation_id).toBe(164030);
  });

  it("anomalies.listPage → exposes the string next_cursor", async () => {
    const envelope = {
      events: [],
      next_cursor: "2026-05-11T15:28:17.153702+00:00_9952",
    };
    const { fetch: fetchImpl, calls } = makeFetch(envelope);
    const client = new BioHash({ baseUrl: BASE, fetch: fetchImpl });
    const page = await client.anomalies.listPage({
      cursor: "2026-05-11T15:28:17.594327+00:00_9953",
    });
    // Cursor must be URL-encoded — URLSearchParams handles + and :.
    expect(calls[0]).toBe(
      `${BASE}/api/anomalies?cursor=2026-05-11T15%3A28%3A17.594327%2B00%3A00_9953`,
    );
    expect(page.next_cursor).toBe(
      "2026-05-11T15:28:17.153702+00:00_9952",
    );
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
