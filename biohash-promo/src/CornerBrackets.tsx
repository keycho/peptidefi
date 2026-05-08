import React from "react";
import { colors } from "./theme";

// Four L-shaped corner brackets drawn with absolutely-positioned
// divs. Used throughout to give boxes / frames the technical-drawing
// look without depending on SVG strokes.

export const CornerBrackets: React.FC<{
  size?: number;
  thickness?: number;
  color?: string;
  inset?: number;
}> = ({ size = 20, thickness = 2, color = colors.ink, inset = 0 }) => {
  const horiz = (style: React.CSSProperties): React.CSSProperties => ({
    position: "absolute",
    width: size,
    height: thickness,
    background: color,
    ...style,
  });
  const vert = (style: React.CSSProperties): React.CSSProperties => ({
    position: "absolute",
    width: thickness,
    height: size,
    background: color,
    ...style,
  });
  return (
    <>
      {/* TL */}
      <div style={horiz({ top: inset, left: inset })} />
      <div style={vert({ top: inset, left: inset })} />
      {/* TR */}
      <div style={horiz({ top: inset, right: inset })} />
      <div style={vert({ top: inset, right: inset })} />
      {/* BL */}
      <div style={horiz({ bottom: inset, left: inset })} />
      <div style={vert({ bottom: inset, left: inset })} />
      {/* BR */}
      <div style={horiz({ bottom: inset, right: inset })} />
      <div style={vert({ bottom: inset, right: inset })} />
    </>
  );
};
