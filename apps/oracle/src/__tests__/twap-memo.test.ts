import { describe, expect, it } from "vitest";
import { canonicalTwapMemoJson } from "../twap/canonical";
import { buildTwapCommit, TWAP_ALGO_V1 } from "../twap/memo";
import {
  SPEC_OBS_1,
  SPEC_OBS_2,
  SPEC_OBS_3,
  SPEC_OBS_4,
  SPEC_ROOT,
  SPEC_TWAP_MEMO_BYTES,
  SPEC_TWAP_MEMO_INPUT,
  SPEC_TWAP_MEMO_JSON,
} from "./fixtures";

describe("canonicalTwapMemoJson", () => {
  it("byte-exact: reproduces the §02.2.3 worked example", () => {
    expect(canonicalTwapMemoJson(SPEC_TWAP_MEMO_INPUT)).toBe(
      SPEC_TWAP_MEMO_JSON,
    );
  });

  it("size: 312 bytes UTF-8 (matches §02.2.3 published size)", () => {
    const bytes = Buffer.byteLength(SPEC_TWAP_MEMO_JSON, "utf-8");
    expect(bytes).toBe(SPEC_TWAP_MEMO_BYTES);
  });

  it("keys are sorted ascending", () => {
    const keys = Object.keys(JSON.parse(SPEC_TWAP_MEMO_JSON));
    const sorted = [...keys].sort();
    expect(keys).toEqual(sorted);
  });

  it("type='twap' and v=1 are always present even though not in the input", () => {
    const parsed = JSON.parse(SPEC_TWAP_MEMO_JSON);
    expect(parsed.type).toBe("twap");
    expect(parsed.v).toBe(1);
  });

  it("throws if a required field is missing", () => {
    const broken = { ...SPEC_TWAP_MEMO_INPUT };
    delete (broken as Record<string, unknown>).algo;
    expect(() => canonicalTwapMemoJson(broken as never)).toThrow(/algo/);
  });

  it("changes byte-exactly on any field change", () => {
    const a = canonicalTwapMemoJson(SPEC_TWAP_MEMO_INPUT);
    const b = canonicalTwapMemoJson({
      ...SPEC_TWAP_MEMO_INPUT,
      twap_value: "5.998001",
    });
    expect(a).not.toBe(b);
  });
});

describe("buildTwapCommit", () => {
  it("uses the existing Phase A primitives to compute observation_set_root", () => {
    const result = buildTwapCommit({
      peptide_code: "BPC157",
      twap_value: "5.998000",
      computed_at: SPEC_TWAP_MEMO_INPUT.computed_at,
      window_start: SPEC_TWAP_MEMO_INPUT.window_start,
      window_end: SPEC_TWAP_MEMO_INPUT.window_end,
      observations: [SPEC_OBS_1, SPEC_OBS_2, SPEC_OBS_3, SPEC_OBS_4],
    });
    // Same observation set as §02.4.6 → same root as SPEC_ROOT.
    expect(result.observationSetRootHex).toBe(SPEC_ROOT);
  });

  it("byte-exact memo when observations match SPEC_ROOT", () => {
    const result = buildTwapCommit({
      peptide_code: "BPC157",
      twap_value: "5.998000",
      computed_at: SPEC_TWAP_MEMO_INPUT.computed_at,
      window_start: SPEC_TWAP_MEMO_INPUT.window_start,
      window_end: SPEC_TWAP_MEMO_INPUT.window_end,
      observations: [SPEC_OBS_1, SPEC_OBS_2, SPEC_OBS_3, SPEC_OBS_4],
    });
    expect(result.memo).toBe(SPEC_TWAP_MEMO_JSON);
  });

  it("defaults algo to 'filtered_median_v1' (matches worker's twap.ts)", () => {
    const result = buildTwapCommit({
      peptide_code: "BPC157",
      twap_value: "5.998000",
      computed_at: SPEC_TWAP_MEMO_INPUT.computed_at,
      window_start: SPEC_TWAP_MEMO_INPUT.window_start,
      window_end: SPEC_TWAP_MEMO_INPUT.window_end,
      observations: [SPEC_OBS_1, SPEC_OBS_2],
    });
    const parsed = JSON.parse(result.memo);
    expect(parsed.algo).toBe(TWAP_ALGO_V1);
  });

  it("throws on empty observations[] (§02.2.3 requires a non-empty set)", () => {
    expect(() =>
      buildTwapCommit({
        peptide_code: "BPC157",
        twap_value: "5.998000",
        computed_at: SPEC_TWAP_MEMO_INPUT.computed_at,
        window_start: SPEC_TWAP_MEMO_INPUT.window_start,
        window_end: SPEC_TWAP_MEMO_INPUT.window_end,
        observations: [],
      }),
    ).toThrow(/empty/);
  });

  it("changes the root if the observation set changes", () => {
    const a = buildTwapCommit({
      peptide_code: "BPC157",
      twap_value: "5.998000",
      computed_at: SPEC_TWAP_MEMO_INPUT.computed_at,
      window_start: SPEC_TWAP_MEMO_INPUT.window_start,
      window_end: SPEC_TWAP_MEMO_INPUT.window_end,
      observations: [SPEC_OBS_1, SPEC_OBS_2, SPEC_OBS_3, SPEC_OBS_4],
    });
    const b = buildTwapCommit({
      peptide_code: "BPC157",
      twap_value: "5.998000",
      computed_at: SPEC_TWAP_MEMO_INPUT.computed_at,
      window_start: SPEC_TWAP_MEMO_INPUT.window_start,
      window_end: SPEC_TWAP_MEMO_INPUT.window_end,
      observations: [SPEC_OBS_1, SPEC_OBS_2],
    });
    expect(a.observationSetRootHex).not.toBe(b.observationSetRootHex);
  });
});
