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

## Gate 2: eight-court load

- Eight motion-heavy sources, program pages, encoders, and destinations.
- Scoring activity on all courts.
- At least two simultaneous commentary rooms.
- Two compositor hosts, courts 1-4 and 5-8.
- Twelve continuous hours preferred.

Gate 2 must include fault injection: camera removal, venue network loss,
MediaMTX restart, one egress kill, controller restart, one compositor loss,
temporary Supabase/origin interruption, and one shadow-destination change.

## Gate 3: shadow event

Run two real courts for a full event day to unlisted destinations while
StreamRun remains public. The producer must use only `/admin/production`; active
play must require zero SSH intervention.

StreamRun is not retired until all gates pass.
