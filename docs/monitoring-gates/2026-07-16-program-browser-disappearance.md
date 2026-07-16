# Program Browser Disappearance Gate

Date: 2026-07-16

## Scope

This gate exercised only one disposable protected Program viewer for synthetic
Camera 4. No physical camera, active event, Egress job, YouTube destination,
router, MediaMTX configuration, or public output was changed. Cameras 1-3 and
5-8 remained intentionally expected off.

The gate first exposed and corrected a contract gap: `PROGRAM_CONTENT`
established a Program viewer before arming, but browser liveness alerts still
depended only on a real live-broadcast expectation. Commit `26501cc7` added the
explicit `scorecheck_program_browser_required` signal. It is true for a real
live broadcast or the selected court's bounded `PROGRAM_CONTENT` gate, while
Egress, YouTube, commentary, scoring, preview, and program-path production
expectations remain unchanged.

## Deployment

- Exact revision: `26501cc71690a9444ae77b019c852b0b23a8df82`.
- Monitoring tests: 28 files and 158 tests passed.
- Evidence/controller tests: 31 passed.
- Strict typecheck and build passed.
- Prometheus 3.13.1 accepted 52 rules and all rule fixtures.
- Only `monitor-service` was recreated. Prometheus, Alertmanager, Caddy, and
  node-exporter retained exact container identities.
- Post-cutover baseline: 8/8 Prometheus targets up, zero alerts, zero active
  incidents, no event, no gate, and all eight browser-required metrics zero.
- Stability hold: 13/13 samples healthy, six of six agents fresh, zero alerts,
  zero incidents, and zero skipped one-second polls.

## Test Timeline

The protected synthetic feed published 1280x720/30 H.264 + AAC. Before arming,
the protected Camera 4 Program viewer was playing at 29-30 fps with zero RTP
loss, dropped frames, or freezes. Preview and Program each had exactly one
dependency reader. Raw had the expected preview and content-analysis readers.

| Event | UTC | Delta |
| --- | --- | ---: |
| `PROGRAM_CONTENT` armed | `2026-07-16T18:28:59.152Z` | n/a |
| Recorder baseline ready | `2026-07-16T18:29:09.572Z` | n/a |
| Viewer close requested | `2026-07-16T18:29:19.194Z` | 0.000s |
| Durable incident opened | `2026-07-16T18:29:45.709Z` | 26.515s |
| Opening Pushover submitted | `2026-07-16T18:29:51.294Z` | 32.100s |
| Viewer reopen requested | `2026-07-16T18:30:51.365Z` | 0.000s recovery |
| New browser waiting heartbeat | `2026-07-16T18:30:55.109Z` | 3.744s |
| New browser playing heartbeat | `2026-07-16T18:31:00.113Z` | 8.748s |
| Durable incident resolved | `2026-07-16T18:31:12.152Z` | 20.787s |
| Recovery Pushover submitted | `2026-07-16T18:31:12.531Z` | 21.166s |
| Ordered cleanup complete | `2026-07-16T18:33:00.115Z` | n/a |

The runbook's 30-second monitor-detection target passed by 3.485 seconds. The
opening phone request followed 5.585 seconds after the durable incident opened;
phone submission is reported separately and is not substituted for monitor
detection latency.

## Result

The protected recorder returned `PASS` across 180 one-second samples with zero
collection errors, zero stale snapshots, and a maximum snapshot generation gap
of 1.785 seconds. It recorded:

- exactly one new `PROGRAM_BROWSER_HEARTBEAT_MISSING` episode;
- one `OPENED` and one `RESOLVED` incident event;
- exactly one opening and one recovery Pushover row;
- delivered opening Pushover with no provider error;
- accepted recovery Pushover with no provider error;
- healthy raw, preview, and Program media throughout the viewer-only fault;
- 30 fps recovery with zero RTP loss, dropped frames, freezes, reconnects, or
  reloads in the replacement disposable viewer; and
- no unexpected incident or attention state on any peer camera.

After dependency recovery, the gate was disarmed, the viewer closed, and the
synthetic publisher stopped. The generic feed controller had been launched with
the unused `freeze` scenario, so it conservatively logged the browser incident
as unexpected during cleanup; after confirming no active gate or incident it
still completed its documented clean stop. Final state had no event, gate,
incident, alert, or Camera 4 path, and `scorecheck_program_browser_required`
returned to zero.

## Evidence

Protected local evidence directory:

```text
~/.config/scorecheck/cutovers/program-browser-contract-20260716T182131Z/
```

Artifact hashes:

```text
controller.jsonl       10caed8dd93abb170b1005977ded57ee1101bbcfbb54ae331caa1319e708f609
evidence.jsonl         96399725a8eebf1939a8f375037b71c0384705919453825e304c8dfec370ee05
evidence-summary.json  4a73e13945febfec7885438abcbce8510a26542b2676e7aef94f16b78dbab029
```

Classification: **functional pass and 30-second detection pass**.
