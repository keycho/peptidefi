import { describe, expect, it } from "vitest";
import { buildCycleCommitFromObservations, buildCycleMemo } from "../memo";
import { bytesToHex0x } from "../merkle";
import {
  SPEC_CYCLE_MEMO_BYTES,
  SPEC_CYCLE_MEMO_INPUT,
  SPEC_CYCLE_MEMO_JSON,
  SPEC_OBS_1,
  SPEC_OBS_2,
  SPEC_OBS_3,
  SPEC_OBS_4,
  SPEC_ROOT,
} from "./fixtures";

describe("buildCycleMemo", () => {
  it("reproduces the §02.2.2 reference example byte-exact", () => {
    expect(buildCycleMemo({ ...SPEC_CYCLE_MEMO_INPUT })).toBe(SPEC_CYCLE_MEMO_JSON);
  });

  it("the reference example is exactly 226 bytes UTF-8 (§02.2.2)", () => {
    const memo = buildCycleMemo({ ...SPEC_CYCLE_MEMO_INPUT });
    expect(Buffer.byteLength(memo, "utf-8")).toBe(SPEC_CYCLE_MEMO_BYTES);
  });

  it("emits sorted keys (alphabetic ascending)", () => {
    const memo = buildCycleMemo({ ...SPEC_CYCLE_MEMO_INPUT });
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
  });

  it("always sets v=1 and type='cycle'", () => {
    const memo = buildCycleMemo({ ...SPEC_CYCLE_MEMO_INPUT });
    const parsed = JSON.parse(memo) as { v: number; type: string };
    expect(parsed.v).toBe(1);
    expect(parsed.type).toBe("cycle");
  });

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
  it("end-to-end produces the §02.4.6 root + a valid memo", () => {
    const result = buildCycleCommitFromObservations({
      cycle_id: 200,
      started_at: "2026-05-01T12:00:00.000Z",
      completed_at: "2026-05-01T12:00:09.000Z",
      observations: [SPEC_OBS_1, SPEC_OBS_2, SPEC_OBS_3, SPEC_OBS_4],
    });

    expect(result.rootHex).toBe(SPEC_ROOT);
    expect(bytesToHex0x(result.root)).toBe(SPEC_ROOT);

    // Memo for the actual 4-obs set has observation_count=4 (NOT 118
    // like the spec's headline example, which represents a real-cycle
    // size). The memo is otherwise identical structurally.
    const parsed = JSON.parse(result.memo) as { observation_count: number };
    expect(parsed.observation_count).toBe(4);
  });

  it("memo size scales with observation_count digit length, not data size", () => {
    // 4 obs (1 digit) → smaller memo
    const fourObs = buildCycleCommitFromObservations({
      cycle_id: 200,
      started_at: "2026-05-01T12:00:00.000Z",
      completed_at: "2026-05-01T12:00:09.000Z",
      observations: [SPEC_OBS_1, SPEC_OBS_2, SPEC_OBS_3, SPEC_OBS_4],
    });
    // 118 obs (3 digits) is the spec's reference at 226 bytes
    const sizeFour = Buffer.byteLength(fourObs.memo, "utf-8");
    expect(sizeFour).toBe(SPEC_CYCLE_MEMO_BYTES - 2); // "118" → "4" saves 2 chars
  });
});
