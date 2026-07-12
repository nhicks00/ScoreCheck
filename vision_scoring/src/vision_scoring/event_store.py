"""Transactional, replay-verified storage for human-authorized shadow scoring.

The SQLite database is an append-only local ledger and projection cache.  It is
*not* an authority for official ScoreCheck mutation.  Every append reparses and
reverifies every persisted authorization envelope, replays the complete event
stream, and byte-compares every derived snapshot before it accepts a write.

The caller supplies the protected :class:`AuthorizationPolicyArchive`, the
exact :class:`Ruleset`, a trusted reducer build SHA-256, and trustworthy
monotonic timestamps.  SQLite cannot prove that its entire file was rolled
back.  Deployments must therefore protect :class:`LedgerCheckpoint` values in
an external monotonic backup/checkpoint boundary and reject rollback there.

There are deliberately no delete, purge, migration, compatibility, automatic
authorization, or official-score dispatch APIs in this module.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import sqlite3
from contextlib import contextmanager
from dataclasses import dataclass
from functools import wraps
from pathlib import Path
from typing import Any, Iterator, NoReturn

from .authorization import (
    MAX_AUTHORIZATION_BYTES,
    AuthorizationError,
    AuthorizationOrigin,
    AuthorizationPolicyArchive,
    AuthorizedRuleEvent,
    encode_authorization_policy_archive,
    encode_authorized_rule_event,
    parse_authorization_policy_archive,
    parse_authorized_rule_event,
    verify_authorized_rule_event,
)
from .domain_events import MAX_ID_LENGTH, MAX_SEQUENCE_NUMBER, RuleEvent
from .rules import MatchState, RulesError, RulesReducer, Ruleset
from .state_codec import (
    MAX_RAW_STATE_BYTES,
    encode_match_state,
    match_state_fingerprint,
)


EVENT_STORE_SCHEMA_VERSION = "2.0"
SQLITE_APPLICATION_ID = 0x5649534E  # ASCII "VISN"
SQLITE_USER_VERSION = 2
SHADOW_OUTBOX_TOPIC = "vision_scoring.shadow.authorized_event.v1"
SHADOW_OUTBOX_TARGET = "SHADOW_ONLY_NO_OFFICIAL_SCORECHECK_MUTATION"
MAX_FAILURE_CODE_LENGTH = 128
MAX_ARCHIVE_ADOPTIONS = 256
MAX_SHADOW_OUTBOX_PAYLOAD_BYTES = 16 * 1024
MAX_ARCHIVE_HISTORY_BYTES_PER_MATCH = 16 * 1024 * 1024
MAX_LEDGER_ENVELOPE_BYTES_PER_MATCH = 32 * 1024 * 1024
MAX_LEDGER_STATE_BYTES_PER_MATCH = 128 * 1024 * 1024
MAX_LEDGER_OUTBOX_BYTES_PER_MATCH = 16 * 1024 * 1024
MAX_LEDGER_TOTAL_BYTES_PER_MATCH = 192 * 1024 * 1024
MAX_LEDGER_TEXT_BYTES_PER_MATCH = 32 * 1024 * 1024
MAX_ARCHIVE_TEXT_BYTES_PER_MATCH = 1024 * 1024
MAX_OUTBOX_MESSAGE_ID_LENGTH = 192
MAX_SQLITE_VALUE_BYTES = 768 * 1024
MAX_SQLITE_SQL_BYTES = 64 * 1024
MAX_SQLITE_COLUMNS = 64
MAX_SQLITE_VARIABLES = 64

_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
_STABLE_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$")
_GENESIS_DOMAIN = b"multicourt-vision-scoring:ledger-genesis:v1\x00"
_CHAIN_DOMAIN = b"multicourt-vision-scoring:ledger-chain:v1\x00"
_CHECKPOINT_DOMAIN = b"multicourt-vision-scoring:ledger-checkpoint:v1\x00"
_ARCHIVE_CHAIN_DOMAIN = b"multicourt-vision-scoring:archive-chain:v1\x00"


class EventStoreError(RuntimeError):
    """Fail-closed store error with a stable machine-readable code."""

    def __init__(self, code: str, message: str, *, checkpoint: Any = None) -> None:
        self.code = code
        self.checkpoint = checkpoint
        super().__init__(f"{code}: {message}")


class _PersistedIntegrityBlock(RuntimeError):
    def __init__(self, failure_code: str, checkpoint: Any) -> None:
        self.failure_code = failure_code
        self.checkpoint = checkpoint
        super().__init__(failure_code)


def _fail(code: str, message: str) -> NoReturn:
    raise EventStoreError(code, message)


def _sqlite_boundary(operation: Any) -> Any:
    """Translate every SQLite exception crossing a public method boundary."""

    @wraps(operation)
    def wrapped(*args: Any, **kwargs: Any) -> Any:
        try:
            return operation(*args, **kwargs)
        except _PersistedIntegrityBlock as exc:
            raise EventStoreError(
                "INTEGRITY_BLOCKED",
                f"ledger was permanently blocked: {exc.failure_code}",
                checkpoint=exc.checkpoint,
            ) from exc
        except EventStoreError:
            raise
        except sqlite3.DatabaseError as exc:
            raise _normalized_sqlite_error(exc, "SQLite operation") from exc

    return wrapped


def _normalized_sqlite_error(
    exc: sqlite3.DatabaseError,
    operation: str,
) -> EventStoreError:
    message = str(exc).lower()
    if isinstance(exc, sqlite3.DataError) or "too big" in message:
        return EventStoreError(
            "SQLITE_LIMIT_EXCEEDED", f"{operation} exceeded a configured SQLite limit"
        )
    return EventStoreError(
        "SQLITE_DATABASE_ERROR", f"{operation} failed closed"
    )


def _sha256(value: object, field_name: str) -> str:
    if type(value) is not str or _SHA256_RE.fullmatch(value) is None:
        raise ValueError(f"{field_name} must be a lowercase SHA-256")
    return value


def _stable_id(value: object, field_name: str) -> str:
    if type(value) is not str or _STABLE_ID_RE.fullmatch(value) is None:
        raise ValueError(f"{field_name} must be an ASCII stable ID")
    return value


def _timestamp(value: object, field_name: str) -> int:
    if type(value) is not int or not 0 <= value <= MAX_SEQUENCE_NUMBER:
        raise ValueError(f"{field_name} must be a non-negative signed 64-bit integer")
    return value


def _canonical_json(value: object) -> bytes:
    try:
        return json.dumps(
            value,
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=True,
            allow_nan=False,
        ).encode("ascii")
    except (TypeError, ValueError, UnicodeEncodeError) as exc:
        raise ValueError("value must be finite canonical ASCII JSON") from exc


def _digest(value: object) -> str:
    return hashlib.sha256(_canonical_json(value)).hexdigest()


def _archive_bytes(archive: AuthorizationPolicyArchive) -> bytes:
    raw = encode_authorization_policy_archive(archive)
    if len(raw) > MAX_AUTHORIZATION_BYTES:
        _fail("ARCHIVE_ENCODING", "archive canonical encoding exceeds its bound")
    if hashlib.sha256(raw).hexdigest() != archive.fingerprint():
        _fail("ARCHIVE_ENCODING", "archive canonical encoding disagrees with fingerprint")
    return raw


def _normalize_sql(value: str) -> str:
    return " ".join(value.split())


def _sql_ascii_check(column: str, maximum: int = MAX_ID_LENGTH) -> str:
    return (
        f"length({column}) BETWEEN 1 AND {maximum} "
        f"AND {column} NOT GLOB '*[^!-~]*'"
    )


def _sql_hash_check(column: str) -> str:
    return f"length({column}) = 64 AND {column} NOT GLOB '*[^0-9a-f]*'"


_DDL = (
    f"""
    CREATE TABLE store_metadata (
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
        schema_version TEXT NOT NULL CHECK(schema_version = '{EVENT_STORE_SCHEMA_VERSION}'),
        schema_fingerprint TEXT NOT NULL CHECK({_sql_hash_check('schema_fingerprint')})
    ) STRICT
    """,
    f"""
    CREATE TABLE matches (
        match_id TEXT PRIMARY KEY CHECK({_sql_ascii_check('match_id')}),
        match_binding_fingerprint TEXT NOT NULL UNIQUE CHECK({_sql_hash_check('match_binding_fingerprint')}),
        ruleset_id TEXT NOT NULL CHECK({_sql_ascii_check('ruleset_id')}),
        ruleset_version TEXT NOT NULL CHECK({_sql_ascii_check('ruleset_version')}),
        ruleset_fingerprint TEXT NOT NULL CHECK({_sql_hash_check('ruleset_fingerprint')}),
        reducer_build_sha256 TEXT NOT NULL CHECK({_sql_hash_check('reducer_build_sha256')}),
        authorization_archive_id TEXT NOT NULL CHECK({_sql_ascii_check('authorization_archive_id')}),
        authorization_trust_domain_id TEXT NOT NULL CHECK({_sql_ascii_check('authorization_trust_domain_id')}),
        adopted_archive_fingerprint TEXT NOT NULL CHECK({_sql_hash_check('adopted_archive_fingerprint')}),
        archive_history_head_sha256 TEXT NOT NULL CHECK({_sql_hash_check('archive_history_head_sha256')}),
        max_events_per_match INTEGER NOT NULL CHECK(max_events_per_match BETWEEN 1 AND 4096),
        initialized_at_ns INTEGER NOT NULL CHECK(initialized_at_ns >= 0),
        last_verified_at_ns INTEGER NOT NULL CHECK(last_verified_at_ns >= initialized_at_ns),
        current_revision INTEGER NOT NULL CHECK(current_revision >= 0),
        current_state_bytes BLOB NOT NULL CHECK(typeof(current_state_bytes) = 'blob' AND length(current_state_bytes) <= 524288),
        current_state_fingerprint TEXT NOT NULL CHECK({_sql_hash_check('current_state_fingerprint')}),
        ledger_head_sha256 TEXT NOT NULL CHECK({_sql_hash_check('ledger_head_sha256')}),
        integrity_blocked INTEGER NOT NULL DEFAULT 0 CHECK(integrity_blocked IN (0, 1)),
        integrity_failure_code TEXT CHECK(integrity_failure_code IS NULL OR ({_sql_ascii_check('integrity_failure_code', MAX_FAILURE_CODE_LENGTH)})),
        CHECK((integrity_blocked = 0 AND integrity_failure_code IS NULL) OR
              (integrity_blocked = 1 AND integrity_failure_code IS NOT NULL))
    ) STRICT
    """,
    f"""
    CREATE TABLE archive_adoptions (
        match_id TEXT NOT NULL CHECK({_sql_ascii_check('match_id')}),
        generation INTEGER NOT NULL CHECK(generation BETWEEN 0 AND 255),
        previous_archive_fingerprint TEXT CHECK(previous_archive_fingerprint IS NULL OR ({_sql_hash_check('previous_archive_fingerprint')})),
        adopted_archive_fingerprint TEXT NOT NULL CHECK({_sql_hash_check('adopted_archive_fingerprint')}),
        archive_id TEXT NOT NULL CHECK({_sql_ascii_check('archive_id')}),
        trust_domain_id TEXT NOT NULL CHECK({_sql_ascii_check('trust_domain_id')}),
        current_policy_fingerprint TEXT NOT NULL CHECK({_sql_hash_check('current_policy_fingerprint')}),
        adopted_at_ns INTEGER NOT NULL CHECK(adopted_at_ns >= 0),
        archive_bytes BLOB NOT NULL CHECK(typeof(archive_bytes) = 'blob' AND length(archive_bytes) <= 524288),
        archive_history_head_sha256 TEXT NOT NULL CHECK({_sql_hash_check('archive_history_head_sha256')}),
        PRIMARY KEY(match_id, generation),
        UNIQUE(adopted_archive_fingerprint),
        FOREIGN KEY(match_id) REFERENCES matches(match_id)
    ) STRICT
    """,
    f"""
    CREATE TABLE authorization_log (
        match_id TEXT NOT NULL CHECK({_sql_ascii_check('match_id')}),
        revision INTEGER NOT NULL CHECK(revision > 0),
        event_id TEXT NOT NULL CHECK({_sql_ascii_check('event_id')}),
        envelope_fingerprint TEXT NOT NULL UNIQUE CHECK({_sql_hash_check('envelope_fingerprint')}),
        authorization_record_fingerprint TEXT NOT NULL CHECK({_sql_hash_check('authorization_record_fingerprint')}),
        command_fingerprint TEXT NOT NULL UNIQUE CHECK({_sql_hash_check('command_fingerprint')}),
        policy_fingerprint TEXT NOT NULL CHECK({_sql_hash_check('policy_fingerprint')}),
        adopted_archive_fingerprint TEXT NOT NULL CHECK({_sql_hash_check('adopted_archive_fingerprint')}),
        actor_id TEXT NOT NULL CHECK({_sql_ascii_check('actor_id')}),
        actor_key_id TEXT NOT NULL CHECK({_sql_ascii_check('actor_key_id')}),
        authorizer_id TEXT NOT NULL CHECK({_sql_ascii_check('authorizer_id')}),
        authorizer_key_id TEXT NOT NULL CHECK({_sql_ascii_check('authorizer_key_id')}),
        authorized_at_ns INTEGER NOT NULL CHECK(authorized_at_ns >= 0),
        verified_at_ns INTEGER NOT NULL CHECK(verified_at_ns >= authorized_at_ns),
        envelope_bytes BLOB NOT NULL CHECK(typeof(envelope_bytes) = 'blob' AND length(envelope_bytes) <= 524288),
        PRIMARY KEY(match_id, revision),
        UNIQUE(match_id, revision, event_id),
        UNIQUE(event_id),
        FOREIGN KEY(match_id) REFERENCES matches(match_id)
    ) STRICT
    """,
    f"""
    CREATE TABLE event_log (
        match_id TEXT NOT NULL CHECK({_sql_ascii_check('match_id')}),
        revision INTEGER NOT NULL CHECK(revision > 0),
        event_id TEXT NOT NULL CHECK({_sql_ascii_check('event_id')}),
        event_type TEXT NOT NULL CHECK(event_type IN ('SET_SEED','POINT_AWARDED','REPLAY_NO_POINT','SIDE_SWITCH_CONFIRMED','TECHNICAL_TIMEOUT_COMPLETED')),
        event_fingerprint TEXT NOT NULL CHECK({_sql_hash_check('event_fingerprint')}),
        envelope_fingerprint TEXT NOT NULL UNIQUE CHECK({_sql_hash_check('envelope_fingerprint')}),
        adopted_archive_fingerprint TEXT NOT NULL CHECK({_sql_hash_check('adopted_archive_fingerprint')}),
        envelope_bytes BLOB NOT NULL CHECK(typeof(envelope_bytes) = 'blob' AND length(envelope_bytes) <= 524288),
        created_at_ns INTEGER NOT NULL CHECK(created_at_ns >= 0),
        appended_at_ns INTEGER NOT NULL CHECK(appended_at_ns >= created_at_ns),
        related_rally_id TEXT CHECK(related_rally_id IS NULL OR ({_sql_ascii_check('related_rally_id')})),
        PRIMARY KEY(match_id, revision),
        UNIQUE(match_id, revision, event_id),
        UNIQUE(event_id),
        FOREIGN KEY(match_id, revision, event_id)
            REFERENCES authorization_log(match_id, revision, event_id)
    ) STRICT
    """,
    f"""
    CREATE TABLE state_history (
        match_id TEXT NOT NULL CHECK({_sql_ascii_check('match_id')}),
        revision INTEGER NOT NULL CHECK(revision > 0),
        event_id TEXT NOT NULL CHECK({_sql_ascii_check('event_id')}),
        state_bytes BLOB NOT NULL CHECK(typeof(state_bytes) = 'blob' AND length(state_bytes) <= 524288),
        state_fingerprint TEXT NOT NULL CHECK({_sql_hash_check('state_fingerprint')}),
        ledger_head_sha256 TEXT NOT NULL CHECK({_sql_hash_check('ledger_head_sha256')}),
        PRIMARY KEY(match_id, revision),
        UNIQUE(match_id, revision, event_id),
        FOREIGN KEY(match_id, revision, event_id)
            REFERENCES event_log(match_id, revision, event_id)
    ) STRICT
    """,
    f"""
    CREATE TABLE shadow_outbox (
        outbox_id INTEGER PRIMARY KEY,
        message_id TEXT NOT NULL UNIQUE CHECK({_sql_ascii_check('message_id', MAX_OUTBOX_MESSAGE_ID_LENGTH)}),
        match_id TEXT NOT NULL CHECK({_sql_ascii_check('match_id')}),
        revision INTEGER NOT NULL CHECK(revision > 0),
        event_id TEXT NOT NULL CHECK({_sql_ascii_check('event_id')}),
        topic TEXT NOT NULL CHECK(topic = 'vision_scoring.shadow.authorized_event.v1'),
        target TEXT NOT NULL CHECK(target = 'SHADOW_ONLY_NO_OFFICIAL_SCORECHECK_MUTATION'),
        payload_bytes BLOB NOT NULL CHECK(typeof(payload_bytes) = 'blob' AND length(payload_bytes) <= 16384),
        payload_fingerprint TEXT NOT NULL CHECK({_sql_hash_check('payload_fingerprint')}),
        envelope_fingerprint TEXT NOT NULL CHECK({_sql_hash_check('envelope_fingerprint')}),
        state_fingerprint TEXT NOT NULL CHECK({_sql_hash_check('state_fingerprint')}),
        reducer_build_sha256 TEXT NOT NULL CHECK({_sql_hash_check('reducer_build_sha256')}),
        created_at_ns INTEGER NOT NULL CHECK(created_at_ns >= 0),
        UNIQUE(match_id, revision),
        UNIQUE(match_id, revision, event_id),
        FOREIGN KEY(match_id, revision, event_id)
            REFERENCES state_history(match_id, revision, event_id)
    ) STRICT
    """,
    f"""
    CREATE TABLE idempotency_log (
        idempotency_key TEXT PRIMARY KEY CHECK({_sql_ascii_check('idempotency_key')}),
        match_id TEXT NOT NULL CHECK({_sql_ascii_check('match_id')}),
        command_fingerprint TEXT NOT NULL UNIQUE CHECK({_sql_hash_check('command_fingerprint')}),
        envelope_fingerprint TEXT NOT NULL UNIQUE CHECK({_sql_hash_check('envelope_fingerprint')}),
        event_id TEXT NOT NULL UNIQUE CHECK({_sql_ascii_check('event_id')}),
        result_revision INTEGER NOT NULL CHECK(result_revision > 0),
        result_state_fingerprint TEXT NOT NULL CHECK({_sql_hash_check('result_state_fingerprint')}),
        outbox_id INTEGER NOT NULL UNIQUE,
        outbox_payload_fingerprint TEXT NOT NULL CHECK({_sql_hash_check('outbox_payload_fingerprint')}),
        reducer_build_sha256 TEXT NOT NULL CHECK({_sql_hash_check('reducer_build_sha256')}),
        UNIQUE(match_id, result_revision, event_id),
        FOREIGN KEY(match_id, result_revision, event_id)
            REFERENCES event_log(match_id, revision, event_id),
        FOREIGN KEY(outbox_id) REFERENCES shadow_outbox(outbox_id)
    ) STRICT
    """,
)

_EXPECTED_TABLES = frozenset(
    {
        "store_metadata",
        "matches",
        "archive_adoptions",
        "authorization_log",
        "event_log",
        "state_history",
        "shadow_outbox",
        "idempotency_log",
    }
)
_SCHEMA_FINGERPRINT = hashlib.sha256(
    "\n".join(_normalize_sql(statement) for statement in _DDL).encode("ascii")
).hexdigest()


@dataclass(frozen=True, slots=True)
class LedgerCheckpoint:
    """Canonical head proof intended for an external rollback-protected store."""

    match_id: str
    match_binding_fingerprint: str
    revision: int
    ledger_head_sha256: str
    state_fingerprint: str
    adopted_archive_fingerprint: str
    archive_adoption_generation: int
    archive_history_head_sha256: str
    reducer_build_sha256: str
    outbox_position: int
    last_verified_at_ns: int
    integrity_blocked: bool
    integrity_failure_code: str | None

    def __post_init__(self) -> None:
        _stable_id(self.match_id, "match_id")
        for field_name in (
            "match_binding_fingerprint",
            "ledger_head_sha256",
            "state_fingerprint",
            "adopted_archive_fingerprint",
            "archive_history_head_sha256",
            "reducer_build_sha256",
        ):
            _sha256(getattr(self, field_name), field_name)
        _timestamp(self.revision, "revision")
        _timestamp(self.outbox_position, "outbox_position")
        _timestamp(self.last_verified_at_ns, "last_verified_at_ns")
        if (
            type(self.archive_adoption_generation) is not int
            or not 0 <= self.archive_adoption_generation < MAX_ARCHIVE_ADOPTIONS
        ):
            raise ValueError("archive_adoption_generation is outside its fixed bound")
        if type(self.integrity_blocked) is not bool:
            raise ValueError("integrity_blocked must be an exact bool")
        if self.revision == 0 and self.outbox_position != 0:
            raise ValueError("an empty ledger checkpoint cannot have an outbox identity")
        if self.revision > 0 and self.outbox_position == 0:
            raise ValueError("a non-empty ledger checkpoint requires an outbox identity")
        if self.integrity_blocked:
            if (
                type(self.integrity_failure_code) is not str
                or not 1 <= len(self.integrity_failure_code) <= MAX_FAILURE_CODE_LENGTH
                or not self.integrity_failure_code.isascii()
                or any(
                    ord(character) < 0x21 or ord(character) > 0x7E
                    for character in self.integrity_failure_code
                )
            ):
                raise ValueError("blocked checkpoint requires a bounded ASCII failure code")
        elif self.integrity_failure_code is not None:
            raise ValueError("unblocked checkpoint forbids an integrity failure code")

    def canonical_dict(self) -> dict[str, object]:
        return {
            "adopted_archive_fingerprint": self.adopted_archive_fingerprint,
            "archive_adoption_generation": self.archive_adoption_generation,
            "archive_history_head_sha256": self.archive_history_head_sha256,
            "integrity_blocked": self.integrity_blocked,
            "integrity_failure_code": self.integrity_failure_code,
            "last_verified_at_ns": self.last_verified_at_ns,
            "ledger_head_sha256": self.ledger_head_sha256,
            "match_binding_fingerprint": self.match_binding_fingerprint,
            "match_id": self.match_id,
            "outbox_position": self.outbox_position,
            "reducer_build_sha256": self.reducer_build_sha256,
            "revision": self.revision,
            "state_fingerprint": self.state_fingerprint,
        }

    def fingerprint(self) -> str:
        return hashlib.sha256(
            _CHECKPOINT_DOMAIN + _canonical_json(self.canonical_dict())
        ).hexdigest()


def verify_checkpoint_progression(
    previous: LedgerCheckpoint,
    candidate: LedgerCheckpoint,
) -> LedgerCheckpoint:
    """Fail closed on locally provable external-checkpoint rollback.

    A hash-chain inclusion proof is still required externally when ``revision``
    advances; this comparator enforces exact identity and monotonic fields.
    """

    if type(previous) is not LedgerCheckpoint or type(candidate) is not LedgerCheckpoint:
        raise ValueError("checkpoints must be exact LedgerCheckpoint values")
    if (
        candidate.match_id != previous.match_id
        or candidate.match_binding_fingerprint
        != previous.match_binding_fingerprint
        or candidate.reducer_build_sha256 != previous.reducer_build_sha256
    ):
        _fail("CHECKPOINT_IDENTITY", "checkpoint identity/build changed")
    if previous.integrity_blocked:
        if candidate != previous:
            _fail(
                "CHECKPOINT_BLOCK_CONFLICT",
                "terminal blocked checkpoint must remain byte-exact",
            )
        return candidate
    if candidate.last_verified_at_ns < previous.last_verified_at_ns:
        _fail("CHECKPOINT_TIME_ROLLBACK", "checkpoint trust time moved backward")
    if candidate.revision < previous.revision:
        _fail("CHECKPOINT_REVISION_ROLLBACK", "checkpoint revision moved backward")
    if candidate.outbox_position < previous.outbox_position:
        _fail("CHECKPOINT_OUTBOX_ROLLBACK", "checkpoint outbox identity moved backward")
    if candidate.archive_adoption_generation < previous.archive_adoption_generation:
        _fail("CHECKPOINT_ARCHIVE_ROLLBACK", "archive generation moved backward")
    if candidate.revision == previous.revision and (
        candidate.ledger_head_sha256 != previous.ledger_head_sha256
        or candidate.state_fingerprint != previous.state_fingerprint
        or candidate.outbox_position != previous.outbox_position
    ):
        _fail("CHECKPOINT_HEAD_CONFLICT", "same revision has a different ledger head")
    if candidate.revision > previous.revision and (
        candidate.outbox_position <= previous.outbox_position
    ):
        _fail("CHECKPOINT_OUTBOX_CONFLICT", "advanced revision lacks a new outbox identity")
    if candidate.archive_adoption_generation == previous.archive_adoption_generation and (
        candidate.adopted_archive_fingerprint
        != previous.adopted_archive_fingerprint
        or candidate.archive_history_head_sha256
        != previous.archive_history_head_sha256
    ):
        _fail("CHECKPOINT_ARCHIVE_CONFLICT", "same archive generation has different identity")
    if candidate.archive_adoption_generation > previous.archive_adoption_generation and (
        candidate.adopted_archive_fingerprint
        == previous.adopted_archive_fingerprint
        or candidate.archive_history_head_sha256
        == previous.archive_history_head_sha256
    ):
        _fail(
            "CHECKPOINT_ARCHIVE_CONFLICT",
            "advanced archive generation did not change both archive identities",
        )
    return candidate


@dataclass(frozen=True, slots=True)
class MatchInitializationResult:
    match_id: str
    match_binding_fingerprint: str
    state_fingerprint: str
    adopted_archive_fingerprint: str
    reducer_build_sha256: str
    checkpoint: LedgerCheckpoint

    def fingerprint(self) -> str:
        return _digest(
            {
                "adopted_archive_fingerprint": self.adopted_archive_fingerprint,
                "checkpoint_fingerprint": self.checkpoint.fingerprint(),
                "match_binding_fingerprint": self.match_binding_fingerprint,
                "match_id": self.match_id,
                "reducer_build_sha256": self.reducer_build_sha256,
                "state_fingerprint": self.state_fingerprint,
            }
        )


@dataclass(frozen=True, slots=True)
class AppendResult:
    match_id: str
    revision: int
    event_id: str
    event_fingerprint: str
    command_fingerprint: str
    envelope_fingerprint: str
    authorization_record_fingerprint: str
    state_fingerprint: str
    outbox_id: int
    outbox_message_id: str
    outbox_payload_fingerprint: str
    adopted_archive_fingerprint: str
    reducer_build_sha256: str
    ledger_head_sha256: str
    checkpoint: LedgerCheckpoint

    def fingerprint(self) -> str:
        return _digest(
            {
                "adopted_archive_fingerprint": self.adopted_archive_fingerprint,
                "authorization_record_fingerprint": self.authorization_record_fingerprint,
                "checkpoint_fingerprint": self.checkpoint.fingerprint(),
                "command_fingerprint": self.command_fingerprint,
                "envelope_fingerprint": self.envelope_fingerprint,
                "event_fingerprint": self.event_fingerprint,
                "event_id": self.event_id,
                "ledger_head_sha256": self.ledger_head_sha256,
                "match_id": self.match_id,
                "outbox_id": self.outbox_id,
                "outbox_message_id": self.outbox_message_id,
                "outbox_payload_fingerprint": self.outbox_payload_fingerprint,
                "reducer_build_sha256": self.reducer_build_sha256,
                "revision": self.revision,
                "state_fingerprint": self.state_fingerprint,
            }
        )


@dataclass(frozen=True, slots=True)
class AuditResult:
    match_id: str
    event_count: int
    state_fingerprint: str
    ledger_head_sha256: str
    adopted_archive_fingerprint: str
    reducer_build_sha256: str
    checkpoint: LedgerCheckpoint

    def fingerprint(self) -> str:
        return _digest(
            {
                "adopted_archive_fingerprint": self.adopted_archive_fingerprint,
                "checkpoint_fingerprint": self.checkpoint.fingerprint(),
                "event_count": self.event_count,
                "ledger_head_sha256": self.ledger_head_sha256,
                "match_id": self.match_id,
                "reducer_build_sha256": self.reducer_build_sha256,
                "state_fingerprint": self.state_fingerprint,
            }
        )


@dataclass(frozen=True, slots=True)
class ArchiveAdvancementResult:
    match_id: str
    previous_archive_fingerprint: str
    adopted_archive_fingerprint: str
    adoption_generation: int
    adopted_at_ns: int
    reducer_build_sha256: str
    integrity_valid: bool
    integrity_failure_code: str | None
    checkpoint: LedgerCheckpoint

    def fingerprint(self) -> str:
        return _digest(
            {
                "adopted_archive_fingerprint": self.adopted_archive_fingerprint,
                "adopted_at_ns": self.adopted_at_ns,
                "adoption_generation": self.adoption_generation,
                "integrity_failure_code": self.integrity_failure_code,
                "integrity_valid": self.integrity_valid,
                "match_id": self.match_id,
                "previous_archive_fingerprint": self.previous_archive_fingerprint,
                "reducer_build_sha256": self.reducer_build_sha256,
                "checkpoint_fingerprint": self.checkpoint.fingerprint(),
            }
        )


@dataclass(frozen=True, slots=True)
class _ReplayResult:
    state: MatchState
    state_bytes: bytes
    state_fingerprint: str
    ledger_head_sha256: str
    outbox_position: int
    event_count: int
    adoptions: tuple["_ArchiveAdoption", ...] = ()
    preflight: "_LedgerPreflight | None" = None


@dataclass(frozen=True, slots=True)
class _ArchiveAdoption:
    generation: int
    archive_fingerprint: str
    current_policy_fingerprint: str
    adopted_at_ns: int
    archive: AuthorizationPolicyArchive
    history_head_sha256: str


@dataclass(frozen=True, slots=True)
class _LedgerPreflight:
    event_count: int
    envelope_bytes: int
    state_bytes: int
    outbox_bytes: int
    text_bytes: int

    @property
    def total_bytes(self) -> int:
        return (
            self.envelope_bytes
            + self.state_bytes
            + self.outbox_bytes
            + self.text_bytes
        )


class SQLiteEventStore:
    """Append-only SQLite ledger for one trusted reducer build and ruleset."""

    __slots__ = (
        "ruleset",
        "reducer",
        "reducer_build_sha256",
        "database_path",
        "_connection",
        "_test_fault_mode",
    )

    def __init__(
        self,
        database_path: str | os.PathLike[str],
        *,
        ruleset: Ruleset,
        reducer_build_sha256: str,
        timeout_seconds: float = 5.0,
    ) -> None:
        if type(ruleset) is not Ruleset:
            raise ValueError("ruleset must be an exact Ruleset")
        self.ruleset = ruleset
        self.reducer = RulesReducer(ruleset)
        self.reducer_build_sha256 = _sha256(
            reducer_build_sha256, "reducer_build_sha256"
        )
        if type(timeout_seconds) not in (int, float) or not 0 < timeout_seconds <= 60:
            raise ValueError("timeout_seconds must be in (0, 60]")
        if isinstance(database_path, Path):
            database_path = str(database_path)
        if type(database_path) is not str or not database_path:
            raise ValueError("database_path must be a non-empty path")
        self.database_path = database_path
        self._test_fault_mode: str | None = None
        try:
            self._connection = sqlite3.connect(
                database_path,
                isolation_level=None,
                timeout=float(timeout_seconds),
            )
            self._connection.row_factory = sqlite3.Row
            self._configure_sqlite_limits()
            self._configure_connection(timeout_seconds=float(timeout_seconds))
            self._ensure_schema()
            self._validate_schema()
        except EventStoreError:
            if hasattr(self, "_connection"):
                self._connection.close()
            raise
        except sqlite3.DatabaseError as exc:
            if hasattr(self, "_connection"):
                self._connection.close()
            raise _normalized_sqlite_error(exc, "SQLite initialization") from exc
        except Exception:
            if hasattr(self, "_connection"):
                self._connection.close()
            raise

    def __enter__(self) -> "SQLiteEventStore":
        return self

    def __exit__(self, *_: object) -> None:
        self.close()

    @_sqlite_boundary
    def close(self) -> None:
        self._connection.close()

    def _configure_connection(self, *, timeout_seconds: float) -> None:
        setconfig = getattr(self._connection, "setconfig", None)
        defensive = getattr(sqlite3, "SQLITE_DBCONFIG_DEFENSIVE", None)
        if setconfig is not None and defensive is not None:
            setconfig(defensive, True)
        self._connection.execute("PRAGMA foreign_keys = ON")
        self._connection.execute("PRAGMA trusted_schema = OFF")
        self._connection.execute("PRAGMA recursive_triggers = OFF")
        self._connection.execute("PRAGMA secure_delete = ON")
        self._connection.execute("PRAGMA cell_size_check = ON")
        self._connection.execute("PRAGMA mmap_size = 0")
        self._connection.execute("PRAGMA synchronous = FULL")
        self._connection.execute(
            f"PRAGMA busy_timeout = {int(timeout_seconds * 1000)}"
        )
        # WAL is durable with synchronous=FULL and permits independent readers.
        # SQLite legitimately returns another mode for an in-memory database.
        self._connection.execute("PRAGMA journal_mode = WAL").fetchone()

    def _configure_sqlite_limits(self) -> None:
        """Set C-level allocation/parser ceilings before the first SQL query."""

        limits = (
            (sqlite3.SQLITE_LIMIT_LENGTH, MAX_SQLITE_VALUE_BYTES),
            (sqlite3.SQLITE_LIMIT_SQL_LENGTH, MAX_SQLITE_SQL_BYTES),
            (sqlite3.SQLITE_LIMIT_COLUMN, MAX_SQLITE_COLUMNS),
            (sqlite3.SQLITE_LIMIT_VARIABLE_NUMBER, MAX_SQLITE_VARIABLES),
            (sqlite3.SQLITE_LIMIT_EXPR_DEPTH, 64),
            (sqlite3.SQLITE_LIMIT_COMPOUND_SELECT, 16),
            (sqlite3.SQLITE_LIMIT_FUNCTION_ARG, 16),
            (sqlite3.SQLITE_LIMIT_ATTACHED, 0),
            (sqlite3.SQLITE_LIMIT_LIKE_PATTERN_LENGTH, 256),
            (sqlite3.SQLITE_LIMIT_TRIGGER_DEPTH, 0),
            (sqlite3.SQLITE_LIMIT_WORKER_THREADS, 0),
        )
        for category, requested in limits:
            self._connection.setlimit(category, requested)
            actual = self._connection.getlimit(category)
            if actual != requested:
                _fail(
                    "SQLITE_LIMIT_CONFIG",
                    f"SQLite runtime limit {category} read back as {actual}",
                )

    @contextmanager
    def _transaction(self, *, immediate: bool) -> Iterator[None]:
        try:
            self._connection.execute("BEGIN IMMEDIATE" if immediate else "BEGIN")
            yield
            self._connection.execute("COMMIT")
        except _PersistedIntegrityBlock:
            if self._connection.in_transaction:
                self._connection.execute("COMMIT")
            raise
        except Exception:
            if self._connection.in_transaction:
                self._connection.execute("ROLLBACK")
            raise

    def _ensure_schema(self) -> None:
        objects = self._connection.execute(
            "SELECT type, name FROM sqlite_master "
            "WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name LIMIT 1"
        ).fetchone()
        if objects:
            return
        with self._transaction(immediate=True):
            for statement in _DDL:
                self._connection.execute(statement)
            self._connection.execute(
                "INSERT INTO store_metadata(singleton, schema_version, schema_fingerprint) "
                "VALUES(1, ?, ?)",
                (EVENT_STORE_SCHEMA_VERSION, _SCHEMA_FINGERPRINT),
            )
            self._connection.execute(f"PRAGMA application_id = {SQLITE_APPLICATION_ID}")
            self._connection.execute(f"PRAGMA user_version = {SQLITE_USER_VERSION}")

    def _validate_schema(self) -> None:
        quick_check = self._connection.execute("PRAGMA quick_check(1)").fetchone()
        if quick_check is None or quick_check[0] != "ok":
            _fail("SQLITE_CORRUPTION", "bounded SQLite quick_check failed")
        application_id = self._connection.execute("PRAGMA application_id").fetchone()[0]
        user_version = self._connection.execute("PRAGMA user_version").fetchone()[0]
        if application_id != SQLITE_APPLICATION_ID or user_version != SQLITE_USER_VERSION:
            _fail("SCHEMA_IDENTITY", "SQLite application_id/user_version is not exact")
        tables = self._connection.execute(
            "SELECT name, sql FROM sqlite_master WHERE type = 'table' "
            "AND name NOT LIKE 'sqlite_%' ORDER BY name"
        ).fetchmany(len(_EXPECTED_TABLES) + 1)
        if frozenset(row["name"] for row in tables) != _EXPECTED_TABLES:
            _fail("SCHEMA_TABLES", "SQLite table set is not exact")
        expected_sql = {
            re.search(r"CREATE TABLE\s+(\w+)", statement, re.IGNORECASE).group(1):
            _normalize_sql(statement)
            for statement in _DDL
        }
        for row in tables:
            if row["sql"] is None or _normalize_sql(row["sql"]) != expected_sql[row["name"]]:
                _fail("SCHEMA_DRIFT", f"table schema drift detected: {row['name']}")
        unexpected = self._connection.execute(
            "SELECT type, name FROM sqlite_master WHERE type IN ('view', 'trigger') "
            "OR (type = 'index' AND sql IS NOT NULL) ORDER BY type, name LIMIT 1"
        ).fetchone()
        if unexpected is not None:
            _fail("SCHEMA_OBJECTS", "unexpected view, trigger, or explicit index exists")
        temporary_objects = self._connection.execute(
            "SELECT type, name FROM sqlite_temp_master ORDER BY type, name LIMIT 1"
        ).fetchone()
        if temporary_objects is not None:
            _fail("SCHEMA_OBJECTS", "temporary schema objects are forbidden")
        databases = self._connection.execute("PRAGMA database_list").fetchall()
        database_names = [row[1] for row in databases]
        if database_names.count("main") != 1 or not set(database_names) <= {"main", "temp"}:
            _fail("SCHEMA_OBJECTS", "attached databases are forbidden")
        table_list = self._connection.execute("PRAGMA table_list").fetchall()
        strict_by_name = {
            row[1]: row[5]
            for row in table_list
            if row[1] in _EXPECTED_TABLES
        }
        if strict_by_name != {name: 1 for name in _EXPECTED_TABLES}:
            _fail("SCHEMA_STRICT", "every event-store table must be STRICT")
        metadata = self._connection.execute(
            "SELECT schema_version, schema_fingerprint FROM store_metadata WHERE singleton = 1"
        ).fetchmany(2)
        if (
            len(metadata) != 1
            or metadata[0]["schema_version"] != EVENT_STORE_SCHEMA_VERSION
            or metadata[0]["schema_fingerprint"] != _SCHEMA_FINGERPRINT
        ):
            _fail("SCHEMA_METADATA", "schema metadata is not exact")
        if self._connection.execute("PRAGMA foreign_keys").fetchone()[0] != 1:
            _fail("FOREIGN_KEYS_DISABLED", "SQLite foreign keys must be enabled")
        if self._connection.execute("PRAGMA synchronous").fetchone()[0] != 2:
            _fail("DURABILITY_MODE", "SQLite synchronous mode must be FULL")
        journal_mode = self._connection.execute("PRAGMA journal_mode").fetchone()[0]
        if self.database_path != ":memory:" and str(journal_mode).lower() != "wal":
            _fail("DURABILITY_MODE", "file-backed SQLite journal mode must be WAL")
        if self._connection.execute("PRAGMA trusted_schema").fetchone()[0] != 0:
            _fail("SCHEMA_TRUST", "SQLite trusted_schema must be disabled")
        violation = self._connection.execute("PRAGMA foreign_key_check").fetchone()
        if violation is not None:
            _fail("FOREIGN_KEY_CORRUPTION", "foreign-key violations exist")
        outbox_identity_stats = self._connection.execute(
            "SELECT COUNT(*), MIN(outbox_id), MAX(outbox_id) FROM shadow_outbox"
        ).fetchone()
        outbox_count, minimum_outbox_id, maximum_outbox_id = outbox_identity_stats
        if (
            (outbox_count == 0 and (minimum_outbox_id is not None or maximum_outbox_id is not None))
            or (
                outbox_count > 0
                and (minimum_outbox_id != 1 or maximum_outbox_id != outbox_count)
            )
        ):
            _fail("OUTBOX_ID_SEQUENCE", "global outbox identities are not contiguous")
        persisted_matches = self._connection.execute(
            """
            SELECT match_id FROM matches
            WHERE ruleset_id != ? OR ruleset_version != ?
               OR ruleset_fingerprint != ? OR reducer_build_sha256 != ?
               OR max_events_per_match != ?
            LIMIT 1
            """,
            (
                self.ruleset.ruleset_id,
                self.ruleset.version,
                self.ruleset.fingerprint(),
                self.reducer_build_sha256,
                self.ruleset.max_events_per_match,
            ),
        ).fetchone()
        if persisted_matches is not None:
            _fail(
                "TRUSTED_RUNTIME_MISMATCH",
                "persisted match was built by another ruleset/reducer build",
            )

    def _binding_fingerprint(
        self, match_id: str, archive: AuthorizationPolicyArchive
    ) -> str:
        return _digest(
            {
                "authorization_archive_id": archive.archive_id,
                "authorization_trust_domain_id": archive.trust_domain_id,
                "match_id": match_id,
                "reducer_build_sha256": self.reducer_build_sha256,
                "ruleset_fingerprint": self.ruleset.fingerprint(),
                "ruleset_id": self.ruleset.ruleset_id,
                "ruleset_version": self.ruleset.version,
                "schema_version": EVENT_STORE_SCHEMA_VERSION,
            }
        )

    def _genesis_head(
        self,
        *,
        match_binding_fingerprint: str,
        initial_state_fingerprint: str,
        initial_archive_fingerprint: str,
    ) -> str:
        return hashlib.sha256(
            _GENESIS_DOMAIN
            + _canonical_json(
                {
                    "initial_archive_fingerprint": initial_archive_fingerprint,
                    "initial_state_fingerprint": initial_state_fingerprint,
                    "match_binding_fingerprint": match_binding_fingerprint,
                    "reducer_build_sha256": self.reducer_build_sha256,
                }
            )
        ).hexdigest()

    def _archive_history_head(
        self,
        *,
        previous_head: str,
        generation: int,
        previous_archive_fingerprint: str | None,
        adopted_archive_fingerprint: str,
        current_policy_fingerprint: str,
        adopted_at_ns: int,
        archive_bytes: bytes,
    ) -> str:
        return hashlib.sha256(
            _ARCHIVE_CHAIN_DOMAIN
            + bytes.fromhex(previous_head)
            + _canonical_json(
                {
                    "adopted_archive_fingerprint": adopted_archive_fingerprint,
                    "adopted_at_ns": adopted_at_ns,
                    "archive_bytes_sha256": hashlib.sha256(archive_bytes).hexdigest(),
                    "current_policy_fingerprint": current_policy_fingerprint,
                    "generation": generation,
                    "previous_archive_fingerprint": previous_archive_fingerprint,
                }
            )
        ).hexdigest()

    @_sqlite_boundary
    def initialize_match(
        self,
        match_id: str,
        *,
        policy_archive: AuthorizationPolicyArchive,
        initialized_at_ns: int,
    ) -> MatchInitializationResult:
        """Explicitly bootstrap one empty match; never infer it from an append."""

        match_id = _stable_id(match_id, "match_id")
        initialized_at_ns = _timestamp(initialized_at_ns, "initialized_at_ns")
        self._require_archive_scope(policy_archive, match_id=match_id)
        if not policy_archive.current_policy.is_active(initialized_at_ns):
            _fail("ARCHIVE_INACTIVE", "current archive policy is inactive at bootstrap")
        archive_fingerprint = policy_archive.fingerprint()
        archive_bytes = _archive_bytes(policy_archive)
        binding = self._binding_fingerprint(match_id, policy_archive)
        state = self.reducer.new_match(match_id)
        state_bytes = encode_match_state(state, ruleset=self.ruleset)
        state_fingerprint = match_state_fingerprint(state, ruleset=self.ruleset)
        head = self._genesis_head(
            match_binding_fingerprint=binding,
            initial_state_fingerprint=state_fingerprint,
            initial_archive_fingerprint=archive_fingerprint,
        )
        archive_head = self._archive_history_head(
            previous_head="0" * 64,
            generation=0,
            previous_archive_fingerprint=None,
            adopted_archive_fingerprint=archive_fingerprint,
            current_policy_fingerprint=policy_archive.current_policy_fingerprint,
            adopted_at_ns=initialized_at_ns,
            archive_bytes=archive_bytes,
        )
        with self._transaction(immediate=True):
            self._validate_schema()
            existing = self._connection.execute(
                "SELECT * FROM matches WHERE match_id = ?", (match_id,)
            ).fetchone()
            if existing is not None:
                expected = (
                    binding,
                    archive_fingerprint,
                    state_fingerprint,
                    self.reducer_build_sha256,
                    initialized_at_ns,
                    state_bytes,
                    head,
                    archive_head,
                )
                actual = (
                    existing["match_binding_fingerprint"],
                    existing["adopted_archive_fingerprint"],
                    existing["current_state_fingerprint"],
                    existing["reducer_build_sha256"],
                    existing["initialized_at_ns"],
                    existing["current_state_bytes"],
                    existing["ledger_head_sha256"],
                    existing["archive_history_head_sha256"],
                )
                if actual != expected or existing["current_revision"] != 0:
                    _fail("MATCH_ALREADY_EXISTS", "match bootstrap conflicts with existing ledger")
                replay = self._replay_locked(
                    match_id=match_id,
                    policy_archive=policy_archive,
                    verified_at_ns=max(initialized_at_ns, existing["last_verified_at_ns"]),
                )
                checkpoint = self._checkpoint_from_row(
                    existing, replay=replay, verified_at_ns=existing["last_verified_at_ns"]
                )
                return MatchInitializationResult(
                    match_id,
                    binding,
                    state_fingerprint,
                    archive_fingerprint,
                    self.reducer_build_sha256,
                    checkpoint,
                )
            self._connection.execute(
                """
                INSERT INTO matches(
                    match_id, match_binding_fingerprint, ruleset_id, ruleset_version,
                    ruleset_fingerprint, reducer_build_sha256, authorization_archive_id,
                    authorization_trust_domain_id, adopted_archive_fingerprint,
                    archive_history_head_sha256,
                    max_events_per_match, initialized_at_ns, last_verified_at_ns,
                    current_revision, current_state_bytes, current_state_fingerprint,
                    ledger_head_sha256, integrity_blocked, integrity_failure_code
                ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, 0, NULL)
                """,
                (
                    match_id,
                    binding,
                    self.ruleset.ruleset_id,
                    self.ruleset.version,
                    self.ruleset.fingerprint(),
                    self.reducer_build_sha256,
                    policy_archive.archive_id,
                    policy_archive.trust_domain_id,
                    archive_fingerprint,
                    archive_head,
                    self.ruleset.max_events_per_match,
                    initialized_at_ns,
                    initialized_at_ns,
                    state_bytes,
                    state_fingerprint,
                    head,
                ),
            )
            self._connection.execute(
                """
                INSERT INTO archive_adoptions(
                    match_id, generation, previous_archive_fingerprint,
                    adopted_archive_fingerprint, archive_id, trust_domain_id,
                    current_policy_fingerprint, adopted_at_ns, archive_bytes,
                    archive_history_head_sha256
                ) VALUES(?, 0, NULL, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    match_id,
                    archive_fingerprint,
                    policy_archive.archive_id,
                    policy_archive.trust_domain_id,
                    policy_archive.current_policy_fingerprint,
                    initialized_at_ns,
                    archive_bytes,
                    archive_head,
                ),
            )
            row = self._connection.execute(
                "SELECT * FROM matches WHERE match_id = ?", (match_id,)
            ).fetchone()
            replay = _ReplayResult(state, state_bytes, state_fingerprint, head, 0, 0)
            checkpoint = self._checkpoint_from_row(
                row, replay=replay, verified_at_ns=initialized_at_ns
            )
        return MatchInitializationResult(
            match_id,
            binding,
            state_fingerprint,
            archive_fingerprint,
            self.reducer_build_sha256,
            checkpoint,
        )

    @_sqlite_boundary
    def append_authorized_event(
        self,
        envelope_bytes: bytes,
        *,
        policy_archive: AuthorizationPolicyArchive,
        verified_at_ns: int,
    ) -> AppendResult:
        """Atomically append one canonical human-direct event and shadow row.

        Delayed append is allowed only when the embedded policy was ledger-current
        at every assessment-signing (if present), command-issue, and authorization
        timestamp.  The latest adopted archive remains authoritative at append.
        """

        if type(envelope_bytes) is not bytes:
            raise ValueError("envelope_bytes must be exact bytes")
        verified_at_ns = _timestamp(verified_at_ns, "verified_at_ns")
        try:
            with self._transaction(immediate=True):
                self._validate_schema()
                envelope = parse_authorized_rule_event(envelope_bytes)
                if encode_authorized_rule_event(envelope) != envelope_bytes:
                    _fail("ENVELOPE_NON_CANONICAL", "envelope bytes are not exact canonical bytes")
                event = envelope.event
                command = envelope.authorization_record.signed_command.command
                if command.origin is not AuthorizationOrigin.HUMAN_DIRECT:
                    _fail(
                        "ASSISTED_CONTEXT_REQUIRED",
                        "assessment-assisted commands require the future atomic case-link API",
                    )
                if command.idempotency_key.startswith("copilot-v1:"):
                    _fail(
                        "COPILOT_CONTEXT_REQUIRED",
                        "reserved copilot request IDs require the future atomic case-link path",
                    )
                match_row = self._load_match_locked(event.match_id)
                self._check_match_pins(match_row, policy_archive=policy_archive)
                self._check_time_locked(
                    match_row,
                    at_ns=verified_at_ns,
                    event=event,
                    authorized_at_ns=envelope.authorization_record.authorized_at_ns,
                )
                idempotency_relation = self._idempotency_relation_locked(
                    command.idempotency_key,
                    command.fingerprint(),
                    envelope.fingerprint(),
                    event.event_id,
                )
                if match_row["integrity_blocked"]:
                    _fail(
                        "INTEGRITY_BLOCKED",
                        f"archive adoption blocked ledger: {match_row['integrity_failure_code']}",
                    )
                replay = self._replay_or_permanently_block_locked(
                    match_id=event.match_id,
                    policy_archive=policy_archive,
                    verified_at_ns=verified_at_ns,
                )
                verify_authorized_rule_event(
                    envelope,
                    policy_archive=policy_archive,
                    verified_at_ns=verified_at_ns,
                )
                self._validate_envelope_policy_timeline(envelope, replay.adoptions)
                self._check_event_scope(event, match_row)
                if idempotency_relation is not None:
                    if not idempotency_relation[0]:
                        _fail(idempotency_relation[1], idempotency_relation[2])
                    self._connection.execute(
                        "UPDATE matches SET last_verified_at_ns = ? WHERE match_id = ?",
                        (verified_at_ns, event.match_id),
                    )
                    return self._result_for_existing_locked(
                        idempotency_relation[3],
                        match_row=match_row,
                        replay=replay,
                        verified_at_ns=verified_at_ns,
                    )
                if command.expected_revision != replay.state.revision:
                    _fail("STALE_REVISION", "command expected_revision is not current")
                if event.sequence_number != replay.state.revision + 1:
                    _fail("EVENT_SEQUENCE", "event sequence is not exactly current revision + 1")
                if replay.event_count >= self.ruleset.max_events_per_match:
                    _fail("EVENT_LIMIT", "match event limit reached; external rollover required")
                try:
                    after = self.reducer.reduce(replay.state, event).after
                except RulesError as exc:
                    raise EventStoreError("RULE_REJECTED", str(exc)) from exc
                state_bytes = encode_match_state(after, ruleset=self.ruleset)
                state_fingerprint = match_state_fingerprint(after, ruleset=self.ruleset)
                envelope_fingerprint = envelope.fingerprint()
                command_fingerprint = command.fingerprint()
                record_fingerprint = envelope.authorization_record.fingerprint()
                archive_fingerprint = policy_archive.fingerprint()
                current_outbox_id = self._connection.execute(
                    "SELECT COALESCE(MAX(outbox_id), 0) FROM shadow_outbox"
                ).fetchone()[0]
                if (
                    type(current_outbox_id) is not int
                    or current_outbox_id >= MAX_SEQUENCE_NUMBER
                ):
                    _fail(
                        "OUTBOX_ID_EXHAUSTED",
                        "global shadow outbox identity is exhausted",
                    )
                outbox_id = current_outbox_id + 1
                message_id = f"shadow:{outbox_id}:{event.event_id}"
                payload_bytes = self._outbox_payload(
                    envelope=envelope,
                    state_fingerprint=state_fingerprint,
                    archive_fingerprint=archive_fingerprint,
                    message_id=message_id,
                    outbox_id=outbox_id,
                    appended_at_ns=verified_at_ns,
                )
                payload_fingerprint = hashlib.sha256(payload_bytes).hexdigest()
                self._check_projected_ledger_budget(
                    replay.preflight,
                    envelope_bytes=envelope_bytes,
                    state_bytes=state_bytes,
                    outbox_bytes=payload_bytes,
                    text_bytes=self._append_text_bytes(
                        envelope=envelope,
                        message_id=message_id,
                        archive_fingerprint=archive_fingerprint,
                        state_fingerprint=state_fingerprint,
                        payload_fingerprint=payload_fingerprint,
                    ),
                )
                new_head = self._next_head(
                    replay.ledger_head_sha256,
                    event=event,
                    envelope_fingerprint=envelope_fingerprint,
                    authorization_record_fingerprint=record_fingerprint,
                    state_fingerprint=state_fingerprint,
                    outbox_payload_fingerprint=payload_fingerprint,
                    archive_fingerprint=archive_fingerprint,
                    outbox_id=outbox_id,
                    appended_at_ns=verified_at_ns,
                )
                self._insert_append_rows(
                    envelope=envelope,
                    envelope_bytes=envelope_bytes,
                    state_bytes=state_bytes,
                    state_fingerprint=state_fingerprint,
                    payload_bytes=payload_bytes,
                    payload_fingerprint=payload_fingerprint,
                    message_id=message_id,
                    outbox_id=outbox_id,
                    archive_fingerprint=archive_fingerprint,
                    verified_at_ns=verified_at_ns,
                    ledger_head_sha256=new_head,
                )
                self._connection.execute(
                    """
                    INSERT INTO idempotency_log(
                        idempotency_key, match_id, command_fingerprint,
                        envelope_fingerprint, event_id, result_revision,
                        result_state_fingerprint, outbox_id,
                        outbox_payload_fingerprint, reducer_build_sha256
                    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        command.idempotency_key,
                        event.match_id,
                        command_fingerprint,
                        envelope_fingerprint,
                        event.event_id,
                        event.sequence_number,
                        state_fingerprint,
                        outbox_id,
                        payload_fingerprint,
                        self.reducer_build_sha256,
                    ),
                )
                changed = self._connection.execute(
                    """
                    UPDATE matches SET
                        last_verified_at_ns = ?, current_revision = ?,
                        current_state_bytes = ?, current_state_fingerprint = ?,
                        ledger_head_sha256 = ?
                    WHERE match_id = ? AND current_revision = ?
                    """,
                    (
                        verified_at_ns,
                        event.sequence_number,
                        state_bytes,
                        state_fingerprint,
                        new_head,
                        event.match_id,
                        replay.state.revision,
                    ),
                ).rowcount
                if changed != 1:
                    _fail("CONCURRENT_REVISION", "match projection revision changed")
                self._apply_private_test_fault_locked()
                self._validate_schema()
                current_row = self._load_match_locked(event.match_id)
                accepted_replay = self._replay_locked(
                    match_id=event.match_id,
                    policy_archive=policy_archive,
                    verified_at_ns=verified_at_ns,
                )
                expected_replay = (
                    after,
                    state_bytes,
                    state_fingerprint,
                    new_head,
                    outbox_id,
                    replay.event_count + 1,
                )
                actual_replay = (
                    accepted_replay.state,
                    accepted_replay.state_bytes,
                    accepted_replay.state_fingerprint,
                    accepted_replay.ledger_head_sha256,
                    accepted_replay.outbox_position,
                    accepted_replay.event_count,
                )
                if actual_replay != expected_replay:
                    _fail("POST_APPEND_REPLAY", "accepted rows differ from proposed transition")
                checkpoint = self._checkpoint_from_row(
                    current_row, replay=accepted_replay, verified_at_ns=verified_at_ns
                )
                result = AppendResult(
                    event.match_id,
                    event.sequence_number,
                    event.event_id,
                    event.fingerprint(),
                    command_fingerprint,
                    envelope_fingerprint,
                    record_fingerprint,
                    state_fingerprint,
                    outbox_id,
                    message_id,
                    payload_fingerprint,
                    archive_fingerprint,
                    self.reducer_build_sha256,
                    new_head,
                    checkpoint,
                )
            return result
        except sqlite3.IntegrityError as exc:
            raise EventStoreError("IMMUTABLE_IDENTITY_CONFLICT", str(exc)) from exc
        except sqlite3.OperationalError as exc:
            code = "CONCURRENT_WRITE" if "locked" in str(exc).lower() else "SQLITE_OPERATION"
            raise EventStoreError(code, str(exc)) from exc

    @_sqlite_boundary
    def audit_replay(
        self,
        match_id: str,
        *,
        policy_archive: AuthorizationPolicyArchive,
        verified_at_ns: int,
    ) -> AuditResult:
        """Reverify the complete ledger and advance its local trust-time floor."""

        match_id = _stable_id(match_id, "match_id")
        verified_at_ns = _timestamp(verified_at_ns, "verified_at_ns")
        try:
            with self._transaction(immediate=True):
                self._validate_schema()
                row = self._load_match_locked(match_id)
                self._check_match_pins(row, policy_archive=policy_archive)
                self._check_time_locked(row, at_ns=verified_at_ns)
                if row["integrity_blocked"]:
                    _fail(
                        "INTEGRITY_BLOCKED",
                        f"archive adoption blocked ledger: {row['integrity_failure_code']}",
                    )
                replay = self._replay_or_permanently_block_locked(
                    match_id=match_id,
                    policy_archive=policy_archive,
                    verified_at_ns=verified_at_ns,
                )
                self._connection.execute(
                    "UPDATE matches SET last_verified_at_ns = ? WHERE match_id = ?",
                    (verified_at_ns, match_id),
                )
                checkpoint = self._checkpoint_from_row(
                    row, replay=replay, verified_at_ns=verified_at_ns
                )
                result = AuditResult(
                    match_id,
                    replay.event_count,
                    replay.state_fingerprint,
                    replay.ledger_head_sha256,
                    policy_archive.fingerprint(),
                    self.reducer_build_sha256,
                    checkpoint,
                )
            return result
        except sqlite3.OperationalError as exc:
            code = "CONCURRENT_WRITE" if "locked" in str(exc).lower() else "SQLITE_OPERATION"
            raise EventStoreError(code, str(exc)) from exc

    @_sqlite_boundary
    def ledger_checkpoint(
        self,
        match_id: str,
        *,
        policy_archive: AuthorizationPolicyArchive,
        verified_at_ns: int,
    ) -> LedgerCheckpoint:
        """Return a fully audited checkpoint for external monotonic protection."""

        return self.audit_replay(
            match_id,
            policy_archive=policy_archive,
            verified_at_ns=verified_at_ns,
        ).checkpoint

    @_sqlite_boundary
    def advance_authorization_archive(
        self,
        match_id: str,
        *,
        previous_archive: AuthorizationPolicyArchive,
        new_archive: AuthorizationPolicyArchive,
        adopted_at_ns: int,
    ) -> ArchiveAdvancementResult:
        """Atomically adopt a structurally monotonic protected archive.

        The protected loader must supply both exact generations.  A newer
        revocation may intentionally invalidate already-persisted envelopes;
        that adoption remains committed and permanently blocks this ledger's
        append/audit path until a separate external recovery process is used.
        Falling back to the prior archive is then rejected by its pinned hash.
        """

        match_id = _stable_id(match_id, "match_id")
        adopted_at_ns = _timestamp(adopted_at_ns, "adopted_at_ns")
        self._require_archive_scope(previous_archive, match_id=match_id)
        self._require_archive_scope(new_archive, match_id=match_id)
        try:
            with self._transaction(immediate=True):
                self._validate_schema()
                row = self._load_match_locked(match_id)
                self._check_match_pins(row, policy_archive=previous_archive)
                self._check_time_locked(row, at_ns=adopted_at_ns)
                if adopted_at_ns <= row["last_verified_at_ns"]:
                    _fail(
                        "ARCHIVE_ADOPTION_TIME",
                        "archive advancement must be later than the trust-time floor",
                    )
                if row["integrity_blocked"]:
                    _fail("INTEGRITY_BLOCKED", "blocked ledgers require external recovery")
                previous_replay = self._replay_or_permanently_block_locked(
                    match_id=match_id,
                    policy_archive=previous_archive,
                    verified_at_ns=adopted_at_ns,
                )
                self._validate_archive_advancement(
                    previous_archive,
                    new_archive,
                    adopted_at_ns=adopted_at_ns,
                )
                previous_fingerprint = previous_archive.fingerprint()
                new_fingerprint = new_archive.fingerprint()
                generation = self._connection.execute(
                    "SELECT MAX(generation) FROM archive_adoptions WHERE match_id = ?",
                    (match_id,),
                ).fetchone()[0] + 1
                if generation >= MAX_ARCHIVE_ADOPTIONS:
                    _fail(
                        "ARCHIVE_ADOPTION_LIMIT",
                        "archive adoption limit reached; external ledger rollover required",
                    )
                new_archive_bytes = _archive_bytes(new_archive)
                current_archive_stats = self._connection.execute(
                    """
                    SELECT COALESCE(SUM(length(archive_bytes)), 0),
                           COALESCE(SUM(
                               length(match_id) +
                               COALESCE(length(previous_archive_fingerprint), 0) +
                               length(adopted_archive_fingerprint) + length(archive_id) +
                               length(trust_domain_id) +
                               length(current_policy_fingerprint) +
                               length(archive_history_head_sha256)
                           ), 0)
                    FROM archive_adoptions WHERE match_id = ?
                    """,
                    (match_id,),
                ).fetchone()
                current_archive_bytes, current_archive_text = current_archive_stats
                if (
                    type(current_archive_bytes) is not int
                    or current_archive_bytes < 0
                    or current_archive_bytes + len(new_archive_bytes)
                    > MAX_ARCHIVE_HISTORY_BYTES_PER_MATCH
                ):
                    _fail(
                        "ARCHIVE_BYTE_BUDGET",
                        "archive adoption exceeds cumulative byte budget",
                    )
                new_archive_text = sum(
                    len(value)
                    for value in (
                        match_id,
                        previous_fingerprint,
                        new_fingerprint,
                        new_archive.archive_id,
                        new_archive.trust_domain_id,
                        new_archive.current_policy_fingerprint,
                        "0" * 64,
                    )
                )
                if (
                    type(current_archive_text) is not int
                    or current_archive_text < 0
                    or current_archive_text + new_archive_text
                    > MAX_ARCHIVE_TEXT_BYTES_PER_MATCH
                ):
                    _fail(
                        "ARCHIVE_TEXT_BUDGET",
                        "archive adoption exceeds cumulative text budget",
                    )
                archive_head = self._archive_history_head(
                    previous_head=row["archive_history_head_sha256"],
                    generation=generation,
                    previous_archive_fingerprint=previous_fingerprint,
                    adopted_archive_fingerprint=new_fingerprint,
                    current_policy_fingerprint=new_archive.current_policy_fingerprint,
                    adopted_at_ns=adopted_at_ns,
                    archive_bytes=new_archive_bytes,
                )
                self._connection.execute(
                    """
                    INSERT INTO archive_adoptions(
                        match_id, generation, previous_archive_fingerprint,
                        adopted_archive_fingerprint, archive_id, trust_domain_id,
                        current_policy_fingerprint, adopted_at_ns, archive_bytes,
                        archive_history_head_sha256
                    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        match_id,
                        generation,
                        previous_fingerprint,
                        new_fingerprint,
                        new_archive.archive_id,
                        new_archive.trust_domain_id,
                        new_archive.current_policy_fingerprint,
                        adopted_at_ns,
                        new_archive_bytes,
                        archive_head,
                    ),
                )
                self._connection.execute(
                    """
                    UPDATE matches SET adopted_archive_fingerprint = ?,
                        archive_history_head_sha256 = ?,
                        last_verified_at_ns = ?, integrity_blocked = 0,
                        integrity_failure_code = NULL
                    WHERE match_id = ?
                    """,
                    (new_fingerprint, archive_head, adopted_at_ns, match_id),
                )
                integrity_valid = True
                failure_code: str | None = None
                try:
                    adopted_replay = self._replay_locked(
                        match_id=match_id,
                        policy_archive=new_archive,
                        verified_at_ns=adopted_at_ns,
                    )
                except AuthorizationError as exc:
                    integrity_valid = False
                    failure_code = f"AUTHORIZATION_{exc.code}"[:MAX_FAILURE_CODE_LENGTH]
                    self._connection.execute(
                        """
                        UPDATE matches SET integrity_blocked = 1,
                            integrity_failure_code = ? WHERE match_id = ?
                        """,
                        (failure_code, match_id),
                    )
                    adopted_replay = previous_replay
                adopted_row = self._load_match_locked(match_id)
                checkpoint = self._checkpoint_from_row(
                    adopted_row,
                    replay=adopted_replay,
                    verified_at_ns=adopted_at_ns,
                )
                result = ArchiveAdvancementResult(
                    match_id,
                    previous_fingerprint,
                    new_fingerprint,
                    generation,
                    adopted_at_ns,
                    self.reducer_build_sha256,
                    integrity_valid,
                    failure_code,
                    checkpoint,
                )
            return result
        except sqlite3.IntegrityError as exc:
            raise EventStoreError("ARCHIVE_ADOPTION_CONFLICT", str(exc)) from exc
        except sqlite3.OperationalError as exc:
            code = "CONCURRENT_WRITE" if "locked" in str(exc).lower() else "SQLITE_OPERATION"
            raise EventStoreError(code, str(exc)) from exc

    def _require_archive_scope(
        self,
        archive: AuthorizationPolicyArchive,
        *,
        match_id: str,
    ) -> None:
        if type(archive) is not AuthorizationPolicyArchive:
            raise ValueError("policy_archive must be exact")
        if archive.match_id != match_id:
            _fail("ARCHIVE_MATCH_SCOPE", "archive is scoped to another match")

    def _load_match_locked(self, match_id: str) -> sqlite3.Row:
        row = self._connection.execute(
            "SELECT * FROM matches WHERE match_id = ?", (match_id,)
        ).fetchone()
        if row is None:
            _fail("MATCH_NOT_INITIALIZED", "explicit initialize_match is required")
        return row

    def _check_match_pins(
        self,
        row: sqlite3.Row,
        *,
        policy_archive: AuthorizationPolicyArchive,
    ) -> None:
        match_id = row["match_id"]
        self._require_archive_scope(policy_archive, match_id=match_id)
        exact = {
            "ruleset_id": self.ruleset.ruleset_id,
            "ruleset_version": self.ruleset.version,
            "ruleset_fingerprint": self.ruleset.fingerprint(),
            "reducer_build_sha256": self.reducer_build_sha256,
            "authorization_archive_id": policy_archive.archive_id,
            "authorization_trust_domain_id": policy_archive.trust_domain_id,
            "adopted_archive_fingerprint": policy_archive.fingerprint(),
            "max_events_per_match": self.ruleset.max_events_per_match,
            "match_binding_fingerprint": self._binding_fingerprint(
                match_id, policy_archive
            ),
        }
        for field_name, expected in exact.items():
            if row[field_name] != expected:
                _fail("TRUST_PIN_MISMATCH", f"pinned field differs: {field_name}")

    def _check_time_locked(
        self,
        row: sqlite3.Row,
        *,
        at_ns: int,
        event: RuleEvent | None = None,
        authorized_at_ns: int | None = None,
    ) -> None:
        if at_ns < row["last_verified_at_ns"]:
            _fail("VERIFICATION_TIME_ROLLBACK", "verification time moved backward")
        if event is not None:
            if authorized_at_ns is None:
                raise AssertionError("authorized_at_ns required with an event")
            if authorized_at_ns < event.created_at_ns:
                _fail("EVENT_CAUSALITY", "authorization predates event creation")
            if at_ns < authorized_at_ns or at_ns < event.created_at_ns:
                _fail("EVENT_CAUSALITY", "verification predates event/authorization")

    def _check_event_scope(self, event: RuleEvent, match_row: sqlite3.Row) -> None:
        if event.match_id != match_row["match_id"]:
            _fail("EVENT_MATCH_SCOPE", "event match differs from initialized match")
        if (
            event.ruleset_id != self.ruleset.ruleset_id
            or event.ruleset_version != self.ruleset.version
            or event.ruleset_fingerprint != self.ruleset.fingerprint()
        ):
            _fail("EVENT_RULESET_SCOPE", "event does not bind the pinned ruleset")

    def _validate_envelope_policy_timeline(
        self,
        envelope: AuthorizedRuleEvent,
        adoptions: tuple[_ArchiveAdoption, ...],
    ) -> None:
        record = envelope.authorization_record
        command = record.signed_command.command
        policy_fingerprint = record.policy.fingerprint()
        checkpoints: list[tuple[str, int]] = [
            ("command issue", command.issued_at_ns),
            ("authorization", record.authorized_at_ns),
        ]
        if command.signed_assessment is not None:
            checkpoints.insert(
                0,
                (
                    "assessment signature",
                    command.signed_assessment.signed_at_ns,
                ),
            )
        for label, timestamp_ns in checkpoints:
            current = [
                adoption
                for adoption in adoptions
                if adoption.adopted_at_ns <= timestamp_ns
            ]
            if not current:
                _fail(
                    "POLICY_BEFORE_ADOPTION",
                    f"envelope {label} predates the first trusted archive adoption",
                )
            if current[-1].current_policy_fingerprint != policy_fingerprint:
                _fail(
                    "POLICY_NOT_CURRENT_AT_TIME",
                    f"envelope policy was not ledger-current at {label}",
                )

    def _idempotency_relation_locked(
        self,
        idempotency_key: str,
        command_fingerprint: str,
        envelope_fingerprint: str,
        event_id: str,
    ) -> tuple[bool, str, str, sqlite3.Row] | None:
        rows = self._connection.execute(
            """
            SELECT * FROM idempotency_log
            WHERE idempotency_key = ? OR command_fingerprint = ?
               OR envelope_fingerprint = ? OR event_id = ?
            """,
            (idempotency_key, command_fingerprint, envelope_fingerprint, event_id),
        ).fetchmany(5)
        if not rows:
            return None
        exact = [
            row
            for row in rows
            if (
                row["idempotency_key"] == idempotency_key
                and row["command_fingerprint"] == command_fingerprint
                and row["envelope_fingerprint"] == envelope_fingerprint
                and row["event_id"] == event_id
            )
        ]
        if len(exact) == 1 and len(rows) == 1:
            return (True, "", "", exact[0])
        if any(row["idempotency_key"] == idempotency_key for row in rows):
            return (
                False,
                "IDEMPOTENCY_CONFLICT",
                "idempotency key is already bound to different canonical content",
                rows[0],
            )
        if any(row["command_fingerprint"] == command_fingerprint for row in rows):
            return (
                False,
                "IDEMPOTENCY_KEY_CONFLICT",
                "exact command was submitted under a different idempotency key",
                rows[0],
            )
        return (
            False,
            "GLOBAL_IDENTITY_CONFLICT",
            "envelope or event identity is globally bound to another request",
            rows[0],
        )

    def _insert_append_rows(
        self,
        *,
        envelope: AuthorizedRuleEvent,
        envelope_bytes: bytes,
        state_bytes: bytes,
        state_fingerprint: str,
        payload_bytes: bytes,
        payload_fingerprint: str,
        message_id: str,
        outbox_id: int,
        archive_fingerprint: str,
        verified_at_ns: int,
        ledger_head_sha256: str,
    ) -> None:
        event = envelope.event
        record = envelope.authorization_record
        command = record.signed_command.command
        envelope_fingerprint = envelope.fingerprint()
        self._connection.execute(
            """
            INSERT INTO authorization_log(
                match_id, revision, event_id, envelope_fingerprint,
                authorization_record_fingerprint, command_fingerprint,
                policy_fingerprint, adopted_archive_fingerprint, actor_id,
                actor_key_id, authorizer_id, authorizer_key_id,
                authorized_at_ns, verified_at_ns, envelope_bytes
            ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                event.match_id,
                event.sequence_number,
                event.event_id,
                envelope_fingerprint,
                record.fingerprint(),
                command.fingerprint(),
                record.policy.fingerprint(),
                archive_fingerprint,
                record.actor_key.actor_id,
                record.actor_key.key_id,
                record.authorizer_key.authorizer_id,
                record.authorizer_key.key_id,
                record.authorized_at_ns,
                verified_at_ns,
                envelope_bytes,
            ),
        )
        self._connection.execute(
            """
            INSERT INTO event_log(
                match_id, revision, event_id, event_type, event_fingerprint,
                envelope_fingerprint, adopted_archive_fingerprint,
                envelope_bytes, created_at_ns, appended_at_ns, related_rally_id
            ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                event.match_id,
                event.sequence_number,
                event.event_id,
                event.event_type.value,
                event.fingerprint(),
                envelope_fingerprint,
                archive_fingerprint,
                envelope_bytes,
                event.created_at_ns,
                verified_at_ns,
                event.related_rally_id,
            ),
        )
        self._connection.execute(
            """
            INSERT INTO state_history(
                match_id, revision, event_id, state_bytes, state_fingerprint,
                ledger_head_sha256
            ) VALUES(?, ?, ?, ?, ?, ?)
            """,
            (
                event.match_id,
                event.sequence_number,
                event.event_id,
                state_bytes,
                state_fingerprint,
                ledger_head_sha256,
            ),
        )
        self._connection.execute(
            """
            INSERT INTO shadow_outbox(
                outbox_id, message_id, match_id, revision, event_id, topic, target,
                payload_bytes, payload_fingerprint, envelope_fingerprint,
                state_fingerprint, reducer_build_sha256, created_at_ns
            ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                outbox_id,
                message_id,
                event.match_id,
                event.sequence_number,
                event.event_id,
                SHADOW_OUTBOX_TOPIC,
                SHADOW_OUTBOX_TARGET,
                payload_bytes,
                payload_fingerprint,
                envelope_fingerprint,
                state_fingerprint,
                self.reducer_build_sha256,
                verified_at_ns,
            ),
        )

    def _outbox_payload(
        self,
        *,
        envelope: AuthorizedRuleEvent,
        state_fingerprint: str,
        archive_fingerprint: str,
        message_id: str,
        outbox_id: int,
        appended_at_ns: int,
    ) -> bytes:
        event = envelope.event
        payload = _canonical_json(
            {
                "adopted_archive_fingerprint": archive_fingerprint,
                "appended_at_ns": appended_at_ns,
                "authorization_record_fingerprint": (
                    envelope.authorization_record.fingerprint()
                ),
                "envelope_fingerprint": envelope.fingerprint(),
                "event_fingerprint": event.fingerprint(),
                "event_id": event.event_id,
                "match_id": event.match_id,
                "message_id": message_id,
                "official_scorecheck_mutation_permitted": False,
                "outbox_id": outbox_id,
                "reducer_build_sha256": self.reducer_build_sha256,
                "revision": event.sequence_number,
                "state_fingerprint": state_fingerprint,
                "target": SHADOW_OUTBOX_TARGET,
                "topic": SHADOW_OUTBOX_TOPIC,
            }
        )
        if len(payload) > MAX_SHADOW_OUTBOX_PAYLOAD_BYTES:
            _fail("OUTBOX_BOUNDS", "derived shadow payload exceeds its fixed bound")
        return payload

    def _next_head(
        self,
        previous_head: str,
        *,
        event: RuleEvent,
        envelope_fingerprint: str,
        authorization_record_fingerprint: str,
        state_fingerprint: str,
        outbox_payload_fingerprint: str,
        archive_fingerprint: str,
        outbox_id: int,
        appended_at_ns: int,
    ) -> str:
        return hashlib.sha256(
            _CHAIN_DOMAIN
            + bytes.fromhex(previous_head)
            + _canonical_json(
                {
                    "adopted_archive_fingerprint": archive_fingerprint,
                    "appended_at_ns": appended_at_ns,
                    "authorization_record_fingerprint": authorization_record_fingerprint,
                    "envelope_fingerprint": envelope_fingerprint,
                    "event_fingerprint": event.fingerprint(),
                    "event_id": event.event_id,
                    "match_id": event.match_id,
                    "outbox_payload_fingerprint": outbox_payload_fingerprint,
                    "outbox_id": outbox_id,
                    "reducer_build_sha256": self.reducer_build_sha256,
                    "revision": event.sequence_number,
                    "state_fingerprint": state_fingerprint,
                }
            )
        ).hexdigest()

    def _replay_or_permanently_block_locked(
        self,
        *,
        match_id: str,
        policy_archive: AuthorizationPolicyArchive,
        verified_at_ns: int,
    ) -> _ReplayResult:
        try:
            return self._replay_locked(
                match_id=match_id,
                policy_archive=policy_archive,
                verified_at_ns=verified_at_ns,
            )
        except AuthorizationError as exc:
            failure_code = f"AUTHORIZATION_{exc.code}"[:MAX_FAILURE_CODE_LENGTH]
            changed = self._connection.execute(
                """
                UPDATE matches SET integrity_blocked = 1,
                    integrity_failure_code = ?, last_verified_at_ns = ?
                WHERE match_id = ? AND integrity_blocked = 0
                """,
                (failure_code, verified_at_ns, match_id),
            ).rowcount
            if changed != 1:
                _fail("INTEGRITY_BLOCKED", "ledger is already permanently blocked")
            checkpoint = self._blocked_checkpoint_locked(
                match_id=match_id,
                verified_at_ns=verified_at_ns,
            )
            raise _PersistedIntegrityBlock(failure_code, checkpoint) from exc

    def _blocked_checkpoint_locked(
        self,
        *,
        match_id: str,
        verified_at_ns: int,
    ) -> LedgerCheckpoint:
        row = self._load_match_locked(match_id)
        generation = self._connection.execute(
            "SELECT MAX(generation) FROM archive_adoptions WHERE match_id = ?",
            (match_id,),
        ).fetchone()[0]
        outbox_position = self._connection.execute(
            "SELECT COALESCE(MAX(outbox_id), 0) FROM shadow_outbox WHERE match_id = ?",
            (match_id,),
        ).fetchone()[0]
        return LedgerCheckpoint(
            match_id,
            row["match_binding_fingerprint"],
            row["current_revision"],
            row["ledger_head_sha256"],
            row["current_state_fingerprint"],
            row["adopted_archive_fingerprint"],
            generation,
            row["archive_history_head_sha256"],
            self.reducer_build_sha256,
            outbox_position,
            verified_at_ns,
            True,
            row["integrity_failure_code"],
        )

    def _replay_locked(
        self,
        *,
        match_id: str,
        policy_archive: AuthorizationPolicyArchive,
        verified_at_ns: int,
    ) -> _ReplayResult:
        match_row = self._load_match_locked(match_id)
        self._check_match_pins(match_row, policy_archive=policy_archive)
        self._check_time_locked(match_row, at_ns=verified_at_ns)
        if not policy_archive.current_policy.is_active(verified_at_ns):
            _fail("ARCHIVE_INACTIVE", "adopted current policy is inactive at verification")
        adoptions = self._validate_adoption_history_locked(
            match_row, policy_archive=policy_archive
        )
        adoption_fingerprints = tuple(item.archive_fingerprint for item in adoptions)
        preflight = self._ledger_preflight_locked(match_id)
        state = self.reducer.new_match(match_id)
        state_bytes = encode_match_state(state, ruleset=self.ruleset)
        state_fingerprint = match_state_fingerprint(state, ruleset=self.ruleset)
        head = self._genesis_head(
            match_binding_fingerprint=match_row["match_binding_fingerprint"],
            initial_state_fingerprint=state_fingerprint,
            initial_archive_fingerprint=adoption_fingerprints[0],
        )
        event_rows = self._connection.execute(
            "SELECT * FROM event_log WHERE match_id = ? ORDER BY revision",
            (match_id,),
        )
        outbox_position = 0
        previous_appended_at_ns = match_row["initialized_at_ns"]
        replayed_count = 0
        for expected_revision, event_row in enumerate(event_rows, start=1):
            replayed_count = expected_revision
            if event_row["revision"] != expected_revision:
                _fail("EVENT_LOG_SEQUENCE", "event log revisions are not contiguous")
            raw = event_row["envelope_bytes"]
            if type(raw) is not bytes:
                _fail("EVENT_LOG_ENCODING", "persisted envelope is not a BLOB")
            try:
                envelope = parse_authorized_rule_event(raw)
            except (AuthorizationError, ValueError) as exc:
                raise EventStoreError("ENVELOPE_INVALID", str(exc)) from exc
            event = verify_authorized_rule_event(
                envelope,
                policy_archive=policy_archive,
                verified_at_ns=verified_at_ns,
            )
            self._validate_envelope_policy_timeline(envelope, adoptions)
            self._check_event_scope(event, match_row)
            self._check_time_locked(
                match_row,
                at_ns=verified_at_ns,
                event=event,
                authorized_at_ns=envelope.authorization_record.authorized_at_ns,
            )
            if event.sequence_number != expected_revision:
                _fail("EVENT_SEQUENCE_CORRUPTION", "event sequence differs from ledger revision")
            envelope_fingerprint = envelope.fingerprint()
            archive_fingerprint = event_row["adopted_archive_fingerprint"]
            if archive_fingerprint not in adoption_fingerprints:
                _fail("EVENT_ARCHIVE_HISTORY", "event references an unadopted archive")
            appended_at_ns = event_row["appended_at_ns"]
            if (
                type(appended_at_ns) is not int
                or appended_at_ns < previous_appended_at_ns
                or appended_at_ns > verified_at_ns
            ):
                _fail("EVENT_APPEND_TIME", "event append times are not monotonic/causal")
            active_adoptions = [
                item for item in adoptions if item.adopted_at_ns <= appended_at_ns
            ]
            if (
                not active_adoptions
                or active_adoptions[-1].archive_fingerprint != archive_fingerprint
            ):
                _fail("EVENT_ARCHIVE_HISTORY", "event did not use archive current at append")
            previous_appended_at_ns = appended_at_ns
            expected_event_values = (
                event.match_id,
                event.sequence_number,
                event.event_id,
                event.event_type.value,
                event.fingerprint(),
                envelope_fingerprint,
                raw,
                event.created_at_ns,
                appended_at_ns,
                event.related_rally_id,
            )
            actual_event_values = (
                event_row["match_id"],
                event_row["revision"],
                event_row["event_id"],
                event_row["event_type"],
                event_row["event_fingerprint"],
                event_row["envelope_fingerprint"],
                event_row["envelope_bytes"],
                event_row["created_at_ns"],
                event_row["appended_at_ns"],
                event_row["related_rally_id"],
            )
            if actual_event_values != expected_event_values:
                _fail("EVENT_LOG_TAMPER", "event log metadata differs from its envelope")
            authorization_row = self._one_row_locked(
                "authorization_log", match_id, expected_revision
            )
            record = envelope.authorization_record
            command = record.signed_command.command
            if command.origin is not AuthorizationOrigin.HUMAN_DIRECT:
                _fail(
                    "ASSISTED_CONTEXT_REQUIRED",
                    "persisted assessment-assisted command lacks an atomic case link",
                )
            expected_authorization_values = (
                event.match_id,
                expected_revision,
                event.event_id,
                envelope_fingerprint,
                record.fingerprint(),
                command.fingerprint(),
                record.policy.fingerprint(),
                archive_fingerprint,
                record.actor_key.actor_id,
                record.actor_key.key_id,
                record.authorizer_key.authorizer_id,
                record.authorizer_key.key_id,
                record.authorized_at_ns,
                appended_at_ns,
                raw,
            )
            actual_authorization_values = tuple(
                authorization_row[field]
                for field in (
                    "match_id",
                    "revision",
                    "event_id",
                    "envelope_fingerprint",
                    "authorization_record_fingerprint",
                    "command_fingerprint",
                    "policy_fingerprint",
                    "adopted_archive_fingerprint",
                    "actor_id",
                    "actor_key_id",
                    "authorizer_id",
                    "authorizer_key_id",
                    "authorized_at_ns",
                    "verified_at_ns",
                    "envelope_bytes",
                )
            )
            if actual_authorization_values != expected_authorization_values:
                _fail("AUTHORIZATION_LOG_TAMPER", "authorization log differs from envelope")
            try:
                state = self.reducer.reduce(state, event).after
            except RulesError as exc:
                raise EventStoreError("REPLAY_RULE_REJECTED", str(exc)) from exc
            state_bytes = encode_match_state(state, ruleset=self.ruleset)
            state_fingerprint = match_state_fingerprint(state, ruleset=self.ruleset)
            state_row = self._one_row_locked(
                "state_history", match_id, expected_revision
            )
            if (
                state_row["event_id"] != event.event_id
                or type(state_row["state_bytes"]) is not bytes
                or len(state_row["state_bytes"]) > MAX_RAW_STATE_BYTES
                or state_row["state_bytes"] != state_bytes
                or state_row["state_fingerprint"] != state_fingerprint
            ):
                _fail("STATE_HISTORY_TAMPER", "state snapshot differs from full replay")
            outbox_row = self._one_row_locked(
                "shadow_outbox", match_id, expected_revision
            )
            outbox_id = outbox_row["outbox_id"]
            if type(outbox_id) is not int or not 1 <= outbox_id <= MAX_SEQUENCE_NUMBER:
                _fail("OUTBOX_TAMPER", "shadow outbox identity is invalid")
            message_id = f"shadow:{outbox_id}:{event.event_id}"
            payload = self._outbox_payload(
                envelope=envelope,
                state_fingerprint=state_fingerprint,
                archive_fingerprint=archive_fingerprint,
                message_id=message_id,
                outbox_id=outbox_id,
                appended_at_ns=appended_at_ns,
            )
            payload_fingerprint = hashlib.sha256(payload).hexdigest()
            expected_outbox_values = (
                outbox_id,
                message_id,
                event.match_id,
                expected_revision,
                event.event_id,
                SHADOW_OUTBOX_TOPIC,
                SHADOW_OUTBOX_TARGET,
                payload,
                payload_fingerprint,
                envelope_fingerprint,
                state_fingerprint,
                self.reducer_build_sha256,
                appended_at_ns,
            )
            actual_outbox_values = tuple(
                outbox_row[field]
                for field in (
                    "outbox_id",
                    "message_id",
                    "match_id",
                    "revision",
                    "event_id",
                    "topic",
                    "target",
                    "payload_bytes",
                    "payload_fingerprint",
                    "envelope_fingerprint",
                    "state_fingerprint",
                    "reducer_build_sha256",
                    "created_at_ns",
                )
            )
            if actual_outbox_values != expected_outbox_values:
                _fail("OUTBOX_TAMPER", "shadow outbox differs from derived message")
            if len(outbox_row["payload_bytes"]) > MAX_SHADOW_OUTBOX_PAYLOAD_BYTES:
                _fail("OUTBOX_TAMPER", "shadow outbox payload exceeds its bound")
            idempotency_row = self._connection.execute(
                "SELECT * FROM idempotency_log WHERE event_id = ?", (event.event_id,)
            ).fetchone()
            if idempotency_row is None:
                _fail("IDEMPOTENCY_LOG_TAMPER", "event has no idempotency record")
            expected_idempotency_values = (
                command.idempotency_key,
                event.match_id,
                command.fingerprint(),
                envelope_fingerprint,
                event.event_id,
                expected_revision,
                state_fingerprint,
                outbox_row["outbox_id"],
                payload_fingerprint,
                self.reducer_build_sha256,
            )
            actual_idempotency_values = tuple(
                idempotency_row[field]
                for field in (
                    "idempotency_key",
                    "match_id",
                    "command_fingerprint",
                    "envelope_fingerprint",
                    "event_id",
                    "result_revision",
                    "result_state_fingerprint",
                    "outbox_id",
                    "outbox_payload_fingerprint",
                    "reducer_build_sha256",
                )
            )
            if actual_idempotency_values != expected_idempotency_values:
                _fail("IDEMPOTENCY_LOG_TAMPER", "idempotency result differs from ledger")
            outbox_position = outbox_row["outbox_id"]
            head = self._next_head(
                head,
                event=event,
                envelope_fingerprint=envelope_fingerprint,
                authorization_record_fingerprint=record.fingerprint(),
                state_fingerprint=state_fingerprint,
                outbox_payload_fingerprint=payload_fingerprint,
                archive_fingerprint=archive_fingerprint,
                outbox_id=outbox_id,
                appended_at_ns=appended_at_ns,
            )
            if state_row["ledger_head_sha256"] != head:
                _fail("STATE_HISTORY_TAMPER", "persisted prefix ledger head differs")
        self._validate_match_row_after_replay(
            match_row,
            state=state,
            state_bytes=state_bytes,
            state_fingerprint=state_fingerprint,
            ledger_head_sha256=head,
            event_count=replayed_count,
        )
        if replayed_count != preflight.event_count:
            _fail("LEDGER_CARDINALITY", "streamed event count differs from preflight")
        return _ReplayResult(
            state,
            state_bytes,
            state_fingerprint,
            head,
            outbox_position,
            replayed_count,
            adoptions,
            preflight,
        )

    def _apply_private_test_fault_locked(self) -> None:
        """Closed test seam: it can only force rollback or detectable corruption."""

        mode = self._test_fault_mode
        if mode is None:
            return
        self._test_fault_mode = None
        if mode == "RAISE_BEFORE_POST_REPLAY":
            _fail("TEST_FAULT_INJECTED", "private deterministic fault was injected")
        if mode == "CORRUPT_OUTBOX_BEFORE_POST_REPLAY":
            self._connection.execute(
                "UPDATE shadow_outbox SET payload_bytes = ? "
                "WHERE outbox_id = (SELECT MAX(outbox_id) FROM shadow_outbox)",
                (b"{}",),
            )
            return
        _fail("TEST_FAULT_MODE", "private test fault mode is unsupported")

    def _one_row_locked(
        self, table_name: str, match_id: str, revision: int
    ) -> sqlite3.Row:
        if table_name not in {"authorization_log", "state_history", "shadow_outbox"}:
            raise AssertionError("unapproved table name")
        rows = self._connection.execute(
            f"SELECT * FROM {table_name} WHERE match_id = ? AND revision = ?",
            (match_id, revision),
        ).fetchmany(2)
        if len(rows) != 1:
            _fail("LEDGER_CARDINALITY", f"{table_name} must have exactly one row per event")
        return rows[0]

    def _ledger_preflight_locked(self, match_id: str) -> _LedgerPreflight:
        """Check counts and byte budgets before selecting any persisted BLOB."""

        event_stats = self._connection.execute(
            """
            SELECT COUNT(*), COALESCE(SUM(length(envelope_bytes)), 0),
                   COALESCE(SUM(
                       length(match_id) + length(event_id) + length(event_type) +
                       length(event_fingerprint) + length(envelope_fingerprint) +
                       length(adopted_archive_fingerprint) +
                       COALESCE(length(related_rally_id), 0)
                   ), 0)
            FROM event_log WHERE match_id = ?
            """,
            (match_id,),
        ).fetchone()
        authorization_stats = self._connection.execute(
            """
            SELECT COUNT(*), COALESCE(SUM(length(envelope_bytes)), 0),
                   COALESCE(SUM(
                       length(match_id) + length(event_id) +
                       length(envelope_fingerprint) +
                       length(authorization_record_fingerprint) +
                       length(command_fingerprint) + length(policy_fingerprint) +
                       length(adopted_archive_fingerprint) + length(actor_id) +
                       length(actor_key_id) + length(authorizer_id) +
                       length(authorizer_key_id)
                   ), 0)
            FROM authorization_log WHERE match_id = ?
            """,
            (match_id,),
        ).fetchone()
        state_stats = self._connection.execute(
            """
            SELECT COUNT(*), COALESCE(SUM(length(state_bytes)), 0),
                   COALESCE(SUM(
                       length(match_id) + length(event_id) +
                       length(state_fingerprint) + length(ledger_head_sha256)
                   ), 0)
            FROM state_history WHERE match_id = ?
            """,
            (match_id,),
        ).fetchone()
        outbox_stats = self._connection.execute(
            """
            SELECT COUNT(*), COALESCE(SUM(length(payload_bytes)), 0),
                   COALESCE(SUM(
                       length(message_id) + length(match_id) + length(event_id) +
                       length(topic) + length(target) + length(payload_fingerprint) +
                       length(envelope_fingerprint) + length(state_fingerprint) +
                       length(reducer_build_sha256)
                   ), 0)
            FROM shadow_outbox WHERE match_id = ?
            """,
            (match_id,),
        ).fetchone()
        idempotency_stats = self._connection.execute(
            """
            SELECT COUNT(*), COALESCE(SUM(
                length(idempotency_key) + length(match_id) +
                length(command_fingerprint) + length(envelope_fingerprint) +
                length(event_id) + length(result_state_fingerprint) +
                length(outbox_payload_fingerprint) + length(reducer_build_sha256)
            ), 0)
            FROM idempotency_log WHERE match_id = ?
            """,
            (match_id,),
        ).fetchone()
        counts = (
            event_stats[0],
            authorization_stats[0],
            state_stats[0],
            outbox_stats[0],
            idempotency_stats[0],
        )
        if any(type(value) is not int or value < 0 for value in counts):
            _fail("LEDGER_PREFLIGHT", "ledger count aggregate is invalid")
        if len(set(counts)) != 1:
            _fail("LEDGER_CARDINALITY", "ledger table counts differ before replay")
        event_count = counts[0]
        if event_count > self.ruleset.max_events_per_match:
            _fail("EVENT_LIMIT_CORRUPTION", "persisted event count exceeds ruleset bound")
        byte_values = (
            event_stats[1],
            authorization_stats[1],
            state_stats[1],
            outbox_stats[1],
            event_stats[2],
            authorization_stats[2],
            state_stats[2],
            outbox_stats[2],
            idempotency_stats[1],
        )
        if any(type(value) is not int or value < 0 for value in byte_values):
            _fail("LEDGER_PREFLIGHT", "ledger byte aggregate is invalid")
        envelope_bytes = event_stats[1] + authorization_stats[1]
        preflight = _LedgerPreflight(
            event_count,
            envelope_bytes,
            state_stats[1],
            outbox_stats[1],
            sum(
                (
                    event_stats[2],
                    authorization_stats[2],
                    state_stats[2],
                    outbox_stats[2],
                    idempotency_stats[1],
                )
            ),
        )
        if envelope_bytes > MAX_LEDGER_ENVELOPE_BYTES_PER_MATCH:
            _fail("LEDGER_BYTE_BUDGET", "authorization envelope budget exceeded")
        if preflight.state_bytes > MAX_LEDGER_STATE_BYTES_PER_MATCH:
            _fail("LEDGER_BYTE_BUDGET", "state-history byte budget exceeded")
        if preflight.outbox_bytes > MAX_LEDGER_OUTBOX_BYTES_PER_MATCH:
            _fail("LEDGER_BYTE_BUDGET", "shadow-outbox byte budget exceeded")
        if preflight.text_bytes > MAX_LEDGER_TEXT_BYTES_PER_MATCH:
            _fail("LEDGER_TEXT_BUDGET", "ledger text byte budget exceeded")
        if preflight.total_bytes > MAX_LEDGER_TOTAL_BYTES_PER_MATCH:
            _fail("LEDGER_BYTE_BUDGET", "aggregate ledger byte budget exceeded")
        return preflight

    def _check_projected_ledger_budget(
        self,
        preflight: _LedgerPreflight | None,
        *,
        envelope_bytes: bytes,
        state_bytes: bytes,
        outbox_bytes: bytes,
        text_bytes: int,
    ) -> None:
        if preflight is None:
            raise AssertionError("replay preflight is required before append")
        projected_envelopes = preflight.envelope_bytes + 2 * len(envelope_bytes)
        projected_states = preflight.state_bytes + len(state_bytes)
        projected_outbox = preflight.outbox_bytes + len(outbox_bytes)
        projected_text = preflight.text_bytes + text_bytes
        if projected_envelopes > MAX_LEDGER_ENVELOPE_BYTES_PER_MATCH:
            _fail("LEDGER_BYTE_BUDGET", "append exceeds envelope byte budget")
        if projected_states > MAX_LEDGER_STATE_BYTES_PER_MATCH:
            _fail("LEDGER_BYTE_BUDGET", "append exceeds state byte budget")
        if projected_outbox > MAX_LEDGER_OUTBOX_BYTES_PER_MATCH:
            _fail("LEDGER_BYTE_BUDGET", "append exceeds outbox byte budget")
        if projected_text > MAX_LEDGER_TEXT_BYTES_PER_MATCH:
            _fail("LEDGER_TEXT_BUDGET", "append exceeds ledger text byte budget")
        if (
            projected_envelopes + projected_states + projected_outbox + projected_text
            > MAX_LEDGER_TOTAL_BYTES_PER_MATCH
        ):
            _fail("LEDGER_BYTE_BUDGET", "append exceeds aggregate ledger byte budget")

    def _append_text_bytes(
        self,
        *,
        envelope: AuthorizedRuleEvent,
        message_id: str,
        archive_fingerprint: str,
        state_fingerprint: str,
        payload_fingerprint: str,
    ) -> int:
        event = envelope.event
        record = envelope.authorization_record
        command = record.signed_command.command
        envelope_fingerprint = envelope.fingerprint()
        record_fingerprint = record.fingerprint()
        command_fingerprint = command.fingerprint()
        policy_fingerprint = record.policy.fingerprint()
        event_fingerprint = event.fingerprint()
        event_text = (
            event.match_id,
            event.event_id,
            event.event_type.value,
            event_fingerprint,
            envelope_fingerprint,
            archive_fingerprint,
            event.related_rally_id or "",
        )
        authorization_text = (
            event.match_id,
            event.event_id,
            envelope_fingerprint,
            record_fingerprint,
            command_fingerprint,
            policy_fingerprint,
            archive_fingerprint,
            record.actor_key.actor_id,
            record.actor_key.key_id,
            record.authorizer_key.authorizer_id,
            record.authorizer_key.key_id,
        )
        state_text = (event.match_id, event.event_id, state_fingerprint, "0" * 64)
        outbox_text = (
            message_id,
            event.match_id,
            event.event_id,
            SHADOW_OUTBOX_TOPIC,
            SHADOW_OUTBOX_TARGET,
            payload_fingerprint,
            envelope_fingerprint,
            state_fingerprint,
            self.reducer_build_sha256,
        )
        idempotency_text = (
            command.idempotency_key,
            event.match_id,
            command_fingerprint,
            envelope_fingerprint,
            event.event_id,
            state_fingerprint,
            payload_fingerprint,
            self.reducer_build_sha256,
        )
        return sum(
            len(value)
            for value in (
                *event_text,
                *authorization_text,
                *state_text,
                *outbox_text,
                *idempotency_text,
            )
        )

    def _validate_match_row_after_replay(
        self,
        match_row: sqlite3.Row,
        *,
        state: MatchState,
        state_bytes: bytes,
        state_fingerprint: str,
        ledger_head_sha256: str,
        event_count: int,
    ) -> None:
        if (
            type(match_row["current_state_bytes"]) is not bytes
            or len(match_row["current_state_bytes"]) > MAX_RAW_STATE_BYTES
        ):
            _fail("CURRENT_PROJECTION_TAMPER", "cached current state exceeds its bound")
        if state.revision != event_count:
            _fail("EVENT_LOG_SEQUENCE", "replayed state revision differs from event count")
        expected = (
            state.revision,
            state_bytes,
            state_fingerprint,
            ledger_head_sha256,
        )
        actual = (
            match_row["current_revision"],
            match_row["current_state_bytes"],
            match_row["current_state_fingerprint"],
            match_row["ledger_head_sha256"],
        )
        if actual != expected:
            _fail("CURRENT_PROJECTION_TAMPER", "cached current projection differs from replay")

    def _validate_adoption_history_locked(
        self,
        match_row: sqlite3.Row,
        *,
        policy_archive: AuthorizationPolicyArchive,
    ) -> tuple[_ArchiveAdoption, ...]:
        stats = self._connection.execute(
            """
            SELECT COUNT(*), COALESCE(SUM(length(archive_bytes)), 0)
                 , COALESCE(SUM(
                       length(match_id) +
                       COALESCE(length(previous_archive_fingerprint), 0) +
                       length(adopted_archive_fingerprint) + length(archive_id) +
                       length(trust_domain_id) + length(current_policy_fingerprint) +
                       length(archive_history_head_sha256)
                   ), 0)
            FROM archive_adoptions WHERE match_id = ?
            """,
            (match_row["match_id"],),
        ).fetchone()
        adoption_count, archive_bytes_total, archive_text_total = stats
        if (
            type(adoption_count) is not int
            or type(archive_bytes_total) is not int
            or type(archive_text_total) is not int
        ):
            _fail("ARCHIVE_HISTORY", "archive preflight aggregates are invalid")
        if not 1 <= adoption_count <= MAX_ARCHIVE_ADOPTIONS:
            _fail("ARCHIVE_HISTORY", "archive adoption count is outside its bound")
        if not 0 <= archive_bytes_total <= MAX_ARCHIVE_HISTORY_BYTES_PER_MATCH:
            _fail("ARCHIVE_BYTE_BUDGET", "archive history byte budget exceeded")
        if not 0 <= archive_text_total <= MAX_ARCHIVE_TEXT_BYTES_PER_MATCH:
            _fail("ARCHIVE_TEXT_BUDGET", "archive history text budget exceeded")
        rows = self._connection.execute(
            "SELECT * FROM archive_adoptions WHERE match_id = ? ORDER BY generation",
            (match_row["match_id"],),
        )
        previous_fingerprint: str | None = None
        previous_time: int | None = None
        previous_archive: AuthorizationPolicyArchive | None = None
        previous_history_head = "0" * 64
        adoptions: list[_ArchiveAdoption] = []
        first_adoption_time: int | None = None
        latest_raw: bytes | None = None
        for generation, row in enumerate(rows):
            if row["generation"] != generation:
                _fail("ARCHIVE_HISTORY", "archive generations are not contiguous")
            if row["previous_archive_fingerprint"] != previous_fingerprint:
                _fail("ARCHIVE_HISTORY", "archive fingerprint chain is broken")
            raw = row["archive_bytes"]
            if type(raw) is not bytes or len(raw) > MAX_AUTHORIZATION_BYTES:
                _fail("ARCHIVE_HISTORY", "archive encoding is not a BLOB")
            try:
                archive = parse_authorization_policy_archive(raw)
            except AuthorizationError as exc:
                raise EventStoreError(
                    "ARCHIVE_HISTORY_ENCODING",
                    f"persisted archive failed strict parsing: {exc.code}",
                ) from exc
            fingerprint = archive.fingerprint()
            if fingerprint != row["adopted_archive_fingerprint"]:
                _fail("ARCHIVE_HISTORY", "archive bytes disagree with adoption fingerprint")
            if (
                archive.archive_id != row["archive_id"]
                or archive.trust_domain_id != row["trust_domain_id"]
                or archive.match_id != match_row["match_id"]
                or archive.current_policy_fingerprint
                != row["current_policy_fingerprint"]
                or row["archive_id"] != match_row["authorization_archive_id"]
                or row["trust_domain_id"]
                != match_row["authorization_trust_domain_id"]
            ):
                _fail("ARCHIVE_HISTORY", "archive adoption scope metadata differs")
            adoption_time = row["adopted_at_ns"]
            if type(adoption_time) is not int or adoption_time < 0:
                _fail("ARCHIVE_HISTORY", "archive adoption time is invalid")
            if first_adoption_time is None:
                first_adoption_time = adoption_time
            if previous_time is not None and adoption_time <= previous_time:
                _fail("ARCHIVE_HISTORY", "archive adoption time did not strictly advance")
            if previous_archive is not None:
                self._validate_archive_dict_advancement(
                    previous_archive.canonical_dict(), archive.canonical_dict()
                )
            history_head = self._archive_history_head(
                previous_head=previous_history_head,
                generation=generation,
                previous_archive_fingerprint=row["previous_archive_fingerprint"],
                adopted_archive_fingerprint=fingerprint,
                current_policy_fingerprint=row["current_policy_fingerprint"],
                adopted_at_ns=adoption_time,
                archive_bytes=raw,
            )
            if row["archive_history_head_sha256"] != history_head:
                _fail("ARCHIVE_HISTORY", "archive history hash chain differs")
            previous_fingerprint = fingerprint
            previous_time = adoption_time
            previous_archive = archive
            previous_history_head = history_head
            latest_raw = raw
            adoptions.append(
                _ArchiveAdoption(
                    generation,
                    fingerprint,
                    archive.current_policy_fingerprint,
                    adoption_time,
                    archive,
                    history_head,
                )
            )
        if len(adoptions) != adoption_count:
            _fail("ARCHIVE_HISTORY", "streamed archive count differs from preflight")
        if previous_fingerprint != match_row["adopted_archive_fingerprint"]:
            _fail("ARCHIVE_HISTORY", "latest archive differs from match trust pin")
        if first_adoption_time != match_row["initialized_at_ns"]:
            _fail("ARCHIVE_HISTORY", "bootstrap archive time differs from match bootstrap")
        if previous_time is None or previous_time > match_row["last_verified_at_ns"]:
            _fail("ARCHIVE_HISTORY", "archive adoption is later than trust-time floor")
        if previous_history_head != match_row["archive_history_head_sha256"]:
            _fail("ARCHIVE_HISTORY", "match archive-history head differs")
        if latest_raw != _archive_bytes(policy_archive):
            _fail("ARCHIVE_ROLLBACK", "caller did not supply the latest exact archive")
        return tuple(adoptions)

    def _validate_archive_advancement(
        self,
        previous: AuthorizationPolicyArchive,
        new: AuthorizationPolicyArchive,
        *,
        adopted_at_ns: int,
    ) -> None:
        if previous.fingerprint() == new.fingerprint():
            _fail("ARCHIVE_NOT_ADVANCED", "new archive is byte-identical to current archive")
        if (
            previous.archive_id != new.archive_id
            or previous.trust_domain_id != new.trust_domain_id
            or previous.match_id != new.match_id
        ):
            _fail("ARCHIVE_SCOPE_CHANGE", "archive scope cannot change")
        if not new.current_policy.is_active(adopted_at_ns):
            _fail("ARCHIVE_INACTIVE", "new current policy is inactive at adoption time")
        self._validate_archive_dict_advancement(
            previous.canonical_dict(), new.canonical_dict()
        )

    def _validate_archive_dict_advancement(
        self,
        previous: dict[str, object],
        new: dict[str, object],
    ) -> None:
        for scope_field in ("archive_id", "trust_domain_id", "match_id", "schema_version"):
            if previous.get(scope_field) != new.get(scope_field):
                _fail("ARCHIVE_SCOPE_CHANGE", f"archive field changed: {scope_field}")
        old_policies = {
            hashlib.sha256(_canonical_json(policy)).hexdigest(): policy
            for policy in previous["policies"]  # type: ignore[index]
        }
        new_policies = {
            hashlib.sha256(_canonical_json(policy)).hexdigest(): policy
            for policy in new["policies"]  # type: ignore[index]
        }
        if not old_policies.keys() <= new_policies.keys():
            _fail("ARCHIVE_POLICY_REMOVED", "historical policy generation disappeared")
        old_current = previous["current_policy_fingerprint"]
        new_current = new["current_policy_fingerprint"]
        if old_current not in new_policies:
            _fail("ARCHIVE_CURRENT_REMOVED", "prior current policy was not retained")
        if new_current != old_current and new_current in old_policies:
            _fail("ARCHIVE_POLICY_ROLLBACK", "current policy cannot revert to an old generation")
        if new_current not in new_policies:
            _fail("ARCHIVE_CURRENT_UNKNOWN", "new current policy is not retained")

        def statuses(data: dict[str, object]) -> dict[tuple[str, str, str], dict[str, object]]:
            return {
                (
                    status["key_kind"],
                    status["principal_id"],
                    status["key_id"],
                ): status
                for status in data["key_revocations"]  # type: ignore[index]
            }

        old_statuses = statuses(previous)
        new_statuses = statuses(new)
        if not old_statuses.keys() <= new_statuses.keys():
            _fail("ARCHIVE_KEY_REMOVED", "historical key identity disappeared")
        for identity, old_status in old_statuses.items():
            new_status = new_statuses[identity]
            if old_status["public_key_sha256"] != new_status["public_key_sha256"]:
                _fail("ARCHIVE_KEY_MATERIAL", "historical key material changed")
            old_revoked = old_status["revoked_at_ns"]
            new_revoked = new_status["revoked_at_ns"]
            if old_revoked is not None and (
                new_revoked is None or new_revoked > old_revoked
            ):
                _fail("ARCHIVE_REVOCATION_ROLLBACK", "revocation was undone or moved later")

    def _checkpoint_from_row(
        self,
        row: sqlite3.Row,
        *,
        replay: _ReplayResult,
        verified_at_ns: int,
    ) -> LedgerCheckpoint:
        generation = self._connection.execute(
            "SELECT MAX(generation) FROM archive_adoptions WHERE match_id = ?",
            (row["match_id"],),
        ).fetchone()[0]
        return LedgerCheckpoint(
            row["match_id"],
            row["match_binding_fingerprint"],
            replay.state.revision,
            replay.ledger_head_sha256,
            replay.state_fingerprint,
            row["adopted_archive_fingerprint"],
            generation,
            row["archive_history_head_sha256"],
            self.reducer_build_sha256,
            replay.outbox_position,
            verified_at_ns,
            bool(row["integrity_blocked"]),
            row["integrity_failure_code"],
        )

    def _result_for_existing_locked(
        self,
        idempotency_row: sqlite3.Row,
        *,
        match_row: sqlite3.Row,
        replay: _ReplayResult,
        verified_at_ns: int,
    ) -> AppendResult:
        event_row = self._connection.execute(
            "SELECT * FROM event_log WHERE event_id = ?",
            (idempotency_row["event_id"],),
        ).fetchone()
        authorization_row = self._connection.execute(
            "SELECT * FROM authorization_log WHERE event_id = ?",
            (idempotency_row["event_id"],),
        ).fetchone()
        outbox_row = self._connection.execute(
            "SELECT * FROM shadow_outbox WHERE outbox_id = ?",
            (idempotency_row["outbox_id"],),
        ).fetchone()
        state_row = self._connection.execute(
            "SELECT * FROM state_history WHERE event_id = ?",
            (idempotency_row["event_id"],),
        ).fetchone()
        if (
            event_row is None
            or authorization_row is None
            or outbox_row is None
            or state_row is None
        ):
            _fail("IDEMPOTENCY_LOG_TAMPER", "idempotency result targets missing rows")
        adoption_row = self._connection.execute(
            """
            SELECT generation, archive_history_head_sha256 FROM archive_adoptions
            WHERE match_id = ? AND adopted_archive_fingerprint = ?
            """,
            (event_row["match_id"], event_row["adopted_archive_fingerprint"]),
        ).fetchone()
        if adoption_row is None:
            _fail("IDEMPOTENCY_LOG_TAMPER", "result references missing archive adoption")
        checkpoint = LedgerCheckpoint(
            event_row["match_id"],
            match_row["match_binding_fingerprint"],
            event_row["revision"],
            state_row["ledger_head_sha256"],
            state_row["state_fingerprint"],
            event_row["adopted_archive_fingerprint"],
            adoption_row["generation"],
            adoption_row["archive_history_head_sha256"],
            self.reducer_build_sha256,
            outbox_row["outbox_id"],
            event_row["appended_at_ns"],
            False,
            None,
        )
        return AppendResult(
            event_row["match_id"],
            event_row["revision"],
            event_row["event_id"],
            event_row["event_fingerprint"],
            authorization_row["command_fingerprint"],
            event_row["envelope_fingerprint"],
            authorization_row["authorization_record_fingerprint"],
            idempotency_row["result_state_fingerprint"],
            outbox_row["outbox_id"],
            outbox_row["message_id"],
            outbox_row["payload_fingerprint"],
            event_row["adopted_archive_fingerprint"],
            self.reducer_build_sha256,
            state_row["ledger_head_sha256"],
            checkpoint,
        )


__all__ = [
    "EVENT_STORE_SCHEMA_VERSION",
    "AppendResult",
    "ArchiveAdvancementResult",
    "AuditResult",
    "EventStoreError",
    "LedgerCheckpoint",
    "MAX_ARCHIVE_ADOPTIONS",
    "MAX_ARCHIVE_HISTORY_BYTES_PER_MATCH",
    "MAX_ARCHIVE_TEXT_BYTES_PER_MATCH",
    "MAX_LEDGER_ENVELOPE_BYTES_PER_MATCH",
    "MAX_LEDGER_OUTBOX_BYTES_PER_MATCH",
    "MAX_LEDGER_STATE_BYTES_PER_MATCH",
    "MAX_LEDGER_TOTAL_BYTES_PER_MATCH",
    "MAX_LEDGER_TEXT_BYTES_PER_MATCH",
    "MAX_SHADOW_OUTBOX_PAYLOAD_BYTES",
    "MAX_SQLITE_COLUMNS",
    "MAX_SQLITE_SQL_BYTES",
    "MAX_SQLITE_VALUE_BYTES",
    "MAX_SQLITE_VARIABLES",
    "MatchInitializationResult",
    "SHADOW_OUTBOX_TARGET",
    "SHADOW_OUTBOX_TOPIC",
    "SQLITE_APPLICATION_ID",
    "SQLITE_USER_VERSION",
    "SQLiteEventStore",
    "verify_checkpoint_progression",
]
