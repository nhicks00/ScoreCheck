# Beach Volleyball Vision Scoring Architecture

**Status:** domain-contract/reducer foundation implemented; authentication, persistence, perception, and training remain gated

**Decision date:** 2026-07-11

**Initial product:** assistive live scoring with explicit abstention and human authority

**Related readiness plan:** [DATA_CAPTURE_READINESS.md](./DATA_CAPTURE_READINESS.md)

## Decision

Build a new event-driven vision service. Do not resume the legacy perception pipeline as the production base. Salvage its deterministic scoring concepts, schemas, test cases, and operator-review ideas, but replace the model orchestration and data lifecycle.

Computer vision produces evidence and proposals; it never writes a score. The deterministic rules reducer is the sole domain function that derives a new score state from an accepted event. It is not, by itself, an access-control or security boundary: official use additionally requires an authenticated authorizer, signature verification, and transactional event persistence, none of which is implemented in the foundation package yet.

The first product is deliberately narrower than referee-grade officiating:

| Product tier | Promise | Explicitly excluded |
|---|---|---|
| Assistive scoring | Identify likely server, rally transition, team attribution, and review moments; propose safe score events | Automatic in/out, touch, net, foot-fault, replay, sanction, or terminal-point adjudication |
| Advanced statistics | Rally segmentation, contacts, trajectories, player movement, and derived statistics after validation | Claims that monocular estimates are referee-accurate |
| Referee support | Fault-specific evidence from synchronized, calibrated multi-camera capture | Certification or unattended officiating without a separate validation program |

The current 1080p30 fixed-camera feed is a compatibility input, not the assumed production optimum. Single-camera 4K60 is the proposed assistive baseline. Synchronized multi-view capture is required before pursuing credible 3D reconstruction or referee-support claims.

## Non-negotiable design rules

1. **Fail closed.** Missing frames, non-monotonic timestamps, duplicate bursts, calibration drift, model failure, version mismatch, or conflicting evidence produces `unresolved` or `review`; it cannot silently fall back to a score mutation.
2. **One domain transition function, separate security boundary.** Vision workers have no credentials for official score tables or overlays. The reducer validates event shape, sequencing, and volleyball-domain semantics, but it does not authenticate callers. A trusted service must authenticate the actor, enforce authority/policy, sign and append the event transactionally, and verify that signature before reduction.
3. **Event sourcing.** Raw observations, proposals, authorizations, corrections, model versions, calibrations, and reducer outputs are append-only and replayable.
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
RallyDecision proposal
  PENDING | REVIEW | REPLAY_NO_POINT | UNRESOLVED | AUTO_CONFIRM
        |
        v
Authenticated authorizer / human review       [not implemented]
        |
        v
Signed RuleEvent -> authenticated event processor       [not implemented]
                    verify signer/ruleset/sequence
                    run reducer
                    append event + derived state atomically
        |
        v
Committed derived score state -> official score + overlay
        |                         |
        +------ immutable audit <-+
```

ScoreCheck remains the official presentation and operator surface. The vision service integrates through the future authenticated event boundary, not by writing `score_states`, `overlay_states`, or their successors directly. Calling `RulesReducer.reduce()` in-process is only a domain-library operation and must not be described as an authorized official mutation.

### Runtime stages

| Stage | Responsibility | Initial implementation |
|---|---|---|
| Capture gateway | Preserve source resolution, audio, presentation timestamps, frame IDs, and drop/duplicate diagnostics | GStreamer/FFmpeg ingest with a bounded 0.5–2 second buffer |
| Calibration | Lens correction, named court points, homography/PnP, fixed-camera drift detection | Manual intrinsics/extrinsics with OpenCV; learned refinement only for recovery |
| Ball perception | Center, visibility, blur extent/orientation, uncertainty, and short track | Causal temporal heatmap model inspired by WASB/BlurBall; run every frame on native-resolution ROI or tiles |
| Player perception | Active-player boxes and court membership | D-FINE-S or RT-DETRv2-S; typically 15–30 Hz |
| Tracking | Rally-local identity, team/side constraints, and occlusion continuity | ByteTrack baseline; BoT-SORT only if held-out tests justify added ReID complexity |
| Pose | Contact-window body/hand evidence | RTMPose-m on player crops only around candidate events |
| Temporal fusion | Serve/contact/dead-ball/next-server evidence with uncertainty | Small causal TCN/GRU or constrained state model over geometry, tracks, pose, audio, and rules context |
| Decision policy | Eligibility, calibration, contradiction checks, and abstention | Versioned policy producing a proposal, never a score |
| Authenticated authorizer | Resolve actor/role, enforce human/referee/automatic policy, bind evidence, sign canonical events | Not implemented; required before any external or official mutation path |
| Authenticated event store | In one transaction: verify signer/ruleset/sequence, run reducer, append event and derived state, and expose replay | Not implemented; in-memory reducer state is not durable proof |
| Rules reducer | Beach-volleyball scoring, service order, set/match completion, and pending side-switch/timeout obligations | Pure deterministic domain library; validates semantics, not identity or access |

LLMs and general-purpose VLMs are not in the live scoring path. They may help with offline labeling review, provided their output remains untrusted and human-verified.

## Contracts

All durable messages use UTC timestamps, monotonic source time, a schema version, capture/model/calibration identifiers, and an idempotency key. Large tensors and video remain in content-addressed storage; events reference them by hash.

`RulesReducer` performs domain validation only: match and set identity, contiguous sequence, exact ruleset fingerprint, event payload, scoring legality, and idempotency. It does not authenticate `actor_id`, establish that an `authority` enum came from a trusted principal, verify `authorization_id`, verify a cryptographic signature, or persist an event atomically. Those are responsibilities of the not-yet-implemented authorizer and event store.

### `RallyDecision`

This is a proposal and has no scoring authority.

```json
{
  "decision_id": "decision-01J...",
  "match_id": "match-123",
  "rally_id": "rally-17",
  "set_number": 1,
  "ruleset_id": "FIVB_BEACH",
  "ruleset_version": "2025-2028",
  "state": "REVIEW",
  "proposed_winner_team": "B",
  "confirmation_mode": "DIRECT_PROVISIONAL",
  "calibrated_probability": 0.997,
  "coverage_policy_version": "coverage-v0",
  "causal_cutoff_timestamp_ns": 418000000000,
  "blocking_reasons": ["human_authorization_required"],
  "evidence_refs": ["artifact:sha256:abc..."]
}
```

Required statuses are:

- `PENDING`: insufficient evidence within the allowed causal buffer;
- `REVIEW`: coherent proposal requiring human/referee review;
- `REPLAY_NO_POINT`: evidence proposes a replay, but the decision itself cannot close the rally;
- `UNRESOLVED`: evidence is missing, contradictory, or outside the trained domain;
- `AUTO_CONFIRM`: passes the decision contract, but still has no authority to issue or persist a `RuleEvent`.

### `RuleEvent` domain contract

The object below can pass contract and domain checks, but it is not thereby authenticated. `authorization_id` is an audit/provenance link to a future authorization record; it is not a token, credential, signature, or proof of permission.

```json
{
  "schema_version": "1.0",
  "event_id": "01J...",
  "sequence_number": 42,
  "match_id": "match-123",
  "set_number": 1,
  "event_type": "POINT_AWARDED",
  "authority": "SCOREKEEPER",
  "actor_id": "operator-7",
  "authorization_id": "authz-01J...",
  "ruleset_id": "FIVB_BEACH",
  "ruleset_version": "2025-2028",
  "ruleset_fingerprint": "f3279c13af9c17ad2df0d4f9d90a042db65fa5e82eb47f64d0590ec8b54e432e",
  "payload": {
    "winner_team": "B",
    "next_serving_player": "b1",
    "confirmation_mode": "HUMAN"
  },
  "reason": "scorekeeper confirmed ordinary rally",
  "related_rally_id": "rally-17",
  "evidence_refs": ["artifact:sha256:def..."],
  "created_at_ns": 1783792800000000000
}
```

The reducer recognizes only these semantic inputs initially. The “authority” column describes a domain restriction after an upstream service has authenticated the caller; an enum value supplied to the library is not proof of authority.

| Event | Effect | Authority |
|---|---|---|
| `SET_SEED` | Seeds service orders, first server, and side mapping; awards no point | Human/referee/trusted import, never `AUTO_POLICY` |
| `POINT_AWARDED` | Awards one rally and updates service entitlement | Human/referee; narrowly eligible `AUTO_POLICY` only after release gate |
| `PENALTY_POINT` | Basic authorized point alias using ordinary point/service validation | Human/referee/trusted import; never `AUTO_POLICY`; not a full sanction model |
| `SERVICE_ORDER_FAULT` | Basic authorized point alias using ordinary point/service validation | Human/referee/trusted import; never `AUTO_POLICY`; not full fault/remedy handling |
| `REPLAY_NO_POINT` | Closes/audits a replay with no score change | Human/referee/trusted import; never `AUTO_POLICY` in v0 |
| `SIDE_SWITCH_CONFIRMED` | Satisfies a pending switch and updates physical side mapping | Human/referee/trusted import; never `AUTO_POLICY` in v0 |
| `TECHNICAL_TIMEOUT_COMPLETED` | Satisfies the pending timeout obligation without changing score | Human/referee/trusted import; never `AUTO_POLICY` in v0 |
| `SCORE_CORRECTION` | Replaces current state under the constrained v0 correction rule | Privileged human/referee/trusted import; never `AUTO_POLICY` |

`SET_COMPLETE`, `MATCH_COMPLETE`, `SIDE_SWITCH_DUE`, `TECHNICAL_TIMEOUT_DUE`, and next-service-order state are reducer outputs, not model predictions.

### Ruleset fingerprint

Ruleset identity is the tuple of `ruleset_id`, `ruleset_version`, and a canonical SHA-256 fingerprint. ID/version labels alone are insufficient because parameters could change without a renamed version.

Canonicalization serializes exactly the effective `Ruleset` fields as UTF-8 JSON with lexicographically sorted keys and compact separators (`,` and `:`), with JSON `null` for an absent timeout. `reducer_semantics_version` must change whenever hardcoded transition semantics change. The default foundation ruleset canonicalizes to:

```json
{"best_of_sets":3,"deciding_set_target":15,"deciding_side_switch_interval":5,"reducer_semantics_version":"beach-reducer-v1","regular_set_target":21,"regular_side_switch_interval":7,"regular_technical_timeout_total":21,"ruleset_id":"FIVB_BEACH","version":"2025-2028","win_by":2}
```

Its lowercase SHA-256 is `f3279c13af9c17ad2df0d4f9d90a042db65fa5e82eb47f64d0590ec8b54e432e`. `MatchState` stores the reducer's computed value and the reducer rejects an event whose value differs exactly. This is a domain/configuration consistency check. SHA-256 without a trusted signature does not authenticate the event or the actor. Historical replay also pins the reducer artifact/container/commit digest; the explicit semantics version is a mandatory release discipline, not a substitute for artifact identity.

The ruleset fingerprint is distinct from `RuleEvent.fingerprint()`, which hashes the complete canonical event for conflict/idempotency detection. A production signed envelope must sign the event fingerprint (plus any required context) and verify it before transactional append/reduction.

### Pending obligations and point entry

`SIDE_SWITCH_DUE` and `TECHNICAL_TIMEOUT_DUE` are latched obligations, not reasons to lose an authoritative score update. Once caller identity is authenticated upstream:

- a human scorekeeper/operator or referee-feed point may be recorded while either obligation is pending;
- recording that point does not claim the switch/timeout occurred and does not clear either obligation;
- `AUTO_POLICY` point events are blocked until all pending obligations have their own authorized confirmation events;
- simultaneous side-switch and technical-timeout obligations are confirmed separately.

If a human/referee terminal point ends the set before a previously overdue obligation is confirmed, the active latch ends with the set but the unresolved obligation is copied into the immutable `SetResult` and `SET_CLOSED_WITH_OPEN_OBLIGATIONS` is emitted. An obligation that becomes scheduled only at the terminal score is not marked overdue, because no further play occurs in that set.

This rule supports delayed/catch-up human entry while preventing automatic scoring from running ahead of unresolved match operations. In the standalone package the authority labels remain caller-supplied and therefore are not security assertions.

`SIDE_SWITCH_CONFIRMED` records the first outstanding `due_total`, current `observed_at_total`, explicit `cleared_through_total`, and observed team/side mapping. Catch-up across more than one interval is accepted only when the mapping matches the number-of-switches parity; an unchanged mapping cannot clear a single overdue switch.

### Administrative point and correction scope

`PENALTY_POINT` and `SERVICE_ORDER_FAULT` are only named aliases for a basic authorized point award. They preserve a reason/event type and reuse normal winner, service, and terminal-point validation. Every score/replay resolution—including either alias—requires a unique `related_rally_id` and immutable evidence so it cannot be scored twice. For an administrative point outside ordinary play, v0 uses an upstream-created synthetic scoring-opportunity ID in that field. They do **not** implement warning or sanction progression, cards, delay/misconduct classification, expulsion, default, forfeit, discipline cases, or every service-order-fault remedy. Those domains remain outside v0.

`SCORE_CORRECTION` v0 is deliberately local. It may supersede only the latest score/replay/correction event and only the current/latest set; seeds, side switches, and timeout events are not correction targets. A corrected terminal score must be reachable—the preceding score cannot already have ended the set. Corrected switch/timeout completion markers are bounded by that pre-terminal score, and a terminal point event cannot claim a same-set next server. It can reopen that latest set when its terminal point is still the latest event. If any later event or set exists, correction requires a separate replay service that appends an auditable correction instruction, rebuilds from the affected point, and revalidates every dependent event. The reducer does not edit history or perform that rebase itself.

The v0 correction payload cannot replace the seeded player roster or service-order tuples. If either tuple is wrong, reject that set seed and restart before accepting a dependent event; correcting it after dependent events requires the future replay service.

## Scoring policy

The primary early signal is the next authorized server, not full visual fault adjudication.

- The first serve of a set seeds serving state and awards nothing.
- If Team A served and Team B makes the next authorized serve, Team B won the prior ordinary rally.
- If Team A serves again, Team A may have won **or the rally may have been replayed**. Server identity alone is insufficient.
- There is no next serve after a set-ending point. Every terminal point remains human-authorized until direct outcome evidence passes a separate gate.
- Replays and corrections require explicit human/referee events. `PENALTY_POINT` and `SERVICE_ORDER_FAULT` cover only basic authorized point aliases; challenges, defaults, and the full sanctions/discipline domain are not implemented.
- Scheduled side switches are derived from score, but the physical team/side mapping must be confirmed when visual identity is uncertain.

The policy must therefore define event-class eligibility. It must not convert a high detector score into an all-purpose notion of rally correctness.

## Capture tiers and supported claims

Detailed measurement gates live in [DATA_CAPTURE_READINESS.md](./DATA_CAPTURE_READINESS.md).

| Capture tier | Supported target | Unsupported target |
|---|---|---|
| Single fixed 1080p30 | Compatibility experiments, server identity, delayed assistive review when the preflight passes | Reliable contact timing, line calls, touch/net adjudication, referee-grade 3D |
| Single fixed 4K60 | Production assistive baseline, better ball continuity, contact candidates, useful player/rally statistics | Authoritative calls hidden by occlusion or requiring depth |
| Dual synchronized calibrated 4K60 | Occlusion recovery, triangulation, stronger contact/team attribution, advanced statistics | Automatic referee authority without fault-specific validation and operations controls |
| Fault-specific multi-camera | Future challenge/referee support | Assumed certification; each fault type requires its own evidence and acceptance program |

## Model and license shortlist

Reported benchmark results are screening evidence, not product guarantees. Every code license, pretrained-weight license, dataset license, export path, and model card must be captured in the artifact manifest before adoption.

| Area | Preferred candidates | Current license posture | Decision |
|---|---|---|---|
| Ball | [WASB](https://github.com/nttcom/WASB-SBDT), [BlurBall](https://github.com/cogsys-tuebingen/BlurBall) concepts | Repositories report permissive licenses; verify weights/data separately | Fine-tune/reimplement a causal volleyball model; benchmark both temporal heatmap and generic detector families |
| Player detection | [D-FINE](https://github.com/Peterande/D-FINE), [RT-DETRv2](https://github.com/lyuwenyu/RT-DETR) | Apache-2.0 code at review time; verify chosen weights | Preferred baseline/challenger pair |
| Alternative detector | [RF-DETR](https://github.com/roboflow/rf-detr) | Code and weights have had distinct product/licensing surfaces; pin exact artifact and terms | Challenger only after legal/artifact review |
| Tracking | [ByteTrack](https://github.com/FoundationVision/ByteTrack), [BoT-SORT](https://github.com/NirAharon/BoT-SORT) | Permissive repositories; transitive model licenses still apply | ByteTrack first; add appearance only when measured |
| Pose | [RTMPose/MMPose](https://github.com/open-mmlab/mmpose) | Apache-2.0 code; verify weights and training sources | Selective-window inference, not every-frame whole-body pose |
| Calibration | [OpenCV calib3d](https://docs.opencv.org/4.x/d9/d0c/group__calib3d.html), [TVCalib](https://github.com/MM4SPA/tvcalib) concepts | OpenCV is permissive; verify learned-model artifacts independently | Manual fixed-camera solution first |
| Temporal events | Small owned TCN/GRU; [MoViNet](https://github.com/tensorflow/models/tree/master/official/projects/movinet) or [E2E-Spot](https://github.com/jhong93/spot) as challengers | Check exact repository and pretrained artifacts | Keep the live path causal and small |

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
| Stream reconnect/model version change | Start a new provenance segment | Join observations across the boundary silently |
| Authority/signature cannot be verified | Reject before append/reduction and alert | Trust `authority` or `authorization_id` strings |
| Ruleset fingerprint mismatch | Reject the event before state transition | Accept matching id/version alone |
| Latest-event/current-set correction | Append `SCORE_CORRECTION`; retain the original event | Edit or delete the superseded event |
| Historical correction after a later event/set | Route to the future replay service | Apply a local state overwrite |

Manual scoring must remain independently operational during every vision outage. Once its actor is authenticated by the future integration, human/referee point entry may continue while side-switch or timeout obligations remain latched; this exception never extends to `AUTO_POLICY`.

## Evaluation and release boundary

Subsystem accuracy is necessary but not sufficient. Release decisions use full-match, source-held-out replay and shadow operation. At minimum report:

- ball localization/visibility by size, blur, occlusion, court zone, venue, and lighting;
- HOTA/IDF1 and identity switches, not merely the count of active tracks;
- court reprojection and physical ground-plane error;
- contact/serve/dead-ball event precision and recall at frame/time tolerances;
- team attribution, replay discrimination, terminal-point handling, and exact score after every event;
- calibration and risk-versus-coverage curves;
- false official mutations per 1,000 eligible rallies and end-to-end latency.

Automatic mutation remains disabled until all gates in [DATA_CAPTURE_READINESS.md](./DATA_CAPTURE_READINESS.md) pass. This includes the non-model security gate: authenticated authority resolution, signature verification, canonical ruleset-fingerprint equality, and transactional event append must exist and pass adversarial tests. In particular, the initial model-policy safety gate is zero false mutations on at least 3,000 independently adjudicated eligible opportunities, zero illegal reducer transitions, and exact committed score after every event. Coverage must be reported beside that result; abstaining on everything is not success.

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

Calendar dates never waive a gate. If 3,000 eligible shadow opportunities or adequate venue diversity are not available by day 90, automatic mutation stays disabled.

## Decisions still required

1. Who owns and can authorize use of each existing or future video source?
2. What camera/lens/placement can consistently satisfy the measured 4K60 preflight at target venues?
3. Is an enterprise detector license preferable to an all-permissive stack after benchmark results?
4. Which storage/versioning system will back content-addressed media and immutable manifests?
5. Which authenticated human/referee roles may authorize ordinary, terminal, replay, basic administrative-point, and correction events at each rollout stage?
6. What regulatory or league process would be required before marketing any feature as referee support?
7. What complete sanctions/defaults/discipline model is required, if any, beyond the v0 administrative-point aliases?
