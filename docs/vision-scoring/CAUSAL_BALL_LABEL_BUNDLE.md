# Causal Ball Label Bundle V1

`CausalBallLabelBundleV1` is a curator-signed completeness claim for causal
ball-detector supervision. It closes a gap that a loose `labels_sha256` cannot:
the signed statement identifies every decoded frame in one bounded source asset
and the exact Annotation Truth V2 preimages and attestations assigned to it.

This is an evidence contract, not a training-admission contract.

## Scope and composition

One bundle covers one bounded, derived source asset, normally a short clip whose
rights and derivation have been authenticated elsewhere. A bundle is capped at
10,000 decoded frames and 1,900,000 canonical JSON bytes. It is not the format
for an arbitrarily long full match. A later dataset manifest may compose many
independently current bundles.

The bundle binds these external commitments without proving them:

- source-asset SHA-256;
- finalized-trace SHA-256;
- capture-policy SHA-256 and generation;
- ontology SHA-256 and version;
- `TRAIN`, `DEV`, or `TEST` split;
- selected stream, decode-contract fingerprint, timestamp basis, pixel space,
  decoded-frame hash basis, frame count, and exact per-frame timestamps; and
- exact Annotation Truth V2 trust-store, verification-policy, annotation,
  preimage, and detached-attestation fingerprints.

The contract does not authenticate clip derivation, capture residency, source
bytes, decoded pixels, rights, physical-camera identity, clocks, or the truth of
the bound trace and policy. Those are separate gates.

## Complete frame enumeration

`completeness_scope` is fixed to `COMPLETE_FULL_DECODED_FRAME`. Frames must be
contiguous and ordered from decoded frame zero. Each frame binds one exact frame
identity and contains:

- exactly one declared match-ball target;
- zero or more localizable non-match-ball observations; and
- canonical, unique annotation and ball-instance ordering.

The curator claims that the non-match list includes every localizable ball in
the full decoded frame. This supports an all-ball heatmap rather than silently
treating unenumerated spare or adjacent-court balls as negatives.

The target state is explicit:

- `PRESENT`: `VISIBLE` or `PARTIALLY_OCCLUDED` and localizable;
- `ABSENT`: reviewed/adjudicated `NOT_PRESENT`, which Annotation Truth V2
  separately requires to carry a full-frame observability attestation; or
- `UNSEEN_UNKNOWN`: `FULLY_OCCLUDED`, `OUT_OF_FRAME`, or
  `INDISTINGUISHABLE`.

Annotation Truth V2 requires `INDISTINGUISHABLE` to retain `role=UNKNOWN`.
Accordingly, the bundle names that exact annotation as the declared match-ball
target by annotation ID and ball-instance ID; it does not rewrite the
annotation's role. Every other entry must be a localizable decoded-frame
observation. `CAPTURE_UNKNOWN` and unavailable-frame references are rejected:
they cannot become heatmap-complete negative supervision.

## Two independent authorities

The curator Ed25519 signature uses the V1 domain
`multicourt-vision-scoring:causal-ball-label-bundle:v1`. It authenticates the
enumeration and completeness claim only.

It does not replace annotation reviewers or adjudicators. Verification rebuilds
the signed statement from the exact concrete `BallFrameAnnotationV2` and
`AnnotationAttestation` objects, then invokes `AnnotationTrustStore` against its
protected current configuration and immutable evidence generation. Missing,
extra, stale, revoked, incorrectly signed, or policy-ineligible annotations fail
closed.

Authority separation is cryptographic as well as semantic. Verification rejects
any raw Ed25519 public-key overlap between every key in the pinned curator
snapshot and every key in the protected Annotation Truth trust store. Different
IDs, roles, or signing domains do not make a reused key independent.

The curator trust snapshot is independently pinned by fingerprint and
generation. It binds one current bundle and one current curator key. A
time-valid historical key is still rejected when it is not the snapshot's
current key. Statement revocations and exact current attestation fingerprints
are enforced.

`protected_verified_at_ns` is a deployment input, not manifest data. It must
come from a protected, rollback-resistant coordinator clock. It is used to
reject future signatures and expired or revoked curator keys. A source asset,
curator, dataset file, or caller-controlled wall clock is not an acceptable time
authority.

## Strict wire format

Bundle, curator attestation, and trust snapshot use canonical ASCII JSON with
exact fields. Parsing rejects duplicate keys, floats and non-finite numbers,
signed-64 overflow, noncanonical bytes, excessive depth, excessive node counts,
unknown enums, reordered frames or annotations, omissions, duplicates, and
mismatched redundant counts or timestamps. Annotation preimages are referenced
by the exact SHA-256 produced by Annotation Truth V2 rather than embedded,
because their canonical geometry legitimately contains floating-point values;
the V1 wire itself deliberately contains no floats.

The builder also rejects per-frame counts above 64 and per-annotation detached
attestation counts above 17 in a cheap structural pass before annotation
canonicalization, attestation fingerprinting, or sorting.

## No admission by receipt

Successful verification returns a private, immutable, read-only evidence
receipt. Every consumer admission property is hard-coded `False`, including
training, evaluation, deployment, and live scoring. `TEST` is therefore never
train-admissible, and neither are `TRAIN` or `DEV` on this receipt alone.

A later training boundary must reverify the exact concrete annotations,
attestations, current trust snapshots, source/rights/derivation evidence, split
policy, and immutable media lease. Protocol conformance or possession of this
receipt is never authority.
