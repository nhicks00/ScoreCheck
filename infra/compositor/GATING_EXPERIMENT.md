# Compositor Cutover Gates

The July 8 local experiment was a functional proof, not a production soak. It
ran for roughly two hours on Apple/ARM, loaded an empty commentary room, and
validated a test RTMP push. It did not satisfy the one-court cutover gate.

## Gate 1: real one-court soak

Required setup:

- DigitalOcean `c-4` x86 dedicated CPU compositor.
- Real Mevo beach camera publishing to `court1_raw`.
- `court1_preview` for the commentator.
- 3500 ms `court1_program` path for the program page.
- At least one remote commentator speaking continuously and intermittently.
- Unlisted real YouTube RTMPS destination.
- Explicit 720p30 H.264 High, 4000 kbps CBR, 2 second keyframes, AAC 128 kbps.

Pass criteria:

- Ten continuous hours without operator intervention.
- Camera and commentary audible in the archive.
- Commentary sync heartbeat reaches `locked`; target/applied delay remains
  bounded and does not make abrupt corrections.
- Scorebug remains correct and does not flash or duplicate sets.
- Sync measured and acceptable at hour 0, hour 5, and hour 10.
- No unexpected player reloads or terminal LiveKit disconnects.
- No sustained encoder overload, growing RSS, `/dev/shm` exhaustion, or RTMPS
  health degradation.
- Camera loss produces the controlled slate while commentary and output remain
  alive, followed by automatic video recovery.

Record at minimum:

```text
LiveKit egress state and errors
egress CPU/RSS and /dev/shm
program heartbeats and reconnect counts
camera/commentary RMS and silence age
MediaMTX CPU/RSS and path readiness
YouTube stream status/health
sync observations at beginning/middle/end
```

### July 12 result

- Ten-hour post-sync run completed with no egress error, reconnect, restart,
  OOM, frame stall, or MediaMTX path interruption during the official window.
- Program held 30 fps. Commentary sync remained `locked`, with about 3.0
  seconds applied delay and 57-60 ms clock RTT. YouTube health remained good.
- One egress averaged about 1.3 CPU cores. Container RSS rose from roughly 552
  MB to 680 MB; the broader process group rose about 13 MB/hour after warmup.
  The trend was slow and non-accelerating, but event-day egresses must be
  restarted between coverage days rather than left running indefinitely.
- Initial subjective sync passed. Midpoint/final subjective checks were not
  recorded, and camera reconnect recovery was not exercised.
- Result: endurance pass, conditional Gate 1 pass. Carry the missing sync and
  recovery checks into the direct eight-court validation.

## Gate 2: eight-court load

The current operator decision is to test all eight real cameras directly,
without synthetic sources or separate two- and four-court stages:

- The first attempt used one dedicated `c-4` ingest node to normalize all
  inputs to 720p30. That topology failed and must not be repeated.
- Streams 1-2 enter as Mevo H.264 RTMP 1080p60 stress inputs at 6 Mbps.
- Streams 3-5 enter as AVKANS Go HEVC SRT caller 1080p30 inputs at 3 Mbps
  with 2500 ms latency.
- Streams 6-8 are MAKI Live H.264 SRT listeners at 1080p30 and 3 Mbps. MediaMTX
  pulls them through the site-to-site tunnel with 2500 ms receiver latency and
  owns reconnects; no Mac or separate relay process participates.
- Four dedicated `c-4` compositor hosts own courts 1-2, 3-4, 5-6, and 7-8.
- Eight separate unlisted destinations have auto-start and auto-stop disabled.
- Run at least two continuous hours; twelve hours remains preferred.

Every court includes its program page, encoder, destination, and scoring. A
compositor host owns at most two courts. Sustained 80% CPU, frame loss, growing
queues/RSS, or one court affecting its paired court fails the topology.

### First full-eight result (2026-07-12)

- All eight real raw feeds reached MediaMTX concurrently after Speedify was
  corrected from Streaming/Auto (which selected TCP) to Speed/UDP. WireGuard
  packet loss improved from 70% to 10%, but the test uplink remained congested
  and below the preferred 75 Mbps bonded-upload floor.
- Program startup exposed an on-demand dependency deadlock: `courtN_program`
  polled for `courtN_preview`, while `courtN_preview` required a reader before
  starting. Program and calibration inputs now directly trigger the preview
  normalizer instead.
- Eight preview normalizers pinned the four-vCPU ingest node at 393.88% CPU.
  FFmpeg processes produced only 18-24 fps at 0.59-0.81x speed, so multiple
  program paths timed out or never produced frames.
- All eight egress requests were accepted, but no YouTube broadcast was
  transitioned live. The egress jobs were stopped after the ingest capacity
  failure; compositor capacity was not the limiting stage.

Gate 2 cannot resume with one `c-4` normalizing eight 1080p inputs. The next
candidate must either split normalization across two `c-4` hosts (four courts
each) or qualify camera-side 720p30 H.264 outputs that remove cloud video
transcoding. A passing run still requires at least 20% sustained CPU headroom
and a non-congested venue uplink.

### Speedify routing follow-up (2026-07-12)

- The low Speedify dashboard rate was real: an ingest-IP host route sent all
  camera and WireGuard traffic directly through T-Mobile. MediaMTX received
  about 35 Mbps while Speedify carried less than 1 Mbps.
- A global ingest-IP override proved the correct Speedify exit identity but
  also captured operator traffic and caused a reconnect storm. The production
  route must select RTMP/SRT ports only and must be active before cameras start.
- Speed/UDP carried one and three direct SRT callers at about 3.5 and 10.6 Mbps.
  Staged addition of the two RTMP cameras settled near 20 Mbps. Adding the
  temporary MAKI WireGuard tunnel raised Speedify input to about 77 Mbps and
  dropped SRT paths, proving the current home uplinks have inadequate headroom.
- Multi-TCP used four sockets per WAN and carried the five direct publishers,
  but the nested WireGuard handshake went stale and listener-camera paths
  dropped. Multi-TCP is rejected for this topology.
- The router was returned to direct routing with Speedify disconnected and all
  eight raw paths healthy. The final two-Mevo/six-AVKANS direct-publisher mix
  must be tested on a sustained 75 Mbps or faster bonded upload before Gate 2.

Gate 2 must include fault injection: camera removal, venue network loss,
MediaMTX restart, one egress kill, controller restart, one compositor loss,
temporary Supabase/origin interruption, and one shadow-destination change.

## Gate 3: shadow event

Run two real courts for a full event day to unlisted destinations while
StreamRun remains public. The producer must use only `/admin/production`; active
play must require zero SSH intervention.

StreamRun is not retired until all gates pass.
