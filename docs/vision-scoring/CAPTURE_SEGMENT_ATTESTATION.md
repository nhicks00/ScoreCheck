# Capture segment attestation V0

## Outcome

`vision_scoring.capture_segment` implements a bounded, signed capture-service
evidence record for one finalized, structurally clean capture segment. It is a
pure control-plane boundary. It authenticates what one protected capture
service asserted and proves that the assertion still matches the supplied,
current metadata, rights, policy, window, trace, and integrity contracts.

It does **not** establish physical truth. In particular, it does not prove:

- that a named physical camera produced the pixels;
- that a clock mapping is accurate, UTC-derived, or independently attested;
- that the finalized asset is resident, immutable in storage, decodable, or
  video-only;
- that decoded pixels match the metadata trace;
- that audio is absent;
- that a volleyball, contact, rally, point, or score event occurred; or
- that any media may be shown to ScoreCheck, used for training/evaluation, or
  deployed.

The verified wrapper therefore returns `False` for live ScoreCheck
presentation, training, evaluation, and deployment admissibility.

## Contracts

### `FinalizedCaptureSegmentStatement`

The canonical statement is capped at 64 KiB and embeds the exact canonical:

- structurally verified capture metadata and fingerprint;
- production capture-session descriptor;
- complete `ClockMappingCandidate` and fingerprint;
- evidence-window request and recomputed plan;
- recomputed `CaptureSegmentIntegrityReport`, including all counters,
  per-finding-kind counts, intervals, time base, disposition, structural
  validity, and video-only claim;
- protected capture policy and generation; and
- operational capture-session rights grant.

It additionally binds:

- segment, lineage-label, capture-service, reconnect-epoch, and literal
  sequence-zero identities;
- finalization and rights-verification coordinator times;
- exact metadata, metadata-attestation, metadata-trust-snapshot, finalized
  trace, rights-attestation, and rights-trust-snapshot hashes;
- exact capture- and rights-policy pins; and
- exactly `ASSISTIVE_SCORING_PROCESSING` and `SCORER_COPILOT_REVIEW`.

Construction accepts only an `OBSERVED_CLEAN`, structurally valid,
structurally eligible, video-only integrity report. “Clean” retains its
existing narrow meaning: the supplied trace did not expose a declared
structural defect. It is not a health certificate for physical capture.

The fixed statement statuses are:

- service claim: `SERVICE_SIGNED_POLICY_BOUNDED_REFERENCES`;
- physical capture truth: `NOT_CLAIMED`;
- asset residency: `NOT_VERIFIED`;
- content: `NOT_VERIFIED`;
- audio: `OUTSIDE_CAPTURE_SEGMENT_CONTRACT`; and
- admissibility:
  `NOT_ADMISSIBLE_PENDING_SOURCE_RESIDENCY_AND_SIGNED_RENDER_VALIDATION`.

### `CaptureSegmentAttestation`

The detached Ed25519 attestation is capped at 4 KiB. The only signing message
is canonical ASCII JSON under:

```text
multicourt-vision-scoring:capture-segment-attestation:v1
```

The message contains the complete statement plus key ID, exact
`CAPTURE_SEGMENT_ATTESTATION_SIGNER` role, trust domain, and signing time. The
module exposes message construction but no signing or private-key API.

### `CaptureSegmentTrustSnapshot`

The protected, caller-pinned snapshot is capped at 512 KiB and contains:

- snapshot generation, trust domain, capture service, lineage, session, and
  capture-policy scope;
- at most 64 current/revoked signer keys, each bound to the exact capture
  service;
- exactly one current sequence-zero genesis segment;
- at most 512 revoked statement hashes; and
- at most 256 reserved non-segment public-key hashes.

The one current entry binds the segment ID, literal-zero sequence, metadata
hash, statement hash, and attestation hash. The snapshot rejects a revoked
current statement. It contains no predecessor or continuation representation.

The snapshot is not self-authenticating. Its canonical SHA-256, generation,
capture service, lineage label, and current-genesis attestation hash must all
come from rollback-protected configuration. A caller-created
snapshot and caller-created “expected” digest are not trust.

The verifier checks the current capture-segment key set against both supplied
metadata and capture-rights key sets. The metadata and rights public-key
hashes must be present in the protected non-segment reservation set, and no
segment key may overlap any of them. Public-key reuse under another key ID is
not role separation.

## Verification replay

`verify_capture_segment_attestation` requires independently supplied, exact
objects and protected pins. It:

1. checks the segment snapshot hash/generation, service, lineage label, policy,
   and current-genesis pins;
2. requires the signed statement and attestation to be that one exact current
   genesis;
3. validates key role, service binding, signing validity, current revocation,
   trusted-time ordering, and the domain-separated Ed25519 signature;
4. re-verifies the current finalized-capture metadata signature and snapshot;
5. re-verifies the current operational capture-session rights grant;
6. rechecks protected capture- and rights-policy pins and generations;
7. recomputes the evidence-window plan from the bounded fragment projection;
8. re-runs `evaluate_capture_trace` over the supplied canonical trace and
   finalized-frame signals;
9. recomputes the finalized-trace digest and requires exact plan/report/trace
   equality with both the signed statement and current metadata; and
10. returns an always-inadmissible verification receipt.

`VerifiedCaptureSegmentEvidence` is a read-only structural `Protocol`, not a
constructible receipt class or capability marker. The verifier returns an
unexported, immutable, slotted implementation with no dataclass replacement
surface. Protocol conformance or Python class membership must never be used as
an authority or admission check; downstream code must re-run its own required
verification boundary and all receipt admission properties remain `False`.

The verifier accepts metadata only, never fragment bytes, asset bytes, clip
bytes, paths, storage handles, network clients, databases, ScoreCheck/event
credentials, or private signing keys. Consequently it can re-authenticate the
earlier exact-byte metadata claim but cannot prove that those bytes remain
resident or unchanged at verification time.

## Genesis-only and reconnect hard cut

V0 authenticates exactly one current sequence-zero genesis statement in
reconnect epoch zero. The `lineage_id` is only an authenticated scope label; it
does not prove historical lineage or continuity. There is no continuation
enum, predecessor field, chain collection, or nonzero sequence API.

Nonzero reconnect epochs are rejected. A reconnect-safe design needs a
protected cross-epoch checkpoint that binds the prior epoch head, reconnect
cause, new session/configuration identities, and coordinator authorization.
Starting an unlinked new genesis after reconnect would permit silent lineage
reset, so V0 does not expose that escape hatch.

A future continuation design must replay the complete ancestor statement,
attestation, evidence inputs, historical trust snapshot, revocation state, and
protected checkpoint at every step. A hash-only predecessor list is
insufficient because it cannot establish that each ancestor signature,
currentness decision, rights decision, and recomputation was valid under its
historical policy. V0 makes no such claim.

## Downstream boundary still required

This slice intentionally stops before product use. A later isolated source and
renderer/decoder validator must, at minimum:

- obtain the exact asset from protected immutable storage and re-hash it;
- validate container/stream layout and video-only requirements;
- decode with pinned software and compare every decoded frame and PTS with the
  committed frame map;
- establish the audio contract explicitly;
- re-verify current operational rights at presentation time; and
- emit its own domain-separated signed derivation under a disjoint key role.

Only that later boundary can replace the fixed non-residency/content/audio
statuses. The capture-segment signature alone never becomes a scoring or media
admission capability.

## Synthetic coverage

`test_capture_segment.py` covers canonical round trips, noncanonical and
oversized parsing, float/depth/node/signed-64 rejection, signatures, current
genesis, key validity/revocation, policy
pins, cross-role public-key separation, protected non-segment reservations,
metadata/rights/window/trace/policy substitution, non-genesis and reconnect
rejection, fixed key bounds,
and absence of mutating/media-I/O imports or API parameters.
