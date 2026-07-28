# MediaMTX DigitalOcean Setup

The current ingest node is `bvm-preview-01` at
`preview.beachvolleyballmedia.com`. Its version-controlled configuration lives
in `infra/mediamtx`.

## Paths

Each camera has one permanent publishing identity and three consumer branches:

| Path | Purpose |
|---|---|
| `courtN_raw` | Permanent camera SRT input: Mevo HEVC or AVKANS H.264, plus AAC |
| `courtN_preview` | Clean, undelayed 1080p H.264 + Opus WHEP commentary/inspection preview |
| `courtN_monitor` | On-demand 360p/10 FPS low-bandwidth operator view |
| `courtN_program` | Clean 1080p source held by the program SRT delay and consumed as buffered fMP4 HLS |
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

Production camera profiles:

```text
Mevo Core 1-2: encrypted SRT, HEVC, 1920x1080 at manifest-selected 30 or 60 fps
AVKANS GO 3-8: encrypted SRT, H.264, 1920x1080 at 30 fps
All cameras: progressive, square pixels, bounded two-second GOP, AAC 48 kHz stereo
```

The admission gate verifies the resulting browser-safe source before coverage.
Mevo HEVC is accepted only through its assigned isolated HEVC-to-H.264
normalizer. AVKANS H.264 must be decodable and report valid geometry/profile;
an H.264 label alone is not sufficient.

## Browser playback

```text
Preview: https://preview.beachvolleyballmedia.com/court1_preview/whep
Monitor: https://preview.beachvolleyballmedia.com/court1_monitor/whep
Program: https://preview.beachvolleyballmedia.com/court1_program/index.m3u8
```

The ScoreCheck application constructs these URLs from each active event's court
rows. Commentary pages consume only preview paths; compositor pages consume only
buffered program HLS paths. Program HLS keeps 15 two-second fMP4 segments and
targets a 12-second live offset because continuity is more important than
latency.

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
program branch reads it. `courtN_monitor` starts only for the selected dashboard
camera and closes after 15 seconds without a reader. `courtN_program` starts
when a compositor reads it.

## Capacity boundary

The July 13 eight-camera soak did not qualify the 4-vCPU ingest host for final
production capacity. Load remained above core count and peaked above 13 while
three program branches were active. Scale or split the ingest plane before the
next full event, then rerun the same viewer-quality and capacity gate. The
on-demand monitor rendition is limited to one selected camera, but that only
limits venue bandwidth; it does not create ingest CPU headroom. Do not admit a
monitor transcode on the central 4-vCPU host during full production until
normalization is offloaded or the revised capacity gate explicitly qualifies it.
The authenticated admin stream-source API issues the monitor URL only when the
court has an explicit `OFF` broadcast expectation; unknown expectation state is
fail-closed.
