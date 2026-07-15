# Campaign 0 — Readiness & Observability Report

**Date:** 2026-07-14 · **Contract:** zero-touch autonomous runtime
(ARCHITECTURE.md v2). Statuses: PASS / FAIL / BLOCKED / NOT MEASURED.

| # | Check | Status | Evidence / smallest next action | Owner |
|---|---|---|---|---|
| A1 | Reducer test suite passes | **PASS** | 26 behavioral tests green (`vision/tests/test_rules.py`) | — |
| A2 | Reducer replays human gold ledgers exactly | **NOT MEASURED** | no gold ledgers exist yet → build 5-8 human-reconciled matches (staged toward 20-30) | Nathan + agent tooling |
| A3 | Correction/compensating-event semantics | **FAIL (known gap)** | reducer has no correction event type; required for AUTO_CORRECTED. Patch queued for the reducer campaign | agent |
| A4 | Perception cannot append authorized events | **PASS (by construction)** | no perception→score write path exists in `scorevision` | — |
| B1 | VOD rights registry | **PARTIAL** | all 38 catalog VODs are owner-provided/owned (catalog `source_scope_declaration`); no formal per-asset registry file yet → generate `RIGHTS_REGISTRY` from catalog + owner attestation | Nathan (attest) |
| B2 | Checkpoint rights review | **PASS (with corrections)** | VideoMAE kinetics checkpoint REMOVED (CC BY-NC); WASB weights demoted to architecture reference; D-FINE/RT-DETR/ByteTrack/RTMPose code Apache/MIT — per-checkpoint provenance review required before any pretrained init | agent per campaign |
| C1 | Splits grouped by full match | **PASS** | `split-manifest.json`, pinned VOD-level 4-way split + cross-venue test | — |
| C2 | Leakage channels (overlay) masked | **PASS (mechanism)** | scorebug black-fill in clip extraction; ablation suite still to run at first training | agent |
| C3 | Prospective shadow partition | **NOT MEASURED** | defined in v2; populate from post-freeze captures | agent |
| D1 | Scorebug label noise measured | **PASS** | 941 rallies: 3.2 corrections/100 pts, 6.7% batch-entry commits, ~6% jump-absorbed points; tiers: 74% OCR-clean / 13% suspect / 12% excluded | — |
| D2 | OCR labels called weak/silver (not gold) | **PASS** | FLYWHEEL.md tier policy v2 | — |
| D3 | OCR lag distribution vs true rally end | **NOT MEASURED** | needs gold ledgers or ball/audio evidence for true end times | after A2 |
| E1 | Ball observability census (≥1,000 decisive windows: pixel size, blur, visibility, occlusion, multi-ball) | **NOT MEASURED** | **the highest-value unknown** — blocks ball-model investment; buildable now from corpus rally windows | agent (next) |
| E2 | Capture integrity (drops/freezes/duplicates) | **PARTIAL** | bWK preflight clean (234,822 packets, no DTS anomalies); repeat per-VOD in census | agent |
| E3 | Court-lock feasibility on owned views | **NOT MEASURED** | Campaign 1 baseline; endline views are catalog-verified fixed for 33 VODs | agent |
| F1 | No-ML / direct-evidence scoring baseline | **PARTIAL** | scorebug-replay ceiling measured (the labeler IS that baseline: ~94% of points recovered cleanly on labeled VODs); `score_actions` e-score feed exists for ScoreCheck-scored events (513 rows currently); referee/audio channels unmeasured | agent |
| G1 | Corpus completeness | **IN PROGRESS** | 6/33 VODs archived (sweep paused post-incident, resumable; leak fixed + memory guard) | Nathan (resume OK) |
| G2 | Zero-touch violations in current docs/code | **PASS (this commit)** | runtime human-confirm language removed from ARCHITECTURE/README/FLYWHEEL/skill; no runtime code had human gates (nothing beyond docs existed yet) | — |
| H1 | Compute budget + kill-switch | **BLOCKED (owner)** | Modal account + workspace budget cap not yet set | Nathan |
| H2 | Annotation capacity declared | **BLOCKED (owner)** | hours/week for gold ledgers + kernel review unknown | Nathan |

## Cold-start information contract (current)

Allowed runtime inputs: the stream itself; persisted engine state for that
stream (RESUME_PERSISTED); rewind buffer where available; visible score
displays (VISUAL_SCORE_SYNC). Not allowed: operator court points, clicked
athletes, team/server labels, manual score. Mid-match start without any sync
source ⇒ UNSYNCHRONIZED (differential tracking only) — by information theory,
not by policy.

## Missing labels for zero-touch subsystems (annotation queue seeds)

Scene/court: corners/lines/net/posts per camera setup (25-50 frames each);
warmup/inactive/replay states. People/roles: all-person tracks with
active-vs-official/spectator labels; team + slot; serving player; side-switch
continuity. Ball: candidate-level identity (active/spare/adjacent/retriever),
blur geometry, visibility states on ~300-600 selected 1-3 s windows. Events:
serve lifecycle, rally boundaries, exceptions (every real instance found).
Cold-start episodes across all startup conditions.

## Highest-information first experiment

**The ball observability census (E1).** It decides between: proceed with
single-view ball modeling; change ball input geometry (crops/tiles/ROI); or
trigger the camera/optics redesign condition. Everything downstream of
Campaign 3 depends on its answer, and it costs ~zero GPU dollars.

## Structural blockers requiring owner action

1. Resume corpus sweep (G1) — one word of approval.
2. Modal account + hard budget cap (H1).
3. Rights attestation memo covering the 38 catalog VODs (B1).
4. Gold-ledger staffing decision (A2/H2): who reconciles the first 5-8
   matches, or whether agent-prepared reconciliation queues + owner review
   is the model.
