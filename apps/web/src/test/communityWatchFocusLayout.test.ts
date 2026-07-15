import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const stylesheet = readFileSync(
  join(process.cwd(), "src/app/score/session/CommunityWatchAndScore.module.css"),
  "utf8"
);
const component = readFileSync(
  join(process.cwd(), "src/app/score/session/CommunityWatchAndScore.tsx"),
  "utf8"
);

describe("community watch focus layout", () => {
  it("keeps the video at a contained 16:9 ratio instead of deriving width from a tall mobile row", () => {
    const videoStart = stylesheet.indexOf(".videoPane {");
    const scoreStart = stylesheet.indexOf(".scorePane", videoStart);
    const videoRules = stylesheet.slice(videoStart, scoreStart);

    expect(videoStart).toBeGreaterThan(-1);
    expect(videoRules).toContain("aspect-ratio: 16 / 9");
    expect(videoRules).toContain("min-height: 0");
    expect(videoRules).toContain("width: 100%");
    expect(videoRules).not.toContain("min-height: 220px");
  });

  it("stacks a full-frame mobile video above scrollable score controls in either orientation", () => {
    const mobileStart = stylesheet.indexOf("@media (max-width: 899px)");
    const desktopStart = stylesheet.indexOf(
      "@media (min-width: 900px)",
      mobileStart
    );
    const mobileRules = stylesheet.slice(mobileStart, desktopStart);

    expect(mobileStart).toBeGreaterThan(-1);
    expect(desktopStart).toBeGreaterThan(mobileStart);
    expect(mobileRules).toContain(".withVideo .videoPane");
    expect(mobileRules).toContain("height: auto");
    expect(mobileRules).toContain("width: min(100%, calc(100svh * 16 / 9))");
    expect(mobileRules).toContain("grid-template-rows: max-content max-content");
    expect(mobileRules).toContain("overflow-x: hidden");
    expect(mobileRules).toContain("overflow-y: auto");
    expect(mobileRules).toContain("overscroll-behavior-y: contain");
    expect(mobileRules).toContain("env(safe-area-inset-left)");
    expect(mobileRules).toContain(".focusScoreCue");
    expect(mobileRules).toContain("touch-action: pan-y");
    expect(mobileRules).not.toContain("position: sticky");
  });

  it("keeps the compact side panel only for short desktop layouts", () => {
    const landscapeStart = stylesheet.indexOf(
      "@media (orientation: landscape) and (max-height: 620px) and (min-width: 900px)"
    );
    const compactLandscapeStart = stylesheet.indexOf(
      "@media (orientation: landscape) and (max-height: 440px) and (min-width: 900px)",
      landscapeStart
    );
    const landscapeRules = stylesheet.slice(landscapeStart, compactLandscapeStart);

    expect(landscapeStart).toBeGreaterThan(-1);
    expect(landscapeRules).toContain("grid-template-columns: minmax(200px, 1fr) minmax(200px, 38vw)");
    expect(landscapeRules).toContain(".focusPanel");
    expect(landscapeRules).toContain("overflow-y: auto");
  });

  it("opens landscape focus video-first without focus scrolling and offers a reliable score affordance", () => {
    expect(component).toContain("focus({ preventScroll: true })");
    expect(component).toContain("function revealScoreControls()");
    expect(component).toContain("shell.scrollTo({");
    expect(component).toContain("Score controls");
  });
});
