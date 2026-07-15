# ScoreCheck Monitoring Completion Audit

Status: implementation audit updated after the Camera 1 physical lifecycle
gate, the qualified one-court `c-4` capacity run, and the deterministic
eight-court fault-matrix deployment. This document separates deployed evidence
from tests and from work that still requires real faults or final event
capacity.

## Acceptance matrix

| Requirement | Evidence | Status |
| --- | --- | --- |
| Read-only host-local collection | Six agents, GET-only Docker proxy, bounded schemas | Deployed and passing |
| Separate observability failure domain | Prometheus, Alertmanager, correlator, monitor API, Caddy on observability VPS | Deployed and passing |
| Eight-camera operator dashboard | Authenticated two-column desktop/one-column mobile matrix, low-rate thumbnails, one selected WHEP player, stage evidence, trends, incidents | Deployed and passing |
| Media transport telemetry | MediaMTX readiness, bitrate, source protocol/mode, codec/profile/resolution/audio, bounded SRT transport counters, readers, FFmpeg progress | Contract v2 deployed and passing |
| Program render telemetry | FPS, dimensions, RTP loss/jitter, reset-safe receive/decode/drop/freeze rates, packet age, feedback counters, reconnects, reloads | Deployed; Camera 1 comparator and same-page physical loss/recovery passed at 30 fps with no stable-window quality loss. Eight simultaneous outputs remain unqualified |
| Full-bitrate repeated-picture detection | Existing decoded element sampled at 160x90/1 Hz; warning/critical correlator and alert rules | Unit and deterministic fault gate passing; real fault pending |
| Black/covered-picture detection | Luma, dark ratio, variance, persistence; mutually exclusive with freeze paging | Unit and deterministic fault gate passing; real fault pending |
| Camera and commentary audio quality | Track/mute, RMS/peak, clipping, silence age, RTP loss/jitter, adaptive sync evidence | Implemented; real audio fault gate pending |
| Score and overlay alignment | Current match, source score, persisted overlay, rendered DOM signatures, exact 67-67 invalid-state checks | Deployed and passing fixtures |
| Infrastructure and Egress attribution | Host/container health, idle/busy state, capacity, expected-versus-active web requests, assigned court pair, exact missing-output attribution, mapping mismatch rejection | Deployed; one-court `c-4` capacity and ordered teardown passed. Current four-worker topology still cannot admit eight simultaneous outputs |
| YouTube health | Exact configured video IDs, lifecycle, ingestion health when OAuth is available, API failure remains unknown | Deployed; provider fault gate pending |
| Durable incidents and operator actions | Fingerprints, open/ack/resolved transitions, checkpoints, acknowledgements, timed silences, expiry re-arm | Deployed and unit-tested |
| Alert expression behavior | Promtool fixtures validate hold times, labels, annotations, court isolation, black/freeze exclusion, decode/freeze rate bands, live gating, shared-worker fan-out, Egress output deficits, capacity, and external phone-channel attachment | Deployed; 49/49 production rules healthy with zero active alerts |
| Page suppression behavior | Disposable network-isolated Alertmanager proves same-court and shared-dependency inhibition while peer alerts remain active | Enforced before deployment |
| Phone paging | Required Pushover emergency acknowledgement and recovery; optional Twilio SMS escalation | Pushover opening/recovery delivery proven in physical Camera 1 episodes; controlled acknowledgement tap remains pending. Twilio is intentionally skipped while carrier registration blocks delivery |
| Independent dead-man | Baseline and active Healthchecks senders with coverage-aware cadence plus read-only Pushover attachment audit | Audit deployed; baseline running, active idle-paused, and Pushover attached to both. Controlled withheld-ping gate remains pending |
| One-court real fault gate | Camera, network, preview, browser, commentary, score, Egress, YouTube, agent, dead-man faults | Physical Camera 1 loss/recovery, durable paging, same-page viewer continuity, A/V sync, and one-court `c-4` capacity passed. Remaining real fault rows are pending |
| Eight-court real load/fault gate | Four compositors, eight representative feeds, two commentary rooms, score on all courts | Fail-closed routing endurance passed under the temporary topology; ingest headroom and viewer quality failed; revised-topology gate pending |

## Deterministic isolation gate

Automated fixtures prove these correlation rules without mutating production:

1. A missing raw publisher marks only its physical court critical.
2. A repeated full-bitrate picture marks only that court and does not blame the
   program browser transport.
3. A black/covered picture is distinct from a freeze and pages only the affected
   camera.
4. A missing expected Egress output is attributed to the exact stale-browser
   camera; worker failure or insufficient capacity inhibits duplicate symptoms.
5. Browser loss and commentary disconnect, silence, clipping, transport, and
   sync failures retain exact camera attribution.
6. A rendered-score mismatch leaves score-source health and the other seven
   cameras unchanged.
7. YouTube API failure is `UNKNOWN`, never a fabricated stream outage.
8. Shared score-worker and host faults create dependency incidents instead of
   eight camera pages.
9. A compositor failure marks only its centrally assigned pair, including when
   the latest agent snapshot is unavailable.
10. Eight healthy outputs pass only when each worker advertises enough qualified
    active-web-request capacity for its assigned pair.

This is deterministic software evidence, not evidence that the physical camera,
venue network, commentator browser, or providers behave correctly under fault.

## Real-feed evidence

The post-sync one-court Gate 1 soak ran for ten hours without a transport
restart, OOM, frame stall, MediaMTX path failure, or program Egress error. That
soak was initially conditional evidence. The later Camera 1 physical lifecycle
gate closed its camera-loss/reconnect and viewer-continuity gaps: raw loss opened
one durable Pushover page, Cameras 2-8 remained isolated, recovery was driven by
feed health, the same Program page survived a full stop/start without reload,
the stable recovery window rendered at 30.003 fps with no counter growth, and
the foreground clap test passed subjective A/V sync. The remaining one-court
work is the rest of the real fault matrix, not another Camera 1 reconnect cycle.

The first full eight-feed load attempt was useful failure evidence, not a pass.
One shared `c-4` normalizer reached about 394 percent CPU, produced only 18-24
fps at 0.59-0.81x realtime, and failed to sustain the program paths. Egress
accepted all eight jobs and the four compositor hosts were not the bottleneck.
The next gate must split normalization by host/court or qualify camera-side
720p H.264 before repeating the load test.

The extended soak also produced a sustained ingest-host load spike: load1
reached 13.85 and remained at 13.47 after 30 seconds on the four-vCPU MediaMTX
host while three FFmpeg normalizers and MediaMTX were the active CPU leaders.
All raw and derived paths, browser samples, Egress outputs, routing, and YouTube
remained healthy during the recheck. This is capacity-headroom risk evidence,
not proof that host load caused the separate browser pacing defect.

The router briefly showed two exact Speedify watchdog command lines at
`19:28Z`, then recurred with three exact processes at `19:59Z`. Both episodes
self-converged to the single long-lived `procd` instance without route,
firewall, fail-closed, publisher, or output drift. This is a recurring
transient supervision defect requiring a root-cause review and atomic
single-instance guard, not sustained steady-state duplication.

The July 13 extended soak exposed a separate downstream quality defect. Courts
1, 3, and 5 continued accumulating Chrome decode drops and freezes after their
one-time deployment reload even though they rendered at 30-31 fps, RTP loss was
zero, RTT was 1-2 ms, FFmpeg and Egress were fresh, and YouTube remained good.
The strongest current hypothesis is timestamp/jitter behavior in the delayed
program path plus WHEP decoder scheduling; host load is correlated evidence,
not a proven cause. Court 1 later remained at 1-2 browser FPS for at least 30
seconds while adding 413 dropped frames, 22 freezes, and 12.803 seconds of
freeze duration; Court 3 reconnected WHEP in-page, and Courts 3 and 5 exceeded
1.2 seconds of jitter-buffer delay. A later synchronized 50-second event added
599, 130, and 169 browser drops on Courts 1, 3, and 5 while all upstream
program FFmpeg processes remained at 30 fps and RTP loss stayed zero. Court 5
then performed an unexplained isolated page reload at `15:13:23Z`; it recovered
at 30 fps while a contemporaneous four-process zombie increase held stable.
That timing is recorded as correlation, not causation. Reset-safe quality-rate
telemetry was further justified when Courts 3 and 5, and later Court 1,
reconnected WHEP in-page and reset their peer-connection counters without
changing page-load identity. The live-only alert bands are now deployed. The
sequential preview/program/preview comparator and physical same-page Camera 1
cycle passed after the Program viewer hard cutover. This closes the known
one-court viewer gate, but it does not erase the historical multi-court failure
or qualify eight simultaneous browser outputs.

The user-directed final endpoint at `21:01Z-21:02Z` captured another synchronized
degradation rather than a clean tail. Courts 1 and 3 initially sampled at 21
and 24 browser fps while Court 5 remained in `stabilizing`; the 52-second
recheck reached 34 fps catch-up, 27 fps, and still-stabilizing respectively.
Since `20:43Z`, the three browsers added 16,925 dropped frames, 594 freezes, and
385.302 seconds of freeze duration in aggregate while RTP loss remained zero
and upstream program FFmpeg stayed near 30 fps with zero drops. MediaMTX load
remained above 12 on four vCPUs during the recheck and zombies increased from
114 to 121. Raw paths, derived branches, routing, Egress, and YouTube stayed
available. Final classification: fail-closed routing endurance passed under
this temporary topology; viewer quality and ingest-host production headroom
failed; final venue capacity remains unqualified because the measured upload
floor was 31.8 Mbps and Cameras 6-8 were temporary WireGuard pulls.

The subsequent hardened one-court `c-4` capacity run from `04:33:49.978Z`
through `05:04:00Z` passed every formal evaluator check. It captured 363/363
valid five-second host samples, held ingest/compositor CPU below their limits,
kept FFmpeg at realtime with zero drop growth, retained fresh zero-loss browser
quality, rejected excess admission at one active request of one, preserved
Cameras 2-8 at zero readers, and maintained healthy unlisted YouTube output.
Process watchers recorded no unclassified lifecycle leak. Ordered teardown
completed YouTube before stopping the exact Egress id, then drained browser and
derived-path readers to raw-only idle. This qualifies one output on the current
`c-4` shape; it does not qualify two outputs per compositor or direct-eight
production.

## Remaining external blockers

ScoreCheck Pushover and both Healthchecks checks are configured. Healthchecks
has one Pushover integration attached exactly to the baseline and active checks,
with the unused legacy check left email-only. The remaining provider and
operator prerequisites are:

1. Prove a withheld baseline ping reaches the phone and recovers without
   creating duplicate alerts.
2. Prove the Pushover emergency acknowledgement interaction in an
   operator-visible window.
3. Execute the remaining real-feed fault rows without disturbing public output.
4. Qualify a final normalization/Egress layout that can admit eight concurrent
   outputs and verify the required 75 Mbps bonded-upload floor at the venue.

Twilio is not required for this release. The attempted SMS path is blocked by
carrier registration/sender approval, so all Twilio deployment variables remain
unset. Pushover is the required phone-alert channel; Twilio should be revisited
only after registration completes and a real delivery succeeds.

Operator approval for isolated monitoring fault gates is recorded. The user
ended the active soak at 16:00 CDT on 2026-07-13 after the final recheck. The
deployment freeze is closed, but every phone-visible or physical-source fault
still needs an explicit operator timing window and a fresh healthy baseline.

The exact deployed dashboard build passed local authenticated visual validation
against the live read-only monitor API at 1600x1000 and 390x844: eight cards,
two columns on desktop and one on narrow mobile, no horizontal overflow, source
profiles visible, and no browser console warnings or errors. Overview cards use
one 256x144 still every 15 seconds; only the selected camera opens live video,
with operator-selectable inspection quality.

Venue Wi-Fi root-cause telemetry remains limited to end-to-end ingest evidence
until specific camera or router APIs are selected and qualified. The monitor
must not claim RF or camera-encoder certainty without those sources.

## Next gates

The protected fault-evidence recorder now combines one-second sanitized monitor
API sampling with one bounded Supabase evidence phase before and after a gate.
It fails closed on stale checkpoints, dirty baselines, duplicate episodes or
notifications, missing dependency-recovery closure, and optional Pushover
acknowledgement/recovery requirements. Provider receipt identifiers are omitted
and Supabase is never polled. This makes future real-gate evidence repeatable;
it does not convert any pending real fault into a pass.

The isolated synthetic feed controller is also implemented and locally
qualified for direct-publisher Camera 2-5 paths. It produces a moving baseline,
full-bitrate repeated picture, uniform black picture, silent camera audio, or a
bounded publisher loss without changing MediaMTX configuration. Its explicit
`RAW_ONLY` versus `PROGRAM_CONTENT` gate contract closes the prior no-event
content-analysis gap. Guardrails refuse occupied paths, active events, dirty
monitoring state, wrong gate profiles, stale Program viewers, and unsafe stop;
the generated 1280x720/30 H.264 + AAC stream was locally probed at about 2.58
Mbps. This is prepared test tooling, not evidence that any remaining real fault
row has passed.

The operator path now uses a pinned, source-hashed container after live baseline
qualification exposed that the local macOS FFmpeg lacked SRT support. Capability
preflight rejects that host before publication, and publisher containment is
bounded to one restart with regression coverage. A subsequent Camera 4 SRT
baseline published, remained healthy, and retired cleanly without arming a gate
or creating an incident. That validates the runner baseline and cleanup only;
the phone-visible Camera 4 fault row remains pending.

1. Prove Pushover acknowledgement and Healthchecks withheld-ping recovery in a
   scheduled operator-visible window.
2. Use test feeds to inject the remaining real rows: full-bitrate freeze,
   black/covered picture, venue/uplink loss, preview normalizer failure, Program
   browser failure, commentary loss/silence/clipping/sync, score corruption,
   Egress stop, YouTube unbind/degradation, agent loss, and dead-man loss.
3. Preserve detection latency, affected component and camera, unaffected-camera
   evidence, notification deduplication, recovery time, CPU/memory trends, and
   Supabase growth for every real fault.
4. Expand or reshape capacity so every compositor can admit its assigned live
   outputs, then run eight representative feeds for at least two hours with
   scoring on all cameras and at least two commentary rooms.
5. Qualify the final camera profiles and the 75 Mbps bonded-upload venue floor.
6. Only after these gates pass, accept monitoring as ready for the shadow event.
