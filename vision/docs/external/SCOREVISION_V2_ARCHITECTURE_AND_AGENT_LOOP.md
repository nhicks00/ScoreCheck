# ScoreVision v2.0 — Architecture Review and Agent-Operated Training Loop

**Research date:** July 14, 2026  
**Decision context:** beach-volleyball scoring first; player/action analytics later  
**Audience:** project owner, Fable 5/OpenClaw operator, CV engineer, data annotator, scoring/rules reviewer  
**Status:** architecture and execution specification; not implementation code

---

## 1. Executive decision

Build **a modular, evidence-fusion computer-vision system around a deterministic scoring control plane**. Do not attempt to train one general video model to watch a match and emit a legal score.

The best practical architecture is:

1. **Deterministic scoring control plane** — authenticated human/referee/scorer events are the only inputs allowed to mutate legal score; the existing rules reducer derives score, server, service order, side, timeouts, set and match state.
2. **Specialist perception plane** — court geometry, four active-player tracks, active-ball hypotheses, rally phase, audio, referee signals, and scoreboard/scorebug observations each produce typed evidence with uncertainty.
3. **Causal event-fusion plane** — a rule-constrained factor graph, dynamic Bayesian model, or hidden semi-Markov model (HSMM) proposes an ordinary point, replay/no point, exception, or unresolved result. It does not authorize a score.
4. **Human-authorized v0** — the scorer sees a prefilled proposal and evidence clip and confirms or corrects it. Calibrated abstention is a feature, not a failure.
5. **Agent-operated research plane** — a durable campaign controller runs bounded experiments against a sealed evaluator. The research agent may propose and implement one falsifiable change at a time, but it cannot edit test labels, split assignments, release gates, rights status, or production score state.

### The most important changes from ScoreVision v1.0

- Keep the modular specialists, deterministic reducer, scorebug-derived weak labels, match-level splits, and human review.
- Replace **“next serve side is the score-attribution keystone”** with **“next serve side is a delayed consistency check and one evidence channel.”** It is ambiguous for replay/no-point, sanctions, corrections, service faults, challenges, terminal points, and missing transitions.
- Treat court geometry as a coordinate system and identity prior, **not a hard active-player filter**. Players legally move into free space and may enter the opponent's court/free zone when not interfering.
- Initialize the four active athletes with a brief human action at match start rather than asking a model to infer them cold from every person in view.
- Replace the proposed `MCG-NJU/videomae-small-finetuned-kinetics` production default. The official VideoMAE repository says most of the project is CC BY-NC 4.0, so this is not a clean commercial starting point.
- Use Qwen3-VL only for offline annotation assistance, clip QA, failure analysis, and a separately evaluated semantic challenger. It should not track the tiny ball or mutate live score.
- Use PyTorch plus **Lightning Fabric/custom loops** for the specialist CV models. Hugging Face Trainer remains appropriate for a Qwen/VLM experiment, but it should not be the universal training framework.
- Add MLflow as the canonical experiment/model registry and immutable data manifests or DVC for data lineage. A Git JSONL ledger remains useful for human decisions but is not enough by itself.
- Put the persistent loop inside a durable orchestrator such as Temporal. Fable 5 is the research brain; it is not the scheduler, source of truth, evaluator, or release authority.

---

## 2. Audit of the uploaded ScoreVision v1.0 proposal

### What is directionally correct

| v1 idea | Assessment | v2 disposition |
|---|---|---|
| One model per perception job | Correct | Retain; avoid an end-to-end video-to-score model |
| CV proposes; deterministic reducer owns score | Correct and safety-critical | Strengthen with authenticated authorization and durable event storage |
| Scorebug OCR creates weak labels | Valuable | Retain as weak supervision; add lag, correction, and human-noise handling |
| Mask scorebug from model inputs | Correct | Retain; make the mask treatment identical in every split |
| Match-level and cross-venue splits | Correct | Expand to camera, date, team, and prospective holdouts |
| FiftyOne/CVAT/Cleanlab data flywheel | Good foundation | Retain with stronger provenance and active-learning contracts |
| ByteTrack first; pose later | Correct | Retain; add court/team/service-order constraints |
| Qwen/VLM only as optional later component | Correct | Narrow it further to offline/review tasks until benchmarked |
| Locked evaluator and one hypothesis per branch | Strong | Retain and enforce with separate credentials and a durable controller |
| Human steering at campaign boundaries | Appropriate | Add explicit legal, data, and release checkpoints |

### What is wrong, unsafe, or insufficiently supported

| v1 claim or assumption | Problem | Required update |
|---|---|---|
| VideoMAE-small checkpoint is a production default | The official repository is predominantly CC BY-NC 4.0; the exact checkpoint/model-card lineage needs review | Remove from commercial baseline; use a permissive compact model trained on owned data, or evaluate V-JEPA 2.1 under artifact-level diligence |
| WASB is “MIT, pretrained volleyball weights,” therefore commercially safe | Repository code licensing does not automatically grant commercial rights to weights, training videos, or annotations | Treat WASB as an architecture/reference benchmark; train the production checkpoint on cleared footage |
| Next server identifies the prior winner | True only for an ordinary completed rally with complete continuity; it cannot distinguish several no-point and administrative paths | Use as delayed checksum, weak-label generator, service-order validator, and recovery cue |
| Court polygon identifies the active players | Beach players may leave the court/free zone and can enter opponent space without interference; officials and retrievers can also enter nearby zones | Human-initialize four player slots, then track persistently using geometry and match constraints |
| Pose is needed to know serve receive / scoring | Pose is expensive and usually unnecessary for rally phase, serving team, and ordinary scoring | Use centroids, velocities, service-zone occupancy, ball possession, and referee/scorer cues first |
| `SERVICE / PLAY / NO-PLAY` alone segments rallies reliably | Useful labels, but scorebug timing can lag and a fixed 16-frame classifier can flicker or miss exceptional transitions | Predict frame/window observations, then impose causal durations and legal transitions with an HSMM/factor graph |
| HF Trainer is the universal training layer | Fine for Transformers, awkward for custom heatmaps, multiple heads, temporal state, specialized losses, and target-hardware profiling | Use Lightning Fabric/custom PyTorch for CV; HF Trainer only where it fits |
| Trackio + Git JSONL is a sufficient registry | Good local diagnostics, but weak model lifecycle, artifact lineage, aliases, and centralized run comparison | Add MLflow Tracking/Registry; keep the append-only decision ledger |
| Fixed `$2–5` per run | Provider-, input-, model-, and convergence-dependent; it can encourage undertraining or unfair comparisons | Measure cost; use explicit GPU-hour and example/step budgets with hard caps |
| M4 hardware is sufficient for one or two streams | Plausible but unproven for the actual full-resolution pipeline | Require export parity and target-device latency/thermal benchmarks before promotion |
| “Gold” scorebug labels are ground truth | Scorebugs can lag, skip, be corrected, or reflect a human entry error | Reserve “gold” for human-reconciled event ledgers; call OCR-derived labels weak/silver even when high quality |
| A VLM can adjudicate rallies after SFT/GRPO | A generative video model may discard the tiny ball through resizing/token sampling and is not naturally calibrated at frame-level timing | Use it for coarse semantic QA and annotation triage; do not make it a legal-evidence source without a separate benchmark |

---

## 3. How scoring should actually be inferred

A point is not one visual object or one frame. It is a **legal state transition inferred from a sequence of evidence**.

### 3.1 Evidence hierarchy for the scoring MVP

Prefer evidence in this order, subject to availability and integrity:

1. **Authenticated official electronic score/scorer feed** — simplest and most direct when an integration is available.
2. **Referee “team to serve” / point-direction signal** — current FIVB rules define an official signal extending the arm toward the team that will serve.
3. **Human scorer input** — one-tap point, replay/no-point, timeout, correction, or administrative event.
4. **Scorebug or venue scoreboard change** — excellent for offline weak labels and shadow verification; not independent truth if generated by the same scorer.
5. **Ball-outcome evidence** — landing side, terminal trajectory, touch candidate, or clearly visible fault.
6. **Player reset and serving-team/player transition** — valuable but delayed.
7. **Audio** — whistle and contact events help locate boundaries; adjacent courts make audio unsuitable as point truth.

### 3.2 The primary v0 path

For each potential transition:

1. Detect or receive a **rally start** candidate.
2. Track a causal **rally-live** state.
3. Detect a **rally-end/stoppage** candidate using whistle, motion, referee signal, ball state, and player reset.
4. Classify the transition as:
   - ordinary point for team A;
   - ordinary point for team B;
   - replay/no point;
   - administrative/exception;
   - unresolved.
5. Produce a review packet with synchronized clips, observations, alternatives, and reason codes.
6. Require an authenticated human confirmation in v0.
7. After the next service is confirmed, use the serving team/player as a delayed checksum and service-order validator.

### 3.3 Why next-server inference is not the sole score mechanism

Current FIVB rules say the serving team scores and continues serving when it wins an ordinary rally, while the receiving team scores and serves next when it wins. But the same rules also define double-fault replays, penalties, service-time-limit outcomes, service-order faults, defaults/incomplete teams, corrections, and other administrative paths. A same-team next serve can therefore mean either a serving-team point or no point; a changed serving team can be produced by an ordinary rally or an administrative event.

Use next-server inference only when all of the following are known:

- capture continuity is intact;
- exactly one transition occurred;
- the prior and new serving teams are known;
- no challenge, replay, sanction, correction, timeout, set transition, terminal state, or interruption occurred;
- service order is known;
- the transition is classified as ordinary.

### 3.4 A simpler hardware option worth testing

Before buying a second 4K court camera for scoring, test one of these lower-cost signals:

- direct e-score/scorer API;
- a small dedicated camera aimed at the first referee and public score display;
- a camera crop that keeps the official hand signals visible;
- an authenticated scorer tablet emitting domain events.

A second 4K court view is valuable for occlusion recovery, trajectories, contact timing, and future referee-support evidence. It is not necessarily the best first hardware purchase for scorekeeping.

---

## 4. Revised three-plane architecture

```text
                         SCORING CONTROL PLANE

 human/referee/scorer ──> authenticated authorizer ──> append-only event store
 official score feed ───>       expected version              │
                                                              ▼
                                                deterministic rules reducer
                                                              │
                                         legal score / server / order / side

                         PERCEPTION / EVIDENCE PLANE

 video + audio ─> capture integrity / clocks / calibration / evidence hashes
                         │
       ┌─────────────────┼────────────────────┬──────────────────────┐
       ▼                 ▼                    ▼                      ▼
 court model       four player slots    active-ball posterior   audio/ref/score
       └─────────────────┼────────────────────┴──────────────────────┘
                         ▼
             causal factor graph / HSMM
                         ▼
       RallyHypothesis + alternatives + uncertainty + reason codes
                         ▼
                 review / policy gate
                         │
                         └────────────── proposes; never mutates score

                         RESEARCH / TRAINING PLANE

 rights registry + immutable data manifests + human gold ledgers + weak labels
                         │
                  campaign controller
                         │
         research agent ─┼─> isolated trainer ─> sealed evaluator
                         │                         │
                         └──── failure mining <────┘
                                     │
                               annotation queue
```

### 4.1 Required contract separation

| Contract | Meaning | May change legal score? |
|---|---|---|
| `MediaAsset` | captured bytes, timestamps, camera/audio identity, integrity state | No |
| `Observation` | model measurement plus uncertainty and provenance | No |
| `RallyHypothesis` | candidate physical/temporal interpretation and alternatives | No |
| `PolicyAssessment` | eligibility/review decision with reason codes | No |
| `AuthorizationRequest` | proposal tied to an expected match version | No |
| `AuthorizedDomainEvent` | authenticated ordinary point, replay, correction, sanction, timeout, set event, etc. | Yes, through reducer only |
| `MatchSnapshot` | derived/cached reducer state | No; rebuildable |

Do not encode `AUTO_CONFIRM` as a model prediction. Automation eligibility is a policy result applied after the hypothesis is produced.

---

## 5. Perception architecture by subsystem

### 5.1 Court and scene geometry

**Production baseline:** one-time/manual surveyed OpenCV calibration for each camera setup, including lens distortion, court corners/lines, service zones, free zone, net plane, posts, antennae, and adjacent-court masks. Run lightweight drift checks during the match.

**Challengers:**

1. an adapted learned sports-field registration model for auto-initialization;
2. the 2026 Unified Sports Field Registration with Lens Distortion Modeling method;
3. a segmentation/keypoint model trained on the project's own court layouts.

**Important rule:** the court polygon is not the active-player definition. It supplies:

- world coordinates and legal zones;
- initial player assignment priors;
- service-zone evidence;
- side-switch handling;
- ball plausibility and adjacent-court rejection;
- landing geometry.

It must not delete a player track merely because the athlete leaves the playing-court polygon.

### 5.2 Active players among spectators, officials, and staff

The simplest robust design is an **operator-assisted roster initialization**:

1. At match start, the operator clicks or confirms the four athletes once.
2. Assign four persistent logical slots: team A player 1, team A player 2, team B player 1, team B player 2.
3. Track those slots using detection, motion, team/side, appearance, service order, and court geometry.
4. Side switches update spatial priors without changing identities.
5. If a track is lost, re-acquire from a shortlist and ask for a one-click confirmation when ambiguity remains.

This is safer and cheaper than training a model to distinguish “active player” from every human in every frame.

**Production detector:** D-FINE-S, fine-tuned on owned beach footage.  
**Detection challengers:** RT-DETRv4-S and RF-DETR-S.  
**Production tracker:** ByteTrack plus team/court/service-order constraints.  
**Tracking challengers:** OC-SORT or TrackTrack; BoT-SORT with and without ReID as an ablation.

Do not add generic ReID until it proves a sustained reduction in identity switches on held-out beach footage. With four known players, match constraints often outperform a pedestrian ReID embedding.

### 5.3 Active volleyball among multiple volleyballs

A generic “volleyball” detector is not enough. Treat **active-ball identity as a latent, time-varying hypothesis**.

Maintain the top candidate tracks with probabilities based on:

- possession/proximity to the authorized server before serve;
- toss and service-contact onset;
- temporal continuity and plausible acceleration;
- distance to candidate player-contact windows;
- court volume, net, and boundary geometry;
- rally-live state;
- penalties for a stationary spare ball, ball retriever throw, or adjacent-court trajectory;
- visibility/occlusion state;
- consistency across views when a second view exists.

At a serve, strongly reinitialize the active-ball posterior around the authorized server. During play, preserve multiple hypotheses rather than permanently locking to one detection. When posterior entropy or candidate conflict is too high, label the active ball unresolved.

**Required ball output states:** visible, partially occluded, fully occluded, out of frame, not present, indistinguishable, capture unknown, and predicted-only. A trajectory interpolated through occlusion is not an observed ball position.

**Production ball baseline:** a custom causal, high-resolution, multi-frame heatmap model with ball centre, blur orientation/extent, visibility, uncertainty, and match-ball probability heads, trained on cleared project footage.

**Ball challengers:**

1. WASB-style high-resolution temporal heatmaps;
2. BlurBall-style blur-aware prediction;
3. TrackNetV4 or a causalized TOTNet-style temporal model.

Do not downsample the whole 1080p frame to 512×288 without first measuring ball pixels. Prefer high-resolution court crops, overlapping tiles, trajectory-guided regions of interest, and periodic global reacquisition.

### 5.4 Rally phase and event boundaries

The v1 `SERVICE / PLAY / NO-PLAY` ontology is useful, but the production system should estimate a richer causal state:

- pre-serve;
- authorization/ready;
- serve attempt;
- rally live;
- suspected rally end;
- provisional result;
- challenge/review;
- replay/no point;
- timeout/technical timeout;
- side switch;
- between sets;
- correction pending;
- terminal/interrupted.

**Production baseline:** a small causal TCN or GRU over specialist features, constrained and smoothed by an HSMM/factor graph. Specialist features include player positions/velocities, ball visibility/motion, whistle probability, referee signal, scoreboard transition, and capture health.

**Challengers:**

1. a compact video encoder trained only on owned footage;
2. V-JEPA 2.1 ViT-B/16 frozen features plus a causal head, after artifact-level license/data review;
3. a larger causal state-space model if long-context evidence proves useful.

Do not make a bidirectional video model the source of a “live” result unless its future-frame lookahead and resulting latency are explicit.

### 5.5 Pose and contact evidence

Pose is **not on the scoring critical path**. Player boxes, centroids, feet, velocity, service-zone occupancy, and hand/ball proximity are enough for the first scoring experiments.

Add RTMPose/RTMW on tracked player crops only for selected event windows when pursuing:

- serve/contact timing;
- attack, set, block, dig, or pass labels;
- jump/takeoff features;
- net-proximity evidence.

Pose alone cannot establish legal contact, a double hit, a lift, a block touch, or a net fault.

### 5.6 Referee, scoreboard, and audio evidence

Train small domain-specific models on owned data for:

- referee point/team-to-serve direction;
- whistle probability;
- ball-contact transient;
- scorebug/public-score transition;
- capture/audio quality.

Scorebug labels need a temporal uncertainty interval because graphics often update after the legal decision. Store both the original OCR time and the inferred event interval.

---

## 6. Qwen, VLMs, and video foundation models

The likely “QN” family in the question is **Qwen**.

### 6.1 Practical verdict

Qwen3-VL-2B is practical for the research and annotation plane, but it is not the correct primary live scorer.

Good uses:

- summarize an already-cut rally clip;
- answer coarse, structured questions such as “which team appears ready to serve?”;
- classify referee gestures on selected frames;
- propose labels for human review;
- cluster and describe failure modes;
- inspect disagreements among OCR, player transition, and specialist models;
- help an agent write experiment hypotheses and decision reports.

Poor or unsafe uses:

- locate a 2–6 pixel blurred ball every frame;
- establish exact contact or landing time;
- maintain the legal match state;
- supply a calibrated probability from free-form generated text;
- mutate score;
- replace the deterministic rules reducer.

The reason is architectural, not merely model size: video VLMs tokenize/resample frames for semantic understanding, while this product often needs full-resolution, frame-level localization of a tiny object. A fluent explanation cannot recover visual information lost during preprocessing.

### 6.2 Recommended VLM experiment order

1. Run the frozen Qwen3-VL-2B model on a sealed coarse-semantic clip set.
2. Convert answers into a strict schema and measure exact-match, abstention, latency, and consistency.
3. Only if it adds value, perform supervised fine-tuning on human-verified examples.
4. Do not begin with GRPO/RL. A weak or hackable reward based on noisy scorebug labels will reward shortcuts.
5. Keep the model in the offline/review path unless it beats the specialist baseline on prospective footage and passes latency/calibration gates.

### 6.3 Video foundation model challenger

V-JEPA 2.1, released March 16, 2026, offers an 80M ViT-B/16 checkpoint at 384-pixel resolution and emphasizes temporally consistent dense features. It is a credible representation-learning challenger for rally phase, player motion, and hard-example embeddings. It is still not a tiny-ball tracker, and its checkpoint/data provenance must be reviewed separately from repository licenses.

### 6.4 SAM 3.1

SAM 3.1, released March 27, 2026, can prompt, segment, and track multiple objects in video. Use it for:

- human-assisted annotation propagation;
- four-player initialization;
- court/person mask bootstrapping;
- failure-case review.

Do not place an 848M-class promptable foundation model in the live score path without a measured reason. Its custom checkpoint license also requires separate review.


---

## 7. Recommended training and MLOps stack

### 7.1 Decision table

| Concern | Production recommendation | Why | Caveat / alternative |
|---|---|---|---|
| Core language | Python 3.11/3.12, `uv`, pinned lockfile | Fast environment creation and reproducibility | Pin CUDA/PyTorch and system libraries in an OCI image too |
| CV training | PyTorch + Lightning Fabric/custom loops | Flexible enough for heatmaps, temporal losses, multiple heads, distributed training, mixed precision, and custom evaluation | Native D-FINE/MMPose runners can be retained behind adapters where productive |
| Transformer/VLM training | Hugging Face Transformers/Trainer or TRL only for the Qwen experiment | Best fit for model cards, processors, adapters, and VLM SFT | Do not force ball/player models through Trainer |
| Configuration | Hydra plus typed validation (Pydantic/dataclasses) | Composable configs with machine validation | Every resolved config is hashed and stored with the run |
| Hyperparameter search | Optuna with pruning and a database-backed study | Better than an LLM manually guessing numeric parameters; supports resumable and distributed studies | Agent defines search hypotheses and bounds; Optuna explores numbers |
| Experiment tracking | MLflow Tracking with PostgreSQL and object storage | Central run lineage, metrics, artifacts, and comparison | Trackio may remain a local/offline curve viewer |
| Model lifecycle | MLflow Model Registry | Versioning, aliases, tags, provenance, rollback | Human promotion only; agent cannot assign production alias |
| Data lineage | Immutable content-addressed manifests; DVC where the corpus size/layout fits | Reproduce exact clips, labels, transforms, and splits | For very large object stores, use manifest hashes/lakeFS-style snapshots rather than forcing every file through Git |
| Corpus curation | FiftyOne | Video slices, embeddings, similarity search, hard-example mining, duplicate/leak detection | Keep sealed-test assets invisible to the research agent |
| Annotation | CVAT, with interpolation/model-assisted labeling | Strong video track workflow and review | Human QA is required after automatic propagation |
| Label-quality triage | Cleanlab on out-of-fold probabilities/embeddings | Finds suspicious labels, outliers, duplicates, and class overlap | It does not adjudicate volleyball rules or temporal truth |
| Durable orchestration | Temporal | Long-lived workflows, history/replay, retries, signals, crash recovery, and resumability | A simpler DB-backed queue can start locally; move to Temporal before unattended multi-day campaigns |
| GPU execution | Modal as first executor, with provider-neutral job interface | Existing fit and API-driven jobs | Do not make Modal the registry or durable workflow state; retain a fallback executor |
| Source control | Git branches/worktrees; protected main; signed release tags | Isolates hypotheses and preserves code decisions | One experiment does not automatically equal one permanent branch |
| Deployment export | ONNX Runtime/TensorRT on NVIDIA; direct PyTorch-to-Core ML for Apple | Target-specific optimization | Every candidate must pass numeric parity and real-device profiling |
| Live stream | MediaMTX or existing ingest, with timestamp-preserving tap before unnecessary transcodes | Avoids avoidable resolution/latency loss | Capture integrity must detect replay, freeze, drops, and clock drift |

### 7.2 Why Lightning Fabric/custom PyTorch is the better core

The system has heterogeneous losses and data shapes:

- ball heatmaps and blur geometry;
- object boxes and identities;
- frame/window state labels;
- variable-length temporal sequences;
- masks for missing/occluded observations;
- factor-graph emission probabilities;
- target-device export tests.

A light custom-loop framework lets the team keep those semantics explicit without adopting a monolithic trainer. Hugging Face Trainer is still valuable where the model is naturally a Hugging Face Transformer.

### 7.3 Reproducibility requirements for every run

A run is invalid unless it records:

- Git commit and uncommitted diff status;
- resolved configuration and hash;
- container/environment digest;
- data manifest and split-manifest hashes;
- rights-registry snapshot ID;
- annotation ontology version;
- model code and initialization checkpoint hashes;
- random seeds;
- GPU type, driver, CUDA, PyTorch, and precision mode;
- training examples/steps seen;
- wall time, GPU time, and cost;
- evaluation harness version;
- target-device export/parity result;
- all metrics and slice metrics;
- failure reason when incomplete.

A repository license is not enough. Every initialization checkpoint must have a provenance record for code, weights, source data, and permitted use.

---

## 8. Data and annotation strategy for hundreds of hours of real footage

### 8.1 Do not manually label the whole archive

Use the archive in four tiers:

| Tier | Contents | Purpose |
|---|---|---|
| Unlabeled corpus | All cleared footage | self-supervised/domain representation, embeddings, hard-negative mining, prospective candidate search |
| Weakly labeled corpus | scorebug OCR, audio peaks, activity windows, existing scorer logs | bootstrap rally boundaries and point transitions with uncertainty |
| Curated training set | agent-selected and human-corrected clips | supervised specialist training |
| Sealed gold set | full matches reconciled by humans against the official score path | model selection/release evaluation; inaccessible to research agent |

The expensive human work should concentrate on representative and failure-rich windows, not random frame-by-frame coverage.

### 8.2 Scorebug/OCR labels

Scorebug labels are useful because a score increment strongly identifies a legal result after the fact. They are not independent physical ground truth.

For every score change, store:

- old and new score;
- OCR observation times and confidence;
- earliest/latest plausible legal event time;
- whether the overlay disappeared, froze, or was corrected;
- human-reconciled winner/event where available;
- whether the clip is ordinary, replay/no-point, administrative, correction, or unknown.

Mask the scorebug identically in all perception inputs so the model cannot learn the answer from the overlay. Also test for leakage through animations, adjacent graphics, audio commentary, and filename/timestamp metadata.

### 8.3 Minimum initial human annotation package

These are practical starting ranges, not universal requirements. Stop early if the observability study fails.

| Annotation package | Initial quantity | Purpose |
|---|---:|---|
| Full human-reconciled match ledgers | 20–30 matches across venues, cameras, lighting, and teams | sealed end-to-end score and event truth |
| Audited rally windows | 1,500–2,500 | rally phase, ordinary/exception, start/end intervals |
| Serve-onset/server labels | 1,000–2,000 events | serving team/player and active-ball initialization |
| Active-player frames/tracks | 2,000–4,000 frames plus selected continuous tracks | detector/tracker and distractor hard negatives |
| Ball windows | 300–600 strategically selected 1–3 s windows; typically 10,000–20,000 visible point labels | high-value blur, occlusion, depth, and multiple-ball coverage |
| Court/calibration frames | 25–50 frames per physical setup and major lighting regime | calibration, drift, and line visibility |
| Referee/scoreboard/audio events | all available in gold matches plus hard negatives | direct scoring evidence and boundary cues |
| Rare exceptions | every real instance found | keep human-only if sample size remains sparse |

Do not label invisible ball positions. Mark an interval or unknown state rather than forcing a point.

### 8.4 Ball annotation ontology

For each candidate ball/frame or blur exposure:

- active match ball, spare ball, adjacent-court ball, retriever ball, held ball, or unknown;
- blur centre;
- blur endpoints/ellipse, orientation, and extent when visible;
- visible, partial occlusion, full occlusion, out of frame, not present, indistinguishable, or capture unknown;
- observed versus interpolated/predicted;
- occluding object;
- annotator confidence;
- event relation: pre-serve, toss, serve, live rally, dead ball, between rallies.

### 8.5 Player annotation ontology

- person box/mask;
- active athlete, official, scorer, line judge, retriever, spectator, or unknown;
- team and roster slot if known;
- service-order slot;
- serving/not serving/unknown;
- visible/occluded/truncated;
- court/free-zone/service-zone relation;
- track identity and identity uncertainty.

### 8.6 Hard negatives that must be deliberately mined

- spare and adjacent-court volleyballs;
- ball-retriever throws and rolling balls;
- players and referees from adjacent courts;
- spectators entering the background;
- heads, hats, circular logos, sun glints, line intersections, flying sand, birds, and debris;
- warmup footage and replay inserts;
- scoreboard animations and cuts;
- whistles/contact sounds from other courts;
- players retrieving a live ball outside the playing-court polygon;
- side switches and uniform/color similarity;
- capture freezes, duplicate frames, dropped frames, and transcodes.

### 8.7 Split rules

Never split by random frame or adjacent clip.

Group by full match and protect against overlap in:

- venue and court;
- camera/lens/encoder configuration;
- calendar date or tournament;
- team pair and preferably athlete identity;
- time of day/weather/lighting;
- scorebug version;
- source stream/transcode lineage.

Use these partitions:

1. **train** — available to the agent;
2. **search/dev** — available to the agent for rapid iteration;
3. **selection** — labels hidden; evaluator returns metrics;
4. **sealed test** — only release evaluator/human can invoke;
5. **prospective shadow** — captured after model, thresholds, and ontology freeze.

### 8.8 Active-learning loop

Each retained model version should generate an annotation queue from:

- uncertainty/entropy;
- disagreement among models and evidence channels;
- false positives with high confidence;
- false negatives near known event windows;
- active-ball identity conflict;
- novel embedding clusters;
- underrepresented slices;
- a fixed random audit sample.

Do not select only uncertain examples; that creates a distorted training distribution. Keep a mixture of random, representative, rare, and failure-focused samples.

### 8.9 Real data without synthetic scene generation

The primary corpus can remain real footage. Still use physically reasonable transformations derived from real samples:

- codec recompression;
- exposure/gamma changes within measured ranges;
- blur kernels sampled from real ball blur;
- crop/scale and mild geometric perturbations consistent with camera drift;
- real glare/shadow/noise overlays cut from owned footage;
- frame drops and timestamp jitter for robustness tests.

These are augmentations of real observations, not replacements for real match data. Never use generative restoration or super-resolution output as legal evidence.

---

## 9. Measurement and evaluation contracts

### 9.1 First run an observability study

Before training the ball model, sample at least 1,000 decisive windows and report:

- visible ball minor-axis pixels by court depth;
- blur length and blur-to-ball-size ratio;
- fraction visible/partially occluded/fully occluded/out of frame;
- usable observations within ±150 ms of decisive events;
- local contrast and saturation;
- spare/adjacent-ball conflicts;
- timestamp/drop/freeze integrity;
- line/net calibration error.

**Provisional redesign trigger:** if the tenth percentile of visible ball size in candidate decisive frames is below roughly four pixels, or too few decisive windows contain at least three usable observations, change optics, camera placement, exposure, or number/type of views before spending heavily on model search. Four pixels is only a signal-presence screen, not enough for line or touch adjudication.

### 9.2 Subsystem metrics

| Subsystem | Required metrics |
|---|---|
| Court/calibration | reprojection error; surveyed world error; net/antenna error; drift recall, delay, and false alarms |
| Active players | active-player recall; distractor false positives/hour; HOTA, AssA, IDF1; identity switches/match; server-team/player accuracy; side-switch recovery |
| Ball | precision/recall at pixel thresholds; error normalized by ball diameter; blur-centre/extent error; visibility confusion; false tracks/hour; active-ball identity accuracy; hallucinated observations during occlusion; usable decisive-window coverage |
| Rally state | event F1 at ±0.25/0.5/1.0 s; duplicate/missed transitions; causal latency; ordinary-versus-exception confusion |
| Referee/scoreboard/audio | class precision/recall; false alarms/hour; temporal error; adjacent-court confusion; missing-signal handling |
| Fusion | rally-result confusion matrix; exception false accept; unresolved rate; risk-coverage; calibration; proposal latency |
| Full score | exact state after every authorized event; full-match perfect path; first divergence; recovery after correction; deterministic replay equality |
| Human workflow | review time; actions per ordinary point; overrides; correction time; automation-bias incidents; scorer error with/without assistant |

### 9.3 Selective prediction

For every proposed automatic or one-tap path, report both:

- **coverage** — fraction of eligible opportunities accepted;
- **selective risk** — wrong accepted proposals divided by accepted proposals.

A system that reaches high accuracy by abstaining on half the match is different from one that covers almost every ordinary point. Never publish only “accuracy.”

### 9.4 Calibration

Report reliability diagrams, Brier score, negative log likelihood, expected calibration error with sensitivity to binning, and class/domain-specific calibration. Calibrate on a dedicated set, not on the model-selection test.

Confidence should combine:

- model uncertainty;
- observation quality and visibility;
- domain/camera health;
- agreement or conflict among evidence channels;
- legal-state eligibility;
- active-ball/player identity certainty.

### 9.5 Confidence intervals

Frames and rallies from one match are correlated. Use match- or venue-day-cluster bootstrap, paired when comparing candidates on the same matches. For rare accepted errors, report one-sided exact/binomial bounds plus cluster sensitivity.

With zero observed independent errors, about 2,995 accepted decisions are required merely to put a one-sided 95% upper bound below 0.1%; correlation increases the effective requirement. A small set with zero errors is not proof of safety.

### 9.6 Provisional product gates to ratify after the first baseline

These values give the agent a starting contract. The owner must ratify them after measuring annotation noise and operational needs.

#### Assistive v0 gate

- deterministic reducer/event-store tests: 100% pass;
- no model can write an authorized event;
- ordinary-point proposal precision: at least 99% at reported coverage on prospective shadow data;
- replay/administrative/terminal cases never silently treated as ordinary in the release set;
- rally proposal p95 latency: under 1 second from detected rally end;
- review clip p95 availability: under 2 seconds;
- median human ordinary-point interaction: no more than two actions and no slower than baseline manual workflow;
- target-device export parity passes;
- all model/data/weight rights resolved.

#### Any future automatic-authorization gate

- separate governing-body/product-owner risk approval;
- one-sided 95% upper bound on accepted wrong-point risk below 0.1% as an initial ceiling, or a stricter approved value;
- zero accepted exception-as-ordinary errors in the prospective release set;
- exact prior state/version, continuous capture, known server/order, nonterminal state, and no active exception for every accepted event;
- full evidence bundle durably stored before authorization;
- rollback and correction drills pass;
- human override remains immediately available.

---

## 10. The agent-operated research loop

### 10.1 “Unblockable” must mean resumable and self-diagnosing

No loop is literally unblockable. An agent cannot ethically or reliably manufacture:

- missing commercial rights;
- an official ruling on an ambiguous rally;
- photons that the camera never captured;
- money beyond its budget;
- physical calibration or a replaced camera;
- a product risk decision.

The correct objective is a loop that:

- survives process/GPU/network failures;
- resumes from checkpoints;
- distinguishes transient from deterministic failures;
- records every decision;
- fails closed on leakage, rights, and safety problems;
- creates a precise blocker packet with the smallest required human action;
- can move to another approved campaign while one campaign is blocked.

### 10.2 Recommended control architecture

| Role | Responsibility | Trust boundary |
|---|---|---|
| Campaign controller | durable state machine, retries, budgets, timeouts, signals, checkpoints | deterministic; owns workflow state |
| Research agent (Fable 5 or replaceable model) | reads allowed context, proposes one hypothesis, edits allowlisted files, explains result | untrusted researcher; replaceable brain |
| Experiment executor | builds isolated environment, runs approved commands on GPU, uploads artifacts | no access to hidden labels or production credentials |
| Sealed evaluator | computes locked metrics and slice reports | read-only harness; hidden labels; separate credentials |
| Data curator | builds FiftyOne views and annotation queues | cannot alter sealed test or rights status |
| Human gatekeeper | approves campaign scope, budget increases, ontology changes, rights, promotion/release | only authority for irreversible/high-impact decisions |

**Temporal** is the recommended durable outer controller for unattended multi-day loops because it persists workflow history and supports retries, signals, replay, and worker recovery. LangGraph or an agent SDK may be used inside the research-agent activity if useful, but it is not the canonical experiment state machine.

### 10.3 Campaign state machine

```text
DRAFT
  -> PREFLIGHT
  -> BASELINE
  -> PROPOSED
  -> RUNNING
  -> EVALUATED
  -> KEEP | DISCARD | BLOCKED
  -> (next PROPOSED) or PROMOTION_CANDIDATE
  -> HUMAN_REVIEW
  -> CLOSED | PROMOTED
```

A campaign is one bounded research question such as:

- “Does blur supervision improve active-ball localization on far-court serves?”
- “Does RT-DETRv4-S reduce active-player misses without exceeding target latency?”
- “Does referee-signal evidence improve ordinary-point selective risk?”

Do not let a campaign simultaneously change architecture, data, labels, optimizer, augmentation, and evaluator.

### 10.4 Multi-fidelity experiment budget

Do not directly copy autoresearch's fixed five-minute budget across heterogeneous CV models. It systematically favors models with faster startup or early convergence.

Use stages:

| Stage | Goal | Typical policy |
|---|---|---|
| Preflight | catch data, shape, license, export, and dependency errors | tiny batch; no performance verdict |
| Smoke | prove loss decreases and metrics execute | fixed examples/optimizer steps |
| Screen | compare hypotheses cheaply | fixed data exposure and one seed; early pruning allowed |
| Full | establish candidate result | full approved schedule; same data exposure as baseline |
| Promotion | estimate variance and target-device behavior | 2–3 seeds or paired cluster bootstrap; export/parity/latency |
| Release | test once on sealed and prospective sets | human-authorized only |

Use wall-clock/cost as constraints, not as the sole fairness definition.

### 10.5 Agent permissions

The research agent may:

- read the project charter, architecture, ontology, allowed training data manifests, public sources, prior run summaries, and error logs;
- edit allowlisted model, training, data-transform, and configuration files in an isolated worktree;
- launch only approved commands through the executor;
- start or query approved Optuna studies;
- query MLflow, FiftyOne, and the human-decision ledger;
- propose an annotation batch;
- create a blocker packet;
- keep or discard a research branch according to machine gates.

The research agent may not:

- read sealed labels or raw evaluator outputs beyond the returned report;
- edit the evaluator, split manifests, rights registry, release thresholds, production aliases, or production score service;
- widen the campaign objective or budget;
- silently install or upgrade dependencies;
- use footage without a cleared rights status;
- merge to protected branches;
- promote a model to production;
- convert predicted/occluded ball points into ground truth;
- suppress failed runs or unfavorable slices;
- run indefinitely without a stop condition.

### 10.6 Retry and blocker policy

| Failure type | Agent/controller action |
|---|---|
| transient API/network/preempted GPU | resume/retry with exponential backoff, maximum three attempts |
| out of memory | one bounded fallback using approved batch/precision strategy; otherwise blocked |
| deterministic data/schema error | no blind retry; diagnose and propose one fix |
| same failure signature twice | create blocker packet |
| corrupted/missing data | quarantine asset; do not relabel as negative |
| evaluator integrity/leak suspicion | stop campaign immediately and notify human |
| rights/license ambiguity | stop use of artifact and request human/legal resolution |
| target metric plateau | stop after predeclared patience; produce failure analysis and label queue |
| budget exhausted | stop; preserve checkpoints and report marginal progress per cost |

A blocker packet contains: reason code, evidence, attempts, affected artifacts, minimal human action, alternatives, cost/risk of each alternative, and a resume token/state.

### 10.7 Keep/discard decision rule

A candidate is retained for further study only when all hard gates pass and at least one predeclared objective improves.

Hard gates, in order:

1. rights and provenance valid;
2. no split or evaluator leakage;
3. run reproducible from recorded manifests;
4. no NaN/corruption/incomplete metric state;
5. no critical safety-slice regression beyond tolerance;
6. calibration and abstention behavior acceptable;
7. target-device export parity and latency within budget;
8. primary metric improvement exceeds the predeclared minimum and noise floor.

Use paired match-level bootstrap for model comparisons. A tiny aggregate gain that comes from one venue or sacrifices an important slice is not a win.

### 10.8 Human checkpoints

The owner should remain hands-off during ordinary experiment execution but is required at:

- campaign charter approval;
- first annotation handbook/ontology freeze;
- data-rights decisions;
- changes to splits or evaluation policy;
- budget expansion;
- new model/checkpoint/license introduction;
- promotion to sealed test;
- production or automatic-authorization release.

---

## 11. Required repository documents and machine contracts

Fable 5 should not begin a persistent loop until these artifacts exist.

| File / record | Required contents | Who may edit |
|---|---|---|
| `PROJECT_CHARTER.md` | product objective, supported/unsupported features, risk policy, authority boundaries | human-approved |
| `ARCHITECTURE.md` | this v2 architecture, interfaces, model roles | reviewed changes only |
| `ONTOLOGY.md` | labels, unknown/occlusion semantics, rule event definitions, examples | human + rule expert |
| `RIGHTS_REGISTRY.csv` | source owner, training/eval/commercial/redistribution rights, term, restrictions, lineage | human/legal only |
| `DATA_MANIFEST.json` | content hashes, source/time/camera, derivatives, labels, rights ID | pipeline-generated |
| `SPLIT_MANIFEST.json` | full-match group assignments and leakage checks | evaluator owner only |
| `CAMPAIGN.md` | one question, baseline, metric, slices, budget, allowed mutations, stop rule | human-approved start |
| `MUTATION_POLICY.md` | files/parameters/tools the agent can change | human/platform owner |
| `COMMAND_CATALOG.md` | exact approved train/eval/profile/export commands and expected outputs | platform owner |
| `ENVIRONMENT_LOCK.json` | container, dependencies, CUDA/PyTorch, model hashes | pipeline-generated/reviewed |
| `EVAL_CONTRACT.md` | metrics, tolerances, eligibility, statistical method, hidden-label interface | evaluator owner only |
| `BASELINE.json` | baseline run IDs and metrics | evaluator-generated |
| `RUN_MANIFEST.json` | all reproducibility metadata for one run | executor-generated |
| `RESULTS.json` | machine-readable metrics, slices, uncertainty, latency, cost | evaluator-generated |
| `DECISION.md` | hypothesis, result, keep/discard rationale, next step | agent; machine-validated |
| `BLOCKER.md` | structured minimal human request | agent/controller |
| `RELEASE_CARD.md` | intended use, unsupported domains, data/weights/licenses, metrics, calibration, hardware | human-approved |
| MLflow record | parameters, metrics, artifacts, model versions/aliases | services; promotion restricted |
| append-only decision ledger | campaign openings, human approvals, keeps/discards, promotions | append-only |

### 11.1 Campaign charter fields

Every campaign must declare before execution:

- hypothesis and mechanism;
- one primary metric;
- critical slice metrics;
- baseline run/model;
- allowed data and split versions;
- allowed files and mutation classes;
- compute/cost/trial limits;
- minimum meaningful improvement;
- regression tolerances;
- number of seeds/stages;
- stop/plateau rules;
- export and latency target;
- licenses/checkpoints permitted;
- human owner and blocker channel.

### 11.2 Machine-readable outputs

The controller must be able to determine without reading prose:

- run success/failure and failure class;
- complete/incomplete metrics;
- primary metric delta and confidence interval;
- every critical-slice delta;
- coverage and selective risk;
- calibration status;
- target-device latency and export parity;
- spend and budget remaining;
- rights/eval-integrity gates;
- keep/discard/block decision;
- next resumable state.

---

## 12. First controlled benchmark matrix

### 12.1 Perception experiments

| ID | Fixed inputs | Baseline | Challengers | Primary decision |
|---|---|---|---|---|
| C0 | matched native videos | historical 1080p30 | native 4K60; synchronized dual 4K60; optional referee/score camera | which capture configuration preserves useful evidence per dollar |
| C1 | surveyed court frames | manual OpenCV | learned keypoints; distortion-aware sports registration | manual repeatability and auto-recovery value |
| P1 | active-player gold set | D-FINE-S | RT-DETRv4-S; RF-DETR-S | active-player recall/latency tradeoff |
| P2 | same detections | ByteTrack + constraints | OC-SORT/TrackTrack; BoT-SORT ± ReID | identity switches and server-slot accuracy |
| B1 | ball observability set | WASB-style reproduction | custom blur-aware; TrackNetV4; causalized TOTNet | usable decisive-window coverage and false tracks/hour |
| B2 | multiple-ball set | single best track | top-K active-ball posterior | active-ball identity errors and abstention |
| R1 | rally-state gold set | rules/features + HSMM | causal TCN; GRU; compact video encoder; V-JEPA features | event F1, exception recall, causal latency |
| E1 | referee/score/audio set | none | each evidence channel alone and in combinations | marginal reduction in selective risk and review time |
| Q1 | coarse semantic clip set | specialist/rules baseline | frozen Qwen3-VL-2B; SFT only if justified | whether VLM adds unique value at acceptable latency/consistency |

### 12.2 End-to-end experiments

| ID | System | Evaluation |
|---|---|---|
| S0 | human scorer + reducer only | workflow baseline, exact score, actions/time |
| S1 | scorebug weak-label replay | label lag/noise and event-reconstruction ceiling |
| S2 | rally phase + referee/scoreboard + human confirm | immediate assistive scoring value without ball dependency |
| S3 | S2 + players/next-server checksum | service-order and disagreement detection |
| S4 | S3 + active-ball evidence | incremental precision/coverage and review-time reduction |
| S5 | full modular system in prospective shadow | selective risk, calibration, exact full-match path, domain shift |
| S6 | single versus dual court view | trajectory/occlusion/coverage gain versus cost/complexity |

A subsystem is included only if its **incremental** contribution improves product-level selective risk, coverage, latency, or human workload. A sophisticated ball/pose model that does not improve scoring should remain an analytics component.

---

## 13. 30/60/90-day sequence

### Days 0–30 — make truth and execution reliable

- Freeze the v2 architecture and authority boundaries.
- Implement/verify authenticated human authorization, durable authorized-event storage, correction semantics, and deterministic reducer replay.
- Complete rights/provenance inventory for footage, annotations, repositories, and checkpoints.
- Replace “gold OCR” terminology with weak/silver versus human-reconciled gold.
- Build 20–30 full-match gold event ledgers or start with the highest-diversity subset available.
- Run capture observability, timestamp, drop/freeze, and ball-pixel/blur census.
- Establish manual court calibration and four-click player initialization.
- Stand up MLflow, immutable manifests/DVC, FiftyOne, CVAT, and the sealed evaluator.
- Stand up the campaign controller in a DB-backed local mode or Temporal.
- Establish no-ML and referee/scorebug/scorer baselines before training a large video model.

**Day-30 gate:** do not begin expensive ball-model search unless footage rights, observability, split integrity, and annotation semantics pass.

### Days 31–60 — train minimum specialist baselines

- D-FINE-S active-player detector and ByteTrack constrained tracker.
- Custom causal blur-aware ball baseline on the selected windows.
- Causal rally-state TCN/GRU plus HSMM/factor graph.
- Referee signal, scoreboard transition, whistle/contact baselines.
- Active-ball top-K association and server-initialization logic.
- Target-device export/parity and latency measurements on every candidate.
- Run benchmark matrix C0–E1.
- Run active-learning round one from uncertainty, disagreement, novel clusters, and random audit.

**Day-60 gate:** select one production baseline and at least one challenger per critical subsystem. Reject any candidate whose gain depends on hidden future frames, unclear rights, test leakage, or unavailable hardware.

### Days 61–90 — end-to-end prospective shadow

- Freeze model/config/ontology/split versions.
- Run S0–S5 on future matches and multiple domains.
- Measure score proposal precision/coverage, exact score state, review time, override causes, and human workflow.
- Reconcile every high-confidence error and every exception mistake.
- Run camera/referee-view A/B and single-versus-dual court-view study.
- Perform capture, database, stale-version, retry, correction, and model-outage failure injection.
- Produce release cards and unsupported-domain list.
- Release assistive scoring only if v0 gates pass; keep autonomous mutation disabled otherwise.

---

## 14. What the project owner must provide

### 14.1 Required before the agent can run autonomously

1. **Repository access and branch policy** — including existing reducer/readiness tests and the exact commands that currently pass.
2. **Footage rights statement** — who owns each source; whether commercial ML training, derivative weights, evaluation, and retention are permitted.
3. **Corpus inventory** — VOD path/hash, match, date, venue/court, camera, resolution/frame rate, transcode lineage, audio, scorebug version, and known issues.
4. **Camera/deployment inventory** — lenses, mounting geometry, native output, exposure controls, target live hardware, and whether a referee/score camera or e-score feed is possible.
5. **Ruleset scope** — FIVB, USAV, NCAA, local amendments, and competition formats.
6. **Human-reconciled score ledgers** — initially 20–30 diverse matches if possible, or a smaller staged plan.
7. **Roster/team/service-order metadata** — at least for the gold matches.
8. **Annotation availability** — who can review court, player, ball, event, and exception labels; expected weekly capacity.
9. **Risk and product goals** — assistive only versus eventual automation; acceptable wrong-proposal risk; useful coverage; review latency.
10. **Compute budget and target hardware** — monthly hard cap, allowed GPU types/providers, storage and egress constraints.
11. **Credentials and secrets** — provided through a secret manager, never placed in prompts or Git.
12. **Blocker owner and response channel** — a human who can resolve rights, hardware, labels, and budget decisions.

### 14.2 Gold event-ledger fields

Each authoritative transition should contain:

- match/set/event sequence ID;
- approximate rally start and end interval;
- score before and after;
- official event type;
- team awarded point, if any;
- serving team/player before and after, when known;
- side and service-order state;
- ordinary/replay/challenge/sanction/correction/timeout/terminal classification;
- source of truth and reviewer;
- confidence/ambiguity note;
- synchronized evidence references.

You do not need to annotate every contact in order to build scoring v0.

### 14.3 Decisions the owner must make explicitly

- Is the first released product strictly human-authorized?
- Is an official scorer/referee feed available?
- Can one cheap evidence camera be added?
- Which rulesets are in scope first?
- What is the accepted risk budget and minimum useful coverage?
- Which open-source licenses are permitted?
- Are athlete identity/biometric processing and minors in scope?
- How long may raw video/audio/evidence be retained?
- Who can approve a correction, terminal event, sanction, or model promotion?

---

## 15. Stop and redesign conditions

Stop the current approach and redesign when any of these occur:

| Condition | Required response |
|---|---|
| Footage or checkpoint commercial rights unresolved | quarantine asset; do not train or promote derivative model |
| Ball observability fails pixel/blur/visibility census | change optics, exposure, camera placement, tiling, or views before architecture search |
| Scorebug labels have uncontrolled lag/corrections | increase human gold set and use interval labels; do not call OCR gold |
| Active players cannot be retained through side switches/occlusions | add operator re-confirmation or a better evidence view before generic ReID escalation |
| Active-ball identity remains ambiguous around spare/adjacent balls | maintain abstention/top-K; add serve initialization or camera geometry; do not force a track |
| Referee/score feed alone delivers the scoring goal | stop making ball tracking a scoring prerequisite; move ball to analytics/review evidence |
| Exception classifier misses rare legal paths | keep all score authorization human; expand exception labels and direct official inputs |
| Model improves aggregate metric but regresses a critical slice | reject or restrict domain; do not average away safety failures |
| Agent alters eval/splits, hides failures, or exploits weak labels | invalidate campaign and rotate credentials/harness as needed |
| Full-match exact score diverges despite strong rally accuracy | prioritize event/order/correction semantics over detector improvements |
| Second 4K view gives negligible product gain | do not purchase/deploy it for scoring; reserve for trajectory research |
| Human review becomes slower or less accurate | redesign UI/evidence ordering; do not ship because model metrics look good |
| Target device cannot sustain latency/thermals | choose smaller model, lower noncritical cadence, or different hardware |

---

## 16. Recommended production baseline and challengers

| Subsystem | Production baseline | Challenger 1 | Challenger 2 | Challenger 3 |
|---|---|---|---|---|
| Court | manual surveyed OpenCV + drift detector | learned court keypoints | unified distortion-aware registration | segmentation-assisted setup |
| Active people | D-FINE-S | RT-DETRv4-S | RF-DETR-S | commercially licensed detector if justified |
| Tracking | ByteTrack + match constraints | OC-SORT | TrackTrack | BoT-SORT ± ReID |
| Ball | custom causal blur-aware heatmap/visibility model | WASB-style | BlurBall-style | TrackNetV4 / causalized TOTNet |
| Active-ball association | top-K probabilistic track hypotheses initialized at serve | learned graph association | dual-view epipolar association | physics-constrained particle filter |
| Rally phase | causal TCN/GRU emissions + HSMM/factor graph | compact owned-data video encoder | V-JEPA 2.1 features | causal state-space model |
| Referee/score | small owned-data classifier/OCR + direct feed where possible | Qwen3-VL offline structured QA | SAM-assisted annotation | dedicated evidence camera |
| Pose | RTMPose on event crops, later | RTMW | ViTPose | RTMO |
| Audio | small owned-data log-mel CNN | EfficientAT initialization | PANNs initialization | BEATs/OpenBEATs after provenance review |
| Research agent | Fable 5 through stable campaign/tool contract | Claude/Codex/other capable agent | ensemble review agent | human researcher |
| Orchestration | Temporal | Prefect/Dagster for simpler DAG-first workflow | DB-backed queue for local prototype | managed agent platform behind same contract |

---

## 17. Source-linked bibliography

### Rules and officiating

1. FIVB, **Official Beach Volleyball Rules 2025–2028**, current rules PDF, published/commissioned for the 2025–2028 cycle. [Official PDF](https://www.fivb.com/wp-content/uploads/2025/02/FIVB-BeachVolleyball_Rules2025_2028-EN-v01.pdf)
2. FIVB, **Beach Volleyball Video Challenge System Regulations**, March 2025. [Official PDF](https://www.fivb.com/wp-content/uploads/2024/07/2025-Beach-Volleyball-Video-Challenge-System-Regulations_Mar-2025.pdf)
3. USA Volleyball, **2025–2027 USAV Beach Rules Book**. [Official PDF](https://usavolleyball.org/wp-content/uploads/2023/09/2025-2027-USAV-Beach-Rules-Book_FINAL.pdf)
4. NCAA, **2026 Beach Volleyball Rules Modifications**, February 2026. [Official PDF](https://ncaaorg.s3.amazonaws.com/championships/sports/volleyball/rules/beach/2026PRWSV_RulesMods.pdf)

### Ball, detection, tracking, calibration, and pose

5. NTT Communications et al., **WASB: Widely Applicable Strong Baseline for Sports Ball Detection and Tracking**, BMVC 2023. [Official repository](https://github.com/nttcom/WASB-SBDT)
6. Gossard et al., **BlurBall: Joint Ball and Motion Blur Estimation for Table Tennis Ball Tracking**, CVPR Sports Workshop 2026. [Official repository](https://github.com/cogsys-tuebingen/blurball)
7. Xu et al., **TOTNet: Occlusion-Aware Temporal Tracking for Robust Ball Detection in Sports Videos**, 2026. [Official repository](https://github.com/AugustRushG/TOTNet)
8. Raj et al., **TrackNetV4**, ICASSP 2025. [Official repository](https://github.com/TrackNetV4/TrackNetV4)
9. Peng et al., **D-FINE**, ICLR 2025 Spotlight. [Official repository](https://github.com/Peterande/D-FINE)
10. **RT-DETRv4**, accepted ECCV 2026; repository update June 18, 2026. [Official repository](https://github.com/RT-DETRs/RT-DETRv4)
11. **RF-DETR**, ICLR 2026. [Official repository and component license table](https://github.com/roboflow/rf-detr)
12. Zhang et al., **ByteTrack**, ECCV 2022. [Official repository](https://github.com/FoundationVision/ByteTrack)
13. OpenMMLab, **MMPose/RTMPose**. [Official repository](https://github.com/open-mmlab/mmpose)
14. OpenCV. [Official repository](https://github.com/opencv/opencv)
15. Theiner et al., **Unified Sports Field Registration with Lens Distortion Modeling**, CVPR Sports Workshop 2026. [CVF paper](https://openaccess.thecvf.com/content/CVPR2026W/CVsports/html/Theiner_Unified_Sports_Field_Registration_with_Lens_Distortion_Modeling_CVPRW_2026_paper.html)

### Video and multimodal foundation models

16. Qwen Team, **Qwen3-VL**. [Official repository](https://github.com/QwenLM/Qwen3-VL)
17. Qwen Team, **Qwen3-VL-2B-Instruct model card**, Apache-2.0 listing, released October 21, 2025. [Official model card](https://huggingface.co/Qwen/Qwen3-VL-2B-Instruct)
18. Meta FAIR, **V-JEPA 2 / V-JEPA 2.1**, V-JEPA 2.1 release March 16, 2026. [Official repository](https://github.com/facebookresearch/vjepa2)
19. Meta, **SAM 3 / SAM 3.1**, SAM 3.1 release March 27, 2026. [Official repository](https://github.com/facebookresearch/sam3)
20. MCG-NJU, **VideoMAE**. The official repository states most of the project is CC BY-NC 4.0. [Official repository/license notice](https://github.com/MCG-NJU/VideoMAE)

### Training, data, evaluation, and orchestration

21. Lightning, **Fabric documentation**. [Official docs](https://lightning.ai/docs/fabric/stable/)
22. Hugging Face, **Trainer documentation**. [Official docs](https://huggingface.co/docs/transformers/main_classes/trainer)
23. Optuna, **hyperparameter optimization and pruning**. [Official docs](https://optuna.readthedocs.io/)
24. MLflow, **Model Registry** and **Dataset Tracking**. [Registry](https://mlflow.org/docs/latest/ml/model-registry/) · [Dataset tracking](https://mlflow.org/docs/latest/ml/dataset/)
25. DVC, **data pipelines and versioning**. [Official docs](https://doc.dvc.org/start/data-pipelines/data-pipelines)
26. Voxel51, **FiftyOne Brain**, similarity, failure mining, duplicates, and split leakage. [Official docs](https://docs.voxel51.com/brain.html)
27. CVAT, **video annotation and interpolation**. [Official 2026 guide](https://www.cvat.ai/resources/blog/video-annotation-guide)
28. Cleanlab, **data and label issue detection**. [Official docs](https://docs.cleanlab.ai/)
29. Temporal, **Workflow Execution and Durable Execution**. [Official docs](https://docs.temporal.io/workflow-execution)
30. Karpathy, **autoresearch**, March 2026. [Official repository](https://github.com/karpathy/autoresearch)

### Agent-loop and eval guidance

31. Anthropic, **Building Effective Agents**, December 19, 2024. [Official article](https://www.anthropic.com/research/building-effective-agents)
32. Anthropic, **Effective harnesses for long-running agents**, November 26, 2025. [Official article](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)
33. Anthropic, **Demystifying evals for AI agents**, January 9, 2026. [Official article](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)
34. Anthropic, **Long-running Claude for scientific computing**, March 23, 2026. [Official article](https://www.anthropic.com/research/long-running-Claude)
35. Anthropic, **Harness design for long-running application development**, March 24, 2026. [Official article](https://www.anthropic.com/engineering/harness-design-long-running-apps)
36. OpenAI, **Testing Agent Skills Systematically with Evals**, January 22, 2026. [Official article](https://developers.openai.com/blog/eval-skills)
37. OpenAI, **Build an Agent Improvement Loop with Traces, Evals, and Codex**, May 12, 2026. [Official cookbook](https://developers.openai.com/cookbook/examples/agents_sdk/agent_improvement_loop)
38. OpenAI, **Evaluation best practices**. Note that the hosted Evals product is scheduled for deprecation in late 2026; use the methodological guidance rather than building a new dependency on that product. [Official guide](https://developers.openai.com/api/docs/guides/evaluation-best-practices)

---

## 18. Final handoff instruction

Fable 5 should begin with **Campaign 0: architecture and data preflight**, not model training.

Its first deliverable is a machine-checkable readiness report answering:

1. Are all data and checkpoint rights resolved?
2. Are the train/search/selection/test/prospective splits leakage-safe?
3. What is the measured ball size, blur, visibility, and capture-integrity distribution?
4. How noisy and delayed are scorebug labels relative to human-reconciled events?
5. Does the reducer reproduce every gold event ledger exactly?
6. Can the four active athletes be initialized and tracked through a full match with acceptable identity error?
7. What no-ML/direct-evidence baseline can already assist scoring?
8. Which single first model experiment has the highest information value?

Only after those answers are recorded should the controller open the first bounded training campaign.
