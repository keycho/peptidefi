import chalk from "chalk";

// BioHash terminal palette
// Matched to the announcement card (biohash_index_announcement_FINAL_v4)

// Hex references from the card:
//   TERMINAL_BG     #0A0F1E   (no inline bg control via chalk - terminal supplies it)
//   TERMINAL_TEXT   #D9D6CC   cream body
//   TERMINAL_AMBER  #FAC775   field values, headings
//   TERMINAL_MINT   #9FE1CB   field names, success
//   TERMINAL_RED    #F09595   declines, errors
//   TERMINAL_DIM    #888880   labels, hints
//   T_GREEN         #5DCAA5   live dot, verify ticks

// chalk.hex calls — chalk@5 still supports them
export const c = {
  body: chalk.hex("#D9D6CC"),
  amber: chalk.hex("#FAC775"),
  mint: chalk.hex("#9FE1CB"),
  red: chalk.hex("#F09595"),
  dim: chalk.hex("#888880"),
  live: chalk.hex("#5DCAA5"),
  white: chalk.hex("#FFFFFF"),
  navy: chalk.hex("#5B8DEF"),
};

// box-drawing characters used throughout
export const box = {
  tl: "┌",
  tr: "┐",
  bl: "└",
  br: "┘",
  h: "─",
  v: "│",
  cross: "┼",
  tDown: "┬",
  tUp: "┴",
  tRight: "├",
  tLeft: "┤",
};

// status glyphs
export const glyph = {
  dot: "●",
  tick: "✓",
  cross: "✗",
  arrowDown: "▼",
  arrowUp: "▲",
  arrow: "→",
  ellipsis: "…",
};

// reusable rule that adapts to terminal width up to a cap
export function rule(width = 60): string {
  return c.dim(box.h.repeat(width));
}

// version stamp - bumped here and exported for splash + --version
export const VERSION = "0.1.0";
