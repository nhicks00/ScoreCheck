# Program-Browser Frame-Pacing Finding

Date: 2026-07-13
Status: defect confirmed by soak evidence; monitoring correction validated locally and held from deployment during the active soak

## Finding

The deployment-triggered page reload at `2026-07-13T13:42:28Z` through
`13:42:41Z` reset the active browser sessions, but it did not cause the ongoing
frame-pacing defect. With no later page reload, the new Court 1, 3, and 5
sessions continued accumulating Chrome `framesDropped`, freeze count, and freeze
duration while rendered FPS remained 30-31.

At approximately `13:59Z`, the browser evidence was:

| Court | Received | Decoded | Dropped | Freezes | Freeze duration | Jitter buffer |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 30,254 | 29,780 | 460 | 47 | 18.067 s | 493.3 ms |
| 3 | 30,251 | 30,148 | 81 | 10 | 13.492 s | 714.4 ms |
| 5 | 30,552 | 30,353 | 193 | 22 | 14.367 s | 205.0 ms |

At approximately `14:14Z`, with no intervening reload, the evidence was:

| Court | Received | Decoded | Dropped | Freezes | Freeze duration | Jitter buffer |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 55,454 | 54,318 | 1,114 | 97 | 42.454 s | 759.6 ms |
| 3 | 55,451 | 55,282 | 155 | 14 | 23.875 s | 479.4 ms |
| 5 | 55,753 | 55,521 | 222 | 27 | 22.231 s | 338.0 ms |

During that interval, Court 1 added 654 dropped frames and 51 freezes, Court 3
added 74 and 5, and Court 5 added 29 and 6. RTP packet loss remained zero, RTT
remained 1-2 ms, FFmpeg remained fresh, program paths stayed ready, Egress
resources stayed healthy, and YouTube reported good health.

## Isolated Court 5 reload

Court 5 loaded a new program page at `2026-07-13T15:13:23.286Z` without a
coordinated deployment or runtime change. Its prior page load was
`13:42:28Z`; Courts 1 and 3 retained their existing page sessions. Court 5's
browser counters reset to zero, `reconnectCount` reported 3, and the new page
stabilized at 30 fps, 154-189 ms jitter-buffer delay, and zero RTP loss.
YouTube remained live, active, and good. Informational `bitrateHigh` and
`audioBitrateLow` issues appeared briefly and cleared on the 30-second recheck.

At approximately the same checkpoint, zombie children beneath the MediaMTX
process increased from 104 to 108 and then held stable: 76 `ffmpeg`, 31
`scorecheck-ffmp`, and one `mv`. Raw paths remained 8/8 ready, derived branches
remained 6/6 ready, all five active publishers retained the expected Speedify
exit identity, frame errors remained zero, and upstream program FFmpeg stayed
near 30 fps. The timing is a correlation to investigate, not evidence that the
zombie increase caused the isolated page reload.

## 15:30Z continuation

From `15:15:20Z` through the `15:30Z` checkpoint, approximately 15 minutes 15
seconds, Court 1 added 1,792 dropped frames, 91 freezes, and 55.877 seconds of
cumulative freeze duration.
It still reported 29 browser fps, 856.3 ms jitter-buffer delay, and zero RTP
loss while its upstream program FFmpeg remained at 30.01 fps. Court 3 added 59
drops, two freezes, and 5.541 seconds of freeze duration and ended at 30 fps,
256 ms jitter-buffer delay, and zero loss. Court 5 remained stable after its
isolated reload at 30 fps, 162 ms jitter-buffer delay, and zero loss with its
new-page counters reset.

Routing remained fail-closed and healthy; all eight raw paths and six derived
branches were ready; all five active publishers retained one expected
Speedify-exit identity; media frame errors remained zero; all three active
Egress jobs remained free of restarts and OOM events; and YouTube Courts 1, 3,
and 5 remained live, active, bound, and healthy. MediaMTX zombie children held
at 108. This checkpoint confirms continuing Court 1 browser-side quality loss
without a contemporaneous upstream, routing, Egress, YouTube, or additional
zombie-growth event.

From `15:30:35Z` through the `15:44Z` checkpoint, Court 1 added another 1,620
dropped frames, 97 freezes, and 51.944 seconds of freeze duration. It reported
29 browser fps, 1,598.1 ms jitter-buffer delay, and zero RTP loss while its
upstream FFmpeg remained at 30.01 fps. Court 3's counters were essentially flat
with no new drops and two freezes; Court 5 added no drops or freezes after its
reload. MediaMTX load1 was elevated at 7.11 with 7.31 GB available memory, but
all eight raw paths and six derived branches retained positive bitrate and zero
frame errors. Zombie children held at 108, Speedify fail-closed routing and its
watchdog remained intact, all monitoring targets, agents, and Egress workers
were healthy, and YouTube Courts 1, 3, and 5 remained live, active, bound, and
healthy. This is continued evidence of the known downstream defect, not a new
failure class.

At `15:59:25Z`, Court 1 acutely fell to 11 browser fps with 1,130.8 ms
jitter-buffer delay and remained degraded at 21 fps after the required
approximately 30-second recheck. Since `15:44:25Z`, it had added 2,370 dropped
frames, 135 freezes, and 75.269 seconds of freeze duration while RTP loss
remained zero and upstream program FFmpeg remained at 30.01 fps. Courts 3 and 5
remained stable at 30 fps. MediaMTX load1 rose to 8.29 and then 8.09 on the
four-vCPU host, while 7.31 GB memory remained available and zombie children
held at 108. All eight raw paths and six derived branches remained ready with
positive bitrate and zero frame errors; Speedify fail-closed routing remained
healthy; Egress workers had no restart or OOM event; and YouTube Courts 1, 3,
and 5 remained live, active, bound, and healthy. The elevated host load remains
correlated evidence, not an established cause of the Court 1-only acute event.

At the `16:14Z` checkpoint, Court 1 had recovered to 30 browser fps but had
still added 2,136 dropped frames, 103 freezes, and 63.627 seconds of freeze
duration since `16:00:10Z`. Jitter-buffer delay was 603.3 ms, RTP loss remained
zero, and upstream program FFmpeg remained at 30.01 fps. Courts 3 and 5 were
essentially stable. MediaMTX load1 eased to 6.28 and zombie children remained
at 108. All eight raw paths and six derived branches remained ready with
positive bitrate and zero frame errors, all five active publishers retained
the expected Speedify exit, monitoring targets, agents, and Egress workers were
healthy, and YouTube Courts 1, 3, and 5 remained live, active, bound, and
healthy. The router had exactly one watchdog process; an earlier broad `pgrep`
count had included its own command and was not evidence of a duplicate
watchdog. The 30 fps sample is a momentary recovery within the continuing
pacing defect, not proof that the defect resolved.

From `16:14:35Z` through the `16:29Z` checkpoint, Court 1 remained at 30
browser fps at the sample but added 653 dropped frames, 45 freezes, and 23.095
seconds of freeze duration. Jitter-buffer delay was 595 ms, RTP loss remained
zero, and upstream program FFmpeg remained at 30.01 fps. Courts 3 and 5 stayed
stable. All eight raw paths and six derived branches remained ready with
positive bitrate and zero frame errors; all five active publishers retained
the expected Speedify exit; fail-closed routing, the watchdog, and kill switch
were intact; router memory and RSS were stable; all three Egress workers were
healthy without restart or OOM events; MediaMTX zombie children held at 108;
and YouTube Courts 1, 3, and 5 remained live, active, bound, and healthy. The
accumulation rate decreased during this interval, but the nonzero drop and
freeze growth shows the pacing defect remained active.

From `16:29:25Z` through the `16:44Z` checkpoint, Court 1 added 965 dropped
frames, 64 freezes, and 33.209 seconds of freeze duration while the sampled
browser FPS remained 30. Jitter-buffer delay was 470 ms, RTP loss remained
zero, and upstream program FFmpeg remained at 30.01 fps. Courts 3 and 5 stayed
stable. Raw and derived paths, bitrates, frame integrity, publisher
Speedify-exit identity, fail-closed routing, the exact-one watchdog, Egress,
monitoring targets and agents, and YouTube remained healthy. MediaMTX load1 was
6.36 and zombie children held at 108. This is another interval where
instantaneous 30 fps masked material cumulative quality loss.

## Multi-court in-page WHEP reconnect

At the `17:14Z` checkpoint, Courts 3 and 5 independently reset their WebRTC
receive, decode, drop, and freeze counters without reloading their program
pages. Court 3 retained its `13:42:41Z` page-load identity while
`reconnectCount` increased from 1 to 3. Court 5 retained its `15:13:23Z`
page-load identity while `reconnectCount` increased from 3 to 4. The unchanged
page identities distinguish these events from browser-page reloads and confirm
in-page WHEP reconnections with new peer-connection counter baselines.

Both courts reported 30 browser fps, zero RTP loss, and 30.01-30.02 fps
upstream program FFmpeg at recheck. During approximately 50 seconds after the
reset, Court 3 freeze count increased from 20 to 30 with 2.852 seconds of added
freeze duration, and Court 5 increased from 20 to 28 with 1.899 seconds added;
drop counts held at 89 and 13. Court 1 remained connected and added 664 drops,
41 freezes, and 26.054 seconds of freeze duration since `16:59:40Z`.
MediaMTX load1 recovered from 13.47 to 6.75 and then 5.43, zombie children held
at 108, and paths, routing, Egress, and YouTube remained healthy.

This event demonstrates that deployed page-session cumulative gauges are not
reset-safe. A correct accumulator must establish a new baseline when any
peer-connection counter decreases, even when `pageLoadedAt` remains unchanged;
the reconnect-count increase provides corroborating context. It must not
convert the reset into a negative rate or fabricate a recovery.

During the interval after those reconnects, Court 3 became the dominant
degraded consumer. From `17:14:41Z` through the `17:29Z` checkpoint, it added
412 dropped frames, 183 freezes, and 80.803 seconds of freeze duration while
jitter-buffer delay reached 1,668 ms. During the required approximately
50-second recheck, it still added 194 drops, 11 freezes, and 13.176 seconds of
freeze duration even though sampled browser FPS remained 30; jitter-buffer
delay fell to 448.2 ms. Court 1 added 837 drops, 50 freezes, and 27.313 seconds
over the main interval but was nearly flat during recheck. Court 5 added 41
freezes and 9.638 seconds, then remained flat. All three courts retained zero
RTP loss and 30.01-30.02 fps upstream program FFmpeg. MediaMTX load1 remained
elevated near 8.6 but below the earlier 13.8 spike, zombie children held at
108, and paths, routing, Egress, and YouTube remained healthy. This demonstrates
that an in-page WHEP reconnect can reset telemetry without resolving the pacing
defect; Court 3's acute impact persisted across the recheck.

From `17:29:46Z` through the `17:45Z` checkpoint, Court 3 added another 88
dropped frames, 185 freezes, and 63.569 seconds of freeze duration. It briefly
reported 39 browser fps before normalizing to 30 fps, consistent with catch-up
or sampling behavior rather than improved output quality. During the
approximately 65-second recheck it still added 12 freezes and 3.424 seconds of
freeze duration. Court 1 added 476 drops, 39 freezes, and 18.098 seconds;
Court 5 remained flat. All three retained zero RTP loss and 30.01-30.02 fps
upstream program FFmpeg. MediaMTX load1 normalized near 6.7, zombie children
held at 108, and paths, routing, Egress, and YouTube remained healthy. This is
continued post-reconnect pacing degradation, not a new failure class; the
transient above-source FPS sample further demonstrates that instantaneous FPS
cannot substitute for reset-safe drop and freeze rates.

From `17:45:16Z` through the `17:59Z` checkpoint, Court 3 remained the dominant
post-reconnect freeze stream, adding 39 dropped frames, 167 freezes, and 56.622
seconds of freeze duration despite sampled 30 browser fps, 249 ms jitter-buffer
delay, zero RTP loss, and 30.01 fps upstream program FFmpeg. Court 1 added 305
drops, 45 freezes, and 17.678 seconds; Court 5 remained flat. MediaMTX load1
normalized to 5.17, zombie children held at 108, and paths, routing, Egress,
and YouTube remained healthy. Persistent freeze growth alongside normalized
host load and lower instantaneous jitter further weakens a simple
instantaneous-load or instantaneous-jitter explanation.

From `17:59:00Z` through the `18:15Z` checkpoint, Courts 1 and 3 again showed
divergent pacing samples. Court 1 added 525 dropped frames, 49 freezes, and
23.020 seconds of freeze duration, sampled 19 browser fps, and then recovered
to 31 fps on recheck. Court 3 added 93 drops, 192 freezes, and 74.272 seconds,
sampled 38 fps, and then remained degraded at 26 fps on recheck while adding
eight freezes and another 3.528 seconds of freeze duration. Both retained zero
RTP loss and 30.01 fps upstream program FFmpeg. Court 5 remained flat.
MediaMTX load1 remained normalized near 5.8, zombie children held at 108, and
paths, routing, Egress, and YouTube remained healthy. The opposing under-run
and catch-up FPS samples, combined with continued rate growth, reinforce that
instantaneous FPS is not a reliable quality verdict for this WHEP pacing
defect.

From `18:14:51Z` through the `18:29Z` checkpoint, Court 3 added 40 dropped
frames, 171 freezes, and 59.283 seconds of freeze duration while sampled at 30
browser fps, 223 ms jitter-buffer delay, zero RTP loss, and 30.01 fps upstream
program FFmpeg. Court 1 added 153 drops, 34 freezes, and 13.365 seconds while
sampled at 30 fps with 1,017.3 ms jitter-buffer delay. Court 5 remained flat.
MediaMTX load1 remained near 6.0, zombie children held at 108, and paths,
routing, Egress, and YouTube remained healthy. This is continued Court 3
post-reconnect freeze accumulation within the same defect.

From `18:28:56Z` through the `18:44Z` checkpoint, Court 3 added 203 dropped
frames, 185 freezes, and 84.402 seconds of freeze duration while sampled at 30
browser fps, 238 ms jitter-buffer delay, zero RTP loss, and 30.01 fps upstream
program FFmpeg. Court 1 also added 766 drops, 65 freezes, and 30.258 seconds;
Court 5 remained flat. MediaMTX load1 was near 7.2, zombie children held at
108, and paths, routing, Egress, and YouTube remained healthy. This remains
severe multi-court pacing loss within the known defect, not a new upstream
failure class.

From `18:43:56Z` through the `18:59Z` checkpoint, Court 3 added another 169
dropped frames, 192 freezes, and 88.272 seconds of freeze duration despite
sampled 30 browser fps, 336.8 ms jitter-buffer delay, zero RTP loss, and 30.01
fps upstream program FFmpeg. Court 1 added 215 drops, 36 freezes, and 13.927
seconds; Court 5 remained flat. MediaMTX load1 was near 5.8, zombie children
held at 108, and paths, routing, Egress, and YouTube remained healthy. A direct
watchdog process listing again confirmed exactly one process; prior count
inflation came from `pgrep`/`wc` observing the diagnostic command itself, not
runtime duplication. Court 3's severe post-reconnect pacing defect remained
active.

From `18:59:11Z` through the `19:14Z` checkpoint, Court 3 added 292 dropped
frames, 184 freezes, and 89.579 seconds of freeze duration despite sampled 30
browser fps, 280.1 ms jitter-buffer delay, zero RTP loss, and 30.01 fps
upstream program FFmpeg. Court 1 added 796 drops, 88 freezes, and 38.425
seconds while sampled at 30 fps with 639 ms jitter-buffer delay. Court 5
remained flat. MediaMTX load1 was 5.94, zombie children held at 108, and paths,
routing, the exact-one watchdog, Egress, and YouTube remained healthy. This is
another sustained multi-court quality-loss interval masked by normal
instantaneous FPS.

From `19:14:00Z` through `19:30:25Z`, Court 1 added 454 dropped frames, 45
freezes, and 20.217 seconds of freeze duration, while Court 3 added 210 drops,
157 freezes, and 52.661 seconds. Both sampled at 30 browser fps with zero RTP
loss and 30.01 fps upstream program FFmpeg; Court 5 remained flat. MediaMTX
load1 was 4.79, zombie children held at 108, and paths, Egress, and YouTube
remained healthy. This is continued Court 1/3 pacing loss within the known
defect.

Between `19:47Z` and `19:49Z`, Courts 3 and 5 experienced another in-page WHEP
reconnect and counter-reset episode with unchanged page-load identities. Court
3's `reconnectCount` increased from 3 to 6 and its receive, decode, drop, and
freeze counters reset to zero. Court 5 increased from 4 to 5; after its reset,
freeze count grew from 84 to 107 with 6.261 seconds of added freeze duration in
115 seconds. The Court 3 jump indicates multiple reconnects may have occurred
between observation samples; it should not be collapsed into one reconnect.

Over the broader interval since `19:30Z`, Court 1 dropped-frame count increased
from 19,197 to 21,932, freeze count from 1,337 to 1,497, and freeze duration by
89.345 seconds. On recheck it reported 27 browser fps and 1,049.1 ms
jitter-buffer delay with zero RTP loss, while program FFmpeg remained at 30.00
fps with zero drops. All eight raw paths and six derived branches remained
ready with positive bitrate and zero frame errors; all six agents were fresh;
all three Egress outputs were active without restart, OOM, or alert; and
YouTube Courts 1, 3, and 5 remained live, active, bound, and healthy. This is a
new reconnect/reset episode within the same multi-court pacing defect.

Between `20:14Z` and `20:15Z`, Court 1 experienced its own in-page WHEP
reconnect and counter reset with unchanged `pageLoadedAt`. Its
`reconnectCount` increased from 0 to 3. Compared with the `19:59Z` values of
23,118 dropped frames, 1,559 freezes, and 810.454 seconds of freeze duration,
the new peer baseline reported 354 drops, 27 freezes, and 13.901 seconds. Over
the next 55 seconds those values grew to 384, 29, and 14.710 seconds. Together
with the prior Court 3 and Court 5 episodes, all three active program courts
have now demonstrated in-page reconnects and peer-counter resets without a page
reload.

Court 5 sampled at 22 browser fps while freeze count grew from 220 to 390 and
freeze duration from 63.182 to 116.662 seconds since `19:59Z`. The recheck
returned to sampled 30 fps but still added ten freezes and 3.021 seconds over
55 seconds. Court 3's new baseline added one 850 ms freeze. All three retained
zero RTP loss while upstream program FFmpeg remained near 30 fps with zero
drops. Raw and derived paths remained ready and advanced bytes with zero frame
errors; publisher identity, agents, Egress, YouTube, and fail-closed routing
remained healthy. This is a Court 1 reconnect/reset event plus continued Court
5 pacing degradation within the same viewer-path defect.

Between `20:28Z` and `20:30Z`, severe Court 1 and Court 5 pacing loss continued
after the prior reconnect resets. Since `20:15Z`, Court 1 dropped frames grew
from 384 to 1,181, freezes from 29 to 83, and freeze duration from 14.710 to
41.278 seconds. After a 32-second recheck those values reached 1,324, 91, and
44.883 seconds while sampled browser FPS was 27 and jitter-buffer delay was
1,390.9 ms. Court 5 freeze count grew from 400 to 561 and freeze duration from
119.683 to 166.017 seconds while sampled at 21 fps. Its recheck sampled 30 fps
but still added nine freezes and 2.553 seconds. Court 3 remained stable on its
post-reset baseline.

All browser RTP loss remained zero and program FFmpeg remained approximately
30.01-30.13 fps with zero drops. Raw and derived paths remained ready, byte
counters advanced, frame errors remained zero, publisher identity and
fail-closed routing were correct, agents and Egress were healthy, and YouTube
Courts 1, 3, and 5 remained live, active, bound, and healthy. This is continued
visible-risk Court 1 and Court 5 degradation within the same viewer-path
defect.

Between `20:43Z` and `20:44Z`, no new reconnect, counter reset, or routing event
occurred, but severe viewer-path accumulation continued. Since the `20:29Z`
recheck, Court 1 added 1,625 dropped frames, 101 freezes, and 51.308 seconds of
freeze duration, reaching 2,949 drops, 192 freezes, and 96.191 seconds. It
sampled at 30 browser fps with 667 ms jitter-buffer delay and zero RTP loss;
program FFmpeg remained at 30.06 fps with zero drops. Court 5 added 159 freezes
and 45.562 seconds, reaching 729 freezes and 214.132 seconds while sampled at
30 fps with zero loss; program FFmpeg remained at 30.01 fps with zero drops.
Court 3 remained stable on its post-reset baseline.

All media paths remained ready and advanced bytes with zero frame errors,
publisher identity and fail-closed routing were correct, agents and Egress were
healthy, and YouTube Courts 1, 3, and 5 remained live, active, bound, and
healthy. This is continued severe pacing accumulation masked by normal sampled
FPS, not a new incident.

From `19:49:35Z` through `19:59:20Z`, Court 1 added 1,186 dropped frames, 62
freezes, and 34.278 seconds of freeze duration while sampled at 30 browser fps
with 726 ms jitter-buffer delay and zero RTP loss. Its program FFmpeg remained
at 30.01 fps with zero drops. After its reconnect, Court 5 added 113 freezes and
30.936 seconds with zero transport loss. Court 3 remained on its post-reset
zero baseline with `reconnectCount` 6, demonstrating again that deployed
cumulative gauges cannot be compared authoritatively across resets. All raw
and derived media paths remained ready and advanced bytes with zero frame
errors. Court 1 briefly reported YouTube health `good` with one issue, which
cleared to `good` with zero issues on recheck; Courts 1, 3, and 5 remained live,
active, and bound. This is continued viewer-path degradation independent of
the recurring router-watchdog supervision anomaly.

The received-minus-decoded gaps closely match Chrome's dropped-frame counters.
That, together with zero RTP loss and high, uneven jitter-buffer delay, points
more strongly to program-path timestamp/jitter behavior plus WHEP decoder
scheduling than to venue packet loss. MediaMTX and host load remain relevant
correlated evidence, but the soak does not establish saturation as the cause.

## Monitoring gap

The heartbeat contract already carried received, decoded, dropped, freeze, and
jitter evidence, but Prometheus exposed only current-page cumulative drop and
freeze gauges. The correlator considered a connected 30 fps browser healthy, so
the dashboard did not surface the sustained quality loss.

## Local correction

The monitor now prepares these additional metrics:

- current-page gauges for received frames, decoded frames, dropped frames, and
  total freeze duration;
- reset-safe counters for received, decoded, dropped, freeze count, and freeze
  duration;
- two-minute recording rules for decode-drop ratio and frozen-time ratio;
- live-only warning bands above 0.5 percent decode loss or 1 percent frozen
  time;
- live-only critical bands above 5 percent decode loss or 10 percent frozen
  time.

The accumulator keys baselines by court and page-load identity. A new page, a
decreased peer-connection counter, or a monitor restart establishes a new
baseline instead of fabricating a spike. Repeated heartbeat polls add nothing.
Rules require at least twelve scrapes and meaningful received-frame volume.
Warnings degrade the court in the dashboard without sending a phone page;
critical quality loss follows the existing Pushover path. Each court card also
shows its current page-session drop ratio and freeze count.

The production Prometheus 3.13.1 `promtool` image validates all 43 rules and all
executable fixtures locally. TypeScript and monitoring unit tests also pass.
Nothing in this correction has been deployed during the active soak.

## Isolation gate

After the soak and deployment freeze:

1. Deploy the monitoring-only correction in a coordinated window.
2. Confirm reset-safe counters remain monotonic across ordinary polls and
   establish a clean baseline across one deliberate program-page restart.
3. Feed the same preview source to an isolated direct-preview WHEP consumer and
   the delayed program WHEP consumer.
4. Compare received, decoded, dropped, freeze, jitter-buffer, host-load, and
   timestamp evidence over at least thirty minutes.
5. Change only one test-path variable at a time, beginning with the delayed SRT
   remux/timestamp path. Do not alter public outputs.
6. Accept a media-path correction only if the program consumer's drop/freeze
   rates materially converge with the direct-preview control without breaking
   commentary synchronization or output continuity.

Until that comparator gate is complete, timestamp/jitter plus browser scheduling
is the leading hypothesis, not a proven root cause.

## Final endpoint: 21:01Z-21:02Z

The user-directed final checkpoint captured a synchronized viewer-path failure
instead of a clean tail sample. Courts 1 and 3 initially reported 21 and 24 fps,
and Court 5 was reconnecting in `stabilizing`. All three retained zero RTP loss
while upstream program FFmpeg remained near 30 fps with zero drops.

The initial page-session counters were:

| Camera | Browser state | Drops | Freezes | Freeze duration | Jitter buffer |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1 | 21 fps | 7,820 | 395 | 225.427 s | 1,319.7 ms |
| 3 | 24 fps | 2,907 | 114 | 65.733 s | 1,744.7 ms |
| 5 | stabilizing | 5,732 | 940 | 341.059 s | not stable |

After 52 seconds, Court 1 reported a 34 fps catch-up sample with 8,544 drops,
420 freezes, 239.996 seconds frozen, and 1,299 ms jitter-buffer delay. Court 3
remained degraded at 27 fps with 3,857 drops, 137 freezes, 82.053 seconds
frozen, and 1,873 ms jitter-buffer delay. Court 5 remained stabilizing with
7,486 drops, 959 freezes, 374.426 seconds frozen, and 1,642 ms jitter-buffer
delay.

Since the 20:43Z checkpoint, Court 1 added 5,595 drops, 228 freezes, and 143.805
seconds of freeze duration; Court 3 added 3,857 drops, 136 freezes, and 81.203
seconds; Court 5 added 7,473 drops, 230 freezes, and 160.294 seconds. All raw
paths, derived branches, Egress jobs, routing, and YouTube outputs remained
available. This is final confirmation that normal point-in-time FPS and healthy
transport/output controls cannot substitute for reset-safe decode-drop and
freeze-rate evidence.

The extended soak therefore fails viewer-quality acceptance. The local detector
and one-reader A/B/A comparator remain the required next diagnostic gate; no
media-path correction is accepted until a test-only comparator run isolates the
program path from the direct preview control.
