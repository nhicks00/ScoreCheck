# Fable 5 Execution Brief — ScoreVision

**Version:** 2.0  
**Date:** July 14, 2026  
**Read first:** `SCOREVISION_V2_ARCHITECTURE_AND_AGENT_LOOP.md`

---

## Mission

Advance ScoreVision from its present data/reducer foundation to a validated **human-authorized live scoring assistant** for beach volleyball.

The product goal is not “train a clever video model.” The product goal is:

> Produce timely, calibrated, evidence-backed rally proposals that reduce scorer work while a deterministic rules reducer remains the sole score authority.

Later work may add player attribution, contacts, actions, trajectories, and referee-support evidence. Do not let later analytics delay the scoring milestone.

---

## Non-negotiable architecture

1. No perception model may write or authorize legal score.
2. Only authenticated domain events enter the deterministic rules reducer.
3. Human authorization is mandatory for v0.
4. Next-server evidence is a delayed checksum, not the sole rally-winner oracle.
5. Court geometry is not a hard filter for active players.
6. Initialize/confirm the four athletes at match start and maintain four persistent player slots.
7. Active-ball identity is a top-K probabilistic hypothesis, reinitialized at serve; do not force a single ball track through ambiguity.
8. Predicted ball positions during occlusion are not observations or ground truth.
9. Pose and VLM work are outside the scoring critical path unless a controlled benchmark shows incremental value.
10. Qwen3-VL may assist annotation, clip QA, and failure analysis; it is not the live ball tracker or score authority.
11. The exact `MCG-NJU/videomae-small-finetuned-kinetics` checkpoint is not an approved commercial default.
12. A repository license is not proof that weights or training video are commercially usable.
13. Test labels, split assignments, evaluator code, rights status, release thresholds, and production aliases are immutable to the research agent.
14. Every campaign is bounded. No infinite autonomous loop is permitted.

---

## Your role

You are the **research agent**, not the workflow scheduler or release authority.

You may:

- inspect approved code, configs, training data manifests, public sources, prior run reports, and failure logs;
- propose one falsifiable hypothesis at a time;
- edit only allowlisted files in an isolated branch/worktree;
- launch only catalogued commands through the experiment executor;
- query MLflow, FiftyOne, Optuna, and the append-only decision ledger;
- produce targeted annotation queues;
- keep/discard research changes according to the locked gate;
- create a structured blocker packet.

You may not:

- access hidden selection/test labels;
- edit the evaluator, splits, rights registry, ontology, release gates, production score service, or protected branches;
- widen budget/scope without approval;
- promote models;
- silently install dependencies;
- use unclear-rights footage or weights;
- suppress failed experiments or unfavorable slices;
- redefine unknown/occluded as negative;
- continue after an eval-integrity, rights, or observability failure.

---

## Phase 0 — readiness before training

Do not launch a substantive model run until all items below have a PASS, FAIL, or BLOCKED result.

### A. Rules and score control

- Existing reducer test suite passes.
- Reducer exactly replays the human gold event ledgers.
- Replay/no-point, correction, timeout, side switch, terminal, service-order, and administrative event semantics are present.
- Perception credentials cannot append authorized events.

### B. Data rights and provenance

- Every VOD has owner/source and training/evaluation/commercial status.
- Every pretrained checkpoint has separate code, weight, and source-data review.
- Unresolved assets are quarantined.
- Every derived clip can be traced to its source hash.

### C. Split integrity

- Splits are grouped by full match.
- Venue, camera, date/tournament, teams, source/transcode, and near-duplicate leakage are checked.
- Research-agent credentials expose only train/search data.
- Selection and sealed test are served only through the evaluator.

### D. Weak-label audit

- Scorebug OCR update lag is measured.
- Score corrections/freezes/disappearances are measured.
- Overlay and related leakage channels are masked or removed.
- OCR labels are called weak/silver; only human-reconciled events are gold.

### E. Camera observability

For a stratified sample of at least 1,000 decisive windows, report:

- ball minor-axis pixels;
- blur length and blur/size ratio;
- visible/partial/full-occlusion/out-of-frame fractions;
- usable observations around event time;
- multiple-ball conflicts;
- glare/shadow/compression slices;
- dropped/frozen/duplicate-frame rate;
- calibration repeatability.

If the footage does not contain enough ball signal, issue a redesign recommendation instead of tuning models indefinitely.

### F. No-ML and direct-evidence baseline

Measure what can be achieved using:

- human scorer events;
- scorebug/score display;
- referee team-to-serve/point signal;
- simple rally activity/audio boundaries;
- player reset and next-server consistency.

This establishes whether ball tracking is actually necessary for the scoring milestone.

---

## Approved initial stack

| Layer | Default |
|---|---|
| Core CV training | PyTorch + Lightning Fabric/custom loops |
| Transformer/VLM experiments | Hugging Face Transformers/Trainer |
| Config | Hydra + typed validation |
| Numeric HPO | Optuna with pruning and DB storage |
| Experiment/model registry | MLflow + PostgreSQL + object storage |
| Data lineage | content-addressed manifests; DVC where appropriate |
| Corpus curation | FiftyOne |
| Annotation | CVAT |
| Label triage | Cleanlab using out-of-fold predictions/embeddings |
| Durable campaign state | Temporal or approved DB-backed local controller |
| GPU executor | Modal first; provider-neutral interface and hard budget |
| Player detector | D-FINE-S |
| Player detector challengers | RT-DETRv4-S, RF-DETR-S |
| Player tracker | ByteTrack + match constraints |
| Ball model | custom causal blur-aware multi-frame heatmap model |
| Ball challengers | WASB-style, BlurBall-style, TrackNetV4/causal TOTNet |
| Rally fusion | causal TCN/GRU emissions + HSMM/factor graph |
| Court | manual OpenCV calibration + drift detector |
| Pose | RTMPose event crops, later |
| VLM | frozen Qwen3-VL-2B offline benchmark; SFT only if justified |
| Deployment | ONNX Runtime/TensorRT for NVIDIA; direct Core ML export for Apple |

A default may change only through an approved architecture campaign and artifact-level license review.

---

## Campaign protocol

Each campaign must have these declared before execution:

- one question and one mechanism;
- baseline run ID;
- primary metric;
- critical slices;
- minimum meaningful improvement;
- allowed data/split versions;
- allowed files and mutation classes;
- trial, GPU-hour, and dollar limits;
- stop/plateau rules;
- seed policy;
- export/latency target;
- approved model/checkpoint list;
- human owner/blocker channel.

### Campaign sequence

1. **PREFLIGHT** — schema, data, license, environment, and command checks.
2. **BASELINE** — rerun or verify the pinned baseline under the same contract.
3. **PROPOSED** — state one falsifiable hypothesis and predicted mechanism.
4. **SMOKE** — ensure loss/metrics execute; no performance verdict.
5. **SCREEN** — fixed data exposure; one seed; pruning allowed.
6. **FULL** — full approved training schedule.
7. **EVALUATED** — sealed evaluator returns aggregate and slice metrics.
8. **KEEP / DISCARD / BLOCKED** — machine rule plus written rationale.
9. **PROMOTION CANDIDATE** — repeat/variance, export, target-device latency.
10. **HUMAN REVIEW** — only a human may invoke sealed release evaluation or promote.

Change one major factor at a time. Delegate bounded numeric parameter search to Optuna rather than manually thrashing hyperparameters.

---

## Keep/discard gates

Evaluate in this order:

1. rights/provenance PASS;
2. split/evaluator integrity PASS;
3. reproducibility PASS;
4. run completeness PASS;
5. no critical-slice regression beyond declared tolerance;
6. calibration/abstention PASS;
7. export parity and target latency PASS;
8. primary improvement exceeds threshold/noise floor.

Use paired match-level bootstrap where possible. Do not keep a model because of a tiny aggregate gain concentrated in one venue.

---

## Error and retry policy

- Transient network/API/preemption: retry with backoff, maximum three attempts.
- OOM: one approved fallback for batch/precision; otherwise block.
- Deterministic error: diagnose once; do not blind-retry.
- Same failure signature twice: produce `BLOCKER.md`.
- Data corruption: quarantine, never relabel as negative.
- Rights ambiguity or eval leakage: stop immediately.
- Budget exhausted or plateau reached: stop and report.

`BLOCKER.md` must state: reason code, evidence, attempts, affected artifacts, minimal human action, alternatives, risk/cost, and exact resume state.

---

## Initial campaign queue

Run in this order unless Phase 0 changes the priorities.

### Campaign 0 — readiness and observability

**Question:** Is the corpus, scoring truth, and capture signal sufficient for controlled model training?  
**Deliverable:** readiness report plus exact blocker list.  
**No model promotion.**

### Campaign 1 — rally/direct-evidence baseline

**Question:** How accurately and quickly can rally boundaries and ordinary point proposals be generated without ball tracking?  
**Inputs:** scorebug weak labels, human gold, referee/scoreboard/audio/player reset.  
**Baseline:** rules/activity heuristic.  
**Challenger:** causal TCN/GRU + HSMM.  
**Decision:** establish the product floor and incremental need for ball evidence.

### Campaign 2 — four active players

**Question:** Can four operator-initialized athlete slots survive a full match, including occlusions and side switches?  
**Baseline:** D-FINE-S + ByteTrack + geometry/team/order constraints.  
**Challengers:** RT-DETRv4-S, RF-DETR-S; OC-SORT/TrackTrack.  
**Metrics:** active-player recall, identity switches/match, server-team/player accuracy, target latency.

### Campaign 3 — active ball

**Question:** Does a causal blur-aware high-resolution model plus top-K association reliably identify the in-play ball?  
**Baseline:** WASB-style reproduction trained on cleared footage.  
**Challenger:** custom blur/visibility/active-ball heads.  
**Metrics:** active-ball identity, false tracks/hour, visibility calibration, decisive-window coverage, latency.

### Campaign 4 — end-to-end evidence fusion

**Question:** What incremental scoring benefit does each evidence channel provide?  
**Ablations:** direct evidence only; +players/next server; +ball; +audio; full fusion.  
**Metrics:** selective risk/coverage, exception false accept, exact score state, human review time.

### Campaign 5 — Qwen/VLM research only

**Question:** Does frozen Qwen3-VL-2B add unique value for coarse clip QA/referee/serve-side labels?  
**Gate:** it must beat or complement the specialist baseline under strict schema, consistency, latency, and cost metrics.  
**Next:** SFT only if frozen performance demonstrates value. No GRPO initially.

---

## Provisional success targets

These are initial targets and require owner ratification after the noise-floor study.

### Assistive scoring release

- reducer/event-store tests: 100%;
- no perception write path to legal score;
- ordinary-point proposal precision: at least 99% at explicitly reported coverage on prospective matches;
- no silent exception-as-ordinary errors in release evaluation;
- p95 proposal latency: under 1 second after detected rally end;
- p95 review clip: under 2 seconds;
- median ordinary review: two actions or fewer and not slower than manual baseline;
- exact authorized score state after every event;
- target-device parity/latency PASS;
- rights/provenance PASS.

### Future automatic authorization

Do not enable without separate human approval. Initial ceiling:

- one-sided 95% upper bound on accepted wrong-point risk below 0.1%, or stricter owner-approved threshold;
- zero accepted exception-as-ordinary errors in prospective release data;
- known prior version, continuous capture, known server/order, nonterminal state, no active exception;
- complete signed evidence bundle and immediate override/correction path.

---

## Required owner inputs

If any item is missing, generate the smallest blocker request rather than guessing.

- repository and protected-branch access;
- existing passing commands/tests;
- footage/data ownership and allowed-use registry;
- corpus manifest and sample VODs;
- camera/lens/stream/deployment-hardware details;
- FIVB/USAV/NCAA/local rules scope;
- human-reconciled event ledgers;
- team/roster/server/order metadata for gold matches;
- weekly annotation/review capacity;
- assistive/automatic product policy and risk budget;
- monthly GPU/storage budget and providers;
- secret-manager credentials;
- human blocker owner and response channel;
- approval on whether a referee/score evidence camera or official score feed is possible.

---

## Required first response from Fable 5

Return a readiness table with one row per Phase 0 check and these fields:

- status: PASS / FAIL / BLOCKED / NOT MEASURED;
- evidence path/run ID;
- risk if unresolved;
- smallest next action;
- who owns that action;
- whether other approved work can proceed;
- exact resumable campaign state.

Then propose **one** first campaign, including its baseline, metric, slices, compute cap, stop rule, and allowed mutation surface. Do not begin training merely because a GPU is available.
