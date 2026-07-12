# Causal ball target materialization V1

`vision_scoring.ball_target_materialization` is the pure boundary between a
complete causal-ball label statement and the `CausalBallTargets` tensors used
by the owned ball-perception baseline. It does not verify signatures, accept a
verification receipt, read media, decide dataset admission, or mutate score.

The only public operation is:

```python
materialize_causal_ball_targets_v1(
    statement,
    annotations,
    model_config=config,
)
```

The caller supplies one exact `CausalBallLabelBundleV1` and exactly the
`BallFrameAnnotationV2` preimages named by it. Annotation tuple order is
irrelevant. Output order comes exclusively from the statement's canonical
frame/reference order.

## Exact rebinding and bounded preflight

Before allocating a tensor, the materializer fails closed unless:

- the statement, annotation tuple, every annotation, and model configuration
  have their exact expected types;
- concrete annotation IDs are unique and equal the complete reference set—no
  missing or additional annotations;
- every annotation fingerprint, reference field, frame identity, source,
  stream, decode contract, timestamp domain, pixel coordinate space, decoded
  hash basis, ontology, and match-ball subject rebinds exactly;
- all frames have one fixed source size, dimensions are divisible by four, and
  frame, dimension, aggregate-pixel, and blur-output bounds fit the model;
- no annotation carries `CAPTURE_UNKNOWN`, an unavailable frame, a capture
  gap, a non-`NONE` duplicate classification, or `uncertainty_radius_px`;
- each frame has at most 16 localizable balls and no two localizable balls map
  to the same stride-four anchor.

Collision errors identify both bounded annotation IDs. Candidate overflow is
rejected; candidates are never truncated. Uncertainty is rejected because V1
has no honest target mapping for it.

These checks establish internal consistency only. They do not establish
signature validity, rights, currentness, split isolation, media residency, or
training authorization. Those are responsibilities of a later trusted
coordinator.

## Fixed tensor encoding

V1 always emits a batch of one on CPU. Floating targets use `torch.float32`,
indices use `torch.long`, masks use `torch.bool`, the heatmap stride is four,
and the candidate axis is exactly 16 slots.

The encoding descriptor is version `1.0` with SHA-256:

`dedbe55929e8a1863acaacb4e86e970d773a05baf53c96fa5654419bda32eec4`

The descriptor binds the ordered visibility and role index tables, tensor
layouts and dtypes, localizability, masks, placeholders, split non-semantics,
and all geometry rules below. Changing any encoded meaning requires a new
version and digest.

`vision_scoring.training_target_encoding` provides the separate, still
non-authorizing content-binding step. It accepts only exact, contiguous,
non-gradient CPU tensors with readable allocated storage that covers the full
logical byte window and has no lazy conjugate or negative view bits. In
canonical field order it hashes the raw row-major little-endian storage bytes:
IEEE-754 binary32, signed int64, or canonical `0`/`1` bool bytes. Shapes,
dtypes, the V1 geometry envelope, the aggregate byte bound, and all five false
authority properties are revalidated before hashing. NaN payload bits are
content-significant. The raw storage read requires exclusive ownership: no
other thread or process may mutate, resize, or truncate the storage during a
hash operation. The planned coordinator satisfies this by hashing fresh,
private materializer output on one thread. A trusted consumer must call
`validate_causal_ball_target_tensor_rows_v1` immediately before consuming the
same mutable tensors; these hashes do not serialize tensors or grant training
authority.

For a source pixel-center coordinate `p`, the heatmap coordinate is:

```text
(p + 0.5) / 4 - 0.5
```

The discrete candidate anchor is
`floor(binary32(heatmap_coordinate + binary32(0.5)))`. This preserves
source-border centers: zero maps to `-0.375` and the last center of a 48-pixel
axis maps to `11.375`, with valid anchors 0 and 11.

Every emitted floating scalar is first rounded to IEEE-754 binary32 (round to
nearest, ties to even). The `+ 0.5` anchor intermediate is independently
rounded to binary32 before `floor`, exactly matching the model/loss helper.
Anchor/collision checks, Gaussian generation, blur targets, and model-bound
decisions use those same normalized scalars. This prevents a float64 preflight
from accepting two centers that collapse onto one anchor in `torch.float32`.

Every localizable annotation (`VISIBLE` or `PARTIALLY_OCCLUDED`) becomes one
candidate in canonical bundle order. Role supervision is enabled for every
candidate, including `UNKNOWN`, `RETRIEVER_BALL`, and `WARMUP_BALL`. The
match-visibility head is supervised on every decoded frame, including absent,
fully occluded, out-of-frame, and indistinguishable match-ball states. No
coordinates are invented for those nonlocalizable states.

Every frame also has complete heatmap supervision. Each localizable ball
contributes a full-grid isotropic Gaussian:

```text
sigma = max(0.7, apparent_minor_axis_diameter_px / (6 * 4))
```

Simultaneous-ball Gaussians are composed with pointwise maximum. A frame with
no localizable ball has an exactly zero heatmap. This dense negative is valid
only because the input statement carries the curator's complete full-decoded-
frame enumeration claim; it is not an objective proof that the source was
completely labeled.

Blur targets preserve the observed geometry:

- `SHARP`: extent `0`, extent mask `true`, axis mask `false`;
- endpoint blur: extent `hypot(end - start) / 4`;
- ellipse blur: extent `2 * major_radius_px / 4`;
- motion-blur axial direction: `(cos(2θ), sin(2θ))`.

The doubled angle makes the target axial: reversing endpoint direction does
not change the represented blur axis. Exact extents above the configured model
output bound are rejected, never clipped.

Unused candidate slots contain `NaN` float placeholders, `-1` index
placeholders, and false masks. They cannot supervise loss.

## Result semantics and deliberate exclusions

`MaterializedCausalBallTargetsV1` binds the statement digest, encoding digest,
bundle/source IDs, split metadata, ordered frame hashes, and targets. Its
dataclass envelope is frozen, but PyTorch tensors remain mutable objects. The
envelope is therefore not a persistence or integrity boundary. A trusted
coordinator must independently bind any serialized tensor artifact before use.

All admission properties are permanently false. `TRAIN`, `DEV`, and `TEST`
produce the same target encoding; split is retained only as metadata. In
particular, this module provides none of the following:

- curator or Annotation Truth signature verification;
- a receipt/protocol interface or conversion of evidence into authority;
- a frame input tensor or `valid_frame_mask`;
- gap interpolation, frame dropping, resizing, cropping, tiling, or
  augmentation;
- dataset generation leasing, TEST isolation, training launch, evaluation,
  calibration, deployment, or live-scoring admission;
- media reads, score state, rule events, or ScoreCheck mutation.

The next trusted-training layer must reverify/reacquire the exact immutable
generation, keep TEST inaccessible to the training worker, bind source RGB
bytes separately, and revalidate the exact in-memory target-content rows at
the consumption boundary. This materializer and target encoder remain pure
computations inside that larger protocol.
