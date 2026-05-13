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

export interface PeptideCurrentTwap {
  twap_value: string;
  computed_at: string;
  solana_signature: string | null;
  solana_slot: number | null;
  cluster: SolanaCluster;
  solscan_url: string | null;
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
