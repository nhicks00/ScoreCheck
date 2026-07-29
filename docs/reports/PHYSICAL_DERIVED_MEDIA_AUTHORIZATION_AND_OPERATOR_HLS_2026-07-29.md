# Physical Derived-Media Authorization and Operator HLS Gate

Date: 2026-07-29  
Physical source: Camera 3, AVKANS SRT/H.264/AAC, 1920x1080 at 30 fps  
Operator priority: continuity and mobile compatibility over latency

## Result

The derived-media authorization gate passed, and the physical browser gate exposed and corrected a separate mobile-inspection defect.

- Anonymous HLS and WHEP requests were denied with HTTP 401.
- Authorized HLS master, child playlist, initialization object, and media object requests succeeded.
- MediaMTX propagated the event-scoped read credential to child playlist and media-object URIs.
- An authorized WHEP session connected over the private VPC, received audio and video, and closed with HTTP 200.
- The same authorized WHEP offer from the current external Mac network completed signaling but received no media before timeout. Ordinary operator inspection therefore cannot depend on public WHEP reachability.
- Sanitized ingest and compositor logs contained no exact read-user or read-password values.
- The overview remained reader-free; bounded inspection readers retired after the configured grace period.

## Mobile HLS Finding

The first iPhone-style WebKit check found two distinct problems:

1. MediaMTX uses a cookie handshake for iOS HLS. `hls.js` requests did not retain that cookie because the player did not enable credentialed XHR.
2. Native HLS accepted the cookie handshake but could not decode the Opus-audio `court3_preview` rendition. The AAC `court3_program` rendition played at 1920x1080 and advanced continuously.

The hard cut is deliberately narrow:

- operator detail inspection reads buffered `courtN_program` HLS;
- `hls.js` requests use credential mode `include` through `XMLHttpRequest.withCredentials`;
- the optional 360p/10 fps `courtN_monitor` rendition encodes mono AAC instead of Opus;
- timing-sensitive commentary and fan scoring continue to use `courtN_preview` WHEP;
- the final program renderer remains on buffered `courtN_program` HLS.

This preserves the low-latency path where timing is authoritative while making ordinary desktop/mobile inspection tolerant of the public WebRTC failure observed in this gate.

## Browser Evidence

The rebuilt ScoreCheck application passed the bounded physical Camera 3 check in Playwright WebKit using an iPhone 15 profile:

| Check | Result |
| --- | --- |
| Application route | `/admin/stream-preview/3` |
| Selected media path | `court3_program` |
| Transport | buffered HLS |
| Player status | `Live - HLS` |
| Dimensions | 1920x1080 |
| Playback | unpaused, ready state 4 |
| Five-second media-time check | advanced 6.595 seconds |
| Media error | none |

This WebKit result is strong automated mobile-browser evidence, but it does not replace one final check on Nathan's physical iPhone.

## Source and Runtime Evidence

- Camera 3 HLS source GOP: 360 packets, 12 keyframes, maximum keyframe gap 1.000012 seconds.
- Authorized Chromium inspection: 42 HLS requests, zero WHEP requests, 1920x1080 playback, and 4.960 seconds of media-time growth during a five-second observation.
- Canonical-origin MediaMTX CORS: exact origin, credentialed requests allowed, and secure partitioned cookie support.
- Camera 5 remained healthy throughout the gate: one active Egress, 1080p buffered HLS at 30 fps, zero browser drops/freezes, and YouTube live/good with no issues.

Protected machine-local artifacts are under the active derived-media evidence pointer for `reliability-physical-20260728`. They contain no published credentials.

## Validation and Deployment State

- Web tests: 76 files, 562 tests passed.
- Strict TypeScript check: passed.
- Lint: passed.
- Production web build: passed.
- MediaMTX tests: 17 passed.
- Branch commit: `821b09fced87ac2e3deebc97f0a7fd61f6083b63`.
- Git remote SHA: matched.
- Vercel change scope: both branch preview deployments reached `READY` (`dpl_8xzF6cs6rRMfn7QUbQWSUibTDkBq` and `dpl_QrH3gHw6MhYtL7cAcPxQK7nJbT8m`); the event-pinned renderer and production alias were not changed.
- MediaMTX AAC monitor-rendition change: checked in and validated, but intentionally not applied to the active ingest container while Camera 5's output is running.

## Remaining Acceptance

1. Verify the preview deployment in a physical iPhone Safari session.
2. Apply the AAC monitor-rendition configuration at a controlled ingest cutover and repeat the 360p mobile check.
3. Preserve one-reader drainage and zero credential leakage in the final event evidence.
