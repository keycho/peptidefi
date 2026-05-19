import ora from "ora";
import Table from "cli-table3";
import { api, ApiError } from "../lib/api.js";
import { c, glyph } from "../lib/theme.js";
import { fmtPrice, trimSig } from "../lib/config.js";

export async function peptideCommand(
  code: string,
  opts: { vendors?: boolean },
) {
  const spinner = ora({
    text: c.dim(`fetching ${code.toUpperCase()}...`),
    color: "yellow",
  }).start();

  try {
    if (opts.vendors) {
      const data = await api.peptideVendors(code);
      spinner.stop();
      renderVendors(code.toUpperCase(), data);
    } else {
      const price = await api.peptide(code);
      spinner.stop();
      renderPrice(price);
    }
  } catch (err) {
    spinner.fail(formatError(err));
    process.exit(1);
  }
}

function renderPrice(p: import("../lib/api.js").PeptidePrice) {
  console.log();
  console.log(
    "  " +
      c.mint(p.code.padEnd(14)) +
      c.amber(fmtPrice(p.twap_usd_per_mg)) +
      c.dim(`  ${p.name}`),
  );

  console.log(
    "  " +
      c.mint("TWAP MEMBERS  ") +
      c.body(`${p.twap_vendor_count} `) +
      c.dim(`of ${p.total_vendor_count} vendors`),
  );

  if (p.range_24h_low !== undefined && p.range_24h_high !== undefined) {
    console.log(
      "  " +
        c.mint("24H RANGE     ") +
        c.body(`${fmtPrice(p.range_24h_low)} – ${fmtPrice(p.range_24h_high)}`),
    );
  }

  if (p.last_commit_signature) {
    console.log(
      "  " +
        c.mint("LAST COMMIT   ") +
        c.body(trimSig(p.last_commit_signature)),
    );
  }

  if (p.last_commit_slot !== undefined) {
    console.log(
      "  " +
        c.mint("SOLANA SLOT   ") +
        c.body(p.last_commit_slot.toLocaleString("en-US")),
    );
  }

  if (p.ipfs_manifest_cid) {
    console.log(
      "  " +
        c.mint("IPFS MANIFEST ") +
        c.body(
          p.ipfs_manifest_cid.slice(0, 12) +
            "…" +
            p.ipfs_manifest_cid.slice(-6),
        ),
    );
  }
  console.log();
}

function renderVendors(
  code: string,
  data: import("../lib/api.js").PeptideVendors,
) {
  console.log();
  console.log(
    "  " +
      c.mint(code.padEnd(14)) +
      c.amber(fmtPrice(data.twap_value)) +
      c.dim("  (TWAP)"),
  );
  console.log();

  const table = new Table({
    head: [
      c.dim("VENDOR"),
      c.dim("DOMAIN"),
      c.dim("PRICE"),
      c.dim("vs TWAP"),
      c.dim("IN TWAP"),
    ],
    style: { head: [], border: [] },
    chars: {
      top: "─",
      "top-mid": "┬",
      "top-left": "┌",
      "top-right": "┐",
      bottom: "─",
      "bottom-mid": "┴",
      "bottom-left": "└",
      "bottom-right": "┘",
      left: "│",
      "left-mid": "├",
      mid: "─",
      "mid-mid": "┼",
      right: "│",
      "right-mid": "┤",
      middle: "│",
    },
  });

  // sort: in-twap first, then by absolute bps from median
  const sorted = [...data.observations].sort((a, b) => {
    if (a.in_twap !== b.in_twap) return a.in_twap ? -1 : 1;
    const ax = Math.abs(a.bps_from_median ?? 0);
    const bx = Math.abs(b.bps_from_median ?? 0);
    return ax - bx;
  });

  for (const obs of sorted) {
    const bps = obs.bps_from_median ?? 0;
    const bpsColor =
      Math.abs(bps) < 500 ? c.live : Math.abs(bps) < 2000 ? c.amber : c.red;
    const bpsStr =
      bps === 0 ? c.dim("median") : bpsColor(`${bps > 0 ? "+" : ""}${bps} bps`);

    table.push([
      c.body(obs.vendor_code),
      c.dim(obs.vendor_domain ?? ""),
      c.amber(fmtPrice(obs.price_usd_per_mg)),
      bpsStr,
      obs.in_twap ? c.live(glyph.tick) : c.dim(glyph.cross),
    ]);
  }

  // indent the table by 2 spaces
  console.log(
    table
      .toString()
      .split("\n")
      .map((l) => "  " + l)
      .join("\n"),
  );
  console.log();
}

function formatError(err: unknown): string {
  if (err instanceof ApiError) return c.red(`error: ${err.message}`);
  if (err instanceof Error) return c.red(`error: ${err.message}`);
  return c.red(`error: ${String(err)}`);
}
