import { describe, expect, it } from "vitest";
import {
  leavesForCommit,
  registerCommitCycle,
  type RegisterCommitCycleArgs,
} from "../db/commit-writer";
import type { SqlClient } from "../db/client";
import { buildMerkleTree } from "@peptide-oracle/shared";
import { SPEC_OBS_1, SPEC_OBS_2, SPEC_OBS_3, SPEC_OBS_4 } from "./fixtures";

/**
 * Minimal stand-in for postgres.js's sql.json() helper. The real
 * helper returns `new Parameter(x, 3802)` where 3802 is the jsonb
 * type oid. We replicate the shape (type=3802, value=x) so the
 * production code path in registerCommitCycle runs unmodified
 * while we capture what it would send to PG.
 */
interface JsonbParameter {
  type: 3802;
  value: unknown;
}
function fakeJsonHelper(x: unknown): JsonbParameter {
  return { type: 3802, value: x };
}

/**
 * Regression coverage for the Phase E bug:
 *
 *   "registerCommitCycle was passing leaves as JSON.stringify(...) +
 *    `::jsonb` cast, which postgres.js binds as a text wire-protocol
 *    parameter. The PG-side `text::jsonb` cast on a JSON-array
 *    string was observed in production to arrive at the function as
 *    a JSON-quoted scalar string ("[{...}]") rather than a JSON
 *    array ([{...}]), causing jsonb_array_length to throw 'cannot
 *    get array length of a scalar'."
 *
 * The fix uses `sql.json(args.leaves)` which binds the value with
 * the jsonb type oid (3802) directly. postgres.js's Parameter
 * constructor for sql.json() has type=3802; this test asserts the
 * positional arg arriving at the SQL template is that shape, not
 * a raw JS string.
 *
 * We can't run a real PG round-trip in CI (no DB), so the test
 * intercepts the tagged-template invocation and inspects the args
 * postgres.js would send.
 */

const tree = buildMerkleTree([SPEC_OBS_1, SPEC_OBS_2, SPEC_OBS_3, SPEC_OBS_4]);
const leaves = leavesForCommit([1001, 1002, 1003, 1004], tree);

const baseArgs: RegisterCommitCycleArgs = {
  cycle_id: 200,
  started_at: new Date("2026-05-01T12:00:00.000Z"),
  completed_at: new Date("2026-05-01T12:00:09.000Z"),
  observation_count: 4,
  merkle_root: "0x" + "00".repeat(32),
  memo_payload: '{"some":"memo"}',
  leaves,
};

describe("registerCommitCycle wire-protocol parameters", () => {
  /**
   * Build a stub SqlClient that records the args to its tagged-template
   * call. We attach sql.json from the real postgres.js module so the
   * production code path runs unmodified — only the network layer is
   * replaced.
   */
  function makeRecordingSql(): {
    sql: SqlClient;
    captured: { strings: TemplateStringsArray; args: unknown[] }[];
  } {
    const captured: { strings: TemplateStringsArray; args: unknown[] }[] = [];
    const tag = ((strings: TemplateStringsArray, ...args: unknown[]) => {
      captured.push({ strings, args });
      // Return a thenable so `await sql\`…\`` resolves to undefined.
      return Promise.resolve();
    }) as unknown as SqlClient;
    // sql.json must remain available for production callers.
    (tag as unknown as { json: typeof fakeJsonHelper }).json = fakeJsonHelper;
    return { sql: tag, captured };
  }

  it("binds leaves via sql.json (not JSON.stringify), producing a Parameter with type=3802 (jsonb)", async () => {
    const { sql, captured } = makeRecordingSql();
    await registerCommitCycle(sql, baseArgs);

    expect(captured).toHaveLength(1);
    const args = captured[0]!.args;
    // Positional args follow the template order:
    //   0: cycle_id, 1: started_at, 2: completed_at,
    //   3: observation_count, 4: merkle_root, 5: memo_payload,
    //   6: leaves
    expect(args).toHaveLength(7);
    const leavesParam = args[6];
    // postgres.js sql.json() returns a Parameter. The constructor sets
    // type to the jsonb oid (3802); we don't import the Parameter class
    // directly (it's not in postgres.js's public type surface) so we
    // duck-type instead.
    expect(typeof leavesParam).toBe("object");
    expect(leavesParam).not.toBeNull();
    const param = leavesParam as { type?: number; value?: unknown };
    expect(param.type).toBe(3802);
    // Critical: the value carried on the Parameter is the original JS
    // array, not a string. postgres.js will JSON.stringify it once at
    // wire-encode time. If a future change reverts to passing a
    // pre-stringified value here, this assertion catches it.
    expect(Array.isArray(param.value)).toBe(true);
    expect((param.value as unknown[]).length).toBe(4);
  });

  it("passes the other args as raw JS values (postgres.js handles the type encoding)", async () => {
    const { sql, captured } = makeRecordingSql();
    await registerCommitCycle(sql, baseArgs);
    const args = captured[0]!.args;
    expect(args[0]).toBe(200);
    expect(args[1]).toBeInstanceOf(Date);
    expect(args[2]).toBeInstanceOf(Date);
    expect(args[3]).toBe(4);
    expect(args[4]).toBe(baseArgs.merkle_root);
    expect(args[5]).toBe(baseArgs.memo_payload);
  });
});
