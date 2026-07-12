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

- One dedicated `c-4` ingest node normalizes all inputs to 720p30.
- Streams 1-2 enter as Mevo H.264 RTMP 1080p60 stress inputs at 6 Mbps.
- Streams 3-5 enter as AVKANS Go HEVC SRT caller 1080p30 inputs at 3 Mbps
  with 2500 ms latency.
- Streams 6-7 are temporary MAKI Live H.264 RTMP 1080p30 inputs at 3 Mbps;
  their current firmware did not bind SRT listeners reliably during setup.
- Stream 8 is a MAKI Live H.264 SRT listener at 1080p30 and 3 Mbps. MediaMTX
  pulls it through the site-to-site tunnel with 2500 ms receiver latency and
  owns reconnects; no Mac or separate relay process participates.
- Four dedicated `c-4` compositor hosts own courts 1-2, 3-4, 5-6, and 7-8.
- Eight separate unlisted destinations have auto-start and auto-stop disabled.
- Run at least two continuous hours; twelve hours remains preferred.

Every court includes its program page, encoder, destination, and scoring. A
compositor host owns at most two courts. Sustained 80% CPU, frame loss, growing
queues/RSS, or one court affecting its paired court fails the topology.

Gate 2 must include fault injection: camera removal, venue network loss,
MediaMTX restart, one egress kill, controller restart, one compositor loss,
temporary Supabase/origin interruption, and one shadow-destination change.

## Gate 3: shadow event

Run two real courts for a full event day to unlisted destinations while
StreamRun remains public. The producer must use only `/admin/production`; active
play must require zero SSH intervention.

StreamRun is not retired until all gates pass.
