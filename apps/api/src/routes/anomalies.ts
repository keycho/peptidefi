import type { Request, Response } from "express";
import { z } from "zod";

import { adminClientUntyped } from "../supabase";
import { sendError } from "../errors";

/**
 * /api/anomalies — public, append-only operational log.
 *
 * Reads from the `anomalies` table created in migration 0034. The
 * table is intentionally public-read (RLS allows anon SELECT), so
 * these endpoints are auth-free and meant to be cached aggressively
 * by clients (Lovable frontend, RSS readers).
 *
 * Endpoints:
 *
 *   GET /api/anomalies          — paginated list with filters
 *   GET /api/anomalies/:id      — single event by id (permalink)
 *   GET /api/anomalies/feed.xml — RSS 2.0 of the last 100 events
 *   GET /api/anomalies/feed.json— JSON Feed 1.1 of the last 100 events
 *   GET /api/anomalies/stats    — severity counts (24h / 7d / all-time)
 *
 * All endpoints sort newest-first by (occurred_at desc, id desc) so
 * pagination cursors are stable even when many rows share the same
 * occurred_at. The cursor format is "<occurred_at_iso>_<id>".
 */

// ─── shared types ──────────────────────────────────────────────────

type Severity = "info" | "warn" | "error" | "critical";

interface AnomalyRow {
  id: number;
  occurred_at: string;
  severity: Severity;
  event_type: string;
  vendor_id: string | null;
  peptide_id: string | null;
  observation_id: number | null;
  cycle_id: number | null;
  description: string;
  context: Record<string, unknown> | null;
  resolved_at: string | null;
  resolved_by: number | null;
}

const SEVERITIES: readonly Severity[] = ["info", "warn", "error", "critical"];

// ─── list ──────────────────────────────────────────────────────────

const listQuerySchema = z.object({
  severity: z
    .string()
    .optional()
    .transform((v) =>
      v
        ? v
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : [],
    )
    .pipe(
      z.array(
        z.enum(["info", "warn", "error", "critical"] as const, {
          errorMap: () => ({
            message: "severity must be one of info, warn, error, critical",
          }),
        }),
      ),
    ),
  event_type: z.string().min(1).max(64).optional(),
  vendor_id: z.string().min(1).max(64).optional(),
  peptide_id: z.string().min(1).max(64).optional(),
  since: z.string().datetime().optional(),
  until: z.string().datetime().optional(),
  limit: z.coerce.number().int().positive().max(200).default(50),
  cursor: z.string().optional(),
});

interface ParsedCursor {
  occurredAt: string;
  id: number;
}

function parseCursor(raw: string): ParsedCursor | null {
  // Format: "<iso>_<id>". The iso may contain colons (and a Z); only
  // split on the LAST underscore to be safe.
  const idx = raw.lastIndexOf("_");
  if (idx < 0) return null;
  const isoPart = raw.slice(0, idx);
  const idPart = raw.slice(idx + 1);
  if (!/^\d+$/.test(idPart)) return null;
  if (Number.isNaN(Date.parse(isoPart))) return null;
  return { occurredAt: isoPart, id: Number(idPart) };
}

function buildCursor(row: AnomalyRow): string {
  return `${row.occurred_at}_${row.id}`;
}

export async function listAnomaliesHandler(
  req: Request,
  res: Response,
): Promise<void> {
  const parsed = listQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    sendError(res, 400, "BAD_REQUEST", parsed.error.message);
    return;
  }
  const { severity, event_type, vendor_id, peptide_id, since, until, limit } =
    parsed.data;

  const supabase = adminClientUntyped();

  // Fetch limit+1 so we know whether there's a next page without a
  // separate count query.
  let query = supabase
    .from("anomalies")
    .select(
      "id, occurred_at, severity, event_type, vendor_id, peptide_id, observation_id, cycle_id, description, context, resolved_at, resolved_by",
    )
    .order("occurred_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(limit + 1);

  if (severity.length > 0) {
    query = query.in("severity", severity);
  }
  if (event_type) {
    query = query.eq("event_type", event_type);
  }
  if (vendor_id) {
    query = query.eq("vendor_id", vendor_id);
  }
  if (peptide_id) {
    query = query.eq("peptide_id", peptide_id);
  }
  if (since) {
    query = query.gte("occurred_at", since);
  }
  if (until) {
    query = query.lte("occurred_at", until);
  }

  // Cursor: `(occurred_at, id) < (cursor.occurred_at, cursor.id)`
  // expressed via PostgREST's `or()` so it composes with the existing
  // filters. `or()` accepts a comma-separated string of conditions.
  if (parsed.data.cursor) {
    const cur = parseCursor(parsed.data.cursor);
    if (!cur) {
      sendError(res, 400, "BAD_REQUEST", "invalid cursor");
      return;
    }
    // Either occurred_at strictly older, OR same occurred_at with
    // strictly smaller id.
    query = query.or(
      `occurred_at.lt.${cur.occurredAt},and(occurred_at.eq.${cur.occurredAt},id.lt.${cur.id})`,
    );
  }

  const { data, error } = await query;
  if (error) {
    sendError(res, 500, "DB_ERROR", `anomalies query failed: ${error.message}`);
    return;
  }

  const rows = (data ?? []) as AnomalyRow[];
  const hasMore = rows.length > limit;
  const events = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor =
    hasMore && events.length > 0 ? buildCursor(events[events.length - 1]!) : null;

  res
    .set("cache-control", "public, max-age=15")
    .json({ events, next_cursor: nextCursor });
}

// ─── single ────────────────────────────────────────────────────────

export async function getAnomalyHandler(
  req: Request,
  res: Response,
): Promise<void> {
  const idParam = req.params.id;
  if (!idParam || !/^\d+$/.test(idParam)) {
    sendError(res, 400, "BAD_REQUEST", "id must be a positive integer");
    return;
  }
  const id = Number(idParam);
  const supabase = adminClientUntyped();
  const { data, error } = await supabase
    .from("anomalies")
    .select(
      "id, occurred_at, severity, event_type, vendor_id, peptide_id, observation_id, cycle_id, description, context, resolved_at, resolved_by",
    )
    .eq("id", id)
    .maybeSingle();
  if (error) {
    sendError(res, 500, "DB_ERROR", `anomaly lookup failed: ${error.message}`);
    return;
  }
  if (!data) {
    sendError(res, 404, "NOT_FOUND", `no anomaly with id=${id}`);
    return;
  }
  res.set("cache-control", "public, max-age=60").json({ event: data });
}

// ─── stats (cached 60s) ────────────────────────────────────────────

interface SeverityCounts {
  info: number;
  warn: number;
  error: number;
  critical: number;
}

interface StatsBody {
  last_24h: SeverityCounts;
  last_7d: SeverityCounts;
  all_time: SeverityCounts;
  generated_at: string;
}

interface StatsCache {
  body: StatsBody;
  expiresAt: number;
}

let statsCache: StatsCache | null = null;
const STATS_TTL_MS = 60 * 1000;

function emptyCounts(): SeverityCounts {
  return { info: 0, warn: 0, error: 0, critical: 0 };
}

async function severityCountsSince(
  supabase: ReturnType<typeof adminClientUntyped>,
  sinceIso: string | null,
): Promise<SeverityCounts | { error: string }> {
  // PostgREST has no GROUP BY surface in the JS client; we use a
  // single SELECT and bucket in-memory. The page size is bounded —
  // even at 1k events/day the all-time table is small (the log is
  // intentionally low-volume; it's notable events only).
  let query = supabase.from("anomalies").select("severity");
  if (sinceIso) {
    query = query.gte("occurred_at", sinceIso);
  }
  const { data, error } = await query;
  if (error) return { error: error.message };
  const counts = emptyCounts();
  for (const row of (data ?? []) as Array<{ severity: Severity }>) {
    if (SEVERITIES.includes(row.severity)) {
      counts[row.severity] += 1;
    }
  }
  return counts;
}

export async function statsAnomaliesHandler(
  _req: Request,
  res: Response,
): Promise<void> {
  const now = Date.now();
  if (statsCache && statsCache.expiresAt > now) {
    res
      .set("cache-control", `public, max-age=${Math.ceil((statsCache.expiresAt - now) / 1000)}`)
      .json(statsCache.body);
    return;
  }

  const supabase = adminClientUntyped();
  const since24h = new Date(now - 24 * 60 * 60 * 1000).toISOString();
  const since7d = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();

  const [last24h, last7d, allTime] = await Promise.all([
    severityCountsSince(supabase, since24h),
    severityCountsSince(supabase, since7d),
    severityCountsSince(supabase, null),
  ]);

  for (const r of [last24h, last7d, allTime]) {
    if ("error" in r) {
      sendError(res, 500, "DB_ERROR", `stats query failed: ${r.error}`);
      return;
    }
  }

  const body: StatsBody = {
    last_24h: last24h as SeverityCounts,
    last_7d: last7d as SeverityCounts,
    all_time: allTime as SeverityCounts,
    generated_at: new Date(now).toISOString(),
  };
  statsCache = { body, expiresAt: now + STATS_TTL_MS };
  res
    .set("cache-control", `public, max-age=${Math.ceil(STATS_TTL_MS / 1000)}`)
    .json(body);
}

/** Test-only — clear the cache between unit tests. */
export function _resetStatsCacheForTests(): void {
  statsCache = null;
}

// ─── feeds ─────────────────────────────────────────────────────────

const FEED_LIMIT = 100;

async function fetchFeedRows(
  supabase: ReturnType<typeof adminClientUntyped>,
): Promise<AnomalyRow[] | { error: string }> {
  const { data, error } = await supabase
    .from("anomalies")
    .select(
      "id, occurred_at, severity, event_type, vendor_id, peptide_id, observation_id, cycle_id, description, context, resolved_at, resolved_by",
    )
    .order("occurred_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(FEED_LIMIT);
  if (error) return { error: error.message };
  return (data ?? []) as AnomalyRow[];
}

function feedSelfUrl(req: Request): string {
  const proto = (req.headers["x-forwarded-proto"] as string | undefined) ?? req.protocol;
  const host = req.get("host") ?? "biohash.network";
  return `${proto}://${host}`;
}

function escapeXml(s: string): string {
  return s.replace(/[<>&'"]/g, (c) => {
    switch (c) {
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case "&":
        return "&amp;";
      case "'":
        return "&apos;";
      case '"':
        return "&quot;";
      default:
        return c;
    }
  });
}

export async function rssFeedAnomaliesHandler(
  req: Request,
  res: Response,
): Promise<void> {
  const supabase = adminClientUntyped();
  const rows = await fetchFeedRows(supabase);
  if ("error" in rows) {
    sendError(res, 500, "DB_ERROR", `feed query failed: ${rows.error}`);
    return;
  }

  const baseUrl = feedSelfUrl(req);
  const items = rows
    .map((r) => {
      const title = `[${r.severity.toUpperCase()}] ${r.event_type}`;
      const link = `${baseUrl}/api/anomalies/${r.id}`;
      const pubDate = new Date(r.occurred_at).toUTCString();
      const desc = r.description;
      return `    <item>
      <title>${escapeXml(title)}</title>
      <link>${escapeXml(link)}</link>
      <guid isPermaLink="true">${escapeXml(link)}</guid>
      <pubDate>${pubDate}</pubDate>
      <description>${escapeXml(desc)}</description>
      <category>${escapeXml(r.severity)}</category>
      <category>${escapeXml(r.event_type)}</category>
    </item>`;
    })
    .join("\n");

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>BioHash Anomaly Log</title>
    <link>${escapeXml(baseUrl)}</link>
    <description>Append-only operational log for the BioHash oracle pipeline.</description>
    <language>en</language>
    <atom:link href="${escapeXml(baseUrl + "/api/anomalies/feed.xml")}" rel="self" type="application/rss+xml" />
${items}
  </channel>
</rss>
`;
  res
    .set("content-type", "application/rss+xml; charset=utf-8")
    .set("cache-control", "public, max-age=60")
    .send(xml);
}

export async function jsonFeedAnomaliesHandler(
  req: Request,
  res: Response,
): Promise<void> {
  const supabase = adminClientUntyped();
  const rows = await fetchFeedRows(supabase);
  if ("error" in rows) {
    sendError(res, 500, "DB_ERROR", `feed query failed: ${rows.error}`);
    return;
  }
  const baseUrl = feedSelfUrl(req);
  const body = {
    version: "https://jsonfeed.org/version/1.1",
    title: "BioHash Anomaly Log",
    home_page_url: baseUrl,
    feed_url: `${baseUrl}/api/anomalies/feed.json`,
    description:
      "Append-only operational log for the BioHash oracle pipeline.",
    items: rows.map((r) => ({
      id: String(r.id),
      url: `${baseUrl}/api/anomalies/${r.id}`,
      title: `[${r.severity.toUpperCase()}] ${r.event_type}`,
      content_text: r.description,
      date_published: r.occurred_at,
      tags: [r.severity, r.event_type],
      _biohash: {
        severity: r.severity,
        event_type: r.event_type,
        vendor_id: r.vendor_id,
        peptide_id: r.peptide_id,
        observation_id: r.observation_id,
        cycle_id: r.cycle_id,
        resolved_at: r.resolved_at,
        resolved_by: r.resolved_by,
      },
    })),
  };
  res
    .set("content-type", "application/feed+json; charset=utf-8")
    .set("cache-control", "public, max-age=60")
    .json(body);
}

// Internal exports for unit tests.
export const _internal = { parseCursor, buildCursor, escapeXml };
