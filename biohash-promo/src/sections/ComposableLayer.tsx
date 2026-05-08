import React from "react";
import { interpolate, spring, useVideoConfig } from "remotion";

import { CornerBrackets } from "../CornerBrackets";
import { SectionShell } from "../SectionShell";
import { colors, sectionFrames, SPRING } from "../theme";

// Six-layer stack — each builds on the layers below it. The visual
// metaphor is a foundation rising up. Layer 1 is the BioHash oracle
// (already shipped); 2 is $bBPC157 (today); 3-6 are downstream
// primitives that need the price feed to exist.

const LAYERS: Array<{
  label: string;
  detail: string;
  status: "live" | "shipping" | "next";
}> = [
  { label: "PRICE FEED", detail: "BioHash oracle", status: "live" },
  {
    label: "PEG-BACKED TOKENS",
    detail: "$bBPC157 today, more soon",
    status: "shipping",
  },
  {
    label: "DEX TRADING",
    detail: "arbitrage tightens spreads",
    status: "next",
  },
  {
    label: "LENDING MARKETS",
    detail: "peptides as collateral",
    status: "next",
  },
  {
    label: "SYNTHETIC BASKETS",
    detail: "peptide indices",
    status: "next",
  },
  {
    label: "SUBSCRIPTION PRODUCTS",
    detail: "TWAP-priced auto-buy",
    status: "next",
  },
];

const LAYER_INTERVAL = 50; // frames between each layer's entrance

// Internal frame timeline (local; 0–600 covers 20s):
//   0–30   : "WHY THIS MATTERS" title springs in
//   30–90  : intro line fades in
//   90+    : layers stack in bottom-up, every LAYER_INTERVAL frames
//   <last> : caption fades in after the last layer settles

export const ComposableLayer: React.FC<{ fontFamily: string }> = ({
  fontFamily,
}) => {
  const { fps } = useVideoConfig();
  const { start, end } = sectionFrames.composableLayer;

  return (
    <SectionShell startFrame={start} endFrame={end} fontFamily={fontFamily}>
      {(localFrame) => {
        const titleProgress = spring({
          frame: localFrame,
          fps,
          config: SPRING,
          durationInFrames: 30,
        });
        const introOpacity = interpolate(localFrame, [30, 90], [0, 1], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
        });
        const lastLayerStart = 90 + (LAYERS.length - 1) * LAYER_INTERVAL;
        const captionOpacity = interpolate(
          localFrame,
          [lastLayerStart + 60, lastLayerStart + 120],
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
              § FIG. 04 · COMPOSABILITY
            </div>

            <div
              style={{
                fontSize: 80,
                fontWeight: 700,
                letterSpacing: -3,
                color: colors.ink,
                marginTop: 24,
                opacity: titleProgress,
                transform: `translateY(${interpolate(titleProgress, [0, 1], [16, 0])}px)`,
              }}
            >
              WHY THIS <span style={{ color: colors.blue }}>MATTERS</span>
            </div>

            <div
              style={{
                fontSize: 24,
                color: colors.ink,
                marginTop: 20,
                marginBottom: 32,
                opacity: introOpacity,
                textAlign: "center",
                maxWidth: 1100,
                lineHeight: 1.5,
              }}
            >
              With a verifiable peptide TWAP on-chain,{" "}
              <span style={{ color: colors.blue, fontWeight: 500 }}>
                new primitives become possible
              </span>
              :
            </div>

            {/* Layer stack — built bottom-up */}
            <div
              style={{
                display: "flex",
                flexDirection: "column-reverse",
                gap: 12,
                width: 1100,
              }}
            >
              {LAYERS.map((layer, i) => {
                const layerStart = 90 + i * LAYER_INTERVAL;
                const enter = spring({
                  frame: localFrame - layerStart,
                  fps,
                  config: SPRING,
                  durationInFrames: 26,
                });
                const isLive = layer.status === "live";
                const isShipping = layer.status === "shipping";
                return (
                  <div
                    key={layer.label}
                    style={{
                      position: "relative",
                      border: `1px solid ${colors.ink}`,
                      backgroundColor: isLive
                        ? "rgba(59,130,246,0.10)"
                        : isShipping
                          ? "rgba(255,255,255,0.6)"
                          : "rgba(255,255,255,0.35)",
                      padding: "18px 28px",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      opacity: enter,
                      transform: `translateY(${interpolate(enter, [0, 1], [24, 0])}px) scaleX(${interpolate(enter, [0, 1], [0.96, 1])})`,
                      transformOrigin: "center center",
                    }}
                  >
                    <CornerBrackets
                      size={10}
                      thickness={2}
                      inset={-1}
                      color={
                        isLive
                          ? colors.blue
                          : isShipping
                            ? colors.ink
                            : colors.muted
                      }
                    />
                    <div
                      style={{
                        display: "flex",
                        gap: 24,
                        alignItems: "baseline",
                      }}
                    >
                      <div
                        style={{
                          fontSize: 15,
                          letterSpacing: 4,
                          color: colors.muted,
                          fontWeight: 500,
                          minWidth: 36,
                        }}
                      >
                        L{LAYERS.length - i}
                      </div>
                      <div
                        style={{
                          fontSize: 28,
                          fontWeight: 700,
                          letterSpacing: -0.5,
                          color: colors.ink,
                        }}
                      >
                        {layer.label}
                      </div>
                      <div
                        style={{
                          fontSize: 18,
                          color: colors.muted,
                        }}
                      >
                        — {layer.detail}
                      </div>
                    </div>
                    <StatusBadge status={layer.status} />
                  </div>
                );
              })}
            </div>

            {/* Caption — flex-flow with marginTop:auto parks it at
                the bottom of the available space, so it can never
                overlap the layer stack regardless of how many layers
                render or whether the stack height changes. */}
            <div
              style={{
                marginTop: "auto",
                paddingTop: 24,
                width: "100%",
                textAlign: "center",
                fontSize: 20,
                color: colors.ink,
                opacity: captionOpacity,
                lineHeight: 1.5,
              }}
            >
              Each primitive needs the layer below.{" "}
              <span style={{ color: colors.blue, fontWeight: 500 }}>
                The price feed comes first. Everything else builds on it.
              </span>
            </div>
          </div>
        );
      }}
    </SectionShell>
  );
};

const StatusBadge: React.FC<{ status: "live" | "shipping" | "next" }> = ({
  status,
}) => {
  const styles =
    status === "live"
      ? {
          color: colors.blue,
          border: colors.blue,
          label: "LIVE",
        }
      : status === "shipping"
        ? {
            color: colors.ink,
            border: colors.ink,
            label: "SHIPPING",
          }
        : {
            color: colors.muted,
            border: colors.border,
            label: "NEXT",
          };
  return (
    <div
      style={{
        fontSize: 12,
        letterSpacing: 3,
        fontWeight: 700,
        color: styles.color,
        border: `1px solid ${styles.border}`,
        padding: "4px 10px",
      }}
    >
      {styles.label}
    </div>
  );
};
