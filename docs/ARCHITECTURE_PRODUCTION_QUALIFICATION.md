# ScoreCheck Architecture Production Qualification

Date: 2026-07-22
Implementation baseline before this gate: `036b88100fba019f53822a9760fa7d84be4959bf`
Status: implementation and physical qualification in progress

## Purpose

This document reconciles the external architecture review with the checked-in
ScoreCheck implementation. It is the release ledger for the next production
qualification cycle, not proof that a deferred live gate has passed.

The target remains:

- permanent Camera 1 through Camera 8 identities;
- temporary DigitalOcean event infrastructure with provider-zero teardown;
- one compositor per active camera plus one warm spare;
- no more than 15 DigitalOcean Droplets;
- 1080p30 or 1080p60 final YouTube output, never an implicit 720p fallback;
- HEVC available as a venue-bandwidth-saving source only through a qualified
  browser-compatible normalization path;
- media continuity prioritized over scoring, commentary, monitoring, and
  control-plane availability.

## Status Definitions

| Status | Meaning |
| --- | --- |
| `SATISFIED` | The checked-in implementation and tests already enforce the recommendation. Live evidence may still be required by an event gate. |
| `PARTIAL` | A material portion exists, but the contract or proof is incomplete. |
| `REQUIRED` | A confirmed implementation defect blocks production qualification. |
| `DEFERRED` | The change is reasonable but requires physical, provider, or production-shaped evidence before implementation or approval. |
| `REJECTED` | The recommendation conflicts with measured constraints, duplicates an existing control, or adds unjustified complexity. |

## Executive Decisions

1. Keep DigitalOcean, event-scoped create/destroy, stable endpoint anchors, and
   the 12-host primary fleet. No provider migration or quota request is part of
   this work.
2. Keep one compositor per camera. Do not consolidate courts onto larger shared
   hosts without a later measured economic and reliability case.
3. Keep HEVC as an allowed camera-side bandwidth profile, but hard-reject HEVC
   from direct WHEP admission. Linux Chromium must receive H.264 with no
   B-frames. The normalizer location will be selected by a production-shaped
   benchmark, not by assumption.
4. Do not put eight software HEVC normalizers on the shared four-vCPU ingest
   host. Prior evidence already showed inadequate headroom there.
5. Do not add a dedicated normalizer Droplet per camera. That cannot fit the
   15-Droplet account ceiling. The only viable HEVC candidate is compositor-local
   normalization, or camera-side H.264 when local normalization cannot qualify.
6. Do not add a thirteenth warm-ingest host by default. First rehearse the
   existing warm compositor spare as an ingest replacement. A thirteenth host is
   admitted only if the simpler dual-role recovery cannot meet the declared RTO.
7. Preserve the existing Pushover-only notification contract. Twilio is not in
   scope.
8. Use hard cutovers. No feature flag is allowed without Nathan explicitly
   saying `NEW FEATURE FLAG APPROVED`.

## P0 Release Ledger

### Media Input And Browser Compatibility

| ID | Review item | Status | Checked-in evidence | Required disposition / proof |
| --- | --- | --- | --- | --- |
| M-01 | Do not copy HEVC directly into Linux Chromium WHEP | `SATISFIED` | Venue admission permits only `direct-h264` or `isolated-hevc-normalizer`. MediaMTX exposes `courtN_normalized`; the preview runner selects raw H.264 or normalized H.264, and the compositor normalizer fails closed unless HEVC is explicitly assigned. | Physical HEVC use remains prohibited until M-12 passes. |
| M-02 | Correct MediaMTX documentation | `SATISFIED` | MediaMTX documentation and runner tests now describe the exact direct-H.264 versus isolated-HEVC topology and keep monitor renditions separate from final 1080 output. | Keep documentation synchronized with runner changes. |
| M-03 | H.264 entering WHEP has no B-frames | `SATISFIED` | Both production profile and capacity gates inspect `has_b_frames`; direct H.264 and normalized browser input require zero. | Retain physical camera fixtures. |
| M-04 | Browser-safe pixel format and progressive scan | `SATISFIED` | Browser input requires explicit `yuv420p` and progressive scan; missing or incompatible metadata fails closed. | No permissive `unknown` production path remains. |
| M-05 | Exact 29.97/30/59.94/60 source modes | `SATISFIED` | Rational frame rates are bound to the per-camera venue profile and limited to `30000/1001`, `30/1`, `60000/1001`, or `60/1`. | Qualify only the modes the specific camera model supports. |
| M-06 | Two-second-or-shorter source GOP | `SATISFIED` | Bounded packet traces require at least two keyframes and reject intervals above 2.1 seconds. | Preserve the trace with event evidence. |
| M-07 | Bounded source and browser timestamps | `SATISFIED` | Bounded packet traces require finite, strictly monotonic DTS and reject greater-than-one-second DTS gaps for every source. Direct/browser H.264 also requires nondecreasing PTS; raw HEVC may use decode-order PTS reordering, but its normalized H.264 browser output may not. | Preserve both raw and normalized traces with event evidence. |
| M-08 | Per-camera minimum and maximum source bitrate | `SATISFIED` | Venue profiles bind source caps; capacity evaluation enforces p05 minimum, observed maximum, positive growth, and the aggregate venue reserve. | Router-side fairness remains an operator-attested venue control. |
| M-09 | Audio present/decodable or intentional continuous silence | `SATISFIED` | Source admission requires exactly one AAC 48 kHz stereo track; browser input requires Opus 48 kHz stereo; the program graph retains an inaudible continuous source when real audio disappears. | Physical output continuity remains part of the commentary/output gate. |
| M-10 | Source stability window and duplicate ownership | `SATISFIED` | The capacity gate requires continuous ready identity, exact profile, one unchanged publisher generation, positive bytes, and no frame errors across the admission window. | Preserve event-bound camera identity evidence. |
| M-11 | Camera model and firmware in source contract | `SATISFIED` | Every enabled venue-profile camera now binds permanent identity, model, firmware, transport, codec, path mode, frame mode, and rate cap. | Values are operator-attested because ffprobe cannot infer hardware firmware. |
| M-12 | HEVC normalization placement | `DEFERRED` | A compositor-local, one-camera HEVC-to-H.264 normalizer and telemetry contract are implemented; shared-ingest normalization remains prohibited. Runtime adoption now requires an exact camera, source-profile, frame-rate, path, and private-ingest binding. No production-shaped 1080p30/60 qualification artifact exists yet. | Benchmark normalizer plus browser, commentary, and Egress at both intended modes before enabling HEVC at an event. |

### Final Output Conformance

| ID | Review item | Status | Checked-in evidence | Required disposition / proof |
| --- | --- | --- | --- | --- |
| O-01 | Explicit 1080p30 and 1080p60 Egress settings | `SATISFIED` | `infra/compositor/start-court.sh` explicitly requests 1920x1080, 30/60 fps, H.264 High, 10/12 Mbps, AAC 128 kbps/48 kHz, and a two-second keyframe interval. | Retain tests and verify the encoded output, not only the request body. |
| O-02 | Remove production 720p fallback | `SATISFIED` | Active production and rehearsal consumers accept only explicit `1080p30` or `1080p60`; stale 720p publisher/destination fixtures were hard-cut. Low-resolution monitor media remains a separate non-output path. | Legacy protected-capture import validation is not an output fallback. |
| O-03 | Actual encoded-output ffprobe | `SATISFIED` | `output-conformance.mjs` captures a protected sample, runs the compositor qualifier, verifies dimensions/fps/profile/GOP/scan/SAR/color/audio/bitrate, hashes the artifact, and binds it to renderer and destination identity. | A fresh artifact is required for each production output generation. |
| O-04 | YouTube profile and health confirmation | `SATISFIED` | Production-soak admission binds output conformance to exact stream/broadcast IDs, renderer identity, active/good YouTube health, privacy, and binding before acceptance. | Retain provider evidence through shutdown. |
| O-05 | Stable output audio through joins/leaves | `SATISFIED` | The long-lived audio graph and protected commentary qualification require continuous AAC stereo output through camera and commentator join/drop/rejoin. | Physical proof is required in the event qualification artifact. |

### Renderer And Control-Plane Independence

| ID | Review item | Status | Checked-in evidence | Required disposition / proof |
| --- | --- | --- | --- | --- |
| R-01 | Pin exact renderer Git/deployment/assets/contracts per event | `SATISFIED` | A protected renderer binding captures canonical and generated Vercel origins, exact deployment ID, Git SHA, asset namespace, and overlay/commentary/heartbeat contracts; the event bundle hashes it. | Capture a fresh binding for each event release. |
| R-02 | Restart reloads the same approved renderer | `SATISFIED` | Compositors require a generated immutable Vercel origin and exact renderer identity. The bootstrap session and browser heartbeat reject deployment/build drift. | Physical restart remains an acceptance-matrix gate. |
| R-03 | Existing scene survives Vercel loss | `PARTIAL` | `renderer-loss-rehearsal.mjs` now reuses an active eight-feed synthetic production soak and blocks only one Egress container's immutable generated Vercel IPv4 destinations. Its owned firewall runtime is Egress-generation-bound, blocks TCP/UDP 443, rejects IPv6 ambiguity and DNS/container drift, restores exactly, and evaluates same-page/reset-safe media, score, peer, and YouTube continuity. Provider-free regressions pass; no attended host artifact exists yet. | Run the attended synthetic gate with Egress live. Existing video/audio/last-good score must continue without navigation, then recover on the same build and page. |
| R-04 | Existing scene survives Supabase loss | `PARTIAL` | Video and commentary are separate from scoring, and the overlay is fail-transparent. Authoritative repair failure preserves the last-good overlay object and reports disconnected state as stale in the browser heartbeat. The camera-free gate now includes a precomputable event-scoped public URL, generation-bound loopback sidecar and state, temporary exact Caddy route, durable fault/restore evidence, output-idle mutation guards, exact rollback, synthetic-soak runner, and reset-safe evaluator. It interrupts authoritative HTTP repair and Realtime together and records only aggregate counters. A browser-only Supabase block remains explicitly invalid. | Deploy the isolated synthetic renderer against the event-scoped proxy URL, prepare the route before starting Egress, run fault/recovery during the attended soak, stop all outputs, then clean the route and retain the protected PASS artifact. No production scoring outage is authorized. |
| R-05 | Program token leakage protections | `SATISFIED` | The protected token is carried only in a URL fragment to a one-time bootstrap, exchanged for a scoped HttpOnly session, then removed by navigation. Program routes enforce private/no-store, no-referrer, strict CSP, and redacted startup output. | Keep third-party resources absent from program routes. |
| R-06 | Bounded browser supervisor | `SATISFIED` | `program-supervisor.mjs` acts only when raw/program/Egress remain healthy while the browser is unavailable for six consecutive samples. It preserves event/destination/output-generation/renderer ownership, permits at most two restarts with a ten-minute cooldown, persists a prepared restart before mutation, resumes it safely, and fails closed after exhaustion. Any restart remains visible and fails the qualification run rather than being hidden. | Prove one bounded recovery on the exact immutable renderer during the physical restart gate. |
| R-07 | Separate renderer deployment blast radius | `DEFERRED` | Admin and program routes currently share the web project. | First prove immutable production deployment pinning. Split the renderer project only if pinning cannot prevent admin deployments from affecting restarted scenes. |
| R-08 | Fully local renderer bundle | `REJECTED` | It would duplicate hosting/build/runtime concerns before immutable deployment pinning is tested. | Reconsider only if an external renderer outage still prevents the declared recovery objective. |
| R-09 | Overlay exception does not interrupt program media | `SATISFIED` | The scorebug error boundary reports failed score-render health, retries only its own subtree once, and then renders transparently. `overlay-exception-rehearsal.mjs` now prepares a generation-bound debug channel only while the target worker is idle, connects through a loopback SSH tunnel to the exact active Egress Chrome page, installs a dormant exception, restores the ordinary host config before arming, and evaluates same-page media, score-render, peer, Egress, and YouTube continuity. Provider-free command, browser-injection, interruption-recovery, and evidence regressions pass. | Run the attended synthetic gate and retain its protected host artifact. A separate inspection browser, a renderer that starts already faulted, or unit tests alone are not qualifying proof. |

### Commentary

| ID | Review item | Status | Checked-in evidence | Required disposition / proof |
| --- | --- | --- | --- | --- |
| C-01 | Low-latency commentator return video | `SATISFIED` | The commentary court mounts the community witness live preview and exports preview timing to the commentary audio client. | Bind a physical return-video latency observation to event readiness. |
| C-02 | Return ambience and other commentators, excluding self | `SATISFIED` | The preview carries camera ambience; LiveKit remote tracks exclude the local microphone; headphones are required. The protected production qualification now requires a two-commentator mix-minus observation. | Retain a fresh event-bound physical artifact. |
| C-03 | Stable gain, compression, delay, and monitoring | `SATISFIED` | ProgramAudioMixer has camera/commentary gains, compressor, per-track delay, RMS/peak/clipping/silence, packet loss, jitter, and clock synchronization telemetry. | Preserve existing tests and physical sync evidence. |
| C-04 | Continuous silence and fixed final stereo layout | `SATISFIED` | The persistent AudioContext includes an inaudible always-on source; the protected qualification requires AAC stereo 128 kbps/48 kHz continuity and centered commentary within one dB. | Physical qualification must cover camera/commentator join and loss. |
| C-05 | Per-commentator gain and ambient ducking | `DEFERRED` | Global commentary gain and limiting exist. Per-person controls/ducking are enhancements, not current release blockers. | Add only after observed operational need; do not complicate the first qualified mix. |
| C-06 | Objective flash/clap calibration | `SATISFIED` | Timing telemetry and calibration paths are paired with a protected event qualification that requires a timestamped flash/clap observation within plus or minus 250 ms. | Repeat after a material network or commentary-path change. |
| C-07 | TURN/TLS and restrictive-network qualification | `SATISFIED` | Production bundle admission requires a protected UDP-blocked TURN/TLS-over-443 observation of at least 120 seconds with no path change. | The artifact must come from the actual restrictive client network, not a synthetic claim. |
| C-08 | Commentary remains optional | `SATISFIED` | Program start uses a bounded commentary wait and treats missing commentary as health data; video/ambient are independent. | Retain physical join/drop/rejoin gate. |

### Venue Admission And Local Network

| ID | Review item | Status | Checked-in evidence | Required disposition / proof |
| --- | --- | --- | --- | --- |
| V-01 | Manifest-controlled constrained/standard/priority profiles | `SATISFIED` | The protected venue profile defines `CONSTRAINED_1080P30`, `STANDARD_1080P30`, and selected `PRIORITY_1080P60`, with an explicit enabled Camera 1-8 set and source/output assignments. | Use only profiles physically supported by each declared camera model. |
| V-02 | Aggregate upload admission with reserve | `SATISFIED` | Venue admission sums enabled-camera source caps, applies the 30 percent reserve, and rejects stale or insufficient measured sustained upload. | Refresh the venue measurement before each event. |
| V-03 | Per-camera source caps/fairness | `SATISFIED` | Each camera has a manifest cap and physical readiness attests router QoS/fairness; capacity gates reject observed maximum violations. | Device/router enforcement remains a venue responsibility and must be observed during soak. |
| V-04 | Fail-closed bonded routing | `SATISFIED` | Speedify routing, guard table, kill switch, watchdog, and controlled failure gates are documented and tested. | Preserve the event-router preflight and never silently bypass bonding. |
| V-05 | Reduced-bitrate single-WAN break-glass | `DEFERRED` | The operator contract is documented below, but no automatic or runtime fallback is implemented. | Rehearse the explicit priority-court procedure before enabling it. Default bonded routing remains fail closed. |
| V-06 | Camera VLAN/wired/QoS/RF/UPS/thermal readiness | `SATISFIED` | The venue profile requires timestamped operator attestations for isolation, wired links or approved wireless exceptions, QoS, RF survey, router thermal headroom, protected power/UPS runtime, cabling, weather protection, and spare power. | Do not fabricate sensors; retain observed/operator evidence. |
| V-07 | Local ISO recording | `DEFERRED` | This protects footage but not live continuity and depends on camera/venue storage. | Add as a finals checklist item after live-path P0 gates pass. |

## P1 Reliability Ledger

### Ingest, VPC, Compositor, And YouTube Recovery

| ID | Review item | Status | Checked-in evidence | Required disposition / proof |
| --- | --- | --- | --- | --- |
| I-01 | Private VPC agent/control traffic | `SATISFIED` | Deployment plans bind monitor agents to private addresses and scrape through the VPC. Firewall contracts pin the event VPC. | Retain provider/network drift checks. |
| I-02 | Private VPC compositor-to-ingest media | `SATISFIED` | Compositor host mapping resolves the public TLS/SNI name to the ingest private address, browser heartbeat reports the selected media path, and production/rehearsal gates require `private-vpc`. | Verify selected ICE/path evidence on the live fleet. |
| I-03 | Warm ingest replacement | `PARTIAL` | `ingest-recoveryctl.mjs` binds the controller to the protected atomic mode-0600 state store and process lock. The SSH/service adapter stages stopped MediaMTX, WireGuard, and retained Caddy TLS state on the existing compositor spare; attaches and removes only the exact ingest network policy; reconciles Reserved-IPv4 ownership; rebinds each compositor; checkpoints the current immutable output owner after every replacement Egress; switches the single MediaMTX monitoring role; and restores the spare compositor. A camera-independent production rehearsal now launches eight protected synthetic source loops only after proving all raw paths idle, uses the ordinary production soak and outputs, owns a tightly bounded primary MediaMTX/Caddy fault, and records reset-safe stable baseline/spare/rollback evidence plus five-minute takeover and rollback RTO gates. Preparation, takeover, rollback, failure resume, lost provider responses, repeated staging, legacy deployment upgrades, rehearsal ownership, and evaluation have provider-free regression coverage. No unassigned Reserved-IP interval or automatic transition is introduced. | Execute the implemented runner on an attended paid 12-host event generation and retain its provider/host/output/monitor report. Keep the dual-role spare unless measured evidence shows a thirteenth host is necessary. Physical-source confirmation remains part of the later camera gate, not this implementation claim. |
| I-04 | Dedicated thirteenth ingest standby | `DEFERRED` | Account limit 15 permits it, but it raises the ordinary event fleet from 12 to 13. | Admit only if dual-role spare recovery misses the measured RTO or creates unacceptable operational risk. |
| I-05 | Active-active ingest | `REJECTED` | Complexity and dual-publisher behavior are unjustified for the current scale. | No action. |
| I-06 | One Egress per compositor | `SATISFIED` | `start-court.sh` serializes starts, verifies active count zero, and the agent contract enforces one active request maximum. | Retain multiplicity fault tests. |
| I-07 | Orphaned Egress reconciliation/idempotency | `SATISFIED` | Every Egress now has a protected atomic owner record binding event, camera, destination, output generation, renderer Git/deployment, output profile, Egress ID, and request digest. Starts, resume, second-admission proof, stop, and supervisor replacement reconcile exact active process plus owner/digest and reject ambiguous or changed ownership. | Retain a production interruption/resume artifact; never manually delete an owner record to force adoption. |
| I-08 | Dedicated-CPU compositor benchmark | `DEFERRED` | Production-shaped capacity harness exists; current event fleet deliberately uses the declared compositor pool shape. | Compare qualified c-4/c-8 and current shape using p95/p99 CPU, steal, encode speed, frame pacing, `/dev/shm`, memory, cold/warm start, and cost. Do not resize from average CPU. |
| I-09 | Spare to YouTube backup ingest | `PARTIAL` | Production destination admission requires distinct primary and backup RTMPS ingestion addresses. A protected one-court runner gives primary and backup Egresses explicit ownership roles, stages the shared stream key only on the spare, verifies dual/backup-only/restored/primary-only topology and provider health, restores primary before removing backup on every handled failure path, and removes the temporary assignment. One bounded no-cookie viewer now remains open through the full transition, samples playback every 250 ms, fails on a sample gap over one second or playhead stall over two seconds, verifies reset-safe audio growth and changing nonblank phase frames, and requires the complete ordered transition marker set. Losing that viewer process makes an otherwise safe resumed gate fail rather than inventing continuity. Provider-free regressions pass. | Run the attended gate against one selected synthetic priority court and retain its protected continuous-viewer artifact. Unit tests do not prove live provider continuity. |
| I-10 | YouTube lifecycle and destination ownership | `SATISFIED` | Production YouTube code validates stream/broadcast IDs, binding, privacy, lifecycle, health, issues, watch page, and distinct primary/backup RTMPS identities. Egress owner schema 2 binds each output to `primary` or `backup`. | Retain output-conformance and exact role ownership evidence. |

### Monitoring, Evidence, And Paging

| ID | Review item | Status | Checked-in evidence | Required disposition / proof |
| --- | --- | --- | --- | --- |
| A-01 | Correlated expected-state incidents | `SATISFIED` | Monitoring distinguishes expected-off from failure, tracks incident episodes, deduplicates notification kinds, and has reset-safe browser counters. | Retain fault-gate tests. |
| A-02 | Pushover emergency receipts and cancellation | `SATISFIED` | `notifications.ts` stores emergency receipt IDs, polls acknowledgement, and cancels on acknowledgement, silence, or dependency recovery. | No duplicate notification system. Twilio remains removed. |
| A-03 | State-aware Healthchecks | `SATISFIED` | Baseline/active schedules and channel audits exist. Teardown stops the event-scoped sender, pauses baseline, active, and sentinel checks, verifies all three paused, and restores services instead of deleting compute if provider maintenance fails. Live provider-zero verification at `2026-07-22T13:28:51Z` proved all three paused with their intended channels. | Retain live subscription audit and preserve automatic pause evidence from the next teardown. |
| A-04 | Local incident outbox during Supabase loss | `SATISFIED` | The monitoring service has a protected bounded local WAL document for incident changes and notification state. An integrated provider-free regression now proves one critical opening page, process restart from local state, recovery-receipt cancellation, one recovery page, failed replay retention, and exact idempotent incident/notification replay after Supabase returns. | Retain a production-shaped outage/replay artifact; this does not substitute for R-04's separate server-side overlay dependency gate. |
| A-05 | External YouTube viewer fresh-frame/audio probe | `SATISFIED` | A bounded no-cookie Chromium probe verifies playhead advance, changing frame fingerprints, nonblack video, decoded audio, and stable dimensions, then closes the temporary browser. Production soak rotates it across active cameras. | Run from an external host for production evidence. |
| A-06 | External platform sentinel | `SATISFIED` | The production soak owns a separate off-VPC sentinel that checks monitor, ingest, commentary, and immutable renderer HTTPS endpoints every minute and reports success/failure to the dedicated paused-between-events `scorecheck-platform-sentinel` Healthchecks check. The check has a unique ping identity and exactly one Pushover channel. Unique-process liveness, endpoint results, delivery, edge gaps, and coverage are mandatory evidence. | Retain one live loss/recovery artifact in the next camera-backed event run. |
| A-07 | Continuous compact critical-log export | `SATISFIED` | One long-lived SSH/Compose stream per temporary host writes filtered, redacted, fsynced lifecycle/error records to protected off-host event evidence. It avoids repeated SSH/Docker polling, emits full-host readiness/coverage heartbeats, and fails the run if any stream exits or coverage is incomplete. | Verify all twelve streams in the next live run and archive the protected event evidence before provider teardown. |
| A-08 | Prometheus headroom/cardinality | `SATISFIED` | Event-scoped monitoring, bounded metrics, disk/resource alerts, and durable incident summaries exist. | Audit labels for unbounded IDs/text before each contract change. |
| A-09 | Cost dead-man without automatic destruction | `SATISFIED` | Coverage close sends an immediate non-blocking reminder; `cost-reminders.mjs` performs read-only provider/monitor checks and dedupes Pushover warnings for active output, one-hour/next-morning compute, unused setup, and terminal provider-nonzero. It never stops or deletes resources. | Schedule it at bounded cadence while an event lifecycle exists. |

## P1/P2 Scoring And Security Ledger

The scoring chain remains atomic for every reconstruction and disaster-recovery
audit: Applying only `030` is invalid because its provider commit RPC depends
on the complete `023`, `024`, `026`, `027`, and `028` contract.

| ID | Review item | Status | Checked-in evidence | Required disposition / proof |
| --- | --- | --- | --- | --- |
| S-01 | Monotonic score revisions and checksums | `SATISFIED` | Community witness migrations and transaction code use score revisions, source revisions/authority epochs, and state hashes. | Preserve exact transaction and replay tests. |
| S-02 | Lease fencing | `SATISFIED` | Production applied exactly `023,024,026,027,028,030` in one transaction after the rollback-only rehearsal. Independent SQL and PostgREST checks proved the migration ledger, `bigint` generation, current schema, removed legacy schema, forced RLS, service-role access, and anonymous denial. Vercel and the Render worker run exact Git SHA `2645dd484d4e537a7184feed8fa853ebd339bf1f`. | At the next active event, retain a fresh lease acquisition and fenced provider commit. Idle verification correctly found no active poller lease. See `SCORING_SCHEMA_HARDCUTOVER_023_030.md`. |
| S-03 | Explicit source precedence/state machine | `SATISFIED` | Checked-in authority modes cover admin lock, provider primary, designated primary, verified consensus, and paused dispute. | Document mapping to operator language; do not replace the implemented model with the review's illustrative names. |
| S-04 | Server-authorized semantic writes | `SATISFIED` | Mutations are service-role transactions and clients submit semantic scoring actions. | Retain RLS/security-boundary tests. |
| S-05 | Private Realtime | `SATISFIED` | The security hard cut removes public table access and keeps authoritative writes server-side. | Verify subscriptions use intended private policy in the live schema. |
| S-06 | HTTP repair ETag/304 | `SATISFIED` | Overlay responses derive a generation-safe checksum/revision ETag, honor `If-None-Match` with 304, and bind event/camera/match/schema identity before client application. | Verify CDN/browser behavior against the production route. |
| S-07 | VolleyballLife bounded polling/backoff/schema/replay/manual fallback | `SATISFIED` | Provider reads are HTTPS-host restricted, eight-second bounded, schema-validated, retried with capped deterministic jittered backoff, recorded in `poller_errors`, and remain subordinate to the explicit manual/community authority model. | Retain provider fixtures and run a production-shape stale/schema failure gate. |
| S-08 | Individual admin identities/MFA | `DEFERRED` | Event-scoped shared admin access is rate-limited and auditable enough for current small operations. | Revisit for higher-value events or multiple independent operators. Do not block current media qualification. |
| S-09 | Program route strict CSP/no third parties/determinism | `SATISFIED` | Program routes use first-party assets, scoped one-time sessions, strict route headers, no-store/no-referrer, and a bounded renderer contract verified at bootstrap. | Preserve a browser resource inventory in event acceptance. |
| S-10 | SSH bastion separation and outbound allowlist | `PARTIAL` | Password and keyboard-interactive SSH are disabled; ingress is limited to protected operator host CIDRs and the sole observability bastion. Event hosts now record accepted-key fingerprints/session type, and final evidence fails unhealthy on non-key auth, unexpected users/sources, or a bastion interactive shell without blocking cost-safe teardown. The lifecycle runbook documents role-specific outbound dependencies and the reason a static DigitalOcean destination-IP list is unsafe for dynamic Vercel, Supabase, YouTube, ACME, registry, and package endpoints. | Retain the first live event SSH audit artifact. Keep broad provider egress as an explicit reliability tradeoff until an attended synthetic run can capture an exact dependency set; add neither a separate bastion nor an outbound proxy without evidence that the simpler contract is insufficient. |

## Lifecycle And Manifest Ledger

| ID | Review item | Status | Checked-in evidence | Required disposition / proof |
| --- | --- | --- | --- | --- |
| L-01 | Event-scoped create/destroy and provider zero | `SATISFIED` | Lifecycle controller, exact manifest, reconstruction provenance, safe teardown, provider-zero audit, and full zero-to-12-to-zero rehearsal are implemented. | Continue explicit human-confirmed teardown. Never power off as a billing substitute. |
| L-02 | Stable camera identity and event court mapping | `SATISFIED` | Permanent Camera 1-8 media identities are separate from event/court presentation. | Preserve this invariant in new profile fields. |
| L-03 | Pin software/build/network/output identity | `SATISFIED` | The protected event bundle hashes manifest/network/bootstrap/source/venue/commentary/renderer inputs; output evidence binds FFmpeg/Chromium renderer and exact YouTube generation. | Capture fresh production artifacts rather than reusing another event's evidence. |
| L-04 | Clock synchronization gate | `SATISFIED` | Stack deployment requires synchronized NTP state and rejects measured host offset beyond the bounded contract before readiness. | Preserve per-host probes in event evidence. |
| L-05 | Stagger Egress starts | `SATISFIED` | Production and rehearsal controllers start one camera output at a time and require its output-conformance result before proceeding to the next. | Do not parallelize starts without a new measured gate. |
| L-06 | Venue physical readiness | `SATISFIED` | Production bundle admission requires the protected, timestamped venue physical-readiness contract described in V-06. | Refresh the operator attestation at the actual venue. |
| L-07 | Persistent reserved-IP cost | `SATISFIED` | Lifecycle documentation explicitly identifies retained endpoint anchors and provider-zero compute. | Keep cost reporting separate for compute and retained anchors. |

## Current Qualification Boundary

The checked-in contract has no remaining implementation-only `REQUIRED` row.
The scoring schema-before-service hard cutover is live and independently
verified, but event readiness remains conditional on production-shaped evidence
for rows marked `PARTIAL` or `DEFERRED` and the acceptance matrix below.

In particular:

- HEVC is retained as a useful source-bandwidth option, but only through the
  isolated compositor normalizer. It is not admitted for an event until that
  exact camera/compositor/output combination passes 1080p30 or 1080p60.
- The dual-role spare ingest transaction, guarded DigitalOcean Reserved-IP
  reassignment, CLI, SSH/service orchestration, output-owner reconciliation,
  monitoring-role cutover, protected eight-feed synthetic launcher, bounded
  primary fault adapter, and camera-independent evidence runner are implemented
  and regression-tested. Measured takeover/rollback RTO on an attended paid
  12-host stack is still missing. Do not add a thirteenth host until that
  simpler recovery is rehearsed and shown insufficient.
- Renderer loss now has a fail-closed synthetic gate but still needs an
  attended host artifact. Supabase loss now has a truthful isolated
  server-side dependency gate but still needs its attended artifact;
  browser-only blocking remains insufficient. Bounded
  browser recovery, exact Egress-owner resume, the external platform sentinel,
  and retained critical-log export have implementations but still need
  production-shaped evidence. The YouTube backup runner is implemented and
  regression-tested, but its attended one-court live transition artifact is
  still missing.
- The existing observability bastion remains the only event bastion. Key-only
  SSH and final accepted-session evidence are implemented; a first live event
  artifact is still required. Dynamic provider dependencies make a static
  destination-IP list unsafe, so no outbound proxy or extra host is admitted
  without measured need.
- The previously recorded web and worker release is deployed, but the current
  qualification candidate contains later local-only event-stack hardening that
  is not yet on `origin/master`. It must not be used to create an event bundle
  until the complete candidate is reviewed and published as one immutable Git
  revision. No event infrastructure was created. A fresh independent read-only
  audit at `2026-07-22T20:14:58Z` proved provider zero, two unassigned retained
  endpoint anchors, and the exact eight-stream idle YouTube pool. Evidence is
  `~/.config/scorecheck/event-stack/audits/architecture-qualification-provider-zero-20260722T201441Z.json`
  with SHA-256
  `b0ce42fa3410bbcf30a7c51d10d856a9c367b81f83c8598fcf645af90485f5eb`.
- The dedicated `scorecheck-platform-sentinel` Healthchecks check is paused
  between events, Pushover-only, and distinct from both monitor dead-men.
  Protected provider evidence is under
  `~/.config/scorecheck/cutovers/platform-sentinel-20260722T131435923Z/`. The
  quiet provider-zero dead-man proof is under
  `~/.config/scorecheck/cutovers/provider-zero-healthchecks-20260722T132828Z/`.
  The
  refreshed immutable recovery source is
  `~/.config/scorecheck/event-stack/production-recovery-source-current-20260722/`
  with source SHA-256
  `ec879a6931e2834d92e5410493045c28fb7b6554b70322175c28c7fccc00f1cf`.

## Rejected Wholesale Changes

| Recommendation | Decision | Reason |
| --- | --- | --- |
| Move to AWS IVS, LiveKit Cloud, Mux, or another managed media provider | `REJECTED` | The current DigitalOcean design is materially cheaper and already provides custom composition, scoring, isolation, and lifecycle control. A migration buys operations outsourcing, not a proven cost or reliability win. |
| Consolidate several cameras on each compositor | `REJECTED` | It increases the blast radius and complicates resource ownership for small savings. |
| Normalize all eight HEVC cameras on the shared ingest | `REJECTED` | Prior measured load already showed no headroom and a shared failure domain. |
| Add eight dedicated normalization Droplets | `REJECTED` | It exceeds the 15-Droplet ceiling and duplicates the one-camera compositor tier. |
| Automatically tear down after an event timer | `REJECTED` | An inaccurate timer could destroy live coverage. Use reminders and explicit teardown. |
| Automatically bypass Speedify on one WAN | `REJECTED` | It can silently overload or expose the venue path. Any break-glass mode must be operator-controlled. |
| Add Twilio beside Pushover | `REJECTED` | The approved monitoring contract is Pushover-only and already has emergency receipt semantics. |

## Acceptance Matrix

No row is a pass unless its artifact records exact Git revision, manifest hash,
host identities, source/output profile, start/end timestamps, and cleanup state.

| Gate | Minimum pass evidence |
| --- | --- |
| H.264 direct source | 1920x1080 progressive `yuv420p`; exact configured rational fps; no B-frames; maximum two-second keyframe spacing; monotonic timestamps; bounded bitrate; decodable audio; stable admission window. |
| HEVC source | Source profile accepted only with assigned isolated normalizer; browser side is verified H.264/no-B-frame; compositor-local 1080p30 and 1080p60 capacity pass before use. |
| Invalid source rejection | HEVC direct-to-WHEP, H.264 B-frames, interlaced video, bad pixel format, wrong fps/resolution, excessive GOP, timestamp reversal, bitrate violation, missing/invalid audio, model/firmware mismatch, and duplicate publisher all fail closed before output. |
| Output conformance | Protected sample and YouTube agree on 1920x1080, selected fps, H.264 approved profile, 10/12 Mbps operating window, near-CBR behavior, two-second GOP, progressive Rec.709/square pixels, AAC stereo 128 kbps/48 kHz, and continuous audio. |
| Eight-camera endurance | All intended source profiles plus eight independent Egresses for event-length duration; no duplicate Egress/publisher, sustained under-run, quality-counter growth, resource breach, zombie growth, or peer-court impact. |
| Venue impairment | Controlled loss, jitter, Speedify path change, and one-WAN loss preserve admitted priority behavior without unrelated-court failure. |
| Ingest replacement | Primary loss, Reserved-IP takeover, source/path/browser recovery, rollback, and declared RTO with no duplicate ingest/publisher. |
| Compositor replacement | Only one camera is affected; spare reuses the exact immutable renderer/output/broadcast generation without duplicate RTMPS publishing. |
| Commentary | Two commentators, mix-minus, headphones, stable output track, late join/drop/rejoin, UDP-blocked TURN/TLS, measured calibration, and video continuity when commentary fails. |
| Vercel loss | Run `renderer-loss-rehearsal.mjs` only against the exact running eight-feed synthetic soak. Existing program video/audio/last-good score continue; browser does not navigate; recovery does not change approved build/page/Egress generation; peers and YouTube remain healthy. |
| Supabase loss | Use a nonproduction dependency that interrupts both Realtime and the server-side authoritative repair path. Video/commentary continue; score holds and becomes observably stale; local incident outbox pages and later reconciles. Browser-only Supabase blocking is not qualifying evidence. |
| Overlay exception | The bounded exception occurs in the actual isolated Egress browser. Its video and audio remain visible/continuous, the same Egress stays active, the score render becomes observably failed/transparent, and page/build/reload/reconnect identity does not change. A second inspection browser or a renderer that starts already faulted is not qualifying evidence. |
| Renderer restart | Forced compositor/browser restart loads the exact approved deployment and contracts. |
| Monitoring loss | Media continues; external dead-man pages; restored monitor reconciles without duplicate incident episodes. |
| Pushover recovery | One opening emergency notification, receipt tracked, repeat acknowledged/cancelled on dependency recovery, one valid recovery notification, no false recovery. |
| YouTube backup | One selected priority court proves primary loss, backup continuity, no duplicate publisher, and controlled return. |
| External viewer | Remote playhead advances, frame fingerprints change, frame is nonblack, audio is active, expected broadcast/build identity is present, and probe load is bounded. |
| Teardown | Broadcasts complete, Egresses zero, temporary Droplets/DNS/firewalls are removed, provider-zero audit passes, only intended retained anchors remain, and cost reminder clears. |

## Controlled Single-WAN Break-Glass Contract

This is a documented emergency mode, not an implemented automatic fallback.
Normal operation remains bonded and fail closed. No component may enter this
mode merely because Speedify is degraded.

Before a future implementation can be enabled, all of the following are
required:

1. Nathan gives an explicit event-specific approval naming the surviving WAN
   and the one or two permanent Camera numbers to protect.
2. The selected cameras are already configured for
   `CONSTRAINED_1080P30`; every other camera output is stopped before routing is
   changed.
3. A fresh sustained-upload measurement proves at least 30 percent headroom
   above the selected cameras' aggregate source caps on that one WAN.
4. The lifecycle opens a critical Pushover incident that says bonded service is
   unavailable, identifies the protected cameras, and instructs the operator
   that all other courts must remain stopped.
5. The routing transaction records the original rules, exact single-WAN route,
   actor, reason, start time, and a bounded expiry. It never alters ordinary
   operator traffic.
6. Recovery is explicit: stop the protected publishers if needed, restore and
   verify the fail-closed Speedify rules/guard table/kill switch, then re-admit
   cameras from the venue profile one at a time.
7. Any expiry, route mismatch, capacity loss, or inability to restore the
   original rules fails closed and keeps camera traffic blocked.

The first rehearsal must be test-feed-only and prove route rollback, bandwidth
headroom, peer-camera isolation, one opening/recovery page, and no silent
automatic transition. Until that artifact exists, V-05 remains disabled.

## Camera-Free Renderer-Origin Rehearsal

This is an attended synthetic gate. It does not start publishers, Egresses,
broadcasts, or a soak. It requires the exact eight-feed synthetic publisher
state and an already-running production soak so it cannot be used against an
unidentified physical source.

The runner targets one compositor and requires separate exact fault and restore
confirmations:

```text
node infra/event-stack/renderer-loss-rehearsal.mjs run \
  --profile /protected/event-profile.json \
  --soak-evidence /protected/production-soak \
  --publisher-state /protected/synthetic-publishers.json \
  --evidence /protected/renderer-loss-evidence \
  --camera 1 \
  --confirm-fault FAULT-RENDERER:EVENT:CAMERA-1 \
  --confirm-restore RESTORE-RENDERER:EVENT:CAMERA-1
```

Before mutation it binds the fault to the exact event generation, camera,
renderer Git/deployment, Egress ID, YouTube destination, output generation,
container identity/address, and current generated-origin IPv4 set. It refuses
an IPv6-enabled Egress network because an unblocked IPv6 route would invalidate
the test. The only inserted jump is in `DOCKER-USER` for that container source;
its private MediaMTX path, monitor heartbeat destination, and YouTube RTMPS
destination are not blocked.

If the operator process exits normally after a failure, the runner attempts the
exact restore automatically. After a hard interruption, use only the persisted
state in the same evidence directory:

```text
node infra/event-stack/renderer-loss-rehearsal.mjs restore \
  --profile /protected/event-profile.json \
  --evidence /protected/renderer-loss-evidence \
  --confirm-restore RESTORE-RENDERER:EVENT:CAMERA-1
```

Do not mark R-03 satisfied from unit tests. A pass requires the protected host
artifact showing baseline, disconnected last-good score state, same-page media
continuity, exact firewall restoration, DNS stability, recovery, and unaffected
peer cameras/YouTube outputs.

## Camera-Free Supabase Dependency Proxy

`supabase-fault-proxy.mjs` is an isolated acceptance-test dependency, not a
production application switch. It listens only on loopback. The host adapter
starts it as a read-only, resource-bounded sidecar in the existing Caddy network
namespace, adds one event-scoped Caddy path, and verifies that path over public
TLS. The event slug is known before renderer deployment and event-bundle
creation; the sidecar, marker, confirmations, and evidence remain bound to the
later runtime generation. No extra Droplet, public port, DNS record, or
persistent route is created. Production renderer and Supabase configuration
must never point to it.

The proxy forwards ordinary HTTP and WebSocket upgrade traffic only to one
configured Supabase origin. It rejects absolute request targets, plaintext
non-loopback upstreams, embedded upstream credentials, and non-loopback listen
addresses. It also rejects every mutating HTTP method: only `GET`, `HEAD`,
`OPTIONS`, and `GET` WebSocket upgrades can reach Supabase. The isolated
renderer can therefore observe the current active event without modifying
production score data. REST access is further limited to `events`, `courts`,
and `overlay_states`; every RPC, auth route, unrelated table, and non-Realtime
WebSocket path is rejected. Fault and restore calls require exact
event-generation confirmations:

```text
FAULT-SUPABASE:<generation-id>
RESTORE-SUPABASE:<generation-id>
```

Faulting closes in-flight HTTP requests and active Realtime sockets before
rejecting new traffic with `503`; restoration is explicit and idempotent. Its
snapshot contains only bounded lifecycle timestamps, the upstream origin, and
aggregate counters. It deliberately records no URL path/query, headers,
credentials, or request/response body.

The observability deployment installs both proxy scripts atomically and rolls
them back with the monitor-service source. Routine observability deployment is
refused while a proxy marker or sidecar remains. The gate itself requires exact
prepare, fault, restore, and cleanup confirmations. On failure it restores the
dependency and removes the route automatically; after an operator interruption,
the protected state supports an exact `restore` command.

The isolated renderer must use this exact trailing-slash base URL as
`NEXT_PUBLIC_SUPABASE_URL`. The current web application intentionally consumes
that same setting in both its browser client and server-side Supabase client:

```text
https://<monitor-host>/_scorecheck-supabase-fault/<unique-event-slug>/
```

The URL can therefore be fixed before Vercel deployment without predicting the
lifecycle generation. Event slugs must never be reused. The URL shape is
compatible with Supabase REST and Realtime construction. The proxy strips only
its exact event prefix, forwards only the allowlisted
REST collection paths and exact `/realtime/v1/websocket` endpoint upstream,
and rejects every other path. Renderer creation
must remain a separate protected provider transaction using an isolated Vercel
project, synthetic publishers, read-only current active-event score state, and
the ordinary
`NEXT_PUBLIC_SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` credentials
without printing them. Capture that immutable renderer binding, use it when
creating the production event bundle, and retain the same binding through the
soak. The runner fails baseline
qualification unless it observes at least one authoritative HTTP request and
exactly one active Realtime socket through the proxy.

After the event stack is live but while every Egress worker is idle, prepare the
proxy route and protected evidence directory:

```text
node infra/event-stack/supabase-loss-rehearsal.mjs prepare \
  --profile /protected/event-profile.json \
  --renderer-binding /protected/isolated-renderer.json \
  --evidence /protected/supabase-loss-evidence \
  --camera 1 \
  --confirm-prepare PREPARE-SUPABASE-FAULT:EVENT
```

Preparation fails closed if any Egress output is active. Start the ordinary
eight-feed synthetic production soak with that isolated renderer. Once its
state is `RUNNING`, execute only the fault and recovery phases:

```text
node infra/event-stack/supabase-loss-rehearsal.mjs run \
  --profile /protected/event-profile.json \
  --soak-evidence /protected/production-soak \
  --publisher-state /protected/synthetic-publishers.json \
  --renderer-binding /protected/isolated-renderer.json \
  --evidence /protected/supabase-loss-evidence \
  --camera 1 \
  --confirm-prepare PREPARE-SUPABASE-FAULT:EVENT \
  --confirm-fault FAULT-SUPABASE:GENERATION \
  --confirm-restore RESTORE-SUPABASE:GENERATION
```

The successful run stops at `RECOVERED_PENDING_CLEANUP`; the healthy proxy route
must remain in place so the still-running isolated renderer does not experience
an unmeasured second dependency outage. Stop the production soak and every
Egress output, then clean the temporary route. Cleanup independently checks
current monitor telemetry and refuses to proceed while any Egress output is
active:

```text
node infra/event-stack/supabase-loss-rehearsal.mjs cleanup \
  --profile /protected/event-profile.json \
  --evidence /protected/supabase-loss-evidence \
  --confirm-cleanup CLEANUP-SUPABASE-FAULT:EVENT
```

Only cleanup produces the terminal PASS report. After an interruption, restore
the dependency from the persisted target but leave the healthy route in place:

```text
node infra/event-stack/supabase-loss-rehearsal.mjs restore \
  --profile /protected/event-profile.json \
  --evidence /protected/supabase-loss-evidence \
  --confirm-restore RESTORE-SUPABASE:GENERATION
```

Then stop all outputs and run the same explicit `cleanup` command. A failed or
interrupted run remains classified FAIL after cleanup.

A PASS requires the same page/build/configuration, unchanged reset-safe video
quality counters, expected aggregate cadence, loaded/disconnected/stale
last-good score, exactly one score-render incident, bounded detection, restored
HTTP and Realtime counters, healthy peers and YouTube, and final host state
`CLEAN`. The separately implemented local incident outbox remains A-04 evidence;
R-04 does not claim outbox replay from this renderer gate. Until the protected
attended artifact exists, R-04 remains `PARTIAL`.

## Overlay Exception Qualification Boundary

The fail-transparent component and provider-free adapter are implemented. The
qualification exception must still occur inside the exact Chromium process
captured by the active isolated Egress. Launching another Program reader tests
the wrong process and can overwrite the court's browser heartbeat. Starting an
Egress on a renderer that was already faulted also fails same-page continuity.

The adapter does not add a production query parameter, runtime switch, or
feature flag. LiveKit Egress v1.13.0 accepts `chrome_flags` and applies them to
the exact captured Chrome process. Preparation preserves the ordinary
`disable-dev-shm-usage: false` override, adds remote debugging only inside the
unpublished Egress container network, writes its protected recovery marker
before swapping config, and recreates only an idle Egress worker. Activation
requires exactly one owner-matched Egress and restores the ordinary host config
without restarting that active process. CDP is reachable only through a local
loopback SSH tunnel and accepts exactly one immutable Program URL matching the
event camera, renderer Git SHA, and Vercel deployment ID.

Run this as a terminal gate for the selected synthetic output. The bounded
scorebug exception intentionally remains in that page until the output is
stopped; the runner never starts or stops publishers, Egress, YouTube, or the
production soak.

1. Before the selected Egress starts, while its worker is idle:

```text
node infra/event-stack/overlay-exception-rehearsal.mjs prepare \
  --profile /protected/event-profile.json \
  --evidence /protected/overlay-exception-evidence \
  --camera 1 \
  --confirm-prepare PREPARE-OVERLAY-DEBUG:EVENT:CAMERA-1
```

2. Start the ordinary eight-feed synthetic production soak. Once the exact
   target Egress and unlisted YouTube output are healthy, run:

```text
node infra/event-stack/overlay-exception-rehearsal.mjs run \
  --profile /protected/event-profile.json \
  --soak-evidence /protected/production-soak \
  --publisher-state /protected/synthetic-publishers.json \
  --evidence /protected/overlay-exception-evidence \
  --confirm-arm ARM-OVERLAY-EXCEPTION:EVENT:CAMERA-1 \
  --confirm-fault FAULT-OVERLAY:EVENT:CAMERA-1
```

3. Stop that output through the ordinary ordered production-soak cleanup. Only
   after active Egress count is zero, remove the channel and prove the ordinary
   worker is healthy with no debug endpoint:

```text
node infra/event-stack/overlay-exception-rehearsal.mjs cleanup \
  --profile /protected/event-profile.json \
  --evidence /protected/overlay-exception-evidence \
  --confirm-cleanup CLEANUP-OVERLAY-DEBUG:EVENT:CAMERA-1
```

An attended pass requires six stable baseline and six stable fault samples,
the same page/build/configuration and exact Egress generation, advancing video
at the selected aggregate cadence, zero quality/reconnect/reload growth, one
expected score-render incident, exactly two caught render throws, a transparent
scorebug, healthy peers and YouTube, then exact post-stop cleanup. Until that
protected artifact exists, R-09's implementation is satisfied but its live
acceptance-matrix gate remains pending.

## Remaining Execution Order

The scoring prerequisite is complete. Checksummed production evidence is under
`~/.config/scorecheck/cutovers/scoring-schema-023-030-20260722T122341Z/`.

1. Capture a real venue profile, renderer binding, commentary qualification,
   camera H.264/HEVC admission traces, and actual output-conformance artifacts.
2. Run physical H.264 1080p30/60 and compositor-local HEVC 1080p30/60 gates.
   Keep any mode that fails disabled rather than weakening admission.
3. Before starting the eight-feed synthetic soak, prepare both the isolated
   event-scoped Supabase proxy and the overlay exception adapter while every
   affected Egress worker is idle. Start the soak with the isolated immutable
   renderer, run Supabase fault/recovery first, then run the Vercel
   renderer-origin loss gate. Execute overlay exception as the terminal gate
   for that synthetic output. Stop all outputs before cleaning either prepared
   adapter. A browser-only Supabase block is not evidence. Then run monitor
   loss/outbox replay and the exact renderer-restart gate.
   Renderer loss, Supabase loss, overlay exception, and ingest recovery share
   one event-generation process lock. A second disruptive gate must fail before
   fault injection; do not remove a live owner's lock or overlap gates to save
   time. The ordinary production-soak process remains concurrent because it is
   the evidence source, not a fault transaction. Lifecycle start, close,
   evidence, destroy, and abort also acquire the lock, preventing coverage or
   teardown from racing an active fault gate.
4. Run the implemented camera-independent dual-role spare rehearsal on an
   attended protected 12-host event generation, measure takeover and rollback
   RTO, and decide whether the thirteenth warm ingest is justified. The runner
   supplies all eight synthetic feeds and exact evidence gates; no physical
   camera operation is required. Do not substitute unit tests for this
   provider/host transaction evidence.
5. Run `youtube-backupctl.mjs` against one priority-court synthetic output.
   Capture exact primary/backup ownership and the runner-owned continuous
   external-viewer trace spanning primary stop, backup-only delivery, primary
   restoration, and backup removal. A restarted/lost trace is a failed gate.
6. Run the eight-camera event-length endurance matrix, external viewer rotation,
   exact cleanup, and terminal provider-zero audit. Only then mark the active
   production-qualification goal complete.
