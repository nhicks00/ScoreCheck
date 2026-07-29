# Physical Speedify Enhanced Streaming Comparison - 2026-07-29

## Decision

Retain **plain Speed mode with Multi-TCP** as the checked-in router profile.
Enhanced Streaming did not interrupt viewer delivery, but it did not improve
the measured transport and increased SRT loss/drop rates on Cameras 2-6 in the
matched six-camera comparison.

This is a physical-camera result, not a synthetic media test. Cameras 1-6 were
publishing through the event router. Cameras 7-8 remained intentionally
isolated by the existing capacity-test rules and were not part of this gate.

## Fixed Conditions

- six camera flows throughout both windows;
- four discovered Speedify inputs, all kept `automatic`;
- Multi-TCP transport throughout;
- the same camera sources and ingest destination;
- Camera 5's existing unlisted YouTube output remained live;
- no camera setting, camera credential, Egress, or YouTube lifecycle change;
- two primary policy rules, two guard rules, and the firewall kill switch
  remained active.

The indoor router topology included wired and Wi-Fi inputs backed by the same
AT&T connection plus a separate T-Mobile input. The two AT&T interfaces add
capacity but are not independent failover paths.

## Matched Windows

| Profile | Start | End | Samples |
| --- | --- | --- | ---: |
| Plain Speed / Multi-TCP | `2026-07-29T06:20:07.680Z` | `2026-07-29T06:35:07.680Z` | 61 |
| Enhanced Streaming / Multi-TCP | `2026-07-29T06:42:22.680Z` | `2026-07-29T06:57:22.678Z` | 61 |

Both windows were approximately 15 minutes with a maximum monitor sample gap
of about 15 seconds. Neither window contained an active incident.

## Transport Result

Rates below are packet-counter growth per minute at MediaMTX.

| Camera | Plain lost/min | Enhanced lost/min | Plain dropped/min | Enhanced dropped/min |
| ---: | ---: | ---: | ---: | ---: |
| 1 | 0.1 | 0.0 | 0.1 | 0.0 |
| 2 | 6.1 | 8.0 | 1.9 | 2.7 |
| 3 | 58.6 | 64.7 | 21.3 | 21.4 |
| 4 | 19.8 | 20.5 | 6.1 | 7.1 |
| 5 | 56.3 | 74.7 | 24.1 | 43.5 |
| 6 | 27.8 | 39.8 | 8.5 | 15.7 |

Enhanced Streaming was worse on Cameras 2-6 and materially worse on Cameras 5
and 6. This does not prove how it will behave during a future WAN failure, but
it provides no basis to replace the lower-loss stable-condition default.

## Router Result

| Metric | Plain Speed | Enhanced Streaming |
| --- | ---: | ---: |
| Maximum CPU ratio | 0.7788 | 0.7764 |
| Minimum available memory | 114,556,928 bytes | 111,386,624 bytes |
| Maximum read queue | 119 packets | 133 packets |
| Average send rate | 15.63 Mbps | 15.59 Mbps |
| Minimum estimated upload | 51.30 Mbps | 44.45 Mbps |

CPU consumption was effectively unchanged. Enhanced Streaming did not create
capacity headroom and had a somewhat larger maximum queue.

## Viewer And Provider Result

Camera 5 rendered 27,002 frames in each matched window. The Enhanced Streaming
window produced an aggregate 30.002 fps and zero growth in browser drops,
freezes, freeze duration, reconnects, or reloads. Actual external YouTube
viewer probes passed at the start, midpoint, endpoint, and after rollback, with
advancing playhead and audio.

The YouTube provider check returned `provider-unavailable` once at
`2026-07-29T06:56:19.645Z`. The external viewer continued playing during that
interval, and the next provider observation returned live/active/good with no
issues. This is classified as a transient provider/API-read failure, not a
viewer delivery outage.

## Cutover And Rollback

Commit `a1e3fd062` temporarily changed the checked-in profile to Enhanced
Streaming so the live setting and repository contract matched during the gate.
Commit `af8a4aeb9` restored the measured plain-Speed default and recorded the
decision.

The router was restored at `2026-07-29T06:59:18.220Z`. During the first 28
seconds after rollback it remained connected with six camera flows, four
Automatic inputs, two primary rules, and two guard rules. Camera 5 remained
healthy at 30 fps, and the post-rollback external viewer probe passed.

## Evidence

Protected evidence is under:

`~/.config/scorecheck/event-stack/events/reliability-physical-20260728/qualification-evidence/camera5-youtube-gate-20260729T055428Z/run/network-comparison/`

The key artifacts are:

- `speed-mode-baseline.json`;
- `enhanced-streaming-cutover-20260729T064115Z/enhanced-streaming-summary.json`;
- `enhanced-streaming-cutover-20260729T064115Z/comparison.json`;
- router transition and rollback samples; and
- four external viewer-probe results.

## Remaining Scope

This comparison does not qualify eight simultaneous cameras or a live WAN
failure. Cameras 7-8 must be reintroduced through a separate capacity gate, and
any future Enhanced Streaming failover experiment must retain Automatic input
priorities and use viewer continuity as the primary result.
