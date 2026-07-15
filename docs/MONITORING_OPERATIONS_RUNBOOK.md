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
  Egress-output, and YouTube symptoms;
- a missing program branch inhibits matching Egress-output,
  browser/render/YouTube symptoms;
- a missing or low-FPS program browser inhibits matching render/YouTube symptoms;
- an unavailable Egress worker inhibits its output-deficit symptoms;
- an Egress capacity deficit inhibits per-court output-deficit symptoms on the
  same worker;
- a court Egress output deficit inhibits its matching browser-missing and
  low-FPS symptoms;
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
the incident remains critical, primary paging is re-armed. When optional SMS
escalation is enabled, its clock starts from that new primary delivery.

Do not silence an unexplained failure. Do not use a silence as a substitute for
setting a court `OFF` after coverage.

## Phone paging and dead-man activation

The required phone path is Pushover emergency priority with acknowledgement.
Recovery notifications are deduplicated and are sent only through providers
that delivered the opening incident. Twilio SMS is intentionally disabled and
is not part of the current release or acceptance gate. Do not delay Pushover
readiness for A2P registration. If SMS is reconsidered later, it must first prove
real delivery with a restricted API key; no public status callback or account
auth token is required.

The required provider configuration uses these protected values:

```text
PUSHOVER_APP_TOKEN
PUSHOVER_USER_KEY
HEALTHCHECKS_BASELINE_PING_URL
HEALTHCHECKS_BASELINE_CHECK_ID
HEALTHCHECKS_ACTIVE_PING_URL
HEALTHCHECKS_API_KEY
HEALTHCHECKS_ACTIVE_CHECK_ID
```

Optional Twilio escalation additionally uses `TWILIO_ACCOUNT_SID`,
`TWILIO_API_KEY_SID`, `TWILIO_API_KEY_SECRET`, `TWILIO_FROM_NUMBER`, and
`TWILIO_TO_NUMBER`.

Store them only in the protected monitoring environment on the observability
host and in the protected local deployment file. Never commit them. Pushover
and both Healthchecks checks are configured in production. Twilio is
unconfigured in the live monitoring service and must remain skipped unless a
future operator explicitly reopens it after a real SMS delivery pass. The
baseline dead-man pings every ten minutes at all times. The active check pings
every minute while any court expects coverage and is explicitly paused through
the Healthchecks management API while the system is idle. A live ping resumes it
automatically.
The service audits the Healthchecks channel list and both check assignments every
five minutes using three read-only API requests, with a thirty-second retry after
provider failure. The dashboard may show `Coverage protected` or `Idle protected`
only when the pings are healthy and the Healthchecks Pushover integration is
attached to both checks. Missing attachment or failed audit degrades the Watchdog
item and the overall system header. The external provider must notify a phone
independently of DigitalOcean, Supabase, Vercel, and ScoreCheck.

Phone notifications use operator language only. Every opening notification has
`Problem:` and `Do this:` lines, identifies the permanent camera number when
applicable, and omits internal stage names, service names, and issue codes.
Recovery messages state what is working again and whether any action remains.

Provider activation is not accepted until all of these pass:

1. Pushover emergency arrives, repeats, deep-links to the monitor, and stops on acknowledgement.
2. Recovery sends once and cancels any active emergency receipt.
3. Baseline and active dead-man checks both alert when their pings are withheld.
4. The dashboard shows Push independently and does not degrade merely because
   the optional SMS path is disabled.
5. The dashboard Watchdog shows both Healthchecks checks as phone protected, and
   removing the Pushover channel from either check raises exactly one durable
   plain-English configuration incident.

If Twilio is enabled later, add a separate acceptance gate proving exactly one
SMS escalation and one provider-matched recovery without changing the Pushover
acceptance criteria above.

### Controlled Healthchecks withheld-ping gate

Do not run this gate during an event, soak, camera fault, media test, or active
incident. Do not arm it merely because the API exists. Nathan must first send the
exact approval `READY FOR PUSHOVER GATE` in the operating task so the expected
phone alert is not mistaken for a real outage.

The monitor API provides:

```text
GET    /v1/dead-man-test-gate
POST   /v1/dead-man-test-gate/arm
DELETE /v1/dead-man-test-gate
```

The arm body is strict JSON:

```json
{
  "check": "baseline",
  "durationSeconds": 900,
  "actor": "nathan",
  "reason": "Prove external baseline Pushover delivery."
}
```

Use `active` with a 180-second duration for the active check under the current
provider settings. These durations are examples, not assumptions: the service
reads the provider's live timeout and grace and rejects any duration that does
not cross the alert deadline by at least thirty seconds. It sends a fresh ping
at arm time and returns `withholdFrom`, `expectedAlertAt`, and `expiresAt` for the
evidence record. Exactly one gate can exist. Preconditions require a fresh
healthy idle snapshot, no event, no expected coverage, no incidents, no court
fault gates, healthy checks, and Pushover attached to both checks.

Run baseline and active as two separate gates. Capture the API response and
Healthchecks status transitions in a protected evidence file, record Nathan's
phone receipt time explicitly, and verify `GET /v1/dead-man-test-gate` returns
`null` after automatic recovery. The active gate sends recovery, waits thirty
seconds, and then returns the check to `paused`. `DELETE` requests immediate
recovery if an operator must cancel. Starting coverage or restarting the service
also aborts safely and restores provider pings. Neither path touches cameras,
MediaMTX, routing, browsers, Egress, YouTube, Supabase expectations, or StreamRun.

The channel-readiness contract is a hard cutover. Configure
`HEALTHCHECKS_BASELINE_CHECK_ID`, deploy the matching monitor service, verify the
new snapshot field, then deploy the matching rules and web build. Do not deploy
the new rules while either check still lacks Pushover, because the missing-channel
alert is intentionally critical.

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

The executable migration queue has one file per monotonically increasing
version. The unapproved vision receipt schema remains outside that queue at
`apps/web/supabase/proposals/vision_shadow_receipts.sql`; do not copy, mark, or
apply it during a monitoring cutover. Do not use `--include-all` or run an
unverified `supabase db push`: require `db push --dry-run` to list exactly the
intended monitoring migration before applying it.

From `infra/monitoring` with the protected environment loaded:

```bash
npm ci
npm run typecheck
npm test
npm run build
MONITOR_SSH_HOST=root@OBSERVABILITY_PUBLIC_IP ./deploy.sh
```

This routine deployment recreates only `monitor-service`. It verifies the new
revision and public health before synchronizing and reloading its matching
Prometheus rules, and it fails if Prometheus, Alertmanager, Caddy, or
node-exporter changes container identity. On failure it restores the prior
service image, environment, rules, scrape config, and source provenance.
Compose topology, Caddy, and Alertmanager changes are rejected here and require
a separate, explicitly reviewed infrastructure cutover.

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

Arming is a hard-cutover contract and requires an explicit `profile` in the
JSON body. Use `RAW_ONLY` for publisher-loss or uplink tests. Use
`PROGRAM_CONTENT` only when a protected Program viewer is planned for
black-picture, repeated-picture, or camera-audio analysis. That profile enables
camera content analysis for the test camera while scoring, commentary,
YouTube, Egress, and production control remain off. Requests without a profile
are rejected instead of guessing operator intent.

```json
{
  "profile": "RAW_ONLY",
  "actor": "operator-id",
  "reason": "Isolated Camera 4 publisher-loss test",
  "durationSeconds": 900
}
```

Start the read-only evidence recorder before the operator introduces a fault.
It samples only the sanitized monitor API, writes an exclusive mode-0600 JSONL
artifact outside the repository, never arms a gate, and never changes media or
Supabase. The first fault-ready sample prints `BASELINE READY`; do not trigger
the physical/provider fault before that line appears.

```bash
./infra/monitoring/capture-fault-evidence.mjs \
  --court 1 \
  --duration-seconds 300 \
  --expected-issue REQUIRED_RAW_PATH_MISSING \
  --require-recovery \
  --durable-evidence \
  --require-pushover-open \
  --require-pushover-recovery \
  --output "$HOME/.config/scorecheck/fault-evidence/camera1-$(date -u +%Y%m%dT%H%M%SZ).jsonl"
```

`--durable-evidence` requires protected `SUPABASE_URL` and
`SUPABASE_SERVICE_ROLE_KEY` environment values. It performs one bounded
read-only evidence phase before sampling and one after sampling; it does not
poll Supabase. The artifact omits provider receipt identifiers and credentials,
but records the incident episode, sanitized transition types, notification
statuses, checkpoint movement, and table-count deltas. When an operator will
acknowledge the emergency in Pushover during the window, also add
`--require-pushover-acknowledgement`.

Use `--allowed-peer-courts` only for a deliberately shared-host fault whose
approved blast radius includes that exact pair. A dirty first sample, any API
gap, an unhealthy collector, stale or malformed durable state, duplicate
incident/notification episodes, a missing expected issue, missing recovery, or
an unapproved peer impact makes the recorder exit nonzero. The artifact is gate
evidence, not permission to modify the dependency under test.

For real camera-content faults on an otherwise unused direct-publisher Camera
2-5 path, use the bounded synthetic feed controller instead of changing a
physical camera or MediaMTX configuration:

```bash
./infra/monitoring/run-test-feed-container.sh \
  --court 4 \
  --scenario freeze \
  --output "$HOME/.config/scorecheck/fault-evidence/camera4-feed-$(date -u +%Y%m%dT%H%M%SZ).jsonl"
```

The container wrapper is the required operator path. It builds a source-hashed,
read-only image from the pinned Node base, verifies SRT, RTMP, H.264, and AAC
support at build time, drops Linux capabilities, applies CPU/memory/PID limits,
and records the image, source, and wrapper hashes in the protected evidence.
The underlying Node script also fails closed before publishing when a directly
selected host FFmpeg lacks any required capability; direct execution is for
development diagnostics, not a live fault gate.

The controller loads publishing credentials only from protected
`MEDIAMTX_PUBLIC_HOST`, `MEDIAMTX_COURT_N_PUBLISH_USER`, and
`MEDIAMTX_COURT_N_PUBLISH_PASS` environment values. It never prints the output
URL, never invokes a shell, and writes only sanitized mode-0600 evidence. It
refuses Camera 1 and listener/pull Cameras 6-8, an occupied selected path, an
active event, an existing gate or incident, stale agents, unhealthy Pushover or
dead-man state, and any peer already needing attention.

The controller first publishes a moving 1280x720/30 H.264 + AAC baseline. After
it prints `TEST FEED READY`, the operator must arm the exact requested profile,
start `capture-fault-evidence.mjs`, and, for `PROGRAM_CONTENT`, open exactly one
protected Program viewer. Enter `FAULT` only after its second preflight passes.
Available scenarios are `freeze`, `black`, `camera-silence`, and
`publisher-loss`. Enter `RECOVER` after detection and phone evidence, leave the
normal feed running through durable recovery, disarm the gate, and enter
`STOP`. `STOP` is refused while a gate or incident remains active. Terminal
input loss restores and holds the normal feed until the bounded gate has ended
instead of creating another camera outage. An unexpected publisher exit gets
one normal-feed containment restart. A failed retry or any later exit stops the
publisher and records the bounded safety failure instead of creating an
unbounded restart loop.

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
| Close program browser | `PROGRAM_BROWSER`, stale heartbeat | 30 seconds |
| Disconnect commentator | `COMMENTARY` only when commentary is required | 20 seconds |
| Mute, clip, or silence commentator | exact commentary issue code; no camera-stage fault | 75 seconds |
| Corrupt score/render fixture | `SCORE_SOURCE` or `SCORE_RENDER`; detect 67-67 | 15 seconds |
| Stop test Egress job | `EGRESS`; program input remains diagnosable | 25 seconds |
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
- expected simultaneous outputs do not exceed any worker's qualified maximum;
- court bitrate and FPS stay within the selected profile;
- score source and rendered scorebug remain aligned;
- every injected single-court fault identifies that court without paging the other seven;
- one compositor fault affects only its assigned pair;
- Pushover acknowledgement, silence expiry, and recovery each deduplicate;
- Twilio remains out of scope unless carrier registration completes and a real
  SMS delivery is separately qualified;
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
- Production revision `34739305cfc439123ec070e0231ce2bbe1853b84` runs 49
  syntax-validated Prometheus rules with executable timing/isolation fixtures.
  Its release gate passed 141 correlator/monitor tests and 27 disposable
  Alertmanager inhibition fixtures. Every observability deployment reruns these
  gates before replacing files or restarting containers.
- Deterministic eight-court isolation fixtures now cover camera loss, repeated
  and black pictures, stopped Egress output, Egress capacity deficit, missing
  program browser, commentary disconnect/mute/clip/silence/jitter/sync loss,
  compositor-pair loss, score-render mismatch, definitive and unknown YouTube
  states, and shared score-worker deduplication. These are code gates, not
  real-feed gates.
- Expanded WebRTC, visual-content, camera-audio, and commentary telemetry: passed
  type/schema/unit validation. A ten-hour one-court transport and sync soak
  completed without restart, OOM, frame stall, MediaMTX path failure, or Egress
  error. The later physical Camera 1 gate passed raw loss/recovery, same-page
  interruption/recovery, sole-reader drainage, a 30.003 fps stable window with
  no counter growth, and subjective A/V sync. The remaining real fault-table
  rows are still outstanding.
- Durable incident, acknowledgement, checkpoint, and silence lifecycle:
  migration 022 and the matching incident-episode service are deployed. The
  post-restart physical recurrence opened a new durable episode, delivered one
  opening Pushover, resolved from observed feed recovery, delivered one recovery,
  and left Cameras 2-8 isolated. The false expiry-recovery and reused-fingerprint
  defects are closed.
- Production web and monitor builds: passed.
- Healthchecks baseline delivery and active idle-pause lifecycle: configured;
  the deployed read-only audit confirms the Pushover channel is attached to both
  required checks. Only the controlled withheld-ping phone delivery/recovery
  gate remains outstanding.
- Pushover delivery and one-time recovery: operational. A false Egress storm
  exposed an idle/busy semantic error and over-broad recovery fan-out; both are
  corrected in production. A controlled acknowledgement test is still required.
  Twilio SMS is optional and remains disabled until campaign/number association
  and real delivery are verified.
- Authenticated production visual check: passed against the live read-only API
  at 1600x1000 and 390x844. The dashboard shows eight permanent Camera labels,
  two cards per desktop row and one per narrow mobile row, low-data 256x144
  snapshots, one operator-selected live reader, no horizontal overflow, and no
  browser console warning or error.
- First eight-feed load attempt: failed the shared-normalizer topology. One `c-4`
  normalizer reached about 394 percent CPU and sustained only 18-24 fps at
  0.59-0.81x realtime; Egress accepted all eight jobs and compositor capacity was
  not the bottleneck. Split normalization or qualify camera-side 720p H.264 before
  repeating the gate.
- The current four compositor workers are each qualified for one active web
  Egress request while each owns two courts. Therefore they cannot qualify an
  eight-simultaneous-output gate as configured. The new capacity rule fails this
  state closed; add qualified workers or explicitly requalify higher per-worker
  capacity before the real eight-court gate.
- The hardened 30-minute one-court `c-4` capacity gate passed 363/363 host
  samples, media/browser quality, one-of-one admission, process lifecycle,
  peer isolation, unlisted YouTube health, and ordered teardown. This qualifies
  one output per current compositor, not two.
- Approval for isolated test-feed faults is recorded. Each phone-visible or
  physical fault still needs an explicit timing window and fresh healthy
  baseline. Never simulate a pass by stopping public production services.
