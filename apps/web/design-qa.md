# Community Witness scorekeeper design QA

## Source and implementation

- Source visual truth: `docs/design/community-witness-mobile-selected.png`
- Browser-rendered score-only implementation: `docs/design/community-witness-mobile-implementation.png`
- Full source/implementation comparison: `docs/design/community-witness-mobile-comparison.png`
- Focused source/implementation comparison: `docs/design/community-witness-mobile-comparison-focus.png`
- Phone watch-and-score: `docs/design/community-witness-watch-mobile.png`
- Phone focus mode: `docs/design/community-witness-focus-mobile.png`
- Phone landscape focus mode: `docs/design/community-witness-focus-landscape.png`
- Desktop watch-and-score: `docs/design/community-witness-watch-desktop.png`
- Desktop focus mode: `docs/design/community-witness-focus-desktop.png`
- Route under test: `/score/session`, exercised through a temporary local fixture route that is removed from the shipping tree
- Primary state: active community witness, Court 4 / Match 12, Set 2, Basey / Hurst vs Caldwell / Labouliere, official score 18–16, Rally 38 awaiting resolution

The selected source and the score-only implementation were placed side by side at the same 390 x 844 viewport. The source's `Broadcast score` label was intentionally changed to `Official score`: a committed canonical snapshot can briefly lead a retrying overlay projection, so the UI must not claim the broadcast is already current.

## Final visual comparison

- Hierarchy matches the selected direction: match context, prominent Set 2 marker, official-score label and local Switch sides control, two complete team panels, rally journey, truthful receipt, and collective coverage.
- The implementation preserves the blue/red team identity, high-contrast score typography, solid primary actions, outlined correction actions, dark scorekeeper canvas, and compact mobile rhythm.
- Real team names wrap without truncation. Long names stay attached to the complete team panel when sides switch.
- The phone watch view gives the upper region to video and begins the scoring surface directly below it. Desktop uses a stable video/score split instead of duplicating or remounting the player.
- Focus mode keeps the YouTube player and score controls in non-overlapping sibling regions. Portrait uses a bottom dock, short landscape uses a side dock, and extreme zoom uses a vertically scrollable stack.
- Repository-native typography and Lucide icons are used; there are no placeholder or fabricated graphic assets.

No known P0, P1, or P2 visual mismatch remains.

## Interaction verification

- `Switch sides` moved the complete Caldwell / Labouliere panel from right to left and Basey / Hurst from left to right while preserving their scores and canonical A/B request identity.
- In focus mode, `Add one point for Basey / Hurst` changed only Basey / Hurst from 18 to 19 and advanced the receipt to Rally 39.
- Add point and Remove point remained explicit in windowed phone, tablet, desktop, portrait focus, landscape focus, and 200%-zoom fallback states.
- Exiting focus mode restored keyboard focus to `Full screen scoring`.
- The video preference survived reload, and `Score only` stopped/unmounted playback without affecting the scoring session.
- Commentary is configured with `videoMode="external"`; its existing low-latency player is the only player mounted there.
- The implementation contains no Unsure or No point action.

## Responsive and accessibility verification

- 390 x 844 phone portrait: video above score; both Add actions visible in the first score region; focus mode shows video plus both complete action cards.
- 320 x 480 narrow portrait / 200% zoom reflow: focus mode has no horizontal overflow, exposes a bounded vertical scroll path, and keeps the last 46 px Remove point control fully reachable and clickable.
- 568 x 320 phone landscape: player and two compact team action cards fit in separate side-by-side regions.
- 320 x 240 simulated 200% zoom: the YouTube player keeps its 200 px minimum, the shell switches to a vertical scroll fallback, and both 44 px Add/Remove targets remain reachable without horizontal clipping.
- 768 x 1024 tablet portrait: video above a full-width, equal-column scorer.
- 1440 x 900 desktop: video/score split and focus-mode video/action dock both render without overflow.
- The real public YouTube test embed loaded without error 153 using `strict-origin-when-cross-origin`; the checked-in video id comes from the court DTO, not this local fixture.
- The iframe remains keyboard reachable. Focus sentinels wrap navigation across the cross-origin frame, Escape/Exit closes the dialog, and dynamic siblings outside the dialog are made inert and `aria-hidden` until exit.
- Native buttons, headings, articles, status regions, list semantics, live regions, named official-score outputs, and assistive side-switch announcements are present in the browser accessibility snapshot.
- Reduced-motion CSS removes press transforms. Every primary/correction action is at least 44 px in compact modes.
- Production-build browser console warnings/errors after final reload: none.

## Policy-driven trade-off

The requested custom controls cannot be drawn over a YouTube embed: YouTube's current minimum-functionality rules prohibit visual elements in front of the player. The delivered focus mode preserves simultaneous viewing and scoring with an adjacent bottom or side action dock. A literal over-video treatment requires an owned/public-CDN player with expiring media authorization; it must not be implemented by exposing reusable MediaMTX credentials.

## Comparison history

1. The initial scorekeeper direction established explicit actions, real names, total score, Set 2, rally journey, personal receipt, and community coverage.
2. The implementation was tightened at 390 px so long names, correction labels, rally geometry, and coverage fit without horizontal overflow.
3. Watch-and-score added responsive video composition, persistent player state, container fullscreen with full-window fallback, and local-only side switching in every presentation.
4. Adversarial review removed a credential-bearing media design, fixed YouTube referrer identity, replaced a prohibited player overlay with sibling controls, added compact/zoom fallbacks, and closed focus containment/restore gaps.

final result: passed
