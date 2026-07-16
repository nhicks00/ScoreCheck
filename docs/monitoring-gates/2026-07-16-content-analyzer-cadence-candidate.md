# Content Analyzer Cadence Candidate

Date: 2026-07-16
Result: local functional, production-class one- and two-analyzer capacity, and
idle production cutover passed; timing gates pending

## Change

The candidate removes FFmpeg keyframe-only decoding from the host-local camera
content analyzer. FFmpeg decodes the complete raw stream and then downsamples
to one 160x90 grayscale frame per second. This is a hard-cutover candidate, not
a feature flag or compatibility mode.

The production content gates showed effective visual updates about five seconds
apart because `-skip_frame nokey` coupled analyzer cadence to the source GOP.
That quantization contributed to the repeated-picture and black monitor-latency
SLA misses.

## Validation

- Monitoring tests: 28 Vitest files / 156 cases and 31 Node tests passed.
- Strict TypeScript typecheck passed.
- Production TypeScript build passed.
- Disposable local RTSP test used 1280x720 H.264 Baseline at 30 fps, AAC audio,
  and a five-second GOP.
- After source-probe startup, analyzer timestamps advanced at approximately one
  second per sample and `framesAnalyzed` advanced by one each sample.
- The analyzer reported `ANALYZING` with zero process restarts.
- Temporary publisher, MediaMTX container, and agent were stopped after capture.

## Production-class capacity evidence

The exact candidate image was built and exercised on idle production-class
`c-4` compositor D with disposable localhost MediaMTX and synthetic 1280x720/30
H.264 Baseline/AAC sources using five-second GOPs. The production monitoring
agent and files were not restarted or replaced. A sustained-host-CPU safety
cutoff was armed at 85%.

One analyzer, 180 one-second samples:

- analyzer host CPU: 2.62% mean, 2.81% p95, 3.59% max;
- analyzer memory: 68.3 MB mean, 70.0 MB p95, 70.5 MB max;
- whole test-host CPU: 18.14% p95, 23.66% max, including the synthetic encoder
  and test MediaMTX;
- 7 to 192 analyzed frames, every sample `ANALYZING`, zero restarts.

Two analyzers, 180 one-second samples:

- combined analyzer host CPU: 5.32% mean, 5.63% p95, 5.94% max;
- combined analyzer memory: 90.3 MB mean, 92.4 MB p95, 93.2 MB max;
- whole test-host CPU: 29.93% p95, 35.44% max, including two synthetic encoders
  and test MediaMTX;
- Camera 7 advanced 7 to 194 frames and Camera 8 advanced 7 to 193; every
  sample was `ANALYZING`, with zero restarts.

All temporary containers drained to zero. The exact candidate image and remote
build/evidence directories were removed after checksummed evidence was copied
to protected local storage. The production monitor agent remained healthy.

Protected evidence:

`~/.config/scorecheck/capacity/content-analyzer-cadence-283115a1/`

- one-analyzer samples SHA-256
  `a62fa67ec6772f791d338ecfd087f3211442d39c267d9b0370fe792a78dbda6f`
- one-analyzer summary SHA-256
  `514d0373f68014abbc8037c317556c6df7071492d53113cc75e9138433adb71c`
- two-analyzer samples SHA-256
  `a3600c8dd5423667f03e7fba14ff8eee88f271b8512809b524df7c20538ca8a2`
- two-analyzer summary SHA-256
  `ae3366011280cc2d9f43ed69ae5f222e80074547ee808677b65ddfad06bf3f24`

## Idle production cutover

All four compositor agents were rebuilt sequentially from exact Git revision
`5f718473e8c758b4a554c6312d054daf30443b5c` while the system was idle. Each old
agent remained active during its image build; only that host's monitor-agent
container was recreated. Every agent returned healthy with restart count zero
before the next host began.

Post-cutover verification at `2026-07-16T16:44:33Z` found:

- all four remote `contentAnalysis.ts` hashes exactly matched `master`;
- collector healthy with 6/6 fresh agents;
- no active event, incident, or fault gate;
- Cameras 1-8 all `EXPECTED_OFF`;
- no notification row newer than the prior formal gate recovery at
  `2026-07-16T15:47:20.440Z`;
- monitor-service, Prometheus, Alertmanager, Caddy, media, Egress, routing, and
  outputs were not restarted or reconfigured.

## Remaining release gate

Repeat the Camera 4 repeated-picture and black timing gates in an explicit
phone-visible operator window. Thresholds remain 15 and 20 seconds. The
hard cutover is accepted only if the runbook's 20- and 25-second
monitor-classification limits pass without peer incidents or duplicate
notifications.
