# Host-Local Camera Content Fault Gates

Date: 2026-07-16
Result: functional gates passed; freeze and black monitor-latency SLAs failed
again in the phone-visible full-frame repeat; silence monitor-latency SLA passed

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

## Phone-visible full-frame repeat

The required repeated-picture and uniform-black timing repeat ran against the
deployed full-frame analyzer in one bounded Camera 4 synthetic window. Pushover
delivery was recorded; no physical camera action was required. Both
recorders passed functional, durable-history, notification-deduplication,
recovery, and peer-isolation checks. Neither timing target passed.

| Scenario | Fault injected | First monitor issue | Monitor latency | Durable incident | Pushover submitted | Pushover latency | Target | Classification |
| --- | --- | --- | ---: | --- | --- | ---: | ---: | --- |
| Repeated picture repeat | `17:33:01.934Z` | `17:33:28.825Z` | `26.891s` | `17:33:26.085Z` | `17:33:31.494Z` | `29.560s` | `20s` | Functional pass; monitor SLA fail; phone latency observed |
| Uniform black repeat | `17:38:43.788Z` | `17:39:13.272Z` | `29.484s` | `17:39:11.085Z` | `17:39:12.683Z` | `28.895s` | `25s` | Functional pass; monitor SLA fail; phone latency observed |

The repeated-picture recorder captured 180 samples and the black recorder 181.
Both had zero sampling errors, stale snapshots, collector failures,
notification/dead-man failures, unexpected incidents, or peer-state changes.
Each episode created one opening Pushover and one recovery Pushover. Both
Program viewers remained connected at 30 fps with zero RTP loss, dropped
frames, freezes, reconnects, or reloads through dependency recovery. Final
cleanup left no event, fault gate, active incident, or live synthetic path.

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

Phone-visible repeat evidence directory:

`~/.config/scorecheck/cutovers/pushover-timing-repeat-20260716T173028Z/`

- `freeze-controller.jsonl` SHA-256
  `87e0fabe87231d9d2d46ce5a53c083bd22378ed13cf544ba4ed62d88f680837e`
- `freeze-evidence.jsonl` SHA-256
  `67f0fad18ff51b33b0b729262c9fa6a6b427c8edf3d4a13687f8cf09386a8e6d`
- `black-controller.jsonl` SHA-256
  `54e352e5084b879b051e5e451b1837d435dcf94d077e2ea9c812b885bc5f971e`
- `black-evidence.jsonl` SHA-256
  `92010ab0ae1a9420592f2fe85671359d991ae9233cae34666539a6e0452e139b`

## Remaining acceptance

Do not lower the content-persistence thresholds to manufacture a latency pass.
The full-frame, one-frame-per-second cadence hard cutover passed local
functional validation, the one- and two-analyzer production-class `c-4`
capacity gates, and an idle all-compositor production deployment. See
`2026-07-16-content-analyzer-cadence-candidate.md`. The explicit phone-visible
repeat is now complete and confirms the remaining delay is systematic rather
than an operator-window artifact. Before acceptance, either reduce the
collection/evaluation latency and repeat both gates, or explicitly revise the
operator SLA with the persistence thresholds unchanged. The remaining real
one-court fault rows and the full eight-court endurance and isolation gate are
still required.
