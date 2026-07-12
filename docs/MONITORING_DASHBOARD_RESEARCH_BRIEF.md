# ScoreCheck Unified Monitoring Dashboard Research Brief

Status: architecture and research handoff only. No implementation is approved by this document.

Prepared for: external architecture review and research before build approval

## 1. Purpose

ScoreCheck needs one admin page that an operator can leave open during an event and understand within roughly ten seconds. It must monitor all eight court pipelines, identify the failing stage, and notify the operator's phone immediately when a significant problem occurs, including while the operator is away from the laptop.

The monitor must cover five related but independent concerns:

1. Camera and venue-network ingest health.
2. Media processing, compositor, egress, and destination health.
3. Remote commentator connectivity, audio quality, and synchronization.
4. Scoreboard, match identity, queue, and VolleyballLife alignment.
5. The health of the monitoring and notification systems themselves.

The research goal is to validate or improve the proposed architecture, metrics, thresholds, notification strategy, storage model, security model, and phased implementation before any production build begins.

## 2. Current-System Assumptions to Validate

This proposal assumes the dashboard belongs in the existing ScoreCheck Next.js admin application rather than a separate application.

The current pipeline is understood as:

```text
VENUE
Mevo/other cameras -> venue Wi-Fi or bonded router -> RTMP ingest

INGEST AND PREVIEW
MediaMTX
  courtN_raw -> courtN_preview -> courtN_program

COMMENTARY
Self-hosted LiveKit room per court
  commentator browser microphone -> LiveKit -> program scene

PROGRAM
Browser-based program scene
  delayed program video + camera audio + commentary + DOM scorebug
  -> LiveKit Web Egress -> YouTube RTMPS

SCORING
VolleyballLife live/bracket data -> ScoreCheck worker -> Supabase
  -> score state + overlay state -> rendered scorebug

CONTROL
ScoreCheck admin + production controller + DigitalOcean infrastructure
```

The expected production scale is eight simultaneous courts. The current code already has:

- `/admin/production`, with per-court preview, current match, score, worker state, program heartbeat, controller status, and MediaMTX reachability.
- A five-second `program_heartbeats` upsert containing video state, rendered frame count, commentary room/track state, audio meters, and commentary synchronization telemetry.
- MediaMTX Control API and Prometheus-compatible metrics enabled on loopback.
- LiveKit Prometheus metrics enabled.
- A production controller that can list, start, and stop egresses.
- Supabase current match, queue, score, overlay, worker heartbeat, and program heartbeat state.
- WebRTC timing collection in the stream player.

Relevant implementation references:

- `apps/web/src/app/admin/production/ProductionConsoleClient.tsx`
- `apps/web/src/lib/productionStatus.ts`
- `apps/web/src/app/api/program/heartbeat/route.ts`
- `apps/web/src/app/program/court/[courtNumber]/ProgramClient.tsx`
- `apps/web/src/components/StreamPlayer.tsx`
- `infra/mediamtx/mediamtx.template.yml`
- `infra/commentary/livekit.template.yaml`
- `infra/controller/src/index.ts`
- `docs/PRODUCTION_PLATFORM_PLAN.md`
- `docs/COMMENTARY_WORKFLOW.md`

## 3. Product Goals

The monitoring experience should:

- Show all eight courts on one laptop screen with stable court positions.
- Detect a camera disconnect, frozen image, low bitrate, low FPS, black frame, audio loss, or unstable ingest.
- Separate camera/venue problems from ingest, transcode, compositor, commentary, scoreboard, egress, and YouTube failures.
- Show live team names, score, match number, round, current set, and source age.
- Prove that the scorebug actually rendered the intended match and score, not merely that Supabase contains correct data.
- Account for intentional score delay and final-score hold behavior before declaring a mismatch.
- Show commentary presence, microphone track state, levels, clipping/silence, network quality, reconnects, and synchronization confidence.
- Detect shared failures without producing eight duplicate alerts.
- Provide a concise diagnosis and recommended first action.
- Send actionable phone notifications with deep links to the affected court.
- Continue alerting if the monitoring server, controller, primary VPS, or ScoreCheck application itself fails.
- Avoid adding significant load to the production media path.
- Avoid high-frequency raw telemetry writes to Supabase.
- Remain read-only by default during live coverage.

## 4. Non-Goals for the First Version

- Automatic repair or restart of production systems.
- Automatic camera reconfiguration.
- Automatic StreamRun or YouTube lifecycle changes.
- A replacement for Prometheus/Grafana as a general-purpose infrastructure explorer.
- An opaque numerical health score.
- Claiming a specific root cause when the available telemetry only supports a broader classification.

Automated remediation should be designed only after fault-injection evidence proves that each action is safe and idempotent.

## 5. Important Diagnostic Limitation

Cloud-side telemetry can prove that a camera's ingest became irregular, slow, frozen, or unavailable before reaching MediaMTX. It cannot reliably distinguish among camera encoder failure, camera Wi-Fi, venue LAN, bonded-router behavior, or venue WAN without venue-side telemetry.

Therefore:

- With router/camera telemetry, the UI may report a supported diagnosis such as `Camera Wi-Fi degradation likely` and show evidence.
- Without router/camera telemetry, the UI must report `Upstream ingest degradation` and must not claim that Wi-Fi is definitively responsible.

Research must identify what APIs, SNMP data, or device telemetry are available from the actual camera and router models.

## 6. Proposed Architecture

```text
VENUE-SIDE SIGNALS
Camera/router agent (optional but strongly recommended)
  RSSI, retries, WAN utilization, link state, latency, loss, carrier health
                         |
MEDIA AND APPLICATION SIGNALS
MediaMTX metrics/API/hooks
FFmpeg progress exporter
LiveKit metrics/webhooks/Room API
LiveKit Egress metrics/API
Program-scene heartbeats
ScoreCheck worker observations
Supabase match/queue/score/overlay state
YouTube Live Streaming API
Node exporter + container metrics
                         |
PRIVATE COLLECTION PLANE
Prometheus-compatible time-series collection
Structured event collector
ScoreCheck correlation service
Alertmanager
                         |
CURRENT HEALTH SNAPSHOT + INCIDENTS
Authenticated monitoring API
Durable incident transitions and acknowledgements in Supabase
                         |
OPERATOR SURFACES
/admin/monitor
Phone push notification
SMS escalation
External dead-man and uptime monitor
```

### 6.1 Dedicated observability host

The preferred topology is a small, separate observability VPS. It should not run on the MediaMTX, LiveKit, or compositor host because a host failure must not remove the monitor responsible for diagnosing that host.

The observability host should contain:

- Prometheus or a validated compatible time-series database.
- Alertmanager.
- A ScoreCheck telemetry/correlation service.
- An authenticated snapshot and range-query API.
- Optional log aggregation after metrics and incidents are stable.

An external provider must monitor this host from outside ScoreCheck. A self-hosted system cannot independently report its own total outage.

### 6.2 Collection security

- MediaMTX, LiveKit, Egress, node, and container metric endpoints remain private.
- Prefer DigitalOcean VPC networking or an authenticated private tunnel.
- Do not expose Prometheus, MediaMTX Control API, LiveKit API, or container metrics directly to the public internet.
- Vercel calls the monitoring API server-side using a protected service credential.
- Browser clients receive only sanitized court health and incident data.
- No YouTube stream key, camera publish password, LiveKit API secret, Supabase service key, or program-page credential may enter telemetry labels, logs, incident text, URLs, or browser payloads.

## 7. Telemetry by Failure Domain

### 7.1 Camera and raw ingest

Collect per court:

- Expected on/off state.
- Raw path ready state and readiness duration.
- Publisher connection state and connection age.
- Last packet/byte arrival age.
- Instantaneous and rolling inbound bitrate.
- Bitrate target, baseline, volatility, and deviation.
- Input FPS and rolling FPS.
- Codec, profile, resolution, frame rate, audio codec, and channel count.
- Keyframe interval/GOP length.
- Frame and packet parse errors.
- Reconnect count, disconnect duration, and time since last reconnect.
- Input audio presence and bitrate.
- Camera-audio RMS, peak, clipping, and silence age.
- Frozen-frame duration, black-frame likelihood, luminance, and image-change rate.

MediaMTX exposes path state, readers, byte counters, inbound frame errors, and protocol-specific metrics. Bitrate should be computed from the rate of byte-counter change rather than stored as a separate untrusted value.

MediaMTX does not expose all desired input FPS, GOP, visual-freeze, and image-content diagnostics directly. Research should compare these instrumentation strategies:

- Emit FFmpeg `-progress` telemetry from the existing normalization process.
- Add a lightweight packet/frame parser that avoids video decode.
- Add low-rate visual frame sampling for black/freeze detection.
- Avoid a separate full decode for every monitor metric if the existing FFmpeg graph can emit the same data.

### 7.2 Venue network and camera-side evidence

If supported by the deployed equipment, collect:

- Camera Wi-Fi RSSI/SNR.
- PHY rate/MCS and band/channel.
- Access-point retransmission and retry rate.
- Camera association/disassociation events.
- Router interface utilization and queue drops.
- Bonded-link member status and per-carrier traffic.
- WAN latency, jitter, packet loss, and DNS reachability.
- Upload utilization versus tested upload capacity.
- Camera battery, temperature, encoder state, and storage state where available.

This likely requires a small venue agent that pushes signed telemetry outbound over HTTPS because venue networks are usually behind NAT.

### 7.3 MediaMTX preview and program branches

Collect per court and branch:

- Raw, preview, and program path readiness.
- Branch process PID, age, restart count, and exit reason.
- FFmpeg input FPS, output FPS, processing speed, output bitrate, dropped frames, and duplicated frames.
- Reader count and reader type.
- Inbound and outbound bytes.
- SRT RTT, retransmitted bytes, loss, belated packets, dropped packets, and receive/send rates.
- WHEP session count and connection state.
- Expected versus actual branch delay.

### 7.4 Program page and compositor

Extend the existing five-second heartbeat with:

- Heartbeat freshness and page build version.
- Presented FPS derived from frame-count deltas.
- Decoded, rendered, dropped, and frozen-frame counters.
- WHEP bytes, packets, loss, jitter, RTT, jitter-buffer delay, and freeze duration.
- Video reconnect count and page reload count.
- Current video state and state-transition timestamp.
- Camera-audio health.
- Rendered overlay revision and render timestamp.
- Rendered event ID, court ID, match ID, teams, set, score, and a canonical digest.
- Browser errors relevant to media, overlay, LiveKit, or heartbeat submission.

Collect host and container state:

- CPU utilization and load against vCPU count.
- Memory and swap pressure.
- Disk free space and disk I/O.
- Network throughput and errors.
- `/dev/shm` utilization.
- Container health, restart count, OOM state, and image version.
- Egress state, start time, error, reconnect behavior, and RTMP output health.

### 7.5 Commentary and synchronization

Collect per court and participant:

- Whether commentary is expected for the current coverage state.
- Room connection state and room age.
- Participant identity/display name and join duration.
- Published audio track count, muted state, and subscription state.
- Audio bitrate, packets, packet loss, jitter, RTT, and reconnect count.
- Commentary RMS, peak, clipping ratio, and silence age.
- Camera/ambient RMS and peak.
- Adaptive sync status: fallback, calibrating, or locked.
- Persisted baseline delay, target delay, applied delay, and target/applied difference.
- Sync clock RTT and latest sample age.
- Last manual clap/lip-sync calibration result and timestamp.

Silence must not be treated as a disconnect. A connected, published track with silence is a warning only when commentary is expected and the configured silence window is exceeded.

Transport telemetry cannot prove semantic human reaction timing. Manual or instrumented A/V calibration remains necessary to establish the baseline.

### 7.6 Scoreboard and match alignment

The evaluator should compare these independently:

1. Configured stream-to-physical-court mapping.
2. VolleyballLife match currently live on that physical court.
3. ScoreCheck current match and queue-active match.
4. Score state and its source/source age.
5. Overlay-state payload returned by the public API.
6. Overlay state actually rendered by the program browser.
7. Next queued match.

Compare:

- Event/division/round source identity.
- Court label and stream number.
- Match ID, match number, round, and scheduled date/time.
- Team names and seeds.
- Current set, set wins, completed set scores, and live points.
- Source status, final status, and source freshness.
- Expected configured scoring delay.
- Final-score hold state.
- Overlay revision and rendered revision.

Rules must understand intentional behavior:

- Do not alarm while a score change is inside the configured VBL delay plus propagation tolerance.
- Do not interpret bracket-only completed-set updates as live point updates.
- Respect the configured completed-match hold.
- When multiple queued matches appear live on one physical court, apply the approved later-queued-live-match arbitration rule.
- Validate scores against the configured match format and flag impossible totals, phantom sets, stale score carryover, or known impossible values such as `67-67`.

The monitor must consume the worker's existing authoritative VBL observations. It must not introduce a second high-frequency VolleyballLife poller.

### 7.7 YouTube destination

Collect:

- Expected broadcast state.
- Reusable live-stream identity and bound broadcast identity, without exposing stream keys.
- Stream status: active, ready, inactive, or error.
- Health status and last health update age.
- Configuration issue type, severity, reason, and remediation description.
- Broadcast lifecycle, recording state, privacy, and bound stream.
- Time from egress start to YouTube receiving.
- Unexpected stream or broadcast transition.

The YouTube API reports issues such as low bitrate, ingestion starvation, frame-rate mismatch, GOP problems, missing audio/video, unsupported codecs, and resolution problems. API polling must be quota-aware and slower than internal five-second media sampling.

### 7.8 Shared infrastructure

Collect:

- Telemetry collector heartbeat and scrape success.
- Prometheus/Alertmanager health and storage capacity.
- ScoreCheck controller heartbeat and reconciliation state.
- ScoreCheck worker heartbeat, poll count, source errors, and response latency.
- MediaMTX, LiveKit, Redis, Egress, and reverse-proxy health.
- Supabase API latency/error rate and database availability.
- Vercel public health and monitoring API reachability.
- DigitalOcean host CPU, memory, disk, bandwidth, load, and availability.
- TLS certificate expiry and DNS resolution.
- Notification-provider health and latest successful test.

## 8. Health and Root-Cause Model

Do not use an opaque `0-100` score. Each required stage has a discrete state:

- `EXPECTED_OFF`: intentionally inactive; no alarm.
- `STARTING`: inside a defined startup grace window.
- `HEALTHY`: required signals are within limits.
- `DEGRADED`: output exists, but quality or redundancy is impaired.
- `CRITICAL`: required output is absent or structurally wrong.
- `RECOVERING`: signals returned but have not yet satisfied recovery hysteresis.
- `UNKNOWN`: collector cannot make a supported determination.

The overall court state is the worst required stage for the court's current expected state.

Expected state should be derived from active event coverage, desired broadcast state, match state, and commentary assignment, with an explicit operator override. This prevents intentional off-air courts and silent commentary rooms from generating false alarms.

### 8.1 Initial threshold hypotheses

These are starting hypotheses for testing, not production constants:

- Raw path unavailable or no incoming bytes for 3-5 seconds: critical.
- Input FPS below 27 for 10 seconds on an expected 30 FPS feed: degraded.
- Input FPS below 20 for 5 seconds: critical.
- Bitrate below roughly 70 percent of configured baseline for 15 seconds: degraded.
- Bitrate below roughly 40 percent or near zero for 5 seconds: critical.
- Frozen visual content for more than 3 seconds while bytes continue: critical camera/encoder symptom.
- Program heartbeat older than 15 seconds: critical compositor/page symptom.
- Program rendered FPS below target after hysteresis: degraded or critical according to severity.
- Expected commentary track absent for 10-15 seconds: critical commentary disconnect.
- Commentary sync leaves `locked` for more than 20-30 seconds: degraded.
- Rendered match identity differs from expected current match: immediate critical.
- Score differs beyond configured delay plus two worker cycles and network tolerance: degraded; sustained mismatch becomes critical.
- YouTube status inactive while broadcast is expected: critical after startup grace.
- Host CPU above 75-80 percent for several minutes: degraded capacity headroom.
- Host CPU above 90 percent, memory pressure, OOM, or disk exhaustion: critical.

All thresholds should be configurable by stream profile and calibrated using real-event baselines and fault tests.

### 8.2 Correlation examples

| Evidence | Likely classification | First action |
| --- | --- | --- |
| One raw path loses bitrate; other courts remain healthy | Court-specific upstream ingest issue | Check that camera, power, Wi-Fi association, and encoder state |
| Several cameras degrade while router WAN loss/utilization worsens | Shared venue uplink issue | Check bonded router, carriers, and upload headroom |
| Raw path healthy; preview FPS and FFmpeg speed collapse | Ingest transcode overload or branch failure | Check ingest CPU, FFmpeg process, and logs |
| Program path healthy; browser presented frames stall | Program browser/compositor issue | Check program heartbeat, Chrome, and compositor resources |
| Program healthy; YouTube reports ingestion starvation | Egress/RTMPS/destination issue | Check egress output and YouTube issue details |
| Supabase overlay correct; rendered digest stale | Program overlay subscription/render issue | Check program page overlay client and realtime connection |
| All scores stale; media remains healthy | Worker, VBL, or Supabase scoring issue | Check worker heartbeat/source errors and VBL availability |
| Courts 1-4 fail together; 5-8 remain healthy | Shared compositor-host failure | Check compositor A and failover plan |

The dashboard should state confidence and evidence. It should not overstate uncertain root causes.

## 9. Single-Page Operator Experience

### 9.1 Page separation

Create a read-only `/admin/monitor` route. Keep mutating start/stop, stream-key, and configuration controls in `/admin/production`.

The monitoring page may link directly to the relevant control or runbook, but it should not expose easy-to-click destructive controls in the live matrix.

### 9.2 Global header

Show:

- Active event and coverage state.
- Local event time.
- Last snapshot age and collector state.
- Healthy/degraded/critical court counts.
- Highest-severity active incident.
- Shared service strip for venue uplink, ingest, commentary, compositor A/B, controller, scoring worker, Supabase, YouTube, and notification delivery.
- Notification sound state and a test-notification command.

### 9.3 Court matrix

Use a fixed 4-by-2 matrix on a production laptop. Court locations must not reorder automatically because operators develop spatial memory.

Each court tile should include:

- Court and stream identity.
- Low-bandwidth visual monitor.
- Overall state and duration.
- One concise highest-priority diagnosis.
- Pipeline strip: `CAMERA > INGEST > PROGRAM > YOUTUBE`.
- Separate commentary and score-alignment indicators.
- Inbound bitrate, input FPS, loss/error signal, and reconnect count.
- Program FPS and egress state.
- Commentary participant/track status, level, and sync status.
- Team names, points, sets, match number, source age, and alignment state.
- Five-minute bitrate and FPS sparklines.

Colors must not be the only status signal. Use icons and explicit labels.

### 9.4 Visual monitoring bandwidth

Do not make eight permanent 720p/30 FPS WHEP subscriptions the default. That would consume operator bandwidth and add load to the media system being observed.

Research these options:

- A dedicated low-bitrate `courtN_monitor` rendition such as 360p/10 FPS.
- Low-rate server-generated thumbnails for healthy courts.
- Automatic promotion of a degraded court to a full-rate preview.
- Full-rate preview and audio only when the operator opens a court detail drawer.
- A single monitor mosaic only as a supplemental view, not as the source of health truth.

The monitoring page must not be required for telemetry collection. Closing the browser must not stop monitoring or alerts.

### 9.5 Court detail drawer

Opening a court should stay on the same page and show:

- Full-rate muted preview with optional audio solo.
- Thirty-minute and event-long graphs.
- Raw, preview, program, egress, and YouTube stage details.
- Commentary participants and per-track health.
- Score alignment comparison table.
- Current incident evidence and recommended response.
- Recent state transitions and relevant structured log excerpts.
- Links to the production control and runbook.

## 10. Phone Notification and Remote Paging Design

Phone notification is a required production capability, not an optional UI enhancement.

### 10.1 Proposed delivery chain

```text
Prometheus alert rules and correlation incidents
                 |
            Alertmanager
                 |
       notification-dispatcher webhook
          /                   \
Primary acknowledged push     SMS fallback/escalation
          |                    |
Pushover or equivalent         Twilio or equivalent
                 |
        Deep link to /admin/monitor?incident=...
```

Recommended behavior:

- Warning: normal mobile push, grouped and rate-limited.
- Critical: emergency-priority push requiring acknowledgement.
- Critical not acknowledged after a configured interval: SMS escalation.
- Critical still unacknowledged or broad outage: optional second recipient or voice-call escalation.
- Recovery: one resolved notification tied to the same incident.
- Shared outage: one root-cause notification, not eight court notifications.

Pushover is a strong candidate because its emergency-priority API supports repeated push notifications until acknowledgement and returns a receipt that can be tracked. Twilio is a strong SMS candidate because delivery status callbacks can report delivered, undelivered, or failed state. The research review should compare these with equivalent managed paging products for cost, delivery reliability, acknowledgement, escalation, and operational complexity.

### 10.2 Independent dead-man monitoring

The ScoreCheck collector must send a heartbeat to an external service every 30-60 seconds during active coverage. Missing heartbeats should notify the phone independently of ScoreCheck, DigitalOcean, Supabase, Vercel, Prometheus, and Alertmanager.

At minimum, externally monitor:

- Observability collector heartbeat.
- Public ScoreCheck health endpoint from outside the infrastructure.
- Media ingress public reachability where a safe synthetic check is possible.
- Notification-dispatcher heartbeat.

Healthchecks.io is one candidate for the collector dead-man check. It is designed to alert when expected pings stop and supports multiple notification integrations. A separate hosted uptime probe should check public HTTP reachability because Healthchecks.io explicitly distinguishes dead-man checks from website uptime monitoring.

The external service should not depend on the same DigitalOcean account, DNS path, or notification dispatcher as the primary monitor.

### 10.3 Notification safety and usability

- Every notification contains event, court, severity, failing stage, observed value, expected value, duration, and a deep link.
- Never include credentials, stream keys, ingest URLs, participant tokens, or private IPs.
- Store provider message/receipt IDs, acknowledgement time, delivery status, and escalation state.
- Acknowledgement silences repeat notifications for that incident; it does not hide the incident from the dashboard.
- Silence and maintenance windows require an expiry time and audit record.
- Notification routing follows active coverage expectations, not merely the existence of metrics.
- Critical monitor-self failures are never muted by an event being marked idle.
- Add a visible `Send test alert` workflow and require a successful phone test before every event.
- Browser/PWA notifications may supplement phone delivery but must not be the only critical channel.

## 11. Data and Retention Model

### 11.1 Time-series store

Store high-frequency numeric samples in Prometheus or a validated compatible system:

- Five-second media/application samples during active coverage.
- Ten-to-fifteen-second host/container samples.
- Slower destination and provider samples.
- Seven to fourteen days of high-resolution retention initially.
- Longer retention only after measuring storage growth and defining downsampling.

Do not write every raw metric sample to Supabase.

### 11.2 Supabase

Store durable, low-churn records:

- Monitoring expectations and per-court profiles.
- Latest periodic checkpoint for fallback display.
- Incident open/update/resolve transitions.
- Alert acknowledgement and silence audit records.
- Notification delivery and escalation receipts.
- Manual calibration results.
- Event health summary and post-event report.

Write incidents on state transitions, not every scrape.

### 11.3 Suggested conceptual entities

- `monitoring_profiles`: expected FPS, bitrate, resolution, codec, audio, and thresholds.
- `court_monitoring_expectations`: camera/commentary/score/broadcast expected state.
- `monitoring_incidents`: fingerprint, severity, stage, evidence, opened/resolved state.
- `incident_notifications`: provider, delivery status, receipt, acknowledgement, escalation.
- `monitoring_checkpoints`: latest sanitized summary, updated periodically.
- `sync_calibrations`: court, method, observed offset, operator result, timestamp.

Exact schema should follow the existing Supabase conventions and avoid new Realtime broadcast churn.

## 12. Collection and UI Cadence

Suggested starting cadence:

| Signal | Active coverage | Idle |
| --- | --- | --- |
| MediaMTX/FFmpeg/program metrics | 5 seconds | 30-60 seconds or disabled when not expected |
| Path and LiveKit lifecycle events | Immediate webhook/hook | Immediate |
| Host/container metrics | 10-15 seconds | 60 seconds |
| Score alignment | Event-driven from existing worker observations | No separate VBL polling |
| YouTube health | 20-30 seconds | Several minutes |
| Dashboard snapshot | 5 seconds while visible | Refresh on visibility return |
| External collector dead-man | 30-60 seconds | 5-15 minutes when no coverage, subject to research |

Alert rules need consecutive-sample requirements and recovery hysteresis. A single transient sample should not create a phone page unless the condition is structurally impossible or immediately destructive.

## 13. Alert Grouping, Escalation, and Noise Control

- Fingerprint incidents by event, failure stage, shared dependency, and court.
- Group shared host/uplink failures before delivery.
- Route warning and critical severity differently.
- Use startup, intermission, and recovery grace windows.
- Repeat only unresolved and unacknowledged critical incidents.
- Suppress downstream symptom alerts when a supported upstream root cause exists.
- Send one recovery notification after stable recovery hysteresis.
- Preserve all suppressed child evidence in the dashboard.
- Track alert detection latency, notification submission latency, provider delivery latency, and acknowledgement latency.

## 14. Reliability Requirements

- The monitor must detect its own stale data and display `UNKNOWN`, never stale green.
- Collector restarts must rebuild current state from real services and Prometheus.
- Alertmanager and incident fingerprints must avoid duplicate pages after restart.
- The dashboard must show the age of every important observation.
- A failing YouTube API must not imply that media itself is down; it should show destination visibility as unknown.
- A failing Supabase query must not erase active media incidents.
- A failing visual monitor stream must not be treated as production failure unless independent production signals agree.
- External dead-man monitoring must survive complete DigitalOcean or ScoreCheck failure.
- Notification-provider failure must be visible and, where possible, trigger the backup provider.

## 15. Proposed Implementation Phases

### Phase 1: telemetry foundation

- Select and provision the observability topology.
- Install Prometheus-compatible collection and Alertmanager.
- Add node/container metrics.
- Scrape MediaMTX, LiveKit, and Egress private metrics.
- Add MediaMTX and LiveKit lifecycle hooks/webhooks.
- Add FFmpeg progress export without duplicating full video decode.
- Implement the sanitized current-health snapshot API.
- Add external collector dead-man monitoring.

Exit criterion: every stage for one court has current metrics and stale-data detection without a dashboard browser being open.

### Phase 2: semantic application telemetry

- Extend program heartbeat with WebRTC video statistics, reconnect/reload counts, and rendered-overlay digest.
- Add score alignment evaluator using existing worker observations.
- Add expected-state configuration.
- Add incident correlation and durable transitions.
- Add Pushover/equivalent push, acknowledgement, SMS fallback, and notification tests.

Exit criterion: controlled one-court failures produce one correct diagnosis and one correctly routed phone notification.

### Phase 3: operator dashboard

- Build `/admin/monitor` as the default read-only live-event view.
- Add global shared-service strip, alert rail, fixed eight-court matrix, and court detail drawer.
- Add low-bandwidth visual monitoring strategy.
- Add five-minute sparklines and incident timeline.
- Add acknowledgement, timed silence, test-notification, and deep-link workflows.

Exit criterion: an operator can identify and acknowledge any injected one-court or shared failure without SSH or a second dashboard.

### Phase 4: venue telemetry and visual diagnostics

- Integrate actual router/bonding telemetry.
- Integrate camera telemetry where supported.
- Add freeze, black-frame, audio-silence, and clipping detection.
- Calibrate thresholds using real camera motion and venue-network conditions.

Exit criterion: supported upstream diagnoses are evidence-backed and false positive rates are acceptable.

### Phase 5: eight-court load and fault gate

- Run eight motion-heavy camera feeds.
- Use two compositor hosts and intended production topology.
- Exercise at least two commentary rooms and live scoring on all courts.
- Run for 10-12 hours.
- Inject camera, venue-network, MediaMTX, commentary, compositor, controller, Supabase, YouTube, monitoring-host, and notification-provider failures.
- Verify unaffected courts stay healthy and shared failures group correctly.

Exit criterion: all acceptance targets below pass, with a documented event report and no unexplained telemetry gaps.

## 16. Acceptance Tests and Targets

Targets should be reviewed and refined by research:

- Camera hard disconnect detected and paged in under 10 seconds.
- Low bitrate or low FPS identified in under 20 seconds without excessive false alerts.
- Full-bitrate frozen video detected in under 10 seconds.
- Black/covered camera detected without treating normal dark scenes as outages.
- Preview/transcoder failure distinguished from raw ingest failure.
- Program-browser frame stall distinguished from MediaMTX failure.
- Commentator track disconnect detected in under 10-15 seconds when expected.
- Commentary sync fallback detected and contextualized without claiming an unmeasured absolute offset.
- Wrong match/team identity in the rendered scorebug detected immediately after observation.
- Score mismatch alerts respect configured delay and final-hold behavior.
- YouTube ingestion starvation or inactive state paged within API cadence.
- Shared host or venue outage sends one root incident, not eight independent pages.
- Critical push repeats until acknowledged or escalated.
- SMS fallback delivery state is recorded.
- Monitoring-host failure is reported by the external dead-man service.
- Closing the operator dashboard does not affect collection or alerts.
- Intentionally inactive courts do not alert.
- Recovered incidents clear only after stable recovery hysteresis.
- No secrets appear in metrics, labels, logs, URLs, incidents, or notifications.

## 17. Decisions Required Before Implementation

1. Exact camera models and firmware versions.
2. Exact venue router, access point, bonding hardware, and carrier setup.
3. Available router APIs, SNMP, telemetry exports, and camera APIs.
4. Whether a dedicated small observability VPS is approved.
5. Prometheus versus an alternative compatible time-series backend after retention and operational research.
6. Primary phone provider: Pushover/equivalent acknowledged push.
7. Backup paging provider: Twilio/equivalent SMS, and whether voice escalation is required.
8. External dead-man and public uptime provider.
9. Primary operator laptop resolution and browser.
10. Additional alert recipients and escalation order.
11. Coverage-state source of truth and manual override behavior.
12. Acceptable detection latency, false-positive rate, storage retention, and monthly monitoring cost.

## 18. Research Questions for the Reviewing Agent

The reviewing agent should challenge the architecture and answer:

- Is a dedicated observability VPS plus external dead-man check the simplest reliable topology?
- Is Prometheus the right store for five-second, eight-court telemetry, or would VictoriaMetrics/another compatible backend materially reduce operational risk?
- What exact MediaMTX v1.19.2 metrics and Control API fields are available for RTMP, SRT, RTSP, and WHEP paths?
- What is the lowest-cost way to derive accurate FPS, GOP, drop/dup, freeze, and black-frame metrics without adding harmful decode/transcode load?
- Can the existing FFmpeg normalization graph emit a monitor rendition and progress telemetry efficiently?
- What LiveKit Server and Egress metrics are available in the pinned versions, and which require client `getStats()` or webhooks?
- What camera and router telemetry can be retrieved from the actual hardware?
- What alert thresholds are defensible for 720p30 RTMP camera ingest and remote commentary?
- How should expected-state and alert inhibition be modeled to avoid tournament false positives?
- How should VBL score timing tolerance be calculated from poll cadence, configured delay, overlay propagation, and final hold?
- Is Pushover emergency priority plus Twilio SMS fallback sufficiently reliable, or should a managed on-call service be used?
- Which external service best monitors the monitor itself without sharing ScoreCheck failure domains?
- What are YouTube API quota implications for eight streams at a 20-30 second health cadence?
- What security controls are required for private metric endpoints, the monitoring API, phone-provider credentials, and incident deep links?
- What storage volume should be expected at five-second cadence for seven to fourteen days?
- How should the system test notification delivery, acknowledgement, escalation, and provider failure before each event?
- What objective fault-injection suite proves the dashboard is diagnosing the correct stage rather than merely detecting symptoms?

## 19. Official Reference Starting Points

- MediaMTX metrics: <https://mediamtx.org/docs/features/metrics>
- MediaMTX Control API: <https://mediamtx.org/docs/features/control-api>
- MediaMTX hooks: <https://mediamtx.org/docs/features/hooks>
- WebRTC statistics: <https://www.w3.org/TR/webrtc-stats/>
- LiveKit webhooks/events: <https://docs.livekit.io/intro/basics/rooms-participants-tracks/webhooks-events/>
- LiveKit Room Service API: <https://docs.livekit.io/reference/other/roomservice-api/>
- LiveKit self-hosted Egress: <https://docs.livekit.io/transport/self-hosting/egress/>
- YouTube live-stream health: <https://developers.google.com/youtube/v3/live/docs/liveStreams>
- YouTube live-broadcast state: <https://developers.google.com/youtube/v3/live/docs/liveBroadcasts>
- Prometheus Alertmanager configuration: <https://prometheus.io/docs/alerting/latest/configuration/>
- Pushover API and emergency acknowledgements: <https://pushover.net/api>
- Twilio message delivery status: <https://help.twilio.com/hc/en-us/articles/223134347-What-do-the-SMS-statuses-mean->
- Healthchecks.io dead-man checks: <https://healthchecks.io/docs/>
- DigitalOcean Droplet metrics: <https://docs.digitalocean.com/products/monitoring/concepts/metrics/>

## 20. Recommended Research Output

The external review should return:

1. Keep/change/reject decision for each major architecture component.
2. A revised component and data-flow diagram.
3. Exact metrics available from each pinned service version.
4. Recommended collection, retention, and storage sizing.
5. Recommended phone paging and external dead-man providers with cost and failure analysis.
6. Threshold and hysteresis table with rationale.
7. Security threat model and credential-handling plan.
8. Expected infrastructure cost for idle and event-day operation.
9. A phased implementation plan with gate criteria.
10. A fault-injection and acceptance-test matrix.
11. Any simpler architecture that meets the same reliability goal with less operational burden.

