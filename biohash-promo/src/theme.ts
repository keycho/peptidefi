// Shared design tokens — keeps the BioHash blueprint aesthetic
// consistent across every section. Mirrors the colour palette used on
// biohash.network (cream background, near-black ink, single brand
// blue accent).

export const colors = {
  background: "#FAFAF7",
  ink: "#0F1A2E",
  muted: "#6B7280",
  border: "#D1D5DB",
  blue: "#3B82F6",
  blueDark: "#1E40AF",
  // Subtle gridline used in the technical-drawing background.
  grid: "#E5E7EB",
  // Used for "on" status dots, success checks.
  success: "#0F5132",
} as const;

// Section frame ranges. Single source of truth — every section reads
// these so adjusting timing in one place propagates everywhere.
export const sectionFrames = {
  positioning: { start: 0, end: 360 }, // 0–12s
  oracle: { start: 360, end: 960 }, // 12–32s
  pegReserve: { start: 960, end: 1740 }, // 32–58s
  composableLayer: { start: 1740, end: 2340 }, // 58–78s
  // Status extended +80 frames (was 240, now 320) to fit the
  // screenshot-reveal sub-phase before the 5-stat list. Cta shifts
  // by the same amount; total composition grows 2700 → 2780 (90s →
  // 92.7s). Composition.durationInFrames in Root.tsx must match.
  status: { start: 2340, end: 2660 }, // 78–88.7s
  cta: { start: 2660, end: 2780 }, // 88.7–92.7s
} as const;

// Per-section crossfade window (frames). Each section fades in over
// FADE_FRAMES leading frames and fades out over FADE_FRAMES trailing
// frames. Keep small enough that the visible content has room to do
// its own internal animations without feeling rushed.
export const FADE_FRAMES = 14;

// Spring config used for entrance animations across the video.
// overshootClamping=true gives a clean settle (no bounce); damping
// + stiffness tuned for a confident, decisive arrival rather than
// a playful pop.
export const SPRING = {
  damping: 100,
  stiffness: 100,
  mass: 1,
  overshootClamping: true,
} as const;
