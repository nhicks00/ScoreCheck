# StreamRun IVS Preview Runbook

This note records the July 1, 2026 Court 1 StreamRun/IVS preview failure so future setup runs do not repeat the same mistake.

## What Failed

Two different problems looked like one player issue:

- The StreamRun IVS destination must be the AWS IVS RTMPS ingest server plus the IVS stream key. Do not paste the IVS playback URL, the site preview URL, or the HTML overlay URL into the destination.
- Local test video on this Mac must not rely on FFmpeg native SRT output or a direct `ffmpeg | srt-live-transmit file://con` stdin pipe. This FFmpeg build does not have SRT output enabled, and the direct stdin pipe can leave `srt-live-transmit` connected while FFmpeg exits or no frames reach StreamRun.

The result was misleading: StreamRun/IVS could show connected/live-ish state while the preview was blank, stale, or only showing old IVS playlist content.

## Correct StreamRun Destination

For each IVS preview destination in StreamRun:

- Platform: custom/Other RTMP destination.
- RTMP address: `rtmps://<ivs-ingest-endpoint>:443/app/`
- Stream key: the AWS IVS stream key value for that court.

Do not store the IVS stream key in docs, committed files, shell history, screenshots, or logs.

After changing a live destination, restart or cycle the affected StreamRun output so the new destination settings are used.

## Separate IVS Output Elements

For clean low-latency scoring preview, each court workflow should have two output elements:

- YouTube output branch: camera plus ScoreCheck HTML overlay.
- IVS preview output branch: camera-only low-latency preview, unless an intentional combined preview is being tested.

The StreamRun API can map and override existing output elements and destinations, but it cannot create missing outputstream elements inside a configuration. If `npm run setup:streamrun` reports `Missing separate IVS outputstream element`, create that output element in the StreamRun editor first, then rerun:

```bash
npm run setup:streamrun:discover
npm run setup:streamrun
```

As of the July 2, 2026 follow-up readiness audit, all courts 1-8 have separate YouTube and IVS output elements. The StreamRun setup verifier now also checks the saved editor settings: every HTML overlay must point at `https://score.beachvolleyballmedia.com/overlay/stream/[1-8]`, each YouTube output must contain only its matching YouTube destination, and each IVS output must contain only its matching IVS preview destination.

## Correct Local Test Feed Shape

Use a local UDP MPEG-TS handoff into `srt-live-transmit`, then forward to the StreamRun SRT input.

Flow:

```text
FFmpeg test pattern -> local UDP MPEG-TS -> srt-live-transmit -> StreamRun SRT input -> StreamRun output -> IVS -> website preview
```

Important details:

- Use the input element stream key from the running StreamRun instance, not the top-level instance stream key.
- Use `pkt_size=1316` on the local FFmpeg UDP output.
- Keep SRT latency explicit.
- Do not print the generated StreamRun SRT URL.

Safe command pattern:

```bash
STREAMRUN_API_KEY=$(sed -n 's/^STREAMRUN_API_KEY=//p' apps/web/.env.local | sed 's/^"//;s/"$//')
STREAMRUN_BASE_URL=$(sed -n 's/^STREAMRUN_BASE_URL=//p' apps/web/.env.local | sed 's/^"//;s/"$//')
: "${STREAMRUN_BASE_URL:=https://streamrun.com}"
INSTANCE_ID="<running-streamrun-instance-id>"
INPUT_KEY=$(curl -fsS -H "Authorization: Bearer ${STREAMRUN_API_KEY}" \
  "${STREAMRUN_BASE_URL%/}/api/v1/instances/${INSTANCE_ID}" \
  | jq -r '.state.elements[] | select(.id=="inputstream-1") | .state.streamkey')

PORT=24124
SRT_URL="srt://ingest.streamrun.io:8890?streamid=publish:${INPUT_KEY}&mode=caller&latency=500000"

/opt/homebrew/bin/srt-live-transmit "udp://:${PORT}?rcvbuf=26214400" "$SRT_URL" -chunk:1316 -quiet -loglevel:error &
SRT_PID=$!

/opt/homebrew/bin/ffmpeg -hide_banner -nostats -loglevel error \
  -re -f lavfi -i "smptebars=duration=1800:size=1280x720:rate=30" \
  -re -f lavfi -i "sine=frequency=1000:duration=1800:sample_rate=48000" \
  -c:v libx264 -preset veryfast -profile:v baseline -level:v 3.1 -pix_fmt yuv420p \
  -r 30 -g 60 -keyint_min 60 -sc_threshold 0 -bf 0 \
  -b:v 2500k -maxrate 2500k -bufsize 5000k \
  -x264-params "nal-hrd=cbr:force-cfr=1:repeat-headers=1:aud=1" \
  -c:a aac -b:a 128k -ar 48000 -ac 2 \
  -f mpegts -mpegts_flags +resend_headers+initial_discontinuity \
  -pat_period 0.2 -sdt_period 0.5 \
  "udp://127.0.0.1:${PORT}?pkt_size=1316"

kill "$SRT_PID" 2>/dev/null || true
```

## Validation Checklist

Do not trust a single status indicator. Verify all of these:

- StreamRun editor preview for the selected output shows the current generated test pattern and the scorebug overlay.
- AWS IVS `get-stream` reports the court channel as `LIVE` and `HEALTHY`.
- The signed IVS HLS playlist has fresh `EXT-X-PROGRAM-DATE-TIME` values and recent media segments return HTTP 200 with MPEG-TS bytes.
- `/admin/ivs-preview/[courtNumber]` plays in a browser with `video.readyState === 4`, `videoWidth > 0`, `currentTime` advancing, and no video element error.
- A browser screenshot shows the current test pattern, not a stale frame.

StreamRun API input counters can be stale or misleading during this workflow. If the API says `0 fps` but StreamRun WebRTC preview and IVS/browser playback show the current test frame, treat the visual/player checks as stronger evidence.

## Known Anti-Patterns

- Do not use this Mac's FFmpeg as `-f mpegts srt://...`; its protocol list has `srtp`, not `srt`.
- Do not rely on a background direct stdin pipe to `srt-live-transmit`; it can leave the SRT process running without a live FFmpeg producer.
- Do not configure the StreamRun IVS destination with an IVS playback URL, signed playback URL, website admin preview URL, or HTML overlay URL.
- Do not use the top-level StreamRun instance `streamkey` when publishing to `inputstream-1`; use the `inputstream-1` element's runtime `state.streamkey`.
