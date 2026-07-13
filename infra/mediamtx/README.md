# ScoreCheck MediaMTX

The ingest server owns three distinct path classes per court:

- `courtN_raw`: permanent Mevo/camera publishing identity.
- `courtN_preview`: clean, normalized, low-latency H.264/Opus for people.
- `courtN_program`: clean preview delayed at the SRT receiver for compositing.

The SRT listener accepts caller-mode venue-camera publishers and also carries
the internal delayed-program read on loopback. Camera publishers authenticate
with a court-scoped SRT stream ID; the loopback reader is separately authorized
by IP. Listener-only cameras are configured as private `srt://` raw sources, so
MediaMTX owns their caller connection and reconnect lifecycle directly.

Both UFW and the DigitalOcean `bvm-preview-firewall` allow only SSH, HTTP/TLS,
RTMP ingest, SRT ingest, and WebRTC UDP media. Keep those two rule sets aligned
when an ingest protocol changes.

`courtN_calibration` is an on-demand UTC-burned test path and is never used by
the production scene.

Render and deploy without printing the publish credential:

```bash
set -a
source ../../apps/web/.env.setup.local
set +a
MEDIAMTX_PROGRAM_DELAY_MS=3500 ./deploy.sh
```

Each `MEDIAMTX_COURT_N_RAW_SOURCE` defaults to `publisher`. Set it to a private
SRT listener URL when the ingest node must pull that camera. Cameras 6-8 are
MAKI listeners in the current Gate 8 hardware mix:

```bash
export MEDIAMTX_COURT_6_RAW_SOURCE='srt://192.168.8.170:1026?mode=caller&latency=2500000'
export MEDIAMTX_COURT_7_RAW_SOURCE='srt://192.168.8.238:1027?mode=caller&latency=2500000'
export MEDIAMTX_COURT_8_RAW_SOURCE='srt://192.168.8.206:1025?mode=caller&latency=2500000'
```

Private camera addresses are reachable only through the router-to-ingest
WireGuard tunnel. No Mac or venue relay process is part of the runtime.

The deploy script backs up the active remote files, recreates the pinned
container, verifies the local MediaMTX API, and restores the prior files if the
new process fails health checks. Docker logs are capped at four 25 MB files.
On-demand branches poll local path readiness every two seconds and start FFmpeg
only after their upstream exists, so an open offline preview cannot create a
process or log storm.

Every H.264 or HEVC input is normalized to H.264/Opus at 720p30 before
preview/program distribution. A 1080p60 camera is therefore an ingest stress
source, not a 60 fps program output. The one-second normalized GOP limits
decoder recovery time after an upstream loss event.
