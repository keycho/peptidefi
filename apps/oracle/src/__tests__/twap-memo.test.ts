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
  SPEC_TWAP_MEMO_BYTES_V1,
  SPEC_TWAP_MEMO_INPUT,
  SPEC_TWAP_MEMO_JSON,
  SPEC_TWAP_MEMO_JSON_V1,
} from "./fixtures";

describe("canonicalTwapMemoJson — v=2 (current default)", () => {
  it("byte-exact: reproduces the §02.2.3 v=2 worked example", () => {
    expect(canonicalTwapMemoJson(SPEC_TWAP_MEMO_INPUT)).toBe(
      SPEC_TWAP_MEMO_JSON,
    );
  });

  it("size: 356 bytes UTF-8 (v=2 worked example)", () => {
    expect(Buffer.byteLength(SPEC_TWAP_MEMO_JSON, "utf-8")).toBe(
      SPEC_TWAP_MEMO_BYTES,
    );
  });

  it("keys are sorted ascending; v=2 has 11 keys including project + url", () => {
    const keys = Object.keys(JSON.parse(SPEC_TWAP_MEMO_JSON));
    expect(keys).toEqual([
      "algo",
      "computed_at",
      "observation_set_root",
      "peptide_code",
      "project",
      "twap_value",
      "type",
      "url",
      "v",
      "window_end",
      "window_start",
    ]);
  });

  it("v=2 sets project='biohash' + url='biohash.network' + type='twap' + v=2", () => {
    const parsed = JSON.parse(SPEC_TWAP_MEMO_JSON);
    expect(parsed.type).toBe("twap");
    expect(parsed.v).toBe(2);
    expect(parsed.project).toBe("biohash");
    expect(parsed.url).toBe("biohash.network");
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

describe("canonicalTwapMemoJson — v=1 (backward compat)", () => {
  it("byte-exact: explicit v=1 reproduces the legacy worked example", () => {
    expect(canonicalTwapMemoJson({ ...SPEC_TWAP_MEMO_INPUT, v: 1 })).toBe(
      SPEC_TWAP_MEMO_JSON_V1,
    );
  });

  it("v=1 is 312 bytes (legacy fixture)", () => {
    const memo = canonicalTwapMemoJson({ ...SPEC_TWAP_MEMO_INPUT, v: 1 });
    expect(Buffer.byteLength(memo, "utf-8")).toBe(SPEC_TWAP_MEMO_BYTES_V1);
  });

  it("v=1 omits project + url and sets v=1", () => {
    const memo = canonicalTwapMemoJson({ ...SPEC_TWAP_MEMO_INPUT, v: 1 });
    const parsed = JSON.parse(memo);
    expect(parsed.v).toBe(1);
    expect(parsed.project).toBeUndefined();
    expect(parsed.url).toBeUndefined();
  });

  it("v=1 → v=2 delta is exactly +44 bytes", () => {
    const v1 = canonicalTwapMemoJson({ ...SPEC_TWAP_MEMO_INPUT, v: 1 });
    const v2 = canonicalTwapMemoJson({ ...SPEC_TWAP_MEMO_INPUT, v: 2 });
    expect(Buffer.byteLength(v2, "utf-8") - Buffer.byteLength(v1, "utf-8")).toBe(44);
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
