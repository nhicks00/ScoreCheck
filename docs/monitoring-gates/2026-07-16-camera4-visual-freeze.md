# Camera 4 Full-Bitrate Visual Freeze Gate

Date: 2026-07-16
Result: Functional gate passed; 20-second detection SLA failed

## Scope and safety

- Camera 4 only, using the isolated synthetic 1280x720/30 H.264/AAC SRT
  publisher and one protected Program viewer.
- The gate profile was `PROGRAM_CONTENT`; Egress, YouTube, scoring, active
  event state, routing, MediaMTX configuration, and public outputs were not
  changed.
- Cameras 1-3 and 5-8 remained `EXPECTED_OFF` throughout the accepted run.
- The source, viewer, evidence recorder, and gate were removed after the run.
  Final monitoring state had no active incident or fault gate.

## Invalid preflight attempts

Two attempts ended before fault injection and do not count as gate evidence:

1. The initial headless viewer blocked audio autoplay. A delayed
   `CAMERA_AUDIO_SILENT` baseline incident caused the controller safety hold.
2. The retry armed `PROGRAM_CONTENT` before the Program viewer finished
   startup. A delayed `CAMERA_AUDIO_TRACK_MISSING` episode caused the same
   safety hold.

Both attempts were fully cleaned up with no peer impact. The accepted operator
sequence is now explicit in the controller and runbook: establish one
autoplay-capable Program viewer, verify clean video, visual, and camera-audio
telemetry, then arm `PROGRAM_CONTENT`, start the recorder, and inject the
fault.

## Accepted gate timeline

| Observation | UTC time | From fault injection |
| --- | --- | ---: |
| Healthy synthetic baseline | `2026-07-16T02:32:44.435Z` | n/a |
| `PROGRAM_CONTENT` armed | `2026-07-16T02:33:33.245Z` | n/a |
| Evidence baseline captured | `2026-07-16T02:34:14.364Z` | n/a |
| Full-bitrate freeze injected | `2026-07-16T02:34:21.105Z` | `0.000s` |
| Monitor first reported the expected issue | `2026-07-16T02:34:48.424Z` | `27.319s` |
| Durable incident opened | `2026-07-16T02:34:55.709Z` | `34.604s` |
| Pushover open submitted and accepted | `2026-07-16T02:34:58.640Z` | `37.535s` |
| Recovery requested | `2026-07-16T02:35:16.516Z` | n/a |
| Durable dependency recovery | `2026-07-16T02:35:58.487Z` | n/a |
| Monitor observed healthy recovery | `2026-07-16T02:35:59.422Z` | n/a |
| Recorder completed | `2026-07-16T02:38:14.999Z` | n/a |

At first detection, the repeated-picture detector reported
`frozenDurationMs=17999` with zero black duration. Browser transport remained
connected at 30 fps with zero RTP loss, dropped frames, browser freezes,
reconnects, or reloads. This correctly isolated content freeze from transport
failure.

## Durable and isolation evidence

- The issue code was exactly `FULL_BITRATE_VISUAL_FREEZE` on Camera 4.
- One durable incident episode was created and resolved by
  `DEPENDENCY_RECOVERED`.
- Durable deltas were one incident, three events, and two notification rows:
  one Pushover open and one recovery. No duplicate or unexpected episode was
  recorded.
- The 240-second recorder captured 240 samples with zero request errors, stale
  snapshots, collector failures, dead-man failures, notification failures,
  unexpected incidents, or unexpected peer states.
- One browser identity remained active. Raw, preview, and program returned
  healthy with positive bitrate and zero frame errors after recovery.

Protected local evidence:

- `~/.config/scorecheck/fault-evidence/camera4-freeze-gate-20260716T0232Z.jsonl`
- `~/.config/scorecheck/fault-evidence/camera4-freeze-gate-capture-20260716T0234Z.jsonl`
- `~/.config/scorecheck/fault-evidence/camera4-freeze-20260716T0220Z.invalid.json`
- `~/.config/scorecheck/fault-evidence/camera4-freeze-retry-20260716T0228Z.invalid.json`

## Classification and next decision

The correlation, isolation, durability, notification deduplication, and
recovery behavior pass. The one-court runbook's 20-second maximum detection
does not pass: the monitor first classified the freeze at 27.319 seconds and
the Pushover open was accepted at 37.535 seconds.

The result must not be converted into a pass by lowering the repeated-picture
threshold after the test. The current program path includes normal media delay,
then the deliberate visual-persistence window, then heartbeat and evaluation
cadence. The recommended correction is a low-latency per-court content analyzer
on the final compositor topology, retaining conservative persistence and peer
isolation. Alternatively, the operator may explicitly accept an approximately
35-40 second phone-opening objective. That tradeoff must be decided before the
remaining black-picture and camera-silence gates are run.
