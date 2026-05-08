# biohash-promo

Remotion explainer video for BioHash. 90 seconds, 1920×1080, 30fps,
silent (text-driven).

Composition id: **`BioHashExplainer`**.

## Quick start

```bash
cd biohash-promo
npm install
npm run dev          # opens Remotion Studio at http://localhost:3000
npm run render       # renders to out/BioHashExplainer.mp4
```

## What's inside

```
src/
├── index.ts                        — registerRoot entry
├── Root.tsx                        — Composition definition
├── BioHashExplainer.tsx            — top-level composition (sequences sections)
├── theme.ts                        — design tokens + section frame ranges
├── CornerBrackets.tsx              — shared corner-bracket helper
├── SectionShell.tsx                — per-section AbsoluteFill wrapper with crossfade
└── sections/
    ├── Positioning.tsx             — frames 0–360       (12s) — what BioHash is
    ├── Oracle.tsx                  — frames 360–960     (20s) — how the oracle works
    ├── PegReserve.tsx              — frames 960–1740    (26s) — mint/burn + reserve
    ├── ComposableLayer.tsx         — frames 1740–2340   (20s) — what's possible on top
    ├── Status.tsx                  — frames 2340–2580   (8s)  — what's live now
    └── Cta.tsx                     — frames 2580–2700   (4s)  — biohash.network
```

Each section component is self-contained:

- knows its own `[startFrame, endFrame]` from `theme.ts/sectionFrames`
- handles its own crossfade in/out via `SectionShell`
- exposes a `localFrame` (current absolute frame minus its start) so
  internal animations can be tuned in section-relative time.

The whole video is 2700 frames (90s × 30fps). Crossfades are 14
frames (~0.47s) — see `FADE_FRAMES` in `theme.ts`.

## Design system

Inline styles only (no Tailwind, no CSS modules). Tokens centralised
in `theme.ts`:

- background: `#FAFAF7` (cream)
- ink: `#0F1A2E` (near-black)
- blue: `#3B82F6` (single accent)
- font: JetBrains Mono via `@remotion/google-fonts/JetBrainsMono`

Sharp corners only (no `border-radius`). Corner-bracket motif
(`CornerBrackets.tsx`) on every box for the technical-drawing feel.

## Animations

- Spring entrances: `spring({ damping: 100, stiffness: 100,
  overshootClamping: true })` from `theme.ts/SPRING`. Settled, no
  bounce.
- Reveals/fades: `interpolate(frame, [a, b], [0, 1], { extrapolateLeft:
  'clamp', extrapolateRight: 'clamp' })`.
- Section crossfades: handled inside `SectionShell` — adjacent
  sections render together during the FADE_FRAMES overlap.

## Tweaking copy

Most strings live inline in their section file. Changing a peptide
list, vendor list, or stat strip is a one-line edit in
`sections/<Section>.tsx`. Section frame timing changes are a one-line
edit in `theme.ts`.

## Tweaking section duration

Edit `sectionFrames` in `src/theme.ts`. The section components and
`SectionShell` read from there; sections automatically rebalance.
**Do** make sure each section's internal animations still fit inside
the new window — open Remotion Studio and scrub through.

## Replacing the placeholder logo / vendor data

The Oracle section uses illustrative vendor names + prices for the
"MULTI-VENDOR SCRAPERS" box. Edit the `VENDORS` const at the top of
`sections/Oracle.tsx` to update.

The Status section's stat block is in `sections/Status.tsx` (the
`STATS` const). Currently shows:
- `ORACLE LIVE — 7+ DAYS UPTIME`
- `~600 COMMITS PER DAY`
- `$1,000 USDC IN RESERVE`
- `FIRST MINT SETTLED`
- `TOKEN METADATA ON-CHAIN`

## Render presets

```bash
# Default (1920x1080, h264, full quality)
npx remotion render BioHashExplainer out/BioHashExplainer.mp4

# Lower bitrate for upload to Twitter / pump.fun (limit ~512MB):
npx remotion render BioHashExplainer out/BioHashExplainer-twitter.mp4 \
  --crf=24

# Half-speed render at 1280x720 for fast iteration:
npx remotion render BioHashExplainer out/BioHashExplainer-720p.mp4 \
  --concurrency=4 --crf=20

# Render a specific section only (debug):
npx remotion render BioHashExplainer out/oracle.mp4 \
  --frames=360-960
```

## Using only `src/` against your existing scaffold

If you already have a fresh `npx create-video` Hello World scaffold
locally and just want my composition without overwriting your
`package.json` / `tsconfig.json` / `remotion.config.ts`:

```bash
# From the parent directory of your existing biohash-promo:
git checkout claude/biohash-explainer-video -- biohash-promo/src
git checkout claude/biohash-explainer-video -- biohash-promo/README.md

# Verify your package.json includes:
#   - "@remotion/google-fonts": "^4.0.0"
# If it's not, install:
cd biohash-promo
npm install @remotion/google-fonts

npm run dev
```

The composition expects `react`, `react-dom`, `remotion`,
`@remotion/cli`, and `@remotion/google-fonts`. The first four come
with the standard Remotion scaffold; the fifth is the only addition.
