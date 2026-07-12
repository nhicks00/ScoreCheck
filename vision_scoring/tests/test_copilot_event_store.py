from __future__ import annotations

import base64
import dataclasses
import hashlib
import tempfile
import unittest
from pathlib import Path

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from tests.test_event_store import REDUCER_BUILD_SHA256, _Fixture
from tests.test_review_contracts import (
    make_assessment,
    make_clip,
    make_hypothesis,
    make_reconciliation,
)
from vision_scoring.authorization import PrincipalRole, TrustedAssessmentKey
from vision_scoring.case_attestation import (
    encode_signed_scorer_copilot_case,
    sign_scorer_copilot_case,
)
from vision_scoring.domain_events import PointAwardedPayload, Team
from vision_scoring.immutable_store import (
    GenerationDescriptor,
    bootstrap_generation_lock,
)
from vision_scoring.review_contracts import (
    ReviewClipRole,
    ReviewDisposition,
    ReviewDispositionKind,
    ScorerCopilotCase,
    copilot_idempotency_key,
    encode_review_authorization_context,
    encode_review_clip_manifest,
    encode_signed_review_disposition,
)
from vision_scoring.event_store import EventStoreError, SQLiteEventStore
from vision_scoring.hypotheses import RallyOutcome
from vision_scoring.review_signing import sign_review_disposition


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
        self.fixture.policy = dataclasses.replace(
            self.fixture.policy,
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

    def _signed_case(self):
        hypothesis = dataclasses.replace(
            make_hypothesis(),
            match_id=self.fixture.match_id,
            rally_id="rally-case-1",
            state_revision=1,
            ruleset_fingerprint=self.fixture.ruleset.fingerprint(),
        )
        reconciliation = make_reconciliation(hypothesis)
        assessment = make_assessment(hypothesis, reconciliation)
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
        self._publish(encode_review_clip_manifest(primary.manifest), primary_bytes)
        self._publish(encode_review_clip_manifest(next_clip.manifest), next_bytes)
        case = ScorerCopilotCase(
            hypothesis=hypothesis,
            reconciliation=reconciliation,
            assessment=assessment,
            signed_assessment=None,
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
                        states_by_revision=(initial, seeded, later),
                        event_review_positions=(0, 0),
                        event_appended_times=(140, 1_490),
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
                        states_by_revision=(initial, seeded),
                        event_review_positions=(0,),
                        event_appended_times=(140,),
                    )
                self.assertEqual(
                    reversed_sequence.exception.code,
                    "REVIEW_ACTION_POSITION",
                )


if __name__ == "__main__":
    unittest.main()
