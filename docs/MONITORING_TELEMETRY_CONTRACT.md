# ScoreCheck Monitoring Telemetry Contract

Status: normative version 1 contract for the unified monitoring system.

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

## Versioning

Every agent snapshot and monitor API response contains:

```json
{ "version": 1 }
```

Version 1 may add optional fields. Removing or changing field meaning requires a new version.

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
scorecheck_native_endpoint_up
```

Counters remain cumulative. Prometheus recording rules derive rates.

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

## Monitor API

Publicly reachable routes are limited to:

```text
GET  /healthz
GET  /v1/snapshot
GET  /v1/incidents/:id
GET  /v1/range/:queryName
POST /v1/browser-heartbeats
POST /v1/provider-callbacks/:provider
POST /v1/incidents/:id/acknowledge
POST /v1/silences
```

Range queries use allowlisted names, bounded time windows, and bounded resolution. Arbitrary PromQL is forbidden.

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

