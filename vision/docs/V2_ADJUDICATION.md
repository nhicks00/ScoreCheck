# Adjudication of the v2 review + zero-touch directive (2026-07-14)

Source docs (preserved in `vision/docs/external/`): GPT Pro's
`SCOREVISION_V2_ARCHITECTURE_AND_AGENT_LOOP.md`, `FABLE5_SCOREVISION_EXECUTION_BRIEF.md`,
and `FABLE5_ZERO_TOUCH_AUTONOMY_CORRECTION.md`. The zero-touch correction
supersedes the human-authorized-v0 requirements in the other two (they
conflict; the correction explicitly wins, and the owner forwarded it as the
product decision).

## Adopted (correct, now canonical)

1. **Zero-touch autonomous runtime is the product contract.** No runtime
   operator initialization, athlete clicking, point confirmation, review
   queue, or manual correction. Human work is offline (labels, gold ledgers,
   campaign approval) only. The former human-confirm path becomes a
   *diagnostic/override surface*, never a required stage. This raises the
   bar: the autonomous policy authorizer becomes safety-critical, which is
   exactly why shadow-mode campaigns (no control input) precede production.
2. **Next-server inference demoted from keystone to delayed checksum.**
   Correct: replays, penalties, service-order faults, corrections, terminal
   points, and multi-transition gaps all break the naive side-out reading.
   The rally-winner posterior fuses ball outcome, last contact, referee
   signals, audio, score-display changes, player reconfiguration, next
   server, and legal constraints. Next-server keeps three jobs: delayed
   verification, service-order validation, corpus label de-noising.
3. **N-best legal state beam + PROVISIONAL/AUTO_FINALIZED/AUTO_CORRECTED/**
   **UNSYNCHRONIZED/DEGRADED/LOST states.** Adopted wholesale — an early
   mistake must not corrupt the match; compensating correction events are
   append-only. Concrete code consequence: the FIVB reducer needs a
   correction-event type (already a known gap from the v1 salvage review).
4. **Autonomous startup modes** (COLD_START_PREMATCH / RESUME_PERSISTED /
   REWIND_RECONSTRUCT / VISUAL_SCORE_SYNC / UNSYNCHRONIZED_MIDMATCH) and the
   honest information boundary: an unseen past score cannot be fabricated.
5. **Court polygon is a coordinate system + prior, not a player filter;
   four persistent logical slots (A1/A2/B1/B2)** inferred autonomously from
   temporal participation (zero-touch version of the roster). Names never
   block scoring.
6. **Active-ball as latent top-K hypothesis, serve-cycle reinitialized**,
   with explicit visibility states; predicted-through-occlusion ≠ observed.
7. **License corrections — both real catches:**
   - `MCG-NJU/videomae-small-finetuned-kinetics` is OUT of the commercial
     baseline (VideoMAE repo is predominantly CC BY-NC 4.0). The HF
     *implementation code* is Apache-2.0, so training that architecture
     from scratch on owned data remains an option; the pretrained
     checkpoint does not.
   - WASB's MIT repo license does not clear its *weights/training data*
     for commercial use. WASB becomes an architecture reference; the
     production ball checkpoint is trained on our cleared footage.
8. **Ball input resolution:** do not blindly downsample 1080p to 512×288 —
   court crops / tiles / trajectory-guided ROIs, decided after the
   observability census measures actual ball pixel sizes.
9. **"Gold" is reserved for human-reconciled event ledgers.** Our OCR tiers
   (code keys `gold/silver/excluded`) are relabeled in documentation as
   OCR-clean / OCR-suspect / OCR-excluded — all *silver-grade weak
   supervision*. Code keys stay (churn without benefit); docs and metrics
   language change.
10. **Campaign 0 (readiness/observability) before any training** — most of
    it is already measured; the ball-pixel census is the big unknown. The
    "if the camera didn't capture it, redesign the camera" stop-condition
    is adopted verbatim.
11. **Optuna for numeric HPO, Hydra-style hashed configs, Lightning
    Fabric/custom loops for the specialist CV models** (HF Trainer only for
    any future VLM work). Multi-fidelity stage budgets (preflight → smoke →
    screen → full → promotion) instead of a fixed wall-clock per run.
12. **Selective-risk + coverage reporting, match-level cluster bootstrap,
    calibration on a dedicated set** — adopted into the eval contract.

## Adopted with staging (right destination, wrong day-one weight)

13. **MLflow + DVC + Temporal.** Correct end-state for a multi-day,
    multi-machine unattended loop. But standing up Postgres-backed MLflow,
    DVC remotes, and a Temporal cluster before a single model exists is
    infrastructure-first sequencing for a solo operator. Staging:
    - now: git JSONL ledger (append-only) + Trackio curves + content-hashed
      config/data manifests (already required by the flywheel);
    - when campaigns multiply: MLflow with local SQLite backend (hours of
      work, no server);
    - before unattended multi-day campaigns: Temporal (or a DB-backed
      controller) exactly as specified.
14. **20–30 human-reconciled gold match ledgers.** Right target, staged:
    5–8 matches covering test+selection splits first (plus the ~300-rally
    kernel), growing toward 20–30. A full-match reconciliation costs a
    human 1.5–3 h; the owner is one person.

## Rebutted / corrected

15. **"Scorebug not independent truth if generated by the same scorer" —
    understated in our case, but the same fact cuts the other way:** the
    owner *owns ScoreCheck*, so for ScoreCheck-scored matches there is a
    machine-readable e-score feed already in production (`score_actions`,
    timestamped, append-only). GPT's "simplest scoring sensor" (direct
    e-score feed) **already exists** for those events — no new hardware.
    It shares provenance with the scorebug (same human), so it is a
    *timing-superior duplicate*, not an independent channel; independence
    still comes from ball/referee/audio/next-server evidence.
16. **VLM caution is right but slightly over-rotated:** frozen Qwen3-VL-2B
    benchmarking on sealed coarse-semantic clips (their Q1) is cheap and
    already in our plan; agreed it never touches the live path. No change,
    just noting v1 already had it offline-only.
17. **The execution brief's "human authorization is mandatory for v0"
    (non-negotiable #3) is void** — superseded by the zero-touch directive.
    We keep its campaign discipline, permissions/prohibitions, retry rules,
    and gates, which are excellent and consistent with our flywheel.

## Repo patch sequence (this commit)

1. `ARCHITECTURE.md` rewritten to v2.0: zero-touch contract, three planes,
   evidence-fusion scoring, N-best beam, startup modes, license fixes,
   staged MLOps, campaign order 0–8.
2. `README.md`/`FLYWHEEL.md`: runtime human-confirm language removed or
   re-scoped to offline/diagnostic; "gold" terminology clarified.
3. `scorevision-campaign` skill: zero-touch eval rule added (no injected
   court/players/score; disqualify runs requiring manual seeds).
4. `READINESS.md`: Campaign 0 report with current PASS/FAIL/NOT-MEASURED.
