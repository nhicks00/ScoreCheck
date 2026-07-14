---
name: scorevision-campaign
description: Run a goal-oriented autonomous training campaign for a ScoreVision model (game-state, ball tracker, or VLM adjudicator) under explicit budgets and stop rules, with the locked eval harness and append-only ledger. Use when Nathan asks to train/improve a vision model toward a metric target.
---

# ScoreVision training campaign

You are running an autonomous training campaign. The pattern follows
NVIDIA's autoresearch skill and the rules in `vision/FLYWHEEL.md`. Nathan
steers at campaign boundaries only.

## Campaign contract (fill in before any run)

- **Goal metric + target**: e.g. `winner_accuracy >= 0.92` on the
  `selection` split from `vision/harness/eval_rally_attribution.py`.
- **Budgets**: max experiments N, wall-clock cap per run, campaign USD cap.
  Modal workspace budget (human-set) is the hard kill-switch; self-account
  GPU-seconds and cost in the ledger for every run.
- **Stop rules**: stop when the target is met, the budget is exhausted, or
  two consecutive hypotheses fail to beat baseline + noise floor. Then write
  the campaign summary and propose (do not start) the next campaign.

## Hard rules — violations disqualify the campaign

1. NEVER edit anything under `vision/harness/` and never read ground-truth
   labels for the `selection` or `test` splits. Any attempt to modify the
   evaluator, read held-out labels, or shortcut training (copying reference
   weights, stubbing metrics, patching timers) is disqualification.
2. Splits are by MATCH/VOD per `corpus/split-manifest.json`: train on
   `train`, iterate on `search`, let the harness score `selection`; `test`
   is untouched until Nathan reviews the campaign summary.
3. Baseline first: reproduce the champion (or trivial baseline) and run the
   harness 3-5x to measure the noise floor. A win = beats baseline + noise.
4. One hypothesis per experiment, minimal diff, own git branch
   (`campaign/<date>-<slug>/<n>-<hypothesis>`), committed before launch.
5. Append every run to `vision/experiments/ledger.jsonl` via
   `scorevision.ledger` (config hash, data manifest hash, metrics from
   harness METRIC lines, GPU-seconds, cost, verdict keep/discard/crashed).
6. Training jobs run on Modal (containerized, no internet, ground truth
   mounted read-only). At most ONE heavy local process at a time on this
   Mac; obey `SCOREVISION_RSS_LIMIT_MB` (see the 2026-07-14 memory incident).
7. Start from known-good recipes (VideoMAE-small kinetics checkpoint; WASB
   volleyball weights) and iterate one component at a time — data mix,
   augmentation, schedule — greedy, no meta-search.
8. Keep a durable session diary at `vision/experiments/<campaign>/DIARY.md`
   (goal, decisions, surprises, handoff notes) so the campaign survives
   context compaction; update it after every experiment.

## Loop

baseline → hypothesis → branch + minimal diff → launch Modal run → harness
on `selection` → ledger + diary → keep/discard → (failure mining: pull
model-vs-OCR disagreement windows from the corpus into the train set) →
next hypothesis → … → stop rule fires → summary + proposal for Nathan.
