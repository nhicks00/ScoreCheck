from __future__ import annotations

import ast
import base64
import dataclasses
import hashlib
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from tests.test_event_store import _Fixture
from vision_scoring.event_store import (
    MAX_SHADOW_OUTBOX_PAYLOAD_BYTES as STORE_MAX_PAYLOAD,
    SHADOW_OUTBOX_TARGET as STORE_TARGET,
    SHADOW_OUTBOX_TOPIC as STORE_TOPIC,
)
from vision_scoring.domain_events import SetSeedPayload
from vision_scoring.review_contracts import (
    copilot_idempotency_key,
    encode_review_authorization_context,
)
from vision_scoring.shadow_transport import (
    DELIVERY_ATTRIBUTION_ONLY,
    MAX_SHADOW_DISPATCH_ENVELOPE_BYTES,
    MAX_SHADOW_OUTBOX_PAYLOAD_BYTES,
    OFFICIAL_SCORE_AUTHORITY_GRANTED,
    SHADOW_OUTBOX_TARGET,
    SHADOW_OUTBOX_TOPIC,
    DispatcherVerificationKey,
    ProtectedDispatcherKeyRegistry,
    ShadowDispatchTrustPolicy,
    ShadowTransportError,
    SignedShadowDispatch,
    encode_signed_shadow_dispatch,
    parse_shadow_outbox_payload,
    parse_signed_shadow_dispatch,
    sign_shadow_dispatch,
    verify_signed_shadow_dispatch,
)


def _canonical(value: object) -> bytes:
    return json.dumps(
        value,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=True,
        allow_nan=False,
    ).encode("ascii")


def _public_key_base64(private_key: Ed25519PrivateKey) -> str:
    raw = private_key.public_key().public_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PublicFormat.Raw,
    )
    return base64.b64encode(raw).decode("ascii")


class ShadowPayloadContractTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.fixture = _Fixture(Path(self.temp.name))
        with self.fixture.store() as store:
            self.fixture.initialize(store)
            store.append_authorized_event(
                self.fixture.envelope(self.fixture.event(1)),
                policy_archive=self.fixture.archive,
                verified_at_ns=140,
            )
            store.append_authorized_event(
                self.fixture.envelope(self.fixture.event(2)),
                policy_archive=self.fixture.archive,
                verified_at_ns=165,
            )
        with sqlite3.connect(self.fixture.path) as connection:
            rows = connection.execute(
                "SELECT payload_bytes FROM shadow_outbox ORDER BY outbox_id"
            ).fetchall()
        self.seed_raw = rows[0][0]
        self.point_raw = rows[1][0]

    def assert_error(self, code: str, operation) -> ShadowTransportError:
        with self.assertRaises(ShadowTransportError) as caught:
            operation()
        self.assertEqual(caught.exception.code, code)
        return caught.exception

    def mutate(self, raw: bytes, **changes: object) -> bytes:
        value = json.loads(raw)
        value.update(changes)
        return _canonical(value)

    def test_frozen_literals_cross_check_committed_event_store(self) -> None:
        self.assertEqual(SHADOW_OUTBOX_TOPIC, STORE_TOPIC)
        self.assertEqual(SHADOW_OUTBOX_TARGET, STORE_TARGET)
        self.assertEqual(MAX_SHADOW_OUTBOX_PAYLOAD_BYTES, STORE_MAX_PAYLOAD)
        self.assertTrue(DELIVERY_ATTRIBUTION_ONLY)
        self.assertFalse(OFFICIAL_SCORE_AUTHORITY_GRANTED)

    def test_real_public_append_payloads_validate_without_private_builder(self) -> None:
        seed = parse_shadow_outbox_payload(self.seed_raw)
        point = parse_shadow_outbox_payload(self.point_raw)
        self.assertEqual(seed.event_type, "SET_SEED")
        self.assertEqual(point.event_type, "POINT_AWARDED")
        self.assertEqual(seed.outbox_id, 1)
        self.assertEqual(point.outbox_id, 2)
        self.assertFalse(seed.official_score_authority_granted)
        tree = ast.parse(Path(__file__).read_text(encoding="utf-8"))
        private_builder_calls = tuple(
            node
            for node in ast.walk(tree)
            if isinstance(node, ast.Call)
            and isinstance(node.func, ast.Attribute)
            and node.func.attr == "_outbox_payload"
        )
        self.assertEqual(private_builder_calls, ())

    def test_payload_domain_ids_match_public_producer_printable_ascii_grammar(
        self,
    ) -> None:
        root = Path(self.temp.name) / "printable-domain-ids"
        root.mkdir()
        fixture = _Fixture(root)
        event = fixture.event(1)
        self.assertIsInstance(event.payload, SetSeedPayload)
        payload = dataclasses.replace(
            event.payload,
            service_order_a=("a+1", "a2"),
            serving_player="a+1",
        )
        event = dataclasses.replace(
            event,
            event_id="event+seed",
            payload=payload,
        )
        with fixture.store() as store:
            fixture.initialize(store)
            store.append_authorized_event(
                fixture.envelope(
                    event,
                    idempotency_key="request:printable-domain-ids",
                ),
                policy_archive=fixture.archive,
                verified_at_ns=140,
            )
        with sqlite3.connect(fixture.path) as connection:
            raw = connection.execute(
                "SELECT payload_bytes FROM shadow_outbox"
            ).fetchone()[0]
        parsed = parse_shadow_outbox_payload(raw)
        self.assertEqual(parsed.event_id, "event+seed")

    def test_real_atomic_copilot_payload_has_complete_identity_set(self) -> None:
        # Local import prevents unittest discovery from collecting the helper's
        # TestCase methods as part of this transport module.
        from tests.test_copilot_event_store import CopilotEventStoreTests

        helper = CopilotEventStoreTests("runTest")
        helper.setUp()
        try:
            with helper._store() as store:
                _, admitted = helper._seed_and_admit(store)
                event = helper._event_for_context(admitted.context, created_at_ns=1_520)
                envelope = helper.fixture.envelope(
                    event,
                    idempotency_key=copilot_idempotency_key(admitted.context),
                )
                appended = store.append_copilot_authorized_event(
                    envelope,
                    encode_review_authorization_context(admitted.context),
                    policy_archive=helper.fixture.archive,
                    verified_at_ns=1_550,
                )
            with sqlite3.connect(helper.fixture.path) as connection:
                raw = connection.execute(
                    "SELECT payload_bytes FROM shadow_outbox WHERE outbox_id = ?",
                    (appended.append.outbox_id,),
                ).fetchone()[0]
            parsed = parse_shadow_outbox_payload(raw)
            self.assertEqual(parsed.event_type, "POINT_AWARDED")
            self.assertTrue(parsed.scorer_copilot_case_fingerprint)
            self.assertTrue(parsed.scorer_copilot_signed_case_fingerprint)
            self.assertTrue(parsed.scorer_copilot_case_link_fingerprint)
            self.assertTrue(parsed.review_authorization_context_fingerprint)
        finally:
            helper.doCleanups()

    def test_remaining_event_specific_shapes_are_exact(self) -> None:
        base = json.loads(self.point_raw)
        summary = base["event_summary"]

        replay = json.loads(self.point_raw)
        replay["event_summary"] = {
            **summary,
            "domain_fields": {"reason": "review-confirmed-replay"},
            "event_type": "REPLAY_NO_POINT",
            "outcome": "REPLAY_NO_POINT",
            "replay_reason": "review-confirmed-replay",
        }
        self.assertEqual(
            parse_shadow_outbox_payload(_canonical(replay)).event_type,
            "REPLAY_NO_POINT",
        )

        side = json.loads(self.point_raw)
        side["event_summary"] = {
            **summary,
            "domain_fields": {
                "cleared_through_total": 7,
                "due_total": 7,
                "observed_at_total": 8,
                "observed_side_a": "FAR",
                "observed_side_b": "NEAR",
            },
            "event_type": "SIDE_SWITCH_CONFIRMED",
            "outcome": None,
            "replay_reason": None,
        }
        self.assertEqual(
            parse_shadow_outbox_payload(_canonical(side)).event_type,
            "SIDE_SWITCH_CONFIRMED",
        )

        timeout = json.loads(self.point_raw)
        timeout["event_summary"] = {
            **summary,
            "domain_fields": {"due_total": 21, "observed_at_total": 22},
            "event_type": "TECHNICAL_TIMEOUT_COMPLETED",
            "outcome": None,
            "replay_reason": None,
        }
        self.assertEqual(
            parse_shadow_outbox_payload(_canonical(timeout)).event_type,
            "TECHNICAL_TIMEOUT_COMPLETED",
        )

    def test_literal_mutation_and_identity_substitution_fail_closed(self) -> None:
        self.assert_error(
            "MUTATION_FORBIDDEN",
            lambda: parse_shadow_outbox_payload(
                self.mutate(self.seed_raw, official_scorecheck_mutation_permitted=True)
            ),
        )
        self.assert_error(
            "FIELD_VALUE",
            lambda: parse_shadow_outbox_payload(
                self.mutate(self.seed_raw, target="OFFICIAL_SCORECHECK")
            ),
        )
        self.assert_error(
            "IDENTITY_MISMATCH",
            lambda: parse_shadow_outbox_payload(
                self.mutate(self.seed_raw, message_id="shadow:9:event-match-1-1")
            ),
        )
        self.assert_error(
            "FIELD_VALUE",
            lambda: parse_shadow_outbox_payload(
                self.mutate(self.seed_raw, match_id="match+producer-forbidden")
            ),
        )

    def test_copilot_identity_values_are_strictly_all_or_none(self) -> None:
        value = json.loads(self.seed_raw)
        value["scorer_copilot_case_fingerprint"] = "a" * 64
        self.assert_error(
            "COPILOT_IDENTITY_SET",
            lambda: parse_shadow_outbox_payload(_canonical(value)),
        )

        for field in (
            "scorer_copilot_case_fingerprint",
            "scorer_copilot_signed_case_fingerprint",
            "scorer_copilot_case_link_fingerprint",
            "review_authorization_context_fingerprint",
        ):
            value[field] = "a" * 64
        self.assert_error(
            "COPILOT_EVENT_CORRELATION",
            lambda: parse_shadow_outbox_payload(_canonical(value)),
        )

        point = json.loads(self.point_raw)
        for field in (
            "scorer_copilot_case_fingerprint",
            "scorer_copilot_signed_case_fingerprint",
            "scorer_copilot_case_link_fingerprint",
            "review_authorization_context_fingerprint",
        ):
            point[field] = "b" * 64
        point["review_position"] = 0
        self.assert_error(
            "COPILOT_EVENT_CORRELATION",
            lambda: parse_shadow_outbox_payload(_canonical(point)),
        )

    def test_event_domain_shape_outcome_and_post_state_are_strict(self) -> None:
        value = json.loads(self.point_raw)
        value["event_summary"]["domain_fields"]["unknown"] = "A"
        self.assert_error(
            "FIELD_SET", lambda: parse_shadow_outbox_payload(_canonical(value))
        )
        value = json.loads(self.point_raw)
        value["event_summary"]["outcome"] = "POINT_TEAM_B"
        self.assert_error(
            "FIELD_VALUE", lambda: parse_shadow_outbox_payload(_canonical(value))
        )
        value = json.loads(self.point_raw)
        value["post_state_summary"]["unknown"] = 0
        self.assert_error(
            "FIELD_SET", lambda: parse_shadow_outbox_payload(_canonical(value))
        )
        value = json.loads(self.point_raw)
        value["event_summary"]["event_type"] = "FUTURE_EVENT"
        self.assert_error(
            "UNSUPPORTED_EVENT_TYPE",
            lambda: parse_shadow_outbox_payload(_canonical(value)),
        )

    def test_unknown_duplicate_and_noncanonical_json_are_rejected(self) -> None:
        self.assert_error(
            "FIELD_SET",
            lambda: parse_shadow_outbox_payload(self.mutate(self.seed_raw, unknown=1)),
        )
        duplicate = b'{"schema_version":"2.0",' + self.seed_raw[1:]
        self.assert_error(
            "DUPLICATE_KEY", lambda: parse_shadow_outbox_payload(duplicate)
        )
        self.assert_error(
            "NON_CANONICAL", lambda: parse_shadow_outbox_payload(b" " + self.seed_raw)
        )

    def test_noninteger_huge_bool_and_out_of_range_timestamps_are_rejected(self) -> None:
        floating = self.seed_raw.replace(b'"review_position":0', b'"review_position":0.0')
        self.assert_error("JSON_NUMBER", lambda: parse_shadow_outbox_payload(floating))
        huge = self.seed_raw.replace(
            b'"review_position":0', b'"review_position":9223372036854775808'
        )
        self.assert_error("JSON_NUMBER", lambda: parse_shadow_outbox_payload(huge))
        boolean = self.seed_raw.replace(b'"revision":1', b'"revision":true')
        self.assert_error("FIELD_TYPE", lambda: parse_shadow_outbox_payload(boolean))
        self.assert_error(
            "FIELD_BOUNDS",
            lambda: parse_shadow_outbox_payload(
                self.mutate(self.seed_raw, appended_at_ns=-1)
            ),
        )
        self.assert_error(
            "FIELD_BOUNDS",
            lambda: parse_shadow_outbox_payload(
                self.mutate(self.seed_raw, review_position=3_073)
            ),
        )

    def test_depth_size_ascii_and_hash_bounds_are_rejected(self) -> None:
        deep = b'{"x":' + b"[" * 17 + b"0" + b"]" * 17 + b"}"
        self.assert_error("JSON_DEPTH", lambda: parse_shadow_outbox_payload(deep))
        self.assert_error(
            "RAW_SIZE",
            lambda: parse_shadow_outbox_payload(
                b" " * (MAX_SHADOW_OUTBOX_PAYLOAD_BYTES + 1)
            ),
        )
        self.assert_error(
            "INVALID_ASCII", lambda: parse_shadow_outbox_payload(b'{"x":"\xc3\xa9"}')
        )
        self.assert_error(
            "JSON_NODES",
            lambda: parse_shadow_outbox_payload(
                _canonical({"x": [0] * 513})
            ),
        )
        self.assert_error(
            "JSON_CONTAINERS",
            lambda: parse_shadow_outbox_payload(
                _canonical({"x": [[] for _ in range(129)]})
            ),
        )
        self.assert_error(
            "FIELD_VALUE",
            lambda: parse_shadow_outbox_payload(
                self.mutate(self.seed_raw, state_fingerprint="A" * 64)
            ),
        )


class ShadowDispatchContractTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        fixture = _Fixture(Path(self.temp.name))
        with fixture.store() as store:
            fixture.initialize(store)
            store.append_authorized_event(
                fixture.envelope(fixture.event(1)),
                policy_archive=fixture.archive,
                verified_at_ns=140,
            )
        with sqlite3.connect(fixture.path) as connection:
            self.payload = connection.execute(
                "SELECT payload_bytes FROM shadow_outbox"
            ).fetchone()[0]

        self.private = Ed25519PrivateKey.generate()
        self.key = DispatcherVerificationKey(
            dispatcher_id="shadow-dispatcher-1",
            key_id="shadow-dispatch-key-1",
            public_key_base64=_public_key_base64(self.private),
            valid_from_ns=100,
            valid_until_ns=1_000,
        )
        self.registry = ProtectedDispatcherKeyRegistry(
            source_ledger_id="vision-ledger-prod-1",
            current_key_id=self.key.key_id,
            keys=(self.key,),
        )
        self.policy = ShadowDispatchTrustPolicy(
            registry=self.registry,
            maximum_clock_skew_ns=5,
            maximum_envelope_lifetime_ns=100,
        )
        self.signed = self.sign()

    def sign(self, **changes: object) -> SignedShadowDispatch:
        values: dict[str, object] = {
            "payload_bytes": self.payload,
            "policy": self.policy,
            "dispatcher_key_id": self.key.key_id,
            "attempt_id": "attempt-1",
            "signed_at_ns": 200,
            "expires_at_ns": 250,
            "dispatcher_private_key": self.private,
        }
        values.update(changes)
        return sign_shadow_dispatch(**values)  # type: ignore[arg-type]

    def assert_error(self, code: str, operation) -> ShadowTransportError:
        with self.assertRaises(ShadowTransportError) as caught:
            operation()
        self.assertEqual(caught.exception.code, code)
        return caught.exception

    def test_sign_verify_roundtrip_and_exact_retry_are_deterministic(self) -> None:
        raw = encode_signed_shadow_dispatch(self.signed)
        parsed = parse_signed_shadow_dispatch(raw)
        verified = verify_signed_shadow_dispatch(
            parsed,
            policy=self.policy,
            verified_at_ns=220,
        )
        retried = self.sign()
        self.assertEqual(retried, self.signed)
        self.assertEqual(encode_signed_shadow_dispatch(retried), raw)
        self.assertEqual(retried.fingerprint(), self.signed.fingerprint())
        self.assertEqual(verified.payload_bytes, self.payload)
        self.assertFalse(parsed.official_score_authority_granted)

    def test_new_attempt_identity_is_distinct_but_same_payload(self) -> None:
        next_attempt = self.sign(attempt_id="attempt-2")
        self.assertNotEqual(next_attempt.signature_base64, self.signed.signature_base64)
        self.assertNotEqual(next_attempt.fingerprint(), self.signed.fingerprint())
        self.assertEqual(next_attempt.payload_bytes, self.signed.payload_bytes)

    def test_payload_hash_message_and_outbox_substitution_are_rejected(self) -> None:
        self.assert_error(
            "PAYLOAD_HASH",
            lambda: dataclasses.replace(self.signed, payload_sha256="0" * 64),
        )
        self.assert_error(
            "IDENTITY_MISMATCH",
            lambda: dataclasses.replace(self.signed, message_id="shadow:9:other"),
        )
        self.assert_error(
            "IDENTITY_MISMATCH",
            lambda: dataclasses.replace(self.signed, outbox_id=9),
        )

    def test_signature_rejects_attempt_payload_and_domain_substitution(self) -> None:
        attempt = dataclasses.replace(self.signed, attempt_id="attempt-substituted")
        self.assert_error(
            "SIGNATURE_INVALID",
            lambda: verify_signed_shadow_dispatch(
                attempt, policy=self.policy, verified_at_ns=220
            ),
        )
        payload_value = json.loads(self.payload)
        payload_value["appended_at_ns"] += 1
        replacement = _canonical(payload_value)
        substituted = dataclasses.replace(
            self.signed,
            payload_bytes=replacement,
            payload_sha256=hashlib.sha256(replacement).hexdigest(),
        )
        self.assert_error(
            "SIGNATURE_INVALID",
            lambda: verify_signed_shadow_dispatch(
                substituted, policy=self.policy, verified_at_ns=220
            ),
        )
        wrong_domain_signature = self.private.sign(
            b"wrong-shadow-domain\x00" + _canonical(self.signed.unsigned_canonical_dict())
        )
        wrong_domain = dataclasses.replace(
            self.signed,
            signature_base64=base64.b64encode(wrong_domain_signature).decode("ascii"),
        )
        self.assert_error(
            "SIGNATURE_INVALID",
            lambda: verify_signed_shadow_dispatch(
                wrong_domain, policy=self.policy, verified_at_ns=220
            ),
        )
        signature = bytearray(base64.b64decode(self.signed.signature_base64))
        group_order = (
            2**252 + 27742317777372353535851937790883648493
        )
        scalar = int.from_bytes(signature[32:], "little") + group_order
        self.assertLess(scalar, 2**256)
        signature[32:] = scalar.to_bytes(32, "little")
        malleated = dataclasses.replace(
            self.signed,
            signature_base64=base64.b64encode(signature).decode("ascii"),
        )
        self.assert_error(
            "SIGNATURE_INVALID",
            lambda: verify_signed_shadow_dispatch(
                malleated, policy=self.policy, verified_at_ns=220
            ),
        )

    def test_cross_source_cross_key_and_private_key_mismatch_fail(self) -> None:
        other_source_registry = dataclasses.replace(
            self.registry, source_ledger_id="vision-ledger-other"
        )
        other_source_policy = dataclasses.replace(
            self.policy, registry=other_source_registry
        )
        self.assert_error(
            "SOURCE_LEDGER_MISMATCH",
            lambda: verify_signed_shadow_dispatch(
                self.signed, policy=other_source_policy, verified_at_ns=220
            ),
        )

        other_private = Ed25519PrivateKey.generate()
        other_key = DispatcherVerificationKey(
            dispatcher_id="shadow-dispatcher-2",
            key_id="shadow-dispatch-key-2",
            public_key_base64=_public_key_base64(other_private),
            valid_from_ns=100,
            valid_until_ns=1_000,
        )
        rotated = ProtectedDispatcherKeyRegistry(
            source_ledger_id=self.registry.source_ledger_id,
            current_key_id=other_key.key_id,
            keys=(self.key, other_key),
        )
        rotated_policy = dataclasses.replace(self.policy, registry=rotated)
        self.assert_error(
            "KEY_NOT_CURRENT",
            lambda: verify_signed_shadow_dispatch(
                self.signed, policy=rotated_policy, verified_at_ns=220
            ),
        )
        self.assert_error(
            "PRIVATE_KEY_MISMATCH",
            lambda: self.sign(dispatcher_private_key=other_private),
        )

    def test_current_revocation_truth_is_enforced_at_verification(self) -> None:
        revoked_key = dataclasses.replace(self.key, revoked_at_ns=210)
        revoked_registry = dataclasses.replace(self.registry, keys=(revoked_key,))
        revoked_policy = dataclasses.replace(self.policy, registry=revoked_registry)
        self.assert_error(
            "KEY_REVOKED",
            lambda: verify_signed_shadow_dispatch(
                self.signed, policy=revoked_policy, verified_at_ns=220
            ),
        )
        scheduled_key = dataclasses.replace(self.key, revoked_at_ns=225)
        scheduled_registry = dataclasses.replace(self.registry, keys=(scheduled_key,))
        scheduled_policy = dataclasses.replace(self.policy, registry=scheduled_registry)
        self.assert_error(
            "KEY_REVOKED",
            lambda: self.sign(policy=scheduled_policy),
        )
        self.assert_error(
            "KEY_REVOKED",
            lambda: verify_signed_shadow_dispatch(
                self.signed,
                policy=scheduled_policy,
                verified_at_ns=220,
            ),
        )

        skew_window_key = dataclasses.replace(self.key, revoked_at_ns=251)
        skew_window_registry = dataclasses.replace(
            self.registry, keys=(skew_window_key,)
        )
        skew_window_policy = dataclasses.replace(
            self.policy, registry=skew_window_registry
        )
        self.assert_error(
            "KEY_REVOKED",
            lambda: verify_signed_shadow_dispatch(
                self.signed,
                policy=skew_window_policy,
                verified_at_ns=252,
            ),
        )

        after_revocation_signed = self.sign(signed_at_ns=220)
        already_revoked_key = dataclasses.replace(self.key, revoked_at_ns=218)
        already_revoked_registry = dataclasses.replace(
            self.registry, keys=(already_revoked_key,)
        )
        already_revoked_policy = dataclasses.replace(
            self.policy, registry=already_revoked_registry
        )
        self.assert_error(
            "KEY_REVOKED",
            lambda: verify_signed_shadow_dispatch(
                after_revocation_signed,
                policy=already_revoked_policy,
                verified_at_ns=215,
            ),
        )

    def test_registry_rejects_cross_identity_public_key_aliases(self) -> None:
        alias = dataclasses.replace(
            self.key,
            dispatcher_id="shadow-dispatcher-alias",
            key_id="shadow-dispatch-key-alias",
        )
        self.assert_error(
            "KEY_REGISTRY",
            lambda: ProtectedDispatcherKeyRegistry(
                source_ledger_id=self.registry.source_ledger_id,
                current_key_id=self.key.key_id,
                keys=(self.key, alias),
            ),
        )
        many_keys = tuple(
            DispatcherVerificationKey(
                dispatcher_id=f"dispatcher-{index}",
                key_id=f"key-{index}",
                public_key_base64=_public_key_base64(
                    Ed25519PrivateKey.generate()
                ),
                valid_from_ns=100,
                valid_until_ns=1_000,
            )
            for index in range(65)
        )
        self.assert_error(
            "KEY_REGISTRY",
            lambda: ProtectedDispatcherKeyRegistry(
                source_ledger_id=self.registry.source_ledger_id,
                current_key_id=many_keys[0].key_id,
                keys=many_keys,
            ),
        )

    def test_clock_skew_expiry_lifetime_and_key_validity_are_explicit(self) -> None:
        self.assert_error(
            "DISPATCH_FUTURE",
            lambda: verify_signed_shadow_dispatch(
                self.signed, policy=self.policy, verified_at_ns=194
            ),
        )
        self.assert_error(
            "DISPATCH_EXPIRED",
            lambda: verify_signed_shadow_dispatch(
                self.signed, policy=self.policy, verified_at_ns=256
            ),
        )
        self.assert_error(
            "DISPATCH_LIFETIME",
            lambda: self.sign(expires_at_ns=301),
        )
        short_key = dataclasses.replace(self.key, valid_until_ns=240)
        short_registry = dataclasses.replace(self.registry, keys=(short_key,))
        short_policy = dataclasses.replace(self.policy, registry=short_registry)
        self.assert_error(
            "KEY_INACTIVE",
            lambda: verify_signed_shadow_dispatch(
                self.signed, policy=short_policy, verified_at_ns=220
            ),
        )

    def test_dispatch_codec_rejects_unknown_duplicate_noncanonical_numbers_and_size(self) -> None:
        raw = encode_signed_shadow_dispatch(self.signed)
        value = json.loads(raw)
        value["unknown"] = 1
        self.assert_error(
            "FIELD_SET", lambda: parse_signed_shadow_dispatch(_canonical(value))
        )
        duplicate = b'{"algorithm":"Ed25519",' + raw[1:]
        self.assert_error(
            "DUPLICATE_KEY", lambda: parse_signed_shadow_dispatch(duplicate)
        )
        self.assert_error(
            "NON_CANONICAL", lambda: parse_signed_shadow_dispatch(b" " + raw)
        )
        floating = raw.replace(b'"signed_at_ns":200', b'"signed_at_ns":200.0')
        self.assert_error("JSON_NUMBER", lambda: parse_signed_shadow_dispatch(floating))
        huge = raw.replace(
            b'"signed_at_ns":200', b'"signed_at_ns":9223372036854775808'
        )
        self.assert_error("JSON_NUMBER", lambda: parse_signed_shadow_dispatch(huge))
        self.assert_error(
            "RAW_SIZE",
            lambda: parse_signed_shadow_dispatch(
                b" " * (MAX_SHADOW_DISPATCH_ENVELOPE_BYTES + 1)
            ),
        )

    def test_dispatch_timestamp_and_base64_fields_are_strict(self) -> None:
        self.assert_error(
            "FIELD_BOUNDS",
            lambda: dataclasses.replace(self.signed, signed_at_ns=-1),
        )
        self.assert_error(
            "DISPATCH_TIME",
            lambda: dataclasses.replace(self.signed, expires_at_ns=199),
        )
        self.assert_error(
            "FIELD_BOUNDS",
            lambda: dataclasses.replace(self.signed, signature_base64="AA=="),
        )

    def test_transport_module_has_no_persistence_or_scoring_imports(self) -> None:
        module_path = (
            Path(__file__).parents[1]
            / "src"
            / "vision_scoring"
            / "shadow_transport.py"
        )
        source = module_path.read_text(encoding="utf-8")
        tree = ast.parse(source)
        imported_roots: set[str] = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                imported_roots.update(alias.name.split(".")[0] for alias in node.names)
            elif isinstance(node, ast.ImportFrom):
                imported_roots.add((node.module or "").split(".")[0])
        self.assertTrue(
            imported_roots.isdisjoint(
                {
                    "sqlite3",
                    "subprocess",
                    "socket",
                    "urllib",
                    "requests",
                    "httpx",
                    "pathlib",
                    "vision_scoring",
                    "event_store",
                    "rules",
                    "authorization",
                }
            )
        )
        self.assertNotIn("SQLiteEventStore", source)
        self.assertNotIn("append_authorized_event", source)


if __name__ == "__main__":
    unittest.main()
