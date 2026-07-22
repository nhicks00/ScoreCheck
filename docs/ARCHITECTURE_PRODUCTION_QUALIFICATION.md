# ScoreCheck Architecture Production Qualification

Date: 2026-07-22
Code baseline: `2645dd484d4e537a7184feed8fa853ebd339bf1f`
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
| M-12 | HEVC normalization placement | `DEFERRED` | A compositor-local, one-camera HEVC-to-H.264 normalizer and telemetry contract are implemented; shared-ingest normalization remains prohibited. No production-shaped 1080p30/60 qualification artifact exists yet. | Benchmark normalizer plus browser, commentary, and Egress at both intended modes before enabling HEVC at an event. |

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
| R-03 | Existing scene survives Vercel loss | `PARTIAL` | The loaded browser can continue media and last rendered state; no full physical control-plane-loss acceptance is bound to the current event contract. | Run Vercel loss/recovery with Egress live. Existing video/audio/last-good score must continue without navigation. |
| R-04 | Existing scene survives Supabase loss | `PARTIAL` | Video and commentary are separate from scoring, and the overlay has fail-transparent behavior. | Run Supabase loss/recovery with Egress live; score must hold last-good and expose stale telemetry without blanking video. |
| R-05 | Program token leakage protections | `SATISFIED` | The protected token is carried only in a URL fragment to a one-time bootstrap, exchanged for a scoped HttpOnly session, then removed by navigation. Program routes enforce private/no-store, no-referrer, strict CSP, and redacted startup output. | Keep third-party resources absent from program routes. |
| R-06 | Bounded browser supervisor | `SATISFIED` | `program-supervisor.mjs` acts only when raw/program/Egress remain healthy while the browser is unavailable for six consecutive samples. It preserves event/destination/output-generation/renderer ownership, permits at most two restarts with a ten-minute cooldown, persists a prepared restart before mutation, resumes it safely, and fails closed after exhaustion. Any restart remains visible and fails the qualification run rather than being hidden. | Prove one bounded recovery on the exact immutable renderer during the physical restart gate. |
| R-07 | Separate renderer deployment blast radius | `DEFERRED` | Admin and program routes currently share the web project. | First prove immutable production deployment pinning. Split the renderer project only if pinning cannot prevent admin deployments from affecting restarted scenes. |
| R-08 | Fully local renderer bundle | `REJECTED` | It would duplicate hosting/build/runtime concerns before immutable deployment pinning is tested. | Reconsider only if an external renderer outage still prevents the declared recovery objective. |

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
| I-03 | Warm ingest replacement | `PARTIAL` | `ingest-recovery.mjs` implements a fail-closed, operator-confirmed transaction for spare-role staging, Reserved-IP move, all eight compositor private bindings, output-generation resumption, monitor-target switch, verification, and rollback. The real DigitalOcean/SSH adapter and physical RTO rehearsal are not complete. | Implement the provider adapter only when a protected 12-host rehearsal is scheduled, then select dual-role spare or a thirteenth host from measured RTO. |
| I-04 | Dedicated thirteenth ingest standby | `DEFERRED` | Account limit 15 permits it, but it raises the ordinary event fleet from 12 to 13. | Admit only if dual-role spare recovery misses the measured RTO or creates unacceptable operational risk. |
| I-05 | Active-active ingest | `REJECTED` | Complexity and dual-publisher behavior are unjustified for the current scale. | No action. |
| I-06 | One Egress per compositor | `SATISFIED` | `start-court.sh` serializes starts, verifies active count zero, and the agent contract enforces one active request maximum. | Retain multiplicity fault tests. |
| I-07 | Orphaned Egress reconciliation/idempotency | `SATISFIED` | Every Egress now has a protected atomic owner record binding event, camera, destination, output generation, renderer Git/deployment, output profile, Egress ID, and request digest. Starts, resume, second-admission proof, stop, and supervisor replacement reconcile exact active process plus owner/digest and reject ambiguous or changed ownership. | Retain a production interruption/resume artifact; never manually delete an owner record to force adoption. |
| I-08 | Dedicated-CPU compositor benchmark | `DEFERRED` | Production-shaped capacity harness exists; current event fleet deliberately uses the declared compositor pool shape. | Compare qualified c-4/c-8 and current shape using p95/p99 CPU, steal, encode speed, frame pacing, `/dev/shm`, memory, cold/warm start, and cost. Do not resize from average CPU. |
| I-09 | Spare to YouTube backup ingest | `DEFERRED` | The warm spare and YouTube lifecycle controls exist; backup-ingestion ownership/failover is not qualified. | Limit first gate to one priority court. Prove primary failure, backup continuity, return-to-primary, and no duplicate publisher. |
| I-10 | YouTube lifecycle and destination ownership | `SATISFIED` | Production YouTube code validates stream/broadcast IDs, binding, privacy, lifecycle, health, issues, and watch page. | Extend with output-conformance and optional backup identity. |

### Monitoring, Evidence, And Paging

| ID | Review item | Status | Checked-in evidence | Required disposition / proof |
| --- | --- | --- | --- | --- |
| A-01 | Correlated expected-state incidents | `SATISFIED` | Monitoring distinguishes expected-off from failure, tracks incident episodes, deduplicates notification kinds, and has reset-safe browser counters. | Retain fault-gate tests. |
| A-02 | Pushover emergency receipts and cancellation | `SATISFIED` | `notifications.ts` stores emergency receipt IDs, polls acknowledgement, and cancels on acknowledgement, silence, or dependency recovery. | No duplicate notification system. Twilio remains removed. |
| A-03 | State-aware Healthchecks | `SATISFIED` | Baseline/active schedules and channel audits exist. | Retain live subscription audit. |
| A-04 | Local incident outbox during Supabase loss | `SATISFIED` | The monitoring service now has a protected bounded local WAL document for incident changes and notification state, with idempotent replay and notification maintenance independent of Supabase availability. | Exercise outage/replay in the acceptance matrix. |
| A-05 | External YouTube viewer fresh-frame/audio probe | `SATISFIED` | A bounded no-cookie Chromium probe verifies playhead advance, changing frame fingerprints, nonblack video, decoded audio, and stable dimensions, then closes the temporary browser. Production soak rotates it across active cameras. | Run from an external host for production evidence. |
| A-06 | External platform sentinel | `SATISFIED` | The production soak owns a separate off-VPC sentinel that checks monitor, ingest, commentary, and immutable renderer HTTPS endpoints every minute and reports success/failure to a dedicated Healthchecks check. Unique-process liveness, endpoint results, delivery, edge gaps, and coverage are mandatory evidence. | Create and attach the dedicated sentinel Healthchecks check, then retain one live loss/recovery artifact. |
| A-07 | Continuous compact critical-log export | `SATISFIED` | One long-lived SSH/Compose stream per temporary host writes filtered, redacted, fsynced lifecycle/error records to protected off-host event evidence. It avoids repeated SSH/Docker polling, emits full-host readiness/coverage heartbeats, and fails the run if any stream exits or coverage is incomplete. | Verify all twelve streams in the next live run and archive the protected event evidence before provider teardown. |
| A-08 | Prometheus headroom/cardinality | `SATISFIED` | Event-scoped monitoring, bounded metrics, disk/resource alerts, and durable incident summaries exist. | Audit labels for unbounded IDs/text before each contract change. |
| A-09 | Cost dead-man without automatic destruction | `SATISFIED` | Coverage close sends an immediate non-blocking reminder; `cost-reminders.mjs` performs read-only provider/monitor checks and dedupes Pushover warnings for active output, one-hour/next-morning compute, unused setup, and terminal provider-nonzero. It never stops or deletes resources. | Schedule it at bounded cadence while an event lifecycle exists. |

## P1/P2 Scoring And Security Ledger

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
| S-10 | SSH bastion separation and outbound allowlist | `DEFERRED` | VPC/firewall contracts and scoped deployment access exist. Splitting bastion from observability adds infrastructure. | First document required egress and interactive SSH audit. Add a host only if the simpler restriction cannot meet recovery/security needs. |

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
- The dual-role spare ingest transaction is implemented but has no live
  DigitalOcean/SSH adapter or measured takeover RTO. Do not add a thirteenth
  host until that simpler recovery is rehearsed and shown insufficient.
- Renderer and Supabase loss, bounded browser recovery, exact Egress-owner
  resume, the external platform sentinel, retained critical-log export, and
  YouTube backup ingest still need production-shaped evidence. The first five
  now have fail-closed implementations; backup ingest remains deferred.
- The exact qualification release is deployed to Vercel and the Render worker.
  No event infrastructure was created. A fresh independent audit at
  `2026-07-22T12:52:02Z` proved provider zero, two unassigned retained endpoint
  anchors, and the exact eight-stream idle YouTube pool.

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
| Vercel loss | Existing program video/audio/last-good score continue; browser does not navigate; recovery does not change approved build. |
| Supabase loss | Video/commentary continue; score holds and becomes observably stale; local incident outbox pages and later reconciles. |
| Overlay exception | Video and audio remain visible/continuous and Egress stays active. |
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

## Remaining Execution Order

The scoring prerequisite is complete. Checksummed production evidence is under
`~/.config/scorecheck/cutovers/scoring-schema-023-030-20260722T122341Z/`.

1. Capture a real venue profile, renderer binding, commentary qualification,
   camera H.264/HEVC admission traces, and actual output-conformance artifacts.
2. Run physical H.264 1080p30/60 and compositor-local HEVC 1080p30/60 gates.
   Keep any mode that fails disabled rather than weakening admission.
3. Run Vercel/Supabase loss, overlay exception, monitor loss/outbox replay, and
   exact renderer-restart gates with one nonpublic camera/output generation.
4. Rehearse dual-role spare ingest takeover and rollback. Add the provider
   adapter only for this protected rehearsal, measure RTO, and decide whether
   the thirteenth warm ingest is justified.
5. Qualify one priority-court spare compositor against YouTube backup ingestion
   and capture interruption/resume evidence for exact Egress ownership.
6. Run the eight-camera event-length endurance matrix, external viewer rotation,
   exact cleanup, and terminal provider-zero audit. Only then mark the active
   production-qualification goal complete.
