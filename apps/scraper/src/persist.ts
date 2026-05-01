import os from "node:os";
import {
  type AdminClient,
  type Numeric,
  type ScrapeResult,
  computePriceUsdPerMg,
  pctDiff,
  rateToUsd,
  type FxRates,
} from "@peptide-oracle/shared";

/**
 * All Supabase writes for a scraper cycle live here. The runner orchestrates
 * order; this module just owns the SQL surface so the runner stays readable.
 *
 * Idempotency note: the scraper never retries an in-flight insert, so we
 * don't use idempotency keys here. Re-running a cycle simply produces another
 * row with a later observed_at — that's the audit trail we want.
 *
 * Numeric column note: `supabase gen types typescript` maps Postgres numeric
 * columns to JS `number`, while our domain math uses Numeric strings (see
 * shared/numeric.ts). For scraper-relevant magnitudes (FX rates ≈ 1, prices
 * ≤ ~$10k, masses ≤ a few grams) Number's ~15 sigfigs are plenty, and
 * supabase-js JSON.stringify-serialises the number losslessly into the wire
 * payload, so Postgres receives the exact decimal string. We convert at the
 * persist boundary only — domain code stays string-typed. AMM code (40,18
 * precision) will use a different path later.
 */
function numToNumber(v: Numeric | null): number | null {
  return v === null ? null : Number(v);
}

export type RunStatus = "running" | "completed" | "partial" | "failed";

/**
 * Open a scraper_runs row at the start of a cycle. Returns the new row's id
 * so closeRun() and writeObservation() can reference it.
 */
export async function openRun(supabase: AdminClient): Promise<number> {
  const host = process.env.HOST_OVERRIDE ?? os.hostname();
  const gitSha = process.env.GIT_SHA ?? null;

  const { data, error } = await supabase
    .from("scraper_runs")
    .insert({
      started_at: new Date().toISOString(),
      status: "running",
      host,
      git_sha: gitSha,
    })
    .select("id")
    .single();

  if (error) throw new Error(`openRun: ${error.message}`);
  return data.id;
}

export interface CloseRunInput {
  products_attempted: number;
  products_succeeded: number;
  products_failed: number;
  status: RunStatus;
  error_summary: string | null;
}

export async function closeRun(
  supabase: AdminClient,
  runId: number,
  input: CloseRunInput,
): Promise<void> {
  const { error } = await supabase
    .from("scraper_runs")
    .update({
      finished_at: new Date().toISOString(),
      status: input.status,
      products_attempted: input.products_attempted,
      products_succeeded: input.products_succeeded,
      products_failed: input.products_failed,
      error_summary: input.error_summary,
    })
    .eq("id", runId);
  if (error) throw new Error(`closeRun: ${error.message}`);
}

export interface ProductRow {
  id: number;
  supplier_id: number;
  peptide_id: number;
  supplier_code: string;
  supplier_sku: string;
  product_url: string;
  product_name: string;
  mass_per_unit_mg: Numeric;
}

/**
 * Insert a supplier_observations row. price_usd_per_mg is computed here
 * (not in the supplier module) using the FX snapshot for this cycle.
 *
 * Returns the inserted observation's id so the caller can attach an
 * availability_events row to it.
 */
export async function writeObservation(
  supabase: AdminClient,
  args: {
    runId: number;
    product: ProductRow;
    result: ScrapeResult;
    fxRates: FxRates | null;
    observedAt: Date;
  },
): Promise<{ id: number; price_usd_per_mg: Numeric | null }> {
  const { runId, product, result, fxRates, observedAt } = args;

  const fx = rateToUsd(fxRates, result.raw_currency);
  const priceUsdPerMg = computePriceUsdPerMg(
    result.raw_price,
    fx,
    result.mass_mg ?? product.mass_per_unit_mg,
  );

  const { data, error } = await supabase
    .from("supplier_observations")
    .insert({
      supplier_product_id: product.id,
      peptide_id: product.peptide_id,
      supplier_id: product.supplier_id,
      observed_at: observedAt.toISOString(),
      scraper_run_id: runId,
      raw_price: numToNumber(result.raw_price),
      raw_currency: result.raw_currency,
      fx_rate_to_usd: numToNumber(fx),
      price_usd_per_mg: numToNumber(priceUsdPerMg),
      raw_availability: result.raw_availability,
      availability_tier: result.availability_tier,
      lead_time_days: result.lead_time_days,
      scrape_success: result.scrape_success,
      scrape_error: result.scrape_error,
      http_status: result.http_status,
      raw_html_hash: result.raw_html_hash,
    })
    .select("id")
    .single();

  if (error) throw new Error(`writeObservation: ${error.message}`);
  return { id: data.id, price_usd_per_mg: priceUsdPerMg };
}

/**
 * Fetch the most recent SUCCESSFUL observation for a product so we can
 * detect tier transitions. Failed observations are excluded — a scrape
 * failure shouldn't masquerade as an in_stock → unknown transition.
 */
export async function getPreviousSuccess(
  supabase: AdminClient,
  productId: number,
  beforeId: number,
): Promise<{
  id: number;
  availability_tier: ScrapeResult["availability_tier"];
} | null> {
  const { data, error } = await supabase
    .from("supplier_observations")
    .select("id, availability_tier")
    .eq("supplier_product_id", productId)
    .eq("scrape_success", true)
    .lt("id", beforeId)
    .order("observed_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(`getPreviousSuccess: ${error.message}`);
  return data;
}

/**
 * Insert an availability_events row. Caller has already determined that the
 * tier changed.
 */
export async function recordAvailabilityChange(
  supabase: AdminClient,
  args: {
    product: ProductRow;
    previousObservationId: number | null;
    currentObservationId: number;
    previousTier: ScrapeResult["availability_tier"] | null;
    currentTier: ScrapeResult["availability_tier"];
  },
): Promise<void> {
  const { error } = await supabase.from("availability_events").insert({
    peptide_id: args.product.peptide_id,
    supplier_id: args.product.supplier_id,
    supplier_product_id: args.product.id,
    event_type: "availability_change",
    detected_at: new Date().toISOString(),
    previous_observation_id: args.previousObservationId,
    current_observation_id: args.currentObservationId,
    previous_tier: args.previousTier,
    current_tier: args.currentTier,
  });
  if (error) throw new Error(`recordAvailabilityChange: ${error.message}`);
}

/**
 * On every successful scrape, refresh supplier_products.mass_per_unit_mg to
 * the parsed value. If the new mass drifts >5% from the stored mass, log a
 * MASS_CHANGE_DETECTED warning so we notice silent supplier-side packaging
 * changes — but follow the supplier either way.
 */
export async function updateProductMass(
  supabase: AdminClient,
  product: ProductRow,
  parsedMassMg: Numeric,
): Promise<void> {
  const stored = product.mass_per_unit_mg;
  const delta = pctDiff(stored, parsedMassMg);

  if (delta > 5) {
    console.warn(
      `[MASS_CHANGE_DETECTED] supplier_product=${product.id} ` +
        `(${product.supplier_code}/${product.supplier_sku}) ` +
        `${stored} → ${parsedMassMg} (Δ ${delta.toFixed(2)}%)`,
    );
  }

  const { error } = await supabase
    .from("supplier_products")
    .update({ mass_per_unit_mg: Number(parsedMassMg) })
    .eq("id", product.id);
  if (error) throw new Error(`updateProductMass: ${error.message}`);
}
