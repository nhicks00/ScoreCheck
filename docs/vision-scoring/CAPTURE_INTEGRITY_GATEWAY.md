# Capture Integrity Gateway

**Status:** pure metadata contracts, integrity evaluator, evidence-window
planner, structurally verified finalized metadata, and a signed genesis-only
capture-service statement are implemented; source-byte materialization,
physical-camera/live-origin proof, and every media or product admission remain
pending

**Decision date:** 2026-07-12

## First-slice boundary

The first slice is limited to:

1. strict capture-trace contracts;
2. a pure integrity state machine;
3. a bounded evidence-window planner over closed-fragment metadata;
4. synthetic metadata fixtures; and
5. later FFmpeg integration plus a test-domain finalized-window handoff to the
   trusted review-source pipeline.

Items 1–4 are implemented and tested. Item 5 remains follow-on work. A
separate implemented control-plane boundary now authenticates one supplied
sequence-zero capture-service statement and replays its exact metadata,
policy, rights, window, trace, and integrity bindings. No source bytes cross
that boundary, and it makes no physical-camera, live-origin, continuity,
media-content, residency, product-admission, or scoring claim.

Do not yet build an AVFoundation camera driver, continuous production byte
ring, multi-camera synchronization, perception integration, or any scoring
path. These contracts and algorithms can be proven without a physical camera
or rights-cleared footage.

## Interpretation boundary

Reuse `SOURCE_PRESENTATION_OFFSET_NS` for finalized source-frame identity and
the existing `FrameDecodeContract`/`DecodedFrameIdentity` only for selected
decoded evidence frames. Do not compute canonical RGB24 hashes for every live
native frame. The declared five-logical-stream 1080p60/1080p30 mix alone would
produce roughly 1.3 GB/s of decoded RGB24 before any future higher-resolution
input.

The gateway may compute a pinned 64×36 8-bit luma diagnostic fingerprint to
surface freeze candidates. Repeated diagnostic hashes never establish
`VERIFIED_CAPTURE_DUPLICATE`: a real scene can be static.

Demux-order PTS reversal can be normal with B-frames, and DTS monotonicity is
not capture proof. Structural evaluation uses decoded presentation order, an
exact-rational but unauthenticated `ClockMappingCandidate`, optional device
sequence, and explicit camera-backend drop callbacks. The implemented signed
capture-service statement authenticates the exact supplied mapping and its
recomputed bindings; it does not establish the mapping's accuracy, UTC origin,
or physical provenance.

## Trace contracts

`CaptureSessionDescriptor` binds source kind (`SYNTHETIC_TEST` or
`LIVE_CAMERA`), deployment/session/match/stream identities, expected native
width/height/FPS rational, capture profile, backend artifact, camera- and
clock-attestation reference hashes, encoder configuration, a locked exposure/control-policy
fingerprint, optional rights grant, and evidence-time opening point.
`LIVE_CAMERA` requires nonempty camera, clock, and rights reference hashes, the
production capture trust-domain value, and an exposure policy that forbids
unrecorded automatic setting changes. Constructing the descriptor verifies
only those fields; it does not open or authenticate the referenced evidence.
Synthetic sessions use a separate test trust domain and can never pass
operational verification.

`CaptureFrameSignal` is metadata only:

- session fingerprint and reconnect epoch;
- gateway-assigned contiguous observed sequence;
- optional backend device sequence;
- exact device timestamp and time base;
- host monotonic timestamp;
- frame dimensions; and
- optional measured exposure duration, sensor gain, and ISO value when the
  backend exposes them; and
- optional diagnostic fingerprint contract/hash.

Evidence time is derived from the exact-rational clock-mapping candidate.
Caller-supplied evidence timestamps are never trusted, but this pure evaluator
also does not authenticate the candidate or prove its claimed error bound. A
measured exposure/control transition that is not permitted and bound by the
session policy invalidates the segment; silently changing shutter, gain,
stabilization, focus, zoom, interpolation, or upscaling is never treated as the
same capture provenance.

`CaptureDropNotice` binds its place in the observed stream, optional device
timestamp and reported count, host time, and one of `LATE_DATA`,
`OUT_OF_BUFFERS`, `DEVICE_DISCONTINUITY`, `ENCODER_REJECTION`,
`DEVICE_FAILURE`, or `UNKNOWN`. Only this explicit backend notice can assert an
explicit drop; a timestamp gap remains inferred.

`CaptureStreamBoundary` records `START`, `INTERRUPT`, `RESUME`,
`CONFIG_CHANGE`, or `STOP`. The pure trace schema represents a resume by
incrementing `reconnect_epoch`, and a configuration change begins new
provenance rather than silently continuing. The signed capture-service V0
boundary accepts only reconnect epoch zero and cannot attest a resumed trace.

`FinalizedSourceFrameSignal` binds presentation-order index, exact source PTS
and time base, mapped evidence timestamp, dimensions, and whether the frame is
represented in finalized output. Schema v1 requires source PTS and time base
to preserve the observed device timestamp and time base exactly; rebased PTS
requires a future explicit, separately bound mapping contract. The signal does
not contain raw pixels.

All implemented codecs use exact field sets, canonical bounded JSON,
duplicate-key and nonfinite/float-number rejection, signed-64-bit limits, and
fixed count/depth/byte ceilings. Findings, integrity reports, and window plans
also expose stable fingerprints over their canonical encoded bytes.

## Audio boundary

The first capture schema is explicitly **video-only**. It makes no claim about
audio continuity, sample identity, or A/V synchronization, and a clean video
integrity report cannot be reused as audio evidence. Audio capture is a later
separate trace and attestation binding the selected device/stream, sample time
base and range, clock mapping, discontinuities, decoded-sample identity, and
measured A/V offset and drift. Review schema v3 correspondingly rejects audio
in rendered clips; audio observations must use separately verified evidence.

## Findings and report

The evaluator emits bounded `IntegrityFinding` values for:

- explicit backend drop;
- inferred device-timestamp gap;
- device-sequence gap;
- timestamp duplicate/regression;
- host-clock regression;
- diagnostic freeze candidate;
- dimension change;
- reconnect boundary;
- encoder frame loss; and
- finalized-output validation failure.

Every finding binds its exact basis and only those counts/deltas actually
established. Observed-sequence and mapped-evidence intervals are present only
when their endpoints were established; a failed clock map never substitutes a
fallback timestamp into an evidence interval.

`CaptureSegmentIntegrityReport` binds the session/window/epoch, actual source
and evidence interval, observed/finalized frame counts, FPS rational,
drop/gap/timestamp/freeze aggregates, bounded findings plus truncation state,
fixed counts for every finding kind, camera/clock/encoder fingerprints,
finalized-trace structural validation, disposition, and reason codes. The
per-kind vector makes a truncated summary internally checkable: it sums to the
total, dominates visible details, and exactly determines finding reason codes.
The report does not claim that source bytes,
rights, camera identity, or clock accuracy have been authenticated.
`window_fingerprint` identifies the canonical input trace; the report's own
fingerprint binds the complete canonical report output. Neither digest is an
authentication proof without an independently trusted signature or expected
digest.

Disposition is exactly `OBSERVED_CLEAN`, `OBSERVED_DEGRADED`, or `INVALID`.
“Observed clean” means no declared problem was observed; it is not “capture
proven healthy.” Missing/regressing presentation timestamps, failed clock map,
reconnect/config crossing, finalized-trace structural failure, or truncated
finding details are invalid. Explicit drops, inferred gaps, and freeze
candidates are at least degraded. Synthetic clean is still non-operational.

## Exact integrity rules

Use integer/rational arithmetic. Expected frame period is:

```text
1_000_000_000 × fps_denominator / fps_numerator
```

A device timestamp delta greater than 1.5 expected periods creates an inferred
gap interval, never a fabricated exact missing-frame count. Operational
decoded presentation timestamps must be present and strictly increasing.
Dimension, camera, encoder, clock, policy, or runtime changes terminate a
segment. Windows cannot cross a reconnect epoch. Equal 64×36 luma hashes over
at least 250 ms produce only a freeze candidate.

## Evidence-window planning

`EvidenceWindowRequest` binds request/idempotency/session/epoch identities,
trigger evidence time, pre/post roll, origin, and request time. Origin is only
`SYNTHETIC_TEST`, `HUMAN_REVIEW_TRIGGER`, or
`UNTRUSTED_PERCEPTION_TRIGGER`; it never asserts a rally-ending event.

`CaptureFragmentDescriptor` binds immutable closed-fragment identity,
session/epoch/sequence, half-open evidence and device intervals `[start, end)`,
byte length/content hash, keyframe-at-start, and exact
camera/clock/encoder/exposure configuration.

The pure planner selects closed fragments from one epoch and one exact
configuration. Keyframe alignment may begin the materialized source before the
requested interval, so the plan records requested and actual intervals. If
retention or byte eviction removes required pre-roll, return
`PREROLL_UNAVAILABLE`; never silently shorten the window.

Initial fixed ceilings:

- 30 seconds retention and 1 GiB ring bytes;
- 64 closed fragments, each at most 2 seconds and 64 MiB;
- 4 pending windows;
- at most 30 seconds total pre/post-roll;
- 1 GiB finalized source and 3,600 frames per window; and
- 64 detailed findings.

At 200 Mbps, 30 seconds is about 750 MB. The first slice deliberately does not
choose a production spool container; that depends on the later native backend
and encoder.

## Implemented genesis-only capture-service evidence

`vision_scoring.capture_assets` recomputes the exact ordered fragment
concatenation, evidence-window plan, finalized trace, integrity report,
capture-policy binding, and operational capture-session-rights result before
producing `StructurallyVerifiedCaptureMetadata`. Its camera and clock values
remain pinned service references, not independently verified physical-camera
or clock attestations.

`vision_scoring.capture_segment` then builds and verifies one bounded
`FinalizedCaptureSegmentStatement` plus detached Ed25519
`CaptureSegmentAttestation`. V0 is a hard cut:

- the statement's segment sequence is exactly zero;
- its reconnect epoch is exactly zero;
- its `lineage_id` is only an authenticated scope label;
- the protected trust snapshot contains exactly one current genesis entry;
  and
- there is no predecessor, continuation, chain, nonzero-sequence, or
  post-reconnect API.

Verification authenticates the exact supplied statement and signature and
replays the current metadata signature, metadata trust snapshot, capture and
rights policy pins, operational rights grant, window plan, finalized trace,
and integrity report. The trust snapshot itself must be independently pinned;
it is not self-authenticating.

This is service-assertion evidence only. It does not prove physical-camera
origin, live capture rather than replay, clock accuracy, media content,
decodability, audio absence, storage residency, or continuity after the one
genesis statement. It authorizes no ScoreCheck presentation, training,
evaluation, deployment, score event, or official-score mutation. The verified
receipt's live-presentation, training, evaluation, and deployment admission
properties are all fixed to `False`.

Container metadata saying 3840×2160 at 60 fps likewise does not prove native
capture, device identity, disabled interpolation/upscaling, or clock
correctness. `structurally_eligible_for_trust_verification` retains only its
narrow structural meaning; it is not media or product admission.

## Modules and public surface

Implementation order and current state:

- `capture_contracts.py`: enums, immutable dataclasses, codecs, bounds —
  implemented;
- `capture_integrity.py`: rational mapping candidate and pure trace evaluator
  — implemented;
- `capture_windows.py`: bounded fragment projection and pure planner —
  implemented;
- `capture_assets.py`: exact fragment-byte hashing plus structural
  metadata/policy/rights/finalized-trace binding — implemented; and
- `capture_segment.py`: signed, replay-verified, genesis-only capture-service
  statement with always-false product-admission flags — implemented.

Primary pure APIs:

```python
evaluate_capture_trace(session, clock_mapping, records, finalized_trace)
    -> CaptureSegmentIntegrityReport

plan_evidence_window(request, fragments) -> EvidenceWindowPlan

build_finalized_capture_segment_statement(...)
    -> FinalizedCaptureSegmentStatement

verify_capture_segment_attestation(...)
    -> VerifiedCaptureSegmentEvidence
```

The capture-segment verifier accepts supplied contracts and metadata only. It
accepts no paths, fragment or asset bytes, storage handles, network/database
clients, private signing keys, ScoreCheck credentials, or relaxed bounds.
Later non-serializable staging APIs must materialize and validate a planned
window before any media use.

Keep synthetic helpers under `tests/support`; do not generalize the existing
media-preflight subprocess implementation during this slice.

## Synthetic validation

Current capture tests use synthetic metadata and in-memory fragment bytes;
they do not produce a source object or ReviewClip. Coverage includes exact
60000/1001 rational mapping, presentation-order semantics, timestamp and
device-sequence gaps, drop notices, freeze candidates, configuration and
stream-boundary invalidation, strict finalized PTS, bounded window planning,
exact fragment hashing, current metadata/rights replay, genesis-only signing,
and hard rejection of nonzero sequence or reconnect epoch at the signed
capture-service boundary.

No FFmpeg/ffprobe live-capture integration, native RTMP/H.264 or SRT/HEVC raw
ingress path, production spool, or renderer/decoder validation is implemented
by this gateway. Any future production dependency requires a separately
reviewed, pinned build or a native constrained capture helper. The deterministic
offline decoder runtime is not a network-ingest runtime.

macOS production capture also requires TCC permission, code signing/
entitlements, and a stronger App Sandbox/XPC or constrained-service boundary;
Python process limits are not a complete kernel/network sandbox. The protected
spool belongs on a local non-iCloud filesystem with 0700 directories, 0600
files, quota/free-space checks, and sustained-write headroom.

## Required gates

Implemented tests cover strict parsing/bounds, session/epoch/config
substitution, sequence/device/timestamp/drop distinctions, supplied clock-map
validity, diagnostic hashes remaining non-authoritative, boundary/config
invalidation, truncation, synthetic-domain rejection, cross-key/domain use,
planner eviction/no-shortening, fragment/config mixing, exact byte hashing,
metadata/rights/policy/trace replay, genesis currentness, key revocation and
role separation, and capture code's inability to perform media I/O or construct
authorization commands, events, outbox rows, or ScoreCheck mutations.

Hardware validation later covers the declared 1080p30 HEVC/SRT and 1080p60
H.264/RTMP profiles, actual device modes and stable IDs, native versus
upscaled/interpolated output, backend drop callbacks, clock behavior under
load, interruption termination, a two-hour soak per production profile,
thermal/disk sustained-write behavior, audio/video sync, ball pixels/blur/court
visibility, and calibration. V0 must stop after an interruption; it has no
post-reconnect capture-service continuation.

## External input boundary

Nothing is needed from Nathan for the implemented contracts, evaluator,
planner, in-memory fragment checks, or synthetic metadata tests. The
test-domain source handoff remains unimplemented.

Real capture later requires the exact camera/capture-card and connection,
lens/mount/court positions, TCC permission, capture disk, stable device modes,
venue/participant rights plus signed session grant, representative lighting,
and approval for long-soak and interruption-termination tests. Synthetic
reports never populate production readiness or real camera/clock verification
fields.
