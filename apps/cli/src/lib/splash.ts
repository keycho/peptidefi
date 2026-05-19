import { c, glyph, VERSION } from "./theme.js";
import { config, trimAddr } from "./config.js";

// ASCII art for "BIOHASH" — hand-crafted block characters, single line.
// Each character is 6 cols wide, 5 rows tall, 1 col gap. Total ~50 cols.
//
// Generated using block characters: █ for body, with no shadow (matches
// the announcement card's clean amber-on-dark feel).
//
// The "+ on-chain peptide price discovery +" subtitle echoes the
// OpenClaude reference's "+ Any model. Every tool. Zero limits. +".
const LOGO = [
  "██████  ██  ██████  ██   ██  █████  ███████ ██   ██",
  "██   ██ ██ ██    ██ ██   ██ ██   ██ ██      ██   ██",
  "██████  ██ ██    ██ ███████ ███████ ███████ ███████",
  "██   ██ ██ ██    ██ ██   ██ ██   ██      ██ ██   ██",
  "██████  ██  ██████  ██   ██ ██   ██ ███████ ██   ██",
];

const SUBTITLE = "+ on-chain peptide price discovery +";

export function renderSplash(): string {
  const lines: string[] = [];

  // top spacing
  lines.push("");

  // logo in amber
  for (const row of LOGO) {
    lines.push("  " + c.amber(row));
  }

  lines.push("");
  lines.push("  " + c.dim(SUBTITLE));
  lines.push("");

  // info panel — fixed width 64 cols
  const W = 64;
  const inner = W - 2;

  const row = (label: string, value: string): string => {
    const labelPart = c.mint(label.padEnd(12));
    const content = `${labelPart} ${c.body(value)}`;
    // we can't measure ANSI string length easily; trust the alignment
    return c.dim("  │ ") + content + " ".repeat(Math.max(0, inner - 1 - 13 - value.length)) + c.dim("│");
  };

  lines.push("  " + c.dim("┌" + "─".repeat(inner) + "┐"));
  lines.push(row("Network", "Solana mainnet-beta"));
  lines.push(row("API", config.apiUrl));
  lines.push(row("Program", trimAddr(config.indexProgram)));
  lines.push(row("Index PDA", trimAddr(config.indexPda) + "  (devnet)"));
  lines.push("  " + c.dim("└" + "─".repeat(inner) + "┘"));
  lines.push("");

  // status line
  lines.push(
    "  " +
      c.live(glyph.dot) +
      " " +
      c.live("live") +
      "    " +
      c.body("type ") +
      c.amber("biohash --help") +
      c.body(" to begin"),
  );
  lines.push("");

  // version stamp
  lines.push("  " + c.dim(`biohash v${VERSION}`));
  lines.push("");

  return lines.join("\n");
}
