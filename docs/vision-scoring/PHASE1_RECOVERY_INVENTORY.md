# Phase 1 Recovery Inventory

**Inventory date:** 2026-07-11
**Legacy source:** branch `codex/rescue-live-score-f2d0600a`, commit
`f2d0600a114114d500ededf287211935502d0974`
**Disposition:** recovery candidates only; all media and derived artifacts remain
`QUARANTINED` with rights `UNKNOWN`

This document is the operational inventory for recovery. It does not repeat the
architecture or capture requirements in [ARCHITECTURE.md](./ARCHITECTURE.md) and
[DATA_CAPTURE_READINESS.md](./DATA_CAPTURE_READINESS.md). A discovered file is
not training data until its identity, lineage, rights, and split are accepted.

## Immediate result

The legacy source and tests are recoverable from Git. The legacy media, reviewed
labels, fine-tuned weights, calibrations, and reports are not in the current
ScoreCheck checkout or Git object history. A separate video audit indicates that
a large candidate corpus probably exists on the currently unmounted volume
`/Volumes/Nathan Footage`, but it has not been matched to the legacy system and
has no established training rights.

Do not train from the local social-media package or from any remounted footage
until the intake checklist below is complete.

## Evidence locations

| Evidence | What it establishes | Limitation |
|---|---|---|
| `codex/rescue-live-score-f2d0600a` at `f2d0600a` | Surviving legacy implementation, configs, tests, and handoffs | Generated `data/` content was ignored and is absent |
| [Legacy recovery ledger](./LEGACY_RECOVERY_LEDGER.md) | Initial disposition and known rule defects | Does not inventory the external footage volume |
| [External probe CSV](</Users/nathanhicks/Documents/Codex/2026-06-19/k/work/social_audit/all_non_scorecheck_video_probe.csv>) (`sha256:da5c14e12698ef5c67ac335b2f3b1516e2bf58dbed5f0567d41477ef86c3bd46`) | Previously probed video paths, dimensions, durations, codec, and read failures | It is a point-in-time derivative audit; many paths are on an unmounted volume |
| `/Users/nathanhicks/Documents/Codex/2026-06-19/k` | Approximately 12 GB of social-audit scripts, reports, reference renders, and derivatives | Edited/vertical/social outputs are not fixed-camera match ground truth |
| `/Volumes/Nathan Footage` | Reported source of most readable footage in the probe inventory | Currently unmounted; existence, hashes, and current readability are unverified |
| Connected Google Drive, `Beach Volleyball` folders | Cloud metadata for Virginia and North Carolina raw MP4/AAC groups | Connector can list metadata but returned HTTP 413 for the smallest video download; bytes, hashes, access rights, and capture quality remain unverified |

The probe CSV is readable and its header was checked. The supplied deduplicated
audit summary reports 32,957 probed paths and 29,174 readable videos. The CSV
itself contains auxiliary/error rows as well, so its raw line count must not be
used as the unique-asset count.

## External candidate-media snapshot

These numbers are discovery leads, not accepted dataset counts:

| Candidate slice | Reported inventory |
|---|---:|
| Readable paths on `/Volumes/Nathan Footage` | 25,632 files / 447.3 hours |
| Conservative volleyball-keyword candidate paths on `/Volumes/Nathan Footage` | 12,300 files / 369.0 hours |
| Keyword candidates, at least 10 minutes | 449 files / 242.9 hours |
| Keyword candidates, at least 30 minutes | 190 files / 163.2 hours |
| Keyword candidates, at least 60 minutes | 20 files / 50.1 hours |

The candidate counts use explicit volleyball/event keywords and intentionally
exclude the generic volume name; they are still heuristic, not content
classification. Prominent reported 4K groups include Texas **3RD COAST**, Missouri **Ozark**,
Florida **FUDS/SHAKA**, Virginia **Big Money**, and North Carolina footage.
These groups are high-priority for metadata-only triage after the volume is
mounted because they may provide venue/camera diversity. Their names and 4K
resolution do not prove fixed-camera suitability, match completeness, rights,
or capture quality.

### Connected Drive recovery lead

A read-only exact-name search found none of the missing legacy manifests,
weights, calibration profiles, or TrackNet artifacts. It did find two raw-video
families that correspond to paths in the external probe CSV:

| Cloud candidate | Metadata-only inventory |
|---|---:|
| Virginia `Big MoneyTVA` | 21 MP4 files / 144.00 GiB plus 21 paired AAC files, grouped under five match/finals names |
| North Carolina `March` | 11 MP4 files / 101.05 GiB plus 11 paired AAC files |
| Duplicate North Carolina folder | 8 same-name/same-size MP4 files / 75.43 GiB plus paired AAC files |

The connector rejected a raw fetch of the smallest Virginia MP4 (approximately
0.74 GiB) with HTTP 413. No cloud video bytes were downloaded, locally opened,
hashed, or accepted. The cloud records remain `REFERENCED_CLOUD`, `QUARANTINED`, and rights
`UNKNOWN`. A local Drive sync, authorized direct export, or the original volume
is required for byte-level preflight. Duplicate names and byte lengths are only
duplicate candidates until hashes match.

The Drive preview thumbnail for that 3:15 Virginia segment visually confirms
indoor sand volleyball from one horizontal, near-corner/diagonal court view:
four active players, a visible ball, and off-court people are in frame. This is
a promising compatibility/hard-negative candidate, but a preview does not
establish native resolution, frame cadence, fixed-camera stability, ball-pixel
distribution, full-match continuity, or transferability to outdoor deployment.

### Mandatory classification

- Rights for every external file are `UNKNOWN` until documentary evidence is
  reviewed for the exact intended use.
- Every file and derivative remains `QUARANTINED`; a public URL, possession of a
  recording, or event access does not imply model-training or redistribution
  permission.
- The 12 GB local social package is useful for locating originals only. Crops,
  social renders, edited highlights, reposts, audio-replaced files, and vertical
  exports must not be treated as ground truth or mixed with fixed-camera test
  data.
- Offline paths are not `FOUND`. They remain `REFERENCED_OFFLINE` until the
  original bytes are mounted, probed, and hashed.

## Recoverable Git material

The rescue branch contains 299 Python files under `live_score/`, including 115
test files, plus tracked profiles and handoffs. Recover selectively; never merge
the branch wholesale. It also contains unrelated generated output and 3,513
tracked `node_modules` files.

| Candidate concept | Rescue evidence | Phase 1 action |
|---|---|---|
| Source inventory and hashing | `live_score/data_registry/asset_registry.py`, `live_score/dataset/sources.py` | Rewrite its SHA-256/probe ideas behind the Phase 0 manifest; do not retain path-driven downloads or the shallow rights field |
| Dense temporal ball labels | `live_score/evaluation/tracknet_wasb_ball.py`, `live_score/tests/test_tracknet_wasb_ball.py` | Reuse ontology/test ideas for visible, occluded, absent, blur, hard-negative, and causal neighboring frames |
| Causal ball continuity | `live_score/perception/tracknet_ball.py` | Benchmark the acquisition-plus-local-temporal-bridge idea; do not inherit a missing checkpoint or old threshold |
| Active-player selection | `live_score/perception/active_players.py`, `live_score/perception/player_tracking_profile.py`, related tests | Rewrite service-corridor recovery, four-player cap, short role memory, bystander suppression, and pose-on-active-crops as isolated components |
| Court lock | `live_score/calibration/mmseg_court.py`, `court_primitives.py`, `temporal_lock.py`, related tests | Extract geometry and temporal-consensus cases into small modules; rerun with new labels and calibrations |
| Source-held-out evaluation | TrackNet, serve-cycle, model-benchmark, and leakage tests | Preserve match/venue/camera grouping and causal evaluation; replace all legacy metrics |
| Fail-closed scoring lanes | strict-scoring, live-scoring-gate, serve FSM, and replay tests | Port only safety scenarios into the new contracts; do not port the old reducer or direct score mutation |

Do not recover compiled `.pyc` files, legacy `locked` status claims, direct CV
score mutation, the old rules implementation, or unverified detector confidence
thresholds. The old player baseline also names `yolo11n.pt` and
`yolo11n-pose.pt`; those names are not artifact identity or license evidence.

## Exact legacy artifacts still missing

Search the remounted volume, backups, annotation exports, and object storage for
these exact paths or terminal names. A name match alone remains quarantined.

### Models and model lineage

- `data/models/volleyball_detection/volleyball_yolo26n_1280_v9_detector_review_1200_bootstrap_2ep/weights/best.pt`
- `data/models/court/mmseg_segformer_static_lock_v1/model_profile.json`
- `tracknet_lite_ball_model.pt`
- `tracknet_lite_ball_model.latest.pt`
- Any associated training configuration, source manifest, code commit,
  environment lock, seed, checkpoint hash, and model card

### Media, labels, and manifests

- `data/diagnostics/reviewed_serve_classifier/current_reviewed_manifest.json`
- `data/diagnostics/serve_contact_training_fullset_v2/training_manifest.json`
- `data/diagnostics/serve_contact_training_fullset_v2/asset_progress_download_next4_segmented/combined_review_manifest.json`
- `data/diagnostics/serve_contact_training_fullset_v2/serve_contact_next_readiness.json`
- `data/raw/serve_contact_sources/`
- `data/raw_video/`
- `data/labels/combined/beach_players_review.csv`
- `data/labels/combined/beach_balls_review.csv`
- Dense TrackNet frame-label manifests and their review-decision files
- The source media and interval lineage behind the reported 2,155-clip and
  1,053-item serve snapshots; their overlap is currently unknown

### Calibration and evaluation

- `data/calibration/serve_contact_sources/`
- `data/calibration/calibration_queue/`
- `data/artifacts/static_source_calibrations_combined_v6/calibrations/`
- `data/artifacts/player_pose_tracking_root_cause_fixes_v1/index.html`
- `data/diagnostics/court_boundary_production_readiness_2026_06_10/production_readiness.json`
- `data/diagnostics/court_boundary_production_readiness_2026_06_10/runtime_lock_report_plus_fan.json`
- `data/diagnostics/court_boundary_production_readiness_2026_06_10/source_heldout_current_best_plus_fan_summary.json`
- Smoke materializations, Parquet features, review decisions, split manifests,
  and reports that connect any metric to exact media and weights

The tracked 17-source YouTube registry is incomplete even as metadata: player
validation also cites `YtqYZieFmjk`, `4HWs0eJ25gs`, and `dGoPmeLYhN4`. Those
three IDs must be reconciled with the registry and rights ledger before use.

## Volume mount and intake checklist

### Before mounting

- [ ] Confirm the expected device/volume owner and obtain permission to inspect
  it for this project.
- [ ] Prefer a read-only mount for first inventory; do not rename, move,
  transcode, or repair files in place.
- [ ] Record UTC time, device identity/serial or volume UUID, filesystem, volume
  name, and the operator performing intake.
- [ ] Create a quarantine manifest location outside Git and outside the source
  volume; do not copy media into the repository.

### On mount

- [ ] Verify the mount is the expected `/Volumes/Nathan Footage` and record its
  immutable device metadata before relying on path names.
- [ ] Recheck a stratified sample of the probe CSV paths, then inventory metadata
  only: path, byte length, modification time, duration, resolution, frame rate,
  codec, audio presence, and read/probe error.
- [ ] Search first for the exact missing paths and terminal filenames above.
- [ ] Triage the long-form 4K groups by event, venue, court, date, camera
  position, full-match continuity, scoreboard visibility, and likely source
  ownership.
- [ ] Compute SHA-256 before copying or transforming any recovery candidate.
- [ ] Copy accepted-for-review bytes into content-addressed quarantine while
  retaining original path, volume identity, and hash; verify the destination
  hash.
- [ ] Detect exact and near-duplicate media, alternate transcodes, excerpts, and
  social derivatives. Link them to one immutable original rather than counting
  them as independent samples.

### Rights and lineage review

- [ ] Keep status `QUARANTINED` and rights `UNKNOWN` until owner/licensor,
  evidence, permitted purposes, model-training rights, redistribution rights,
  athlete/minor constraints, expiration, and reviewer decision are recorded.
- [ ] Match recovered legacy labels, calibrations, or reports to media by hash
  and time interval, not filename alone.
- [ ] Reject orphan labels or weights that cannot be tied to exact source data,
  code, environment, and split. They may inform test design but not benchmark
  claims.
- [ ] Assign exact `TRAIN`/`DEV`/`TEST` at the match plus venue/camera/day group
  before frame or clip extraction; synchronized views and derivatives inherit
  the same split. `DEV` is the validation/model-selection split and therefore
  influences the released artifact.

### Exit condition

Recovery is ready to hand into annotation or training only when at least one
candidate corpus has accepted rights, immutable source hashes, capture metadata,
source-group splits, an approved ontology, and reproducible derivative lineage.
Until then, Phase 1 may proceed with tooling and synthetic contract tests, but
all empirical training and performance claims remain blocked.
