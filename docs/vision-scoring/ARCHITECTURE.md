# Beach Volleyball Vision Scoring Architecture

**Status:** V0 domain, policy, reducer, signed human authorization, atomic
replay-verified scorer-copilot persistence, authenticated append-only
ScoreCheck receipts, signed evidence contracts, sealed recovery intake, and an
owned causal ball runtime are implemented. The ball runtime has synthetic test
coverage only; rights-cleared training, deployable perception, and live product
integration remain gated.

**Decision date:** 2026-07-11

**Initial product:** assistive live scoring with explicit abstention and signed human authorization

**Related readiness plan:** [DATA_CAPTURE_READINESS.md](./DATA_CAPTURE_READINESS.md)

**Independent review adoption:**
[SECOND_STUDY_ADOPTION.md](./SECOND_STUDY_ADOPTION.md)

**Trusted clip-production design:**
[TRUSTED_REVIEW_CLIP_PIPELINE.md](./TRUSTED_REVIEW_CLIP_PIPELINE.md)

**Capture-integrity gateway design:**
[CAPTURE_INTEGRITY_GATEWAY.md](./CAPTURE_INTEGRITY_GATEWAY.md)

**Current signed capture-service genesis:**
[CAPTURE_SEGMENT_ATTESTATION.md](./CAPTURE_SEGMENT_ATTESTATION.md)

**Current ball runtime and label-completeness contract:**
[CAUSAL_BALL_BASELINE.md](./CAUSAL_BALL_BASELINE.md) and
[CAUSAL_BALL_LABEL_BUNDLE.md](./CAUSAL_BALL_LABEL_BUNDLE.md)

## Decision

Build a new event-driven vision service. Do not resume the legacy perception pipeline as the production base. Salvage its deterministic scoring concepts, schemas, test cases, and operator-review ideas, but replace the model orchestration and data lifecycle.

Computer vision produces evidence and hypotheses; it never writes a score. The deterministic rules reducer is the sole domain function that derives a new score state from an accepted event. It is not, by itself, an access-control or security boundary. The foundation now implements protected per-match authorization policy, signed human commands, authorizer countersignatures, strict envelope verification, and transactional replay/append for both human-direct and signed-case scorer-copilot shadow events. A scorer-copilot transition is accepted only when its signed case, historical review prefix, store-derived context, authorization link, event, state, idempotency result, and outbox row commit and replay atomically.

The first product is deliberately narrower than referee-grade officiating:

| Product tier | Promise | Explicitly excluded |
|---|---|---|
| Assistive scoring | Identify likely server, rally transition, team attribution, and review moments; surface evidence and recommended intents for a human | Automatic in/out, touch, net, foot-fault, replay, sanction, or terminal-point adjudication |
| Advanced statistics | Rally segmentation, contacts, trajectories, player movement, and derived statistics after validation | Claims that monocular estimates are referee-accurate |
| Referee support | Fault-specific evidence from synchronized, calibrated multi-camera capture | Certification or unattended officiating without a separate validation program |

No current camera feed has been recovered, rights-cleared, and shown observable
for this system. Historical 1080p30 material is only a possible Tier A
compatibility profile if its bytes are recovered, its rights and releases are
accepted, and its exact capture profile passes the observability gates.
Single-camera native 4K60 is the proposed prospective assistive baseline.
Synchronized multi-view capture is required before pursuing credible 3D
reconstruction or referee-support claims.

## Non-negotiable design rules

1. **Fail closed.** Missing frames, non-monotonic timestamps, duplicate bursts, calibration drift, model failure, version mismatch, or conflicting evidence produces `unresolved` or `review`; it cannot silently fall back to a score mutation.
2. **One domain transition function, separate security boundary.** Vision workers have no credentials for official score tables or overlays. The reducer validates event shape, sequencing, and volleyball-domain semantics, but it does not authenticate callers. The trusted boundary verifies a signed human command against protected per-match policy, countersigns the exact event envelope, and must reverify it within the append transaction before reduction.
3. **Event sourcing.** Raw observations, hypotheses, assessments, human commands, authorized envelopes, model versions, calibrations, and reducer outputs are append-only and replayable.
4. **Deterministic rules.** Replaying the same ordered `RuleEvent` stream under the same rules version must produce byte-equivalent score state.
5. **Calibrated abstention.** Confidence is not a generic detector score. Release decisions use source-held-out, event-level calibration and report accuracy against coverage.
6. **Causal live path.** Live models may use only present and past frames plus a bounded replay buffer. Non-causal models may be offline benchmarks, never live dependencies.
7. **Hard cutover.** No backward-compatible adapter for the legacy model pipeline is planned. Consumers move to the new contracts together.
8. **No production feature flag is authorized.** Shadow execution uses a separate sink with no mutation permission. A feature flag requires the owner's exact approval phrase before implementation.

## System boundary

```text
Native camera/audio
        |
        v
Capture integrity gate ----fail----> blocked + operator alert
        |
        v
Calibration and camera-motion monitor
        |
        v
Specialist observations
  ball | players | tracks | selective pose | court | audio
        |
        v
Causal temporal fusion + rules context
        |
        v
RallyHypothesis
  primary causal inference; no next-server evidence or scoring power
        |
        v
Independent next-server reconciliation (optional)
  later evidence; corroborate or downgrade only, never promote
        |
        v
Exception-first PolicyAssessment
  pending | unresolved | review | human authorization required
        |
        v
Human review -> signed AuthorizationCommand
        |
        v
Trusted authorizer verifies policy/roles/signatures
        |
        v
Countersigned AuthorizedRuleEvent
        |
        v
Transactional shadow processor
  reverify envelope and complete immutable history
  run reducer; append event/state/outbox atomically
  replay signed case/journal and historical score prefix
  commit case link with event/state/outbox atomically
        |
        v
Committed shadow state + scorer-copilot audit
  no credential or path to official ScoreCheck mutation
```

ScoreCheck remains the existing official manual-score surface. It has no vision
endpoint or vision UI. V0 is shadow-only: the vision subsystem has no credential
or code path that can write `score_states`, `overlay_states`, or their
successors. Calling `RulesReducer.reduce()` in-process is only a domain-library
operation and must not be described as an authorized or official mutation.

### Runtime stages

| Stage | Responsibility | Planned baseline | Current runtime state |
|---|---|---|---|
| Capture gateway | Preserve source resolution, audio, presentation timestamps, frame IDs, and drop/duplicate diagnostics | GStreamer/FFmpeg ingest with a bounded 0.5–2 second buffer | Structural trace/window evaluators and one signed, genesis-only capture-service evidence contract exist. No media ingest service or admitted asset exists. |
| Calibration | Lens correction, named court points, homography/PnP, fixed-camera drift detection | Manual intrinsics/extrinsics with OpenCV; learned refinement only for recovery | No calibration runtime or validated profile. |
| Ball perception | Center, visibility, blur extent/orientation, uncertainty, and short track | Owned causal temporal heatmap model on native-resolution ROI or tiles | A small stride-four encoder plus causal ConvGRU and heatmap/visibility/role/offset/blur/variance heads is implemented. It has 15 PyTorch regression tests and a 50-step synthetic overfit smoke only; it has never seen beach footage. |
| Player perception | Active-player boxes and court membership | D-FINE-S or RT-DETRv2-S; typically 15–30 Hz | Planned only. |
| Tracking | Rally-local identity, team/side constraints, and occlusion continuity | ByteTrack baseline; BoT-SORT only if held-out tests justify added ReID complexity | Planned only. |
| Pose | Contact-window body/hand evidence | RTMPose-m on player crops only around candidate events | Planned only. |
| Temporal fusion | Primary serve/contact/dead-ball and team-attribution evidence with uncertainty | Transparent constrained factor graph/HSMM first; a small causal TCN/GRU only if held-out evidence justifies it | Contracts exist; no fusion runtime. The ball ConvGRU is a perception model, not this event-fusion stage. |
| Next-server reconciliation | Compare a separately timed server observation to one exact primary hypothesis and state revision | Delayed consistency check only; never a source of policy promotion | Deterministic contract/reconciliation logic implemented; no live observation producer. |
| Decision policy | Eligibility, calibration, contradiction checks, and abstention | Versioned policy producing an assessment, never an event or score | Deterministic policy contract implemented; no live perception input. |
| Human authorization | Bind one exact event to a signed human command, optionally assisted by a separately signed eligible assessment | Ed25519 command/signature contracts; only scorekeeper, referee, and match-admin human roles exist | Implemented control-plane contract. |
| Trusted authorizer | Verify protected per-match policy generation, current revocations, role/event allowlist, command, assessment provenance, and context; countersign the envelope | Protected deployment identity/session resolution around the canonical authorizer | Canonical authorization boundary implemented; deployment identity/session resolution remains external. |
| Authenticated event store | In one transaction: verify signer/ruleset/sequence, run reducer, append event and derived state, and expose replay | Replay-verified no-mutation shadow ledger | Strict SQLite ledger implemented with full event and scorer-copilot history replay, exact cache/outbox/link comparison, global idempotency, historical score/review ordering, bounded history, externally comparable checkpoints, and permanent integrity blocking. |
| ScoreCheck receipt sink | Preserve authenticated source evidence without any official-score capability | Immutable receipt table and fixed historical-signature-verified read/replay boundary | Append-only persistence and `VERIFIED_RECEIPT_PREFIX` replay implemented. External rollback checkpoint, real Supabase/PostgREST/JWT role mapping, protected target resolver, endpoint, UI, and live dispatch are absent. |
| Rules reducer | Beach-volleyball scoring, service order, set/match completion, and pending side-switch/timeout obligations | Pure deterministic domain library | Implemented; validates semantics, not identity or access. |

LLMs and general-purpose VLMs are not in the live scoring path. They may help with offline labeling review, provided their output remains untrusted and human-verified.

## Contracts

Durable control-plane records use bounded schemas, stable identifiers,
explicit causal or authorization timestamps, and content fingerprints.
`AuthorizationCommand` owns the mutation idempotency key and expected revision;
those fields are not inference power. Large tensors and video remain in
content-addressed storage, and records carry immutable evidence references and
exact model/configuration provenance where applicable.

A pre-V2 loose `labels_sha256` and a task coverage declaration identified bytes
but did not prove that every decoded frame—or every localizable ball in a
frame—was enumerated. Schema-2 readiness now defines `labels_sha256` as the
exact `BallLabelPackRootV1` hash and binds its immutable generation, source
asset, and split through a separate structural label-pack worker.
`CausalBallLabelBundleV1` supplies the curator-signed
completeness claim for one bounded derived asset. It binds the exact ordered
decoded-frame identities and the complete per-frame set of Annotation Truth V2
preimages and attestations. Verification authenticates only the curator's
stated `COMPLETE_FULL_DECODED_FRAME` enumeration assertion; it does not
objectively prove source-frame completeness, source residency, derivation,
rights, pixel truth, annotation truth, or capture lineage. Its verification
receipt keeps training, evaluation, deployment, and live-scoring admission
fixed to `False`. The schema-3 readiness report mirrors all five false
admission scopes; structural TEST-pack verification is not evaluation or TEST
admission. A trusted single-use training launcher and an immutable media lease
that reverify all of those independent authorities are still pending. The
implemented bounded bridge is specified in
[READINESS_LABEL_PACK_GATE.md](./READINESS_LABEL_PACK_GATE.md).

`RulesReducer` performs domain validation only: match and set identity,
contiguous sequence, exact ruleset fingerprint, event payload, scoring legality,
rally-resolution uniqueness, and idempotency. It receives a pure domain event;
actor identity, role, policy, and signatures exist only in the outer authorized
envelope. The authorization module verifies the signed human command and
countersigned envelope. The transactional store repeats that verification
before reduction and append. Its dedicated scorer-copilot path also replays the
exact signed case journal and historical score prefix, binds the store-derived
review context, and commits the one-to-one case authorization link inside the
same transaction.

### Inference, reconciliation, and policy contracts

`RallyHypothesis` is a bounded causal inference record. Its four mutually
exclusive outcomes use integer parts-per-million that sum exactly to 1,000,000.
It binds match, rally, set, state revision, ruleset fingerprint, causal cutoff,
immutable evidence provenance, and exact model/configuration provenance. It
cannot contain next-server evidence.

`NextServerObservation` is a separate, later record bound to the same match,
rally, set, and state revision. Its evidence timestamp cannot precede the
hypothesis cutoff. Reconciliation records the exact hypothesis fingerprint and
classifies the observation as corroborating, contradicting, same-server
ambiguous, service-order conflict, unavailable, or inapplicable at a terminal
point. The evidence is useful as a delayed consistency check, but it never
raises a hypothesis into a more permissive policy status. A corroborating
observation leaves the primary-evidence decision unchanged; contradiction or a
service-order conflict requires review, and same-server ambiguity cannot
resolve replay ambiguity or remove human handling.

`PolicyAssessment` is deterministic advice bound to the exact hypothesis,
optional reconciliation, policy fingerprint, state revision, ruleset, evidence,
and causal time. Its statuses are `PENDING`, `REVIEW_REQUIRED`,
`HUMAN_AUTHORIZATION_REQUIRED`, and `UNRESOLVED`. Only a high-confidence point
with sufficient independent primary rally evidence and no fatal/review signal
can reach the human-authorization-required status. Replay, challenge,
administrative, timeout, side-switch, and correction signals remain review
cases. The assessment has no event-creation or scoring power.

### `RuleEvent` domain contract

The object below can pass contract and domain checks, but it is not thereby
authenticated. Identity, role, policy, command, and signature fields are
intentionally absent. Those facts belong to the signed outer envelope.

```json
{
  "schema_version": "2.0",
  "event_id": "01J...",
  "sequence_number": 42,
  "match_id": "match-123",
  "set_number": 1,
  "event_type": "POINT_AWARDED",
  "ruleset_id": "FIVB_BEACH",
  "ruleset_version": "2025-2028",
  "ruleset_fingerprint": "d814e2e4762a756ecc4e3b57010c0c345aed18b016bff39791b52daf27f722b4",
  "payload": {
    "winner_team": "B",
    "evidence_refs": ["artifact:sha256:def..."]
  },
  "related_rally_id": "rally-17",
  "created_at_ns": 1783792800000000000
}
```

The hard-cut schema and authorization allowlists recognize exactly five event
types:

| Event | Effect | Human role/path |
|---|---|---|
| `SET_SEED` | Seeds the two stable match rosters, service orders, first server, and side mapping; awards no point | Match admin, direct signed human command only |
| `POINT_AWARDED` | Awards one rally and derives the next server from the seeded service order | Scorekeeper or referee; direct, or assessment-assisted with both assessment and human signatures |
| `REPLAY_NO_POINT` | Resolves one rally with no score change | Scorekeeper or referee, direct signed human command only |
| `SIDE_SWITCH_CONFIRMED` | Satisfies a pending switch and records the observed physical side mapping | Scorekeeper or referee, direct signed human command only |
| `TECHNICAL_TIMEOUT_COMPLETED` | Satisfies a pending timeout without changing score | Scorekeeper or referee, direct signed human command only |

`SET_COMPLETE`, `MATCH_COMPLETE`, `SIDE_SWITCH_DUE`, `TECHNICAL_TIMEOUT_DUE`, and next-service-order state are reducer outputs, not model predictions.

### Signed human authorization and trust archive

An `AuthorizationCommand` binds the exact event fingerprint, expected state
revision, idempotency key, match-scoped policy fingerprint, human actor/key and
role, issue/expiry times, and nonce. A human-direct command forbids an attached
assessment. An assessment-assisted command must carry the exact separately
signed `PolicyAssessment`; its assessment key and policy fingerprint must be
accepted by the protected authorization policy, and its status, reasons,
intent, evidence, rally, ruleset, set, and state revision must all match the
event. The human still signs the command. A trusted authorizer then verifies it
and countersigns the complete canonical envelope.

`AuthorizationPolicyArchive` retains the exact historical per-match policy
generations needed to verify older envelopes while naming one current
generation. Current actor, assessment, and authorizer key revocations are
applied when an old envelope is replayed, so a later compromise can invalidate
historical use. Public-key material cannot be moved to a new identity to evade
that status.

The archive is not its own rollback detector. A trusted deployment loader must
obtain it from an externally rollback-protected configuration source and pin
its exact fingerprint. Policy validity windows provide freshness checks but do
not detect rollback within a window. The same outer boundary must protect a
monotonic event-log checkpoint or trusted backup generation; restoring an
internally consistent older database and older policy archive is otherwise
outside the package's ability to detect.

### Durable replay integrity

The ordered canonical authorized-event log is the source of truth. Encoded
`MatchState` is a validated cache only; decoding a self-consistent snapshot is
not evidence that the reducer produced it. Before append or audit, the
implemented transactional shadow store strictly parses and reverifies every
retained envelope against the protected archive and current revocations,
replays the complete contiguous event stream under the pinned ruleset/reducer
artifact, and compares each stored derived-state snapshot byte-for-byte. The
envelope, event, derived state, idempotency result, and shadow outbox record must
commit atomically. A failed write leaves none of them committed.

The existing ScoreCheck `scorer_shadow_states` table is not a valid vision sink
because scorer handoff can promote it into the official/broadcast score. The
implemented boundary instead stores authenticated, append-only receipts and
exposes only a fixed historical-signature-verified
`VERIFIED_RECEIPT_PREFIX` read/replay result. That status is neither a score nor
a rollback-completeness claim. An externally protected monotonic ScoreCheck
receipt checkpoint, real Supabase role/JWT/PostgREST mapping, a protected target
resolver, live dispatch, endpoint, and UI are not implemented. See
[SCORECHECK_SHADOW_INTEGRATION.md](./SCORECHECK_SHADOW_INTEGRATION.md).

### Ruleset fingerprint

Ruleset identity is the tuple of `ruleset_id`, `ruleset_version`, and a canonical SHA-256 fingerprint. ID/version labels alone are insufficient because parameters could change without a renamed version.

Canonicalization serializes exactly the effective `Ruleset` fields as UTF-8 JSON with lexicographically sorted keys and compact separators (`,` and `:`), with JSON `null` for an absent timeout. `reducer_semantics_version` must change whenever hardcoded transition semantics change. The default foundation ruleset canonicalizes to:

```json
{"best_of_sets":3,"deciding_set_target":15,"deciding_side_switch_interval":5,"max_events_per_match":4096,"reducer_semantics_version":"beach-reducer-v2","regular_set_target":21,"regular_side_switch_interval":7,"regular_technical_timeout_total":21,"ruleset_id":"FIVB_BEACH","version":"2025-2028","win_by":2}
```

Its lowercase SHA-256 is `d814e2e4762a756ecc4e3b57010c0c345aed18b016bff39791b52daf27f722b4`. `MatchState` stores the reducer's computed value and the reducer rejects an event whose value differs exactly. This is a domain/configuration consistency check. SHA-256 without a trusted signature does not authenticate the event or the actor. Historical replay also pins the reducer artifact/container/commit digest; the explicit semantics version is a mandatory release discipline, not a substitute for artifact identity.

The ruleset fingerprint is distinct from `RuleEvent.fingerprint()`, which hashes the complete canonical event for conflict/idempotency detection. A production signed envelope must sign the event fingerprint (plus any required context) and verify it before transactional append/reduction.

### Pending obligations and point entry

`SIDE_SWITCH_DUE` and `TECHNICAL_TIMEOUT_DUE` are latched obligations, not reasons to lose an authorized human score update:

- a signed scorekeeper or referee point may be recorded while either obligation is pending;
- recording that point does not claim the switch/timeout occurred and does not clear either obligation;
- simultaneous side-switch and technical-timeout obligations are confirmed separately.

If a human/referee terminal point ends the set before a previously overdue obligation is confirmed, the active latch ends with the set but the unresolved obligation is copied into the immutable `SetResult` and `SET_CLOSED_WITH_OPEN_OBLIGATIONS` is emitted. An obligation that becomes scheduled only at the terminal score is not marked overdue, because no further play occurs in that set.

This rule supports delayed/catch-up human entry while preserving unresolved
match operations. V0 has no automated event origin.

`SIDE_SWITCH_CONFIRMED` records the first outstanding `due_total`, current `observed_at_total`, explicit `cleared_through_total`, and observed team/side mapping. Catch-up across more than one interval is accepted only when the mapping matches the number-of-switches parity; an unchanged mapping cannot clear a single overdue switch.

### Unsupported administrative and correction paths

Administrative points, service-order remedies, sanctions, defaults, forfeits,
discipline, and all score corrections are outside V0. They cannot be encoded as
a specialized rule event and cannot enter the signed authorization path.

The reducer and authorization allowlists intentionally contain no correction
event. A future correction design must be a separately privileged replay
command, not a state overwrite: it must bind the affected event position and
before/after state fingerprints, retain the original immutable log, rebuild
from the affected point, and revalidate every dependent event and derived
state. Until that design and its trust/rollback controls exist, an incorrect
seed or score requires manual takeover; no local correction is accepted.

## Scoring policy

The primary early signal is a causal rally hypothesis built from rally
transition and team-attribution evidence, not full visual fault adjudication.
The next observed server is delayed reconciliation evidence only.

- The first serve of a set seeds serving state and awards nothing.
- If Team A served and Team B makes the next authorized serve, Team B won the prior ordinary rally.
- If Team A serves again, Team A may have won **or the rally may have been replayed**. Server identity alone is insufficient.
- There is no next serve after a set-ending point. Every terminal point remains human-authorized until direct outcome evidence passes a separate gate.
- Next-server corroboration never promotes an assessment; it leaves the
  primary-evidence result unchanged. A contradiction or service-order conflict
  requires review, while same-server ambiguity cannot remove human handling.
- Replays require a direct signed scorekeeper/referee command. Challenges,
  administrative points, corrections, defaults, and the full
  sanctions/discipline domain are unsupported.
- Scheduled side switches are derived from score, but the physical team/side mapping must be confirmed when visual identity is uncertain.

The policy must therefore define event-class eligibility. It must not convert a high detector score into an all-purpose notion of rally correctness.

## Capture tiers and supported claims

Detailed measurement gates live in [DATA_CAPTURE_READINESS.md](./DATA_CAPTURE_READINESS.md).

| Capture tier | Supported target | Unsupported target |
|---|---|---|
| Recovered fixed 1080p30 profile | Compatibility experiments, server identity, delayed assistive review only after byte recovery, signed rights/releases, and observability preflight | Any claim that a current feed exists; reliable contact timing, line calls, touch/net adjudication, referee-grade 3D |
| Single fixed 4K60 | Production assistive baseline, better ball continuity, contact candidates, useful player/rally statistics | Authoritative calls hidden by occlusion or requiring depth |
| Dual synchronized calibrated 4K60 | Occlusion recovery, triangulation, stronger contact/team attribution, advanced statistics | Unattended referee decisions without fault-specific validation and operations controls |
| Fault-specific multi-camera | Future challenge/referee support | Assumed certification; each fault type requires its own evidence and acceptance program |

## Planned model-family shortlist and current runtime

Reported benchmark results are screening evidence, not product guarantees. Every code license, pretrained-weight license, dataset license, export path, and model card must be captured in the artifact manifest before adoption.

| Area | Planned baseline/challengers | Current license posture | Runtime implementation |
|---|---|---|---|
| Ball | Owned causal heatmap baseline; [WASB](https://github.com/nttcom/WASB-SBDT), [BlurBall](https://github.com/cogsys-tuebingen/BlurBall), D-FINE-S, and RT-DETRv2-S concepts as empirical comparators | Candidate repositories report permissive licenses; exact weights/data remain separately gated | Owned causal ConvGRU baseline implemented and synthetic-smoke-tested only. No beach-data checkpoint, export, latency result, calibration result, or service. External candidate families are not integrated. |
| Player detection | [D-FINE](https://github.com/Peterande/D-FINE), [RT-DETRv2](https://github.com/lyuwenyu/RT-DETR) | Apache-2.0 code at review time; verify chosen weights | Planned only. |
| Alternative detector | [RF-DETR](https://github.com/roboflow/rf-detr) | Code and weights have had distinct product/licensing surfaces; pin exact artifact and terms | Planned challenger only after legal/artifact review. |
| Tracking | [ByteTrack](https://github.com/FoundationVision/ByteTrack), [BoT-SORT](https://github.com/NirAharon/BoT-SORT) | Permissive repositories; transitive model licenses still apply | Planned only; ByteTrack first, appearance only when measured. |
| Pose | [RTMPose/MMPose](https://github.com/open-mmlab/mmpose) | Apache-2.0 code; verify weights and training sources | Planned only; selective-window inference is preferred. |
| Calibration | [OpenCV calib3d](https://docs.opencv.org/4.x/d9/d0c/group__calib3d.html), [TVCalib](https://github.com/MM4SPA/tvcalib) concepts | OpenCV is permissive; verify learned-model artifacts independently | Planned only; manual fixed-camera solution first. |
| Temporal events | Transparent factor graph/HSMM; small owned causal TCN/GRU, [MoViNet](https://github.com/tensorflow/models/tree/master/official/projects/movinet), or [E2E-Spot](https://github.com/jhong93/spot) as challengers | Check exact repository and pretrained artifacts | No event-model runtime. The current ball ConvGRU is not an implementation of this stage. |

Initial rejection list:

- Ultralytics YOLO in a proprietary product without a documented enterprise license; the public path is AGPL-oriented.
- GPL event-model code such as T-DEED in the product runtime.
- Non-causal future-context models in the live path.
- A single globally resized 640-pixel-wide input for ball detection.
- Offline SAM-family segmentation as a live dependency; it is acceptable for pre-labeling only.

## Failure and recovery behavior

| Failure | Required behavior | Forbidden behavior |
|---|---|---|
| Timestamp gap/reversal, duplicated-frame burst | Close current candidate as `unresolved`; alert; preserve buffer | Interpolate through it and score |
| Camera moved or calibration drifted | Block spatially dependent proposals until recalibrated | Reuse stale homography |
| Model process/OOM/export error | Mark subsystem unavailable; keep manual scoring operational | Substitute another confidence field or fail open |
| Ball/player/pose disagreement | Route to review with all evidence | Average unrelated scores into confidence |
| Side/team identity uncertain | Require human/referee `SIDE_SWITCH_CONFIRMED` or remain unresolved | Guess from jersey color or last location |
| Stream reconnect/model version change | Block current genesis-only admission; require a future protected cross-epoch checkpoint before starting a separately authenticated segment | Join observations across the boundary silently or accept an unlinked new genesis |
| Human/authorizer signature or protected role cannot be verified | Reject before append/reduction and alert | Trust fields embedded in the domain event |
| Ruleset fingerprint mismatch | Reject the event before state transition | Accept matching id/version alone |
| Any score or seed correction request | Stop shadow progression, retain the request for audit, and require manual takeover pending the future privileged replay design | Edit/delete history, overwrite state, or manufacture a current V0 event |

Manual scoring must remain independently operational during every vision outage. A signed human point entry may continue while side-switch or timeout obligations remain latched; no automated event origin exists in V0.

## Evaluation and release boundary

Subsystem accuracy is necessary but not sufficient. Release decisions use full-match, source-held-out replay and shadow operation. At minimum report:

- ball localization/visibility by size, blur, occlusion, court zone, venue, and lighting;
- HOTA/IDF1 and identity switches, not merely the count of active tracks;
- court reprojection and physical ground-plane error;
- contact/serve/dead-ball event precision and recall at frame/time tolerances;
- team attribution, replay discrimination, terminal-point handling, and exact score after every event;
- calibration and risk-versus-coverage curves;
- false human-authorization-ready assessments per 1,000 eligible rallies and end-to-end latency; official mutations are impossible in the V0 shadow path.

V0 remains no-mutation shadow regardless of model metrics. A future official
path would require every gate in
[DATA_CAPTURE_READINESS.md](./DATA_CAPTURE_READINESS.md), explicit product
approval outside this hard cut, authenticated human/role resolution, signature
verification, canonical ruleset-fingerprint equality, rollback protection, and
transactional append under adversarial tests. The initial model-policy safety
study still targets zero false proposed mutations on at least 3,000
independently adjudicated eligible opportunities, zero illegal reducer
transitions, and exact shadow state after every event. Coverage must be reported
beside that result; abstaining on everything is not success.

## Hard-cutover disposition

The legacy prototype reportedly survives only in unreachable commit `f2d0600a114114d500ededf287211935502d0974`. Its media, weights, calibration artifacts, and most reviewed labels are absent from the current checkout, so old performance claims are not reproducible yet.

| Keep as reference | Rewrite | Reject |
|---|---|---|
| Deterministic scoring intent, NEXT_SERVER insight, rules cases, event/audit concepts, operator review UX | Capture gateway, calibration contract, all perception orchestration, fusion, confidence policy, authenticated authorizer, signed event persistence/replay, reducer integration, artifact lifecycle, evaluation harness | Precomputed-feature “live” path, detector confidence used as pose confidence, hardcoded evidence, silent fallback, direct CV score mutation |

The commit is now preserved on `codex/rescue-live-score-f2d0600a`. Do not merge its source wholesale. Recovery is archaeology; new work targets these contracts. See [LEGACY_RECOVERY_LEDGER.md](./LEGACY_RECOVERY_LEDGER.md).

## Delivery sequence

- **Days 0–30:** repository/data recovery, rights and artifact manifests, rules/event contracts, capture preflight, annotation guide, and dataset split lock.
- **Days 31–60:** source-held-out perception baselines, causal fusion, calibration, authenticated/signed event-path prototype, deterministic offline replay, and error taxonomy.
- **Days 61–90:** one-court no-mutation shadow operation, operator review workflow, risk/coverage measurement, and the single-versus-dual-camera decision.

Calendar dates never waive a gate. If 3,000 eligible shadow opportunities or adequate venue diversity are not available by day 90, remain in shadow. V0 contains no automated or official mutation path.

## Decisions still required

1. Who owns and can authorize use of each existing or future video source?
2. What camera/lens/placement can consistently satisfy the measured 4K60 preflight at target venues?
3. Is an enterprise detector license preferable to an all-permissive stack after benchmark results?
4. Which production object store or read-only snapshot service will replace the
   implemented local immutable-generation/lease primitive while preserving its
   exact membership, staged-consumption, and publisher/consumer isolation?
5. Which production identity/session system will resolve a person to the protected scorekeeper, referee, or match-admin key for one match?
6. What regulatory or league process would be required before marketing any feature as referee support?
7. What trust model and governing-body semantics are required for a future privileged replay command and any separately modeled sanctions/defaults/discipline domain?
