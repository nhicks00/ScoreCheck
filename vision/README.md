# ScoreVision — functional CV scoring pipeline for beach volleyball

**Goal:** a working system that keeps live score during beach volleyball streams,
expanding later to richer stats. This package is the functional-first restart of
the vision effort, decided 2026-07-14 after a full review of the prior
`vision_scoring` work (branch `codex/vision-review-proposals`, 168 commits,
~124K lines) and a research sweep of 2024–2026 sports-CV practice.

## Why a restart

The prior effort produced a correct FIVB rules reducer and honest benchmarks,
but buried them under cryptographic governance (signed manifests, attestation
chains, sealed capabilities, "authority: false" receipts) to the point that
**no model ever saw a frame of real footage**. The salvage review (4 parallel
code reviews, per-module verdicts) concluded:

- **KEEP** `rules.py` + `domain_events.py` + `test_rules.py` — correct,
  deterministic, event-sourced FIVB beach reducer (21/15 targets, win-by-2,
  7/5 side switches, TTO at 21, service rotation), zero crypto dependencies.
  Copied into this package verbatim (imports adjusted).
- **ADAPT** ideas only: next-server reconciliation (side-out logic), policy
  threshold ladder, activity-scan recipe, candidate-decoder math, honest
  benchmark methodology.
- **DROP** the rest: ~7,000 lines of attestation plumbing per subsystem, the
  custom causal ConvGRU ball net (never trained, receptive field too small,
  native-1080p-only constraint, fails its own 5-stream capacity test), and all
  quarantine/admission ceremony.

The old branch remains untouched for reference.

## What we have (data reality, verified 2026-07-14)

| Asset | Where | Status |
|---|---|---|
| 38 owned YouTube livestream VODs, ~174 h total (33 fixed-endline candidates, ~157 h) | catalog: `vision/data/provided-youtube-livestream-sources-v1.json` (copied from old branch) | re-downloadable with yt-dlp; one already local |
| `bWK0AihsH5g` — AVP Denver 2026 Championship Sunday Court 14, 1080p30 H.264, 2h10m | `~/.codex/vision-media-quarantine/owner-youtube-denver-2026/bWK0AihsH5g/` | resident, verified |
| ScoreCheck scorebug on every produced VOD (own overlay: `apps/web/src/app/overlay/court/[courtNumber]/OverlayClient.tsx`) | top-left; teams, seeds, per-set scores, current score in gold, serve indicator (gold circle), `COURT n SET n MATCH n` / `FINAL` strip | **OCR-verified: Apple Vision reads it at 1.00 confidence** |
| `score_actions` append-only table (Supabase) | ScoreCheck DB | candidate ground-truth timelines for produced matches |
| ~447 h more on `/Volumes/Nathan Footage` (unmounted), ~245 GiB on Google Drive, local DJI drone matches (`~/Desktop/Polar plunge deb/`) | offline / local | future corpus |
| Production profiles | 2× Mevo (RTMP/H.264 1080p60), 6× AVKANS → 3 SRT/HEVC 1080p30 streams; CV must branch **before** the 720p30 program normalization | recorded fact |

## Architecture (functional-first)

```
                     OFFLINE LABEL FACTORY (now)
owned VODs ──ffmpeg 1fps──► scorebug crop ──OCR──► legal-state machine
                                                   (volleyball successor rules,
                                                    multi-frame voting)
                                                          │
                    committed score timeline + rally-end events + serve state
                                                          │
              ┌───────────────────────────────────────────┤
              ▼                                           ▼
   rally clips (overlay MASKED)                 auto-labels: rally winner,
   for model training                           set/match boundaries, server side

                     MODELS (train on the above)
1. Game-state classifier  SERVICE / PLAY / NO-PLAY   (VideoMAE-small or CNN+temporal;
   masouduut94/volleyball_analytics recipe — highest-value signal)
2. Ball heatmap tracker   WASB (MIT, pretrained VOLLEYBALL weights) fine-tuned
   on beach frames; 3-frame 512×288 MIMO; CVAT track-mode point labels
3. Later: player det/track (RF-DETR+ByteTrack), court keypoints, serve-side det

                     LIVE SCORING LOOP (target)
rally START  = SERVICE state onset (+ ball-motion onset corroboration)
rally END    = ball-track death + sustained NO-PLAY
point WINNER = side of the NEXT serve (side-out rule — no in/out call needed)
checksums    = side switches at 7/5 cumulative points; set ends 21/15 win-by-2
score state  = salvaged FIVB rules reducer (event-sourced, replayable)
human backstop = ScoreCheck scorer UI confirms low-confidence rallies
                 (EventAnchor / Balltime pattern — market leader does the same)
```

Key design choices, each validated against prior art:

1. **Score inference rides on serve detection + side-out logic, not ball
   landing.** Rally scoring means next-server side ⇔ previous rally winner.
   This converts the hardest CV problem (in/out, touches) into left/right
   classification of the next serve. Cost: one rally of latency — acceptable
   for assistive scoring with a human backstop.
2. **The scorebug is the label factory** (ASAP/cricket/SmartTennisTV
   precedent). Our own overlay ⇒ known layout ⇒ near-perfect OCR; a
   volleyball-legal successor state machine rejects illegal readings
   (SmartTennisTV gained +3..12 accuracy points this way in tennis).
   Expected yield: 150–250 rallies/match ⇒ ~15–25k labeled rallies from the
   existing catalog alone.
3. **Leakage control is non-negotiable:** training clips get the scorebug
   region black-filled; splits are by match AND venue/production template,
   never by frame. Unmasked frames are the label source only. Rally/score
   evaluation includes overlay-present/absent/masked/value-shuffled ablations.
4. **Ball model = WASB fine-tune, not a from-scratch net.** Multi-frame
   heatmap paradigm dominates published ball-tracking benchmarks; WASB ships
   MIT-licensed pretrained volleyball weights (F1 86.5–88.0 @ τ=4px on indoor
   volleyball). Transfer datapoint: tennis/badminton weights transfer poorly
   to volleyball — volleyball weights + a few-thousand beach frames of
   fine-tune are required. Avoid AGPL Ultralytics for product code.
5. **Reducer gaps to close before live use:** add a score-correction/undo
   event; add an AUTO_COMMIT policy tier above the human-review ladder (the
   old design capped at HUMAN_AUTHORIZATION_REQUIRED, making autonomous
   scoring structurally impossible).
6. **Camera geometry is procedural, not algorithmic:** mandate
   Balltime-style capture (1080p, centered endline, elevated, all four
   far-court corners visible). 33 of 38 catalog VODs already comply.

## Milestones

- **M1 (this package, now): VOD → score timeline labeler.**
  `scorevision.vod_labeler` — locate scorebug, OCR at 1 fps, legal-state
  machine, emit `timeline.jsonl` + `rallies.json` + verification report.
  Verified end-to-end on the resident bWK VOD.
- **M2: corpus + clips.** yt-dlp archival of the 33 endline VODs (PO-token
  plugin + browser cookies per 2026 YouTube SABR reality); run labeler over
  corpus; extract overlay-masked rally clips; build the train/val/test split
  by match+venue.
- **M3: game-state model.** Fine-tune SERVICE/PLAY/NO-PLAY on auto-labeled
  windows (rally boundaries from M1 give SERVICE/PLAY; dead time gives
  NO-PLAY). Evaluate rally-boundary F1 against held-out OCR timelines.
- **M4: ball tracker.** WASB volleyball weights → CVAT track-mode labels on
  ~3–5k beach frames (sampled across lighting/courts) → fine-tune (Modal
  A100, ≈$2–3/run) → ONNX/CoreML export.
- **M5: offline scoring replay.** Full loop on held-out VODs: serve
  detection → rally segmentation → side-out attribution → reducer replay;
  compare against OCR timeline (and `score_actions` where available).
  Report score-accuracy vs. coverage (abstention) curves.
- **M6: live shadow.** MediaMTX tap upstream of normalization, real-time
  inference on M4 Max (WASB-class nets are laptop-real-time), shadow score
  vs. manual scorer in ScoreCheck DB; human-confirm UI for low-confidence
  rallies.

## Layout

```
vision/
  pyproject.toml            uv project (py311; numpy; macOS: pyobjc Vision)
  src/scorevision/
    rules.py                salvaged FIVB reducer (KEEP verbatim)
    domain_events.py        salvaged event contracts (KEEP verbatim)
    ocr_apple.py            Apple Vision OCR engine (macOS)
    scorebug.py             scorebug locator + reading parser (+serve color)
    score_timeline.py       volleyball-legal successor state machine + voting
    vod_labeler.py          CLI: VOD → timeline/rallies/report
  tests/                    salvaged rules tests + new parser/timeline tests
  data/                     source catalog (copied from old branch)
```

Run the M1/M2 pipeline:

```bash
cd vision && uv sync
# 1. score labels from the scorebug (events/states/rallies/summary)
uv run scorevision-label /path/to/vod.mp4 --out out/vod1/
# 2. rally windows from the 1Hz activity signal + score commits
uv run scorevision-windows /path/to/vod.mp4 \
  --rallies out/vod1/rallies.json --out out/vod1/windows.json
# 3. overlay-masked training clips (mask rect from out/vod1/run.json)
uv run scorevision-clips /path/to/vod.mp4 \
  --windows out/vod1/windows.json --mask-rect 0,20,626,124 --out out/vod1/clips/
# corpus archival (operator-run; ~100-200 GB):
CORPUS_DIR=/path/to/corpus ./scripts/archive_corpus.sh
```

For a new overlay theme, harvest a digit-template bank once
(`scripts/harvest_digit_templates.py`) — Apple Vision cannot be trusted with
isolated scorebug digits (a lone gold '0' returns nothing); template
correlation against the known overlay font is deterministic.

Overlay themes in the corpus: **ScoreCheck** (COURT/SET/MATCH strip, gold
current cell — template-classified) and **SportCam** (Colorado Cupcakes
productions: `1st 00:00` ordinal clock, red finals, white-on-black current —
pure OCR). Streams with no overlay (e.g. AVP Next Miami) archive unlabeled;
they still serve ball-model frame sampling.

## Research references

WASB-SBDT (BMVC 2023, MIT, pretrained volleyball weights):
github.com/nttcom/WASB-SBDT · vball-net (volleyball TrackNet, MIT):
github.com/asigatchov/vball-net · game-state recipe:
github.com/masouduut94/volleyball_analytics · ASAP scorebug auto-labeling:
arXiv:2301.06866 · SmartTennisTV score automaton: arXiv:1801.01430 ·
score-overlay leakage: arXiv:2203.05711 · EventAnchor human-confirm pattern:
arXiv:2101.04954 · TrackNetV3/V4/V5, TOTNet (occlusion SOTA): arXiv:2508.09650 ·
event spotting: VNL-STES (CVPR 2025 CVSports).
