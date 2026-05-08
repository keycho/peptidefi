import React from "react";
import { Composition } from "remotion";
import { BioHashExplainer } from "./BioHashExplainer";

// 92.7 seconds at 30 fps = 2780 frames. (Originally 2700 / 90s; the
// Status section was extended by 80 frames to fit the screenshot-
// reveal sub-phase before the stat list — see theme.ts.)
// 1920x1080 — standard 16:9. Matches biohash.network's hero
// aspect ratio for embedding without letterboxing.

export const RemotionRoot: React.FC = () => {
  return (
    <Composition
      id="BioHashExplainer"
      component={BioHashExplainer}
      durationInFrames={2780}
      fps={30}
      width={1920}
      height={1080}
    />
  );
};
