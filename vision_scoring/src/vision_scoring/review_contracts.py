"""Immutable, non-authoritative contracts for scorer-copilot review.

These records describe what an operator was shown and any advisory review work.
They deliberately contain no :class:`RuleEvent`, score mutation, actor
authorization, or persistence behavior.  The only bridge to the authorization
boundary is a content fingerprint that can be placed in an
``AuthorizationCommand.idempotency_key`` by a later integration layer.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import json
import re
from dataclasses import dataclass
from enum import Enum
from typing import TYPE_CHECKING, Any, Callable, Mapping, TypeVar

from .authorization import (
    MAX_ID_LENGTH as MAX_AUTHORIZATION_ID_LENGTH,
    PrincipalRole,
    SignedPolicyAssessment,
)
from .domain_events import (
    MAX_EVIDENCE_REF_LENGTH,
    MAX_EVIDENCE_REFS,
    MAX_ID_LENGTH,
    MAX_SEQUENCE_NUMBER,
    MAX_SET_NUMBER,
    Team,
)
from .hypotheses import (
    EvidenceKind,
    EvidenceProvenance,
    ExceptionSignal,
    HypothesisModelProvenance,
    RallyHypothesis,
    RallyOutcome,
)
from .immutable_store import generation_id_for
from .policy import (
    PolicyAssessment,
    PolicyAssessmentStatus,
    PolicyReason,
    ScoringIntent,
    ScoringIntentKind,
)
from .reconciliation import NextServerOutcome, NextServerReconciliation

if TYPE_CHECKING:
    from .case_attestation import SignedScorerCopilotCase


REVIEW_SCHEMA_VERSION = "2.0"
# This bound is deliberately below the ledger's 768 KiB SQLite BLOB/TEXT limit.
# Keeping the contract ceiling smaller means a record accepted by a codec can be
# persisted without a second, storage-specific truncation rule.
MAX_REVIEW_RECORD_BYTES = 512 * 1024
MAX_REVIEW_JSON_DEPTH = 32
MAX_REVIEW_JSON_NODES = 20_000
MAX_REVIEW_JSON_CONTAINERS = 4_000
MAX_REVIEW_CLIPS = 8
MAX_REVIEW_CLIP_BYTES = 512 * 1024 * 1024
MAX_REVIEW_CLIP_FRAMES = 72_000
MAX_REVIEW_CLIP_DURATION_NS = 5 * 60 * 1_000_000_000
MAX_REVIEW_REASONS = 8
MAX_ADJUDICATED_DISPOSITIONS = 16
MAX_REVIEW_ACTIONS = 32

_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
_STABLE_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$")
_COPILOT_IDEMPOTENCY_PREFIX = "copilot-v1:"
_CASE_ADMISSION_IDEMPOTENCY_PREFIX = "case-admission-v1:"


class ReviewContractError(ValueError):
    """A strict parsing failure with a stable machine-readable code."""

    def __init__(self, code: str, message: str) -> None:
        self.code = code
        super().__init__(f"{code}: {message}")


def _fail(code: str, message: str) -> None:
    raise ReviewContractError(code, message)


def _require_sha256(value: object, field_name: str) -> str:
    if type(value) is not str or _SHA256_RE.fullmatch(value) is None:
        raise ValueError(f"{field_name} must be a lowercase SHA-256")
    return value


def _require_stable_id(value: object, field_name: str) -> str:
    if type(value) is not str or _STABLE_ID_RE.fullmatch(value) is None:
        raise ValueError(f"{field_name} must be an ASCII stable ID")
    return value


def _require_review_action_idempotency_key(value: object) -> str:
    key = _require_stable_id(value, "idempotency_key")
    reserved = (
        _COPILOT_IDEMPOTENCY_PREFIX,
        _CASE_ADMISSION_IDEMPOTENCY_PREFIX,
    )
    if key.startswith(reserved):
        raise ValueError(
            "idempotency_key cannot use a reserved scorer-copilot namespace"
        )
    return key


def _require_timestamp(value: object, field_name: str) -> int:
    if type(value) is not int or not 0 <= value <= MAX_SEQUENCE_NUMBER:
        raise ValueError(f"{field_name} must be a non-negative signed 64-bit integer")
    return value


def _require_positive(value: object, field_name: str, *, maximum: int) -> int:
    if type(value) is not int or not 1 <= value <= maximum:
        raise ValueError(f"{field_name} must be an integer in [1, {maximum}]")
    return value


def _require_nonnegative(value: object, field_name: str, *, maximum: int) -> int:
    if type(value) is not int or not 0 <= value <= maximum:
        raise ValueError(f"{field_name} must be an integer in [0, {maximum}]")
    return value


def _require_evidence_ref(value: object, field_name: str) -> str:
    if (
        type(value) is not str
        or not value
        or len(value) > MAX_EVIDENCE_REF_LENGTH
        or re.fullmatch(r"[\x21-\x7e]+", value) is None
    ):
        raise ValueError(
            f"{field_name} must be printable non-whitespace ASCII of at most "
            f"{MAX_EVIDENCE_REF_LENGTH} characters"
        )
    return value


def _canonical_evidence_refs(
    value: object,
    field_name: str,
    *,
    allow_empty: bool,
) -> tuple[str, ...]:
    if type(value) is not tuple:
        raise ValueError(f"{field_name} must be an immutable tuple")
    lower = 0 if allow_empty else 1
    if not lower <= len(value) <= MAX_EVIDENCE_REFS:
        raise ValueError(
            f"{field_name} must contain {lower}..{MAX_EVIDENCE_REFS} entries"
        )
    refs = tuple(
        _require_evidence_ref(item, f"{field_name}[{index}]")
        for index, item in enumerate(value)
    )
    if len(set(refs)) != len(refs):
        raise ValueError(f"{field_name} cannot contain duplicates")
    return tuple(sorted(refs))


def _canonical_base64(value: object, field_name: str) -> str:
    if type(value) is not str or not value:
        raise ValueError(f"{field_name} must be canonical base64")
    try:
        raw = base64.b64decode(value.encode("ascii"), validate=True)
    except (UnicodeEncodeError, binascii.Error, ValueError) as exc:
        raise ValueError(f"{field_name} must be canonical base64") from exc
    if len(raw) != 64 or base64.b64encode(raw).decode("ascii") != value:
        raise ValueError(f"{field_name} must encode exactly 64 bytes")
    return value


def _canonical_json_bytes(
    value: Mapping[str, Any],
    *,
    label: str,
    maximum: int = MAX_REVIEW_RECORD_BYTES,
) -> bytes:
    try:
        encoded = json.dumps(
            value,
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=True,
            allow_nan=False,
        ).encode("ascii")
    except (TypeError, ValueError, UnicodeEncodeError) as exc:
        raise ValueError(f"{label} must be finite canonical ASCII JSON") from exc
    if len(encoded) > maximum:
        raise ValueError(f"{label} exceeds {maximum} bytes")
    return encoded


def _fingerprint(value: Mapping[str, Any], *, label: str) -> str:
    return hashlib.sha256(_canonical_json_bytes(value, label=label)).hexdigest()


class ReviewClipRole(str, Enum):
    PRIMARY = "PRIMARY"
    NEXT_SERVER_RECONCILIATION = "NEXT_SERVER_RECONCILIATION"
    CONTEXT_ONLY = "CONTEXT_ONLY"


@dataclass(frozen=True, slots=True)
class ReviewClipManifest:
    """Exact mapping for one immutable, display-only rendered clip."""

    source_sha256: str
    selected_video_stream_index: int
    start_frame_index: int
    end_frame_index: int
    frame_count: int
    start_timestamp_ns: int
    end_timestamp_ns: int
    decoder_contract_sha256: str
    render_profile_sha256: str
    rendered_clip_sha256: str
    role: ReviewClipRole
    evidence_refs: tuple[str, ...]
    schema_version: str = REVIEW_SCHEMA_VERSION

    def __post_init__(self) -> None:
        if self.schema_version != REVIEW_SCHEMA_VERSION:
            raise ValueError("unsupported review-clip schema")
        _require_sha256(self.source_sha256, "source_sha256")
        _require_nonnegative(
            self.selected_video_stream_index,
            "selected_video_stream_index",
            maximum=MAX_SEQUENCE_NUMBER,
        )
        start_frame = _require_nonnegative(
            self.start_frame_index,
            "start_frame_index",
            maximum=MAX_SEQUENCE_NUMBER,
        )
        end_frame = _require_nonnegative(
            self.end_frame_index,
            "end_frame_index",
            maximum=MAX_SEQUENCE_NUMBER,
        )
        if end_frame < start_frame:
            raise ValueError("end_frame_index cannot precede start_frame_index")
        frame_count = _require_positive(
            self.frame_count,
            "frame_count",
            maximum=MAX_REVIEW_CLIP_FRAMES,
        )
        if frame_count != end_frame - start_frame + 1:
            raise ValueError("frame_count must exactly cover the declared frame interval")
        start_timestamp = _require_timestamp(
            self.start_timestamp_ns, "start_timestamp_ns"
        )
        end_timestamp = _require_timestamp(
            self.end_timestamp_ns, "end_timestamp_ns"
        )
        if end_timestamp < start_timestamp:
            raise ValueError("end_timestamp_ns cannot precede start_timestamp_ns")
        if end_timestamp - start_timestamp > MAX_REVIEW_CLIP_DURATION_NS:
            raise ValueError("review clip exceeds the fixed duration bound")
        _require_sha256(self.decoder_contract_sha256, "decoder_contract_sha256")
        _require_sha256(self.render_profile_sha256, "render_profile_sha256")
        _require_sha256(self.rendered_clip_sha256, "rendered_clip_sha256")
        if type(self.role) is not ReviewClipRole:
            raise ValueError("role must be a ReviewClipRole")
        refs = _canonical_evidence_refs(
            self.evidence_refs,
            "evidence_refs",
            allow_empty=self.role is ReviewClipRole.CONTEXT_ONLY,
        )
        if self.role is ReviewClipRole.CONTEXT_ONLY and refs:
            raise ValueError("CONTEXT_ONLY clips cannot claim inference evidence")
        object.__setattr__(self, "evidence_refs", refs)

    def canonical_dict(self) -> dict[str, object]:
        return {
            "decoder_contract_sha256": self.decoder_contract_sha256,
            "end_frame_index": self.end_frame_index,
            "end_timestamp_ns": self.end_timestamp_ns,
            "evidence_refs": list(self.evidence_refs),
            "frame_count": self.frame_count,
            "render_profile_sha256": self.render_profile_sha256,
            "rendered_clip_sha256": self.rendered_clip_sha256,
            "role": self.role.value,
            "schema_version": self.schema_version,
            "selected_video_stream_index": self.selected_video_stream_index,
            "source_sha256": self.source_sha256,
            "start_frame_index": self.start_frame_index,
            "start_timestamp_ns": self.start_timestamp_ns,
        }

    def fingerprint(self) -> str:
        return _fingerprint(self.canonical_dict(), label="review clip manifest")


@dataclass(frozen=True, slots=True)
class ReviewClipRef:
    """Content-addressed reference to a manifest and its rendered clip."""

    manifest: ReviewClipManifest
    manifest_sha256: str
    immutable_generation_id: str
    generation_object_sha256s: tuple[str, ...]
    rendered_size_bytes: int
    schema_version: str = REVIEW_SCHEMA_VERSION

    def __post_init__(self) -> None:
        if self.schema_version != REVIEW_SCHEMA_VERSION:
            raise ValueError("unsupported review-clip reference schema")
        if type(self.manifest) is not ReviewClipManifest:
            raise ValueError("manifest must be an exact ReviewClipManifest")
        _require_sha256(self.manifest_sha256, "manifest_sha256")
        if self.manifest_sha256 != self.manifest.fingerprint():
            raise ValueError("manifest_sha256 does not bind the exact manifest")
        if self.manifest_sha256 == self.manifest.rendered_clip_sha256:
            raise ValueError("manifest and rendered clip must be distinct objects")
        if type(self.generation_object_sha256s) is not tuple:
            raise ValueError("generation_object_sha256s must be an immutable tuple")
        expected_objects = tuple(
            sorted((self.manifest_sha256, self.manifest.rendered_clip_sha256))
        )
        if self.generation_object_sha256s != expected_objects:
            raise ValueError(
                "generation_object_sha256s must contain exactly the manifest and clip"
            )
        _require_sha256(self.immutable_generation_id, "immutable_generation_id")
        if self.immutable_generation_id != generation_id_for(expected_objects):
            raise ValueError(
                "immutable_generation_id does not bind the exact clip objects"
            )
        _require_positive(
            self.rendered_size_bytes,
            "rendered_size_bytes",
            maximum=MAX_REVIEW_CLIP_BYTES,
        )

    def canonical_dict(self) -> dict[str, object]:
        return {
            "generation_object_sha256s": list(self.generation_object_sha256s),
            "immutable_generation_id": self.immutable_generation_id,
            "manifest": self.manifest.canonical_dict(),
            "manifest_sha256": self.manifest_sha256,
            "rendered_size_bytes": self.rendered_size_bytes,
            "schema_version": self.schema_version,
        }

    def fingerprint(self) -> str:
        return _fingerprint(self.canonical_dict(), label="review clip reference")


@dataclass(frozen=True, slots=True)
class ScorerCopilotCase:
    """One immutable review presentation with no event authority."""

    hypothesis: RallyHypothesis
    reconciliation: NextServerReconciliation | None
    assessment: PolicyAssessment
    signed_assessment: SignedPolicyAssessment | None
    clips: tuple[ReviewClipRef, ...]
    opened_at_ns: int
    schema_version: str = REVIEW_SCHEMA_VERSION

    def __post_init__(self) -> None:
        if self.schema_version != REVIEW_SCHEMA_VERSION:
            raise ValueError("unsupported scorer-copilot case schema")
        if type(self.hypothesis) is not RallyHypothesis:
            raise ValueError("hypothesis must be an exact RallyHypothesis")
        if self.reconciliation is not None and type(
            self.reconciliation
        ) is not NextServerReconciliation:
            raise ValueError(
                "reconciliation must be an exact NextServerReconciliation or None"
            )
        if type(self.assessment) is not PolicyAssessment:
            raise ValueError("assessment must be an exact PolicyAssessment")
        if self.signed_assessment is not None:
            if type(self.signed_assessment) is not SignedPolicyAssessment:
                raise ValueError(
                    "signed_assessment must be an exact SignedPolicyAssessment or None"
                )
            if self.signed_assessment.assessment != self.assessment:
                raise ValueError("signed_assessment must bind the exact assessment")
        if (
            type(self.clips) is not tuple
            or not 1 <= len(self.clips) <= MAX_REVIEW_CLIPS
            or any(type(clip) is not ReviewClipRef for clip in self.clips)
        ):
            raise ValueError(
                f"clips must contain 1..{MAX_REVIEW_CLIPS} exact ReviewClipRef values"
            )
        if len({clip.manifest_sha256 for clip in self.clips}) != len(self.clips):
            raise ValueError("clips cannot repeat a manifest")
        if len(
            {clip.manifest.rendered_clip_sha256 for clip in self.clips}
        ) != len(self.clips):
            raise ValueError("clips cannot repeat rendered content")
        object.__setattr__(
            self,
            "clips",
            tuple(sorted(self.clips, key=lambda clip: clip.manifest_sha256)),
        )
        opened_at = _require_timestamp(self.opened_at_ns, "opened_at_ns")
        if opened_at < self.assessment.causal_cutoff_timestamp_ns:
            raise ValueError("opened_at_ns cannot precede the assessment cutoff")
        if opened_at < max(clip.manifest.end_timestamp_ns for clip in self.clips):
            raise ValueError("opened_at_ns cannot precede any displayed clip")
        if self.signed_assessment is not None and not (
            self.assessment.causal_cutoff_timestamp_ns
            <= self.signed_assessment.signed_at_ns
            <= opened_at
        ):
            raise ValueError(
                "signed_assessment time must lie between assessment cutoff and case open"
            )
        self._validate_context()

    def _validate_context(self) -> None:
        hypothesis = self.hypothesis
        assessment = self.assessment
        if (
            assessment.hypothesis_id != hypothesis.hypothesis_id
            or assessment.hypothesis_fingerprint != hypothesis.fingerprint()
            or assessment.match_id != hypothesis.match_id
            or assessment.rally_id != hypothesis.rally_id
            or assessment.set_number != hypothesis.set_number
            or assessment.state_revision != hypothesis.state_revision
            or assessment.ruleset_fingerprint != hypothesis.ruleset_fingerprint
        ):
            raise ValueError("assessment context does not bind the exact hypothesis")

        reconciliation = self.reconciliation
        if reconciliation is None:
            if (
                assessment.reconciliation_outcome is not None
                or assessment.reconciliation_fingerprint is not None
                or assessment.causal_cutoff_timestamp_ns
                != hypothesis.causal_cutoff_timestamp_ns
            ):
                raise ValueError(
                    "assessment reconciliation context is inconsistent with the case"
                )
        else:
            if (
                reconciliation.hypothesis_id != hypothesis.hypothesis_id
                or reconciliation.hypothesis_fingerprint != hypothesis.fingerprint()
                or reconciliation.match_id != hypothesis.match_id
                or reconciliation.rally_id != hypothesis.rally_id
                or reconciliation.set_number != hypothesis.set_number
                or reconciliation.state_revision != hypothesis.state_revision
                or reconciliation.causal_cutoff_timestamp_ns
                < hypothesis.causal_cutoff_timestamp_ns
                or assessment.reconciliation_outcome is not reconciliation.outcome
                or assessment.reconciliation_fingerprint != reconciliation.fingerprint()
                or assessment.causal_cutoff_timestamp_ns
                != reconciliation.causal_cutoff_timestamp_ns
            ):
                raise ValueError(
                    "reconciliation and assessment do not bind the exact hypothesis context"
                )

        primary_evidence = {item.evidence_ref: item for item in hypothesis.evidence}
        reconciliation_evidence: dict[str, EvidenceProvenance] = {}
        if reconciliation is not None and reconciliation.evidence is not None:
            reconciliation_evidence[reconciliation.evidence.evidence_ref] = (
                reconciliation.evidence
            )
        expected_refs = tuple(sorted((*primary_evidence, *reconciliation_evidence)))
        if assessment.evidence_refs != expected_refs:
            raise ValueError(
                "assessment evidence must exactly equal hypothesis and reconciliation evidence"
            )

        covered_refs: set[str] = set()
        for clip in self.clips:
            manifest = clip.manifest
            if manifest.role is ReviewClipRole.PRIMARY:
                if manifest.end_timestamp_ns > hypothesis.causal_cutoff_timestamp_ns:
                    raise ValueError("primary clip exceeds the hypothesis causal cutoff")
                if not set(manifest.evidence_refs) <= set(primary_evidence):
                    raise ValueError("primary clip references non-primary evidence")
                evidence = primary_evidence
            elif manifest.role is ReviewClipRole.NEXT_SERVER_RECONCILIATION:
                if reconciliation is None or not reconciliation_evidence:
                    raise ValueError(
                        "next-server clip requires reconciliation evidence"
                    )
                if (
                    manifest.start_timestamp_ns
                    < hypothesis.causal_cutoff_timestamp_ns
                    or manifest.end_timestamp_ns
                    > reconciliation.causal_cutoff_timestamp_ns
                ):
                    raise ValueError(
                        "next-server clip lies outside its causal reconciliation window"
                    )
                if set(manifest.evidence_refs) != set(reconciliation_evidence):
                    raise ValueError(
                        "next-server clip must reference the exact reconciliation evidence"
                    )
                evidence = reconciliation_evidence
            else:
                if (
                    manifest.end_timestamp_ns
                    > assessment.causal_cutoff_timestamp_ns
                ):
                    raise ValueError(
                        "context-only clip exceeds the assessment causal cutoff"
                    )
                evidence = {}
            for reference in manifest.evidence_refs:
                captured_at = evidence[reference].captured_at_ns
                if not (
                    manifest.start_timestamp_ns
                    <= captured_at
                    <= manifest.end_timestamp_ns
                ):
                    raise ValueError(
                        "clip interval must contain every referenced evidence timestamp"
                    )
                covered_refs.add(reference)
        if covered_refs != set(assessment.evidence_refs):
            raise ValueError(
                "review clips must exactly cover every assessed evidence reference"
            )

    @property
    def match_id(self) -> str:
        return self.hypothesis.match_id

    @property
    def rally_id(self) -> str:
        return self.hypothesis.rally_id

    @property
    def set_number(self) -> int:
        return self.hypothesis.set_number

    @property
    def state_revision(self) -> int:
        return self.hypothesis.state_revision

    @property
    def ruleset_fingerprint(self) -> str:
        return self.hypothesis.ruleset_fingerprint

    def canonical_dict(self) -> dict[str, object]:
        return {
            "assessment": self.assessment.canonical_dict(),
            "clips": [clip.canonical_dict() for clip in self.clips],
            "hypothesis": self.hypothesis.canonical_dict(),
            "opened_at_ns": self.opened_at_ns,
            "reconciliation": (
                self.reconciliation.canonical_dict()
                if self.reconciliation is not None
                else None
            ),
            "schema_version": self.schema_version,
            "signed_assessment": (
                self.signed_assessment.canonical_dict()
                if self.signed_assessment is not None
                else None
            ),
        }

    def fingerprint(self) -> str:
        return _fingerprint(self.canonical_dict(), label="scorer-copilot case")


class ReviewDispositionKind(str, Enum):
    OBSERVED_OUTCOME = "OBSERVED_OUTCOME"
    NO_DECISION = "NO_DECISION"
    CASE_INVALID = "CASE_INVALID"
    ESCALATE = "ESCALATE"


class ReviewDispositionReason(str, Enum):
    INSUFFICIENT_EVIDENCE = "INSUFFICIENT_EVIDENCE"
    CAPTURE_UNUSABLE = "CAPTURE_UNUSABLE"
    RALLY_BOUNDARY_WRONG = "RALLY_BOUNDARY_WRONG"
    TEAM_ATTRIBUTION_CONFLICT = "TEAM_ATTRIBUTION_CONFLICT"
    NEXT_SERVER_CONFLICT = "NEXT_SERVER_CONFLICT"
    RULES_CONTEXT_CONFLICT = "RULES_CONTEXT_CONFLICT"


def _validate_review_result(
    *,
    kind: ReviewDispositionKind,
    outcome: RallyOutcome | None,
    reasons: tuple[ReviewDispositionReason, ...],
    allow_escalate: bool,
) -> tuple[ReviewDispositionReason, ...]:
    if type(kind) is not ReviewDispositionKind:
        raise ValueError("kind must be a ReviewDispositionKind")
    if outcome is not None and type(outcome) is not RallyOutcome:
        raise ValueError("outcome must be a RallyOutcome or None")
    if outcome is RallyOutcome.UNRESOLVED:
        raise ValueError("UNRESOLVED cannot be recorded as an observed outcome")
    if (
        type(reasons) is not tuple
        or len(reasons) > MAX_REVIEW_REASONS
        or any(type(reason) is not ReviewDispositionReason for reason in reasons)
        or len(set(reasons)) != len(reasons)
    ):
        raise ValueError("reasons must be a bounded unique immutable tuple")
    canonical_reasons = tuple(sorted(reasons, key=lambda reason: reason.value))
    if kind is ReviewDispositionKind.OBSERVED_OUTCOME:
        if outcome not in {
            RallyOutcome.POINT_TEAM_A,
            RallyOutcome.POINT_TEAM_B,
            RallyOutcome.REPLAY_NO_POINT,
        }:
            raise ValueError("OBSERVED_OUTCOME requires a concrete rally outcome")
        allowed = {
            ReviewDispositionReason.TEAM_ATTRIBUTION_CONFLICT,
            ReviewDispositionReason.NEXT_SERVER_CONFLICT,
        }
        if not set(canonical_reasons) <= allowed:
            raise ValueError("observed outcomes contain an incompatible reason")
    elif kind is ReviewDispositionKind.NO_DECISION:
        if (
            outcome is not None
            or ReviewDispositionReason.INSUFFICIENT_EVIDENCE
            not in canonical_reasons
        ):
            raise ValueError("NO_DECISION requires INSUFFICIENT_EVIDENCE and no outcome")
    elif kind is ReviewDispositionKind.CASE_INVALID:
        invalid_reasons = {
            ReviewDispositionReason.CAPTURE_UNUSABLE,
            ReviewDispositionReason.RALLY_BOUNDARY_WRONG,
            ReviewDispositionReason.RULES_CONTEXT_CONFLICT,
        }
        if outcome is not None or not (set(canonical_reasons) & invalid_reasons):
            raise ValueError("CASE_INVALID requires an invalid-case reason and no outcome")
    else:
        if not allow_escalate:
            raise ValueError("adjudication cannot escalate")
        if outcome is not None or not canonical_reasons:
            raise ValueError("ESCALATE requires at least one reason and no outcome")
    return canonical_reasons


def _validate_action_head(
    *,
    case_fingerprint: str,
    signed_case_fingerprint: str,
    expected_case_sequence: int,
    previous_record_fingerprint: str,
) -> None:
    _require_sha256(case_fingerprint, "case_fingerprint")
    _require_sha256(signed_case_fingerprint, "signed_case_fingerprint")
    _require_nonnegative(
        expected_case_sequence,
        "expected_case_sequence",
        maximum=MAX_REVIEW_ACTIONS - 1,
    )
    _require_sha256(previous_record_fingerprint, "previous_record_fingerprint")
    if (
        expected_case_sequence == 0
        and previous_record_fingerprint != signed_case_fingerprint
    ):
        raise ValueError(
            "sequence-zero action must name the signed case fingerprint as its previous record"
        )


def _validate_signed_case_identity(
    *,
    case_fingerprint: str,
    signed_case_fingerprint: str,
    signed_case: SignedScorerCopilotCase,
) -> ScorerCopilotCase:
    # Local import avoids a module cycle: case_attestation imports the
    # unsigned case codec from this module.
    from .case_attestation import SignedScorerCopilotCase

    if type(signed_case) is not SignedScorerCopilotCase:
        raise ValueError("signed_case must be an exact SignedScorerCopilotCase")
    if (
        case_fingerprint != signed_case.case_fingerprint
        or signed_case_fingerprint != signed_case.fingerprint()
    ):
        raise ValueError("record does not bind the exact signed case")
    return signed_case.case


@dataclass(frozen=True, slots=True)
class ReviewDisposition:
    """An advisory human review action; never an authorization command."""

    case_fingerprint: str
    signed_case_fingerprint: str
    expected_case_sequence: int
    previous_record_fingerprint: str
    idempotency_key: str
    kind: ReviewDispositionKind
    outcome: RallyOutcome | None
    reasons: tuple[ReviewDispositionReason, ...]
    schema_version: str = REVIEW_SCHEMA_VERSION

    def __post_init__(self) -> None:
        if self.schema_version != REVIEW_SCHEMA_VERSION:
            raise ValueError("unsupported review-disposition schema")
        _validate_action_head(
            case_fingerprint=self.case_fingerprint,
            signed_case_fingerprint=self.signed_case_fingerprint,
            expected_case_sequence=self.expected_case_sequence,
            previous_record_fingerprint=self.previous_record_fingerprint,
        )
        _require_review_action_idempotency_key(self.idempotency_key)
        object.__setattr__(
            self,
            "reasons",
            _validate_review_result(
                kind=self.kind,
                outcome=self.outcome,
                reasons=self.reasons,
                allow_escalate=True,
            ),
        )

    def canonical_dict(self) -> dict[str, object]:
        return {
            "case_fingerprint": self.case_fingerprint,
            "expected_case_sequence": self.expected_case_sequence,
            "idempotency_key": self.idempotency_key,
            "kind": self.kind.value,
            "outcome": self.outcome.value if self.outcome is not None else None,
            "previous_record_fingerprint": self.previous_record_fingerprint,
            "reasons": [reason.value for reason in self.reasons],
            "schema_version": self.schema_version,
            "signed_case_fingerprint": self.signed_case_fingerprint,
        }

    def validate_signed_case(self, signed_case: SignedScorerCopilotCase) -> None:
        _validate_signed_case_identity(
            case_fingerprint=self.case_fingerprint,
            signed_case_fingerprint=self.signed_case_fingerprint,
            signed_case=signed_case,
        )

    def fingerprint(self) -> str:
        return _fingerprint(self.canonical_dict(), label="review disposition")


@dataclass(frozen=True, slots=True)
class SignedReviewDisposition:
    disposition: ReviewDisposition
    disposition_fingerprint: str
    actor_id: str
    actor_key_id: str
    actor_role: PrincipalRole
    policy_fingerprint: str
    trust_domain_id: str
    signed_at_ns: int
    signature_base64: str
    schema_version: str = REVIEW_SCHEMA_VERSION

    def __post_init__(self) -> None:
        if self.schema_version != REVIEW_SCHEMA_VERSION:
            raise ValueError("unsupported signed-review schema")
        if type(self.disposition) is not ReviewDisposition:
            raise ValueError("disposition must be an exact ReviewDisposition")
        _require_sha256(self.disposition_fingerprint, "disposition_fingerprint")
        if self.disposition_fingerprint != self.disposition.fingerprint():
            raise ValueError("disposition_fingerprint does not bind the disposition")
        _require_stable_id(self.actor_id, "actor_id")
        _require_stable_id(self.actor_key_id, "actor_key_id")
        if type(self.actor_role) is not PrincipalRole:
            raise ValueError("actor_role must be a PrincipalRole")
        _require_sha256(self.policy_fingerprint, "policy_fingerprint")
        _require_stable_id(self.trust_domain_id, "trust_domain_id")
        _require_timestamp(self.signed_at_ns, "signed_at_ns")
        _canonical_base64(self.signature_base64, "signature_base64")

    @staticmethod
    def attestation_dict(
        *,
        disposition: ReviewDisposition,
        disposition_fingerprint: str,
        actor_id: str,
        actor_key_id: str,
        actor_role: PrincipalRole,
        policy_fingerprint: str,
        trust_domain_id: str,
        signed_at_ns: int,
    ) -> dict[str, object]:
        return {
            "actor_id": actor_id,
            "actor_key_id": actor_key_id,
            "actor_role": actor_role.value,
            "disposition": disposition.canonical_dict(),
            "disposition_fingerprint": disposition_fingerprint,
            "policy_fingerprint": policy_fingerprint,
            "schema_version": REVIEW_SCHEMA_VERSION,
            "signed_at_ns": signed_at_ns,
            "trust_domain_id": trust_domain_id,
        }

    def unsigned_canonical_dict(self) -> dict[str, object]:
        return self.attestation_dict(
            disposition=self.disposition,
            disposition_fingerprint=self.disposition_fingerprint,
            actor_id=self.actor_id,
            actor_key_id=self.actor_key_id,
            actor_role=self.actor_role,
            policy_fingerprint=self.policy_fingerprint,
            trust_domain_id=self.trust_domain_id,
            signed_at_ns=self.signed_at_ns,
        )

    def canonical_dict(self) -> dict[str, object]:
        value = self.unsigned_canonical_dict()
        value["signature_base64"] = self.signature_base64
        return value

    def fingerprint(self) -> str:
        return _fingerprint(self.canonical_dict(), label="signed review disposition")


@dataclass(frozen=True, slots=True)
class ReviewAdjudication:
    """A final advisory resolution of named review dispositions."""

    case_fingerprint: str
    signed_case_fingerprint: str
    expected_case_sequence: int
    previous_record_fingerprint: str
    idempotency_key: str
    considered_signed_disposition_fingerprints: tuple[str, ...]
    kind: ReviewDispositionKind
    outcome: RallyOutcome | None
    reasons: tuple[ReviewDispositionReason, ...]
    schema_version: str = REVIEW_SCHEMA_VERSION

    def __post_init__(self) -> None:
        if self.schema_version != REVIEW_SCHEMA_VERSION:
            raise ValueError("unsupported review-adjudication schema")
        _validate_action_head(
            case_fingerprint=self.case_fingerprint,
            signed_case_fingerprint=self.signed_case_fingerprint,
            expected_case_sequence=self.expected_case_sequence,
            previous_record_fingerprint=self.previous_record_fingerprint,
        )
        _require_review_action_idempotency_key(self.idempotency_key)
        if (
            type(self.considered_signed_disposition_fingerprints) is not tuple
            or not 1
            <= len(self.considered_signed_disposition_fingerprints)
            <= MAX_ADJUDICATED_DISPOSITIONS
        ):
            raise ValueError(
                "considered dispositions must be a bounded nonempty immutable tuple"
            )
        for fingerprint in self.considered_signed_disposition_fingerprints:
            _require_sha256(fingerprint, "considered signed disposition fingerprint")
        if len(set(self.considered_signed_disposition_fingerprints)) != len(
            self.considered_signed_disposition_fingerprints
        ):
            raise ValueError(
                "considered signed disposition fingerprints must be unique"
            )
        if self.expected_case_sequence == 0:
            raise ValueError("adjudication requires at least one prior case action")
        if (
            self.previous_record_fingerprint
            not in self.considered_signed_disposition_fingerprints
        ):
            raise ValueError(
                "adjudication must consider the immediately previous review record"
            )
        object.__setattr__(
            self,
            "considered_signed_disposition_fingerprints",
            tuple(sorted(self.considered_signed_disposition_fingerprints)),
        )
        object.__setattr__(
            self,
            "reasons",
            _validate_review_result(
                kind=self.kind,
                outcome=self.outcome,
                reasons=self.reasons,
                allow_escalate=False,
            ),
        )

    def canonical_dict(self) -> dict[str, object]:
        return {
            "case_fingerprint": self.case_fingerprint,
            "considered_signed_disposition_fingerprints": list(
                self.considered_signed_disposition_fingerprints
            ),
            "expected_case_sequence": self.expected_case_sequence,
            "idempotency_key": self.idempotency_key,
            "kind": self.kind.value,
            "outcome": self.outcome.value if self.outcome is not None else None,
            "previous_record_fingerprint": self.previous_record_fingerprint,
            "reasons": [reason.value for reason in self.reasons],
            "schema_version": self.schema_version,
            "signed_case_fingerprint": self.signed_case_fingerprint,
        }

    def validate_signed_case(self, signed_case: SignedScorerCopilotCase) -> None:
        _validate_signed_case_identity(
            case_fingerprint=self.case_fingerprint,
            signed_case_fingerprint=self.signed_case_fingerprint,
            signed_case=signed_case,
        )

    def fingerprint(self) -> str:
        return _fingerprint(self.canonical_dict(), label="review adjudication")


@dataclass(frozen=True, slots=True)
class SignedReviewAdjudication:
    adjudication: ReviewAdjudication
    adjudication_fingerprint: str
    actor_id: str
    actor_key_id: str
    actor_role: PrincipalRole
    policy_fingerprint: str
    trust_domain_id: str
    signed_at_ns: int
    signature_base64: str
    schema_version: str = REVIEW_SCHEMA_VERSION

    def __post_init__(self) -> None:
        if self.schema_version != REVIEW_SCHEMA_VERSION:
            raise ValueError("unsupported signed-adjudication schema")
        if type(self.adjudication) is not ReviewAdjudication:
            raise ValueError("adjudication must be an exact ReviewAdjudication")
        _require_sha256(self.adjudication_fingerprint, "adjudication_fingerprint")
        if self.adjudication_fingerprint != self.adjudication.fingerprint():
            raise ValueError("adjudication_fingerprint does not bind the adjudication")
        _require_stable_id(self.actor_id, "actor_id")
        _require_stable_id(self.actor_key_id, "actor_key_id")
        if type(self.actor_role) is not PrincipalRole:
            raise ValueError("actor_role must be a PrincipalRole")
        _require_sha256(self.policy_fingerprint, "policy_fingerprint")
        _require_stable_id(self.trust_domain_id, "trust_domain_id")
        _require_timestamp(self.signed_at_ns, "signed_at_ns")
        _canonical_base64(self.signature_base64, "signature_base64")

    @staticmethod
    def attestation_dict(
        *,
        adjudication: ReviewAdjudication,
        adjudication_fingerprint: str,
        actor_id: str,
        actor_key_id: str,
        actor_role: PrincipalRole,
        policy_fingerprint: str,
        trust_domain_id: str,
        signed_at_ns: int,
    ) -> dict[str, object]:
        return {
            "actor_id": actor_id,
            "actor_key_id": actor_key_id,
            "actor_role": actor_role.value,
            "adjudication": adjudication.canonical_dict(),
            "adjudication_fingerprint": adjudication_fingerprint,
            "policy_fingerprint": policy_fingerprint,
            "schema_version": REVIEW_SCHEMA_VERSION,
            "signed_at_ns": signed_at_ns,
            "trust_domain_id": trust_domain_id,
        }

    def unsigned_canonical_dict(self) -> dict[str, object]:
        return self.attestation_dict(
            adjudication=self.adjudication,
            adjudication_fingerprint=self.adjudication_fingerprint,
            actor_id=self.actor_id,
            actor_key_id=self.actor_key_id,
            actor_role=self.actor_role,
            policy_fingerprint=self.policy_fingerprint,
            trust_domain_id=self.trust_domain_id,
            signed_at_ns=self.signed_at_ns,
        )

    def canonical_dict(self) -> dict[str, object]:
        value = self.unsigned_canonical_dict()
        value["signature_base64"] = self.signature_base64
        return value

    def fingerprint(self) -> str:
        return _fingerprint(self.canonical_dict(), label="signed review adjudication")


@dataclass(frozen=True, slots=True)
class ReviewAuthorizationContext:
    """Frozen review head and evidence set; this is not authorization."""

    case_fingerprint: str
    signed_case_fingerprint: str
    match_id: str
    rally_id: str
    set_number: int
    state_revision: int
    ruleset_fingerprint: str
    case_sequence: int
    journal_head_fingerprint: str
    evidence_refs: tuple[str, ...]
    schema_version: str = REVIEW_SCHEMA_VERSION

    def __post_init__(self) -> None:
        if self.schema_version != REVIEW_SCHEMA_VERSION:
            raise ValueError("unsupported review-authorization context schema")
        _require_sha256(self.case_fingerprint, "case_fingerprint")
        _require_sha256(self.signed_case_fingerprint, "signed_case_fingerprint")
        _require_stable_id(self.match_id, "match_id")
        _require_stable_id(self.rally_id, "rally_id")
        _require_positive(self.set_number, "set_number", maximum=MAX_SET_NUMBER)
        _require_nonnegative(
            self.state_revision,
            "state_revision",
            maximum=MAX_SEQUENCE_NUMBER,
        )
        _require_sha256(self.ruleset_fingerprint, "ruleset_fingerprint")
        _require_nonnegative(
            self.case_sequence,
            "case_sequence",
            maximum=MAX_REVIEW_ACTIONS,
        )
        _require_sha256(self.journal_head_fingerprint, "journal_head_fingerprint")
        if (
            self.case_sequence == 0
            and self.journal_head_fingerprint != self.signed_case_fingerprint
        ):
            raise ValueError(
                "sequence-zero context must use the signed case as its journal head"
            )
        object.__setattr__(
            self,
            "evidence_refs",
            _canonical_evidence_refs(
                self.evidence_refs,
                "evidence_refs",
                allow_empty=False,
            ),
        )

    def validate_signed_case(self, signed_case: SignedScorerCopilotCase) -> None:
        case = _validate_signed_case_identity(
            case_fingerprint=self.case_fingerprint,
            signed_case_fingerprint=self.signed_case_fingerprint,
            signed_case=signed_case,
        )
        if (
            self.match_id != case.match_id
            or self.rally_id != case.rally_id
            or self.set_number != case.set_number
            or self.state_revision != case.state_revision
            or self.ruleset_fingerprint != case.ruleset_fingerprint
            or self.evidence_refs != case.assessment.evidence_refs
        ):
            raise ValueError("authorization context does not bind the exact case")

    def canonical_dict(self) -> dict[str, object]:
        return {
            "case_fingerprint": self.case_fingerprint,
            "case_sequence": self.case_sequence,
            "evidence_refs": list(self.evidence_refs),
            "journal_head_fingerprint": self.journal_head_fingerprint,
            "match_id": self.match_id,
            "rally_id": self.rally_id,
            "ruleset_fingerprint": self.ruleset_fingerprint,
            "schema_version": self.schema_version,
            "set_number": self.set_number,
            "state_revision": self.state_revision,
            "signed_case_fingerprint": self.signed_case_fingerprint,
        }

    def fingerprint(self) -> str:
        return _fingerprint(
            self.canonical_dict(), label="review authorization context"
        )


def copilot_idempotency_key(context: ReviewAuthorizationContext) -> str:
    """Return the bounded helper value; never constructs or authorizes a command."""

    if type(context) is not ReviewAuthorizationContext:
        raise ValueError("context must be an exact ReviewAuthorizationContext")
    value = f"{_COPILOT_IDEMPOTENCY_PREFIX}{context.fingerprint()}"
    if len(value) > MAX_AUTHORIZATION_ID_LENGTH or _STABLE_ID_RE.fullmatch(value) is None:
        raise ValueError(
            "copilot context fingerprint does not fit an authorization idempotency key"
        )
    return value


@dataclass(frozen=True, slots=True)
class CaseAuthorizationLink:
    """Post-commit linkage metadata; it is not proof without its envelope."""

    context: ReviewAuthorizationContext
    context_fingerprint: str
    signed_case_fingerprint: str
    authorized_envelope_fingerprint: str
    event_fingerprint: str
    event_id: str
    committed_event_sequence: int
    committed_state_revision: int
    outbox_id: int
    committed_at_ns: int
    schema_version: str = REVIEW_SCHEMA_VERSION

    def __post_init__(self) -> None:
        if self.schema_version != REVIEW_SCHEMA_VERSION:
            raise ValueError("unsupported case-authorization link schema")
        if type(self.context) is not ReviewAuthorizationContext:
            raise ValueError("context must be an exact ReviewAuthorizationContext")
        _require_sha256(self.context_fingerprint, "context_fingerprint")
        if self.context_fingerprint != self.context.fingerprint():
            raise ValueError("context_fingerprint does not bind the exact context")
        _require_sha256(self.signed_case_fingerprint, "signed_case_fingerprint")
        if self.signed_case_fingerprint != self.context.signed_case_fingerprint:
            raise ValueError(
                "signed_case_fingerprint does not bind the context's signed case"
            )
        _require_sha256(
            self.authorized_envelope_fingerprint,
            "authorized_envelope_fingerprint",
        )
        _require_sha256(self.event_fingerprint, "event_fingerprint")
        _require_stable_id(self.event_id, "event_id")
        expected_sequence = self.context.state_revision + 1
        if expected_sequence > MAX_SEQUENCE_NUMBER:
            raise ValueError("context revision cannot advance within signed 64-bit bounds")
        if self.committed_event_sequence != expected_sequence:
            raise ValueError(
                "committed_event_sequence must immediately follow the context revision"
            )
        if self.committed_state_revision != self.committed_event_sequence:
            raise ValueError(
                "committed_state_revision must equal the committed event sequence"
            )
        _require_positive(
            self.outbox_id,
            "outbox_id",
            maximum=MAX_SEQUENCE_NUMBER,
        )
        _require_timestamp(self.committed_at_ns, "committed_at_ns")

    def validate_signed_case(self, signed_case: SignedScorerCopilotCase) -> None:
        self.context.validate_signed_case(signed_case)
        # validate_signed_case above performs the exact runtime type check.
        case = signed_case.case
        if self.committed_at_ns < case.opened_at_ns:
            raise ValueError("authorization link cannot commit before the case opened")

    def canonical_dict(self) -> dict[str, object]:
        return {
            "authorized_envelope_fingerprint": self.authorized_envelope_fingerprint,
            "committed_at_ns": self.committed_at_ns,
            "committed_event_sequence": self.committed_event_sequence,
            "committed_state_revision": self.committed_state_revision,
            "context": self.context.canonical_dict(),
            "context_fingerprint": self.context_fingerprint,
            "event_fingerprint": self.event_fingerprint,
            "event_id": self.event_id,
            "outbox_id": self.outbox_id,
            "schema_version": self.schema_version,
            "signed_case_fingerprint": self.signed_case_fingerprint,
        }

    def fingerprint(self) -> str:
        return _fingerprint(self.canonical_dict(), label="case authorization link")


class _DuplicateKey(ValueError):
    pass


def _object_pairs(pairs: list[tuple[str, object]]) -> dict[str, object]:
    value: dict[str, object] = {}
    for key, item in pairs:
        if key in value:
            raise _DuplicateKey(key)
        value[key] = item
    return value


def _validate_json_shape(value: object, label: str) -> None:
    """Bound structure iteratively so validation cannot recurse on hostile JSON."""

    stack: list[tuple[object, int]] = [(value, 0)]
    nodes = 0
    containers = 0
    while stack:
        current, parent_container_depth = stack.pop()
        nodes += 1
        if nodes > MAX_REVIEW_JSON_NODES:
            _fail("JSON_NODES", f"{label} exceeds maximum JSON node count")
        if type(current) is dict:
            containers += 1
            container_depth = parent_container_depth + 1
            if container_depth > MAX_REVIEW_JSON_DEPTH:
                _fail("JSON_DEPTH", f"{label} exceeds maximum JSON depth")
            if containers > MAX_REVIEW_JSON_CONTAINERS:
                _fail(
                    "JSON_CONTAINERS",
                    f"{label} exceeds maximum JSON container count",
                )
            stack.extend(
                (item, container_depth) for item in current.values()
            )
        elif type(current) is list:
            containers += 1
            container_depth = parent_container_depth + 1
            if container_depth > MAX_REVIEW_JSON_DEPTH:
                _fail("JSON_DEPTH", f"{label} exceeds maximum JSON depth")
            if containers > MAX_REVIEW_JSON_CONTAINERS:
                _fail(
                    "JSON_CONTAINERS",
                    f"{label} exceeds maximum JSON container count",
                )
            stack.extend((item, container_depth) for item in current)


def _reject_noninteger_number(token: str) -> object:
    raise ValueError(f"non-integer JSON number is forbidden: {token}")


def _load_raw(raw: bytes, label: str) -> dict[str, object]:
    if type(raw) is not bytes:
        _fail("RAW_TYPE", f"{label} must be bytes")
    if not raw or len(raw) > MAX_REVIEW_RECORD_BYTES:
        _fail(
            "RAW_SIZE",
            f"{label} must contain 1..{MAX_REVIEW_RECORD_BYTES} bytes",
        )
    try:
        text = raw.decode("utf-8", errors="strict")
    except UnicodeDecodeError as exc:
        raise ReviewContractError("INVALID_UTF8", f"{label} is not UTF-8") from exc
    try:
        value = json.loads(
            text,
            object_pairs_hook=_object_pairs,
            parse_float=_reject_noninteger_number,
            parse_constant=_reject_noninteger_number,
        )
    except _DuplicateKey as exc:
        raise ReviewContractError(
            "DUPLICATE_KEY", f"{label} contains duplicate key {exc}"
        ) from exc
    except RecursionError as exc:
        raise ReviewContractError(
            "JSON_DEPTH", f"{label} exceeds parser nesting limits"
        ) from exc
    except (json.JSONDecodeError, ValueError) as exc:
        raise ReviewContractError("INVALID_JSON", f"{label} is invalid JSON") from exc
    if type(value) is not dict:
        _fail("TOP_LEVEL_TYPE", f"{label} must be a JSON object")
    _validate_json_shape(value, label)
    return value


def _exact_dict(
    value: object,
    fields: frozenset[str],
    label: str,
) -> dict[str, object]:
    if type(value) is not dict:
        _fail("FIELD_TYPE", f"{label} must be an object")
    missing = sorted(fields - set(value))
    unknown = sorted(set(value) - fields)
    if missing or unknown:
        _fail(
            "FIELD_SET",
            f"{label} has missing={missing!r} unknown={unknown!r}",
        )
    return value


def _exact_list(value: object, label: str, *, maximum: int) -> list[object]:
    if type(value) is not list or len(value) > maximum:
        _fail("FIELD_TYPE", f"{label} must be a list of at most {maximum} items")
    return value


_EVIDENCE_FIELDS = frozenset(
    {"captured_at_ns", "content_sha256", "evidence_ref", "kind", "source_id"}
)
_MODEL_FIELDS = frozenset(
    {
        "inference_config_sha256",
        "model_id",
        "model_version",
        "runtime_id",
        "weights_sha256",
    }
)
_HYPOTHESIS_FIELDS = frozenset(
    {
        "causal_cutoff_timestamp_ns",
        "evidence",
        "exception_signals",
        "hypothesis_id",
        "match_id",
        "models",
        "probabilities_ppm",
        "rally_id",
        "ruleset_fingerprint",
        "schema_version",
        "set_number",
        "state_revision",
    }
)
_RECONCILIATION_FIELDS = frozenset(
    {
        "causal_cutoff_timestamp_ns",
        "evidence",
        "expected_player_id",
        "expected_team",
        "hypothesis_fingerprint",
        "hypothesis_id",
        "match_id",
        "model",
        "observed_player_id",
        "observed_probability_ppm",
        "observed_team",
        "outcome",
        "rally_id",
        "schema_version",
        "set_number",
        "state_revision",
    }
)
_INTENT_FIELDS = frozenset({"kind", "winner_team"})
_ASSESSMENT_FIELDS = frozenset(
    {
        "causal_cutoff_timestamp_ns",
        "evidence_refs",
        "hypothesis_fingerprint",
        "hypothesis_id",
        "match_id",
        "policy_fingerprint",
        "policy_version",
        "rally_id",
        "reasons",
        "recommended_intent",
        "reconciliation_fingerprint",
        "reconciliation_outcome",
        "ruleset_fingerprint",
        "schema_version",
        "set_number",
        "state_revision",
        "status",
    }
)
_SIGNED_ASSESSMENT_FIELDS = frozenset(
    {
        "assessment",
        "assessment_fingerprint",
        "assessment_key_id",
        "assessor_id",
        "schema_version",
        "signature_base64",
        "signed_at_ns",
    }
)
_CLIP_MANIFEST_FIELDS = frozenset(
    {
        "decoder_contract_sha256",
        "end_frame_index",
        "end_timestamp_ns",
        "evidence_refs",
        "frame_count",
        "render_profile_sha256",
        "rendered_clip_sha256",
        "role",
        "schema_version",
        "selected_video_stream_index",
        "source_sha256",
        "start_frame_index",
        "start_timestamp_ns",
    }
)
_CLIP_REF_FIELDS = frozenset(
    {
        "generation_object_sha256s",
        "immutable_generation_id",
        "manifest",
        "manifest_sha256",
        "rendered_size_bytes",
        "schema_version",
    }
)
_CASE_FIELDS = frozenset(
    {
        "assessment",
        "clips",
        "hypothesis",
        "opened_at_ns",
        "reconciliation",
        "schema_version",
        "signed_assessment",
    }
)
_DISPOSITION_FIELDS = frozenset(
    {
        "case_fingerprint",
        "expected_case_sequence",
        "idempotency_key",
        "kind",
        "outcome",
        "previous_record_fingerprint",
        "reasons",
        "schema_version",
        "signed_case_fingerprint",
    }
)
_SIGNED_DISPOSITION_FIELDS = frozenset(
    {
        "actor_id",
        "actor_key_id",
        "actor_role",
        "disposition",
        "disposition_fingerprint",
        "policy_fingerprint",
        "schema_version",
        "signature_base64",
        "signed_at_ns",
        "trust_domain_id",
    }
)
_ADJUDICATION_FIELDS = frozenset(
    {
        "case_fingerprint",
        "considered_signed_disposition_fingerprints",
        "expected_case_sequence",
        "idempotency_key",
        "kind",
        "outcome",
        "previous_record_fingerprint",
        "reasons",
        "schema_version",
        "signed_case_fingerprint",
    }
)
_SIGNED_ADJUDICATION_FIELDS = frozenset(
    {
        "actor_id",
        "actor_key_id",
        "actor_role",
        "adjudication",
        "adjudication_fingerprint",
        "policy_fingerprint",
        "schema_version",
        "signature_base64",
        "signed_at_ns",
        "trust_domain_id",
    }
)
_CONTEXT_FIELDS = frozenset(
    {
        "case_fingerprint",
        "case_sequence",
        "evidence_refs",
        "journal_head_fingerprint",
        "match_id",
        "rally_id",
        "ruleset_fingerprint",
        "schema_version",
        "set_number",
        "signed_case_fingerprint",
        "state_revision",
    }
)
_LINK_FIELDS = frozenset(
    {
        "authorized_envelope_fingerprint",
        "committed_at_ns",
        "committed_event_sequence",
        "committed_state_revision",
        "context",
        "context_fingerprint",
        "event_fingerprint",
        "event_id",
        "outbox_id",
        "schema_version",
        "signed_case_fingerprint",
    }
)


def _evidence_from_dict(value: object, label: str) -> EvidenceProvenance:
    data = _exact_dict(value, _EVIDENCE_FIELDS, label)
    return EvidenceProvenance(
        evidence_ref=data["evidence_ref"],
        kind=EvidenceKind(data["kind"]),
        source_id=data["source_id"],
        content_sha256=data["content_sha256"],
        captured_at_ns=data["captured_at_ns"],
    )


def _model_from_dict(value: object, label: str) -> HypothesisModelProvenance:
    data = _exact_dict(value, _MODEL_FIELDS, label)
    return HypothesisModelProvenance(
        model_id=data["model_id"],
        model_version=data["model_version"],
        weights_sha256=data["weights_sha256"],
        inference_config_sha256=data["inference_config_sha256"],
        runtime_id=data["runtime_id"],
    )


def _hypothesis_from_dict(value: object, label: str) -> RallyHypothesis:
    data = _exact_dict(value, _HYPOTHESIS_FIELDS, label)
    evidence = tuple(
        _evidence_from_dict(item, f"{label}.evidence[{index}]")
        for index, item in enumerate(
            _exact_list(data["evidence"], f"{label}.evidence", maximum=MAX_EVIDENCE_REFS)
        )
    )
    models = tuple(
        _model_from_dict(item, f"{label}.models[{index}]")
        for index, item in enumerate(
            _exact_list(data["models"], f"{label}.models", maximum=32)
        )
    )
    probabilities = _exact_dict(
        data["probabilities_ppm"],
        frozenset(outcome.value for outcome in RallyOutcome),
        f"{label}.probabilities_ppm",
    )
    return RallyHypothesis(
        hypothesis_id=data["hypothesis_id"],
        match_id=data["match_id"],
        rally_id=data["rally_id"],
        set_number=data["set_number"],
        state_revision=data["state_revision"],
        ruleset_fingerprint=data["ruleset_fingerprint"],
        causal_cutoff_timestamp_ns=data["causal_cutoff_timestamp_ns"],
        probabilities_ppm={
            outcome: probabilities[outcome.value] for outcome in RallyOutcome
        },
        exception_signals=tuple(
            ExceptionSignal(item)
            for item in _exact_list(
                data["exception_signals"],
                f"{label}.exception_signals",
                maximum=len(ExceptionSignal),
            )
        ),
        evidence=evidence,
        models=models,
        schema_version=data["schema_version"],
    )


def _reconciliation_from_dict(
    value: object,
    label: str,
) -> NextServerReconciliation | None:
    if value is None:
        return None
    data = _exact_dict(value, _RECONCILIATION_FIELDS, label)
    return NextServerReconciliation(
        hypothesis_id=data["hypothesis_id"],
        hypothesis_fingerprint=data["hypothesis_fingerprint"],
        match_id=data["match_id"],
        rally_id=data["rally_id"],
        set_number=data["set_number"],
        state_revision=data["state_revision"],
        causal_cutoff_timestamp_ns=data["causal_cutoff_timestamp_ns"],
        outcome=NextServerOutcome(data["outcome"]),
        expected_team=(
            Team(data["expected_team"]) if data["expected_team"] is not None else None
        ),
        expected_player_id=data["expected_player_id"],
        observed_team=(
            Team(data["observed_team"]) if data["observed_team"] is not None else None
        ),
        observed_player_id=data["observed_player_id"],
        observed_probability_ppm=data["observed_probability_ppm"],
        evidence=(
            _evidence_from_dict(data["evidence"], f"{label}.evidence")
            if data["evidence"] is not None
            else None
        ),
        model=(
            _model_from_dict(data["model"], f"{label}.model")
            if data["model"] is not None
            else None
        ),
        schema_version=data["schema_version"],
    )


def _assessment_from_dict(value: object, label: str) -> PolicyAssessment:
    data = _exact_dict(value, _ASSESSMENT_FIELDS, label)
    intent_raw = data["recommended_intent"]
    intent: ScoringIntent | None
    if intent_raw is None:
        intent = None
    else:
        intent_data = _exact_dict(intent_raw, _INTENT_FIELDS, f"{label}.intent")
        intent = ScoringIntent(
            kind=ScoringIntentKind(intent_data["kind"]),
            winner_team=(
                Team(intent_data["winner_team"])
                if intent_data["winner_team"] is not None
                else None
            ),
        )
    return PolicyAssessment(
        hypothesis_id=data["hypothesis_id"],
        hypothesis_fingerprint=data["hypothesis_fingerprint"],
        match_id=data["match_id"],
        rally_id=data["rally_id"],
        set_number=data["set_number"],
        state_revision=data["state_revision"],
        ruleset_fingerprint=data["ruleset_fingerprint"],
        causal_cutoff_timestamp_ns=data["causal_cutoff_timestamp_ns"],
        policy_version=data["policy_version"],
        policy_fingerprint=data["policy_fingerprint"],
        status=PolicyAssessmentStatus(data["status"]),
        reasons=tuple(
            PolicyReason(item)
            for item in _exact_list(data["reasons"], f"{label}.reasons", maximum=64)
        ),
        recommended_intent=intent,
        evidence_refs=tuple(
            _exact_list(
                data["evidence_refs"],
                f"{label}.evidence_refs",
                maximum=MAX_EVIDENCE_REFS,
            )
        ),
        reconciliation_outcome=(
            NextServerOutcome(data["reconciliation_outcome"])
            if data["reconciliation_outcome"] is not None
            else None
        ),
        reconciliation_fingerprint=data["reconciliation_fingerprint"],
        schema_version=data["schema_version"],
    )


def _signed_assessment_from_dict(
    value: object,
    label: str,
) -> SignedPolicyAssessment | None:
    if value is None:
        return None
    data = _exact_dict(value, _SIGNED_ASSESSMENT_FIELDS, label)
    return SignedPolicyAssessment(
        assessment=_assessment_from_dict(data["assessment"], f"{label}.assessment"),
        assessment_fingerprint=data["assessment_fingerprint"],
        assessor_id=data["assessor_id"],
        assessment_key_id=data["assessment_key_id"],
        signed_at_ns=data["signed_at_ns"],
        signature_base64=data["signature_base64"],
        schema_version=data["schema_version"],
    )


def _clip_manifest_from_dict(value: object, label: str) -> ReviewClipManifest:
    data = _exact_dict(value, _CLIP_MANIFEST_FIELDS, label)
    return ReviewClipManifest(
        source_sha256=data["source_sha256"],
        selected_video_stream_index=data["selected_video_stream_index"],
        start_frame_index=data["start_frame_index"],
        end_frame_index=data["end_frame_index"],
        frame_count=data["frame_count"],
        start_timestamp_ns=data["start_timestamp_ns"],
        end_timestamp_ns=data["end_timestamp_ns"],
        decoder_contract_sha256=data["decoder_contract_sha256"],
        render_profile_sha256=data["render_profile_sha256"],
        rendered_clip_sha256=data["rendered_clip_sha256"],
        role=ReviewClipRole(data["role"]),
        evidence_refs=tuple(
            _exact_list(
                data["evidence_refs"],
                f"{label}.evidence_refs",
                maximum=MAX_EVIDENCE_REFS,
            )
        ),
        schema_version=data["schema_version"],
    )


def _clip_ref_from_dict(value: object, label: str) -> ReviewClipRef:
    data = _exact_dict(value, _CLIP_REF_FIELDS, label)
    return ReviewClipRef(
        manifest=_clip_manifest_from_dict(data["manifest"], f"{label}.manifest"),
        manifest_sha256=data["manifest_sha256"],
        immutable_generation_id=data["immutable_generation_id"],
        generation_object_sha256s=tuple(
            _exact_list(
                data["generation_object_sha256s"],
                f"{label}.generation_object_sha256s",
                maximum=2,
            )
        ),
        rendered_size_bytes=data["rendered_size_bytes"],
        schema_version=data["schema_version"],
    )


def _case_from_dict(value: object, label: str) -> ScorerCopilotCase:
    data = _exact_dict(value, _CASE_FIELDS, label)
    return ScorerCopilotCase(
        hypothesis=_hypothesis_from_dict(data["hypothesis"], f"{label}.hypothesis"),
        reconciliation=_reconciliation_from_dict(
            data["reconciliation"], f"{label}.reconciliation"
        ),
        assessment=_assessment_from_dict(data["assessment"], f"{label}.assessment"),
        signed_assessment=_signed_assessment_from_dict(
            data["signed_assessment"], f"{label}.signed_assessment"
        ),
        clips=tuple(
            _clip_ref_from_dict(item, f"{label}.clips[{index}]")
            for index, item in enumerate(
                _exact_list(data["clips"], f"{label}.clips", maximum=MAX_REVIEW_CLIPS)
            )
        ),
        opened_at_ns=data["opened_at_ns"],
        schema_version=data["schema_version"],
    )


def _disposition_from_dict(value: object, label: str) -> ReviewDisposition:
    data = _exact_dict(value, _DISPOSITION_FIELDS, label)
    return ReviewDisposition(
        case_fingerprint=data["case_fingerprint"],
        signed_case_fingerprint=data["signed_case_fingerprint"],
        expected_case_sequence=data["expected_case_sequence"],
        previous_record_fingerprint=data["previous_record_fingerprint"],
        idempotency_key=data["idempotency_key"],
        kind=ReviewDispositionKind(data["kind"]),
        outcome=(RallyOutcome(data["outcome"]) if data["outcome"] is not None else None),
        reasons=tuple(
            ReviewDispositionReason(item)
            for item in _exact_list(
                data["reasons"], f"{label}.reasons", maximum=MAX_REVIEW_REASONS
            )
        ),
        schema_version=data["schema_version"],
    )


def _signed_disposition_from_dict(
    value: object,
    label: str,
) -> SignedReviewDisposition:
    data = _exact_dict(value, _SIGNED_DISPOSITION_FIELDS, label)
    return SignedReviewDisposition(
        disposition=_disposition_from_dict(data["disposition"], f"{label}.disposition"),
        disposition_fingerprint=data["disposition_fingerprint"],
        actor_id=data["actor_id"],
        actor_key_id=data["actor_key_id"],
        actor_role=PrincipalRole(data["actor_role"]),
        policy_fingerprint=data["policy_fingerprint"],
        trust_domain_id=data["trust_domain_id"],
        signed_at_ns=data["signed_at_ns"],
        signature_base64=data["signature_base64"],
        schema_version=data["schema_version"],
    )


def _adjudication_from_dict(value: object, label: str) -> ReviewAdjudication:
    data = _exact_dict(value, _ADJUDICATION_FIELDS, label)
    return ReviewAdjudication(
        case_fingerprint=data["case_fingerprint"],
        signed_case_fingerprint=data["signed_case_fingerprint"],
        expected_case_sequence=data["expected_case_sequence"],
        previous_record_fingerprint=data["previous_record_fingerprint"],
        idempotency_key=data["idempotency_key"],
        considered_signed_disposition_fingerprints=tuple(
            _exact_list(
                data["considered_signed_disposition_fingerprints"],
                f"{label}.considered_signed_disposition_fingerprints",
                maximum=MAX_ADJUDICATED_DISPOSITIONS,
            )
        ),
        kind=ReviewDispositionKind(data["kind"]),
        outcome=(RallyOutcome(data["outcome"]) if data["outcome"] is not None else None),
        reasons=tuple(
            ReviewDispositionReason(item)
            for item in _exact_list(
                data["reasons"], f"{label}.reasons", maximum=MAX_REVIEW_REASONS
            )
        ),
        schema_version=data["schema_version"],
    )


def _signed_adjudication_from_dict(
    value: object,
    label: str,
) -> SignedReviewAdjudication:
    data = _exact_dict(value, _SIGNED_ADJUDICATION_FIELDS, label)
    return SignedReviewAdjudication(
        adjudication=_adjudication_from_dict(
            data["adjudication"], f"{label}.adjudication"
        ),
        adjudication_fingerprint=data["adjudication_fingerprint"],
        actor_id=data["actor_id"],
        actor_key_id=data["actor_key_id"],
        actor_role=PrincipalRole(data["actor_role"]),
        policy_fingerprint=data["policy_fingerprint"],
        trust_domain_id=data["trust_domain_id"],
        signed_at_ns=data["signed_at_ns"],
        signature_base64=data["signature_base64"],
        schema_version=data["schema_version"],
    )


def _context_from_dict(value: object, label: str) -> ReviewAuthorizationContext:
    data = _exact_dict(value, _CONTEXT_FIELDS, label)
    return ReviewAuthorizationContext(
        case_fingerprint=data["case_fingerprint"],
        signed_case_fingerprint=data["signed_case_fingerprint"],
        match_id=data["match_id"],
        rally_id=data["rally_id"],
        set_number=data["set_number"],
        state_revision=data["state_revision"],
        ruleset_fingerprint=data["ruleset_fingerprint"],
        case_sequence=data["case_sequence"],
        journal_head_fingerprint=data["journal_head_fingerprint"],
        evidence_refs=tuple(
            _exact_list(
                data["evidence_refs"],
                f"{label}.evidence_refs",
                maximum=MAX_EVIDENCE_REFS,
            )
        ),
        schema_version=data["schema_version"],
    )


def _link_from_dict(value: object, label: str) -> CaseAuthorizationLink:
    data = _exact_dict(value, _LINK_FIELDS, label)
    return CaseAuthorizationLink(
        context=_context_from_dict(data["context"], f"{label}.context"),
        context_fingerprint=data["context_fingerprint"],
        signed_case_fingerprint=data["signed_case_fingerprint"],
        authorized_envelope_fingerprint=data["authorized_envelope_fingerprint"],
        event_fingerprint=data["event_fingerprint"],
        event_id=data["event_id"],
        committed_event_sequence=data["committed_event_sequence"],
        committed_state_revision=data["committed_state_revision"],
        outbox_id=data["outbox_id"],
        committed_at_ns=data["committed_at_ns"],
        schema_version=data["schema_version"],
    )


_T = TypeVar("_T")


def _parse(
    raw: bytes,
    *,
    label: str,
    builder: Callable[[object, str], _T],
    encoder: Callable[[_T], bytes],
) -> _T:
    data = _load_raw(raw, label)
    try:
        value = builder(data, label)
    except ReviewContractError:
        raise
    except (TypeError, ValueError, KeyError) as exc:
        raise ReviewContractError("RECORD_INVALID", f"{label} is invalid") from exc
    if encoder(value) != raw:
        _fail("NON_CANONICAL", f"{label} is not canonical")
    return value


def encode_review_clip_manifest(value: ReviewClipManifest) -> bytes:
    if type(value) is not ReviewClipManifest:
        raise ValueError("value must be an exact ReviewClipManifest")
    return _canonical_json_bytes(value.canonical_dict(), label="review clip manifest")


def parse_review_clip_manifest(raw: bytes) -> ReviewClipManifest:
    return _parse(
        raw,
        label="review clip manifest",
        builder=_clip_manifest_from_dict,
        encoder=encode_review_clip_manifest,
    )


def encode_review_clip_ref(value: ReviewClipRef) -> bytes:
    if type(value) is not ReviewClipRef:
        raise ValueError("value must be an exact ReviewClipRef")
    return _canonical_json_bytes(value.canonical_dict(), label="review clip reference")


def parse_review_clip_ref(raw: bytes) -> ReviewClipRef:
    return _parse(
        raw,
        label="review clip reference",
        builder=_clip_ref_from_dict,
        encoder=encode_review_clip_ref,
    )


def encode_scorer_copilot_case(value: ScorerCopilotCase) -> bytes:
    if type(value) is not ScorerCopilotCase:
        raise ValueError("value must be an exact ScorerCopilotCase")
    return _canonical_json_bytes(value.canonical_dict(), label="scorer-copilot case")


def parse_scorer_copilot_case(raw: bytes) -> ScorerCopilotCase:
    return _parse(
        raw,
        label="scorer-copilot case",
        builder=_case_from_dict,
        encoder=encode_scorer_copilot_case,
    )


def encode_review_disposition(value: ReviewDisposition) -> bytes:
    if type(value) is not ReviewDisposition:
        raise ValueError("value must be an exact ReviewDisposition")
    return _canonical_json_bytes(value.canonical_dict(), label="review disposition")


def parse_review_disposition(raw: bytes) -> ReviewDisposition:
    return _parse(
        raw,
        label="review disposition",
        builder=_disposition_from_dict,
        encoder=encode_review_disposition,
    )


def encode_signed_review_disposition(value: SignedReviewDisposition) -> bytes:
    if type(value) is not SignedReviewDisposition:
        raise ValueError("value must be an exact SignedReviewDisposition")
    return _canonical_json_bytes(
        value.canonical_dict(), label="signed review disposition"
    )


def parse_signed_review_disposition(raw: bytes) -> SignedReviewDisposition:
    return _parse(
        raw,
        label="signed review disposition",
        builder=_signed_disposition_from_dict,
        encoder=encode_signed_review_disposition,
    )


def encode_review_adjudication(value: ReviewAdjudication) -> bytes:
    if type(value) is not ReviewAdjudication:
        raise ValueError("value must be an exact ReviewAdjudication")
    return _canonical_json_bytes(value.canonical_dict(), label="review adjudication")


def parse_review_adjudication(raw: bytes) -> ReviewAdjudication:
    return _parse(
        raw,
        label="review adjudication",
        builder=_adjudication_from_dict,
        encoder=encode_review_adjudication,
    )


def encode_signed_review_adjudication(value: SignedReviewAdjudication) -> bytes:
    if type(value) is not SignedReviewAdjudication:
        raise ValueError("value must be an exact SignedReviewAdjudication")
    return _canonical_json_bytes(
        value.canonical_dict(), label="signed review adjudication"
    )


def parse_signed_review_adjudication(raw: bytes) -> SignedReviewAdjudication:
    return _parse(
        raw,
        label="signed review adjudication",
        builder=_signed_adjudication_from_dict,
        encoder=encode_signed_review_adjudication,
    )


def encode_review_authorization_context(value: ReviewAuthorizationContext) -> bytes:
    if type(value) is not ReviewAuthorizationContext:
        raise ValueError("value must be an exact ReviewAuthorizationContext")
    return _canonical_json_bytes(
        value.canonical_dict(), label="review authorization context"
    )


def parse_review_authorization_context(raw: bytes) -> ReviewAuthorizationContext:
    return _parse(
        raw,
        label="review authorization context",
        builder=_context_from_dict,
        encoder=encode_review_authorization_context,
    )


def encode_case_authorization_link(value: CaseAuthorizationLink) -> bytes:
    if type(value) is not CaseAuthorizationLink:
        raise ValueError("value must be an exact CaseAuthorizationLink")
    return _canonical_json_bytes(value.canonical_dict(), label="case authorization link")


def parse_case_authorization_link(raw: bytes) -> CaseAuthorizationLink:
    return _parse(
        raw,
        label="case authorization link",
        builder=_link_from_dict,
        encoder=encode_case_authorization_link,
    )


__all__ = [
    "CaseAuthorizationLink",
    "MAX_ADJUDICATED_DISPOSITIONS",
    "MAX_REVIEW_ACTIONS",
    "MAX_REVIEW_JSON_CONTAINERS",
    "MAX_REVIEW_JSON_DEPTH",
    "MAX_REVIEW_JSON_NODES",
    "MAX_REVIEW_RECORD_BYTES",
    "REVIEW_SCHEMA_VERSION",
    "ReviewAdjudication",
    "ReviewAuthorizationContext",
    "ReviewClipManifest",
    "ReviewClipRef",
    "ReviewClipRole",
    "ReviewContractError",
    "ReviewDisposition",
    "ReviewDispositionKind",
    "ReviewDispositionReason",
    "ScorerCopilotCase",
    "SignedReviewAdjudication",
    "SignedReviewDisposition",
    "copilot_idempotency_key",
    "encode_case_authorization_link",
    "encode_review_adjudication",
    "encode_review_authorization_context",
    "encode_review_clip_manifest",
    "encode_review_clip_ref",
    "encode_review_disposition",
    "encode_scorer_copilot_case",
    "encode_signed_review_adjudication",
    "encode_signed_review_disposition",
    "parse_case_authorization_link",
    "parse_review_adjudication",
    "parse_review_authorization_context",
    "parse_review_clip_manifest",
    "parse_review_clip_ref",
    "parse_review_disposition",
    "parse_scorer_copilot_case",
    "parse_signed_review_adjudication",
    "parse_signed_review_disposition",
]
