import React from "react";
import {
  Img,
  interpolate,
  spring,
  staticFile,
  useVideoConfig,
} from "remotion";

import { CornerBrackets } from "../CornerBrackets";
import { SectionShell } from "../SectionShell";
import { fonts } from "../fonts";
import { colors, sectionFrames, SPRING } from "../theme";

// Real-UI screenshots loaded from biohash-promo/public/screens/.
// staticFile() resolves these to URLs Remotion serves at render time.
// IF YOU UPDATE PATHS HERE: make sure the PNGs exist at the same
// filenames under public/screens/ — both `npm run dev` and
// `npx remotion render` 404 silently into broken-image rendering
// otherwise.
const SCREENSHOTS: Array<{ src: string; caption: string }> = [
  { src: "screens/bbpc157-hero.png", caption: "biohash.network/bbpc157" },
  { src: "screens/market-vendors.png", caption: "biohash.network/market" },
  { src: "screens/phantom-token.png", caption: "$bBPC157 in Phantom wallet" },
  { src: "screens/solscan-tx.png", caption: "First mint confirmed on Solana" },
];

const STATS: Array<{ label: string; detail?: string }> = [
  { label: "ORACLE LIVE", detail: "7+ DAYS UPTIME" },
  { label: "~600 COMMITS", detail: "PER DAY" },
  { label: "$1,000 USDC", detail: "IN RESERVE" },
  { label: "FIRST MINT", detail: "SETTLED" },
  { label: "TOKEN METADATA", detail: "ON-CHAIN" },
];

// ─── Phase 1: screenshot reveal ─────────────────────────────────────
// Each screenshot has a 35-frame total window:
//   FADE in (5) + HOLD full (25) + FADE out (5)
// Adjacent screenshots overlap by SCREENSHOT_FADE frames so the
// trailing fade of one IS the leading fade of the next — clean
// crossfade with no blank beat between.
const SCREENSHOT_BASE = 30;
const SCREENSHOT_INTERVAL = 30;
const SCREENSHOT_FADE = 5;
const SCREENSHOT_HOLD = 25;
// Last screenshot ends at: 30 + 3*30 + 5 + 25 + 5 = 155.

// ─── Phase 2: stat list ─────────────────────────────────────────────
// Starts after a brief gap so the last screenshot is fully gone
// before the first stat slides in.
const STATS_BASE = 175;
const STAT_INTERVAL = 22;
// Last stat enters at 175 + 4*22 = 263; spring settles ~24 frames
// later at ~287. Section ends at localFrame 320 (33 frame buffer).

// Internal frame timeline (local; 0–320 covers 10.7s):
//   0–30   : "WHERE WE ARE" title springs in (persists)
//   30–155 : screenshot phase — 4 reveals, crossfading
//   155–175: phase handoff (last screenshot fades out, brief beat)
//   175–290: 5 ✓ stats animate in left-to-right
//   290–320: hold

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
              § FIG. 05 · STATUS
            </div>

            {/* Title — persists across both phases */}
            <div
              style={{
                fontFamily: fonts.display,
                fontSize: 80,
                fontWeight: 700,
                letterSpacing: -1,
                color: colors.ink,
                marginTop: 24,
                marginBottom: 32,
                opacity: titleProgress,
                transform: `translateY(${interpolate(titleProgress, [0, 1], [16, 0])}px)`,
              }}
            >
              WHERE WE <span style={{ color: colors.blue }}>ARE</span>
            </div>

            {/* Phase swap area: both phases are absolute-positioned
                inside this flex-1 region. Per-screenshot opacity (in
                ScreenshotsPhase) and per-stat spring entrance (in
                StatsPhase) gate visibility — no z-index conflict
                because the phases don't temporally overlap. */}
            <div style={{ position: "relative", flex: 1, width: "100%" }}>
              <ScreenshotsPhase
                localFrame={localFrame}
                fps={fps}
                fontFamily={fontFamily}
              />
              <StatsPhase localFrame={localFrame} fps={fps} />
            </div>
          </div>
        );
      }}
    </SectionShell>
  );
};

// ─── ScreenshotsPhase ──────────────────────────────────────────────

const ScreenshotsPhase: React.FC<{
  localFrame: number;
  fps: number;
  fontFamily: string;
}> = ({ localFrame, fps, fontFamily }) => {
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {SCREENSHOTS.map((shot, i) => {
        const screenStart = SCREENSHOT_BASE + i * SCREENSHOT_INTERVAL;
        const screenLocal = localFrame - screenStart;

        // 4-stop opacity: in over [0, FADE], hold over [FADE,
        // FADE+HOLD], out over [FADE+HOLD, FADE+HOLD+FADE].
        // Strictly monotonic — no Remotion guard issues.
        const opacity = interpolate(
          screenLocal,
          [
            0,
            SCREENSHOT_FADE,
            SCREENSHOT_FADE + SCREENSHOT_HOLD,
            SCREENSHOT_FADE + SCREENSHOT_HOLD + SCREENSHOT_FADE,
          ],
          [0, 1, 1, 0],
          { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
        );

        // Subtle scale-in — 1.05 → 1.0 over the spring's natural
        // settle. Tied to the same screenLocal so it peaks just as
        // the opacity reaches 1.
        const scaleProgress = spring({
          frame: screenLocal,
          fps,
          config: SPRING,
          durationInFrames: 30,
        });
        const scale = interpolate(scaleProgress, [0, 1], [1.05, 1.0]);

        // Skip rendering entirely outside the visible window — keeps
        // the DOM lean and avoids unnecessary <Img> work for frames
        // where this screenshot is invisible.
        if (
          screenLocal < -2 ||
          screenLocal > SCREENSHOT_FADE + SCREENSHOT_HOLD + SCREENSHOT_FADE + 2
        ) {
          return null;
        }

        return (
          <div
            key={shot.src}
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              opacity,
              transform: `scale(${scale})`,
            }}
          >
            {/* Image frame — thin ink border, no shadow/glow,
                matches the technical-drawing aesthetic. */}
            <div
              style={{
                width: 1280,
                height: 580,
                border: `1px solid ${colors.ink}`,
                backgroundColor: "white",
                position: "relative",
                overflow: "hidden",
              }}
            >
              <CornerBrackets size={12} thickness={2} inset={-1} />
              <Img
                src={staticFile(shot.src)}
                style={{
                  width: "100%",
                  height: "100%",
                  objectFit: "contain",
                  display: "block",
                }}
              />
            </div>

            {/* Caption: monospace, blue accent, small */}
            <div
              style={{
                marginTop: 18,
                fontSize: 18,
                letterSpacing: 2,
                color: colors.blue,
                fontWeight: 500,
                fontFamily: fonts.mono,
              }}
            >
              {shot.caption}
            </div>
          </div>
        );
      })}
    </div>
  );
};

// ─── StatsPhase ────────────────────────────────────────────────────

const StatsPhase: React.FC<{ localFrame: number; fps: number }> = ({
  localFrame,
  fps,
}) => {
  // Brief fade-in for the whole phase so the transition from the
  // last screenshot to the first stat is smooth rather than abrupt.
  // Stats themselves still spring in individually.
  const phaseFadeIn = interpolate(
    localFrame,
    [STATS_BASE - 8, STATS_BASE + 8],
    [0, 1],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
  );

  // Skip entirely when the phase isn't visible.
  if (localFrame < STATS_BASE - 12) return null;

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        opacity: phaseFadeIn,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 18,
          width: 900,
        }}
      >
        {STATS.map((stat, i) => {
          const statStart = STATS_BASE + i * STAT_INTERVAL;
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
                  fontFamily: fonts.display,
                  fontSize: 36,
                  fontWeight: 700,
                  color: colors.ink,
                  letterSpacing: 0,
                }}
              >
                {stat.label}
              </div>
              {stat.detail && (
                <div
                  style={{
                    fontFamily: fonts.display,
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
};
