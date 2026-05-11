import { HttpClient, type BioHashClientOptions } from "./http";
import type {
  AnomaliesListResponse,
  CycleDetail,
  CyclesListResponse,
  ListAnomaliesParams,
  ListCyclesParams,
  ObservationDetailResponse,
  PeptideDetailResponse,
  PeptidesListResponse,
  TwapDetail,
  VendorPricesResponse,
  VendorsLeaderboardResponse,
  VerifyObservationResponse,
} from "./types";

/* ─── Resource classes ────────────────────────────────────────────── */

class PeptidesAPI {
  constructor(private readonly http: HttpClient) {}

  /** GET /v1/peptides — list every tracked, active peptide. */
  list(opts?: { signal?: AbortSignal }): Promise<PeptidesListResponse> {
    return this.http.request<PeptidesListResponse>({
      method: "GET",
      path: "/v1/peptides",
      ...(opts?.signal ? { signal: opts.signal } : {}),
    });
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

  /** GET /v1/cycles — paginated list of commit cycles. */
  list(
    params?: ListCyclesParams,
    opts?: { signal?: AbortSignal },
  ): Promise<CyclesListResponse> {
    return this.http.request<CyclesListResponse>({
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
  leaderboard(opts?: {
    signal?: AbortSignal;
  }): Promise<VendorsLeaderboardResponse> {
    return this.http.request<VendorsLeaderboardResponse>({
      method: "GET",
      path: "/vendors/leaderboard",
      ...(opts?.signal ? { signal: opts.signal } : {}),
    });
  }
}

class AnomaliesAPI {
  constructor(private readonly http: HttpClient) {}

  /** GET /api/anomalies — paginated append-only event log. */
  list(
    params?: ListAnomaliesParams,
    opts?: { signal?: AbortSignal },
  ): Promise<AnomaliesListResponse> {
    return this.http.request<AnomaliesListResponse>({
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
