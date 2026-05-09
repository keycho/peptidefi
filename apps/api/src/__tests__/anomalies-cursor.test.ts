import { describe, expect, it } from "vitest";

import { _internal } from "../routes/anomalies";

const { parseCursor, buildCursor, escapeXml } = _internal;

describe("anomalies cursor", () => {
  it("round-trips a cursor: build → parse", () => {
    const built = buildCursor({
      id: 1234,
      occurred_at: "2026-05-08T14:31:00.000Z",
      severity: "info",
      event_type: "x",
      vendor_id: null,
      peptide_id: null,
      observation_id: null,
      cycle_id: null,
      description: "y",
      context: null,
      resolved_at: null,
      resolved_by: null,
    });
    expect(built).toBe("2026-05-08T14:31:00.000Z_1234");
    const parsed = parseCursor(built);
    expect(parsed).toEqual({
      occurredAt: "2026-05-08T14:31:00.000Z",
      id: 1234,
    });
  });

  it("rejects malformed cursor strings", () => {
    expect(parseCursor("")).toBeNull();
    expect(parseCursor("nope")).toBeNull();
    expect(parseCursor("2026-05-08_abc")).toBeNull();
    expect(parseCursor("notadate_42")).toBeNull();
  });

  it("splits on the LAST underscore (ISO contains colons but no underscores)", () => {
    // Defensive: build an ISO with a Z suffix; parser should still
    // bisect cleanly on the trailing _<id>.
    const parsed = parseCursor("2026-05-08T14:31:00Z_999");
    expect(parsed).toEqual({ occurredAt: "2026-05-08T14:31:00Z", id: 999 });
  });
});

describe("xml escape (RSS feed safety)", () => {
  it("escapes the five XML special characters", () => {
    expect(escapeXml("<")).toBe("&lt;");
    expect(escapeXml(">")).toBe("&gt;");
    expect(escapeXml("&")).toBe("&amp;");
    expect(escapeXml("'")).toBe("&apos;");
    expect(escapeXml('"')).toBe("&quot;");
  });

  it("leaves benign text alone", () => {
    expect(escapeXml("BPC157 push failed: blockhash expired")).toBe(
      "BPC157 push failed: blockhash expired",
    );
  });

  it("escapes a realistic anomaly description without injection risk", () => {
    const desc =
      'peg-pusher failed for BPC157: "<script>alert(1)</script>" & friends';
    const escaped = escapeXml(desc);
    expect(escaped).not.toContain("<script>");
    expect(escaped).toContain("&lt;script&gt;");
    expect(escaped).toContain("&amp;");
    expect(escaped).toContain("&quot;");
  });
});
