import { HttpClient, type BioHashClientOptions } from "./http";
import type {
  AnomaliesListEnvelope,
  AnomalyEvent,
  CycleDetail,
  CycleSummary,
  CyclesListEnvelope,
  ListAnomaliesParams,
  ListCyclesParams,
  ObservationDetailResponse,
  PeptideDetailResponse,
  PeptideListItem,
  PeptidesListEnvelope,
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

/* ─── Top-level client ────────────────────────────────────────────── */

export class BioHash {
  public readonly peptides: PeptidesAPI;
  public readonly twaps: TwapsAPI;
  public readonly observations: ObservationsAPI;
  public readonly cycles: CyclesAPI;
  public readonly verify: VerifyAPI;
  public readonly vendors: VendorsAPI;
  public readonly anomalies: AnomaliesAPI;

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
  }

  /** The resolved base URL the client is hitting (trailing slashes stripped). */
  get baseUrl(): string {
    return this.http.baseUrl;
  }
}
