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
| Media transport telemetry | MediaMTX raw/preview/program readiness, bitrate, codecs, frame errors, readers, FFmpeg progress | Deployed and passing |
| Program render telemetry | FPS, dimensions, RTP loss/jitter, frames, packet age, feedback counters, reconnects, reloads | Implemented; real-feed revalidation pending |
| Full-bitrate repeated-picture detection | Existing decoded element sampled at 160x90/1 Hz; warning/critical correlator and alert rules | Unit and deterministic fault gate passing; real fault pending |
| Black/covered-picture detection | Luma, dark ratio, variance, persistence; mutually exclusive with freeze paging | Unit and deterministic fault gate passing; real fault pending |
| Camera and commentary audio quality | Track/mute, RMS/peak, clipping, silence age, RTP loss/jitter, adaptive sync evidence | Implemented; real audio fault gate pending |
| Score and overlay alignment | Current match, source score, persisted overlay, rendered DOM signatures, exact 67-67 invalid-state checks | Deployed and passing fixtures |
| Infrastructure and Egress attribution | Host/container health, capacity, assigned court pair, mapping mismatch rejection | Deployed; restart-during-outage fixture passing |
| YouTube health | Exact configured video IDs, lifecycle, ingestion health when OAuth is available, API failure remains unknown | Deployed; provider fault gate pending |
| Durable incidents and operator actions | Fingerprints, open/ack/resolved transitions, checkpoints, acknowledgements, timed silences, expiry re-arm | Deployed and unit-tested |
| Phone paging | Pushover emergency acknowledgement plus Twilio SMS escalation and recovery logic | Code complete; credentials and delivery gate pending |
| Independent dead-man | Baseline and active Healthchecks senders with coverage-aware cadence | Code complete; provider URLs and withheld-ping gate pending |
| One-court real fault gate | Camera, network, preview, browser, commentary, score, Egress, YouTube, agent, dead-man faults | Pending test session |
| Eight-court real load/fault gate | Four compositors, eight representative feeds, two commentary rooms, score on all courts | Pending hardware/feed session |

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

## Remaining external blockers

The following protected values are not configured and cannot be invented by the
application:

```text
PUSHOVER_APP_TOKEN
PUSHOVER_USER_KEY
TWILIO_ACCOUNT_SID
TWILIO_AUTH_TOKEN
TWILIO_FROM_NUMBER
TWILIO_TO_NUMBER
HEALTHCHECKS_BASELINE_PING_URL
HEALTHCHECKS_ACTIVE_PING_URL
```

An authenticated production-browser visual pass also needs an existing admin
session. Venue Wi-Fi root-cause telemetry remains limited to end-to-end ingest
evidence until specific camera or router APIs are selected and qualified; the
monitor must not claim RF or camera-encoder certainty without those sources.

## Next gates

1. Configure Pushover, Twilio, and two independent dead-man checks; prove primary,
   escalation, acknowledgement, recovery, and withheld-ping behavior.
2. Run the one-court test broadcast and inject every row in the runbook table.
3. Run eight representative feeds across all four compositors for at least two
   hours, with scoring on all courts and at least two commentary rooms.
4. Preserve detection latency, unaffected-court evidence, duplicate count,
   recovery time, CPU/memory trends, and Supabase growth for every fault.
5. Only after these gates pass, accept monitoring as ready for the shadow event.
