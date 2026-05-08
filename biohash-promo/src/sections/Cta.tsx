import React from "react";
import { interpolate, spring, useVideoConfig } from "remotion";

import { CornerBrackets } from "../CornerBrackets";
import { SectionShell } from "../SectionShell";
import { colors, sectionFrames, SPRING } from "../theme";

// Internal frame timeline (local; 0–120 covers 4s):
//   0–30  : BIOHASH wordmark springs in
//   30–60 : subtitle fades in
//   60+   : URL fades in with subtle pulse (sin wave on opacity)

export const Cta: React.FC<{ fontFamily: string }> = ({ fontFamily }) => {
  const { fps } = useVideoConfig();
  const { start, end } = sectionFrames.cta;

  return (
    <SectionShell startFrame={start} endFrame={end} fontFamily={fontFamily}>
      {(localFrame) => {
        const wordmarkProgress = spring({
          frame: localFrame,
          fps,
          config: SPRING,
          durationInFrames: 30,
        });
        const subtitleOpacity = interpolate(localFrame, [30, 60], [0, 1], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
        });
        const urlOpacityBase = interpolate(localFrame, [60, 90], [0, 1], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
        });
        // Gentle pulse: ±10% opacity oscillation. Period ~1s (30
        // frames) at 30fps. Subtle, not distracting.
        const pulse = 0.9 + 0.1 * Math.sin((localFrame - 60) / 4.8);
        const urlOpacity = urlOpacityBase * pulse;

        return (
          <div
            style={{
              width: "100%",
              height: "100%",
              padding: 80,
              position: "relative",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <CornerBrackets size={32} thickness={2} inset={40} />

            {/* Hero wordmark — same treatment as Section 1 for bookend feel */}
            <div
              style={{
                fontSize: 240,
                fontWeight: 700,
                letterSpacing: -10,
                color: colors.ink,
                lineHeight: 1,
                opacity: wordmarkProgress,
                transform: `translateY(${interpolate(wordmarkProgress, [0, 1], [40, 0])}px)`,
              }}
            >
              <span style={{ color: colors.blue }}>B</span>IO
              <span style={{ color: colors.blue }}>H</span>ASH
            </div>

            {/* Subtitle */}
            <div
              style={{
                fontSize: 28,
                letterSpacing: 4,
                color: colors.muted,
                marginTop: 32,
                opacity: subtitleOpacity,
                fontWeight: 500,
              }}
            >
              THE PRICE LAYER FOR PEPTIDES
            </div>

            {/* URL with pulse */}
            <div
              style={{
                marginTop: 64,
                fontSize: 56,
                fontWeight: 500,
                color: colors.blue,
                opacity: urlOpacity,
                letterSpacing: 1,
              }}
            >
              biohash.network
            </div>
          </div>
        );
      }}
    </SectionShell>
  );
};
