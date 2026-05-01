import type { Observation } from "../canonical";

/**
 * Test fixtures from the spec's §02.4.6 worked example. Field values
 * sourced directly from the spec's "Observations 2 / 3 / 4" table;
 * obs 1 also exposes its full canonical body inline for the
 * canonical-form regression test.
 */

export const SPEC_OBS_1: Observation = {
  id: 1001,
  supplier_id: 7,
  peptide_id: 12,
  supplier_product_id: 140,
  scraper_run_id: 200,
  observed_at: "2026-05-01T12:00:00.000Z",
  raw_price: "54.50",
  raw_currency: "USD",
  fx_rate_to_usd: "1.000000",
  price_usd_per_mg: "3.633333",
  raw_availability: "in stock",
  availability_tier: "in_stock",
  lead_time_days: null,
  scrape_success: true,
  scrape_error: null,
  http_status: 200,
  raw_html_hash: "0xaaaaaaaa",
};

export const SPEC_OBS_2: Observation = {
  id: 1002,
  supplier_id: 4,
  peptide_id: 12,
  supplier_product_id: 141,
  scraper_run_id: 200,
  observed_at: "2026-05-01T12:00:01.000Z",
  raw_price: "75.00",
  raw_currency: "USD",
  fx_rate_to_usd: "1.000000",
  price_usd_per_mg: "5.000000",
  raw_availability: "in stock",
  availability_tier: "in_stock",
  lead_time_days: null,
  scrape_success: true,
  scrape_error: null,
  http_status: 200,
  raw_html_hash: "0xbbbbbbbb",
};

export const SPEC_OBS_3: Observation = {
  id: 1003,
  supplier_id: 6,
  peptide_id: 12,
  supplier_product_id: 142,
  scraper_run_id: 200,
  observed_at: "2026-05-01T12:00:02.000Z",
  raw_price: null,
  raw_currency: "USD",
  fx_rate_to_usd: "1.000000",
  price_usd_per_mg: null,
  raw_availability: "sold out",
  availability_tier: "out_of_stock",
  lead_time_days: null,
  scrape_success: true,
  scrape_error: null,
  http_status: 200,
  raw_html_hash: "0xcccccccc",
};

export const SPEC_OBS_4: Observation = {
  id: 1004,
  supplier_id: 1,
  peptide_id: 12,
  supplier_product_id: 143,
  scraper_run_id: 200,
  observed_at: "2026-05-01T12:00:03.000Z",
  raw_price: null,
  raw_currency: null,
  fx_rate_to_usd: null,
  price_usd_per_mg: null,
  raw_availability: null,
  availability_tier: "unknown",
  lead_time_days: null,
  scrape_success: false,
  scrape_error: "403 Forbidden",
  http_status: 403,
  raw_html_hash: null,
};

/**
 * Full canonical body of obs 1, as published in §02.4.6. Test asserts
 * canonicalObservationJson(SPEC_OBS_1) === this string byte-for-byte.
 */
export const SPEC_OBS_1_CANONICAL_JSON =
  '{"availability_tier":"in_stock","fx_rate_to_usd":"1.000000","http_status":200,"id":1001,"lead_time_days":null,"observed_at":"2026-05-01T12:00:00.000Z","peptide_id":12,"price_usd_per_mg":"3.633333","raw_availability":"in stock","raw_currency":"USD","raw_html_hash":"0xaaaaaaaa","raw_price":"54.50","scrape_error":null,"scrape_success":true,"scraper_run_id":200,"supplier_id":7,"supplier_product_id":140}';

// Expected hashes from §02.4.6 worked example. These are the regression
// vector — implementations that don't produce these for the fixtures
// above are wrong (per spec §02.4.7 implementation note).

export const SPEC_LEAF_HASHES = {
  L1: "0x1e16c4304f26d820628da73d43579cb3dd6e5f5a9a47a2cb299ace9ee7330594",
  L2: "0x959381874f74d9903fbdeb87ad8c1d77e7b9e3a066abcc0d14b467fb0cbfafde",
  L3: "0xee80eadf0626319bf490cd0d7aabae0c737d905c09d6e5e36f645b19cdf221d3",
  L4: "0xea784b0d61953f0f61a236f49fa7bbfae729a3b5a874ef9e3dfa140ecc21b567",
} as const;

export const SPEC_INNER_HASHES = {
  N12: "0xae4cca3083ad2b4cdd9a444dc20b41861f7c41d8521324d52e8c94a3faf2d0d2",
  N34: "0x0ec68c7f5b4d998218079a2bc8a7ff6f4b29297e9b755cacf051433cb62479d4",
} as const;

export const SPEC_ROOT =
  "0x9c0516afa29a523ee901e26fd372c285d273671b5e08e7be606d6b8e8d22789e";

/**
 * Reference cycle commit memo from §02.2.2 — observation_count=118
 * (representative of a real cycle, NOT the 4 from the worked example
 * above). 226 bytes UTF-8 per spec.
 */
export const SPEC_CYCLE_MEMO_INPUT = {
  cycle_id: 200,
  observation_count: 118,
  merkle_root: SPEC_ROOT,
  started_at: "2026-05-01T12:00:00.000Z",
  completed_at: "2026-05-01T12:00:09.000Z",
} as const;

export const SPEC_CYCLE_MEMO_JSON =
  '{"completed_at":"2026-05-01T12:00:09.000Z","cycle_id":200,"merkle_root":"0x9c0516afa29a523ee901e26fd372c285d273671b5e08e7be606d6b8e8d22789e","observation_count":118,"started_at":"2026-05-01T12:00:00.000Z","type":"cycle","v":1}';

export const SPEC_CYCLE_MEMO_BYTES = 226;
