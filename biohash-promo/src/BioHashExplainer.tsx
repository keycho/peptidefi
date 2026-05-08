import React from "react";
import { AbsoluteFill } from "remotion";
import { loadFont } from "@remotion/google-fonts/JetBrainsMono";

import { colors } from "./theme";
import { Positioning } from "./sections/Positioning";
import { Oracle } from "./sections/Oracle";
import { PegReserve } from "./sections/PegReserve";
import { ComposableLayer } from "./sections/ComposableLayer";
import { Status } from "./sections/Status";
import { Cta } from "./sections/Cta";

// Load JetBrains Mono once at module level. loadFont() returns a
// fontFamily string that's safe to use across the composition; the
// font is bundled into the Remotion render and works under
// `npx remotion render` without external network access at render
// time.
const { fontFamily } = loadFont("normal", {
  weights: ["400", "500", "700"],
});

export const BioHashExplainer: React.FC = () => {
  // Background fill is a single AbsoluteFill at the root so adjacent
  // sections crossfading on top of each other always have the cream
  // colour underneath them. Section components themselves also paint
  // the background — stacked layers, but cheap to render.
  return (
    <AbsoluteFill style={{ backgroundColor: colors.background }}>
      <BlueprintGrid />
      <Positioning fontFamily={fontFamily} />
      <Oracle fontFamily={fontFamily} />
      <PegReserve fontFamily={fontFamily} />
      <ComposableLayer fontFamily={fontFamily} />
      <Status fontFamily={fontFamily} />
      <Cta fontFamily={fontFamily} />
    </AbsoluteFill>
  );
};

// Subtle dot grid on the background — gives the technical-drawing
// feel without competing with the foreground content. Pure CSS, no
// per-frame work.
const BlueprintGrid: React.FC = () => (
  <AbsoluteFill
    style={{
      backgroundImage: `radial-gradient(circle, ${colors.grid} 1px, transparent 1px)`,
      backgroundSize: "32px 32px",
      backgroundPosition: "0 0",
      opacity: 0.6,
    }}
  />
);
