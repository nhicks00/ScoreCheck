# Camera 5 Real YouTube Backup Handoff Gate

Date: 2026-07-29

Scope: Camera 5's existing unlisted live broadcast and reusable YouTube stream, its normal primary compositor, the warm spare publishing to YouTube's real backup RTMPS endpoint, and one uninterrupted external viewer.

## Verdict

**Backup ingestion compatibility passed. Provider continuity passed. Viewer continuity failed.**

YouTube accepted the same stream key on its backup RTMPS endpoint, remained `active` and `good` with zero configuration issues while the primary publisher was absent, and kept the unlisted broadcast live and recording. ScoreCheck admitted exactly one Egress on each participating host and restored the original primary ownership without a duplicate on either host.

The viewer nevertheless stalled for 5.997 seconds during the primary-to-backup transition. Removing the backup after restoring the primary caused another 3.501-second not-ready interval and a 0.386-second playhead rollback. The handoff therefore fails ScoreCheck's two-second viewer-continuity requirement even though every YouTube provider signal stayed green.

## Code Contract Proven Live

YouTube returned a backup address ending in the exact query `?backup=1`. Commit `d3346358e` permits that one provider-defined query only for the backup RTMPS address. Primary addresses still reject queries, and backup addresses reject credentials, fragments, extra parameters, or any value other than `backup=1`.

The compositor's existing destination construction appends `/<stream-name>` to the complete base address. The live Egress successfully used that contract, proving that the compatibility change is correct without weakening the protected assignment boundary.

## Transition Timeline

| Event | UTC |
| --- | --- |
| Continuous viewer started | 09:49:01.536 |
| Backup Egress `EG_RrZjgJdrzpVA` started | 09:49:41 |
| Primary stop began/completed | 09:50:30-09:50:33 |
| First viewer stall began | 09:50:39.763 |
| Viewer resumed | 09:50:45.760 |
| Provider verified backup-only active/good | 09:50:58.331 |
| Replacement primary `EG_XB86jrihPWwt` started | 09:51:00 |
| Both hosts verified healthy | 09:51:32.263 |
| Backup stop requested | 09:51:43.368 |
| Backup active set empty | 09:52:00 |
| Second not-ready interval | 09:52:08.756-09:52:12.257 |
| Viewer playhead moved backward | 09:52:12.507 |
| Provider verified primary-only active/good | 09:52:32.250 |
| Retired reader drained | 09:52:45.289 |
| Continuous viewer completed | 09:52:54.183 |

## Viewer Evidence

The uninterrupted viewer captured 932 samples over 232.611 seconds:

- zero dropped trace samples;
- 260 ms maximum sampling gap;
- 5.997 seconds maximum playhead stall;
- 39 not-playback-ready samples;
- 222.231 seconds of playhead advance;
- 3,631,521 decoded audio bytes;
- zero audio counter resets; and
- one 0.386-second playhead regression.

The two failure intervals correlated with changing which YouTube ingestion endpoint remained active. Provider status was not sensitive enough to expose either viewer-visible interruption.

## Root-Cause Boundary

The evidence proves that the ScoreCheck assignment, ownership, and provider APIs worked. It does not prove a fault in either RTMPS connection. A stronger current hypothesis is that two independently started browser/Egress encoders were not frame-locked or timestamp-aligned, so YouTube's endpoint switch exposed a media-timeline discontinuity. That remains a hypothesis; this gate did not capture encoder timestamp equivalence deeply enough to certify it.

The important architectural result is measured: the already accepted normal-latency single-output supervisor recovery produced a 752 ms viewer stall, while the dual-publisher handoff produced a 5.997-second stall and timeline rollback. Adding a backup publisher is therefore not a reliability improvement for ordinary coverage in the current architecture.

## Cleanup And Final State

- The backup Egress stopped cleanly and the spare returned to zero active Egresses and `IDLE`.
- The protected backup assignment was hash-verified before removal and is absent remotely.
- Camera 5's restored primary Egress is `EG_XB86jrihPWwt`, supervisor `HEALTHY`, with zero recovery attempts used.
- The program path drained from three readers to its expected two readers.
- The reusable stream and unlisted broadcast remained active, good, live, and recording with zero issues.
- A fresh post-cleanup viewer probe passed with 8.060 seconds of playhead advance and 130,938 decoded audio bytes.
- Camera 5 remained healthy and no incident or fault gate remained.

## Protected Evidence

Evidence is stored outside Git under:

`~/.config/scorecheck/event-stack/events/reliability-physical-20260728/qualification-evidence/camera5-real-youtube-backup-20260729T094847Z`

The bundle includes the full viewer trace, phase markers, provider observations, exact Egress ownership, reader drainage, assignment cleanup, post-cleanup viewer proof, and machine-readable `summary.json`.

## Release Decision

- Keep commit `d3346358e`; the exact YouTube backup endpoint is now supported and validated.
- Do not advertise or automatically use YouTube backup ingestion as transparent failover.
- Retain it only as an operator-controlled emergency redundancy option until a later synchronized-encoder design independently meets the two-second viewer budget.
- Prefer the simpler normal-latency exact-owner single-output supervisor for current production recovery.
- Do not spend the next release cycle engineering frame-locked dual encoders unless later full-event evidence shows that the accepted single-output recovery is insufficient.
