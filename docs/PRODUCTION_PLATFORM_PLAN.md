# ScoreCheck Production Platform Plan

## Decision

Keep the browser-program-scene architecture and harden it. Do not rebuild around
cloud OBS or vMix unless the x86 LiveKit Egress benchmark fails.

The July 12 Gate 1 soak proved a ten-hour real-camera, remote-commentary,
ScoreCheck WHEP, browser-compositor, and YouTube RTMPS path on a DigitalOcean
`c-4`. It did not prove multi-court capacity or the required failure recovery.

## Target architecture

```text
VENUE
Mevo/AVKANS cameras -> bonded router -> court1_raw ... court8_raw

INGEST AND PREVIEW
MediaMTX primary
  raw -> courtN_preview (undelayed normalized H.264/Opus)
      -> courtN_program (controlled SRT delay, clean stream)
MediaMTX warm standby with tested IP failover

COMMENTARY
Self-hosted LiveKit audio rooms
  rtc.beachvolleyballmedia.com
  one short-lived JWT and room per court
  TURN/TLS, track presence, real RMS/peak health

PROGRAM
Four event-day c-4 compositor hosts, two courts each
  program WHEP + DOM scorebug + LiveKit tracks
  Web Audio gain/delay/compression/meters
  controlled signal-loss slate
  LiveKit Web Egress -> YouTube RTMPS

CONTROL
Supabase desired/observed state -> outbound controller reconciler
  -> DigitalOcean, LiveKit Egress, MediaMTX, YouTube APIs
```

## Implemented Gate 1 foundation

- Separate `preview_stream_path` and `program_stream_path` court fields.
- Program-video delay, camera gain, commentary gain, and commentary delay fields.
- Program mode is WHEP-only and never falls back to HLS.
- Real presented-frame watchdog via `requestVideoFrameCallback`.
- Controlled video-loss slate while scorebug and audio continue.
- Self-hosted LiveKit commentary node with TURN/TLS and pinned images.
- Court-scoped 24-hour commentator/program JWTs.
- Direct microphone publish, co-commentator monitoring, and reconnect behavior.
- Web Audio camera/commentary mix with delay, compression, and meters.
- Audio-aware program heartbeats.
- MediaMTX `courtN_raw`, `courtN_preview`, and delayed `courtN_program` paths.
- Pinned MediaMTX, LiveKit Server, Egress, Redis, and Caddy images.
- LiveKit Chrome sandbox seccomp profile instead of broad `SYS_ADMIN`.
- Explicit YouTube 720p30/4 Mbps/2 second keyframe/AAC RTMPS request.

## Implemented unified monitoring foundation

- Dedicated observability VPS with Prometheus, Alertmanager, correlator, bounded
  monitor API, durable incident store, and independent dead-man sender.
- Read-only agents on MediaMTX, Commentary, and all four compositor hosts.
- Explicit compositor telemetry mapping A=1-2, B=3-4, C=5-6, D=7-8.
- MediaMTX bitrate/path telemetry, FFmpeg `-progress`, program-browser frame and
  WebRTC stats, LiveKit commentary health, Egress capacity, score/render
  alignment, YouTube health, and host/container metrics.
- Authenticated `/admin/monitor` 4x2 matrix with low-rate thumbnails, one selected
  full WHEP preview, exact first actions, trends, shared-host capacity, and
  durable checkpoint fallback.
- Durable deduplicated incidents, acknowledgement, audited timed silences,
  Pushover emergency acknowledgement, Twilio SMS escalation, and recovery logic.
- Expected-state lifecycle wired to event activation/completion and Production
  Console start/stop so idle courts do not poll or page as if live.
- High-frequency telemetry retained in Prometheus; Supabase receives only
  low-churn control and audit records plus one checkpoint per minute.

Phone-provider and external dead-man delivery remain conditional on protected
Pushover, Twilio, and Healthchecks credentials. Real one-court and eight-court
fault gates remain test-session work; monitoring must not prove itself by
stopping public production services.

## Capacity topology

Do not place all eight encoders on one host. Gate 1 measured about 1.3 CPU
cores per 720p30 web egress. The next event-day target is:

```text
Compositor A: dedicated c-4, courts 1-2
Compositor B: dedicated c-4, courts 3-4
Compositor C: dedicated c-4, courts 5-6
Compositor D: dedicated c-4, courts 7-8
One prewarmed c-4 replacement
```

Two measured jobs should use about 2.6 cores, leaving about 35% host CPU
headroom. LiveKit admission reserves 1.5 CPU and 2 GB per job so a `c-4`
accepts at most two web egresses. The July full-eight test deliberately skips
the staged two- and four-court runs, so the same estimate must be validated on
all four hosts at once rather than inferred from a partial load.

The first full-eight ingest candidate, one dedicated `c-4` with 8 GB RAM,
failed on 2026-07-12. Eight 1080p inputs normalized to H.264/Opus at 720p30
pinned all four CPUs at 393.88%; individual FFmpeg branches ran at only
0.59-0.81x and produced 18-24 fps. The single-node normalization topology is
therefore rejected. The tested input mix was two H.264 RTMP Mevos at 1080p60,
three HEVC/SRT AVKANS Go cameras at 1080p30, and three H.264/SRT MAKI Live
listeners pulled through the routed camera-LAN tunnel. No venue computer or
separate relay process participated.

The next candidate is two dedicated `c-4` normalization workers split four
courts each, while preserving one logical media namespace and the existing
four two-court compositor hosts. Camera-side 720p30 H.264 plus stream-copy or
audio-only conversion is the simpler alternative, but each camera model must
be explicitly qualified before adopting it. Either candidate must sustain
less than 80% CPU, real-time FFmpeg speed, stable 30 fps output, and a
non-congested venue uplink before Gate 2 can pass. The temporary MAKI
assignments do not alter the final AVKANS hardware target.

Venue camera routing is selective rather than router-wide. Speedify runs in
Speed mode over UDP with its default route disabled; only MediaMTX RTMP/SRT
ingest ports enter the bonded tunnel. This keeps operator and camera-control
traffic independent and prevents the ingest-IP host route that bypassed
Speedify during the July 12 test. Routing must be active before publishers
start, and the worst sustained bonded upload must be at least 75 Mbps. The
temporary MAKI listener paths still require WireGuard and failed the available
home-network capacity test; production qualification waits for the final six
direct-caller AVKANS cameras or a stronger venue uplink.

## Reliability rules

- Program and preview latency classes are explicit and cannot silently switch.
- Input loss never ends YouTube; it produces a slate and alarm.
- Commentary remains available during camera loss.
- Program pages retry media and LiveKit connections indefinitely.
- Egress and media images are pulled before event day, never automatically on
  event morning.
- Four compositor hosts limit a host failure to two courts.
- StreamRun remains the break-glass public path through the shadow event.
- A new stack does not become public because it merely starts; source, audio,
  egress, YouTube receiving status, and health must all be good.

## Controller direction

Replace the current command proxy with an outbound desired-state reconciler.
Supabase should hold persistent fleet/court runtime and commands. On restart the
controller lists real egress jobs, rebuilds mappings, compares desired state,
restarts missing jobs, and stops orphans only after a safety delay.

Target lifecycle:

```text
OFF -> SOURCE_READY -> SCENE_STARTING -> ENCODER_STARTING
    -> YOUTUBE_RECEIVING -> LIVE_HEALTHY
    -> DEGRADED -> RECOVERING -> LIVE_HEALTHY
```

## YouTube match architecture

Keep one persistent reusable YouTube `liveStream` per court and create a
separate `liveBroadcast` per match. Keep the encoder running between matches.
Bind and transition broadcasts through the YouTube API only after the stream is
receiving and healthy. Auto-start and auto-stop remain disabled so a camera or
network failure can never complete a broadcast.

YouTube keys must move out of normal court columns before production. Store a
secret reference on the court and resolve it only in the controller. Program
page access must likewise move from one shared token to short-lived court-scoped
tokens before cutover.

## Required gates

1. **One court:** real camera, remote audible commentary, real YouTube RTMPS,
   ten hours, sync checked at beginning/middle/end on a DigitalOcean c-4.
2. **Eight courts:** four-host layout, eight real feeds and destinations,
   scoring on all, at least two commentary rooms, two hours minimum and twelve
   hours preferred. The direct-eight run replaces separate two- and four-court
   gates by explicit operator decision; it does not relax any per-host limit.
3. **Fault injection:** camera/network/MediaMTX/egress/controller/host/origin
   failures with unaffected courts remaining live.
4. **Shadow event:** two real courts, unlisted destinations, StreamRun public,
   producer uses only `/admin/production`, zero active-play SSH intervention.

## Implementation order

1. Preserve the July 12 Gate 1 evidence and apply its lifecycle/logging fixes. Done.
2. Deploy the independent unified monitoring foundation. Done.
3. Activate and prove phone paging plus external dead-man delivery.
4. Run the one-court monitoring fault gate using a test broadcast.
5. Provision and run the full-eight load, sync, recovery, and fault gate.
6. Convert the controller to desired-state reconciliation.
7. Move YouTube/program credentials to proper secret storage.
8. Add reusable-stream/per-match YouTube orchestration.
9. Run the two-court shadow event, then the full shadow event.

The July 12 soak is an endurance pass for the final x86, audible-commentary,
RTMPS pipeline. Gate 1 remains conditional because midpoint/final subjective
sync checks were not recorded and camera reconnection was not tested. Those
checks move into the direct-eight run rather than being waived.
