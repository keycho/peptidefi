// Camera transform for the cinematic narrative mode.
// A "camera" is the world point at the centre of the screen plus a scale factor.
//   cam = { cx, cy, scale }
// We apply it to the 2D context with translate + scale BEFORE drawing world content
// (panels, brackets, vendor labels). UI overlays (header, footer, floating
// annotations) are drawn AFTER restoring the transform, so they stay in screen
// space and do not zoom.

import { LAYOUT, headerRect, footerRect } from "../style.js";

export const SCREEN_CENTER_X = LAYOUT.width / 2;

// Stage = the vertical span between the header strip and the footer strip.
// The camera centres world content on the vertical midpoint of that span,
// so a wide-shot framing visually rests in the panels rather than the chrome.
export function stageCenterY() {
  const h = headerRect();
  const f = footerRect();
  return (h.bottom + f.top) / 2;
}

// Apply (translate, scale) such that world point (cam.cx, cam.cy) lands at
// (SCREEN_CENTER_X, stageCenterY()).
export function applyCamera(ctx, cam) {
  const tx = SCREEN_CENTER_X - cam.cx * cam.scale;
  const ty = stageCenterY() - cam.cy * cam.scale;
  ctx.translate(tx, ty);
  ctx.scale(cam.scale, cam.scale);
}

// Standard ease curves. The Material "standard" easing — cubic-bezier(0.4, 0, 0.2, 1) —
// is implemented with a Newton-Raphson solve over the parametric Bezier.
function cubicBezier(x1, y1, x2, y2) {
  const sampleX = (t) =>
    3 * (1 - t) * (1 - t) * t * x1 +
    3 * (1 - t) * t * t * x2 +
    t * t * t;
  const sampleY = (t) =>
    3 * (1 - t) * (1 - t) * t * y1 +
    3 * (1 - t) * t * t * y2 +
    t * t * t;
  const dSampleX = (t) =>
    3 * (1 - t) * (1 - t) * x1 +
    6 * (1 - t) * t * (x2 - x1) +
    3 * t * t * (1 - x2);
  return (x) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 8; i++) {
      const curX = sampleX(t) - x;
      if (Math.abs(curX) < 1e-5) break;
      const slope = dSampleX(t);
      if (Math.abs(slope) < 1e-6) break;
      t -= curX / slope;
      if (t < 0) t = 0;
      else if (t > 1) t = 1;
    }
    return sampleY(t);
  };
}

const STANDARD = cubicBezier(0.4, 0, 0.2, 1);
const EASE_OUT = cubicBezier(0, 0, 0.2, 1);
const EASE_IN = cubicBezier(0.4, 0, 1, 1);

export const EASES = {
  linear: (t) => t,
  standard: STANDARD,
  easeInOut: STANDARD,
  easeOut: EASE_OUT,
  easeIn: EASE_IN,
};

export function clamp01(t) {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return t;
}

export function lerp(a, b, t) {
  return a + (b - a) * t;
}

// Linearly interpolate two camera states with a named ease.
export function interpCamera(a, b, u, easeName = "standard") {
  const ease = EASES[easeName] ?? STANDARD;
  const e = ease(clamp01(u));
  return {
    cx: lerp(a.cx, b.cx, e),
    cy: lerp(a.cy, b.cy, e),
    scale: lerp(a.scale, b.scale, e),
  };
}
