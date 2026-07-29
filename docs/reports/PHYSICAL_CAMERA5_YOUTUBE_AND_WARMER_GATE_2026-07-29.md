# Physical Camera 5 YouTube and Program-Warmer Gate

Date: 2026-07-29

## Verdict

PASS for the bounded one-camera end-to-end provider path.

This result qualifies the current Camera 5 AVKANS source through SRT ingest, buffered HLS program rendering, LiveKit Egress, and an unlisted YouTube broadcast. It does not qualify the venue router for seven or eight simultaneous camera publishers, and it does not replace a full multi-camera event soak.

## Physical Input

- Camera: Camera 5, AVKANS Go firmware 2.2.3
- Transport: SRT push
- Video: H.264 High, 1920x1080, approximately 30 fps
- Audio: AAC stereo, 48 kHz
- Source bitrate during the gate: approximately 3.2 Mbps variable bitrate
- Commentary: explicitly not participating
- Peer topology: Cameras 1-6 publishing; Cameras 7-8 intentionally isolated by router capacity rules

## Gate Window

- Start: `2026-07-29T06:08:35.379Z`
- End: `2026-07-29T06:23:35.381Z`
- Duration: 900.002 seconds
- Monitor samples: 181
- YouTube provider samples: 31
- Maximum monitor gap: 5.003 seconds
- Problems: 0

## Viewer and Program Results

- Aggregate browser rendered cadence: 30.0022 fps
- Browser page identity: unchanged
- Rendered frame growth: 27,002
- Dropped-frame growth: 0
- Freeze growth: 0
- Freeze-duration growth: 0 ms
- Reconnect growth: 0
- Reload growth: 0
- Program frame errors: 0
- YouTube throughout: live, recording, unlisted, bound, active, good, zero configuration issues
- Five separate actual YouTube playback checks passed, including the post-cutover check; each observed an advancing playhead and no viewer problem

The SRT source reported 548 additional lost packets over 333,489 received packets during the window, plus 207 dropped packets. No corresponding browser or YouTube defect occurred. This supports the design priority: transport recovery and program buffering can absorb modest source-path impairment without degrading the viewer.

## HLS Reader Finding

The deployed monitor reported a maximum `court5_program` reader count of 311. Direct attribution proved this was not viewer fan-out:

- one stable Chromium HLS browser session was present;
- one FFmpeg program-warmer process generated 99 short-lived MediaMTX HLS sessions in an approximately 12-second sample;
- the FFmpeg requests retained the original read query but did not retain MediaMTX's HLS session identity;
- direct connection and host evidence showed no matching network fan-out.

The warmer was hard-cut from HLS input to one private RTSP/TCP packet-copy reader. After MediaMTX's 30-second session expiry:

- HLS sessions: 100 to 1;
- program-path readers: one HLS browser plus one RTSP warmer;
- browser state: playing at 30 fps;
- browser quality counters: all zero;
- YouTube: healthy;
- incidents: zero;
- actual post-cutover YouTube playback check: passed.

All eight compositor hosts were aligned to revision `8b4816861`. Camera 5 was WARM with one reader process start; the other seven warmers were IDLE. Every renderer and Egress container stayed healthy with zero restarts. Only the warmer containers were recreated.

## Monitoring Binding Finding

When Camera 5 changed from TESTING to LIVE, the monitor initially evaluated an older completed YouTube video because the active court row still held the previous video ID. The provider itself was live and healthy, so this was a control-plane mapping defect rather than an output defect.

The active row was corrected and the monitor converged to HEALTHY. Commit `cc48b0de3` makes the production runner fail closed unless the current YouTube video ID is durably written and returned for the exact event/camera before the LIVE expectation is enabled.

## Remaining Limits

1. The venue router has passed six simultaneous publishers only. Seven leaves insufficient reserve; eight has failed under the current router CPU profile. Cameras 7-8 remain intentionally isolated for this controlled result.
2. The runtime branch is pushed but not merged into the release branch. Integration must preserve commits `cc48b0de3` and `8b4816861`.
3. A full multi-camera YouTube endurance gate remains required after the router capacity decision.

## One-Hour Post-Gate Checkpoint

The same Camera 5 page and Egress remained active through
`2026-07-29T07:04:22.680Z`, more than one hour after page load:

- 113,375 additional rendered frames at 29.993 aggregate fps;
- zero browser drops, freezes, freeze-duration growth, reconnects, or reloads;
- one created HLS instance, zero destroyed instances, and one active instance;
- bounded buffered-ahead time with a 12.106-second maximum;
- post-fix JavaScript heap cycling between approximately 8.6 MB and 18.5 MB
  rather than increasing linearly;
- exactly two program readers in every sample after `06:30Z`: one HLS browser
  and one RTSP warmer; and
- a fresh actual YouTube viewer probe with advancing playhead and audio.

The provider API returned `provider-unavailable` once near `06:56:19Z`. The
external viewer continued playing during that interval, and the next provider
observation returned live/active/good with no issues. This is a provider/API
read transient, not a delivery outage.

The same interval included the matched plain-Speed versus Enhanced Streaming
comparison documented in
`PHYSICAL_SPEEDIFY_ENHANCED_STREAMING_COMPARISON_2026-07-29.md`. Neither mode
caused a viewer defect; plain Speed retained lower SRT loss/drop rates and was
restored.

## Lifecycle Attestation Repair

The earlier lifecycle-start refusal was reproduced with the exact production
reconstruction verifier. A complete hash-only fleet audit isolated the drift to
the idle warm spare; every active host already matched the current release.
`bvm-compositor-spare` was missing the committed program-warmer RTSP binding and
the current Egress-supervisor and program-warmer scripts.

The spare had zero active Egress requests and an `IDLE` supervisor before the
cutover. Only that host was updated. Camera 5 remained live throughout at 30 fps
with zero drops, freezes, reconnects, or reloads, while Egress and YouTube stayed
healthy and no incident opened. The authoritative 12-host verification then
passed at `2026-07-29T07:19:49.304Z`, including exact config hashes, clocks,
private-network bindings, containers, agents, and public endpoints.

The event intentionally remains in lifecycle phase `ready`: this direct bounded
gate did not claim standard whole-event coverage ownership. The controller now
persists the fresh reconstruction evidence used by a successful future coverage
start and leaves the previous healthy evidence unchanged when admission fails.
The full event-stack regression suite passes 454/454 tests.

## Protected Evidence

Evidence is stored outside Git at:

`~/.config/scorecheck/event-stack/events/reliability-physical-20260728/qualification-evidence/camera5-youtube-gate-20260729T055428Z`

Important evidence includes the 181-sample gate trace and summary, five viewer probes, before/after HLS session attribution, compositor container identity checks, deployment backups and hashes, and fleet convergence results.

The lifecycle repair evidence is stored separately at:

`~/.config/scorecheck/event-stack/events/reliability-physical-20260728/qualification-evidence/lifecycle-attestation-reconcile-20260729T071738Z`
