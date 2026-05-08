import React from "react";
import { Composition } from "remotion";
import { BioHashExplainer } from "./BioHashExplainer";

// 90 seconds at 30 fps = 2700 frames.
// 1920x1080 — standard 16:9. Matches biohash.network's hero
// aspect ratio for embedding without letterboxing.

export const RemotionRoot: React.FC = () => {
  return (
    <Composition
      id="BioHashExplainer"
      component={BioHashExplainer}
      durationInFrames={2700}
      fps={30}
      width={1920}
      height={1080}
    />
  );
};
