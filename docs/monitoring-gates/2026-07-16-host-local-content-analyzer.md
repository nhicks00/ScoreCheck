# Host-Local Camera Content Analyzer Gate

Date: 2026-07-16
Result: implementation, c-4 capacity, and production hard cutover passed;
functional phone gates passed with two monitor-latency SLA misses

## Decision

Camera black, repeated-picture, missing-audio, silence, and clipping evidence
will come from a browser-independent decoder on the camera's assigned
compositor. The analyzer reads the private raw RTSP path before preview,
program delay, browser rendering, or Egress. Program-browser telemetry remains
the authority for WHEP/viewer quality only.

This is monitoring contract v3 and a hard cutover. There is no compatibility
mode or feature flag. Every agent, monitor-service, Prometheus rule consumer,
and dashboard consumer must move to the same revision.

## Analyzer contract

- FFprobe establishes video and optional camera audio tracks.
- FFmpeg is spawned directly without a shell and performs decoder-only work.
- Video analysis uses keyframes, 160x90 grayscale, and a one-frame-per-second
  sample.
- Audio analysis uses mono 8 kHz signed 16-bit PCM windows.
- Freeze, black, silence, and sample ages use monotonic persistence durations.
- Stale decoder output is killed after ten seconds and retried with bounded
  exponential backoff.
- A missing, stale, duplicate, or conflicting analyzer fails closed. Browser
  content fields are never substituted as camera-content authority.
- Exactly one analyzer owns each camera. The current four-compositor topology
  runs two analyzers per host; the final eight-compositor topology runs one.

Private RTSP has no credentials in process arguments. DigitalOcean firewall,
UFW, and exact MediaMTX source-IP/path authorization jointly bind each assigned
compositor private IP to only its owned `courtN_raw` path(s).

## Functional validation

The built contract-v3 agent was exercised end to end against a disposable
H.264/AAC MediaMTX source. A moving source reported `ANALYZING`, fresh visual
samples, audible camera audio, zero clipping, and no false freeze/black state.
A static nonblack source crossed the repeated-picture persistence threshold
while camera audio remained healthy.

Local validation covered monitoring typecheck/build, 156 Vitest cases, 31 Node
tests, all event-stack and MediaMTX tests, the 521-test web suite plus
typecheck/lint/build, Prometheus 3.13.1 config/rules/fixtures, Alertmanager
0.33.1 config and 34 inhibition fixtures, and native agent/service image builds.

## c-4 capacity evidence

Both capacity runs used disposable localhost MediaMTX, synthetic 1280x720/30
H.264/AAC publishers, and the native-amd64 contract-v3 agent image on idle
`bvm-compositor-b`. They changed no production service, network rule, camera,
expectation, output, or monitoring contract. Temporary containers, networks,
images, and build files were removed after capture.

### One analyzer

- 180 one-second active samples after a 60-sample baseline.
- Analyzer CPU: 0.65% host mean, 0.73% p95, 1.43% max.
- Analyzer memory: 36.6 MB mean, 40.4 MB p95, 41.9 MB max.
- 186 analyzed frames at the endpoint, fresh video/audio, zero restarts, zero
  freeze/black/silence/clipping.
- Conservative addition to the prior qualified one-Egress c-4 gate: 62.96%
  p95 CPU and 69.34% max CPU.

Protected evidence:

- `~/.config/scorecheck/capacity/content-analyzer-c4-20260716T1317Z/`
- raw log SHA-256
  `e5c2ddef348a9ac1fa5690d5b7aa7455897b1ce5817204ce4c6ec66118ac9714`
- sample CSV SHA-256
  `2ad2a4ab71dbbf916f8ed19fa27ab600d64c53a2350d8042b472bb8180979d51`
- summary SHA-256
  `a6517d3d72f5c723327c312a22cc1c62793704a546ebd5481236b31cac69a589`

### Two analyzers

- 180 one-second active samples after a 15-sample two-publisher baseline.
- Analyzer CPU: 1.26% host mean, 1.43% p95, 1.89% max.
- Analyzer memory: 58.7 MB mean, 62.8 MB p95, 63.8 MB max.
- Both analyzers reached 188 frames with fresh video/audio, zero restarts, and
  zero freeze/black/silence/clipping.
- Conservative addition to the prior qualified one-Egress c-4 gate: 63.65%
  p95 CPU and 69.81% max CPU, below the 75% p95 and 80% max limits.

Protected evidence:

- `~/.config/scorecheck/capacity/content-analyzer-c4-two-stream-20260716T1333Z/`
- raw log SHA-256
  `5f162c498f4bc9050c5c8114feae4a55eccbf0079b67c7285dd88f576e6633a8`
- sample CSV SHA-256
  `78b1f245194ae49ca449267353e69b059e1b2eb0511fef192ebc4f80a66a7403`
- summary SHA-256
  `d70ffb143c956954cbe3cd93ff300ac54c07055a5f305d4d0e3687bf5a3b1c53`

## Production and phone-gate result

The idle same-revision contract-v3 cutover and live freshness verification are
complete. Isolated Camera 4 repeated-picture, black-picture, and camera-silence
gates each passed durable incident creation, one Pushover opening, clean
recovery, one recovery delivery, and peer-court isolation. Silence met its
75-second monitor-classification SLA. Repeated picture was classified in
27.110 seconds against a 20-second target, and black was classified in 33.230
seconds against a 25-second target, so those two latency gates remain failed.

See `2026-07-16-host-local-content-fault-gates.md` for the exact timeline,
protected evidence checksums, and remaining acceptance. Missing camera audio
and prolonged camera silence remain critical after their bounded holds;
clipping remains warning-only.
