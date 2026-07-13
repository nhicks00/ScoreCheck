# Ingest Host Capacity-Risk Finding

Date: 2026-07-13
Status: sustained load spike observed without coincident output failure; correlation only

## Event

At the `16:59Z` checkpoint, load1 on the four-vCPU MediaMTX ingest host reached
13.85 and remained at 13.47 after the required approximately 30-second recheck.
The active CPU leaders were three FFmpeg normalizers at approximately 89.6,
74.0, and 71.6 percent of one CPU and MediaMTX at approximately 48.5 percent.
Zombie children remained stable at 108.

No output degradation coincided with the recheck. All eight raw paths and six
derived branches remained ready with positive bitrate and zero frame errors.
Program FFmpeg remained at 30.01-30.02 fps. Program browsers on Courts 1, 3,
and 5 reported 31, 30, and 30 fps with zero RTP loss. YouTube remained live,
active, bound, and healthy on all three outputs, and fail-closed routing stayed
healthy.

During the preceding interval, Court 1 added 231 dropped frames, 21 freezes,
and 13.322 seconds of freeze duration; Court 3 added 72 drops, nine freezes,
and 7.598 seconds. Those counters remained flat during the subsequent
approximately 50-second recheck.

## Assessment

Sustained load above 13 on a four-vCPU host is a capacity-headroom risk even
though Linux load is not equivalent to CPU utilization and the active outputs
remained healthy. The simultaneous normalizer activity is relevant capacity
evidence, but this checkpoint does not prove that host load caused the known
browser pacing defect. The flat browser counters during the recheck argue
against treating this load spike as a direct trigger.

The post-soak capacity gate should preserve per-process CPU, run-queue/load,
MediaMTX path health, normalizer progress, browser pacing rates, and output
health on one timeline. A topology or sizing change should be accepted only if
it restores meaningful headroom under representative eight-feed load without
changing media timing, commentary synchronization, or public-output behavior.

## 19:47Z-19:49Z continuation

MediaMTX zombie children increased from 108 to 111 and held at 111 on recheck,
all beneath the same parent PID 76143. Host load1 rose from 6.45 to 7.13 on the
four-vCPU host. At the same checkpoint, Courts 3 and 5 experienced in-page WHEP
reconnect and counter-reset activity and Court 1 remained severely degraded.

However, all eight raw paths and six derived branches remained ready with
positive bitrate and zero frame errors, program FFmpeg remained at 30 fps with
zero drops, all agents and Egress outputs were healthy, YouTube outputs were
healthy, and fail-closed Speedify routing remained intact. The zombie growth
and load rise are confirmed capacity-risk evidence and temporal correlation;
they do not establish causation for the browser reconnects or pacing loss.

## 19:58Z-20:01Z continuation

MediaMTX load1 was 6.17 and then 6.91 on the four-vCPU host. Zombie children
held at 111. All eight raw paths and six derived branches remained ready, all
byte counters advanced, and frame errors remained zero. Browser pacing loss
continued concurrently, but the media-host evidence showed no new path or
frame-integrity failure. This remains elevated-load and reduced-headroom
evidence, separate from both the viewer-path defect and recurring router
watchdog duplication.

## 20:14Z-20:15Z continuation

MediaMTX zombie children increased from 111 to 114 and held at 114. Host load1
rose from 6.34 to 8.14 during the 32-second recheck on the four-vCPU host. All
eight raw paths and six derived branches remained ready, byte counters
advanced, and frame errors remained zero. Program FFmpeg remained near 30 fps
with zero drops, and Egress and YouTube remained healthy.

The zombie increase and sustained load rise are confirmed additional
capacity-risk evidence. They occurred near a Court 1 in-page WHEP reconnect and
continued Court 5 pacing degradation, but healthy media-path and output
evidence still prevents a causal attribution.

## 20:28Z-20:30Z continuation

MediaMTX load1 spiked to 9.58 on the four-vCPU host and eased to 7.18 after the
32-second recheck. Zombie children held at 114. At the same checkpoint, Courts
1 and 5 showed severe browser pacing loss, but all eight raw paths and six
derived branches remained ready, bytes advanced, frame errors remained zero,
program FFmpeg remained near 30 fps with zero drops, and routing, Egress, and
YouTube remained healthy.

This is sustained reduced-headroom evidence. The load spike remains correlated
with viewer-path degradation but is not causal proof because media ingest and
all public-output controls remained intact.

## 20:43Z-20:44Z continuation

MediaMTX load1 eased through 5.03, 6.11, and 6.70 while zombie children held at
114. Although below the earlier 9.58 spike, load remained above the host's four
vCPU count. All raw and derived paths remained ready, bytes advanced, frame
errors remained zero, and upstream FFmpeg, routing, Egress, and YouTube stayed
healthy. This is continued reduced-headroom evidence rather than a new capacity
incident or proof of viewer-path causation.

## Final endpoint: 21:01Z-21:02Z

At the user-directed 16:00 CDT endpoint, MediaMTX load was
14.08/13.84/10.22 and remained 12.58/13.44/10.27 after the required recheck on
the four-vCPU host. Zombie children increased from 114 to 121 beneath the same
parent PID 76143. All eight raw paths and six derived branches remained ready,
all byte counters advanced, frame errors remained zero, and the five direct
publishers retained the expected Speedify exit identity.

The final browser checkpoint simultaneously degraded while upstream FFmpeg
remained near 30 fps with zero reported drops. Courts 1 and 3 initially sampled
at 21 and 24 fps; Court 5 was reconnecting in `stabilizing`. After 52 seconds,
Court 1 reported a 34 fps catch-up sample, Court 3 remained at 27 fps, and Court
5 was still stabilizing. Compositor CPU ratios remained 0.25/0.42/0.27 with no
restart, OOM, or Egress alert, and YouTube remained active, live, bound, and
healthy apart from one informational Court 5 audio-bitrate warning.

This endpoint fails ingest-host production headroom and end-to-end viewer
quality qualification. It does not prove that host load caused the browser
pacing defect because raw and derived path integrity, FFmpeg progress, Egress,
and public outputs remained intact. The next capacity gate must test the revised
normalization topology under representative direct-camera load and preserve the
same synchronized evidence before production acceptance.
