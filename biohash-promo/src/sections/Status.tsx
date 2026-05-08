import React from "react";
import { interpolate, spring, useVideoConfig } from "remotion";

import { CornerBrackets } from "../CornerBrackets";
import { SectionShell } from "../SectionShell";
import { colors, sectionFrames, SPRING } from "../theme";

const STATS: Array<{ label: string; detail?: string }> = [
  { label: "ORACLE LIVE", detail: "7+ DAYS UPTIME" },
  { label: "~600 COMMITS", detail: "PER DAY" },
  { label: "$1,000 USDC", detail: "IN RESERVE" },
  { label: "FIRST MINT", detail: "SETTLED" },
  { label: "TOKEN METADATA", detail: "ON-CHAIN" },
];

// Internal frame timeline (local; 0–240 covers 8s):
//   0–30   : "WHERE WE ARE" title springs in
//   30+    : 5 checkmarks animate in sequentially every ~36 frames

const STAT_INTERVAL = 36;

export const Status: React.FC<{ fontFamily: string }> = ({ fontFamily }) => {
  const { fps } = useVideoConfig();
  const { start, end } = sectionFrames.status;

  return (
    <SectionShell startFrame={start} endFrame={end} fontFamily={fontFamily}>
      {(localFrame) => {
        const titleProgress = spring({
          frame: localFrame,
          fps,
          config: SPRING,
          durationInFrames: 30,
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
              justifyContent: "center",
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
              § FIG. 05 · STATUS
            </div>

            <div
              style={{
                fontSize: 88,
                fontWeight: 700,
                letterSpacing: -3,
                color: colors.ink,
                marginBottom: 56,
                opacity: titleProgress,
                transform: `translateY(${interpolate(titleProgress, [0, 1], [16, 0])}px)`,
              }}
            >
              WHERE WE <span style={{ color: colors.blue }}>ARE</span>
            </div>

            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 18,
                width: 900,
              }}
            >
              {STATS.map((stat, i) => {
                const statStart = 30 + i * STAT_INTERVAL;
                const enter = spring({
                  frame: localFrame - statStart,
                  fps,
                  config: SPRING,
                  durationInFrames: 24,
                });
                return (
                  <div
                    key={stat.label}
                    style={{
                      display: "flex",
                      alignItems: "baseline",
                      gap: 24,
                      borderBottom: `1px solid ${colors.border}`,
                      paddingBottom: 16,
                      opacity: enter,
                      transform: `translateX(${interpolate(enter, [0, 1], [-24, 0])}px)`,
                    }}
                  >
                    <div
                      style={{
                        fontSize: 36,
                        color: colors.blue,
                        fontWeight: 700,
                        width: 40,
                        flexShrink: 0,
                      }}
                    >
                      ✓
                    </div>
                    <div
                      style={{
                        fontSize: 32,
                        fontWeight: 700,
                        color: colors.ink,
                        letterSpacing: -0.5,
                      }}
                    >
                      {stat.label}
                    </div>
                    {stat.detail && (
                      <div
                        style={{
                          fontSize: 22,
                          color: colors.muted,
                          letterSpacing: 2,
                          fontWeight: 500,
                          marginLeft: "auto",
                        }}
                      >
                        — {stat.detail}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        );
      }}
    </SectionShell>
  );
};
