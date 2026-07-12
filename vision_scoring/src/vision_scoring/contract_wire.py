"""Shared strict canonical-JSON and scalar primitives for signed contracts."""

from __future__ import annotations

import base64
import binascii
from enum import Enum
import json
import re
from typing import Any, Mapping

MAX_SIGNED_64 = (1 << 63) - 1
MIN_SIGNED_64 = -(1 << 63)
DEFAULT_MAX_JSON_BYTES = 2 * 1024 * 1024
DEFAULT_MAX_JSON_DEPTH = 16
DEFAULT_MAX_JSON_NODES = 50_000
DEFAULT_MAX_JSON_CONTAINERS = 10_000

_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
_STABLE_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$")


class CanonicalWireError(ValueError):
    """Strict wire-format failure with a stable code."""

    def __init__(self, code: str, message: str) -> None:
        self.code = code
        super().__init__(f"{code}: {message}")


def _fail(code: str, message: str) -> None:
    raise CanonicalWireError(code, message)


def require_exact_int(
    value: object,
    field_name: str,
    *,
    minimum: int = 0,
    maximum: int = MAX_SIGNED_64,
) -> int:
    if type(value) is not int or not minimum <= value <= maximum:
        raise ValueError(
            f"{field_name} must be an exact integer in [{minimum}, {maximum}]"
        )
    return value


def require_stable_id(value: object, field_name: str) -> str:
    if type(value) is not str or _STABLE_ID_RE.fullmatch(value) is None:
        raise ValueError(f"{field_name} must be an ASCII stable ID")
    return value


def require_sha256(value: object, field_name: str) -> str:
    if type(value) is not str or _SHA256_RE.fullmatch(value) is None:
        raise ValueError(f"{field_name} must be a lowercase SHA-256")
    return value


def canonical_base64(value: object, field_name: str, *, expected_bytes: int) -> bytes:
    if type(value) is not str or not value:
        raise ValueError(f"{field_name} must be canonical base64")
    try:
        decoded = base64.b64decode(value.encode("ascii"), validate=True)
    except (UnicodeEncodeError, binascii.Error, ValueError) as exc:
        raise ValueError(f"{field_name} must be canonical base64") from exc
    if (
        len(decoded) != expected_bytes
        or base64.b64encode(decoded).decode("ascii") != value
    ):
        raise ValueError(
            f"{field_name} must be canonical base64 for {expected_bytes} bytes"
        )
    return decoded


def require_canonical_tuple(
    value: object,
    field_name: str,
    *,
    minimum: int,
    maximum: int,
    validator: Any,
) -> tuple[Any, ...]:
    if type(value) is not tuple or not minimum <= len(value) <= maximum:
        raise ValueError(
            f"{field_name} must be an immutable tuple with {minimum} to "
            f"{maximum} items"
        )
    for item in value:
        validator(item, f"{field_name} item")
    order = tuple(
        sorted(
            value,
            key=lambda item: item.value if isinstance(item, Enum) else item,
        )
    )
    if value != order or len(set(value)) != len(value):
        raise ValueError(f"{field_name} must be unique and canonically sorted")
    return value


def enum_from_json(enum_type: type[Enum], value: object, field_name: str) -> Enum:
    if type(value) is not str:
        raise ValueError(f"{field_name} must be a string")
    try:
        return enum_type(value)
    except ValueError as exc:
        raise ValueError(f"{field_name} has an unsupported enum value") from exc


def require_exact_fields(
    value: object, required: set[str], *, label: str
) -> dict[str, Any]:
    if type(value) is not dict:
        raise ValueError(f"{label} must be an exact JSON object")
    actual = set(value)
    missing = sorted(required - actual)
    extra = sorted(actual - required)
    if missing or extra:
        details: list[str] = []
        if missing:
            details.append(f"missing {', '.join(missing)}")
        if extra:
            details.append(f"unsupported {', '.join(extra)}")
        raise ValueError(f"{label} fields are invalid: {'; '.join(details)}")
    return value


def exact_list(value: Mapping[str, Any], field_name: str, *, label: str) -> list[Any]:
    selected = value[field_name]
    if type(selected) is not list:
        raise ValueError(f"{label}.{field_name} must be a JSON array")
    return selected


def canonical_json_bytes(
    value: Mapping[str, Any],
    *,
    label: str,
    maximum_bytes: int = DEFAULT_MAX_JSON_BYTES,
) -> bytes:
    require_exact_int(
        maximum_bytes,
        "maximum_bytes",
        minimum=1,
        maximum=DEFAULT_MAX_JSON_BYTES,
    )
    _measure_json(
        value,
        maximum_depth=DEFAULT_MAX_JSON_DEPTH,
        maximum_nodes=DEFAULT_MAX_JSON_NODES,
        maximum_containers=DEFAULT_MAX_JSON_CONTAINERS,
    )
    try:
        encoded = json.dumps(
            value,
            ensure_ascii=True,
            sort_keys=True,
            separators=(",", ":"),
            allow_nan=False,
        ).encode("ascii")
    except (TypeError, ValueError, UnicodeEncodeError) as exc:
        raise ValueError(f"{label} must be finite canonical ASCII JSON") from exc
    if not 1 <= len(encoded) <= maximum_bytes:
        raise ValueError(f"{label} exceeds {maximum_bytes} bytes")
    return encoded


def _reject_duplicate_pairs(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            _fail("DUPLICATE_JSON_KEY", f"duplicate JSON key: {key}")
        result[key] = value
    return result


def _reject_nonfinite(token: str) -> None:
    _fail("NONFINITE_JSON_NUMBER", f"nonfinite JSON number: {token}")


def _parse_signed_64_integer(token: str) -> int:
    # 19 decimal digits plus an optional leading minus is the longest possible
    # signed-64 token. The value check remains authoritative at the boundary.
    if len(token) > 20:
        _fail("JSON_INTEGER_RANGE", "JSON integer exceeds signed 64-bit")
    try:
        value = int(token, 10)
    except ValueError as exc:
        _fail("INVALID_JSON_NUMBER", "JSON integer is invalid")
        raise AssertionError from exc
    if not MIN_SIGNED_64 <= value <= MAX_SIGNED_64:
        _fail("JSON_INTEGER_RANGE", "JSON integer exceeds signed 64-bit")
    return value


def _reject_float(token: str) -> None:
    _fail("INVALID_JSON_NUMBER", f"floating JSON number is forbidden: {token}")


def _measure_json(
    value: object,
    *,
    maximum_depth: int,
    maximum_nodes: int,
    maximum_containers: int,
    depth: int = 1,
) -> tuple[int, int]:
    if depth > maximum_depth:
        _fail("JSON_DEPTH_EXCEEDED", "canonical JSON is too deeply nested")
    nodes = 1
    containers = 0
    if type(value) is dict:
        containers = 1
        for key, item in value.items():
            if type(key) is not str:
                _fail("INVALID_JSON_KEY", "JSON object keys must be strings")
            child_nodes, child_containers = _measure_json(
                item,
                maximum_depth=maximum_depth,
                maximum_nodes=maximum_nodes,
                maximum_containers=maximum_containers,
                depth=depth + 1,
            )
            nodes += child_nodes
            containers += child_containers
    elif type(value) in (list, tuple):
        containers = 1
        for item in value:
            child_nodes, child_containers = _measure_json(
                item,
                maximum_depth=maximum_depth,
                maximum_nodes=maximum_nodes,
                maximum_containers=maximum_containers,
                depth=depth + 1,
            )
            nodes += child_nodes
            containers += child_containers
    elif type(value) is int:
        if not MIN_SIGNED_64 <= value <= MAX_SIGNED_64:
            _fail("JSON_INTEGER_RANGE", "JSON integer exceeds signed 64-bit")
    elif value is not None and type(value) not in (str, bool):
        _fail("INVALID_JSON_VALUE", "unsupported JSON value")
    if nodes > maximum_nodes:
        _fail("JSON_NODE_LIMIT_EXCEEDED", "canonical JSON has too many nodes")
    if containers > maximum_containers:
        _fail(
            "JSON_CONTAINER_LIMIT_EXCEEDED",
            "canonical JSON has too many containers",
        )
    return nodes, containers


def parse_canonical_json_object(
    raw: bytes,
    *,
    label: str,
    maximum_bytes: int = DEFAULT_MAX_JSON_BYTES,
    maximum_depth: int = DEFAULT_MAX_JSON_DEPTH,
    maximum_nodes: int = DEFAULT_MAX_JSON_NODES,
    maximum_containers: int = DEFAULT_MAX_JSON_CONTAINERS,
) -> dict[str, Any]:
    require_exact_int(
        maximum_bytes,
        "maximum_bytes",
        minimum=1,
        maximum=DEFAULT_MAX_JSON_BYTES,
    )
    require_exact_int(
        maximum_depth,
        "maximum_depth",
        minimum=1,
        maximum=DEFAULT_MAX_JSON_DEPTH,
    )
    require_exact_int(
        maximum_nodes,
        "maximum_nodes",
        minimum=1,
        maximum=DEFAULT_MAX_JSON_NODES,
    )
    require_exact_int(
        maximum_containers,
        "maximum_containers",
        minimum=1,
        maximum=DEFAULT_MAX_JSON_CONTAINERS,
    )
    if type(raw) is not bytes or not 1 <= len(raw) <= maximum_bytes:
        _fail("JSON_SIZE", f"{label} must be 1 to {maximum_bytes} exact bytes")
    try:
        value = json.loads(
            raw.decode("utf-8", errors="strict"),
            object_pairs_hook=_reject_duplicate_pairs,
            parse_constant=_reject_nonfinite,
            parse_int=_parse_signed_64_integer,
            parse_float=_reject_float,
        )
    except CanonicalWireError:
        raise
    except RecursionError as exc:
        _fail("JSON_DEPTH_EXCEEDED", f"{label} is too deeply nested")
        raise AssertionError from exc
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        _fail("INVALID_JSON", f"{label} must be valid UTF-8 JSON")
        raise AssertionError from exc
    try:
        _measure_json(
            value,
            maximum_depth=maximum_depth,
            maximum_nodes=maximum_nodes,
            maximum_containers=maximum_containers,
        )
    except RecursionError as exc:
        _fail("JSON_DEPTH_EXCEEDED", f"{label} is too deeply nested")
        raise AssertionError from exc
    if type(value) is not dict:
        _fail("JSON_ROOT", f"{label} root must be an object")
    canonical = canonical_json_bytes(value, label=label, maximum_bytes=maximum_bytes)
    if raw != canonical:
        _fail("NONCANONICAL_JSON", f"{label} bytes are not canonical")
    return value


__all__ = [
    "CanonicalWireError",
    "DEFAULT_MAX_JSON_BYTES",
    "DEFAULT_MAX_JSON_CONTAINERS",
    "DEFAULT_MAX_JSON_DEPTH",
    "DEFAULT_MAX_JSON_NODES",
    "MAX_SIGNED_64",
    "MIN_SIGNED_64",
    "canonical_base64",
    "canonical_json_bytes",
    "enum_from_json",
    "exact_list",
    "parse_canonical_json_object",
    "require_canonical_tuple",
    "require_exact_fields",
    "require_exact_int",
    "require_sha256",
    "require_stable_id",
]
