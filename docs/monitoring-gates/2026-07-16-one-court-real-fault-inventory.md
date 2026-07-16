# One-Court Real-Fault Acceptance Inventory

Date: 2026-07-16

This is the authoritative inventory for the runbook's one-court gate. A unit or
deterministic isolation fixture proves software behavior but does not close a
real dependency row. A functional pass does not become a latency pass unless
the measured first monitor issue is within the runbook maximum.

| Fault row | Current evidence | Classification | Required next action |
| --- | --- | --- | --- |
| Stop camera publishing | Camera 1 recurrence opened `REQUIRED_RAW_PATH_MISSING` 9.290s after the physical stop acknowledgement, delivered one opening Pushover, recovered from observed feed health, and isolated Cameras 2-8 | Functional and 20s detection pass | Accepted; do not repeat solely for evidence |
| Freeze full-bitrate camera content | Camera 4 browser-authoritative and host-local gates isolated `FULL_BITRATE_VISUAL_FREEZE`. The deployed full-frame phone-visible repeat passed functional/durable/dedupe/recovery/isolation checks but first monitor issue was 26.891s and Pushover submission was 29.560s | Functional pass; 20s monitor latency fail | Reduce collection/evaluation latency and repeat, or explicitly revise the operator SLA without weakening the 15s persistence threshold |
| Cover camera or send uniform black | Camera 4 host-local gate isolated `CAMERA_CONTENT_BLACK` and excluded duplicate freeze paging. The deployed full-frame phone-visible repeat passed functional/durable/dedupe/recovery/isolation checks but first monitor issue was 29.484s and Pushover submission was 28.895s | Functional pass; 25s monitor latency fail | Reduce collection/evaluation latency and repeat, or explicitly revise the operator SLA without weakening the 20s persistence threshold |
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
- The repeated-picture and black phone-visible latency repeats are complete.
  Both confirm functional paging and isolation, but neither meets its timing
  target. Further work is an engineering/SLA decision, not another operator
  availability requirement.
- Every remaining row changes an isolated dependency and therefore requires a
  fresh healthy baseline, explicit test window, exact dependency identity, and
  a verified cleanup. No public output, active event, global MediaMTX setting,
  routing policy, or unrelated camera may be changed.
- The full eight-court gate remains separate. One-court evidence does not prove
  aggregate capacity, multi-browser pacing, venue bandwidth, or cross-court
  isolation under eight simultaneous outputs.
