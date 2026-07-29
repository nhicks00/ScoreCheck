# Physical Camera 5 HLS Recovery Gate

Date: 2026-07-29 UTC  
Branch: `codex/reliability-qualification`  
Runtime media revision: `660c54caa3e76ae69b142e409c7f7bf7b675ab38`  
Latest evidence-tool revision: `41acf18dbaaaefaf0703463479d2cd4ff52cdc62`  
Result: **Output conformance PASS; continuous browser playback FAIL; formal recorder coverage FAIL**

## Scope

This was a physical-camera, file-only qualification of Camera 5. Camera 5 was
an AVKANS GO publishing 1920x1080 H.264/AAC over SRT. The candidate program
path was:

```text
Camera 5 SRT/H.264
  -> MediaMTX court5_raw
  -> FFmpeg RTSP/TCP stream copy court5_program
  -> patched MediaMTX fMP4 HLS
  -> event-local Chromium renderer
  -> LiveKit Egress MP4 file
```

No YouTube output was started. All Speedify inputs remained saved as
`automatic`. The test did not change camera configuration.

## Candidate Changes

| Commit | Change |
| --- | --- |
| `aa0c32f18` | Use RTSP/TCP for the buffered program branch and keep the HLS muxer alive after an H.264 DTS extraction failure. |
| `74de263fb` | Supply the RTSP port to MediaMTX hook processes. |
| `660c54caa` | Use the FFmpeg RTSP demuxer's supported `-timeout` option. |
| `41acf18db` | Split stream metadata from keyframe-only ffprobe evidence so long captures no longer emit all-frame JSON. This commit was pushed after the gate started and was not part of the runtime capture. |

The deployed MediaMTX image was
`scorecheck/mediamtx:1.19.2-avkans-adts-gop2`. MediaMTX and Caddy remained
healthy with restart count zero and zero zombie processes. The Caddy container
identity did not change during the MediaMTX-only cutovers.

## Timeline

| UTC | Observation |
| --- | --- |
| `01:28:06` | Bounded qualification unit started. |
| `01:28:11` | One file-only Egress became active. |
| `01:28:12` | Program branch runner started. |
| `01:28:13` | `court5_program` became available; one HLS muxer and browser session started. |
| `01:29:05` | First damaged-GOP recovery warning occurred without killing the muxer. |
| `01:37:25` | The original external monitor recorder stopped after two fetch failures. The router recorder stopped at approximately the same checkpoint. |
| `01:51:37` | A second HLS browser session appeared on the unchanged program page. |
| `01:58:12` | Final preserved browser heartbeat before Egress cleanup. |
| `01:58:16` | The 1,800-second MP4 capture finalized. |
| `01:59:33` | HLS muxer retired normally after the reader left. |
| `02:01:03` | On-demand program runner retired normally after the configured idle delay. |
| `02:05:25` | Legacy all-frame ffprobe completed and the qualification unit exited successfully. |

## What Passed

### Program process survival

- One program runner start and one normal retirement.
- One HLS muxer creation and one normal post-test retirement.
- Thirty-two damaged-GOP/DTS extraction warnings were handled without a
  MediaMTX restart or immediate muxer crash.
- MediaMTX restart count remained zero and ingest zombie count remained zero.
- The compositor returned to idle with zero active Egress requests, no Egress
  restart, no OOM, and zero zombies.

### Final encoded file

The exact 1,800-second file passed the local 1080p30 output contract:

| Property | Observed |
| --- | --- |
| Codec/profile | H.264 High |
| Dimensions | 1920x1080 |
| Frame rate | 30 fps |
| Pixel/scan/color | yuv420p, progressive, Rec.709 |
| Video bitrate | 9,012.31 kbps in the content-dependent MP4 |
| Audio | AAC stereo, 48 kHz, 128.183 kbps |
| Duration | 1,800.96 seconds |
| Keyframes | 901 |
| Maximum keyframe gap | 2.000 seconds |
| File size | 2,058,713,180 bytes |
| File SHA-256 | `79ce92523feb0d6ad479476a20fe0240ad707427e4b071bd888a183d2905e9ea` |

This proves that Egress continued producing a valid 1080p30 program file. It
does not prove continuous camera motion inside every encoded frame.

## What Failed

### Browser continuity

The final preserved heartbeat retained the same page load and reported:

| Counter | Final value |
| --- | ---: |
| HLS player instances created/destroyed/active | 2 / 1 / 1 |
| Reconnects / page reloads | 1 / 0 |
| Dropped decoded frames | 46 |
| Freeze count | 62 |
| Total browser freeze duration | 23,518.8 ms |
| HLS playout delay | 38,144 ms |
| Forward buffer | 19,528.1 ms |

The HLS segmenter also warned that segment duration changed through
`3s -> 5s -> 6s -> 8s -> 19s -> 38s`. Keeping the muxer alive prevented a
hard process failure, but the dropped damaged GOPs created an expanding media
timeline gap. The result is not acceptable as smooth, continuous playback.

The content analyzer's 94,997 ms frozen-image signal is retained but is not
used as the primary verdict because a physically static camera scene can
produce the same visual signature. The browser's reset-safe drop, freeze, and
reconnect evidence is independently sufficient to fail the gate.

### Source transport

The final preserved raw-path counters were:

- packets received: `2,182,057`;
- packets lost: `419,003`;
- packets retransmitted: `391,717`;
- packets dropped: `87,692`;
- configured/negotiated receive buffer: approximately `2,500 ms`.

During the synchronized first portion of the gate, Speedify reported zero
aggregate tunnel loss and all four input records remained saved as
`automatic`. The AVKANS SRT loss and damaged H.264 GOPs therefore remain the
earliest proven failure layer. The evidence does not support blaming YouTube,
Egress encoding, or aggregate venue bandwidth for this gate.

### Recorder coverage

The original 15-second monitor recorder ended at `01:37:25Z`, and the router
recorder ended at approximately `01:35Z`. Direct systemd, MediaMTX, artifact,
and final preserved heartbeat evidence covers the completed run, but the
formal external recorder did not cover all 30 minutes. This is a separate gate
failure and is not waived by the successful file output.

A new launchd-owned monitor and Tailscale router recorder were started under a
separate protected continuation directory after this defect was discovered.

## Classification

| Gate | Result |
| --- | --- |
| MediaMTX survives damaged GOPs | PASS |
| One exact Egress, clean idle cleanup | PASS |
| 1080p30 H.264/AAC output conformance | PASS |
| Continuous buffered camera playback | FAIL |
| Event-length monitor/router recorder coverage | FAIL |
| YouTube viewer delivery | NOT RUN |
| Overall production qualification | FAIL |

The candidate must not be expanded to eight outputs or YouTube yet.

## Next Decision

The next physical experiment must address source recovery before another HLS
change. MediaMTX 1.19.2 uses gosrt's listener configuration and negotiates the
receiver delay with the caller. A bounded higher receiver-latency gate is the
smallest server-side experiment consistent with the project's reliability-first
priority. It should compare per-camera loss and drop slopes before and after the
change while all Speedify inputs remain automatic.

If a larger SRT recovery window does not materially reduce AVKANS loss, the
next measured comparison is AVKANS RTMP/H.264 versus SRT/H.264. Software
decode/re-encode can conceal damaged references, but it should not become the
default until compositor CPU and event-long playback headroom pass.

## Protected Evidence

Protected root:

```text
~/.config/scorecheck/event-stack/events/weekend-dry-run-20260726/
  final-evidence/diagnostic-20260726T2301Z/
  hls-recovery-gate-c5-20260729T0128Z-summary/
```

Small artifact hashes:

| Artifact | SHA-256 |
| --- | --- |
| `court-5-1080p30.capture.json` | `56f2b2b1b5481cf51b9f0a078806749b11cec3212fd909f6bc1f87a11186be7f` |
| `court-5-1080p30.conformance.json` | `f689236d7ef097bbf52cd2126c8dc881005ca63a9aba34be20e743252e7f9ebb` |
| `mediamtx-court5-gate.log` | `9d5aef5d5b65e4ef29624cad0138fe40cffe930502037ad79425e7cef4347e0c` |
| `monitor-baseline.jsonl` | `13e578300b0a486da9378a856f88402836215c75710be7155c982f86bd6b67a8` |
| `monitor-last-recorder-sample.jsonl` | `ff1309c65c5124f855d4f8ba5d43ee7e5fcb30f28cd6816b06df77f44ba832a5` |
| `monitor-final-preserved-heartbeat.json` | `c518371148026209989cd3c19230485fa7d7d737e4c04a730f434a54e9aa6af7` |

Large raw media and all-frame probe data remain on protected event hosts and
are intentionally excluded from Git. Their identity and the MP4 hash are
preserved in the capture report.
