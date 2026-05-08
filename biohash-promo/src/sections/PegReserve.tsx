import React from "react";
import { interpolate, spring, useVideoConfig } from "remotion";

import { CornerBrackets } from "../CornerBrackets";
import { SectionShell } from "../SectionShell";
import { colors, sectionFrames, SPRING } from "../theme";

// Internal frame timeline (local; 0–780 covers 26s):
//   0–30   : "THE PEG" title springs in
//   30–60  : "$bBPC157 — first peg-backed peptide token" subtitle
//   60–240 : Stage 1 — MINT FLOW
//   240–300: stage-1 caption fade-in + brief hold
//   300–330: pause
//   330–510: Stage 2 — BURN FLOW (reverse)
//   510–570: stage-2 caption + hold
//   570–600: pause
//   600–720: Stage 3 — Reserve dynamics + multi-line caption
//   720–780: bottom three-line tagline

type Stage = "mint" | "burn" | "reserve";

export const PegReserve: React.FC<{ fontFamily: string }> = ({
  fontFamily,
}) => {
  const { fps } = useVideoConfig();
  const { start, end } = sectionFrames.pegReserve;

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
        const taglineOpacity = interpolate(localFrame, [720, 760], [0, 1], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
        });

        // Stage selection: only one of mint/burn/reserve renders at a time
        // (with crossfade overlap). Each stage has its own frame window.
        const stageOpacities = {
          mint: interpolate(
            localFrame,
            [60, 90, 280, 310],
            [0, 1, 1, 0],
            { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
          ),
          burn: interpolate(
            localFrame,
            [310, 340, 550, 580],
            [0, 1, 1, 0],
            { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
          ),
          reserve: interpolate(
            localFrame,
            // Reserve is the last stage — fade in and stay. With
            // extrapolateRight: "clamp" the value plateaus at 1 for
            // every frame past 610, so no trailing stop is needed.
            // (Earlier the inputs were [580, 610, 800, 800] which
            // tripped Remotion's strict-monotonic guard.)
            [580, 610],
            [0, 1],
            { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
          ),
        };

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
              }}
            >
              § FIG. 03 · THE PEG
            </div>

            <div
              style={{
                fontSize: 88,
                fontWeight: 700,
                letterSpacing: -3,
                color: colors.ink,
                marginTop: 40,
                opacity: titleProgress,
                transform: `translateY(${interpolate(titleProgress, [0, 1], [20, 0])}px)`,
              }}
            >
              THE <span style={{ color: colors.blue }}>PEG</span>
            </div>
            <div
              style={{
                fontSize: 22,
                letterSpacing: 2,
                color: colors.muted,
                marginTop: 12,
                marginBottom: 32,
                opacity: subtitleOpacity,
                fontWeight: 500,
              }}
            >
              <span style={{ color: colors.blue }}>$bBPC157</span> — first peg-backed peptide token
            </div>

            {/* Stage stack (absolute-positioned, each stage controls its own opacity) */}
            <div style={{ position: "relative", flex: 1, width: "100%" }}>
              <Stage1Mint
                localFrame={localFrame}
                opacity={stageOpacities.mint}
                fps={fps}
              />
              <Stage2Burn
                localFrame={localFrame}
                opacity={stageOpacities.burn}
                fps={fps}
              />
              <Stage3Reserve
                localFrame={localFrame}
                opacity={stageOpacities.reserve}
                fps={fps}
              />
            </div>

            {/* Bottom tagline — flex-flow with width:100% sits below
                the flex:1 stage stack at its natural height. No absolute
                positioning, so it can never overlap the stage content. */}
            <div
              style={{
                width: "100%",
                opacity: taglineOpacity,
                textAlign: "center",
                fontSize: 18,
                letterSpacing: 4,
                color: colors.ink,
                fontWeight: 500,
                paddingTop: 24,
                borderTop: `1px solid ${colors.ink}`,
              }}
            >
              DETERMINISTIC ENTRY/EXIT · NO OFF-CHAIN SETTLEMENT · NO SYNTHETIC RISK
            </div>
          </div>
        );
      }}
    </SectionShell>
  );
};

// ─── helpers ─────────────────────────────────────────────────────

const NodeBox: React.FC<{
  title: string;
  sub?: string;
  highlight?: boolean;
  width?: number;
}> = ({ title, sub, highlight, width = 220 }) => (
  <div
    style={{
      width,
      border: `1px solid ${highlight ? colors.blue : colors.ink}`,
      backgroundColor: highlight ? "rgba(59,130,246,0.08)" : "rgba(255,255,255,0.5)",
      padding: "16px 20px",
      textAlign: "center",
      position: "relative",
    }}
  >
    <CornerBrackets
      size={10}
      thickness={2}
      inset={-1}
      color={highlight ? colors.blue : colors.ink}
    />
    <div
      style={{
        fontSize: 22,
        fontWeight: 700,
        letterSpacing: -0.5,
        color: highlight ? colors.blue : colors.ink,
      }}
    >
      {title}
    </div>
    {sub && (
      <div
        style={{
          fontSize: 13,
          color: colors.muted,
          marginTop: 4,
          letterSpacing: 1,
        }}
      >
        {sub}
      </div>
    )}
  </div>
);

const FlowArrow: React.FC<{
  label: string;
  reverse?: boolean;
  progress: number; // 0..1
  width?: number;
}> = ({ label, reverse, progress, width = 180 }) => {
  // Animated stroke: line draws in from one end. progress 0 → 1.
  const drawn = interpolate(progress, [0, 1], [0, width]);
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        margin: "0 8px",
        opacity: progress,
      }}
    >
      <div
        style={{
          fontSize: 13,
          letterSpacing: 3,
          color: colors.muted,
          fontWeight: 500,
          marginBottom: 6,
        }}
      >
        {label}
      </div>
      <div
        style={{
          width,
          height: 2,
          position: "relative",
          backgroundColor: colors.border,
        }}
      >
        <div
          style={{
            position: "absolute",
            top: 0,
            left: reverse ? "auto" : 0,
            right: reverse ? 0 : "auto",
            height: 2,
            width: drawn,
            backgroundColor: colors.ink,
          }}
        />
        {/* Arrow head */}
        <div
          style={{
            position: "absolute",
            top: -5,
            right: reverse ? "auto" : -1,
            left: reverse ? -1 : "auto",
            width: 0,
            height: 0,
            borderTop: "6px solid transparent",
            borderBottom: "6px solid transparent",
            borderLeft: reverse ? `none` : `8px solid ${colors.ink}`,
            borderRight: reverse ? `8px solid ${colors.ink}` : `none`,
            opacity: progress > 0.95 ? 1 : 0,
          }}
        />
      </div>
    </div>
  );
};

const Stage1Mint: React.FC<{
  localFrame: number;
  opacity: number;
  fps: number;
}> = ({ localFrame, opacity, fps }) => {
  const flowProgress = interpolate(localFrame, [60, 200], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const captionOpacity = interpolate(localFrame, [220, 270], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        opacity,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 32,
      }}
    >
      <div
        style={{
          fontSize: 16,
          letterSpacing: 4,
          fontWeight: 500,
          color: colors.muted,
        }}
      >
        STAGE 1 / MINT
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
        }}
      >
        <NodeBox title="USER" sub="connects wallet" />
        <FlowArrow
          label="USDC"
          progress={interpolate(flowProgress, [0, 0.5], [0, 1], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          })}
        />
        <NodeBox title="RESERVE VAULT" sub="program-owned PDA" highlight />
        <FlowArrow
          label="at TWAP"
          progress={interpolate(flowProgress, [0.5, 1], [0, 1], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          })}
        />
        <NodeBox title="$bBPC157" sub="freshly minted" />
      </div>
      <div
        style={{
          fontSize: 24,
          textAlign: "center",
          color: colors.ink,
          opacity: captionOpacity,
          letterSpacing: 0.5,
        }}
      >
        USDC enters.{" "}
        <span style={{ color: colors.blue, fontWeight: 500 }}>
          Token issues at oracle TWAP.
        </span>
      </div>
    </div>
  );
};

const Stage2Burn: React.FC<{
  localFrame: number;
  opacity: number;
  fps: number;
}> = ({ localFrame, opacity, fps }) => {
  const flowProgress = interpolate(localFrame, [330, 470], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const captionOpacity = interpolate(localFrame, [490, 540], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        opacity,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 32,
      }}
    >
      <div
        style={{
          fontSize: 16,
          letterSpacing: 4,
          fontWeight: 500,
          color: colors.muted,
        }}
      >
        STAGE 2 / BURN
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
        }}
      >
        <NodeBox title="USER" sub="receives USDC" />
        <FlowArrow
          label="USDC"
          reverse
          progress={interpolate(flowProgress, [0.5, 1], [0, 1], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          })}
        />
        <NodeBox title="RESERVE VAULT" sub="program-owned PDA" highlight />
        <FlowArrow
          label="at TWAP"
          reverse
          progress={interpolate(flowProgress, [0, 0.5], [0, 1], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          })}
        />
        <NodeBox title="$bBPC157" sub="burned" />
      </div>
      <div
        style={{
          fontSize: 24,
          textAlign: "center",
          color: colors.ink,
          opacity: captionOpacity,
          letterSpacing: 0.5,
        }}
      >
        Token burned.{" "}
        <span style={{ color: colors.blue, fontWeight: 500 }}>
          USDC exits at current TWAP.
        </span>
      </div>
    </div>
  );
};

const Stage3Reserve: React.FC<{
  localFrame: number;
  opacity: number;
  fps: number;
}> = ({ localFrame, opacity, fps }) => {
  // Reserve "fill" animates between drain (mint) and refill (rewards).
  // Subtle oscillation so the bar feels alive without being noisy.
  const fillFrames = localFrame - 600;
  const fillBase = 0.55;
  const fillSwing = Math.sin(fillFrames / 30) * 0.15;
  const fillPct = Math.max(
    0.2,
    Math.min(0.85, fillBase + fillSwing),
  );
  const captionOpacity = interpolate(localFrame, [630, 690], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        opacity,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 32,
      }}
    >
      <div
        style={{
          fontSize: 16,
          letterSpacing: 4,
          fontWeight: 500,
          color: colors.muted,
        }}
      >
        STAGE 3 / RESERVE DYNAMICS
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "flex-end",
          gap: 64,
        }}
      >
        {/* Reserve "tank" */}
        <div
          style={{
            position: "relative",
            width: 240,
            height: 320,
            border: `2px solid ${colors.ink}`,
            backgroundColor: "rgba(255,255,255,0.4)",
          }}
        >
          <div
            style={{
              position: "absolute",
              left: 0,
              right: 0,
              bottom: 0,
              height: `${fillPct * 100}%`,
              backgroundColor: `${colors.blue}`,
              opacity: 0.4,
              transition: "height 0.3s",
            }}
          />
          <div
            style={{
              position: "absolute",
              top: 16,
              left: 0,
              right: 0,
              textAlign: "center",
              fontSize: 13,
              letterSpacing: 4,
              color: colors.ink,
              fontWeight: 500,
            }}
          >
            RESERVE
          </div>
          <div
            style={{
              position: "absolute",
              bottom: 16,
              left: 0,
              right: 0,
              textAlign: "center",
              fontSize: 22,
              fontWeight: 700,
              color: colors.ink,
            }}
          >
            $1,000 USDC
          </div>
          <CornerBrackets size={12} thickness={2} inset={-2} />
        </div>

        {/* Inflow / outflow callouts */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 16,
            fontSize: 18,
            color: colors.ink,
          }}
        >
          <div>
            <span style={{ color: colors.success, fontWeight: 700 }}>+ MINT</span>{" "}
            adds USDC at TWAP
          </div>
          <div>
            <span style={{ color: colors.muted, fontWeight: 700 }}>– BURN</span>{" "}
            removes USDC at TWAP
          </div>
          <div>
            <span style={{ color: colors.blue, fontWeight: 700 }}>+ FEES</span>{" "}
            $BIOHASH creator rewards (today) →
            <br />
            mint/burn fees (V0.2)
          </div>
        </div>
      </div>

      <div
        style={{
          fontSize: 22,
          textAlign: "center",
          color: colors.ink,
          opacity: captionOpacity,
          maxWidth: 1200,
          lineHeight: 1.5,
        }}
      >
        Reserve <span style={{ fontWeight: 500 }}>grows</span> on mint.{" "}
        <span style={{ fontWeight: 500 }}>Drains</span> on burn. Drift is
        absorbed by the project's creator-rewards stream;{" "}
        <span style={{ color: colors.blue, fontWeight: 500 }}>
          V0.2 fees deepen reserve organically.
        </span>
      </div>
    </div>
  );
};
