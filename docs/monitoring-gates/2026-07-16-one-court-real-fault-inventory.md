# One-Court Real-Fault Acceptance Inventory

Date: 2026-07-16

This is the authoritative inventory for the runbook's one-court gate. A unit or
deterministic isolation fixture proves software behavior but does not close a
real dependency row. A functional pass does not become a latency pass unless
the measured first monitor issue is within the runbook maximum.

| Fault row | Current evidence | Classification | Required next action |
| --- | --- | --- | --- |
| Stop camera publishing | Camera 1 recurrence opened `REQUIRED_RAW_PATH_MISSING` 9.290s after the physical stop acknowledgement, delivered one opening Pushover, recovered from observed feed health, and isolated Cameras 2-8 | Functional and 20s detection pass | Accepted; do not repeat solely for evidence |
| Freeze full-bitrate camera content | Camera 4 browser-authoritative and host-local gates both isolated `FULL_BITRATE_VISUAL_FREEZE`, durably opened/resolved one episode, and delivered one open/recovery pair. First monitor issues were 27.319s and 27.110s | Functional pass; 20s latency fail | Repeat once on the deployed full-frame analyzer in an explicit phone-visible window |
| Cover camera or send uniform black | Camera 4 host-local gate isolated `CAMERA_CONTENT_BLACK`, excluded duplicate freeze paging, and durably delivered one open/recovery pair. First monitor issue was 33.230s | Functional pass; 25s latency fail | Repeat once on the deployed full-frame analyzer in the same explicit phone-visible window |
| Degrade venue uplink | Deterministic transport and bitrate fixtures only | Pending real dependency gate | Use one isolated camera/test publisher through the venue router and an approved bounded network impairment; preserve Speedify fail-closed evidence and peer flows |
| Stall preview normalizer | Deterministic path/FFmpeg fixtures only | Pending real process gate | Use an isolated test camera and stop only its disposable preview normalizer; do not change global MediaMTX configuration |
| Close program browser | Camera 1 proved same-page camera-loss recovery, but no controlled browser-only disappearance gate | Pending real browser gate | Use one isolated protected Program viewer and close only that viewer while raw/preview remain healthy |
| Disconnect commentator | Commentary telemetry and fixtures are deployed | Pending real commentary gate | Use an isolated commentary room with commentary explicitly expected, then disconnect the test publisher |
| Mute, clip, or silence commentator | Camera-audio silence passed at 64.091s; that is not commentary-audio evidence | Pending real commentary-audio gates | Exercise silence, mute/track loss, clipping, transport degradation, and sync loss on an isolated commentary room |
| Corrupt score or rendered score | Deterministic source/render mismatch and exact 67-67 fixtures pass | Pending real score gate | Use a disposable test event/match and a bounded test-only score/render fixture; never corrupt an active event |
| Stop test Egress job | One-court Egress capacity and ordered normal teardown passed; no expected-live forced stop was injected | Pending real Egress gate | Start one unlisted test Egress, stop only its exact ID while expected live, and preserve healthy program input evidence |
| Unbind or degrade test YouTube destination | Unlisted healthy lifecycle and ordered completion passed; provider fault not injected | Pending real provider gate | Use a fresh unlisted broadcast/stream and an API-controlled unbind or bounded degradation with upstream stages held healthy |
| Stop one host agent | Deterministic missing-agent and assigned-pair attribution fixtures pass | Pending real monitoring-agent gate | During isolated expectations, stop only one test/selected agent and prove `UNKNOWN`, shared-host attribution, paging dedupe, and recovery |
| Withhold monitor dead-man | Baseline and active Healthchecks withheld-ping delivery/recovery gates passed with Pushover attached | Functional provider-dead-man pass | Accepted; do not repeat solely for evidence |

## Execution boundaries

- Camera 1 physical loss/recovery and dead-man delivery are accepted and should
  not be repeated merely to increase sample count.
- The repeated-picture and black rows are the only functional gates awaiting a
  latency repeat after the analyzer cadence hard cutover. They require Nathan
  to be ready to observe Pushover before the first fault is injected.
- Every remaining row changes an isolated dependency and therefore requires a
  fresh healthy baseline, explicit test window, exact dependency identity, and
  a verified cleanup. No public output, active event, global MediaMTX setting,
  routing policy, or unrelated camera may be changed.
- The full eight-court gate remains separate. One-court evidence does not prove
  aggregate capacity, multi-browser pacing, venue bandwidth, or cross-court
  isolation under eight simultaneous outputs.
