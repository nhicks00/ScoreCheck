# ScoreCheck Monitoring Telemetry Contract

Status: normative version 2 contract for the unified monitoring system.

## Invariants

1. Monitoring continues when every operator browser is closed.
2. Monitoring collection is read-only and never accepts production-control commands.
3. A stale or unavailable observation is `UNKNOWN`, never healthy.
4. High-frequency samples live in Prometheus, not Supabase.
5. Supabase stores expectations, incident transitions, acknowledgements, silences, notification receipts, and periodic fallback checkpoints.
6. Monitoring and production control are separate processes and deployment lifecycles.
7. No metric label, incident, notification, log, or URL contains a credential.
8. Court, branch, host role, service, protocol, state, and bounded issue code are the only variable metric dimensions.
9. Team names, participant names, remote addresses, connection IDs, container IDs, and error text are never Prometheus labels.
10. A downstream symptom may be inhibited for paging, but it remains visible as incident evidence.
11. Compositor court ownership is declared in central target configuration and
    repeated by the host agent. A mismatch rejects the sample without replacing
    the last known-good snapshot.

## Versioning

Every agent snapshot and monitor API response contains:

```json
{ "version": 2 }
```

Version 2 is a hard cutover across the web producer, host agents, monitor API,
and dashboard. Removing or changing field meaning requires a new version.
Version 1 is rejected; no compatibility shim is maintained.

## Stages

The bounded stage vocabulary is:

```text
VENUE
RAW_INGEST
PREVIEW
PROGRAM_PATH
PROGRAM_BROWSER
COMMENTARY
SCORE_SOURCE
SCORE_RENDER
EGRESS
YOUTUBE
HOST
CONTROL
MONITORING
NOTIFICATION
```

## Health states

```text
EXPECTED_OFF
STARTING
HEALTHY
DEGRADED
CRITICAL
RECOVERING
UNKNOWN
MAINTENANCE
NOT_APPLICABLE
```

`UNKNOWN` outranks `HEALTHY` for operator attention. It does not automatically outrank a supported `CRITICAL` condition.

## Expected-state dimensions

```text
coverage_phase: OFF | WARMUP | LIVE_MATCH | INTERMISSION | FINAL_HOLD | TEARDOWN
media_expectation: OFF | WARM | REQUIRED
broadcast_expectation: OFF | TESTING | LIVE
commentary_expectation: NONE | OPTIONAL | REQUIRED
scoring_expectation: NONE | SCHEDULED | LIVE | FINAL_HOLD
```

Every manual override includes `createdBy`, `createdAt`, `reason`, and `expiresAt`.

## Agent roles

```text
mediamtx
commentary
compositor
worker
venue
observability
```

Each host runs one `scorecheck-monitor-agent`. The agent:

- Reads only allowlisted loopback APIs and metrics endpoints.
- Reads allowlisted Docker container state from the local socket.
- Exposes a normalized Prometheus endpoint.
- Exposes a sanitized current snapshot.
- Sends bounded lifecycle events to the correlator when configured.
- Does not expose a shell, arbitrary proxy, arbitrary file read, arbitrary query, or mutation endpoint.

Compositor agents also publish their bounded `assignedCourts` list. Central
targets persist the same ownership, so attribution survives an observability
restart while a compositor is unreachable. The current two-court topology is
A=1–2, B=3–4, C=5–6, and D=7–8. A court may be owned by exactly one compositor;
replacement hosts must register ownership explicitly.

## Stable metric labels

Allowed labels:

```text
agent
host
role
service
court
branch
protocol
state
stage
issue_code
```

All values are normalized to `[a-zA-Z0-9_.:-]{1,80}`. Unknown or untrusted values are dropped rather than escaped into labels.

## Core agent metrics

```text
scorecheck_agent_up
scorecheck_agent_collection_duration_seconds
scorecheck_agent_collection_errors_total
scorecheck_host_uptime_seconds
scorecheck_host_load1
scorecheck_host_memory_total_bytes
scorecheck_host_memory_available_bytes
scorecheck_host_disk_total_bytes
scorecheck_host_disk_free_bytes
scorecheck_service_running
scorecheck_service_healthy
scorecheck_service_restart_total
scorecheck_service_oom_killed
scorecheck_service_memory_usage_bytes
scorecheck_service_memory_limit_bytes
scorecheck_service_cpu_ratio
scorecheck_media_path_ready
scorecheck_media_path_readers
scorecheck_media_path_bytes_received_total
scorecheck_media_path_bytes_sent_total
scorecheck_media_path_inbound_bitrate_bps
scorecheck_media_path_frame_errors_total
scorecheck_media_transport_metrics_available
scorecheck_media_transport_rtt_ms
scorecheck_media_transport_packets_received_total
scorecheck_media_transport_packets_lost_total
scorecheck_media_transport_packets_retransmitted_total
scorecheck_media_transport_packets_dropped_total
scorecheck_media_transport_receive_rate_bps
scorecheck_media_transport_receive_buffer_ms
scorecheck_media_transport_configured_latency_ms
scorecheck_native_endpoint_up
scorecheck_compositor_court_assignment
scorecheck_egress_idle
scorecheck_egress_metrics_valid
scorecheck_egress_can_accept_request
scorecheck_egress_cgroup_memory_bytes
scorecheck_egress_cpu_load_ratio
scorecheck_egress_memory_load_ratio
```

`scorecheck_egress_idle` is an activity signal derived from LiveKit Egress
`livekit_egress_available`: `1` means no active request and `0` means the worker
is busy. It is not a health signal. Egress health is derived from endpoint
reachability and required-metric validity; admission capacity is reported
separately by `scorecheck_egress_can_accept_request`.

Counters remain cumulative. Prometheus recording rules derive rates.

Media path snapshots also carry bounded source protocol and mode, video/audio
codec, source dimensions/profile, audio sample rate/channel count, and nullable
transport quality. MediaMTX path details are fetched once per ready epoch and
cached, rather than polled per path every five seconds; failed detail requests
retry no more than once every 30 seconds. SRT connection quality
is collected from one host-local list request per agent interval. Pull-mode SRT
sources may not expose per-connection transport counters in MediaMTX and remain
explicitly nullable rather than inferred as healthy.

## Program-browser and content metrics

The program page reports bounded WebRTC and rendered-content evidence through
its five-second heartbeat. This is supplemental to browser-independent host
collection: a missing browser heartbeat is never inferred as healthy.

```text
rendered FPS and dimensions
inbound RTP jitter and jitter-buffer delay
packets received/lost and most-recent-packet age
frames received/decoded/dropped and keyframes decoded
freeze count and cumulative freeze duration
NACK, PLI, and FIR counts
reconnect and page-reload counts
mean luma, luma variance, dark-pixel ratio, and inter-frame difference
continuous repeated-picture and black-picture duration
commentary room, participant, track, mute, level, clipping, silence, packet,
jitter-buffer, sync-lock, delay-gap, clock-RTT, and timing-sample evidence
camera audio track, level, peak, clipping, and silence evidence
```

Current-page WebRTC counters are exposed as gauges for direct forensic
inspection. The monitor also converts received frames, decoded frames, dropped
frames, freeze count, and freeze duration into reset-safe Prometheus counters.
Baselines are isolated by court and page-load identity; page reloads and
peer-connection counter decreases re-baseline instead of creating false
increments. Two-minute recording rules derive decode-drop and frozen-time
ratios. Live-court alert rules require at least twelve source samples and
meaningful frame volume before warning at 0.5 percent decode loss or 1 percent
frozen time, and before paging at 5 percent decode loss or 10 percent frozen
time.

Visual analysis samples the already-decoded camera element once per second at
160x90. It does not create another media connection or decoder. A frame is a
black-picture candidate only when at least 97 percent of sampled pixels have
luma at or below 16, mean luma is at most 16, and luma variance is at most 40.
An inter-frame mean luma difference at or below 0.8 is a repeated-picture
candidate. During `LIVE_MATCH`, repeated content is warning evidence after five
seconds and critical after fifteen; black content is critical after twenty.
Black and repeated-picture pages are mutually exclusive.

Because a genuinely static camera view can resemble a repeated encoder frame,
the operator must confirm the current thumbnail before changing equipment. The
alert is high-value during volleyball play but is not proof of a specific
camera defect by itself.

Audio meters sample every 500 ms and define non-silence as RMS above -52 dBFS.
Silence age starts when a live track first appears, even if no audible sample is
ever observed. A required live track is warning evidence after 60 seconds of
silence; a clipped-sample ratio above five percent is warning evidence. Missing
or muted required commentary tracks are classified separately from silence and
clipping. Recent packet loss is calculated in Prometheus over one minute;
cumulative loss remains evidence only and cannot hold a recovered track in a
permanent degraded state.

## Paging inhibition

Inhibition is same-court or same-host unless the source is an explicitly shared
dependency. Raw ingest outranks branch/browser/YouTube symptoms; program branch
outranks browser/render/YouTube; program browser outranks render/YouTube;
commentary room connectivity outranks commentary track/quality/network/sync;
agent reachability outranks matching host-service symptoms; YouTube unhealthy
outranks YouTube degraded. `SCORE_WORKER_UNAVAILABLE` is the only initial
court-independent source and may inhibit all per-court source-alignment pages.

The inhibition configuration is accepted only after a disposable Alertmanager
proves source activity, target suppression, and an unaffected peer for every
scope. Inhibited downstream stages remain in the monitor snapshot and dashboard.

## Snapshot freshness

Every observation includes both source observation time and collector receipt time where available.

Default freshness:

| Source | Fresh | Degraded visibility | Unknown |
| --- | ---: | ---: | ---: |
| Agent snapshot | <=10 s | <=20 s | >20 s |
| Program browser | <=10 s | <=15 s | >15 s |
| Media path sample | <=10 s | <=20 s | >20 s |
| YouTube API | <=90 s | <=180 s | >180 s |
| Supabase checkpoint | never live truth | always marked fallback | unavailable |

## Incident fingerprint

The deterministic fingerprint input is:

```text
eventId | rootDependency | stage | courtOrHost | issueCode
```

Timestamps and mutable message text are excluded.

The fingerprint identifies a problem class, not a lifetime database row. Only
one non-resolved incident may exist for a fingerprint. Continuing samples and
service restarts retain that active incident UUID. A recurrence after
resolution creates a new incident UUID and `OPENED` event, even when the
fingerprint is identical. Notification uniqueness is scoped to
`incident_id + provider + notification_kind`, so delivery deduplicates within
an episode while preserving independent opening and recovery receipts for each
recurrence.

The monitor service fails closed at startup unless the database advertises the
episode contract. Schema migration 022 must therefore be applied immediately
before the matching service rollout during one bounded idle cutover; mixed
old-service/new-schema and new-service/old-schema states are unsupported.

## Incident closure semantics

An Alertmanager `resolved` transition is not, by itself, proof that a monitored
dependency recovered. Monitor-service classifies and persists every closure as
one of:

- `DEPENDENCY_RECOVERED`: current evidence proves the dependency was healthy at
  the alert resolution time;
- `FAULT_GATE_EXPIRED` or `FAULT_GATE_ENDED`: an intentional test expectation
  ceased while the dependency was not proven healthy;
- `EXPECTATION_ENDED`: production expectations ceased while the dependency was
  not proven healthy; or
- `ALERT_CLEARED_UNVERIFIED`: the alert cleared without enough recovery evidence.

The closure kind, reason, expectation source, gate expiry, and current raw-path
evidence are written to both the durable incident evidence and its `RESOLVED`
event. A normal recovery notification is allowed only for
`DEPENDENCY_RECOVERED`. Ending an expectation cancels an outstanding emergency
repeat but must never tell the operator that the feed is back.

## Monitor API

Publicly reachable routes are limited to:

```text
GET  /healthz
GET  /v1/snapshot
GET  /v1/incidents/:id
GET  /v1/range/court-pipeline
GET  /v1/courts/:courtNumber/thumbnail
GET  /v1/fault-gates
POST /v1/browser-heartbeats
POST /v1/browser-thumbnails
POST /v1/alertmanager
POST /v1/incidents/:id/acknowledge
POST /v1/silences
POST /v1/fault-gates/courts/:courtNumber/arm
DELETE /v1/fault-gates/courts/:courtNumber
```

Range queries use allowlisted names, bounded time windows, and bounded resolution. Arbitrary PromQL is forbidden.
The initial `court-pipeline` query returns only raw bitrate, preview FPS, and
program FPS for courts 1–8, with a maximum of 240 samples per series.

The snapshot includes separate paging-provider and external dead-man health.
Dead-man check mode is bounded to `NOT_CONFIGURED`, `UNKNOWN`, `RUNNING`, or
`PAUSED`; an intentional idle pause is healthy, while a failed ping or pause is
degraded. `deadMan.phoneChannel` separately reports whether the required
Healthchecks Pushover integration is attached to the baseline and active checks,
the last successful read-only audit, and the last audit failure. The audit runs
every five minutes and retries provider failures after thirty seconds. It makes
one channel-list request and one check request per configured check; it never
writes provider configuration or Supabase telemetry. Ping URLs, check ids,
integration ids and names, and API keys are never returned.

Silences require at least one bounded event, court, stage, or issue-code scope,
an operator, a reason, and an expiry no more than 24 hours away. They suppress
notifications only. Incidents and degraded stage health remain visible, and a
still-active critical condition re-arms primary paging when the silence expires.

## Browser heartbeat security

Browser heartbeats require a court-scoped, short-lived credential and include:

```text
credentialId
courtNumber
heartbeatSeq
sampledAt
pageLoadedAt
pageBuildVersion
configurationVersion
```

The gateway rejects:

- Invalid signatures.
- Court mismatch.
- Timestamps outside the replay window.
- Non-increasing sequence numbers for an active credential.
- Payloads over the configured byte limit.
- Unknown fields when the schema marks them forbidden.

## Secret and cardinality prohibitions

Never emit:

```text
YouTube stream keys
RTMP publish credentials
program-page tokens
LiveKit tokens or API credentials
Supabase service credentials
camera credentials
Pushover/Twilio credentials
Healthchecks ping URLs
full private ingest URLs
query strings from browser exceptions
```

## Phase 0 gate

The gate passes when:

- Contract types and parsers have automated tests.
- The agent emits only allowlisted labels.
- Agent snapshots contain no remote address, connection ID, token, or arbitrary error text.
- The monitor service marks a missing agent `UNKNOWN`.
- Monitoring processes can run with the browser closed.
