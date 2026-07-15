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
that blocker rather than treating it as healthy. A bounded monitoring-only
deployment and real operator-visible fault gates remain pending.
