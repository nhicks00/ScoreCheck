# Camera 1 Media-Lifecycle Gate

Date: 2026-07-14
Status: passed; comparator, reader churn, durable repeat detection, feed-driven recovery paging, same-page viewer continuity, ordered recovery, and subjective sync accepted

## Baseline

Camera 1 published through the fail-closed Speedify route. MediaMTX observed the
Speedify exit as the RTMP source rather than the direct mobile exit. The source
profile was H264 Main, 1920x1080 at 60 fps, with AAC 48 kHz stereo audio and
approximately 6.0-6.3 Mbps of inbound traffic. Frame-error counters were zero.

The venue route retained the required Speedify interface, policy table, guard
table, firewall kill switch, and exactly one watchdog. Ordinary non-camera
traffic remained on the normal route.

## MediaMTX Hook Repair

The first comparator attempt exposed a deployment regression in every derived
path hook. MediaMTX was configured to direct-execute hook strings that began
with shell builtins (`while` and `exec`), producing `executable file not found`
and preventing preview/program startup.

The hard-cutover repair moved readiness waiting into
`scorecheck-ffmpeg-runner.sh` and made every MediaMTX hook direct-execute that
owned lifecycle runner. The updated runner passed shell syntax, readiness,
eight signal-cycle, early-failure cleanup, rendered-YAML, and direct-command
tests. Deployment recreated only the MediaMTX container. Post-deploy health was
healthy with zero restarts, hook errors, frame errors, and zombie children.

## Stale Egress Finding

Three LiveKit Egress jobs from the completed July 13 soak were still active on
compositors A, B, and C, consuming Courts 1, 3, and 5 program WHEP paths even
though monitoring reported no active event and broadcast output was expected
off. All three stale jobs were stopped before isolated testing. All four Egress
workers then reported idle and the stale WHEP sessions cleared. No StreamRun,
camera-routing, or event configuration was changed.

This is a lifecycle and cost-control defect: completed test output must be
explicitly reconciled to zero instead of relying on event expectation state.

## Preview A -> Program -> Preview B

The accepted run began only after the prior program branch and all WHEP readers
fully retired. Exactly one WHEP reader was mounted in each phase.

| Phase | FPS | Dropped | Frozen | Jitter buffer | RTP loss |
| --- | ---: | ---: | ---: | ---: | ---: |
| Preview A | 30.0 | 0.00% | 0.00% | 204 ms | 0.00% |
| Program | 30.0 | 0.00% | 0.00% | 219 ms | 0.00% |
| Preview B | 30.0 | 0.00% | 0.00% | 235 ms | 0.00% |

The browser classified the comparison healthy. At completion, WHEP sessions
returned to zero, the program path retired, and MediaMTX remained at zero hook
errors, frame errors, and zombie children.

## Reader Churn

An initial stress pass used a 1.2-second inter-cycle delay and was discarded
after the sampler observed transient overlap while MediaMTX retired the prior
closed peer. This established that a local `RTCPeerConnection.close()` is not
an instantaneous server-side release boundary.

The accepted run used a 3.5-second release barrier and the product's WHEP
handshake. It completed 50/50 connections with no failures:

- 25 `court1_preview` sessions
- 25 `court1_program` sessions
- 50/50 sessions closed
- maximum active WHEP sessions: 1
- overlap events: 0
- final WHEP sessions: 0
- final MediaMTX zombie children: 0

## Physical Loss And Recovery

The monitor-only raw expectation was armed at `14:27:48.091Z`. Camera 1 raw
loss was first observed at `14:35:17.972Z`. The durable critical incident
opened at `14:35:35.709Z`, and one Pushover opening page was delivered at
`14:35:42Z`, 24 seconds after observed loss. A secondary low-bitrate warning
did not page. Cameras 2-8 remained expected off and received no incident.

Nathan acknowledged restart at `14:38:10Z`. MediaMTX recorded raw readiness at
`14:38:08.290Z`, and the monitor reported healthy positive bitrate by
`14:38:18.046Z`. The same Speedify source identity and H264 Main 1080p60 plus
AAC 48 kHz stereo profile returned. Both Camera 1 incidents were absent from
the active snapshot by `14:38:20.725Z`; frame errors remained zero.

Operational media recovery therefore passed. Recovery-notification causality
did not pass: the fault gate expired at `14:37:48Z`, Alertmanager resolved the
alerts at `14:38:00.709Z`, and Pushover accepted a recovery notification at
`14:38:11.401Z`, before monitor-confirmed raw health. The expectation expiry,
not observed feed recovery, caused that notification.

## Incident-Episode Repeat

After deploying migration `022` and the matching incident-episode service, a
fresh raw-only gate was armed from a healthy Camera 1 baseline at
`21:04:34.862Z`. Camera 1 was stopped at `21:06:21.419Z`.

- A new `REQUIRED_RAW_PATH_MISSING` episode opened at `21:06:30.709Z`, with a
  durable `OPENED` event at `21:06:35.724Z`.
- Exactly one opening Pushover was accepted at `21:06:36.115Z`.
- The expected non-paging `RAW_BITRATE_LOW` episode opened separately.
- Durable counts advanced by two incident episodes, two opening events, and one
  notification. Cameras 2-8 remained expected off with no incident.

Camera 1 republished with the same RTMP push, H264 Main 1920x1080, and AAC
48 kHz stereo identity at 6.15-6.24 Mbps with zero frame errors. Both episodes
resolved from observed feed recovery at `21:08:10.709Z`; their durable recovery
events were recorded at `21:08:20.722Z` and `21:08:35.724Z`. Exactly one
recovery Pushover was accepted at `21:08:36.201Z`.

MediaMTX's raw-ready timestamp preceded the corrected physical restart
acknowledgement by 8.752 seconds, so this run does not establish a meaningful
physical restart-to-ready latency. It does establish feed-driven closure,
per-occurrence durability, opening/recovery notification deduplication, and
peer-court isolation. After explicit disarm, no additional closure notification
appeared and Camera 1 remained healthy.

## Foreground Viewer Loss And Recovery

A normal foreground Safari viewer established a clean pre-loss baseline. The
same page remained playing and connected for a 130-second acceptance window and
an additional 15-minute watch. It held 30 fps, zero frame drops, zero RTP loss,
no reconnects or reloads, and exactly one reader on each raw, preview, and
program path. Cameras 2-8 had no readers or incidents.

The operator stop acknowledgement was approximately `22:17:17Z`, but server
logs place Camera 1 RTMP EOF and raw/downstream retirement at `22:17:08.238Z`
through `22:17:08.267Z`. Because the media event preceded the approximate
operator acknowledgement by 8.7 seconds, no technical stop-to-detection latency
is claimed. Safari visibly showed the interruption slate and heartbeat remained
available, while all three media paths retired and peer courts stayed isolated.

Same-page continuity failed. The original Safari page reloaded repeatedly while
the source was absent, and recovery occurred on a new page identity. Its reload
diagnostic also reset from a previously observed nonzero value to zero, making
that page-local counter non-authoritative.

From the restart acknowledgement at approximately `22:19:31Z`, recovery was
ordered and clean:

- raw ready at `22:19:32.237Z` (+1.237 seconds)
- preview ready at `22:19:36.353Z` (+5.353 seconds)
- program ready at `22:20:05.660Z` (+34.660 seconds)
- Safari WHEP established at `22:20:06.457Z` (+35.457 seconds)
- stable 30 fps playback by `22:20:13.774Z`

Retry overlap briefly produced three program readers, then drained to exactly
one by `22:20:18.942Z`. The recovered page remained at 30 fps with zero drops,
freezes, RTP loss, or frame errors through `22:42:40Z`. Raw, preview, and program
each held exactly one reader; Cameras 2-8 remained isolated and monitoring opened
no incident or fault gate.

The hard cutover removed the Program page's full-reload escalation, limited
remounts to foreground connected presentation stalls, preserved tab-lineage
reconnect/reload counters, and serialized WHEP teardown and retry ownership.
Its local production build and forced-WHEP-unavailable browser simulation
passed: the same page/time origin held, the slate appeared, reload count
remained fixed, reconnect count advanced, recovery returned to one connected
WHEP session, and the temporary test reader retired. The production physical
acceptance below closes the remaining deployment gate.

## Deployed Same-Page Acceptance

The Program viewer hard cutover was deployed in production build
`d6d324eefe6e0712b03d6ed22cacc39b49d42232`. A follow-up copy-only deployment,
`5e6fc1c42b2cfe4450dbdbd283add260dd93fa1f`, added the viewer-facing notice
that Nathan had been alerted and was working on camera recovery. The final
physical cycle used that exact build on one foreground Safari page loaded at
`23:04:54.741Z`.

The accepted pre-stop window rendered 3,886 frames over 130.104 seconds
(29.868 fps aggregate). The page was playing and connected, reload count held
at 2, reconnect count held at 9, browser drop/freeze/RTP-loss counters stayed
zero, and raw, preview, and program each had exactly one reader. Isolated
integer samples at 28 and 31 fps were cadence quantization; neither coincided
with a counter or rendered-frame defect.

MediaMTX recorded the physical-loss sequence before the delayed operator
acknowledgement, so no stop-to-detection latency is claimed:

- Camera 1 RTMP publisher EOF at `23:48:47.407Z`
- preview path destroyed at `23:48:47.433Z`
- program path destroyed at `23:48:47.434Z`
- operator acknowledgement received at `23:48:59.543Z`

The same Safari page and build survived the full outage. It displayed the exact
updated interruption slate with a fresh heartbeat, frozen rendered frame count,
and reload count fixed at 2. Reconnect count advanced on a bounded cadence.
Direct MediaMTX samples showed at most one zero-byte WHEP retry session at a
time, with complete drainage between cycles. Cameras 2-8 had no readers and no
monitoring fault gate or incident was created.

Recovery was ordered by server timestamps:

- RTMP connection opened at `23:53:31.039Z`
- raw ready at `23:53:35.188Z`
- preview ready at `23:53:39.301Z`
- final Safari WHEP session created at `23:54:00.454Z`
- program ready at `23:54:09.097Z`

Raw and preview were already ready before the `23:53:42.865Z` restart
acknowledgement, so no receipt-based latency is inferred for them. Program was
ready 26.232 seconds after that receipt. The original page returned to playing
without reloading; reload count remained 2 and reconnect count stabilized at
18. The final WHEP session was the sole positive-byte program reader.

The reset-safe stable window rendered 6,606 frames over 220.177 seconds
(30.003 fps aggregate). Drops and RTP loss stayed zero. Initial WHEP recovery
produced exactly two brief freezes totaling 895 ms before the formal baseline;
those counters did not grow during the stable window. Raw, preview, and program
finished ready with positive bitrate, reader counts 1/1/1, and frame errors
zero. Nathan accepted a foreground clap test as subjectively synchronized.

## Verdict And Required Follow-Up

Accepted:

- fail-closed Camera 1 publication through Speedify
- repaired raw -> preview -> delayed program lifecycle
- browser pacing comparison
- 50-cycle reader ownership and cleanup
- physical raw-loss detection, one opening page, deduplication, and court isolation
- physical publisher reconnection and profile continuity
- repeat incident persistence and feed-driven recovery paging
- visible interruption slate, ordered media recovery, post-recovery endurance,
  and peer isolation
- same-page/no-reload continuity through physical source loss and recovery
- sequential WHEP retry ownership and final sole-reader drainage
- reset-safe post-recovery quality and subjective audio/video sync

Not accepted:

- completed-test Egress reconciliation
- final camera-side normalization and multi-court resource capacity
- venue qualification at the required 75 Mbps bonded-upload floor

Phase 1 is complete. Proceed to the checked-in 30-minute one-court `c-4`
capacity gate, then qualify the final camera-side or isolated-normalizer topology
before any direct-eight soak. Event teardown must also verify zero active Egress
jobs before infrastructure is considered idle.
