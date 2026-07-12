from __future__ import annotations

import base64
import dataclasses
import json
import unittest

import vision_scoring.review_contracts as review_module
from vision_scoring.authorization import PrincipalRole, SignedPolicyAssessment
from vision_scoring.domain_events import Team
from vision_scoring.hypotheses import (
    EvidenceKind,
    EvidenceProvenance,
    HypothesisModelProvenance,
    RallyHypothesis,
    RallyOutcome,
)
from vision_scoring.immutable_store import generation_id_for
from vision_scoring.policy import (
    PolicyAssessment,
    PolicyAssessmentStatus,
    PolicyReason,
    ScoringIntent,
    ScoringIntentKind,
)
from vision_scoring.reconciliation import NextServerOutcome, NextServerReconciliation
from vision_scoring.review_contracts import (
    MAX_REVIEW_JSON_CONTAINERS,
    MAX_REVIEW_JSON_DEPTH,
    MAX_REVIEW_JSON_NODES,
    MAX_REVIEW_RECORD_BYTES,
    MAX_REVIEW_ACTIONS,
    CaseAuthorizationLink,
    ReviewAdjudication,
    ReviewAuthorizationContext,
    ReviewClipManifest,
    ReviewClipRef,
    ReviewClipRole,
    ReviewContractError,
    ReviewDisposition,
    ReviewDispositionKind,
    ReviewDispositionReason,
    ScorerCopilotCase,
    SignedReviewDisposition,
    copilot_idempotency_key,
    encode_case_authorization_link,
    encode_review_adjudication,
    encode_review_authorization_context,
    encode_review_clip_manifest,
    encode_review_clip_ref,
    encode_review_disposition,
    encode_scorer_copilot_case,
    parse_case_authorization_link,
    parse_review_adjudication,
    parse_review_authorization_context,
    parse_review_clip_manifest,
    parse_review_clip_ref,
    parse_review_disposition,
    parse_scorer_copilot_case,
)


RULESET_SHA = "a" * 64
PRIMARY_SHA = "b" * 64
FUSION_WEIGHTS_SHA = "c" * 64
FUSION_CONFIG_SHA = "d" * 64
NEXT_SHA = "e" * 64
SERVER_WEIGHTS_SHA = "f" * 64
SERVER_CONFIG_SHA = "1" * 64
POLICY_SHA = "2" * 64
SOURCE_SHA = "3" * 64
DECODER_SHA = "4" * 64
RENDER_SHA = "5" * 64
PRIMARY_CLIP_SHA = "6" * 64
NEXT_CLIP_SHA = "7" * 64


def make_hypothesis() -> RallyHypothesis:
    return RallyHypothesis(
        hypothesis_id="hypothesis-1",
        match_id="match-1",
        rally_id="rally-1",
        set_number=1,
        state_revision=3,
        ruleset_fingerprint=RULESET_SHA,
        causal_cutoff_timestamp_ns=1_100,
        probabilities_ppm={
            RallyOutcome.POINT_TEAM_A: 100_000,
            RallyOutcome.POINT_TEAM_B: 800_000,
            RallyOutcome.REPLAY_NO_POINT: 50_000,
            RallyOutcome.UNRESOLVED: 50_000,
        },
        exception_signals=(),
        evidence=(
            EvidenceProvenance(
                evidence_ref="artifact:primary",
                kind=EvidenceKind.FUSED_RALLY,
                source_id="camera-1",
                content_sha256=PRIMARY_SHA,
                captured_at_ns=1_000,
            ),
        ),
        models=(
            HypothesisModelProvenance(
                model_id="fusion",
                model_version="1.0",
                weights_sha256=FUSION_WEIGHTS_SHA,
                inference_config_sha256=FUSION_CONFIG_SHA,
                runtime_id="runtime-1",
            ),
        ),
    )


def make_reconciliation(
    hypothesis: RallyHypothesis | None = None,
) -> NextServerReconciliation:
    hypothesis = hypothesis or make_hypothesis()
    return NextServerReconciliation(
        hypothesis_id=hypothesis.hypothesis_id,
        hypothesis_fingerprint=hypothesis.fingerprint(),
        match_id=hypothesis.match_id,
        rally_id=hypothesis.rally_id,
        set_number=hypothesis.set_number,
        state_revision=hypothesis.state_revision,
        causal_cutoff_timestamp_ns=1_300,
        outcome=NextServerOutcome.CORROBORATES,
        expected_team=Team.B,
        expected_player_id="b2",
        observed_team=Team.B,
        observed_player_id="b2",
        observed_probability_ppm=950_000,
        evidence=EvidenceProvenance(
            evidence_ref="artifact:next-server",
            kind=EvidenceKind.NEXT_SERVER,
            source_id="camera-1",
            content_sha256=NEXT_SHA,
            captured_at_ns=1_200,
        ),
        model=HypothesisModelProvenance(
            model_id="server-identity",
            model_version="1.0",
            weights_sha256=SERVER_WEIGHTS_SHA,
            inference_config_sha256=SERVER_CONFIG_SHA,
            runtime_id="runtime-1",
        ),
    )


def make_assessment(
    hypothesis: RallyHypothesis | None = None,
    reconciliation: NextServerReconciliation | None = None,
) -> PolicyAssessment:
    hypothesis = hypothesis or make_hypothesis()
    reconciliation = reconciliation or make_reconciliation(hypothesis)
    return PolicyAssessment(
        hypothesis_id=hypothesis.hypothesis_id,
        hypothesis_fingerprint=hypothesis.fingerprint(),
        match_id=hypothesis.match_id,
        rally_id=hypothesis.rally_id,
        set_number=hypothesis.set_number,
        state_revision=hypothesis.state_revision,
        ruleset_fingerprint=hypothesis.ruleset_fingerprint,
        causal_cutoff_timestamp_ns=reconciliation.causal_cutoff_timestamp_ns,
        policy_version="review-policy-v1",
        policy_fingerprint=POLICY_SHA,
        status=PolicyAssessmentStatus.REVIEW_REQUIRED,
        reasons=(PolicyReason.INSUFFICIENT_CONFIDENCE,),
        recommended_intent=ScoringIntent(
            ScoringIntentKind.AWARD_POINT,
            Team.B,
        ),
        evidence_refs=("artifact:primary", "artifact:next-server"),
        reconciliation_outcome=reconciliation.outcome,
        reconciliation_fingerprint=reconciliation.fingerprint(),
    )


def make_clip(
    role: ReviewClipRole,
    evidence_refs: tuple[str, ...],
    *,
    start_frame: int,
    end_frame: int,
    start_ns: int,
    end_ns: int,
    rendered_sha: str,
) -> ReviewClipRef:
    manifest = ReviewClipManifest(
        source_sha256=SOURCE_SHA,
        selected_video_stream_index=0,
        start_frame_index=start_frame,
        end_frame_index=end_frame,
        frame_count=end_frame - start_frame + 1,
        start_timestamp_ns=start_ns,
        end_timestamp_ns=end_ns,
        decoder_contract_sha256=DECODER_SHA,
        render_profile_sha256=RENDER_SHA,
        rendered_clip_sha256=rendered_sha,
        role=role,
        evidence_refs=evidence_refs,
    )
    objects = tuple(sorted((manifest.fingerprint(), rendered_sha)))
    return ReviewClipRef(
        manifest=manifest,
        manifest_sha256=manifest.fingerprint(),
        immutable_generation_id=generation_id_for(objects),
        generation_object_sha256s=objects,
        rendered_size_bytes=1_024,
    )


def make_primary_clip(**overrides: object) -> ReviewClipRef:
    values: dict[str, object] = {
        "role": ReviewClipRole.PRIMARY,
        "evidence_refs": ("artifact:primary",),
        "start_frame": 1,
        "end_frame": 11,
        "start_ns": 900,
        "end_ns": 1_100,
        "rendered_sha": PRIMARY_CLIP_SHA,
    }
    values.update(overrides)
    return make_clip(**values)  # type: ignore[arg-type]


def make_next_clip(**overrides: object) -> ReviewClipRef:
    values: dict[str, object] = {
        "role": ReviewClipRole.NEXT_SERVER_RECONCILIATION,
        "evidence_refs": ("artifact:next-server",),
        "start_frame": 12,
        "end_frame": 22,
        "start_ns": 1_100,
        "end_ns": 1_300,
        "rendered_sha": NEXT_CLIP_SHA,
    }
    values.update(overrides)
    return make_clip(**values)  # type: ignore[arg-type]


def make_case() -> ScorerCopilotCase:
    hypothesis = make_hypothesis()
    reconciliation = make_reconciliation(hypothesis)
    assessment = make_assessment(hypothesis, reconciliation)
    return ScorerCopilotCase(
        hypothesis=hypothesis,
        reconciliation=reconciliation,
        assessment=assessment,
        signed_assessment=None,
        clips=(make_next_clip(), make_primary_clip()),
        opened_at_ns=1_400,
    )


def make_disposition(case: ScorerCopilotCase | None = None) -> ReviewDisposition:
    case = case or make_case()
    return ReviewDisposition(
        case_fingerprint=case.fingerprint(),
        expected_case_sequence=0,
        previous_record_fingerprint=case.fingerprint(),
        idempotency_key="review-action-1",
        kind=ReviewDispositionKind.OBSERVED_OUTCOME,
        outcome=RallyOutcome.POINT_TEAM_B,
        reasons=(),
    )


def make_structurally_signed_disposition(
    case: ScorerCopilotCase | None = None,
    disposition: ReviewDisposition | None = None,
) -> SignedReviewDisposition:
    case = case or make_case()
    disposition = disposition or make_disposition(case)
    return SignedReviewDisposition(
        disposition=disposition,
        disposition_fingerprint=disposition.fingerprint(),
        actor_id="scorekeeper-1",
        actor_key_id="scorekeeper-key-1",
        actor_role=PrincipalRole.SCOREKEEPER,
        policy_fingerprint="8" * 64,
        trust_domain_id="court-control",
        signed_at_ns=1_450,
        signature_base64=base64.b64encode(b"s" * 64).decode("ascii"),
    )


def make_adjudication(
    case: ScorerCopilotCase | None = None,
    signed_disposition: SignedReviewDisposition | None = None,
) -> ReviewAdjudication:
    case = case or make_case()
    signed_disposition = signed_disposition or make_structurally_signed_disposition(
        case
    )
    return ReviewAdjudication(
        case_fingerprint=case.fingerprint(),
        expected_case_sequence=1,
        previous_record_fingerprint=signed_disposition.fingerprint(),
        idempotency_key="adjudication-1",
        considered_signed_disposition_fingerprints=(
            signed_disposition.fingerprint(),
        ),
        kind=ReviewDispositionKind.OBSERVED_OUTCOME,
        outcome=RallyOutcome.POINT_TEAM_B,
        reasons=(),
    )


def make_context(case: ScorerCopilotCase | None = None) -> ReviewAuthorizationContext:
    case = case or make_case()
    return ReviewAuthorizationContext(
        case_fingerprint=case.fingerprint(),
        match_id=case.match_id,
        rally_id=case.rally_id,
        set_number=case.set_number,
        state_revision=case.state_revision,
        ruleset_fingerprint=case.ruleset_fingerprint,
        case_sequence=0,
        journal_head_fingerprint=case.fingerprint(),
        evidence_refs=case.assessment.evidence_refs,
    )


def make_link(case: ScorerCopilotCase | None = None) -> CaseAuthorizationLink:
    case = case or make_case()
    context = make_context(case)
    return CaseAuthorizationLink(
        context=context,
        context_fingerprint=context.fingerprint(),
        authorized_envelope_fingerprint="8" * 64,
        event_fingerprint="9" * 64,
        event_id="event-4",
        committed_event_sequence=4,
        committed_state_revision=4,
        outbox_sequence=1,
        committed_at_ns=1_500,
    )


class ReviewContractRoundTripTests(unittest.TestCase):
    def test_all_unsigned_records_round_trip_canonically(self) -> None:
        case = make_case()
        disposition = make_disposition(case)
        signed_disposition = make_structurally_signed_disposition(
            case, disposition
        )
        values = (
            (case.clips[0].manifest, encode_review_clip_manifest, parse_review_clip_manifest),
            (case.clips[0], encode_review_clip_ref, parse_review_clip_ref),
            (case, encode_scorer_copilot_case, parse_scorer_copilot_case),
            (disposition, encode_review_disposition, parse_review_disposition),
            (
                make_adjudication(case, signed_disposition),
                encode_review_adjudication,
                parse_review_adjudication,
            ),
            (
                make_context(case),
                encode_review_authorization_context,
                parse_review_authorization_context,
            ),
            (make_link(case), encode_case_authorization_link, parse_case_authorization_link),
        )
        for value, encoder, parser in values:
            with self.subTest(record=type(value).__name__):
                raw = encoder(value)
                self.assertEqual(parser(raw), value)
                self.assertEqual(encoder(parser(raw)), raw)

    def test_collections_are_canonical_and_case_identity_is_stable(self) -> None:
        baseline = make_case()
        reordered = dataclasses.replace(baseline, clips=tuple(reversed(baseline.clips)))
        self.assertEqual(reordered.clips, baseline.clips)
        self.assertEqual(reordered.fingerprint(), baseline.fingerprint())

        disposition = dataclasses.replace(
            make_disposition(baseline),
            reasons=(
                ReviewDispositionReason.NEXT_SERVER_CONFLICT,
                ReviewDispositionReason.TEAM_ATTRIBUTION_CONFLICT,
            ),
        )
        reversed_reasons = dataclasses.replace(
            disposition, reasons=tuple(reversed(disposition.reasons))
        )
        self.assertEqual(reversed_reasons.fingerprint(), disposition.fingerprint())


class ReviewParserHardeningTests(unittest.TestCase):
    def test_unknown_path_and_supersession_fields_are_rejected(self) -> None:
        manifest_data = json.loads(encode_review_clip_manifest(make_primary_clip().manifest))
        manifest_data["path"] = "/tmp/untrusted.mp4"
        with self.assertRaisesRegex(ReviewContractError, "FIELD_SET"):
            parse_review_clip_manifest(
                json.dumps(manifest_data, sort_keys=True, separators=(",", ":")).encode()
            )

        case_data = json.loads(encode_scorer_copilot_case(make_case()))
        case_data["supersedes_case_fingerprint"] = "0" * 64
        with self.assertRaisesRegex(ReviewContractError, "FIELD_SET"):
            parse_scorer_copilot_case(
                json.dumps(case_data, sort_keys=True, separators=(",", ":")).encode()
            )

        adjudication_data = json.loads(
            encode_review_adjudication(make_adjudication())
        )
        adjudication_data["considered_disposition_fingerprints"] = (
            adjudication_data.pop("considered_signed_disposition_fingerprints")
        )
        with self.assertRaisesRegex(ReviewContractError, "FIELD_SET"):
            parse_review_adjudication(
                json.dumps(
                    adjudication_data,
                    sort_keys=True,
                    separators=(",", ":"),
                ).encode()
            )

    def test_duplicate_keys_noncanonical_bytes_and_oversize_fail_closed(self) -> None:
        raw = encode_review_clip_manifest(make_primary_clip().manifest)
        duplicate = b'{"source_sha256":"' + SOURCE_SHA.encode() + b'",' + raw[1:]
        with self.assertRaisesRegex(ReviewContractError, "DUPLICATE_KEY"):
            parse_review_clip_manifest(duplicate)
        with self.assertRaisesRegex(ReviewContractError, "NON_CANONICAL"):
            parse_review_clip_manifest(b" " + raw)
        with self.assertRaisesRegex(ReviewContractError, "RAW_SIZE"):
            parse_review_clip_manifest(b"{" + b" " * MAX_REVIEW_RECORD_BYTES)

    def test_float_exponent_and_nonfinite_numbers_are_rejected_at_parse_time(self) -> None:
        raw = encode_review_clip_manifest(make_primary_clip().manifest)
        data = raw.replace(b'"frame_count":11', b'"frame_count":1.1', 1)
        exponent = raw.replace(b'"frame_count":11', b'"frame_count":1e1', 1)
        nonfinite = raw.replace(b'"frame_count":11', b'"frame_count":NaN', 1)
        for hostile in (data, exponent, nonfinite):
            with self.subTest(raw=hostile[:80]):
                with self.assertRaisesRegex(ReviewContractError, "INVALID_JSON"):
                    parse_review_clip_manifest(hostile)

    def test_deep_json_is_bounded_without_recursive_shape_walk(self) -> None:
        nested = (
            b'{"x":'
            + b"[" * (MAX_REVIEW_JSON_DEPTH + 10)
            + b"0"
            + b"]" * (MAX_REVIEW_JSON_DEPTH + 10)
            + b"}"
        )
        with self.assertRaisesRegex(ReviewContractError, "JSON_DEPTH"):
            parse_review_clip_manifest(nested)

        parser_overflow = b'{"x":' + b"[" * 2_000 + b"0" + b"]" * 2_000 + b"}"
        with self.assertRaisesRegex(ReviewContractError, "JSON_DEPTH"):
            parse_review_clip_manifest(parser_overflow)

    def test_node_and_container_bombs_are_bounded(self) -> None:
        nodes = (
            b'{"x":['
            + b",".join(b"0" for _ in range(MAX_REVIEW_JSON_NODES + 1))
            + b"]}"
        )
        with self.assertRaisesRegex(ReviewContractError, "JSON_NODES"):
            parse_review_clip_manifest(nodes)

        containers = (
            b'{"x":['
            + b",".join(b"[]" for _ in range(MAX_REVIEW_JSON_CONTAINERS + 1))
            + b"]}"
        )
        with self.assertRaisesRegex(ReviewContractError, "JSON_CONTAINERS"):
            parse_review_clip_manifest(containers)


class ReviewEvidenceInvariantTests(unittest.TestCase):
    def test_clip_reference_binds_exact_manifest_generation_and_bytes(self) -> None:
        clip = make_primary_clip()
        with self.assertRaisesRegex(ValueError, "manifest_sha256"):
            dataclasses.replace(clip, manifest_sha256="0" * 64)
        with self.assertRaisesRegex(ValueError, "generation_object_sha256s"):
            dataclasses.replace(clip, generation_object_sha256s=("0" * 64,))
        with self.assertRaisesRegex(ValueError, "immutable_generation_id"):
            dataclasses.replace(clip, immutable_generation_id="0" * 64)

    def test_case_rejects_duplicate_rendered_clip_content(self) -> None:
        baseline = make_case()
        duplicate_render = make_next_clip(rendered_sha=PRIMARY_CLIP_SHA)
        with self.assertRaisesRegex(ValueError, "repeat rendered content"):
            dataclasses.replace(
                baseline,
                clips=(make_primary_clip(), duplicate_render),
            )

    def test_context_only_clip_cannot_claim_inference_evidence(self) -> None:
        with self.assertRaisesRegex(ValueError, "CONTEXT_ONLY"):
            dataclasses.replace(
                make_primary_clip().manifest,
                role=ReviewClipRole.CONTEXT_ONLY,
            )

    def test_primary_clip_cannot_cross_hypothesis_cutoff(self) -> None:
        baseline = make_case()
        late_primary = make_primary_clip(end_ns=1_101)
        with self.assertRaisesRegex(ValueError, "primary clip exceeds"):
            dataclasses.replace(
                baseline,
                clips=(late_primary, make_next_clip()),
            )

    def test_next_server_clip_is_separate_and_causally_bounded(self) -> None:
        baseline = make_case()
        early_next = make_next_clip(start_ns=1_099)
        with self.assertRaisesRegex(ValueError, "causal reconciliation window"):
            dataclasses.replace(
                baseline,
                clips=(make_primary_clip(), early_next),
            )
        wrong_ref = make_next_clip(evidence_refs=("artifact:primary",))
        with self.assertRaisesRegex(ValueError, "exact reconciliation evidence"):
            dataclasses.replace(
                baseline,
                clips=(make_primary_clip(), wrong_ref),
            )

    def test_case_requires_exact_assessment_reconciliation_and_evidence(self) -> None:
        baseline = make_case()
        wrong_assessment = dataclasses.replace(
            baseline.assessment,
            reconciliation_fingerprint="0" * 64,
        )
        with self.assertRaisesRegex(ValueError, "reconciliation and assessment"):
            dataclasses.replace(baseline, assessment=wrong_assessment)

        with self.assertRaisesRegex(ValueError, "exactly cover"):
            dataclasses.replace(baseline, clips=(make_primary_clip(),))

        mismatched_match = dataclasses.replace(
            baseline.assessment,
            match_id="match-2",
        )
        with self.assertRaisesRegex(ValueError, "exact hypothesis"):
            dataclasses.replace(baseline, assessment=mismatched_match)

    def test_case_open_time_bounds_presentations_and_signed_assessment(self) -> None:
        baseline = make_case()
        context_clip = make_clip(
            ReviewClipRole.CONTEXT_ONLY,
            (),
            start_frame=23,
            end_frame=24,
            start_ns=1_301,
            end_ns=1_401,
            rendered_sha="0" * 64,
        )
        with self.assertRaisesRegex(ValueError, "displayed clip"):
            dataclasses.replace(
                baseline,
                clips=(*baseline.clips, context_clip),
            )

        early_assessment_signature = SignedPolicyAssessment(
            assessment=baseline.assessment,
            assessment_fingerprint=baseline.assessment.fingerprint(),
            assessor_id="assessment-service-1",
            assessment_key_id="assessment-key-1",
            signed_at_ns=baseline.assessment.causal_cutoff_timestamp_ns - 1,
            signature_base64=base64.b64encode(b"x" * 64).decode("ascii"),
        )
        with self.assertRaisesRegex(ValueError, "signed_assessment time"):
            dataclasses.replace(
                baseline,
                signed_assessment=early_assessment_signature,
            )

    def test_context_only_clip_cannot_extend_beyond_assessment_cutoff(self) -> None:
        baseline = make_case()
        late_context = make_clip(
            ReviewClipRole.CONTEXT_ONLY,
            (),
            start_frame=23,
            end_frame=24,
            start_ns=1_300,
            end_ns=1_301,
            rendered_sha="0" * 64,
        )
        with self.assertRaisesRegex(ValueError, "assessment causal cutoff"):
            dataclasses.replace(
                baseline,
                clips=(*baseline.clips, late_context),
                opened_at_ns=1_500,
            )


class ReviewActionInvariantTests(unittest.TestCase):
    def test_dispositions_are_bounded_advice_not_generic_payloads(self) -> None:
        case = make_case()
        with self.assertRaisesRegex(ValueError, "NO_DECISION"):
            dataclasses.replace(
                make_disposition(case),
                kind=ReviewDispositionKind.NO_DECISION,
                outcome=None,
            )
        with self.assertRaisesRegex(ValueError, "UNRESOLVED"):
            dataclasses.replace(
                make_disposition(case),
                outcome=RallyOutcome.UNRESOLVED,
            )
        with self.assertRaisesRegex(ValueError, "sequence-zero"):
            dataclasses.replace(
                make_disposition(case),
                previous_record_fingerprint="0" * 64,
            )

    def test_adjudication_cannot_escalate_or_ignore_named_dispositions(self) -> None:
        adjudication = make_adjudication()
        with self.assertRaisesRegex(ValueError, "cannot escalate"):
            dataclasses.replace(
                adjudication,
                kind=ReviewDispositionKind.ESCALATE,
                outcome=None,
                reasons=(ReviewDispositionReason.NEXT_SERVER_CONFLICT,),
            )
        with self.assertRaisesRegex(ValueError, "bounded nonempty"):
            dataclasses.replace(
                adjudication,
                considered_signed_disposition_fingerprints=(),
            )
        with self.assertRaisesRegex(ValueError, "prior case action"):
            dataclasses.replace(
                adjudication,
                expected_case_sequence=0,
                previous_record_fingerprint=adjudication.case_fingerprint,
            )
        with self.assertRaisesRegex(ValueError, "immediately previous"):
            dataclasses.replace(
                adjudication,
                previous_record_fingerprint="0" * 64,
            )

    def test_action_inputs_stop_before_max_but_post_action_context_reaches_max(self) -> None:
        case = make_case()
        signed = make_structurally_signed_disposition(case)
        final_input = dataclasses.replace(
            make_disposition(case),
            expected_case_sequence=MAX_REVIEW_ACTIONS - 1,
            previous_record_fingerprint=signed.fingerprint(),
        )
        self.assertEqual(
            final_input.expected_case_sequence,
            MAX_REVIEW_ACTIONS - 1,
        )
        with self.assertRaisesRegex(ValueError, "expected_case_sequence"):
            dataclasses.replace(
                final_input,
                expected_case_sequence=MAX_REVIEW_ACTIONS,
            )
        final_context = dataclasses.replace(
            make_context(case),
            case_sequence=MAX_REVIEW_ACTIONS,
            journal_head_fingerprint=signed.fingerprint(),
        )
        self.assertEqual(final_context.case_sequence, MAX_REVIEW_ACTIONS)

    def test_authorization_context_and_link_bind_exact_case_revision(self) -> None:
        case = make_case()
        context = make_context(case)
        context.validate_case(case)
        self.assertRegex(copilot_idempotency_key(context), r"^copilot-v1:[0-9a-f]{64}$")

        wrong_evidence = dataclasses.replace(
            context,
            evidence_refs=("artifact:primary",),
        )
        with self.assertRaisesRegex(ValueError, "exact case"):
            wrong_evidence.validate_case(case)

        link = make_link(case)
        link.validate_case(case)
        with self.assertRaisesRegex(ValueError, "immediately follow"):
            dataclasses.replace(link, committed_event_sequence=5, committed_state_revision=5)
        with self.assertRaisesRegex(ValueError, "before the case opened"):
            dataclasses.replace(link, committed_at_ns=case.opened_at_ns - 1).validate_case(
                case
            )

    def test_post_action_context_uses_signed_action_fingerprint(self) -> None:
        case = make_case()
        disposition = make_disposition(case)
        signed = make_structurally_signed_disposition(case, disposition)
        context = dataclasses.replace(
            make_context(case),
            case_sequence=1,
            journal_head_fingerprint=signed.fingerprint(),
        )
        self.assertEqual(context.journal_head_fingerprint, signed.fingerprint())
        self.assertNotEqual(
            context.journal_head_fingerprint,
            disposition.fingerprint(),
        )

    def test_review_contracts_expose_no_rule_event_or_score_mutation(self) -> None:
        self.assertFalse(hasattr(review_module, "RuleEvent"))
        for record_type in (
            ReviewDisposition,
            ReviewAdjudication,
            ReviewAuthorizationContext,
        ):
            names = {field.name for field in dataclasses.fields(record_type)}
            self.assertNotIn("event", names)
            self.assertNotIn("score", names)
            self.assertNotIn("winner_team", names)
        self.assertNotIn(
            "supersedes_case_fingerprint",
            {field.name for field in dataclasses.fields(ScorerCopilotCase)},
        )
        with self.assertRaises(dataclasses.FrozenInstanceError):
            make_disposition().kind = ReviewDispositionKind.NO_DECISION  # type: ignore[misc]


if __name__ == "__main__":
    unittest.main()
