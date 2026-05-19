import ora from "ora";
import { api, ApiError } from "../lib/api.js";
import { c, glyph } from "../lib/theme.js";
import { fmtLevel, fmtPct } from "../lib/config.js";

export async function indexCommand(opts: { history?: string }) {
  // --history mode: show last N hours as a sparkline-style table
  if (opts.history) {
    await renderHistory(opts.history);
    return;
  }

  // Default: current level
  const spinner = ora({
    text: c.dim("fetching current index..."),
    color: "yellow",
  }).start();

  try {
    const current = await api.indexCurrent();
    spinner.stop();

    const changeColor = current.change_pct < 0 ? c.red : c.live;
    const arrow = current.change_pct < 0 ? glyph.arrowDown : glyph.arrowUp;
    const baselineDate = current.hour_start.slice(0, 10);

    console.log();
    console.log(
      "  " + c.mint("INDEX LEVEL     ") + c.amber(fmtLevel(current.level)),
    );
    console.log(
      "  " +
        c.mint("CHANGE          ") +
        changeColor(`${arrow} ${fmtPct(current.change_pct)} from ${fmtLevel(current.baseline)}`),
    );
    console.log(
      "  " +
        c.mint("COHORT          ") +
        c.body(`${current.cohort_size} peptides `) +
        c.dim("(equal-weight)"),
    );
    console.log(
      "  " +
        c.mint("LAST UPDATE     ") +
        c.body(formatHourUtc(current.hour_start)),
    );
    console.log(
      "  " +
        c.mint("SOURCE          ") +
        c.body("api ") +
        c.dim("· backed by mainnet TWAP commits"),
    );

    if (current.ipfs_cid) {
      console.log(
        "  " +
          c.mint("IPFS MANIFEST   ") +
          c.body(current.ipfs_cid.slice(0, 12) + "…" + current.ipfs_cid.slice(-6)),
      );
    }
    console.log();
  } catch (err) {
    spinner.fail(formatError(err));
    process.exit(1);
  }
}

async function renderHistory(spec: string) {
  // parse 7d, 24h, 14d
  const match = spec.match(/^(\d+)([hd])$/i);
  if (!match) {
    console.error(c.red(`invalid --history value: "${spec}". use e.g. 24h or 7d`));
    process.exit(1);
  }
  const num = parseInt(match[1]!, 10);
  const unit = match[2]!.toLowerCase();
  const hours = unit === "d" ? num * 24 : num;

  const spinner = ora({
    text: c.dim(`fetching last ${spec}...`),
    color: "yellow",
  }).start();

  try {
    const points = await api.indexHistory(hours);
    spinner.stop();

    if (points.length === 0) {
      console.log(c.dim("no history points returned."));
      return;
    }

    const first = points[0]!.level;
    const last = points[points.length - 1]!.level;
    const totalChange = ((last - first) / first) * 100;

    console.log();
    console.log(
      "  " +
        c.mint(`LAST ${spec.toUpperCase()}`) +
        c.dim(`  ·  ${points.length} hourly points`),
    );
    console.log();

    // build a min/max sparkline from the levels
    const levels = points.map((p) => p.level);
    const min = Math.min(...levels);
    const max = Math.max(...levels);
    const range = max - min || 1;
    const blocks = "▁▂▃▄▅▆▇█";
    const spark = levels
      .map((v) => {
        const idx = Math.min(
          blocks.length - 1,
          Math.floor(((v - min) / range) * blocks.length),
        );
        return blocks[idx];
      })
      .join("");

    console.log("  " + c.amber(spark));
    console.log();
    console.log(
      "  " +
        c.mint("FIRST   ") +
        c.body(fmtLevel(first)) +
        c.dim(`  (${formatHourUtc(points[0]!.hour_start)})`),
    );
    console.log(
      "  " +
        c.mint("LAST    ") +
        c.body(fmtLevel(last)) +
        c.dim(`  (${formatHourUtc(points[points.length - 1]!.hour_start)})`),
    );
    console.log(
      "  " +
        c.mint("HIGH    ") +
        c.body(fmtLevel(max)),
    );
    console.log(
      "  " +
        c.mint("LOW     ") +
        c.body(fmtLevel(min)),
    );

    const changeColor = totalChange < 0 ? c.red : c.live;
    const arrow = totalChange < 0 ? glyph.arrowDown : glyph.arrowUp;
    console.log(
      "  " +
        c.mint("CHANGE  ") +
        changeColor(`${arrow} ${fmtPct(totalChange)}`),
    );
    console.log();
  } catch (err) {
    spinner.fail(formatError(err));
    process.exit(1);
  }
}

function formatHourUtc(iso: string): string {
  // "2026-05-16T19:00:00Z" -> "2026-05-16 19:00 UTC"
  return iso.replace("T", " ").slice(0, 16) + " UTC";
}

function formatError(err: unknown): string {
  if (err instanceof ApiError) return c.red(`error: ${err.message}`);
  if (err instanceof Error) return c.red(`error: ${err.message}`);
  return c.red(`error: ${String(err)}`);
}
