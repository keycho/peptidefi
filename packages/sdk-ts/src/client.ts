import { HttpClient, type BioHashClientOptions } from "./http";
import type {
  AnomaliesListEnvelope,
  AnomalyEvent,
  CycleDetail,
  CycleSummary,
  CyclesListEnvelope,
  IndexComponentsResponse,
  IndexCurrentResponse,
  IndexHistoryParams,
  IndexHistoryResponse,
  ListAnomaliesParams,
  ListCyclesParams,
  ObservationDetailResponse,
  PeptideDetailResponse,
  PeptideListItem,
  PeptidePriceHistoryResponse,
  PeptidesListEnvelope,
  PriceHistoryParams,
  TwapDetail,
  VendorLeaderboardEntry,
  VendorPricesResponse,
  VendorsLeaderboardEnvelope,
  VerifyObservationResponse,
} from "./types";

/**
 * Resource classes for the BioHash SDK. Each method maps 1:1 to an
 * endpoint on api.biohash.network and returns a value typed against
 * the real production response shape.
 *
 * For list endpoints the SDK unwraps the JSON envelope and returns
 * the inner array directly:
 *
 *   peptides.list()        → PeptideListItem[]        (from { peptides, count })
 *   cycles.list()          → CycleSummary[]           (from { cycles, next_cursor })
 *   vendors.leaderboard()  → VendorLeaderboardEntry[] (from { vendors })
 *   anomalies.list()       → AnomalyEvent[]           (from { events, next_cursor })
 *
 * For the two paginated lists (cycles + anomalies) a parallel
 * `.listPage()` method returns the full envelope so callers can
 * drive cursor pagination without losing `next_cursor`.
 *
 * Single-item endpoints with multi-field responses (peptide detail,
 * vendor prices, observations, twaps, verify, cycle detail) are
 * passed through unchanged.
 */

/* ─── Resource classes ────────────────────────────────────────────── */

class PeptidesAPI {
  constructor(private readonly http: HttpClient) {}

  /** GET /v1/peptides — list every tracked, active peptide. */
  async list(opts?: { signal?: AbortSignal }): Promise<PeptideListItem[]> {
    const env = await this.http.request<PeptidesListEnvelope>({
      method: "GET",
      path: "/v1/peptides",
      ...(opts?.signal ? { signal: opts.signal } : {}),
    });
    return env.peptides;
  }

  /** GET /v1/peptides/:id — single peptide + 7-day TWAP history. */
  get(
    codeOrId: string | number,
    opts?: { signal?: AbortSignal },
  ): Promise<PeptideDetailResponse> {
    return this.http.request<PeptideDetailResponse>({
      method: "GET",
      path: `/v1/peptides/${encodeURIComponent(String(codeOrId))}`,
      ...(opts?.signal ? { signal: opts.signal } : {}),
    });
  }

  /** GET /v1/peptides/:code/vendor-prices — current per-vendor prices. */
  vendorPrices(
    code: string,
    opts?: { signal?: AbortSignal },
  ): Promise<VendorPricesResponse> {
    return this.http.request<VendorPricesResponse>({
      method: "GET",
      path: `/v1/peptides/${encodeURIComponent(code)}/vendor-prices`,
      ...(opts?.signal ? { signal: opts.signal } : {}),
    });
  }

  /**
   * GET /v1/peptides/:code/price-history — per-vendor price history
   * (aggregated daily or hourly) plus the TWAP series over the same
   * window. Use {@link PriceHistoryParams.days} (1..90) to control
   * the window length and {@link PriceHistoryParams.aggregation} to
   * choose between daily and hourly buckets. Optional
   * {@link PriceHistoryParams.vendor} narrows the response to a single
   * supplier code.
   */
  priceHistory(
    code: string,
    params?: PriceHistoryParams,
    opts?: { signal?: AbortSignal },
  ): Promise<PeptidePriceHistoryResponse> {
    return this.http.request<PeptidePriceHistoryResponse>({
      method: "GET",
      path: `/v1/peptides/${encodeURIComponent(code)}/price-history`,
      ...(params ? { query: params as Record<string, unknown> } : {}),
      ...(opts?.signal ? { signal: opts.signal } : {}),
    });
  }
}

class TwapsAPI {
  constructor(private readonly http: HttpClient) {}

  /** GET /v1/twaps/:id — single TWAP commit by UUID. */
  get(twapId: string, opts?: { signal?: AbortSignal }): Promise<TwapDetail> {
    return this.http.request<TwapDetail>({
      method: "GET",
      path: `/v1/twaps/${encodeURIComponent(twapId)}`,
      ...(opts?.signal ? { signal: opts.signal } : {}),
    });
  }
}

class ObservationsAPI {
  constructor(private readonly http: HttpClient) {}

  /** GET /v1/observations/:id — canonical observation + Merkle proof. */
  get(
    observationId: number,
    opts?: { signal?: AbortSignal },
  ): Promise<ObservationDetailResponse> {
    return this.http.request<ObservationDetailResponse>({
      method: "GET",
      path: `/v1/observations/${encodeURIComponent(String(observationId))}`,
      ...(opts?.signal ? { signal: opts.signal } : {}),
    });
  }
}

class CyclesAPI {
  constructor(private readonly http: HttpClient) {}

  /**
   * GET /v1/cycles — paginated list of commit cycles. Returns the array
   * directly; use {@link CyclesAPI.listPage} when you need `next_cursor`
   * to drive pagination.
   */
  async list(
    params?: ListCyclesParams,
    opts?: { signal?: AbortSignal },
  ): Promise<CycleSummary[]> {
    const env = await this.listPage(params, opts);
    return env.cycles;
  }

  /**
   * GET /v1/cycles — paginated list with the raw envelope, exposing
   * `next_cursor` so callers can walk pages.
   */
  listPage(
    params?: ListCyclesParams,
    opts?: { signal?: AbortSignal },
  ): Promise<CyclesListEnvelope> {
    return this.http.request<CyclesListEnvelope>({
      method: "GET",
      path: "/v1/cycles",
      ...(params ? { query: params as Record<string, unknown> } : {}),
      ...(opts?.signal ? { signal: opts.signal } : {}),
    });
  }

  /** GET /v1/cycles/:id — cycle detail with observations inlined. */
  get(
    cycleId: number,
    opts?: { signal?: AbortSignal },
  ): Promise<CycleDetail> {
    return this.http.request<CycleDetail>({
      method: "GET",
      path: `/v1/cycles/${encodeURIComponent(String(cycleId))}`,
      ...(opts?.signal ? { signal: opts.signal } : {}),
    });
  }
}

class VerifyAPI {
  constructor(private readonly http: HttpClient) {}

  /**
   * GET /v1/verify/observation/:id — server-side end-to-end verifier.
   * The response is a discriminated union on `verified`. A `false`
   * with `status: "pending_commit"` is not a hard failure — retry
   * after `retry_after_seconds`.
   */
  observation(
    observationId: number,
    opts?: { signal?: AbortSignal },
  ): Promise<VerifyObservationResponse> {
    return this.http.request<VerifyObservationResponse>({
      method: "GET",
      path: `/v1/verify/observation/${encodeURIComponent(String(observationId))}`,
      ...(opts?.signal ? { signal: opts.signal } : {}),
    });
  }
}

class VendorsAPI {
  constructor(private readonly http: HttpClient) {}

  /** GET /vendors/leaderboard — public vendor leaderboard, ranked. */
  async leaderboard(opts?: {
    signal?: AbortSignal;
  }): Promise<VendorLeaderboardEntry[]> {
    const env = await this.http.request<VendorsLeaderboardEnvelope>({
      method: "GET",
      path: "/vendors/leaderboard",
      ...(opts?.signal ? { signal: opts.signal } : {}),
    });
    return env.vendors;
  }
}

class AnomaliesAPI {
  constructor(private readonly http: HttpClient) {}

  /**
   * GET /api/anomalies — paginated append-only event log. Returns the
   * array directly; use {@link AnomaliesAPI.listPage} when you need
   * `next_cursor` to drive pagination.
   */
  async list(
    params?: ListAnomaliesParams,
    opts?: { signal?: AbortSignal },
  ): Promise<AnomalyEvent[]> {
    const env = await this.listPage(params, opts);
    return env.events;
  }

  /**
   * GET /api/anomalies — paginated list with the raw envelope, exposing
   * `next_cursor` so callers can walk pages.
   */
  listPage(
    params?: ListAnomaliesParams,
    opts?: { signal?: AbortSignal },
  ): Promise<AnomaliesListEnvelope> {
    return this.http.request<AnomaliesListEnvelope>({
      method: "GET",
      path: "/api/anomalies",
      ...(params ? { query: params as Record<string, unknown> } : {}),
      ...(opts?.signal ? { signal: opts.signal } : {}),
    });
  }
}

/* ─── BioHash Peptide Index (v0.2.1) ──────────────────────────────── */

/**
 * BioHash Peptide Index resource. Three endpoints map to the three
 * methods below:
 *
 *   - GET /v1/index/current      -> getIndex()
 *   - GET /v1/index/history      -> getIndexHistory({ from?, to? })
 *   - GET /v1/index/components   -> getIndexComponents()
 *
 * `from` / `to` accept either ISO 8601 strings or Date objects; the
 * SDK normalises Dates to UTC ISO strings before serialising into the
 * query string. Defaults match the server: window=30 days, max=365.
 *
 * The components response includes per-peptide contribution math so
 * callers can render "which peptides moved the index" without
 * recomputing the formula client-side.
 */
class IndexAPI {
  constructor(private readonly http: HttpClient) {}

  /** GET /v1/index/current -- latest hour from index_history. */
  getIndex(opts?: { signal?: AbortSignal }): Promise<IndexCurrentResponse> {
    return this.http.request<IndexCurrentResponse>({
      method: "GET",
      path: "/v1/index/current",
      ...(opts?.signal ? { signal: opts.signal } : {}),
    });
  }

  /**
   * GET /v1/index/history?from=&to= -- time series. Window defaults
   * to the last 30 days when neither bound is provided; the server
   * caps the requested range at 365 days.
   */
  getIndexHistory(
    params?: { from?: string | Date; to?: string | Date },
    opts?: { signal?: AbortSignal },
  ): Promise<IndexHistoryResponse> {
    const query: IndexHistoryParams = {};
    if (params?.from !== undefined) {
      query.from = params.from instanceof Date ? params.from.toISOString() : params.from;
    }
    if (params?.to !== undefined) {
      query.to = params.to instanceof Date ? params.to.toISOString() : params.to;
    }
    return this.http.request<IndexHistoryResponse>({
      method: "GET",
      path: "/v1/index/history",
      ...(Object.keys(query).length > 0
        ? { query: query as Record<string, unknown> }
        : {}),
      ...(opts?.signal ? { signal: opts.signal } : {}),
    });
  }

  /**
   * GET /v1/index/components -- per-peptide breakdown of the most
   * recent index level. Includes baseline_twap, current_twap, weight,
   * and the (current/baseline) * (baseline_level/N) contribution.
   */
  getIndexComponents(opts?: {
    signal?: AbortSignal;
  }): Promise<IndexComponentsResponse> {
    return this.http.request<IndexComponentsResponse>({
      method: "GET",
      path: "/v1/index/components",
      ...(opts?.signal ? { signal: opts.signal } : {}),
    });
  }
}

/* ─── Top-level client ────────────────────────────────────────────── */

export class BioHash {
  public readonly peptides: PeptidesAPI;
  public readonly twaps: TwapsAPI;
  public readonly observations: ObservationsAPI;
  public readonly cycles: CyclesAPI;
  public readonly verify: VerifyAPI;
  public readonly vendors: VendorsAPI;
  public readonly anomalies: AnomaliesAPI;
  /** BioHash Peptide Index (SDK v0.2.1+). */
  public readonly index: IndexAPI;

  private readonly http: HttpClient;

  constructor(options: BioHashClientOptions = {}) {
    this.http = new HttpClient(options);
    this.peptides = new PeptidesAPI(this.http);
    this.twaps = new TwapsAPI(this.http);
    this.observations = new ObservationsAPI(this.http);
    this.cycles = new CyclesAPI(this.http);
    this.verify = new VerifyAPI(this.http);
    this.vendors = new VendorsAPI(this.http);
    this.anomalies = new AnomaliesAPI(this.http);
    this.index = new IndexAPI(this.http);
  }

  /**
   * Top-level convenience: getIndex() == index.getIndex(). Provided
   * so callers can write `await client.getIndex()` matching the
   * sketch in the SDK v0.2.1 release notes. Same for getIndexHistory
   * and getIndexComponents.
   */
  getIndex(opts?: { signal?: AbortSignal }): Promise<IndexCurrentResponse> {
    return this.index.getIndex(opts);
  }
  getIndexHistory(
    params?: { from?: string | Date; to?: string | Date },
    opts?: { signal?: AbortSignal },
  ): Promise<IndexHistoryResponse> {
    return this.index.getIndexHistory(params, opts);
  }
  getIndexComponents(opts?: {
    signal?: AbortSignal;
  }): Promise<IndexComponentsResponse> {
    return this.index.getIndexComponents(opts);
  }

  /** The resolved base URL the client is hitting (trailing slashes stripped). */
  get baseUrl(): string {
    return this.http.baseUrl;
  }
}
