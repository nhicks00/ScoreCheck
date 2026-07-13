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
