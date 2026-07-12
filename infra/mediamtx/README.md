# ScoreCheck MediaMTX

The ingest server owns three distinct path classes per court:

- `courtN_raw`: permanent Mevo/camera publishing identity.
- `courtN_preview`: clean, normalized, low-latency H.264/Opus for people.
- `courtN_program`: clean preview delayed at the SRT receiver for compositing.

`courtN_calibration` is an on-demand UTC-burned test path and is never used by
the production scene.

Render and deploy without printing the publish credential:

```bash
set -a
source ../../apps/web/.env.setup.local
set +a
MEDIAMTX_PROGRAM_DELAY_MS=3500 ./deploy.sh
```

The deploy script backs up the active remote files, recreates the pinned
container, verifies the local MediaMTX API, and restores the prior files if the
new process fails health checks.
