import React from "react";
import { AbsoluteFill } from "remotion";

import { colors } from "./theme";
import { fonts } from "./fonts";
import { Positioning } from "./sections/Positioning";
import { Oracle } from "./sections/Oracle";
import { PegReserve } from "./sections/PegReserve";
import { ComposableLayer } from "./sections/ComposableLayer";
import { Status } from "./sections/Status";
import { Cta } from "./sections/Cta";

// `fontFamily` prop is the default for each section — Inter (body).
// Sections override per-element to Barlow Condensed for headings /
// all-caps labels and JetBrains Mono for technical data (numbers,
// addresses, codes, URLs). See ./fonts.ts.

export const BioHashExplainer: React.FC = () => {
  // Background fill is a single AbsoluteFill at the root so adjacent
  // sections crossfading on top of each other always have the cream
  // colour underneath them. Section components themselves also paint
  // the background — stacked layers, but cheap to render.
  return (
    <AbsoluteFill style={{ backgroundColor: colors.background }}>
      <BlueprintGrid />
      <Positioning fontFamily={fonts.body} />
      <Oracle fontFamily={fonts.body} />
      <PegReserve fontFamily={fonts.body} />
      <ComposableLayer fontFamily={fonts.body} />
      <Status fontFamily={fonts.body} />
      <Cta fontFamily={fonts.body} />
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
