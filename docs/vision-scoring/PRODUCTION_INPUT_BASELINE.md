# Vision Scoring Production Input Baseline

**Recorded:** 2026-07-12

**Status:** owner-reported deployment inventory and candidate media catalog;
not an accepted asset manifest, capture preflight, or rights decision

## Production stream family

The first deployment must be designed and benchmarked against the streams that
will actually reach the scorer-copilot, rather than against a 4K-first capture
assumption:

| Logical streams | Physical capture inventory | Transport | Video | Nominal encoded bitrate | Capability tier |
|---|---|---|---|---:|---|
| 1–2 | Two Mevo Core units | RTMP | H.264, 1920×1080 progressive, 60 fps | 6 Mbps each | Tier B: enhanced |
| 3–5 | Six AVKANS Go cameras contributing to three logical streams | SRT | HEVC, 1920×1080 progressive, 30 fps | 3 Mbps each | Tier A: compatibility/constrained |

The exact physical-camera-to-logical-stream mapping for the six AVKANS units
has not been supplied. No document, manifest, calibration, or synchronization
contract may invent that mapping. The nominal settings are planning inputs;
the ingest gateway must measure the exact codec parameters, cadence, timestamps,
drops, reconnects, resolution, and bitrate of each admitted asset or session.
Older branch material describes Maki H.264 cameras for logical streams 6–8;
that stale mapping is superseded by the owner's newer production statement and
must not be revived without a new attested inventory.

The existing streaming stack normalizes mixed H.264/HEVC inputs to
H.264/Opus 720p30 for preview, program output, and YouTube. The CV path must
branch from raw ingress or immutable native archival bytes *before* that
normalization. `courtN_program`, preview/program renditions, and YouTube
transcodes are derived compatibility and visual-QA strata, not substitutes for
the native 1080p input. Each derived rendition retains its own hash, media
identity, parent lineage, and transformation version.

Higher-resolution or higher-bitrate media may occasionally be available. It is
an optional challenger stratum, not the production baseline. A future consumer
streaming product must also accept retrospective or live 1080p footage from
phones and other consumer cameras. "Accept" means the system can ingest,
measure, classify, and either produce bounded assistive evidence or abstain. It
does not promise that every 1080p source makes every rally observable.

## Capability tiers

| Tier | Input class | Intended evidence | Required behavior |
|---|---|---|---|
| A: compatibility/constrained | 1080p30, including the nominal 3 Mbps HEVC/SRT profile and consumer/phone footage | Feasibility, rally segmentation, likely server/team evidence, review clips, and limited ball evidence where measured observability permits | Preflight by exact profile and condition; downgrade or abstain when ball size, blur, compression, occlusion, timing, or calibration is inadequate |
| B: enhanced | 1080p60, including the nominal 6 Mbps H.264/RTMP profile | More temporal samples for ball continuity and contact candidates, plus Tier A evidence | Same outcome gates; 60 fps is not proof of native cadence, short exposure, or useful ball pixels |
| Optional challenger | 4K and/or higher bitrate, single view | Measure whether added spatial detail materially improves held-out risk/coverage or operator workload | Do not require it for the product or call it the default until evidence justifies that constraint |
| Future synchronized multi-view | Two or more independently verified synchronized and jointly calibrated views | Occlusion recovery, triangulation, stronger contact/team attribution, advanced statistics | Separate synchronization, geometry, and fault-specific validation; no unattended referee claim |

Codec, transport, nominal bitrate, device, venue, lighting, placement, and
transcode history are benchmark strata. None is a support decision by itself.
Support is decided by exact-asset/session capture integrity and empirical
observability gates. A low-bitrate stream can be conditionally useful, and a
high-resolution stream can still be unusable because of blur, occlusion,
upscaling, stabilization, dropped frames, or compression.

These tiers do not change the V0 product boundary. Computer vision produces
evidence and hypotheses; an authenticated human remains the only source of an
authorized scoring event, and the vision shadow path has no official-score
mutation capability.

## Owner-declared candidate footage

On 2026-07-12, the project owner declared ownership of, and project-use
authorization for, all footage on these channels:

- [Colorado Cupcakes](https://www.youtube.com/@ColoradoCupcakes)
- [Beach Volleyball Videos](https://www.youtube.com/@BeachVolleyballVideos)

That declaration makes the channel material a candidate source catalog; it is
not an exact-asset `RightsDecision`. Public catalog examples observed on
2026-07-12 include these Denver recordings:

| Video ID | Catalog title |
|---|---|
| [`2zrOGgdzx0w`](https://www.youtube.com/watch?v=2zrOGgdzx0w) | Center Court Sunday |
| [`5UBnTp6lU-M`](https://www.youtube.com/watch?v=5UBnTp6lU-M) | Court 7 Sunday |
| [`nXOY-BhBJNo`](https://www.youtube.com/watch?v=nXOY-BhBJNo) | Main Draw Court 14 |
| [`VePG236baik`](https://www.youtube.com/watch?v=VePG236baik) | Main Draw Center |
| [`L715edQIstg`](https://www.youtube.com/watch?v=L715edQIstg) | Main Draw Court 7 |
| [`rBPLJcLKng8`](https://www.youtube.com/watch?v=rBPLJcLKng8) | Court 8 |
| [`Ndcd-fBI4wA`](https://www.youtube.com/watch?v=Ndcd-fBI4wA) | Qualifier Court 17 |
| [`rk4rj0XKBPk`](https://www.youtube.com/watch?v=rk4rj0XKBPk) | Qualifier Court 7 |
| [`R-BLBYBZjGg`](https://www.youtube.com/watch?v=R-BLBYBZjGg) | Qualifier Court 8 |

Before any bytes enter training, development evaluation, or locked testing,
each exact source still needs platform-compliant acquisition and the normal
admission evidence: immutable original/export bytes, SHA-256 and byte length,
source and derivative lineage, an accepted signed rights decision for the
intended use, participant and minor clearance where applicable, split identity,
and current annotation/capture authorities. Prefer an original master or
owner-authenticated export over a YouTube transcode. If a platform rendition is
needed to reproduce the deployed image-quality stratum, retain it as a separate
derived asset with exact acquisition and transcode provenance.

## Immediate empirical work

1. Register the exact Mevo and AVKANS encoder/transport profiles without
   guessing the AVKANS physical-to-logical mapping.
2. Branch CV capture before the 720p30 program normalization and prove the raw
   ingress/native archival lineage through the capture-integrity gateway.
3. Obtain owner-authenticated original/export files for a bounded Denver pilot,
   then create exact source manifests and accepted rights decisions.
4. Measure visible ball diameter, blur, compression artifacts, occlusion,
   frame continuity, cadence, timestamp behavior, reconnects, and court
   visibility separately for 1080p30 HEVC/SRT and 1080p60 H.264/RTMP.
5. Freeze codec, transport, bitrate, device, venue, lighting, and placement as
   benchmark strata before extraction; prevent match/root-asset/leakage-group
   overlap across splits.
6. Publish `pass`, `conditional`, or `unsupported` capability decisions. An
   unsupported profile stays manual; it is not rescued by lowering a safety
   threshold after seeing test results.
