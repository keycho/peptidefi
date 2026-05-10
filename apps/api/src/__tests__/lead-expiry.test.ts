import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ACCEPTED_TIMEOUT_DAYS,
  RESPONDED_TIMEOUT_DAYS,
  SUBMITTED_TIMEOUT_DAYS,
  runLeadExpiryJob,
} from "../lib/lead-expiry";

/**
 * Verify the lead-expiry sweeper reads/writes the correct rows for
 * each of its three timeouts. The supabase client is replaced with
 * a hand-rolled fake that records every call so we can assert the
 * generated SQL-equivalents (table, columns, filter dates).
 */

vi.mock("@peptide-oracle/shared", async (importOriginal) => {
  const real = await importOriginal<object>();
  return { ...real, logAnomaly: async () => null };
});

interface FakeQuery {
  table: string;
  filters: Array<{ op: string; col: string; val: unknown }>;
  selectCols: string | null;
  updatePayload: Record<string, unknown> | null;
  resolved: { data: unknown; error: unknown };
}

interface FakeSupabase {
  queries: FakeQuery[];
  from: (table: string) => unknown;
  /** Test helper: queue the next-N from() calls' resolution data. */
  enqueue: (rows: unknown[]) => void;
}

function makeFakeSupabase(): FakeSupabase {
  const fake: FakeSupabase = {
    queries: [],
    from: () => undefined,
    enqueue: () => undefined,
  };
  // Only SELECT-shaped queries consume from the data queue. UPDATE
  // and INSERT-without-select resolve to a no-op success so they
  // don't shift queue alignment.
  const dataQueue: unknown[][] = [];
  fake.enqueue = (rows) => dataQueue.push(rows);
  fake.from = (table: string) => {
    const q: FakeQuery = {
      table,
      filters: [],
      selectCols: null,
      updatePayload: null,
      resolved: { data: null, error: null },
    };
    fake.queries.push(q);
    const builder = {
      select(cols: string) {
        q.selectCols = cols;
        return builder;
      },
      update(payload: Record<string, unknown>) {
        q.updatePayload = payload;
        return builder;
      },
      eq(col: string, val: unknown) {
        q.filters.push({ op: "eq", col, val });
        return builder;
      },
      lte(col: string, val: unknown) {
        q.filters.push({ op: "lte", col, val });
        return builder;
      },
      single() {
        // .single() always implies SELECT — consume from queue.
        const rows = dataQueue.shift() ?? [];
        return Promise.resolve({ data: rows[0] ?? null, error: null });
      },
      then(onF: (v: { data: unknown; error: unknown }) => unknown) {
        // Differentiate SELECT (consumes queue) from UPDATE (no-op).
        // updatePayload set ⇒ this builder ran .update() — return
        // success without shifting the queue.
        if (q.updatePayload !== null) {
          return Promise.resolve({ data: null, error: null }).then(onF);
        }
        return Promise.resolve({
          data: dataQueue.shift() ?? null,
          error: null,
        }).then(onF);
      },
    };
    return builder;
  };
  return fake;
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("runLeadExpiryJob", () => {
  it("auto-rejects submitted leads older than 14 days", async () => {
    const fake = makeFakeSupabase();
    // Order matches the production execution path:
    //   1. select submitted → [lead-1]
    //   2. notifyExpired → submitter single → submitter-10
    //   3. select accepted_pipeline → []
    //   4. select vendor_responded → []
    fake.enqueue([{ id: 1, submitter_id: 10, vendor_name: "OldCo" }]);
    fake.enqueue([{ id: 10, wallet_address: "wallet-x" }]); // submitter for notify
    fake.enqueue([]); // accepted_pipeline lookup
    fake.enqueue([]); // vendor_responded lookup

    const now = new Date("2026-05-09T00:00:00Z");
    const summary = await runLeadExpiryJob(
      fake as unknown as Parameters<typeof runLeadExpiryJob>[0],
      now,
    );
    expect(summary.rejected_review_timeout).toBe(1);
    expect(summary.expired_accepted).toBe(0);
    expect(summary.expired_responded).toBe(0);

    // Verify the sweep used the right cutoff date.
    const submittedSelect = fake.queries.find(
      (q) =>
        q.table === "vendor_leads" &&
        q.filters.some((f) => f.op === "eq" && f.val === "submitted"),
    );
    expect(submittedSelect).toBeTruthy();
    const cutoffFilter = submittedSelect!.filters.find((f) => f.op === "lte");
    expect(cutoffFilter).toBeTruthy();
    const cutoffMs = new Date(cutoffFilter!.val as string).getTime();
    const expectedMs = now.getTime() - SUBMITTED_TIMEOUT_DAYS * 86400_000;
    // Within 1s tolerance.
    expect(Math.abs(cutoffMs - expectedMs)).toBeLessThan(1000);

    // Verify the UPDATE set the right status.
    const update = fake.queries.find(
      (q) =>
        q.table === "vendor_leads" &&
        q.updatePayload !== null &&
        q.updatePayload.status === "rejected",
    );
    expect(update).toBeTruthy();
    expect(update!.updatePayload!.rejection_reason).toContain("review timeout");
  });

  it("expires accepted_pipeline leads older than 60 days", async () => {
    const fake = makeFakeSupabase();
    fake.enqueue([]); // submitted lookup
    fake.enqueue([{ id: 2, submitter_id: 20, vendor_name: "StallCo" }]);
    fake.enqueue([{ id: 20, wallet_address: "wallet-y" }]); // notify submitter
    fake.enqueue([]); // responded lookup

    const now = new Date("2026-05-09T00:00:00Z");
    const summary = await runLeadExpiryJob(
      fake as unknown as Parameters<typeof runLeadExpiryJob>[0],
      now,
    );
    expect(summary.expired_accepted).toBe(1);

    // Cutoff for the accepted bucket uses the 60-day window.
    const acceptedSelect = fake.queries.find(
      (q) =>
        q.table === "vendor_leads" &&
        q.filters.some((f) => f.op === "eq" && f.val === "accepted_pipeline"),
    );
    const cutoffMs = new Date(
      acceptedSelect!.filters.find((f) => f.op === "lte")!.val as string,
    ).getTime();
    const expectedMs = now.getTime() - ACCEPTED_TIMEOUT_DAYS * 86400_000;
    expect(Math.abs(cutoffMs - expectedMs)).toBeLessThan(1000);

    const update = fake.queries.find(
      (q) =>
        q.updatePayload !== null && q.updatePayload.status === "expired",
    );
    expect(update).toBeTruthy();
    expect(update!.updatePayload!.expired_at).toBeTruthy();
  });

  it("expires vendor_responded leads older than 30 days", async () => {
    const fake = makeFakeSupabase();
    fake.enqueue([]);
    fake.enqueue([]);
    fake.enqueue([{ id: 3, submitter_id: 30, vendor_name: "GhostCo" }]);
    fake.enqueue([{ id: 30, wallet_address: "wallet-z" }]); // notify submitter

    const now = new Date("2026-05-09T00:00:00Z");
    const summary = await runLeadExpiryJob(
      fake as unknown as Parameters<typeof runLeadExpiryJob>[0],
      now,
    );
    expect(summary.expired_responded).toBe(1);

    const respondedSelect = fake.queries.find(
      (q) =>
        q.table === "vendor_leads" &&
        q.filters.some((f) => f.op === "eq" && f.val === "vendor_responded"),
    );
    const cutoffMs = new Date(
      respondedSelect!.filters.find((f) => f.op === "lte")!.val as string,
    ).getTime();
    const expectedMs = now.getTime() - RESPONDED_TIMEOUT_DAYS * 86400_000;
    expect(Math.abs(cutoffMs - expectedMs)).toBeLessThan(1000);
  });

  it("returns zero counts and makes no UPDATE when nothing's expired", async () => {
    const fake = makeFakeSupabase();
    fake.enqueue([]);
    fake.enqueue([]);
    fake.enqueue([]);
    const summary = await runLeadExpiryJob(
      fake as unknown as Parameters<typeof runLeadExpiryJob>[0],
    );
    expect(summary).toEqual({
      rejected_review_timeout: 0,
      expired_accepted: 0,
      expired_responded: 0,
    });
    const updates = fake.queries.filter((q) => q.updatePayload !== null);
    expect(updates).toHaveLength(0);
  });
});
