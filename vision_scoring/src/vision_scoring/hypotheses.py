"""Bounded, immutable causal hypotheses produced by perception and fusion."""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from enum import Enum
from types import MappingProxyType
from typing import Mapping

from .domain_events import (
    MAX_EVIDENCE_REF_LENGTH,
    MAX_EVIDENCE_REFS,
    MAX_ID_LENGTH,
    MAX_SEQUENCE_NUMBER,
    MAX_SET_NUMBER,
    Team,
)


PPM_TOTAL = 1_000_000
_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
_MAX_MODELS = 32


def _require_text(value: str, field_name: str, *, maximum: int) -> None:
    if (
        type(value) is not str
        or not value
        or len(value) > maximum
        or re.fullmatch(r"[\x21-\x7e]+", value) is None
    ):
        raise ValueError(
            f"{field_name} must be printable non-whitespace ASCII of at most "
            f"{maximum} characters"
        )


def _require_sha256(value: str, field_name: str) -> None:
    if type(value) is not str or _SHA256_RE.fullmatch(value) is None:
        raise ValueError(f"{field_name} must be a lowercase 64-character SHA-256")


def _require_nonnegative_integer(value: int, field_name: str) -> None:
    if type(value) is not int or not 0 <= value <= MAX_SEQUENCE_NUMBER:
        raise ValueError(f"{field_name} must be a non-negative signed 64-bit integer")


class RallyOutcome(str, Enum):
    """Mutually exclusive inference outcomes; none has scoring authority."""

    POINT_TEAM_A = "POINT_TEAM_A"
    POINT_TEAM_B = "POINT_TEAM_B"
    REPLAY_NO_POINT = "REPLAY_NO_POINT"
    UNRESOLVED = "UNRESOLVED"

    @property
    def winner(self) -> Team | None:
        if self is RallyOutcome.POINT_TEAM_A:
            return Team.A
        if self is RallyOutcome.POINT_TEAM_B:
            return Team.B
        return None


class ExceptionSignal(str, Enum):
    """Signals that must be screened before point-winner optimization."""

    CAPTURE_GAP = "CAPTURE_GAP"
    REPLAY_NO_POINT = "REPLAY_NO_POINT"
    CHALLENGE = "CHALLENGE"
    CORRECTION = "CORRECTION"
    ADMINISTRATIVE_POINT = "ADMINISTRATIVE_POINT"
    TIMEOUT = "TIMEOUT"
    SIDE_SWITCH = "SIDE_SWITCH"
    RULES_CONFLICT = "RULES_CONFLICT"


class EvidenceKind(str, Enum):
    """The independent role played by a referenced evidence artifact."""

    RALLY_TRANSITION = "RALLY_TRANSITION"
    TEAM_ATTRIBUTION = "TEAM_ATTRIBUTION"
    FUSED_RALLY = "FUSED_RALLY"
    NEXT_SERVER = "NEXT_SERVER"
    REFEREE_SIGNAL = "REFEREE_SIGNAL"
    SCOREBOARD = "SCOREBOARD"
    AUDIO = "AUDIO"
    CAPTURE_INTEGRITY = "CAPTURE_INTEGRITY"


@dataclass(frozen=True, slots=True)
class EvidenceProvenance:
    """Content identity and causal time for one bounded evidence artifact."""

    evidence_ref: str
    kind: EvidenceKind
    source_id: str
    content_sha256: str
    captured_at_ns: int

    def __post_init__(self) -> None:
        _require_text(
            self.evidence_ref,
            "evidence_ref",
            maximum=MAX_EVIDENCE_REF_LENGTH,
        )
        if not isinstance(self.kind, EvidenceKind):
            raise ValueError("kind must be an EvidenceKind")
        _require_text(self.source_id, "source_id", maximum=MAX_ID_LENGTH)
        _require_sha256(self.content_sha256, "content_sha256")
        _require_nonnegative_integer(self.captured_at_ns, "captured_at_ns")

    def canonical_dict(self) -> dict[str, object]:
        return {
            "captured_at_ns": self.captured_at_ns,
            "content_sha256": self.content_sha256,
            "evidence_ref": self.evidence_ref,
            "kind": self.kind.value,
            "source_id": self.source_id,
        }


@dataclass(frozen=True, slots=True)
class HypothesisModelProvenance:
    """Exact model and inference-configuration identity used by fusion."""

    model_id: str
    model_version: str
    weights_sha256: str
    inference_config_sha256: str
    runtime_id: str

    def __post_init__(self) -> None:
        for field_name in ("model_id", "model_version", "runtime_id"):
            _require_text(
                getattr(self, field_name),
                field_name,
                maximum=MAX_ID_LENGTH,
            )
        _require_sha256(self.weights_sha256, "weights_sha256")
        _require_sha256(self.inference_config_sha256, "inference_config_sha256")

    def canonical_dict(self) -> dict[str, str]:
        return {
            "inference_config_sha256": self.inference_config_sha256,
            "model_id": self.model_id,
            "model_version": self.model_version,
            "runtime_id": self.runtime_id,
            "weights_sha256": self.weights_sha256,
        }


@dataclass(frozen=True, slots=True)
class RallyHypothesis:
    """A causal inference record with no policy or event authority."""

    hypothesis_id: str
    match_id: str
    rally_id: str
    set_number: int
    state_revision: int
    ruleset_fingerprint: str
    causal_cutoff_timestamp_ns: int
    probabilities_ppm: Mapping[RallyOutcome, int]
    exception_signals: tuple[ExceptionSignal, ...]
    evidence: tuple[EvidenceProvenance, ...]
    models: tuple[HypothesisModelProvenance, ...]
    schema_version: str = "1.0"

    def __post_init__(self) -> None:
        for field_name in (
            "hypothesis_id",
            "match_id",
            "rally_id",
        ):
            _require_text(
                getattr(self, field_name),
                field_name,
                maximum=MAX_ID_LENGTH,
            )
        if self.schema_version != "1.0":
            raise ValueError("schema_version must be exactly '1.0'")
        if (
            type(self.set_number) is not int
            or not 1 <= self.set_number <= MAX_SET_NUMBER
        ):
            raise ValueError(f"set_number must be in [1, {MAX_SET_NUMBER}]")
        _require_nonnegative_integer(self.state_revision, "state_revision")
        _require_sha256(self.ruleset_fingerprint, "ruleset_fingerprint")
        _require_nonnegative_integer(
            self.causal_cutoff_timestamp_ns,
            "causal_cutoff_timestamp_ns",
        )
        if not isinstance(self.probabilities_ppm, Mapping):
            raise ValueError("probabilities_ppm must be a mapping")
        if len(self.probabilities_ppm) != len(RallyOutcome):
            raise ValueError("probabilities_ppm must contain exactly four entries")
        if set(self.probabilities_ppm) != set(RallyOutcome):
            raise ValueError("probabilities_ppm must contain every RallyOutcome exactly once")
        probabilities: dict[RallyOutcome, int] = {}
        for outcome, probability in self.probabilities_ppm.items():
            if not isinstance(outcome, RallyOutcome):
                raise ValueError("probability keys must be RallyOutcome values")
            if type(probability) is not int or not 0 <= probability <= PPM_TOTAL:
                raise ValueError("probabilities must be integer ppm values in [0, 1000000]")
            probabilities[outcome] = probability
        if sum(probabilities.values()) != PPM_TOTAL:
            raise ValueError("probabilities_ppm must sum exactly to 1000000")

        if type(self.exception_signals) is not tuple or any(
            not isinstance(signal, ExceptionSignal) for signal in self.exception_signals
        ):
            raise ValueError("exception_signals must be a tuple of ExceptionSignal values")
        if len(set(self.exception_signals)) != len(self.exception_signals):
            raise ValueError("exception_signals cannot contain duplicates")
        if (
            type(self.evidence) is not tuple
            or not 1 <= len(self.evidence) <= MAX_EVIDENCE_REFS
        ):
            raise ValueError(
                f"evidence must contain between 1 and {MAX_EVIDENCE_REFS} entries"
            )
        if any(not isinstance(item, EvidenceProvenance) for item in self.evidence):
            raise ValueError("evidence entries must be EvidenceProvenance values")
        if any(item.kind is EvidenceKind.NEXT_SERVER for item in self.evidence):
            raise ValueError(
                "NEXT_SERVER evidence belongs only in reconciliation, not RallyHypothesis"
            )
        if len({item.evidence_ref for item in self.evidence}) != len(self.evidence):
            raise ValueError("evidence_ref values must be unique")
        if any(
            item.captured_at_ns > self.causal_cutoff_timestamp_ns
            for item in self.evidence
        ):
            raise ValueError("evidence cannot occur after causal_cutoff_timestamp_ns")
        if type(self.models) is not tuple or not 1 <= len(self.models) <= _MAX_MODELS:
            raise ValueError(f"models must contain between 1 and {_MAX_MODELS} entries")
        if any(not isinstance(item, HypothesisModelProvenance) for item in self.models):
            raise ValueError("models entries must be HypothesisModelProvenance values")
        if len({item.model_id for item in self.models}) != len(self.models):
            raise ValueError("model_id values must be unique")

        object.__setattr__(
            self,
            "probabilities_ppm",
            MappingProxyType(dict(probabilities)),
        )
        object.__setattr__(
            self,
            "exception_signals",
            tuple(sorted(self.exception_signals, key=lambda signal: signal.value)),
        )
        object.__setattr__(
            self,
            "evidence",
            tuple(sorted(self.evidence, key=lambda item: item.evidence_ref)),
        )
        object.__setattr__(
            self,
            "models",
            tuple(sorted(self.models, key=lambda item: item.model_id)),
        )

    def probability_ppm(self, outcome: RallyOutcome) -> int:
        if not isinstance(outcome, RallyOutcome):
            raise ValueError("outcome must be a RallyOutcome")
        return self.probabilities_ppm[outcome]

    @property
    def leading_outcome(self) -> RallyOutcome | None:
        maximum = max(self.probabilities_ppm.values())
        leaders = tuple(
            outcome
            for outcome, probability in self.probabilities_ppm.items()
            if probability == maximum
        )
        return leaders[0] if len(leaders) == 1 else None

    @property
    def proposed_winner(self) -> Team | None:
        outcome = self.leading_outcome
        return outcome.winner if outcome is not None else None

    @property
    def evidence_kinds(self) -> frozenset[EvidenceKind]:
        return frozenset(item.kind for item in self.evidence)

    @property
    def has_primary_point_evidence(self) -> bool:
        kinds = self.evidence_kinds
        return (
            EvidenceKind.FUSED_RALLY in kinds
            or (
                EvidenceKind.RALLY_TRANSITION in kinds
                and EvidenceKind.TEAM_ATTRIBUTION in kinds
            )
        )

    def canonical_dict(self) -> dict[str, object]:
        return {
            "causal_cutoff_timestamp_ns": self.causal_cutoff_timestamp_ns,
            "evidence": [item.canonical_dict() for item in self.evidence],
            "exception_signals": sorted(signal.value for signal in self.exception_signals),
            "hypothesis_id": self.hypothesis_id,
            "match_id": self.match_id,
            "models": [item.canonical_dict() for item in self.models],
            "probabilities_ppm": {
                outcome.value: self.probabilities_ppm[outcome]
                for outcome in sorted(RallyOutcome, key=lambda item: item.value)
            },
            "rally_id": self.rally_id,
            "ruleset_fingerprint": self.ruleset_fingerprint,
            "schema_version": self.schema_version,
            "set_number": self.set_number,
            "state_revision": self.state_revision,
        }

    def fingerprint(self) -> str:
        encoded = json.dumps(
            self.canonical_dict(),
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
        return hashlib.sha256(encoded).hexdigest()
