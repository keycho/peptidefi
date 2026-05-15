/**
 * Public response shapes for the BioHash REST API. These mirror the
 * JSON bodies returned by api.biohash.network as of v1; numeric fields
 * that the server returns as strings (to preserve full precision on
 * numeric/decimal columns from Postgres) are typed as `string` here.
 *
 * If you need numbers, parse them at the call site — the SDK does not
 * coerce to avoid silent precision loss.
 *
 * Shapes verified against the live API. Internal envelope types
 * (PeptidesListEnvelope, CyclesListEnvelope, etc.) describe the
 * raw HTTP body; the SDK unwraps single-array envelopes before
 * returning to the caller.
 */

export type SolanaCluster = "mainnet-beta" | "devnet" | "testnet";

export interface SolanaRef {
  signature: string;
  slot: number | null;
  cluster: SolanaCluster;
  solscan_url: string;
  explorer_url: string;
}

/* ─── /v1/peptides ────────────────────────────────────────────────── */

/**
 * Pin-state discriminator (SDK v0.2.1+, BioHash Peptide Index schema 1.1).
 *
 * 'pre_cohort' = the surfaced `ipfs_cid` points to a schema 1.1
 *   manifest whose `index_snapshot` is null (first pin, fired
 *   immediately after Solana finalization for the per-peptide SLA).
 * 'final' = the surfaced `ipfs_cid` points to a schema 1.1 manifest
 *   whose `index_snapshot` is populated (final pin, fired once the
 *   cohort completes for the hour).
 *
 * Null only when no pin has succeeded yet for the row.
 */
export type PinState = "pre_cohort" | "final";

export interface PeptideCurrentTwap {
  twap_value: string;
  computed_at: string;
  solana_signature: string | null;
  solana_slot: number | null;
  cluster: SolanaCluster;
  solscan_url: string | null;
  /**
   * IPFS CID of the pinned cycle manifest, COALESCE(final_ipfs_cid,
   * ipfs_cid) on the server. Null when no pin has succeeded yet.
   * Added in SDK v0.2.1 alongside `pin_state`.
   */
  ipfs_cid?: string | null;
  /** See {@link PinState}. Added in SDK v0.2.1. */
  pin_state?: PinState | null;
}

export interface PeptideListItem {
  peptide_id: number;
  code: string;
  display_name: string;
  full_name: string;
  twap_commits_count: number;
  current_twap: PeptideCurrentTwap | null;
}

/** Raw envelope returned by GET /v1/peptides; the SDK unwraps to `peptides`. */
export interface PeptidesListEnvelope {
  peptides: PeptideListItem[];
  count: number;
}

/* ─── /v1/peptides/:id ────────────────────────────────────────────── */

export interface PeptideDetail {
  peptide_id: number;
  code: string;
  display_name: string;
  full_name: string;
  is_active: boolean;
}

export interface PeptideTwapHistoryItem {
  twap_id: string;
  twap_value: string;
  computed_at: string;
  window_start: string;
  window_end: string;
  observation_set_root: string;
  status: string;
  cluster: SolanaCluster;
  solana: SolanaRef | null;
  finalized_at: string | null;
  /** See {@link PeptideCurrentTwap.ipfs_cid}. Added in SDK v0.2.1. */
  ipfs_cid?: string | null;
  /** See {@link PinState}. Added in SDK v0.2.1. */
  pin_state?: PinState | null;
  /**
   * BioHash Peptide Index level for the hour this commit belongs to,
   * or null if the cohort was incomplete for the hour. Returned as a
   * decimal string when the server preserves precision and as a number
   * otherwise. Added in SDK v0.2.1.
   */
  index_level?: number | string | null;
}

export interface PeptideDetailResponse {
  peptide: PeptideDetail;
  twap_history: PeptideTwapHistoryItem[];
  history_window: { start: string; end: string };
}

/* ─── /v1/peptides/:code/vendor-prices ────────────────────────────── */

export interface VendorPriceRow {
  vendor_name: string;
  price_usd_per_mg: string;
  observed_at: string;
}

export interface VendorPricesTwap {
  value_usd_per_mg: string;
  computed_at: string;
  cluster: SolanaCluster;
}

export interface VendorPricesSpread {
  min: string;
  max: string;
  variance_pct: number;
}

export interface VendorPricesResponse {
  peptide_code: string;
  twap: VendorPricesTwap;
  vendors: VendorPriceRow[];
  spread: VendorPricesSpread;
}

/* ─── /v1/peptides/:code/price-history ────────────────────────────── */

export type PriceHistoryAggregation = "daily" | "hourly";

export interface PriceHistoryParams {
  /** Window length in days. 1..90, default 14. */
  days?: number;
  /** Bucket aggregation. Default `"daily"`. */
  aggregation?: PriceHistoryAggregation;
  /** Optional supplier code (e.g. `"PUREHEALTH"`) to narrow the response. */
  vendor?: string;
}

export interface VendorPricePoint {
  /** ISO 8601 UTC bucket-start timestamp. */
  timestamp: string;
  /** Average price across all observations in the bucket. */
  price_usd_per_mg: number;
  /** Number of observations that contributed to the bucket. */
  observation_count: number;
}

export interface VendorPriceSeries {
  vendor_code: string;
  vendor_display_name: string;
  points: VendorPricePoint[];
}

export interface TwapHistoryPoint {
  timestamp: string;
  twap_value_usd_per_mg: number;
  cycle_count: number;
  /** See {@link PeptideCurrentTwap.ipfs_cid}. Added in SDK v0.2.1. */
  ipfs_cid?: string | null;
  /** See {@link PinState}. Added in SDK v0.2.1. */
  pin_state?: PinState | null;
}

export interface PeptidePriceHistoryResponse {
  peptide_code: string;
  peptide_display_name: string;
  window_start: string;
  window_end: string;
  aggregation: PriceHistoryAggregation;
  vendors: VendorPriceSeries[];
  twap_series: TwapHistoryPoint[];
}

/* ─── /v1/twaps/:id ───────────────────────────────────────────────── */

export interface TwapDetail {
  twap_id: string;
  peptide_code: string;
  algo: "filtered_median_v1" | string;
  twap_value: string;
  computed_at: string;
  window_start: string;
  window_end: string;
  observation_set_root: string;
  status: string;
  cluster: SolanaCluster;
  solana: SolanaRef | null;
  memo_payload: string;
  submitted_at: string | null;
  finalized_at: string | null;
  retry_count: number;
  last_error: string | null;
  input_observation_ids: number[];
}

/* ─── /v1/observations/:id ────────────────────────────────────────── */

export interface ObservationCanonical {
  /** The observation's primary key. Note: field name is `id`, not `observation_id`. */
  id: number;
  supplier_id: number;
  peptide_id: number;
  supplier_product_id: number;
  scraper_run_id: number;
  observed_at: string;
  raw_price: string | null;
  raw_currency: string | null;
  fx_rate_to_usd: string | null;
  price_usd_per_mg: string | null;
  raw_availability: string | null;
  availability_tier: string;
  lead_time_days: number | null;
  scrape_success: boolean;
  scrape_error: string | null;
  http_status: number | null;
  raw_html_hash: string | null;
}

export interface ObservationCommitRef {
  cycle_id: number;
  leaf_hash: string;
  leaf_index: number;
  merkle_root: string;
  status: string;
  solana_signature: string | null;
  solana_slot: number | null;
  solscan_url: string | null;
  explorer_url: string | null;
}

export interface MerkleProofStep {
  position: "left" | "right";
  hash: string;
}

export interface ObservationProof {
  merkle_root: string;
  proof: MerkleProofStep[];
}

export interface ObservationDetailResponse {
  observation: ObservationCanonical;
  canonical_leaf_json: string;
  computed_leaf_hash: string;
  commit: ObservationCommitRef | null;
  proof: ObservationProof | null;
}

/* ─── /v1/cycles ──────────────────────────────────────────────────── */

export interface CycleSummary {
  cycle_id: number;
  started_at: string;
  completed_at: string;
  observation_count: number;
  merkle_root: string;
  status: string | null;
  cluster: SolanaCluster;
  solana: SolanaRef | null;
  submitted_at: string | null;
  finalized_at: string | null;
}

/** Raw envelope returned by GET /v1/cycles; the SDK unwraps to `cycles`. */
export interface CyclesListEnvelope {
  cycles: CycleSummary[];
  next_cursor: number | null;
}

export interface CycleObservationRef {
  observation_id: number;
  leaf_index: number;
  leaf_hash: string;
}

export interface CycleDetail extends CycleSummary {
  memo_payload: string;
  retry_count: number;
  last_error: string | null;
  observations: CycleObservationRef[];
}

export type CycleStatusFilter =
  | "pending"
  | "submitted"
  | "finalized"
  | "failed"
  | "all";

export interface ListCyclesParams {
  limit?: number;
  cursor?: number;
  status?: CycleStatusFilter;
}

/* ─── /v1/verify/observation/:id ──────────────────────────────────── */

export interface VerifyCheck {
  name: string;
  passed: boolean;
  detail?: string;
}

export interface VerifyOnChain {
  signature: string | null;
  slot: number;
  cluster: SolanaCluster;
  memo: string;
  block_time?: number | null;
  solscan_url?: string;
  explorer_url?: string;
  /** Present when the API has the finalized→confirmed RPC fallback enabled. */
  commitment_used?: "finalized" | "confirmed";
}

export interface VerifyObservationSuccess {
  verified: true;
  observation_id: number;
  cycle_id: number;
  leaf_index: number;
  leaf_hash: string;
  merkle_root: string;
  proof: MerkleProofStep[];
  on_chain: VerifyOnChain;
  checks: VerifyCheck[];
  /** Present when the API has the finalized→confirmed RPC fallback enabled. */
  verified_at_commitment?: "finalized" | "confirmed";
}

export interface VerifyObservationFailure {
  verified: false;
  observation_id: number;
  cycle_id?: number;
  /** "pending_commit" indicates the observation will become verifiable later. */
  status?: "pending_commit";
  failure_reason?: string;
  failure_detail?: string;
  failure_code?: string;
  detail?: string;
  retry_after_seconds?: number;
  checks: VerifyCheck[];
  on_chain?: Partial<VerifyOnChain>;
  proof?: MerkleProofStep[];
}

export type VerifyObservationResponse =
  | VerifyObservationSuccess
  | VerifyObservationFailure;

/* ─── /vendors/leaderboard ────────────────────────────────────────── */

export interface VendorLeaderboardEntry {
  rank: number;
  supplier_code: string;
  supplier_display_name: string;
  logo_url: string | null;
  coverage_count: number;
  in_stock_rate: string;
  update_frequency: number;
  cheapest_pct: string;
  avg_spread_vs_twap: string | null;
  freshness_seconds: number;
  composite_score: string;
}

/** Raw envelope returned by GET /vendors/leaderboard; the SDK unwraps to `vendors`. */
export interface VendorsLeaderboardEnvelope {
  vendors: VendorLeaderboardEntry[];
}

/* ─── /api/anomalies ──────────────────────────────────────────────── */

export type AnomalySeverity = "info" | "warning" | "error" | "critical";

export interface AnomalyEvent {
  id: number;
  occurred_at: string;
  severity: AnomalySeverity;
  event_type: string;
  description: string;
  vendor_id: string | null;
  peptide_id: string | null;
  observation_id: number | null;
  cycle_id: number | null;
  context: Record<string, unknown> | null;
  resolved_at: string | null;
  resolved_by: string | null;
}

/** Raw envelope returned by GET /api/anomalies; the SDK unwraps to `events`. */
export interface AnomaliesListEnvelope {
  events: AnomalyEvent[];
  /** Opaque composite cursor: `${timestamp}_${id}`. Pass back as `cursor`. */
  next_cursor: string | null;
}

export interface ListAnomaliesParams {
  limit?: number;
  cursor?: string;
  severity?: AnomalySeverity;
  event_type?: string;
  vendor_id?: string;
  peptide_id?: string;
  since?: string;
  until?: string;
}

/* ─── /v1/index/* (SDK v0.2.1, BioHash Peptide Index) ─────────────── */

/**
 * One row from the BioHash Peptide Index hourly history. Same shape
 * returned by /v1/index/current (`index` field), /v1/index/history
 * (each element of the `history` array), and /v1/index/components
 * (the `index` field, which mirrors `current` for the same hour).
 */
export interface IndexHistoryRow {
  /** Top-of-hour UTC timestamp (ISO 8601). Primary key in index_history. */
  hour_start: string;
  /** Equal-weight index level. Sum of per-peptide contributions. */
  level: number;
  /**
   * sha256 (lowercase hex) of the canonical components vector. See
   * docs/PUBLIC_API.md "Manifest schema (version 1.1)" for the
   * byte-for-byte reproducibility recipe.
   */
  components_hash: string;
  /** When the index was computed (wall clock, not the hour itself). */
  computed_at: string;
  /** Configured baseline date (ISO date), shared across the cohort. */
  baseline_date: string;
  /** Configured baseline level (currently 1000.00). */
  baseline_level: number;
  /**
   * Best-available IPFS CIDs for the 29 cohort manifests pinned for
   * this hour, in peptide_code-sorted order. `null` when no CIDs are
   * recorded yet (pre-launch or pinning disabled). May contain fewer
   * than N entries if some peptides' pins failed in both passes.
   */
  ipfs_cids: string[] | null;
}

export interface IndexCurrentResponse {
  /** Null when index_history is empty (pre-launch). */
  index: IndexHistoryRow | null;
}

export interface IndexHistoryResponse {
  history: IndexHistoryRow[];
  window: {
    from: string;
    to: string;
    /** Cap the server enforces on the requested window length. */
    max_days: number;
  };
}

export interface IndexHistoryParams {
  /** ISO 8601 UTC start of the requested window, inclusive. */
  from?: string;
  /** ISO 8601 UTC end of the requested window, inclusive. */
  to?: string;
}

/** Per-peptide breakdown of the most recent index level. */
export interface IndexComponentEntry {
  peptide_code: string;
  /** Decimal string (from PG numeric). */
  baseline_twap: string;
  /** Configured baseline date (ISO date). */
  baseline_date: string;
  /**
   * Date of the finalized TWAP whose value is recorded in
   * baseline_twap. Differs from baseline_date when the peptide
   * started observation after the configured baseline.
   */
  actual_baseline_date: string;
  /** Current TWAP for the hour matching index_history's latest row. */
  current_twap: number | null;
  /** 1/N. Same float across every cohort entry for the same hour. */
  weight: number;
  /** (current_twap / baseline_twap) * (baseline_level / N). */
  contribution: number | null;
}

export interface IndexComponentsResponse {
  /** The hour these components belong to. Null when no index exists yet. */
  index: IndexHistoryRow | null;
  components: IndexComponentEntry[];
}
