import React from "react";
import { interpolate, spring, useVideoConfig } from "remotion";

import { CornerBrackets } from "../CornerBrackets";
import { SectionShell } from "../SectionShell";
import { fonts } from "../fonts";
import { colors, sectionFrames, SPRING } from "../theme";

// Vendor chips shown inside Box 1. Prices are illustrative — real
// values come from the live API and would update per-render. Pinning
// representative-but-static numbers keeps the explainer evergreen.
const VENDORS: Array<{ name: string; price: string }> = [
  { name: "Peptide Sciences", price: "$5.20" },
  { name: "Limitless Life", price: "$9.40" },
  { name: "Direct Peptides", price: "$6.80" },
  { name: "Pure Rawz", price: "$4.95" },
  { name: "PharmaGrade", price: "$11.20" },
  { name: "Sigma", price: "$8.10" },
];

// Internal frame timeline (local):
//   0–30   : "THE ORACLE" title springs in
//   30–60  : section subtitle
//   60–180 : Box 1 + vendor chips appear
//   180–220: arrow + "30-MIN TIME-WEIGHTED AVERAGE" label
//   220–340: Box 2 + averaging visual
//   340–380: arrow + "SIGNED + COMMITTED HOURLY" label
//   380–500: Box 3 + on-chain visual
//   500–600: bottom three-line caption

export const Oracle: React.FC<{ fontFamily: string }> = ({ fontFamily }) => {
  const { fps } = useVideoConfig();
  const { start, end } = sectionFrames.oracle;

  return (
    <SectionShell startFrame={start} endFrame={end} fontFamily={fontFamily}>
      {(localFrame) => {
        const titleProgress = spring({
          frame: localFrame,
          fps,
          config: SPRING,
          durationInFrames: 30,
        });
        const subtitleOpacity = interpolate(localFrame, [30, 60], [0, 1], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
        });
        const captionOpacity = interpolate(localFrame, [500, 560], [0, 1], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
        });

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
            }}
          >
            <CornerBrackets size={32} thickness={2} inset={40} />

            <div
              style={{
                position: "absolute",
                top: 60,
                left: 80,
                fontSize: 14,
                letterSpacing: 4,
                color: colors.muted,
                fontWeight: 500,
                fontFamily: fonts.display,
              }}
            >
              § FIG. 02 · THE ORACLE
            </div>

            {/* Title — tightened from fontSize 88 / marginTop 40
                / marginBottom 40 to free up vertical space for
                three boxes + two arrows + flex-flow caption. */}
            <div
              style={{
                fontFamily: fonts.display,
                fontSize: 80,
                fontWeight: 700,
                letterSpacing: -1,
                color: colors.ink,
                marginTop: 16,
                opacity: titleProgress,
                transform: `translateY(${interpolate(titleProgress, [0, 1], [20, 0])}px)`,
              }}
            >
              THE <span style={{ color: colors.blue }}>ORACLE</span>
            </div>
            <div
              style={{
                fontFamily: fonts.display,
                fontSize: 20,
                letterSpacing: 4,
                color: colors.muted,
                marginTop: 12,
                marginBottom: 24,
                opacity: subtitleOpacity,
                fontWeight: 500,
              }}
            >
              SCRAPE → AVERAGE → ANCHOR
            </div>

            {/* Three-stage flow column */}
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                width: 1100,
              }}
            >
              <Box
                title="MULTI-VENDOR SCRAPERS"
                subtitle="6+ vendor sites · Updated continuously"
                appearStart={60}
                appearEnd={120}
                localFrame={localFrame}
                fps={fps}
              >
                <div
                  style={{
                    display: "flex",
                    flexWrap: "wrap",
                    gap: 8,
                    marginTop: 16,
                    justifyContent: "center",
                  }}
                >
                  {VENDORS.map((v, i) => {
                    const vStart = 100 + i * 10;
                    const vOpacity = interpolate(
                      localFrame,
                      [vStart, vStart + 20],
                      [0, 1],
                      {
                        extrapolateLeft: "clamp",
                        extrapolateRight: "clamp",
                      },
                    );
                    return (
                      <div
                        key={v.name}
                        style={{
                          opacity: vOpacity,
                          padding: "6px 12px",
                          border: `1px solid ${colors.border}`,
                          backgroundColor: "rgba(255,255,255,0.6)",
                          fontSize: 14,
                          fontWeight: 500,
                          color: colors.ink,
                        }}
                      >
                        {v.name}{" "}
                        <span
                          style={{
                            fontFamily: fonts.mono,
                            color: colors.blue,
                            marginLeft: 6,
                          }}
                        >
                          {v.price}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </Box>

              <Arrow
                label="30-MIN TIME-WEIGHTED AVERAGE"
                appearStart={180}
                appearEnd={220}
                localFrame={localFrame}
              />

              <Box
                title="TWAP COMPUTATION"
                subtitle="Outliers diluted · Manipulation resistant"
                appearStart={220}
                appearEnd={280}
                localFrame={localFrame}
                fps={fps}
              >
                <AveragingVisual localFrame={localFrame} startFrame={260} />
              </Box>

              <Arrow
                label="SIGNED + COMMITTED HOURLY"
                appearStart={340}
                appearEnd={380}
                localFrame={localFrame}
              />

              <Box
                title="SOLANA MAINNET"
                subtitle="Permanent · Verifiable · Free to read"
                appearStart={380}
                appearEnd={440}
                localFrame={localFrame}
                fps={fps}
              >
                <div
                  style={{
                    marginTop: 12,
                    fontSize: 14,
                    fontFamily: fonts.mono,
                    color: colors.muted,
                    letterSpacing: 1,
                  }}
                >
                  tx: 5J3K…aBcD · slot 347823901 · finalized
                </div>
              </Box>
            </div>

            {/* Caption — flex-flow with marginTop:auto so it parks
                at the bottom of the available space, NEVER overlaps
                the third flow box no matter how tall the box content
                renders. (Was previously absolute-positioned at
                bottom:70, which collided when vendor chips wrapped.) */}
            <div
              style={{
                marginTop: "auto",
                width: "100%",
                opacity: captionOpacity,
                textAlign: "center",
                fontSize: 22,
                fontWeight: 400,
                color: colors.ink,
                letterSpacing: 1,
              }}
            >
              This is the price layer.{" "}
              <span style={{ fontWeight: 500, color: colors.blue }}>
                Independent. On-chain. Composable.
              </span>
            </div>
          </div>
        );
      }}
    </SectionShell>
  );
};

// ─── helpers ─────────────────────────────────────────────────────

const Box: React.FC<{
  title: string;
  subtitle: string;
  appearStart: number;
  appearEnd: number;
  localFrame: number;
  fps: number;
  children?: React.ReactNode;
}> = ({ title, subtitle, appearStart, appearEnd, localFrame, fps, children }) => {
  const enter = spring({
    frame: localFrame - appearStart,
    fps,
    config: SPRING,
    durationInFrames: appearEnd - appearStart,
  });
  return (
    <div
      style={{
        width: "100%",
        border: `1px solid ${colors.ink}`,
        backgroundColor: "rgba(255,255,255,0.4)",
        // Tightened from "20px 32px" to free up vertical space.
        padding: "14px 28px",
        position: "relative",
        opacity: enter,
        transform: `translateY(${interpolate(enter, [0, 1], [16, 0])}px)`,
      }}
    >
      <CornerBrackets size={12} thickness={2} inset={-1} />
      <div
        style={{
          fontFamily: fonts.display,
          fontSize: 32,
          fontWeight: 700,
          letterSpacing: 0,
          color: colors.ink,
        }}
      >
        {title}
      </div>
      <div
        style={{
          fontSize: 16,
          color: colors.muted,
          marginTop: 4,
          letterSpacing: 0,
        }}
      >
        {subtitle}
      </div>
      {children}
    </div>
  );
};

const Arrow: React.FC<{
  label: string;
  appearStart: number;
  appearEnd: number;
  localFrame: number;
}> = ({ label, appearStart, appearEnd, localFrame }) => {
  const opacity = interpolate(localFrame, [appearStart, appearEnd], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const lineHeight = interpolate(
    localFrame,
    [appearStart, appearEnd],
    [0, 32],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
  );
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        margin: "8px 0",
        opacity,
      }}
    >
      <div
        style={{
          width: 1,
          height: lineHeight,
          backgroundColor: colors.ink,
        }}
      />
      <div
        style={{
          fontFamily: fonts.display,
          fontSize: 14,
          letterSpacing: 3,
          color: colors.muted,
          fontWeight: 500,
          marginTop: 4,
          marginBottom: 4,
        }}
      >
        ↓ {label}
      </div>
      <div
        style={{
          width: 1,
          height: lineHeight,
          backgroundColor: colors.ink,
        }}
      />
    </div>
  );
};

// Tiny visual for Box 2: 6 dots condense into a single horizontal bar
// (the "average"). Frames keyed off TWAP-computation entrance time.
const AveragingVisual: React.FC<{ localFrame: number; startFrame: number }> = ({
  localFrame,
  startFrame,
}) => {
  const progress = interpolate(
    localFrame,
    [startFrame, startFrame + 60],
    [0, 1],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
  );
  // 6 dots: spread across [-150, 150] at progress=0, all at 0 at progress=1.
  const positions = [-150, -90, -40, 30, 80, 140];
  return (
    <div
      style={{
        position: "relative",
        height: 32,
        marginTop: 12,
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
      }}
    >
      {/* Average line: fades in as dots collapse */}
      <div
        style={{
          position: "absolute",
          top: 15,
          left: "calc(50% - 60px)",
          width: 120,
          height: 2,
          backgroundColor: colors.blue,
          opacity: progress,
        }}
      />
      {positions.map((x, i) => (
        <div
          key={i}
          style={{
            position: "absolute",
            top: 12,
            left: `calc(50% + ${interpolate(progress, [0, 1], [x, 0])}px - 4px)`,
            width: 8,
            height: 8,
            borderRadius: 0,
            backgroundColor: colors.ink,
            opacity: interpolate(progress, [0, 0.7, 1], [1, 1, 0.4]),
          }}
        />
      ))}
    </div>
  );
};
