# Capacity Gate Evaluator

`evaluate-gate.mjs` converts a bounded Prometheus window plus explicit host and
operator attestations into a credential-free PASS/FAIL evidence file. It does
not start readers, Egress jobs, cameras, or destinations.

The evaluator deliberately refuses a telemetry-only pass. Prometheus does not
currently prove source-profile identity, process reaping, `/dev/shm` headroom,
or cross-court isolation, so those values must be captured and supplied in the
attestation file. Missing values fail the gate.

## Run

Copy the example files outside Git, fill in the measured attestations, and run
the evaluator against the observability host after a benchmark window:

```bash
export SCORECHECK_PROMETHEUS_BEARER_TOKEN='protected-value'

node infra/capacity/evaluate-gate.mjs \
  --config infra/capacity/court1-c4.example.json \
  --attestations /protected/court1-attestations.json \
  --prometheus-url http://127.0.0.1:9090 \
  --start 2026-07-14T15:00:00Z \
  --end 2026-07-14T15:30:00Z \
  --output /protected/court1-capacity-report.json
```

The bearer token is read only from the environment and is never written to the
report. The output file is created mode `0600`. Exit status is `0` for PASS,
`2` for a completed FAIL, and `1` for invalid configuration or query failure.

## Acceptance boundaries

The checked-in c-4 profile requires:

- every required media path ready for the accepted window;
- positive raw bitrate and zero media frame-error growth;
- FFmpeg p05 speed at least `0.98x`, p05 output at least 29 fps, and zero drop
  growth;
- ingest and compositor CPU p95 no more than 75%, maximum below 80%, stable
  post-warmup memory, no restart growth, and no OOM;
- fresh browser heartbeats, at least 29 fps at p05, no warning-level frame-drop
  or freeze ratio, and a continuously active Egress job;
- verified source profile and assignment, zero zombie growth, no Egress errors,
  `/dev/shm` below 80%, and no impact outside the assigned court.

Use a normalizer-only manifest by omitting `compositor`, setting
`requireBrowser` to `false`, and listing only the raw/derived paths and FFmpeg
branches exercised by that benchmark. A larger compositor candidate requires a
separate manifest with its actual vCPU count; passing a c-4 report does not
admit two courts on another host.

## Test

```bash
node --test infra/capacity/evaluate-gate.test.mjs
infra/compositor/test-admission-config.sh
```
