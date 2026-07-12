# Trusted Review-Clip Pipeline

**Status:** capture-session rights plus structurally checked, signed capture
metadata and metadata-only video-frame provenance implemented; trusted media,
verified ReviewClip production, and every live/training/evaluation/deployment
admission remain gated designs

**Decision date:** 2026-07-12

## Decision

Use both of these controls:

1. a separate one-object immutable source generation, fully opened, staged,
   hashed, and leased for a complete render batch; and
2. a domain-separated renderer signature over the exact source reference,
   frame map, manifest, output, toolchain, policy, and rights proof.

Do not place a potentially 64 GiB source object inside every clip generation.
That would multiply storage and hashing cost, and the immutable publisher does
not permit hard-link shortcuts. One verified source session may render several
clips while holding one lease and one staged source snapshot.

The current review schema v2 proves only canonical manifest bytes and rendered
object identity/size. Its `source_sha256`, decoder, selected frames/timestamps,
and render-profile values remain signed claims. After the atomic scorer-copilot
store is frozen, this pipeline replaces those contracts with review schema v3;
there is no v2 compatibility parser or migration.

## Interim hard-cut metadata boundary

`vision_scoring.capture_assets` implements a deliberately narrower safety
slice. It is not `CaptureSegmentAttestation`, review schema v3, a renderer
proof, a residency lease, or a ScoreCheck admission path.

`build_structurally_verified_capture_metadata()`:

- hashes the exact ordered concatenation of every selected fragment and checks
  each fragment hash and byte length;
- recomputes the evidence-window plan and rejects a shortened request;
- re-runs `evaluate_capture_trace()` over the immutable trace and finalized
  frame/PTS sequence instead of accepting a caller-supplied report;
- binds the exact session/configuration, match, capture session, venue, camera
  scope, roster, participants, window, fragment set, PTS/time base, policy
  generation, and operational capture-rights result; and
- produces `StructurallyVerifiedCaptureMetadata`, whose camera and clock hashes
  remain pinned service references—not verified camera/clock attestations.

Serialized metadata is authenticated separately with the domain
`multicourt-vision-scoring:finalized-capture-metadata:v1` and the
`FINALIZED_CAPTURE_METADATA_SIGNER` role. The current/revoked metadata trust
snapshot permits only one current metadata record per exact finalized asset.
Its signer public keys must be disjoint from every capture-session-rights signer
key. This signature authenticates metadata only; it does not authenticate media
content, a physical camera, clock accuracy, derivation, or residency.

`build_video_only_review_clip_provenance()` hashes exact supplied clip bytes and
preserves a contiguous one-to-one metadata map of source presentation indices,
PTS/time base, and mapped evidence timestamps. It does not decode those bytes
or verify that they contain the declared frames, contain a video stream, or
exclude audio/data streams. Decoder, render-profile, and renderer-runtime
hashes are explicitly declared claims.

Both public records carry fixed fail-closed statuses and properties:

- camera/clock references are
  `PINNED_SERVICE_REFERENCES_NOT_ATTESTATION_VERIFIED`;
- source/clip residency is `NOT_VERIFIED`;
- the capture metadata is
  `NOT_ADMISSIBLE_PENDING_CAPTURE_SEGMENT_AND_MEDIA_VALIDATION`;
- ReviewClip provenance is
  `NOT_ADMISSIBLE_PENDING_RENDERER_DECODER_AND_RESIDENCY_VALIDATION`; and
- live ScoreCheck presentation, training, evaluation, and deployment
  admissibility properties are always `False`.

The interim clip API accepts exactly
`ASSISTIVE_SCORING_PROCESSING` plus `SCORER_COPILOT_REVIEW`. This tuple records
the only operational rights checked; it does **not** make the metadata or clip
admissible for presentation. Non-operational, pose, training, evaluation,
deployment, derivative-data, and redistribution uses are absent from this API,
not optional. Exact-asset rights for those uses return only with the later
signed renderer/dataset-evidence and residency boundary.

## Future verified-v3 claims (not the interim metadata boundary)

A future successfully verified v3 clip would mean:

- exact source bytes were resident, safely opened, fully hashed, and leased
  through render completion;
- a protected renderer key signed the exact derivation record;
- the frame map, output bytes, fixed decoder/render/runtime contracts, and
  rights proof match that record;
- the rendered output passed the pinned structural/decode validator; and
- the clip generation is currently resident and byte-verified when admitted,
  presented, reviewed, or linked.

It does not prove physical camera truth, unseen camera behavior, computation in
the cryptographic sense, clock accuracy beyond a separate capture attestation,
current source residency after the render lease closes, or that a human watched
every frame or exact UI pixels.

## Immutable objects

### Source generation

The source store contains exactly one object:

```text
generations/<source-generation-id>/
  descriptor.json
  objects/<source-sha256>
```

`ReviewSourceRef` binds:

- schema version;
- source SHA-256 and exact logical size;
- source generation ID; and
- the exact singleton generation member tuple.

### Clip generation

Each clip generation contains exactly:

- canonical `ReviewClipManifestV3`;
- rendered clip bytes;
- canonical frame-map sidecar;
- canonical `SignedReviewClipDerivation`;
- the exact signed rights decision and attestation used for the render; and
- a canonical signed capture-segment attestation when the claim is live
  operational capture.

The signed derivation cannot contain its own object hash or final clip-generation
ID without a hash cycle. `ReviewClipRefV3` externally binds all object hashes,
sizes, and the exact sorted generation membership.

## Audio boundary

Review schema v3 is deliberately **video-only**. A source object may contain
audio, but the renderer does not decode, copy, transform, present, or cite it;
the rendered clip validator requires exactly one video stream and rejects every
audio stream. No audio observation may reference a v3 video frame map as proof
of sample timing or A/V alignment.

Audio becomes a separate later contract only after it binds the selected audio
stream, exact sample/time-base map, source-to-evidence clock transform, measured
A/V offset and drift, decoded-sample identity, render derivation, rights uses,
and output validation. Silently copying source audio or assuming that container
timestamps establish synchronization is forbidden.

## Contracts

### ReviewClipManifestV3

The manifest binds:

- source reference;
- selected video-stream index;
- selection start/end in the case evidence timeline;
- exact frame count;
- first and last canonical decoded-frame hashes;
- frame-map SHA-256;
- decoder and render-profile fingerprints;
- rendered clip SHA-256;
- clip role; and
- exact evidence references.

Ambiguous `start_frame_index`/`end_frame_index` fields are removed. Frame
selection is defined by the frame map and presentation order.

### Frame-map sidecar

The canonical bounded sidecar binds:

- source-reference fingerprint;
- selected stream and decoder contract;
- timeline-mapping fingerprint;
- evidence-timeline selection interval; and
- one entry per output frame containing presentation-order index, exact source
  PTS/time base, mapped evidence timestamp, and canonical decoded-frame hash.

V0 requires present, strictly increasing presentation timestamps and forbids
interpolation, synthesized frames, and frame-rate resampling. The pinned
software decoder contract defines B-frame reordering; presentation order, not
demux packet order, is authoritative.

### SignedReviewClipDerivation

The signed derivation binds:

- render job/request identities;
- exact source reference and verification method/time;
- manifest, frame-map, and rendered-object hashes/sizes;
- decoder, render profile, renderer runtime, and output-validation contracts;
- rights decision/attestation, rights policy/trust/evidence generations,
  verification date, geography, and exact required-use tuple;
- capture mode, optional capture-attestation hash, and timeline mapping;
- render start/completion/signing times; and
- renderer identity, key, policy, trust domain, protected configuration
  generation, and signature.

Capture mode is exactly one of:

- `LIVE_ATTESTED_CAPTURE_SEGMENT`; or
- `OFFLINE_FINALIZED_ASSET`.

Live ScoreCheck shadow use requires the first. The second is allowed only in a
protected offline evaluation/research deployment mode. Human-direct origin is
not a shortcut around media integrity or rights.

### CaptureSegmentAttestation

A separate capture key—not a renderer, assessment, review, human-command, or
authorizer key—binds source reference, capture session/match/stream/segment,
previous-segment chain and reconnect epoch, camera/profile/device/encoder
identities, source-to-evidence timeline mapping, clock verification/error
bound, frame-integrity counters, capture interval, protected capture policy,
and signature.

This is trusted-service evidence, not proof of physical truth.

## Rights boundary

`RightsDecision` schema v2 is exact-asset based and therefore works for a
finalized source whose SHA-256 is known. It cannot preauthorize bytes from a
future live segment.

Do not overload unrelated training or redistribution permissions to mean live
scorer review. The rights schema v2 adds explicit uses:

- `ASSISTIVE_SCORING_PROCESSING`; and
- `SCORER_COPILOT_REVIEW`.

Every future verified operational clip requires both. In the future signed-v3
boundary, add `BIOMETRIC_POSE_ANALYSIS` only when pose/biometric processing
occurs; add model-training/evaluation, derivative-dataset, or redistribution
permissions only when those activities actually occur. A permission tuple must
describe the real use, not merely be maximally permissive or broad.

The separately signed `CaptureSessionRightsGrant` is now implemented as a
strict, bounded, pure contract. It binds the exact grant, match, capture
session, venue, canonical camera set, roster commitment, canonical participant
scope, validity interval, geography, exact permitted-use tuple, basis,
owner/licensor, license where applicable, participant-age status, release and
rights-evidence hashes, reviewer, protected policy fingerprint, and protected
policy generation. Its detached Ed25519 attestation uses the distinct
`multicourt-vision-scoring:capture-session-rights-grant:v1` signing domain and
the `CAPTURE_SESSION_RIGHTS_GRANT_SIGNER` key role.

Operational verification requires a current trust snapshot whose SHA-256 is
independently pinned by protected configuration, plus independently supplied
expected policy fingerprint/generation and a trusted, rollback-protected
coordinator clock for `verified_at_ns`. A caller-controlled or backdated time
is not freshness evidence. It rejects a
stale or revoked grant, revoked or out-of-window key, cross-domain/key/reviewer
substitution, inactive date or geography, any match/session/venue/camera/roster
or participant mismatch, and missing minor clearance. It always requires both
`ASSISTIVE_SCORING_PROCESSING` and `SCORER_COPILOT_REVIEW`; training,
evaluation, pose, derivative-data, deployment, and redistribution uses remain
independent and cannot appear in this future-byte-free session grant. They must
be authorized later by an exact-asset `RightsDecision` after finalized bytes
exist.

The interim metadata API does not accept that later decision and exposes no
non-operational-use argument or field. Knowing an exact asset hash is necessary
but insufficient: training/evaluation/deployment remains blocked until the
signed renderer or dataset-evidence derivation and resident-object boundary can
bind the exact bytes actually used.

The grant deliberately has no asset or segment SHA-256: it cannot claim or
preauthorize future bytes. The trusted capture service still must bind every
finalized segment to the verified grant and current trust generation. Grant
evidence is content-addressed here; the operational coordinator must verify the
resident evidence objects through the later protected evidence-store boundary.
A later rights revocation blocks new rendering, admission, presentation,
review, or link but does not rewrite an already linked historical human event.

Checked human-readable synthetic value examples live at
`vision_scoring/examples/capture-session-rights-grant.json`,
`capture-session-rights-grant-attestation.json`, and
`capture-rights-trust-snapshot.json`. They contain no production authority and
are not canonical wire byte fixtures; tests generate exact wire bytes through
each contract's canonical encoder.

Rights policy, trust store, evidence generation, and protected configuration
are checked before and after source work so a mid-render governance change
invalidates the result.

## Trust and process separation

Use separate signature domains for renderer derivation, capture segments,
capture metadata, capture-session rights grants, and future retirement. A
capture-metadata signer public key may not appear in the capture-session-rights
keyring even under a different key ID. A protected
`ClipProductionPolicyArchive` retains adoption history, current revocations,
trusted renderer/capture keys, approved decoder/render/runtime/validator
fingerprints, and fixed resource ceilings. It grants no scoring authority.

The coordinator owns the renderer key and parses no hostile media. The isolated
worker receives read-only access to the verified staged source, a private
write-only output directory, and approved fingerprints. It receives no
network, database, event-ledger, ScoreCheck, signing-key, scorer, admin, or
official-score credentials.

The worker uses no shell, starts in a new process group with a fixed
environment, and is killable at one absolute deadline. The initial fixed V0
ceilings are:

- 8 render requests per batch;
- 64 GiB source;
- 30 seconds and 3,600 frames per clip;
- 128 MiB rendered bytes per clip and 512 MiB per case;
- 8 MiB frame map and 512 KiB manifest/attestation objects;
- 64 KiB each for stdout/stderr;
- 6 GiB address space, 64 file descriptors, 32 processes, and no core dumps;
- 3,600 seconds for source verification plus the render batch.

The future renderer contract pins software decoding, executable/runtime hashes,
stream selection, PTS/presentation semantics, rotation/color/deinterlace
policy, fixed encoding flags, stripped nondeterministic metadata, and exact
output validation. It separately forbids interpolation and FPS conversion. A
second isolated validator decodes the output and verifies frame count,
timestamps, dimensions, exactly one video stream, no audio or data streams, and
absence of extra frames.

## Public surface

```python
publish_quarantined_source(source_path, *, trusted_store_context) -> ReviewSourceRef

with open_verified_source_session(source_ref, *, production_context) as session:
    refs = session.render_review_clips(requests)

with verify_review_clips_for_use(
    refs,
    *,
    verification_context,
    verified_at_ns,
) as verified_lease:
    ...
```

`VerifiedSourceSession` and `VerifiedReviewClipLease` are non-serializable and
cannot outlive their leases. Public APIs accept no executable path, arbitrary
arguments, trust roots, keys, timeouts, or relaxed limits. A durable render-job
registry provides exact idempotency; conflicting bytes under one request key
fail closed.

## Publishing and retirement

The coordinator recomputes every output digest, publishes from private
same-filesystem staging with exclusive generation locking and no-replace
semantics, fsyncs files/directories, atomically exposes the complete generation,
then reacquires a read lease and reverifies every object before returning.

V0 exposes no deletion/retirement API. Before legal deletion is implemented,
add a signed monotonic retirement index whose entries remain effective even if
bytes later reappear. Exclusive retirement waits for active shared leases and
cannot remove clips for active/unresolved cases. Historical links retain hashes
and signatures and never cause an official score reversal.

## Required adversarial gates

P0 covers source descriptor/object/hash/size/path identity and mutation;
renderer/capture cross-key substitution; policy adoption/revocation; exact
rights purpose/geography/date; capture match/session/source binding; clock-map
substitution; frame off-by-one/future-frame errors; render request conflicts;
fault injection after every publish step; worker credential/network/process
escape; output/sidecar/attestation tampering; clip loss after admission; current
rights rechecks; and attempts by clip code to construct an authorization
command, event, outbox row, or official mutation.

P1 covers VFR/B-frames/negative or pathological timestamps, rotation and
interlacing, keyframe seek mistakes, decoder/runtime drift, nondeterministic
metadata, hangs/resource exhaustion/output growth, concurrent render races,
generation replacement, source/clip retirement races, and signed retirement
rollback.

## Implementation sequence

An interim safety slice is implemented before these production steps: exact
fragment/clip-byte hashing, structural trace/window recomputation, signed
metadata currentness, operational-rights rechecks, explicit non-admission, and
hard rejection of every non-operational use. It does not complete any trusted
media or ReviewClip step below.

1. Hard-cut review clips to schema v3: source ref, frame map, capture
   attestation, derivation, signed derivation, and strict codecs.
2. Implement clip-production policy/archive and domain-separated signing.
3. Implement safe source publication and non-serializable verified source
   sessions.
4. **Implemented:** add exact assistive-scoring/review rights uses, exact-asset
   rights schema v2, and the pure capture-session grant verifier. Finalized
   review-source verification remains part of the clip-production slice.
5. Implement isolated deterministic render/validation and atomic publishing.
6. Replace case-store clip checks with v3 verification and current
   policy/rights checks at admission, context, action, and link.
7. Add bounded finalized capture-window segments plus capture attestation and
   integrate the implemented pre-match capture-session rights grant before
   claiming live origin/clocks.
8. Add signed retirement only after the no-deletion V0 is proven.
9. Expose clips through the dedicated no-mutation ScoreCheck receipt UI.

Steps 1–6 can be proven with synthetic fixtures and selected finalized media.
Live operation remains gated on the separate capture-session rights grant,
capture/clock attestation, signed renderer/decoder validation, resident leased
objects, and actual rights-cleared source material.
