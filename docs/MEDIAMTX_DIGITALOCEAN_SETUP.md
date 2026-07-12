# MediaMTX DigitalOcean Setup

The current ingest node is `bvm-preview-01` at
`preview.beachvolleyballmedia.com`. Its version-controlled configuration lives
in `infra/mediamtx`.

## Paths

Each camera has one permanent publishing identity and two consumer branches:

| Path | Purpose |
|---|---|
| `courtN_raw` | Mevo/camera H.264 + AAC input |
| `courtN_preview` | Clean, undelayed 720p H.264 + Opus WHEP preview |
| `courtN_program` | Clean preview held by the program SRT delay |
| `courtN_calibration` | On-demand UTC-burned engineering view only |

The program path stream-copies the normalized preview after the SRT receiver
buffer. It does not run a second H.264 encoder.

## Mevo publishing

For court 1:

```text
RTMP server: rtmp://preview.beachvolleyballmedia.com
Stream key:  court1_raw?user=streamrun&pass=<publish password>
```

Change only the court number for courts 2 through 8. The publish password is in
the existing gitignored local credentials, never in this document.

Recommended starting camera profile:

```text
1280x720, 30 fps
H.264, 4 Mbps CBR or closest supported setting
2 second keyframe interval
AAC, 48 kHz, 128 kbps
```

## Browser playback

```text
Preview: https://preview.beachvolleyballmedia.com/court1_preview/whep
Program: https://preview.beachvolleyballmedia.com/court1_program/whep
```

The ScoreCheck application constructs these URLs from each active event's court
rows. Commentary pages consume only preview paths; compositor pages consume only
program paths.

## Deployment

```bash
cd infra/mediamtx
set -a
source ../../apps/web/.env.setup.local
set +a
MEDIAMTX_PROGRAM_DELAY_MS=3500 ./deploy.sh
```

The script:

1. Renders the publish credential into a gitignored config.
2. Uploads the pinned Compose/config bundle.
3. Backs up the active remote files.
4. Recreates MediaMTX.
5. Verifies the local API.
6. Restores the prior configuration on failure.

## Health checks

On the node:

```bash
curl -fsS http://127.0.0.1:9997/v3/paths/list | jq .
curl -fsS http://127.0.0.1:9998/metrics | head
docker stats --no-stream mediamtx
docker logs --tail=100 mediamtx
```

Path readiness is demand-driven. `courtN_preview` starts when a human or the
program branch reads it. `courtN_program` starts when a compositor reads it.

## Capacity boundary

The existing base node is suitable for one-court Gate 1 and low-volume preview
use. It is not the eight-court production target. Before Gate 2, direct camera
outputs must be profiled and the ingest plane must be sized from measured
normalization CPU, with an initial planning floor of 8 dedicated vCPU and
8-16 GB RAM if all eight feeds require H.264 normalization.
