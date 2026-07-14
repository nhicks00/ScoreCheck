# Camera 1 Media-Lifecycle Gate

Date: 2026-07-14
Status: media path, comparator, reader churn, loss detection, and operational recovery passed; recovery-notification causality failed and requires a monitoring fix plus bounded repeat

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

## Verdict And Required Follow-Up

Accepted:

- fail-closed Camera 1 publication through Speedify
- repaired raw -> preview -> delayed program lifecycle
- browser pacing comparison
- 50-cycle reader ownership and cleanup
- physical raw-loss detection, one opening page, deduplication, and court isolation
- physical publisher reconnection and profile continuity

Not accepted:

- feed-driven recovery paging
- completed-test Egress reconciliation

Before the next capacity phase, monitoring must distinguish dependency recovery
from expectation cessation. Incident closure caused by gate or event expiry
must persist that closure reason and must not emit a normal recovery page. After
deployment, repeat one short Camera 1 stop/restart inside an extended gate and
prove the recovery page follows raw readiness. Event teardown must also verify
zero active Egress jobs before infrastructure is considered idle.
