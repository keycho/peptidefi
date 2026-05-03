import { describe, expect, it } from "vitest";
import { buildCycleCommitFromObservations, buildCycleMemo } from "../memo";
import { bytesToHex0x } from "@peptide-oracle/shared";
import {
  SPEC_CYCLE_MEMO_BYTES,
  SPEC_CYCLE_MEMO_BYTES_V1,
  SPEC_CYCLE_MEMO_INPUT,
  SPEC_CYCLE_MEMO_JSON,
  SPEC_CYCLE_MEMO_JSON_V1,
  SPEC_OBS_1,
  SPEC_OBS_2,
  SPEC_OBS_3,
  SPEC_OBS_4,
  SPEC_ROOT,
} from "./fixtures";

describe("buildCycleMemo — v=2 (current default)", () => {
  it("reproduces the §02.2.2 v=2 reference example byte-exact", () => {
    expect(buildCycleMemo({ ...SPEC_CYCLE_MEMO_INPUT })).toBe(SPEC_CYCLE_MEMO_JSON);
  });

  it("v=2 reference example is exactly 270 bytes UTF-8", () => {
    const memo = buildCycleMemo({ ...SPEC_CYCLE_MEMO_INPUT });
    expect(Buffer.byteLength(memo, "utf-8")).toBe(SPEC_CYCLE_MEMO_BYTES);
  });

  it("emits sorted keys (alphabetic ascending), v=2 has 9 keys including project + url", () => {
    const memo = buildCycleMemo({ ...SPEC_CYCLE_MEMO_INPUT });
    const parsed = JSON.parse(memo) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual([
      "completed_at",
      "cycle_id",
      "merkle_root",
      "observation_count",
      "project",
      "started_at",
      "type",
      "url",
      "v",
    ]);
  });

  it("v=2 sets project='biohash' + url='biohash.network' + type='cycle' + v=2", () => {
    const memo = buildCycleMemo({ ...SPEC_CYCLE_MEMO_INPUT });
    const parsed = JSON.parse(memo) as {
      v: number;
      type: string;
      project: string;
      url: string;
    };
    expect(parsed.v).toBe(2);
    expect(parsed.type).toBe("cycle");
    expect(parsed.project).toBe("biohash");
    expect(parsed.url).toBe("biohash.network");
  });
});

describe("buildCycleMemo — v=1 (backward compat for devnet cycles 1-63)", () => {
  it("explicit v=1 reproduces the legacy byte-exact memo", () => {
    expect(buildCycleMemo({ ...SPEC_CYCLE_MEMO_INPUT, v: 1 })).toBe(
      SPEC_CYCLE_MEMO_JSON_V1,
    );
  });

  it("v=1 is 226 bytes (legacy fixture)", () => {
    const memo = buildCycleMemo({ ...SPEC_CYCLE_MEMO_INPUT, v: 1 });
    expect(Buffer.byteLength(memo, "utf-8")).toBe(SPEC_CYCLE_MEMO_BYTES_V1);
  });

  it("v=1 has 7 keys (no project/url) and v=1", () => {
    const memo = buildCycleMemo({ ...SPEC_CYCLE_MEMO_INPUT, v: 1 });
    const parsed = JSON.parse(memo) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual([
      "completed_at",
      "cycle_id",
      "merkle_root",
      "observation_count",
      "started_at",
      "type",
      "v",
    ]);
    expect(parsed.v).toBe(1);
    expect(parsed.project).toBeUndefined();
    expect(parsed.url).toBeUndefined();
  });

  it("v=1 and v=2 differ by exactly +44 bytes (`,\"project\":\"biohash\"`+`,\"url\":\"biohash.network\"`)", () => {
    const v1 = buildCycleMemo({ ...SPEC_CYCLE_MEMO_INPUT, v: 1 });
    const v2 = buildCycleMemo({ ...SPEC_CYCLE_MEMO_INPUT, v: 2 });
    expect(Buffer.byteLength(v2, "utf-8") - Buffer.byteLength(v1, "utf-8")).toBe(44);
  });
});

describe("buildCycleMemo — input validation (version-independent)", () => {
  it("rejects observation_count <= 0", () => {
    expect(() =>
      buildCycleMemo({ ...SPEC_CYCLE_MEMO_INPUT, observation_count: 0 }),
    ).toThrow(/observation_count.*> 0/);
  });

  it("rejects negative cycle_id", () => {
    expect(() => buildCycleMemo({ ...SPEC_CYCLE_MEMO_INPUT, cycle_id: -1 })).toThrow(
      /cycle_id.*non-negative/,
    );
  });

  it("rejects non-integer cycle_id", () => {
    expect(() => buildCycleMemo({ ...SPEC_CYCLE_MEMO_INPUT, cycle_id: 1.5 })).toThrow(
      /cycle_id.*non-negative/,
    );
  });

  it("rejects malformed merkle_root", () => {
    const bad = { ...SPEC_CYCLE_MEMO_INPUT, merkle_root: "not-a-hash" };
    expect(() => buildCycleMemo(bad)).toThrow(/merkle_root.*0x.*hex/);
  });

  it("rejects uppercase hex in merkle_root (canonical form is lowercase)", () => {
    const bad = { ...SPEC_CYCLE_MEMO_INPUT, merkle_root: SPEC_ROOT.toUpperCase() };
    expect(() => buildCycleMemo(bad)).toThrow(/merkle_root.*hex/);
  });
});

describe("buildCycleCommitFromObservations", () => {
  it("end-to-end produces the §02.4.6 root + a valid v=2 memo", () => {
    const result = buildCycleCommitFromObservations({
      cycle_id: 200,
      started_at: "2026-05-01T12:00:00.000Z",
      completed_at: "2026-05-01T12:00:09.000Z",
      observations: [SPEC_OBS_1, SPEC_OBS_2, SPEC_OBS_3, SPEC_OBS_4],
    });

    // The leaf canonical form (and therefore Merkle root) is
    // version-independent — only the OUTER memo schema bumped to v=2.
    expect(result.rootHex).toBe(SPEC_ROOT);
    expect(bytesToHex0x(result.root)).toBe(SPEC_ROOT);

    // Production code path always emits v=2.
    const parsed = JSON.parse(result.memo) as {
      observation_count: number;
      v: number;
      project: string;
      url: string;
    };
    expect(parsed.observation_count).toBe(4);
    expect(parsed.v).toBe(2);
    expect(parsed.project).toBe("biohash");
    expect(parsed.url).toBe("biohash.network");
  });

  it("memo size scales with observation_count digit length, not data size", () => {
    // 4 obs (1 digit) vs 118 obs (3 digits) → 2-char delta.
    const fourObs = buildCycleCommitFromObservations({
      cycle_id: 200,
      started_at: "2026-05-01T12:00:00.000Z",
      completed_at: "2026-05-01T12:00:09.000Z",
      observations: [SPEC_OBS_1, SPEC_OBS_2, SPEC_OBS_3, SPEC_OBS_4],
    });
    const sizeFour = Buffer.byteLength(fourObs.memo, "utf-8");
    expect(sizeFour).toBe(SPEC_CYCLE_MEMO_BYTES - 2); // "118" → "4" saves 2 chars
  });
});
