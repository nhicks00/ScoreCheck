# ScoreVision Architecture v1.0 — the full stack and the loop

**The one-sentence architecture:** small, single-purpose perception models
feed a deterministic volleyball state machine that keeps score via side-out
logic, and everything improves inside an agent-operated training flywheel
whose goal signal is our own (tiered) scorebug ground truth.

Companion docs: [README.md](README.md) (M1-M6 milestones, data reality),
[FLYWHEEL.md](FLYWHEEL.md) (loop rules, label-noise policy). This doc unifies
them into the end-state system.

---

## Layer 0 — Data substrate (BUILT, growing)

| Component | Tech | Status |
|---|---|---|
| Corpus | NAS `CV TRAINING DATA/corpus/<id>/` — VOD + audio + auto-labels | 6/33 VODs, sweep resumable |
| Auto-labels | `scorevision-label`: Apple Vision OCR + fixed-font template classifier + volleyball-legal state machine | built, verified |
| Label quality | gold/silver/excluded tiers from human-scoring noise fingerprints | built (74/13/12%) |
| Rally windows | 1 Hz activity signal ⋈ score commits | built |
| Leakage control | scorebug region black-filled in every training clip; match-level splits | built |
| Splits | train / search / selection / test, pinned by VOD, cross-venue test | built |
| Corpus hub (next) | FiftyOne (Apache-2.0, local, video-native): clip samples, embeddings, slice tags, failure mining | planned, campaign 1 |

## Layer 1 — Perception models (small, fast, one job each)

Ordered by criticality to score-keeping; each is a flywheel campaign.

1. **Game-state classifier** — SERVICE / PLAY / NO-PLAY over 16-frame
   windows. VideoMAE-small (22M) from `MCG-NJU/videomae-small-finetuned-kinetics`.
   *The rally segmenter* — rally start = SERVICE onset, rally end = sustained
   NO-PLAY. Auto-labeled from rally windows (PLAY), inter-rally gaps
   (NO-PLAY), window heads (SERVICE). Cost/run ~$2-5 on Modal L40S.
2. **Ball tracker** — WASB (1.5M params, MIT, pretrained *volleyball*
   weights), 3-frame 512×288 heatmaps + temporal smoothing. Trajectories,
   contact points, rally-end confirmation, ball speed. Needs ~3-5k CVAT
   point-labels on beach frames (track-mode interpolation, ~days of solo work
   — or bootstrap-then-correct).
3. **Player detection + tracking** — RT-DETR/RF-DETR (Apache-2.0; avoid AGPL
   Ultralytics in product code) + ByteTrack. Four players, sand dives,
   endline occlusions. Feeds serve-side attribution and all player analytics.
4. **Serve-side detector** — the score-attribution keystone: which side
   serves next ⇒ who won the previous rally (side-out rule). v1 is a
   HEURISTIC on top of 1+3 (player behind which endline at SERVICE onset),
   not a new model. Also the corpus-wide label de-noiser (scorebug vs
   side-out disagreement flags bad labels automatically).
5. **Court keypoints/homography** — 8-keypoint fit (endline-camera-tolerant,
   asigatchov-style). Pixel→meter mapping for placement maps and speeds.
   Analytics tier, not needed for scoring v1.
6. **Pose estimation** — RTMPose on player crops, only where actions need it
   (attack/block/dig/set classification via pose + ball proximity). Analytics
   tier.
7. **VLM rally adjudicator (optional, later)** — Qwen3-VL-2B (Apache-2.0),
   SFT-first on scorebug-derived QA ("which side serves next?"), GRPO only if
   SFT plateaus (NVIDIA's own autoresearch found SFT beat GRPO on a
   perception task). Used as a tie-breaker/auditor, never the primary path.

## Layer 2 — Event & state inference (deterministic code, NOT ML)

```
game-state stream ─┐
ball track ────────┼─► RALLY STATE MACHINE ─► rally events (start/end, conf.)
player tracks ─────┘          │
                              ▼
                    SIDE-OUT ATTRIBUTION (next serve side = last winner)
                              │            + side-switch checksums (7/5 pts)
                              ▼
                    FIVB RULES REDUCER (salvaged, 26 tests) = score authority
                              │
                              ▼
              confidence + abstention → HUMAN CONFIRM for low-confidence
              (ScoreCheck scorer UI, EventAnchor/Balltime pattern)
```

Rules: CV proposes, the reducer keeps score, a human backstops. No model ever
writes a score directly; every event carries confidence and evidence refs.

## Layer 3 — Products

1. **Score keeping** (the goal): offline replay → live shadow vs manual
   scorer → assistive with one-tap confirm → autonomous with correction UI.
2. **Analytics** (the expansion): touches (serve/receive/set/attack/block/dig),
   rally length distributions, serve speed, placement heat maps, player
   movement — all anchored to rally events; the same event log auto-cuts
   highlight reels (rally windows already exist).
3. **Live integration**: tap MediaMTX upstream of the 720p normalization;
   per-court worker at 1080p30/60; CoreML/ONNX exports run real-time on
   Apple Silicon (WASB-class nets are laptop-real-time per benchmarks).

## Layer 4 — The improvement loop (FLYWHEEL.md, built)

```
     ┌── CAMPAIGN: goal metric + $ cap + stop rules (Nathan approves) ──┐
     │                                                                   │
 corpus ─► dataset build ─► Modal train ($2-5) ─► LOCKED HARNESS ─► ledger
     ▲         (splits,        (config-hashed)      (gold-tier,      (git)
     │          masked)                              seq metrics)      │
     │                                                                 ▼
 failure mining ◄─ slice analysis ◄─ keep/discard vs baseline+noise floor
 (model-vs-OCR                                                         │
  disagreement,                                                        ▼
  FiftyOne similarity)                          champion promotion gates
                                                (no slice regression)
```

Operator: Claude Code running the `scorevision-campaign` skill — baseline
first, one hypothesis per git branch, append-only ledger, budgets declared
up front, human steering at campaign boundaries only. Anti-reward-hacking:
harness is stdlib-only and unwritable during campaigns, held-out labels
unreadable, disqualification language in every campaign prompt.

## The technology stack (one table)

| Concern | Choice | Why |
|---|---|---|
| Language/env | Python 3.11+, uv | already standard here |
| Training | PyTorch + HF `transformers`/`Trainer` | VideoMAE + WASB are plain supervised fine-tunes; NeMo RL/Gym rejected (generative-only, Linux-only) |
| Compute | Modal (L40S/A100, per-second) | $2-5/run, spawn/poll API for agents, human-set workspace budget = hard kill-switch; RunPod fallback for long runs |
| Curves | Trackio (free, SQLite, wandb-compatible) | agent-friendly; W&B rejected (free tier non-commercial) |
| Registry | git: `experiments/ledger.jsonl` + config/data hashes | NVIDIA autoresearch's own pattern; auditable |
| Corpus ops | FiftyOne + Cleanlab | failure mining, label hygiene; both Apache-2.0, local |
| Ball labels | CVAT track mode | keyframe interpolation, fastest solo labeling |
| OCR/labels | Apple Vision + template bank (built) | deterministic on own overlay fonts |
| Eval | locked stdlib harness (built) | agent can run, never edit |
| Detection models | RT-DETR/RF-DETR, WASB, VideoMAE-small, RTMPose | strongest open weights, commercial-safe licenses |
| Live inference | CoreML/ONNX export on Apple Silicon | M4-class hardware is sufficient for 1-2 streams |
| Rules/score | salvaged FIVB reducer + side-out logic | deterministic, 26 behavioral tests |
| Loop operator | Claude Code + `scorevision-campaign` skill | goal/budget prompts, ledger, stop rules |

## Sequencing — critical path to "keeps score"

| Wave | Deliverable | Gate metric (locked harness) |
|---|---|---|
| 1 (now) | corpus complete + game-state model | rally-boundary F1 on selection split |
| 2 | ball tracker fine-tune | ball F1@4px + rally-end delta reduction |
| 3 | players + serve-side heuristic → **end-to-end offline score replay** | winner accuracy (gold), sequence similarity, set-score exact match |
| 4 | live shadow on MediaMTX + confirm UI | shadow-vs-manual agreement over full events |
| 5 | poses, court homography, analytics products | per-product metrics |

Waves 3's metric is the product goal — from there, every campaign moves the
number Nathan actually cares about: *does the system keep the right score?*
