# ScoreCheck Production Platform Plan

## Decision

Keep the browser-program-scene architecture and harden it. Do not rebuild around
cloud OBS or vMix unless the x86 LiveKit Egress benchmark fails.

The July 8 test proved that headless Chrome can capture ScoreCheck WHEP video,
the DOM scorebug, and browser audio and push a test stream. It did not prove a
ten-hour real-camera/commentary run or eight-court capacity.

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
Two event-day compositor hosts, four courts each
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

## Capacity topology

Do not place all eight encoders on one 32-vCPU host. The event-day target is:

```text
Compositor A: dedicated 32 vCPU, courts 1-4
Compositor B: dedicated 32 vCPU, courts 5-8
One prewarmed or quickly restorable replacement
```

LiveKit v1.13.0 currently defaults Web Egress admission cost to 3.0 CPU units,
but admission values do not create capacity. Gate 1 measures actual x86 CPU;
Gate 2 determines final limits from eight motion-heavy feeds.

The ingest node also needs a dedicated capacity test. If all direct cameras
require H.264 normalization, start Gate 2 planning at 8 dedicated vCPU and
8-16 GB RAM. Use stream-copy or audio-only conversion per qualified camera
model where possible.

## Reliability rules

- Program and preview latency classes are explicit and cannot silently switch.
- Input loss never ends YouTube; it produces a slate and alarm.
- Commentary remains available during camera loss.
- Program pages retry media and LiveKit connections indefinitely.
- Egress and media images are pulled before event day, never automatically on
  event morning.
- Two compositor hosts limit a host failure to four courts.
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
2. **Eight courts:** two-host layout, eight feeds/destinations, scoring on all,
   at least two commentary rooms, twelve hours preferred.
3. **Fault injection:** camera/network/MediaMTX/egress/controller/host/origin
   failures with unaffected courts remaining live.
4. **Shadow event:** two real courts, unlisted destinations, StreamRun public,
   producer uses only `/admin/production`, zero active-play SSH intervention.

## Implementation order

1. Complete and validate Gate 1 foundation.
2. Run the real one-court ten-hour soak and fix measured failures.
3. Convert the controller to desired-state reconciliation.
4. Move YouTube/program credentials to proper secret storage.
5. Provision the two-host four-plus-four topology.
6. Run the eight-court load and fault-injection gate.
7. Add reusable-stream/per-match YouTube orchestration.
8. Run the two-court shadow event, then the full shadow event.

The previous tournament and local compositor run do not count as Gate 1: they
soaked ScoreCheck scoring and a functional browser capture, not the final x86,
audible-commentary, RTMPS pipeline described above.
