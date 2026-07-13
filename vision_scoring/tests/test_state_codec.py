from __future__ import annotations

import hashlib
import json
import unittest
from dataclasses import replace
from typing import Any

from vision_scoring.domain_events import (
    CourtSide,
    PointAwardedPayload,
    RuleEvent,
    RuleEventType,
    SetSeedPayload,
    SideSwitchConfirmedPayload,
    Team,
    TechnicalTimeoutCompletedPayload,
)
from vision_scoring.rules import DomainEffect, MatchState, RulesReducer, Ruleset, SetPhase
from vision_scoring.state_codec import (
    MAX_RAW_STATE_BYTES,
    StateCodecError,
    StateCodecErrorCode,
    decode_match_state,
    encode_match_state,
    match_state_fingerprint,
)


class _MatchFixture:
    def __init__(self, ruleset: Ruleset | None = None) -> None:
        self.ruleset = ruleset or Ruleset()
        self.reducer = RulesReducer(self.ruleset)
        self.state = self.reducer.new_match("match-1")
        self.counter = 0

    def apply(
        self,
        event_type: RuleEventType,
        payload: Any,
        *,
        set_number: int | None = None,
        rally_id: str | None = None,
    ) -> None:
        self.counter += 1
        current_number = self.state.current_set.number if self.state.current_set else 1
        event = RuleEvent(
            event_id=f"event-{self.counter}",
            sequence_number=self.state.revision + 1,
            match_id=self.state.match_id,
            set_number=set_number or current_number,
            event_type=event_type,
            ruleset_id=self.state.ruleset_id,
            ruleset_version=self.state.ruleset_version,
            ruleset_fingerprint=self.state.ruleset_fingerprint,
            payload=payload,
            created_at_ns=self.counter,
            related_rally_id=rally_id,
        )
        self.state = self.reducer.reduce(self.state, event).after

    def seed(self, *, set_number: int | None = None) -> None:
        number = set_number or (
            1 if self.state.current_set is None else self.state.current_set.number + 1
        )
        self.apply(
            RuleEventType.SET_SEED,
            SetSeedPayload(
                service_order_a=("a1", "a2"),
                service_order_b=("b1", "b2"),
                serving_team=Team.A,
                serving_player="a1",
                side_a=CourtSide.NEAR,
                side_b=CourtSide.FAR,
            ),
            set_number=number,
        )

    def point(self, winner: Team) -> None:
        next_number = self.counter + 1
        self.apply(
            RuleEventType.POINT_AWARDED,
            PointAwardedPayload(
                winner_team=winner,
                evidence_refs=(f"evidence-{next_number}",),
            ),
            rally_id=f"rally-{next_number}",
        )

    def win_current_set(self, winner: Team) -> None:
        current = self.state.current_set
        assert current is not None
        while current.phase is SetPhase.IN_PROGRESS:
            self.point(winner)
            current = self.state.current_set
            assert current is not None


class StateCodecTests(unittest.TestCase):
    def setUp(self) -> None:
        self.ruleset = Ruleset()
        fixture = _MatchFixture(self.ruleset)
        fixture.seed()
        fixture.point(Team.A)
        self.active_state = fixture.state

    @staticmethod
    def _canonical(data: Any) -> bytes:
        return json.dumps(data, sort_keys=True, separators=(",", ":")).encode("utf-8")

    def _data(self, state: MatchState | None = None) -> dict[str, Any]:
        return json.loads(
            encode_match_state(state or self.active_state, ruleset=self.ruleset)
        )

    def _assert_rejected(
        self,
        raw: bytes,
        code: StateCodecErrorCode | None = None,
        *,
        ruleset: Ruleset | None = None,
    ) -> None:
        with self.assertRaises(StateCodecError) as caught:
            decode_match_state(raw, ruleset=ruleset or self.ruleset)
        if code is not None:
            self.assertEqual(caught.exception.code, code.value)

    def _set_terminal_with_two_open_obligations(self) -> MatchState:
        fixture = _MatchFixture(self.ruleset)
        fixture.seed()
        for _ in range(20):
            fixture.point(Team.A)
            fixture.point(Team.B)
        fixture.point(Team.A)
        fixture.point(Team.A)
        self.assertIs(fixture.state.current_set.phase, SetPhase.COMPLETE)
        return fixture.state

    def _match_terminal(self) -> MatchState:
        fixture = _MatchFixture(self.ruleset)
        fixture.seed()
        fixture.win_current_set(Team.A)
        fixture.seed(set_number=2)
        fixture.win_current_set(Team.A)
        self.assertIs(fixture.state.match_winner, Team.A)
        return fixture.state

    def test_roundtrips_initial_active_set_terminal_and_match_terminal_states(self) -> None:
        initial = RulesReducer(self.ruleset).new_match("match-1")
        set_terminal = self._set_terminal_with_two_open_obligations()
        match_terminal = self._match_terminal()
        for state in (initial, self.active_state, set_terminal, match_terminal):
            with self.subTest(revision=state.revision, winner=state.match_winner):
                encoded = encode_match_state(state, ruleset=self.ruleset)
                decoded = decode_match_state(encoded, ruleset=self.ruleset)
                self.assertEqual(decoded, state)
                self.assertEqual(
                    encode_match_state(decoded, ruleset=self.ruleset),
                    encoded,
                )

    def test_roundtrips_confirmed_side_switch_and_timeout_audit(self) -> None:
        fixture = _MatchFixture(self.ruleset)
        fixture.seed()
        for _ in range(10):
            fixture.point(Team.A)
            fixture.point(Team.B)
        fixture.point(Team.A)
        current = fixture.state.current_set
        assert current is not None
        fixture.apply(
            RuleEventType.SIDE_SWITCH_CONFIRMED,
            SideSwitchConfirmedPayload(
                due_total=7,
                observed_at_total=21,
                cleared_through_total=21,
                observed_side_a=current.side_b,
                observed_side_b=current.side_a,
                evidence_refs=("side-evidence",),
            ),
        )
        fixture.apply(
            RuleEventType.TECHNICAL_TIMEOUT_COMPLETED,
            TechnicalTimeoutCompletedPayload(
                due_total=21,
                observed_at_total=21,
                evidence_refs=("timeout-evidence",),
            ),
        )
        encoded = encode_match_state(fixture.state, ruleset=self.ruleset)
        self.assertEqual(
            decode_match_state(encoded, ruleset=self.ruleset),
            fixture.state,
        )

    def test_custom_ruleset_is_caller_supplied_and_exactly_bound(self) -> None:
        custom = Ruleset(
            ruleset_id="LOCAL_RULES",
            version="1",
            reducer_semantics_version="local-v1",
            best_of_sets=1,
            regular_set_target=5,
            deciding_set_target=3,
            win_by=2,
            regular_side_switch_interval=3,
            deciding_side_switch_interval=2,
            regular_technical_timeout_total=None,
        )
        fixture = _MatchFixture(custom)
        fixture.seed()
        fixture.win_current_set(Team.B)
        encoded = encode_match_state(fixture.state, ruleset=custom)
        self.assertEqual(decode_match_state(encoded, ruleset=custom), fixture.state)
        self._assert_rejected(encoded, StateCodecErrorCode.INVARIANT)
        with self.assertRaises(StateCodecError):
            encode_match_state(fixture.state, ruleset=self.ruleset)

    def test_fingerprint_is_sha256_of_canonical_bytes(self) -> None:
        encoded = encode_match_state(self.active_state, ruleset=self.ruleset)
        self.assertEqual(
            match_state_fingerprint(self.active_state, ruleset=self.ruleset),
            hashlib.sha256(encoded).hexdigest(),
        )

    def test_domain_effect_frozenset_is_canonical_sorted(self) -> None:
        state = self._set_terminal_with_two_open_obligations()
        data = self._data(state)
        effects = data["completed_sets"][0]["unresolved_obligations"]
        self.assertEqual(
            effects,
            ["SIDE_SWITCH_DUE", "TECHNICAL_TIMEOUT_DUE"],
        )
        data["completed_sets"][0]["unresolved_obligations"] = list(reversed(effects))
        self._assert_rejected(
            self._canonical(data),
            StateCodecErrorCode.NON_CANONICAL,
        )

    def test_rejects_wrong_raw_type_size_utf8_and_top_level(self) -> None:
        with self.assertRaises(StateCodecError) as caught:
            decode_match_state("{}", ruleset=self.ruleset)  # type: ignore[arg-type]
        self.assertEqual(caught.exception.code, StateCodecErrorCode.RAW_TYPE.value)
        self._assert_rejected(
            b" " * (MAX_RAW_STATE_BYTES + 1),
            StateCodecErrorCode.RAW_TOO_LARGE,
        )
        self._assert_rejected(b"\xff", StateCodecErrorCode.INVALID_UTF8)
        self._assert_rejected(b"[]", StateCodecErrorCode.TOP_LEVEL_TYPE)

    def test_rejects_duplicate_keys_at_every_object_level(self) -> None:
        raw = encode_match_state(self.active_state, ruleset=self.ruleset)
        duplicate_top = b'{"match_id":"duplicate",' + raw[1:]
        self._assert_rejected(duplicate_top, StateCodecErrorCode.DUPLICATE_KEY)
        duplicate_nested = raw.replace(
            b'"number":1,',
            b'"number":1,"number":1,',
            1,
        )
        self._assert_rejected(duplicate_nested, StateCodecErrorCode.DUPLICATE_KEY)

    def test_rejects_deep_input_without_recursion_error(self) -> None:
        raw = b"[" * 2_000 + b"0" + b"]" * 2_000
        self._assert_rejected(raw, StateCodecErrorCode.JSON_DEPTH_EXCEEDED)

    def test_rejects_floats_nonfinite_and_out_of_signed64(self) -> None:
        data = self._data()
        data["team_a_sets"] = 0.0
        self._assert_rejected(self._canonical(data), StateCodecErrorCode.INVALID_JSON)
        raw = encode_match_state(self.active_state, ruleset=self.ruleset).replace(
            b'"team_a_sets":0',
            b'"team_a_sets":NaN',
        )
        self._assert_rejected(raw, StateCodecErrorCode.INVALID_JSON)
        data = self._data()
        data["last_sequence_number"] = 1 << 63
        self._assert_rejected(self._canonical(data), StateCodecErrorCode.INVALID_JSON)

    def test_rejects_noncanonical_whitespace_and_unknown_recursive_data(self) -> None:
        raw = encode_match_state(self.active_state, ruleset=self.ruleset)
        self._assert_rejected(raw + b"\n", StateCodecErrorCode.NON_CANONICAL)
        data = self._data()
        data["current_set"]["metadata"] = {"arbitrary": [1, 2, 3]}
        self._assert_rejected(self._canonical(data), StateCodecErrorCode.FIELD_SET)
        data = self._data()
        data["corrected_event_ids"] = []
        self._assert_rejected(self._canonical(data), StateCodecErrorCode.FIELD_SET)

    def test_rejects_wrong_field_types_ascii_ids_hashes_and_collection_bounds(self) -> None:
        cases: list[tuple[str, Any, StateCodecErrorCode]] = []

        data = self._data()
        data["team_a_sets"] = False
        cases.append(("bool counter", data, StateCodecErrorCode.FIELD_TYPE))

        data = self._data()
        data["match_id"] = "mátch"
        cases.append(("unicode id", data, StateCodecErrorCode.FIELD_ASCII))

        data = self._data()
        data["ruleset_fingerprint"] = "A" * 64
        cases.append(("uppercase hash", data, StateCodecErrorCode.FIELD_VALUE))

        data = self._data()
        data["applied_events"] = [{}] * 4_097
        cases.append(("event count", data, StateCodecErrorCode.FIELD_BOUNDS))

        data = self._data()
        data["completed_sets"] = [{}] * 100
        cases.append(("set count", data, StateCodecErrorCode.FIELD_BOUNDS))

        for name, data, code in cases:
            with self.subTest(name=name):
                self._assert_rejected(self._canonical(data), code)

    def test_rejects_tampered_current_set_invariants(self) -> None:
        mutations = {
            "set order": lambda d: d["current_set"].__setitem__("number", 2),
            "target": lambda d: d["current_set"].__setitem__("target_points", 15),
            "same side": lambda d: d["current_set"].__setitem__("side_b", "NEAR"),
            "duplicate player": lambda d: d["current_set"]["service_order_b"].__setitem__(0, "a1"),
            "wrong team player": lambda d: d["current_set"].__setitem__("serving_player", "b1"),
            "next server": lambda d: d["current_set"].__setitem__("next_server_index_a", 0),
            "terminal phase": lambda d: d["current_set"].__setitem__("phase", "COMPLETE"),
            "terminal active score": lambda d: d["current_set"].update(
                {"team_a_points": 21, "team_b_points": 0}
            ),
            "switch total": lambda d: d["current_set"].__setitem__(
                "last_side_switch_total", 1
            ),
            "premature timeout": lambda d: d["current_set"].__setitem__(
                "technical_timeout_completed", True
            ),
            "premature winner": lambda d: d.__setitem__("match_winner", "A"),
        }
        for name, mutate in mutations.items():
            data = self._data()
            mutate(data)
            with self.subTest(name=name):
                self._assert_rejected(self._canonical(data))

    def test_rejects_terminal_operations_at_the_terminal_point(self) -> None:
        fixture = _MatchFixture(self.ruleset)
        fixture.seed()
        fixture.win_current_set(Team.A)

        data = self._data(fixture.state)
        data["current_set"]["last_side_switch_total"] = 21
        self._assert_rejected(self._canonical(data), StateCodecErrorCode.INVARIANT)

        data = self._data(fixture.state)
        data["current_set"]["technical_timeout_completed"] = True
        self._assert_rejected(self._canonical(data), StateCodecErrorCode.INVARIANT)

    def test_rejects_tampered_completed_set_and_match_totals(self) -> None:
        one_set_fixture = _MatchFixture(self.ruleset)
        one_set_fixture.seed()
        one_set_fixture.win_current_set(Team.A)

        cases: list[tuple[str, dict[str, Any]]] = []
        data = self._data(one_set_fixture.state)
        data["completed_sets"][0]["set_number"] = 2
        cases.append(("result order", data))

        data = self._data(one_set_fixture.state)
        data["completed_sets"][0]["winner"] = "B"
        cases.append(("result winner", data))

        data = self._data(one_set_fixture.state)
        data["completed_sets"][0]["team_a_points"] = 1
        data["current_set"]["team_a_points"] = 1
        cases.append(("one point set", data))

        data = self._data(one_set_fixture.state)
        data["team_a_sets"] = 0
        cases.append(("set totals", data))

        data = self._data(one_set_fixture.state)
        data["match_winner"] = "A"
        cases.append(("winner after one set", data))

        match_terminal = self._match_terminal()
        data = self._data(match_terminal)
        data["match_winner"] = "B"
        cases.append(("wrong match winner", data))

        data = self._data(one_set_fixture.state)
        data["completed_sets"][0]["unresolved_obligations"] = ["MATCH_COMPLETE"]
        cases.append(("non-obligation effect", data))

        for name, data in cases:
            with self.subTest(name=name):
                self._assert_rejected(self._canonical(data))

    def test_rejects_event_revision_identity_order_and_fingerprint_tampering(self) -> None:
        mutations = {
            "revision": lambda d: d.__setitem__("last_sequence_number", 1),
            "duplicate id": lambda d: d["applied_events"][1].__setitem__(
                "event_id", d["applied_events"][0]["event_id"]
            ),
            "duplicate fingerprint": lambda d: d["applied_events"][1].__setitem__(
                "fingerprint", d["applied_events"][0]["fingerprint"]
            ),
            "invalid fingerprint": lambda d: d["applied_events"][1].__setitem__(
                "fingerprint", "0" * 63
            ),
            "event set order": lambda d: d["applied_events"][1].__setitem__(
                "set_number", 2
            ),
            "seed order": lambda d: d["applied_events"][0].__setitem__(
                "set_number", 2
            ),
            "seed rally": lambda d: d["applied_events"][0].__setitem__(
                "resolution_rally_id", "rally-seed"
            ),
            "point rally": lambda d: d["applied_events"][1].__setitem__(
                "resolution_rally_id", None
            ),
        }
        for name, mutate in mutations.items():
            data = self._data()
            mutate(data)
            with self.subTest(name=name):
                self._assert_rejected(self._canonical(data))

    def test_rejects_rally_mapping_tampering_and_point_count_mismatch(self) -> None:
        cases: list[tuple[str, dict[str, Any]]] = []
        data = self._data()
        data["rally_resolutions"][0]["event_id"] = "event-1"
        cases.append(("wrong mapping event", data))

        data = self._data()
        data["rally_resolutions"].append(dict(data["rally_resolutions"][0]))
        cases.append(("duplicate mapping", data))

        data = self._data()
        data["current_set"]["team_a_points"] = 0
        cases.append(("point total", data))

        for name, data in cases:
            with self.subTest(name=name):
                self._assert_rejected(self._canonical(data), StateCodecErrorCode.INVARIANT)

    def test_encoder_rejects_forged_in_memory_state(self) -> None:
        current = self.active_state.current_set
        assert current is not None
        forged = replace(
            self.active_state,
            current_set=replace(current, side_b=current.side_a),
        )
        with self.assertRaises(StateCodecError):
            encode_match_state(forged, ruleset=self.ruleset)

        wrong_collection = replace(
            self.active_state,
            applied_events=list(self.active_state.applied_events),  # type: ignore[arg-type]
        )
        with self.assertRaises(StateCodecError):
            encode_match_state(wrong_collection, ruleset=self.ruleset)


if __name__ == "__main__":
    unittest.main()
