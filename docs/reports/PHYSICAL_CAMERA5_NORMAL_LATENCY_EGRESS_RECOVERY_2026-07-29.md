# Camera 5 Normal-Latency Exact-Owner Recovery Acceptance

Date: 2026-07-29

Scope: one clearly nonblack physical Camera 5 H.264/SRT feed, one fresh unlisted normal-latency YouTube destination on the warm spare, one continuous external viewer, and a complete Egress worker recycle. The existing Camera 5 primary output and every peer camera were left untouched.

## Verdict

**Pass. Normal-latency exact-owner output recovery met the viewer-continuity target.**

The continuous external viewer stalled for at most 752 ms while the entire Egress worker container was recycled and its exact immutable request was replayed. The player advanced for 202.430 seconds during a 203.635-second observation, decoded audio continuously, never reset its audio counter, and ended with no evaluator problem. Exactly one Egress was active on the spare at all times; there was no old/new overlap.

This closes the visual acceptance left open by the Camera 6 test. Camera 5 provided a moving, nonblank physical scene, and normal-latency YouTube buffering concealed the worker recycle inside the two-second release budget.

## Recovery Timeline

| Event | UTC |
| --- | --- |
| Continuous viewer started | 09:35:00.380 |
| Exact fault command completed | 09:36:36 |
| Active Egress set first empty | 09:36:37 |
| Supervisor entered `RECOVERING` | 09:36:40 |
| Replacement Egress first active | 09:36:48 |
| Replacement supervisor healthy | 09:36:50 |
| Continuous viewer completed | 09:38:24.036 |

The original Egress `EG_7tbPTYNjjQMq` was replaced by `EG_WopUx86uz6yQ`. The worker container identity changed, proving a complete worker recycle rather than an in-process browser retry.

## Viewer Evidence

The uninterrupted viewer captured 816 samples over 203.635 seconds:

- zero dropped samples;
- 254 ms maximum sampling gap;
- 752 ms maximum playhead stall;
- 202.430 seconds of playhead advance;
- 3,310,911 decoded audio bytes;
- zero audio counter resets;
- five transient not-ready samples;
- no pause, timeline regression, or evaluator problem; and
- moving, nonblank frames before and after recovery.

The reported 1280x720 dimensions are the external probe player's selected rendition, not the encoded Egress profile. The immutable Egress request remained 1920x1080 at 30 fps.

## Isolation And Primary Output

- Maximum active Egress count on the spare was one.
- The old and replacement Egresses never overlapped.
- Camera 5 raw and program media remained 1920x1080 H.264/AAC with positive bitrate and zero frame errors.
- Camera 5's existing primary unlisted broadcast stayed live, recording, active, and provider-health `good` with zero issues.
- A separate primary viewer probe advanced 8.055 seconds and decoded 130,971 audio bytes.
- Cameras 1, 3, 4, and 6 remained healthy; Cameras 2, 7, and 8 remained expected off.
- No incident or fault gate was created.

## Ordered Cleanup

The isolated broadcast was completed before its Egress was stopped. The stream became inactive/no-data, the spare reached zero active Egresses and `IDLE`, all temporary owner and assignment files were removed, and the existing Camera 5 primary output remained live.

## Protected Evidence

Evidence is stored outside Git under:

`~/.config/scorecheck/event-stack/events/reliability-physical-20260728/qualification-evidence/camera5-normal-visual-recovery-20260729T093119Z`

Its `summary.json` is the authoritative machine-readable gate result.

## Release Decision

- Accept normal-latency YouTube plus the two-second/two-observation exact-owner supervisor as the production single-output recovery path.
- Preserve full Egress-container recycle, exact request ownership, bounded retries, PulseAudio/admission reconciliation, and no duplicate publisher.
- Do not infer that YouTube provider health alone proves continuity; every recovery gate still requires a persistent external viewer.
- Proceed to local-renderer and control-plane-loss recovery rather than repeating this same accepted fault.
