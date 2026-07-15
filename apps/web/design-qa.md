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
- Current-run before/after responsive audit: `docs/design/community-video-audit/`
- Current-run portrait comparison: `docs/design/community-video-audit/13-phone-portrait-before-after.png`
- Current-run landscape comparison: `docs/design/community-video-audit/14-phone-landscape-before-after.png`
- Route under test: `/score/session`, exercised through a temporary local fixture route that is removed from the shipping tree
- Primary state: active community witness, Court 4 / Match 12, Set 2, Basey / Hurst vs Caldwell / Labouliere, official score 18–16, Rally 38 awaiting resolution

The selected source and the score-only implementation were placed side by side at the same 390 x 844 viewport. The source's `Broadcast score` label was intentionally changed to `Official score`: a committed canonical snapshot can briefly lead a retrying overlay projection, so the UI must not claim the broadcast is already current.

## Final visual comparison

- Hierarchy matches the selected direction: match context, prominent Set 2 marker, official-score label and local Switch sides control, two complete team panels, rally journey, truthful receipt, and collective coverage.
- The implementation preserves the blue/red team identity, high-contrast score typography, solid primary actions, outlined correction actions, dark scorekeeper canvas, and compact mobile rhythm.
- Real team names wrap without truncation. Long names stay attached to the complete team panel when sides switch.
- The phone watch view gives the upper region to an exact 16:9 video and begins the scoring surface directly below it. Desktop uses a stable video/score split instead of duplicating or remounting the player.
- Focus mode preserves the complete 16:9 source frame. Phone and tablet layouts place scoring below the video in both orientations; landscape opens video-first and exposes scoring through a thumb-scroll path plus a `Score controls` handle. Short desktop layouts alone retain a side dock.
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

- 390 x 844 phone portrait: the normal and focus players measure 390 x 219.375, exactly 16:9, with no horizontal overflow; both teams' Add/Remove controls remain visible.
- 320 x 480 narrow portrait / 200% zoom reflow: focus video measures 320 x 180, the dialog has a bounded 503 px scroll path, and the final 46 px Remove point controls remain reachable without horizontal clipping.
- 568 x 320 phone landscape: focus video measures 568 x 319.5, the largest complete 16:9 frame possible. Scoring begins directly below at y=319.5 and the visible `Score controls` handle scrolls both teams' actions into view.
- 844 x 390 wide-phone landscape: focus video measures 693.328 x 389.984 and is centered with black gutters. The score panel follows below; no source edge is cropped.
- 768 x 1024 tablet portrait: focus video measures 768 x 432 above a full-width, equal-column scorer.
- 1440 x 900 desktop: video/score split and focus-mode video/action dock render without overflow; the contained 16:9 video is centered in its available track.
- The real public YouTube test embed loaded without error 153 using `strict-origin-when-cross-origin`; the checked-in video id comes from the court DTO, not this local fixture.
- The iframe remains keyboard reachable. Focus sentinels wrap navigation across the cross-origin frame, Escape/Exit closes the dialog, and dynamic siblings outside the dialog are made inert and `aria-hidden` until exit.
- Native buttons, headings, articles, status regions, list semantics, live regions, named official-score outputs, and assistive side-switch announcements are present in the browser accessibility snapshot.
- Reduced-motion CSS removes press transforms. Every primary/correction action is at least 44 px in compact modes.
- Production-build browser console warnings/errors after final reload: none.

## Policy-driven trade-off

The current public YouTube embed is an advisory transition path, not the desired scoring transport. It can remain several seconds behind the court and a cross-origin iframe can consume touch gestures. The delivered layout therefore preserves the full frame, keeps score controls in a sibling region, and adds a small landscape navigation handle. The target scoring player is authenticated `courtN_preview` WHEP through capacity-qualified read replicas; the existing single origin Droplet and reusable MediaMTX credentials are not a safe public distribution tier. See `docs/community-low-latency-playback-plan.md`.

## Comparison history

1. The initial scorekeeper direction established explicit actions, real names, total score, Set 2, rally journey, personal receipt, and community coverage.
2. The implementation was tightened at 390 px so long names, correction labels, rally geometry, and coverage fit without horizontal overflow.
3. Watch-and-score added responsive video composition, persistent player state, container fullscreen with full-window fallback, and local-only side switching in every presentation.
4. Adversarial review removed a credential-bearing media design, fixed YouTube referrer identity, replaced a prohibited player overlay with sibling controls, added compact/zoom fallbacks, and closed focus containment/restore gaps.
5. Current-run browser audit found and fixed three deterministic geometry failures: the 42svh mobile height overrode 16:9, focus mode stretched the iframe, and phone landscape forced a narrow side split. A fourth focus-management bug was fixed by preventing the Exit control from auto-scrolling the video offscreen.

final result: responsive layout passed; owned low-latency community playback remains a separately gated hard cut
