# Physical Camera 5 HLS Endurance Gate

Date: 2026-07-29 UTC

Branch: `codex/reliability-qualification`

Evidence revision: `dea7177a34f4f476c5def9dcfcf6a1dace525cd0`

Result: **PASS for physical source, buffered browser continuity, 1080p30 file output, cleanup, and recorder coverage**

## Scope

This was a 30-minute, local-file-only endurance gate using physical Camera 5,
an AVKANS GO publishing 1920x1080 H.264 High/AAC over SRT. Six physical camera
flows were active through the event router. Cameras 7 and 8 were intentionally
blocked before Speedify because the preceding physical capacity staircase
showed that this router does not have acceptable seven- or eight-camera reserve.

The tested path was:

```text
Camera 5 SRT/H.264
  -> MediaMTX court5_raw
  -> FFmpeg RTSP/TCP stream-copy court5_program
  -> MediaMTX fMP4 HLS
  -> event-local Chromium renderer
  -> one LiveKit Egress 1080p30 MP4 file
```

No broadcast destination was configured, so this gate could not publish to
YouTube. All Speedify input priorities remained `automatic`.

## Timeline

| UTC | Observation |
| --- | --- |
| `05:10:31` | Program page loaded. |
| `05:10:33` | Exact Egress `EG_WrXxbUPzencL` became active on the first attempt. |
| `05:10:36` | Browser heartbeat reported startup waiting state. |
| `05:11:06` | Browser entered stable playing state. |
| `05:26:06` | Reset-safe 900-second midpoint completed at exactly 30.0 rendered fps with zero quality-counter growth. |
| `05:40:31` | Final fresh playing heartbeat was preserved. |
| `05:40:33` | Exact 1,800-second capture boundary passed; Egress stopped to proven idle. |
| `05:41:22` | Output metadata and keyframe probes completed successfully. |
| `05:43:37` | HLS reader and on-demand program branch had drained; raw reader count returned to baseline. |

## Browser Continuity

The same page and one HLS player remained active for the whole playing window.

| Property | Observed |
| --- | ---: |
| Playing interval | 1,765 seconds |
| Rendered frame delta | 52,953 |
| Aggregate rendered fps | 30.0017 |
| Dropped-frame delta | 0 |
| Freeze-count delta | 0 |
| Freeze-duration delta | 0 ms |
| Reconnect delta | 0 |
| Reload delta | 0 |
| Maximum HLS instances created/active | 1 / 1 |
| Playout delay | 11.831-13.953 seconds |
| Buffered ahead | 10.402-13.520 seconds |
| JavaScript heap | 7.83-17.58 MB |

Latency was deliberately subordinate to continuity. The roughly 12-14 second
buffer stayed bounded rather than expanding, and it absorbed source transport
recovery without a browser-visible interruption.

## Source And Router

Camera 5 remained ready at approximately 3.23 Mbps with zero media frame
errors and no content-analyzer restart growth. During the exact capture window:

| Property | Observed |
| --- | ---: |
| SRT packets received | +662,475 |
| SRT packets lost | +2,445 (0.369%) |
| SRT packets dropped | +1,006 (0.152%) |
| SRT RTT | 91.7-331.1 ms, 117.0 ms average |
| Camera bitrate | 3.191-3.272 Mbps |
| Router CPU | 71.5-79.1%, 74.5% average |
| Router queue | 0-107 packets, 23.6 average |
| Camera flows | Exactly 6 |

The source still required SRT recovery, but no damaged GOP/DTS warning reached
the HLS muxer. The ingest log recorded one normal startup segment adjustment
from two to three seconds, then no further segment-duration growth.

This does not qualify six full-motion cameras. Cameras 1 and 2 were showing
mostly dark/static scenes and used materially less than their configured peak
bitrate. The separate physical capacity report remains authoritative: four
cameras retained at least 30% router CPU reserve, six were stable in the
bounded static-scene hold, seven lacked reserve, and eight repeatedly failed.

## Output Conformance

The exact 1,800.917-second file passed the current 1080p30 contract:

| Property | Observed |
| --- | --- |
| Video | H.264 High, 1920x1080, yuv420p, progressive |
| Color | Rec.709 space, transfer, and primaries |
| Frame rate | 30 fps |
| Video bitrate | 9,896.188 kbps |
| Audio | AAC stereo, 48 kHz, 128.881 kbps |
| Keyframes | 901 |
| Maximum keyframe gap | 2.000 seconds |
| File size | 2,257,807,730 bytes |
| File SHA-256 | `06f21843ae13fecfe526691f94ab39056b305f54035a639af96cc6f0fec82644` |

The large MP4 remains on the protected event host. Small metadata, keyframe,
capture, and conformance reports were copied locally and verified byte-for-byte
against remote SHA-256 values.

## Runtime And Cleanup

- One exact Egress was active for the whole capture; no duplicate was admitted.
- Effective Egress memory was 1.92-2.73 GB and CPU load ratio averaged 0.398.
- Direct container memory growth was filesystem page cache charged for the
  large local evidence file, not anonymous-process growth. Host available
  memory remained healthy and returned to approximately 15.3 GB after stop.
- Compositor and ingest zombie counts remained zero.
- Egress and MediaMTX restart counts remained zero; Egress was not OOM-killed.
- One HLS muxer was created and one was destroyed.
- The program path retired normally, and Camera 5 raw reader count returned
  from two to its baseline one.
- Incidents and monitor fault gates remained empty.

## Recorder Coverage

| Recorder | Samples | Maximum gap | Result |
| --- | ---: | ---: | --- |
| Monitor snapshot | 120 | 15 seconds | PASS |
| Router/Speedify | 150 | 60 seconds | PASS |

This closes the formal recorder-coverage failure from the earlier Camera 5 HLS
gate.

## Classification

| Gate | Result |
| --- | --- |
| Physical SRT/H.264 source remains admitted | PASS |
| Buffered HLS browser continuity | PASS |
| One exact Egress and clean idle cleanup | PASS |
| 1080p30 H.264/AAC output conformance | PASS |
| Event-length monitor/router recorder coverage | PASS |
| YouTube provider and viewer delivery | NOT RUN |
| Full-motion six-camera router reserve | NOT PROVEN |
| Eight-camera production capacity on this router | FAIL, from separate physical staircase |

This is the first clean 30-minute physical buffered-program pass after the
prior HLS failure. It validates the combined current state: eight-second SRT
receiver latency, RTSP/TCP program branch, bounded HLS runtime, current browser
health counters, fixed output probe, and durable recorders. It does not isolate
which individual change was sufficient.

## Next Gate

Use this exact Camera 5 path for a bounded unlisted YouTube gate. Require the
same reset-safe browser continuity plus persistent Egress identity, YouTube
`live/active/good` state, fresh moving viewer playback, correct audio, and clean
source-loss slate/recovery without completing the broadcast. Do not expand to
eight simultaneous outputs until dedicated venue-router hardware passes the
physical eight-camera reserve gate.

## Protected Evidence

```text
~/.config/scorecheck/event-stack/events/reliability-physical-20260728/
  qualification-evidence/camera5-hls-endurance-20260729T051015Z/
```

The evidence directory contains the exact report copies, preflight/postflight
snapshots, midpoint and final reset-safe summaries, recorder coverage, runtime
cleanup evidence, and a 15-entry SHA-256 manifest. The manifest SHA-256 is
`6f1922d06b57597ee098d767f235b9448d0b11afbbfb05551bad3cea4b61aa2a`.
