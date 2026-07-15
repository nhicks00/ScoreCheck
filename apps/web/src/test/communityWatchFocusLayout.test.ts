import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const stylesheet = readFileSync(
  join(process.cwd(), "src/app/score/session/CommunityWatchAndScore.module.css"),
  "utf8"
);

describe("community watch focus layout", () => {
  it("lets portrait focus mode scroll without changing the landscape side panel", () => {
    const portraitStart = stylesheet.indexOf("@media (orientation: portrait)");
    const desktopStart = stylesheet.indexOf("@media (min-width: 900px)", portraitStart);
    const portraitRules = stylesheet.slice(portraitStart, desktopStart);

    expect(portraitStart).toBeGreaterThan(-1);
    expect(desktopStart).toBeGreaterThan(portraitStart);
    expect(portraitRules).toContain(".watchShell.withVideo.focusMode");
    expect(portraitRules).toContain("overflow-x: hidden");
    expect(portraitRules).toContain("overflow-y: auto");
    expect(portraitRules).toContain("overscroll-behavior-y: contain");

    const landscapeStart = stylesheet.indexOf(
      "@media (orientation: landscape) and (max-height: 620px)"
    );
    const compactLandscapeStart = stylesheet.indexOf(
      "@media (orientation: landscape) and (max-height: 440px)",
      landscapeStart
    );
    const landscapeRules = stylesheet.slice(landscapeStart, compactLandscapeStart);

    expect(landscapeStart).toBeGreaterThan(desktopStart);
    expect(landscapeRules).toContain("grid-template-columns: minmax(200px, 1fr) minmax(200px, 38vw)");
    expect(landscapeRules).toContain(".focusPanel");
    expect(landscapeRules).toContain("overflow-y: auto");
  });
});
