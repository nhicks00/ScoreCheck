# Capacity Gate Evaluator

`evaluate-gate.mjs` converts a bounded Prometheus window plus explicit host and
operator attestations, the protected host-sampler CSV, and continuous process
evidence into a credential-free PASS/FAIL evidence file. It does not start
readers, Egress jobs, cameras, or destinations.

The evaluator deliberately refuses a telemetry-only pass. Prometheus does not
currently prove the complete source profile, process launch flags, or
cross-court isolation, so those values remain explicit attestations. Whole-host
CPU, sampler coverage/cadence/lag, and `/dev/shm` headroom are read directly
from the host-sampler CSV. A single long-lived Python process on each host also
scans `/proc` every 50 ms and records bounded PID, PPID, command, parent,
fingerprint, lifecycle, and classification evidence. Any new unclassified
zombie aborts sampling immediately. Exact sampler and configured container
healthcheck signatures are bounded by duration, count, and rolling rate. The
workload lifecycle classes are Chrome child waits and PulseAudio `pactl` waits
whose exact parentage, full ancestry, and cgroup resolve to the Egress
container; they share stricter duration, count, rate, concurrency, and closure
gates. Missing or sparse evidence fails the gate.
SSH exit-to-wait children are classified only when both process and parent are
the host SSH service (`sshd` under `sshd` or `systemd`); they remain subject to
the observer duration, count, rate, and closure gates.

## Run

Start the protected host sampler before the workload. It launches one
long-lived SSH/Python watcher per host. CPU and shared-memory samples align to
UTC interval boundaries inside those same processes, so repeated SSH/PAM and
container-exec observer churn cannot contaminate the gate:

```bash
node infra/capacity/sample-hosts.mjs \
  --ingest-host root@INGEST_HOST \
  --compositor-host root@COMPOSITOR_HOST \
  --ssh-key ~/.ssh/scorecheck_do \
  --interval-seconds 5 \
  --duration-seconds 2100 \
  --process-poll-ms 50 \
  --output /protected/court1-host-samples.csv \
  --process-output /protected/court1-zombie-events.ndjson
```

Stop the sampler only after the endpoint is sealed. Copy the attestation
example outside Git, fill in the operator-observed fields, and run the evaluator
against the observability host:

```bash
export SCORECHECK_PROMETHEUS_BEARER_TOKEN='protected-value'

node infra/capacity/evaluate-gate.mjs \
  --config infra/capacity/court1-c4.example.json \
  --attestations /protected/court1-attestations.json \
  --host-samples /protected/court1-host-samples.csv \
  --zombie-events /protected/court1-zombie-events.ndjson \
  --prometheus-url http://127.0.0.1:9090 \
  --start 2026-07-14T15:00:00Z \
  --end 2026-07-14T15:30:00Z \
  --output /protected/court1-capacity-report.json
```

The bearer token is read only from the environment and is never written to the
report. The output file is created mode `0600`. Exit status is `0` for PASS,
`2` for a completed FAIL, and `1` for invalid configuration or query failure.
For a 30-minute gate, the example uses a bounded 35-minute sampler so normal
completion does not depend on a terminal signal. On a fail-closed process
event, the local sampler first terminates both remote
watchers gracefully and only force-kills a transport that does not exit within
one second. This prevents the measurement harness from stranding its own SSH
session child under host init.

## Acceptance boundaries

The checked-in c-4 profile requires:

- every required media path ready for the accepted window;
- positive raw bitrate and zero media frame-error growth;
- continuously available FFmpeg speed telemetry, p05 speed at least `0.98x`,
  p05 output at least 29 fps, and zero drop growth;
- ingest and compositor service CPU plus separately observed whole-host CPU p95
  no more than 75%, maximum below 80%, stable post-warmup memory, no restart
  growth, and no OOM;
- host samples covering at least 80% of the official window, with p95, maximum,
  start-edge, and end-edge gaps no more than 7.5 seconds for the configured
  five-second sampler, plus no aligned sample more than 250 ms late;
- continuous 50 ms process watchers spanning both window edges with no restart,
  stop, heartbeat gap over two seconds, or scan gap over 250 ms;
- an exact allowlisted pre-run zombie baseline, zero new unclassified zombies,
  no exempt observer/healthcheck zombie lasting over two seconds, and bounded
  exempt churn (at most 16 per rolling minute and 480 total per host);
- no exact Egress Chrome or `pactl` child wait over 500 ms, more than one
  concurrent workload wait, more than 16 total or eight per rolling minute, or
  any unclosed workload lifecycle; all other workload zombies remain
  unclassified and fail immediately;
- fresh browser heartbeats, at least 29 fps at p05, no warning-level frame-drop
  or freeze ratio, and a continuously active Egress job;
- exact observed protocol/mode/codecs/dimensions/audio profile matching the
  manifest, verified assignment, no new workload zombie, no Egress errors,
  Chrome proven to use the configured `/dev/shm`, peak usage below 80%, and no
  impact outside the assigned court.

Use a normalizer-only manifest by omitting `compositor`, setting
`requireBrowser` to `false`, and listing only the raw/derived paths and FFmpeg
branches exercised by that benchmark. A larger compositor candidate requires a
separate manifest with its actual vCPU count; passing a c-4 report does not
admit two courts on another host.

## Test

```bash
node --test infra/capacity/evaluate-gate.test.mjs
node --test infra/capacity/host-samples.test.mjs
node --test infra/capacity/sample-hosts.test.mjs
node --test infra/capacity/zombie-evidence.test.mjs
infra/compositor/test-admission-config.sh
infra/compositor/test-start-court.sh
```
