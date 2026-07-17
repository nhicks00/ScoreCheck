# Capacity Gate Evaluator

`evaluate-gate.mjs` converts a bounded Prometheus window plus explicit host and
operator attestations, the protected host-sampler CSV, and continuous process
evidence into a credential-free PASS/FAIL evidence file. It does not start
readers, Egress jobs, cameras, or destinations.

The evaluator deliberately refuses a telemetry-only pass. Prometheus does not
currently prove the complete source profile, process launch flags, or
cross-court isolation. Source profiles come from the protected camera-profile
qualification report; process flags and isolation remain explicit attestations.
Whole-host
CPU, sampler coverage/cadence/lag, and `/dev/shm` headroom are read directly
from the host-sampler CSV. A single long-lived Python process on each host also
scans `/proc` every 50 ms and records bounded PID, PPID, command, parent,
fingerprint, lifecycle, and classification evidence. Any new unclassified
zombie aborts sampling immediately. Exact sampler and configured container
healthcheck signatures are bounded by duration, count, and rolling rate. The
workload lifecycle classes are Chrome child waits, PulseAudio `pactl` waits,
and the exact `gst-plugin-scan` child spawned directly by LiveKit Egress. Their
exact parentage, full ancestry, and cgroup must resolve to the Egress container;
they share stricter duration, count, rate, concurrency, and closure gates.
Generic GStreamer processes and every unmatched workload child remain
unclassified and fail immediately. Missing or sparse evidence fails the gate.
SSH exit-to-wait children are classified only when both process and parent are
the host SSH service (`sshd` under `sshd` or `systemd`); they remain subject to
the observer duration, count, rate, and closure gates.

## Final-camera profile gate

`camera-profile-gate.mjs` qualifies the source profile before normalization.
It deliberately separates three evidence sources:

- fixed-deadline, sanitized monitor snapshots prove publisher continuity,
  bitrate, frame-error growth, source identity, collector freshness, and the
  absence of incidents or fault gates;
- a bounded local `ffprobe` reached through an SSH RTSP tunnel proves the
  actual video frame rate, codec/profile, dimensions, and audio profile;
- the evaluator combines both artifacts into a credential-free mode-`0600`
  PASS/FAIL report.

The sampler skips a missed slot instead of issuing catch-up requests, so
clustered samples cannot inflate coverage. It never starts camera publishers,
normalizers, program readers, Egress jobs, or destinations. The probe creates
one short-lived raw RTSP reader per required court and closes its SSH tunnel on
success or failure.

The checked-in `camera-profiles.example.json` candidate targets the intended
Camera 3-5 hard cutover: SRT push, H.264 Main 1280x720 at 29-31 fps, and AAC 48
kHz stereo for every logical stream. Change that manifest only to the intended
camera configuration before the run. Do not weaken it after observing HEVC or
another mismatch; a mismatch means that camera still requires an isolated
normalization assignment.

The separate `camera-profiles-eight-court.example.json` manifest is the required
input for the final endurance qualification. Its output is report schema 2 and
embeds the exact qualification contract, hashes of both protected source
artifacts, and sanitized monitor and `ffprobe` profiles. Schema-1 reports and
reports missing the complete generated check set are rejected; operator
attestations cannot substitute for this artifact.

Run the ten-minute sampler and take the bounded probe near the start of its
window:

```bash
mkdir -p "$HOME/.config/scorecheck/camera-profiles/restored-3-5"
chmod 700 "$HOME/.config/scorecheck/camera-profiles/restored-3-5"

export SCORECHECK_MONITOR_API_TOKEN='protected-value'
node infra/capacity/camera-profile-gate.mjs sample \
  --config infra/capacity/camera-profiles.example.json \
  --monitor-url https://monitor.beachvolleyballmedia.com \
  --duration-seconds 600 \
  --output "$HOME/.config/scorecheck/camera-profiles/restored-3-5/samples.ndjson" &
sampler_pid=$!

node infra/capacity/camera-profile-gate.mjs probe \
  --config infra/capacity/camera-profiles.example.json \
  --ingest-host root@INGEST_HOST \
  --ssh-key "$HOME/.ssh/scorecheck_do" \
  --output "$HOME/.config/scorecheck/camera-profiles/restored-3-5/probes.json"

wait "$sampler_pid"
node infra/capacity/camera-profile-gate.mjs evaluate \
  --config infra/capacity/camera-profiles.example.json \
  --evidence "$HOME/.config/scorecheck/camera-profiles/restored-3-5/samples.ndjson" \
  --probes "$HOME/.config/scorecheck/camera-profiles/restored-3-5/probes.json" \
  --output "$HOME/.config/scorecheck/camera-profiles/restored-3-5/report.json"
```

A profile PASS does not prove the separate fail-closed Speedify route, final
75 Mbps bonded-upload floor, derived-path normalization capacity, or eight
simultaneous outputs. Those remain later gates.

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
  --known-hosts /protected/event-known-hosts \
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
- an exact pre-run zombie baseline (empty for the checked-in c-4 profile), zero
  new unclassified zombies,
  no exempt observer/healthcheck zombie lasting over two seconds, and bounded
  exempt churn (at most 16 per rolling minute and 480 total per host);
- no exact Egress Chrome root/child, `pactl`, or direct `gst-plugin-scan` child
  wait over 500 ms, more than one concurrent workload wait, more than 16 total
  or eight per rolling minute, or any unclosed workload lifecycle; all other
  workload zombies remain unclassified and fail immediately;
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

## Eight-court endurance gate

The final endurance gate uses `sample-host-pool.mjs` and
`evaluate-eight-court-gate.mjs`. It does not run the one-court sampler eight
times: that would create eight SSH observers on the ingest host and contaminate
the capacity evidence. The pool sampler starts exactly one long-lived watcher
on the ingest host, one on each of eight independently assigned compositor
hosts, and one on the unassigned warm spare. It writes a single protected
NDJSON artifact with stable host IDs and remote machine fingerprints. Duplicate
physical identities fail even when different SSH aliases were supplied, and
the spare is proven ready throughout the window instead of only appearing in a
preflight snapshot.

Each watcher also records its host-local DigitalOcean droplet ID and hostname.
The evaluator requires those values to match the exact active droplet resources
captured by the fresh provider preflight, and rejects missing, changed, or
duplicated provider identities. The final gate fixes metric coverage at 99% or
higher and rounds the required sample count upward, so a fractional threshold
cannot silently pass with less than the configured coverage.

The checked-in `eight-court-endurance.example.json` is a candidate manifest,
not a claim about the final camera or ingest profiles. Replace every source
profile and host vCPU value with evidence from the camera-profile and host
qualification gates before starting. Do not weaken a profile after seeing the
result. The official window is at least 120 seconds of warmup plus 7,200
post-warmup seconds.

Immediately before the endurance window, run the same ten-minute sample,
bounded `ffprobe`, and evaluate sequence documented above with
`camera-profiles-eight-court.example.json`. Store the resulting mode-`0600`
report beside the other protected gate evidence. The endurance manifest's
`expectedCameraProfileGateId` must equal that report's gate ID, all eight source
profiles must match exactly, and the report must finish before workload start
within `maximumCameraProfileEvidenceAgeSeconds`.

Start the pool sampler before the first Egress request. Provide exactly one
ingest host and nine unique compositor hosts, including the warm spare:

```bash
node infra/capacity/sample-host-pool.mjs \
  --host bvm-preview-01,ingest,root@INGEST_HOST \
  --host bvm-compositor-a,compositor,root@COMPOSITOR_A \
  --host bvm-compositor-b,compositor,root@COMPOSITOR_B \
  --host bvm-compositor-c,compositor,root@COMPOSITOR_C \
  --host bvm-compositor-d,compositor,root@COMPOSITOR_D \
  --host bvm-compositor-e,compositor,root@COMPOSITOR_E \
  --host bvm-compositor-f,compositor,root@COMPOSITOR_F \
  --host bvm-compositor-g,compositor,root@COMPOSITOR_G \
  --host bvm-compositor-h,compositor,root@COMPOSITOR_H \
  --host bvm-compositor-spare,compositor,root@COMPOSITOR_SPARE \
  --ssh-key ~/.ssh/scorecheck_do \
  --known-hosts /protected/event-known-hosts \
  --interval-seconds 5 \
  --duration-seconds 7500 \
  --process-poll-ms 50 \
  --output /protected/eight-court-host-events.ndjson
```

Capture the exact nine-compositor `preflight-capacity.mjs` JSON immediately
before the run. The evaluator requires all eight assigned worker names plus the
warm spare, the manifest's exact region/size/vCPU shape, no missing or extra
tagged worker, and no provider blocker. The
spare must remain fresh, idle, valid, admission-ready, restart-free, OOM-free,
and process-clean for the full window. It also requires separate venue evidence
with at least three timestamped upload measurements spanning five minutes. The
evaluator derives p05 and worst packet loss from those raw samples; it requires
p05 of at least 75 Mbps, bounded packet loss, the Speedify exit, and fail-closed
routing. The example venue and operator-attestation files deliberately fail
until real observations replace their defaults.

The preflight CLI stamps `checkedAt`; the evaluator rejects an artifact older
than the manifest's bounded preflight age or dated after workload start. Venue
evidence has the same pre-run boundary so a concurrent speed test cannot
retroactively qualify or disturb the endurance window.

After the endpoint is sealed, evaluate the full Prometheus window:

```bash
export SCORECHECK_PROMETHEUS_BEARER_TOKEN='protected-value'

node infra/capacity/evaluate-eight-court-gate.mjs \
  --config /protected/eight-court-config.json \
  --attestations /protected/eight-court-attestations.json \
  --host-events /protected/eight-court-host-events.ndjson \
  --pool-preflight /protected/compositor-pool-preflight.json \
  --venue-evidence /protected/venue-network.json \
  --camera-profile-report /protected/eight-camera-profile-report.json \
  --prometheus-url http://127.0.0.1:9090 \
  --start 2026-07-15T12:00:00Z \
  --end 2026-07-15T14:02:00Z \
  --output /protected/eight-court-endurance-report.json
```

Endpoint collection is capped at eight concurrent Prometheus requests. The
evaluator caches identical queries and writes one protected local evidence
artifact containing the source host-event SHA-256/event count and the exact
camera-profile report plus its SHA-256; it does not
write high-frequency samples to Supabase.

The aggregate report fails if any one court fails. Per-court checks include
raw/preview/program readiness and exact reader counts, FFmpeg cadence and
drop/duplicate growth with a hard critical floor, continuously positive raw
traffic, one active Egress request on the assigned worker,
browser FPS/drop/freeze/packet-loss/session/reconnect/reload behavior, camera
audio, score source/render alignment, and YouTube health. At least two courts
must additionally pass commentary connection, track, mute, clipping, silence,
loss, jitter, sync-lock, delay-gap, and human A/V-sync evidence. Global checks
require all eleven agents fresh, healthy control/score/YouTube/dead-man/Pushover
dependencies, active dead-man sender mode with no test gate, no warning or
critical alert, cross-court isolation, unlisted
manual-lifecycle test broadcasts, zero active incidents or fault gates, exact
pool inventory, one continuous monitor-service process, fresh monitor snapshots,
bounded Prometheus
series gaps and edge coverage, continuous warm-spare readiness, and the venue
floor.

The attestation file is endpoint-stamped and expires after a bounded lag. Each
required commentary court also records its clap/A/V-sync observation time; an
old observation from a previous run cannot satisfy the gate. Source profiles
are intentionally absent from this file because only the bound camera-profile
artifact can qualify them.

## Test

```bash
node --test infra/capacity/evaluate-gate.test.mjs
node --test infra/capacity/camera-profile-gate.test.mjs
node --test infra/capacity/host-samples.test.mjs
node --test infra/capacity/sample-hosts.test.mjs
node --test infra/capacity/zombie-evidence.test.mjs
node --test infra/capacity/pool-host-evidence.test.mjs
node --test infra/capacity/sample-host-pool.test.mjs
node --test infra/capacity/evaluate-eight-court-gate.test.mjs
infra/compositor/test-admission-config.sh
infra/compositor/test-start-court.sh
```
