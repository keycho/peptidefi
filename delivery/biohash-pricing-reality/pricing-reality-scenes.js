// Cinematic narrative timeline for ?mode=pricing-reality.
//
// 40-second story. Each "beat" owns a time range, a camera framing (with optional
// in-beat animation from a "from" to a "to" state over a duration), header/status
// text, and a declarative overlay spec.
//
// The mode coordinator (./modes/pricing-reality.js) consumes this:
//   - getCamera(scenes, t)  -> current camera state
//   - getBeat(scenes, t)    -> current beat (for overlay text + flags)
// Overlays are drawn imperatively by the coordinator using the beat spec.

import { LAYOUT } from "../style.js";
import { interpCamera, EASES, stageCenterY, clamp01 } from "../camera/camera.js";

export const TOTAL_DURATION_SEC = 40;

// Headline values are hardcoded per the task spec so the cinematic text matches
// even if the snapshot drifts slightly between fetches.
export const HEADLINE = Object.freeze({
  code: "BPC157",
  displayCode: "BPC-157",
  minPrice: 3.6333,
  maxPrice: 11.0000,
  twap: 6.6990,
  spreadRatio: 3.03, // 11.0 / 3.6333
  cycle: 1500,
  slot: 419467611,
  signature: "3tYeH9wTcDfo3WHX6S2s3JhLTkgP289s8jbUoXWsx1hXhkGM62xkx25fY88UAwoLEyT8qTeBQKyax28abg4uYn5Q",
  signatureShort: "3tYeH9w...uYn5Q",
  vendors: [
    { code: "PUREHEALTH", short: "PureHealth", display: "Pure Health Peptides", price: 3.6333 },
    { code: "VERIFIED",   short: "Verified",   display: "Verified Peptides",    price: 5.3000 },
    { code: "LIBERTY",    short: "Liberty",    display: "Liberty Peptides",     price: 5.4000 },
    { code: "SWISSCHEMS", short: "SwissChems", display: "Swiss Chems",          price: 8.0000 },
    { code: "PULSE",      short: "Pulse",      display: "Pulse Peptides",       price: 8.2227 },
    { code: "GENETIC",    short: "Genetic",    display: "Genetic Peptide",      price: 11.0000 },
  ],
});

// Build the per-frame scene state given a loaded view + prepared cross-peptide grid.
export function buildScenes({ view, crossPeptide, cycleStream }) {
  const bpcRow = crossPeptide.rows.find((r) => r.peptide.code === HEADLINE.code);
  if (!bpcRow) {
    throw new Error(
      `pricing-reality: BPC-157 row missing from snapshot (looked for code="${HEADLINE.code}")`,
    );
  }

  const camWide = wideCamera();
  const camBpc = bpc157Camera(crossPeptide, bpcRow);
  const camSolana = solanaCamera(cycleStream);

  const beats = [
    // -------------------- t=0-4: OPENING HOOK --------------------
    {
      name: "opening-hook",
      range: [0, 4],
      camera: { from: camBpc, to: camBpc },
      headerText: "BPC-157  ·  same compound  ·  six vendors",
      statusText: "vendor_price_min=$3.63  ·  vendor_price_max=$11.00",
      overlay: {
        bpcRow,
        dimOthers: true,
        highlightVendors: ["PUREHEALTH", "GENETIC"],
        bracket: {
          minPrice: HEADLINE.minPrice,
          maxPrice: HEADLINE.maxPrice,
          label: `${HEADLINE.spreadRatio.toFixed(2)}× spread`,
          style: "normal",
        },
      },
    },

    // -------------------- t=4-8: BRACKET EMPHASIS --------------------
    {
      name: "bracket-emphasis",
      range: [4, 8],
      camera: { from: camBpc, to: camBpc },
      headerText: "BPC-157  ·  same compound  ·  six vendors",
      statusText: "vendors=6  ·  spread_ratio=3.03  ·  TWAP_pending",
      overlay: {
        bpcRow,
        dimOthers: false,
        highlightVendors: ["PUREHEALTH", "GENETIC"],
        bracket: {
          minPrice: HEADLINE.minPrice,
          maxPrice: HEADLINE.maxPrice,
          label: `${HEADLINE.spreadRatio.toFixed(2)}×`,
          subLabel: "Same compound. Same purity grade.",
          style: "hot",
          pulse: true,
        },
        vendorLabels: true, // show all six vendor pills
      },
    },

    // -------------------- t=8-14: PULLBACK --------------------
    {
      name: "pullback",
      range: [8, 14],
      camera: {
        from: camBpc,
        to: camWide,
        ease: "easeOut",
        durationSec: 4, // animates 8 -> 12, then holds wide 12 -> 14
      },
      headerText: "32 peptides indexed  ·  scanning the set",
      statusText: "scanning indexed peptide set...",
      overlay: {
        bpcRow,
        bracket: {
          minPrice: HEADLINE.minPrice,
          maxPrice: HEADLINE.maxPrice,
          label: `${HEADLINE.spreadRatio.toFixed(2)}×`,
          style: "fading",
          fadeOutRange: [8, 11],
        },
        allRowBrackets: { fadeInRange: [10.5, 13.5], bold: false },
      },
    },

    // -------------------- t=14-22: SYSTEM-WIDE REVEAL --------------------
    {
      name: "system-wide-reveal",
      range: [14, 22],
      camera: { from: camWide, to: camWide },
      headerText: "32 peptides  ·  same compound disagreement, everywhere",
      statusText: "n_peptides=32  ·  spread_persistent  ·  all_peptides_unanchored",
      overlay: {
        allRowBrackets: { fadeInRange: [10.5, 13.5], bold: true },
        floatingTopRight: {
          lines: [
            "32 peptides indexed",
            "spread persists across the indexed set",
            "no peptide priced with <1.3× spread",
          ],
          fadeInRange: [14.2, 15.6],
        },
      },
    },

    // -------------------- t=22-28: RESOLUTION (TWAP enters) --------------------
    {
      name: "resolution-twap",
      range: [22, 28],
      camera: {
        from: camWide,
        to: camBpc,
        ease: "easeInOut",
        durationSec: 3, // animates 22 -> 25, then holds 25 -> 28
      },
      headerText: "TWAP  ·  filtered_median_v1  ·  $6.6990/mg",
      statusText: "TWAP computed  ·  filtered_median_v1  ·  locked at $6.6990/mg",
      overlay: {
        bpcRow,
        allRowBrackets: { bold: false },
        twapSweep: {
          peptideCode: HEADLINE.code,
          twapPrice: HEADLINE.twap,
          startSec: 22.2,
          snapSec: 23.4,
          afterglowEndSec: 24.8,
        },
        twapLabel: {
          text: `✓ TWAP $${HEADLINE.twap.toFixed(4)}/mg`,
          visibleFromSec: 23.6,
        },
      },
    },

    // -------------------- t=28-33: SOLANA COMMIT --------------------
    {
      name: "solana-commit",
      range: [28, 33],
      camera: {
        from: camBpc,
        to: camSolana,
        ease: "easeInOut",
        durationSec: 2, // animates 28 -> 30, then holds 30 -> 33
      },
      headerText: "Solana mainnet-beta  ·  cycle #1500  ·  FINALIZED",
      statusText: "FINALIZED  slot=419467611",
      overlay: {
        bpcRow,
        twapLabel: {
          text: `✓ TWAP $${HEADLINE.twap.toFixed(4)}/mg`,
          visibleFromSec: 23.6,
          fadeOutRange: [28.2, 28.9],
        },
        syntheticLedgerRow: {
          cycleId: HEADLINE.cycle,
          slot: HEADLINE.slot,
          signatureShort: HEADLINE.signatureShort,
          appearSec: 28.6,
          finalizeSec: 29.7,
          pulseHoldSec: 32.5,
        },
      },
    },

    // -------------------- t=33-38: RETURN TO WIDE --------------------
    {
      name: "return-wide",
      range: [33, 38],
      camera: {
        from: camSolana,
        to: camWide,
        ease: "easeInOut",
        durationSec: 3, // animates 33 -> 36, then holds 36 -> 38
      },
      headerText: "32 peptides priced  ·  on-chain reference  ·  mainnet-beta",
      statusText: "biohash-oracle  ·  32 peptides priced  ·  mainnet-beta",
      overlay: {
        allRowBrackets: { bold: false },
        titleCard: {
          line1: "BioHash.",
          line2: "The first on-chain reference price for the peptide market.",
          fadeInRange: [35.0, 36.6],
        },
      },
    },

    // -------------------- t=38-40: HOLD FINAL --------------------
    {
      name: "hold-final",
      range: [38, 40],
      camera: { from: camWide, to: camWide },
      headerText: "32 peptides priced  ·  on-chain reference  ·  mainnet-beta",
      statusText: "biohash-oracle  ·  32 peptides priced  ·  mainnet-beta",
      overlay: {
        allRowBrackets: { bold: false },
        titleCard: {
          line1: "BioHash.",
          line2: "The first on-chain reference price for the peptide market.",
          fadeInRange: [35.0, 36.6],
        },
      },
    },
  ];

  return { beats, bpcRow, camWide, camBpc, camSolana };
}

function wideCamera() {
  return { cx: LAYOUT.width / 2, cy: stageCenterY(), scale: 1.0 };
}

function bpc157Camera(crossPeptide, bpcRow) {
  // Centre the BPC-157 row's vendor track horizontally, and the row's vertical
  // midpoint vertically. Scale 2x as the spec requires.
  const xc = (crossPeptide.axisLeft + crossPeptide.axisRight) / 2;
  return { cx: xc, cy: bpcRow.yCenter, scale: 2.0 };
}

function solanaCamera(cycleStream) {
  const r = cycleStream.regions;
  // Focus the LEDGER column. The new ledger row is drawn near the top of the
  // ledger area, so we bias the framing upward so that row lands at screen mid
  // without colliding with the (screen-space) header strip above.
  const xc = (r.ledgerLeft + r.ledgerRight) / 2;
  const yc = r.ledgerTop + 110; // shifts the row into the visible stage centre
  return { cx: xc, cy: yc, scale: 1.5 };
}

// Find the active beat for a given t. Returns the last beat if t is past the end.
export function getBeat(scenes, t) {
  for (const b of scenes.beats) {
    if (t >= b.range[0] && t < b.range[1]) return b;
  }
  return scenes.beats[scenes.beats.length - 1];
}

// Interpolated camera state for a given t. Within a beat, the camera animates
// from beat.camera.from to beat.camera.to over beat.camera.durationSec (defaults
// to the beat length). After that it holds the "to" state until the next beat.
export function getCamera(scenes, t) {
  const beat = getBeat(scenes, t);
  const cam = beat.camera;
  const [t0, t1] = beat.range;
  const dur = cam.durationSec ?? (t1 - t0);
  const u = clamp01((t - t0) / dur);
  return interpCamera(cam.from, cam.to, u, cam.ease ?? "easeInOut");
}

// Helper used by overlays: fade factor over a [startSec, endSec] window.
export function fadeIn(t, [a, b]) {
  if (b <= a) return t >= a ? 1 : 0;
  return clamp01((t - a) / (b - a));
}

// 1 -> 0 fade over a window.
export function fadeOut(t, [a, b]) {
  return 1 - fadeIn(t, [a, b]);
}

export { EASES };
