# Vision Scoring Data and Capture Readiness

**Readiness:** blocked for rights-cleared empirical training and deployment
claims; the owned causal ball runtime is synthetic-smoke-tested only and scoring
work is V0 no-mutation shadow

**Date:** 2026-07-11

**Architecture:** [ARCHITECTURE.md](./ARCHITECTURE.md)

**Current evidence contracts:**
[CAPTURE_SEGMENT_ATTESTATION.md](./CAPTURE_SEGMENT_ATTESTATION.md),
[CAUSAL_BALL_BASELINE.md](./CAUSAL_BALL_BASELINE.md), and
[CAUSAL_BALL_LABEL_BUNDLE.md](./CAUSAL_BALL_LABEL_BUNDLE.md)

## Current verdict

The project does not currently have a reproducible training dataset, a real-data
checkpoint, a deployable model artifact, or a validated capture profile. An
owned causal ConvGRU ball architecture and loss runtime now exist. They have 15
PyTorch regression tests and a 50-step synthetic overfit smoke, but have never
seen beach-volleyball footage and have no export, latency, probability
calibration, or service result. The next empirical deliverable is trusted data
admission and a bounded real-data baseline—not an ungoverned long training run.

The legacy handoff is useful for finding failure modes and candidate labels. It is not a trusted baseline until its inputs, outputs, versions, splits, and metrics can be reproduced.

### What the legacy repository appears to contain

The following figures were recovered from an unreachable legacy commit and its handoff files. The corresponding media/artifacts are absent from the current checkout, so these are **claims to audit**, not accepted ground truth.

| Legacy item | Reported state | Readiness implication |
|---|---|---|
| Source registry | 17 YouTube source IDs; the first six represented 110,056 seconds (about 30.57 hours) | Source availability and training rights are unresolved |
| Detector review | 15 frames, 114 person boxes, 168 ball boxes; all reportedly unverified | Too small and unverified for evaluation |
| Serve review | 2,155 clips: 525 `serve_contact`, 181 `setup_no_contact`, 1,449 `not_serve` | Potential label lead; media, lineage, adjudication, and split are missing |
| Separate serve chunks | 1,053 items: 358 contact and 695 non-serve; 7/9 chunks processed | Overlap with the prior snapshot is unknown |
| TrackNet plan | 1,500–3,000 intended dense labels | No surviving labeled set, model card, or weights found |
| Player validation | 2,700 frames, 441 identity switches, approximately 99.7% pose-row coverage | Coverage did not establish identity or keypoint/contact correctness |
| Court validation | 30-frame old YOLO report, mean quad IoU about 0.948 | Predated the last architecture and does not validate current calibration |
| Strict serve smoke | Strict recall 0 at strict coverage 0 | Abstention produced safety without usefulness |

There is no discovered DVC/LFS lineage, remote artifact inventory, durable checksums, or reproducible map from source video to labels, split, model, calibration, and report. Treat every legacy asset found later as quarantined until it passes the intake process below.

## Gate 0: preserve and inventory

Before model work:

1. Keep legacy commit `f2d0600a114114d500ededf287211935502d0974` anchored to rescue branch `codex/rescue-live-score-f2d0600a` so Git garbage collection cannot remove it.
2. Search local disks, cloud buckets, annotation tools, prior worktrees, and backups for videos, label exports, weights, calibrations, reports, and environment locks.
3. Hash every recovered artifact before opening or transforming it.
4. Build a recovery ledger with `found`, `missing`, `corrupt`, `duplicate`, `rights_unknown`, `quarantined`, or `accepted` status.
5. Never restore generated assets into Git history. Use content-addressed object storage plus a versioned manifest.

Exit condition: every referenced legacy asset has a disposition, and the rescue reference plus recovery ledger exist. Recovery can continue later, but unknown legacy data cannot enter a training run.

The initial recovery ledger is [LEGACY_RECOVERY_LEDGER.md](./LEGACY_RECOVERY_LEDGER.md).

## Data provenance and rights

A public URL or the ability to download a video does not grant commercial model-training, redistribution, biometric/pose-analysis, or derivative-dataset rights. Athlete likeness, venue agreements, broadcaster ownership, music/audio rights, and youth participants require explicit review.

Every source asset must have a manifest record containing at least:

| Category | Required fields |
|---|---|
| Identity | `asset_id`, original URI/device ID, SHA-256, byte length, acquisition timestamp |
| Rights | owner/licensor, evidence document, permitted purposes, redistribution/model rights, expiration, geography, participant/minor constraints, reviewer, decision |
| Match | event, venue, court, date, match/set, teams, competition level, official-score source |
| Capture | camera/lens/position, resolution/fps, shutter/exposure if available, codec/bitrate, audio, PTS/timebase, transcode history |
| Geometry | calibration ID, named court points, lens model, camera-motion segments |
| Lineage | parent asset hash, extraction command/version, annotation-set version, reviewer/adjudicator |
| Split | immutable match/venue/camera/day group and exact `TRAIN`, `DEV`, or `TEST` assignment (`DEV` is validation/model selection) |
| Status | quarantine/accepted/rejected, validation failures, retention/deletion date |

Rules:

- Training and evaluation jobs accept only manifest IDs, never arbitrary paths.
- The complete canonical manifest is detached from caller-owned memory, signed
  by a trusted dataset curator, checked against the sole current manifest for
  that dataset, and revalidated on the actual UTC date. A payload enum or hash
  without the separately pinned signature/current-manifest store is not trust.
- Readiness manifests are hard-cut to schema `2.0`, and reports to schema
  `3.0`. Every source binds `labels_sha256` as its exact
  `BallLabelPackRootV1` hash plus `label_pack_generation_id`; old schema and
  omitted fields are blockers.
- Every declared media, calibration, camera-attestation, clock-verification,
  and encoder artifact must be resident in the exact protected media/capture
  generation derived from its digest set. Labels are excluded from that
  artifact proof and reconstructed from a distinct protected label store.
  Syntax-only checks cannot produce `ready=true`.
- One killable worker loads the complete source-bound label-pack batch. It is
  capped at 512 packs, 1,000,000 verified contract objects, 4 GiB verified
  contract bytes, and a 3,600-second post-start monotonic verification/result
  deadline. A structurally
  verified TRAIN, DEV, or TEST pack grants no training, evaluation, TEST,
  deployment, or live-scoring admission.
- The trusted launcher loads one protected configuration generation per
  single-use validation and rechecks its current pointer at completion. A
  concurrent policy, key-compromise, current-manifest, decision, or revocation
  publication invalidates the run. Publisher rollback is forbidden.
- Published content generations are atomically renamed and never mutated.
  Consumer UIDs have read-only filesystem access, cooperative shared locks are
  held through verification/consumption, and every training/evaluation consumer
  reacquires the generation and independently stages/hashes bytes before use.
- The protected readiness policy—not the dataset—pins unseen-TEST-venue
  enforcement, the rights policy, source-tree commitment, trusted-launcher
  deployment artifact, executing runtime identity, governance domain, and
  validity window.
- Rights must be `accepted` for the exact intended use; `unknown` is a hard failure.
- TRAIN and DEV both require deployment permission because training, tuning,
  early stopping, and model selection all influence the released artifact.
- Split assignment happens before clip/frame extraction. Every derivative inherits the parent's split.
- Test assets and labels are access-controlled and rejected by training jobs.
- Original media is immutable. Derived artifacts reference parent hashes and transformation versions.
- Annotation corrections create a new dataset version; they do not overwrite history.
- Passing manifest/artifact intake is necessary but not semantic-label approval.
  Each task-specific training/evaluation entry point must parse its exact label
  bytes into the strict annotation contracts and verify every declared
  reviewer/adjudicator signature, current annotation fingerprint, revocation,
  evidence file, evaluator identity, and minimum truth policy before use.
- A pre-V2 loose `labels_sha256` and a declared coverage manifest did not, by
  themselves, prove complete decoded-frame or all-localizable-ball enumeration.
  `CausalBallLabelBundleV1` adds a curator-signed
  `COMPLETE_FULL_DECODED_FRAME` claim for one bounded derived asset and binds
  every frame to exact Annotation Truth V2 preimages and attestations. It
  authenticates only the curator's enumeration assertion; it does not
  objectively prove source-frame completeness. Its receipt keeps training,
  evaluation, deployment, and live-scoring admission fixed to `False`; source
  residency, derivation, rights, pixel truth, annotation truth, and capture
  lineage remain independently gated.
- The implemented V2 readiness bridge authenticates each exact pack root,
  generation, source asset, and split and emits compact structural proofs only.
  See [READINESS_LABEL_PACK_GATE.md](./READINESS_LABEL_PACK_GATE.md) for store
  separation, cross-generation alias, worker, and report invariants.
- A trusted single-use training launcher and immutable media lease must
  reverify the exact current readiness, rights, derivation, split, annotation,
  label-bundle, and source-byte authorities before any trainer can consume the
  data. That launcher does not exist yet.
- Model cards list source-manifest versions, code commit, environment lock, seed, hyperparameters, weights hash, and evaluation report hash.
- All leakage identities are bounded ASCII-stable IDs; lineage traversal is
  iterative and record-count bounded, so Unicode aliases and deep recursive
  chains cannot bypass or crash split validation.
- Pretrained weights and source code are separate artifacts with separate licenses. Dataset terms do not follow automatically from a code license.

## Capture tiers

| Tier | Minimum capture | Intended use | Release limitation |
|---|---|---|---|
| A: compatibility | One fixed 1920×1080 camera at 30 progressive fps plus synchronized audio | Feasibility, server identity, delayed assistive review, and no-mutation shadow, but only if the exact footage is recovered, rights-cleared, released, and observable | Historical profile only; no current feed is established, and it is never eligible for an official score mutation or referee claim |
| B: assistive baseline | One fixed 3840×2160 camera at 59.94/60 progressive fps, native-resolution recording, synchronized audio | Ball continuity, contact candidates, rally/server/team attribution, statistics | Occluded/depth-dependent and terminal cases remain human-authorized |
| C: multi-view | At least two genlocked or independently verified synchronized 4K60 cameras with joint calibration | Occlusion recovery, triangulation, stronger contact attribution | Still requires fault-specific validation before referee support |

Camera placement is not prescribed yet. A high centered end-line view, diagonal view, and side view have different line visibility, depth, net-plane, and player-occlusion tradeoffs. Select placement from measured observability maps at representative courts, not preference.

## Capture preflight

Run the preflight for every camera/lens/encoder/placement profile and again whenever the camera moves. Record source-native frames; a stream transcode may be tested separately but must not replace the archival capture.

Collect at least:

- an empty-court calibration sequence and surveyed/named court points;
- serves and rallies covering near/far corners, sidelines, end lines, high arcs, net play, dives, and player occlusion;
- hard negatives such as heads, spectators, glare, white/yellow clothing, logos, posts, lines, spare balls, and adjacent courts;
- a lighting/noise range representative of deployment, including transitions if outdoor;
- audio containing ball contacts, whistles, speech, wind, music, and crowd noise;
- reconnect, dropped-frame, and clock-drift tests;
- at least 1,000 stratified decisive-event windows, plus a continuous
  two-hour-or-longer capture soak for every production profile;
- for multi-view, a synchronization and joint-calibration sequence across the whole court volume.

### Provisional engineering gates

These thresholds are **engineering assumptions for the first experiment**, not published universal truths. They must be challenged with outcome data and replaced by measured operating limits. Passing them means “worth benchmarking,” not “safe to score.”

| Measurement | Tier A: 1080p30 assumption | Tier B: 4K60 assumption | Why it exists |
|---|---|---|---|
| Visible-ball diameter after production preprocessing | 10th percentile at least 6 pixels | 10th percentile at least 10–12 pixels | Below this, center/blur/contact evidence becomes dominated by sampling and compression |
| Preprocessing | Native-resolution ROI or overlapping tiles; no global 640-wide resize | Native-resolution ROI or overlapping tiles | Preserves the small target |
| Ball motion blur | 95th-percentile streak no more than 2 apparent ball diameters | 95th percentile no more than 1 apparent ball diameter | Forces exposure/lighting tradeoff to be measured; temporal blur modeling still remains necessary |
| Decisive-event observability | At least 1,000 stratified windows; report usable observed positions | Same; provisional 10th percentile at least 3 observed positions for an eligible ordinary event | Prevents average visible-frame results from hiding unobservable outcomes |
| Native source | Device/encoder configuration attested; no interpolation or lower-resolution upscale | Same | A 4K/60 label does not prove native photons or cadence |
| Frame integrity | No unexplained timestamp reversal, critical drop, or frozen/duplicated sequence in decisive windows; no unmarked reconnect | Same | Temporal evidence is invalid without a trustworthy clock |
| Audio/video alignment | Absolute error and drift within one frame (33.3 ms) over a 10-minute test | Within one frame (16.7 ms) over a 10-minute test | Contact audio is only useful when time-aligned |
| Court visibility | All four court corners, lines, net intersections, and both service zones visible with recorded occlusion map | Same | Calibration and side/service reasoning need stable landmarks |
| Ground-plane calibration check | 95th-percentile surveyed-checkpoint error at or below 5 cm in the playable area | Same initial target | Adequate for geometry features; **not authorization for line calls** |
| Image reprojection check | 95th-percentile independent holdout error at or below 2 pixels | Same initial target | Detects a calibration that appears plausible but misses image evidence |
| Fixed-camera stability | Drift monitor remains within the calibration check; zoom/stabilization crop is disabled or explicitly modeled | Same | Prevents stale geometry |

For Tier C, the provisional cross-camera timestamp target is at most 2 ms and must be verified under motion, not inferred from device settings. Joint 3D residuals and rolling-shutter effects determine the final acceptable limit.

Use shutter, aperture, gain, lighting, focus, codec, and bitrate as controls to satisfy measured size/blur/noise gates. Do not use “4K” or a bitrate number as a proxy for usable ball pixels. If low light cannot meet the blur gate without destructive noise, that deployment profile is unsupported and the system must remain manual.

### Preflight report

Produce one immutable report per capture profile containing:

- ball-size, blur-length, visibility, compression, and occlusion distributions by court zone;
- frame-drop, duplicate, PTS-monotonicity, reconnect, and A/V-drift results;
- court reprojection and physical checkpoint errors;
- representative native crops, not only resized screenshots;
- camera/lens/settings diagram and calibration hashes;
- a clear `pass`, `conditional`, or `unsupported` decision with failed assumptions.

## Annotation contract

Annotation is temporal and uncertainty-aware. Do not turn every ambiguous frame into a false exact label.

Keep four truth layers distinct throughout collection, review, and evaluation:

1. **Media truth** records the exact captured bytes, stream/frame/sample timing,
   decode identity, and capture-integrity state.
2. **Observational truth** records only what a reviewer can see or hear,
   including explicit occluded, indistinguishable, and capture-unknown states.
3. **Physical adjudication** records an expert conclusion about what physically
   happened and may remain unresolved or use an uncertainty interval.
4. **Official/legal truth** records the authenticated referee/scorer decision
   under one exact ruleset. It is not rewritten to agree with physical evidence.

An inconclusive review that leaves an official call standing therefore creates
different physical and official labels; neither may overwrite the other.

| Layer | Required labels |
|---|---|
| Ball | Full selected-stream/decode identity; center or exactly one blur representation; visible/occluded/out-of-frame; apparent size; ambiguity; track segment; pixel-equivalent versus capture-attested duplicate classification |
| Players | Box/mask as needed, rally-local identity, team, physical side, active/non-active player, occlusion/truncation |
| Pose/contact | Visible keypoints with visibility, candidate hand/arm contact interval, contacting player/team, ambiguity window; label selectively around events |
| Court | Named keypoints, line masks, playable polygon, posts, net/antenna geometry, lens-distortion and camera-motion segment |
| Temporal events | Set start, serve preparation, serve contact, rally start/end, candidate contacts, bounce/dead ball, next authorized serve, replay, challenge, reported administrative point, correction, terminal point, side switch |
| Audio | Contact transient, whistle, speech/crowd/music/wind hard negative, uncertainty interval |
| Rules truth | Official rally winner, event reason, service order, set/match state after every authorized event, adjudicator and evidence source |

Scoreboard OCR and audio may create weak labels or surface review candidates. They are never sole evaluation truth. Two reviewers adjudicate event boundaries, replay/administrative cases, and any disagreement that affects scoring. Store label uncertainty as an interval rather than forcing an exact contact frame.

Preserve a governing-body/referee source's original sanction, default,
misconduct, service-order-fault, or correction label instead of collapsing it
into a generic training target. These may be annotation truth and review
strata, but none maps to a V0 rule event. The reducer and authorization
allowlists support only the five explicitly documented human-authorized event
types; administrative remedies and corrections remain unsupported.

## Initial dataset design

The first benchmark tranche is intentionally source-diverse:

- 12–16 rights-cleared full matches spanning at least six venue/camera/lighting condition groups;
- at least two entire venue/camera groups locked as test holdouts before extraction;
- 30,000–60,000 densely labeled ball frames sampled as continuous clips, not independent easy frames;
- at least 100 serve sequences, 100 difficult rallies, and 50 replay/interruption/terminal/hard-negative sequences;
- near/far-zone, blur, occlusion, low-light, compression, adjacent-court, and spare-ball strata explicitly represented;
- additional player/pose labels selected to answer measured failure modes rather than satisfy an arbitrary box count.

Split only by match plus venue/camera/day group. Never place adjacent frames, clips from the same rally, alternate transcodes, or synchronized views of the same match into different splits.

Use active learning only after the initial stratified seed exists. Sample uncertainty, model disagreement, rare strata, identity switches, and false-score-risk cases; continue to reserve randomly sampled negatives so the loop does not collapse onto unusual failures.

## Required first perception experiment

The scorer-copilot control plane, authenticated authorization boundary, local
transactional shadow sink, append-only ScoreCheck receipt store, and fixed
receipt-prefix replay now exist. The rights-cleared intake path is not complete,
and ScoreCheck still lacks its external rollback checkpoint, real deployment
role mapping, target resolver, endpoint, UI, and live integration. The owned
causal ball runtime is ready only as a synthetic-tested implementation baseline.
The first event-fusion baseline remains a transparent constrained factor
graph/HSMM; learned TCN/GRU event fusion is a challenger after that baseline is
reproducible. The ball model's ConvGRU is not an event-fusion implementation.

Run one controlled matrix before selecting a trained production ball model:

| Dimension | Planned empirical variants | Current runtime state |
|---|---|---|
| Ball family | Owned causal temporal heatmap; WASB-derived baseline; BlurBall-style blur head; D-FINE-S; RT-DETRv2-S | Only the owned causal ConvGRU heatmap/attribute runtime exists, synthetic-smoke-tested with no real checkpoint. Every external family remains planned. |
| Input | Global 640 control; native ROI; overlapping source-resolution tiles | Base tensor runtime exists; ROI/tiling merger and empirical input comparison do not. |
| Temporal context | 1, 3, 5, and 9 causal frames at both 30 and 60 fps | Architectural prefix-causality is tested; no real-data comparison exists. |
| Capture | Tier A 1080p30 and Tier B 4K60, including matched downsample pairs where possible | No current rights-cleared, preflight-approved feed exists for either tier. |
| Fusion ablation | Ball only; +court; +players/tracks; +selective pose; +audio; +rules context | Planned only. |
| Generalization | Seen-condition validation; held-out venue/camera; held-out lighting/compression | Planned only; no real split or empirical result exists. |

The global-640 variant is a control, not the assumed deployment choice. Reject a more complex candidate if it does not improve held-out event-level risk/coverage or if its runtime prevents the latency budget.

## Metrics

Report point estimates, confidence intervals where meaningful, per-condition slices, and raw error examples.

| Layer | Required metrics |
|---|---|
| Ball | Precision/recall/F1 at a preregistered operating-confidence threshold; AP101 over the full confidence ranking; center error in pixels and apparent ball diameters; negative-frame activation count/rate on negative-only suites; visibility accuracy; track gap length; slices by apparent size, blur, occlusion, zone, venue, and light |
| Player/tracking | Detection AP, HOTA, IDF1, identity switches per player-minute/rally, team and side attribution |
| Pose/contact | Keypoint accuracy for visible points; contact-team and contact-time precision/recall at ±1, ±2, and tolerance windows |
| Court | Reprojection error and surveyed physical error by court zone; drift-detection delay and false alarms |
| Events | Precision/recall/F1 for serve, dead-ball, replay, next-server, terminal, and team attribution; event latency |
| Calibration | Reliability diagram, ECE/Brier or appropriate alternative, and accuracy-versus-coverage/risk-versus-coverage curves |
| Rules | Exact state after every event, complete-match score accuracy, illegal transition count, canonical ruleset-fingerprint rejection, pending-obligation audit behavior, rejection of unsupported event classes, and replay determinism |
| Product | False human-authorization-ready assessments per 1,000 eligible rallies and per match; review/abstention rate; proposal override rate; p50/p95 evidence-to-assessment latency; median operator actions and review time per rally; scorer error rate, missed-exception rate, and automation-bias errors versus an unaided manual-scoring control |

The live inference target is initially p95 at or below two seconds after the
decisive primary evidence, using the bounded 0.5–2 second buffer. Independent
next-server reconciliation is inherently delayed until the next authorized
serve; report that delay separately rather than hiding it in model latency.

## Release gates

Gates are cumulative. A schedule, demo, or high subsystem AP cannot waive them.

### 1. Provenance gate

- 100% of used assets and derivatives have accepted rights, hashes, lineage, split, and review state.
- Every ball-training clip has a current curator-signed
  `CausalBallLabelBundleV1` that authenticates the curator's bounded
  full-decoded-frame/all-ball enumeration claim, plus independently current
  Annotation Truth V2, source, derivation, rights, and immutable-media evidence.
  A bundle receipt alone is never admission or objective completeness proof.
- Environment, code, weights, calibration, and report hashes reproduce the evaluation.
- Every event/evaluation run records the exact canonical ruleset SHA-256 (including reducer semantics version) and reducer artifact/container/commit digest, not only a human-readable ruleset id/version.
- No train/test family leakage is detected.

### 2. Capture gate

- The exact deployment profile passes its preflight under representative lighting and load.
- Failure injection proves timestamp, reconnect, calibration, and model failures block proposals.
- Manual scoring remains usable independently; once authenticated upstream, human/referee point entry can continue while side-switch or timeout obligations remain latched.

### 3. Offline model gate

- The candidate beats declared baselines on locked held-out conditions at the event/product level, not only detector AP.
- Risk/coverage is calibrated on validation and reported unchanged on the locked test set.
- Every supported and unsupported condition is documented in a model/capture card.
- Full-match replay produces zero illegal reducer transitions.
- Tests show next-server evidence never promotes a policy status:
  corroboration leaves the primary result unchanged, contradiction or a
  service-order conflict requires review, and same-server ambiguity cannot
  remove human handling.
- Tests show exception signals are screened before point optimization and
  cannot enter the assessment-assisted authorization path.
- Tests reject every administrative, correction, or otherwise unknown event
  type at both the domain parser and authorization boundary.

Absolute subsystem thresholds beyond the preflight assumptions are intentionally not invented here. Pre-register them after the first baseline, before opening the locked test set.

### 4. Authorization and persistence gate

The reducer accepting a domain-valid event does not satisfy this gate. The
signed human-authorization contracts and local transactional shadow store
exist, but the complete deployment gate still requires these external trust
controls:

- resolve a human identity/session to a protected per-match scorekeeper,
  referee, or match-admin key; V0 contains no model or service principal;
- require an exact signed human `AuthorizationCommand`; for the assisted path,
  require the exact separately signed eligible `PolicyAssessment` and preserve
  its model/evidence provenance;
- verify the fixed role/event allowlist, command lifetime, nonce, expected
  revision, event/rally context, ruleset, policy generation, and both human and
  authorizer signatures before reduction;
- load the authorization archive through an externally rollback-protected
  configuration boundary and pin its fingerprint. Retain exact historical
  policy generations, but apply current key revocations when replaying their
  envelopes;
- compute the effective ruleset's canonical SHA-256, persist it in match state,
  and reject exact mismatches;
- within one transaction, lock the match sequence and idempotency key, reverify
  the envelope, replay the complete canonical event history, compare every
  cached state byte-for-byte, run the reducer, and atomically append the
  authorization proof, event, state, idempotency result, and shadow outbox row;
- protect a monotonic database checkpoint or trusted backup generation outside
  the database. An internally consistent rollback of the database and policy
  archive cannot be detected from their contents alone;
- pass forged key/role, changed payload, changed ruleset parameter, untrusted or
  rolled-back policy, revoked historical key, duplicate/conflict, stale
  sequence, concurrent append, state-cache tamper, and storage-failure tests.

The domain event contains no identity, role, permission claim, or signature;
those belong only to the signed outer envelope. Exactly five event types are
accepted: `SET_SEED`, `POINT_AWARDED`, `REPLAY_NO_POINT`,
`SIDE_SWITCH_CONFIRMED`, and `TECHNICAL_TIMEOUT_COMPLETED`. Administrative
points, service-order remedies, sanctions/defaults/discipline, and corrections
are unsupported.

### 5. Shadow gate

- Run on complete live matches with no credentials capable of official mutation.
- Keep ScoreCheck as the existing official manual-score surface. The
  authenticated append-only receipt store and fixed
  `VERIFIED_RECEIPT_PREFIX` historical replay are implemented, but no vision
  endpoint or UI exists. Before live use, add an externally protected monotonic
  ScoreCheck receipt checkpoint, prove the real Supabase/PostgREST/JWT-to-role
  mapping, and provide a separately protected target resolver. None grants an
  official-score mutation path.
- Record every hypothesis, optional reconciliation, assessment, abstention,
  signed human ruling, late/corrected annotation truth, outage, and version
  boundary.
- Exercise all five supported event types plus reconnects, terminal points, and
  adverse weather/lighting.
- Retain correction, challenge, administrative, sanction, default, and
  discipline cases as review/evaluation strata only; they cannot produce a V0
  event.
- Reparse, reverify, and replay the complete immutable authorized-event history
  on every audit. Treat derived state as a cache and compare it byte-for-byte.

### 6. Evidence required before considering any post-V0 official path

V0 is shadow-only and contains no automated event origin or ScoreCheck mutation
credential. The following are research evidence, not implementation permission:

- zero false human-authorization-ready assessments across at least 3,000
  independently adjudicated eligible opportunities;
- exact shadow score after every human-authorized event and zero illegal
  reducer transitions;
- useful coverage reported beside safety, with event- and condition-level
  slices;
- terminal points, replays, challenges, corrections, administrative cases, and
  identity uncertainty reported separately;
- no authorization-ready assessment during any integrity, calibration, model,
  or version failure;
- signed human authorization, transactional shadow append, complete replay,
  rollback protection, and canonical ruleset matching remain healthy under
  failure injection;
- a separate architecture and security review plus explicit owner approval for
  any new official mutation design.

With zero observed errors, the binomial “rule of three” gives only an
approximate 95% upper error bound of `3/N`, or 0.1% at 3,000 observations. Real
rallies are correlated by venue, camera, and weather, so 3,000 is an initial
study gate—not proof of perfection. Continue to report venue-clustered results.

## 30/60/90-day sequence

| Window | Work | Exit decision |
|---|---|---|
| Days 0–30 | Preserve/inventory legacy artifacts; resolve rights; choose object manifest/versioning; hard-cut hypothesis/policy/authorization contracts; implement scorer-copilot review, signed transactional shadow event log, outbox, and deterministic replay; validate canonical ruleset fingerprint, five-event allowlist, and unsupported-event rejection; test camera placements; run Tier A/B preflights; lock dataset groups | Demonstrate a no-mutation control plane and select a supported capture/label plan, or stop and redesign |
| Days 31–60 | Complete the first benchmark tranche; establish constrained factor-graph/HSMM and simple vision baselines; then run the justified ball/detector/tracker/pose/calibration challengers and calibrated abstention studies; replay complete matches; publish model/capture cards and error taxonomy | Select a production baseline and challenger only if held-out product and event-security tests justify them |
| Days 61–90 | Operate one court in no-mutation shadow; harden operator review and audit replay; accumulate independent eligible cases; test failure injection; decide whether dual-camera value justifies cost | Approve continued shadow, human-confirmed assistive research, or redesign; V0 has no official mutation path |

If adequate rights-cleared diversity, preflight quality, or 3,000 eligible opportunities are unavailable by day 90, remain in shadow. The deadline is not a reason to relax the architecture.

## Stop conditions

Pause and redesign instead of collecting more of the same data when:

- the ball fails the provisional size/blur gate across meaningful court zones;
- held-out venue performance collapses despite stratified data and realistic augmentation;
- same-server replays cannot be separated at the required precision;
- team/side identity errors dominate scoring risk;
- one-camera occlusion makes decisive evidence unobservable;
- rights prevent retaining or training on the footage needed for deployment;
- operator review burden remains comparable to manual scoring at the required safety level.

Those outcomes are useful architecture evidence. They point to a camera, synchronization, product-scope, or human-workflow change—not automatically to a larger model.
