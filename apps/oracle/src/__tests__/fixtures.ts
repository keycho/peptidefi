import type { Observation } from "@peptide-oracle/shared";

/**
 * Test fixtures from the spec's §02.4.6 worked example. Field values
 * sourced directly from the spec's "Observations 2 / 3 / 4" table;
 * obs 1 also exposes its full canonical body inline for the
 * canonical-form regression test.
 *
 * Decimal scales reflect schema migration 0004:
 *   raw_price          numeric(20, 6)  → 6 decimal places
 *   fx_rate_to_usd     numeric(20, 8)  → 8 decimal places
 *   price_usd_per_mg   numeric(20, 6)  → 6 decimal places
 *
 * Per spec §2.5, the canonical decimal string is whatever
 * Postgres returns for `column::text` — a fixed-scale numeric
 * column always renders with that exact scale. The leaf hashes
 * + ROOT below are computed against the schema-correct strings,
 * not the un-scaled forms used in the v1 spec draft.
 */

export const SPEC_OBS_1: Observation = {
  id: 1001,
  supplier_id: 7,
  peptide_id: 12,
  supplier_product_id: 140,
  scraper_run_id: 200,
  observed_at: "2026-05-01T12:00:00.000Z",
  raw_price: "54.500000",
  raw_currency: "USD",
  fx_rate_to_usd: "1.00000000",
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
  raw_price: "75.000000",
  raw_currency: "USD",
  fx_rate_to_usd: "1.00000000",
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
  fx_rate_to_usd: "1.00000000",
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
  '{"availability_tier":"in_stock","fx_rate_to_usd":"1.00000000","http_status":200,"id":1001,"lead_time_days":null,"observed_at":"2026-05-01T12:00:00.000Z","peptide_id":12,"price_usd_per_mg":"3.633333","raw_availability":"in stock","raw_currency":"USD","raw_html_hash":"0xaaaaaaaa","raw_price":"54.500000","scrape_error":null,"scrape_success":true,"scraper_run_id":200,"supplier_id":7,"supplier_product_id":140}';

// Expected hashes from §02.4.6 worked example. These are the regression
// vector — implementations that don't produce these for the fixtures
// above are wrong (per spec §02.4.7 implementation note).
//
// Recomputed from SPEC_OBS_1..4 with schema-correct decimal scales
// (numeric(20,6) for prices, numeric(20,8) for fx_rate_to_usd). The
// previous draft values from the v1 spec used un-scaled strings
// (e.g., raw_price "54.50") that don't reproduce off the actual DB.

export const SPEC_LEAF_HASHES = {
  L1: "0x799fe69ea74165d8321268f25d560e3ed48f57ab4d0552a9d866acda15238db5",
  L2: "0x1eabe587a9f12e9a7cce5e0d601146e2e4011100961f19d2e11c8759f52f72b2",
  L3: "0x8c02334f0c170326a91dd6d64b27a44b48ff67d2dbc1afb9986ec7ba2eb6db23",
  L4: "0xea784b0d61953f0f61a236f49fa7bbfae729a3b5a874ef9e3dfa140ecc21b567",
} as const;

export const SPEC_INNER_HASHES = {
  N12: "0xab602f7b7e6eafb0c9a8d67d372a05df930f4236b8188467f61aa01055f0fbdb",
  N34: "0xe8311c85eda90c265477f52a679554cebfff67611144f1a52f16a1a753d232b8",
} as const;

export const SPEC_ROOT =
  "0x100eeb8fabe2d1cb200324e8ccbcc3ead12cfa18224a744cbe11d813dcb32af8";

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
  '{"completed_at":"2026-05-01T12:00:09.000Z","cycle_id":200,"merkle_root":"0x100eeb8fabe2d1cb200324e8ccbcc3ead12cfa18224a744cbe11d813dcb32af8","observation_count":118,"started_at":"2026-05-01T12:00:00.000Z","type":"cycle","v":1}';

export const SPEC_CYCLE_MEMO_BYTES = 226;

/**
 * Reference TWAP commit memo from §02.2.3. The example uses
 * peptide BPC157 and an observation_set_root reused from §02.4.6
 * for visual continuity (NOT the real Merkle root over the BPC157
 * observations — the spec deliberately picks a known-named root
 * to keep the examples cross-referenceable).
 *
 * Size: 312 bytes UTF-8 per the §02.2.3 spec text.
 */
export const SPEC_TWAP_MEMO_INPUT = {
  algo: "filtered_median_v1",
  peptide_code: "BPC157",
  twap_value: "5.998000",
  computed_at: "2026-05-01T12:00:00.000Z",
  window_start: "2026-05-01T11:00:00.000Z",
  window_end: "2026-05-01T12:00:00.000Z",
  observation_set_root: SPEC_ROOT,
} as const;

export const SPEC_TWAP_MEMO_JSON =
  '{"algo":"filtered_median_v1","computed_at":"2026-05-01T12:00:00.000Z","observation_set_root":"0x100eeb8fabe2d1cb200324e8ccbcc3ead12cfa18224a744cbe11d813dcb32af8","peptide_code":"BPC157","twap_value":"5.998000","type":"twap","v":1,"window_end":"2026-05-01T12:00:00.000Z","window_start":"2026-05-01T11:00:00.000Z"}';

export const SPEC_TWAP_MEMO_BYTES = 312;
