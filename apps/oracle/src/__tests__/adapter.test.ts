import { describe, expect, it } from "vitest";
import {
  rowToObservation,
  canonicalTimestamp,
  type SupplierObservationRow,
} from "../db/observation-adapter";
import { canonicalObservationJson } from "@peptide-oracle/shared";
import { bytesToHex0x, leafHash } from "@peptide-oracle/shared";
import {
  SPEC_OBS_1,
  SPEC_OBS_1_CANONICAL_JSON,
  SPEC_LEAF_HASHES,
} from "./fixtures";

/**
 * Adapter regression tests. The byte-exact L1 reproduction proves the
 * full pipeline works end-to-end:
 *
 *   PG row → rowToObservation → canonicalObservationJson → leafHash
 *
 * matches the spec §02.4.6 worked example for L1. If this test goes red,
 * something in the adapter is doing a non-canonical transformation
 * (truncating differently, parsing a numeric to float, etc.) and any
 * commits we send out won't reproduce off the database.
 */

/**
 * The PG row that, when fed through the adapter, must produce
 * SPEC_OBS_1. Mirrors the row that a fresh `INSERT` would have for
 * the spec's first observation.
 *
 * Decimals are strings (per §02.5 / postgres.js numeric default).
 * The id columns are bigints (postgres.js bigint default for int8).
 * observed_at is a Date (postgres.js timestamptz default).
 */
const SPEC_ROW_1: SupplierObservationRow = {
  id: 1001n,
  supplier_id: 7n,
  peptide_id: 12n,
  supplier_product_id: 140n,
  scraper_run_id: 200n,
  observed_at: new Date("2026-05-01T12:00:00.000Z"),
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

describe("rowToObservation", () => {
  it("produces the canonical Observation that matches SPEC_OBS_1 exactly", () => {
    const obs = rowToObservation(SPEC_ROW_1);
    expect(obs).toEqual(SPEC_OBS_1);
  });

  it("byte-exact: row → adapter → canonical JSON matches §02.4.6 obs 1", () => {
    const obs = rowToObservation(SPEC_ROW_1);
    const json = canonicalObservationJson(obs);
    expect(json).toBe(SPEC_OBS_1_CANONICAL_JSON);
  });

  it("byte-exact: row → adapter → leaf hash equals SPEC_LEAF_HASHES.L1", () => {
    const obs = rowToObservation(SPEC_ROW_1);
    const hash = leafHash(obs);
    expect(bytesToHex0x(hash)).toBe(SPEC_LEAF_HASHES.L1);
  });

  it("accepts plain numbers for id columns when in safe-integer range", () => {
    const row: SupplierObservationRow = {
      ...SPEC_ROW_1,
      id: 1001,
      supplier_id: 7,
      peptide_id: 12,
      supplier_product_id: 140,
      scraper_run_id: 200,
    };
    expect(rowToObservation(row)).toEqual(SPEC_OBS_1);
  });

  it("accepts an ISO-string observed_at (supabase-js wire shape) and re-renders to ms-precision UTC", () => {
    const row: SupplierObservationRow = {
      ...SPEC_ROW_1,
      observed_at: "2026-05-01T12:00:00.000+00:00",
    };
    const obs = rowToObservation(row);
    expect(obs.observed_at).toBe("2026-05-01T12:00:00.000Z");
  });

  it("throws if a numeric column arrives as a JS number (driver misconfig — would float-truncate)", () => {
    const row: SupplierObservationRow = {
      ...SPEC_ROW_1,
      raw_price: 54.5 as unknown as string,
    };
    expect(() => rowToObservation(row)).toThrow(/raw_price/);
  });

  it("throws if a bigint id exceeds JS safe integer range", () => {
    const row: SupplierObservationRow = {
      ...SPEC_ROW_1,
      id: BigInt(Number.MAX_SAFE_INTEGER) + 1n,
    };
    expect(() => rowToObservation(row)).toThrow(/safe integer/);
  });

  it("preserves null decimals (out-of-stock observation)", () => {
    const row: SupplierObservationRow = {
      ...SPEC_ROW_1,
      raw_price: null,
      price_usd_per_mg: null,
    };
    const obs = rowToObservation(row);
    expect(obs.raw_price).toBeNull();
    expect(obs.price_usd_per_mg).toBeNull();
  });
});

describe("canonicalTimestamp", () => {
  it("truncates sub-millisecond precision (matches §02.6 'truncate, not round')", () => {
    // PG can store microseconds; JS Date constructor truncates at ms.
    const d = new Date("2026-05-01T12:00:00.123456Z");
    expect(canonicalTimestamp(d, "observed_at")).toBe("2026-05-01T12:00:00.123Z");
  });

  it("normalizes any non-UTC ISO offset to UTC Z form", () => {
    const out = canonicalTimestamp(
      "2026-05-01T14:00:00.000+02:00",
      "observed_at",
    );
    expect(out).toBe("2026-05-01T12:00:00.000Z");
  });

  it("output is exactly 24 chars (§02.6 fixed-width)", () => {
    const out = canonicalTimestamp(
      new Date("2026-05-01T12:00:00.000Z"),
      "observed_at",
    );
    expect(out.length).toBe(24);
  });

  it("throws on an invalid date string", () => {
    expect(() => canonicalTimestamp("not-a-date", "observed_at")).toThrow(
      /invalid date/,
    );
  });
});
