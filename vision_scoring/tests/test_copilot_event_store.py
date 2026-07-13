from __future__ import annotations

import base64
import dataclasses
import hashlib
import sqlite3
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from tests.test_event_store import REDUCER_BUILD_SHA256, _Fixture
from tests.test_review_contracts import (
    POLICY_SHA,
    make_assessment,
    make_clip,
    make_hypothesis,
    make_reconciliation,
)
from vision_scoring.authorization import (
    AuthorizationOrigin,
    PrincipalRole,
    TrustedActorKey,
    TrustedAssessmentKey,
    TrustedKeyKind,
    sign_policy_assessment,
)
from vision_scoring.case_attestation import (
    encode_signed_scorer_copilot_case,
    sign_scorer_copilot_case,
)
from vision_scoring.domain_events import (
    PointAwardedPayload,
    ReplayNoPointPayload,
    RuleEventType,
    Team,
)
from vision_scoring.immutable_store import (
    GenerationDescriptor,
    bootstrap_generation_lock,
)
from vision_scoring.review_contracts import (
    ReviewAdjudication,
    ReviewClipRole,
    ReviewDisposition,
    ReviewDispositionKind,
    ReviewDispositionReason,
    ScorerCopilotCase,
    copilot_idempotency_key,
    encode_review_authorization_context,
    encode_review_clip_manifest,
    encode_signed_review_adjudication,
    encode_signed_review_disposition,
)
from vision_scoring.event_store import (
    EventStoreError,
    SQLiteEventStore,
    _ScoreRevisionContext,
)
from vision_scoring.hypotheses import RallyOutcome
from vision_scoring.policy import PolicyAssessmentStatus, PolicyReason
from vision_scoring.review_signing import (
    sign_review_adjudication,
    sign_review_disposition,
)


def _public_key_base64(private_key: Ed25519PrivateKey) -> str:
    raw = private_key.public_key().public_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PublicFormat.Raw,
    )
    return base64.b64encode(raw).decode("ascii")


class CopilotEventStoreTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.fixture = _Fixture(self.root)
        self.immutable_root = self.root / "immutable"
        (self.immutable_root / "locks").mkdir(parents=True)
        (self.immutable_root / "generations").mkdir()
        self.producer_private = Ed25519PrivateKey.generate()
        self.producer_key = TrustedAssessmentKey(
            assessor_id="case-producer-1",
            key_id="case-producer-key-1",
            public_key_base64=_public_key_base64(self.producer_private),
            valid_from_ns=1,
            valid_until_ns=1_000_000,
        )
        self.referee_private = Ed25519PrivateKey.generate()
        self.referee_key = TrustedActorKey(
            actor_id="referee-1",
            key_id="referee-key-1",
            role=PrincipalRole.REFEREE,
            public_key_base64=_public_key_base64(self.referee_private),
            valid_from_ns=1,
            valid_until_ns=1_000_000,
        )
        self.fixture.policy = dataclasses.replace(
            self.fixture.policy,
            accepted_assessment_policy_fingerprints=(POLICY_SHA,),
            actor_keys=self.fixture.policy.actor_keys + (self.referee_key,),
            assessment_keys=(self.producer_key,),
        )
        self.fixture.archive = self.fixture.archive_for(
            (self.fixture.policy,),
            current=self.fixture.policy,
        )

    def _publish(self, manifest_bytes: bytes, rendered: bytes) -> None:
        payloads = (manifest_bytes, rendered)
        digests = tuple(sorted(hashlib.sha256(item).hexdigest() for item in payloads))
        descriptor = GenerationDescriptor.build(digests)
        bootstrap_generation_lock(self.immutable_root, descriptor.generation_id)
        generation = self.immutable_root / "generations" / descriptor.generation_id
        objects = generation / "objects"
        objects.mkdir(parents=True)
        for payload in payloads:
            (objects / hashlib.sha256(payload).hexdigest()).write_bytes(payload)
        (generation / "descriptor.json").write_bytes(descriptor.canonical_bytes())

    def _signed_case(
        self,
        *,
        rally_id: str = "rally-case-1",
        hypothesis_id: str = "hypothesis-1",
        state_revision: int = 1,
        publish_clips: bool = True,
        with_signed_assessment: bool = False,
    ):
        hypothesis = dataclasses.replace(
            make_hypothesis(),
            hypothesis_id=hypothesis_id,
            match_id=self.fixture.match_id,
            rally_id=rally_id,
            state_revision=state_revision,
            ruleset_fingerprint=self.fixture.ruleset.fingerprint(),
        )
        reconciliation = make_reconciliation(hypothesis)
        assessment = make_assessment(hypothesis, reconciliation)
        signed_assessment = None
        if with_signed_assessment:
            assessment = dataclasses.replace(
                assessment,
                status=PolicyAssessmentStatus.HUMAN_AUTHORIZATION_REQUIRED,
                reasons=(PolicyReason.HUMAN_AUTHORIZATION_REQUIRED,),
            )
            signed_assessment = sign_policy_assessment(
                assessment=assessment,
                assessor_id=self.producer_key.assessor_id,
                assessment_key_id=self.producer_key.key_id,
                signed_at_ns=1_340,
                assessment_private_key=self.producer_private,
            )
        primary_bytes = b"primary-render" * 80
        next_bytes = b"next-server-render" * 70
        primary = make_clip(
            ReviewClipRole.PRIMARY,
            ("artifact:primary",),
            start_frame=1,
            end_frame=11,
            start_ns=900,
            end_ns=1_100,
            rendered_sha=hashlib.sha256(primary_bytes).hexdigest(),
        )
        primary = dataclasses.replace(
            primary,
            rendered_size_bytes=len(primary_bytes),
        )
        next_clip = make_clip(
            ReviewClipRole.NEXT_SERVER_RECONCILIATION,
            ("artifact:next-server",),
            start_frame=12,
            end_frame=22,
            start_ns=1_100,
            end_ns=1_300,
            rendered_sha=hashlib.sha256(next_bytes).hexdigest(),
        )
        next_clip = dataclasses.replace(
            next_clip,
            rendered_size_bytes=len(next_bytes),
        )
        if publish_clips:
            self._publish(
                encode_review_clip_manifest(primary.manifest),
                primary_bytes,
            )
            self._publish(
                encode_review_clip_manifest(next_clip.manifest),
                next_bytes,
            )
        case = ScorerCopilotCase(
            hypothesis=hypothesis,
            reconciliation=reconciliation,
            assessment=assessment,
            signed_assessment=signed_assessment,
            clips=(primary, next_clip),
            opened_at_ns=1_400,
        )
        return sign_scorer_copilot_case(
            case=case,
            policy_archive=self.fixture.archive,
            assessor_id=self.producer_key.assessor_id,
            assessment_key_id=self.producer_key.key_id,
            signed_at_ns=1_350,
            assessment_private_key=self.producer_private,
        )

    def _store(self) -> SQLiteEventStore:
        return SQLiteEventStore(
            self.fixture.path,
            ruleset=self.fixture.ruleset,
            reducer_build_sha256=REDUCER_BUILD_SHA256,
            immutable_store_root=self.immutable_root,
        )

    def _seed_and_admit(self, store: SQLiteEventStore, signed_case=None):
        signed_case = signed_case or self._signed_case()
        self.fixture.initialize(store)
        store.append_authorized_event(
            self.fixture.envelope(self.fixture.event(1)),
            policy_archive=self.fixture.archive,
            verified_at_ns=140,
        )
        admitted = store.admit_scorer_copilot_case(
            encode_signed_scorer_copilot_case(signed_case),
            policy_archive=self.fixture.archive,
            admitted_at_ns=1_500,
        )
        return signed_case, admitted

    def _signed_disposition(
        self,
        signed_case,
        *,
        kind: ReviewDispositionKind = ReviewDispositionKind.OBSERVED_OUTCOME,
        outcome: RallyOutcome | None = RallyOutcome.POINT_TEAM_B,
        reasons: tuple[ReviewDispositionReason, ...] = (),
        idempotency_key: str = "review-action-helper-1",
        expected_case_sequence: int = 0,
        previous_record_fingerprint: str | None = None,
        signed_at_ns: int = 1_525,
    ):
        disposition = ReviewDisposition(
            case_fingerprint=signed_case.case_fingerprint,
            signed_case_fingerprint=signed_case.fingerprint(),
            expected_case_sequence=expected_case_sequence,
            previous_record_fingerprint=(
                previous_record_fingerprint or signed_case.fingerprint()
            ),
            idempotency_key=idempotency_key,
            kind=kind,
            outcome=outcome,
            reasons=reasons,
        )
        return sign_review_disposition(
            disposition=disposition,
            signed_case=signed_case,
            policy_archive=self.fixture.archive,
            actor_id=self.fixture.scorekeeper_key.actor_id,
            actor_key_id=self.fixture.scorekeeper_key.key_id,
            actor_role=PrincipalRole.SCOREKEEPER,
            signed_at_ns=signed_at_ns,
            actor_private_key=self.fixture.scorekeeper_private,
        )

    def _event_for_context(
        self,
        context,
        *,
        event_id: str = "copilot-point-1",
        winner: Team = Team.B,
        created_at_ns: int = 1_600,
        rally_id: str | None = None,
        evidence_refs: tuple[str, ...] | None = None,
    ):
        event = self.fixture.event(
            2,
            event_id=event_id,
            winner=winner,
            created_at_ns=created_at_ns,
        )
        return dataclasses.replace(
            event,
            related_rally_id=rally_id or context.rally_id,
            payload=PointAwardedPayload(
                winner,
                context.evidence_refs if evidence_refs is None else evidence_refs,
            ),
        )

    def test_admit_case_and_exact_retry_preserve_prefix_receipt(self) -> None:
        signed_case = self._signed_case()
        raw = encode_signed_scorer_copilot_case(signed_case)
        with self._store() as store:
            self.fixture.initialize(store)
            store.append_authorized_event(
                self.fixture.envelope(self.fixture.event(1)),
                policy_archive=self.fixture.archive,
                verified_at_ns=140,
            )
            admitted = store.admit_scorer_copilot_case(
                raw,
                policy_archive=self.fixture.archive,
                admitted_at_ns=1_500,
            )
            self.assertEqual(admitted.context.signed_case_fingerprint, signed_case.fingerprint())
            self.assertEqual(admitted.context.journal_head_fingerprint, signed_case.fingerprint())
            self.assertEqual(admitted.review_position, 1)
            self.assertEqual(admitted.checkpoint.revision, 1)
            self.assertEqual(admitted.checkpoint.copilot_case_count, 1)
            derived = store.derive_scorer_copilot_context(
                signed_case.fingerprint(),
                policy_archive=self.fixture.archive,
                verified_at_ns=1_550,
            )
            self.assertEqual(derived, admitted.context)
            retried = store.admit_scorer_copilot_case(
                raw,
                policy_archive=self.fixture.archive,
                admitted_at_ns=1_600,
            )
            self.assertEqual(retried, admitted)
            audited = store.audit_replay(
                self.fixture.match_id,
                policy_archive=self.fixture.archive,
                verified_at_ns=1_700,
            )
            self.assertEqual(audited.checkpoint.review_position, 1)

    def test_case_admission_between_completed_and_next_seeded_set_fails_closed(
        self,
    ) -> None:
        signed_case = self._signed_case(
            rally_id="rally-between-sets",
            hypothesis_id="hypothesis-between-sets",
            state_revision=22,
        )
        with self._store() as store:
            self.fixture.initialize(store)
            for revision in range(1, 23):
                event = self.fixture.event(revision, winner=Team.A)
                store.append_authorized_event(
                    self.fixture.envelope(event),
                    policy_archive=self.fixture.archive,
                    verified_at_ns=event.created_at_ns + 10,
                )
            with self.assertRaises(EventStoreError) as caught:
                store.admit_scorer_copilot_case(
                    encode_signed_scorer_copilot_case(signed_case),
                    policy_archive=self.fixture.archive,
                    admitted_at_ns=1_500,
                )
            self.assertEqual(
                caught.exception.code,
                "CASE_SET_NOT_IN_PROGRESS",
            )

    def test_append_disposition_and_exact_retry_preserve_prefix_receipt(self) -> None:
        signed_case = self._signed_case()
        with self._store() as store:
            self.fixture.initialize(store)
            store.append_authorized_event(
                self.fixture.envelope(self.fixture.event(1)),
                policy_archive=self.fixture.archive,
                verified_at_ns=140,
            )
            admitted = store.admit_scorer_copilot_case(
                encode_signed_scorer_copilot_case(signed_case),
                policy_archive=self.fixture.archive,
                admitted_at_ns=1_500,
            )
            disposition = ReviewDisposition(
                case_fingerprint=signed_case.case_fingerprint,
                signed_case_fingerprint=signed_case.fingerprint(),
                expected_case_sequence=0,
                previous_record_fingerprint=signed_case.fingerprint(),
                idempotency_key="review-action-case-1",
                kind=ReviewDispositionKind.OBSERVED_OUTCOME,
                outcome=RallyOutcome.POINT_TEAM_B,
                reasons=(),
            )
            signed = sign_review_disposition(
                disposition=disposition,
                signed_case=signed_case,
                policy_archive=self.fixture.archive,
                actor_id=self.fixture.scorekeeper_key.actor_id,
                actor_key_id=self.fixture.scorekeeper_key.key_id,
                actor_role=PrincipalRole.SCOREKEEPER,
                signed_at_ns=1_525,
                actor_private_key=self.fixture.scorekeeper_private,
            )
            raw = encode_signed_review_disposition(signed)
            appended = store.append_review_disposition(
                raw,
                policy_archive=self.fixture.archive,
                accepted_at_ns=1_550,
            )
            self.assertEqual(appended.case_sequence, 1)
            self.assertEqual(appended.signed_record_fingerprint, signed.fingerprint())
            self.assertEqual(appended.review_position, 2)
            self.assertEqual(appended.checkpoint.copilot_action_count, 1)
            self.assertEqual(
                store.derive_scorer_copilot_context(
                    signed_case.fingerprint(),
                    policy_archive=self.fixture.archive,
                    verified_at_ns=1_575,
                ),
                appended.context,
            )
            retried = store.append_review_disposition(
                raw,
                policy_archive=self.fixture.archive,
                accepted_at_ns=1_600,
            )
            self.assertEqual(retried, appended)
            self.assertEqual(admitted.checkpoint.revision, appended.checkpoint.revision)

    def test_adjudication_head_authorizes_exact_observed_outcome(self) -> None:
        with self._store() as store:
            signed_case, _ = self._seed_and_admit(store)
            signed_disposition = self._signed_disposition(signed_case)
            disposition_result = store.append_review_disposition(
                encode_signed_review_disposition(signed_disposition),
                policy_archive=self.fixture.archive,
                accepted_at_ns=1_550,
            )
            adjudication = ReviewAdjudication(
                case_fingerprint=signed_case.case_fingerprint,
                signed_case_fingerprint=signed_case.fingerprint(),
                expected_case_sequence=1,
                previous_record_fingerprint=signed_disposition.fingerprint(),
                idempotency_key="review-adjudication-helper-1",
                considered_signed_disposition_fingerprints=(
                    signed_disposition.fingerprint(),
                ),
                kind=ReviewDispositionKind.OBSERVED_OUTCOME,
                outcome=RallyOutcome.POINT_TEAM_B,
                reasons=(),
            )
            signed_adjudication = sign_review_adjudication(
                adjudication=adjudication,
                considered_signed_dispositions=(signed_disposition,),
                signed_case=signed_case,
                policy_archive=self.fixture.archive,
                actor_id=self.referee_key.actor_id,
                actor_key_id=self.referee_key.key_id,
                actor_role=PrincipalRole.REFEREE,
                signed_at_ns=1_575,
                actor_private_key=self.referee_private,
            )
            adjudicated = store.append_review_adjudication(
                encode_signed_review_adjudication(signed_adjudication),
                policy_archive=self.fixture.archive,
                accepted_at_ns=1_590,
            )
            self.assertEqual(adjudicated.case_sequence, 2)
            self.assertEqual(adjudicated.review_position, 3)
            self.assertEqual(
                disposition_result.context.case_fingerprint,
                adjudicated.context.case_fingerprint,
            )
            event = self._event_for_context(adjudicated.context)
            envelope = self.fixture.envelope(
                event,
                idempotency_key=copilot_idempotency_key(adjudicated.context),
            )
            appended = store.append_copilot_authorized_event(
                envelope,
                encode_review_authorization_context(adjudicated.context),
                policy_archive=self.fixture.archive,
                verified_at_ns=1_640,
            )
            self.assertEqual(appended.append.revision, 2)
            self.assertEqual(appended.context.case_sequence, 2)
            self.assertEqual(appended.append.checkpoint.copilot_action_count, 2)

    def test_observed_replay_no_point_head_links_exact_replay_event(self) -> None:
        with self._store() as store:
            signed_case, _ = self._seed_and_admit(store)
            signed_disposition = self._signed_disposition(
                signed_case,
                outcome=RallyOutcome.REPLAY_NO_POINT,
                idempotency_key="review-replay-no-point-1",
            )
            disposition_result = store.append_review_disposition(
                encode_signed_review_disposition(signed_disposition),
                policy_archive=self.fixture.archive,
                accepted_at_ns=1_550,
            )
            context = disposition_result.context
            point_template = self.fixture.event(
                2,
                event_id="copilot-replay-no-point",
                created_at_ns=1_600,
            )
            event = dataclasses.replace(
                point_template,
                event_type=RuleEventType.REPLAY_NO_POINT,
                related_rally_id=context.rally_id,
                payload=ReplayNoPointPayload(
                    "review-confirmed-replay",
                    context.evidence_refs,
                ),
            )
            envelope = self.fixture.envelope(
                event,
                idempotency_key=copilot_idempotency_key(context),
            )
            appended = store.append_copilot_authorized_event(
                envelope,
                encode_review_authorization_context(context),
                policy_archive=self.fixture.archive,
                verified_at_ns=1_640,
            )
            self.assertEqual(appended.append.revision, 2)
            self.assertEqual(appended.link.event_fingerprint, event.fingerprint())
            audited = store.audit_replay(
                self.fixture.match_id,
                policy_archive=self.fixture.archive,
                verified_at_ns=1_650,
            )
            self.assertEqual(audited.event_count, 2)

    def test_non_outcome_review_heads_cannot_authorize_score_events(self) -> None:
        cases = (
            self._signed_case(
                rally_id="rally-no-decision",
                hypothesis_id="hypothesis-no-decision",
            ),
            self._signed_case(
                rally_id="rally-case-invalid",
                hypothesis_id="hypothesis-case-invalid",
                publish_clips=False,
            ),
            self._signed_case(
                rally_id="rally-escalate",
                hypothesis_id="hypothesis-escalate",
                publish_clips=False,
            ),
        )
        specifications = (
            (
                ReviewDispositionKind.NO_DECISION,
                (ReviewDispositionReason.INSUFFICIENT_EVIDENCE,),
            ),
            (
                ReviewDispositionKind.CASE_INVALID,
                (ReviewDispositionReason.CAPTURE_UNUSABLE,),
            ),
            (
                ReviewDispositionKind.ESCALATE,
                (ReviewDispositionReason.RULES_CONTEXT_CONFLICT,),
            ),
        )
        with self._store() as store:
            self.fixture.initialize(store)
            store.append_authorized_event(
                self.fixture.envelope(self.fixture.event(1)),
                policy_archive=self.fixture.archive,
                verified_at_ns=140,
            )
            for offset, signed_case in enumerate(cases):
                store.admit_scorer_copilot_case(
                    encode_signed_scorer_copilot_case(signed_case),
                    policy_archive=self.fixture.archive,
                    admitted_at_ns=1_500 + offset * 10,
                )
            contexts = []
            for offset, (signed_case, specification) in enumerate(
                zip(cases, specifications)
            ):
                kind, reasons = specification
                signed = self._signed_disposition(
                    signed_case,
                    kind=kind,
                    outcome=None,
                    reasons=reasons,
                    idempotency_key=f"forbidden-review-head-{offset}",
                    signed_at_ns=1_530 + offset * 10,
                )
                result = store.append_review_disposition(
                    encode_signed_review_disposition(signed),
                    policy_archive=self.fixture.archive,
                    accepted_at_ns=1_540 + offset * 10,
                )
                contexts.append(result.context)
            for offset, context in enumerate(contexts):
                event = self._event_for_context(
                    context,
                    event_id=f"forbidden-review-event-{offset}",
                )
                envelope = self.fixture.envelope(
                    event,
                    idempotency_key=copilot_idempotency_key(context),
                )
                with self.assertRaises(EventStoreError) as caught:
                    store.append_copilot_authorized_event(
                        envelope,
                        encode_review_authorization_context(context),
                        policy_archive=self.fixture.archive,
                        verified_at_ns=1_640,
                    )
                self.assertEqual(
                    caught.exception.code,
                    "COPILOT_REVIEW_NO_OUTCOME",
                )
            audited = store.audit_replay(
                self.fixture.match_id,
                policy_archive=self.fixture.archive,
                verified_at_ns=1_650,
            )
            self.assertEqual(audited.event_count, 1)
            self.assertEqual(audited.checkpoint.copilot_link_count, 0)

    def test_copilot_link_rejects_stale_context_outcome_evidence_and_rally_mismatch(
        self,
    ) -> None:
        with self._store() as store:
            signed_case, admitted = self._seed_and_admit(store)
            signed_disposition = self._signed_disposition(signed_case)
            reviewed = store.append_review_disposition(
                encode_signed_review_disposition(signed_disposition),
                policy_archive=self.fixture.archive,
                accepted_at_ns=1_550,
            )

            stale_event = self._event_for_context(
                admitted.context,
                event_id="stale-context-event",
            )
            stale_envelope = self.fixture.envelope(
                stale_event,
                idempotency_key=copilot_idempotency_key(admitted.context),
            )
            with self.assertRaises(EventStoreError) as stale:
                store.append_copilot_authorized_event(
                    stale_envelope,
                    encode_review_authorization_context(admitted.context),
                    policy_archive=self.fixture.archive,
                    verified_at_ns=1_640,
                )
            self.assertEqual(stale.exception.code, "STALE_REVIEW_CONTEXT")

            attempts = (
                (
                    "outcome-mismatch-event",
                    self._event_for_context(
                        reviewed.context,
                        event_id="outcome-mismatch-event",
                        winner=Team.A,
                    ),
                    "COPILOT_REVIEW_OUTCOME_MISMATCH",
                ),
                (
                    "evidence-mismatch-event",
                    self._event_for_context(
                        reviewed.context,
                        event_id="evidence-mismatch-event",
                        evidence_refs=("artifact:wrong-evidence",),
                    ),
                    "COPILOT_EVENT_EVIDENCE",
                ),
                (
                    "rally-mismatch-event",
                    self._event_for_context(
                        reviewed.context,
                        event_id="rally-mismatch-event",
                        rally_id="rally-wrong",
                    ),
                    "COPILOT_EVENT_CONTEXT",
                ),
            )
            for _, event, expected_code in attempts:
                envelope = self.fixture.envelope(
                    event,
                    idempotency_key=copilot_idempotency_key(reviewed.context),
                )
                with self.assertRaises(EventStoreError) as caught:
                    store.append_copilot_authorized_event(
                        envelope,
                        encode_review_authorization_context(reviewed.context),
                        policy_archive=self.fixture.archive,
                        verified_at_ns=1_640,
                    )
                self.assertEqual(caught.exception.code, expected_code)
            audited = store.audit_replay(
                self.fixture.match_id,
                policy_archive=self.fixture.archive,
                verified_at_ns=1_650,
            )
            self.assertEqual(audited.event_count, 1)
            self.assertEqual(audited.checkpoint.copilot_link_count, 0)

    def test_atomic_copilot_fault_rolls_back_event_link_history_and_projections(
        self,
    ) -> None:
        with self._store() as store:
            _, admitted = self._seed_and_admit(store)
            event = self._event_for_context(
                admitted.context,
                event_id="faulted-copilot-event",
                created_at_ns=1_520,
            )
            envelope = self.fixture.envelope(
                event,
                idempotency_key=copilot_idempotency_key(admitted.context),
            )
            store._test_fault_mode = "RAISE_BEFORE_POST_REPLAY"  # type: ignore[attr-defined]
            with self.assertRaises(EventStoreError) as caught:
                store.append_copilot_authorized_event(
                    envelope,
                    encode_review_authorization_context(admitted.context),
                    policy_archive=self.fixture.archive,
                    verified_at_ns=1_550,
                )
            self.assertEqual(caught.exception.code, "TEST_FAULT_INJECTED")
            expected_counts = {
                "event_log": 1,
                "authorization_log": 1,
                "state_history": 1,
                "shadow_outbox": 1,
                "idempotency_log": 1,
                "request_identities": 2,
                "copilot_cases": 1,
                "copilot_journal": 0,
                "copilot_authorization_links": 0,
                "copilot_history": 1,
            }
            for table_name, expected_count in expected_counts.items():
                actual_count = store._connection.execute(  # type: ignore[attr-defined]
                    f"SELECT COUNT(*) FROM {table_name}"
                ).fetchone()[0]
                self.assertEqual(actual_count, expected_count, table_name)
            projection = store._connection.execute(  # type: ignore[attr-defined]
                """
                SELECT current_case_sequence, linked_event_id,
                       authorization_link_fingerprint
                FROM copilot_cases WHERE case_fingerprint = ?
                """,
                (admitted.case_fingerprint,),
            ).fetchone()
            self.assertEqual(tuple(projection), (0, None, None))
            audited = store.audit_replay(
                self.fixture.match_id,
                policy_archive=self.fixture.archive,
                verified_at_ns=1_560,
            )
            self.assertEqual(audited.event_count, 1)
            self.assertEqual(audited.checkpoint.review_position, 1)
            committed = store.append_copilot_authorized_event(
                envelope,
                encode_review_authorization_context(admitted.context),
                policy_archive=self.fixture.archive,
                verified_at_ns=1_570,
            )
            self.assertEqual(committed.append.revision, 2)

    def test_concurrent_double_link_has_exactly_one_atomic_winner(self) -> None:
        with self._store() as store:
            _, admitted = self._seed_and_admit(store)
        context_bytes = encode_review_authorization_context(admitted.context)
        envelopes = {
            label: self.fixture.envelope(
                self._event_for_context(
                    admitted.context,
                    event_id=f"concurrent-copilot-{label}",
                    created_at_ns=1_520,
                ),
                idempotency_key=copilot_idempotency_key(admitted.context),
            )
            for label in ("a", "b")
        }
        barrier = threading.Barrier(2)
        outcomes: list[tuple[str, str]] = []
        outcome_lock = threading.Lock()

        def worker(label: str) -> None:
            try:
                with self._store() as local_store:
                    barrier.wait(timeout=5)
                    local_store.append_copilot_authorized_event(
                        envelopes[label],
                        context_bytes,
                        policy_archive=self.fixture.archive,
                        verified_at_ns=1_550,
                    )
                outcome = (label, "committed")
            except (EventStoreError, sqlite3.Error) as exc:
                outcome = (label, getattr(exc, "code", type(exc).__name__))
            with outcome_lock:
                outcomes.append(outcome)

        threads = tuple(
            threading.Thread(target=worker, args=(label,)) for label in envelopes
        )
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=10)
        self.assertFalse(any(thread.is_alive() for thread in threads))
        self.assertEqual(
            sum(result == "committed" for _, result in outcomes),
            1,
        )
        losing_label, losing_result = next(
            (label, result)
            for label, result in outcomes
            if result != "committed"
        )
        self.assertEqual(losing_result, "IDEMPOTENCY_CONFLICT")
        with self._store() as store:
            with self.assertRaises(EventStoreError) as double_link:
                store.append_copilot_authorized_event(
                    envelopes[losing_label],
                    context_bytes,
                    policy_archive=self.fixture.archive,
                    verified_at_ns=1_560,
                )
            self.assertEqual(double_link.exception.code, "IDEMPOTENCY_CONFLICT")
            audited = store.audit_replay(
                self.fixture.match_id,
                policy_archive=self.fixture.archive,
                verified_at_ns=1_570,
            )
            self.assertEqual(audited.event_count, 2)
            self.assertEqual(audited.checkpoint.copilot_link_count, 1)
            self.assertEqual(audited.checkpoint.review_position, 2)

    def test_high_event_replay_retains_only_review_needed_score_contexts(self) -> None:
        with self._store() as store:
            signed_case, _ = self._seed_and_admit(store)
            for revision in range(2, 34):
                created_at_ns = 1_500 + revision * 20
                template = self.fixture.event(
                    revision,
                    event_id=f"resource-replay-{revision}",
                    created_at_ns=created_at_ns,
                )
                event = dataclasses.replace(
                    template,
                    event_type=RuleEventType.REPLAY_NO_POINT,
                    payload=ReplayNoPointPayload(
                        "resource-regression-replay",
                        template.payload.evidence_refs,
                    ),
                )
                store.append_authorized_event(
                    self.fixture.envelope(event),
                    policy_archive=self.fixture.archive,
                    verified_at_ns=created_at_ns + 10,
                )

            captured: list[dict[str, object]] = []
            original = SQLiteEventStore._validate_review_score_order_locked

            def probe(instance, **kwargs):
                captured.append(kwargs)
                return original(instance, **kwargs)

            with mock.patch.object(
                SQLiteEventStore,
                "_validate_review_score_order_locked",
                autospec=True,
                side_effect=probe,
            ):
                audited = store.audit_replay(
                    self.fixture.match_id,
                    policy_archive=self.fixture.archive,
                    verified_at_ns=2_200,
                )
            self.assertEqual(audited.event_count, 33)
            self.assertEqual(len(captured), 1)
            replay_facts = captured[0]
            self.assertEqual(replay_facts["event_count"], 33)
            self.assertEqual(
                set(replay_facts["revision_contexts"]),
                {signed_case.case.state_revision},
            )
            self.assertEqual(replay_facts["rally_resolution_revisions"], {})
            review = replay_facts["review"]
            self.assertFalse(hasattr(review.cases[0], "signed_case"))

    def test_replay_rejects_case_journal_link_and_projection_tamper(self) -> None:
        with self._store() as store:
            signed_case, _ = self._seed_and_admit(store)
            signed_disposition = self._signed_disposition(signed_case)
            reviewed = store.append_review_disposition(
                encode_signed_review_disposition(signed_disposition),
                policy_archive=self.fixture.archive,
                accepted_at_ns=1_550,
            )
            event = self._event_for_context(reviewed.context)
            store.append_copilot_authorized_event(
                self.fixture.envelope(
                    event,
                    idempotency_key=copilot_idempotency_key(reviewed.context),
                ),
                encode_review_authorization_context(reviewed.context),
                policy_archive=self.fixture.archive,
                verified_at_ns=1_640,
            )

            def assert_private_replay_error(expected_code: str) -> None:
                with store._transaction(immediate=False):  # type: ignore[attr-defined]
                    with self.assertRaises(EventStoreError) as caught:
                        store._replay_locked(  # type: ignore[attr-defined]
                            match_id=self.fixture.match_id,
                            policy_archive=self.fixture.archive,
                            verified_at_ns=1_650,
                        )
                self.assertEqual(caught.exception.code, expected_code)

            connection = store._connection  # type: ignore[attr-defined]
            connection.execute(
                "UPDATE copilot_cases SET state_revision = 2 WHERE case_fingerprint = ?",
                (signed_case.case_fingerprint,),
            )
            assert_private_replay_error("COPILOT_CASE_TAMPER")
            connection.execute(
                "UPDATE copilot_cases SET state_revision = 1 WHERE case_fingerprint = ?",
                (signed_case.case_fingerprint,),
            )

            original_unsigned_fingerprint = connection.execute(
                """
                SELECT unsigned_record_fingerprint FROM copilot_journal
                WHERE case_fingerprint = ?
                """,
                (signed_case.case_fingerprint,),
            ).fetchone()[0]
            connection.execute(
                """
                UPDATE copilot_journal SET unsigned_record_fingerprint = ?
                WHERE case_fingerprint = ?
                """,
                ("f" * 64, signed_case.case_fingerprint),
            )
            assert_private_replay_error("REVIEW_JOURNAL_TAMPER")
            connection.execute(
                """
                UPDATE copilot_journal SET unsigned_record_fingerprint = ?
                WHERE case_fingerprint = ?
                """,
                (original_unsigned_fingerprint, signed_case.case_fingerprint),
            )

            original_link_fingerprint = connection.execute(
                """
                SELECT link_fingerprint FROM copilot_authorization_links
                WHERE case_fingerprint = ?
                """,
                (signed_case.case_fingerprint,),
            ).fetchone()[0]
            connection.execute(
                """
                UPDATE copilot_authorization_links SET link_fingerprint = ?
                WHERE case_fingerprint = ?
                """,
                ("e" * 64, signed_case.case_fingerprint),
            )
            connection.execute(
                """
                UPDATE copilot_cases SET authorization_link_fingerprint = ?
                WHERE case_fingerprint = ?
                """,
                ("e" * 64, signed_case.case_fingerprint),
            )
            assert_private_replay_error("COPILOT_LINK_TAMPER")
            connection.execute(
                """
                UPDATE copilot_authorization_links SET link_fingerprint = ?
                WHERE case_fingerprint = ?
                """,
                (original_link_fingerprint, signed_case.case_fingerprint),
            )
            connection.execute(
                """
                UPDATE copilot_cases SET authorization_link_fingerprint = ?
                WHERE case_fingerprint = ?
                """,
                (original_link_fingerprint, signed_case.case_fingerprint),
            )

            connection.execute(
                """
                UPDATE copilot_cases SET current_case_sequence = 0
                WHERE case_fingerprint = ?
                """,
                (signed_case.case_fingerprint,),
            )
            assert_private_replay_error("COPILOT_CASE_PROJECTION")
            connection.execute(
                """
                UPDATE copilot_cases SET current_case_sequence = 1
                WHERE case_fingerprint = ?
                """,
                (signed_case.case_fingerprint,),
            )
            audited = store.audit_replay(
                self.fixture.match_id,
                policy_archive=self.fixture.archive,
                verified_at_ns=1_660,
            )
            self.assertEqual(audited.event_count, 2)

    def test_runtime_case_count_bound_fails_before_admission_write(self) -> None:
        signed_case = self._signed_case()
        raw = encode_signed_scorer_copilot_case(signed_case)
        with self._store() as store:
            self.fixture.initialize(store)
            store.append_authorized_event(
                self.fixture.envelope(self.fixture.event(1)),
                policy_archive=self.fixture.archive,
                verified_at_ns=140,
            )
            with mock.patch(
                "vision_scoring.event_store.MAX_COPILOT_CASES_PER_MATCH",
                0,
            ):
                with self.assertRaises(EventStoreError) as caught:
                    store.admit_scorer_copilot_case(
                        raw,
                        policy_archive=self.fixture.archive,
                        admitted_at_ns=1_500,
                    )
            self.assertEqual(caught.exception.code, "COPILOT_CASE_LIMIT")
            self.assertEqual(
                store._connection.execute(  # type: ignore[attr-defined]
                    "SELECT COUNT(*) FROM copilot_cases"
                ).fetchone()[0],
                0,
            )

    def test_atomic_sequence_zero_human_event_links_case_and_outbox(self) -> None:
        signed_case = self._signed_case()
        with self._store() as store:
            self.fixture.initialize(store)
            store.append_authorized_event(
                self.fixture.envelope(self.fixture.event(1)),
                policy_archive=self.fixture.archive,
                verified_at_ns=140,
            )
            admitted = store.admit_scorer_copilot_case(
                encode_signed_scorer_copilot_case(signed_case),
                policy_archive=self.fixture.archive,
                admitted_at_ns=1_500,
            )
            point = dataclasses.replace(
                self.fixture.event(
                    2,
                    winner=Team.B,
                    created_at_ns=1_520,
                ),
                related_rally_id=admitted.context.rally_id,
                payload=PointAwardedPayload(
                    Team.B,
                    admitted.context.evidence_refs,
                ),
            )
            envelope = self.fixture.envelope(
                point,
                idempotency_key=copilot_idempotency_key(admitted.context),
            )
            context_bytes = encode_review_authorization_context(admitted.context)
            appended = store.append_copilot_authorized_event(
                envelope,
                context_bytes,
                policy_archive=self.fixture.archive,
                verified_at_ns=1_550,
            )
            self.assertEqual(appended.append.revision, 2)
            self.assertEqual(appended.link.event_id, point.event_id)
            self.assertEqual(appended.link.outbox_id, appended.append.outbox_id)
            self.assertEqual(appended.append.checkpoint.copilot_link_count, 1)
            self.assertEqual(appended.append.checkpoint.review_position, 2)
            retried = store.append_copilot_authorized_event(
                envelope,
                context_bytes,
                policy_archive=self.fixture.archive,
                verified_at_ns=1_575,
            )
            self.assertEqual(retried, appended)
            audited = store.audit_replay(
                self.fixture.match_id,
                policy_archive=self.fixture.archive,
                verified_at_ns=1_600,
            )
            self.assertEqual(audited.event_count, 2)
            self.assertEqual(audited.checkpoint.copilot_link_count, 1)

    def test_atomic_sequence_zero_assessment_assisted_event_requires_exact_case_attestation(
        self,
    ) -> None:
        signed_case = self._signed_case(with_signed_assessment=True)
        with self._store() as store:
            _, admitted = self._seed_and_admit(store, signed_case)
            event = self._event_for_context(
                admitted.context,
                event_id="assisted-copilot-point",
                created_at_ns=1_520,
            )
            independently_signed = self.fixture.envelope(
                event,
                idempotency_key=copilot_idempotency_key(admitted.context),
                origin=AuthorizationOrigin.ASSESSMENT_ASSISTED,
                assessment_value=signed_case.case.assessment,
                assessment_key=self.producer_key,
                assessment_private_key=self.producer_private,
            )
            with self.assertRaises(EventStoreError) as mismatched:
                store.append_copilot_authorized_event(
                    independently_signed,
                    encode_review_authorization_context(admitted.context),
                    policy_archive=self.fixture.archive,
                    verified_at_ns=1_550,
                )
            self.assertEqual(
                mismatched.exception.code,
                "COPILOT_ASSESSMENT_MISMATCH",
            )
            envelope = self.fixture.envelope(
                event,
                idempotency_key=copilot_idempotency_key(admitted.context),
                origin=AuthorizationOrigin.ASSESSMENT_ASSISTED,
                assessment_value=signed_case.case.assessment,
                signed_assessment_value=signed_case.case.signed_assessment,
            )
            appended = store.append_copilot_authorized_event(
                envelope,
                encode_review_authorization_context(admitted.context),
                policy_archive=self.fixture.archive,
                verified_at_ns=1_550,
            )
            self.assertEqual(appended.append.revision, 2)
            self.assertEqual(appended.context.case_sequence, 0)
            audited = store.audit_replay(
                self.fixture.match_id,
                policy_archive=self.fixture.archive,
                verified_at_ns=1_560,
            )
            self.assertEqual(audited.event_count, 2)

    def test_exact_admission_retry_is_receipt_but_derive_requires_resident_clips(self) -> None:
        signed_case = self._signed_case()
        raw = encode_signed_scorer_copilot_case(signed_case)
        with self._store() as store:
            self.fixture.initialize(store)
            store.append_authorized_event(
                self.fixture.envelope(self.fixture.event(1)),
                policy_archive=self.fixture.archive,
                verified_at_ns=140,
            )
            admitted = store.admit_scorer_copilot_case(
                raw,
                policy_archive=self.fixture.archive,
                admitted_at_ns=1_500,
            )
            clip = signed_case.case.clips[0]
            missing = (
                self.immutable_root
                / "generations"
                / clip.immutable_generation_id
                / "objects"
                / clip.manifest.rendered_clip_sha256
            )
            missing.unlink()
            retried = store.admit_scorer_copilot_case(
                raw,
                policy_archive=self.fixture.archive,
                admitted_at_ns=1_550,
            )
            self.assertEqual(retried, admitted)
            with self.assertRaises(EventStoreError) as caught:
                store.derive_scorer_copilot_context(
                    signed_case.fingerprint(),
                    policy_archive=self.fixture.archive,
                    verified_at_ns=1_600,
                )
            self.assertTrue(caught.exception.code.startswith("COPILOT_CLIP_"))

    def test_event_replay_rejects_review_prefix_rollback(self) -> None:
        signed_case = self._signed_case()
        with self._store() as store:
            self.fixture.initialize(store)
            store.append_authorized_event(
                self.fixture.envelope(self.fixture.event(1)),
                policy_archive=self.fixture.archive,
                verified_at_ns=140,
            )
            store.admit_scorer_copilot_case(
                encode_signed_scorer_copilot_case(signed_case),
                policy_archive=self.fixture.archive,
                admitted_at_ns=1_500,
            )
            for revision, created_at_ns, verified_at_ns in (
                (2, 1_520, 1_550),
                (3, 1_560, 1_590),
            ):
                event = self.fixture.event(
                    revision,
                    created_at_ns=created_at_ns,
                )
                store.append_authorized_event(
                    self.fixture.envelope(event),
                    policy_archive=self.fixture.archive,
                    verified_at_ns=verified_at_ns,
                )
            store._connection.execute(  # type: ignore[attr-defined]
                "UPDATE event_log SET review_position_at_append = 0 "
                "WHERE match_id = ? AND revision = 3",
                (self.fixture.match_id,),
            )
            with self.assertRaises(EventStoreError) as caught:
                store.audit_replay(
                    self.fixture.match_id,
                    policy_archive=self.fixture.archive,
                    verified_at_ns=1_600,
                )
            self.assertEqual(caught.exception.code, "EVENT_REVIEW_PREFIX_ROLLBACK")

    def test_historical_review_score_and_case_sequence_order_are_position_based(self) -> None:
        signed_case = self._signed_case()
        with self._store() as store:
            self.fixture.initialize(store)
            seed = self.fixture.event(1)
            store.append_authorized_event(
                self.fixture.envelope(seed),
                policy_archive=self.fixture.archive,
                verified_at_ns=140,
            )
            store.admit_scorer_copilot_case(
                encode_signed_scorer_copilot_case(signed_case),
                policy_archive=self.fixture.archive,
                admitted_at_ns=1_500,
            )
            disposition = ReviewDisposition(
                case_fingerprint=signed_case.case_fingerprint,
                signed_case_fingerprint=signed_case.fingerprint(),
                expected_case_sequence=0,
                previous_record_fingerprint=signed_case.fingerprint(),
                idempotency_key="review-position-proof-1",
                kind=ReviewDispositionKind.OBSERVED_OUTCOME,
                outcome=RallyOutcome.POINT_TEAM_B,
                reasons=(),
            )
            signed = sign_review_disposition(
                disposition=disposition,
                signed_case=signed_case,
                policy_archive=self.fixture.archive,
                actor_id=self.fixture.scorekeeper_key.actor_id,
                actor_key_id=self.fixture.scorekeeper_key.key_id,
                actor_role=PrincipalRole.SCOREKEEPER,
                signed_at_ns=1_525,
                actor_private_key=self.fixture.scorekeeper_private,
            )
            store.append_review_disposition(
                encode_signed_review_disposition(signed),
                policy_archive=self.fixture.archive,
                accepted_at_ns=1_550,
            )
            with store._transaction(immediate=False):  # type: ignore[attr-defined]
                replay = store._replay_locked(  # type: ignore[attr-defined]
                    match_id=self.fixture.match_id,
                    policy_archive=self.fixture.archive,
                    verified_at_ns=1_560,
                )
                self.assertIsNotNone(replay.review)
                review = replay.review
                initial = store.reducer.new_match(self.fixture.match_id)
                seeded = store.reducer.reduce(initial, seed).after
                later = store.reducer.reduce(
                    seeded,
                    self.fixture.event(2, created_at_ns=1_490),
                ).after
                with self.assertRaises(EventStoreError) as stale:
                    store._validate_review_score_order_locked(  # type: ignore[attr-defined]
                        review=review,
                        event_review_positions=[0, 0],
                        event_appended_times=[140, 1_490],
                        revision_contexts={
                            1: _ScoreRevisionContext(1, True, False),
                        },
                        rally_resolution_revisions={},
                        event_count=2,
                    )
                self.assertEqual(
                    stale.exception.code,
                    "HISTORICAL_STALE_CASE_REVISION",
                )

                case_entry, action_entry = review.history_entries
                reversed_review = dataclasses.replace(
                    review,
                    cases=(
                        dataclasses.replace(
                            review.cases[0],
                            admission_review_position=2,
                        ),
                    ),
                    history_entries=(
                        dataclasses.replace(
                            case_entry,
                            position=2,
                            committed_at_ns=1_550,
                        ),
                        dataclasses.replace(
                            action_entry,
                            position=1,
                            committed_at_ns=1_550,
                        ),
                    ),
                )
                with self.assertRaises(EventStoreError) as reversed_sequence:
                    store._validate_review_score_order_locked(  # type: ignore[attr-defined]
                        review=reversed_review,
                        event_review_positions=[0],
                        event_appended_times=[140],
                        revision_contexts={
                            1: _ScoreRevisionContext(1, True, False),
                        },
                        rally_resolution_revisions={},
                        event_count=1,
                    )
                self.assertEqual(
                    reversed_sequence.exception.code,
                    "REVIEW_ACTION_POSITION",
                )

    def test_case_admission_text_projection_counts_every_v3_row_copy(self) -> None:
        signed_case = self._signed_case()
        raw = encode_signed_scorer_copilot_case(signed_case)
        with self._store() as store:
            self.fixture.initialize(store)
            store.append_authorized_event(
                self.fixture.envelope(self.fixture.event(1)),
                policy_archive=self.fixture.archive,
                verified_at_ns=140,
            )
            with store._transaction(immediate=False):  # type: ignore[attr-defined]
                replay = store._replay_locked(  # type: ignore[attr-defined]
                    match_id=self.fixture.match_id,
                    policy_archive=self.fixture.archive,
                    verified_at_ns=1_490,
                )
            self.assertIsNotNone(replay.review)
            review = replay.review
            assert review is not None
            case = signed_case.case
            signed_fingerprint = signed_case.fingerprint()
            review_position = review.preflight.history_count + 1
            previous_head = review.review_history_head_sha256
            review_head = store._review_history_head(  # type: ignore[attr-defined]
                previous_head,
                review_position=review_position,
                entry_kind="CASE",
                case_fingerprint=signed_case.case_fingerprint,
                entry_fingerprint=signed_fingerprint,
                committed_at_ns=1_500,
            )
            admission_key = store._case_admission_idempotency_key(  # type: ignore[attr-defined]
                signed_fingerprint
            )
            request_fingerprint = store._case_admission_request_fingerprint(  # type: ignore[attr-defined]
                signed_fingerprint
            )
            context = store._context_for_signed_case(  # type: ignore[attr-defined]
                signed_case,
                case_sequence=0,
                journal_head_fingerprint=signed_fingerprint,
            )
            result_fingerprint = store._case_admission_result_fingerprint(  # type: ignore[attr-defined]
                signed_case_fingerprint=signed_fingerprint,
                context_fingerprint=context.fingerprint(),
                review_position=review_position,
                review_history_head_sha256=review_head,
            )
            exact_increment = sum(
                len(value)
                for value in (
                    # copilot_cases row
                    signed_case.case_fingerprint,
                    case.match_id,
                    signed_fingerprint,
                    admission_key,
                    case.rally_id,
                    case.ruleset_fingerprint,
                    signed_fingerprint,
                    review_head,
                    # copilot_history row
                    case.match_id,
                    "CASE",
                    signed_case.case_fingerprint,
                    signed_fingerprint,
                    previous_head,
                    review_head,
                    # request_identities row
                    admission_key,
                    case.match_id,
                    "CASE_ADMISSION",
                    request_fingerprint,
                    signed_fingerprint,
                    result_fingerprint,
                )
            )
            exact_minus_one = review.preflight.text_bytes + exact_increment - 1
            with mock.patch(
                "vision_scoring.event_store.MAX_COPILOT_REVIEW_TEXT_BYTES_PER_MATCH",
                exact_minus_one,
            ):
                with self.assertRaises(EventStoreError) as caught:
                    store.admit_scorer_copilot_case(
                        raw,
                        policy_archive=self.fixture.archive,
                        admitted_at_ns=1_500,
                    )
            self.assertEqual(caught.exception.code, "REVIEW_TEXT_BUDGET")

    def test_review_action_text_projection_counts_every_v3_row_copy(self) -> None:
        signed_case = self._signed_case()
        with self._store() as store:
            self.fixture.initialize(store)
            store.append_authorized_event(
                self.fixture.envelope(self.fixture.event(1)),
                policy_archive=self.fixture.archive,
                verified_at_ns=140,
            )
            store.admit_scorer_copilot_case(
                encode_signed_scorer_copilot_case(signed_case),
                policy_archive=self.fixture.archive,
                admitted_at_ns=1_500,
            )
            disposition = ReviewDisposition(
                case_fingerprint=signed_case.case_fingerprint,
                signed_case_fingerprint=signed_case.fingerprint(),
                expected_case_sequence=0,
                previous_record_fingerprint=signed_case.fingerprint(),
                idempotency_key="review-text-budget-1",
                kind=ReviewDispositionKind.OBSERVED_OUTCOME,
                outcome=RallyOutcome.POINT_TEAM_B,
                reasons=(),
            )
            signed = sign_review_disposition(
                disposition=disposition,
                signed_case=signed_case,
                policy_archive=self.fixture.archive,
                actor_id=self.fixture.scorekeeper_key.actor_id,
                actor_key_id=self.fixture.scorekeeper_key.key_id,
                actor_role=PrincipalRole.SCOREKEEPER,
                signed_at_ns=1_525,
                actor_private_key=self.fixture.scorekeeper_private,
            )
            with store._transaction(immediate=False):  # type: ignore[attr-defined]
                replay = store._replay_locked(  # type: ignore[attr-defined]
                    match_id=self.fixture.match_id,
                    policy_archive=self.fixture.archive,
                    verified_at_ns=1_540,
                )
            self.assertIsNotNone(replay.review)
            review = replay.review
            assert review is not None
            new_sequence = review.case_state(signed_case.case_fingerprint).case_sequence + 1
            review_position = review.preflight.history_count + 1
            previous_head = review.review_history_head_sha256
            signed_fingerprint = signed.fingerprint()
            review_head = store._review_history_head(  # type: ignore[attr-defined]
                previous_head,
                review_position=review_position,
                entry_kind="DISPOSITION",
                case_fingerprint=signed_case.case_fingerprint,
                entry_fingerprint=signed_fingerprint,
                committed_at_ns=1_550,
            )
            context = store._context_for_signed_case(  # type: ignore[attr-defined]
                signed_case,
                case_sequence=new_sequence,
                journal_head_fingerprint=signed_fingerprint,
            )
            request_kind = "REVIEW_DISPOSITION"
            request_fingerprint = store._review_request_fingerprint(  # type: ignore[attr-defined]
                record_type="DISPOSITION",
                signed_record_fingerprint=signed_fingerprint,
            )
            result_fingerprint = store._review_result_identity_fingerprint(  # type: ignore[attr-defined]
                signed_record_fingerprint=signed_fingerprint,
                case_sequence=new_sequence,
                context_fingerprint=context.fingerprint(),
                review_position=review_position,
                review_history_head_sha256=review_head,
            )
            exact_increment = sum(
                len(value)
                for value in (
                    # copilot_journal row
                    signed_fingerprint,
                    self.fixture.match_id,
                    signed_case.case_fingerprint,
                    signed_case.fingerprint(),
                    "DISPOSITION",
                    disposition.fingerprint(),
                    disposition.previous_record_fingerprint,
                    disposition.idempotency_key,
                    signed.policy_fingerprint,
                    review_head,
                    # copilot_history row
                    self.fixture.match_id,
                    "DISPOSITION",
                    signed_case.case_fingerprint,
                    signed_fingerprint,
                    previous_head,
                    review_head,
                    # request_identities row
                    disposition.idempotency_key,
                    self.fixture.match_id,
                    request_kind,
                    request_fingerprint,
                    signed_fingerprint,
                    result_fingerprint,
                )
            )
            exact_minus_one = review.preflight.text_bytes + exact_increment - 1
            with mock.patch(
                "vision_scoring.event_store.MAX_COPILOT_REVIEW_TEXT_BYTES_PER_MATCH",
                exact_minus_one,
            ):
                with self.assertRaises(EventStoreError) as caught:
                    store.append_review_disposition(
                        encode_signed_review_disposition(signed),
                        policy_archive=self.fixture.archive,
                        accepted_at_ns=1_550,
                    )
            self.assertEqual(caught.exception.code, "REVIEW_TEXT_BUDGET")

    def test_replay_rejects_case_ordinal_reordered_against_history(self) -> None:
        first = self._signed_case()
        second = self._signed_case(
            rally_id="rally-case-2",
            hypothesis_id="hypothesis-2",
            publish_clips=False,
        )
        with self._store() as store:
            self.fixture.initialize(store)
            store.append_authorized_event(
                self.fixture.envelope(self.fixture.event(1)),
                policy_archive=self.fixture.archive,
                verified_at_ns=140,
            )
            for signed_case, admitted_at_ns in ((first, 1_500), (second, 1_510)):
                store.admit_scorer_copilot_case(
                    encode_signed_scorer_copilot_case(signed_case),
                    policy_archive=self.fixture.archive,
                    admitted_at_ns=admitted_at_ns,
                )
            connection = store._connection  # type: ignore[attr-defined]
            connection.execute(
                "UPDATE copilot_cases SET case_ordinal = 100 WHERE case_ordinal = 1"
            )
            connection.execute(
                "UPDATE copilot_cases SET case_ordinal = 1 WHERE case_ordinal = 2"
            )
            connection.execute(
                "UPDATE copilot_cases SET case_ordinal = 2 WHERE case_ordinal = 100"
            )
            with self.assertRaises(EventStoreError) as caught:
                store.audit_replay(
                    self.fixture.match_id,
                    policy_archive=self.fixture.archive,
                    verified_at_ns=1_600,
                )
            self.assertEqual(caught.exception.code, "COPILOT_CASE_ORDER")

    def test_exact_copilot_retry_persists_scheduled_authorization_revocation(
        self,
    ) -> None:
        actor_identity = (
            TrustedKeyKind.ACTOR,
            self.fixture.scorekeeper_key.actor_id,
            self.fixture.scorekeeper_key.key_id,
        )
        self.fixture.archive = self.fixture.archive_for(
            (self.fixture.policy,),
            current=self.fixture.policy,
            revoked_at_ns={actor_identity: 1_560},
        )
        signed_case = self._signed_case()
        with self._store() as store:
            self.fixture.initialize(store)
            store.append_authorized_event(
                self.fixture.envelope(self.fixture.event(1)),
                policy_archive=self.fixture.archive,
                verified_at_ns=140,
            )
            admitted = store.admit_scorer_copilot_case(
                encode_signed_scorer_copilot_case(signed_case),
                policy_archive=self.fixture.archive,
                admitted_at_ns=1_500,
            )
            point = dataclasses.replace(
                self.fixture.event(2, winner=Team.B, created_at_ns=1_520),
                related_rally_id=admitted.context.rally_id,
                payload=PointAwardedPayload(
                    Team.B,
                    admitted.context.evidence_refs,
                ),
            )
            envelope = self.fixture.envelope(
                point,
                idempotency_key=copilot_idempotency_key(admitted.context),
            )
            context_bytes = encode_review_authorization_context(admitted.context)
            store.append_copilot_authorized_event(
                envelope,
                context_bytes,
                policy_archive=self.fixture.archive,
                verified_at_ns=1_550,
            )
            with self.assertRaises(EventStoreError) as caught:
                store.append_copilot_authorized_event(
                    envelope,
                    context_bytes,
                    policy_archive=self.fixture.archive,
                    verified_at_ns=1_570,
                )
            self.assertEqual(caught.exception.code, "INTEGRITY_BLOCKED")
            row = store._connection.execute(  # type: ignore[attr-defined]
                """
                SELECT integrity_blocked, integrity_failure_code FROM matches
                WHERE match_id = ?
                """,
                (self.fixture.match_id,),
            ).fetchone()
            self.assertEqual(row["integrity_blocked"], 1)
            self.assertEqual(
                row["integrity_failure_code"],
                "AUTHORIZATION_ACTOR_KEY_REVOKED",
            )
            self.assertIsNotNone(caught.exception.checkpoint)
            self.assertTrue(caught.exception.checkpoint.integrity_blocked)

    def test_review_request_key_collision_fails_before_media_verification(self) -> None:
        signed_case = self._signed_case()
        with self._store() as store:
            self.fixture.initialize(store)
            store.append_authorized_event(
                self.fixture.envelope(
                    self.fixture.event(1),
                    idempotency_key="occupied-review-key",
                ),
                policy_archive=self.fixture.archive,
                verified_at_ns=140,
            )
            store.admit_scorer_copilot_case(
                encode_signed_scorer_copilot_case(signed_case),
                policy_archive=self.fixture.archive,
                admitted_at_ns=1_500,
            )
            disposition = ReviewDisposition(
                case_fingerprint=signed_case.case_fingerprint,
                signed_case_fingerprint=signed_case.fingerprint(),
                expected_case_sequence=0,
                previous_record_fingerprint=signed_case.fingerprint(),
                idempotency_key="occupied-review-key",
                kind=ReviewDispositionKind.OBSERVED_OUTCOME,
                outcome=RallyOutcome.POINT_TEAM_B,
                reasons=(),
            )
            signed = sign_review_disposition(
                disposition=disposition,
                signed_case=signed_case,
                policy_archive=self.fixture.archive,
                actor_id=self.fixture.scorekeeper_key.actor_id,
                actor_key_id=self.fixture.scorekeeper_key.key_id,
                actor_role=PrincipalRole.SCOREKEEPER,
                signed_at_ns=1_525,
                actor_private_key=self.fixture.scorekeeper_private,
            )
            with mock.patch.object(
                SQLiteEventStore,
                "_verify_case_clips_into_stack",
                autospec=True,
            ) as media_verifier:
                with self.assertRaises(EventStoreError) as caught:
                    store.append_review_disposition(
                        encode_signed_review_disposition(signed),
                        policy_archive=self.fixture.archive,
                        accepted_at_ns=1_550,
                    )
            self.assertEqual(caught.exception.code, "REVIEW_IDEMPOTENCY_CONFLICT")
            media_verifier.assert_not_called()


if __name__ == "__main__":
    unittest.main()
