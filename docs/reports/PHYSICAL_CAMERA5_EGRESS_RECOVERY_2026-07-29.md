# Camera 5 Exact-Owner Egress Recovery Gate

Date: 2026-07-29  
Scope: one physical Camera 5 H.264/SRT feed, one unlisted live YouTube broadcast, and one dedicated compositor. Cameras 1-4 and 6 remained live; Cameras 7-8 remained intentionally expected off under the router-capacity gate.

## Verdict

**Supervisor recovery passed. Viewer continuity failed.**

The exact owned Egress was deliberately removed without creating a normal stop intent. The host-local supervisor detected repeated absence, replaced the Egress worker container, replayed only the immutable owned request, and converged to exactly one replacement publisher. The YouTube broadcast was never completed and no duplicate publisher appeared.

The external YouTube viewer remained attached but was not playback-ready for 96 quarter-second samples and its playhead stalled for 24.001 seconds. This is not a production pass because continuous viewer playback is the primary requirement.

## Timeline

| Event | UTC |
| --- | --- |
| Continuous external viewer ready | 07:27:06.016 |
| Exact Egress stop requested | 07:27:59.648 |
| Active Egress set first empty | 07:28:00.928 |
| Third missing confirmation / worker recycle | 07:28:11-07:28:12 |
| Exactly one replacement Egress active | 07:28:20.353 |
| Supervisor returned `HEALTHY` | 07:28:24.947 |
| Viewer stall interval | 07:28:06.099-07:28:30.100 |
| YouTube provider next reported active/good | 07:29:20.629 |
| External post-recovery probe passed | 07:31:31.573 |

## Recovery Evidence

- Fault-to-replacement: 20.705 seconds.
- Empty-active-set-to-replacement: 19.425 seconds.
- Maximum simultaneous active Egresses: one.
- Old and new Egress IDs differed.
- Old and new container IDs differed.
- Request generation and request SHA-256 were preserved.
- Final worker: healthy, restart count zero.
- Final native contract: one active request out of one maximum; PulseAudio load valid.
- Replacement browser: 30 fps, zero dropped frames, zero freezes, zero reconnects, and zero reloads.
- YouTube returned to live/active/good with no configuration issues.
- Camera 5 raw ingest stayed ready with positive bitrate and zero media frame errors.
- Cameras 1-4 and 6 stayed healthy; no peer-camera state changed.

## Viewer Evidence

The persistent external viewer captured 889 samples over 221.922 seconds at a maximum 258 ms sample gap:

- maximum playhead stall: 24.001 seconds;
- not-playback-ready samples: 96;
- player-paused samples: zero;
- playhead regressions: zero;
- trace-capacity drops: zero;
- audio decoded before and after recovery;
- beginning and ending frames were distinct and nonblank; and
- a fresh eight-second post-recovery viewer probe passed with moving video and decoded audio.

The viewer advanced for 197.763 seconds over a 221.922-second trace, matching the observed output gap. YouTube buffering did not conceal the recovery interval.

## Monitoring Evidence

Monitoring correctly surfaced the real YouTube ingest interruption and resolved it after provider recovery. It also opened a 13-second score-render mismatch episode during the replacement renderer's cold start. That score episode was transient and unrelated to canonical score data. Its ten-second alert hold generated unnecessary opening and recovery notifications.

Two measured hard cuts follow from this gate:

1. New YouTube broadcasts use normal latency instead of low latency.
2. The rendered-score mismatch alert must persist for 30 seconds before paging, exceeding the measured cold-start transient while preserving detection of sustained mismatch.

## Protected Evidence

Evidence is stored outside Git under:

`~/.config/scorecheck/event-stack/events/reliability-physical-20260728/qualification-evidence/camera5-egress-recovery-20260729T072531Z`

The protected bundle includes sanitized one-second host samples, the immutable owner comparison, monitor transition samples, durable incident and notification rows, the continuous external viewer trace, screenshots, one-shot viewer probes, and the machine-readable gate summary. No stream key or renderer token is retained in the sanitized host evidence.

## Next Gate

Create a fresh unlisted normal-latency destination on the spare compositor and repeat this exact failure while leaving the accepted Camera 5 primary output untouched. Require:

- exactly one publisher before and after recovery;
- no overlap;
- immutable request generation and digest;
- bounded worker replacement;
- no external viewer stall longer than two seconds;
- continuous decoded audio;
- no unrelated score-render page; and
- all peer cameras isolated.
