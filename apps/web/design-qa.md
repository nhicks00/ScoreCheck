# Community scorekeeper design QA

## Evidence

- Source visual truth: `docs/design/community-overlay-selected-top.png`
- Final implementation screenshot: `docs/design/community-overlay-qa/17-final-landscape-top-844x390.png`
- Full source/implementation comparison: `docs/design/community-overlay-qa/18-final-landscape-comparison.png`
- Focused controls comparison: `docs/design/community-overlay-qa/19-final-controls-comparison.png`
- Required responsive states: `docs/design/community-overlay-qa/10-focus-narrow-video-rail-320x480.png`, `11-focus-landscape-top-568x320.png`, `12-focus-landscape-bottom-568x320.png`, `13-focus-tablet-768x1024.png`, `14-focus-desktop-top-1440x900.png`, `15-windowed-desktop-1440x900.png`, and `16-windowed-phone-390x844.png`
- Route under test: a temporary local fixture around the shipping `CommunityWatchAndScore` component. The fixture route was removed after QA.
- Primary state: Court 4 / Match 12, Set 2, Basey / Hurst 18, Caldwell / Labouliere 16, Rally 38 awaiting resolution.

## Final comparison findings

- Typography: prominent tabular scores, the current set, real team names, explicit Add point and Remove point labels, and compact utility labels preserve the selected direction's hierarchy. Long names wrap without separating identity from the score controls.
- Spacing and layout: the complete 16:9 match image remains contained at every checked size. Portrait uses video above scoring; landscape focus places paired team docks over opposite video corners; desktop windowed mode uses a stable video/scorer split.
- Colors: the blue/red action identity, dark translucent surfaces, white totals, and high-contrast correction outlines match the source direction and existing ScoreCheck palette.
- Image quality: the source frame uses `object-fit: contain`, so neither left nor right court edges are cropped. Black gutters are intentional whenever device and source aspect ratios differ.
- Copy: all score inputs describe the resulting action. There is no Unsure, No point, or latency identifier. The latest contribution receipt is factual and collective rather than competitive.
- The selected source's `Live · low latency` bubble was intentionally omitted at the user's direction. Latency remains an operational qualification signal, not information a scorekeeper must interpret.
- The live match image itself is dynamic and is not a fidelity target; containment, placement, contrast, control hierarchy, and responsive geometry are the fidelity surfaces.

No P0, P1, or P2 visual mismatch remains.

## Responsive measurements

- 320 x 480 narrow portrait: video is 320 x 180, horizontal overflow is hidden, both teams' score actions appear in the initial viewport, and remaining utilities are reachable in the bounded vertical scroll. The player rail sits 9 px from the video bottom instead of covering the court center.
- 390 x 844 phone portrait: video is 390 x 219.375 with the scorer below it; Add point is 56 px high and Remove point is 46 px high. The landscape-only position control is hidden because top/bottom corners have no meaning in this presentation.
- 568 x 320 phone landscape: video is 568 x 319.5. With team docks at the top, player controls move to bottom-left; with docks at the bottom, player controls move to top-left. The utility cluster remains centered on the opposite edge without overlap.
- 844 x 390 wide-phone landscape: video is 693.328 x 389.984, centered with black gutters. Add point is 48 px, Remove point is 44 px, and full utility labels remain visible.
- 768 x 1024 tablet portrait: video is 768 x 432 above the full-width scorer without horizontal overflow.
- 1440 x 900 desktop focus: video is 1440 x 810, centered vertically with the entire 16:9 frame visible. Windowed desktop uses the video/scorer split; windowed phone stacks them.

## Interaction and accessibility verification

- Selecting Set 3 changed the fixture's canonical set while retaining court, match, teams, and scores. In the shipping flow this command is revisioned and restricted to the active designated primary scorer or an admin; remote designation also requires the qualified owned court feed.
- Switch sides exchanged the complete visual team panels while preserving canonical A/B action identity. Adding a point after the switch changed only the selected real team from 18 to 19.
- Moving controls relocated both team docks together. The top preference persisted through reload at 1440 x 900.
- Escape closed focus mode and restored keyboard focus to Full screen scoring. The focus query includes enabled selects and filters out controls that have no rendered client rectangles.
- Native buttons, a named set selector, headings, score outputs, status/live regions, safe-area padding, reduced-motion handling, and at least 44 px compact scoring targets are present.
- Final in-app browser warning/error log after responsive and Escape testing: empty. The local Next development server emitted only its known cross-origin development warning because the temporary fixture was opened through `127.0.0.1`; no fixture code ships.

## Comparison history

1. Initial evidence: `01-landscape-top-844x390.png`, `02-landscape-top-comparison.png`, and `03-landscape-top-controls-comparison.png`. P1: the position toggle appeared in portrait despite having no effect. P1: the player rail could obstruct a narrow portrait match or collide with landscape utilities. P2: compact Add point targets were 42 px and 844 px utility labels were unnecessarily hidden.
2. First correction: `04-landscape-top-after-844x390.png`, `05-landscape-top-after-comparison.png`, and `06-landscape-top-after-controls-comparison.png`. Add point became 48 px and Remove point 44 px in short landscape; labels stayed visible above 640 px; the no-op portrait toggle was removed.
3. Responsive adversarial pass: `07-focus-portrait-390x844.png` through `16-windowed-phone-390x844.png`. The player rail became orientation- and team-position-aware, the 320 px scroll path was verified, and top/bottom persistence plus desktop/windowed composition were exercised.
4. Final same-state comparison: `17-final-landscape-top-844x390.png`, `18-final-landscape-comparison.png`, and `19-final-controls-comparison.png`. No P0, P1, or P2 issue remained.

final result: passed
