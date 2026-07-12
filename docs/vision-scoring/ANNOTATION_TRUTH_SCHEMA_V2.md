# Annotation Truth Schema V2

**Status:** implemented contracts and fail-closed unit benchmark; production
dataset/readiness authority bridge remains intentionally unavailable

**Decision date:** 2026-07-12

## Why V1 is being replaced

The V1 `BallState` mixes observability with image appearance: motion blur is
not a visibility state, and `ABSENT` does not distinguish a confidently empty
observable search volume from occlusion, ambiguity, a capture failure, or a
ball that is simply not in play. V1 temporal annotations also place visible
signals, inferred physical events, and official/legal outcomes in one enum.
That permits training and evaluation to silently substitute one kind of truth
for another.

V2 is a hard cut. There is no V1 parser, alias, migration shim, or mixed-schema
dataset. Existing synthetic fixtures are regenerated; any real annotation must
be explicitly relabeled or independently reviewed under V2.

## Four truth layers

1. **Media truth** is the immutable source/decode/capture identity and timing.
2. **Observational truth** says only what a reviewer can see or hear.
3. **Physical adjudication** is an expert conclusion about what happened in the
   world and may remain unresolved or interval-valued.
4. **Reported-official, unverified truth** is a human-reviewed transcription of
   a purported referee/scorer record under an exact ruleset. V2 does not call it
   authenticated official/legal truth; that requires a separate signed
   official-source verifier that has not been built.

Media truth remains in typed frame/decode/capture references. The other three
layers use distinct annotation types. Ball observations have a dedicated
signing domain now; the other types remain ineligible for trusted evaluation
until their own policies and signing domains exist. No record can select its
own truth layer with a free-form string.

## Ball observation contract

`BallFrameAnnotationV2` separates four axes:

- `visibility`: `VISIBLE`, `PARTIALLY_OCCLUDED`, `FULLY_OCCLUDED`,
  `OUT_OF_FRAME`, `NOT_PRESENT`, `INDISTINGUISHABLE`, or `CAPTURE_UNKNOWN`;
- `appearance`: `SHARP`, `MOTION_BLURRED`, or `NOT_OBSERVABLE`;
- `role`: `MATCH_BALL`, `SPARE_BALL`, `ADJACENT_COURT_BALL`,
  `RETRIEVER_BALL`, `WARMUP_BALL`, or `UNKNOWN`;
- `play_state`: `IN_PLAY`, `NOT_IN_PLAY`, `UNKNOWN`, or `NOT_APPLICABLE`.

Rules:

- `VISIBLE` and `PARTIALLY_OCCLUDED` require a center and apparent minor-axis
  diameter. `SHARP` forbids blur geometry; `MOTION_BLURRED` requires exactly
  one bounded blur representation.
- `FULLY_OCCLUDED`, `OUT_OF_FRAME`, `INDISTINGUISHABLE`, and
  `CAPTURE_UNKNOWN` contain no invented point geometry.
- `NOT_PRESENT` is a match-ball-only claim. It requires a typed
  `SearchRegionObservabilityAttestation` bound to the exact source, selected
  stream, decoded frame identity, full-frame rectangle, full observability,
  capture-integrity evidence, reviewer IDs, and review evidence. When the
  ball-only verifier accepts it, the enclosing reviewed/adjudicated annotation
  signatures cover that complete contract. It
  uses `role=MATCH_BALL`, `play_state=NOT_APPLICABLE`, and no track.
- `CAPTURE_UNKNOWN` requires an `UnavailableFrameReference` that binds a capture
  segment, expected presentation interval, reason, capture-integrity evidence,
  and gap evidence without inventing a decoded-frame hash or pixel grid. It is
  never a negative training example.
- `INDISTINGUISHABLE`, `CAPTURE_UNKNOWN`, and every `UNKNOWN` role/play state
  require a bounded ambiguity reason.
- A predicted or interpolated trajectory point is a different artifact and can
  never be serialized as an observed ball annotation.
- Role and play-state claims are independently reviewable. A visually obvious
  ball need not be the match ball, and a match ball need not be in play.
- Multiple balls may share one decoded frame. Their key is the frame identity
  plus `ball_instance_id` and role; exactly one logical `match-ball` subject is
  required per evaluated frame, while spare/adjacent/retriever/warmup balls are
  retained as separate hard-negative role slices.

The ball-localization benchmark's primary metrics admit only the logical
match-ball subject when visible or partially occluded with real geometry.
Non-match balls cannot contribute true positives and therefore cannot mask a
match-ball miss. A logical match-ball whose role is `UNKNOWN` is excluded from
primary TP/FP/FN and reported through unresolved-role frame/prediction
diagnostics. Non-match activations use all retained above-threshold predictions,
including predictions on frames where primary match-ball truth is nonlocalizable
or role-unresolved. Every other visibility state remains a separately reported
stratum.

The report includes immutable operating-point performance slices for every
appearance, role, and play-state enum value. Appearance and play-state slices
partition resolved match-ball truth and predictions. `MATCH_BALL` role
performance exactly equals the primary operating metric; concrete non-match
roles use hard-negative activation semantics; `UNKNOWN` role remains diagnostic
and cannot claim a localization TP. Every slice carries self-checked TP/FP/FN,
precision/recall/F1, ignored/evaluable counts, and matched-error evidence. The
in-memory report retains the exact immutable truth and prediction objects and
replays them during construction, binding each labeled slice and each negative
or unresolved frame identity to the committed TEST inputs. The compact
canonical report omits those large objects, so any persisted report must retain
the committed input artifacts beside it for independent revalidation.

## Separate temporal records

### ObservedTemporalEventAnnotation

Permitted types describe signals or directly visible/audible candidates, such
as whistle, service-authorization signal, toss/release, serve contact,
player-contact candidate, net-crossing candidate, landing candidate,
out-of-play candidate, rally-end signal, referee direction, challenge request,
timeout signal, side-switch observation, scoreboard display change, and next
server observation.

This record never says that a point was legally awarded or a physical fault was
established. Attribution may be known, unknown, or not applicable and unknown
values require a reason.

### PhysicalEventAdjudication

Permitted conclusions describe expert physical findings such as observed
contact, landing region, net/antenna contact, last touch, ordinary physical
rally winner, physical interference, or `UNRESOLVED`. A conclusion embeds typed,
resolved `ObservedTemporalEventAnnotation` values and verifies their unique
logical IDs, source, ontology, timestamp basis, and containment in the
adjudication interval. The physical record fingerprints declared reviewer/
adjudicator IDs and evidence, but V2 does **not** verify signatures for physical
records. That requires a future physical-annotation trust policy. It has no score
authority, and physical enums do not use legal replay/no-point wording.

### ReportedOfficialEventAnnotation

Permitted types describe a reported match record: set seed/start,
ordinary point, replay/no point, challenge result, reported sanction or
service-order remedy, timeout/TTO, side switch, reported correction, set/match
end, interruption, or resumption. It binds the exact ruleset fingerprint,
reported source/authority labels, source match revision when available, and
evidence record. Canonical output says `REPORTED_OFFICIAL_UNVERIFIED`,
`official_source_authenticated: false`, `score_authority: false`, and
`official_mutation_permitted: false`. DRAFT records are rejected. Unsupported
V0 domain events remain annotation strata and cannot be converted into
scorer-copilot authorization commands.

An inconclusive physical record and a reported-official point record have
different fingerprints. Neither overwrites or inherits truth from the other,
and neither is trusted by the ball-only signature verifier.

## Trust and evaluation

- Ball observations have a distinct signed type tag and signature domain.
  Unsupported types fail closed instead of falling through the ball verifier.
- Trust stores pin the current fingerprint by `(annotation_type,
  annotation_id)`, not by an untyped ID.
- The current evaluator requires a typed unit-evaluation manifest containing an
  ontology fingerprint, validated `SplitManifest` TEST assignments, and exact
  annotation coverage commitments. It recomputes all three against inputs.
- That manifest is explicitly `UNVERIFIED_UNIT_BENCHMARK` and cannot claim
  training or production readiness. A future authenticated readiness bridge
  must be separately designed and verified.
- Splits keep synchronized views, transcodes, adjacent windows, and all truth
  layers for one rally in the same partition.
- Reports disclose unresolved, occluded, indistinguishable, capture-unknown,
  not-present, and non-match-ball strata rather than excluding them silently.
  Confident-negative activations are constrained to exact canonical evaluated
  negative frame identities and their set commitment.
- Reported-official and physical records are structural inputs only until their
  own trust verifiers exist. Any cross-layer comparison is diagnostic, never an
  implicit ground-truth substitution.

## Implementation sequence

Implemented now: strict V2 contracts, ball-only typed attestation trust,
match-ball-first unit evaluation, typed split/coverage commitments, and
adversarial tests. Still required before empirical readiness claims:

1. authenticate a production dataset/readiness generation and bind this exact
   annotation ontology and evaluator artifact to it;
2. implement separate trust policies/signature domains for observed temporal,
   physical-adjudication, and reported-official records;
3. add annotation-tool export/import only after strict canonical codecs exist;
4. implement a distinct official-source verifier before introducing any
   authenticated official/legal truth type.

No empirical training begins while a dataset can confuse observation,
physical adjudication, or legal truth.
