// ?mode=pricing-reality
//
// Cinematic narrative video (40s) that reveals vendor disagreement on the SAME
// peptide compound. Uses the existing Oracle Lab v2 panel renderers untouched;
// adds a camera transform and overlay layer on top.
//
// Architecture:
//   1. Build the existing prep objects from the loaded view (panel-cycle-stream
//      + panel-cross-peptide). These remain the canonical world rendering.
//   2. Build the scene list (40s of beats with camera framings + overlay specs).
//   3. Per frame:
//        a. Fill background
//        b. Save ctx, apply camera transform, render both panels at world coords,
//           draw world-space cinematic overlays (brackets, vendor labels, TWAP
//           sweep, synthetic ledger row, all-row bracket emphasis), restore ctx.
//        c. Draw screen-space chrome (header strip, status strip, citation
//           strip, floating annotations, title card) WITHOUT the camera transform
//           so they stay readable.
//
// The default mode (no ?mode=) is unchanged — main.js falls through to its
// original buildPrep + renderFrame path.

import {
  COLORS,
  FONTS,
  LAYOUT,
  headerRect,
  footerRect,
  panel1Rect,
} from "../style.js";
import {
  prepareCycleStream,
  renderPanel1,
} from "../panels/panel-cycle-stream.js";
import {
  prepareCrossPeptide,
  renderPanel2,
} from "../panels/panel-cross-peptide.js";
import {
  buildTimeMapper,
  scheduleCycleStream,
  Player,
  bindKeyboard,
} from "../animation.js";
import { applyCamera } from "../camera/camera.js";
import {
  buildScenes,
  getBeat,
  getCamera,
  fadeIn,
  fadeOut,
  TOTAL_DURATION_SEC,
  HEADLINE,
} from "../scenes/pricing-reality-scenes.js";

// Public entry point. main.js calls this when ?mode=pricing-reality.
export async function runPricingRealityMode({ ctx, view, setStatus }) {
  const mapper = buildTimeMapper(view.cycleStream);
  const scheduled = scheduleCycleStream(view.cycleStream, mapper);
  const cycleStream = prepareCycleStream(scheduled, panel1Rect());
  const crossPeptide = prepareCrossPeptide(view);

  let scenes;
  try {
    scenes = buildScenes({ view, crossPeptide, cycleStream });
  } catch (err) {
    setStatus?.(`pricing-reality: ${err.message}`);
    console.error(err);
    return;
  }

  // The video loops — at t=40 we want to jump straight back to t=0, not hold.
  const player = new Player({
    durationSec: TOTAL_DURATION_SEC,
    onFrame: (t, playerState) => {
      renderPricingRealityFrame(ctx, {
        view, cycleStream, crossPeptide, scenes,
      }, t, playerState);
    },
  });
  player.holdAtEnd = false;
  const unbind = bindKeyboard(player);

  // Optional ?t= for deterministic screenshotting, plus ?paused=1 to freeze.
  const params = new URLSearchParams(window.location.search);
  const tParam = params.get("t");
  if (tParam !== null) {
    const t = Number(tParam);
    if (Number.isFinite(t)) player.setElapsed(t);
  }
  if (params.get("paused") === "1") {
    player.paused = true;
  }

  player.start();
  setStatus?.(
    `pricing-reality  ·  40s  ·  BPC-157 spread ${HEADLINE.spreadRatio.toFixed(2)}×  ·  [space] pause  [r] restart  [0] seek-start  [arrows] scrub`,
  );
  window.__lab = { mode: "pricing-reality", view, player, ctx, unbind, scenes };
}

// ----------------------------------------------------------------------------
// Per-frame render
// ----------------------------------------------------------------------------

function renderPricingRealityFrame(ctx, ctxBag, t, playerState) {
  const { view, cycleStream, crossPeptide, scenes } = ctxBag;

  ctx.save();

  // 1. background
  ctx.fillStyle = COLORS.background;
  ctx.fillRect(0, 0, LAYOUT.width, LAYOUT.height);

  // 2. compute camera + active beat
  const cam = getCamera(scenes, t);
  const beat = getBeat(scenes, t);

  // 3. WORLD layer — under camera transform
  ctx.save();
  applyCamera(ctx, cam);

  // Underlying panels (existing, untouched). Use a static elapsedSec for panels
  // so the cycle-stream particle animation is calm rather than racing — the
  // story here is not the system running, it's the spreads it reveals.
  const panelElapsed = 0;
  renderPanel1(ctx, view, cycleStream, panelElapsed);
  renderPanel2(ctx, view, crossPeptide, panelElapsed);

  // Cinematic overlays in world space (zoom with camera)
  drawWorldOverlays(ctx, ctxBag, beat, t);

  ctx.restore();

  // 4. SCREEN layer — fixed UI strips on top of everything
  drawHeaderStrip(ctx, beat, t, view);
  drawFooterStrip(ctx, beat, view, playerState);
  drawScreenAnnotations(ctx, ctxBag, beat, t);

  ctx.restore();
}

// ----------------------------------------------------------------------------
// WORLD overlays
// ----------------------------------------------------------------------------

function drawWorldOverlays(ctx, ctxBag, beat, t) {
  const ov = beat.overlay ?? {};

  // (a) Dim non-highlighted vendor dots on the BPC-157 row. We achieve the
  //     "60% opacity" effect by painting a translucent-background scrim over
  //     the row, then re-drawing the highlighted dots brighter on top.
  if (ov.dimOthers && ov.bpcRow) {
    drawDimRowScrim(ctx, ctxBag.crossPeptide, ov.bpcRow);
  }

  // (b) All-row bracket emphasis (faded in across the pullback → reveal beats).
  if (ov.allRowBrackets) {
    const alpha = ov.allRowBrackets.fadeInRange
      ? fadeIn(t, ov.allRowBrackets.fadeInRange)
      : 1;
    if (alpha > 0.01) {
      drawAllRowBrackets(ctx, ctxBag.crossPeptide, alpha, ov.allRowBrackets.bold);
    }
  }

  // (c) Vendor highlight halos (PUREHEALTH + GENETIC during opening beats).
  if (ov.highlightVendors && ov.bpcRow) {
    drawVendorHighlights(ctx, ctxBag.crossPeptide, ov.bpcRow, ov.highlightVendors);
  }

  // (d) The big BPC-157 bracket annotation.
  if (ov.bracket && ov.bpcRow) {
    let alpha = 1;
    if (ov.bracket.fadeOutRange) alpha = fadeOut(t, ov.bracket.fadeOutRange);
    if (alpha > 0.01) {
      drawBpcBracket(ctx, ctxBag.crossPeptide, ov.bpcRow, ov.bracket, t, alpha);
    }
  }

  // (e) Per-vendor name labels (during bracket-emphasis beat).
  if (ov.vendorLabels && ov.bpcRow) {
    drawBpcVendorLabels(ctx, ctxBag.crossPeptide, ov.bpcRow);
  }

  // (f) TWAP sweep + snap on BPC-157 (resolution beat).
  if (ov.twapSweep && ov.bpcRow) {
    drawTwapSweep(ctx, ctxBag.crossPeptide, ov.bpcRow, ov.twapSweep, t);
  }

  // (g) "✓ TWAP $..." label above BPC-157 row.
  if (ov.twapLabel && ov.bpcRow) {
    let alpha = fadeIn(t, [
      ov.twapLabel.visibleFromSec,
      ov.twapLabel.visibleFromSec + 0.4,
    ]);
    if (ov.twapLabel.fadeOutRange) {
      alpha *= fadeOut(t, ov.twapLabel.fadeOutRange);
    }
    if (alpha > 0.01) {
      drawTwapLabel(ctx, ctxBag.crossPeptide, ov.bpcRow, ov.twapLabel.text, alpha);
    }
  }

  // (h) Synthetic ledger row for cycle #1500 (solana commit beat).
  if (ov.syntheticLedgerRow) {
    drawSyntheticLedgerRow(ctx, ctxBag.cycleStream, ov.syntheticLedgerRow, t);
  }
}

// Dim the parts of the BPC-157 row that aren't highlighted. Implementation: paint
// a 40%-alpha background-coloured scrim over the row's vendor track. The
// highlighted dots are then redrawn on top so they punch through.
function drawDimRowScrim(ctx, prep, bpcRow) {
  const yc = bpcRow.yCenter;
  const h = bpcRow.rowHeight + 1;
  ctx.save();
  ctx.fillStyle = "rgba(15, 17, 21, 0.55)";
  ctx.fillRect(prep.axisLeft - 4, yc - h / 2, prep.axisRight - prep.axisLeft + 8, h);
  ctx.restore();
}

// Per-peptide bracket emphasis for the wide shot. Each priced row gets a slightly
// bolder horizontal bar with caps + an "Nx" label centred on it.
function drawAllRowBrackets(ctx, prep, alpha, bold) {
  ctx.save();
  ctx.globalAlpha = alpha;
  for (const row of prep.rows) {
    const p = row.peptide;
    if (p.isObservationPhase || p.spreadMin == null || p.spreadMax == null) continue;
    const x0 = prep.xScale(p.spreadMin);
    const x1 = prep.xScale(p.spreadMax);
    const yc = row.yCenter;

    ctx.strokeStyle = bold ? "#C896E6" : "rgba(200, 150, 230, 0.55)";
    ctx.lineWidth = bold ? 1.5 : 1.1;
    ctx.beginPath();
    ctx.moveTo(x0, yc);
    ctx.lineTo(x1, yc);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x0, yc - 4);
    ctx.lineTo(x0, yc + 4);
    ctx.moveTo(x1, yc - 4);
    ctx.lineTo(x1, yc + 4);
    ctx.stroke();

    // Ratio label (e.g. "2.7×") centred above the bracket
    const ratio = p.spreadMax / p.spreadMin;
    if (Number.isFinite(ratio) && ratio > 1.05) {
      ctx.fillStyle = bold ? "#E8C8FF" : "rgba(200, 150, 230, 0.8)";
      ctx.font = `500 8px ${FONTS.mono}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "alphabetic";
      ctx.fillText(`${ratio.toFixed(1)}×`, (x0 + x1) / 2, yc - 5);
    }
  }
  ctx.globalAlpha = 1;
  ctx.restore();
}

// Halos around PUREHEALTH + GENETIC dots on the BPC-157 row. The dots
// themselves are rendered by panel-cross-peptide; we add an extra glow ring on
// top so they read as the "two compared dots."
function drawVendorHighlights(ctx, prep, bpcRow, vendorCodes) {
  const p = bpcRow.peptide;
  const yc = bpcRow.yCenter;
  ctx.save();
  for (const v of p.vendors) {
    if (!vendorCodes.includes(v.code)) continue;
    const x = prep.xScale(v.price);
    // outer pulse ring
    ctx.beginPath();
    ctx.strokeStyle = v.color;
    ctx.globalAlpha = 0.8;
    ctx.lineWidth = 1.4;
    ctx.arc(x, yc, 7, 0, Math.PI * 2);
    ctx.stroke();
    // inner brighter dot
    ctx.beginPath();
    ctx.fillStyle = v.color;
    ctx.globalAlpha = 1;
    ctx.arc(x, yc, 3.4, 0, Math.PI * 2);
    ctx.fill();
    // tiny price stamp under the dot
    ctx.fillStyle = "rgba(232, 230, 222, 0.95)";
    ctx.font = `500 7px ${FONTS.mono}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillText(`$${v.price.toFixed(2)}`, x, yc + 6);
  }
  ctx.globalAlpha = 1;
  ctx.restore();
}

// Big bracket spanning min → max on BPC-157 with a centred ratio label.
function drawBpcBracket(ctx, prep, bpcRow, br, t, alpha) {
  const yc = bpcRow.yCenter;
  const xMin = prep.xScale(br.minPrice);
  const xMax = prep.xScale(br.maxPrice);
  const bracketY = yc - 8.5; // above the row

  const hot = br.style === "hot";
  const fading = br.style === "fading";
  const color = hot ? "#FAC775" : (fading ? "rgba(200, 150, 230, 0.45)" : "#C896E6");
  const bold = hot ? 1.7 : (fading ? 0.9 : 1.3);

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = color;
  ctx.lineWidth = bold;
  // horizontal bar
  ctx.beginPath();
  ctx.moveTo(xMin, bracketY);
  ctx.lineTo(xMax, bracketY);
  ctx.stroke();
  // caps (down-facing tick marks)
  ctx.beginPath();
  ctx.moveTo(xMin, bracketY);
  ctx.lineTo(xMin, bracketY + 4);
  ctx.moveTo(xMax, bracketY);
  ctx.lineTo(xMax, bracketY + 4);
  ctx.stroke();

  // Pulsing label
  const labelY = bracketY - 4;
  const xMid = (xMin + xMax) / 2;
  let scale = 1;
  if (br.pulse) {
    const w = (t - 4) % 1.4;
    scale = 1 + 0.10 * Math.sin((w / 1.4) * Math.PI * 2);
  }
  ctx.fillStyle = color;
  const labelSize = (hot ? 11 : 9) * scale;
  ctx.font = `700 ${labelSize.toFixed(1)}px ${FONTS.mono}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  // background plate behind the label for legibility
  const labelText = br.label;
  const w = ctx.measureText(labelText).width;
  ctx.save();
  ctx.fillStyle = "rgba(15, 17, 21, 0.85)";
  ctx.fillRect(xMid - w / 2 - 3, labelY - labelSize - 1, w + 6, labelSize + 3);
  ctx.restore();
  ctx.fillText(labelText, xMid, labelY);

  // Sub-label (italic-ish, smaller, sits below the bracket)
  if (br.subLabel) {
    ctx.fillStyle = "rgba(232, 230, 222, 0.78)";
    ctx.font = `400 7px ${FONTS.mono}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    const subY = yc + bpcRow.rowHeight / 2 + 5;
    const subW = ctx.measureText(br.subLabel).width;
    ctx.save();
    ctx.fillStyle = "rgba(15, 17, 21, 0.85)";
    ctx.fillRect(xMid - subW / 2 - 3, subY - 1, subW + 6, 9);
    ctx.restore();
    ctx.fillStyle = "rgba(232, 230, 222, 0.92)";
    ctx.fillText(br.subLabel, xMid, subY);
  }

  ctx.restore();
}

// Mono-font vendor pills next to each dot on the BPC-157 row. Alternates above
// and below the row so labels don't pile up on top of each other.
function drawBpcVendorLabels(ctx, prep, bpcRow) {
  const p = bpcRow.peptide;
  const yc = bpcRow.yCenter;
  // Stagger above/below to avoid horizontal collisions in tight regions.
  const stagger = [-1, 1, -1, 1, -1, 1];
  ctx.save();
  ctx.font = `500 6.5px ${FONTS.mono}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (let i = 0; i < p.vendors.length; i++) {
    const v = p.vendors[i];
    const x = prep.xScale(v.price);
    const dy = stagger[i % stagger.length] * 12;
    const y = yc + dy;
    const labelShort = vendorShortName(v.name);
    const text = `${labelShort} · $${v.price.toFixed(2)}`;
    const w = ctx.measureText(text).width;
    // background pill
    ctx.fillStyle = "rgba(15, 17, 21, 0.92)";
    ctx.fillRect(x - w / 2 - 3, y - 5.5, w + 6, 11);
    ctx.strokeStyle = "rgba(232, 230, 222, 0.18)";
    ctx.lineWidth = 0.5;
    ctx.strokeRect(x - w / 2 - 3, y - 5.5, w + 6, 11);
    // text
    ctx.fillStyle = v.color;
    ctx.fillText(text, x, y);
    // connector line from dot to pill
    ctx.strokeStyle = "rgba(232, 230, 222, 0.25)";
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    ctx.moveTo(x, yc);
    ctx.lineTo(x, y - (dy > 0 ? 5.5 : -5.5));
    ctx.stroke();
  }
  ctx.restore();
}

function vendorShortName(displayName) {
  const map = {
    "Pure Health Peptides": "PureHealth",
    "Verified Peptides":    "Verified",
    "Liberty Peptides":     "Liberty",
    "Swiss Chems":          "SwissChems",
    "Pulse Peptides":       "Pulse",
    "Genetic Peptide":      "Genetic",
  };
  return map[displayName] ?? (displayName || "?").split(" ")[0];
}

// Sweep + snap. From startSec to snapSec, a TWAP line animates from the left edge
// of the row across to the median position, narrowing in as it approaches.
// At snapSec, a magnetic burst goes off and the tick locks.
function drawTwapSweep(ctx, prep, bpcRow, sw, t) {
  if (t < sw.startSec) return;
  const yc = bpcRow.yCenter;
  const xTarget = prep.xScale(sw.twapPrice);
  const halfRow = bpcRow.rowHeight / 2 + 2;

  // Phase 1: sweep — line moves from xL toward xTarget, easing in.
  const sweepProg = Math.min(1, (t - sw.startSec) / (sw.snapSec - sw.startSec));
  const xL = prep.axisLeft;
  const xCur = xL + (xTarget - xL) * easeOutCubic(sweepProg);

  ctx.save();
  // soft trailing band behind the moving tick
  const grad = ctx.createLinearGradient(xL, yc, xCur, yc);
  grad.addColorStop(0, "rgba(82, 148, 224, 0)");
  grad.addColorStop(1, "rgba(82, 148, 224, 0.65)");
  ctx.fillStyle = grad;
  ctx.fillRect(xL, yc - halfRow, xCur - xL, halfRow * 2);

  // the moving / locked tick itself
  ctx.strokeStyle = "#5294E0";
  ctx.lineWidth = 1.8;
  ctx.beginPath();
  ctx.moveTo(xCur, yc - halfRow);
  ctx.lineTo(xCur, yc + halfRow);
  ctx.stroke();

  // Snap burst: brief radial flash centred on the TWAP point.
  if (t >= sw.snapSec && t < sw.afterglowEndSec) {
    const u = (t - sw.snapSec) / (sw.afterglowEndSec - sw.snapSec);
    const a = 1 - u;
    const r = 6 + u * 26;
    ctx.beginPath();
    ctx.strokeStyle = `rgba(93, 202, 165, ${a * 0.85})`;
    ctx.lineWidth = 2;
    ctx.arc(xTarget, yc, r, 0, Math.PI * 2);
    ctx.stroke();

    ctx.beginPath();
    ctx.fillStyle = `rgba(93, 202, 165, ${a})`;
    ctx.arc(xTarget, yc, 3.4 * (1 - u * 0.4), 0, Math.PI * 2);
    ctx.fill();
  }

  // After the snap, draw the final TWAP tick in green so it reads as "locked"
  if (t >= sw.snapSec) {
    ctx.strokeStyle = "#5DCAA5";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(xTarget, yc - halfRow);
    ctx.lineTo(xTarget, yc + halfRow);
    ctx.stroke();
  }
  ctx.restore();
}

function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }

function drawTwapLabel(ctx, prep, bpcRow, text, alpha) {
  const yc = bpcRow.yCenter;
  const xTarget = prep.xScale(HEADLINE.twap);
  const labelY = yc - bpcRow.rowHeight / 2 - 14;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.font = `700 10px ${FONTS.mono}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  const w = ctx.measureText(text).width;
  // background plate
  ctx.fillStyle = "rgba(15, 17, 21, 0.92)";
  ctx.fillRect(xTarget - w / 2 - 5, labelY - 11, w + 10, 14);
  ctx.strokeStyle = "rgba(93, 202, 165, 0.6)";
  ctx.lineWidth = 0.6;
  ctx.strokeRect(xTarget - w / 2 - 5, labelY - 11, w + 10, 14);
  // label text
  ctx.fillStyle = "#5DCAA5";
  ctx.fillText(text, xTarget, labelY);
  ctx.restore();
}

// A pretend ledger row for cycle #1500 drawn over the panel's existing ledger
// area. Three phases:
//   - appear (slot etc. fade in)
//   - finalize (pulse-green flash, status flips from submitted → finalized)
//   - hold (steady, the camera is still on it)
function drawSyntheticLedgerRow(ctx, cycleStream, row, t) {
  const r = cycleStream.regions;
  if (t < row.appearSec) return;
  // Place IN the body of the ledger column, just below the "Solana mainnet-beta"
  // heading. At this beat the underlying ledger is empty (panelElapsed=0 in this
  // mode), so the area below the heading is clean.
  const y = r.ledgerTop + r.ledgerHeadingHeight + 6;
  const rowH = r.ledgerRowHeight + 8;

  // background card
  const finalized = t >= row.finalizeSec;
  const pulseT = clamp01((t - row.finalizeSec) / 1.2);
  const pulseAlpha = finalized ? Math.max(0, 0.55 - pulseT * 0.55) : 0;

  ctx.save();
  // appear fade-in over 0.6s
  const appearAlpha = Math.min(1, (t - row.appearSec) / 0.6);
  ctx.globalAlpha = appearAlpha;

  // pulse green underline
  if (pulseAlpha > 0) {
    ctx.fillStyle = `rgba(93, 202, 165, ${pulseAlpha})`;
    ctx.fillRect(r.ledgerLeft, y - 2, r.ledgerRight - r.ledgerLeft, rowH);
  }

  // border / left rule
  ctx.fillStyle = finalized ? "#5DCAA5" : "#FAC775";
  ctx.fillRect(r.ledgerLeft, y - 2, 2, rowH);

  // status dot
  ctx.beginPath();
  ctx.fillStyle = finalized ? "#5DCAA5" : "#FAC775";
  ctx.arc(r.ledgerLeft + 12, y + 9, 3.2, 0, Math.PI * 2);
  ctx.fill();

  // cycle id
  ctx.fillStyle = COLORS.foreground;
  ctx.font = `600 10px ${FONTS.mono}`;
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.fillText(`#${row.cycleId}`, r.ledgerLeft + 20, y + 12);

  // slot
  ctx.fillStyle = COLORS.muted;
  ctx.font = `400 9px ${FONTS.mono}`;
  ctx.fillText(`slot ${row.slot}`, r.ledgerLeft + 68, y + 12);

  // signature
  ctx.fillStyle = "#9945FF";
  ctx.textAlign = "right";
  ctx.font = `500 9px ${FONTS.mono}`;
  ctx.fillText(row.signatureShort, r.ledgerRight - 6, y + 12);

  // status row
  ctx.fillStyle = finalized ? "#5DCAA5" : "#FAC775";
  ctx.font = `500 8px ${FONTS.mono}`;
  ctx.textAlign = "left";
  ctx.fillText(
    finalized ? "FINALIZED  ·  TWAP[BPC-157] committed" : "submitted  ·  awaiting finalization",
    r.ledgerLeft + 20,
    y + 22,
  );

  ctx.restore();
}

function clamp01(t) {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return t;
}

// ----------------------------------------------------------------------------
// SCREEN-space chrome
// ----------------------------------------------------------------------------

function drawHeaderStrip(ctx, beat, t, view) {
  const h = headerRect();
  ctx.save();

  // Opaque background so zoomed-in world content (which can extend up into the
  // y<headerBottom region under high-zoom framings) doesn't bleed through.
  ctx.fillStyle = COLORS.background;
  ctx.fillRect(0, 0, LAYOUT.width, h.bottom + 1);

  // brand mark, top-left
  ctx.fillStyle = COLORS.finalized;
  ctx.font = `500 10px ${FONTS.mono}`;
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.fillText("biohash-oracle-lab", h.left, h.top + 4);

  // mode tag, top-right
  ctx.fillStyle = COLORS.muted;
  ctx.textAlign = "right";
  ctx.fillText("mode: pricing-reality", h.right, h.top + 4);

  // cinematic title, centred
  ctx.fillStyle = COLORS.foreground;
  ctx.font = `500 17px ${FONTS.mono}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.fillText(beat.headerText ?? "", LAYOUT.width / 2, h.top + 22);

  // subtitle (constant, gentle)
  ctx.fillStyle = COLORS.dim;
  ctx.font = `400 10px ${FONTS.mono}`;
  ctx.fillText(
    "vendor disagreement on identical compounds  ·  resolved by on-chain TWAP",
    LAYOUT.width / 2,
    h.top + 46,
  );

  // hairline divider
  ctx.strokeStyle = COLORS.hairline;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(h.left, h.bottom);
  ctx.lineTo(h.right, h.bottom);
  ctx.stroke();

  ctx.restore();
}

function drawFooterStrip(ctx, beat, view, playerState) {
  const f = footerRect();
  const cy = f.top + f.height / 2;
  ctx.save();

  // Opaque background so zoomed-in world content underneath the footer band
  // doesn't bleed through.
  ctx.fillStyle = COLORS.background;
  ctx.fillRect(0, f.top - 1, LAYOUT.width, LAYOUT.height - f.top + 1);

  ctx.strokeStyle = COLORS.hairline;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(f.left, f.top);
  ctx.lineTo(f.right, f.top);
  ctx.stroke();

  // Status strip (bottom-left). Replaces the default mode's timer.
  ctx.fillStyle = COLORS.foreground;
  ctx.font = `500 11px ${FONTS.mono}`;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  const statusText = beat.statusText ?? "";
  ctx.fillText(statusText, f.left, cy);

  if (playerState?.paused) {
    const w = ctx.measureText(statusText).width;
    ctx.fillStyle = COLORS.anomalyWarn;
    ctx.font = `500 8px ${FONTS.mono}`;
    ctx.fillText("PAUSED", f.left + w + 10, cy);
  }

  // Citation strip (bottom-right).
  ctx.fillStyle = COLORS.muted;
  ctx.font = `400 9px ${FONTS.mono}`;
  ctx.textAlign = "right";
  ctx.fillText(
    `biohash.network  ·  cycle #${HEADLINE.cycle}  ·  slot ${HEADLINE.slot}  ·  ${view.meta.cluster}`,
    f.right,
    cy,
  );

  ctx.restore();
}

function drawScreenAnnotations(ctx, ctxBag, beat, t) {
  const ov = beat.overlay ?? {};

  // Floating top-right card with the system-wide insights.
  if (ov.floatingTopRight) {
    const a = fadeIn(t, ov.floatingTopRight.fadeInRange ?? [beat.range[0], beat.range[0] + 1.4]);
    if (a > 0.01) {
      drawFloatingTopRight(ctx, ov.floatingTopRight.lines, a);
    }
  }

  // Title card centred ("BioHash. The first on-chain reference price...")
  if (ov.titleCard) {
    const a = fadeIn(t, ov.titleCard.fadeInRange);
    if (a > 0.01) {
      drawTitleCard(ctx, ov.titleCard.line1, ov.titleCard.line2, a);
    }
  }
}

function drawFloatingTopRight(ctx, lines, alpha) {
  const h = headerRect();
  const x = h.right - 12;
  const y = h.bottom + 16;
  const lineH = 16;
  const pad = 8;
  const width = 246;
  const height = lineH * lines.length + pad * 2 + 4;

  ctx.save();
  ctx.globalAlpha = alpha;

  // background plate
  ctx.fillStyle = "rgba(15, 17, 21, 0.92)";
  ctx.fillRect(x - width, y, width, height);
  ctx.strokeStyle = "rgba(232, 230, 222, 0.18)";
  ctx.lineWidth = 1;
  ctx.strokeRect(x - width, y, width, height);

  // accent corner
  ctx.fillStyle = "#5DCAA5";
  ctx.fillRect(x - width, y, 2, height);

  // header
  ctx.fillStyle = COLORS.dim;
  ctx.font = `500 8px ${FONTS.mono}`;
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.fillText("// pricing-reality.observe", x - width + pad, y + pad);

  // lines
  ctx.font = `500 10px ${FONTS.mono}`;
  ctx.textBaseline = "top";
  for (let i = 0; i < lines.length; i++) {
    const ly = y + pad + 12 + i * lineH;
    ctx.fillStyle = i === 0 ? "#FAC775" : COLORS.foreground;
    ctx.fillText(lines[i], x - width + pad, ly);
  }

  ctx.restore();
}

function drawTitleCard(ctx, line1, line2, alpha) {
  // Final-frame title overlay. Sits in the left half of the canvas where the
  // cycle-stream panel is mostly empty in this mode, so the priced 32-peptide
  // grid on the right remains the visible proof behind the conclusion.
  ctx.save();
  ctx.globalAlpha = alpha;
  // centre over the left panel area (x=24..628), vertical mid of stage
  const cx = 326;
  const cy = 380;
  const w = 568;
  const h = 96;

  ctx.fillStyle = "rgba(15, 17, 21, 0.94)";
  ctx.fillRect(cx - w / 2, cy - h / 2, w, h);
  ctx.strokeStyle = "rgba(93, 202, 165, 0.55)";
  ctx.lineWidth = 1;
  ctx.strokeRect(cx - w / 2, cy - h / 2, w, h);

  // accent bars on left and right
  ctx.fillStyle = "#5DCAA5";
  ctx.fillRect(cx - w / 2, cy - h / 2, 3, h);
  ctx.fillRect(cx + w / 2 - 3, cy - h / 2, 3, h);

  // small kicker
  ctx.fillStyle = COLORS.dim;
  ctx.font = `500 9px ${FONTS.mono}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  ctx.fillText("// the conclusion", cx, cy - 26);

  ctx.fillStyle = "#E8E6DE";
  ctx.font = `700 26px ${FONTS.mono}`;
  ctx.fillText(line1, cx, cy + 2);

  ctx.fillStyle = COLORS.muted;
  ctx.font = `400 11px ${FONTS.mono}`;
  ctx.fillText(line2, cx, cy + 26);

  ctx.restore();
}
