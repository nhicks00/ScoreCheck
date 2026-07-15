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
const overlay = readFileSync(
  join(process.cwd(), "src/app/score/session/CommunityScoreOverlay.tsx"),
  "utf8"
);
const overlayStylesheet = readFileSync(
  join(process.cwd(), "src/app/score/session/CommunityScoreOverlay.module.css"),
  "utf8"
);
const sessionClient = readFileSync(
  join(process.cwd(), "src/app/score/session/CommunityWitnessSessionClient.tsx"),
  "utf8"
);
const globalStylesheet = readFileSync(join(process.cwd(), "src/app/globals.css"), "utf8");
const scorerStylesheet = readFileSync(
  join(process.cwd(), "src/app/score/session/CommunityWitnessScorer.module.css"),
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

  it("stacks a full-frame video above score controls in portrait focus view", () => {
    const portraitStart = stylesheet.indexOf("@media (orientation: portrait)");
    const landscapeStart = stylesheet.indexOf("@media (orientation: landscape)", portraitStart);
    const portraitRules = stylesheet.slice(portraitStart, landscapeStart);

    expect(portraitStart).toBeGreaterThan(-1);
    expect(portraitRules).toContain("grid-template-rows: max-content max-content");
    expect(portraitRules).toContain("overflow-x: hidden");
    expect(portraitRules).toContain("overflow-y: auto");
    expect(portraitRules).toContain("overscroll-behavior-y: contain");
    expect(portraitRules).toContain("aspect-ratio: 16 / 9");
    expect(portraitRules).toContain("env(safe-area-inset-left)");
    expect(overlayStylesheet).toContain(".utilityBar .moveControlsButton");
    expect(overlayStylesheet).toContain("display: none");
  });

  it("overlays both movable team docks on a contained landscape video", () => {
    const landscapeStart = stylesheet.indexOf("@media (orientation: landscape)");
    const desktopStart = stylesheet.indexOf("@media (min-width: 900px)", landscapeStart);
    const landscapeRules = stylesheet.slice(landscapeStart, desktopStart);

    expect(landscapeRules).toContain("display: flex");
    expect(landscapeRules).toContain("width: min(100vw, calc(100dvh * 16 / 9))");
    expect(overlayStylesheet).toContain("@media (orientation: landscape)");
    expect(overlayStylesheet).toContain(".controlsTop .teamDocks");
    expect(overlayStylesheet).toContain(".controlsBottom .teamDocks");
    expect(overlayStylesheet).toContain("pointer-events: none");
    expect(overlayStylesheet).toContain("pointer-events: auto");
    expect(stylesheet).toContain(".scoreControlsTop.focusMode .videoPane :global(.scoring-video-controls)");
    expect(stylesheet).toContain("left: max(8px, env(safe-area-inset-left))");
  });

  it("preserves compact landscape touch targets and only collapses utility labels on narrow phones", () => {
    const compactStart = overlayStylesheet.indexOf(
      "@media (orientation: landscape) and (max-height: 430px)"
    );
    const narrowStart = overlayStylesheet.indexOf(
      "@media (orientation: landscape) and (max-height: 430px) and (max-width: 640px)",
      compactStart
    );
    const compactRules = overlayStylesheet.slice(compactStart, narrowStart);
    const narrowRules = overlayStylesheet.slice(narrowStart);

    expect(compactStart).toBeGreaterThan(-1);
    expect(compactRules).toContain(".addPoint");
    expect(compactRules).toContain("min-height: 48px");
    expect(compactRules).toContain(".removePoint");
    expect(compactRules).toContain("min-height: 44px");
    expect(compactRules).not.toContain(".utilityLabel");
    expect(narrowRules).toContain(".utilityLabel");
    const videoControlsStart = globalStylesheet.indexOf(
      ".scoring-stream-preview .scoring-video-controls button {"
    );
    const videoControlsEnd = globalStylesheet.indexOf("}", videoControlsStart);
    expect(globalStylesheet.slice(videoControlsStart, videoControlsEnd)).toContain("min-height: 44px");
    expect(globalStylesheet.slice(videoControlsStart, videoControlsEnd)).toContain("min-width: 44px");
    const firstUtilityStart = overlayStylesheet.indexOf(".utilityBar button,");
    const utilityStart = overlayStylesheet.indexOf(".utilityBar button,", firstUtilityStart + 1);
    const utilityEnd = overlayStylesheet.indexOf("}", utilityStart);
    expect(overlayStylesheet.slice(utilityStart, utilityEnd)).toContain("min-width: 44px");
    const recoveryStart = scorerStylesheet.indexOf(".sessionAlert button {");
    const recoveryEnd = scorerStylesheet.indexOf("}", recoveryStart);
    expect(scorerStylesheet.slice(recoveryStart, recoveryEnd)).toContain("min-height: 44px");
  });

  it("keeps the player provider-neutral and opens focus without scrolling", () => {
    expect(component).toContain("focus({ preventScroll: true })");
    expect(component).toContain("media: ReactNode | null");
    expect(component).toContain("{props.media}");
    expect(component).not.toContain("youtubeVideoId");
    expect(component).not.toContain("YouTube");
  });

  it("does not claim remote scoring remains active when required video is unavailable", () => {
    expect(component).toContain("Court video is unavailable. Remote authoritative scoring is paused.");
    expect(component).toContain("Court video is unavailable. You can still record what you see.");
    expect(component).not.toContain("Court video is not available. Scoring remains active.");
  });

  it("keeps the canonical set selector in the focus trap and ignores hidden controls", () => {
    expect(component).toContain("select:not([disabled])");
    expect(component).toContain("element.getClientRects().length > 0");
    expect(component).toContain("styles.scoreControlsTop");
    expect(component).toContain("styles.scoreControlsBottom");
  });

  it("uses explicit score actions, actual team data, a prominent canonical set, and no latency badge", () => {
    expect(overlay).toContain("sideOrder.map((side)");
    expect(overlay).toContain("view.teams[side]");
    expect(overlay).toContain("Set {view.currentSet}");
    expect(overlay).toContain("Add point");
    expect(overlay).toContain("Remove point");
    expect(overlay).toContain("onAddPoint(side)");
    expect(overlay).toContain("onRemovePoint(side)");
    expect(overlay).not.toMatch(/unsure/i);
    expect(overlay).not.toMatch(/no point/i);
    expect(overlay).not.toMatch(/low latency/i);
  });

  it("keeps visual side switching canonical and exposes recovery inside the overlay", () => {
    expect(overlay).toContain("key={side}");
    expect(overlay).toContain("aria-label=\"Switch team sides visually\"");
    expect(overlay).toContain("recovery.onAction");
    expect(overlay).toContain("role=\"alert\"");
    expect(sessionClient).toContain('"Retry saved contribution"');
    expect(sessionClient).toContain("focusRecovery={visibleError ?");
  });

  it("gates remote current-set changes on the same qualified frame as score actions", () => {
    const setActionStart = sessionClient.indexOf("async function selectCanonicalSet");
    const setActionEnd = sessionClient.indexOf("\n  function retrySavedContribution", setActionStart);
    const setAction = sessionClient.slice(setActionStart, setActionEnd);

    expect(setAction).toContain("requiresQualifiedMedia(snapshot)");
    expect(setAction).toContain("capturePlaybackEvidence({ baseRevision: snapshot.score.revision })");
    expect(setAction).toContain("!playbackEvidence?.qualification.liveActionEligible");
    expect(setAction).toContain("...(playbackEvidence ? { playbackEvidence } : {})");
    expect(sessionClient).toContain("setSelectionAuthority && !mediaEligible");
  });
});
