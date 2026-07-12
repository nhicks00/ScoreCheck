from __future__ import annotations

import base64
import dataclasses
import hashlib
import json
import inspect
import sqlite3
import tempfile
import threading
import unittest
from unittest import mock
from pathlib import Path

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from vision_scoring.authorization import (
    AuthorizationCommand,
    AuthorizationOrigin,
    AuthorizationPolicy,
    AuthorizationPolicyArchive,
    KeyRevocationStatus,
    PrincipalRole,
    TrustedActorKey,
    TrustedAssessmentKey,
    TrustedAuthorizerKey,
    TrustedKeyKind,
    authorize_rule_event,
    encode_authorized_rule_event,
    parse_authorized_rule_event,
    sign_authorization_command,
    sign_policy_assessment,
)
from vision_scoring.domain_events import (
    CourtSide,
    PointAwardedPayload,
    RuleEvent,
    RuleEventType,
    SetSeedPayload,
    Team,
)
from vision_scoring.event_store import (
    MAX_ARCHIVE_HISTORY_BYTES_PER_MATCH,
    MAX_ARCHIVE_TEXT_BYTES_PER_MATCH,
    MAX_LEDGER_ENVELOPE_BYTES_PER_MATCH,
    MAX_LEDGER_TEXT_BYTES_PER_MATCH,
    MAX_SQLITE_COLUMNS,
    MAX_SQLITE_SQL_BYTES,
    MAX_SQLITE_VALUE_BYTES,
    MAX_SQLITE_VARIABLES,
    SHADOW_OUTBOX_TARGET,
    SHADOW_OUTBOX_TOPIC,
    EventStoreError,
    SQLiteEventStore,
    verify_checkpoint_progression,
)
from vision_scoring.policy import (
    PolicyAssessment,
    PolicyAssessmentStatus,
    PolicyReason,
    ScoringIntent,
    ScoringIntentKind,
)
from vision_scoring.rules import Ruleset
from vision_scoring.state_codec import match_state_fingerprint


REDUCER_BUILD_SHA256 = "d" * 64


def _public_key_base64(private_key: Ed25519PrivateKey) -> str:
    raw = private_key.public_key().public_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PublicFormat.Raw,
    )
    return base64.b64encode(raw).decode("ascii")


class _Fixture:
    def __init__(self, root: Path, *, match_id: str = "match-1") -> None:
        self.path = root / "ledger.sqlite3"
        self.match_id = match_id
        self.ruleset = Ruleset()
        self.scorekeeper_private = Ed25519PrivateKey.generate()
        self.admin_private = Ed25519PrivateKey.generate()
        self.authorizer_private = Ed25519PrivateKey.generate()
        self.scorekeeper_key = TrustedActorKey(
            actor_id=f"scorekeeper-{match_id}",
            key_id=f"scorekeeper-key-{match_id}",
            role=PrincipalRole.SCOREKEEPER,
            public_key_base64=_public_key_base64(self.scorekeeper_private),
            valid_from_ns=1,
            valid_until_ns=1_000_000,
        )
        self.admin_key = TrustedActorKey(
            actor_id=f"admin-{match_id}",
            key_id=f"admin-key-{match_id}",
            role=PrincipalRole.MATCH_ADMIN,
            public_key_base64=_public_key_base64(self.admin_private),
            valid_from_ns=1,
            valid_until_ns=1_000_000,
        )
        self.authorizer_key = TrustedAuthorizerKey(
            authorizer_id=f"authorizer-{match_id}",
            key_id=f"authorizer-key-{match_id}",
            public_key_base64=_public_key_base64(self.authorizer_private),
            valid_from_ns=1,
            valid_until_ns=1_000_000,
        )
        self.policy = self.policy_for("policy-v1")
        self.archive = self.archive_for((self.policy,), current=self.policy)

    def policy_for(
        self,
        policy_id: str,
        *,
        valid_from_ns: int = 1,
        valid_until_ns: int = 1_000_000,
    ) -> AuthorizationPolicy:
        return AuthorizationPolicy(
            policy_id=policy_id,
            trust_domain_id=f"court-control-{self.match_id}",
            match_id=self.match_id,
            valid_from_ns=valid_from_ns,
            valid_until_ns=valid_until_ns,
            max_command_lifetime_ns=500,
            accepted_assessment_policy_fingerprints=(),
            actor_keys=(self.scorekeeper_key, self.admin_key),
            assessment_keys=(),
            authorizer_keys=(self.authorizer_key,),
        )

    def archive_for(
        self,
        policies: tuple[AuthorizationPolicy, ...],
        *,
        current: AuthorizationPolicy,
        revoked_at_ns: dict[tuple[TrustedKeyKind, str, str], int | None] | None = None,
    ) -> AuthorizationPolicyArchive:
        overrides = revoked_at_ns or {}
        statuses: dict[tuple[TrustedKeyKind, str, str], KeyRevocationStatus] = {}
        for policy in policies:
            groups = (
                (TrustedKeyKind.ACTOR, policy.actor_keys, "actor_id"),
                (
                    TrustedKeyKind.ASSESSMENT,
                    policy.assessment_keys,
                    "assessor_id",
                ),
                (TrustedKeyKind.AUTHORIZER, policy.authorizer_keys, "authorizer_id"),
            )
            for kind, keys, principal_field in groups:
                for key in keys:
                    principal_id = getattr(key, principal_field)
                    identity = (kind, principal_id, key.key_id)
                    statuses[identity] = KeyRevocationStatus(
                        key_kind=kind,
                        principal_id=principal_id,
                        key_id=key.key_id,
                        public_key_sha256=hashlib.sha256(
                            base64.b64decode(key.public_key_base64)
                        ).hexdigest(),
                        revoked_at_ns=overrides.get(identity, key.revoked_at_ns),
                    )
        return AuthorizationPolicyArchive(
            archive_id=f"archive-{self.match_id}",
            trust_domain_id=current.trust_domain_id,
            match_id=self.match_id,
            policies=policies,
            current_policy_fingerprint=current.fingerprint(),
            key_revocations=tuple(statuses.values()),
        )

    def event(
        self,
        revision: int,
        *,
        event_id: str | None = None,
        winner: Team = Team.A,
        created_at_ns: int | None = None,
    ) -> RuleEvent:
        if revision == 1:
            event_type = RuleEventType.SET_SEED
            payload = SetSeedPayload(
                ("a1", "a2"),
                ("b1", "b2"),
                Team.A,
                "a1",
                CourtSide.NEAR,
                CourtSide.FAR,
            )
            rally_id = None
        else:
            event_type = RuleEventType.POINT_AWARDED
            payload = PointAwardedPayload(
                winner, (f"artifact:frame:{self.match_id}:{revision}",)
            )
            rally_id = f"rally-{self.match_id}-{revision}"
        return RuleEvent(
            event_id=event_id or f"event-{self.match_id}-{revision}",
            sequence_number=revision,
            match_id=self.match_id,
            set_number=1,
            event_type=event_type,
            ruleset_id=self.ruleset.ruleset_id,
            ruleset_version=self.ruleset.version,
            ruleset_fingerprint=self.ruleset.fingerprint(),
            payload=payload,
            created_at_ns=created_at_ns or 100 + revision * 20,
            related_rally_id=rally_id,
        )

    def envelope(
        self,
        event: RuleEvent,
        *,
        policy: AuthorizationPolicy | None = None,
        archive: AuthorizationPolicyArchive | None = None,
        idempotency_key: str | None = None,
        authorized_at_ns: int | None = None,
        origin: AuthorizationOrigin = AuthorizationOrigin.HUMAN_DIRECT,
        assessment_value: PolicyAssessment | None = None,
        signed_assessment_value=None,
        assessment_key: TrustedAssessmentKey | None = None,
        assessment_private_key: Ed25519PrivateKey | None = None,
    ) -> bytes:
        policy = policy or self.policy
        archive = archive or self.archive
        if event.event_type is RuleEventType.SET_SEED:
            actor_key = self.admin_key
            actor_private = self.admin_private
        else:
            actor_key = self.scorekeeper_key
            actor_private = self.scorekeeper_private
        issued = event.created_at_ns + 2
        authorized = authorized_at_ns or event.created_at_ns + 5
        signed_assessment = signed_assessment_value
        if signed_assessment is not None and assessment_value is None:
            raise ValueError("signed assessment requires assessment_value")
        if assessment_value is not None and signed_assessment is None:
            if assessment_key is None or assessment_private_key is None:
                raise ValueError("assessment signing key pair is required")
            signed_assessment = sign_policy_assessment(
                assessment=assessment_value,
                assessor_id=assessment_key.assessor_id,
                assessment_key_id=assessment_key.key_id,
                signed_at_ns=event.created_at_ns - 1,
                assessment_private_key=assessment_private_key,
            )
        command = AuthorizationCommand(
            event=event,
            event_fingerprint=event.fingerprint(),
            expected_revision=event.sequence_number - 1,
            idempotency_key=(
                idempotency_key
                or f"request:{self.match_id}:{event.event_id}"
            ),
            origin=origin,
            actor_id=actor_key.actor_id,
            actor_key_id=actor_key.key_id,
            actor_role=actor_key.role,
            issued_at_ns=issued,
            expires_at_ns=issued + 100,
            nonce=f"nonce-{self.match_id}-{event.event_id}-0001",
            policy_id=policy.policy_id,
            policy_fingerprint=policy.fingerprint(),
            trust_domain_id=policy.trust_domain_id,
            assessment=assessment_value,
            assessment_fingerprint=(
                assessment_value.fingerprint()
                if assessment_value is not None
                else None
            ),
            signed_assessment=signed_assessment,
        )
        signed = sign_authorization_command(command, actor_private)
        envelope = authorize_rule_event(
            signed_command=signed,
            policy_archive=archive,
            authorizer_id=self.authorizer_key.authorizer_id,
            authorizer_key_id=self.authorizer_key.key_id,
            authorizer_private_key=self.authorizer_private,
            authorized_at_ns=authorized,
        )
        return encode_authorized_rule_event(envelope)

    def store(self) -> SQLiteEventStore:
        return SQLiteEventStore(
            self.path,
            ruleset=self.ruleset,
            reducer_build_sha256=REDUCER_BUILD_SHA256,
        )

    def initialize(self, store: SQLiteEventStore, *, at_ns: int = 100) -> None:
        store.initialize_match(
            self.match_id,
            policy_archive=self.archive,
            initialized_at_ns=at_ns,
        )


class EventStoreTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.fixture = _Fixture(self.root)

    def assert_store_error(self, code: str, operation) -> EventStoreError:
        with self.assertRaises(EventStoreError) as caught:
            operation()
        self.assertEqual(caught.exception.code, code)
        return caught.exception

    def test_bootstrap_append_full_replay_and_shadow_checkpoint(self) -> None:
        with self.fixture.store() as store:
            initialized = store.initialize_match(
                self.fixture.match_id,
                policy_archive=self.fixture.archive,
                initialized_at_ns=100,
            )
            seed = self.fixture.envelope(self.fixture.event(1))
            first = store.append_authorized_event(
                seed, policy_archive=self.fixture.archive, verified_at_ns=140
            )
            point = self.fixture.envelope(self.fixture.event(2))
            second = store.append_authorized_event(
                point, policy_archive=self.fixture.archive, verified_at_ns=165
            )
            audit = store.audit_replay(
                self.fixture.match_id,
                policy_archive=self.fixture.archive,
                verified_at_ns=170,
            )

            self.assertEqual(initialized.checkpoint.revision, 0)
            self.assertEqual(first.revision, 1)
            self.assertEqual(second.revision, 2)
            self.assertEqual(audit.event_count, 2)
            self.assertEqual(audit.checkpoint.revision, 2)
            self.assertEqual(audit.reducer_build_sha256, REDUCER_BUILD_SHA256)
            self.assertEqual(len(audit.fingerprint()), 64)
            self.assertEqual(len(audit.checkpoint.fingerprint()), 64)
            self.assertEqual(first.outbox_id, 1)
            self.assertEqual(second.outbox_id, 2)
            self.assertIs(
                verify_checkpoint_progression(initialized.checkpoint, first.checkpoint),
                first.checkpoint,
            )
            self.assertIs(
                verify_checkpoint_progression(first.checkpoint, second.checkpoint),
                second.checkpoint,
            )
            self.assert_store_error(
                "CHECKPOINT_OUTBOX_ROLLBACK",
                lambda: verify_checkpoint_progression(
                    second.checkpoint,
                    dataclasses.replace(
                        second.checkpoint,
                        outbox_position=second.checkpoint.outbox_position - 1,
                        last_verified_at_ns=second.checkpoint.last_verified_at_ns + 1,
                    ),
                ),
            )
            with self.assertRaisesRegex(ValueError, "lowercase SHA-256"):
                dataclasses.replace(
                    second.checkpoint,
                    ledger_head_sha256="A" * 64,
                )
            with self.assertRaisesRegex(ValueError, "exact bool"):
                dataclasses.replace(second.checkpoint, integrity_blocked=1)
            unchanged_archive_advance = dataclasses.replace(
                second.checkpoint,
                archive_adoption_generation=(
                    second.checkpoint.archive_adoption_generation + 1
                ),
                last_verified_at_ns=second.checkpoint.last_verified_at_ns + 1,
            )
            self.assert_store_error(
                "CHECKPOINT_ARCHIVE_CONFLICT",
                lambda: verify_checkpoint_progression(
                    second.checkpoint, unchanged_archive_advance
                ),
            )

        connection = sqlite3.connect(self.fixture.path)
        connection.row_factory = sqlite3.Row
        try:
            outbox = connection.execute(
                "SELECT * FROM shadow_outbox ORDER BY outbox_id"
            ).fetchall()
            payload = json.loads(outbox[-1]["payload_bytes"])
            self.assertEqual(outbox[-1]["topic"], SHADOW_OUTBOX_TOPIC)
            self.assertEqual(outbox[-1]["target"], SHADOW_OUTBOX_TARGET)
            self.assertFalse(payload["official_scorecheck_mutation_permitted"])
            self.assertEqual(payload["outbox_id"], outbox[-1]["outbox_id"])
            self.assertEqual(payload["reducer_build_sha256"], REDUCER_BUILD_SHA256)
            self.assertEqual(connection.execute("PRAGMA synchronous").fetchone()[0], 2)
            self.assertEqual(connection.execute("PRAGMA journal_mode").fetchone()[0], "wal")
        finally:
            connection.close()

    def test_append_requires_explicit_bootstrap_and_exact_runtime_build(self) -> None:
        envelope = self.fixture.envelope(self.fixture.event(1))
        with self.fixture.store() as store:
            self.assert_store_error(
                "MATCH_NOT_INITIALIZED",
                lambda: store.append_authorized_event(
                    envelope,
                    policy_archive=self.fixture.archive,
                    verified_at_ns=140,
                ),
            )
            self.fixture.initialize(store)
        self.assert_store_error(
            "TRUSTED_RUNTIME_MISMATCH",
            lambda: SQLiteEventStore(
                self.fixture.path,
                ruleset=self.fixture.ruleset,
                reducer_build_sha256="e" * 64,
            ),
        )

    def test_exact_idempotent_retry_returns_original_result_after_later_event(self) -> None:
        seed = self.fixture.envelope(self.fixture.event(1))
        point = self.fixture.envelope(self.fixture.event(2))
        with self.fixture.store() as store:
            self.fixture.initialize(store)
            original = store.append_authorized_event(
                seed, policy_archive=self.fixture.archive, verified_at_ns=140
            )
            store.append_authorized_event(
                point, policy_archive=self.fixture.archive, verified_at_ns=165
            )
            retried = store.append_authorized_event(
                seed, policy_archive=self.fixture.archive, verified_at_ns=170
            )
            self.assertEqual(retried, original)
            self.assertEqual(retried.fingerprint(), original.fingerprint())
            audit = store.audit_replay(
                self.fixture.match_id,
                policy_archive=self.fixture.archive,
                verified_at_ns=171,
            )
            self.assertEqual(audit.event_count, 2)

    def test_idempotency_conflicts_on_changed_content_key_or_global_identity(self) -> None:
        seed_event = self.fixture.event(1)
        seed = self.fixture.envelope(seed_event)
        request_key = f"request:{self.fixture.match_id}:{seed_event.event_id}"
        changed_event = dataclasses.replace(seed_event, event_id="changed-seed")
        changed_content = self.fixture.envelope(
            changed_event, idempotency_key=request_key
        )
        changed_key = self.fixture.envelope(
            seed_event, idempotency_key="another-request-key"
        )
        with self.fixture.store() as store:
            self.fixture.initialize(store)
            store.append_authorized_event(
                seed, policy_archive=self.fixture.archive, verified_at_ns=140
            )
            self.assert_store_error(
                "IDEMPOTENCY_CONFLICT",
                lambda: store.append_authorized_event(
                    changed_content,
                    policy_archive=self.fixture.archive,
                    verified_at_ns=141,
                ),
            )
            self.assert_store_error(
                "GLOBAL_IDENTITY_CONFLICT",
                lambda: store.append_authorized_event(
                    changed_key,
                    policy_archive=self.fixture.archive,
                    verified_at_ns=141,
                ),
            )

    def test_reserved_copilot_request_requires_atomic_case_context_path(self) -> None:
        envelope = self.fixture.envelope(
            self.fixture.event(1),
            idempotency_key=f"copilot-v1:{'a' * 64}",
        )
        with self.fixture.store() as store:
            self.fixture.initialize(store)
            self.assert_store_error(
                "COPILOT_CONTEXT_REQUIRED",
                lambda: store.append_authorized_event(
                    envelope,
                    policy_archive=self.fixture.archive,
                    verified_at_ns=140,
                ),
            )
            audit = store.audit_replay(
                self.fixture.match_id,
                policy_archive=self.fixture.archive,
                verified_at_ns=141,
            )
            self.assertEqual(audit.event_count, 0)

    def test_generic_append_rejects_every_assessment_assisted_command(self) -> None:
        assessment_private = Ed25519PrivateKey.generate()
        assessment_key = TrustedAssessmentKey(
            assessor_id="scoring-policy-service",
            key_id="assessment-key-1",
            public_key_base64=_public_key_base64(assessment_private),
            valid_from_ns=1,
            valid_until_ns=1_000_000,
        )
        scoring_policy_fingerprint = "c" * 64
        policy = AuthorizationPolicy(
            policy_id="assisted-policy-v1",
            trust_domain_id=self.fixture.policy.trust_domain_id,
            match_id=self.fixture.match_id,
            valid_from_ns=1,
            valid_until_ns=1_000_000,
            max_command_lifetime_ns=500,
            accepted_assessment_policy_fingerprints=(scoring_policy_fingerprint,),
            actor_keys=(self.fixture.scorekeeper_key, self.fixture.admin_key),
            assessment_keys=(assessment_key,),
            authorizer_keys=(self.fixture.authorizer_key,),
        )
        archive = self.fixture.archive_for((policy,), current=policy)
        seed = self.fixture.envelope(
            self.fixture.event(1), policy=policy, archive=archive
        )
        point_event = self.fixture.event(2)
        assessment_value = PolicyAssessment(
            hypothesis_id="hypothesis-1",
            hypothesis_fingerprint="b" * 64,
            match_id=self.fixture.match_id,
            rally_id=point_event.related_rally_id,
            set_number=1,
            state_revision=1,
            ruleset_fingerprint=self.fixture.ruleset.fingerprint(),
            causal_cutoff_timestamp_ns=point_event.created_at_ns - 10,
            policy_version="scoring-policy-v1",
            policy_fingerprint=scoring_policy_fingerprint,
            status=PolicyAssessmentStatus.HUMAN_AUTHORIZATION_REQUIRED,
            reasons=(PolicyReason.HUMAN_AUTHORIZATION_REQUIRED,),
            recommended_intent=ScoringIntent(
                ScoringIntentKind.AWARD_POINT, Team.A
            ),
            evidence_refs=point_event.payload.evidence_refs,
        )
        assisted = self.fixture.envelope(
            point_event,
            policy=policy,
            archive=archive,
            origin=AuthorizationOrigin.ASSESSMENT_ASSISTED,
            assessment_value=assessment_value,
            assessment_key=assessment_key,
            assessment_private_key=assessment_private,
        )
        with self.fixture.store() as store:
            store.initialize_match(
                self.fixture.match_id,
                policy_archive=archive,
                initialized_at_ns=100,
            )
            store.append_authorized_event(
                seed, policy_archive=archive, verified_at_ns=140
            )
            self.assert_store_error(
                "ASSISTED_CONTEXT_REQUIRED",
                lambda: store.append_authorized_event(
                    assisted, policy_archive=archive, verified_at_ns=160
                ),
            )
            self.assertEqual(
                store.audit_replay(
                    self.fixture.match_id,
                    policy_archive=archive,
                    verified_at_ns=161,
                ).event_count,
                1,
            )

    def test_production_append_has_no_callback_and_private_fault_cannot_commit(self) -> None:
        signature = inspect.signature(SQLiteEventStore.append_authorized_event)
        self.assertNotIn("before_commit", signature.parameters)
        seed = self.fixture.envelope(self.fixture.event(1))
        with self.fixture.store() as store:
            self.fixture.initialize(store)
            with self.assertRaises(AttributeError):
                store.before_commit = lambda: None  # type: ignore[attr-defined]
            store._test_fault_mode = "RAISE_BEFORE_POST_REPLAY"  # type: ignore[attr-defined]
            self.assert_store_error(
                "TEST_FAULT_INJECTED",
                lambda: store.append_authorized_event(
                    seed,
                    policy_archive=self.fixture.archive,
                    verified_at_ns=140,
                ),
            )
            self.assertEqual(
                store.audit_replay(
                    self.fixture.match_id,
                    policy_archive=self.fixture.archive,
                    verified_at_ns=141,
                ).event_count,
                0,
            )

    def test_fault_before_commit_rolls_back_every_table_and_projection(self) -> None:
        seed = self.fixture.envelope(self.fixture.event(1))
        with self.fixture.store() as store:
            self.fixture.initialize(store)
            store._test_fault_mode = "RAISE_BEFORE_POST_REPLAY"  # type: ignore[attr-defined]
            self.assert_store_error(
                "TEST_FAULT_INJECTED",
                lambda: store.append_authorized_event(
                    seed,
                    policy_archive=self.fixture.archive,
                    verified_at_ns=140,
                ),
            )
            audit = store.audit_replay(
                self.fixture.match_id,
                policy_archive=self.fixture.archive,
                verified_at_ns=141,
            )
            self.assertEqual(audit.event_count, 0)
            committed = store.append_authorized_event(
                seed, policy_archive=self.fixture.archive, verified_at_ns=142
            )
            self.assertEqual(committed.revision, 1)

        connection = sqlite3.connect(self.fixture.path)
        try:
            for table in (
                "authorization_log",
                "event_log",
                "state_history",
                "shadow_outbox",
                "idempotency_log",
            ):
                self.assertEqual(
                    connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0],
                    1,
                )
        finally:
            connection.close()

    def test_concurrent_distinct_writers_have_exactly_one_winner(self) -> None:
        seed = self.fixture.envelope(self.fixture.event(1))
        candidate_a = self.fixture.envelope(
            self.fixture.event(2, event_id="concurrent-a", winner=Team.A)
        )
        candidate_b = self.fixture.envelope(
            self.fixture.event(2, event_id="concurrent-b", winner=Team.B)
        )
        with self.fixture.store() as store:
            self.fixture.initialize(store)
            store.append_authorized_event(
                seed, policy_archive=self.fixture.archive, verified_at_ns=140
            )

        barrier = threading.Barrier(2)
        outcomes: list[tuple[str, str]] = []
        outcomes_lock = threading.Lock()

        def worker(label: str, raw: bytes) -> None:
            try:
                with self.fixture.store() as local_store:
                    barrier.wait(timeout=5)
                    local_store.append_authorized_event(
                        raw,
                        policy_archive=self.fixture.archive,
                        verified_at_ns=165,
                    )
                outcome = (label, "committed")
            except EventStoreError as exc:
                outcome = (label, exc.code)
            with outcomes_lock:
                outcomes.append(outcome)

        threads = [
            threading.Thread(target=worker, args=("a", candidate_a)),
            threading.Thread(target=worker, args=("b", candidate_b)),
        ]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=10)
        self.assertFalse(any(thread.is_alive() for thread in threads))
        self.assertEqual(sorted(value for _, value in outcomes), ["STALE_REVISION", "committed"])
        with self.fixture.store() as store:
            audit = store.audit_replay(
                self.fixture.match_id,
                policy_archive=self.fixture.archive,
                verified_at_ns=166,
            )
            self.assertEqual(audit.event_count, 2)

    def test_cross_match_event_and_idempotency_ids_are_globally_unique(self) -> None:
        fixture_two = _Fixture(self.root, match_id="match-2")
        first_event = self.fixture.event(1, event_id="global-event-id")
        first_key = "global-idempotency-key"
        with self.fixture.store() as store:
            self.fixture.initialize(store)
            fixture_two.initialize(store)
            store.append_authorized_event(
                self.fixture.envelope(first_event, idempotency_key=first_key),
                policy_archive=self.fixture.archive,
                verified_at_ns=140,
            )
            colliding_event = fixture_two.event(1, event_id="global-event-id")
            self.assert_store_error(
                "GLOBAL_IDENTITY_CONFLICT",
                lambda: store.append_authorized_event(
                    fixture_two.envelope(colliding_event),
                    policy_archive=fixture_two.archive,
                    verified_at_ns=140,
                ),
            )
            colliding_key_event = fixture_two.event(1, event_id="unique-event-id")
            self.assert_store_error(
                "IDEMPOTENCY_CONFLICT",
                lambda: store.append_authorized_event(
                    fixture_two.envelope(
                        colliding_key_event, idempotency_key=first_key
                    ),
                    policy_archive=fixture_two.archive,
                    verified_at_ns=140,
                ),
            )

    def test_reopen_preserves_history_and_source_has_no_destructive_write_patterns(self) -> None:
        seed = self.fixture.envelope(self.fixture.event(1))
        with self.fixture.store() as store:
            self.fixture.initialize(store)
            store.append_authorized_event(
                seed, policy_archive=self.fixture.archive, verified_at_ns=140
            )
        with self.fixture.store() as reopened:
            audit = reopened.audit_replay(
                self.fixture.match_id,
                policy_archive=self.fixture.archive,
                verified_at_ns=141,
            )
            self.assertEqual(audit.event_count, 1)
            public_names = {name.lower() for name in dir(reopened) if not name.startswith("_")}
            self.assertFalse(public_names & {"delete", "purge", "truncate", "clear"})
        source = (
            Path(__file__).parents[1]
            / "src"
            / "vision_scoring"
            / "event_store.py"
        ).read_text(encoding="utf-8").upper()
        for forbidden in (
            "INSERT OR IGNORE",
            "INSERT OR REPLACE",
            "ON CONFLICT",
            "DELETE FROM",
            "DROP TABLE",
        ):
            self.assertNotIn(forbidden, source)

    def test_verification_time_cannot_move_backward(self) -> None:
        seed = self.fixture.envelope(self.fixture.event(1))
        with self.fixture.store() as store:
            self.fixture.initialize(store)
            store.append_authorized_event(
                seed, policy_archive=self.fixture.archive, verified_at_ns=140
            )
            self.assert_store_error(
                "VERIFICATION_TIME_ROLLBACK",
                lambda: store.audit_replay(
                    self.fixture.match_id,
                    policy_archive=self.fixture.archive,
                    verified_at_ns=139,
                ),
            )
            self.assert_store_error(
                "VERIFICATION_TIME_ROLLBACK",
                lambda: store.append_authorized_event(
                    seed,
                    policy_archive=self.fixture.archive,
                    verified_at_ns=139,
                ),
            )

    def test_post_insert_fault_hook_tamper_is_replayed_then_rolled_back(self) -> None:
        seed = self.fixture.envelope(self.fixture.event(1))
        with self.fixture.store() as store:
            self.fixture.initialize(store)
            store._test_fault_mode = (  # type: ignore[attr-defined]
                "CORRUPT_OUTBOX_BEFORE_POST_REPLAY"
            )
            self.assert_store_error(
                "OUTBOX_TAMPER",
                lambda: store.append_authorized_event(
                    seed,
                    policy_archive=self.fixture.archive,
                    verified_at_ns=140,
                ),
            )
            audit = store.audit_replay(
                self.fixture.match_id,
                policy_archive=self.fixture.archive,
                verified_at_ns=141,
            )
            self.assertEqual(audit.event_count, 0)

    def test_idempotent_retry_replays_history_before_returning_prior_result(self) -> None:
        seed = self.fixture.envelope(self.fixture.event(1))
        with self.fixture.store() as store:
            self.fixture.initialize(store)
            store.append_authorized_event(
                seed, policy_archive=self.fixture.archive, verified_at_ns=140
            )
        connection = sqlite3.connect(self.fixture.path)
        try:
            connection.execute("UPDATE shadow_outbox SET payload_bytes = ?", (b"{}",))
            connection.commit()
        finally:
            connection.close()
        with self.fixture.store() as store:
            self.assert_store_error(
                "OUTBOX_TAMPER",
                lambda: store.append_authorized_event(
                    seed,
                    policy_archive=self.fixture.archive,
                    verified_at_ns=141,
                ),
            )

    def test_audit_detects_envelope_state_projection_outbox_auth_and_idempotency_tamper(self) -> None:
        fixtures = {
            label: _Fixture(self.root, match_id=f"tamper-{label}")
            for label in (
                "envelope",
                "state",
                "projection",
                "outbox",
                "authorization",
                "idempotency",
            )
        }
        with self.fixture.store() as store:
            for fixture in fixtures.values():
                fixture.initialize(store)
                store.append_authorized_event(
                    fixture.envelope(fixture.event(1)),
                    policy_archive=fixture.archive,
                    verified_at_ns=140,
                )
        connection = sqlite3.connect(self.fixture.path)
        try:
            connection.execute(
                "UPDATE event_log SET envelope_bytes = ? WHERE match_id = ?",
                (b"{}", fixtures["envelope"].match_id),
            )
            connection.execute(
                "UPDATE state_history SET state_bytes = ? WHERE match_id = ?",
                (b"{}", fixtures["state"].match_id),
            )
            connection.execute(
                "UPDATE matches SET current_state_bytes = ? WHERE match_id = ?",
                (b"{}", fixtures["projection"].match_id),
            )
            connection.execute(
                "UPDATE shadow_outbox SET payload_bytes = ? WHERE match_id = ?",
                (b"{}", fixtures["outbox"].match_id),
            )
            connection.execute(
                "UPDATE authorization_log SET actor_id = ? WHERE match_id = ?",
                ("forged-actor", fixtures["authorization"].match_id),
            )
            connection.execute(
                "UPDATE idempotency_log SET result_state_fingerprint = ? WHERE match_id = ?",
                ("f" * 64, fixtures["idempotency"].match_id),
            )
            connection.commit()
        finally:
            connection.close()

        expected = {
            "envelope": "ENVELOPE_INVALID",
            "state": "STATE_HISTORY_TAMPER",
            "projection": "CURRENT_PROJECTION_TAMPER",
            "outbox": "OUTBOX_TAMPER",
            "authorization": "AUTHORIZATION_LOG_TAMPER",
            "idempotency": "IDEMPOTENCY_LOG_TAMPER",
        }
        with self.fixture.store() as store:
            for label, fixture in fixtures.items():
                with self.subTest(label=label):
                    self.assert_store_error(
                        expected[label],
                        lambda fixture=fixture: store.audit_replay(
                            fixture.match_id,
                            policy_archive=fixture.archive,
                            verified_at_ns=141,
                        ),
                    )

    def test_historical_outbox_identity_and_foreign_key_tamper_fails_closed(self) -> None:
        seed = self.fixture.envelope(self.fixture.event(1))
        with self.fixture.store() as store:
            self.fixture.initialize(store)
            result = store.append_authorized_event(
                seed, policy_archive=self.fixture.archive, verified_at_ns=140
            )
            self.assertEqual(result.outbox_id, 1)
        connection = sqlite3.connect(self.fixture.path)
        try:
            connection.execute("PRAGMA foreign_keys = OFF")
            connection.execute(
                "UPDATE shadow_outbox SET outbox_id = 99 WHERE outbox_id = 1"
            )
            connection.commit()
        finally:
            connection.close()
        self.assert_store_error("FOREIGN_KEY_CORRUPTION", self.fixture.store)

    def test_open_rejects_unexpected_trigger_and_schema_identity_tamper(self) -> None:
        with self.fixture.store() as store:
            self.fixture.initialize(store)
        connection = sqlite3.connect(self.fixture.path)
        try:
            connection.execute(
                """
                CREATE TRIGGER malicious_projection_trigger
                AFTER UPDATE ON matches BEGIN
                    SELECT 1;
                END
                """
            )
            connection.commit()
        finally:
            connection.close()
        self.assert_store_error("SCHEMA_OBJECTS", self.fixture.store)

        connection = sqlite3.connect(self.fixture.path)
        try:
            connection.execute("DROP TRIGGER malicious_projection_trigger")
            connection.execute("PRAGMA application_id = 123")
            connection.commit()
        finally:
            connection.close()
        self.assert_store_error("SCHEMA_IDENTITY", self.fixture.store)

    def test_sqlite_database_errors_are_normalized_at_constructor_and_public_api(self) -> None:
        corrupt_path = self.root / "corrupt.sqlite3"
        corrupt_path.write_bytes(b"this is not a sqlite database")
        self.assert_store_error(
            "SQLITE_DATABASE_ERROR",
            lambda: SQLiteEventStore(
                corrupt_path,
                ruleset=self.fixture.ruleset,
                reducer_build_sha256=REDUCER_BUILD_SHA256,
            ),
        )

    def test_sqlite_runtime_limits_are_set_and_read_back_before_use(self) -> None:
        with self.fixture.store() as store:
            connection = store._connection  # type: ignore[attr-defined]
            expected = {
                sqlite3.SQLITE_LIMIT_LENGTH: MAX_SQLITE_VALUE_BYTES,
                sqlite3.SQLITE_LIMIT_SQL_LENGTH: MAX_SQLITE_SQL_BYTES,
                sqlite3.SQLITE_LIMIT_COLUMN: MAX_SQLITE_COLUMNS,
                sqlite3.SQLITE_LIMIT_VARIABLE_NUMBER: MAX_SQLITE_VARIABLES,
                sqlite3.SQLITE_LIMIT_ATTACHED: 0,
            }
            for category, value in expected.items():
                self.assertEqual(connection.getlimit(category), value)

    def test_every_representative_text_column_has_database_bounds_and_ascii_checks(self) -> None:
        seed = self.fixture.envelope(self.fixture.event(1))
        with self.fixture.store() as store:
            self.fixture.initialize(store)
            store.append_authorized_event(
                seed, policy_archive=self.fixture.archive, verified_at_ns=140
            )
        cases = (
            ("matches", "authorization_archive_id", "x" * 129),
            ("archive_adoptions", "archive_id", "x" * 129),
            ("event_log", "event_type", "x" * 129),
            ("authorization_log", "actor_id", "x" * 129),
            ("shadow_outbox", "message_id", "x" * 193),
            ("idempotency_log", "idempotency_key", "x" * 129),
            ("event_log", "event_id", "non-ascii-é"),
            ("event_log", "event_fingerprint", "G" * 64),
        )
        connection = sqlite3.connect(self.fixture.path)
        try:
            connection.execute("PRAGMA foreign_keys = OFF")
            for table, column, value in cases:
                with self.subTest(table=table, column=column):
                    with self.assertRaises(sqlite3.IntegrityError):
                        connection.execute(
                            f"UPDATE {table} SET {column} = ?",
                            (value,),
                        )
                    connection.rollback()
        finally:
            connection.close()

    def test_oversized_legacy_text_is_rejected_before_row_materialization(self) -> None:
        cases = (
            ("matches", "authorization_archive_id", "SQLITE_LIMIT_EXCEEDED"),
            ("archive_adoptions", "archive_id", "SQLITE_LIMIT_EXCEEDED"),
            ("event_log", "event_type", "SQLITE_LIMIT_EXCEEDED"),
            ("authorization_log", "actor_id", "SQLITE_LIMIT_EXCEEDED"),
            ("shadow_outbox", "message_id", "SQLITE_LIMIT_EXCEEDED"),
            ("idempotency_log", "idempotency_key", "SQLITE_LIMIT_EXCEEDED"),
        )
        for table, column, expected_code in cases:
            with self.subTest(table=table, column=column):
                with tempfile.TemporaryDirectory() as root:
                    fixture = _Fixture(Path(root))
                    seed = fixture.envelope(fixture.event(1))
                    with fixture.store() as store:
                        fixture.initialize(store)
                        store.append_authorized_event(
                            seed,
                            policy_archive=fixture.archive,
                            verified_at_ns=140,
                        )
                    connection = sqlite3.connect(fixture.path)
                    try:
                        connection.execute("PRAGMA foreign_keys = OFF")
                        connection.execute("PRAGMA ignore_check_constraints = ON")
                        connection.execute(
                            f"UPDATE {table} SET {column} = ?",
                            ("x" * 1_000_000,),
                        )
                        connection.commit()
                    finally:
                        connection.close()
                    self.assert_store_error(expected_code, fixture.store)

        store = self.fixture.store()
        self.fixture.initialize(store)
        store._connection.close()  # type: ignore[attr-defined]
        self.assert_store_error(
            "SQLITE_DATABASE_ERROR",
            lambda: store.audit_replay(
                self.fixture.match_id,
                policy_archive=self.fixture.archive,
                verified_at_ns=101,
            ),
        )

    def test_byte_budget_preflight_rejects_before_blob_rows_are_materialized(self) -> None:
        self.assertGreater(MAX_LEDGER_ENVELOPE_BYTES_PER_MATCH, 1)
        self.assertGreater(MAX_ARCHIVE_HISTORY_BYTES_PER_MATCH, 1)
        seed = self.fixture.envelope(self.fixture.event(1))
        with self.fixture.store() as store:
            self.fixture.initialize(store)
            store.append_authorized_event(
                seed, policy_archive=self.fixture.archive, verified_at_ns=140
            )
            blocked_column = "envelope_bytes"

            def guarded_row_factory(cursor, row):
                names = tuple(description[0] for description in cursor.description)
                if blocked_column in names:
                    raise AssertionError(f"{blocked_column} was materialized")
                return sqlite3.Row(cursor, row)

            store._connection.row_factory = guarded_row_factory  # type: ignore[attr-defined]
            with mock.patch(
                "vision_scoring.event_store.MAX_LEDGER_ENVELOPE_BYTES_PER_MATCH",
                1,
            ):
                self.assert_store_error(
                    "LEDGER_BYTE_BUDGET",
                    lambda: store.audit_replay(
                        self.fixture.match_id,
                        policy_archive=self.fixture.archive,
                        verified_at_ns=141,
                    ),
                )
            blocked_column = "archive_bytes"
            with mock.patch(
                "vision_scoring.event_store.MAX_ARCHIVE_HISTORY_BYTES_PER_MATCH",
                1,
            ):
                self.assert_store_error(
                    "ARCHIVE_BYTE_BUDGET",
                    lambda: store.audit_replay(
                        self.fixture.match_id,
                        policy_archive=self.fixture.archive,
                        verified_at_ns=141,
                    ),
                )
            blocked_column = "event_type"
            with mock.patch(
                "vision_scoring.event_store.MAX_LEDGER_TEXT_BYTES_PER_MATCH",
                1,
            ):
                self.assert_store_error(
                    "LEDGER_TEXT_BUDGET",
                    lambda: store.audit_replay(
                        self.fixture.match_id,
                        policy_archive=self.fixture.archive,
                        verified_at_ns=141,
                    ),
                )
            blocked_column = "archive_id"
            with mock.patch(
                "vision_scoring.event_store.MAX_ARCHIVE_TEXT_BYTES_PER_MATCH",
                1,
            ):
                self.assert_store_error(
                    "ARCHIVE_TEXT_BUDGET",
                    lambda: store.audit_replay(
                        self.fixture.match_id,
                        policy_archive=self.fixture.archive,
                        verified_at_ns=141,
                    ),
                )

    def test_generic_append_text_projection_matches_persisted_v3_rows(self) -> None:
        seed = self.fixture.envelope(self.fixture.event(1))
        with self.fixture.store() as store:
            self.fixture.initialize(store)
            with store._transaction(immediate=False):  # type: ignore[attr-defined]
                before = store._ledger_preflight_locked(  # type: ignore[attr-defined]
                    self.fixture.match_id
                )
            projected_text_values: list[int] = []
            original_budget_check = SQLiteEventStore._check_projected_ledger_budget  # type: ignore[attr-defined]

            def capture_budget_check(
                instance,
                preflight,
                *,
                envelope_bytes,
                state_bytes,
                outbox_bytes,
                text_bytes,
            ):
                projected_text_values.append(text_bytes)
                return original_budget_check(
                    instance,
                    preflight,
                    envelope_bytes=envelope_bytes,
                    state_bytes=state_bytes,
                    outbox_bytes=outbox_bytes,
                    text_bytes=text_bytes,
                )

            with mock.patch.object(
                SQLiteEventStore,
                "_check_projected_ledger_budget",
                new=capture_budget_check,
            ):
                store.append_authorized_event(
                    seed,
                    policy_archive=self.fixture.archive,
                    verified_at_ns=140,
                )
            with store._transaction(immediate=False):  # type: ignore[attr-defined]
                after = store._ledger_preflight_locked(  # type: ignore[attr-defined]
                    self.fixture.match_id
                )
            self.assertEqual(len(projected_text_values), 1)
            self.assertEqual(
                after.text_bytes - before.text_bytes,
                projected_text_values[0],
            )

    def test_replay_rejects_self_consistent_outbox_id_reordering(self) -> None:
        with self.fixture.store() as store:
            self.fixture.initialize(store)
            for revision, verified_at_ns in ((1, 140), (2, 160)):
                store.append_authorized_event(
                    self.fixture.envelope(self.fixture.event(revision)),
                    policy_archive=self.fixture.archive,
                    verified_at_ns=verified_at_ns,
                )

            connection = store._connection  # type: ignore[attr-defined]
            match_row = store._load_match_locked(self.fixture.match_id)  # type: ignore[attr-defined]
            rows = connection.execute(
                "SELECT * FROM event_log WHERE match_id = ? ORDER BY revision",
                (self.fixture.match_id,),
            ).fetchall()
            state = store.reducer.new_match(self.fixture.match_id)
            state0_fingerprint = match_state_fingerprint(
                state,
                ruleset=store.ruleset,
            )
            initial_archive = connection.execute(
                """
                SELECT adopted_archive_fingerprint FROM archive_adoptions
                WHERE match_id = ? AND generation = 0
                """,
                (self.fixture.match_id,),
            ).fetchone()[0]
            head = store._genesis_head(  # type: ignore[attr-defined]
                match_binding_fingerprint=match_row["match_binding_fingerprint"],
                initial_state_fingerprint=state0_fingerprint,
                initial_archive_fingerprint=initial_archive,
            )
            updates: list[tuple[object, ...]] = []
            for row, new_outbox_id in zip(rows, (2, 1)):
                envelope = parse_authorized_rule_event(row["envelope_bytes"])
                state = store.reducer.reduce(state, envelope.event).after
                state_fingerprint = match_state_fingerprint(
                    state,
                    ruleset=store.ruleset,
                )
                message_id = (
                    f"shadow:{new_outbox_id}:{envelope.event.event_id}"
                )
                payload = store._outbox_payload(  # type: ignore[attr-defined]
                    envelope=envelope,
                    state=state,
                    state_fingerprint=state_fingerprint,
                    archive_fingerprint=row["adopted_archive_fingerprint"],
                    message_id=message_id,
                    outbox_id=new_outbox_id,
                    appended_at_ns=row["appended_at_ns"],
                    review_position=row["review_position_at_append"],
                    review_history_head_sha256=row[
                        "review_history_head_at_append"
                    ],
                )
                payload_fingerprint = hashlib.sha256(payload).hexdigest()
                head = store._next_head(  # type: ignore[attr-defined]
                    head,
                    event=envelope.event,
                    envelope_fingerprint=envelope.fingerprint(),
                    authorization_record_fingerprint=(
                        envelope.authorization_record.fingerprint()
                    ),
                    state_fingerprint=state_fingerprint,
                    outbox_payload_fingerprint=payload_fingerprint,
                    archive_fingerprint=row["adopted_archive_fingerprint"],
                    outbox_id=new_outbox_id,
                    appended_at_ns=row["appended_at_ns"],
                    review_position=row["review_position_at_append"],
                    review_history_head_sha256=row[
                        "review_history_head_at_append"
                    ],
                )
                result_fingerprint = store._event_result_identity_fingerprint(  # type: ignore[attr-defined]
                    envelope_fingerprint=envelope.fingerprint(),
                    state_fingerprint=state_fingerprint,
                    outbox_id=new_outbox_id,
                    outbox_payload_fingerprint=payload_fingerprint,
                )
                updates.append(
                    (
                        row["revision"],
                        new_outbox_id,
                        message_id,
                        payload,
                        payload_fingerprint,
                        head,
                        result_fingerprint,
                        envelope.authorization_record.signed_command.command.idempotency_key,
                    )
                )

            connection.execute("PRAGMA foreign_keys = OFF")
            connection.execute(
                "UPDATE shadow_outbox SET outbox_id = outbox_id + 10"
            )
            connection.execute(
                "UPDATE idempotency_log SET outbox_id = outbox_id + 10"
            )
            for (
                revision,
                new_outbox_id,
                message_id,
                payload,
                payload_fingerprint,
                prefix_head,
                result_fingerprint,
                idempotency_key,
            ) in updates:
                connection.execute(
                    """
                    UPDATE shadow_outbox SET outbox_id = ?, message_id = ?,
                        payload_bytes = ?, payload_fingerprint = ?
                    WHERE match_id = ? AND revision = ?
                    """,
                    (
                        new_outbox_id,
                        message_id,
                        payload,
                        payload_fingerprint,
                        self.fixture.match_id,
                        revision,
                    ),
                )
                connection.execute(
                    """
                    UPDATE idempotency_log SET outbox_id = ?,
                        outbox_payload_fingerprint = ?
                    WHERE match_id = ? AND result_revision = ?
                    """,
                    (
                        new_outbox_id,
                        payload_fingerprint,
                        self.fixture.match_id,
                        revision,
                    ),
                )
                connection.execute(
                    """
                    UPDATE request_identities SET result_identity_fingerprint = ?
                    WHERE idempotency_key = ?
                    """,
                    (result_fingerprint, idempotency_key),
                )
                connection.execute(
                    """
                    UPDATE state_history SET ledger_head_sha256 = ?
                    WHERE match_id = ? AND revision = ?
                    """,
                    (prefix_head, self.fixture.match_id, revision),
                )
            connection.execute(
                "UPDATE matches SET ledger_head_sha256 = ? WHERE match_id = ?",
                (updates[-1][5], self.fixture.match_id),
            )
            connection.execute("PRAGMA foreign_keys = ON")

            with self.assertRaises(EventStoreError) as caught:
                store.audit_replay(
                    self.fixture.match_id,
                    policy_archive=self.fixture.archive,
                    verified_at_ns=170,
                )
            self.assertEqual(caught.exception.code, "OUTBOX_ID_ORDER")

    def test_safe_archive_rotation_is_audited_and_old_archive_cannot_return(self) -> None:
        seed = self.fixture.envelope(self.fixture.event(1))
        new_policy = self.fixture.policy_for("policy-v2")
        new_archive = self.fixture.archive_for(
            (self.fixture.policy, new_policy), current=new_policy
        )
        with self.fixture.store() as store:
            self.fixture.initialize(store)
            store.append_authorized_event(
                seed, policy_archive=self.fixture.archive, verified_at_ns=140
            )
            advanced = store.advance_authorization_archive(
                self.fixture.match_id,
                previous_archive=self.fixture.archive,
                new_archive=new_archive,
                adopted_at_ns=150,
            )
            self.assertTrue(advanced.integrity_valid)
            self.assertEqual(advanced.adoption_generation, 1)
            self.assertEqual(advanced.checkpoint.archive_adoption_generation, 1)
            self.assertEqual(
                advanced.checkpoint.adopted_archive_fingerprint,
                new_archive.fingerprint(),
            )
            self.assert_store_error(
                "TRUST_PIN_MISMATCH",
                lambda: store.audit_replay(
                    self.fixture.match_id,
                    policy_archive=self.fixture.archive,
                    verified_at_ns=151,
                ),
            )
            audit = store.audit_replay(
                self.fixture.match_id,
                policy_archive=new_archive,
                verified_at_ns=151,
            )
            self.assertEqual(audit.event_count, 1)
            point_event = self.fixture.event(2, created_at_ns=160)
            point = self.fixture.envelope(
                point_event, policy=new_policy, archive=new_archive
            )
            result = store.append_authorized_event(
                point, policy_archive=new_archive, verified_at_ns=170
            )
            self.assertEqual(result.revision, 2)
            self.assertEqual(
                result.adopted_archive_fingerprint, new_archive.fingerprint()
            )

    def test_delayed_append_uses_policy_timeline_and_pre_adoption_policy_fails(self) -> None:
        new_policy = self.fixture.policy_for("policy-v2")
        rotated = self.fixture.archive_for(
            (self.fixture.policy, new_policy), current=new_policy
        )
        seed = self.fixture.envelope(self.fixture.event(1))
        delayed_event = self.fixture.event(
            2, event_id="delayed-v1-event", created_at_ns=145
        )
        delayed_v1 = self.fixture.envelope(delayed_event)
        premature_event = self.fixture.event(
            2, event_id="premature-v2-event", created_at_ns=145
        )
        premature_v2 = self.fixture.envelope(
            premature_event,
            policy=new_policy,
            archive=rotated,
        )
        with self.fixture.store() as store:
            self.fixture.initialize(store)
            store.append_authorized_event(
                seed, policy_archive=self.fixture.archive, verified_at_ns=140
            )
            store.advance_authorization_archive(
                self.fixture.match_id,
                previous_archive=self.fixture.archive,
                new_archive=rotated,
                adopted_at_ns=155,
            )
            self.assert_store_error(
                "POLICY_NOT_CURRENT_AT_TIME",
                lambda: store.append_authorized_event(
                    premature_v2,
                    policy_archive=rotated,
                    verified_at_ns=160,
                ),
            )
            delayed = store.append_authorized_event(
                delayed_v1,
                policy_archive=rotated,
                verified_at_ns=161,
            )
            self.assertEqual(delayed.revision, 2)

    def test_staged_never_current_policy_cannot_authorize_an_append(self) -> None:
        staged_policy = self.fixture.policy_for("staged-policy-v2")
        staged_archive = self.fixture.archive_for(
            (self.fixture.policy, staged_policy), current=self.fixture.policy
        )
        forged_current_archive = self.fixture.archive_for(
            (self.fixture.policy, staged_policy), current=staged_policy
        )
        seed = self.fixture.envelope(
            self.fixture.event(1),
            policy=self.fixture.policy,
            archive=staged_archive,
        )
        staged_event = self.fixture.event(2, event_id="staged-policy-event")
        staged_envelope = self.fixture.envelope(
            staged_event,
            policy=staged_policy,
            archive=forged_current_archive,
        )
        with self.fixture.store() as store:
            store.initialize_match(
                self.fixture.match_id,
                policy_archive=staged_archive,
                initialized_at_ns=100,
            )
            store.append_authorized_event(
                seed, policy_archive=staged_archive, verified_at_ns=140
            )
            self.assert_store_error(
                "POLICY_NOT_CURRENT_AT_TIME",
                lambda: store.append_authorized_event(
                    staged_envelope,
                    policy_archive=staged_archive,
                    verified_at_ns=160,
                ),
            )

    def test_tampered_equal_time_archive_generation_fails_replay(self) -> None:
        new_policy = self.fixture.policy_for("policy-v2")
        new_archive = self.fixture.archive_for(
            (self.fixture.policy, new_policy), current=new_policy
        )
        with self.fixture.store() as store:
            self.fixture.initialize(store)
            store.advance_authorization_archive(
                self.fixture.match_id,
                previous_archive=self.fixture.archive,
                new_archive=new_archive,
                adopted_at_ns=150,
            )
        connection = sqlite3.connect(self.fixture.path)
        try:
            connection.execute(
                "UPDATE archive_adoptions SET adopted_at_ns = 100 WHERE generation = 1"
            )
            connection.commit()
        finally:
            connection.close()
        with self.fixture.store() as store:
            self.assert_store_error(
                "ARCHIVE_HISTORY",
                lambda: store.audit_replay(
                    self.fixture.match_id,
                    policy_archive=new_archive,
                    verified_at_ns=151,
                ),
            )

    def test_persisted_archive_is_strictly_reparsed_before_trust(self) -> None:
        with self.fixture.store() as store:
            self.fixture.initialize(store)
        connection = sqlite3.connect(self.fixture.path)
        try:
            raw = connection.execute(
                "SELECT archive_bytes FROM archive_adoptions"
            ).fetchone()[0]
            duplicate = raw.replace(
                b'{"archive_id":',
                b'{"archive_id":"duplicate","archive_id":',
                1,
            )
            connection.execute(
                "UPDATE archive_adoptions SET archive_bytes = ?", (duplicate,)
            )
            connection.commit()
        finally:
            connection.close()
        with self.fixture.store() as store:
            self.assert_store_error(
                "ARCHIVE_HISTORY_ENCODING",
                lambda: store.audit_replay(
                    self.fixture.match_id,
                    policy_archive=self.fixture.archive,
                    verified_at_ns=101,
                ),
            )

    def test_archive_adoption_rejects_policy_removal_timestamp_tie_and_revocation_rollback(self) -> None:
        new_policy = self.fixture.policy_for("policy-v2")
        rotated = self.fixture.archive_for(
            (self.fixture.policy, new_policy), current=new_policy
        )
        scorekeeper_identity = (
            TrustedKeyKind.ACTOR,
            self.fixture.scorekeeper_key.actor_id,
            self.fixture.scorekeeper_key.key_id,
        )
        revoked = self.fixture.archive_for(
            (self.fixture.policy, new_policy),
            current=new_policy,
            revoked_at_ns={scorekeeper_identity: 145},
        )
        with self.fixture.store() as store:
            self.fixture.initialize(store)
            seed = self.fixture.envelope(self.fixture.event(1))
            store.append_authorized_event(
                seed, policy_archive=self.fixture.archive, verified_at_ns=140
            )
            self.assert_store_error(
                "ARCHIVE_ADOPTION_TIME",
                lambda: store.advance_authorization_archive(
                    self.fixture.match_id,
                    previous_archive=self.fixture.archive,
                    new_archive=rotated,
                    adopted_at_ns=140,
                ),
            )
            store.advance_authorization_archive(
                self.fixture.match_id,
                previous_archive=self.fixture.archive,
                new_archive=rotated,
                adopted_at_ns=150,
            )
            self.assert_store_error(
                "ARCHIVE_POLICY_REMOVED",
                lambda: store.advance_authorization_archive(
                    self.fixture.match_id,
                    previous_archive=rotated,
                    new_archive=self.fixture.archive,
                    adopted_at_ns=151,
                ),
            )
            adopted_revocation = store.advance_authorization_archive(
                self.fixture.match_id,
                previous_archive=rotated,
                new_archive=revoked,
                adopted_at_ns=152,
            )
            self.assertTrue(adopted_revocation.integrity_valid)
            self.assert_store_error(
                "ARCHIVE_REVOCATION_ROLLBACK",
                lambda: store.advance_authorization_archive(
                    self.fixture.match_id,
                    previous_archive=revoked,
                    new_archive=rotated,
                    adopted_at_ns=153,
                ),
            )

    def test_compromise_revocation_adopts_then_blocks_without_old_archive_fallback(self) -> None:
        seed = self.fixture.envelope(self.fixture.event(1))
        admin_identity = (
            TrustedKeyKind.ACTOR,
            self.fixture.admin_key.actor_id,
            self.fixture.admin_key.key_id,
        )
        compromised = self.fixture.archive_for(
            (self.fixture.policy,),
            current=self.fixture.policy,
            revoked_at_ns={admin_identity: 110},
        )
        with self.fixture.store() as store:
            self.fixture.initialize(store)
            store.append_authorized_event(
                seed, policy_archive=self.fixture.archive, verified_at_ns=140
            )
            advanced = store.advance_authorization_archive(
                self.fixture.match_id,
                previous_archive=self.fixture.archive,
                new_archive=compromised,
                adopted_at_ns=150,
            )
            self.assertFalse(advanced.integrity_valid)
            self.assertTrue(advanced.checkpoint.integrity_blocked)
            self.assertIsNotNone(advanced.integrity_failure_code)
            self.assert_store_error(
                "INTEGRITY_BLOCKED",
                lambda: store.audit_replay(
                    self.fixture.match_id,
                    policy_archive=compromised,
                    verified_at_ns=151,
                ),
            )
            self.assert_store_error(
                "TRUST_PIN_MISMATCH",
                lambda: store.audit_replay(
                    self.fixture.match_id,
                    policy_archive=self.fixture.archive,
                    verified_at_ns=151,
                ),
            )
            self.assert_store_error(
                "INTEGRITY_BLOCKED",
                lambda: store.append_authorized_event(
                    seed,
                    policy_archive=compromised,
                    verified_at_ns=151,
                ),
            )

    def test_future_revocation_permanently_blocks_on_later_replay(self) -> None:
        future_revoked_admin = dataclasses.replace(
            self.fixture.admin_key, revoked_at_ns=150
        )
        future_policy = AuthorizationPolicy(
            policy_id="future-revocation-policy",
            trust_domain_id=self.fixture.policy.trust_domain_id,
            match_id=self.fixture.match_id,
            valid_from_ns=1,
            valid_until_ns=1_000_000,
            max_command_lifetime_ns=500,
            accepted_assessment_policy_fingerprints=(),
            actor_keys=(self.fixture.scorekeeper_key, future_revoked_admin),
            assessment_keys=(),
            authorizer_keys=(self.fixture.authorizer_key,),
        )
        future_archive = self.fixture.archive_for(
            (future_policy,), current=future_policy
        )
        seed = self.fixture.envelope(
            self.fixture.event(1), policy=future_policy, archive=future_archive
        )
        with self.fixture.store() as store:
            store.initialize_match(
                self.fixture.match_id,
                policy_archive=future_archive,
                initialized_at_ns=100,
            )
            committed = store.append_authorized_event(
                seed, policy_archive=future_archive, verified_at_ns=140
            )
            self.assertEqual(committed.revision, 1)
            self.assertEqual(
                store.audit_replay(
                    self.fixture.match_id,
                    policy_archive=future_archive,
                    verified_at_ns=149,
                ).event_count,
                1,
            )
            blocked_error = self.assert_store_error(
                "INTEGRITY_BLOCKED",
                lambda: store.audit_replay(
                    self.fixture.match_id,
                    policy_archive=future_archive,
                    verified_at_ns=160,
                ),
            )
            self.assertIsNotNone(blocked_error.checkpoint)
            self.assertTrue(blocked_error.checkpoint.integrity_blocked)
            self.assertIs(
                verify_checkpoint_progression(
                    committed.checkpoint, blocked_error.checkpoint
                ),
                blocked_error.checkpoint,
            )
            self.assert_store_error(
                "CHECKPOINT_BLOCK_CONFLICT",
                lambda: verify_checkpoint_progression(
                    blocked_error.checkpoint,
                    dataclasses.replace(
                        blocked_error.checkpoint,
                        last_verified_at_ns=(
                            blocked_error.checkpoint.last_verified_at_ns + 1
                        ),
                    ),
                ),
            )
            row = store._connection.execute(  # type: ignore[attr-defined]
                """
                SELECT integrity_blocked, integrity_failure_code, last_verified_at_ns
                FROM matches WHERE match_id = ?
                """,
                (self.fixture.match_id,),
            ).fetchone()
            self.assertEqual(row["integrity_blocked"], 1)
            self.assertTrue(row["integrity_failure_code"].startswith("AUTHORIZATION_"))
            self.assertEqual(row["last_verified_at_ns"], 160)
        with self.fixture.store() as reopened:
            self.assert_store_error(
                "INTEGRITY_BLOCKED",
                lambda: reopened.audit_replay(
                    self.fixture.match_id,
                    policy_archive=future_archive,
                    verified_at_ns=161,
                ),
            )

    def test_ruleset_event_bound_is_enforced_before_a_second_write(self) -> None:
        self.fixture.ruleset = Ruleset(max_events_per_match=1)
        seed = self.fixture.envelope(self.fixture.event(1))
        point = self.fixture.envelope(self.fixture.event(2))
        with self.fixture.store() as store:
            self.fixture.initialize(store)
            store.append_authorized_event(
                seed, policy_archive=self.fixture.archive, verified_at_ns=140
            )
            self.assert_store_error(
                "EVENT_LIMIT",
                lambda: store.append_authorized_event(
                    point,
                    policy_archive=self.fixture.archive,
                    verified_at_ns=165,
                ),
            )
            audit = store.audit_replay(
                self.fixture.match_id,
                policy_archive=self.fixture.archive,
                verified_at_ns=166,
            )
            self.assertEqual(audit.event_count, 1)
