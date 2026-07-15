# ScoreVision Zero-Touch Autonomy Correction

**Directive for Fable 5**  
**Status:** This document supersedes any runtime guidance in earlier ScoreVision documents or chat messages that requires an operator to select players, confirm athletes, approve points, review low-confidence events, reacquire tracks, configure a court, or correct the score during normal operation.

## 1. Non-negotiable product contract

ScoreVision is a **zero-touch autonomous runtime system**.

When a supported live video stream becomes available, the engine must immediately begin processing it and must autonomously:

1. identify the primary beach-volleyball court and its geometry;
2. determine whether a match, warmup, interval, timeout, replay, or inactive scene is present;
3. identify the four active athletes among all visible people;
4. partition those athletes into two persistent teams and maintain identity through side switches and occlusions;
5. identify the currently active match ball among spare balls, adjacent-court balls, retriever-thrown balls, and other false candidates;
6. detect service, rally start, rally end, replay/no-point, set transitions, side switches, and other supported state transitions;
7. infer the rally winner from all available evidence;
8. update the legal score through a deterministic rules reducer;
9. recover automatically after track loss, camera interruption, uncertainty, or contradictory evidence;
10. persist an auditable event and evidence history.

There is **no runtime operator initialization**, no athlete clicking, no manual calibration, no one-tap confirmation, no human review queue, and no requirement that a person correct ordinary scoring errors.

Offline human work remains permitted for creating and auditing training/evaluation labels. That is a development process, not a runtime dependency.

## 2. Corrections to earlier architecture guidance

Remove or replace all runtime language equivalent to:

- “operator clicks or confirms the four athletes”;
- “human authorizes every point”;
- “low confidence goes to human review”;
- “one-click track reacquisition”;
- “assistive confirm UI” as a required scoring stage;
- “manual court setup”;
- “human correction is the normal recovery path.”

Replace it with:

- autonomous court and scene lock;
- autonomous active-roster inference;
- autonomous team and player-slot assignment;
- autonomous active-ball lifecycle management;
- autonomous evidence fusion and policy authorization;
- automatic provisional scoring, finalization, reconciliation, and correction;
- diagnostic interfaces that observe the system but are never required to let it proceed.

Keep the prior separation between perception and legal state mutation. A perception model still must not directly edit the score. Instead, an **autonomous policy authorizer** evaluates the model evidence, current state hypotheses, rules constraints, and capture health, then emits an authorized domain event to the deterministic reducer.

## 3. One unavoidable startup constraint

A vision system cannot infer an unseen historical score from future images alone.

Two streams can be visually identical from time `t` onward even though the score before `t` was different. Therefore, exact zero-touch score synchronization requires at least one of these autonomous inputs:

1. the engine observes the match from before the first legal serve and initializes the detected match at 0–0;
2. the engine restores a previously persisted match state for the stream;
3. the engine can inspect a rewind buffer or earlier recording and reconstruct the score path;
4. the engine can read an existing scorebug, venue scoreboard, electronic score feed, or equivalent state source.

Do not solve this with an operator prompt.

Implement autonomous startup modes:

- `COLD_START_PREMATCH`: detect the new match and initialize 0–0;
- `RESUME_PERSISTED`: restore the last cryptographically linked state and continue;
- `REWIND_RECONSTRUCT`: process the available history faster than real time, then catch up;
- `VISUAL_SCORE_SYNC`: read a visible score display and verify it against subsequent play;
- `UNSYNCHRONIZED_MIDMATCH`: track future rallies and score differential while clearly marking the absolute score as not yet synchronized.

The engine begins processing immediately in every mode. It must never invent an exact historical score that is not observable.

## 4. Revised runtime architecture

```text
LIVE STREAM
    |
    v
CAPTURE HEALTH + STREAM IDENTITY
    |
    v
AUTONOMOUS SCENE / COURT DISCOVERY
    |-- detect all court candidates
    |-- select primary complete court or spawn one worker per supported court
    |-- estimate lines, net, posts, antennae, service/free zones, distortion
    |-- validate and monitor calibration drift
    v
AUTONOMOUS MATCH-ENTITY DISCOVERY
    |-- detect and track all people
    |-- infer four active-player roles from temporal participation
    |-- partition into persistent Team A / Team B
    |-- assign logical slots A1, A2, B1, B2
    |-- recover identities automatically after occlusion and side switches
    v
AUTONOMOUS ACTIVE-BALL MANAGER
    |-- detect all ball-like candidates
    |-- initialize active-ball hypotheses at serve preparation/toss
    |-- maintain top-K hypotheses through contacts and occlusion
    |-- reject spare, adjacent-court, static, and retriever balls
    |-- reacquire automatically at every service cycle
    v
CAUSAL OBSERVATION STREAMS
    |-- service / play / dead-ball phase
    |-- ball position, visibility, trajectory, landing candidates
    |-- player motion, pose, contact candidates, server identity
    |-- referee gestures, whistle/audio, score-display changes
    |-- timeout, challenge, replay, correction, terminal cues
    v
CONSTRAINED TEMPORAL FUSION
    |-- HSMM / factor graph / constrained Bayesian state model
    |-- learned emission models, deterministic legal constraints
    |-- maintains N-best rally and match-state hypotheses
    v
AUTONOMOUS POLICY AUTHORIZER
    |-- emits provisional event immediately when useful
    |-- finalizes when evidence threshold is reached
    |-- chooses MAP outcome at bounded deadline if necessary
    |-- generates automatic correction when later evidence contradicts
    v
DETERMINISTIC RULES REDUCER
    |
    v
EVENT-SOURCED SCORE + SERVER + ORDER + SET/MATCH STATE
```

## 5. Autonomous court discovery

Court geometry is part of the scoring critical path, not merely an analytics feature.

The engine must use it to:

- establish the target match region;
- reject spectators and adjacent-court activity;
- determine near/far or left/right team occupancy;
- locate service zones and end lines;
- normalize player and ball coordinates;
- detect side switches;
- constrain active-ball hypotheses;
- detect whether the full supported court remains visible.

### Required implementation

Use a two-stage strategy:

1. **Fast learned court/net keypoint proposal** on startup and periodically thereafter.
2. **Geometric fitting and validation** using line intersections, net/post geometry, expected topology, RANSAC, lens-distortion parameters, and temporal stability.

A known camera profile may be loaded automatically from a camera/scene fingerprint, but no operator may select it. Unknown scenes must self-calibrate.

The primary court is selected automatically using a score over:

- geometric completeness;
- projected area and centrality;
- presence of a coherent net;
- repeated four-player activity;
- active-ball trajectories;
- association with the dominant match audio/score overlay when available.

If multiple complete courts are supported in one stream, spawn one independent match worker per court rather than forcing one global decision.

## 6. Autonomous active-player discovery

Do not define an active athlete as “a person currently inside the court polygon.” Players may leave the playing area while pursuing the ball, and officials or retrievers may enter relevant regions.

Detect and track all people, then infer four persistent active roles with a temporal participation model.

### Features for active-roster inference

For every person tracklet, compute:

- track duration and continuity;
- fraction of time in the court and free zone;
- repeated presence before, during, and after rallies;
- serve preparation and receive-position evidence;
- proximity to active-ball contacts;
- motion intensity and volleyball-specific movement;
- side occupancy relative to the net;
- pairwise coordination with another athlete;
- appearance embedding consistency;
- exclusion-zone evidence for referee stand, scorer table, spectator region, and ball-retriever paths.

Solve a constrained temporal assignment with exactly four active logical roles during normal play:

- `A1`, `A2`, `B1`, `B2`;
- exactly two athletes per team;
- team membership persists across side switches;
- court side may change only at a legal or strongly evidenced switch;
- player identity can be unknown while the logical slot remains tracked;
- track loss triggers automatic reacquisition using appearance, team, motion, service order, and state history.

Athlete names are not a prerequisite for scoring. The system may score with anonymous persistent logical identities.

## 7. Autonomous active-ball selection

The active match ball is a latent identity, not simply the highest-confidence ball detection.

Maintain multiple ball hypotheses with probabilities. Reinitialize the lifecycle at each service sequence.

### Serve-based initialization

The selected server and the serve state provide the strongest automatic initialization cue:

1. locate ball candidates held near or tossed by the candidate server;
2. require temporal motion consistent with a toss or release;
3. associate the candidate with serve contact and subsequent court-directed motion;
4. retain alternative hypotheses until evidence separates them.

### During the rally

Update hypotheses from:

- blur-aware multi-frame ball heatmaps;
- trajectory continuity and uncertainty;
- court/net geometry;
- plausible player-contact windows;
- expected flight and bounce/landing behavior;
- visibility and occlusion state;
- cross-view consistency when a second camera exists.

Explicitly classify:

- visible;
- partially occluded;
- fully occluded;
- out of frame;
- not present;
- indistinguishable among candidates;
- capture unknown.

Predicted positions through occlusion must never be mislabeled as observed positions.

Reject or down-weight candidates that are:

- stationary outside the service lifecycle;
- persistently outside the target court/free-zone volume;
- associated with a retriever or spectator;
- associated with an adjacent court;
- inconsistent with the selected server and subsequent contacts.

## 8. Autonomous scoring logic

Do not make next-server inference the sole scoring mechanism. Use it as powerful delayed evidence inside a larger autonomous fusion model.

### Evidence hierarchy

The rally-winner posterior may use:

1. direct ball outcome evidence: landing side, in/out region, net termination, trajectory cessation;
2. last-contact and team-side evidence;
3. referee point-direction and replay/no-point gestures;
4. scorebug or venue-score change when present;
5. whistle and other synchronized audio events;
6. player transition into service/receive formations;
7. next serving team and serving player;
8. celebration/regrouping evidence only as a weak cue;
9. deterministic rules and service-order constraints.

All cues must carry source quality, timing uncertainty, and correlation metadata. Two outputs derived from the same camera failure are not independent votes.

### Revised decision states

Remove runtime states that imply human intervention, such as `REVIEW`.

Use:

- `BOOTSTRAPPING` — scene and match state are being established;
- `LIVE` — current state is synchronized;
- `PROVISIONAL` — an automatic point estimate has been emitted but may change;
- `WAITING_FOR_EVIDENCE` — no final event yet; later causal evidence is expected;
- `AUTO_FINALIZED` — the autonomous authorizer has committed the event;
- `AUTO_CORRECTED` — a later autonomous event superseded an earlier conclusion;
- `UNSYNCHRONIZED` — future events are tracked but absolute score is not known;
- `DEGRADED` — one or more sensors are unavailable but scoring continues under a defined policy;
- `LOST` — capture or scene identity is insufficient to claim a score;
- `ENDED` — set or match terminal state reached.

### N-best state hypotheses

A single early mistake must not irreversibly corrupt the entire match.

Maintain an N-best beam of legal match-state hypotheses. Each hypothesis contains:

- score and set state;
- serving team/player and order;
- side assignments;
- pending replay/correction status;
- cumulative evidence likelihood;
- linked event history.

Later evidence such as the next server, score display, side switch, terminal score, or service order can eliminate inconsistent branches. The external score is the highest-posterior legal state, with provisional/final status.

### Automatic finalization and correction

The autonomous policy authorizer should:

1. issue a low-latency provisional result after rally end when confidence is adequate;
2. continue collecting causal evidence;
3. finalize when posterior margin, evidence completeness, and rules consistency meet the release policy;
4. at a bounded deadline, select the maximum-posterior legal outcome or remain explicitly unsynchronized/lost according to product policy;
5. automatically append a compensating correction event if later evidence invalidates a finalized event;
6. never delete or rewrite prior events.

This preserves zero-touch operation without pretending every decision is equally observable.

## 9. What “no human intervention” changes in the safety architecture

The system no longer relies on a human backstop, so the automated authorization policy becomes a safety-critical component.

Keep these boundaries:

- perception services cannot directly mutate score;
- only the autonomous policy authorizer can issue authorized domain events;
- every event is idempotent, versioned, signed, and linked to evidence;
- the deterministic reducer remains the sole legal state transition implementation;
- corrections are append-only compensating events;
- the system automatically rejects stale proposals and conflicting state versions;
- capture failure must produce `DEGRADED`, `UNSYNCHRONIZED`, or `LOST`, not a fabricated confident score.

The absence of an operator is not permission to hide uncertainty. The runtime must expose status and confidence programmatically while continuing autonomously under its policy.

## 10. Required training labels for zero-touch operation

The current corpus and scorebug labels are useful but insufficient for autonomous startup. Add labels for:

### Scene and court

- primary court instance;
- court corners/lines, net, posts, antennae;
- full-court-visible versus unsupported view;
- warmup, inactive court, replay, timeout, between sets, between matches;
- adjacent court instances.

### People and roles

- all person tracks;
- active athlete versus referee, scorer, retriever, spectator, coach, unknown;
- team membership;
- persistent logical player slot where possible;
- serving player;
- side-switch continuity;
- occlusion and reacquisition events.

### Ball identity

- every visible ball candidate in selected hard windows;
- active match ball versus spare/adjacent/retriever/unknown ball;
- serve lifecycle association;
- visibility and occlusion states;
- observed versus predicted trajectory points.

### Match state and events

- match start and set start;
- service preparation, authorization, toss, contact;
- rally start and end;
- ordinary point winner;
- replay/no-point;
- timeout and technical timeout;
- side switch;
- service-order anomaly;
- correction/challenge/sanction when represented in the footage;
- set and match terminal events;
- score checkpoints and serving team/player.

### Cold-start episodes

Build evaluation episodes beginning at:

- warmup;
- before the first serve;
- between rallies;
- during a rally;
- during a timeout;
- between sets;
- at a side switch;
- at an arbitrary mid-match timestamp;
- after a camera interruption;
- with a visible or absent scorebug.

## 11. Required zero-touch evaluation harness

The locked harness must provide the engine only the allowed runtime inputs. It may not inject court points, player IDs, team labels, server identity, score, or match phase unless the evaluated startup mode explicitly permits a persisted state or machine-readable score feed.

### Startup metrics

- primary-court selection accuracy;
- court-lock success rate and time to lock;
- false match-start rate;
- new-match detection accuracy;
- full-court-support classification;
- time to synchronized score;
- synchronization success by startup mode.

### Active-player metrics

- active-player set precision/recall;
- exact four-player-set accuracy;
- team partition accuracy;
- logical-slot continuity;
- side-switch identity continuity;
- automatic reacquisition success and latency;
- spectator/referee/retriever false inclusion rate.

### Active-ball metrics

- active-ball identity accuracy;
- false lock to spare/adjacent ball per hour;
- serve-initialization success;
- reacquisition success;
- visible-ball localization error;
- hallucinated observation rate during occlusion.

### Scoring metrics

- rally-boundary F1 and timing error;
- rally-winner accuracy;
- replay/no-point recall;
- exact score after every event;
- full-set and full-match exact-path rate;
- time to provisional point;
- time to final point;
- automatic correction frequency and correctness;
- first-divergence event index;
- recovery from divergence;
- serving-team/player and service-order accuracy.

### Zero-touch acceptance condition

A run is disqualified if it required any hidden manual initialization, clicked player, manually supplied court point, human point confirmation, manual track reassignment, or manual score correction.

## 12. Revised campaign order for the agentic training loop

Do not proceed directly from a rally classifier to ball tracking and then assume scoring is solved. Execute campaigns in this order:

### Campaign 0 — zero-touch harness and information contract

- implement cold-start episode generation;
- remove hidden metadata and manual seeds;
- define supported startup modes;
- establish no-ML and scorebug-only baselines;
- measure current end-to-end zero-touch performance.

### Campaign 1 — autonomous scene and court lock

- train/evaluate court, net, and scene-state detection;
- implement geometric validation and drift recovery;
- pass cold-start court-lock gates.

### Campaign 2 — autonomous four-player role discovery

- detect all people;
- train the active-participant classifier/graph model;
- implement persistent team and logical-slot assignment;
- pass exact-four-player, side-switch, and reacquisition gates.

### Campaign 3 — autonomous service and active-ball lifecycle

- identify candidate server;
- initialize top-K ball hypotheses from serve preparation/toss;
- train active-ball-versus-decoy association;
- pass spare-ball and adjacent-court challenge sets.

### Campaign 4 — rally phase and direct outcome evidence

- train causal rally-state emissions;
- add ball landing, last-contact, referee-signal, audio, and score-display observations;
- compare factor-graph/HSMM fusion against causal TCN/GRU challengers.

### Campaign 5 — N-best score-state inference

- implement legal hypothesis beam;
- use next server as delayed verification rather than sole attribution;
- implement provisional, final, and automatic correction events;
- evaluate exact score path and recovery.

### Campaign 6 — end-to-end zero-touch offline replay

- start from raw stream only;
- run complete matches without intervention;
- score exactness, latency, corrections, and failure modes.

### Campaign 7 — live shadow without control input

- deploy the identical zero-touch engine live;
- compare it to the official record after the fact;
- do not provide a confirmation or correction input to the engine.

### Campaign 8 — production autonomy hardening

- optimize inference, synchronization, persistence, restart recovery, model rollback, and failure injection;
- validate supported hardware and camera profiles;
- freeze the autonomous authorization policy.

## 13. Model-stack implications

Continue with a modular specialist architecture. Do not replace the entire runtime with one VLM.

Recommended roles:

- court/keypoint model plus geometric solver;
- player detector plus tracker;
- temporal active-participant and team-assignment model;
- blur-aware multi-frame ball model;
- service/server detector;
- small causal temporal models for event emissions;
- constrained probabilistic fusion and legal-state beam;
- deterministic reducer.

A Qwen-class VLM may be used offline for label proposals, semantic failure analysis, referee-gesture exploration, or as a benchmark challenger on coarse clips. It must not be the only source for tiny-ball localization, active-ball identity, legal score state, or low-latency event authorization.

Pose is not required to bootstrap scoring. Add it only where it measurably improves server detection, contact timing, or later analytics.

## 14. Runtime output contract

Expose at least:

```text
match_instance_id
engine_state
score_team_a
score_team_b
set_score_team_a
set_score_team_b
serving_team
serving_player_slot
team_side_mapping
score_status: provisional | final | unsynchronized | lost
confidence
last_event_id
last_event_type
last_event_time
last_correction_event_id
capture_health
court_lock_confidence
active_player_set_confidence
active_ball_confidence
ruleset_id
model_bundle_id
```

The engine may emit a provisional score immediately and revise it automatically. Consumers must be able to distinguish provisional from finalized state without asking a human.

## 15. Stop and redesign conditions

The agent must not hide structural impossibility behind more training.

Escalate a redesign when:

- the court cannot be automatically recovered with required geometry from the supported camera view;
- four active athletes cannot be separated from surrounding people at acceptable exact-set accuracy;
- the active ball is not observable often enough for direct outcome inference;
- mid-match absolute score is demanded without prior state, rewind history, or a visible/machine-readable score source;
- exact full-match score remains unstable because rare exceptions are absent from training;
- automatic corrections create oscillating or nonconvergent score histories;
- a second camera or a dedicated referee/score view provides materially better autonomy than further single-view model tuning.

A redesign may change camera placement, add a synchronized view, add a dedicated referee/score camera, or narrow the supported operating domain. It must not add an operator requirement.

## 16. Immediate work order

Perform these changes now:

1. Patch all ScoreVision architecture and execution documents to declare zero-touch runtime as non-negotiable.
2. Remove human confirmation, manual athlete selection, manual court calibration, and manual reacquisition from the runtime design.
3. Add the autonomous bootstrap state machine and startup modes.
4. Add the active-participant temporal assignment subsystem.
5. Add the top-K active-ball lifecycle subsystem.
6. Add N-best legal match-state hypotheses and automatic correction semantics.
7. Rewrite the evaluation harness so every end-to-end test begins from raw video without manual seeds.
8. Add random-start and mid-match synchronization tests.
9. Reorder the campaign plan around cold-start autonomy rather than manually initialized component accuracy.
10. Produce a readiness report that states which current code paths violate the zero-touch contract and the exact patch sequence to remove them.

## 17. Definition of done

The zero-touch milestone is complete only when a supported stream can be launched with one machine action—starting the engine—and the system, without any further input:

- discovers the court;
- identifies and tracks the four active athletes;
- identifies the serving player and active ball;
- recognizes match and rally transitions;
- produces and persists the score;
- tracks server, service order, sides, set, and match state;
- recovers from ordinary occlusion and track loss;
- corrects its own prior event when later evidence proves it wrong;
- exposes provisional/final/unsynchronized status honestly;
- completes full-match evaluation with no manual initialization or intervention.

That is the target architecture. Human-assisted runtime scoring is not an intermediate product requirement and must not shape the core system design.
