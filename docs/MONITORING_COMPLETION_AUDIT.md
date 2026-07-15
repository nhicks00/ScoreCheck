# ScoreCheck Monitoring Completion Audit

Status: implementation audit after the unified monitoring build. This document
separates deployed evidence from tests and from work that requires external
providers or real media feeds.

## Acceptance matrix

| Requirement | Evidence | Status |
| --- | --- | --- |
| Read-only host-local collection | Six agents, GET-only Docker proxy, bounded schemas | Deployed and passing |
| Separate observability failure domain | Prometheus, Alertmanager, correlator, monitor API, Caddy on observability VPS | Deployed and passing |
| Eight-court operator dashboard | Authenticated 4x2 matrix, low-rate thumbnails, one selected WHEP player, stage evidence, trends, incidents | Deployed and passing |
| Media transport telemetry | MediaMTX readiness, bitrate, source protocol/mode, codec/profile/resolution/audio, bounded SRT transport counters, readers, FFmpeg progress | Contract v2 deployed and passing |
| Program render telemetry | FPS, dimensions, RTP loss/jitter, reset-safe receive/decode/drop/freeze rates, packet age, feedback counters, reconnects, reloads | Sustained browser frame-pacing defect confirmed; detector and one-reader A/B/A path comparator validated locally, deployment pending |
| Full-bitrate repeated-picture detection | Existing decoded element sampled at 160x90/1 Hz; warning/critical correlator and alert rules | Unit and deterministic fault gate passing; real fault pending |
| Black/covered-picture detection | Luma, dark ratio, variance, persistence; mutually exclusive with freeze paging | Unit and deterministic fault gate passing; real fault pending |
| Camera and commentary audio quality | Track/mute, RMS/peak, clipping, silence age, RTP loss/jitter, adaptive sync evidence | Implemented; real audio fault gate pending |
| Score and overlay alignment | Current match, source score, persisted overlay, rendered DOM signatures, exact 67-67 invalid-state checks | Deployed and passing fixtures |
| Infrastructure and Egress attribution | Host/container health, idle/busy state, capacity, assigned court pair, mapping mismatch rejection | Deployed; false busy-state paging corrected and restart-during-outage fixture passing |
| YouTube health | Exact configured video IDs, lifecycle, ingestion health when OAuth is available, API failure remains unknown | Deployed; provider fault gate pending |
| Durable incidents and operator actions | Fingerprints, open/ack/resolved transitions, checkpoints, acknowledgements, timed silences, expiry re-arm | Deployed and unit-tested |
| Alert expression behavior | Promtool fixtures validate hold times, labels, annotations, court isolation, black/freeze exclusion, decode/freeze rate bands, live gating, shared-worker fan-out, and external phone-channel attachment | Deployed; 46/46 production rules healthy with zero active alerts |
| Page suppression behavior | Disposable network-isolated Alertmanager proves same-court and shared-dependency inhibition while peer alerts remain active | Enforced before deployment |
| Phone paging | Required Pushover emergency acknowledgement and recovery; optional Twilio SMS escalation | Pushover delivery/recovery proven; controlled acknowledgement gate pending. Twilio is optional and disabled because campaign/number association and live delivery are not verified |
| Independent dead-man | Baseline and active Healthchecks senders with coverage-aware cadence plus read-only Pushover attachment audit | Audit deployed; baseline running, active idle-paused, and Pushover attached to both. Controlled withheld-ping gate remains pending |
| One-court real fault gate | Camera, network, preview, browser, commentary, score, Egress, YouTube, agent, dead-man faults | Ten-hour transport/sync soak passed; injected fault matrix pending |
| Eight-court real load/fault gate | Four compositors, eight representative feeds, two commentary rooms, score on all courts | Fail-closed routing endurance passed under the temporary topology; ingest headroom and viewer quality failed; revised-topology gate pending |

## Deterministic isolation gate

Automated fixtures prove these correlation rules without mutating production:

1. A missing raw publisher marks only its physical court critical.
2. A repeated full-bitrate picture marks only that court and does not blame the
   program browser transport.
3. A compositor failure marks only its centrally assigned pair, including when
   the latest agent snapshot is unavailable.
4. A rendered-score mismatch leaves score-source health and the other seven
   courts unchanged.
5. YouTube API failure is `UNKNOWN`, never a fabricated stream outage.
6. A shared score-worker fault creates one dependency incident instead of eight
   court pages.

This is deterministic software evidence, not evidence that the physical camera,
venue network, commentator browser, or providers behave correctly under fault.

## Real-feed evidence

The post-sync one-court Gate 1 soak ran for ten hours without a transport
restart, OOM, frame stall, MediaMTX path failure, or program egress error. The
initial and operator-observed sync check passed. This is conditional acceptance:
the camera reconnect test, midpoint/final subjective sync observations, and the
fault-injection matrix were not completed, so the soak does not close Gate 1.

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
changing page-load identity. Live-only alert bands and a sequential
preview/program/preview comparator pass locally and await a coordinated
post-soak deployment and test-only gate.

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

## Remaining external blockers

ScoreCheck Pushover and both Healthchecks checks are configured. Healthchecks
has one Pushover integration attached exactly to the baseline and active checks,
with the unused legacy check left email-only. The remaining provider and
operator prerequisites are:

1. Prove a withheld baseline ping reaches the phone and recovers without
   creating duplicate alerts.
2. An existing production admin session for a production-browser visual pass;
   Vercel intentionally does not export the sensitive admin secret.

Twilio is not required for this release. Its sender remains disabled as an
optional future escalation path until A2P campaign association and a real
delivery test pass.

Operator approval for isolated monitoring fault gates is recorded, and Camera 4
is available as a raw-only test feed. The user ended the active soak at 16:00
CDT on 2026-07-13 after the final recheck. Further test-only gates still require
explicit coordination, but the soak deployment freeze is closed.

The exact deployed dashboard build passed local authenticated visual validation
against the live read-only monitor API at 1600x1000 and 390x844: eight cards,
four columns on wide desktop, no horizontal overflow, source profiles visible,
and no browser console warnings or errors.

Venue Wi-Fi root-cause telemetry remains limited to end-to-end ingest evidence
until specific camera or router APIs are selected and qualified. The monitor
must not claim RF or camera-encoder certainty without those sources.

## Next gates

1. Prove Pushover acknowledgement, recovery, and withheld-ping behavior in a
   scheduled operator-visible window.
2. Repeat the one-court test broadcast and inject every remaining row in the
   runbook table, including camera reconnect and subjective sync checks.
3. Replace the shared eight-feed normalizer topology, then run eight
   representative feeds across a capacity-qualified compositor pool for at
   least two hours, with scoring on all courts and at least two commentary rooms.
4. Preserve detection latency, unaffected-court evidence, duplicate count,
   recovery time, CPU/memory trends, and Supabase growth for every fault.
5. Only after these gates pass, accept monitoring as ready for the shadow event.
