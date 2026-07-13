from __future__ import annotations

import dataclasses
import json
import unittest

from vision_scoring.domain_events import (
    ContractError,
    ContractErrorCode,
    CourtSide,
    MAX_EVIDENCE_REFS,
    MAX_RAW_EVENT_BYTES,
    PointAwardedPayload,
    ReplayNoPointPayload,
    RuleEvent,
    RuleEventType,
    SetSeedPayload,
    SideSwitchConfirmedPayload,
    Team,
    TechnicalTimeoutCompletedPayload,
    encode_rule_event,
    parse_rule_event,
    rule_event_to_dict,
)


FINGERPRINT = "a" * 64


def point_event(**overrides: object) -> RuleEvent:
    values: dict[str, object] = {
        "event_id": "event-1",
        "sequence_number": 1,
        "match_id": "match-1",
        "set_number": 1,
        "event_type": RuleEventType.POINT_AWARDED,
        "ruleset_id": "FIVB_BEACH",
        "ruleset_version": "2025-2028",
        "ruleset_fingerprint": FINGERPRINT,
        "payload": PointAwardedPayload(Team.A, ("evidence:frame-1",)),
        "created_at_ns": 123,
        "related_rally_id": "rally-1",
    }
    values.update(overrides)
    return RuleEvent(**values)  # type: ignore[arg-type]


class DomainEventTests(unittest.TestCase):
    def assert_code(self, code: ContractErrorCode, operation) -> ContractError:
        with self.assertRaises(ContractError) as caught:
            operation()
        self.assertEqual(caught.exception.code, code.value)
        return caught.exception

    def test_all_five_typed_payloads_round_trip_canonically(self) -> None:
        cases = (
            (
                RuleEventType.SET_SEED,
                SetSeedPayload(
                    ("a1", "a2"),
                    ("b1", "b2"),
                    Team.A,
                    "a1",
                    CourtSide.NEAR,
                    CourtSide.FAR,
                ),
                None,
            ),
            (
                RuleEventType.POINT_AWARDED,
                PointAwardedPayload(Team.B, ("frame:1",)),
                "rally-1",
            ),
            (
                RuleEventType.REPLAY_NO_POINT,
                ReplayNoPointPayload("external interference", ("frame:2",)),
                "rally-2",
            ),
            (
                RuleEventType.SIDE_SWITCH_CONFIRMED,
                SideSwitchConfirmedPayload(
                    7, 7, 7, CourtSide.FAR, CourtSide.NEAR, ("frame:3",)
                ),
                None,
            ),
            (
                RuleEventType.TECHNICAL_TIMEOUT_COMPLETED,
                TechnicalTimeoutCompletedPayload(21, 21, ("frame:4",)),
                None,
            ),
        )
        for index, (event_type, payload, rally_id) in enumerate(cases, 1):
            with self.subTest(event_type=event_type):
                event = RuleEvent(
                    event_id=f"event-{index}",
                    sequence_number=index,
                    match_id="match-1",
                    set_number=1,
                    event_type=event_type,
                    ruleset_id="FIVB_BEACH",
                    ruleset_version="2025-2028",
                    ruleset_fingerprint=FINGERPRINT,
                    payload=payload,
                    created_at_ns=index,
                    related_rally_id=rally_id,
                )
                encoded = encode_rule_event(event)
                self.assertEqual(parse_rule_event(encoded), event)
                self.assertEqual(encode_rule_event(parse_rule_event(encoded)), encoded)

    def test_canonical_encoding_and_fingerprint_are_stable(self) -> None:
        event = point_event()
        encoded = encode_rule_event(event)
        self.assertEqual(encoded, encode_rule_event(parse_rule_event(encoded)))
        self.assertEqual(event.fingerprint(), parse_rule_event(encoded).fingerprint())
        self.assertNotIn(b" ", encoded)
        self.assertEqual(json.loads(encoded), rule_event_to_dict(event))

    def test_evidence_references_have_set_semantics_in_canonical_form(self) -> None:
        first = point_event(
            payload=PointAwardedPayload(
                Team.A,
                ("evidence:z", "evidence:a"),
            )
        )
        second = point_event(
            payload=PointAwardedPayload(
                Team.A,
                ("evidence:a", "evidence:z"),
            )
        )
        self.assertEqual(first.payload.evidence_refs, ("evidence:a", "evidence:z"))
        self.assertEqual(encode_rule_event(first), encode_rule_event(second))
        self.assertEqual(first.fingerprint(), second.fingerprint())

    def test_contract_is_immutable_and_excludes_authorization_fields(self) -> None:
        event = point_event()
        with self.assertRaises(dataclasses.FrozenInstanceError):
            event.sequence_number = 2  # type: ignore[misc]
        field_names = {field.name for field in dataclasses.fields(RuleEvent)}
        self.assertTrue(
            {"actor_id", "authority", "authorization_id", "signature"}.isdisjoint(
                field_names
            )
        )
        payload_fields = {field.name for field in dataclasses.fields(PointAwardedPayload)}
        self.assertEqual(payload_fields, {"winner_team", "evidence_refs"})

    def test_duplicate_keys_are_rejected_at_any_object_level(self) -> None:
        raw = encode_rule_event(point_event()).decode("ascii")
        duplicate_top = raw.replace('"event_id":"event-1"', '"event_id":"x","event_id":"event-1"')
        self.assert_code(
            ContractErrorCode.DUPLICATE_KEY,
            lambda: parse_rule_event(duplicate_top),
        )
        duplicate_payload = raw.replace(
            '"winner_team":"A"', '"winner_team":"B","winner_team":"A"'
        )
        self.assert_code(
            ContractErrorCode.DUPLICATE_KEY,
            lambda: parse_rule_event(duplicate_payload),
        )

    def test_exact_top_level_and_payload_field_sets_are_required(self) -> None:
        wire = rule_event_to_dict(point_event())
        del wire["created_at_ns"]
        self.assert_code(
            ContractErrorCode.FIELD_SET,
            lambda: parse_rule_event(json.dumps(wire)),
        )
        wire = rule_event_to_dict(point_event())
        wire["unexpected"] = None
        self.assert_code(
            ContractErrorCode.FIELD_SET,
            lambda: parse_rule_event(json.dumps(wire)),
        )
        wire = rule_event_to_dict(point_event())
        wire["payload"]["next_serving_player"] = "a1"  # type: ignore[index]
        self.assert_code(
            ContractErrorCode.FIELD_SET,
            lambda: parse_rule_event(json.dumps(wire)),
        )

    def test_parser_enforces_raw_byte_bound_and_utf8(self) -> None:
        self.assert_code(
            ContractErrorCode.RAW_TOO_LARGE,
            lambda: parse_rule_event(b" " * (MAX_RAW_EVENT_BYTES + 1)),
        )
        self.assert_code(
            ContractErrorCode.RAW_TOO_LARGE,
            lambda: parse_rule_event("é" * (MAX_RAW_EVENT_BYTES // 2 + 1)),
        )
        self.assert_code(
            ContractErrorCode.INVALID_UTF8,
            lambda: parse_rule_event(b"\xff"),
        )
        self.assert_code(ContractErrorCode.RAW_TYPE, lambda: parse_rule_event({}))  # type: ignore[arg-type]

    def test_deep_json_fails_as_contract_error_not_recursion_error(self) -> None:
        deeply_nested = "[" * 5_000 + "0" + "]" * 5_000
        error = self.assert_code(
            ContractErrorCode.JSON_DEPTH_EXCEEDED,
            lambda: parse_rule_event(deeply_nested),
        )
        self.assertNotIsInstance(error.__cause__, RecursionError)  # boundary does not leak it

        malformed = "[" * 5_000
        try:
            parse_rule_event(malformed)
        except ContractError:
            pass
        except RecursionError as exc:  # pragma: no cover - security regression guard
            self.fail(f"parser leaked RecursionError: {exc}")

    def test_bool_is_not_accepted_as_an_integer(self) -> None:
        self.assert_code(
            ContractErrorCode.FIELD_TYPE,
            lambda: point_event(sequence_number=True),
        )
        self.assert_code(
            ContractErrorCode.FIELD_TYPE,
            lambda: SideSwitchConfirmedPayload(
                True,
                0,
                0,
                CourtSide.FAR,
                CourtSide.NEAR,
                ("frame:1",),
            ),
        )

    def test_ascii_and_text_bounds_are_enforced(self) -> None:
        self.assert_code(
            ContractErrorCode.FIELD_ASCII,
            lambda: point_event(event_id="événement"),
        )
        self.assert_code(
            ContractErrorCode.FIELD_ASCII,
            lambda: ReplayNoPointPayload("bad\nreason", ("frame:1",)),
        )
        self.assert_code(
            ContractErrorCode.FIELD_BOUNDS,
            lambda: ReplayNoPointPayload("x" * 513, ("frame:1",)),
        )
        self.assert_code(
            ContractErrorCode.FIELD_ASCII,
            lambda: PointAwardedPayload(Team.A, ("référence",)),
        )

    def test_evidence_count_is_bounded_and_unique(self) -> None:
        maximum = tuple(f"frame:{index}" for index in range(MAX_EVIDENCE_REFS))
        self.assertEqual(len(PointAwardedPayload(Team.A, maximum).evidence_refs), 64)
        self.assert_code(
            ContractErrorCode.FIELD_BOUNDS,
            lambda: PointAwardedPayload(
                Team.A,
                maximum + ("frame:overflow",),
            ),
        )
        self.assert_code(
            ContractErrorCode.FIELD_VALUE,
            lambda: PointAwardedPayload(Team.A, ("frame:1", "frame:1")),
        )

    def test_non_finite_and_floating_json_numbers_are_rejected(self) -> None:
        raw = encode_rule_event(point_event()).decode("ascii")
        for replacement in ("1.5", "NaN", "Infinity"):
            with self.subTest(replacement=replacement):
                changed = raw.replace('"sequence_number":1', f'"sequence_number":{replacement}')
                self.assert_code(
                    ContractErrorCode.INVALID_JSON,
                    lambda changed=changed: parse_rule_event(changed),
                )

    def test_event_payload_type_and_linkage_are_closed(self) -> None:
        self.assert_code(
            ContractErrorCode.PAYLOAD_EVENT_MISMATCH,
            lambda: point_event(payload=ReplayNoPointPayload("replay", ("frame:1",))),
        )
        self.assert_code(
            ContractErrorCode.RELATIONSHIP_INVALID,
            lambda: point_event(related_rally_id=None),
        )
        wire = rule_event_to_dict(point_event())
        wire["supersedes_event_id"] = "event-0"
        self.assert_code(
            ContractErrorCode.FIELD_SET,
            lambda: parse_rule_event(json.dumps(wire)),
        )

    def test_schema_and_event_type_are_closed(self) -> None:
        wire = rule_event_to_dict(point_event())
        wire["schema_version"] = "3.0"
        self.assert_code(
            ContractErrorCode.UNSUPPORTED_SCHEMA,
            lambda: parse_rule_event(json.dumps(wire)),
        )
        wire = rule_event_to_dict(point_event())
        wire["event_type"] = "PENALTY_POINT"
        self.assert_code(
            ContractErrorCode.UNSUPPORTED_EVENT_TYPE,
            lambda: parse_rule_event(json.dumps(wire)),
        )
        self.assertNotIn("SCORE_CORRECTION", RuleEventType.__members__)


if __name__ == "__main__":
    unittest.main()
