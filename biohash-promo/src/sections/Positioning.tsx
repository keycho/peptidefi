import React from "react";
import { interpolate, spring, useVideoConfig } from "remotion";

import { CornerBrackets } from "../CornerBrackets";
import { SectionShell } from "../SectionShell";
import { colors, sectionFrames, SPRING } from "../theme";

const PEPTIDES = [
  "BPC-157",
  "TB-500",
  "GHK-Cu",
  "Semaglutide",
  "NAD+",
  "GHRP-6",
  "Tirzepatide",
];

// Internal frame timeline (offsets are local to this section, in frames):
//   0–30   : "BIOHASH" wordmark springs in
//   30–60  : subtitle fades in
//   60–90  : idle
//   90–150 : two-line positioning quote fades in
//   180–270: peptide list animates in left-to-right
//   270–330: bottom stat strip fades in
//   330–360: hold

export const Positioning: React.FC<{ fontFamily: string }> = ({
  fontFamily,
}) => {
  const { fps } = useVideoConfig();
  const { start, end } = sectionFrames.positioning;
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
        const quoteOpacity = interpolate(localFrame, [90, 150], [0, 1], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
        });
        const statStripOpacity = interpolate(
          localFrame,
          [270, 330],
          [0, 1],
          { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
        );

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

            {/* Top section label */}
            <div
              style={{
                position: "absolute",
                top: 60,
                left: 80,
                fontSize: 14,
                letterSpacing: 4,
                color: colors.muted,
                fontWeight: 500,
              }}
            >
              § FIG. 01 · POSITIONING
            </div>

            {/* Hero wordmark */}
            <div
              style={{
                fontSize: 200,
                fontWeight: 700,
                letterSpacing: -8,
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
                fontSize: 24,
                letterSpacing: 6,
                color: colors.muted,
                marginTop: 32,
                opacity: subtitleOpacity,
                fontWeight: 500,
              }}
            >
              REAL-WORLD ASSET ORACLE FOR PEPTIDES
            </div>

            {/* Two-line positioning quote */}
            <div
              style={{
                fontSize: 36,
                lineHeight: 1.5,
                color: colors.ink,
                marginTop: 96,
                textAlign: "center",
                fontWeight: 400,
                opacity: quoteOpacity,
              }}
            >
              Most oracles price crypto.
              <br />
              <span style={{ color: colors.blue, fontWeight: 500 }}>
                We price something with no on-chain reference.
              </span>
            </div>

            {/* Peptide list — each name fades + slides in sequentially */}
            <div
              style={{
                marginTop: 64,
                fontSize: 28,
                letterSpacing: 1,
                color: colors.ink,
                fontWeight: 500,
                display: "flex",
                gap: 16,
                flexWrap: "wrap",
                justifyContent: "center",
              }}
            >
              {PEPTIDES.map((peptide, i) => {
                const peptideStart = 180 + i * 12;
                const peptideOpacity = interpolate(
                  localFrame,
                  [peptideStart, peptideStart + 18],
                  [0, 1],
                  {
                    extrapolateLeft: "clamp",
                    extrapolateRight: "clamp",
                  },
                );
                const peptideShift = interpolate(
                  localFrame,
                  [peptideStart, peptideStart + 18],
                  [12, 0],
                  {
                    extrapolateLeft: "clamp",
                    extrapolateRight: "clamp",
                  },
                );
                return (
                  <React.Fragment key={peptide}>
                    {i > 0 && (
                      <span
                        style={{
                          color: colors.border,
                          opacity: peptideOpacity,
                        }}
                      >
                        ·
                      </span>
                    )}
                    <span
                      style={{
                        opacity: peptideOpacity,
                        transform: `translateY(${peptideShift}px)`,
                        display: "inline-block",
                      }}
                    >
                      {peptide}
                    </span>
                  </React.Fragment>
                );
              })}
              <span
                style={{
                  color: colors.muted,
                  opacity: interpolate(
                    localFrame,
                    [180 + PEPTIDES.length * 12, 180 + PEPTIDES.length * 12 + 18],
                    [0, 1],
                    {
                      extrapolateLeft: "clamp",
                      extrapolateRight: "clamp",
                    },
                  ),
                }}
              >
                + 19 more
              </span>
            </div>

            {/* Bottom stats strip */}
            <div
              style={{
                position: "absolute",
                bottom: 80,
                left: 80,
                right: 80,
                opacity: statStripOpacity,
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                paddingTop: 24,
                borderTop: `1px solid ${colors.ink}`,
              }}
            >
              <div
                style={{
                  fontSize: 18,
                  letterSpacing: 4,
                  fontWeight: 500,
                  color: colors.ink,
                }}
              >
                26 PEPTIDES · 6+ VENDOR SOURCES · ON-CHAIN HOURLY
              </div>
              <div
                style={{
                  fontSize: 12,
                  letterSpacing: 3,
                  color: colors.muted,
                }}
              >
                BIOHASH.NETWORK
              </div>
            </div>
          </div>
        );
      }}
    </SectionShell>
  );
};
