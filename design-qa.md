# ScoreCheck homepage sand-perspective QA

final result: passed

## Source and implementation evidence

- Source visual truth: `/Users/nathanhicks/.codex/generated_images/019f7ad7-35f3-7732-9d14-42e2543764fd/exec-93e164da-2627-4275-aa6b-bdfebc3b9c74.png`
- Browser-rendered implementation: `/Users/nathanhicks/.codex/visualizations/2026/07/19/019f7ad7-35f3-7732-9d14-42e2543764fd/homepage-perspective-qa/homepage-perspective-1487x1058.jpg`
- Full-view side-by-side comparison: `/Users/nathanhicks/.codex/visualizations/2026/07/19/019f7ad7-35f3-7732-9d14-42e2543764fd/homepage-perspective-qa/reference-vs-perspective-implementation.png`
- Focused scoreboard comparison: `/Users/nathanhicks/.codex/visualizations/2026/07/19/019f7ad7-35f3-7732-9d14-42e2543764fd/homepage-perspective-qa/scoreboard-reference-vs-implementation.png`
- Compact browser capture: `/Users/nathanhicks/.codex/visualizations/2026/07/19/019f7ad7-35f3-7732-9d14-42e2543764fd/homepage-perspective-qa/homepage-perspective-compact-844x844.jpg`
- Mobile browser capture: `/Users/nathanhicks/.codex/visualizations/2026/07/19/019f7ad7-35f3-7732-9d14-42e2543764fd/homepage-perspective-qa/homepage-perspective-mobile-390x844.jpg`
- Viewport: 1487 x 1058, device pixel ratio 1.
- State: public homepage, setup complete, default interaction state.

## Findings

- No actionable P0, P1, or P2 mismatches remain.
- Fonts and typography: the display headline, body copy, CTA, guide text, team names, scores, and court/set metadata retain the approved hierarchy. The scoreboard plane now foreshortens toward the net without sacrificing numeral or team-name legibility.
- Spacing and layout rhythm: the hero crop, end line, scoreboard anchor, and guide strip retain their approved positions. The bottom of the score plane stays fixed near the end line while its upper row recedes into the sand perspective.
- Colors and visual tokens: ink, off-white, orange, and white scoreboard treatments are unchanged. The change introduces no gradient, new panel, or artificial decoration.
- Image quality and asset fidelity: the approved full-court asset remains untouched at full resolution. The live DOM scoreboard is projected over the sand with CSS perspective rather than baking text into the raster image.
- Copy and content: all homepage wording, team names, scores, court number, and set number remain unchanged.
- Accessibility and behavior: the visual transform does not alter DOM order or the scoreboard's accessible label. Links remain keyboard-accessible.

## Comparison history

1. Pass 1 used the final tuned projection at the matched viewport. The full-view and focused side-by-side comparisons found no actionable P0, P1, or P2 differences, so no post-comparison repair iteration was required.

## Interaction and console checks

- `See live courts` was clicked and navigated to `http://localhost:3103/score`, then the browser returned to the homepage.
- `Open Admin` remains linked to `/admin/events`.
- Browser console: no errors.

## Focused comparison evidence

- The dedicated 2000 x 150 scoreboard crop compares the same sand/end-line region from both artifacts. It confirms that the projected score remains centered, legible, inside the near boundary, and visually integrated with the court plane.

## Follow-up polish

- P3 test gap: the supplied visual truth is desktop-only, so responsive captures can be checked for alignment and overflow but not source-matched composition.

## Implementation checklist

- [x] Project the entire scoreboard as one court-aligned plane.
- [x] Anchor the near score row while the court/set row recedes toward the net.
- [x] Preserve approved copy, image crop, content, and navigation.
- [x] Capture browser evidence and compare full-view and focused scoreboard regions side by side.
- [x] Check 844 x 844 and 390 x 844 responsive views for overflow and end-line alignment.
- [x] Verify the primary homepage action and browser console.
