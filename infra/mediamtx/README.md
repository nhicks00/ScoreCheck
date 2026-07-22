# ScoreCheck MediaMTX

The ingest server owns four operator-facing path classes per camera:

- `courtN_raw`: permanent Mevo/camera publishing identity.
- `courtN_preview`: clean, browser-safe, low-latency H.264/Opus for people.
- `courtN_monitor`: on-demand 360p/10 FPS data-saver view for one selected camera.
- `courtN_program`: clean preview delayed at the SRT receiver for compositing.

The SRT listener accepts caller-mode venue-camera publishers and also carries
the internal delayed-program read on loopback. Camera publishers authenticate
with a court-scoped SRT stream ID; the loopback reader is separately authorized
by IP. Listener-only cameras are configured as private `srt://` raw sources, so
MediaMTX owns their caller connection and reconnect lifecycle directly.

Both UFW and the DigitalOcean `bvm-preview-firewall` allow only SSH, HTTP/TLS,
RTMP ingest, SRT ingest, and WebRTC UDP media. Keep those two rule sets aligned
when an ingest protocol changes.

Caddy stores certificate state in the protected host directory
`/opt/mediamtx/caddy_data`, not a Docker named volume. Event deployment restores
retained state before Caddy starts when it is available, and teardown captures
the current state before deleting the ingest Droplet. This preserves the stable
ingest endpoint certificate across the provider-zero lifecycle and a Reserved-IP
recovery without relying on fresh ACME issuance.

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
process or log storm. The hook command directly `exec`s the monitored runner,
and the runner terminates and waits for both FFmpeg and its progress parser
before exiting. This ownership is required because MediaMTX is PID 1 in the
container and otherwise adopts unreaped hook descendants.

The shared ingest does not software-encode production video. A camera may use
the direct preview/program branch only after the production source gate proves
1920x1080 progressive H.264 at its exact 29.97/30/59.94/60 mode, `yuv420p`, no
B-frames, bounded timestamps, and a two-second-or-shorter GOP. The branch
stream-copies that H.264 video and converts AAC to 48 kHz stereo Opus.

HEVC remains a supported venue-bandwidth source format only when the event
manifest assigns an isolated HEVC-to-H.264 normalizer and the source probe also
proves the resulting `courtN_preview` is browser-safe. The current template has
no qualified HEVC normalizer assignment, so HEVC must fail production admission
instead of being copied into Linux Chromium WHEP. Monitor and calibration paths
may encode low-resolution diagnostics, but they never define YouTube output.

The July 13 extended run proved that the four-vCPU MediaMTX host does not have
production headroom for shared video normalization: load remained
above 12 at the endpoint with only three active preview/program pairs, and hook
zombies grew to 121. MediaMTX remains the raw/derived path relay. Final
qualification must use browser-safe camera-side H.264 or an isolated,
benchmarked normalization tier; final YouTube output remains 1080p30 or
1080p60. Run `test-scorecheck-ffmpeg-runner.sh` before deployment;
the live churn gate must then show zero zombie growth across at least 50 branch
start/stop cycles.

The monitor rendition is also demand-driven and closes 15 seconds after its
last reader. The dashboard opens at most one monitor or preview reader at a
time; the eight-camera overview uses JPEG snapshots instead of eight decoders.
