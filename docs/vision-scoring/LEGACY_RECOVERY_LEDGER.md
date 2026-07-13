# Legacy Vision Scoring Recovery Ledger

**Ledger date:** 2026-07-11

**Recovery source:** ScoreCheck commit `f2d0600a114114d500ededf287211935502d0974`

**Rescue reference:** `codex/rescue-live-score-f2d0600a`

**Related decisions:** [ARCHITECTURE.md](./ARCHITECTURE.md) · [DATA_CAPTURE_READINESS.md](./DATA_CAPTURE_READINESS.md)

This ledger records what is locally recoverable. It does not promote an artifact
into the new training or production lineage. Every later discovery must be
hashed, rights-reviewed, and linked to a manifest before use.

| Artifact class | Current disposition | Evidence | Required next action |
|---|---|---|---|
| Legacy source and tests | Preserved as archaeological reference | Rescue branch points to the complete surviving commit | Inventory licenses and selectively rewrite behavior; never merge wholesale |
| Rules concepts and cases | Accepted as requirements clues | `live_score/rules/beach.py`, event schemas, journal, replay and strict-scoring tests | Re-express in the new pure reducer and independent authorization layer |
| Dataset source registry | Quarantined metadata | `live_score/dataset_sources.json` lists 17 YouTube sources | Establish source ownership, contracts, availability, and commercial-use rights |
| Original video/media | Missing locally | No reproducible media set exists in the current checkout | Search local disks, cloud storage, annotation platforms, old worktrees, and backups |
| Reviewed detector labels | Missing/unverified | Handoffs mention only a 15-frame unverified snapshot | Locate exports and hashes; otherwise relabel from rights-cleared media |
| Serve/replay labels | Missing lineage | Handoffs mention 2,155 clips and a separate 1,053-item snapshot with unknown overlap | Recover manifests and source intervals or reject as training evidence |
| Dense ball/TrackNet labels | Missing | No dense label artifact or checksum survives | Recreate only after capture preflight and ontology approval |
| Model weights | Missing | No trusted `.pt`, ONNX, TensorRT, or equivalent artifact found | Search backups; quarantine anything recovered until lineage/license review |
| Calibration profiles | Missing/placeholder | Last readiness output identified placeholder calibration | Recalibrate actual deployment cameras; old values are not reusable by assumption |
| Experiment reports/metrics | Non-reproducible claims | Handoff numbers lack media, weights, split, code environment, and report hashes | Use only to seed failure tests; rerun every accepted benchmark |
| Compiled `.pyc` remnants | Rejected as source | Current legacy folder contains compiled remnants without authoritative source context | Do not decompile into the new codebase |
| Synthetic score replay | Accepted only as a rules fixture idea | The old 107-event replay reached expected set scores using conflicting semantics | Rewrite using strict first-serve seeding and assert every intermediate state |

## Recovered rule defects to preserve as regression requirements

- first serve semantics differed between strict and replay paths;
- same-team next serve could not distinguish a point from replay/no-point;
- non-final set-ending transitions could bypass terminal review;
- final-point safety depended on caller input rather than derived score state;
- side-switch and technical-timeout obligations were mutually exclusive;
- player service order was not implemented;
- several score/side/replay mutations were absent from the audit log;
- startup could purge raw history without rehydrating state;
- duplicate journal writes were not atomically idempotent;
- corrections were insufficiently constrained and undo could toggle state.

The new foundation already covers first-serve seeding, service order, replay,
side-switch confirmation, simultaneous timeout effects, terminal transition
validation, deterministic fold, idempotency, exact canonical-ruleset fingerprint
matching, strict signed human commands, protected per-match role policy,
authorizer countersignatures, and canonical state caching. Correction is
deliberately unsupported by the event schema, reducer, and authorization
allowlists; every correction must wait for a separately designed privileged
replay command that rebuilds and revalidates the immutable history. The reducer
still performs domain checks rather than authentication. Deployment
identity/session resolution and transactional persistence remain pending.

## Recovery intake procedure

For every newly found file or object:

1. copy nothing into the accepted corpus initially;
2. record original location, byte length, modification time, and SHA-256;
3. identify the owning person/entity and exact permitted uses;
4. identify source match, venue, camera, date, transform history, and related labels;
5. compare hashes and intervals for duplicates or overlap;
6. mark `accepted`, `quarantined`, or `rejected` with reviewer and reason;
7. assign dataset split at the source-match/domain-group level before extraction;
8. let training consume only immutable accepted manifest IDs.
