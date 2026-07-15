# Deterministic Monitoring Fault Matrix

Date: 2026-07-15

## Scope

This gate validates diagnosis, court isolation, alert timing, and inhibition
without changing production media, routing, browsers, outputs, expectations, or
notification providers. It does not substitute for the pending real-feed fault
matrix.

## Results

- Monitoring unit/correlation suite: 27 files, 141 tests passed.
- Prometheus 3.13.1: 49 rules passed syntax and executable rule tests.
- Alertmanager 0.33.1: configuration valid; 27 disposable inhibition fixtures
  passed with no network access to production receivers.
- Eight simultaneous healthy outputs pass only in the synthetic fixture where
  every two-court worker has a qualified maximum of two.
- Camera loss, repeated picture, black picture, stopped Egress, browser loss,
  commentary failure modes, score-render mismatch, YouTube failure, shared
  dependency failure, and peer-court isolation all pass deterministic checks.

## New Egress Contract

The prior monitor could see a healthy, reachable Egress worker while one
expected court output had stopped. The hard-cut contract now compares expected
live outputs to active web requests. It emits:

- `EGRESS_EXPECTATION_EXCEEDS_CAPACITY` when assigned live outputs exceed the
  worker's qualified maximum;
- `EGRESS_OUTPUT_MISSING` for the exact stale-browser court when the worker has
  fewer active requests than expected.

Worker-unavailable alerts inhibit the derived output symptom. The exact court
output symptom inhibits its browser-missing/low-FPS duplicates, while peer courts
remain independent.

## Production Boundary

Production has four compositor workers, each currently qualified for one active
web Egress request while assigned two courts. Eight simultaneous live outputs
are therefore not qualified by the current topology. The new monitor exposes
that blocker rather than treating it as healthy. Real operator-visible fault
gates remain pending.

## Production Cutover

The monitoring-only release completed on exact revision
`34739305cfc439123ec070e0231ce2bbe1853b84` at `2026-07-15T05:06Z`.

- Alertmanager was recreated once, intentionally, because two failed-closed
  in-place attempts proved that its single-file bind mount retained the old
  inode. The clean recreate moved container `6dc2244a31bb` to `81474b4bc981`,
  preserved its data volume, loaded all new inhibition rules, and retained
  restart count zero. Backup:
  `/opt/scorecheck-monitoring/backups/alertmanager-recreate-20260715T050538Z.yml`.
- Monitor-service moved from `4c7b97603b81` to `d758764d8c66`, reports the exact
  release revision, is healthy, and has restart count zero.
- Prometheus `be82eb2dbda9`, Caddy `dc7439995fde`, and node-exporter
  `badad55e5f05` retained their container identities.
- Production reports 49 rules, zero unhealthy rules, zero firing rules, and zero
  Alertmanager alerts. Six of six agents are fresh; event, incidents, and fault
  gates are empty. A delayed `05:08Z` recheck retained the same state with both
  changed containers at restart count zero.
- Camera 1 continued publishing at positive bitrate with zero frame errors.
  No media, routing, browser, YouTube, output, expectation, or StreamRun state
  was changed.
- Pushover and both Healthchecks channel assignments remained healthy. Twilio
  remained disabled and no phone notification was sent.
