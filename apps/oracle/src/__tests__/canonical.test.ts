import { describe, expect, it } from "vitest";
import { canonicalObservationJson, OBSERVATION_FIELDS } from "@peptide-oracle/shared";
import { SPEC_OBS_1, SPEC_OBS_1_CANONICAL_JSON } from "./fixtures";

describe("canonicalObservationJson", () => {
  it("reproduces the §02.4.6 worked example for obs 1", () => {
    expect(canonicalObservationJson(SPEC_OBS_1)).toBe(SPEC_OBS_1_CANONICAL_JSON);
  });

  it("emits all 17 fields", () => {
    const json = canonicalObservationJson(SPEC_OBS_1);
    const parsed = JSON.parse(json) as Record<string, unknown>;
    expect(Object.keys(parsed)).toHaveLength(17);
    expect(Object.keys(parsed).sort()).toEqual([...OBSERVATION_FIELDS].sort());
  });

  it("sorts keys alphabetically (deterministic)", () => {
    const json = canonicalObservationJson(SPEC_OBS_1);
    const parsed = JSON.parse(json) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual([...OBSERVATION_FIELDS]);
  });

  it("emits no whitespace", () => {
    const json = canonicalObservationJson(SPEC_OBS_1);
    // Outside string literals there should be no whitespace at all.
    // Strip string contents (including escaped quotes) and confirm the
    // remaining structural JSON has no spaces / tabs / newlines.
    const stripped = json.replace(/"(?:[^"\\]|\\.)*"/g, '""');
    expect(/\s/.test(stripped)).toBe(false);
  });

  it("preserves null values for absent fields (§02.2.7)", () => {
    const json = canonicalObservationJson(SPEC_OBS_1);
    const parsed = JSON.parse(json) as Record<string, unknown>;
    expect(parsed.lead_time_days).toBe(null);
    expect(parsed.scrape_error).toBe(null);
  });

  it("throws on a missing required field", () => {
    const incomplete = { ...SPEC_OBS_1 } as unknown as Record<string, unknown>;
    delete incomplete.raw_html_hash;
    expect(() => canonicalObservationJson(incomplete as never)).toThrow(
      /missing required field "raw_html_hash"/,
    );
  });

  it("throws on an undefined field value (forces explicit null)", () => {
    const bad = { ...SPEC_OBS_1, raw_currency: undefined } as unknown;
    expect(() => canonicalObservationJson(bad as never)).toThrow(
      /raw_currency.*undefined/,
    );
  });

  it("ignores extra keys not in the canonical 17 (only the 17 are emitted)", () => {
    const withExtras = {
      ...SPEC_OBS_1,
      created_at: "2026-05-01T12:00:00.500+00:00",
      __junk__: "ignore me",
    } as unknown;
    const json = canonicalObservationJson(withExtras as never);
    const parsed = JSON.parse(json) as Record<string, unknown>;
    expect(parsed.created_at).toBeUndefined();
    expect(parsed.__junk__).toBeUndefined();
    expect(Object.keys(parsed)).toHaveLength(17);
  });
});
