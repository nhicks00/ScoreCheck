# Capture Integrity Gateway

**Status:** pure metadata contracts, integrity evaluator, and evidence-window
planner implemented; source-byte materialization and capture trust remain
pending

**Decision date:** 2026-07-12

## First-slice boundary

The first slice is limited to:

1. strict capture-trace contracts;
2. a pure integrity state machine;
3. a bounded evidence-window planner over closed-fragment metadata;
4. synthetic metadata and FFmpeg integration fixtures; and
5. a test-domain finalized-window handoff to the trusted review-source
   pipeline.

Items 1–3 are implemented and tested. Items 4–5 remain follow-on work; no
source bytes or trust claims cross this pure metadata boundary yet.

Do not yet build an AVFoundation camera driver, continuous production byte
ring, multi-camera synchronization, perception integration, or any scoring
path. These contracts and algorithms can be proven without a physical camera
or rights-cleared footage.

## Interpretation boundary

Reuse `SOURCE_PRESENTATION_OFFSET_NS` for finalized source-frame identity and
the existing `FrameDecodeContract`/`DecodedFrameIdentity` only for selected
decoded evidence frames. Do not compute canonical RGB24 hashes for every live
4K60 frame; that would hash roughly 1.5 GB/s of decoded RGB.

The gateway may compute a pinned 64×36 8-bit luma diagnostic fingerprint to
surface freeze candidates. Repeated diagnostic hashes never establish
`VERIFIED_CAPTURE_DUPLICATE`: a real scene can be static.

Demux-order PTS reversal can be normal with B-frames, and DTS monotonicity is
not capture proof. Structural evaluation uses decoded presentation order, an
exact-rational but unauthenticated `ClockMappingCandidate`, optional device
sequence, and explicit camera-backend drop callbacks. The later trust boundary
must authenticate and independently constrain that clock candidate before any
operational claim.

## Trace contracts

`CaptureSessionDescriptor` binds source kind (`SYNTHETIC_TEST` or
`LIVE_CAMERA`), deployment/session/match/stream identities, expected native
width/height/FPS rational, capture profile, backend artifact, camera and clock
attestations, encoder configuration, a locked exposure/control-policy
fingerprint, optional rights grant, and evidence-time opening point.
`LIVE_CAMERA` requires production camera/clock attestations, a rights grant,
and an exposure policy that forbids unrecorded automatic setting changes.
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
`CONFIG_CHANGE`, or `STOP`. Every resume increments `reconnect_epoch`; a
configuration change begins new provenance rather than silently continuing.

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

## Capture, camera, and clock trust

After finalization:

1. validate and hash the exact window;
2. publish a singleton immutable source generation;
3. construct `ReviewSourceRef`;
4. sign `CaptureSegmentAttestation` over source/session/epoch/window/report,
   actual presentation and evidence intervals, frame count,
   camera/clock/encoder/rights identities, prior-segment chain, protected
   capture policy, and capture key; and
5. give the source reference and attestation to the review-clip pipeline.

Camera and clock claims use separate key kinds and signature domains. A clock
attestation binds device/evidence anchors, rational mapping, host-monotonic
validity interval, samples/residual/error bound, algorithm, policy, and key. A
camera attestation binds stable device/backend identities, negotiated native
mode/pixel format, lens/configuration, stabilization/upscaling/interpolation
state, locked/manual exposure and gain controls (or their explicitly measured
transition policy), encoder, validity interval, policy, and key.

Container metadata saying 3840×2160 at 60 fps does not prove native capture,
device identity, disabled interpolation/upscaling, or clock correctness.

The future `capture_trust.py` boundary must fail closed while independently:

- authenticating the session, camera, clock, rights, and fragment claims;
- re-deriving the session and every selected fragment configuration
  fingerprint instead of trusting serialized fingerprint strings;
- enforcing policy ceilings on the clock candidate's claimed and measured
  absolute error;
- opening, hashing, and validating the exact source bytes against fragment and
  finalized-window identities; and
- re-running the pure evaluator over the committed canonical trace and
  requiring the exact report fingerprint, rather than trusting serialized
  finding basis keys or aggregates; and
- validating the rights grant for the source, match, participants, venue,
  purpose, and requested evidence interval.

Until those checks succeed, `structurally_eligible_for_trust_verification`
means only that the pure trace is eligible to be presented to that later
boundary.

## Modules and public surface

Implementation order and current state:

- `capture_contracts.py`: enums, immutable dataclasses, codecs, bounds —
  implemented;
- `capture_integrity.py`: rational mapping candidate and pure trace evaluator
  — implemented;
- `capture_windows.py`: bounded fragment projection and pure planner —
  implemented;
- `capture_process.py`: fixed-command supervisor for finalized synthetic
  fixtures only;
- `capture_source.py`: output validation and test-domain source publication;
- `capture_trust.py`: separate camera, clock, and segment signatures.

Primary pure APIs:

```python
evaluate_capture_trace(session, clock_mapping, records, finalized_trace)
    -> CaptureSegmentIntegrityReport

plan_evidence_window(request, fragments) -> EvidenceWindowPlan
```

Later non-serializable staging APIs materialize and publish a planned window.
No production API accepts executable paths, shell arguments, timeouts, trust
roots, signing keys, camera claims, or relaxed bounds.

Keep synthetic helpers under `tests/support`; do not generalize the existing
media-preflight subprocess implementation during this slice.

## Synthetic validation

Most tests use pure metadata traces. Short-lived integration fixtures cover
60 and 60000/1001 fps, B-frames with valid presentation order, timestamp gaps,
freeze/repetition, VFR, wrong 1080p30 profile, rotation/interlace metadata,
corrupt output, and reconnect epochs. One roughly 0.25-second/15-frame
3840×2160 60 fps `testsrc2` fixture proves the native-size path without making
the suite expensive.

The local ARM64 Mac has Homebrew FFmpeg/ffprobe 8.1 with libx264 and
VideoToolbox. That build has `--enable-gpl`/`--enable-libx264`; it is allowed
only as an internal synthetic fixture generator. It is not the proprietary
production capture dependency. Production should use a separately reviewed,
pinned build or a native Swift AVFoundation/VideoToolbox helper.

macOS production capture also requires TCC permission, code signing/
entitlements, and a stronger App Sandbox/XPC or constrained-service boundary;
Python process limits are not a complete kernel/network sandbox. The protected
spool belongs on a local non-iCloud filesystem with 0700 directories, 0600
files, quota/free-space checks, and sustained-write headroom.

## Required gates

P0 tests cover strict parsing/bounds, session/epoch/config substitution,
sequence/device/timestamp/drop distinctions, clock validity, diagnostic hashes
remaining non-authoritative, reconnect/config invalidation, truncation,
synthetic-domain rejection, cross-key/domain use, planner eviction/no-shortening,
fragment/config mixing, path/symlink/hard-link/FIFO/dataless inputs, subprocess
output/deadline/descendant limits, no partial publication, singleton source
membership, and capture code's inability to construct authorization commands,
events, outbox rows, or ScoreCheck mutations.

Hardware validation later covers actual camera/capture-card modes and stable
IDs, native versus upscaled/interpolated output, AVFoundation drop callbacks,
clock behavior under load, unplug/replug epochs, two-hour 4K60 soak, thermal/
disk sustained-write behavior, audio/video sync, ball pixels/blur/court
visibility, and calibration.

## External input boundary

Nothing is needed from Nathan for contracts, evaluator, planner, synthetic
fixtures, process-failure tests, or a test-domain source handoff.

Real capture later requires the exact camera/capture-card and connection,
lens/mount/court positions, TCC permission, capture disk, stable device modes,
venue/participant rights plus signed session grant, representative lighting,
and approval for long soak and reconnect tests. Synthetic reports never
populate production readiness or real camera/clock verification fields.
