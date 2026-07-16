# Host-Local Camera Content Fault Gates

Date: 2026-07-16
Result: functional gates passed; the one-second private polling/evaluation
cutover reduced freeze and black latency but both monitor SLAs remain narrowly
failed; silence monitor-latency SLA passed

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

## One-second private-loop hard cutover and repeat

Production revision `239f019ec87a136bd9b277f1f0f40a87c518044e`
changed only the monitor service's six private-agent poll loop and Prometheus
rule evaluation from five seconds to one second. A single-flight guard prevents
overlapping agent polls and exposes skipped cycles. Supabase control-plane
refresh, the 60-second durable checkpoint, YouTube, Healthchecks, notification
status, and provider polling cadences were not increased. Prometheus,
Alertmanager, Caddy, and node-exporter retained their exact container
identities. A 120-second post-cutover hold passed 13/13 samples with zero
health failures, alerts, incidents, gates, restarts, or skipped polls; maximum
snapshot age was `1.257s`.

The first deployment attempt made no runtime change because the staged guard
still required obsolete monitoring contract version 2 while production
correctly returned version 3. Revision `239f019e` includes a regression-tested
contract-v3 guard, after which the bounded service-only deployment passed.

| Scenario | Fault injected | First monitor issue | Monitor latency | Durable incident | Pushover submitted | Pushover latency | Target | Classification |
| --- | --- | --- | ---: | --- | --- | ---: | ---: | --- |
| Repeated picture optimized repeat | `18:02:52.415Z` | `18:03:14.874Z` | `22.459s` | `18:03:15.085Z` | `18:03:20.635Z` | `28.220s` | `20s` | Functional pass; latency improved `4.432s`; monitor SLA still fails by `2.459s` |
| Uniform black optimized repeat | `18:07:21.225Z` | `18:07:47.535Z` | `26.310s` | `18:07:48.085Z` | `18:07:53.990Z` | `32.765s` | `25s` | Functional pass; latency improved `3.174s`; monitor SLA still fails by `1.310s` |

The optimized freeze recorder passed 181 samples and the black recorder 180.
Both had zero sampling errors, stale snapshots, collector failures,
notification/dead-man failures, unexpected incidents, or peer-state changes.
Each recurrence created one new durable episode, one opening Pushover, and one
recovery Pushover. Both viewers recovered at 30 fps with zero RTP loss, dropped
frames, WebRTC freezes, reconnects, or reloads. Final cleanup again left no
event, gate, active incident, alert, live synthetic path, or viewer.

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
seconds. The analyzer decodes the complete stream and downsamples to 160x90 at
one sample per second. The optimized repeat removes most avoidable private poll
and rule-evaluation delay, but the test feed's production-like 2.5-second SRT
latency plus decoding, normalization, and analyzer propagation still consumed
roughly six to seven seconds before persistence could begin. The remaining
`1.310-2.459s` misses are therefore a pipeline/SLA boundary, not evidence that
Supabase or provider polling should increase. They remain failures.

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

Optimized private-loop repeat evidence directory:

`~/.config/scorecheck/cutovers/pushover-timing-optimized-20260716T180119Z/`

- `freeze-controller.jsonl` SHA-256
  `fd805b0d95c2820dc6211dbb6a126ef1a3b647613f98bf23f56743d636471fd5`
- `freeze-evidence.jsonl` SHA-256
  `232bfd4cdba2a6d0975fd5ddd276e51125bc5392f1865cc7f27dd941031222d0`
- `black-controller.jsonl` SHA-256
  `fa827498899d580a538879a75be2479b07bd9604758b01f36b9cda08e639656c`
- `black-evidence.jsonl` SHA-256
  `315afb68ba43a7d4b9ba56c853c57c38a464a373fd490baa002b727bc598fd9d`

## Remaining acceptance

Do not lower the content-persistence thresholds to manufacture a latency pass.
The full-frame, one-frame-per-second cadence hard cutover passed local
functional validation, the one- and two-analyzer production-class `c-4`
capacity gates, and an idle all-compositor production deployment. See
`2026-07-16-content-analyzer-cadence-candidate.md`. The explicit phone-visible
repeat and the one-second private-loop optimization are complete. The safe
central scheduling improvement is deployed and verified, but the physical
media/persistence floor still exceeds both original targets. Before timing
acceptance, choose either host-local alert evaluation ahead of the central SRT
path or revise the operator targets to at least 25 seconds for repeated picture
and 30 seconds for uniform black. Do not lower persistence thresholds or media
latency solely to manufacture a pass. The remaining real one-court rows and the
full eight-court endurance and isolation gate are still required.
