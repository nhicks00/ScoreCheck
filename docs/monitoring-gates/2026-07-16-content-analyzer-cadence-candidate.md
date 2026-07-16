# Content Analyzer Cadence Candidate

Date: 2026-07-16
Result: local functional validation passed; production capacity qualification
pending

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

## Release gate

Do not merge or deploy this candidate from functional evidence alone. Full-frame
decode is more CPU intensive than keyframe-only decode. Repeat the existing
one- and two-analyzer `c-4` capacity gates with the exact candidate image and
retain the 75% p95 / 80% max host CPU, memory, restart, freshness, and cleanup
requirements. If the final topology assigns one court per compositor, the
one-analyzer result is authoritative for that topology; a two-analyzer result
does not substitute for a different assignment.

After capacity passes, deploy all analyzer agents on one revision in an idle
bounded cutover and repeat the Camera 4 repeated-picture and black timing gates.
Thresholds remain 15 and 20 seconds. The candidate is accepted only if the
runbook's 20- and 25-second monitor-classification limits pass without peer
incidents or duplicate notifications.
