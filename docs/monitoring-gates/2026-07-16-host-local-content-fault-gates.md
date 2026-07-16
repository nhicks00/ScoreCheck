# Host-Local Camera Content Fault Gates

Date: 2026-07-16
Result: functional gates passed; freeze and black monitor-latency SLAs failed;
silence monitor-latency SLA passed

## Scope

The gates used Camera 4 only, an isolated synthetic raw publisher, and the
camera's assigned host-local analyzer. Cameras 1-3 and 5-8 remained expected
off and produced no peer incident. No event, public output, routing policy,
camera, or StreamRun state was changed. Every controller reached `CLEAN_STOP`,
and the publisher, viewer, and fault-gate state were removed after capture.

Pushover was the only phone-alert provider. The direct emergency
acknowledgement lifecycle had already passed in the monitoring-contract
cutover, so these content gates evaluated one opening delivery, one recovery
delivery, durable incident state, recovery, and court isolation.

## Results

| Scenario | Fault injected | First monitor issue | Monitor latency | Durable incident | Opening delivered | Recovery requested | Durable resolution | Recovery accepted | Classification |
| --- | --- | --- | ---: | --- | --- | --- | --- | --- | --- |
| Repeated picture | `15:46:20.506Z` | `15:46:47.616Z` | `27.110s` | `15:46:45.085Z` | `15:46:50Z` | `15:47:09.603Z` | `15:47:17.085Z` | `15:47:20.440Z` | Functional pass; 20s monitor SLA fail |
| Uniform black | `15:37:19.397Z` | `15:37:52.627Z` | `33.230s` | `15:37:49.085Z` | `15:37:55Z` | `15:38:13.903Z` | `15:38:22.085Z` | `15:38:24.613Z` | Functional pass; 25s monitor SLA fail |
| Camera silence | `15:41:13.422Z` | `15:42:17.513Z` | `64.091s` | `15:42:33.085Z` | `15:42:39Z` | `15:43:05.562Z` | `15:43:12.210Z` | `15:43:12.797Z` | Functional pass; 75s monitor SLA pass |

The formal black and repeated-picture evidence each contains 150 samples. The
silence evidence contains 151. All three report zero recorder errors, stale
snapshots, collector failures, dead-man failures, duplicate or missing expected
notifications, unexpected peer incidents, and cleanup failures.

The original repeated-picture recorder run is retained as a failed artifact.
It incorrectly required a Pushover emergency acknowledgement inside a gate
whose priority and delivery lifecycle did not create one. The corrected replay
removed that mismatched requirement; it did not change detector thresholds,
incident semantics, or notification behavior.

## Latency interpretation

The production thresholds remain unchanged: repeated picture becomes critical
after 15 seconds, uniform black after 20 seconds, and camera silence after 60
seconds. The analyzer requests one video sample per second but currently
decodes keyframes only; this test source produced effective visual updates
about five seconds apart. The monitor service polls the private agent snapshots
every five seconds. Raw media arrival precedes the persistence window. Those
stages account for the additional observed delay, but they do not convert a
missed runbook SLA into a pass.

This gate produced no evidence that Supabase polling must increase. Analyzer
samples are held in agent memory, private snapshot polling is independent of
the 60-second durable checkpoint, and incident rows are written only on state
transitions.

## Protected evidence

Evidence directory:

`~/.config/scorecheck/cutovers/pushover-gates-20260716T152635Z/`

- `black-evidence.jsonl` SHA-256
  `8f5156d0c65863d58131055de62e8b99bbe9796d7e13266b50a7409cbed6dc52`
- `silence-evidence.jsonl` SHA-256
  `f139d868c5564866e15dfae27c5796ba9fec4043c11dc611ce628f233ba18298`
- `freeze-replay-evidence.jsonl` SHA-256
  `8cedf731b3c1e2c439ebf5ce11b25b9a80d651915b1bfcbc48e4f3d742398f4e`

## Remaining acceptance

Do not lower the content-persistence thresholds to manufacture a latency pass.
The full-frame, one-frame-per-second cadence candidate passed local functional
validation and the one- and two-analyzer production-class `c-4` capacity gates.
See `2026-07-16-content-analyzer-cadence-candidate.md`. Before the real
eight-court gate, deploy that candidate in an idle bounded cutover and repeat
the repeated-picture and black timing gates, or explicitly revise the operator
SLA. The remaining real one-court fault rows and the full eight-court endurance
and isolation gate are still required.
