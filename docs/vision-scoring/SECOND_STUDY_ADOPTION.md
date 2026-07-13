# Independent Architecture Study: Adoption Record

**Study received:** 2026-07-12
**Decision recorded:** 2026-07-12
**Source:** owner-reported ChatGPT GPT-5.6 Sol Pro architecture study
**Source artifact:** SHA-256
`7c5249ae4d8b92f332ee2aa8280da7633171c61e715fca11464a71f8f7233f6d`;
94,492 bytes; 1,905 lines
**Source caveat:** the supplied artifact does not self-identify the model. The
model name is Nathan's corrected owner report after the earlier speech-to-text
error. The attachment remains external to the repository; this record does not
claim it is repo-resident.
**Relationship to Phase 0:** corroborating review that changed both product
sequencing and the primary-evidence strategy; it does not supersede the Phase 0
safety boundaries

## Adopted changes

1. **The first product is a scorer copilot.** Build the authenticated,
   event-sourced, human-authorized scoring control plane and evidence/review
   workflow before treating any perception model as a scoring dependency.
2. **Next-server evidence is reconciliation, not primary point truth.** It can
   detect contradictions, service-order errors, or recover likely ordinary
   transitions. It cannot distinguish same-server points from replay/no-point,
   has unbounded exception latency, and does not exist after a terminal point.
3. **Separate inference from policy.** Perception produces observations and a
   `RallyHypothesis`; a reproducible exception-first policy produces a
   `PolicyAssessment`; an authenticated human separately creates an authorized
   event. No model or service principal can authorize score mutation, and a
   model never labels its own output legally confirmed.
4. **Exception screening precedes winner optimization.** Capture gaps,
   replay/no-point, challenges, corrections, administrative points, timeouts,
   side switches, terminal states, and rules/version conflicts are explicit
   states and release metrics.
5. **Use a transparent constrained state estimator first.** A factor graph,
   dynamic Bayesian network, or HSMM is the baseline for causal fusion and
   duration/missing-data handling. A causal TCN/GRU remains a challenger for
   learned observation emissions.
6. **Expand evaluation beyond detector accuracy.** Required reporting includes
   exception false-accept risk, cluster-aware confidence intervals,
   risk/coverage, full-match time-to-first-divergence, human review workload,
   and held-out venue/camera/lighting/team plus prospective capture.
7. **Strengthen provenance.** Rights and annotation review claims require
   separately trusted signatures, revocation/current-decision checks, resolved
   evidence hashes, and exact artifact/configuration identity. A content hash
   alone is not authority.

## Confirmed and subsequently refined decisions

- The study's 4K60-first planning assumption is superseded by the owner's
  production inventory recorded on 2026-07-12. Tier A is constrained 1080p30
  (nominal 3 Mbps HEVC/SRT); Tier B is enhanced 1080p60 (nominal 6 Mbps
  H.264/RTMP). Optional 4K is a challenger, not a prerequisite. Support remains
  conditional on exact-profile observability and calibrated abstention.
- The CV path branches from raw ingress or immutable native archival bytes
  before the streaming stack's H.264/Opus 720p30 normalization. Program and
  YouTube renditions are derived compatibility/visual-QA sources with explicit
  lineage, not substitutes for native input.
- Synchronized calibrated multi-view is future research, not an assumed
  purchase; it must materially improve risk-bounded coverage, review time, or
  geometry. The currently reported six-AVKANS-to-three-logical-stream physical
  mapping is unspecified and no synchronization claim may be inferred.
- The ball baseline remains a custom causal, blur-aware, high-resolution
  temporal heatmap model. Its owned ConvGRU runtime is implemented and has 15
  PyTorch tests plus a 50-step synthetic overfit smoke, but it has never been
  trained on beach footage and has no real checkpoint, export, latency,
  calibration, or deployable-service claim.
- D-FINE-S/RT-DETR-family player detection, ByteTrack plus volleyball
  constraints, manual OpenCV calibration, selective RTMPose, and owned-data
  audio remain the first benchmark family.
- No VLM/LLM, generic end-to-end video-to-score model, or perception service is
  allowed to mutate score.

## Candidate additions, not automatic adoptions

- RT-DETRv4-S, OC-SORT, TrackTrack, newer distortion-aware field registration,
  and Mamba/state-space event models enter the challenger ledger only after
  exact code, checkpoint, data, causal, export, and commercial-license review.
- FIVB, USAV, NCAA, and competition amendments must be separate versioned
  rulesets. The current reducer foundation is not silently claimed to implement
  every one of them.
- Scoreboard OCR and audio are redundant observations. An official electronic
  scoresheet/referee feed is preferred when available; neither OCR nor audio is
  legal score authority.

## Deliberate V0 deferrals

- The study correctly requires immutable correction history, but its abstract
  `CorrectionEvent` is not sufficient executable semantics. A local state
  replacement can invalidate service order, side switches, timeouts, later
  sets, and terminal state. V0 therefore exposes no correction event or
  authorization path. A future privileged replay command must bind the target
  interval plus before/after state fingerprints, rebuild from the immutable
  authorized log, and revalidate every dependent event.
- Model-family names in the study are benchmark candidates, not approved code,
  checkpoints, datasets, or commercial licenses. No candidate enters training
  until its exact artifacts and resident source media pass the existing rights,
  provenance, capture-observability, split, and annotation gates.

## Revised execution order

1. Finish capture/media, signed rights, annotation-trust, split, and evaluation
   contracts.
2. Build authenticated human authorization, expected-version concurrency,
   transactional append/outbox, signed evidence manifests, and deterministic
   replay around the existing reducer.
3. Build immediate evidence-clip/review and no-mutation shadow interfaces.
4. Run rights-cleared camera observability and calibration trials.
5. Freeze multi-axis benchmark partitions and exception/human-workflow metrics.
6. Train rally/referee/scoreboard/server evidence first, then ball/player/pose/
   audio specialists.
7. Add exception-first constrained fusion and prospective shadow evaluation.

The control-plane sequencing change is now reflected in the implementation:
signed scorer-copilot persistence precedes empirical perception, and ScoreCheck
has authenticated append-only receipts plus fixed
`VERIFIED_RECEIPT_PREFIX` replay without any official-score edge. The latter is
not live integration: its external monotonic rollback checkpoint, real
Supabase/PostgREST/JWT role mapping, protected target resolver, endpoint, and UI
remain absent.

The primary-evidence change is also retained: next-server observations can
corroborate or downgrade one earlier causal rally hypothesis but can never
promote policy eligibility or stand in for direct evidence at terminal and
same-server/replay cases.

`CausalBallLabelBundleV1` now addresses one provenance gap discovered while
following this order. A loose `labels_sha256` and coverage declaration did not
prove complete decoded-frame/all-localizable-ball enumeration. The new
curator-signed bundle authenticates only the curator's bounded derived-asset
completeness assertion; it does not objectively prove source-frame
completeness. Every receipt admission flag remains `False`, and source
residency, rights, derivation, annotation truth, the trusted training launcher,
and immutable media lease remain pending.

Empirical training remains gated on exact rights, resident source bytes,
capture observability, timestamp/freeze integrity, reproducible calibration,
and an annotation agreement pilot. Failure of autonomous scoring is not failure
of the scorer-copilot product.
