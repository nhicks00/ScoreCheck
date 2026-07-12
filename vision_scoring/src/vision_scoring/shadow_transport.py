"""Bounded authenticated transport contracts for shadow outbox-v2 messages.

This module proves two deliberately narrow facts:

* the payload is the exact canonical shape emitted by the vision ledger's
  ``vision_scoring.shadow.authorized_event.v2`` outbox; and
* a currently trusted dispatcher key signed an exact delivery attempt.

Neither fact grants scoring authority.  There is intentionally no database,
network, filesystem, process, event-store, or ScoreCheck mutation integration
in this module.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import json
import re
from dataclasses import dataclass
from typing import Any, NoReturn

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import (
    Ed25519PrivateKey,
    Ed25519PublicKey,
)


SHADOW_OUTBOX_SCHEMA_VERSION = "2.0"
SHADOW_OUTBOX_TOPIC = "vision_scoring.shadow.authorized_event.v2"
SHADOW_OUTBOX_TARGET = "SHADOW_ONLY_NO_OFFICIAL_SCORECHECK_MUTATION"
SHADOW_DISPATCH_SCHEMA_VERSION = "1.0"
SHADOW_DISPATCH_ALGORITHM = "Ed25519"

MAX_SHADOW_OUTBOX_PAYLOAD_BYTES = 16 * 1024
MAX_SHADOW_DISPATCH_ENVELOPE_BYTES = 32 * 1024
MAX_SIGNED_64 = (1 << 63) - 1
MAX_STABLE_ID_LENGTH = 128
MAX_DOMAIN_ID_LENGTH = 128
MAX_MESSAGE_ID_LENGTH = 192
MAX_REASON_LENGTH = 512
MAX_EVIDENCE_COUNT = 64
MAX_JSON_DEPTH = 16
MAX_JSON_NODES = 512
MAX_JSON_CONTAINERS = 128
MAX_REVIEW_POSITION = 3_072
MAX_DISPATCH_KEYS = 64

# Public constants make the security boundary machine-checkable by consumers.
DELIVERY_ATTRIBUTION_ONLY = True
OFFICIAL_SCORE_AUTHORITY_GRANTED = False

_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
_STABLE_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$")
_DISPATCH_SIGNING_DOMAIN = (
    b"multicourt-vision-scoring:shadow-dispatch-envelope:v1\x00"
)
_EVIDENCE_SET_DOMAIN = (
    b"multicourt-vision-scoring:outbox-evidence-set:v1\x00"
)

_PAYLOAD_FIELDS = frozenset(
    {
        "adopted_archive_fingerprint",
        "appended_at_ns",
        "authorization_record_fingerprint",
        "envelope_fingerprint",
        "event_fingerprint",
        "event_id",
        "event_summary",
        "match_id",
        "message_id",
        "official_scorecheck_mutation_permitted",
        "outbox_id",
        "post_state_summary",
        "reducer_build_sha256",
        "revision",
        "ruleset_fingerprint",
        "ruleset_id",
        "ruleset_version",
        "review_authorization_context_fingerprint",
        "review_history_head_sha256",
        "review_position",
        "schema_version",
        "scorer_copilot_case_fingerprint",
        "scorer_copilot_case_link_fingerprint",
        "scorer_copilot_signed_case_fingerprint",
        "state_fingerprint",
        "target",
        "topic",
    }
)
_EVENT_SUMMARY_FIELDS = frozenset(
    {
        "domain_fields",
        "evidence_count",
        "evidence_refs_fingerprint",
        "event_type",
        "outcome",
        "replay_reason",
    }
)
_POST_STATE_FIELDS = frozenset(
    {
        "current_set",
        "last_completed_set",
        "match_winner",
        "team_a_sets",
        "team_b_sets",
    }
)
_CURRENT_SET_FIELDS = frozenset(
    {
        "number",
        "phase",
        "serving_player",
        "serving_team",
        "team_a_points",
        "team_b_points",
    }
)
_LAST_COMPLETED_SET_FIELDS = frozenset(
    {"number", "team_a_points", "team_b_points", "winner"}
)
_DISPATCH_FIELDS = frozenset(
    {
        "algorithm",
        "attempt_id",
        "dispatcher_id",
        "dispatcher_key_id",
        "expires_at_ns",
        "message_id",
        "outbox_id",
        "payload_base64",
        "payload_sha256",
        "schema_version",
        "signature_base64",
        "signed_at_ns",
        "source_ledger_id",
    }
)


class ShadowTransportError(ValueError):
    """A fail-closed transport-contract failure with a stable code."""

    def __init__(self, code: str, message: str) -> None:
        self.code = code
        super().__init__(f"{code}: {message}")


def _fail(code: str, message: str) -> NoReturn:
    raise ShadowTransportError(code, message)


def _stable_id(value: object, name: str) -> str:
    if type(value) is not str or _STABLE_ID_RE.fullmatch(value) is None:
        _fail("FIELD_VALUE", f"{name} must be an ASCII stable ID")
    return value


def _domain_id(value: object, name: str) -> str:
    """Mirror the committed RuleEvent/Ruleset printable-ASCII ID grammar."""

    if (
        type(value) is not str
        or not 1 <= len(value) <= MAX_DOMAIN_ID_LENGTH
        or not value.isascii()
        or any(ord(character) < 0x21 or ord(character) > 0x7E for character in value)
    ):
        _fail("FIELD_VALUE", f"{name} must be bounded printable non-whitespace ASCII")
    return value


def _message_id(value: object) -> str:
    if (
        type(value) is not str
        or not 1 <= len(value) <= MAX_MESSAGE_ID_LENGTH
        or not value.isascii()
        or any(ord(character) < 0x21 or ord(character) > 0x7E for character in value)
    ):
        _fail("FIELD_VALUE", "message_id must be bounded printable ASCII")
    return value


def _sha256(value: object, name: str) -> str:
    if type(value) is not str or _SHA256_RE.fullmatch(value) is None:
        _fail("FIELD_VALUE", f"{name} must be a lowercase SHA-256")
    return value


def _exact_int(
    value: object,
    name: str,
    *,
    minimum: int = 0,
    maximum: int = MAX_SIGNED_64,
) -> int:
    if type(value) is not int:
        _fail("FIELD_TYPE", f"{name} must be an exact integer")
    if not minimum <= value <= maximum:
        _fail("FIELD_BOUNDS", f"{name} is outside its signed-64 bound")
    return value


def _literal(value: object, expected: str, name: str) -> str:
    if type(value) is not str or value != expected:
        _fail("FIELD_VALUE", f"{name} must equal {expected!r}")
    return value


def _nullable_literal(value: object, allowed: frozenset[str], name: str) -> str | None:
    if value is None:
        return None
    if type(value) is not str or value not in allowed:
        _fail("FIELD_VALUE", f"{name} has an unsupported value")
    return value


def _ascii_text(value: object, name: str, maximum: int) -> str:
    if (
        type(value) is not str
        or not 1 <= len(value) <= maximum
        or value != value.strip()
        or not value.isascii()
        or any(ord(character) < 0x20 or ord(character) > 0x7E for character in value)
    ):
        _fail("FIELD_VALUE", f"{name} must be bounded printable ASCII")
    return value


def _exact_dict(
    value: object,
    expected: frozenset[str],
    name: str,
) -> dict[str, object]:
    if type(value) is not dict:
        _fail("FIELD_TYPE", f"{name} must be an exact object")
    present = frozenset(value)
    if present != expected:
        _fail(
            "FIELD_SET",
            f"{name} fields differ; missing={sorted(expected - present)!r} "
            f"unknown={sorted(present - expected)!r}",
        )
    return value


class _DuplicateKey(ValueError):
    pass


class _JsonNumber(ValueError):
    pass


def _object_pairs(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise _DuplicateKey(key)
        result[key] = value
    return result


def _parse_int(token: str) -> int:
    digits = token[1:] if token.startswith("-") else token
    if len(digits) > 19:
        raise _JsonNumber("integer exceeds signed-64 syntax bound")
    value = int(token)
    if not -MAX_SIGNED_64 - 1 <= value <= MAX_SIGNED_64:
        raise _JsonNumber("integer exceeds signed-64 value bound")
    return value


def _reject_number(token: str) -> object:
    raise _JsonNumber(f"unsupported JSON number {token!r}")


def _validate_json_shape(value: object, label: str) -> None:
    stack: list[tuple[object, int]] = [(value, 0)]
    nodes = 0
    containers = 0
    while stack:
        current, parent_depth = stack.pop()
        nodes += 1
        if nodes > MAX_JSON_NODES:
            _fail("JSON_NODES", f"{label} exceeds its JSON node bound")
        if type(current) is dict or type(current) is list:
            containers += 1
            depth = parent_depth + 1
            if depth > MAX_JSON_DEPTH:
                _fail("JSON_DEPTH", f"{label} exceeds its JSON depth bound")
            if containers > MAX_JSON_CONTAINERS:
                _fail("JSON_CONTAINERS", f"{label} exceeds its container bound")
            children = current.values() if type(current) is dict else current
            stack.extend((child, depth) for child in children)


def _canonical_json(value: object, *, maximum: int, label: str) -> bytes:
    try:
        raw = json.dumps(
            value,
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=True,
            allow_nan=False,
        ).encode("ascii")
    except (TypeError, ValueError, UnicodeEncodeError) as exc:
        raise ShadowTransportError(
            "ENCODING", f"{label} must be finite canonical ASCII JSON"
        ) from exc
    if not 1 <= len(raw) <= maximum:
        _fail("RAW_SIZE", f"{label} exceeds its encoded byte bound")
    return raw


def _load_json(raw: bytes, *, maximum: int, label: str) -> dict[str, object]:
    if type(raw) is not bytes:
        _fail("RAW_TYPE", f"{label} must be exact bytes")
    if not 1 <= len(raw) <= maximum:
        _fail("RAW_SIZE", f"{label} must contain 1..{maximum} bytes")
    try:
        text = raw.decode("ascii", errors="strict")
    except UnicodeDecodeError as exc:
        raise ShadowTransportError(
            "INVALID_ASCII", f"{label} must be ASCII JSON"
        ) from exc
    try:
        value = json.loads(
            text,
            object_pairs_hook=_object_pairs,
            parse_int=_parse_int,
            parse_float=_reject_number,
            parse_constant=_reject_number,
        )
    except _DuplicateKey as exc:
        raise ShadowTransportError(
            "DUPLICATE_KEY", f"{label} contains duplicate key {exc}"
        ) from exc
    except _JsonNumber as exc:
        raise ShadowTransportError("JSON_NUMBER", str(exc)) from exc
    except RecursionError as exc:
        raise ShadowTransportError(
            "JSON_DEPTH", f"{label} exceeds parser nesting limits"
        ) from exc
    except json.JSONDecodeError as exc:
        raise ShadowTransportError("INVALID_JSON", f"{label} is invalid JSON") from exc
    if type(value) is not dict:
        _fail("TOP_LEVEL_TYPE", f"{label} must be an object")
    _validate_json_shape(value, label)
    return value


def _canonical_base64(
    value: object,
    name: str,
    *,
    expected_size: int | None = None,
    maximum_size: int | None = None,
) -> bytes:
    if type(value) is not str or not value:
        _fail("FIELD_VALUE", f"{name} must be canonical base64")
    try:
        raw = base64.b64decode(value.encode("ascii"), validate=True)
    except (UnicodeEncodeError, binascii.Error, ValueError) as exc:
        raise ShadowTransportError(
            "FIELD_VALUE", f"{name} must be canonical base64"
        ) from exc
    if base64.b64encode(raw).decode("ascii") != value:
        _fail("FIELD_VALUE", f"{name} must be canonical base64")
    if expected_size is not None and len(raw) != expected_size:
        _fail("FIELD_BOUNDS", f"{name} must encode exactly {expected_size} bytes")
    if maximum_size is not None and not 1 <= len(raw) <= maximum_size:
        _fail("FIELD_BOUNDS", f"{name} exceeds its decoded byte bound")
    return raw


def _empty_evidence_fingerprint() -> str:
    return hashlib.sha256(_EVIDENCE_SET_DOMAIN + b"[]").hexdigest()


def _validate_set_seed(summary: dict[str, object], domain: dict[str, object]) -> None:
    expected = frozenset(
        {
            "service_order_a",
            "service_order_b",
            "serving_player",
            "serving_team",
            "side_a",
            "side_b",
        }
    )
    _exact_dict(domain, expected, "event_summary.domain_fields")
    orders: list[str] = []
    for field in ("service_order_a", "service_order_b"):
        value = domain[field]
        if type(value) is not list or len(value) != 2:
            _fail("FIELD_TYPE", f"domain_fields.{field} must be a two-item array")
        validated = [_domain_id(item, f"domain_fields.{field}") for item in value]
        if len(set(validated)) != 2:
            _fail("FIELD_VALUE", f"domain_fields.{field} players must be distinct")
        orders.extend(validated)
    if len(set(orders)) != 4:
        _fail("FIELD_VALUE", "set-seed player identities must be distinct")
    serving_team = domain["serving_team"]
    if type(serving_team) is not str or serving_team not in {"A", "B"}:
        _fail("FIELD_VALUE", "domain_fields.serving_team must be A or B")
    serving_player = _domain_id(
        domain["serving_player"], "domain_fields.serving_player"
    )
    expected_server = orders[0] if serving_team == "A" else orders[2]
    if serving_player != expected_server:
        _fail("FIELD_VALUE", "serving_player must lead the serving team's order")
    side_a = domain["side_a"]
    side_b = domain["side_b"]
    if type(side_a) is not str or type(side_b) is not str:
        _fail("FIELD_TYPE", "set-seed sides must be strings")
    if {side_a, side_b} != {"NEAR", "FAR"}:
        _fail("FIELD_VALUE", "set-seed teams must occupy opposite court sides")
    if summary["evidence_count"] != 0:
        _fail("FIELD_VALUE", "SET_SEED must have zero evidence references")
    if summary["evidence_refs_fingerprint"] != _empty_evidence_fingerprint():
        _fail("FIELD_VALUE", "SET_SEED must bind the empty evidence set")
    if summary["outcome"] is not None or summary["replay_reason"] is not None:
        _fail("FIELD_VALUE", "SET_SEED cannot claim a rally outcome")


def _validate_event_summary(value: object) -> str:
    summary = _exact_dict(value, _EVENT_SUMMARY_FIELDS, "event_summary")
    evidence_count = _exact_int(
        summary["evidence_count"],
        "event_summary.evidence_count",
        maximum=MAX_EVIDENCE_COUNT,
    )
    _sha256(
        summary["evidence_refs_fingerprint"],
        "event_summary.evidence_refs_fingerprint",
    )
    event_type = summary["event_type"]
    if type(event_type) is not str:
        _fail("FIELD_TYPE", "event_summary.event_type must be a string")
    domain = summary["domain_fields"]
    if type(domain) is not dict:
        _fail("FIELD_TYPE", "event_summary.domain_fields must be an object")

    if event_type == "SET_SEED":
        _validate_set_seed(summary, domain)
    elif event_type == "POINT_AWARDED":
        _exact_dict(domain, frozenset({"winner_team"}), "event_summary.domain_fields")
        winner = domain["winner_team"]
        if type(winner) is not str or winner not in {"A", "B"}:
            _fail("FIELD_VALUE", "point winner_team must be A or B")
        if evidence_count < 1:
            _fail("FIELD_VALUE", "POINT_AWARDED requires evidence")
        if summary["outcome"] != f"POINT_TEAM_{winner}":
            _fail("FIELD_VALUE", "point outcome does not match winner_team")
        if summary["replay_reason"] is not None:
            _fail("FIELD_VALUE", "POINT_AWARDED cannot carry replay_reason")
    elif event_type == "REPLAY_NO_POINT":
        _exact_dict(domain, frozenset({"reason"}), "event_summary.domain_fields")
        reason = _ascii_text(domain["reason"], "domain_fields.reason", MAX_REASON_LENGTH)
        if evidence_count < 1:
            _fail("FIELD_VALUE", "REPLAY_NO_POINT requires evidence")
        if summary["outcome"] != "REPLAY_NO_POINT" or summary["replay_reason"] != reason:
            _fail("FIELD_VALUE", "replay summary does not match its reason/outcome")
    elif event_type == "SIDE_SWITCH_CONFIRMED":
        _exact_dict(
            domain,
            frozenset(
                {
                    "cleared_through_total",
                    "due_total",
                    "observed_at_total",
                    "observed_side_a",
                    "observed_side_b",
                }
            ),
            "event_summary.domain_fields",
        )
        for name in ("cleared_through_total", "due_total", "observed_at_total"):
            _exact_int(domain[name], f"domain_fields.{name}")
        side_a = domain["observed_side_a"]
        side_b = domain["observed_side_b"]
        if type(side_a) is not str or type(side_b) is not str or {side_a, side_b} != {"NEAR", "FAR"}:
            _fail("FIELD_VALUE", "observed teams must occupy opposite court sides")
        if evidence_count < 1:
            _fail("FIELD_VALUE", "SIDE_SWITCH_CONFIRMED requires evidence")
        if summary["outcome"] is not None or summary["replay_reason"] is not None:
            _fail("FIELD_VALUE", "side-switch event cannot claim a rally outcome")
    elif event_type == "TECHNICAL_TIMEOUT_COMPLETED":
        _exact_dict(
            domain,
            frozenset({"due_total", "observed_at_total"}),
            "event_summary.domain_fields",
        )
        _exact_int(domain["due_total"], "domain_fields.due_total")
        _exact_int(domain["observed_at_total"], "domain_fields.observed_at_total")
        if evidence_count < 1:
            _fail("FIELD_VALUE", "TECHNICAL_TIMEOUT_COMPLETED requires evidence")
        if summary["outcome"] is not None or summary["replay_reason"] is not None:
            _fail("FIELD_VALUE", "timeout event cannot claim a rally outcome")
    else:
        _fail("UNSUPPORTED_EVENT_TYPE", "event_summary.event_type is unsupported")
    return event_type


def _validate_post_state(value: object) -> None:
    state = _exact_dict(value, _POST_STATE_FIELDS, "post_state_summary")
    _exact_int(state["team_a_sets"], "post_state_summary.team_a_sets")
    _exact_int(state["team_b_sets"], "post_state_summary.team_b_sets")
    _nullable_literal(
        state["match_winner"], frozenset({"A", "B"}), "post_state_summary.match_winner"
    )
    current = state["current_set"]
    if current is not None:
        current = _exact_dict(current, _CURRENT_SET_FIELDS, "post_state_summary.current_set")
        _exact_int(current["number"], "current_set.number", minimum=1, maximum=99)
        if type(current["phase"]) is not str or current["phase"] not in {
            "IN_PROGRESS",
            "COMPLETE",
        }:
            _fail("FIELD_VALUE", "current_set.phase is unsupported")
        _domain_id(current["serving_player"], "current_set.serving_player")
        if type(current["serving_team"]) is not str or current["serving_team"] not in {"A", "B"}:
            _fail("FIELD_VALUE", "current_set.serving_team must be A or B")
        _exact_int(current["team_a_points"], "current_set.team_a_points")
        _exact_int(current["team_b_points"], "current_set.team_b_points")
    completed = state["last_completed_set"]
    if completed is not None:
        completed = _exact_dict(
            completed,
            _LAST_COMPLETED_SET_FIELDS,
            "post_state_summary.last_completed_set",
        )
        _exact_int(completed["number"], "last_completed_set.number", minimum=1, maximum=99)
        _exact_int(completed["team_a_points"], "last_completed_set.team_a_points")
        _exact_int(completed["team_b_points"], "last_completed_set.team_b_points")
        if type(completed["winner"]) is not str or completed["winner"] not in {"A", "B"}:
            _fail("FIELD_VALUE", "last_completed_set.winner must be A or B")


@dataclass(frozen=True, slots=True)
class ValidatedShadowOutboxMessage:
    """Validated identity of exact outbox bytes; no delivery or score authority."""

    payload_bytes: bytes
    payload_sha256: str
    message_id: str
    outbox_id: int
    match_id: str
    event_id: str
    revision: int
    appended_at_ns: int
    event_type: str
    scorer_copilot_case_fingerprint: str | None
    scorer_copilot_signed_case_fingerprint: str | None
    scorer_copilot_case_link_fingerprint: str | None
    review_authorization_context_fingerprint: str | None

    @property
    def official_score_authority_granted(self) -> bool:
        return False


def parse_shadow_outbox_payload(raw: bytes) -> ValidatedShadowOutboxMessage:
    """Parse and fully validate exact canonical outbox-v2 payload bytes."""

    data = _exact_dict(
        _load_json(raw, maximum=MAX_SHADOW_OUTBOX_PAYLOAD_BYTES, label="shadow payload"),
        _PAYLOAD_FIELDS,
        "shadow payload",
    )
    if _canonical_json(
        data, maximum=MAX_SHADOW_OUTBOX_PAYLOAD_BYTES, label="shadow payload"
    ) != raw:
        _fail("NON_CANONICAL", "shadow payload must be canonical ASCII JSON")

    _literal(data["schema_version"], SHADOW_OUTBOX_SCHEMA_VERSION, "schema_version")
    _literal(data["topic"], SHADOW_OUTBOX_TOPIC, "topic")
    _literal(data["target"], SHADOW_OUTBOX_TARGET, "target")
    if type(data["official_scorecheck_mutation_permitted"]) is not bool:
        _fail("FIELD_TYPE", "official_scorecheck_mutation_permitted must be an exact bool")
    if data["official_scorecheck_mutation_permitted"]:
        _fail("MUTATION_FORBIDDEN", "shadow payload must forbid official ScoreCheck mutation")

    match_id = _stable_id(data["match_id"], "match_id")
    event_id = _domain_id(data["event_id"], "event_id")
    _domain_id(data["ruleset_id"], "ruleset_id")
    _domain_id(data["ruleset_version"], "ruleset_version")
    message_id = _message_id(data["message_id"])
    outbox_id = _exact_int(data["outbox_id"], "outbox_id", minimum=1)
    revision = _exact_int(data["revision"], "revision", minimum=1)
    appended_at_ns = _exact_int(data["appended_at_ns"], "appended_at_ns")
    review_position = _exact_int(
        data["review_position"],
        "review_position",
        maximum=MAX_REVIEW_POSITION,
    )
    expected_message_id = f"shadow:{outbox_id}:{event_id}"
    if message_id != expected_message_id:
        _fail("IDENTITY_MISMATCH", "message_id does not bind outbox_id and event_id")

    for name in (
        "adopted_archive_fingerprint",
        "authorization_record_fingerprint",
        "envelope_fingerprint",
        "event_fingerprint",
        "reducer_build_sha256",
        "review_history_head_sha256",
        "ruleset_fingerprint",
        "state_fingerprint",
    ):
        _sha256(data[name], name)

    copilot_names = (
        "scorer_copilot_case_fingerprint",
        "scorer_copilot_signed_case_fingerprint",
        "scorer_copilot_case_link_fingerprint",
        "review_authorization_context_fingerprint",
    )
    copilot_values = tuple(data[name] for name in copilot_names)
    if any(value is None for value in copilot_values) != all(
        value is None for value in copilot_values
    ):
        _fail("COPILOT_IDENTITY_SET", "copilot fingerprints must be all present or all absent")
    if copilot_values[0] is not None:
        for name, value in zip(copilot_names, copilot_values):
            _sha256(value, name)

    event_type = _validate_event_summary(data["event_summary"])
    if copilot_values[0] is not None and (
        event_type not in {"POINT_AWARDED", "REPLAY_NO_POINT"}
        or review_position < 1
    ):
        _fail(
            "COPILOT_EVENT_CORRELATION",
            "copilot identities require a linked point/replay at positive review position",
        )
    _validate_post_state(data["post_state_summary"])
    return ValidatedShadowOutboxMessage(
        payload_bytes=raw,
        payload_sha256=hashlib.sha256(raw).hexdigest(),
        message_id=message_id,
        outbox_id=outbox_id,
        match_id=match_id,
        event_id=event_id,
        revision=revision,
        appended_at_ns=appended_at_ns,
        event_type=event_type,
        scorer_copilot_case_fingerprint=copilot_values[0],
        scorer_copilot_signed_case_fingerprint=copilot_values[1],
        scorer_copilot_case_link_fingerprint=copilot_values[2],
        review_authorization_context_fingerprint=copilot_values[3],
    )


def _public_key_base64(public_key: Ed25519PublicKey) -> str:
    raw = public_key.public_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PublicFormat.Raw,
    )
    return base64.b64encode(raw).decode("ascii")


@dataclass(frozen=True, slots=True)
class DispatcherVerificationKey:
    dispatcher_id: str
    key_id: str
    public_key_base64: str
    valid_from_ns: int
    valid_until_ns: int
    revoked_at_ns: int | None = None

    def __post_init__(self) -> None:
        _stable_id(self.dispatcher_id, "dispatcher_id")
        _stable_id(self.key_id, "key_id")
        raw = _canonical_base64(
            self.public_key_base64,
            "public_key_base64",
            expected_size=32,
        )
        try:
            Ed25519PublicKey.from_public_bytes(raw)
        except ValueError as exc:
            raise ShadowTransportError(
                "KEY_ENCODING", "public_key_base64 is not an Ed25519 public key"
            ) from exc
        _exact_int(self.valid_from_ns, "valid_from_ns")
        _exact_int(self.valid_until_ns, "valid_until_ns")
        if self.valid_until_ns < self.valid_from_ns:
            _fail("KEY_TIME", "dispatcher key validity interval is reversed")
        if self.revoked_at_ns is not None:
            _exact_int(self.revoked_at_ns, "revoked_at_ns")

    @property
    def public_key(self) -> Ed25519PublicKey:
        return Ed25519PublicKey.from_public_bytes(
            base64.b64decode(self.public_key_base64)
        )


@dataclass(frozen=True, slots=True)
class ProtectedDispatcherKeyRegistry:
    """Protected current-key selection plus explicit retained revocation truth."""

    source_ledger_id: str
    current_key_id: str
    keys: tuple[DispatcherVerificationKey, ...]

    def __post_init__(self) -> None:
        _stable_id(self.source_ledger_id, "source_ledger_id")
        _stable_id(self.current_key_id, "current_key_id")
        if (
            type(self.keys) is not tuple
            or not 1 <= len(self.keys) <= MAX_DISPATCH_KEYS
        ):
            _fail("KEY_REGISTRY", "keys must be a bounded non-empty exact tuple")
        if any(type(key) is not DispatcherVerificationKey for key in self.keys):
            _fail("KEY_REGISTRY", "registry keys must be exact DispatcherVerificationKey values")
        identities = tuple((key.dispatcher_id, key.key_id) for key in self.keys)
        if len(set(identities)) != len(identities):
            _fail("KEY_REGISTRY", "dispatcher key identities must be unique")
        if len({key.key_id for key in self.keys}) != len(self.keys):
            _fail("KEY_REGISTRY", "dispatcher key_id values must be globally unique")
        if len({key.public_key_base64 for key in self.keys}) != len(self.keys):
            _fail("KEY_REGISTRY", "dispatcher public keys must not alias identities")
        if sum(key.key_id == self.current_key_id for key in self.keys) != 1:
            _fail("KEY_REGISTRY", "current_key_id must select exactly one retained key")

    @property
    def current_key(self) -> DispatcherVerificationKey:
        return next(key for key in self.keys if key.key_id == self.current_key_id)


@dataclass(frozen=True, slots=True)
class ShadowDispatchTrustPolicy:
    registry: ProtectedDispatcherKeyRegistry
    maximum_clock_skew_ns: int
    maximum_envelope_lifetime_ns: int

    def __post_init__(self) -> None:
        if type(self.registry) is not ProtectedDispatcherKeyRegistry:
            _fail("TRUST_POLICY", "registry must be exact ProtectedDispatcherKeyRegistry")
        _exact_int(self.maximum_clock_skew_ns, "maximum_clock_skew_ns")
        _exact_int(
            self.maximum_envelope_lifetime_ns,
            "maximum_envelope_lifetime_ns",
            minimum=1,
        )


@dataclass(frozen=True, slots=True)
class SignedShadowDispatch:
    source_ledger_id: str
    dispatcher_id: str
    dispatcher_key_id: str
    attempt_id: str
    payload_bytes: bytes
    payload_sha256: str
    message_id: str
    outbox_id: int
    signed_at_ns: int
    expires_at_ns: int
    signature_base64: str
    algorithm: str = SHADOW_DISPATCH_ALGORITHM
    schema_version: str = SHADOW_DISPATCH_SCHEMA_VERSION

    def __post_init__(self) -> None:
        _literal(self.schema_version, SHADOW_DISPATCH_SCHEMA_VERSION, "schema_version")
        _literal(self.algorithm, SHADOW_DISPATCH_ALGORITHM, "algorithm")
        _stable_id(self.source_ledger_id, "source_ledger_id")
        _stable_id(self.dispatcher_id, "dispatcher_id")
        _stable_id(self.dispatcher_key_id, "dispatcher_key_id")
        _stable_id(self.attempt_id, "attempt_id")
        payload = parse_shadow_outbox_payload(self.payload_bytes)
        _sha256(self.payload_sha256, "payload_sha256")
        if self.payload_sha256 != payload.payload_sha256:
            _fail("PAYLOAD_HASH", "payload_sha256 does not bind payload_bytes")
        _message_id(self.message_id)
        _exact_int(self.outbox_id, "outbox_id", minimum=1)
        if self.message_id != payload.message_id or self.outbox_id != payload.outbox_id:
            _fail("IDENTITY_MISMATCH", "dispatch identities do not bind the exact payload")
        _exact_int(self.signed_at_ns, "signed_at_ns")
        _exact_int(self.expires_at_ns, "expires_at_ns")
        if self.expires_at_ns < self.signed_at_ns:
            _fail("DISPATCH_TIME", "dispatch expiry predates signing")
        _canonical_base64(self.signature_base64, "signature_base64", expected_size=64)
        _canonical_json(
            self.canonical_dict(),
            maximum=MAX_SHADOW_DISPATCH_ENVELOPE_BYTES,
            label="signed shadow dispatch",
        )

    def unsigned_canonical_dict(self) -> dict[str, object]:
        return {
            "algorithm": self.algorithm,
            "attempt_id": self.attempt_id,
            "dispatcher_id": self.dispatcher_id,
            "dispatcher_key_id": self.dispatcher_key_id,
            "expires_at_ns": self.expires_at_ns,
            "message_id": self.message_id,
            "outbox_id": self.outbox_id,
            "payload_base64": base64.b64encode(self.payload_bytes).decode("ascii"),
            "payload_sha256": self.payload_sha256,
            "schema_version": self.schema_version,
            "signed_at_ns": self.signed_at_ns,
            "source_ledger_id": self.source_ledger_id,
        }

    def canonical_dict(self) -> dict[str, object]:
        value = self.unsigned_canonical_dict()
        value["signature_base64"] = self.signature_base64
        return value

    def fingerprint(self) -> str:
        return hashlib.sha256(encode_signed_shadow_dispatch(self)).hexdigest()

    @property
    def official_score_authority_granted(self) -> bool:
        return False


def _signing_message(value: dict[str, object]) -> bytes:
    return _DISPATCH_SIGNING_DOMAIN + _canonical_json(
        value,
        maximum=MAX_SHADOW_DISPATCH_ENVELOPE_BYTES,
        label="shadow dispatch attestation",
    )


def _trusted_key_for_signing(
    policy: ShadowDispatchTrustPolicy,
    *,
    dispatcher_key_id: str,
    signed_at_ns: int,
    expires_at_ns: int,
) -> DispatcherVerificationKey:
    if type(policy) is not ShadowDispatchTrustPolicy:
        _fail("TRUST_POLICY", "policy must be exact ShadowDispatchTrustPolicy")
    key_id = _stable_id(dispatcher_key_id, "dispatcher_key_id")
    if key_id != policy.registry.current_key_id:
        _fail("KEY_NOT_CURRENT", "only the protected current dispatcher key may sign")
    key = policy.registry.current_key
    if not key.valid_from_ns <= signed_at_ns <= expires_at_ns <= key.valid_until_ns:
        _fail("KEY_INACTIVE", "dispatcher key is not active for the full envelope lifetime")
    if key.revoked_at_ns is not None and key.revoked_at_ns <= expires_at_ns:
        _fail(
            "KEY_REVOKED",
            "dispatcher key is revoked before the requested envelope expires",
        )
    return key


def sign_shadow_dispatch(
    *,
    payload_bytes: bytes,
    policy: ShadowDispatchTrustPolicy,
    dispatcher_key_id: str,
    attempt_id: str,
    signed_at_ns: int,
    expires_at_ns: int,
    dispatcher_private_key: Ed25519PrivateKey,
) -> SignedShadowDispatch:
    """Create one deterministic, authenticated delivery-attribution envelope."""

    if type(policy) is not ShadowDispatchTrustPolicy:
        _fail("TRUST_POLICY", "policy must be exact ShadowDispatchTrustPolicy")
    payload = parse_shadow_outbox_payload(payload_bytes)
    signed_at_ns = _exact_int(signed_at_ns, "signed_at_ns")
    expires_at_ns = _exact_int(expires_at_ns, "expires_at_ns")
    if expires_at_ns < signed_at_ns:
        _fail("DISPATCH_TIME", "dispatch expiry predates signing")
    if expires_at_ns - signed_at_ns > policy.maximum_envelope_lifetime_ns:
        _fail("DISPATCH_LIFETIME", "dispatch lifetime exceeds protected policy")
    if not isinstance(dispatcher_private_key, Ed25519PrivateKey):
        _fail("PRIVATE_KEY_TYPE", "dispatcher_private_key must be Ed25519PrivateKey")
    key = _trusted_key_for_signing(
        policy,
        dispatcher_key_id=dispatcher_key_id,
        signed_at_ns=signed_at_ns,
        expires_at_ns=expires_at_ns,
    )
    unsigned = {
        "algorithm": SHADOW_DISPATCH_ALGORITHM,
        "attempt_id": _stable_id(attempt_id, "attempt_id"),
        "dispatcher_id": key.dispatcher_id,
        "dispatcher_key_id": key.key_id,
        "expires_at_ns": expires_at_ns,
        "message_id": payload.message_id,
        "outbox_id": payload.outbox_id,
        "payload_base64": base64.b64encode(payload_bytes).decode("ascii"),
        "payload_sha256": payload.payload_sha256,
        "schema_version": SHADOW_DISPATCH_SCHEMA_VERSION,
        "signed_at_ns": signed_at_ns,
        "source_ledger_id": policy.registry.source_ledger_id,
    }
    signature = dispatcher_private_key.sign(_signing_message(unsigned))
    try:
        key.public_key.verify(signature, _signing_message(unsigned))
    except InvalidSignature as exc:
        raise ShadowTransportError(
            "PRIVATE_KEY_MISMATCH",
            "private dispatcher key does not match the protected current key",
        ) from exc
    return SignedShadowDispatch(
        source_ledger_id=policy.registry.source_ledger_id,
        dispatcher_id=key.dispatcher_id,
        dispatcher_key_id=key.key_id,
        attempt_id=attempt_id,
        payload_bytes=payload_bytes,
        payload_sha256=payload.payload_sha256,
        message_id=payload.message_id,
        outbox_id=payload.outbox_id,
        signed_at_ns=signed_at_ns,
        expires_at_ns=expires_at_ns,
        signature_base64=base64.b64encode(signature).decode("ascii"),
    )


def verify_signed_shadow_dispatch(
    signed: SignedShadowDispatch,
    *,
    policy: ShadowDispatchTrustPolicy,
    verified_at_ns: int,
) -> ValidatedShadowOutboxMessage:
    """Verify current delivery attribution; never authorize a score mutation."""

    if type(signed) is not SignedShadowDispatch:
        _fail("SIGNED_TYPE", "signed must be exact SignedShadowDispatch")
    if type(policy) is not ShadowDispatchTrustPolicy:
        _fail("TRUST_POLICY", "policy must be exact ShadowDispatchTrustPolicy")
    verified_at_ns = _exact_int(verified_at_ns, "verified_at_ns")
    registry = policy.registry
    if signed.source_ledger_id != registry.source_ledger_id:
        _fail("SOURCE_LEDGER_MISMATCH", "dispatch source ledger is not trusted")
    matches = tuple(
        key
        for key in registry.keys
        if key.key_id == signed.dispatcher_key_id
        and key.dispatcher_id == signed.dispatcher_id
    )
    if len(matches) != 1:
        _fail("KEY_UNTRUSTED", "dispatcher identity/key is not retained exactly once")
    key = matches[0]
    if key.key_id != registry.current_key_id:
        _fail("KEY_NOT_CURRENT", "dispatch was not signed by the protected current key")
    if signed.expires_at_ns - signed.signed_at_ns > policy.maximum_envelope_lifetime_ns:
        _fail("DISPATCH_LIFETIME", "dispatch lifetime exceeds protected policy")
    if signed.signed_at_ns > verified_at_ns + policy.maximum_clock_skew_ns:
        _fail("DISPATCH_FUTURE", "dispatch signing time exceeds allowed clock skew")
    if verified_at_ns > signed.expires_at_ns + policy.maximum_clock_skew_ns:
        _fail("DISPATCH_EXPIRED", "dispatch is expired beyond allowed clock skew")
    if not key.valid_from_ns <= signed.signed_at_ns <= signed.expires_at_ns <= key.valid_until_ns:
        _fail("KEY_INACTIVE", "dispatcher key is not active for the envelope lifetime")
    if key.revoked_at_ns is not None and key.revoked_at_ns <= max(
        signed.expires_at_ns, verified_at_ns
    ):
        _fail(
            "KEY_REVOKED",
            "dispatcher key revocation intersects the signed envelope lifetime "
            "or current verification time",
        )
    try:
        key.public_key.verify(
            _canonical_base64(signed.signature_base64, "signature_base64", expected_size=64),
            _signing_message(signed.unsigned_canonical_dict()),
        )
    except InvalidSignature as exc:
        raise ShadowTransportError(
            "SIGNATURE_INVALID", "shadow dispatch signature is invalid"
        ) from exc
    return parse_shadow_outbox_payload(signed.payload_bytes)


def encode_signed_shadow_dispatch(value: SignedShadowDispatch) -> bytes:
    if type(value) is not SignedShadowDispatch:
        _fail("SIGNED_TYPE", "value must be exact SignedShadowDispatch")
    return _canonical_json(
        value.canonical_dict(),
        maximum=MAX_SHADOW_DISPATCH_ENVELOPE_BYTES,
        label="signed shadow dispatch",
    )


def parse_signed_shadow_dispatch(raw: bytes) -> SignedShadowDispatch:
    data = _exact_dict(
        _load_json(
            raw,
            maximum=MAX_SHADOW_DISPATCH_ENVELOPE_BYTES,
            label="signed shadow dispatch",
        ),
        _DISPATCH_FIELDS,
        "signed shadow dispatch",
    )
    try:
        payload_bytes = _canonical_base64(
            data["payload_base64"],
            "payload_base64",
            maximum_size=MAX_SHADOW_OUTBOX_PAYLOAD_BYTES,
        )
        value = SignedShadowDispatch(
            source_ledger_id=data["source_ledger_id"],
            dispatcher_id=data["dispatcher_id"],
            dispatcher_key_id=data["dispatcher_key_id"],
            attempt_id=data["attempt_id"],
            payload_bytes=payload_bytes,
            payload_sha256=data["payload_sha256"],
            message_id=data["message_id"],
            outbox_id=data["outbox_id"],
            signed_at_ns=data["signed_at_ns"],
            expires_at_ns=data["expires_at_ns"],
            signature_base64=data["signature_base64"],
            algorithm=data["algorithm"],
            schema_version=data["schema_version"],
        )
    except ShadowTransportError:
        raise
    except (KeyError, TypeError, ValueError) as exc:
        raise ShadowTransportError(
            "ENVELOPE_INVALID", "signed shadow dispatch fields are invalid"
        ) from exc
    if encode_signed_shadow_dispatch(value) != raw:
        _fail("NON_CANONICAL", "signed shadow dispatch must be canonical ASCII JSON")
    return value


__all__ = [
    "DELIVERY_ATTRIBUTION_ONLY",
    "DispatcherVerificationKey",
    "MAX_SHADOW_DISPATCH_ENVELOPE_BYTES",
    "MAX_SHADOW_OUTBOX_PAYLOAD_BYTES",
    "OFFICIAL_SCORE_AUTHORITY_GRANTED",
    "ProtectedDispatcherKeyRegistry",
    "SHADOW_DISPATCH_ALGORITHM",
    "SHADOW_DISPATCH_SCHEMA_VERSION",
    "SHADOW_OUTBOX_SCHEMA_VERSION",
    "SHADOW_OUTBOX_TARGET",
    "SHADOW_OUTBOX_TOPIC",
    "ShadowDispatchTrustPolicy",
    "ShadowTransportError",
    "SignedShadowDispatch",
    "ValidatedShadowOutboxMessage",
    "encode_signed_shadow_dispatch",
    "parse_shadow_outbox_payload",
    "parse_signed_shadow_dispatch",
    "sign_shadow_dispatch",
    "verify_signed_shadow_dispatch",
]
