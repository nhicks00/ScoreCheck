# Causal Ball Perception Baseline

**Status:** owned-code training and contract baseline; synthetic smoke-tested only

## Boundary

`vision_scoring.ball_model` maps a bounded RGB frame prefix to ball-perception
tensors. It does not import a pretrained model, load external weights, create a
rule event, authorize a command, mutate a score, or claim a point outcome. Its
outputs are untrusted observations for a later evidence pipeline.

PyTorch is in the optional `training` extra. Importing the base
`vision_scoring` package remains inert and does not require it.

```bash
uv venv /outside/the/repository/vision-scoring-ml --python 3.11
uv pip install --python /outside/the/repository/vision-scoring-ml/bin/python \
  -e './vision_scoring[training]'
```

## Architecture

Each RGB frame passes independently through a small stride-four convolutional
encoder. Group normalization is per sample, so encoding a frame cannot consume
statistics from another time step. A spatial ConvGRU then processes encoded
frames from index zero to the current index with no reverse pass, future pad, or
bidirectional attention. An unavailable frame resets recurrent state to zero;
its output remains masked, and evidence before the gap cannot leak into a valid
suffix.

The retained spatial grid feeds these per-frame heads:

- one-channel all-ball center heatmap logits at one quarter source width and
  height;
- one frame-level match-ball visibility distribution over decoded-frame
  observability states; capture-unknown is structural input truth expressed by
  the validity mask, not a learned class;
- dense role logits sampled independently at each ball peak, covering
  match, spare, adjacent-court, retriever, and warmup balls; match-ball
  probability is the corresponding softmax component; `UNKNOWN` is an explicit
  output class, while `role_mask=False` means the role was not reviewed;
- dense sub-pixel center offsets, axial blur orientation as
  `(cos(2 theta), sin(2 theta))`, and bounded blur extent in heatmap pixels;
- dense bounded x/y log variance trained with candidate-local
  heteroscedastic center negative log likelihood.

The log-variance objective supplies a mechanism for conditional sub-pixel
spatial calibration at a detected candidate. It does not yet account for a
missed peak. No calibration claim exists until rights-cleared held-out data is
evaluated.

## Supervision contract

The target record combines a dense, explicitly enumerated all-ball heatmap with
at most 16 candidate-local attribute records per frame. Independent masks gate
complete heatmap enumeration, match-ball visibility, each candidate center,
candidate role, blur orientation, and blur extent. Contract validation rejects
a candidate center unless that candidate is `VISIBLE` or
`PARTIALLY_OCCLUDED`; absent, fully occluded, out-of-frame,
indistinguishable, and capture-unknown states therefore cannot be converted
into forced coordinates. Role supervision can be withheld independently when
the role was not reviewed; a reviewed unresolved role uses the explicit
`UNKNOWN` class. Sharp candidates supervise zero blur extent without inventing
a blur orientation.

Source pixel-center coordinates map to heatmap coordinates by exactly
`(source_xy + 0.5) / 4 - 0.5`. The accepted heatmap domain is
`[-0.5, grid_dimension - 0.5)`, and the candidate anchor is exactly
`floor(heatmap_xy + 0.5)`. This preserves source border pixel centers without
clamping or a second coordinate convention.

The heatmap uses focal loss with positive Gaussian mass and background mass
normalized separately per frame rather than unweighted whole-grid BCE. Fully
enumerated zero-candidate frames remain valid hard negatives; unreviewed frames
can be omitted with `heatmap_mask=False`.

Input batch, sequence, dimensions, aggregate pixels, channel-coupled activation
budget, dtype, range, mask shape, target shape, and finite-value checks fail
closed before model or loss use. Every assembled scalar loss is checked again;
finite logits that overflow a supervised reduction raise an explicit error
instead of returning an infinite or NaN training signal.

## Causality test

The regression suite compares every output head for a short prefix against the
same prefix embedded in a longer sequence, then replaces all future pixels and
compares again. Prefix tensors must remain equal within numerical tolerance.
This verifies the live architectural invariant; future export runtimes must
repeat the same test against exported artifacts.

A separate gap test changes all pre-gap pixels and verifies every head on the
valid suffix is invariant after one capture-unknown frame resets recurrent
state.

## Synthetic scope and limitations

`vision_scoring.synthetic_ball_data` deterministically renders small Gaussian
spots and line-integrated motion streaks with visible, partially occluded, and
nonlocalizable states. Selected frames contain both a match ball and a
separately moving non-match ball, including a supervised unknown-role example;
other frames contain only the non-match ball or no localizable candidates. This
exists only to exercise masks, candidate locality, tensor plumbing,
backpropagation, and causality on CPU. It is not training data, an accuracy
benchmark, a capture proxy, or evidence of deployment readiness.

The baseline has not seen beach-volleyball footage. It has no camera geometry,
tiling merger, temporal identity tracker, checkpoint provenance, export path,
latency benchmark, probability calibration result, or rights-cleared empirical
evaluation. Those remain separate gates.
