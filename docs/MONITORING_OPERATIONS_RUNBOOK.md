# ScoreCheck Monitoring Operations Runbook

## Purpose

`/admin/monitor` is the event-day view for all eight ScoreCheck courts. It
correlates venue ingest, MediaMTX paths, FFmpeg normalization, browser program
rendering, remote commentary, score/overlay alignment, LiveKit Egress,
infrastructure capacity, and YouTube health without controlling those systems.

Monitoring collection is independent of operator browsers and production
control. Closing the dashboard does not stop collection or phone paging.

## Production endpoints

- Operator dashboard: `https://score.beachvolleyballmedia.com/admin/monitor`
- Sanitized monitor health: `https://monitor.beachvolleyballmedia.com/healthz`
- Monitor API: `https://monitor.beachvolleyballmedia.com/v1/*` with its service credential
- Public ScoreCheck health: `https://score.beachvolleyballmedia.com/api/health`

Never paste monitoring tokens, provider credentials, stream keys, program-page
tokens, or dead-man ping URLs into tickets, chat, logs, or screenshots.

## Runtime topology

| Host role | Responsibility | Expected agents |
| --- | --- | ---: |
| MediaMTX | Raw ingest, preview/program paths, FFmpeg progress | 1 |
| Commentary | LiveKit rooms, participants, tracks, packet health | 1 |
| Compositor A | Egress capacity for courts 1-2 | 1 |
| Compositor B | Egress capacity for courts 3-4 | 1 |
| Compositor C | Egress capacity for courts 5-6 | 1 |
| Compositor D | Egress capacity for courts 7-8 | 1 |
| Observability | Prometheus, Alertmanager, correlator, API, incident dispatcher | local |

Every production host agent is read-only. Docker is exposed through a GET-only
socket proxy; the agent cannot start, stop, or reconfigure production services.
Compositor ownership is stored centrally and repeated by the agent. A mismatched
assignment is rejected, and an unreachable compositor remains attributable to
its pair even if observability restarts during the outage.

## Dashboard reading order

1. Check the global strip. Collector must report `6/6 agents` before coverage.
2. Find the first red, amber, or unknown court tile.
3. Read its first issue and first action. This is the correlated upstream cause,
   not merely the most visible downstream symptom.
4. Select the court to open its full WHEP preview and all stage evidence.
5. Check the assigned compositor and shared host cards for capacity or restart evidence.
6. Use acknowledgement only after an operator owns the response.
7. Use a timed silence only for planned work. A silence suppresses paging; it
   never hides the incident or marks the stage healthy.

The 4x2 thumbnails are low-rate browser snapshots, not eight extra decoders.
Only the selected or newly critical court opens a full live WHEP player.

## Expected-state lifecycle

All courts are `OFF` when an event is activated or completed. A successful
Production Console start arms one court for 18 hours with:

```text
coverage_phase=WARMUP
media_expectation=REQUIRED
broadcast_expectation=LIVE
commentary_expectation=OPTIONAL
scoring_expectation=SCHEDULED
```

Observed live scoring promotes the effective phase to `LIVE_MATCH`; a final
promotes it to `FINAL_HOLD`. A successful broadcast stop clears the court to
`OFF`. An inactive advertised MediaMTX path is expected off and must not page.

If Production Console reports that the expectation update failed, do not
assume the dashboard is monitoring that court. Resolve the expectation warning
before public coverage.

## Freshness and polling budget

| Signal | Collection | Stale/unknown boundary |
| --- | ---: | ---: |
| Host agents | 5 seconds | 20 seconds |
| Program browser heartbeat | 5 seconds | 15 seconds |
| Control plane | 5 seconds | 30 seconds |
| YouTube | internally bounded to 60 seconds | 180 seconds |
| Dashboard snapshot | 5 seconds while visible | 15 seconds |
| Five-minute sparklines | 30 seconds while visible | optional |
| Durable Supabase checkpoint | 60 seconds | fallback only |
| Browser thumbnail | 15 seconds | 45 seconds |
| Local visual content sample | 1 second | carried by browser heartbeat |
| Local audio level sample | 0.5 seconds | carried by browser heartbeat |

High-frequency samples stay in Prometheus. Supabase receives only expectations,
incident transitions, acknowledgements, silences, notification receipts, and a
single sanitized fallback checkpoint per minute.

## Incident semantics

- `CRITICAL`: active coverage is failing or the monitor cannot prove a required stage. Page immediately.
- `DEGRADED`: quality or redundancy is impaired. Keep visible; do not page by default.
- `UNKNOWN`: telemetry is stale or unavailable. Never translate this to healthy.
- `EXPECTED_OFF`: that stage is intentionally inactive.
- `MAINTENANCE`: reserved for an explicitly bounded maintenance state.

Incident fingerprints exclude timestamps and message text, so repeated samples
update one durable incident. Acknowledgement stops repeated emergency push
delivery but leaves the incident visible until the evidence recovers.

Alertmanager inhibits downstream pages when a stronger upstream cause is active:

- a missing host agent inhibits matching host service and Egress symptoms;
- a missing raw court path inhibits matching normalization, program-browser,
  and YouTube symptoms;
- a missing program branch inhibits matching browser/render/YouTube symptoms;
- a missing or low-FPS program browser inhibits matching render/YouTube symptoms;
- a disconnected commentary room inhibits matching track, level, network, and
  synchronization symptoms;
- the shared score-worker alert inhibits all per-court source-alignment pages;
- YouTube unhealthy inhibits YouTube degraded for the same court.

Inhibition suppresses duplicate notification delivery only. The dashboard stage
matrix and Prometheus evidence continue to show every downstream symptom. Every
deployment proves same-court suppression and peer-court independence against a
disposable Alertmanager before restarting production observability.

### Content and audio thresholds

- Repeated picture: warning after 5 seconds, critical after 15 seconds, only
  during `LIVE_MATCH` and only while raw transport remains healthy.
- Uniform black or covered picture: critical after 20 seconds. It suppresses the
  repeated-picture alert so one physical symptom does not produce two pages.
- Camera or required commentary silence: warning after 60 seconds from track
  arrival or the last audible sample.
- Camera or commentary clipping: warning when more than 5 percent of recent
  samples are at or above 0.99 absolute amplitude.
- Commentary packet loss: warning above 10 percent over one minute.
- Commentary jitter-buffer delay: warning above 300 ms for 20 seconds.
- Commentary sync: warning when not locked or target-to-applied delay differs by
  more than 250 ms for 30 seconds.

Use the current thumbnail and stage evidence before changing equipment. Content
analysis distinguishes changing from repeated pixels, but cannot prove whether
a static view was intentional.

### Timed silence

The dashboard can silence an exact incident for 15, 30, 60, or 120 minutes.
Every silence requires a reason and records actor, scope, creation time, and
expiry. Existing emergency pushes are cancelled. If the silence expires while
the incident remains critical, primary paging is re-armed and the SMS escalation
clock starts from that new primary delivery.

Do not silence an unexplained failure. Do not use a silence as a substitute for
setting a court `OFF` after coverage.

## Phone paging and dead-man activation

The code supports Pushover emergency priority with acknowledgement, followed by
Twilio SMS after two minutes when the critical incident remains unacknowledged.
Recovery notifications are deduplicated. Twilio callbacks are signature checked.

The following protected values must be supplied before paging can be activated:

```text
PUSHOVER_APP_TOKEN
PUSHOVER_USER_KEY
TWILIO_ACCOUNT_SID
TWILIO_AUTH_TOKEN
TWILIO_FROM_NUMBER
TWILIO_TO_NUMBER
HEALTHCHECKS_BASELINE_PING_URL
HEALTHCHECKS_ACTIVE_PING_URL
HEALTHCHECKS_API_KEY
HEALTHCHECKS_ACTIVE_CHECK_ID
```

Store them only in the protected monitoring environment on the observability
host and in the protected local deployment file. Never commit them. The baseline
dead-man pings every ten minutes at all times. The active check pings every minute
while any court expects coverage and is explicitly paused through the Healthchecks
management API while the system is idle. A live ping resumes it automatically.
The dashboard must show `Coverage active` or `Idle protected`, and any ping/pause
failure must degrade the Watchdog item. The external provider must notify a phone
independently of DigitalOcean, Supabase, Vercel, and ScoreCheck.

Provider activation is not accepted until all of these pass:

1. Pushover emergency arrives, repeats, deep-links to the monitor, and stops on acknowledgement.
2. Unacknowledged Pushover escalates to one Twilio SMS after two minutes.
3. Recovery sends once and cancels any active emergency receipt.
4. Baseline and active dead-man checks both alert when their pings are withheld.
5. The dashboard shows provider failure as degraded notification health.

## Deployment and verification

From `infra/monitoring` with the protected environment loaded:

```bash
npm ci
npm run typecheck
npm test
npm run build
MONITOR_SSH_HOST=root@OBSERVABILITY_PUBLIC_IP ./deploy.sh
```

Register or replace a compositor agent with:

```bash
MONITOR_SSH_HOST=root@OBSERVABILITY_PUBLIC_IP \
  ../compositor/register-monitoring.sh \
  --name HOST_NAME \
  --ssh-host root@COMPOSITOR_PUBLIC_IP \
  --private-ip COMPOSITOR_VPC_IP \
  --courts COURT_PAIR \
  --observability-private-ip OBSERVABILITY_VPC_IP \
  --refresh
```

After every deployment verify:

- monitor health is `ok`;
- all six agent targets are up in Prometheus;
- Prometheus rule validation passes;
- Alertmanager can deliver to the correlator;
- snapshot reports eight courts and six fresh agents;
- every court has exactly one expected compositor mapping;
- there are no unexplained active incidents;
- `/admin/monitor` loads through an authenticated production admin session;
- the browser console contains no monitoring errors.

## Fault-injection gates

Fault tests must use test broadcasts and explicit operator approval. Never stop a
public StreamRun path or a live production output for a monitoring test.

### One-court gate

| Fault | Expected diagnosis | Maximum detection |
| --- | --- | ---: |
| Stop camera publishing | `RAW_INGEST`, camera/venue first action | 20 seconds |
| Freeze full-bitrate camera content | `FULL_BITRATE_VISUAL_FREEZE`; seven peers unaffected | 20 seconds |
| Cover camera or send uniform black | `CAMERA_CONTENT_BLACK`; no duplicate freeze page | 25 seconds |
| Degrade venue uplink | bitrate/FPS/loss trend degrades before downstream failure | 30 seconds |
| Stall preview normalizer | `PREVIEW`, FFmpeg/path evidence | 20 seconds |
| Close program browser | `PROGRAM_BROWSER`, stale heartbeat | 15 seconds |
| Disconnect commentator | `COMMENTARY` only when commentary is required | 20 seconds |
| Mute, clip, or silence commentator | exact commentary issue code; no camera-stage fault | 75 seconds |
| Corrupt score/render fixture | `SCORE_SOURCE` or `SCORE_RENDER`; detect 67-67 | 15 seconds |
| Stop test Egress job | `EGRESS`; program input remains diagnosable | 20 seconds |
| Unbind test YouTube stream | `YOUTUBE`; upstream stages remain healthy | 180 seconds |
| Stop one host agent | matching host/stages become `UNKNOWN`, never healthy | 20 seconds |
| Withhold monitor dead-man | external phone notification | provider deadline |

For every fault, record detect time, root stage, first action, page delivery,
unaffected stages/courts, recovery time, duplicate count, and any false symptom.

### Eight-court gate

Run eight real or representative feeds across the four two-court compositors for
at least two hours, preferably twelve. Require scoring on all courts and two
active commentary rooms. Acceptance requires:

- all 6 agents remain fresh;
- no sustained host CPU above 80% and no growing memory trend;
- every Egress worker remains available and accepts no more than two jobs;
- court bitrate and FPS stay within the selected profile;
- score source and rendered scorebug remain aligned;
- every injected single-court fault identifies that court without paging the other seven;
- one compositor fault affects only its assigned pair;
- acknowledgement, silence expiry, SMS escalation, and recovery each deduplicate;
- no high-frequency telemetry growth appears in Supabase.

## Current acceptance status

- Browser-independent six-agent collection: passed.
- Eight-court mapping and Egress capacity visibility: passed while idle.
- Prometheus rules (37 syntax-validated plus executable timing/isolation tests)
  and correlator unit/fault fixtures: passed. Every observability deployment
  reruns these gates before replacing files or restarting containers.
- Deterministic eight-court isolation fixtures for camera loss, repeated picture,
  compositor-pair loss, score-render mismatch, YouTube API unknown, and shared
  score-worker deduplication: passed. These are code gates, not real-feed gates.
- Expanded WebRTC, visual-content, camera-audio, and commentary telemetry: passed
  type/schema/unit validation; awaits the next real program-page session.
- Durable incident, acknowledgement, checkpoint, and silence lifecycle: passed.
- Production web and monitor builds: passed.
- Healthchecks baseline delivery and active idle-pause lifecycle: configured; the
  withheld-ping phone delivery gate remains outstanding because the project
  currently has email as its Healthchecks notification channel.
- Pushover delivery: awaiting an app token and user key. Twilio authentication is
  valid, but SMS remains disabled until the account has an SMS-capable sender.
- Authenticated production visual check: requires an existing admin login.
- Real one-court and eight-court fault injection: requires the next test-feed
  session; code must not simulate this by stopping public production services.
