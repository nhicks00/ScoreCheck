# Community scorekeeper design QA

## Evidence

- Source visual truth: `docs/design/community-overlay-qa/25-corner-controls-reference.jpg`
- Final reference-sized implementation screenshot: `docs/design/community-overlay-qa/26-reference-sized-corners-1280x592.png`
- Final same-viewport comparison: `docs/design/community-overlay-qa/27-corner-controls-reference-comparison.png`
- Final focused-controls comparison: `docs/design/community-overlay-qa/28-corner-controls-focused-comparison.png`
- Final responsive evidence: `docs/design/community-overlay-qa/29-reference-corners-844x390.png`, `30-reference-corners-568x320.png`, `31-reference-corners-bottom-568x320.png`, and `32-reference-corners-320x480.png`
- Player-clearance implementation: `docs/design/community-overlay-qa/33-player-clearance-1280x592.png`, `34-player-clearance-844x390.png`, `35-player-clearance-568x320.png`, and `36-player-clearance-bottom-844x390.png`
- Player-clearance comparisons: `docs/design/community-overlay-qa/40-player-clearance-comparison.png` and `41-player-clearance-focused-comparison.png`
- Real `StreamPlayer` evidence: `docs/design/community-overlay-qa/37-real-player-clearance-844x390.png`, `38-real-player-clearance-568x320.png`, `39-real-player-portrait-320x480.png`, `42-real-player-clearance-1280x592.png`, `43-real-player-recovery-bottom-568x320.png`, `44-real-player-recovery-top-568x320.png`, and `45-real-player-bottom-844x390.png`
- Required responsive states: `docs/design/community-overlay-qa/10-focus-narrow-video-rail-320x480.png`, `11-focus-landscape-top-568x320.png`, `12-focus-landscape-bottom-568x320.png`, `13-focus-tablet-768x1024.png`, `14-focus-desktop-top-1440x900.png`, `15-windowed-desktop-1440x900.png`, and `16-windowed-phone-390x844.png`
- Route under test: a temporary local fixture around the shipping `CommunityWatchAndScore` component. The fixture route was removed after QA.
- Primary state: Court 4 / Match 12, Set 2, Basey / Hurst 18, Caldwell / Labouliere 16, Rally 38 awaiting resolution.

## Final comparison findings

- Typography: prominent tabular scores, real team names, explicit Add point and Remove point labels, and compact utility labels preserve the selected direction's hierarchy. Landscape reduces the center copy to a single `Set 2` selector; its accessible name remains `Official current set`. Utility labels remain visible on desktop and become visually hidden at 1100 px and below, while their complete accessible names remain available.
- Spacing and layout: at 1280 x 592, each corner dock is 217.6 x 188.9 px, nearly matching the reference's approximately 208–222 x 195–200 px footprint. Add point is 195.6 x 48 px and Remove point is 195.6 x 44 px. The center surface is only 116 x 52 px, about 69 percent less area than the reference's 244 x 80 px information card. The scorekeeper utility rail now uses the open right edge instead of the media-control zone. In landscape focus, the real player rail is bounded to the left half, does not wrap, and truncates expanded status copy with an ellipsis before it can displace its three transport buttons.
- Colors: the blue/red action identity, dark translucent surfaces, white totals, and high-contrast correction outlines match the source direction and existing ScoreCheck palette.
- Image quality: the source frame uses `object-fit: contain`, so neither left nor right court edges are cropped. Black gutters are intentional whenever device and source aspect ratios differ.
- Copy: all score inputs describe the resulting action. There is no Unsure, No point, or latency identifier. The latest contribution receipt is factual and collective rather than competitive.
- The reference's visible `Current set`, court/match detail, and latency bubble are intentionally omitted from landscape focus. The set remains visible and configurable; portrait retains the richer set context below the video because it does not obstruct the match.
- The player controls visible in screenshot `26` were baked into the QA court image rather than rendered by `StreamPlayer`. The product change still reserves that center transport zone, and separate real-player captures verify the shipping DOM in live-position, error-status, receipt, and recovery states.
- The live match image itself is dynamic and is not a fidelity target; containment, placement, contrast, control hierarchy, and responsive geometry are the fidelity surfaces.

No P0, P1, or P2 visual mismatch remains.

## Responsive measurements

- 1280 x 592 desktop landscape: each team dock is 217.6 x 188.9 px; Add point is 48 px high, Remove point is 44 px high, and the selectable center set surface is 116 x 52 px. The document is exactly viewport-sized with no overflow.
- 320 x 480 narrow portrait: video is exactly 320 x 180 with the whole frame visible, all four scoring actions are 44 px high, the receipt ends at 472.7 px, and the document remains exactly 320 x 480 without horizontal or vertical overflow.
- 390 x 844 phone portrait: video is 390 x 219.375 with the scorer below it; Add point is 52 px high and Remove point is 44 px high, reducing the two-action block by roughly 24 px. The landscape-only position control is hidden because top/bottom corners have no meaning in this presentation.
- 568 x 320 phone landscape: team docks are 168 x 89.9 px. Add point and Remove point share a row at 74.5 x 44 px with a 5 px gap. With teams at the top, the real player rail is x=9–276 and the utility cluster is x=410–560. With teams at the bottom, the top-left player rail contracts to x=9–220, leaving the set selector at x=242–326 and the utility cluster at x=410–560. No pair intersects and the document remains exactly viewport-sized.
- 844 x 390 wide-phone landscape: team docks are approximately 143.5 x 139.8 px with stacked 44 px actions. The bottom-left player rail is x=84.3–362.6 and the right utility cluster is x=627.9–836. In the alternate position, the top-left player rail ends at x=358.0 before the set selector begins at x=379.8.
- 1280 x 592 real-player error state: the player rail is x=122.8–528.2 while the scorekeeper utility cluster is x=933.4–1272. The player buttons and desktop utility labels remain fully visible.
- 768 x 1024 tablet portrait: video is 768 x 432 above the full-width scorer without horizontal overflow.
- 1440 x 900 desktop focus: video is 1440 x 810, centered vertically with the entire 16:9 frame visible. Windowed desktop uses the video/scorer split; windowed phone stacks them.

## Interaction and accessibility verification

- Selecting Set 3 changed the compact selector to `Set 3`; selecting Set 2 restored it. In the shipping flow this command is revisioned and restricted to the active designated primary scorer or an admin; remote designation also requires the qualified owned court feed.
- Switch sides exchanged the complete visual team panels while preserving canonical A/B action identity. Adding a point after the switch changed only the selected real team from 18 to 19.
- Moving controls relocated both team docks together. The top preference persisted through reload at 1440 x 900.
- Real `StreamPlayer` geometry was checked at 1280 x 592, 844 x 390, 568 x 320, and 320 x 480 in both landscape control positions. The player rail intersected neither the utility bar nor receipt. At 568 x 320 the representative recovery alert also cleared the player rail and both team docks; its 44 px Retry saved contribution action remained available.
- Escape closed focus mode and restored keyboard focus to Full screen scoring. The focus query includes enabled selects and filters out controls that have no rendered client rectangles.
- Native buttons, a named set selector, headings, score outputs, status/live regions, safe-area padding, reduced-motion handling, and at least 44 px compact scoring targets are present.
- Final in-app browser warning/error log after responsive and selector testing: empty. Only React development and hot-refresh informational messages were present; no fixture code ships.

## Comparison history

1. Initial evidence: `01-landscape-top-844x390.png`, `02-landscape-top-comparison.png`, and `03-landscape-top-controls-comparison.png`. P1: the position toggle appeared in portrait despite having no effect. P1: the player rail could obstruct a narrow portrait match or collide with landscape utilities. P2: compact Add point targets were 42 px and 844 px utility labels were unnecessarily hidden.
2. First correction: `04-landscape-top-after-844x390.png`, `05-landscape-top-after-comparison.png`, and `06-landscape-top-after-controls-comparison.png`. Add point became 48 px and Remove point 44 px in short landscape; labels stayed visible above 640 px; the no-op portrait toggle was removed.
3. Responsive adversarial pass: `07-focus-portrait-390x844.png` through `16-windowed-phone-390x844.png`. The player rail became orientation- and team-position-aware, the 320 px scroll path was verified, and top/bottom persistence plus desktop/windowed composition were exercised.
4. Final same-state comparison: `17-final-landscape-top-844x390.png`, `18-final-landscape-comparison.png`, and `19-final-controls-comparison.png`. No P0, P1, or P2 issue remained.
5. Compact controls pass: `20-compact-landscape-top-568x320.png` through `24-compact-landscape-bottom-568x320.png`. Windowed action stacks became 52/44 px, landscape actions moved into one 44 px row, and 320 px portrait docks became about 97 px tall without horizontal overflow or sub-44 px targets. Saving-state labels were shortened to Adding… and Removing… so they remain legible inside the compact controls.
6. Reference-geometry pass: `25-corner-controls-reference.jpg` through `32-reference-corners-320x480.png`. Taller landscape team docks now match the supplied corner-control footprint, while the center landscape card became a 116 x 52 px set-only selector. Short landscape adapts to smaller docks, and 568 x 320 uses side-by-side 44 px actions to prevent the controls from consuming excessive video height.
7. Player-clearance pass: `33-player-clearance-1280x592.png` through `45-real-player-bottom-844x390.png`. The initial comparison identified a P1 collision between the centered transport panel shown in the accepted frame and the bottom-center scorekeeper utility rail. The utility cluster moved to the right edge, short landscape labels collapsed, and the 568 px receipt/recovery width became a fixed 150 px. Real-player QA then found an error-status rail could grow into the set selector, so landscape player controls were bounded to a left lane, set to no-wrap, and status copy became ellipsized. Final DOM geometry found no player/utility, player/set, recovery/player, or recovery/team-dock intersection.

final result: passed
