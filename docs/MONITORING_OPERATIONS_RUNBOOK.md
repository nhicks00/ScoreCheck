# ScoreCheck Monitoring Operations Runbook

## Purpose

`/admin/monitor` is the event-day view for all eight permanent ScoreCheck camera
feeds. Camera numbers follow the permanent stream-key identity; the physical
court assignment is secondary and may change between events. The dashboard
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
2. Find the first red, amber, or unknown camera card.
3. Read `Camera live`, `Camera unstable`, or `Camera offline` separately from
   the production-pipeline badge. A missing downstream output must never make a
   healthy incoming camera look offline.
4. Read its first issue and first action. This is the correlated upstream cause,
   not merely the most visible downstream symptom.
5. Select the camera to open its live WHEP inspection and all stage evidence.
6. Check the assigned compositor and shared host cards for capacity or restart evidence.
7. Use acknowledgement only after an operator owns the response.
8. Use a timed silence only for planned work. A silence suppresses paging; it
   never hides the incident or marks the stage healthy.

The overview is a fixed two-column grid. Its images are 256x144 JPEG snapshots
captured every 15 seconds, not eight extra video readers. Only a camera the
operator explicitly opens uses a live WHEP player. New alerts select the affected
camera without starting video. `Data saver` uses the on-demand
360p/10 FPS `courtN_monitor` rendition at roughly 0.4 Mbps. `Detail` uses the
existing 720p/30 FPS preview at roughly 2.6 Mbps. Switching cameras or using
`Close video` releases the prior reader; the monitor rendition closes after
15 seconds without a reader. This selected-reader limit controls venue download
bandwidth, not ingest CPU. On the current central 4-vCPU host, keep `Data saver`
disabled during full production until camera normalization is offloaded or the
capacity gate qualifies the added transcode. The dashboard enforces that limit:
when a camera has a live broadcast expectation, inspection uses the existing
`Detail` path and the `Data saver` option is unavailable. The authenticated
stream-source API enforces the same rule and fails closed when the expectation
cannot be loaded; the disabled dashboard option is not the capacity boundary.

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

Incident fingerprints exclude timestamps and message text. Repeated samples
within one active outage update that durable incident. After resolution, the
same fingerprint opens a new incident episode with a new UUID, `opened_at`,
event history, and notification receipts. Acknowledgement stops repeated
emergency push delivery for that episode but leaves it visible until the
evidence recovers.

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

The deployed service supports Pushover emergency priority with acknowledgement,
followed by Twilio SMS after two minutes when a critical incident remains
unacknowledged. Recovery notifications are deduplicated and are sent only
through providers that delivered the opening incident. Twilio message creation
and bounded receipt polling use a restricted API key; no public status callback
or account auth token is required.

The complete provider configuration uses these protected values:

```text
PUSHOVER_APP_TOKEN
PUSHOVER_USER_KEY
TWILIO_ACCOUNT_SID
TWILIO_API_KEY_SID
TWILIO_API_KEY_SECRET
TWILIO_FROM_NUMBER
TWILIO_TO_NUMBER
HEALTHCHECKS_BASELINE_PING_URL
HEALTHCHECKS_ACTIVE_PING_URL
HEALTHCHECKS_API_KEY
HEALTHCHECKS_ACTIVE_CHECK_ID
```

Store them only in the protected monitoring environment on the observability
host and in the protected local deployment file. Never commit them. Pushover
and both Healthchecks checks are configured in production. Twilio API
credentials and a sender are available, but escalation remains disabled until
the sender's A2P registration is approved and an actual test message reaches the
destination. A `30034` result means the sender is still unregistered and must
remain disabled. The baseline
dead-man pings every ten minutes at all times. The active check pings every minute
while any court expects coverage and is explicitly paused through the Healthchecks
management API while the system is idle. A live ping resumes it automatically.
The dashboard must show `Coverage active` or `Idle protected`, and any ping/pause
failure must degrade the Watchdog item. The external provider must notify a phone
independently of DigitalOcean, Supabase, Vercel, and ScoreCheck.

Phone notifications use operator language only. Every opening notification has
`Problem:` and `Do this:` lines, identifies the permanent camera number when
applicable, and omits internal stage names, service names, and issue codes.
Recovery messages state what is working again and whether any action remains.

Provider activation is not accepted until all of these pass:

1. Pushover emergency arrives, repeats, deep-links to the monitor, and stops on acknowledgement.
2. Unacknowledged Pushover escalates to one Twilio SMS after two minutes.
3. Recovery sends once and cancels any active emergency receipt.
4. Baseline and active dead-man checks both alert when their pings are withheld.
5. The dashboard shows provider failure as degraded notification health.

## Deployment and verification

Migration `022_monitoring_incident_episodes.sql` and the matching monitor
service are one hard-cutover unit. The old service writes conflicts on
`fingerprint`; the new service writes conflicts on `id` and refuses startup
unless `monitoring_incident_episode_contract()` returns `1`. Never run the old
service after migration 022, and never run the new service before it.

Perform this bounded cutover only while coverage is idle:

1. Capture a database backup and record the current migration list, incident
   counts, latest incident/event/notification timestamps, monitor image
   revision, health, and restart count.
2. Stop only monitor-service so no process can write the old contract during
   migration.
3. Dry-run and apply migration 022, then run
   `infra/monitoring/sql/verify-incident-episodes.sql`. The verification is
   transactional and leaves no probe rows.
4. Deploy the matching monitor-service image and require its schema contract
   startup check, `/healthz`, snapshot, and durable checkpoint to pass.
5. Record the applied migration version, contract result, image revision,
   container start time/restart count, and unchanged Prometheus, Alertmanager,
   Caddy, media, routing, and output provenance.

`infra/monitoring/sql/rollback-incident-episodes.sql` is guarded and
non-destructive. It may be used only if the new service fails before any
fingerprint has more than one durable episode. Once recurrence history exists,
use the pre-cutover backup or a forward fix; never delete incident history to
make rollback possible.

The repository currently contains two historical files with migration version
`017`, while the linked project records one `017`. Do not use `--include-all`
and do not run an unfiltered `supabase db push` for this cutover. Build a
temporary migration directory from the production-applied history, omit only
the unmatched `017_vision_shadow_receipts.sql`, and require `db push --dry-run`
to list exactly migration 022 before applying it. Resolve the duplicate legacy
version in its owning vision rollout; it is not part of this monitoring change.

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

Fault tests must use test broadcasts and explicit operator approval. Never stop
or alter a public ScoreCheck output for a monitoring test.

When no tournament event is active, arm one test feed through the authenticated
monitor API instead of creating a fake Supabase event. The override is held only
in monitor-service memory, requires a healthy raw baseline and all agents fresh,
permits one court at a time, leaves broadcast/commentary/scoring off, and expires
after at most thirty minutes. Use at least fifteen minutes for a human-operated
physical disconnect/reconnect gate. Preview and program branches remain expected off; the
gate requires only the selected raw ingest. A monitor-service restart clears it.

```text
POST /v1/fault-gates/courts/{court}/arm
DELETE /v1/fault-gates/courts/{court}
```

Every alert opened from this override carries `expectation_source=fault_gate`
and a plain-English `TEST` notification title. Restore and verify the raw
feed before disarming; disarming an unrestored feed can only stop test paging,
not repair the camera path. Gate expiry or disarm while a dependency remains
unhealthy is persisted as expectation cessation, cancels emergency repeats,
and suppresses the normal recovery notification. Only observed dependency
recovery may announce that the feed is back.

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
- every Egress metrics/health endpoint remains reachable, busy workers remain healthy, and no worker accepts more than its configured job capacity;
- court bitrate and FPS stay within the selected profile;
- score source and rendered scorebug remain aligned;
- every injected single-court fault identifies that court without paging the other seven;
- one compositor fault affects only its assigned pair;
- acknowledgement, silence expiry, SMS escalation, and recovery each deduplicate;
- no high-frequency telemetry growth appears in Supabase.

## Current acceptance status

- Browser-independent six-agent collection: passed.
- Eight-court mapping and Egress capacity visibility: passed while idle. Egress
  busy workers are now classified as healthy, not unavailable, and paging is
  gated to assigned live work.
- Monitoring contract v2 media profiles: deployed to all six agents. All eight
  raw feeds report bounded source protocol/mode, video profile/resolution, and
  audio format. Push-SRT courts expose RTT and packet counters; pull-SRT and
  RTMP paths remain explicitly unavailable rather than fabricated.
- Prometheus rules (37 syntax-validated plus executable timing/isolation tests)
  and correlator unit/fault fixtures: passed. Every observability deployment
  reruns these gates before replacing files or restarting containers.
- Deterministic eight-court isolation fixtures for camera loss, repeated picture,
  compositor-pair loss, score-render mismatch, YouTube API unknown, and shared
  score-worker deduplication: passed. These are code gates, not real-feed gates.
- Expanded WebRTC, visual-content, camera-audio, and commentary telemetry: passed
  type/schema/unit validation. A ten-hour one-court transport and sync soak
  completed without restart, OOM, frame stall, MediaMTX path failure, or egress
  error; the injected fault matrix and camera reconnect gate remain outstanding.
- Durable incident, acknowledgement, checkpoint, and silence lifecycle: the
  original episode passed, but the first post-restart recurrence gate exposed
  global fingerprint uniqueness and failed durable opening/paging. Migration
  022 plus the matching monitor-service implements true incident episodes; a
  fresh physical recurrence gate is still required after deployment and after
  Camera 1 has returned to a healthy baseline.
- Production web and monitor builds: passed.
- Healthchecks baseline delivery and active idle-pause lifecycle: configured; the
  withheld-ping phone delivery gate remains outstanding because the project
  currently has email as its Healthchecks notification channel.
- Pushover delivery and one-time recovery: operational. A false Egress storm
  exposed an idle/busy semantic error and over-broad recovery fan-out; both are
  corrected in production. Controlled acknowledgement and escalation tests are
  still required. Twilio authentication is valid, but SMS remains disabled until
  the account has an approved SMS-capable sender.
- Authenticated production visual check: requires an existing admin login because
  Vercel does not export the sensitive admin secret. The exact deployed build
  passed local authenticated validation against the live read-only API at
  1600x1000 and 390x844 with eight cards, a four-column wide layout, no
  horizontal overflow, and no browser console warnings or errors.
- First eight-feed load attempt: failed the shared-normalizer topology. One `c-4`
  normalizer reached about 394 percent CPU and sustained only 18-24 fps at
  0.59-0.81x realtime; Egress accepted all eight jobs and compositor capacity was
  not the bottleneck. Split normalization or qualify camera-side 720p H.264 before
  repeating the gate.
- Remaining real one-court and eight-court fault injection requires the next
  isolated test-feed session and explicit approval. Never simulate a pass by
  stopping public production services.
