# Program Path Pacing Comparator

Date: 2026-07-13
Status: implemented and validated locally; not deployed or executed during the active soak

## Purpose

The extended soak proved a visible program-browser pacing failure while the
upstream program FFmpeg process remained at approximately 30 fps, RTP packet
loss remained zero, and YouTube stayed live and healthy. At approximately
`2026-07-13T14:29Z`, Court 1 rendered at 1-2 fps for at least 30 seconds and
added 413 dropped frames, 22 freezes, and 12.803 seconds of freeze duration.
Court 3 reconnected its WHEP session without reloading the page, while Courts 3
and 5 reached more than 1.2 seconds of browser jitter-buffer delay.

A later synchronized event from approximately `2026-07-13T15:00:05Z` through
`15:00:55Z` affected all three active program browsers. Courts 1, 3, and 5
added 599, 130, and 169 dropped frames respectively while their upstream
program FFmpeg processes remained at 30.01-30.02 fps, RTP loss remained zero,
and routing, ingest, and YouTube stayed healthy. That strengthens the
shared-component hypothesis without proving whether the common boundary is the
program timestamp path, WHEP delivery, or browser scheduling.

That evidence narrows the boundary but does not distinguish the delayed
program branch from WHEP delivery or browser scheduling. The comparator is a
read-only diagnostic for that distinction.

## Design

The admin monitor exposes an operator-invoked A/B/A sequence for one selected
court:

1. `courtN_preview` control A.
2. `courtN_program` delayed branch.
3. `courtN_preview` control B.

Only one WHEP player is mounted at a time. Each phase gets a ten-second warmup
and then one, two, or five minutes of measurement. The default is two minutes,
matching the production recording-rule window. HLS fallback is unavailable in
the test. Opening the comparator unmounts the selected-court live preview and
restores its prior state when the comparator closes, so the dashboard never
adds a second reader during the sequence. The tab becoming hidden aborts the
run instead of accepting throttled-browser evidence.

The report records reset-safe increases for received, decoded, and dropped
frames; freeze count and duration; packets received and lost; NACK, PLI, and
FIR feedback; median FPS; and p95 jitter-buffer, RTP jitter, and RTT values.
Source URLs and read credentials are never included in the downloaded JSON.
The diagnostic does not post program heartbeats, create incidents, modify
expected state, or call a production-control endpoint.

## Attribution

The comparator uses the same warning bands as production monitoring:

- frame drops above 0.5 percent;
- frozen time above 1 percent.

At least 30 seconds, 900 received frames, and 24 connected samples are required
per phase. Attribution is deliberately narrow:

- healthy preview A + degraded program + healthy preview B: `PROGRAM_PATH`;
- all three degraded: `SHARED`;
- all three healthy: `HEALTHY`;
- disagreeing controls or insufficient evidence: `INCONCLUSIVE`.

`PROGRAM_PATH` is evidence to test the SRT delay/remux implementation next; it
is not proof of a specific FFmpeg flag, MediaMTX defect, or Chrome defect.

## Post-soak gate

After the deployment freeze:

1. Roll out the deployment-isolation and reset-safe telemetry commits in one
   coordinated window.
2. Confirm the monitor does not connect either comparator source until the
   operator presses **Run A/B/A**.
3. Run a two-minute-per-phase sequence on a test court with stable motion.
4. Preserve the downloaded JSON, monitor snapshot, MediaMTX path metrics,
   branch FFmpeg progress, and host/container utilization for the same window.
5. Repeat once before changing the media path.
6. Change one delay/remux variable on a test-only branch, then repeat the exact
   sequence. Do not modify public program outputs during diagnosis.

The comparator is not soak evidence until this gate is actually executed.
