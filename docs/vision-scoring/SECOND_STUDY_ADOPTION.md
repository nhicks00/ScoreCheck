# Independent Architecture Study: Adoption Record

**Study received:** 2026-07-12
**Decision recorded:** 2026-07-12
**Source:** independent GPT Sol Pro architecture study supplied by the project
owner
**Relationship to Phase 0:** corroborating review with one material sequencing
change; it does not supersede the Phase 0 safety boundaries

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
   `PolicyAssessment`; an authenticated human/service separately creates an
   authorized event. A model never labels its own output legally confirmed.
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

## Confirmed existing decisions

- Native single-camera 4K60 remains the prospective baseline; historical
  1080p30 is compatibility/shadow material only after rights and observability
  gates pass.
- Dual synchronized calibrated 4K60 is an experiment, not an assumed purchase;
  it must materially improve risk-bounded coverage, review time, or geometry.
- The ball baseline remains a custom causal, blur-aware, high-resolution
  temporal heatmap model trained on cleared beach footage.
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

Empirical training remains gated on exact rights, resident source bytes,
capture observability, timestamp/freeze integrity, reproducible calibration,
and an annotation agreement pilot. Failure of autonomous scoring is not failure
of the scorer-copilot product.
