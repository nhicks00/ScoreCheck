# Camera 6 Normal-Latency Egress Recovery Gate

Date: 2026-07-29  
Scope: one physical Camera 6 H.264/SRT feed, a fresh unlisted normal-latency YouTube broadcast, one dedicated compositor, and a persistent external YouTube viewer. The accepted Camera 5 output and all peer camera paths were left untouched.

## Verdict

**Exact-owner recovery passed. The two-second viewer-stall target passed after the supervisor timing hard cut. Full visual acceptance remains inconclusive.**

Normal-latency YouTube alone reduced the prior low-latency Camera 5 viewer stall from 24.001 seconds to 11.750 seconds, but did not satisfy the continuity target. Changing only the Egress supervisor from a five-second interval with three missing observations to a two-second interval with two missing observations reduced Camera 6's measured external-viewer stall to 1.499 seconds. The replacement still recycled the complete Egress worker, validated PulseAudio and admission state, and replayed only the immutable owned request. No duplicate Egress was active.

The original machine evaluator returned `FAILED` because Camera 6's physical scene was already nearly black before the fault and because seven quarter-second samples reported `readyState=2`. Six of those samples formed one 1.249-second interval; the seventh was isolated. The player was never paused, its maximum playhead stall remained below two seconds, decoded audio advanced without a counter reset, and the trace advanced in real time. Treating every transient `readyState=2` sample as a playback failure contradicted those measured delivery signals, so the evaluator now records that count while failing actual pauses and excessive playhead stalls. Re-evaluating the preserved trace leaves only the pre-existing black-scene failure. Camera 6 therefore proves the recovery timing improvement but cannot provide a valid nonblack visual-fidelity pass.

## Configuration Comparison

| Run | YouTube latency | Supervisor interval | Missing observations | Maximum viewer stall | Not-ready samples | Fault to replacement |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| Initial Camera 6 run | normal | 5 seconds | 3 | 11.750 seconds | 47 | 23.114 seconds |
| Repeat hard cut | normal | 2 seconds | 2 | 1.499 seconds | 7 | 12.980 seconds |

The worker recycle itself was stable at approximately 7.86 seconds in both runs. The measured gain came from reducing absence confirmation from 12.372 seconds to 2.262 seconds. Normal-latency YouTube then had enough buffered program to conceal all but 1.499 seconds of playhead interruption.

## Repeat Timeline

| Event | UTC |
| --- | --- |
| Continuous viewer trace started | 07:58:13.778 |
| Fault requested for exact Egress `EG_usZMamkx5qqm` | 07:58:46.022 |
| Active Egress set first empty; missing observation 1 | 07:58:48.878 |
| Missing observation 2; worker recycle began | 07:58:51.140 |
| Exactly one replacement `EG_ygo3uNnucGTZ` active | 07:58:59.002 |
| First healthy supervisor observation | 07:59:00.156 |
| Stable healthy endpoint recorded | 07:59:02.443 |
| Viewer trace completed | 08:00:23.533 |

## Ownership And Host Evidence

- Maximum active Egress count was one.
- The old and replacement Egress IDs differed.
- The old and replacement container IDs differed.
- The immutable request generation and digest remained owned by Camera 6.
- The replacement host returned healthy Egress, valid idle admission before replay, and valid PulseAudio load.
- The supervisor used two bounded recovery attempts for this output generation and did not start an unowned publisher.
- Camera 6 raw ingest remained 1920x1080 H.264/SRT with positive bitrate and zero frame errors.
- Cameras 1-5 remained healthy and Cameras 7-8 remained intentionally expected off.

## Viewer Evidence

The repeat viewer trace captured 521 samples over 129.755 seconds:

- maximum sample gap: 254 ms;
- dropped trace samples: zero;
- maximum playhead stall: 1.499 seconds;
- player-paused samples: zero;
- not-playback-ready samples: seven;
- playhead advance: 128.168 seconds, or 98.78% of wall time;
- decoded audio bytes: 2,113,309;
- audio counter resets: zero; and
- player geometry: 1280x720.

The source was not suitable for visual-fidelity acceptance. Baseline and phase captures had mean luma around 2.7-4.4 with approximately 97.7-98.5% dark pixels, matching the monitor's independent near-black classification. This pre-existing source condition must not be misclassified as a recovery-generated black frame.

The continuity evaluator was corrected from a false all-samples `readyState>=3` requirement to the actual operator contract. It now preserves `notPlaybackReadySamples`, but qualifies continuity from bounded playhead stall, real-time playhead advance, decoded audio, pause state, dimensions, sampling cadence, and moving/nonblack frame evidence. The preserved trace re-evaluates with one problem only: `continuous viewer phase frame was black or visually blank`.

## Monitoring Evidence

The Camera 6 Egress and YouTube stages recovered without publisher multiplicity. No incident or fault gate remained after cleanup. The supervisor's repeat generation reached its configured two-attempt bound, so the temporary output was retired rather than left with no remaining recovery budget.

The score-render alert's new 30-second hold did not create a transient score-render episode during this gate. Provider-stage monitoring still reported the real YouTube ingest interruption; that signal is correct even when normal-latency buffering limits the viewer-visible stall.

## Ordered Cleanup

Cleanup preserved the broadcast lifecycle contract:

1. The unlisted broadcast `L9gPbXvla84` transitioned from live to complete at 08:06:31Z.
2. Exact Egress `EG_ygo3uNnucGTZ` was then stopped through the owned stop path.
3. Active Egress count reached zero and all Camera 6 owner/request/stop-intent files were absent.
4. The reusable Camera 6 stream became inactive with no configuration issues.
5. Camera 6 monitoring returned to OFF/OFF/OFF and its prior video binding was restored.
6. The program warmer and on-demand program path retired; raw ingest remained healthy with one analysis reader and zero frame errors.
7. Final monitoring showed no active incidents or fault gates.

## Protected Evidence

Evidence is stored outside Git under:

`~/.config/scorecheck/event-stack/events/reliability-physical-20260728/qualification-evidence/camera6-egress-recovery-normal-20260729T074611Z`

It includes both viewer traces, one-second host timelines, recovery summaries, provider observations, broadcast transition evidence, control-plane restoration evidence, and final idle-state verification.

## Release Decision

Keep YouTube normal latency and the two-second/two-observation exact-owner supervisor timing. The measured combination met the two-second viewer-stall target without weakening ownership, bounded retries, complete worker recycle, or admission checks.

Persistent-output recovery is not yet fully production-qualified. Repeat once on a physical source with a clearly nonblack moving scene, then exercise abnormal handler exit, full Egress-container loss, and compositor restart. The next viewer evaluator should distinguish a bounded transient `readyState=2` interval from an actual pause or playhead stall while continuing to preserve the raw samples.
