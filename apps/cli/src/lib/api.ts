import { config } from "./config.js";

// ----------------------------------------------------------------------------
// Response types — minimal shapes for the fields the CLI actually reads.
// These match the public API contract documented at api.biohash.network/docs.
// ----------------------------------------------------------------------------

export interface IndexCurrent {
  level: number;
  baseline: number;
  change_pct: number;
  cohort_size: number;
  hour_start: string; // ISO timestamp
  components_hash: string;
  ipfs_cid?: string;
}

export interface IndexHistoryPoint {
  hour_start: string;
  level: number;
  change_pct: number;
}

export interface PeptidePrice {
  code: string;
  name: string;
  twap_usd_per_mg: number;
  twap_vendor_count: number;
  total_vendor_count: number;
  range_24h_low?: number;
  range_24h_high?: number;
  last_commit_signature?: string;
  last_commit_slot?: number;
  ipfs_manifest_cid?: string;
}

export interface PeptideVendorObservation {
  vendor_code: string;
  vendor_name: string;
  vendor_domain?: string;
  price_usd_per_mg: number;
  in_twap: boolean;
  bps_from_median?: number;
}

export interface PeptideVendors {
  code: string;
  twap_value: number;
  observations: PeptideVendorObservation[];
}

export interface CycleSummary {
  cycle_id: number;
  hour_start: string;
  finalized_count: number;
  expected_count: number;
  solana_signature: string;
  solana_slot: number;
  components_hash: string;
  ipfs_manifest_cid: string;
}

// ----------------------------------------------------------------------------
// fetch wrapper with timeout + structured errors
// ----------------------------------------------------------------------------

class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly endpoint: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function get<T>(path: string): Promise<T> {
  const url = `${config.apiUrl}${path}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), config.fetchTimeoutMs);

  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { Accept: "application/json" },
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new ApiError(
        res.status,
        path,
        `${res.status} ${res.statusText}${text ? `: ${text.slice(0, 200)}` : ""}`,
      );
    }

    return (await res.json()) as T;
  } catch (err) {
    if (err instanceof ApiError) throw err;
    if (err instanceof Error && err.name === "AbortError") {
      throw new ApiError(0, path, `request timed out after ${config.fetchTimeoutMs}ms`);
    }
    const msg = err instanceof Error ? err.message : String(err);
    throw new ApiError(0, path, `network error: ${msg}`);
  } finally {
    clearTimeout(timer);
  }
}

// ----------------------------------------------------------------------------
// Public API surface
// ----------------------------------------------------------------------------

export const api = {
  indexCurrent: () => get<IndexCurrent>("/v1/index/current"),

  indexHistory: (hours: number) =>
    get<IndexHistoryPoint[]>(`/v1/index/history?hours=${hours}`),

  peptide: (code: string) =>
    get<PeptidePrice>(`/v1/peptides/${encodeURIComponent(code.toUpperCase())}`),

  peptideVendors: (code: string) =>
    get<PeptideVendors>(
      `/v1/peptides/${encodeURIComponent(code.toUpperCase())}/vendors`,
    ),

  cycle: (cycleId: number) => get<CycleSummary>(`/v1/cycles/${cycleId}`),
};

export { ApiError };
