import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { colors, FADE_FRAMES } from "./theme";

// Wraps each section so they're all stacked at the root level of the
// composition. Each section's component knows its own start/end
// frames and renders itself only when in (or fading in/out of) view.
//
// Why component-self-managed visibility instead of <Sequence>: gives
// each section a single absolute frame number to reason about, makes
// crossfades trivial (both sections' opacity overlap in the FADE
// window), and keeps section files self-contained.

export interface SectionShellProps {
  startFrame: number;
  endFrame: number;
  fontFamily: string;
  // The localFrame is `useCurrentFrame() - startFrame`. Section
  // internals key all their entrance animations off this.
  children: (localFrame: number) => React.ReactNode;
}

export const SectionShell: React.FC<SectionShellProps> = ({
  startFrame,
  endFrame,
  fontFamily,
  children,
}) => {
  const frame = useCurrentFrame();

  // Visibility window: render nothing outside the [start - fade,
  // end + fade] range. Saves render cycles on the frames where the
  // section can't possibly be visible.
  if (frame < startFrame - FADE_FRAMES || frame > endFrame + FADE_FRAMES) {
    return null;
  }

  // Crossfade: linear ramp up over the first FADE_FRAMES and ramp
  // down over the last FADE_FRAMES. Adjacent sections both render
  // during the overlap window, summing to a soft transition.
  const opacity = interpolate(
    frame,
    [
      startFrame - FADE_FRAMES,
      startFrame + FADE_FRAMES,
      endFrame - FADE_FRAMES,
      endFrame + FADE_FRAMES,
    ],
    [0, 1, 1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
  );

  const localFrame = frame - startFrame;

  return (
    <AbsoluteFill
      style={{
        opacity,
        backgroundColor: colors.background,
        color: colors.ink,
        fontFamily,
        // Prevent fontKerning / hinting drift between renders by
        // pinning a sensible default.
        fontKerning: "none",
        WebkitFontSmoothing: "antialiased",
      }}
    >
      {children(localFrame)}
    </AbsoluteFill>
  );
};
