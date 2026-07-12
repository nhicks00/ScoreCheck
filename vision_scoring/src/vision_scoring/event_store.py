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
from bisect import bisect_left
from contextlib import ExitStack, contextmanager
from dataclasses import dataclass
from functools import wraps
from pathlib import Path
from typing import Any, Iterator, NoReturn

from .authorization import (
    MAX_AUTHORIZATION_BYTES,
    AuthorizationError,
    AuthorizationOrigin,
    AuthorizationPolicy,
    AuthorizationPolicyArchive,
    AuthorizedRuleEvent,
    encode_authorization_policy_archive,
    encode_authorized_rule_event,
    parse_authorization_policy_archive,
    parse_authorized_rule_event,
    verify_signed_policy_assessment_for_policy,
    verify_authorized_rule_event,
)
from .case_attestation import (
    CaseAttestationError,
    SignedScorerCopilotCase,
    encode_signed_scorer_copilot_case,
    parse_signed_scorer_copilot_case,
    verify_signed_scorer_copilot_case,
    verify_signed_scorer_copilot_case_at_historical_acceptance,
)
from .domain_events import (
    MAX_ID_LENGTH,
    MAX_SEQUENCE_NUMBER,
    PointAwardedPayload,
    ReplayNoPointPayload,
    RuleEvent,
    RuleEventType,
    SetSeedPayload,
    SideSwitchConfirmedPayload,
    Team,
    TechnicalTimeoutCompletedPayload,
)
from .hypotheses import RallyOutcome
from .immutable_store import ImmutableStoreError, generation_read_lease
from .review_contracts import (
    MAX_REVIEW_ACTIONS,
    MAX_REVIEW_CLIP_BYTES,
    MAX_REVIEW_RECORD_BYTES,
    CaseAuthorizationLink,
    ReviewAuthorizationContext,
    ReviewContractError,
    ReviewDispositionKind,
    ScorerCopilotCase,
    SignedReviewAdjudication,
    SignedReviewDisposition,
    copilot_idempotency_key,
    encode_case_authorization_link,
    encode_review_authorization_context,
    encode_review_clip_manifest,
    encode_signed_review_adjudication,
    encode_signed_review_disposition,
    parse_case_authorization_link,
    parse_review_authorization_context,
    parse_signed_review_adjudication,
    parse_signed_review_disposition,
)
from .review_signing import (
    ReviewSignatureError,
    verify_case_policy_assessment,
    verify_case_policy_assessment_at_historical_acceptance,
    verify_signed_review_adjudication,
    verify_signed_review_adjudication_at_historical_acceptance,
    verify_signed_review_disposition,
    verify_signed_review_disposition_at_historical_acceptance,
)
from .rules import MatchState, RulesError, RulesReducer, Ruleset, SetPhase
from .state_codec import (
    MAX_RAW_STATE_BYTES,
    encode_match_state,
    match_state_fingerprint,
)


EVENT_STORE_SCHEMA_VERSION = "3.0"
SQLITE_APPLICATION_ID = 0x5649534E  # ASCII "VISN"
SQLITE_USER_VERSION = 3
SHADOW_OUTBOX_TOPIC = "vision_scoring.shadow.authorized_event.v2"
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
MAX_COPILOT_CASES_PER_MATCH = 512
MAX_COPILOT_JOURNAL_RECORDS_PER_MATCH = 2048
MAX_COPILOT_HISTORY_RECORDS_PER_MATCH = (
    MAX_COPILOT_CASES_PER_MATCH
    + MAX_COPILOT_JOURNAL_RECORDS_PER_MATCH
    + MAX_COPILOT_CASES_PER_MATCH
)
MAX_COPILOT_REVIEW_BYTES_PER_MATCH = 128 * 1024 * 1024
MAX_COPILOT_REVIEW_TEXT_BYTES_PER_MATCH = 16 * 1024 * 1024
MAX_COPILOT_CLIP_BYTES_PER_CASE = 512 * 1024 * 1024
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
_REVIEW_GENESIS_DOMAIN = b"multicourt-vision-scoring:review-genesis:v1\x00"
_REVIEW_CHAIN_DOMAIN = b"multicourt-vision-scoring:review-chain:v1\x00"
_EVIDENCE_SET_DOMAIN = b"multicourt-vision-scoring:outbox-evidence-set:v1\x00"

# ReviewClipRef proves the embedded manifest and rendered-object bytes only.
# It cannot prove that source_sha256 was resident or that the render was
# actually derived from that source.  That residual requires a separately
# attested derivation/source-residency contract.
REVIEW_CLIP_SOURCE_DERIVATION_RESIDUAL = (
    "ReviewClipRef does not prove source_sha256 residency or rendered-clip "
    "derivation from that source"
)


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


def _evidence_set_fingerprint(evidence_refs: tuple[str, ...]) -> str:
    if type(evidence_refs) is not tuple:
        raise ValueError("evidence_refs must be an exact tuple")
    return hashlib.sha256(
        _EVIDENCE_SET_DOMAIN + _canonical_json(list(evidence_refs))
    ).hexdigest()


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
        copilot_case_count INTEGER NOT NULL CHECK(copilot_case_count BETWEEN 0 AND {MAX_COPILOT_CASES_PER_MATCH}),
        copilot_action_count INTEGER NOT NULL CHECK(copilot_action_count BETWEEN 0 AND {MAX_COPILOT_JOURNAL_RECORDS_PER_MATCH}),
        copilot_link_count INTEGER NOT NULL CHECK(copilot_link_count BETWEEN 0 AND {MAX_COPILOT_CASES_PER_MATCH}),
        review_position INTEGER NOT NULL CHECK(review_position BETWEEN 0 AND {MAX_COPILOT_HISTORY_RECORDS_PER_MATCH}),
        review_history_head_sha256 TEXT NOT NULL CHECK({_sql_hash_check('review_history_head_sha256')}),
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
        review_position_at_append INTEGER NOT NULL CHECK(review_position_at_append BETWEEN 0 AND {MAX_COPILOT_HISTORY_RECORDS_PER_MATCH}),
        review_history_head_at_append TEXT NOT NULL CHECK({_sql_hash_check('review_history_head_at_append')}),
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
        topic TEXT NOT NULL CHECK(topic = 'vision_scoring.shadow.authorized_event.v2'),
        target TEXT NOT NULL CHECK(target = 'SHADOW_ONLY_NO_OFFICIAL_SCORECHECK_MUTATION'),
        payload_bytes BLOB NOT NULL CHECK(typeof(payload_bytes) = 'blob' AND length(payload_bytes) <= 16384),
        payload_fingerprint TEXT NOT NULL CHECK({_sql_hash_check('payload_fingerprint')}),
        envelope_fingerprint TEXT NOT NULL CHECK({_sql_hash_check('envelope_fingerprint')}),
        state_fingerprint TEXT NOT NULL CHECK({_sql_hash_check('state_fingerprint')}),
        reducer_build_sha256 TEXT NOT NULL CHECK({_sql_hash_check('reducer_build_sha256')}),
        review_position_at_append INTEGER NOT NULL CHECK(review_position_at_append BETWEEN 0 AND {MAX_COPILOT_HISTORY_RECORDS_PER_MATCH}),
        review_history_head_at_append TEXT NOT NULL CHECK({_sql_hash_check('review_history_head_at_append')}),
        case_authorization_link_fingerprint TEXT CHECK(case_authorization_link_fingerprint IS NULL OR ({_sql_hash_check('case_authorization_link_fingerprint')})),
        review_context_fingerprint TEXT CHECK(review_context_fingerprint IS NULL OR ({_sql_hash_check('review_context_fingerprint')})),
        created_at_ns INTEGER NOT NULL CHECK(created_at_ns >= 0),
        CHECK((case_authorization_link_fingerprint IS NULL AND review_context_fingerprint IS NULL) OR
              (case_authorization_link_fingerprint IS NOT NULL AND review_context_fingerprint IS NOT NULL)),
        UNIQUE(match_id, revision),
        UNIQUE(match_id, revision, event_id),
        FOREIGN KEY(match_id, revision, event_id)
            REFERENCES state_history(match_id, revision, event_id)
    ) STRICT
    """,
    f"""
    CREATE TABLE request_identities (
        idempotency_key TEXT PRIMARY KEY CHECK({_sql_ascii_check('idempotency_key')}),
        match_id TEXT NOT NULL CHECK({_sql_ascii_check('match_id')}),
        request_kind TEXT NOT NULL CHECK(request_kind IN ('CASE_ADMISSION','HUMAN_EVENT','COPILOT_EVENT','REVIEW_DISPOSITION','REVIEW_ADJUDICATION')),
        request_fingerprint TEXT NOT NULL CHECK({_sql_hash_check('request_fingerprint')}),
        accepted_identity_fingerprint TEXT NOT NULL CHECK({_sql_hash_check('accepted_identity_fingerprint')}),
        result_identity_fingerprint TEXT NOT NULL CHECK({_sql_hash_check('result_identity_fingerprint')}),
        created_at_ns INTEGER NOT NULL CHECK(created_at_ns >= 0),
        UNIQUE(request_fingerprint),
        FOREIGN KEY(match_id) REFERENCES matches(match_id)
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
        FOREIGN KEY(idempotency_key) REFERENCES request_identities(idempotency_key),
        FOREIGN KEY(match_id, result_revision, event_id)
            REFERENCES event_log(match_id, revision, event_id),
        FOREIGN KEY(outbox_id) REFERENCES shadow_outbox(outbox_id)
    ) STRICT
    """,
    f"""
    CREATE TABLE copilot_cases (
        case_fingerprint TEXT PRIMARY KEY CHECK({_sql_hash_check('case_fingerprint')}),
        match_id TEXT NOT NULL CHECK({_sql_ascii_check('match_id')}),
        case_ordinal INTEGER NOT NULL CHECK(case_ordinal BETWEEN 1 AND {MAX_COPILOT_CASES_PER_MATCH}),
        signed_case_fingerprint TEXT NOT NULL UNIQUE CHECK({_sql_hash_check('signed_case_fingerprint')}),
        admission_idempotency_key TEXT NOT NULL UNIQUE CHECK({_sql_ascii_check('admission_idempotency_key')}),
        signed_case_bytes BLOB NOT NULL CHECK(typeof(signed_case_bytes) = 'blob' AND length(signed_case_bytes) BETWEEN 1 AND {MAX_REVIEW_RECORD_BYTES}),
        rally_id TEXT NOT NULL CHECK({_sql_ascii_check('rally_id')}),
        set_number INTEGER NOT NULL CHECK(set_number BETWEEN 1 AND 99),
        state_revision INTEGER NOT NULL CHECK(state_revision >= 0),
        ruleset_fingerprint TEXT NOT NULL CHECK({_sql_hash_check('ruleset_fingerprint')}),
        opened_at_ns INTEGER NOT NULL CHECK(opened_at_ns >= 0),
        producer_signed_at_ns INTEGER NOT NULL CHECK(producer_signed_at_ns >= 0),
        rendered_clip_total_bytes INTEGER NOT NULL CHECK(rendered_clip_total_bytes BETWEEN 1 AND {MAX_COPILOT_CLIP_BYTES_PER_CASE}),
        producer_policy_generation INTEGER NOT NULL CHECK(producer_policy_generation BETWEEN 0 AND {MAX_ARCHIVE_ADOPTIONS - 1}),
        assessment_policy_generation INTEGER CHECK(assessment_policy_generation IS NULL OR assessment_policy_generation BETWEEN 0 AND {MAX_ARCHIVE_ADOPTIONS - 1}),
        verification_archive_generation INTEGER NOT NULL CHECK(verification_archive_generation BETWEEN 0 AND {MAX_ARCHIVE_ADOPTIONS - 1}),
        admitted_at_ns INTEGER NOT NULL CHECK(admitted_at_ns >= 0),
        current_case_sequence INTEGER NOT NULL CHECK(current_case_sequence BETWEEN 0 AND {MAX_REVIEW_ACTIONS}),
        current_head_fingerprint TEXT NOT NULL CHECK({_sql_hash_check('current_head_fingerprint')}),
        linked_event_id TEXT CHECK(linked_event_id IS NULL OR ({_sql_ascii_check('linked_event_id')})),
        authorization_link_fingerprint TEXT CHECK(authorization_link_fingerprint IS NULL OR ({_sql_hash_check('authorization_link_fingerprint')})),
        review_position INTEGER NOT NULL CHECK(review_position BETWEEN 1 AND {MAX_COPILOT_HISTORY_RECORDS_PER_MATCH}),
        review_history_head_sha256 TEXT NOT NULL CHECK({_sql_hash_check('review_history_head_sha256')}),
        CHECK((linked_event_id IS NULL AND authorization_link_fingerprint IS NULL) OR
              (linked_event_id IS NOT NULL AND authorization_link_fingerprint IS NOT NULL)),
        UNIQUE(match_id, case_ordinal),
        UNIQUE(match_id, rally_id, state_revision),
        UNIQUE(match_id, review_position),
        FOREIGN KEY(match_id) REFERENCES matches(match_id),
        FOREIGN KEY(admission_idempotency_key) REFERENCES request_identities(idempotency_key)
    ) STRICT
    """,
    f"""
    CREATE TABLE copilot_journal (
        signed_record_fingerprint TEXT PRIMARY KEY CHECK({_sql_hash_check('signed_record_fingerprint')}),
        match_id TEXT NOT NULL CHECK({_sql_ascii_check('match_id')}),
        case_fingerprint TEXT NOT NULL CHECK({_sql_hash_check('case_fingerprint')}),
        signed_case_fingerprint TEXT NOT NULL CHECK({_sql_hash_check('signed_case_fingerprint')}),
        case_sequence INTEGER NOT NULL CHECK(case_sequence BETWEEN 1 AND {MAX_REVIEW_ACTIONS}),
        record_type TEXT NOT NULL CHECK(record_type IN ('DISPOSITION','ADJUDICATION')),
        unsigned_record_fingerprint TEXT NOT NULL CHECK({_sql_hash_check('unsigned_record_fingerprint')}),
        previous_record_fingerprint TEXT NOT NULL CHECK({_sql_hash_check('previous_record_fingerprint')}),
        idempotency_key TEXT NOT NULL UNIQUE CHECK({_sql_ascii_check('idempotency_key')}),
        signed_record_bytes BLOB NOT NULL CHECK(typeof(signed_record_bytes) = 'blob' AND length(signed_record_bytes) BETWEEN 1 AND {MAX_REVIEW_RECORD_BYTES}),
        policy_fingerprint TEXT NOT NULL CHECK({_sql_hash_check('policy_fingerprint')}),
        signing_policy_generation INTEGER NOT NULL CHECK(signing_policy_generation BETWEEN 0 AND {MAX_ARCHIVE_ADOPTIONS - 1}),
        verification_archive_generation INTEGER NOT NULL CHECK(verification_archive_generation BETWEEN 0 AND {MAX_ARCHIVE_ADOPTIONS - 1}),
        signed_at_ns INTEGER NOT NULL CHECK(signed_at_ns >= 0),
        accepted_at_ns INTEGER NOT NULL CHECK(accepted_at_ns >= signed_at_ns),
        review_position INTEGER NOT NULL CHECK(review_position BETWEEN 1 AND {MAX_COPILOT_HISTORY_RECORDS_PER_MATCH}),
        review_history_head_sha256 TEXT NOT NULL CHECK({_sql_hash_check('review_history_head_sha256')}),
        UNIQUE(case_fingerprint, case_sequence),
        UNIQUE(match_id, review_position),
        FOREIGN KEY(case_fingerprint) REFERENCES copilot_cases(case_fingerprint),
        FOREIGN KEY(idempotency_key) REFERENCES request_identities(idempotency_key),
        FOREIGN KEY(match_id) REFERENCES matches(match_id)
    ) STRICT
    """,
    f"""
    CREATE TABLE copilot_authorization_links (
        case_fingerprint TEXT PRIMARY KEY CHECK({_sql_hash_check('case_fingerprint')}),
        match_id TEXT NOT NULL CHECK({_sql_ascii_check('match_id')}),
        signed_case_fingerprint TEXT NOT NULL CHECK({_sql_hash_check('signed_case_fingerprint')}),
        event_id TEXT NOT NULL UNIQUE CHECK({_sql_ascii_check('event_id')}),
        context_fingerprint TEXT NOT NULL UNIQUE CHECK({_sql_hash_check('context_fingerprint')}),
        context_bytes BLOB NOT NULL CHECK(typeof(context_bytes) = 'blob' AND length(context_bytes) BETWEEN 1 AND {MAX_REVIEW_RECORD_BYTES}),
        link_fingerprint TEXT NOT NULL UNIQUE CHECK({_sql_hash_check('link_fingerprint')}),
        link_bytes BLOB NOT NULL CHECK(typeof(link_bytes) = 'blob' AND length(link_bytes) BETWEEN 1 AND {MAX_REVIEW_RECORD_BYTES}),
        committed_at_ns INTEGER NOT NULL CHECK(committed_at_ns >= 0),
        review_position INTEGER NOT NULL CHECK(review_position BETWEEN 1 AND {MAX_COPILOT_HISTORY_RECORDS_PER_MATCH}),
        review_history_head_sha256 TEXT NOT NULL CHECK({_sql_hash_check('review_history_head_sha256')}),
        UNIQUE(match_id, review_position),
        FOREIGN KEY(case_fingerprint) REFERENCES copilot_cases(case_fingerprint),
        FOREIGN KEY(event_id) REFERENCES event_log(event_id),
        FOREIGN KEY(match_id) REFERENCES matches(match_id)
    ) STRICT
    """,
    f"""
    CREATE TABLE copilot_history (
        match_id TEXT NOT NULL CHECK({_sql_ascii_check('match_id')}),
        review_position INTEGER NOT NULL CHECK(review_position BETWEEN 1 AND {MAX_COPILOT_HISTORY_RECORDS_PER_MATCH}),
        entry_kind TEXT NOT NULL CHECK(entry_kind IN ('CASE','DISPOSITION','ADJUDICATION','AUTHORIZATION_LINK')),
        case_fingerprint TEXT NOT NULL CHECK({_sql_hash_check('case_fingerprint')}),
        entry_fingerprint TEXT NOT NULL CHECK({_sql_hash_check('entry_fingerprint')}),
        committed_at_ns INTEGER NOT NULL CHECK(committed_at_ns >= 0),
        previous_history_head_sha256 TEXT NOT NULL CHECK({_sql_hash_check('previous_history_head_sha256')}),
        review_history_head_sha256 TEXT NOT NULL CHECK({_sql_hash_check('review_history_head_sha256')}),
        PRIMARY KEY(match_id, review_position),
        UNIQUE(entry_kind, entry_fingerprint),
        FOREIGN KEY(match_id) REFERENCES matches(match_id)
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
        "request_identities",
        "idempotency_log",
        "copilot_cases",
        "copilot_journal",
        "copilot_authorization_links",
        "copilot_history",
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
    review_position: int
    copilot_case_count: int
    copilot_action_count: int
    copilot_link_count: int
    review_history_head_sha256: str
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
            "review_history_head_sha256",
        ):
            _sha256(getattr(self, field_name), field_name)
        _timestamp(self.revision, "revision")
        _timestamp(self.outbox_position, "outbox_position")
        if (
            type(self.review_position) is not int
            or not 0 <= self.review_position <= MAX_COPILOT_HISTORY_RECORDS_PER_MATCH
        ):
            raise ValueError("review_position is outside its fixed bound")
        count_bounds = (
            (self.copilot_case_count, MAX_COPILOT_CASES_PER_MATCH),
            (self.copilot_action_count, MAX_COPILOT_JOURNAL_RECORDS_PER_MATCH),
            (self.copilot_link_count, MAX_COPILOT_CASES_PER_MATCH),
        )
        if any(
            type(value) is not int or not 0 <= value <= maximum
            for value, maximum in count_bounds
        ):
            raise ValueError("copilot checkpoint count is outside its fixed bound")
        if self.review_position != sum(value for value, _ in count_bounds):
            raise ValueError("review_position must equal case + action + link counts")
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
            "copilot_action_count": self.copilot_action_count,
            "copilot_case_count": self.copilot_case_count,
            "copilot_link_count": self.copilot_link_count,
            "review_history_head_sha256": self.review_history_head_sha256,
            "review_position": self.review_position,
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

    External inclusion proofs are still required when the event revision,
    review position, or archive-adoption generation advances; this comparator
    enforces exact identity and monotonic fields but cannot prove that a changed
    head extends the previously protected chain rather than a fork.
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
    previous_counts = (
        previous.review_position,
        previous.copilot_case_count,
        previous.copilot_action_count,
        previous.copilot_link_count,
    )
    candidate_counts = (
        candidate.review_position,
        candidate.copilot_case_count,
        candidate.copilot_action_count,
        candidate.copilot_link_count,
    )
    if any(new < old for old, new in zip(previous_counts, candidate_counts)):
        _fail("CHECKPOINT_REVIEW_ROLLBACK", "checkpoint review count moved backward")
    if candidate.archive_adoption_generation < previous.archive_adoption_generation:
        _fail("CHECKPOINT_ARCHIVE_ROLLBACK", "archive generation moved backward")
    if candidate.revision == previous.revision and (
        candidate.ledger_head_sha256 != previous.ledger_head_sha256
        or candidate.state_fingerprint != previous.state_fingerprint
        or candidate.outbox_position != previous.outbox_position
    ):
        _fail("CHECKPOINT_HEAD_CONFLICT", "same revision has a different ledger head")
    if candidate.review_position == previous.review_position:
        if (
            candidate_counts != previous_counts
            or candidate.review_history_head_sha256
            != previous.review_history_head_sha256
        ):
            _fail(
                "CHECKPOINT_REVIEW_CONFLICT",
                "same review position has different counts or history head",
            )
    elif candidate.review_history_head_sha256 == previous.review_history_head_sha256:
        _fail(
            "CHECKPOINT_REVIEW_CONFLICT",
            "advanced review position did not change its history head",
        )
    if candidate.revision > previous.revision:
        if candidate.outbox_position <= previous.outbox_position:
            _fail(
                "CHECKPOINT_OUTBOX_CONFLICT",
                "advanced revision lacks a new outbox identity",
            )
        if (
            candidate.ledger_head_sha256 == previous.ledger_head_sha256
            or candidate.state_fingerprint == previous.state_fingerprint
        ):
            _fail(
                "CHECKPOINT_HEAD_CONFLICT",
                "advanced revision did not change both ledger and state identity",
            )
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
class CaseAdmissionResult:
    match_id: str
    case_fingerprint: str
    signed_case_fingerprint: str
    admitted_at_ns: int
    context: ReviewAuthorizationContext
    review_position: int
    review_history_head_sha256: str
    checkpoint: LedgerCheckpoint


@dataclass(frozen=True, slots=True)
class ReviewJournalAppendResult:
    match_id: str
    case_fingerprint: str
    case_sequence: int
    signed_record_fingerprint: str
    record_type: str
    accepted_at_ns: int
    context: ReviewAuthorizationContext
    review_position: int
    review_history_head_sha256: str
    checkpoint: LedgerCheckpoint


@dataclass(frozen=True, slots=True)
class CopilotAppendResult:
    append: AppendResult
    case_fingerprint: str
    context: ReviewAuthorizationContext
    link: CaseAuthorizationLink


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
    review: "_ReviewReplayResult | None" = None


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


@dataclass(frozen=True, slots=True)
class _ReviewCaseState:
    case_fingerprint: str
    signed_case_fingerprint: str
    admission_review_position: int
    state_revision: int
    set_number: int
    rally_id: str
    case_sequence: int
    head_fingerprint: str
    head_kind: ReviewDispositionKind | None
    head_outcome: RallyOutcome | None
    latest_accepted_at_ns: int
    linked_event_id: str | None
    authorization_link_fingerprint: str | None


@dataclass(frozen=True, slots=True)
class _ReviewHistoryEntry:
    position: int
    entry_kind: str
    case_fingerprint: str
    entry_fingerprint: str
    committed_at_ns: int
    persisted_head_sha256: str
    linked_event_revision: int | None = None
    case_sequence: int | None = None


@dataclass(frozen=True, slots=True)
class _ReplayLink:
    case_fingerprint: str
    context: ReviewAuthorizationContext
    link: CaseAuthorizationLink
    link_fingerprint: str
    review_position: int
    review_history_head_sha256: str
    case_sequence: int
    head_kind: ReviewDispositionKind | None
    head_outcome: RallyOutcome | None
    latest_accepted_at_ns: int
    assessment_fingerprint: str
    signed_assessment_fingerprint: str | None


@dataclass(frozen=True, slots=True)
class _ScoreRevisionContext:
    """The only historical MatchState facts needed by review replay."""

    current_set_number: int | None
    current_set_in_progress: bool
    match_complete: bool


@dataclass(frozen=True, slots=True)
class _ReviewPreflight:
    case_count: int
    journal_count: int
    link_count: int
    blob_bytes: int
    text_bytes: int

    @property
    def history_count(self) -> int:
        return self.case_count + self.journal_count + self.link_count


@dataclass(frozen=True, slots=True)
class _ReviewReplayResult:
    cases: tuple[_ReviewCaseState, ...]
    links: tuple[_ReplayLink, ...]
    history_entries: tuple[_ReviewHistoryEntry, ...]
    review_history_head_sha256: str
    preflight: _ReviewPreflight

    def case_state(self, case_fingerprint: str) -> _ReviewCaseState:
        matches = tuple(
            item for item in self.cases if item.case_fingerprint == case_fingerprint
        )
        if len(matches) != 1:
            _fail("COPILOT_CASE_CARDINALITY", "case identity does not resolve exactly once")
        return matches[0]

    def link_for_event(self, event_id: str) -> _ReplayLink | None:
        matches = tuple(item for item in self.links if item.link.event_id == event_id)
        if len(matches) > 1:
            _fail("COPILOT_LINK_CARDINALITY", "event has multiple case links")
        return matches[0] if matches else None

    def head_at_position(self, position: int, *, genesis_head: str) -> str:
        if type(position) is not int or not 0 <= position <= len(
            self.history_entries
        ):
            _fail("REVIEW_HISTORY_POSITION", "event review position is invalid")
        if position == 0:
            return genesis_head
        entry = self.history_entries[position - 1]
        if entry.position != position:
            _fail("REVIEW_HISTORY_POSITION", "review history is not contiguous")
        return entry.persisted_head_sha256


class SQLiteEventStore:
    """Append-only SQLite ledger for one trusted reducer build and ruleset."""

    __slots__ = (
        "ruleset",
        "reducer",
        "reducer_build_sha256",
        "database_path",
        "immutable_store_root",
        "_connection",
        "_test_fault_mode",
    )

    def __init__(
        self,
        database_path: str | os.PathLike[str],
        *,
        ruleset: Ruleset,
        reducer_build_sha256: str,
        immutable_store_root: Path | None = None,
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
        if immutable_store_root is not None:
            if not isinstance(immutable_store_root, Path) or not immutable_store_root.is_absolute():
                raise ValueError("immutable_store_root must be an absolute pathlib.Path")
        self.immutable_store_root = immutable_store_root
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

    def _review_genesis_head(self, *, match_binding_fingerprint: str) -> str:
        return hashlib.sha256(
            _REVIEW_GENESIS_DOMAIN
            + _canonical_json(
                {
                    "match_binding_fingerprint": match_binding_fingerprint,
                    "reducer_build_sha256": self.reducer_build_sha256,
                    "schema_version": EVENT_STORE_SCHEMA_VERSION,
                }
            )
        ).hexdigest()

    def _review_history_head(
        self,
        previous_head: str,
        *,
        review_position: int,
        entry_kind: str,
        case_fingerprint: str,
        entry_fingerprint: str,
        committed_at_ns: int,
    ) -> str:
        _sha256(previous_head, "previous_head")
        _sha256(case_fingerprint, "case_fingerprint")
        _sha256(entry_fingerprint, "entry_fingerprint")
        if entry_kind not in {
            "CASE",
            "DISPOSITION",
            "ADJUDICATION",
            "AUTHORIZATION_LINK",
        }:
            raise ValueError("unsupported review history entry kind")
        if (
            type(review_position) is not int
            or not 1 <= review_position <= MAX_COPILOT_HISTORY_RECORDS_PER_MATCH
        ):
            raise ValueError("review_position is outside its fixed bound")
        committed_at_ns = _timestamp(committed_at_ns, "committed_at_ns")
        return hashlib.sha256(
            _REVIEW_CHAIN_DOMAIN
            + bytes.fromhex(previous_head)
            + _canonical_json(
                {
                    "case_fingerprint": case_fingerprint,
                    "committed_at_ns": committed_at_ns,
                    "entry_fingerprint": entry_fingerprint,
                    "entry_kind": entry_kind,
                    "match_reducer_build_sha256": self.reducer_build_sha256,
                    "review_position": review_position,
                }
            )
        ).hexdigest()

    def _insert_review_history_row(
        self,
        *,
        match_id: str,
        review_position: int,
        entry_kind: str,
        case_fingerprint: str,
        entry_fingerprint: str,
        committed_at_ns: int,
        previous_head: str,
        history_head: str,
    ) -> None:
        self._connection.execute(
            """
            INSERT INTO copilot_history(
                match_id, review_position, entry_kind, case_fingerprint,
                entry_fingerprint, committed_at_ns,
                previous_history_head_sha256, review_history_head_sha256
            ) VALUES(?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                match_id,
                review_position,
                entry_kind,
                case_fingerprint,
                entry_fingerprint,
                committed_at_ns,
                previous_head,
                history_head,
            ),
        )

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
        review_head = self._review_genesis_head(
            match_binding_fingerprint=binding
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
                    review_head,
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
                    existing["review_history_head_sha256"],
                )
                if (
                    actual != expected
                    or existing["current_revision"] != 0
                    or existing["review_position"] != 0
                    or existing["copilot_case_count"] != 0
                    or existing["copilot_action_count"] != 0
                    or existing["copilot_link_count"] != 0
                ):
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
                    ledger_head_sha256, copilot_case_count, copilot_action_count,
                    copilot_link_count, review_position, review_history_head_sha256,
                    integrity_blocked, integrity_failure_code
                ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, 0, 0, 0, 0, ?, 0, NULL)
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
                    review_head,
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
            review = _ReviewReplayResult(
                (),
                (),
                (),
                review_head,
                _ReviewPreflight(0, 0, 0, 0, 0),
            )
            replay = _ReplayResult(
                state,
                state_bytes,
                state_fingerprint,
                head,
                0,
                0,
                review=review,
            )
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
    def admit_scorer_copilot_case(
        self,
        signed_case_bytes: bytes,
        *,
        policy_archive: AuthorizationPolicyArchive,
        admitted_at_ns: int,
    ) -> CaseAdmissionResult:
        """Admit one exact producer-signed case under leased clip generations."""

        if type(signed_case_bytes) is not bytes:
            raise ValueError("signed_case_bytes must be exact bytes")
        admitted_at_ns = _timestamp(admitted_at_ns, "admitted_at_ns")
        try:
            signed_case = parse_signed_scorer_copilot_case(signed_case_bytes)
        except (CaseAttestationError, ReviewContractError, ValueError) as exc:
            raise EventStoreError("COPILOT_CASE_INVALID", "signed case bytes are invalid") from exc
        if encode_signed_scorer_copilot_case(signed_case) != signed_case_bytes:
            _fail("COPILOT_CASE_NONCANONICAL", "signed case bytes are noncanonical")
        case = signed_case.case
        signed_case_fingerprint = signed_case.fingerprint()
        try:
            with self._transaction(immediate=False):
                existing_signed_identity = self._preflight_case_admission_before_clips_locked(
                    signed_case_bytes=signed_case_bytes,
                    signed_case=signed_case,
                    policy_archive=policy_archive,
                    admitted_at_ns=admitted_at_ns,
                )
            with ExitStack() as clip_stack:
                clips_verified = not existing_signed_identity
                if clips_verified:
                    self._verify_case_clips_into_stack(clip_stack, signed_case)
                with self._transaction(immediate=True):
                    self._validate_schema()
                    match_row = self._load_match_locked(case.match_id)
                    self._check_match_pins(match_row, policy_archive=policy_archive)
                    self._check_time_locked(match_row, at_ns=admitted_at_ns)
                    if match_row["integrity_blocked"]:
                        _fail("INTEGRITY_BLOCKED", "blocked ledger cannot admit review cases")
                    replay = self._replay_or_permanently_block_locked(
                        match_id=case.match_id,
                        policy_archive=policy_archive,
                        verified_at_ns=admitted_at_ns,
                    )
                    if replay.review is None:
                        raise AssertionError("case admission requires review replay")
                    existing = self._connection.execute(
                        """
                        SELECT * FROM copilot_cases
                        WHERE case_fingerprint = ? OR signed_case_fingerprint = ?
                           OR (match_id = ? AND rally_id = ? AND state_revision = ?)
                        """,
                        (
                            signed_case.case_fingerprint,
                            signed_case_fingerprint,
                            case.match_id,
                            case.rally_id,
                            case.state_revision,
                        ),
                    ).fetchmany(4)
                    exact = tuple(
                        row
                        for row in existing
                        if row["case_fingerprint"] == signed_case.case_fingerprint
                        and row["signed_case_fingerprint"] == signed_case_fingerprint
                        and row["signed_case_bytes"] == signed_case_bytes
                    )
                    if existing:
                        if len(existing) != 1 or len(exact) != 1:
                            _fail(
                                "CASE_ADMISSION_CONFLICT",
                                "unsigned case/rally revision is bound to another presentation",
                            )
                        row = exact[0]
                        context = self._context_for_signed_case(
                            signed_case,
                            case_sequence=0,
                            journal_head_fingerprint=signed_case_fingerprint,
                        )
                        checkpoint = self._checkpoint_for_review_prefix_locked(
                            match_row=match_row,
                            revision=case.state_revision,
                            archive_generation=row["verification_archive_generation"],
                            review_position=row["review_position"],
                            review_history_head_sha256=row[
                                "review_history_head_sha256"
                            ],
                            verified_at_ns=row["admitted_at_ns"],
                        )
                        self._connection.execute(
                            "UPDATE matches SET last_verified_at_ns = ? WHERE match_id = ?",
                            (admitted_at_ns, case.match_id),
                        )
                        return CaseAdmissionResult(
                            case.match_id,
                            signed_case.case_fingerprint,
                            signed_case_fingerprint,
                            row["admitted_at_ns"],
                            context,
                            row["review_position"],
                            row["review_history_head_sha256"],
                            checkpoint,
                        )
                    if not clips_verified:
                        _fail(
                            "CASE_ADMISSION_RETRY_RACE",
                            "preexisting case disappeared before exact retry replay",
                        )
                    if admitted_at_ns < case.opened_at_ns:
                        _fail("CASE_ADMISSION_TIME", "case cannot be admitted before opening")
                    if case.state_revision != replay.state.revision:
                        _fail("STALE_CASE_REVISION", "case state revision is not current")
                    current_set = replay.state.current_set
                    if current_set is None or current_set.number != case.set_number:
                        _fail("CASE_SET_CONTEXT", "case set is not the current active set")
                    if current_set.phase is not SetPhase.IN_PROGRESS:
                        _fail(
                            "CASE_SET_NOT_IN_PROGRESS",
                            "cases require an in-progress current set",
                        )
                    if replay.state.match_complete:
                        _fail("CASE_MATCH_COMPLETE", "completed matches cannot admit cases")
                    if replay.state.rally_resolution(case.rally_id) is not None:
                        _fail("CASE_RALLY_RESOLVED", "case rally is already resolved")
                    if replay.review.preflight.case_count >= MAX_COPILOT_CASES_PER_MATCH:
                        _fail("COPILOT_CASE_LIMIT", "case count limit reached")
                    producer_adoption = self._signing_policy_adoption(
                        replay.adoptions,
                        policy_fingerprint=signed_case.authorization_policy_fingerprint,
                        signed_at_ns=signed_case.signed_at_ns,
                        label="case producer signature",
                    )
                    verification_adoption = self._adoption_at(
                        replay.adoptions,
                        admitted_at_ns,
                        label="case admission",
                    )
                    assessment_adoption: _ArchiveAdoption | None = None
                    if case.signed_assessment is not None:
                        assessment_adoption = self._adoption_at(
                            replay.adoptions,
                            case.signed_assessment.signed_at_ns,
                            label="case assessment signature",
                        )
                    try:
                        verify_signed_scorer_copilot_case(
                            signed_case,
                            case=case,
                            policy_archive=policy_archive,
                            verified_at_ns=admitted_at_ns,
                        )
                        if assessment_adoption is not None:
                            selected_policy = policy_archive.resolve_policy(
                                assessment_adoption.current_policy_fingerprint
                            )
                            verify_case_policy_assessment(
                                case,
                                signing_policy=selected_policy,
                                policy_archive=policy_archive,
                                verified_at_ns=admitted_at_ns,
                            )
                    except (AuthorizationError, CaseAttestationError, ReviewSignatureError) as exc:
                        raise EventStoreError(
                            "REVIEW_EVIDENCE_REVOKED"
                            if "REVOKED" in str(exc)
                            else "COPILOT_CASE_SIGNATURE_INVALID",
                            "case producer/assessment verification failed",
                        ) from exc
                    rendered_total = sum(
                        clip.rendered_size_bytes for clip in case.clips
                    )
                    review_position = replay.review.preflight.history_count + 1
                    previous_review_head = replay.review.review_history_head_sha256
                    review_head = self._review_history_head(
                        previous_review_head,
                        review_position=review_position,
                        entry_kind="CASE",
                        case_fingerprint=signed_case.case_fingerprint,
                        entry_fingerprint=signed_case_fingerprint,
                        committed_at_ns=admitted_at_ns,
                    )
                    context = self._context_for_signed_case(
                        signed_case,
                        case_sequence=0,
                        journal_head_fingerprint=signed_case_fingerprint,
                    )
                    admission_key = self._case_admission_idempotency_key(
                        signed_case_fingerprint
                    )
                    request_fingerprint = self._case_admission_request_fingerprint(
                        signed_case_fingerprint
                    )
                    occupied = self._connection.execute(
                        """
                        SELECT idempotency_key FROM request_identities
                        WHERE idempotency_key = ? OR request_fingerprint = ? LIMIT 1
                        """,
                        (admission_key, request_fingerprint),
                    ).fetchone()
                    if occupied is not None:
                        _fail("CASE_ADMISSION_CONFLICT", "admission request identity is occupied")
                    result_fingerprint = self._case_admission_result_fingerprint(
                        signed_case_fingerprint=signed_case_fingerprint,
                        context_fingerprint=context.fingerprint(),
                        review_position=review_position,
                        review_history_head_sha256=review_head,
                    )
                    projected_blob = (
                        replay.review.preflight.blob_bytes + len(signed_case_bytes)
                    )
                    case_row_text = (
                        signed_case.case_fingerprint,
                        case.match_id,
                        signed_case_fingerprint,
                        admission_key,
                        case.rally_id,
                        case.ruleset_fingerprint,
                        signed_case_fingerprint,
                        review_head,
                    )
                    history_row_text = (
                        case.match_id,
                        "CASE",
                        signed_case.case_fingerprint,
                        signed_case_fingerprint,
                        previous_review_head,
                        review_head,
                    )
                    request_row_text = (
                        admission_key,
                        case.match_id,
                        "CASE_ADMISSION",
                        request_fingerprint,
                        signed_case_fingerprint,
                        result_fingerprint,
                    )
                    projected_text = replay.review.preflight.text_bytes + sum(
                        len(value)
                        for value in (
                            *case_row_text,
                            *history_row_text,
                            *request_row_text,
                        )
                    )
                    if projected_text > MAX_COPILOT_REVIEW_TEXT_BYTES_PER_MATCH:
                        _fail("REVIEW_TEXT_BUDGET", "case admission exceeds review text budget")
                    if projected_blob + projected_text > MAX_COPILOT_REVIEW_BYTES_PER_MATCH:
                        _fail("REVIEW_BYTE_BUDGET", "case admission exceeds review byte budget")
                    self._connection.execute(
                        """
                        INSERT INTO request_identities(
                            idempotency_key, match_id, request_kind,
                            request_fingerprint, accepted_identity_fingerprint,
                            result_identity_fingerprint, created_at_ns
                        ) VALUES(?, ?, 'CASE_ADMISSION', ?, ?, ?, ?)
                        """,
                        (
                            admission_key,
                            case.match_id,
                            request_fingerprint,
                            signed_case_fingerprint,
                            result_fingerprint,
                            admitted_at_ns,
                        ),
                    )
                    self._connection.execute(
                        """
                        INSERT INTO copilot_cases(
                            case_fingerprint, match_id, case_ordinal,
                            signed_case_fingerprint, admission_idempotency_key,
                            signed_case_bytes, rally_id, set_number, state_revision,
                            ruleset_fingerprint, opened_at_ns, producer_signed_at_ns,
                            rendered_clip_total_bytes, producer_policy_generation,
                            assessment_policy_generation,
                            verification_archive_generation, admitted_at_ns,
                            current_case_sequence, current_head_fingerprint,
                            linked_event_id, authorization_link_fingerprint,
                            review_position, review_history_head_sha256
                        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, NULL, NULL, ?, ?)
                        """,
                        (
                            signed_case.case_fingerprint,
                            case.match_id,
                            replay.review.preflight.case_count + 1,
                            signed_case_fingerprint,
                            admission_key,
                            signed_case_bytes,
                            case.rally_id,
                            case.set_number,
                            case.state_revision,
                            case.ruleset_fingerprint,
                            case.opened_at_ns,
                            signed_case.signed_at_ns,
                            rendered_total,
                            producer_adoption.generation,
                            assessment_adoption.generation if assessment_adoption else None,
                            verification_adoption.generation,
                            admitted_at_ns,
                            signed_case_fingerprint,
                            review_position,
                            review_head,
                        ),
                    )
                    self._insert_review_history_row(
                        match_id=case.match_id,
                        review_position=review_position,
                        entry_kind="CASE",
                        case_fingerprint=signed_case.case_fingerprint,
                        entry_fingerprint=signed_case_fingerprint,
                        committed_at_ns=admitted_at_ns,
                        previous_head=previous_review_head,
                        history_head=review_head,
                    )
                    changed = self._connection.execute(
                        """
                        UPDATE matches SET last_verified_at_ns = ?,
                            copilot_case_count = ?, review_position = ?,
                            review_history_head_sha256 = ?
                        WHERE match_id = ? AND current_revision = ?
                          AND review_position = ? AND copilot_case_count = ?
                        """,
                        (
                            admitted_at_ns,
                            replay.review.preflight.case_count + 1,
                            review_position,
                            review_head,
                            case.match_id,
                            replay.state.revision,
                            replay.review.preflight.history_count,
                            replay.review.preflight.case_count,
                        ),
                    ).rowcount
                    if changed != 1:
                        _fail("CONCURRENT_REVIEW", "review projection changed")
                    self._apply_private_test_fault_locked()
                    self._validate_schema()
                    accepted_row = self._load_match_locked(case.match_id)
                    accepted_replay = self._replay_locked(
                        match_id=case.match_id,
                        policy_archive=policy_archive,
                        verified_at_ns=admitted_at_ns,
                    )
                    accepted_case = accepted_replay.review.case_state(
                        signed_case.case_fingerprint
                    ) if accepted_replay.review is not None else None
                    if (
                        accepted_case is None
                        or accepted_case.case_sequence != 0
                        or accepted_case.head_fingerprint != signed_case_fingerprint
                        or accepted_replay.state != replay.state
                    ):
                        _fail("POST_ADMISSION_REPLAY", "accepted case differs from proposal")
                    checkpoint = self._checkpoint_from_row(
                        accepted_row,
                        replay=accepted_replay,
                        verified_at_ns=admitted_at_ns,
                    )
                    result = CaseAdmissionResult(
                        case.match_id,
                        signed_case.case_fingerprint,
                        signed_case_fingerprint,
                        admitted_at_ns,
                        context,
                        review_position,
                        review_head,
                        checkpoint,
                    )
                return result
        except sqlite3.IntegrityError as exc:
            raise EventStoreError("CASE_ADMISSION_CONFLICT", "case admission identity conflict") from exc
        except sqlite3.OperationalError as exc:
            code = "CONCURRENT_WRITE" if "locked" in str(exc).lower() else "SQLITE_OPERATION"
            raise EventStoreError(code, "case admission SQLite operation failed") from exc

    @_sqlite_boundary
    def derive_scorer_copilot_context(
        self,
        signed_case_fingerprint: str,
        *,
        policy_archive: AuthorizationPolicyArchive,
        verified_at_ns: int,
    ) -> ReviewAuthorizationContext:
        """Reverify resident presentation bytes and derive the live signed head."""

        signed_case_fingerprint = _sha256(
            signed_case_fingerprint,
            "signed_case_fingerprint",
        )
        verified_at_ns = _timestamp(verified_at_ns, "verified_at_ns")
        preloaded_case = self._preload_signed_case_for_clip_verification(
            signed_case_fingerprint
        )
        with self._transaction(immediate=False):
            self._preflight_context_derivation_before_clips_locked(
                signed_case_fingerprint=signed_case_fingerprint,
                policy_archive=policy_archive,
                verified_at_ns=verified_at_ns,
                preloaded_case=preloaded_case,
            )
        with ExitStack() as clip_stack:
            self._verify_case_clips_into_stack(clip_stack, preloaded_case)
            with self._transaction(immediate=True):
                self._validate_schema()
                case_row, signed_case = self._load_signed_case_locked(
                    signed_case_fingerprint
                )
                if signed_case != preloaded_case:
                    _fail("COPILOT_CASE_TAMPER", "case changed after clip verification")
                match_row = self._load_match_locked(case_row["match_id"])
                self._check_match_pins(match_row, policy_archive=policy_archive)
                self._check_time_locked(match_row, at_ns=verified_at_ns)
                if match_row["integrity_blocked"]:
                    _fail("INTEGRITY_BLOCKED", "blocked ledger cannot present review cases")
                replay = self._replay_or_permanently_block_locked(
                    match_id=case_row["match_id"],
                    policy_archive=policy_archive,
                    verified_at_ns=verified_at_ns,
                )
                if replay.review is None:
                    raise AssertionError("context derivation requires review replay")
                case_state = replay.review.case_state(
                    signed_case.case_fingerprint
                )
                if case_state.linked_event_id is not None:
                    _fail("CASE_ALREADY_LINKED", "linked case cannot produce a new context")
                if signed_case.case.state_revision != replay.state.revision:
                    _fail("STALE_CASE_REVISION", "case revision is no longer current")
                self._verify_case_current_use_locked(
                    signed_case=signed_case,
                    policy_archive=policy_archive,
                    verified_at_ns=verified_at_ns,
                    adoptions=replay.adoptions,
                )
                context = self._context_for_signed_case(
                    signed_case,
                    case_sequence=case_state.case_sequence,
                    journal_head_fingerprint=case_state.head_fingerprint,
                )
                self._connection.execute(
                    "UPDATE matches SET last_verified_at_ns = ? WHERE match_id = ?",
                    (verified_at_ns, case_row["match_id"]),
                )
            return context

    @_sqlite_boundary
    def append_review_disposition(
        self,
        signed_disposition_bytes: bytes,
        *,
        policy_archive: AuthorizationPolicyArchive,
        accepted_at_ns: int,
    ) -> ReviewJournalAppendResult:
        if type(signed_disposition_bytes) is not bytes:
            raise ValueError("signed_disposition_bytes must be exact bytes")
        try:
            signed = parse_signed_review_disposition(signed_disposition_bytes)
        except (ReviewContractError, ValueError) as exc:
            raise EventStoreError("REVIEW_RECORD_INVALID", "disposition bytes are invalid") from exc
        return self._append_review_record(
            signed_record_bytes=signed_disposition_bytes,
            signed_record=signed,
            record_type="DISPOSITION",
            policy_archive=policy_archive,
            accepted_at_ns=accepted_at_ns,
        )

    @_sqlite_boundary
    def append_review_adjudication(
        self,
        signed_adjudication_bytes: bytes,
        *,
        policy_archive: AuthorizationPolicyArchive,
        accepted_at_ns: int,
    ) -> ReviewJournalAppendResult:
        if type(signed_adjudication_bytes) is not bytes:
            raise ValueError("signed_adjudication_bytes must be exact bytes")
        try:
            signed = parse_signed_review_adjudication(signed_adjudication_bytes)
        except (ReviewContractError, ValueError) as exc:
            raise EventStoreError("REVIEW_RECORD_INVALID", "adjudication bytes are invalid") from exc
        return self._append_review_record(
            signed_record_bytes=signed_adjudication_bytes,
            signed_record=signed,
            record_type="ADJUDICATION",
            policy_archive=policy_archive,
            accepted_at_ns=accepted_at_ns,
        )

    def _append_review_record(
        self,
        *,
        signed_record_bytes: bytes,
        signed_record: SignedReviewDisposition | SignedReviewAdjudication,
        record_type: str,
        policy_archive: AuthorizationPolicyArchive,
        accepted_at_ns: int,
    ) -> ReviewJournalAppendResult:
        accepted_at_ns = _timestamp(accepted_at_ns, "accepted_at_ns")
        if record_type == "DISPOSITION":
            if type(signed_record) is not SignedReviewDisposition:
                raise ValueError("signed_record must be an exact disposition")
            if encode_signed_review_disposition(signed_record) != signed_record_bytes:
                _fail("REVIEW_RECORD_NONCANONICAL", "disposition bytes are noncanonical")
            unsigned = signed_record.disposition
            request_kind = "REVIEW_DISPOSITION"
        elif record_type == "ADJUDICATION":
            if type(signed_record) is not SignedReviewAdjudication:
                raise ValueError("signed_record must be an exact adjudication")
            if encode_signed_review_adjudication(signed_record) != signed_record_bytes:
                _fail("REVIEW_RECORD_NONCANONICAL", "adjudication bytes are noncanonical")
            unsigned = signed_record.adjudication
            request_kind = "REVIEW_ADJUDICATION"
        else:
            raise ValueError("unsupported record_type")
        signed_record_fingerprint = signed_record.fingerprint()
        request_fingerprint = self._review_request_fingerprint(
            record_type=record_type,
            signed_record_fingerprint=signed_record_fingerprint,
        )
        preloaded_case = self._preload_signed_case_for_clip_verification(
            unsigned.signed_case_fingerprint
        )
        try:
            with self._transaction(immediate=False):
                existing_signed_identity = self._preflight_review_record_before_clips_locked(
                    signed_record_bytes=signed_record_bytes,
                    signed_record=signed_record,
                    record_type=record_type,
                    policy_archive=policy_archive,
                    accepted_at_ns=accepted_at_ns,
                    preloaded_case=preloaded_case,
                )
            with ExitStack() as clip_stack:
                clips_verified = not existing_signed_identity
                if clips_verified:
                    self._verify_case_clips_into_stack(clip_stack, preloaded_case)
                with self._transaction(immediate=True):
                    self._validate_schema()
                    case_row, signed_case = self._load_signed_case_locked(
                        unsigned.signed_case_fingerprint
                    )
                    if signed_case != preloaded_case:
                        _fail("COPILOT_CASE_TAMPER", "case changed after clip verification")
                    if unsigned.case_fingerprint != signed_case.case_fingerprint:
                        _fail("CASE_MISMATCH", "review record binds another unsigned case")
                    match_row = self._load_match_locked(case_row["match_id"])
                    self._check_match_pins(match_row, policy_archive=policy_archive)
                    self._check_time_locked(match_row, at_ns=accepted_at_ns)
                    if match_row["integrity_blocked"]:
                        _fail("INTEGRITY_BLOCKED", "blocked ledger cannot append review actions")
                    replay = self._replay_or_permanently_block_locked(
                        match_id=case_row["match_id"],
                        policy_archive=policy_archive,
                        verified_at_ns=accepted_at_ns,
                    )
                    if replay.review is None:
                        raise AssertionError("review append requires review replay")
                    case_state = replay.review.case_state(signed_case.case_fingerprint)
                    identity_rows = self._connection.execute(
                        """
                        SELECT * FROM request_identities
                        WHERE idempotency_key = ? OR request_fingerprint = ?
                        """,
                        (unsigned.idempotency_key, request_fingerprint),
                    ).fetchmany(3)
                    exact_identity = tuple(
                        row
                        for row in identity_rows
                        if row["idempotency_key"] == unsigned.idempotency_key
                        and row["request_kind"] == request_kind
                        and row["request_fingerprint"] == request_fingerprint
                        and row["accepted_identity_fingerprint"]
                        == signed_record_fingerprint
                    )
                    existing_record = self._connection.execute(
                        """
                        SELECT * FROM copilot_journal
                        WHERE signed_record_fingerprint = ?
                           OR idempotency_key = ?
                        """,
                        (signed_record_fingerprint, unsigned.idempotency_key),
                    ).fetchmany(3)
                    exact_record = tuple(
                        row
                        for row in existing_record
                        if row["signed_record_fingerprint"]
                        == signed_record_fingerprint
                        and row["signed_record_bytes"] == signed_record_bytes
                        and row["idempotency_key"] == unsigned.idempotency_key
                    )
                    if identity_rows or existing_record:
                        if (
                            len(identity_rows) != 1
                            or len(exact_identity) != 1
                            or len(existing_record) != 1
                            or len(exact_record) != 1
                        ):
                            _fail(
                                "REVIEW_IDEMPOTENCY_CONFLICT",
                                "review request identity is bound to different content",
                            )
                        row = exact_record[0]
                        context = self._context_for_signed_case(
                            signed_case,
                            case_sequence=row["case_sequence"],
                            journal_head_fingerprint=signed_record_fingerprint,
                        )
                        checkpoint = self._checkpoint_for_review_prefix_locked(
                            match_row=match_row,
                            revision=signed_case.case.state_revision,
                            archive_generation=row["verification_archive_generation"],
                            review_position=row["review_position"],
                            review_history_head_sha256=row[
                                "review_history_head_sha256"
                            ],
                            verified_at_ns=row["accepted_at_ns"],
                        )
                        self._connection.execute(
                            "UPDATE matches SET last_verified_at_ns = ? WHERE match_id = ?",
                            (accepted_at_ns, case_row["match_id"]),
                        )
                        return ReviewJournalAppendResult(
                            case_row["match_id"],
                            signed_case.case_fingerprint,
                            row["case_sequence"],
                            signed_record_fingerprint,
                            record_type,
                            row["accepted_at_ns"],
                            context,
                            row["review_position"],
                            row["review_history_head_sha256"],
                            checkpoint,
                        )
                    if not clips_verified:
                        _fail(
                            "REVIEW_RETRY_RACE",
                            "preexisting review record disappeared before replay",
                        )
                    if case_state.linked_event_id is not None:
                        _fail("CASE_ALREADY_LINKED", "linked case cannot accept actions")
                    if signed_case.case.state_revision != replay.state.revision:
                        _fail("STALE_CASE_REVISION", "case revision is no longer current")
                    if replay.review.preflight.journal_count >= MAX_COPILOT_JOURNAL_RECORDS_PER_MATCH:
                        _fail("COPILOT_ACTION_LIMIT", "match action count limit reached")
                    if case_state.case_sequence >= MAX_REVIEW_ACTIONS:
                        _fail("REVIEW_ACTION_LIMIT", "case action count limit reached")
                    if (
                        unsigned.expected_case_sequence != case_state.case_sequence
                        or unsigned.previous_record_fingerprint
                        != case_state.head_fingerprint
                    ):
                        _fail("STALE_REVIEW_HEAD", "review action does not extend current head")
                    if signed_record.signed_at_ns < case_state.latest_accepted_at_ns:
                        _fail("REVIEW_RECORD_TIME", "review signature predates accepted head")
                    if not signed_record.signed_at_ns <= accepted_at_ns:
                        _fail("REVIEW_RECORD_TIME", "acceptance predates review signature")
                    self._verify_case_current_use_locked(
                        signed_case=signed_case,
                        policy_archive=policy_archive,
                        verified_at_ns=accepted_at_ns,
                        adoptions=replay.adoptions,
                    )
                    signing_adoption = self._signing_policy_adoption(
                        replay.adoptions,
                        policy_fingerprint=signed_record.policy_fingerprint,
                        signed_at_ns=signed_record.signed_at_ns,
                        label="review record signature",
                    )
                    verification_adoption = self._adoption_at(
                        replay.adoptions,
                        accepted_at_ns,
                        label="review record acceptance",
                    )
                    try:
                        if record_type == "DISPOSITION":
                            verify_signed_review_disposition(
                                signed_record,
                                signed_case=signed_case,
                                policy_archive=policy_archive,
                                verified_at_ns=accepted_at_ns,
                            )
                        else:
                            considered: list[SignedReviewDisposition] = []
                            for fingerprint in (
                                unsigned.considered_signed_disposition_fingerprints
                            ):
                                rows = self._connection.execute(
                                    """
                                    SELECT record_type, case_fingerprint,
                                           signed_record_bytes
                                    FROM copilot_journal
                                    WHERE signed_record_fingerprint = ?
                                    """,
                                    (fingerprint,),
                                ).fetchmany(2)
                                if (
                                    len(rows) != 1
                                    or rows[0]["record_type"] != "DISPOSITION"
                                    or rows[0]["case_fingerprint"]
                                    != signed_case.case_fingerprint
                                ):
                                    _fail(
                                        "ADJUDICATION_MEMBERSHIP",
                                        "adjudication names nonaccepted disposition",
                                    )
                                considered.append(
                                    parse_signed_review_disposition(
                                        rows[0]["signed_record_bytes"]
                                    )
                                )
                            verify_signed_review_adjudication(
                                signed_record,
                                considered_signed_dispositions=tuple(considered),
                                signed_case=signed_case,
                                policy_archive=policy_archive,
                                verified_at_ns=accepted_at_ns,
                            )
                    except (ReviewSignatureError, ReviewContractError) as exc:
                        raise EventStoreError(
                            "REVIEW_EVIDENCE_REVOKED"
                            if "REVOKED" in str(exc)
                            else "REVIEW_SIGNATURE_INVALID",
                            "new review record verification failed",
                        ) from exc
                    new_sequence = case_state.case_sequence + 1
                    review_position = replay.review.preflight.history_count + 1
                    previous_review_head = replay.review.review_history_head_sha256
                    review_head = self._review_history_head(
                        previous_review_head,
                        review_position=review_position,
                        entry_kind=record_type,
                        case_fingerprint=signed_case.case_fingerprint,
                        entry_fingerprint=signed_record_fingerprint,
                        committed_at_ns=accepted_at_ns,
                    )
                    context = self._context_for_signed_case(
                        signed_case,
                        case_sequence=new_sequence,
                        journal_head_fingerprint=signed_record_fingerprint,
                    )
                    result_fingerprint = self._review_result_identity_fingerprint(
                        signed_record_fingerprint=signed_record_fingerprint,
                        case_sequence=new_sequence,
                        context_fingerprint=context.fingerprint(),
                        review_position=review_position,
                        review_history_head_sha256=review_head,
                    )
                    projected_blob = replay.review.preflight.blob_bytes + len(
                        signed_record_bytes
                    )
                    journal_row_text = (
                        signed_record_fingerprint,
                        case_row["match_id"],
                        signed_case.case_fingerprint,
                        signed_case.fingerprint(),
                        record_type,
                        unsigned.fingerprint(),
                        unsigned.previous_record_fingerprint,
                        unsigned.idempotency_key,
                        signed_record.policy_fingerprint,
                        review_head,
                    )
                    history_row_text = (
                        case_row["match_id"],
                        record_type,
                        signed_case.case_fingerprint,
                        signed_record_fingerprint,
                        previous_review_head,
                        review_head,
                    )
                    request_row_text = (
                        unsigned.idempotency_key,
                        case_row["match_id"],
                        request_kind,
                        request_fingerprint,
                        signed_record_fingerprint,
                        result_fingerprint,
                    )
                    projected_text = replay.review.preflight.text_bytes + sum(
                        len(value)
                        for value in (
                            *journal_row_text,
                            *history_row_text,
                            *request_row_text,
                        )
                    )
                    if projected_text > MAX_COPILOT_REVIEW_TEXT_BYTES_PER_MATCH:
                        _fail("REVIEW_TEXT_BUDGET", "review append exceeds text budget")
                    if projected_blob + projected_text > MAX_COPILOT_REVIEW_BYTES_PER_MATCH:
                        _fail("REVIEW_BYTE_BUDGET", "review append exceeds total budget")
                    self._connection.execute(
                        """
                        INSERT INTO request_identities(
                            idempotency_key, match_id, request_kind,
                            request_fingerprint, accepted_identity_fingerprint,
                            result_identity_fingerprint, created_at_ns
                        ) VALUES(?, ?, ?, ?, ?, ?, ?)
                        """,
                        (
                            unsigned.idempotency_key,
                            case_row["match_id"],
                            request_kind,
                            request_fingerprint,
                            signed_record_fingerprint,
                            result_fingerprint,
                            accepted_at_ns,
                        ),
                    )
                    self._connection.execute(
                        """
                        INSERT INTO copilot_journal(
                            signed_record_fingerprint, match_id, case_fingerprint,
                            signed_case_fingerprint, case_sequence, record_type,
                            unsigned_record_fingerprint,
                            previous_record_fingerprint, idempotency_key,
                            signed_record_bytes, policy_fingerprint,
                            signing_policy_generation,
                            verification_archive_generation, signed_at_ns,
                            accepted_at_ns, review_position,
                            review_history_head_sha256
                        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        """,
                        (
                            signed_record_fingerprint,
                            case_row["match_id"],
                            signed_case.case_fingerprint,
                            signed_case.fingerprint(),
                            new_sequence,
                            record_type,
                            unsigned.fingerprint(),
                            unsigned.previous_record_fingerprint,
                            unsigned.idempotency_key,
                            signed_record_bytes,
                            signed_record.policy_fingerprint,
                            signing_adoption.generation,
                            verification_adoption.generation,
                            signed_record.signed_at_ns,
                            accepted_at_ns,
                            review_position,
                            review_head,
                        ),
                    )
                    self._insert_review_history_row(
                        match_id=case_row["match_id"],
                        review_position=review_position,
                        entry_kind=record_type,
                        case_fingerprint=signed_case.case_fingerprint,
                        entry_fingerprint=signed_record_fingerprint,
                        committed_at_ns=accepted_at_ns,
                        previous_head=previous_review_head,
                        history_head=review_head,
                    )
                    changed_case = self._connection.execute(
                        """
                        UPDATE copilot_cases SET current_case_sequence = ?,
                            current_head_fingerprint = ?
                        WHERE case_fingerprint = ? AND current_case_sequence = ?
                          AND current_head_fingerprint = ? AND linked_event_id IS NULL
                        """,
                        (
                            new_sequence,
                            signed_record_fingerprint,
                            signed_case.case_fingerprint,
                            case_state.case_sequence,
                            case_state.head_fingerprint,
                        ),
                    ).rowcount
                    changed_match = self._connection.execute(
                        """
                        UPDATE matches SET last_verified_at_ns = ?,
                            copilot_action_count = ?, review_position = ?,
                            review_history_head_sha256 = ?
                        WHERE match_id = ? AND current_revision = ?
                          AND copilot_action_count = ? AND review_position = ?
                        """,
                        (
                            accepted_at_ns,
                            replay.review.preflight.journal_count + 1,
                            review_position,
                            review_head,
                            case_row["match_id"],
                            replay.state.revision,
                            replay.review.preflight.journal_count,
                            replay.review.preflight.history_count,
                        ),
                    ).rowcount
                    if changed_case != 1 or changed_match != 1:
                        _fail("CONCURRENT_REVIEW", "case/review projection changed")
                    self._apply_private_test_fault_locked()
                    self._validate_schema()
                    accepted_match_row = self._load_match_locked(case_row["match_id"])
                    accepted_replay = self._replay_locked(
                        match_id=case_row["match_id"],
                        policy_archive=policy_archive,
                        verified_at_ns=accepted_at_ns,
                    )
                    accepted_state = accepted_replay.review.case_state(
                        signed_case.case_fingerprint
                    ) if accepted_replay.review is not None else None
                    if (
                        accepted_state is None
                        or accepted_state.case_sequence != new_sequence
                        or accepted_state.head_fingerprint
                        != signed_record_fingerprint
                        or accepted_replay.state != replay.state
                    ):
                        _fail("POST_REVIEW_REPLAY", "accepted review differs from proposal")
                    checkpoint = self._checkpoint_from_row(
                        accepted_match_row,
                        replay=accepted_replay,
                        verified_at_ns=accepted_at_ns,
                    )
                    result = ReviewJournalAppendResult(
                        case_row["match_id"],
                        signed_case.case_fingerprint,
                        new_sequence,
                        signed_record_fingerprint,
                        record_type,
                        accepted_at_ns,
                        context,
                        review_position,
                        review_head,
                        checkpoint,
                    )
                return result
        except sqlite3.IntegrityError as exc:
            raise EventStoreError(
                "REVIEW_IDEMPOTENCY_CONFLICT",
                "review request identity conflict",
            ) from exc
        except sqlite3.OperationalError as exc:
            code = "CONCURRENT_WRITE" if "locked" in str(exc).lower() else "SQLITE_OPERATION"
            raise EventStoreError(code, "review append SQLite operation failed") from exc

    @_sqlite_boundary
    def append_copilot_authorized_event(
        self,
        envelope_bytes: bytes,
        context_bytes: bytes,
        *,
        policy_archive: AuthorizationPolicyArchive,
        verified_at_ns: int,
    ) -> CopilotAppendResult:
        """Atomically append one human-authorized event and its exact case link."""

        if type(envelope_bytes) is not bytes:
            raise ValueError("envelope_bytes must be exact bytes")
        if type(context_bytes) is not bytes:
            raise ValueError("context_bytes must be exact bytes")
        verified_at_ns = _timestamp(verified_at_ns, "verified_at_ns")
        try:
            envelope = parse_authorized_rule_event(envelope_bytes)
            context = parse_review_authorization_context(context_bytes)
        except (AuthorizationError, ReviewContractError, ValueError) as exc:
            raise EventStoreError(
                "COPILOT_APPEND_INVALID",
                "envelope or review context bytes are invalid",
            ) from exc
        if encode_authorized_rule_event(envelope) != envelope_bytes:
            _fail("ENVELOPE_NON_CANONICAL", "envelope bytes are not canonical")
        if encode_review_authorization_context(context) != context_bytes:
            _fail("COPILOT_CONTEXT_NONCANONICAL", "context bytes are not canonical")
        # Reject callers without live actor/authorizer credentials before any
        # immutable media object can be opened.
        try:
            verify_authorized_rule_event(
                envelope,
                policy_archive=policy_archive,
                verified_at_ns=verified_at_ns,
            )
        except AuthorizationError:
            self._persist_block_for_exact_copilot_retry(
                envelope_bytes=envelope_bytes,
                envelope=envelope,
                policy_archive=policy_archive,
                verified_at_ns=verified_at_ns,
            )
            raise
        preloaded_case = self._preload_signed_case_for_clip_verification(
            context.signed_case_fingerprint
        )
        try:
            context.validate_signed_case(preloaded_case)
        except ValueError as exc:
            raise EventStoreError(
                "COPILOT_CONTEXT_INVALID",
                "context does not bind the exact persisted signed case",
            ) from exc
        try:
            with self._transaction(immediate=False):
                preflight_values = self._validate_copilot_proposal_locked(
                    envelope=envelope,
                    envelope_bytes=envelope_bytes,
                    context=context,
                    policy_archive=policy_archive,
                    verified_at_ns=verified_at_ns,
                    preloaded_case=preloaded_case,
                )
                preexisting = preflight_values[-1] is not None
            with ExitStack() as clip_stack:
                clips_verified = not preexisting
                if clips_verified:
                    self._verify_case_clips_into_stack(clip_stack, preloaded_case)
                with self._transaction(immediate=True):
                    self._validate_schema()
                    (
                        match_row,
                        replay,
                        case_row,
                        signed_case,
                        case_state,
                        relation,
                    ) = self._validate_copilot_proposal_locked(
                        envelope=envelope,
                        envelope_bytes=envelope_bytes,
                        context=context,
                        policy_archive=policy_archive,
                        verified_at_ns=verified_at_ns,
                        preloaded_case=preloaded_case,
                    )
                    event = envelope.event
                    command = envelope.authorization_record.signed_command.command
                    if relation is not None:
                        replay_link = replay.review.link_for_event(event.event_id)
                        if replay_link is None:
                            raise AssertionError("exact copilot retry requires replay link")
                        self._connection.execute(
                            "UPDATE matches SET last_verified_at_ns = ? WHERE match_id = ?",
                            (verified_at_ns, event.match_id),
                        )
                        return CopilotAppendResult(
                            self._result_for_existing_locked(
                                relation[3],
                                match_row=match_row,
                                replay=replay,
                                verified_at_ns=verified_at_ns,
                            ),
                            replay_link.case_fingerprint,
                            replay_link.context,
                            replay_link.link,
                        )
                    if not clips_verified:
                        _fail(
                            "COPILOT_RETRY_RACE",
                            "preexisting linked event disappeared before final replay",
                        )
                    if replay.preflight is None or replay.review is None:
                        raise AssertionError("copilot append requires complete preflight")
                    if replay.event_count >= self.ruleset.max_events_per_match:
                        _fail(
                            "EVENT_LIMIT",
                            "match event limit reached; external rollover required",
                        )
                    try:
                        after = self.reducer.reduce(replay.state, event).after
                    except RulesError as exc:
                        raise EventStoreError("RULE_REJECTED", str(exc)) from exc
                    state_bytes = encode_match_state(after, ruleset=self.ruleset)
                    state_fingerprint = match_state_fingerprint(
                        after,
                        ruleset=self.ruleset,
                    )
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
                    link = CaseAuthorizationLink(
                        context=context,
                        context_fingerprint=context.fingerprint(),
                        signed_case_fingerprint=signed_case.fingerprint(),
                        authorized_envelope_fingerprint=envelope_fingerprint,
                        event_fingerprint=event.fingerprint(),
                        event_id=event.event_id,
                        committed_event_sequence=event.sequence_number,
                        committed_state_revision=after.revision,
                        outbox_id=outbox_id,
                        committed_at_ns=verified_at_ns,
                    )
                    link.validate_signed_case(signed_case)
                    link_bytes = encode_case_authorization_link(link)
                    link_fingerprint = link.fingerprint()
                    review_position = replay.review.preflight.history_count + 1
                    previous_review_head = replay.review.review_history_head_sha256
                    review_head = self._review_history_head(
                        previous_review_head,
                        review_position=review_position,
                        entry_kind="AUTHORIZATION_LINK",
                        case_fingerprint=signed_case.case_fingerprint,
                        entry_fingerprint=link_fingerprint,
                        committed_at_ns=verified_at_ns,
                    )
                    payload_bytes = self._outbox_payload(
                        envelope=envelope,
                        state=after,
                        state_fingerprint=state_fingerprint,
                        archive_fingerprint=archive_fingerprint,
                        message_id=message_id,
                        outbox_id=outbox_id,
                        appended_at_ns=verified_at_ns,
                        review_position=review_position,
                        review_history_head_sha256=review_head,
                        case_authorization_link_fingerprint=link_fingerprint,
                        review_context_fingerprint=context.fingerprint(),
                        case_fingerprint=signed_case.case_fingerprint,
                        signed_case_fingerprint=signed_case.fingerprint(),
                    )
                    payload_fingerprint = hashlib.sha256(payload_bytes).hexdigest()
                    review_projected_blob = (
                        replay.review.preflight.blob_bytes
                        + len(context_bytes)
                        + len(link_bytes)
                    )
                    review_projected_text = replay.review.preflight.text_bytes + sum(
                        len(value)
                        for value in (
                            signed_case.case_fingerprint,
                            event.match_id,
                            signed_case.fingerprint(),
                            event.event_id,
                            context.fingerprint(),
                            link_fingerprint,
                            review_head,
                            event.event_id,
                            link_fingerprint,
                            event.match_id,
                            "AUTHORIZATION_LINK",
                            signed_case.case_fingerprint,
                            link_fingerprint,
                            previous_review_head,
                            review_head,
                        )
                    )
                    if review_projected_text > MAX_COPILOT_REVIEW_TEXT_BYTES_PER_MATCH:
                        _fail("REVIEW_TEXT_BUDGET", "case link exceeds review text budget")
                    if (
                        review_projected_blob + review_projected_text
                        > MAX_COPILOT_REVIEW_BYTES_PER_MATCH
                    ):
                        _fail("REVIEW_BYTE_BUDGET", "case link exceeds review byte budget")
                    request_fingerprint = self._event_request_fingerprint(
                        envelope,
                        request_kind="COPILOT_EVENT",
                    )
                    result_identity_fingerprint = self._event_result_identity_fingerprint(
                        envelope_fingerprint=envelope_fingerprint,
                        state_fingerprint=state_fingerprint,
                        outbox_id=outbox_id,
                        outbox_payload_fingerprint=payload_fingerprint,
                    )
                    ledger_extra_text = sum(
                        len(value)
                        for value in (
                            review_head,
                            review_head,
                            link_fingerprint,
                            context.fingerprint(),
                            command.idempotency_key,
                            event.match_id,
                            "COPILOT_EVENT",
                            request_fingerprint,
                            envelope_fingerprint,
                            result_identity_fingerprint,
                        )
                    )
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
                        )
                        + ledger_extra_text,
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
                        review_position=review_position,
                        review_history_head_sha256=review_head,
                        case_authorization_link_fingerprint=link_fingerprint,
                        review_context_fingerprint=context.fingerprint(),
                        case_fingerprint=signed_case.case_fingerprint,
                        signed_case_fingerprint=signed_case.fingerprint(),
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
                        review_position=review_position,
                        review_history_head_sha256=review_head,
                        case_authorization_link_fingerprint=link_fingerprint,
                        review_context_fingerprint=context.fingerprint(),
                    )
                    self._connection.execute(
                        """
                        INSERT INTO request_identities(
                            idempotency_key, match_id, request_kind,
                            request_fingerprint, accepted_identity_fingerprint,
                            result_identity_fingerprint, created_at_ns
                        ) VALUES(?, ?, 'COPILOT_EVENT', ?, ?, ?, ?)
                        """,
                        (
                            command.idempotency_key,
                            event.match_id,
                            request_fingerprint,
                            envelope_fingerprint,
                            result_identity_fingerprint,
                            verified_at_ns,
                        ),
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
                    self._connection.execute(
                        """
                        INSERT INTO copilot_authorization_links(
                            case_fingerprint, match_id, signed_case_fingerprint,
                            event_id, context_fingerprint, context_bytes,
                            link_fingerprint, link_bytes, committed_at_ns,
                            review_position, review_history_head_sha256
                        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        """,
                        (
                            signed_case.case_fingerprint,
                            event.match_id,
                            signed_case.fingerprint(),
                            event.event_id,
                            context.fingerprint(),
                            context_bytes,
                            link_fingerprint,
                            link_bytes,
                            verified_at_ns,
                            review_position,
                            review_head,
                        ),
                    )
                    self._insert_review_history_row(
                        match_id=event.match_id,
                        review_position=review_position,
                        entry_kind="AUTHORIZATION_LINK",
                        case_fingerprint=signed_case.case_fingerprint,
                        entry_fingerprint=link_fingerprint,
                        committed_at_ns=verified_at_ns,
                        previous_head=previous_review_head,
                        history_head=review_head,
                    )
                    changed_case = self._connection.execute(
                        """
                        UPDATE copilot_cases SET linked_event_id = ?,
                            authorization_link_fingerprint = ?
                        WHERE case_fingerprint = ? AND linked_event_id IS NULL
                          AND current_case_sequence = ?
                          AND current_head_fingerprint = ?
                        """,
                        (
                            event.event_id,
                            link_fingerprint,
                            signed_case.case_fingerprint,
                            case_state.case_sequence,
                            case_state.head_fingerprint,
                        ),
                    ).rowcount
                    changed_match = self._connection.execute(
                        """
                        UPDATE matches SET
                            last_verified_at_ns = ?, current_revision = ?,
                            current_state_bytes = ?, current_state_fingerprint = ?,
                            ledger_head_sha256 = ?, copilot_link_count = ?,
                            review_position = ?, review_history_head_sha256 = ?
                        WHERE match_id = ? AND current_revision = ?
                          AND copilot_link_count = ? AND review_position = ?
                          AND review_history_head_sha256 = ?
                        """,
                        (
                            verified_at_ns,
                            event.sequence_number,
                            state_bytes,
                            state_fingerprint,
                            new_head,
                            replay.review.preflight.link_count + 1,
                            review_position,
                            review_head,
                            event.match_id,
                            replay.state.revision,
                            replay.review.preflight.link_count,
                            replay.review.preflight.history_count,
                            previous_review_head,
                        ),
                    ).rowcount
                    if changed_case != 1 or changed_match != 1:
                        _fail("CONCURRENT_COPILOT_APPEND", "case or match projection changed")
                    self._apply_private_test_fault_locked()
                    self._validate_schema()
                    accepted_row = self._load_match_locked(event.match_id)
                    accepted_replay = self._replay_locked(
                        match_id=event.match_id,
                        policy_archive=policy_archive,
                        verified_at_ns=verified_at_ns,
                    )
                    accepted_link = accepted_replay.review.link_for_event(event.event_id)
                    if (
                        accepted_link is None
                        or accepted_link.link != link
                        or accepted_replay.state != after
                        or accepted_replay.ledger_head_sha256 != new_head
                        or accepted_replay.outbox_position != outbox_id
                    ):
                        _fail(
                            "POST_COPILOT_REPLAY",
                            "accepted linked event differs from atomic proposal",
                        )
                    checkpoint = self._checkpoint_from_row(
                        accepted_row,
                        replay=accepted_replay,
                        verified_at_ns=verified_at_ns,
                    )
                    append = AppendResult(
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
                    result = CopilotAppendResult(
                        append,
                        signed_case.case_fingerprint,
                        context,
                        link,
                    )
                return result
        except sqlite3.IntegrityError as exc:
            raise EventStoreError(
                "COPILOT_APPEND_IDENTITY_CONFLICT",
                "atomic case/event identity conflict",
            ) from exc
        except sqlite3.OperationalError as exc:
            code = "CONCURRENT_WRITE" if "locked" in str(exc).lower() else "SQLITE_OPERATION"
            raise EventStoreError(code, "copilot append SQLite operation failed") from exc

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
                        "assessment-assisted commands require the dedicated atomic case-link API",
                    )
                if command.idempotency_key.startswith(
                    ("copilot-v1:", "case-admission-v1:")
                ):
                    _fail(
                        "COPILOT_CONTEXT_REQUIRED",
                        "reserved copilot request IDs require the dedicated atomic case-link path",
                    )
                request_kind = "HUMAN_EVENT"
                request_fingerprint = self._event_request_fingerprint(
                    envelope,
                    request_kind=request_kind,
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
                    request_kind=request_kind,
                    request_fingerprint=request_fingerprint,
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
                review_position = match_row["review_position"]
                review_history_head = match_row["review_history_head_sha256"]
                payload_bytes = self._outbox_payload(
                    envelope=envelope,
                    state=after,
                    state_fingerprint=state_fingerprint,
                    archive_fingerprint=archive_fingerprint,
                    message_id=message_id,
                    outbox_id=outbox_id,
                    appended_at_ns=verified_at_ns,
                    review_position=review_position,
                    review_history_head_sha256=review_history_head,
                )
                payload_fingerprint = hashlib.sha256(payload_bytes).hexdigest()
                result_identity_fingerprint = self._event_result_identity_fingerprint(
                    envelope_fingerprint=envelope_fingerprint,
                    state_fingerprint=state_fingerprint,
                    outbox_id=outbox_id,
                    outbox_payload_fingerprint=payload_fingerprint,
                )
                v3_text_bytes = sum(
                    len(value)
                    for value in (
                        review_history_head,
                        review_history_head,
                        command.idempotency_key,
                        event.match_id,
                        request_kind,
                        request_fingerprint,
                        envelope_fingerprint,
                        result_identity_fingerprint,
                    )
                )
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
                    )
                    + v3_text_bytes,
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
                    review_position=review_position,
                    review_history_head_sha256=review_history_head,
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
                    review_position=review_position,
                    review_history_head_sha256=review_history_head,
                    case_authorization_link_fingerprint=None,
                    review_context_fingerprint=None,
                )
                self._connection.execute(
                    """
                    INSERT INTO request_identities(
                        idempotency_key, match_id, request_kind,
                        request_fingerprint, accepted_identity_fingerprint,
                        result_identity_fingerprint, created_at_ns
                    ) VALUES(?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        command.idempotency_key,
                        event.match_id,
                        request_kind,
                        request_fingerprint,
                        envelope_fingerprint,
                        result_identity_fingerprint,
                        verified_at_ns,
                    ),
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

    def _preflight_case_admission_before_clips_locked(
        self,
        *,
        signed_case_bytes: bytes,
        signed_case: SignedScorerCopilotCase,
        policy_archive: AuthorizationPolicyArchive,
        admitted_at_ns: int,
    ) -> bool:
        """Authenticate and establish eligibility before immutable clip reads."""

        case = signed_case.case
        self._validate_schema()
        existing = self._connection.execute(
            """
            SELECT * FROM copilot_cases
            WHERE case_fingerprint = ? OR signed_case_fingerprint = ?
               OR (match_id = ? AND rally_id = ? AND state_revision = ?)
            """,
            (
                signed_case.case_fingerprint,
                signed_case.fingerprint(),
                case.match_id,
                case.rally_id,
                case.state_revision,
            ),
        ).fetchmany(4)
        exact = tuple(
            row
            for row in existing
            if row["case_fingerprint"] == signed_case.case_fingerprint
            and row["signed_case_fingerprint"] == signed_case.fingerprint()
            and row["signed_case_bytes"] == signed_case_bytes
        )
        if existing and (len(existing) != 1 or len(exact) != 1):
            _fail(
                "CASE_ADMISSION_CONFLICT",
                "unsigned case/rally revision is bound to another presentation",
            )
        historical_retry = bool(existing)
        if not historical_retry:
            try:
                # This deliberately precedes full ledger replay: callers without
                # a trusted producer signature cannot force replay plus media.
                verify_signed_scorer_copilot_case(
                    signed_case,
                    case=case,
                    policy_archive=policy_archive,
                    verified_at_ns=admitted_at_ns,
                )
            except (AuthorizationError, CaseAttestationError) as exc:
                raise EventStoreError(
                    "REVIEW_EVIDENCE_REVOKED"
                    if "REVOKED" in str(exc)
                    else "COPILOT_CASE_SIGNATURE_INVALID",
                    "case producer verification failed before clip access",
                ) from exc

        match_row = self._load_match_locked(case.match_id)
        self._check_match_pins(match_row, policy_archive=policy_archive)
        self._check_time_locked(match_row, at_ns=admitted_at_ns)
        if match_row["integrity_blocked"]:
            _fail("INTEGRITY_BLOCKED", "blocked ledger cannot admit review cases")
        replay = self._replay_or_permanently_block_locked(
            match_id=case.match_id,
            policy_archive=policy_archive,
            verified_at_ns=admitted_at_ns,
        )
        if replay.review is None:
            raise AssertionError("case admission preflight requires review replay")
        if historical_retry:
            # Exact retry retrieves the immutable historical receipt only.  It
            # makes no current-usability claim; derive_scorer_copilot_context is
            # the sole presentation boundary and rechecks revocation + media.
            return True

        if admitted_at_ns < case.opened_at_ns:
            _fail("CASE_ADMISSION_TIME", "case cannot be admitted before opening")
        if case.state_revision != replay.state.revision:
            _fail("STALE_CASE_REVISION", "case state revision is not current")
        current_set = replay.state.current_set
        if current_set is None or current_set.number != case.set_number:
            _fail("CASE_SET_CONTEXT", "case set is not the current active set")
        if current_set.phase is not SetPhase.IN_PROGRESS:
            _fail(
                "CASE_SET_NOT_IN_PROGRESS",
                "cases require an in-progress current set",
            )
        if replay.state.match_complete:
            _fail("CASE_MATCH_COMPLETE", "completed matches cannot admit cases")
        if replay.state.rally_resolution(case.rally_id) is not None:
            _fail("CASE_RALLY_RESOLVED", "case rally is already resolved")
        if replay.review.preflight.case_count >= MAX_COPILOT_CASES_PER_MATCH:
            _fail("COPILOT_CASE_LIMIT", "case count limit reached")
        self._signing_policy_adoption(
            replay.adoptions,
            policy_fingerprint=signed_case.authorization_policy_fingerprint,
            signed_at_ns=signed_case.signed_at_ns,
            label="case producer signature",
        )
        self._adoption_at(
            replay.adoptions,
            admitted_at_ns,
            label="case admission",
        )
        if case.signed_assessment is not None:
            assessment_adoption = self._adoption_at(
                replay.adoptions,
                case.signed_assessment.signed_at_ns,
                label="case assessment signature",
            )
            try:
                verify_case_policy_assessment(
                    case,
                    signing_policy=policy_archive.resolve_policy(
                        assessment_adoption.current_policy_fingerprint
                    ),
                    policy_archive=policy_archive,
                    verified_at_ns=admitted_at_ns,
                )
            except (AuthorizationError, ReviewSignatureError) as exc:
                raise EventStoreError(
                    "REVIEW_EVIDENCE_REVOKED"
                    if "REVOKED" in str(exc)
                    else "COPILOT_CASE_SIGNATURE_INVALID",
                    "case assessment verification failed before clip access",
                ) from exc
        return False

    def _verify_case_clips_into_stack(
        self,
        stack: ExitStack,
        signed_case: SignedScorerCopilotCase,
    ) -> None:
        """Acquire and retain every exact clip-generation lease through commit."""

        if type(stack) is not ExitStack:
            raise ValueError("stack must be an exact ExitStack")
        if type(signed_case) is not SignedScorerCopilotCase:
            raise ValueError("signed_case must be exact")
        if self.immutable_store_root is None:
            _fail(
                "COPILOT_IMMUTABLE_STORE_UNCONFIGURED",
                "review APIs require a trusted immutable store root",
            )
        rendered_total = sum(
            clip.rendered_size_bytes for clip in signed_case.case.clips
        )
        if rendered_total > MAX_COPILOT_CLIP_BYTES_PER_CASE:
            _fail("COPILOT_CLIP_BUDGET", "case rendered clips exceed aggregate bound")
        try:
            for clip in sorted(
                signed_case.case.clips,
                key=lambda item: item.immutable_generation_id,
            ):
                lease = stack.enter_context(
                    generation_read_lease(
                        self.immutable_store_root,
                        clip.immutable_generation_id,
                        blocking=False,
                    )
                )
                if lease.descriptor.object_sha256s != clip.generation_object_sha256s:
                    _fail(
                        "COPILOT_CLIP_GENERATION",
                        "clip generation descriptor has nonexact membership",
                    )
                expected_manifest = encode_review_clip_manifest(clip.manifest)
                with lease.open_verified_object(
                    clip.manifest_sha256,
                    max_bytes=MAX_REVIEW_RECORD_BYTES,
                ) as stream:
                    manifest_bytes = stream.read(MAX_REVIEW_RECORD_BYTES + 1)
                if manifest_bytes != expected_manifest:
                    _fail(
                        "COPILOT_CLIP_MANIFEST",
                        "generation manifest bytes differ from embedded canonical manifest",
                    )
                with lease.open_verified_object(
                    clip.manifest.rendered_clip_sha256,
                    max_bytes=clip.rendered_size_bytes,
                ) as stream:
                    rendered_size = os.fstat(stream.fileno()).st_size
                if rendered_size != clip.rendered_size_bytes:
                    _fail(
                        "COPILOT_CLIP_SIZE",
                        "rendered clip size differs from signed case",
                    )
        except ImmutableStoreError as exc:
            code = exc.code if _STABLE_ID_RE.fullmatch(exc.code) else "STORE_FAILURE"
            raise EventStoreError(
                f"COPILOT_CLIP_{code}"[:MAX_FAILURE_CODE_LENGTH],
                "immutable clip verification failed closed",
            ) from exc
        except OSError as exc:
            raise EventStoreError(
                "COPILOT_CLIP_IO_FAILURE",
                "immutable clip I/O failed closed",
            ) from exc

    def _load_signed_case_locked(
        self,
        signed_case_fingerprint: str,
    ) -> tuple[sqlite3.Row, SignedScorerCopilotCase]:
        _sha256(signed_case_fingerprint, "signed_case_fingerprint")
        rows = self._connection.execute(
            "SELECT * FROM copilot_cases WHERE signed_case_fingerprint = ?",
            (signed_case_fingerprint,),
        ).fetchmany(2)
        if len(rows) != 1:
            _fail("COPILOT_CASE_NOT_FOUND", "signed case does not resolve exactly once")
        raw = rows[0]["signed_case_bytes"]
        if type(raw) is not bytes:
            _fail("COPILOT_CASE_ENCODING", "persisted signed case is not a BLOB")
        try:
            signed_case = parse_signed_scorer_copilot_case(raw)
        except (CaseAttestationError, ReviewContractError, ValueError) as exc:
            raise EventStoreError("COPILOT_CASE_INVALID", "persisted case is invalid") from exc
        if signed_case.fingerprint() != signed_case_fingerprint:
            _fail("COPILOT_CASE_TAMPER", "signed case fingerprint differs from row")
        return rows[0], signed_case

    def _persist_block_for_exact_copilot_retry(
        self,
        *,
        envelope_bytes: bytes,
        envelope: AuthorizedRuleEvent,
        policy_archive: AuthorizationPolicyArchive,
        verified_at_ns: int,
    ) -> None:
        """Persist a scheduled authorization failure for an exact retry only.

        New invalid envelopes still fail before media and without taking the
        writer lock. An exact retained envelope is rechecked under the normal
        full replay path so a newly effective actor/authorizer revocation
        records the ledger's documented terminal integrity block.
        """

        event = envelope.event
        envelope_fingerprint = envelope.fingerprint()
        rows = self._connection.execute(
            """
            SELECT envelope_bytes, envelope_fingerprint FROM event_log
            WHERE match_id = ? AND event_id = ?
            """,
            (event.match_id, event.event_id),
        ).fetchmany(2)
        if (
            len(rows) != 1
            or rows[0]["envelope_bytes"] != envelope_bytes
            or rows[0]["envelope_fingerprint"] != envelope_fingerprint
        ):
            return
        with self._transaction(immediate=True):
            self._validate_schema()
            locked_rows = self._connection.execute(
                """
                SELECT envelope_bytes, envelope_fingerprint FROM event_log
                WHERE match_id = ? AND event_id = ?
                """,
                (event.match_id, event.event_id),
            ).fetchmany(2)
            if (
                len(locked_rows) != 1
                or locked_rows[0]["envelope_bytes"] != envelope_bytes
                or locked_rows[0]["envelope_fingerprint"] != envelope_fingerprint
            ):
                return
            match_row = self._load_match_locked(event.match_id)
            self._check_match_pins(match_row, policy_archive=policy_archive)
            if match_row["integrity_blocked"]:
                _fail(
                    "INTEGRITY_BLOCKED",
                    f"ledger is already blocked: {match_row['integrity_failure_code']}",
                )
            self._replay_or_permanently_block_locked(
                match_id=event.match_id,
                policy_archive=policy_archive,
                verified_at_ns=verified_at_ns,
            )

    def _preload_signed_case_for_clip_verification(
        self,
        signed_case_fingerprint: str,
    ) -> SignedScorerCopilotCase:
        """Preflight review bounds before loading one case for media leases."""

        metadata = self._connection.execute(
            """
            SELECT match_id FROM copilot_cases
            WHERE signed_case_fingerprint = ?
            """,
            (signed_case_fingerprint,),
        ).fetchmany(2)
        if len(metadata) != 1:
            _fail("COPILOT_CASE_NOT_FOUND", "signed case does not resolve exactly once")
        self._review_preflight_locked(metadata[0]["match_id"])
        _, signed_case = self._load_signed_case_locked(signed_case_fingerprint)
        return signed_case

    def _preflight_context_derivation_before_clips_locked(
        self,
        *,
        signed_case_fingerprint: str,
        policy_archive: AuthorizationPolicyArchive,
        verified_at_ns: int,
        preloaded_case: SignedScorerCopilotCase,
    ) -> None:
        """Reject ineligible presentations before opening immutable objects."""

        self._validate_schema()
        case_row, signed_case = self._load_signed_case_locked(
            signed_case_fingerprint
        )
        if signed_case != preloaded_case:
            _fail("COPILOT_CASE_TAMPER", "case changed before clip verification")
        match_row = self._load_match_locked(case_row["match_id"])
        self._check_match_pins(match_row, policy_archive=policy_archive)
        self._check_time_locked(match_row, at_ns=verified_at_ns)
        if match_row["integrity_blocked"]:
            _fail("INTEGRITY_BLOCKED", "blocked ledger cannot present review cases")
        replay = self._replay_or_permanently_block_locked(
            match_id=case_row["match_id"],
            policy_archive=policy_archive,
            verified_at_ns=verified_at_ns,
        )
        if replay.review is None:
            raise AssertionError("context derivation requires review replay")
        case_state = replay.review.case_state(signed_case.case_fingerprint)
        if case_state.linked_event_id is not None:
            _fail("CASE_ALREADY_LINKED", "linked case cannot produce a new context")
        if signed_case.case.state_revision != replay.state.revision:
            _fail("STALE_CASE_REVISION", "case revision is no longer current")
        self._verify_case_current_use_locked(
            signed_case=signed_case,
            policy_archive=policy_archive,
            verified_at_ns=verified_at_ns,
            adoptions=replay.adoptions,
        )

    def _preflight_review_record_before_clips_locked(
        self,
        *,
        signed_record_bytes: bytes,
        signed_record: SignedReviewDisposition | SignedReviewAdjudication,
        record_type: str,
        policy_archive: AuthorizationPolicyArchive,
        accepted_at_ns: int,
        preloaded_case: SignedScorerCopilotCase,
    ) -> bool:
        """Reject unauthenticated/stale review actions before any media I/O.

        The final writer transaction repeats every decision while holding the
        immutable-generation leases.  This read phase is only a resource gate:
        an untrusted caller cannot force hundreds of MiB of clip hashing with a
        fabricated signature or a stale journal head.
        """

        unsigned = (
            signed_record.disposition
            if record_type == "DISPOSITION"
            else signed_record.adjudication
        )
        case_row, signed_case = self._load_signed_case_locked(
            unsigned.signed_case_fingerprint
        )
        if signed_case != preloaded_case:
            _fail("COPILOT_CASE_TAMPER", "case changed before clip verification")
        if unsigned.case_fingerprint != signed_case.case_fingerprint:
            _fail("CASE_MISMATCH", "review record binds another unsigned case")
        match_row = self._load_match_locked(case_row["match_id"])
        self._check_match_pins(match_row, policy_archive=policy_archive)
        self._check_time_locked(match_row, at_ns=accepted_at_ns)
        if match_row["integrity_blocked"]:
            _fail("INTEGRITY_BLOCKED", "blocked ledger cannot append review actions")
        replay = self._replay_or_permanently_block_locked(
            match_id=case_row["match_id"],
            policy_archive=policy_archive,
            verified_at_ns=accepted_at_ns,
        )
        if replay.review is None:
            raise AssertionError("review preflight requires review replay")
        case_state = replay.review.case_state(signed_case.case_fingerprint)

        rows = self._connection.execute(
            """
            SELECT * FROM copilot_journal
            WHERE signed_record_fingerprint = ? OR idempotency_key = ?
            """,
            (signed_record.fingerprint(), unsigned.idempotency_key),
        ).fetchmany(3)
        exact = tuple(
            row
            for row in rows
            if row["signed_record_fingerprint"] == signed_record.fingerprint()
            and row["signed_record_bytes"] == signed_record_bytes
            and row["idempotency_key"] == unsigned.idempotency_key
            and row["record_type"] == record_type
        )
        if rows:
            if len(rows) != 1 or len(exact) != 1:
                _fail(
                    "REVIEW_IDEMPOTENCY_CONFLICT",
                    "review request identity is bound to different content",
                )
            # This is historical receipt retrieval, not a current presentation.
            return True

        request_kind = (
            "REVIEW_DISPOSITION"
            if record_type == "DISPOSITION"
            else "REVIEW_ADJUDICATION"
        )
        request_fingerprint = self._review_request_fingerprint(
            record_type=record_type,
            signed_record_fingerprint=signed_record.fingerprint(),
        )
        occupied_requests = self._connection.execute(
            """
            SELECT idempotency_key FROM request_identities
            WHERE idempotency_key = ? OR request_fingerprint = ?
            LIMIT 2
            """,
            (unsigned.idempotency_key, request_fingerprint),
        ).fetchmany(2)
        if occupied_requests:
            _fail(
                "REVIEW_IDEMPOTENCY_CONFLICT",
                "review request identity is occupied by another request kind",
            )

        if case_state.linked_event_id is not None:
            _fail("CASE_ALREADY_LINKED", "linked case cannot accept actions")
        if signed_case.case.state_revision != replay.state.revision:
            _fail("STALE_CASE_REVISION", "case revision is no longer current")
        if replay.review.preflight.journal_count >= MAX_COPILOT_JOURNAL_RECORDS_PER_MATCH:
            _fail("COPILOT_ACTION_LIMIT", "match action count limit reached")
        if case_state.case_sequence >= MAX_REVIEW_ACTIONS:
            _fail("REVIEW_ACTION_LIMIT", "case action count limit reached")
        if (
            unsigned.expected_case_sequence != case_state.case_sequence
            or unsigned.previous_record_fingerprint != case_state.head_fingerprint
        ):
            _fail("STALE_REVIEW_HEAD", "review action does not extend current head")
        if (
            signed_record.signed_at_ns < case_state.latest_accepted_at_ns
            or signed_record.signed_at_ns > accepted_at_ns
        ):
            _fail("REVIEW_RECORD_TIME", "review record time is not causal")
        self._verify_case_current_use_locked(
            signed_case=signed_case,
            policy_archive=policy_archive,
            verified_at_ns=accepted_at_ns,
            adoptions=replay.adoptions,
        )
        self._signing_policy_adoption(
            replay.adoptions,
            policy_fingerprint=signed_record.policy_fingerprint,
            signed_at_ns=signed_record.signed_at_ns,
            label="review record signature",
        )
        self._adoption_at(
            replay.adoptions,
            accepted_at_ns,
            label="review record acceptance",
        )
        try:
            if record_type == "DISPOSITION":
                verify_signed_review_disposition(
                    signed_record,
                    signed_case=signed_case,
                    policy_archive=policy_archive,
                    verified_at_ns=accepted_at_ns,
                )
            else:
                considered: list[SignedReviewDisposition] = []
                for fingerprint in (
                    unsigned.considered_signed_disposition_fingerprints
                ):
                    disposition_rows = self._connection.execute(
                        """
                        SELECT record_type, case_fingerprint, signed_record_bytes
                        FROM copilot_journal
                        WHERE signed_record_fingerprint = ?
                        """,
                        (fingerprint,),
                    ).fetchmany(2)
                    if (
                        len(disposition_rows) != 1
                        or disposition_rows[0]["record_type"] != "DISPOSITION"
                        or disposition_rows[0]["case_fingerprint"]
                        != signed_case.case_fingerprint
                    ):
                        _fail(
                            "ADJUDICATION_MEMBERSHIP",
                            "adjudication names nonaccepted disposition",
                        )
                    considered.append(
                        parse_signed_review_disposition(
                            disposition_rows[0]["signed_record_bytes"]
                        )
                    )
                verify_signed_review_adjudication(
                    signed_record,
                    considered_signed_dispositions=tuple(considered),
                    signed_case=signed_case,
                    policy_archive=policy_archive,
                    verified_at_ns=accepted_at_ns,
                )
        except (ReviewSignatureError, ReviewContractError) as exc:
            raise EventStoreError(
                "REVIEW_EVIDENCE_REVOKED"
                if "REVOKED" in str(exc)
                else "REVIEW_SIGNATURE_INVALID",
                "new review record verification failed before clip access",
            ) from exc
        return False

    def _verify_case_current_use_locked(
        self,
        *,
        signed_case: SignedScorerCopilotCase,
        policy_archive: AuthorizationPolicyArchive,
        verified_at_ns: int,
        adoptions: tuple[_ArchiveAdoption, ...],
    ) -> None:
        """Apply latest revocation truth before a new presentation/action/link."""

        case = signed_case.case
        try:
            verify_signed_scorer_copilot_case(
                signed_case,
                case=case,
                policy_archive=policy_archive,
                verified_at_ns=verified_at_ns,
            )
            if case.signed_assessment is not None:
                assessment_adoption = self._adoption_at(
                    adoptions,
                    case.signed_assessment.signed_at_ns,
                    label="case assessment signature",
                )
                selected_policy = policy_archive.resolve_policy(
                    assessment_adoption.current_policy_fingerprint
                )
                verify_case_policy_assessment(
                    case,
                    signing_policy=selected_policy,
                    policy_archive=policy_archive,
                    verified_at_ns=verified_at_ns,
                )
            accepted_dispositions: dict[str, SignedReviewDisposition] = {}
            rows = self._connection.execute(
                """
                SELECT record_type, signed_record_bytes FROM copilot_journal
                WHERE case_fingerprint = ? ORDER BY case_sequence
                """,
                (signed_case.case_fingerprint,),
            )
            for row in rows:
                raw = row["signed_record_bytes"]
                if type(raw) is not bytes:
                    _fail("REVIEW_RECORD_ENCODING", "review record is not a BLOB")
                if row["record_type"] == "DISPOSITION":
                    disposition = parse_signed_review_disposition(raw)
                    verify_signed_review_disposition(
                        disposition,
                        signed_case=signed_case,
                        policy_archive=policy_archive,
                        verified_at_ns=verified_at_ns,
                    )
                    accepted_dispositions[disposition.fingerprint()] = disposition
                elif row["record_type"] == "ADJUDICATION":
                    adjudication = parse_signed_review_adjudication(raw)
                    considered = tuple(
                        accepted_dispositions[fingerprint]
                        for fingerprint in adjudication.adjudication.considered_signed_disposition_fingerprints
                    )
                    verify_signed_review_adjudication(
                        adjudication,
                        considered_signed_dispositions=considered,
                        signed_case=signed_case,
                        policy_archive=policy_archive,
                        verified_at_ns=verified_at_ns,
                    )
                else:
                    _fail("REVIEW_RECORD_TYPE", "review record type is invalid")
        except KeyError as exc:
            raise EventStoreError(
                "ADJUDICATION_MEMBERSHIP",
                "adjudication names unavailable disposition",
            ) from exc
        except (AuthorizationError, CaseAttestationError, ReviewSignatureError) as exc:
            code = (
                "REVIEW_EVIDENCE_REVOKED"
                if "REVOKED" in str(exc)
                else "REVIEW_EVIDENCE_INVALID"
            )
            raise EventStoreError(code, "current review evidence verification failed") from exc

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

    def _adoption_at(
        self,
        adoptions: tuple[_ArchiveAdoption, ...],
        timestamp_ns: int,
        *,
        label: str,
    ) -> _ArchiveAdoption:
        current = tuple(
            adoption
            for adoption in adoptions
            if adoption.adopted_at_ns <= timestamp_ns
        )
        if not current:
            _fail(
                "POLICY_BEFORE_ADOPTION",
                f"{label} predates the first trusted archive adoption",
            )
        return current[-1]

    def _signing_policy_adoption(
        self,
        adoptions: tuple[_ArchiveAdoption, ...],
        *,
        policy_fingerprint: str,
        signed_at_ns: int,
        label: str,
    ) -> _ArchiveAdoption:
        adoption = self._adoption_at(adoptions, signed_at_ns, label=label)
        if adoption.current_policy_fingerprint != policy_fingerprint:
            _fail(
                "POLICY_NOT_CURRENT_AT_TIME",
                f"{label} policy was retained but not ledger-current when signed",
            )
        return adoption

    def _context_for_signed_case(
        self,
        signed_case: SignedScorerCopilotCase,
        *,
        case_sequence: int,
        journal_head_fingerprint: str,
    ) -> ReviewAuthorizationContext:
        case = signed_case.case
        context = ReviewAuthorizationContext(
            case_fingerprint=signed_case.case_fingerprint,
            signed_case_fingerprint=signed_case.fingerprint(),
            match_id=case.match_id,
            rally_id=case.rally_id,
            set_number=case.set_number,
            state_revision=case.state_revision,
            ruleset_fingerprint=case.ruleset_fingerprint,
            case_sequence=case_sequence,
            journal_head_fingerprint=journal_head_fingerprint,
            evidence_refs=case.assessment.evidence_refs,
        )
        context.validate_signed_case(signed_case)
        return context

    def _copilot_event_outcome(self, event: RuleEvent) -> RallyOutcome:
        if (
            event.event_type is RuleEventType.POINT_AWARDED
            and type(event.payload) is PointAwardedPayload
        ):
            return (
                RallyOutcome.POINT_TEAM_A
                if event.payload.winner_team is Team.A
                else RallyOutcome.POINT_TEAM_B
            )
        if (
            event.event_type is RuleEventType.REPLAY_NO_POINT
            and type(event.payload) is ReplayNoPointPayload
        ):
            return RallyOutcome.REPLAY_NO_POINT
        _fail(
            "COPILOT_EVENT_TYPE",
            "case-linked authorization accepts only point or replay outcomes",
        )

    def _validate_copilot_event_semantics(
        self,
        *,
        envelope: AuthorizedRuleEvent,
        context: ReviewAuthorizationContext,
        assessment_fingerprint: str,
        signed_assessment_fingerprint: str | None,
        pre_state: MatchState,
        case_sequence: int,
        head_kind: ReviewDispositionKind | None,
        head_outcome: RallyOutcome | None,
        latest_accepted_at_ns: int,
        verified_at_ns: int,
    ) -> None:
        """Validate the fail-closed mapping from one review head to one event."""

        event = envelope.event
        command = envelope.authorization_record.signed_command.command
        outcome = self._copilot_event_outcome(event)
        if (
            context.match_id != event.match_id
            or context.rally_id != event.related_rally_id
            or context.set_number != event.set_number
            or context.ruleset_fingerprint != event.ruleset_fingerprint
            or context.state_revision != command.expected_revision
            or context.state_revision != pre_state.revision
            or event.sequence_number != context.state_revision + 1
        ):
            _fail(
                "COPILOT_EVENT_CONTEXT",
                "event does not exactly advance the case match/rally/set/revision",
            )
        payload = event.payload
        if type(payload) not in {PointAwardedPayload, ReplayNoPointPayload}:
            _fail("COPILOT_EVENT_TYPE", "case-linked event payload is unsupported")
        if payload.evidence_refs != context.evidence_refs:
            _fail(
                "COPILOT_EVENT_EVIDENCE",
                "event evidence must exactly equal the signed case evidence set",
            )
        if (
            pre_state.match_complete
            or pre_state.rally_resolution(context.rally_id) is not None
        ):
            _fail("COPILOT_RALLY_RESOLVED", "case rally is no longer unresolved")
        current_set = pre_state.current_set
        if current_set is None or current_set.number != context.set_number:
            _fail("COPILOT_SET_CONTEXT", "case set is not the current active set")
        if current_set.phase is not SetPhase.IN_PROGRESS:
            _fail(
                "COPILOT_SET_NOT_IN_PROGRESS",
                "case-linked events require an in-progress current set",
            )
        causal_floor = latest_accepted_at_ns
        record = envelope.authorization_record
        if (
            event.created_at_ns < causal_floor
            or command.issued_at_ns < causal_floor
            or record.authorized_at_ns < causal_floor
            or verified_at_ns < causal_floor
        ):
            _fail(
                "COPILOT_EVENT_TIME",
                "event authorization predates the accepted case/review head",
            )
        if case_sequence == 0:
            if command.origin is AuthorizationOrigin.ASSESSMENT_ASSISTED:
                if (
                    signed_assessment_fingerprint is None
                    or command.assessment is None
                    or command.assessment.fingerprint() != assessment_fingerprint
                    or command.signed_assessment is None
                    or command.signed_assessment.fingerprint()
                    != signed_assessment_fingerprint
                ):
                    _fail(
                        "COPILOT_ASSESSMENT_MISMATCH",
                        "assisted command must use the exact signed case assessment",
                    )
            elif command.origin is not AuthorizationOrigin.HUMAN_DIRECT:
                _fail("COPILOT_ORIGIN", "unsupported case-linked command origin")
            # A human may override the model at the untouched sequence-zero
            # head, but only to one of the three concrete rally outcomes above.
            return
        if command.origin is not AuthorizationOrigin.HUMAN_DIRECT:
            _fail(
                "COPILOT_POST_REVIEW_ORIGIN",
                "post-review authorization must be human-direct",
            )
        if (
            head_kind is not ReviewDispositionKind.OBSERVED_OUTCOME
            or head_outcome is None
        ):
            _fail(
                "COPILOT_REVIEW_NO_OUTCOME",
                "non-outcome review heads cannot authorize a score event",
            )
        if outcome is not head_outcome:
            _fail(
                "COPILOT_REVIEW_OUTCOME_MISMATCH",
                "event outcome differs from the current human review head",
            )

    def _validate_copilot_proposal_locked(
        self,
        *,
        envelope: AuthorizedRuleEvent,
        envelope_bytes: bytes,
        context: ReviewAuthorizationContext,
        policy_archive: AuthorizationPolicyArchive,
        verified_at_ns: int,
        preloaded_case: SignedScorerCopilotCase,
    ) -> tuple[
        sqlite3.Row,
        _ReplayResult,
        sqlite3.Row,
        SignedScorerCopilotCase,
        _ReviewCaseState,
        tuple[bool, str, str, sqlite3.Row] | None,
    ]:
        """Replay and validate a copilot proposal; safe to repeat before commit."""

        event = envelope.event
        command = envelope.authorization_record.signed_command.command
        request_fingerprint = self._event_request_fingerprint(
            envelope,
            request_kind="COPILOT_EVENT",
        )
        match_row = self._load_match_locked(event.match_id)
        self._check_match_pins(match_row, policy_archive=policy_archive)
        self._check_time_locked(
            match_row,
            at_ns=verified_at_ns,
            event=event,
            authorized_at_ns=envelope.authorization_record.authorized_at_ns,
        )
        relation = self._idempotency_relation_locked(
            command.idempotency_key,
            command.fingerprint(),
            envelope.fingerprint(),
            event.event_id,
            request_kind="COPILOT_EVENT",
            request_fingerprint=request_fingerprint,
        )
        if relation is not None and not relation[0]:
            _fail(relation[1], relation[2])
        if match_row["integrity_blocked"]:
            _fail("INTEGRITY_BLOCKED", "blocked ledger cannot append linked events")
        replay = self._replay_or_permanently_block_locked(
            match_id=event.match_id,
            policy_archive=policy_archive,
            verified_at_ns=verified_at_ns,
        )
        if replay.review is None:
            raise AssertionError("copilot append requires review replay")
        verify_authorized_rule_event(
            envelope,
            policy_archive=policy_archive,
            verified_at_ns=verified_at_ns,
        )
        self._validate_envelope_policy_timeline(envelope, replay.adoptions)
        self._check_event_scope(event, match_row)
        case_row, signed_case = self._load_signed_case_locked(
            context.signed_case_fingerprint
        )
        if signed_case != preloaded_case:
            _fail("COPILOT_CASE_TAMPER", "case changed before linked append")
        try:
            context.validate_signed_case(signed_case)
        except ValueError as exc:
            raise EventStoreError(
                "COPILOT_CONTEXT_INVALID",
                "context does not bind the exact persisted signed case",
            ) from exc
        case_state = replay.review.case_state(signed_case.case_fingerprint)
        derived_context = self._context_for_signed_case(
            signed_case,
            case_sequence=case_state.case_sequence,
            journal_head_fingerprint=case_state.head_fingerprint,
        )
        if context != derived_context:
            _fail("STALE_REVIEW_CONTEXT", "context is not the current exact review head")
        if command.idempotency_key != copilot_idempotency_key(context):
            _fail(
                "COPILOT_IDEMPOTENCY",
                "linked command must use the context-derived request identity",
            )
        if relation is not None:
            replay_link = replay.review.link_for_event(event.event_id)
            if (
                replay_link is None
                or replay_link.context != context
                or replay_link.case_fingerprint != signed_case.case_fingerprint
                or case_state.linked_event_id != event.event_id
            ):
                _fail(
                    "COPILOT_RETRY_LINK_MISMATCH",
                    "exact event retry does not resolve to its atomic case link",
                )
            return (
                match_row,
                replay,
                case_row,
                signed_case,
                case_state,
                relation,
            )
        if case_state.linked_event_id is not None:
            _fail("CASE_ALREADY_LINKED", "case is already linked to another event")
        if replay.review.preflight.link_count >= MAX_COPILOT_CASES_PER_MATCH:
            _fail("COPILOT_LINK_LIMIT", "match link count limit reached")
        if replay.review.preflight.history_count >= MAX_COPILOT_HISTORY_RECORDS_PER_MATCH:
            _fail("REVIEW_HISTORY_LIMIT", "review history count limit reached")
        self._verify_case_current_use_locked(
            signed_case=signed_case,
            policy_archive=policy_archive,
            verified_at_ns=verified_at_ns,
            adoptions=replay.adoptions,
        )
        self._validate_copilot_event_semantics(
            envelope=envelope,
            context=context,
            assessment_fingerprint=signed_case.case.assessment.fingerprint(),
            signed_assessment_fingerprint=(
                signed_case.case.signed_assessment.fingerprint()
                if signed_case.case.signed_assessment is not None
                else None
            ),
            pre_state=replay.state,
            case_sequence=case_state.case_sequence,
            head_kind=case_state.head_kind,
            head_outcome=case_state.head_outcome,
            latest_accepted_at_ns=case_state.latest_accepted_at_ns,
            verified_at_ns=verified_at_ns,
        )
        return (
            match_row,
            replay,
            case_row,
            signed_case,
            case_state,
            None,
        )

    def _review_request_fingerprint(
        self,
        *,
        record_type: str,
        signed_record_fingerprint: str,
    ) -> str:
        if record_type not in {"DISPOSITION", "ADJUDICATION"}:
            raise ValueError("unsupported review record type")
        return _digest(
            {
                "record_type": record_type,
                "signed_record_fingerprint": signed_record_fingerprint,
            }
        )

    def _case_admission_idempotency_key(
        self,
        signed_case_fingerprint: str,
    ) -> str:
        _sha256(signed_case_fingerprint, "signed_case_fingerprint")
        key = f"case-admission-v1:{signed_case_fingerprint}"
        return _stable_id(key, "case admission idempotency key")

    def _case_admission_request_fingerprint(
        self,
        signed_case_fingerprint: str,
    ) -> str:
        return _digest(
            {
                "request_kind": "CASE_ADMISSION",
                "signed_case_fingerprint": signed_case_fingerprint,
            }
        )

    def _case_admission_result_fingerprint(
        self,
        *,
        signed_case_fingerprint: str,
        context_fingerprint: str,
        review_position: int,
        review_history_head_sha256: str,
    ) -> str:
        return _digest(
            {
                "context_fingerprint": context_fingerprint,
                "review_history_head_sha256": review_history_head_sha256,
                "review_position": review_position,
                "signed_case_fingerprint": signed_case_fingerprint,
            }
        )

    def _review_result_identity_fingerprint(
        self,
        *,
        signed_record_fingerprint: str,
        case_sequence: int,
        context_fingerprint: str,
        review_position: int,
        review_history_head_sha256: str,
    ) -> str:
        return _digest(
            {
                "case_sequence": case_sequence,
                "context_fingerprint": context_fingerprint,
                "review_history_head_sha256": review_history_head_sha256,
                "review_position": review_position,
                "signed_record_fingerprint": signed_record_fingerprint,
            }
        )

    def _idempotency_relation_locked(
        self,
        idempotency_key: str,
        command_fingerprint: str,
        envelope_fingerprint: str,
        event_id: str,
        *,
        request_kind: str,
        request_fingerprint: str,
    ) -> tuple[bool, str, str, sqlite3.Row] | None:
        identity_rows = self._connection.execute(
            """
            SELECT * FROM request_identities
            WHERE idempotency_key = ? OR request_fingerprint = ?
            """,
            (idempotency_key, request_fingerprint),
        ).fetchmany(3)
        rows = self._connection.execute(
            """
            SELECT * FROM idempotency_log
            WHERE idempotency_key = ? OR command_fingerprint = ?
               OR envelope_fingerprint = ? OR event_id = ?
            """,
            (idempotency_key, command_fingerprint, envelope_fingerprint, event_id),
        ).fetchmany(5)
        if not identity_rows and not rows:
            return None
        exact_identity = [
            row
            for row in identity_rows
            if row["idempotency_key"] == idempotency_key
            and row["request_kind"] == request_kind
            and row["request_fingerprint"] == request_fingerprint
            and row["accepted_identity_fingerprint"] == envelope_fingerprint
        ]
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
        if (
            len(exact_identity) == 1
            and len(identity_rows) == 1
            and len(exact) == 1
            and len(rows) == 1
        ):
            return (True, "", "", exact[0])
        if identity_rows:
            if any(row["idempotency_key"] == idempotency_key for row in identity_rows):
                return (
                    False,
                    "IDEMPOTENCY_CONFLICT",
                    "idempotency key is already bound to another request kind/content",
                    identity_rows[0],
                )
            return (
                False,
                "IDEMPOTENCY_KEY_CONFLICT",
                "exact request was submitted under a different idempotency key",
                identity_rows[0],
            )
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

    def _validate_request_identity_locked(
        self,
        *,
        idempotency_key: str,
        match_id: str,
        request_kind: str,
        request_fingerprint: str,
        accepted_identity_fingerprint: str,
        result_identity_fingerprint: str,
        created_at_ns: int,
    ) -> sqlite3.Row:
        rows = self._connection.execute(
            "SELECT * FROM request_identities WHERE idempotency_key = ?",
            (idempotency_key,),
        ).fetchmany(2)
        if len(rows) != 1:
            _fail("REQUEST_IDENTITY_TAMPER", "request identity does not resolve once")
        expected = (
            idempotency_key,
            match_id,
            request_kind,
            request_fingerprint,
            accepted_identity_fingerprint,
            result_identity_fingerprint,
            created_at_ns,
        )
        actual = tuple(
            rows[0][field]
            for field in (
                "idempotency_key",
                "match_id",
                "request_kind",
                "request_fingerprint",
                "accepted_identity_fingerprint",
                "result_identity_fingerprint",
                "created_at_ns",
            )
        )
        if actual != expected:
            _fail("REQUEST_IDENTITY_TAMPER", "request identity differs from source")
        return rows[0]

    def _event_request_fingerprint(
        self,
        envelope: AuthorizedRuleEvent,
        *,
        request_kind: str,
    ) -> str:
        if request_kind not in {"HUMAN_EVENT", "COPILOT_EVENT"}:
            raise ValueError("invalid event request kind")
        command = envelope.authorization_record.signed_command.command
        return _digest(
            {
                "command_fingerprint": command.fingerprint(),
                "envelope_fingerprint": envelope.fingerprint(),
                "event_fingerprint": envelope.event.fingerprint(),
                "request_kind": request_kind,
            }
        )

    def _event_result_identity_fingerprint(
        self,
        *,
        envelope_fingerprint: str,
        state_fingerprint: str,
        outbox_id: int,
        outbox_payload_fingerprint: str,
    ) -> str:
        return _digest(
            {
                "envelope_fingerprint": envelope_fingerprint,
                "outbox_id": outbox_id,
                "outbox_payload_fingerprint": outbox_payload_fingerprint,
                "state_fingerprint": state_fingerprint,
            }
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
        review_position: int,
        review_history_head_sha256: str,
        case_authorization_link_fingerprint: str | None,
        review_context_fingerprint: str | None,
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
                envelope_bytes, created_at_ns, appended_at_ns, related_rally_id,
                review_position_at_append, review_history_head_at_append
            ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
                review_position,
                review_history_head_sha256,
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
                , review_position_at_append, review_history_head_at_append,
                case_authorization_link_fingerprint, review_context_fingerprint
            ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
                review_position,
                review_history_head_sha256,
                case_authorization_link_fingerprint,
                review_context_fingerprint,
            ),
        )

    def _outbox_payload(
        self,
        *,
        envelope: AuthorizedRuleEvent,
        state: MatchState,
        state_fingerprint: str,
        archive_fingerprint: str,
        message_id: str,
        outbox_id: int,
        appended_at_ns: int,
        review_position: int,
        review_history_head_sha256: str,
        case_authorization_link_fingerprint: str | None = None,
        review_context_fingerprint: str | None = None,
        case_fingerprint: str | None = None,
        signed_case_fingerprint: str | None = None,
    ) -> bytes:
        event = envelope.event
        if type(state) is not MatchState:
            raise ValueError("state must be an exact MatchState")
        current_set = state.current_set
        last_completed = state.completed_sets[-1] if state.completed_sets else None
        if type(event.payload) is PointAwardedPayload:
            outcome = f"POINT_TEAM_{event.payload.winner_team.value}"
            replay_reason: str | None = None
            evidence_refs = event.payload.evidence_refs
            domain_fields: dict[str, object] = {
                "winner_team": event.payload.winner_team.value,
            }
        elif type(event.payload) is ReplayNoPointPayload:
            outcome = "REPLAY_NO_POINT"
            replay_reason = event.payload.reason
            evidence_refs = event.payload.evidence_refs
            domain_fields = {"reason": event.payload.reason}
        elif type(event.payload) is SideSwitchConfirmedPayload:
            outcome = None
            replay_reason = None
            evidence_refs = event.payload.evidence_refs
            domain_fields = {
                "cleared_through_total": event.payload.cleared_through_total,
                "due_total": event.payload.due_total,
                "observed_at_total": event.payload.observed_at_total,
                "observed_side_a": event.payload.observed_side_a.value,
                "observed_side_b": event.payload.observed_side_b.value,
            }
        elif type(event.payload) is TechnicalTimeoutCompletedPayload:
            outcome = None
            replay_reason = None
            evidence_refs = event.payload.evidence_refs
            domain_fields = {
                "due_total": event.payload.due_total,
                "observed_at_total": event.payload.observed_at_total,
            }
        elif type(event.payload) is SetSeedPayload:
            outcome = None
            replay_reason = None
            evidence_refs = ()
            domain_fields = {
                "service_order_a": list(event.payload.service_order_a),
                "service_order_b": list(event.payload.service_order_b),
                "serving_player": event.payload.serving_player,
                "serving_team": event.payload.serving_team.value,
                "side_a": event.payload.side_a.value,
                "side_b": event.payload.side_b.value,
            }
        else:
            raise AssertionError("unsupported RuleEvent payload")
        optional_values = (
            case_authorization_link_fingerprint,
            review_context_fingerprint,
            case_fingerprint,
            signed_case_fingerprint,
        )
        if any(value is None for value in optional_values) != all(
            value is None for value in optional_values
        ):
            raise ValueError("copilot outbox identities must be all present or all absent")
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
                "event_summary": {
                    "evidence_count": len(evidence_refs),
                    "domain_fields": domain_fields,
                    "evidence_refs_fingerprint": _evidence_set_fingerprint(
                        evidence_refs
                    ),
                    "event_type": event.event_type.value,
                    "outcome": outcome,
                    "replay_reason": replay_reason,
                },
                "match_id": event.match_id,
                "message_id": message_id,
                "official_scorecheck_mutation_permitted": False,
                "outbox_id": outbox_id,
                "post_state_summary": {
                    "current_set": (
                        {
                            "number": current_set.number,
                            "phase": current_set.phase.value,
                            "serving_player": current_set.serving_player,
                            "serving_team": current_set.serving_team.value,
                            "team_a_points": current_set.team_a_points,
                            "team_b_points": current_set.team_b_points,
                        }
                        if current_set is not None
                        else None
                    ),
                    "last_completed_set": (
                        {
                            "number": last_completed.set_number,
                            "team_a_points": last_completed.team_a_points,
                            "team_b_points": last_completed.team_b_points,
                            "winner": last_completed.winner.value,
                        }
                        if last_completed is not None
                        else None
                    ),
                    "match_winner": (
                        state.match_winner.value
                        if state.match_winner is not None
                        else None
                    ),
                    "team_a_sets": state.team_a_sets,
                    "team_b_sets": state.team_b_sets,
                },
                "reducer_build_sha256": self.reducer_build_sha256,
                "revision": event.sequence_number,
                "ruleset_fingerprint": event.ruleset_fingerprint,
                "ruleset_id": event.ruleset_id,
                "ruleset_version": event.ruleset_version,
                "review_authorization_context_fingerprint": (
                    review_context_fingerprint
                ),
                "review_history_head_sha256": review_history_head_sha256,
                "review_position": review_position,
                "scorer_copilot_case_link_fingerprint": (
                    case_authorization_link_fingerprint
                ),
                "scorer_copilot_case_fingerprint": case_fingerprint,
                "scorer_copilot_signed_case_fingerprint": (
                    signed_case_fingerprint
                ),
                "schema_version": "2.0",
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
        review_position: int,
        review_history_head_sha256: str,
        case_authorization_link_fingerprint: str | None = None,
        review_context_fingerprint: str | None = None,
        case_fingerprint: str | None = None,
        signed_case_fingerprint: str | None = None,
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
                    "review_authorization_context_fingerprint": (
                        review_context_fingerprint
                    ),
                    "review_history_head_sha256": review_history_head_sha256,
                    "review_position": review_position,
                    "scorer_copilot_case_link_fingerprint": (
                        case_authorization_link_fingerprint
                    ),
                    "scorer_copilot_case_fingerprint": case_fingerprint,
                    "scorer_copilot_signed_case_fingerprint": (
                        signed_case_fingerprint
                    ),
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
            row["review_position"],
            row["copilot_case_count"],
            row["copilot_action_count"],
            row["copilot_link_count"],
            row["review_history_head_sha256"],
            verified_at_ns,
            True,
            row["integrity_failure_code"],
        )

    def _replay_review_locked(
        self,
        *,
        match_row: sqlite3.Row,
        policy_archive: AuthorizationPolicyArchive,
        verified_at_ns: int,
        adoptions: tuple[_ArchiveAdoption, ...],
    ) -> _ReviewReplayResult:
        """Replay canonical cases, actions, links, requests, and history."""

        match_id = match_row["match_id"]
        preflight = self._review_preflight_locked(match_id)
        source_entries: dict[int, _ReviewHistoryEntry] = {}
        case_states: list[_ReviewCaseState] = []
        links: list[_ReplayLink] = []

        case_rows = self._connection.execute(
            "SELECT * FROM copilot_cases WHERE match_id = ? ORDER BY case_ordinal",
            (match_id,),
        )
        streamed_cases = 0
        previous_case_review_position = 0
        for expected_ordinal, case_row in enumerate(case_rows, start=1):
            streamed_cases = expected_ordinal
            raw = case_row["signed_case_bytes"]
            if type(raw) is not bytes:
                _fail("COPILOT_CASE_ENCODING", "persisted signed case is not a BLOB")
            try:
                signed_case = parse_signed_scorer_copilot_case(raw)
            except (CaseAttestationError, ReviewContractError, ValueError) as exc:
                raise EventStoreError("COPILOT_CASE_INVALID", "persisted case is invalid") from exc
            if encode_signed_scorer_copilot_case(signed_case) != raw:
                _fail("COPILOT_CASE_ENCODING", "persisted signed case is noncanonical")
            case = signed_case.case
            signed_case_fingerprint = signed_case.fingerprint()
            rendered_total = sum(clip.rendered_size_bytes for clip in case.clips)
            admitted_at_ns = case_row["admitted_at_ns"]
            if (
                type(admitted_at_ns) is not int
                or not case.opened_at_ns <= admitted_at_ns <= verified_at_ns
            ):
                _fail("COPILOT_CASE_TIME", "case admission time is not causal")
            producer_adoption = self._signing_policy_adoption(
                adoptions,
                policy_fingerprint=signed_case.authorization_policy_fingerprint,
                signed_at_ns=signed_case.signed_at_ns,
                label="case producer signature",
            )
            verification_adoption = self._adoption_at(
                adoptions,
                admitted_at_ns,
                label="case admission",
            )
            assessment_adoption: _ArchiveAdoption | None = None
            if case.signed_assessment is not None:
                assessment_adoption = self._adoption_at(
                    adoptions,
                    case.signed_assessment.signed_at_ns,
                    label="case assessment signature",
                )
            try:
                verify_signed_scorer_copilot_case_at_historical_acceptance(
                    signed_case,
                    case=case,
                    policy_archive=verification_adoption.archive,
                    verified_at_ns=admitted_at_ns,
                    accepted_at_ns=admitted_at_ns,
                )
                if assessment_adoption is not None:
                    signing_policy = verification_adoption.archive.resolve_policy(
                        assessment_adoption.current_policy_fingerprint
                    )
                    verify_case_policy_assessment_at_historical_acceptance(
                        case,
                        signing_policy=signing_policy,
                        policy_archive=verification_adoption.archive,
                        verified_at_ns=admitted_at_ns,
                        accepted_at_ns=admitted_at_ns,
                    )
            except (AuthorizationError, CaseAttestationError, ReviewSignatureError) as exc:
                raise EventStoreError(
                    "COPILOT_CASE_SIGNATURE_INVALID",
                    "historical case evidence verification failed",
                ) from exc
            expected_case_values = (
                signed_case.case_fingerprint,
                case.match_id,
                expected_ordinal,
                signed_case_fingerprint,
                self._case_admission_idempotency_key(signed_case_fingerprint),
                raw,
                case.rally_id,
                case.set_number,
                case.state_revision,
                case.ruleset_fingerprint,
                case.opened_at_ns,
                signed_case.signed_at_ns,
                rendered_total,
                producer_adoption.generation,
                assessment_adoption.generation if assessment_adoption else None,
                verification_adoption.generation,
                admitted_at_ns,
            )
            actual_case_values = tuple(
                case_row[field]
                for field in (
                    "case_fingerprint",
                    "match_id",
                    "case_ordinal",
                    "signed_case_fingerprint",
                    "admission_idempotency_key",
                    "signed_case_bytes",
                    "rally_id",
                    "set_number",
                    "state_revision",
                    "ruleset_fingerprint",
                    "opened_at_ns",
                    "producer_signed_at_ns",
                    "rendered_clip_total_bytes",
                    "producer_policy_generation",
                    "assessment_policy_generation",
                    "verification_archive_generation",
                    "admitted_at_ns",
                )
            )
            if actual_case_values != expected_case_values:
                _fail("COPILOT_CASE_TAMPER", "case row differs from signed source")
            if (
                case.match_id != match_id
                or case.ruleset_fingerprint != self.ruleset.fingerprint()
            ):
                _fail("COPILOT_CASE_SCOPE", "case scope differs from pinned match/ruleset")

            case_entry = _ReviewHistoryEntry(
                case_row["review_position"],
                "CASE",
                signed_case.case_fingerprint,
                signed_case_fingerprint,
                admitted_at_ns,
                case_row["review_history_head_sha256"],
                case_sequence=0,
            )
            if case_entry.position <= previous_case_review_position:
                _fail(
                    "COPILOT_CASE_ORDER",
                    "case ordinal does not follow admission history order",
                )
            previous_case_review_position = case_entry.position
            if case_entry.position in source_entries:
                _fail("REVIEW_HISTORY_POSITION", "review source positions collide")
            source_entries[case_entry.position] = case_entry
            initial_context = self._context_for_signed_case(
                signed_case,
                case_sequence=0,
                journal_head_fingerprint=signed_case_fingerprint,
            )
            admission_key = self._case_admission_idempotency_key(
                signed_case_fingerprint
            )
            self._validate_request_identity_locked(
                idempotency_key=admission_key,
                match_id=match_id,
                request_kind="CASE_ADMISSION",
                request_fingerprint=self._case_admission_request_fingerprint(
                    signed_case_fingerprint
                ),
                accepted_identity_fingerprint=signed_case_fingerprint,
                result_identity_fingerprint=self._case_admission_result_fingerprint(
                    signed_case_fingerprint=signed_case_fingerprint,
                    context_fingerprint=initial_context.fingerprint(),
                    review_position=case_entry.position,
                    review_history_head_sha256=case_entry.persisted_head_sha256,
                ),
                created_at_ns=admitted_at_ns,
            )

            case_sequence = 0
            current_head = signed_case_fingerprint
            latest_accepted_at_ns = admitted_at_ns
            head_kind: ReviewDispositionKind | None = None
            head_outcome: RallyOutcome | None = None
            accepted_dispositions: dict[str, SignedReviewDisposition] = {}
            journal_rows = self._connection.execute(
                """
                SELECT * FROM copilot_journal
                WHERE case_fingerprint = ? ORDER BY case_sequence
                """,
                (signed_case.case_fingerprint,),
            )
            for expected_sequence, journal_row in enumerate(journal_rows, start=1):
                raw_record = journal_row["signed_record_bytes"]
                if type(raw_record) is not bytes:
                    _fail("REVIEW_RECORD_ENCODING", "signed review record is not a BLOB")
                record_type = journal_row["record_type"]
                try:
                    if record_type == "DISPOSITION":
                        signed_record = parse_signed_review_disposition(raw_record)
                        unsigned_record = signed_record.disposition
                        encoded = encode_signed_review_disposition(signed_record)
                    elif record_type == "ADJUDICATION":
                        signed_record = parse_signed_review_adjudication(raw_record)
                        unsigned_record = signed_record.adjudication
                        encoded = encode_signed_review_adjudication(signed_record)
                    else:
                        _fail("REVIEW_RECORD_TYPE", "review record type is invalid")
                except (ReviewContractError, ValueError) as exc:
                    raise EventStoreError(
                        "REVIEW_RECORD_INVALID",
                        "persisted signed review record is invalid",
                    ) from exc
                if encoded != raw_record:
                    _fail("REVIEW_RECORD_ENCODING", "review record is noncanonical")
                signed_record_fingerprint = signed_record.fingerprint()
                if (
                    unsigned_record.case_fingerprint != signed_case.case_fingerprint
                    or unsigned_record.signed_case_fingerprint
                    != signed_case_fingerprint
                    or unsigned_record.expected_case_sequence != expected_sequence - 1
                    or unsigned_record.previous_record_fingerprint != current_head
                ):
                    _fail("REVIEW_JOURNAL_HEAD", "review record does not extend exact head")
                accepted_at_ns = journal_row["accepted_at_ns"]
                if (
                    signed_record.signed_at_ns < latest_accepted_at_ns
                    or type(accepted_at_ns) is not int
                    or not signed_record.signed_at_ns
                    <= accepted_at_ns
                    <= verified_at_ns
                    or accepted_at_ns < latest_accepted_at_ns
                ):
                    _fail("REVIEW_RECORD_TIME", "review record time is not causal")
                signing_adoption = self._signing_policy_adoption(
                    adoptions,
                    policy_fingerprint=signed_record.policy_fingerprint,
                    signed_at_ns=signed_record.signed_at_ns,
                    label="review record signature",
                )
                record_verification_adoption = self._adoption_at(
                    adoptions,
                    accepted_at_ns,
                    label="review record acceptance",
                )
                try:
                    if record_type == "DISPOSITION":
                        verify_signed_review_disposition_at_historical_acceptance(
                            signed_record,
                            signed_case=signed_case,
                            policy_archive=record_verification_adoption.archive,
                            verified_at_ns=accepted_at_ns,
                            accepted_at_ns=accepted_at_ns,
                        )
                        accepted_dispositions[signed_record_fingerprint] = signed_record
                    else:
                        considered: list[SignedReviewDisposition] = []
                        for fingerprint in (
                            unsigned_record.considered_signed_disposition_fingerprints
                        ):
                            disposition = accepted_dispositions.get(fingerprint)
                            if disposition is None:
                                _fail(
                                    "ADJUDICATION_MEMBERSHIP",
                                    "adjudication names a nonaccepted disposition",
                                )
                            considered.append(disposition)
                        verify_signed_review_adjudication_at_historical_acceptance(
                            signed_record,
                            considered_signed_dispositions=tuple(considered),
                            signed_case=signed_case,
                            policy_archive=record_verification_adoption.archive,
                            verified_at_ns=accepted_at_ns,
                            accepted_at_ns=accepted_at_ns,
                        )
                except ReviewSignatureError as exc:
                    raise EventStoreError(
                        "REVIEW_SIGNATURE_INVALID",
                        "historical review signature verification failed",
                    ) from exc
                expected_journal_values = (
                    signed_record_fingerprint,
                    match_id,
                    signed_case.case_fingerprint,
                    signed_case_fingerprint,
                    expected_sequence,
                    record_type,
                    unsigned_record.fingerprint(),
                    unsigned_record.previous_record_fingerprint,
                    unsigned_record.idempotency_key,
                    raw_record,
                    signed_record.policy_fingerprint,
                    signing_adoption.generation,
                    record_verification_adoption.generation,
                    signed_record.signed_at_ns,
                    accepted_at_ns,
                )
                actual_journal_values = tuple(
                    journal_row[field]
                    for field in (
                        "signed_record_fingerprint",
                        "match_id",
                        "case_fingerprint",
                        "signed_case_fingerprint",
                        "case_sequence",
                        "record_type",
                        "unsigned_record_fingerprint",
                        "previous_record_fingerprint",
                        "idempotency_key",
                        "signed_record_bytes",
                        "policy_fingerprint",
                        "signing_policy_generation",
                        "verification_archive_generation",
                        "signed_at_ns",
                        "accepted_at_ns",
                    )
                )
                if actual_journal_values != expected_journal_values:
                    _fail("REVIEW_JOURNAL_TAMPER", "journal row differs from signed source")
                entry = _ReviewHistoryEntry(
                    journal_row["review_position"],
                    record_type,
                    signed_case.case_fingerprint,
                    signed_record_fingerprint,
                    accepted_at_ns,
                    journal_row["review_history_head_sha256"],
                    case_sequence=expected_sequence,
                )
                if entry.position in source_entries:
                    _fail("REVIEW_HISTORY_POSITION", "review source positions collide")
                source_entries[entry.position] = entry
                case_sequence = expected_sequence
                current_head = signed_record_fingerprint
                latest_accepted_at_ns = accepted_at_ns
                head_kind = unsigned_record.kind
                head_outcome = unsigned_record.outcome
                context = self._context_for_signed_case(
                    signed_case,
                    case_sequence=case_sequence,
                    journal_head_fingerprint=current_head,
                )
                request_kind = (
                    "REVIEW_DISPOSITION"
                    if record_type == "DISPOSITION"
                    else "REVIEW_ADJUDICATION"
                )
                self._validate_request_identity_locked(
                    idempotency_key=unsigned_record.idempotency_key,
                    match_id=match_id,
                    request_kind=request_kind,
                    request_fingerprint=self._review_request_fingerprint(
                        record_type=record_type,
                        signed_record_fingerprint=signed_record_fingerprint,
                    ),
                    accepted_identity_fingerprint=signed_record_fingerprint,
                    result_identity_fingerprint=self._review_result_identity_fingerprint(
                        signed_record_fingerprint=signed_record_fingerprint,
                        case_sequence=case_sequence,
                        context_fingerprint=context.fingerprint(),
                        review_position=entry.position,
                        review_history_head_sha256=entry.persisted_head_sha256,
                    ),
                    created_at_ns=accepted_at_ns,
                )
            if case_sequence > MAX_REVIEW_ACTIONS:
                _fail("REVIEW_ACTION_LIMIT", "case action count exceeds its bound")

            link_rows = self._connection.execute(
                "SELECT * FROM copilot_authorization_links WHERE case_fingerprint = ?",
                (signed_case.case_fingerprint,),
            ).fetchmany(2)
            linked_event_id: str | None = None
            authorization_link_fingerprint: str | None = None
            if len(link_rows) > 1:
                _fail("COPILOT_LINK_CARDINALITY", "case has multiple links")
            if link_rows:
                link_row = link_rows[0]
                context_raw = link_row["context_bytes"]
                link_raw = link_row["link_bytes"]
                if type(context_raw) is not bytes or type(link_raw) is not bytes:
                    _fail("COPILOT_LINK_ENCODING", "link/context is not a BLOB")
                try:
                    context = parse_review_authorization_context(context_raw)
                    link = parse_case_authorization_link(link_raw)
                except (ReviewContractError, ValueError) as exc:
                    raise EventStoreError("COPILOT_LINK_INVALID", "persisted link is invalid") from exc
                derived_context = self._context_for_signed_case(
                    signed_case,
                    case_sequence=case_sequence,
                    journal_head_fingerprint=current_head,
                )
                if context != derived_context or link.context != derived_context:
                    _fail("COPILOT_CONTEXT_TAMPER", "link context is not store-derived head")
                try:
                    link.validate_signed_case(signed_case)
                except ValueError as exc:
                    raise EventStoreError("COPILOT_LINK_INVALID", "link does not bind case") from exc
                if not latest_accepted_at_ns <= link.committed_at_ns <= verified_at_ns:
                    _fail("COPILOT_LINK_TIME", "link commit predates current review head")
                event_row = self._connection.execute(
                    "SELECT * FROM event_log WHERE event_id = ?",
                    (link.event_id,),
                ).fetchone()
                outbox_row = self._connection.execute(
                    "SELECT * FROM shadow_outbox WHERE outbox_id = ?",
                    (link.outbox_id,),
                ).fetchone()
                if event_row is None or outbox_row is None:
                    _fail("COPILOT_LINK_TARGET", "link targets missing event/outbox")
                if (
                    event_row["match_id"] != match_id
                    or event_row["revision"] != link.committed_event_sequence
                    or event_row["event_fingerprint"] != link.event_fingerprint
                    or event_row["envelope_fingerprint"]
                    != link.authorized_envelope_fingerprint
                    or event_row["appended_at_ns"] != link.committed_at_ns
                    or outbox_row["event_id"] != link.event_id
                ):
                    _fail("COPILOT_LINK_TARGET", "link differs from event/outbox target")
                link_fingerprint = link.fingerprint()
                expected_link_values = (
                    signed_case.case_fingerprint,
                    match_id,
                    signed_case_fingerprint,
                    link.event_id,
                    context.fingerprint(),
                    context_raw,
                    link_fingerprint,
                    link_raw,
                    link.committed_at_ns,
                )
                actual_link_values = tuple(
                    link_row[field]
                    for field in (
                        "case_fingerprint",
                        "match_id",
                        "signed_case_fingerprint",
                        "event_id",
                        "context_fingerprint",
                        "context_bytes",
                        "link_fingerprint",
                        "link_bytes",
                        "committed_at_ns",
                    )
                )
                if actual_link_values != expected_link_values:
                    _fail("COPILOT_LINK_TAMPER", "link row differs from canonical link")
                link_entry = _ReviewHistoryEntry(
                    link_row["review_position"],
                    "AUTHORIZATION_LINK",
                    signed_case.case_fingerprint,
                    link_fingerprint,
                    link.committed_at_ns,
                    link_row["review_history_head_sha256"],
                    linked_event_revision=event_row["revision"],
                    case_sequence=case_sequence,
                )
                if link_entry.position in source_entries:
                    _fail("REVIEW_HISTORY_POSITION", "review source positions collide")
                source_entries[link_entry.position] = link_entry
                linked_event_id = link.event_id
                authorization_link_fingerprint = link_fingerprint
                links.append(
                    _ReplayLink(
                        signed_case.case_fingerprint,
                        context,
                        link,
                        link_fingerprint,
                        link_entry.position,
                        link_entry.persisted_head_sha256,
                        case_sequence,
                        head_kind,
                        head_outcome,
                        latest_accepted_at_ns,
                        case.assessment.fingerprint(),
                        (
                            case.signed_assessment.fingerprint()
                            if case.signed_assessment is not None
                            else None
                        ),
                    )
                )
            expected_projection = (
                case_sequence,
                current_head,
                linked_event_id,
                authorization_link_fingerprint,
            )
            actual_projection = tuple(
                case_row[field]
                for field in (
                    "current_case_sequence",
                    "current_head_fingerprint",
                    "linked_event_id",
                    "authorization_link_fingerprint",
                )
            )
            if actual_projection != expected_projection:
                _fail("COPILOT_CASE_PROJECTION", "case projection differs from replay")
            case_states.append(
                _ReviewCaseState(
                    signed_case.case_fingerprint,
                    signed_case_fingerprint,
                    case_entry.position,
                    case.state_revision,
                    case.set_number,
                    case.rally_id,
                    case_sequence,
                    current_head,
                    head_kind,
                    head_outcome,
                    latest_accepted_at_ns,
                    linked_event_id,
                    authorization_link_fingerprint,
                )
            )
        if streamed_cases != preflight.case_count:
            _fail("COPILOT_CASE_CARDINALITY", "streamed case count differs from preflight")

        if len(source_entries) != preflight.history_count:
            _fail("REVIEW_HISTORY_COUNTS", "review source entry count differs")
        genesis = self._review_genesis_head(
            match_binding_fingerprint=match_row["match_binding_fingerprint"]
        )
        previous_head = genesis
        previous_time = match_row["initialized_at_ns"]
        replayed_history: list[_ReviewHistoryEntry] = []
        history_rows = self._connection.execute(
            "SELECT * FROM copilot_history WHERE match_id = ? ORDER BY review_position",
            (match_id,),
        )
        for expected_position, history_row in enumerate(history_rows, start=1):
            source = source_entries.get(expected_position)
            if source is None:
                _fail("REVIEW_HISTORY_SOURCE", "history entry has no source row")
            if source.committed_at_ns < previous_time:
                _fail("REVIEW_HISTORY_TIME", "review commit times moved backward")
            expected_head = self._review_history_head(
                previous_head,
                review_position=expected_position,
                entry_kind=source.entry_kind,
                case_fingerprint=source.case_fingerprint,
                entry_fingerprint=source.entry_fingerprint,
                committed_at_ns=source.committed_at_ns,
            )
            expected_values = (
                match_id,
                expected_position,
                source.entry_kind,
                source.case_fingerprint,
                source.entry_fingerprint,
                source.committed_at_ns,
                previous_head,
                expected_head,
            )
            actual_values = tuple(
                history_row[field]
                for field in (
                    "match_id",
                    "review_position",
                    "entry_kind",
                    "case_fingerprint",
                    "entry_fingerprint",
                    "committed_at_ns",
                    "previous_history_head_sha256",
                    "review_history_head_sha256",
                )
            )
            if actual_values != expected_values or source.persisted_head_sha256 != expected_head:
                _fail("REVIEW_HISTORY_TAMPER", "review history chain differs from source")
            replayed_history.append(source)
            previous_head = expected_head
            previous_time = source.committed_at_ns
        expected_match_projection = (
            preflight.case_count,
            preflight.journal_count,
            preflight.link_count,
            preflight.history_count,
            previous_head,
        )
        actual_match_projection = (
            match_row["copilot_case_count"],
            match_row["copilot_action_count"],
            match_row["copilot_link_count"],
            match_row["review_position"],
            match_row["review_history_head_sha256"],
        )
        if actual_match_projection != expected_match_projection:
            _fail("REVIEW_MATCH_PROJECTION", "match review projection differs from replay")
        return _ReviewReplayResult(
            tuple(case_states),
            tuple(links),
            tuple(replayed_history),
            previous_head,
            preflight,
        )

    def _validate_review_score_order_locked(
        self,
        *,
        review: _ReviewReplayResult,
        event_review_positions: list[int],
        event_appended_times: list[int],
        revision_contexts: dict[int, _ScoreRevisionContext],
        rally_resolution_revisions: dict[str, int],
        event_count: int,
    ) -> None:
        """Prove each review record against its exact historical score prefix.

        Review/event timestamps may be equal and therefore cannot establish
        cross-ledger order.  An event cryptographically binds the review prefix
        visible at append, so the score revision preceding review position ``p``
        is exactly the number of events whose bound review position is ``< p``.
        """

        if (
            event_count != len(event_review_positions)
            or len(event_appended_times) != event_count
            or any(
                later < earlier
                for earlier, later in zip(
                    event_review_positions,
                    event_review_positions[1:],
                )
            )
        ):
            raise AssertionError("score prefix state cardinality differs")
        cases = {item.case_fingerprint: item for item in review.cases}
        if len(cases) != len(review.cases):
            _fail("COPILOT_CASE_CARDINALITY", "case replay identities collide")
        history_by_case: dict[str, list[_ReviewHistoryEntry]] = {
            case_fingerprint: [] for case_fingerprint in cases
        }
        for entry in review.history_entries:
            case_history = history_by_case.get(entry.case_fingerprint)
            if case_history is None:
                _fail("REVIEW_HISTORY_SOURCE", "history names an unknown case")
            case_history.append(entry)
        for case_state in review.cases:
            case_history = history_by_case[case_state.case_fingerprint]
            journal = sorted(
                (
                    entry
                    for entry in case_history
                    if entry.entry_kind != "AUTHORIZATION_LINK"
                ),
                key=lambda entry: (
                    entry.case_sequence
                    if entry.case_sequence is not None
                    else MAX_REVIEW_ACTIONS + 1
                ),
            )
            if (
                len(journal) != case_state.case_sequence + 1
                or tuple(entry.case_sequence for entry in journal)
                != tuple(range(case_state.case_sequence + 1))
                or any(
                    later.position <= earlier.position
                    for earlier, later in zip(journal, journal[1:])
                )
            ):
                _fail(
                    "REVIEW_ACTION_POSITION",
                    "case journal sequence does not advance in global history order",
                )
            case_links = tuple(
                entry
                for entry in case_history
                if entry.entry_kind == "AUTHORIZATION_LINK"
            )
            if case_links and (
                len(case_links) != 1
                or case_links[0].case_sequence != case_state.case_sequence
                or case_links[0].position <= journal[-1].position
            ):
                _fail(
                    "COPILOT_LINK_ORDER",
                    "case link does not follow the complete journal sequence",
                )
        for position, appended_at_ns in zip(
            event_review_positions,
            event_appended_times,
        ):
            if position > 0:
                history_entry = review.history_entries[position - 1]
                if (
                    history_entry.position != position
                    or appended_at_ns < history_entry.committed_at_ns
                ):
                    _fail(
                        "EVENT_REVIEW_PREFIX_TIME",
                        "event predates the review prefix it binds",
                    )
        for entry in review.history_entries:
            prefix_revision = bisect_left(event_review_positions, entry.position)
            if not 0 <= prefix_revision <= event_count:
                _fail("REVIEW_SCORE_PREFIX", "review score prefix is out of range")
            if (
                prefix_revision > 0
                and entry.committed_at_ns
                < event_appended_times[prefix_revision - 1]
            ):
                _fail(
                    "REVIEW_SCORE_PREFIX_TIME",
                    "review entry predates its preceding score prefix",
                )
            case_state = cases.get(entry.case_fingerprint)
            if case_state is None:
                _fail("REVIEW_HISTORY_SOURCE", "history names an unknown case")
            if entry.entry_kind in {"CASE", "DISPOSITION", "ADJUDICATION"}:
                if entry.entry_kind == "CASE":
                    if entry.position != case_state.admission_review_position:
                        _fail(
                            "CASE_ADMISSION_POSITION",
                            "case history position differs from its admission",
                        )
                elif entry.position <= case_state.admission_review_position:
                    _fail(
                        "REVIEW_ACTION_POSITION",
                        "review action does not follow case admission",
                    )
                if case_state.state_revision != prefix_revision:
                    _fail(
                        "HISTORICAL_STALE_CASE_REVISION",
                        "case/action was not accepted at its bound score revision",
                    )
                revision_context = revision_contexts.get(prefix_revision)
                if revision_context is None:
                    _fail(
                        "REVIEW_SCORE_PREFIX",
                        "needed historical score context was not retained",
                    )
                if revision_context.current_set_number is None:
                    _fail(
                        "HISTORICAL_CASE_PRESEED",
                        "case/action predates the initial set seed",
                    )
                if revision_context.current_set_number != case_state.set_number:
                    _fail(
                        "HISTORICAL_CASE_SET_CONTEXT",
                        "case/action set differs from its historical score prefix",
                    )
                if not revision_context.current_set_in_progress:
                    _fail(
                        "HISTORICAL_CASE_SET_NOT_IN_PROGRESS",
                        "case/action was accepted outside an in-progress set",
                    )
                if revision_context.match_complete:
                    _fail(
                        "HISTORICAL_CASE_MATCH_COMPLETE",
                        "case/action was accepted after match completion",
                    )
                resolved_at_revision = rally_resolution_revisions.get(
                    case_state.rally_id
                )
                if (
                    resolved_at_revision is not None
                    and resolved_at_revision <= prefix_revision
                ):
                    _fail(
                        "HISTORICAL_CASE_RALLY_RESOLVED",
                        "case/action was accepted after rally resolution",
                    )
                continue
            if entry.entry_kind != "AUTHORIZATION_LINK":
                _fail("REVIEW_HISTORY_KIND", "unsupported review history entry")
            if entry.linked_event_revision is None:
                _fail("COPILOT_LINK_TARGET", "link lacks an event revision")
            expected_event_revision = prefix_revision + 1
            if (
                entry.linked_event_revision != expected_event_revision
                or expected_event_revision > len(event_review_positions)
                or event_review_positions[expected_event_revision - 1]
                != entry.position
            ):
                _fail(
                    "COPILOT_LINK_ORDER",
                    "link is not the first event at its exact review prefix",
                )
            if any(
                source.entry_kind != "AUTHORIZATION_LINK"
                and source.position >= entry.position
                for source in history_by_case[entry.case_fingerprint]
            ):
                _fail(
                    "COPILOT_LINK_ORDER",
                    "case link does not follow every accepted case action",
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
        review = self._replay_review_locked(
            match_row=match_row,
            policy_archive=policy_archive,
            verified_at_ns=verified_at_ns,
            adoptions=adoptions,
        )
        review_genesis = self._review_genesis_head(
            match_binding_fingerprint=match_row["match_binding_fingerprint"]
        )
        adoption_fingerprints = tuple(item.archive_fingerprint for item in adoptions)
        preflight = self._ledger_preflight_locked(match_id)
        state = self.reducer.new_match(match_id)
        needed_revisions = {case.state_revision for case in review.cases}
        needed_rally_ids = {case.rally_id for case in review.cases}
        revision_contexts: dict[int, _ScoreRevisionContext] = {}
        if state.revision in needed_revisions:
            revision_contexts[state.revision] = _ScoreRevisionContext(
                None,
                False,
                False,
            )
        rally_resolution_revisions: dict[str, int] = {}
        event_review_positions: list[int] = []
        event_appended_times: list[int] = []
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
        previous_review_position = 0
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
            event_appended_times.append(appended_at_ns)
            review_position_at_append = event_row["review_position_at_append"]
            if review_position_at_append < previous_review_position:
                _fail(
                    "EVENT_REVIEW_PREFIX_ROLLBACK",
                    "later event binds an older review-history prefix",
                )
            previous_review_position = review_position_at_append
            event_review_positions.append(review_position_at_append)
            expected_review_head = review.head_at_position(
                review_position_at_append,
                genesis_head=review_genesis,
            )
            if event_row["review_history_head_at_append"] != expected_review_head:
                _fail("EVENT_REVIEW_PREFIX", "event binds an invalid review prefix")
            replay_link = review.link_for_event(event.event_id)
            if replay_link is None:
                link_fingerprint = None
                context_fingerprint = None
                case_fingerprint = None
                signed_case_fingerprint = None
            else:
                if (
                    review_position_at_append != replay_link.review_position
                    or expected_review_head
                    != replay_link.review_history_head_sha256
                ):
                    _fail("EVENT_REVIEW_PREFIX", "copilot event omits its atomic link")
                link_fingerprint = replay_link.link_fingerprint
                context_fingerprint = replay_link.context.fingerprint()
                case_fingerprint = replay_link.context.case_fingerprint
                signed_case_fingerprint = (
                    replay_link.context.signed_case_fingerprint
                )
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
                review_position_at_append,
                expected_review_head,
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
                event_row["review_position_at_append"],
                event_row["review_history_head_at_append"],
            )
            if actual_event_values != expected_event_values:
                _fail("EVENT_LOG_TAMPER", "event log metadata differs from its envelope")
            authorization_row = self._one_row_locked(
                "authorization_log", match_id, expected_revision
            )
            record = envelope.authorization_record
            command = record.signed_command.command
            if replay_link is None:
                if (
                    command.origin is not AuthorizationOrigin.HUMAN_DIRECT
                    or command.idempotency_key.startswith(
                        ("copilot-v1:", "case-admission-v1:")
                    )
                ):
                    _fail(
                        "ASSISTED_CONTEXT_REQUIRED",
                        "unlinked persisted event uses a reserved/assisted path",
                    )
                request_kind = "HUMAN_EVENT"
            else:
                if command.idempotency_key != copilot_idempotency_key(
                    replay_link.context
                ):
                    _fail("COPILOT_IDEMPOTENCY", "linked command request ID is invalid")
                self._validate_copilot_event_semantics(
                    envelope=envelope,
                    context=replay_link.context,
                    assessment_fingerprint=replay_link.assessment_fingerprint,
                    signed_assessment_fingerprint=(
                        replay_link.signed_assessment_fingerprint
                    ),
                    pre_state=state,
                    case_sequence=replay_link.case_sequence,
                    head_kind=replay_link.head_kind,
                    head_outcome=replay_link.head_outcome,
                    latest_accepted_at_ns=replay_link.latest_accepted_at_ns,
                    verified_at_ns=appended_at_ns,
                )
                request_kind = "COPILOT_EVENT"
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
            if state.revision in needed_revisions:
                current_set = state.current_set
                revision_contexts[state.revision] = _ScoreRevisionContext(
                    current_set.number if current_set is not None else None,
                    (
                        current_set is not None
                        and current_set.phase is SetPhase.IN_PROGRESS
                    ),
                    state.match_complete,
                )
            if (
                event.related_rally_id in needed_rally_ids
                and state.rally_resolution(event.related_rally_id) is not None
            ):
                rally_resolution_revisions.setdefault(
                    event.related_rally_id,
                    state.revision,
                )
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
            if outbox_id <= outbox_position:
                _fail(
                    "OUTBOX_ID_ORDER",
                    "shadow outbox identities are not increasing with match revision",
                )
            message_id = f"shadow:{outbox_id}:{event.event_id}"
            payload = self._outbox_payload(
                envelope=envelope,
                state=state,
                state_fingerprint=state_fingerprint,
                archive_fingerprint=archive_fingerprint,
                message_id=message_id,
                outbox_id=outbox_id,
                appended_at_ns=appended_at_ns,
                review_position=review_position_at_append,
                review_history_head_sha256=expected_review_head,
                case_authorization_link_fingerprint=link_fingerprint,
                review_context_fingerprint=context_fingerprint,
                case_fingerprint=case_fingerprint,
                signed_case_fingerprint=signed_case_fingerprint,
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
                review_position_at_append,
                expected_review_head,
                link_fingerprint,
                context_fingerprint,
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
                    "review_position_at_append",
                    "review_history_head_at_append",
                    "case_authorization_link_fingerprint",
                    "review_context_fingerprint",
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
            request_fingerprint = self._event_request_fingerprint(
                envelope,
                request_kind=request_kind,
            )
            self._validate_request_identity_locked(
                idempotency_key=command.idempotency_key,
                match_id=event.match_id,
                request_kind=request_kind,
                request_fingerprint=request_fingerprint,
                accepted_identity_fingerprint=envelope_fingerprint,
                result_identity_fingerprint=self._event_result_identity_fingerprint(
                    envelope_fingerprint=envelope_fingerprint,
                    state_fingerprint=state_fingerprint,
                    outbox_id=outbox_id,
                    outbox_payload_fingerprint=payload_fingerprint,
                ),
                created_at_ns=appended_at_ns,
            )
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
                review_position=review_position_at_append,
                review_history_head_sha256=expected_review_head,
                case_authorization_link_fingerprint=link_fingerprint,
                review_context_fingerprint=context_fingerprint,
                case_fingerprint=case_fingerprint,
                signed_case_fingerprint=signed_case_fingerprint,
            )
            if state_row["ledger_head_sha256"] != head:
                _fail("STATE_HISTORY_TAMPER", "persisted prefix ledger head differs")
        self._validate_review_score_order_locked(
            review=review,
            event_review_positions=event_review_positions,
            event_appended_times=event_appended_times,
            revision_contexts=revision_contexts,
            rally_resolution_revisions=rally_resolution_revisions,
            event_count=replayed_count,
        )
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
            review,
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
                       COALESCE(length(related_rally_id), 0) +
                       length(review_history_head_at_append)
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
                       length(reducer_build_sha256) +
                       length(review_history_head_at_append) +
                       COALESCE(length(case_authorization_link_fingerprint), 0) +
                       COALESCE(length(review_context_fingerprint), 0)
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
        request_stats = self._connection.execute(
            """
            SELECT COUNT(*), COALESCE(SUM(
                length(idempotency_key) + length(match_id) + length(request_kind) +
                length(request_fingerprint) +
                length(accepted_identity_fingerprint) +
                length(result_identity_fingerprint)
            ), 0)
            FROM request_identities
            WHERE match_id = ? AND request_kind IN ('HUMAN_EVENT','COPILOT_EVENT')
            """,
            (match_id,),
        ).fetchone()
        counts = (
            event_stats[0],
            authorization_stats[0],
            state_stats[0],
            outbox_stats[0],
            idempotency_stats[0],
            request_stats[0],
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
            request_stats[1],
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
                    request_stats[1],
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

    def _review_preflight_locked(self, match_id: str) -> _ReviewPreflight:
        """Bound every review source before fetching any canonical BLOB."""

        case_stats = self._connection.execute(
            """
            SELECT COUNT(*), COALESCE(SUM(length(signed_case_bytes)), 0),
                   COALESCE(SUM(
                       length(case_fingerprint) + length(match_id) +
                       length(signed_case_fingerprint) +
                       length(admission_idempotency_key) + length(rally_id) +
                       length(ruleset_fingerprint) + length(current_head_fingerprint) +
                       COALESCE(length(linked_event_id), 0) +
                       COALESCE(length(authorization_link_fingerprint), 0) +
                       length(review_history_head_sha256)
                   ), 0)
            FROM copilot_cases WHERE match_id = ?
            """,
            (match_id,),
        ).fetchone()
        journal_stats = self._connection.execute(
            """
            SELECT COUNT(*), COALESCE(SUM(length(signed_record_bytes)), 0),
                   COALESCE(SUM(
                       length(signed_record_fingerprint) + length(match_id) +
                       length(case_fingerprint) + length(signed_case_fingerprint) +
                       length(record_type) + length(unsigned_record_fingerprint) +
                       length(previous_record_fingerprint) + length(idempotency_key) +
                       length(policy_fingerprint) + length(review_history_head_sha256)
                   ), 0)
            FROM copilot_journal WHERE match_id = ?
            """,
            (match_id,),
        ).fetchone()
        link_stats = self._connection.execute(
            """
            SELECT COUNT(*),
                   COALESCE(SUM(length(context_bytes) + length(link_bytes)), 0),
                   COALESCE(SUM(
                       length(case_fingerprint) + length(match_id) +
                       length(signed_case_fingerprint) + length(event_id) +
                       length(context_fingerprint) + length(link_fingerprint) +
                       length(review_history_head_sha256)
                   ), 0)
            FROM copilot_authorization_links WHERE match_id = ?
            """,
            (match_id,),
        ).fetchone()
        history_stats = self._connection.execute(
            """
            SELECT COUNT(*), MIN(review_position), MAX(review_position),
                   COALESCE(SUM(
                       length(match_id) + length(entry_kind) +
                       length(case_fingerprint) + length(entry_fingerprint) +
                       length(previous_history_head_sha256) +
                       length(review_history_head_sha256)
                   ), 0)
            FROM copilot_history WHERE match_id = ?
            """,
            (match_id,),
        ).fetchone()
        request_stats = self._connection.execute(
            """
            SELECT COUNT(*), COALESCE(SUM(
                length(idempotency_key) + length(match_id) + length(request_kind) +
                length(request_fingerprint) +
                length(accepted_identity_fingerprint) +
                length(result_identity_fingerprint)
            ), 0) FROM request_identities
            WHERE match_id = ? AND request_kind IN (
                'CASE_ADMISSION','REVIEW_DISPOSITION','REVIEW_ADJUDICATION'
            )
            """,
            (match_id,),
        ).fetchone()
        request_count = request_stats[0]
        numeric = (
            *tuple(case_stats),
            *tuple(journal_stats),
            *tuple(link_stats),
            history_stats[0],
            history_stats[3],
            *tuple(request_stats),
        )
        if any(type(value) is not int or value < 0 for value in numeric):
            _fail("REVIEW_PREFLIGHT", "review aggregate is invalid")
        case_count = case_stats[0]
        journal_count = journal_stats[0]
        link_count = link_stats[0]
        history_count = history_stats[0]
        if case_count > MAX_COPILOT_CASES_PER_MATCH:
            _fail("COPILOT_CASE_LIMIT", "persisted case count exceeds its bound")
        if journal_count > MAX_COPILOT_JOURNAL_RECORDS_PER_MATCH:
            _fail("COPILOT_ACTION_LIMIT", "persisted review action count exceeds its bound")
        if link_count > case_count:
            _fail("COPILOT_LINK_CARDINALITY", "link count exceeds case count")
        if history_count != case_count + journal_count + link_count:
            _fail("REVIEW_HISTORY_COUNTS", "review source/history counts disagree")
        if request_count != case_count + journal_count:
            _fail("REQUEST_IDENTITY_COUNTS", "review request identity count disagrees")
        if (
            history_count == 0
            and (history_stats[1] is not None or history_stats[2] is not None)
        ) or (
            history_count > 0
            and (history_stats[1] != 1 or history_stats[2] != history_count)
        ):
            _fail("REVIEW_HISTORY_POSITION", "review positions are not contiguous")
        blob_bytes = case_stats[1] + journal_stats[1] + link_stats[1]
        text_bytes = (
            case_stats[2]
            + journal_stats[2]
            + link_stats[2]
            + history_stats[3]
            + request_stats[1]
        )
        if text_bytes > MAX_COPILOT_REVIEW_TEXT_BYTES_PER_MATCH:
            _fail("REVIEW_TEXT_BUDGET", "review text byte budget exceeded")
        if blob_bytes + text_bytes > MAX_COPILOT_REVIEW_BYTES_PER_MATCH:
            _fail("REVIEW_BYTE_BUDGET", "aggregate review byte budget exceeded")
        return _ReviewPreflight(
            case_count,
            journal_count,
            link_count,
            blob_bytes,
            text_bytes,
        )

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
        if replay.review is None:
            raise AssertionError("checkpoint requires replay-derived review state")
        review = replay.review
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
            review.preflight.history_count,
            review.preflight.case_count,
            review.preflight.journal_count,
            review.preflight.link_count,
            review.review_history_head_sha256,
            verified_at_ns,
            bool(row["integrity_blocked"]),
            row["integrity_failure_code"],
        )

    def _review_counts_at_position_locked(
        self,
        match_id: str,
        review_position: int,
    ) -> tuple[int, int, int]:
        stats = self._connection.execute(
            """
            SELECT
                COALESCE(SUM(CASE WHEN entry_kind = 'CASE' THEN 1 ELSE 0 END), 0),
                COALESCE(SUM(CASE WHEN entry_kind IN ('DISPOSITION','ADJUDICATION') THEN 1 ELSE 0 END), 0),
                COALESCE(SUM(CASE WHEN entry_kind = 'AUTHORIZATION_LINK' THEN 1 ELSE 0 END), 0)
            FROM copilot_history
            WHERE match_id = ? AND review_position <= ?
            """,
            (match_id, review_position),
        ).fetchone()
        values = tuple(stats)
        if any(type(value) is not int or value < 0 for value in values):
            _fail("REVIEW_HISTORY_COUNTS", "review prefix counts are invalid")
        if sum(values) != review_position:
            _fail("REVIEW_HISTORY_COUNTS", "review prefix position is not contiguous")
        return values  # type: ignore[return-value]

    def _checkpoint_for_review_prefix_locked(
        self,
        *,
        match_row: sqlite3.Row,
        revision: int,
        archive_generation: int,
        review_position: int,
        review_history_head_sha256: str,
        verified_at_ns: int,
    ) -> LedgerCheckpoint:
        if revision == 0:
            state = self.reducer.new_match(match_row["match_id"])
            state_fingerprint = match_state_fingerprint(state, ruleset=self.ruleset)
            ledger_head = self._genesis_head(
                match_binding_fingerprint=match_row["match_binding_fingerprint"],
                initial_state_fingerprint=state_fingerprint,
                initial_archive_fingerprint=self._connection.execute(
                    """
                    SELECT adopted_archive_fingerprint FROM archive_adoptions
                    WHERE match_id = ? AND generation = 0
                    """,
                    (match_row["match_id"],),
                ).fetchone()[0],
            )
            outbox_id = 0
        else:
            state_row = self._connection.execute(
                """
                SELECT state_fingerprint, ledger_head_sha256 FROM state_history
                WHERE match_id = ? AND revision = ?
                """,
                (match_row["match_id"], revision),
            ).fetchone()
            outbox_row = self._connection.execute(
                """
                SELECT outbox_id FROM shadow_outbox
                WHERE match_id = ? AND revision = ?
                """,
                (match_row["match_id"], revision),
            ).fetchone()
            if state_row is None or outbox_row is None:
                _fail("REVIEW_RECEIPT_PREFIX", "review receipt score prefix is missing")
            state_fingerprint = state_row["state_fingerprint"]
            ledger_head = state_row["ledger_head_sha256"]
            outbox_id = outbox_row["outbox_id"]
        adoption = self._connection.execute(
            """
            SELECT adopted_archive_fingerprint, archive_history_head_sha256
            FROM archive_adoptions WHERE match_id = ? AND generation = ?
            """,
            (match_row["match_id"], archive_generation),
        ).fetchone()
        if adoption is None:
            _fail("REVIEW_RECEIPT_PREFIX", "review receipt archive prefix is missing")
        counts = self._review_counts_at_position_locked(
            match_row["match_id"], review_position
        )
        return LedgerCheckpoint(
            match_row["match_id"],
            match_row["match_binding_fingerprint"],
            revision,
            ledger_head,
            state_fingerprint,
            adoption["adopted_archive_fingerprint"],
            archive_generation,
            adoption["archive_history_head_sha256"],
            self.reducer_build_sha256,
            outbox_id,
            review_position,
            counts[0],
            counts[1],
            counts[2],
            review_history_head_sha256,
            verified_at_ns,
            False,
            None,
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
        review_position = event_row["review_position_at_append"]
        review_counts = self._review_counts_at_position_locked(
            event_row["match_id"], review_position
        )
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
            review_position,
            review_counts[0],
            review_counts[1],
            review_counts[2],
            event_row["review_history_head_at_append"],
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
