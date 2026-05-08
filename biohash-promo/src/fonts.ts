// Font registry — three families that mirror biohash.network exactly.
//
//   display = Barlow Condensed (BIOHASH wordmark, section titles,
//             all-caps labels with letter-spacing)
//   body    = Inter (paragraph copy, captions, descriptive text)
//   mono    = JetBrains Mono (numbers, addresses, peptide codes,
//             vendor prices, hex tx IDs, URLs)
//
// loadFont() is called once at module load; the resulting fontFamily
// strings are stable across the entire render and bundled into the
// Remotion output (no network at render time).

import { loadFont as loadBarlowCondensed } from "@remotion/google-fonts/BarlowCondensed";
import { loadFont as loadInter } from "@remotion/google-fonts/Inter";
import { loadFont as loadJetBrainsMono } from "@remotion/google-fonts/JetBrainsMono";

const display = loadBarlowCondensed("normal", {
  weights: ["500", "600", "700"],
});
const body = loadInter("normal", {
  weights: ["400", "500", "700"],
});
const mono = loadJetBrainsMono("normal", {
  weights: ["400", "500", "700"],
});

export const fonts = {
  display: display.fontFamily,
  body: body.fontFamily,
  mono: mono.fontFamily,
} as const;
