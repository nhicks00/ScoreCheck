# ScoreVision Architecture v2.0 — zero-touch autonomous scoring

**Supersedes v1.0 (2026-07-14).** Incorporates the external v2 review and the
zero-touch autonomy directive (`docs/external/`), adjudicated in
[docs/V2_ADJUDICATION.md](docs/V2_ADJUDICATION.md). Companions:
[README.md](README.md) (data reality, milestones), [FLYWHEEL.md](FLYWHEEL.md)
(training loop), [READINESS.md](READINESS.md) (Campaign 0 status).

## Product contract (non-negotiable)

ScoreVision is a **zero-touch autonomous runtime**: start the engine on a
supported stream and, with no operator action, it discovers the court,
identifies the four active athletes, assigns persistent team/slots
(A1/A2/B1/B2), selects the active ball, detects rallies and outcomes,
maintains legal score/server/order/side/set/match state, recovers from
occlusion and track loss, and corrects its own earlier conclusions when later
evidence contradicts them. There is no runtime human confirmation, review
queue, clicked athlete, manual calibration, or manual correction. Offline
human work (annotation, gold ledgers, campaign approval) is a development
process, not a runtime dependency. Diagnostic/override interfaces may observe
the system; they are never required for it to proceed.

**Engine states:** BOOTSTRAPPING · LIVE · PROVISIONAL · WAITING_FOR_EVIDENCE ·
AUTO_FINALIZED · AUTO_CORRECTED · UNSYNCHRONIZED · DEGRADED · LOST · ENDED.

**Startup modes (all autonomous):** COLD_START_PREMATCH (detect new match,
init 0-0) · RESUME_PERSISTED · REWIND_RECONSTRUCT · VISUAL_SCORE_SYNC (read a
visible score display) · UNSYNCHRONIZED_MIDMATCH (track future rallies; never
fabricate an unobserved past score). The one hard information boundary: a
mid-match start with no prior state, no rewind, and no readable score source
cannot know the absolute score — it says so honestly and keeps tracking.

## Three planes

```
SCORING CONTROL PLANE
  autonomous policy authorizer ─► append-only event store ─► deterministic
  (sole issuer of authorized        (versioned, evidence-     FIVB reducer
   domain events; models never       linked, corrections       (sole legal
   mutate score)                     are compensating events)   transition fn)

PERCEPTION / EVIDENCE PLANE
  capture health ─► autonomous court/scene lock ─► four-slot player discovery
  ─► active-ball lifecycle (top-K) ─► causal observation streams (phase, ball,
  players/server, referee, audio, score display) ─► constrained temporal
  fusion (TCN/GRU emissions + HSMM/factor graph) ─► N-BEST legal match-state
  hypotheses with likelihoods

RESEARCH / TRAINING PLANE  (see FLYWHEEL.md)
  rights-tracked corpus ─► weak labels (OCR tiers) + human gold ledgers ─►
  campaigns ─► sealed evaluator ─► ledger ─► failure mining ─► annotation queue
```

## Scoring inference (how a point actually happens)

A point is a **legal state transition inferred from a sequence of evidence**,
not one frame. The rally-winner posterior fuses, in rough order of value:

1. ball outcome evidence (landing side, trajectory termination, net);
2. last-contact / team-side evidence;
3. referee point-direction and replay gestures (FIVB defines an official
   team-to-serve signal);
4. score-display transitions when present (ScoreCheck-scored events also have
   the `score_actions` e-score feed — timing-superior but same-provenance as
   the scorebug, so it is a duplicate channel, not independent);
5. whistle/audio timing;
6. player reconfiguration into serve/receive formations;
7. **next serving team/player — a delayed checksum and service-order
   validator, NOT the sole attribution mechanism** (replays, penalties,
   service faults, corrections, terminal points, and lost intervals all
   break the naive side-out reading);
8. deterministic legal-score and side-switch constraints (7/5-point
   checksums, set targets).

The fusion layer maintains an **N-best beam of legal match-state hypotheses**;
later evidence eliminates inconsistent branches. The externally visible score
is the highest-posterior legal state, marked provisional or final. When later
evidence contradicts a finalized event, the authorizer appends a compensating
correction event (reducer gains a correction-event type — known gap) and
recomputes deterministically. Capture failure yields DEGRADED/UNSYNCHRONIZED/
LOST — never a fabricated confident score.

## Perception stack (baselines + challengers)

| Subsystem | Production baseline | Challengers | Notes |
|---|---|---|---|
| Court/scene | two-stage: learned court/net keypoint proposal + geometric fit (lines, net, posts, distortion, RANSAC), drift-monitored, camera-fingerprint auto-profiles | distortion-aware sports registration (CVPRW'26); segmentation-assisted | autonomous; no operator court selection; part of the scoring critical path |
| Active people | D-FINE-S fine-tuned on owned footage (Apache-2.0) | RT-DETRv4-S, RF-DETR-S | detect ALL people; court polygon is a prior, never a track-killer |
| Roster/slots | temporal participation model → constrained assignment to A1/A2/B1/B2 | graph/association learning | zero-touch roster; auto reacquisition; names optional |
| Tracking | ByteTrack (MIT) + team/court/service-order constraints | OC-SORT, TrackTrack, BoT-SORT±ReID | no generic ReID until it beats constraints on beach footage |
| Ball | custom causal blur-aware multi-frame heatmap model trained on OUR footage; court crops/tiles/ROIs, not blind 512×288 downsampling | WASB-style (architecture reference only — weights not rights-cleared), BlurBall-style, TrackNetV4/causal TOTNet | explicit visibility states; predicted-through-occlusion ≠ observation |
| Active-ball identity | top-K hypotheses, serve-cycle reinitialization around the server's toss | learned association; physics-constrained filtering | reject spare/adjacent/retriever balls; abstain on high entropy |
| Rally phase | causal TCN/GRU over specialist features + HSMM/factor graph with legal durations/transitions | compact video encoder trained on owned data; V-JEPA 2.1 frozen features (license diligence) | `MCG-NJU/videomae-small-finetuned-kinetics` checkpoint REMOVED (CC BY-NC); HF *code* Apache-2.0 so scratch-training the arch remains legal |
| Referee/score/audio | small owned-data classifiers (gesture, whistle, contact transient, score-display transition) | dedicated referee/score camera; Qwen3-VL offline QA | cheap evidence beats a second 4K court camera for scoring |
| Pose | RTMPose on event-window crops — analytics tier, later | RTMW, ViTPose, RTMO | not on the scoring critical path |
| VLM | frozen Qwen3-VL-2B on sealed coarse-semantic clips, offline only | SFT only if frozen shows value; no GRPO against noisy rewards | never the ball tracker, score authority, or live-path component |
| Legal state | existing FIVB reducer (event-sourced, 26 tests) + correction events | none — no ML replacement | |

## Data & evaluation (deltas from v1)

- Four label tiers: unlabeled corpus → weak (OCR tiers: clean/suspect/
  excluded — all silver-grade) → curated (model-assisted, human-corrected) →
  **gold = human-reconciled full-match event ledgers** (staged: 5-8 matches
  first, target 20-30). "Gold" never refers to OCR output.
- The zero-touch eval harness starts from RAW VIDEO: no injected court
  points, player IDs, team labels, server, phase, or score (except modes
  that explicitly permit persisted state/score feeds). Runs requiring any
  manual seed are disqualified.
- Cold-start episodes (warmup / pre-serve / mid-rally / timeout / between
  sets / arbitrary timestamp / post-interruption / ± scorebug) join the
  eval suite; metrics add court-lock time, exact-four-player accuracy,
  active-ball identity, sync success by startup mode, full-match exact-path
  rate, correction correctness, and selective risk + coverage (never bare
  accuracy).
- Splits gain a **prospective shadow** partition (captured after freeze).

## Training/MLOps stack (staged adoption)

Now: PyTorch + Lightning Fabric/custom loops (specialists), hashed configs,
Optuna for numeric HPO, git JSONL ledger + Trackio, FiftyOne/CVAT/Cleanlab,
Modal executor with human-set budget cap. Next (campaigns multiply): MLflow
tracking/registry on local SQLite. Before unattended multi-day loops:
Temporal (or DB-backed controller) as the durable campaign state machine —
the agent is a replaceable research activity inside it, never the scheduler,
evaluator, or release authority.

## Campaign order (replaces v1 waves)

0. **Readiness & observability** — rights, splits, label-noise, reducer
   replay of gold ledgers, ball-pixel/blur census, no-ML baselines
   ([READINESS.md](READINESS.md)).
1. Autonomous scene/court/calibration lock.
2. Autonomous four-player role + team discovery.
3. Autonomous server + active-ball lifecycle.
4. Causal rally phase + direct outcome evidence (rally/direct-evidence
   baseline first: how far do scorebug/referee/audio/reset signals get
   WITHOUT ball tracking?).
5. N-best legal score-state inference, autonomous finalization, corrections.
6. End-to-end zero-touch offline match replay from raw streams.
7. Live shadow with no control input.
8. Production hardening: restart recovery, persistence, rollback, failure
   injection, latency/thermal on target hardware.

Stop-and-redesign triggers (camera/optics before endless model search; no
operator requirement as a workaround — ever) are listed in the external
directive and adopted verbatim.
