# ScoreVision Flywheel — goal-oriented, agent-managed training

**Decision date:** 2026-07-14 · **Trigger:** NVIDIA's autoresearch demo
([blog](https://developer.nvidia.com/blog/how-to-run-an-autoresearch-workflow-with-rl-agent-skills-and-nvidia-nemo/),
[skills repo](https://github.com/NVIDIA/skills)) — a coding agent given a goal
+ time budget stood up the environment, trained Qwen3-VL-2B from 25% → 96.9%
on one L40S in under an hour, logged every experiment, and proposed the next.

## Does the NVIDIA post help us?

**Yes — the pattern; no — the stack (for now).**

Adopt from the demo:
1. **The loop shape** (their `nemo-rl-auto-research` skill is public, plain
   markdown): goal + explicit stop rules → baseline first → one branch +
   minimal diff per hypothesis → append-only experiment ledger → keep/discard
   → campaign summary + proposed next step.
2. **The empirical lesson:** for a perception task, the agent found **SFT on
   environment-generated data beat GRPO (RL)**. Our perception models are
   supervised; try supervised routes before any RL.
3. **Goal + budget prompting** with a human as "strategic validator": steer at
   campaign boundaries, never mid-run (NVIDIA documents steering-drift as a
   failure mode).

Do **not** adopt NeMo RL / NeMo Gym as dependencies today: both are built
exclusively around HuggingFace *generative* transformers with vLLM rollouts
(Linux + CUDA only). Our first models — a ~22M-param VideoMAE-small classifier
and a 1.5M-param WASB heatmap CNN — are plain PyTorch fine-tunes; NeMo adds
only incompatible machinery. NeMo RL becomes relevant exactly when (if) we
train the **Qwen3-VL-2B rally adjudicator** (Apache-2.0, native video) — that
task is squarely in its envelope, and also in TRL GRPO / EasyR1 / SkyRL's.

## Our unfair advantage

NVIDIA had to build a synthetic environment to get a verifiable reward. We
get one for free: **held-out matches' scorebug timelines are exact ground
truth** for the end goal (rally winners + timestamps + score sequences),
produced by an independent signal (overlay OCR), not by the model — so
training on them is weak supervision, not self-training, and evaluation
against them is a true external check at match scale (~10-15k rallies).

## The loop

```
        ┌────────────────────────────────────────────────────────────┐
        │ CAMPAIGN (goal + budget + stop rules, human-approved)      │
        └────────────────────────────────────────────────────────────┘
 corpus (NAS) ──► DATASET build (masked clips, match-level splits)
                      │
                      ▼
              TRAIN challenger on Modal (config-hashed, $2-5/run)
                      │
                      ▼
              LOCKED EVAL HARNESS (vision/harness/ — agent may run,
              never edit; splits it never reads; METRIC lines out)
                      │
                      ▼
              LEDGER append (vision/experiments/ledger.jsonl, git)
                      │
              ┌───────┴────────┐
              ▼                ▼
        ANALYZE slices    keep / discard vs baseline + noise floor
        (venue, light,          │
         court, theme)          ▼
              │           PROMOTE champion only if: primary metric ↑
              ▼           AND no slice regresses (gates logged)
        MINE failures ──► targeted windows from the 157h corpus
        (model-vs-OCR          │
         disagreement)         ▼
              └──────► PROPOSE next experiment (agent) → human reviews
                        at campaign boundary
```

## Non-negotiable design rules (distilled from the 2025-26 literature)

1. **Locked harness.** Eval code + held-out labels live outside the agent's
   writable surface during campaigns (`vision/harness/` + read-only label
   mounts). The worker never grades itself; scores come from the harness or a
   separate judge. (AIRA measured a 9-13% val→test gap from self-graded
   search; AIRA2's hidden fixed splits eliminated it.)
2. **Match-level splits, four ways.** train / search (agent iterates) /
   selection (harness picks checkpoints) / test (untouched until campaign
   end). Never split by clip or frame; never let the agent read selection or
   test labels.
3. **Noise floor first.** Run the baseline eval 3-5×; accept a change only if
   it beats baseline + noise. Most "gains" and "overfitting" are noise
   exploitation.
4. **Append-only ledger in git.** Every run: id, hypothesis, config hash,
   data-manifest hash, metrics, GPU-seconds, cost, verdict. NVIDIA's own
   registry-for-agents is exactly this. Trackio (free, SQLite, wandb-API
   compatible) for training curves; **no W&B** (free tier is non-commercial).
5. **Budgets + stop rules declared before launch.** Per-run wall-clock cap,
   max experiments, campaign $ cap; Modal workspace budget is the human-set
   hard kill-switch (UI-only by design); the agent self-accounts GPU-seconds
   in the ledger. Stop when target met or budget exhausted — then summarize
   and propose, don't keep spinning.
6. **Anti-reward-hacking posture.** Containerized training, no internet in
   jobs, ground truth mounted read-only, and explicit disqualification
   language in the campaign prompt (measured to cut frontier-model hacking
   from 10/10 to 3/10 runs — METR/BlueDot). When an exploit is found: patch
   the harness, don't scold the model.
7. **Known-good recipes + greedy component iteration.** Start from pretrained
   weights (MCG-NJU/videomae-small-finetuned-kinetics; WASB volleyball
   weights, MIT) and iterate one component at a time. Operators and eval
   fidelity beat clever search (MLE-STAR, AIRA: MCTS gained nothing over
   greedy with good operators).
8. **Human at campaign boundaries only.** Nathan approves goal + budget, reads
   the morning summary, picks the next campaign. No mid-run steering.

## Data flywheel specifics

- **Corpus hub:** FiftyOne (Apache-2.0, local, video-native) — one sample per
  rally clip; fields: OCR label + parse confidence, venue/court/lighting/
  overlay-theme tags, model predictions, embeddings. Brain
  uniqueness/representativeness picks the initial diverse train set;
  similarity search mines failure lookalikes.
- **Trigger = disagreement.** Tesla's "disengagement" analog here is
  model-vs-OCR disagreement on rally winner/boundaries, plus low-confidence
  segments (uncertainty sampling reached full performance with 1/3 the labels
  in SoccerNet action spotting). Sample one clip per uncertain segment —
  adjacent frames are near-duplicate label waste.
- **Label hygiene:** Cleanlab confident-learning pass each cycle over
  classifier probs vs OCR labels to catch scorebug-parse errors; hand-verify
  the flagged ~1-5% + a small random audit (SoccerNet did exactly this over
  OCR-anchored annotations).
- **Self-training guard:** never recycle model pseudo-labels (esp. ball
  tracks) into training without the OCR anchor or confidence threshold +
  audit — confirmation-bias feedback loops are the documented failure mode.

## Model roadmap under the flywheel

| Model | Route | Cost/run | Goal metric (harness) |
|---|---|---|---|
| Game-state (SERVICE/PLAY/NO-PLAY), VideoMAE-small | plain PyTorch/HF on Modal L40S | $2-5 | rally-boundary F1 vs held-out timelines |
| Ball tracker, WASB fine-tune | plain PyTorch on Modal | $2-5 | ball F1@τpx on labeled frames + downstream rally-end deltas |
| Rally adjudicator, Qwen3-VL-2B (later) | SFT first ($5-20), then TRL GRPO/EasyR1 with exact-match rewards ($25-80/run) | ~$300-500 first campaign | rally-winner / serve-side exact match vs scorebug truth |

## What exists already vs. what this adds

Already built: corpus + auto-labels (M1/M2), leakage-masked clips, split
manifest, overlay-ablation discipline. This doc adds: the four-way split, the
locked harness + ledger + campaign skill, promotion gates, and the
failure-mining loop. First campaign target: **M3 game-state model**, the
moment enough corpus VODs are labeled.
