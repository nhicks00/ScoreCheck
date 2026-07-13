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
| Program render telemetry | FPS, dimensions, RTP loss/jitter, reset-safe receive/decode/drop/freeze rates, packet age, feedback counters, reconnects, reloads | Sustained browser frame-pacing defect confirmed; detector validated locally and deployment pending |
| Full-bitrate repeated-picture detection | Existing decoded element sampled at 160x90/1 Hz; warning/critical correlator and alert rules | Unit and deterministic fault gate passing; real fault pending |
| Black/covered-picture detection | Luma, dark ratio, variance, persistence; mutually exclusive with freeze paging | Unit and deterministic fault gate passing; real fault pending |
| Camera and commentary audio quality | Track/mute, RMS/peak, clipping, silence age, RTP loss/jitter, adaptive sync evidence | Implemented; real audio fault gate pending |
| Score and overlay alignment | Current match, source score, persisted overlay, rendered DOM signatures, exact 67-67 invalid-state checks | Deployed and passing fixtures |
| Infrastructure and Egress attribution | Host/container health, idle/busy state, capacity, assigned court pair, mapping mismatch rejection | Deployed; false busy-state paging corrected and restart-during-outage fixture passing |
| YouTube health | Exact configured video IDs, lifecycle, ingestion health when OAuth is available, API failure remains unknown | Deployed; provider fault gate pending |
| Durable incidents and operator actions | Fingerprints, open/ack/resolved transitions, checkpoints, acknowledgements, timed silences, expiry re-arm | Deployed and unit-tested |
| Alert expression behavior | Promtool fixtures validate hold times, labels, annotations, court isolation, black/freeze exclusion, decode/freeze rate bands, live gating, and shared-worker fan-out | 43-rule candidate passing locally; deployment held during active soak |
| Page suppression behavior | Disposable network-isolated Alertmanager proves same-court and shared-dependency inhibition while peer alerts remain active | Enforced before deployment |
| Phone paging | Pushover emergency acknowledgement plus Twilio SMS escalation and recovery logic | Pushover delivery/recovery proven; Twilio sender purchased but blocked by pending A2P registration; controlled acknowledgement/escalation gate pending |
| Independent dead-man | Baseline and active Healthchecks senders with coverage-aware cadence | Configured; baseline running and active idle-paused; withheld-ping phone gate pending |
| One-court real fault gate | Camera, network, preview, browser, commentary, score, Egress, YouTube, agent, dead-man faults | Ten-hour transport/sync soak passed; injected fault matrix pending |
| Eight-court real load/fault gate | Four compositors, eight representative feeds, two commentary rooms, score on all courts | First load attempt exposed an invalid shared-normalizer topology; revised-topology gate pending |

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

The July 13 extended soak exposed a separate downstream quality defect. Courts
1, 3, and 5 continued accumulating Chrome decode drops and freezes after their
one-time deployment reload even though they rendered at 30-31 fps, RTP loss was
zero, RTT was 1-2 ms, FFmpeg and Egress were fresh, and YouTube remained good.
The strongest current hypothesis is timestamp/jitter behavior in the delayed
program path plus WHEP decoder scheduling; host load is correlated evidence,
not a proven cause. Reset-safe quality-rate telemetry and live-only alert bands
pass locally and await a coordinated post-soak deployment and comparator gate.

## Remaining external blockers

ScoreCheck Pushover and both Healthchecks checks are configured. The
Healthchecks project still has only its email channel. The remaining provider
and operator prerequisites are:

1. Approval of the purchased SMS sender's A2P registration. A live test on
   2026-07-13 returned Twilio error `30034`, so production escalation remains
   disabled until a delivery test passes.
2. A Pushover channel on the Healthchecks project. Its Management API can list
   but cannot create integrations, so this requires one authenticated provider
   subscription in the Healthchecks UI.
3. Explicit operator approval and isolated test feeds for destructive fault
   injection, acknowledgement, escalation, and withheld-ping gates.
4. An existing production admin session for a production-browser visual pass;
   Vercel intentionally does not export the sensitive admin secret.

The exact deployed dashboard build passed local authenticated visual validation
against the live read-only monitor API at 1600x1000 and 390x844: eight cards,
four columns on wide desktop, no horizontal overflow, source profiles visible,
and no browser console warnings or errors.

Venue Wi-Fi root-cause telemetry remains limited to end-to-end ingest evidence
until specific camera or router APIs are selected and qualified. The monitor
must not claim RF or camera-encoder certainty without those sources.

## Next gates

1. Add an independent Healthchecks phone channel and an approved Twilio sender,
   then prove acknowledgement, one SMS escalation, recovery, and withheld-ping
   behavior in a scheduled test window.
2. Repeat the one-court test broadcast and inject every remaining row in the
   runbook table, including camera reconnect and subjective sync checks.
3. Replace the shared eight-feed normalizer topology, then run eight
   representative feeds across all four compositors for at least two hours,
   with scoring on all courts and at least two commentary rooms.
4. Preserve detection latency, unaffected-court evidence, duplicate count,
   recovery time, CPU/memory trends, and Supabase growth for every fault.
5. Only after these gates pass, accept monitoring as ready for the shadow event.
