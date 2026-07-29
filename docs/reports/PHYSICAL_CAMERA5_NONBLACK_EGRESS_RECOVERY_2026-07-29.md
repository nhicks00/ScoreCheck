# Camera 5 Nonblack Exact-Owner Egress Recovery Gate

Date: 2026-07-29  
Scope: one physical Camera 5 H.264/SRT feed, its existing unlisted low-latency YouTube broadcast, one dedicated compositor, and one continuous external viewer. Cameras 1, 3, 4, and 6 remained live; Cameras 2, 7, and 8 remained expected off.

## Verdict

**Exact-owner recovery passed. Viewer continuity failed.**

The compositor recovered the deliberately removed Camera 5 Egress in 12.771 seconds without admitting a duplicate publisher. The replacement browser reached 1920x1080 HLS playback at 30 fps with zero dropped frames, freezes, reconnects, or reloads. Camera 5 ingest and program media remained healthy, and all peer-camera states were isolated.

The persistent YouTube viewer stalled for 18.501 seconds. The same viewer resumed without navigation, decoded audio before and after the fault, and ended on changing nonblank frames. A fresh post-recovery viewer probe also passed. This is still a release failure because continuous viewer playback is the primary requirement.

The result confirms the prior comparison rather than contradicting it: the accepted two-second/two-observation Egress supervisor timing is fast enough, but this older low-latency YouTube destination does not provide enough viewer buffer to conceal the complete worker recycle. New production destinations must use normal latency.

## Recovery Timeline

| Event | UTC |
| --- | --- |
| Continuous viewer started | 09:15:45.795 |
| Exact owned Egress stop requested | 09:16:13.250 |
| Stop command completed | 09:16:13.329 |
| Active Egress set first empty | 09:16:14.409 |
| Supervisor first reported `MISSING_PENDING` | 09:16:16.247 |
| Worker recycle began | 09:16:18.083 |
| Replacement `EG_4MWTzUMZbozJ` first active | 09:16:26.021 |
| Supervisor returned `HEALTHY` | 09:16:27.896 |
| Viewer resumed playback | 09:16:38.910 |
| YouTube monitoring incident opened | 09:17:05.709 |
| YouTube next reported live/active/good | 09:17:26.863 |
| Fresh post-recovery viewer probe passed | 09:17:45.362 |
| Continuous viewer trace completed | 09:18:07.659 |

Measured recovery intervals:

- fault request to replacement Egress: 12.771 seconds;
- first empty active set to replacement Egress: 11.612 seconds;
- fault request to healthy supervisor: 14.646 seconds; and
- maximum external-viewer playhead stall: 18.501 seconds.

## Ownership And Host Evidence

- Maximum simultaneous active Egress count was one.
- Old Egress `EG_eRH4YNfPrsF9` was replaced by `EG_4MWTzUMZbozJ`.
- The worker container changed once, from the original container to a fresh healthy container with restart count zero.
- Event, destination role, output generation, renderer identity, and request SHA-256 remained unchanged during automatic recovery.
- The supervisor reached `HEALTHY` with one active request out of one maximum and a valid PulseAudio load.
- Camera 5 raw ingest remained 1920x1080 H.264/AAC over SRT at approximately 3.2 Mbps with zero frame errors.
- The Camera 5 program path remained 1920x1080 with positive bitrate and zero frame errors.
- Cameras 1, 3, 4, and 6 stayed healthy. Cameras 2, 7, and 8 stayed expected off.

## Viewer Evidence

The continuous viewer captured a 141.864-second trace with:

- 252 ms maximum sampling gap;
- zero dropped trace samples;
- 18.501 seconds maximum playhead stall;
- 74 not-playback-ready samples;
- no paused samples or playhead regression;
- 123.339 seconds of playhead advance;
- 2,014,468 decoded audio bytes; and
- changing, nonblank frames before and after recovery.

The independent eight-second post-recovery probe advanced 8.059 seconds, decoded another 130,960 audio bytes, and passed moving/nonblank-frame validation. Provider health and a later one-shot probe therefore prove eventual recovery, but they do not erase the visible stall captured by the persistent viewer.

## Recovery-Budget Rotation Finding

The recovery used the second and final permitted attempt for the original output generation. A deliberate owned stop/start was therefore required to leave Camera 5 protected by a fresh generation.

That maintenance rotation exposed a separate lifecycle defect:

1. LiveKit acknowledged the stop while the retiring Egress still appeared in its active list.
2. The old `stop-court.sh` immediately removed ownership and stop intent.
3. The following start correctly rejected the still-active job, preventing duplication.
4. Monitoring briefly saw an ownerless Egress and opened an `EGRESS_SUPERVISOR_FAILED` incident.
5. After the old job drained, a fresh generation started as `EG_RGyTYWLV8aBe` with zero recovery attempts used.

The stop path is now hardened to retain ownership and stop intent until LiveKit reports an empty active set. It fails closed on control errors, malformed responses, an unexpected active identity, or a 30-second drain timeout. The regression fixture covers a stop that remains active for multiple polls.

After the bounded maintenance rotation:

- the new generation was healthy with recovery attempts `0`;
- the browser was 1920x1080 HLS at 30 fps with zero drops/freezes/reconnects/reloads;
- YouTube was live/active/good with zero issues;
- no incident or fault gate remained; and
- a fresh external viewer probe advanced 8.041 seconds with 130,912 decoded audio bytes and moving nonblank frames.

## Protected Evidence

Evidence is stored outside Git under:

`~/.config/scorecheck/event-stack/events/reliability-physical-20260728/qualification-evidence/camera5-nonblack-recovery-preflight-20260729T091229Z`

The bundle includes the continuous viewer trace, pre/post viewer probes, 0.5-second compositor samples, monitor samples, exact fault timestamps, immutable owner evidence, the maintenance-generation rotation log, and the final fresh-generation viewer probe. Protected credentials and stream keys are not included in the report.

## Release Decision

- Keep the two-second/two-observation exact-owner supervisor timing.
- Require normal-latency YouTube destinations for production.
- Deploy the stop-drain ownership fix before the next deliberate output stop.
- Do not classify persistent-output recovery as fully production-qualified yet.
- Repeat the exact fault once against a fresh normal-latency destination using a clearly nonblack physical source. Require a viewer stall no longer than two seconds, continuous audio, exact one-publisher ownership, and no stop-drain or peer-camera incident.
