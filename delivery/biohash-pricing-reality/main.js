import { loadFromFile } from "./data-loader.js";
import { renderFrame, buildPrep } from "./render-frame.js";
import { LAYOUT } from "./style.js";
import { Player, bindKeyboard, DURATION_SEC } from "./animation.js";

function setupCanvas(canvas) {
  const dpr = window.devicePixelRatio ?? 1;
  canvas.style.width = `${LAYOUT.width}px`;
  canvas.style.height = `${LAYOUT.height}px`;
  canvas.width = Math.round(LAYOUT.width * dpr);
  canvas.height = Math.round(LAYOUT.height * dpr);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("main: 2d context unavailable");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.imageSmoothingEnabled = true;
  return ctx;
}

function setStatus(text) {
  const el = document.getElementById("status");
  if (el) el.textContent = text;
}

async function main() {
  const canvas = document.getElementById("lab");
  if (!(canvas instanceof HTMLCanvasElement)) {
    throw new Error("main: #lab canvas missing");
  }
  const ctx = setupCanvas(canvas);

  setStatus("loading data...");
  let view;
  try {
    view = await loadFromFile("data/oracle-snapshot.json");
  } catch (err) {
    setStatus(`load failed: ${err.message}`);
    console.error(err);
    return;
  }

  // Mode dispatch. The default (no ?mode= or unrecognised mode) falls through
  // to the existing render-frame + Player path below, unchanged.
  const mode = new URLSearchParams(window.location.search).get("mode");
  if (mode === "pricing-reality") {
    const { runPricingRealityMode } = await import("./modes/pricing-reality.js");
    await runPricingRealityMode({ ctx, canvas, view, setStatus });
    return;
  }

  const prep = buildPrep(view);

  setStatus(
    `loaded - ${view.peptides.length} peptides - ${view.meta.totalCycles} cycles - ${view.meta.totalAnomalies} anomalies - 30s loop - [space] pause [r] restart`,
  );

  const player = new Player({
    durationSec: DURATION_SEC,
    onFrame: (elapsedSec, state) => {
      renderFrame(ctx, view, prep, elapsedSec, state);
    },
  });
  const unbind = bindKeyboard(player);
  player.start();

  window.__lab = { view, prep, player, ctx, canvas, unbind };
}

main().catch((err) => {
  setStatus(`fatal: ${err.message}`);
  console.error(err);
});
