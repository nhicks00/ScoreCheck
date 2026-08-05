# ScoreCheck Reliability Review Reconciliation

Date: 2026-07-28
Scope: GPT Pro review of the first eight-camera dry run, reconciled against the current repository and protected evidence.
Priority order: continuous viewer playback, A/V and score synchronization, fidelity, predictable recovery, then latency.

## Decision Summary

The review supports the current basic architecture. ScoreCheck should keep DigitalOcean, MediaMTX, buffered HLS for the program renderer, one compositor per camera, LiveKit Web Egress, unlisted YouTube destinations, event-scoped infrastructure, and a separate monitoring plane. A wholesale media-platform rewrite is not justified.

The current release is not production-qualified. The first dry run exposed four P0 gaps that are now implemented and locally validated on the reliability branch: host-local exact-owner output recovery, an event-local renderer with cached control-plane state, coverage-owned warm program branches, and scoped derived-media credentials. A July 28 physical gate passed exact browser-safe source admission and serialized local-only 1080p30 output capture for AVKANS Cameras 3-8. Event-length HLS memory/object behavior, infrastructure fault recovery, both Mevo paths, and final eight-output conformance remain live gates rather than completed evidence.

## Code-Backed Matrix

| Recommendation | Status | Current evidence | Decision |
|---|---|---|---|
| Use buffered HLS in the program renderer | Satisfied in configuration and instrumentation; endurance open | `programTimeline.ts` defines 12 s target, 24 s maximum, 18 s forward buffer, 4 s back buffer, 32 MB compressed buffer, and six startup segments. `StreamPlayer.tsx` uses standard-latency hls.js, a segment-boundary start, and no catch-up playback. The production-soak evaluator now retains playout-delay bounds, browser heap, HLS instance ownership, and full Egress cgroup floor/peak/growth evidence, and rejects missing headroom or sustained retained growth. | Keep. Run the event-length physical gate; do not claim that the 32 MB compressed buffer caps total browser memory. |
| Keep WHEP only for low-bandwidth operator inspection | Partial | Program mode uses HLS; preview and selected monitoring paths still support WHEP. | Keep WHEP out of the program output path. Verify overview pages create no live readers. |
| Keep one compositor per output | Satisfied architecturally | The manifest assigns one court per compositor and each host hard-rejects a second web Egress. | Keep through 1080p30 qualification. Defer consolidation. |
| Persist YouTube output through camera loss | Partial | `start-court.sh` starts the renderer without awaiting camera media, so the interruption slate can remain encoded. Camera loss does not intentionally complete YouTube. | Keep invariant. Prove it under a bounded physical source loss after exact-once supervision is deployed. |
| Exact-once Egress recovery | Implemented; live gate open | The schema-3 owner binds request digest, output generation, destination, and exact renderer identity. A host-local supervisor shares the lifecycle lock, requires repeated absence, rejects owner/active-set ambiguity, verifies the event-local renderer, fully recycles Egress, and replays only the exact owned request with a bounded budget. Active-but-unhealthy browser recovery now stops only the exact owner, recycles the empty worker, proves native admission/PulseAudio state, and resumes the same generation; an interrupted recovery repeats the idle recycle before replay. | Run isolated handler, container, and host-reboot recovery gates with a real camera and unlisted output. |
| Reconcile LiveKit abnormal-exit residue | Implemented; live gate open | Production pins LiveKit Egress `v1.13.0`. The supervisor requires a new worker container ID, a healthy endpoint, exactly one idle/admissible native metric set, zero active web requests, and one finite PulseAudio load below capacity before replay. Missing, duplicate, malformed, non-finite, negative, and fractional state fails closed. Upstream issue #1274 remains open. | Run abnormal handler, full container-loss, and compositor-reboot gates with the real output path. Keep bounded attempts per output generation. |
| Immutable event renderer | Implemented; live gate open | Egress now targets a compositor-local standalone renderer artifact whose manifest binds exact Git SHA, immutable Vercel deployment identity, artifact digest, assets, and contract versions. Recovery refuses replay when the local binding differs. | Prove cold recovery with Vercel denied and preserve exact artifact/deployment provenance. |
| Local last-good scene during control-plane loss | Implemented; live gate open | The local renderer stores bounded, mode-safe, atomic court and overlay caches. It serves cached state with an explicit stale source marker when Supabase/API access is unavailable. | Prove cold browser restart with Vercel and Supabase denied while video, silence/ambient audio, score, and interruption messaging remain renderable. |
| Keep program HLS warm during coverage | Implemented; live gate open | A coverage owner file controls one packet-copy warmer for `courtN_program`; deliberate output stop removes ownership and retires the warmer. Monitoring reports ownership, liveness, and restarts. | Verify one warmer per LIVE court, no idle warmer, bounded restart behavior, and no reader fan-out. |
| Final 1080p output conformance | Six-camera local evidence passed; full gate open | The conformance gate records an actual local output and uses pinned `ffprobe` to assert H.264 High, 1920x1080, yuv420p progressive Rec.709, selected frame rate/bitrate, two-second-or-shorter keyframes, AAC stereo at 48 kHz, and continuity. Cameras 3-8 each passed one serialized physical local-only capture in one Egress start attempt and returned idle. | Complete Cameras 1-2, then reconcile all eight persistent outputs with YouTube provider/viewer evidence. The next full gate is 1080p30 only. |
| AVKANS SRT/H.264 | Source and local output accepted; endurance open | Physical Cameras 3-8 passed exact H.264 High, yuv420p progressive, no-B-frame, 30 fps, one-second GOP, monotonic timestamp, AAC stereo 48 kHz source admission. Each then passed a local 1080p30 H.264 High/AAC output capture. | Keep SRT/H.264 for Cameras 3-8 and complete event-length buffered-HLS and unlisted viewer endurance. |
| Mevo SRT/HEVC | Measured decision | HEVC saves venue bandwidth but requires an isolated HEVC-to-H.264 normalizer. The first dry run observed normalizer/source instability that was not qualified as camera-only or platform-only. | Run same-scene Mevo SRT/H.264 versus SRT/HEVC A/B at comparable viewer quality. Select HEVC only if the full normalized path is materially more reliable or materially reduces required uplink without consuming unsafe compute headroom. |
| H.264 browser-safe admission | Passed for physical Cameras 3-8; Mevos open | The physical AVKANS gate verified identity/profile, SRT transport, pixel format, progressive scan, exact 30 fps, zero B-frames, one-second GOP, monotonic timestamps, bounded bitrate, AAC continuity, and the derived browser input contract. | Preserve this contract. Complete the isolated HEVC normalizer path for Cameras 1-2 without weakening direct H.264 admission. |
| Two four-camera ingest shards | Measured decision, not approved topology | One shared ingest remains the largest blast radius. The current tested lifecycle is exactly 12 temporary Droplets and includes a warm compositor spare with an ingest-recovery role. | First qualify Reserved-IP takeover using the existing spare and measure RTO. Add a thirteenth host or two static shards only if the measured RTO/blast radius justifies the added lifecycle and cost. Never exceed the 15-Droplet ceiling. |
| Private compositor-to-ingest paths | Satisfied by contract; reverify live | Deployment binds the public TLS hostname to the ingest private VPC address and reconstruction provenance checks it. | Keep and verify selected endpoint/reader evidence in every event preflight. |
| Venue bandwidth reserve | Partial | The admission runner has profile requirements and Speedify evidence, but Speedify's own capacity estimate was shown to be non-authoritative. | Gate on measured sustained application-layer upload and per-camera delivered rates. Require 30% hard reserve and target 50% preferred reserve. Treat bounded VBR fluctuation as normal. |
| Wi-Fi, RF, power, and thermal evidence | Partial; AP association telemetry implemented | Router/Speedify state and host resources are recorded. Heartbeat schema v3 adds the dedicated camera-AP associated-device count and weakest client signal without changing Wi-Fi or Speedify policy. Camera power and thermal state remain unavailable. | Keep the telemetry diagnostic-only until camera identity can be bound without false positives. Do not prescribe HE80 or another radio width without venue evidence. |
| Commentary return, mix-minus, and calibration | Partial | Commentary publish, delay/sync status, audio levels, TURN infrastructure, and clap testing exist. | After core media passes, qualify return video, mix-minus, silence-preserving audio, TURN/TLS fallback, and repeatable flash/clap calibration. Commentary failure must never stop camera ambient/video. |
| Scoring revisions and stale-client safety | Largely satisfied; integrated gate open | Community scoring includes revisions, authority epochs, leases, idempotent semantic actions, stale-revision rejection, and durable tests. | Do not redesign before integrated overlay/control-plane loss tests. Verify ETag/checksum repair and source-precedence behavior against the running program scene. |
| External viewer proof | Partial | YouTube API health and watch-page HTTP checks exist; manual human playback checks were used. | Add a bounded external fresh-frame/audio probe. Provider health alone is not viewer proof. |
| Derived media authorization | Implemented; live gate open | Event-scoped HMAC-derived credentials now protect preview, program, monitor, and calibration reads. Caddy validates exact WHEP and HLS paths; web, renderer, compositor, monitor, recovery, and spare consumers receive the same generated contract. Raw paths remain publish-only. | Verify child HLS requests, WHEP session teardown, denial without credentials, and no credential leakage in logs or browser telemetry. |
| Event teardown truthfulness | Satisfied | Lifecycle deletes temporary Droplets and the independent schema-v2 audit now requires zero temporary or unknown compute while separately validating the exact persistent cloud UniFi controller. Two retained unassigned Reserved IPv4s intentionally remain and can accrue a small charge. | Preserve manual teardown confirmation and report retained support infrastructure and endpoint-anchor cost separately. |
| Long YouTube sessions and archive | Open | A 16-18 hour end-to-end run has not passed. | Run beyond the 12-hour archive-risk boundary and preserve a separate critical recording for priority coverage if YouTube archive completeness is not proven. |

## Release Plan

### Phase 1: Code-backed P0 hardening

1. Deploy the locally validated host-local exact-owner Egress supervisor and exercise its bounded recovery paths.
2. Run the event-length physical gate against the HLS runtime telemetry for Egress cgroup memory, JS heap, HLS instance ownership, buffer length, playout delay, reload/reconnect generations, drops, freezes, and audio correction.
3. Exercise the compositor-local renderer through cold-start Vercel and Supabase loss gates.
4. Verify coverage-owned program branches stay warm only while broadcast expectation is LIVE.
5. Verify the scoped derived-media hard cutover across compositor, monitor, calibration, and operator consumers.
6. Validate actual output conformance and persistent interruption-slate behavior against bounded physical feeds and unlisted destinations.

### Phase 2: Isolated infrastructure gates

1. Abnormal browser handler exit, Egress child crash, full Egress-container loss, and compositor reboot.
2. Vercel denial, Supabase denial, and simultaneous cold browser restart.
3. Ingest primary loss and Reserved-IP takeover using the existing warm spare.
4. YouTube sender interruption without broadcast completion or duplicate publisher.
5. Monitor host loss with external sentinel paging.

### Phase 3: Bounded physical comparison

The physical router and cameras are now the release evidence source; synthetic acceptance workflows are excluded by operator direction. The July 28 gate accepted AVKANS Cameras 3-8 at 1080p30 SRT/H.264. Cameras 1-2 retained DHCP leases but were not associated to the camera AP and opened no SRT flows after the Speedify upgrade, so the earliest proven fault is before the router tunnel or ingest. Resume their isolated SRT/HEVC normalizer qualification after they physically reconnect.

### Phase 4: Full event qualification

Run all eight cameras for 16-18 hours at 1080p30 to cross the archive and long-lived-browser risk windows. Require continuous unlisted YouTube outputs, bounded HLS process/object growth, exact one-output ownership, no unexplained Egress residue, no cross-court failures, adequate venue reserve, working mobile monitoring, and retrospective evidence completeness.

### Phase 5: Integrated products and operations

Only after core media passes: overlay timing and stale-state recovery, remote commentary/TURN/mix-minus/sync, fan-scoring authority and stale-client safety, mobile incident drills, external viewer probing, security cutover, event lifecycle rehearsal, and final temporary-compute-zero teardown.

## Explicit Deferrals

- 1080p60 production qualification until 1080p30 passes.
- Multiple outputs per compositor.
- Active-active ingest or dual publishing from every camera.
- A permanent thirteenth host before spare-takeover RTO is measured.
- A different media platform without a same-source test proving a repeatable MediaMTX-specific fault.
- RF channel-width prescriptions without venue evidence.
- Feature flags; all accepted changes are hard cutovers.

## Current Operator Requirement

Keep every Speedify input's saved priority at `automatic`; working roles such as `always` and `secondary` remain Speedify scheduler state. Cameras 3-8 need no operator action. Cameras 1-2 require one physical Wi-Fi/stream reconnection before their source and normalized output can be qualified. No YouTube destination should start until all eight source paths pass.

## Primary Upstream Evidence

- LiveKit Egress issue #1274, PulseAudio residue after abnormal handler termination: <https://github.com/livekit/egress/issues/1274>
- LiveKit Egress v1.13.0 release: <https://github.com/livekit/egress/releases/tag/v1.13.0>
