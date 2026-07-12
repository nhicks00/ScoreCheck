"""Exception-first policy assessment with no event-construction authority."""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from enum import Enum

from .domain_events import (
    MAX_EVIDENCE_REF_LENGTH,
    MAX_EVIDENCE_REFS,
    MAX_ID_LENGTH,
    MAX_SEQUENCE_NUMBER,
    MAX_SET_NUMBER,
    Team,
)
from .hypotheses import ExceptionSignal, RallyHypothesis, RallyOutcome
from .reconciliation import NextServerOutcome, NextServerReconciliation
from .rules import MatchState, SetPhase


PPM_TOTAL = 1_000_000
_SHA256_RE = re.compile(r"[0-9a-f]{64}")


class PolicyAssessmentStatus(str, Enum):
    """Policy states; none means that an event has been authorized."""

    PENDING = "PENDING"
    REVIEW_REQUIRED = "REVIEW_REQUIRED"
    HUMAN_AUTHORIZATION_REQUIRED = "HUMAN_AUTHORIZATION_REQUIRED"
    UNRESOLVED = "UNRESOLVED"


class ScoringIntentKind(str, Enum):
    """A recommendation only, deliberately distinct from a RuleEvent."""

    AWARD_POINT = "AWARD_POINT"
    RECORD_REPLAY_NO_POINT = "RECORD_REPLAY_NO_POINT"


class PolicyReason(str, Enum):
    WAITING_FOR_EVIDENCE = "WAITING_FOR_EVIDENCE"
    INSUFFICIENT_CONFIDENCE = "INSUFFICIENT_CONFIDENCE"
    AMBIGUOUS_OUTCOME = "AMBIGUOUS_OUTCOME"
    MODEL_UNRESOLVED = "MODEL_UNRESOLVED"
    PRIMARY_POINT_EVIDENCE_REQUIRED = "PRIMARY_POINT_EVIDENCE_REQUIRED"
    NEXT_SERVER_CONTRADICTION = "NEXT_SERVER_CONTRADICTION"
    NEXT_SERVER_AMBIGUOUS = "NEXT_SERVER_AMBIGUOUS"
    SERVICE_ORDER_CONFLICT = "SERVICE_ORDER_CONFLICT"
    RECONCILIATION_CONTEXT_MISMATCH = "RECONCILIATION_CONTEXT_MISMATCH"
    EVIDENCE_PROVENANCE_CONFLICT = "EVIDENCE_PROVENANCE_CONFLICT"
    CAPTURE_GAP = "CAPTURE_GAP"
    REPLAY_REQUIRES_REVIEW = "REPLAY_REQUIRES_REVIEW"
    CHALLENGE_REQUIRES_REVIEW = "CHALLENGE_REQUIRES_REVIEW"
    CORRECTION_REQUIRES_REVIEW = "CORRECTION_REQUIRES_REVIEW"
    ADMINISTRATIVE_POINT_REQUIRES_REVIEW = (
        "ADMINISTRATIVE_POINT_REQUIRES_REVIEW"
    )
    TIMEOUT_REQUIRES_REVIEW = "TIMEOUT_REQUIRES_REVIEW"
    SIDE_SWITCH_REQUIRES_REVIEW = "SIDE_SWITCH_REQUIRES_REVIEW"
    RULES_CONFLICT = "RULES_CONFLICT"
    MATCH_CONTEXT_MISMATCH = "MATCH_CONTEXT_MISMATCH"
    RULESET_MISMATCH = "RULESET_MISMATCH"
    STALE_STATE = "STALE_STATE"
    SET_CONTEXT_MISMATCH = "SET_CONTEXT_MISMATCH"
    TERMINAL_STATE = "TERMINAL_STATE"
    PENDING_DOMAIN_OBLIGATIONS = "PENDING_DOMAIN_OBLIGATIONS"
    HUMAN_AUTHORIZATION_REQUIRED = "HUMAN_AUTHORIZATION_REQUIRED"


@dataclass(frozen=True, slots=True)
class ScoringIntent:
    """A non-authoritative recommendation that cannot mutate score."""

    kind: ScoringIntentKind
    winner_team: Team | None = None

    def __post_init__(self) -> None:
        if not isinstance(self.kind, ScoringIntentKind):
            raise ValueError("kind must be a ScoringIntentKind")
        if self.winner_team is not None and not isinstance(self.winner_team, Team):
            raise ValueError("winner_team must be Team A or B when present")
        if self.kind is ScoringIntentKind.AWARD_POINT:
            if self.winner_team is None:
                raise ValueError("AWARD_POINT requires winner_team")
        elif self.winner_team is not None:
            raise ValueError("RECORD_REPLAY_NO_POINT cannot contain winner_team")

    def canonical_dict(self) -> dict[str, str | None]:
        return {
            "kind": self.kind.value,
            "winner_team": self.winner_team.value if self.winner_team else None,
        }


@dataclass(frozen=True, slots=True)
class PolicyConfig:
    """Versioned integer-only release thresholds for a policy assessment."""

    policy_version: str
    human_authorization_threshold_ppm: int = 995_000
    review_threshold_ppm: int = 700_000
    minimum_reconciliation_probability_ppm: int = 900_000

    def __post_init__(self) -> None:
        if (
            type(self.policy_version) is not str
            or re.fullmatch(r"[\x21-\x7e]+", self.policy_version) is None
            or len(self.policy_version) > MAX_ID_LENGTH
        ):
            raise ValueError(
                "policy_version must be non-empty and at most 128 characters"
            )
        for field_name in (
            "human_authorization_threshold_ppm",
            "review_threshold_ppm",
            "minimum_reconciliation_probability_ppm",
        ):
            value = getattr(self, field_name)
            if type(value) is not int or not 0 <= value <= PPM_TOTAL:
                raise ValueError(f"{field_name} must be integer ppm in [0, 1000000]")
        if self.review_threshold_ppm > self.human_authorization_threshold_ppm:
            raise ValueError(
                "review threshold cannot exceed human-authorization threshold"
            )

    def canonical_dict(self) -> dict[str, str | int]:
        return {
            "human_authorization_threshold_ppm": (
                self.human_authorization_threshold_ppm
            ),
            "minimum_reconciliation_probability_ppm": (
                self.minimum_reconciliation_probability_ppm
            ),
            "policy_version": self.policy_version,
            "review_threshold_ppm": self.review_threshold_ppm,
        }

    def fingerprint(self) -> str:
        encoded = json.dumps(
            self.canonical_dict(),
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
        return hashlib.sha256(encoded).hexdigest()


@dataclass(frozen=True, slots=True)
class PolicyAssessment:
    """Reproducible policy output that is not an authorization or RuleEvent."""

    hypothesis_id: str
    hypothesis_fingerprint: str
    match_id: str
    rally_id: str
    set_number: int
    state_revision: int
    ruleset_fingerprint: str
    causal_cutoff_timestamp_ns: int
    policy_version: str
    policy_fingerprint: str
    status: PolicyAssessmentStatus
    reasons: tuple[PolicyReason, ...]
    recommended_intent: ScoringIntent | None
    evidence_refs: tuple[str, ...]
    reconciliation_outcome: NextServerOutcome | None = None
    reconciliation_fingerprint: str | None = None
    schema_version: str = "1.0"

    def __post_init__(self) -> None:
        for field_name in (
            "hypothesis_id",
            "match_id",
            "rally_id",
            "policy_version",
        ):
            value = getattr(self, field_name)
            if (
                type(value) is not str
                or len(value) > MAX_ID_LENGTH
                or re.fullmatch(r"[\x21-\x7e]+", value) is None
            ):
                raise ValueError(
                    f"{field_name} must be printable non-whitespace ASCII"
                )
        for field_name in (
            "hypothesis_fingerprint",
            "ruleset_fingerprint",
            "policy_fingerprint",
        ):
            if (
                type(getattr(self, field_name)) is not str
                or _SHA256_RE.fullmatch(getattr(self, field_name)) is None
            ):
                raise ValueError(
                    f"{field_name} must be a lowercase 64-character SHA-256"
                )
        if self.schema_version != "1.0":
            raise ValueError("schema_version must be exactly '1.0'")
        if (
            type(self.set_number) is not int
            or not 1 <= self.set_number <= MAX_SET_NUMBER
        ):
            raise ValueError(f"set_number must be in [1, {MAX_SET_NUMBER}]")
        if (
            type(self.state_revision) is not int
            or not 0 <= self.state_revision <= MAX_SEQUENCE_NUMBER
        ):
            raise ValueError("state_revision must be a non-negative signed 64-bit integer")
        if (
            type(self.causal_cutoff_timestamp_ns) is not int
            or not (
                0
                <= self.causal_cutoff_timestamp_ns
                <= MAX_SEQUENCE_NUMBER
            )
        ):
            raise ValueError(
                "causal_cutoff_timestamp_ns must be a non-negative signed 64-bit integer"
            )
        if not isinstance(self.status, PolicyAssessmentStatus):
            raise ValueError("status must be a PolicyAssessmentStatus")
        if type(self.reasons) is not tuple or not self.reasons or any(
            not isinstance(reason, PolicyReason) for reason in self.reasons
        ):
            raise ValueError("reasons must be a non-empty tuple of PolicyReason values")
        if len(set(self.reasons)) != len(self.reasons):
            raise ValueError("reasons cannot contain duplicates")
        object.__setattr__(
            self,
            "reasons",
            tuple(sorted(self.reasons, key=lambda reason: reason.value)),
        )
        if self.recommended_intent is not None and not isinstance(
            self.recommended_intent,
            ScoringIntent,
        ):
            raise ValueError("recommended_intent must be ScoringIntent when present")
        if (
            type(self.evidence_refs) is not tuple
            or not 1 <= len(self.evidence_refs) <= MAX_EVIDENCE_REFS
            or any(
                type(reference) is not str
                or len(reference) > MAX_EVIDENCE_REF_LENGTH
                or re.fullmatch(r"[\x21-\x7e]+", reference) is None
                for reference in self.evidence_refs
            )
        ):
            raise ValueError("evidence_refs must be a bounded tuple of ASCII references")
        if len(set(self.evidence_refs)) != len(self.evidence_refs):
            raise ValueError("evidence_refs cannot contain duplicates")
        object.__setattr__(self, "evidence_refs", tuple(sorted(self.evidence_refs)))
        reconciliation_present = self.reconciliation_outcome is not None
        if reconciliation_present != (self.reconciliation_fingerprint is not None):
            raise ValueError(
                "reconciliation outcome and fingerprint must be present together"
            )
        if (
            self.reconciliation_fingerprint is not None
            and (
                type(self.reconciliation_fingerprint) is not str
                or _SHA256_RE.fullmatch(self.reconciliation_fingerprint) is None
            )
        ):
            raise ValueError(
                "reconciliation_fingerprint must be a lowercase SHA-256 when present"
            )
        if self.reconciliation_outcome is not None and not isinstance(
            self.reconciliation_outcome,
            NextServerOutcome,
        ):
            raise ValueError("reconciliation_outcome must be NextServerOutcome")
        if self.status in {
            PolicyAssessmentStatus.PENDING,
            PolicyAssessmentStatus.UNRESOLVED,
        } and self.recommended_intent is not None:
            raise ValueError("pending or unresolved assessments cannot recommend an intent")
        if self.status is PolicyAssessmentStatus.HUMAN_AUTHORIZATION_REQUIRED:
            if (
                self.recommended_intent is None
                or self.recommended_intent.kind is not ScoringIntentKind.AWARD_POINT
            ):
                raise ValueError(
                    "HUMAN_AUTHORIZATION_REQUIRED requires a point recommendation"
                )
            if PolicyReason.HUMAN_AUTHORIZATION_REQUIRED not in self.reasons:
                raise ValueError(
                    "HUMAN_AUTHORIZATION_REQUIRED requires its explicit reason"
                )
            allowed_reasons = {
                PolicyReason.HUMAN_AUTHORIZATION_REQUIRED,
                PolicyReason.NEXT_SERVER_AMBIGUOUS,
            }
            if not set(self.reasons) <= allowed_reasons:
                raise ValueError(
                    "HUMAN_AUTHORIZATION_REQUIRED cannot contain exception or review reasons"
                )
            if self.reconciliation_outcome in {
                NextServerOutcome.CONTRADICTS,
                NextServerOutcome.SERVICE_ORDER_CONFLICT,
            }:
                raise ValueError(
                    "contradictory reconciliation cannot require authorization"
                )
            if (
                PolicyReason.NEXT_SERVER_AMBIGUOUS in self.reasons
                and self.reconciliation_outcome
                is not NextServerOutcome.AMBIGUOUS_SAME_SERVER
            ):
                raise ValueError(
                    "next-server ambiguity reason requires matching reconciliation"
                )
        elif PolicyReason.HUMAN_AUTHORIZATION_REQUIRED in self.reasons:
            raise ValueError(
                "human-authorization reason is reserved for its matching status"
            )

    def canonical_dict(self) -> dict[str, object]:
        return {
            "causal_cutoff_timestamp_ns": self.causal_cutoff_timestamp_ns,
            "evidence_refs": list(self.evidence_refs),
            "hypothesis_fingerprint": self.hypothesis_fingerprint,
            "hypothesis_id": self.hypothesis_id,
            "match_id": self.match_id,
            "policy_version": self.policy_version,
            "policy_fingerprint": self.policy_fingerprint,
            "rally_id": self.rally_id,
            "reasons": [reason.value for reason in self.reasons],
            "recommended_intent": (
                self.recommended_intent.canonical_dict()
                if self.recommended_intent is not None
                else None
            ),
            "reconciliation_fingerprint": self.reconciliation_fingerprint,
            "reconciliation_outcome": (
                self.reconciliation_outcome.value
                if self.reconciliation_outcome is not None
                else None
            ),
            "ruleset_fingerprint": self.ruleset_fingerprint,
            "schema_version": self.schema_version,
            "set_number": self.set_number,
            "state_revision": self.state_revision,
            "status": self.status.value,
        }

    def fingerprint(self) -> str:
        encoded = json.dumps(
            self.canonical_dict(),
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
        return hashlib.sha256(encoded).hexdigest()


_FATAL_EXCEPTION_REASONS = {
    ExceptionSignal.CAPTURE_GAP: PolicyReason.CAPTURE_GAP,
    ExceptionSignal.RULES_CONFLICT: PolicyReason.RULES_CONFLICT,
}
_REVIEW_EXCEPTION_REASONS = {
    ExceptionSignal.REPLAY_NO_POINT: PolicyReason.REPLAY_REQUIRES_REVIEW,
    ExceptionSignal.CHALLENGE: PolicyReason.CHALLENGE_REQUIRES_REVIEW,
    ExceptionSignal.CORRECTION: PolicyReason.CORRECTION_REQUIRES_REVIEW,
    ExceptionSignal.ADMINISTRATIVE_POINT: (
        PolicyReason.ADMINISTRATIVE_POINT_REQUIRES_REVIEW
    ),
    ExceptionSignal.TIMEOUT: PolicyReason.TIMEOUT_REQUIRES_REVIEW,
    ExceptionSignal.SIDE_SWITCH: PolicyReason.SIDE_SWITCH_REQUIRES_REVIEW,
}


def _intent_for_outcome(outcome: RallyOutcome) -> ScoringIntent | None:
    if outcome.winner is not None:
        return ScoringIntent(ScoringIntentKind.AWARD_POINT, outcome.winner)
    if outcome is RallyOutcome.REPLAY_NO_POINT:
        return ScoringIntent(ScoringIntentKind.RECORD_REPLAY_NO_POINT)
    return None


def _unique_reasons(reasons: list[PolicyReason]) -> tuple[PolicyReason, ...]:
    return tuple(sorted(set(reasons), key=lambda reason: reason.value))


def _make_assessment(
    hypothesis: RallyHypothesis,
    config: PolicyConfig,
    status: PolicyAssessmentStatus,
    reasons: list[PolicyReason],
    *,
    intent: ScoringIntent | None = None,
    reconciliation: NextServerReconciliation | None = None,
) -> PolicyAssessment:
    evidence_refs = [item.evidence_ref for item in hypothesis.evidence]
    if (
        reconciliation is not None
        and reconciliation.evidence_ref is not None
        and reconciliation.evidence_ref not in evidence_refs
    ):
        evidence_refs.append(reconciliation.evidence_ref)
    if len(evidence_refs) > MAX_EVIDENCE_REFS:
        raise ValueError(
            "combined hypothesis and reconciliation evidence exceeds the bounded limit"
        )
    return PolicyAssessment(
        hypothesis_id=hypothesis.hypothesis_id,
        hypothesis_fingerprint=hypothesis.fingerprint(),
        match_id=hypothesis.match_id,
        rally_id=hypothesis.rally_id,
        set_number=hypothesis.set_number,
        state_revision=hypothesis.state_revision,
        ruleset_fingerprint=hypothesis.ruleset_fingerprint,
        causal_cutoff_timestamp_ns=max(
            hypothesis.causal_cutoff_timestamp_ns,
            (
                reconciliation.causal_cutoff_timestamp_ns
                if reconciliation is not None
                else hypothesis.causal_cutoff_timestamp_ns
            ),
        ),
        policy_version=config.policy_version,
        policy_fingerprint=config.fingerprint(),
        status=status,
        reasons=_unique_reasons(reasons),
        recommended_intent=intent,
        evidence_refs=tuple(evidence_refs),
        reconciliation_outcome=(
            reconciliation.outcome if reconciliation is not None else None
        ),
        reconciliation_fingerprint=(
            reconciliation.fingerprint() if reconciliation is not None else None
        ),
    )


def assess_hypothesis(
    *,
    hypothesis: RallyHypothesis,
    state: MatchState,
    config: PolicyConfig,
    reconciliation: NextServerReconciliation | None = None,
) -> PolicyAssessment:
    """Screen exceptions, then recommend an intent without authorizing an event."""

    if not isinstance(hypothesis, RallyHypothesis):
        raise ValueError("hypothesis must be a RallyHypothesis")
    if not isinstance(state, MatchState):
        raise ValueError("state must be a MatchState")
    if not isinstance(config, PolicyConfig):
        raise ValueError("config must be a PolicyConfig")
    if reconciliation is not None and not isinstance(
        reconciliation,
        NextServerReconciliation,
    ):
        raise ValueError("reconciliation must be NextServerReconciliation or None")

    fatal_reasons: list[PolicyReason] = []
    if hypothesis.match_id != state.match_id:
        fatal_reasons.append(PolicyReason.MATCH_CONTEXT_MISMATCH)
    if hypothesis.ruleset_fingerprint != state.ruleset_fingerprint:
        fatal_reasons.append(PolicyReason.RULESET_MISMATCH)
    if hypothesis.state_revision != state.revision:
        fatal_reasons.append(PolicyReason.STALE_STATE)
    current = state.current_set
    if current is None or current.number != hypothesis.set_number:
        fatal_reasons.append(PolicyReason.SET_CONTEXT_MISMATCH)
    if state.match_complete or (
        current is not None and current.phase is SetPhase.COMPLETE
    ):
        fatal_reasons.append(PolicyReason.TERMINAL_STATE)
    for signal in hypothesis.exception_signals:
        reason = _FATAL_EXCEPTION_REASONS.get(signal)
        if reason is not None:
            fatal_reasons.append(reason)
    if reconciliation is not None and (
        reconciliation.hypothesis_id != hypothesis.hypothesis_id
        or reconciliation.hypothesis_fingerprint != hypothesis.fingerprint()
        or reconciliation.match_id != hypothesis.match_id
        or reconciliation.rally_id != hypothesis.rally_id
        or reconciliation.set_number != hypothesis.set_number
        or reconciliation.state_revision != hypothesis.state_revision
    ):
        fatal_reasons.append(PolicyReason.RECONCILIATION_CONTEXT_MISMATCH)
    if reconciliation is not None and reconciliation.evidence is not None:
        same_reference = tuple(
            item
            for item in hypothesis.evidence
            if item.evidence_ref == reconciliation.evidence.evidence_ref
        )
        if same_reference and same_reference[0] != reconciliation.evidence:
            fatal_reasons.append(PolicyReason.EVIDENCE_PROVENANCE_CONFLICT)

    review_reasons: list[PolicyReason] = []
    if current is not None and current.pending_effects:
        review_reasons.append(PolicyReason.PENDING_DOMAIN_OBLIGATIONS)
    for signal in hypothesis.exception_signals:
        reason = _REVIEW_EXCEPTION_REASONS.get(signal)
        if reason is not None:
            review_reasons.append(reason)
    if fatal_reasons:
        return _make_assessment(
            hypothesis,
            config,
            PolicyAssessmentStatus.UNRESOLVED,
            fatal_reasons + review_reasons,
            reconciliation=reconciliation,
        )
    if review_reasons:
        intent = None
        if (
            ExceptionSignal.REPLAY_NO_POINT in hypothesis.exception_signals
            and hypothesis.leading_outcome is RallyOutcome.REPLAY_NO_POINT
        ):
            intent = ScoringIntent(ScoringIntentKind.RECORD_REPLAY_NO_POINT)
        return _make_assessment(
            hypothesis,
            config,
            PolicyAssessmentStatus.REVIEW_REQUIRED,
            review_reasons,
            intent=intent,
            reconciliation=reconciliation,
        )

    outcome = hypothesis.leading_outcome
    if outcome is None:
        return _make_assessment(
            hypothesis,
            config,
            PolicyAssessmentStatus.PENDING,
            [PolicyReason.AMBIGUOUS_OUTCOME],
            reconciliation=reconciliation,
        )
    if outcome is RallyOutcome.UNRESOLVED:
        return _make_assessment(
            hypothesis,
            config,
            PolicyAssessmentStatus.UNRESOLVED,
            [PolicyReason.MODEL_UNRESOLVED],
            reconciliation=reconciliation,
        )
    if outcome is RallyOutcome.REPLAY_NO_POINT:
        return _make_assessment(
            hypothesis,
            config,
            PolicyAssessmentStatus.REVIEW_REQUIRED,
            [PolicyReason.REPLAY_REQUIRES_REVIEW],
            intent=_intent_for_outcome(outcome),
            reconciliation=reconciliation,
        )

    intent = _intent_for_outcome(outcome)
    assert intent is not None  # RallyOutcome exhaustiveness after non-point returns.
    probability_ppm = hypothesis.probability_ppm(outcome)

    if reconciliation is not None and (
        reconciliation.observed_probability_ppm is not None
        and reconciliation.observed_probability_ppm
        >= config.minimum_reconciliation_probability_ppm
    ):
        if reconciliation.outcome is NextServerOutcome.CONTRADICTS:
            return _make_assessment(
                hypothesis,
                config,
                PolicyAssessmentStatus.REVIEW_REQUIRED,
                [PolicyReason.NEXT_SERVER_CONTRADICTION],
                intent=intent,
                reconciliation=reconciliation,
            )
        if reconciliation.outcome is NextServerOutcome.SERVICE_ORDER_CONFLICT:
            return _make_assessment(
                hypothesis,
                config,
                PolicyAssessmentStatus.REVIEW_REQUIRED,
                [PolicyReason.SERVICE_ORDER_CONFLICT],
                intent=intent,
                reconciliation=reconciliation,
            )

    if not hypothesis.has_primary_point_evidence:
        reasons = [PolicyReason.PRIMARY_POINT_EVIDENCE_REQUIRED]
        status = (
            PolicyAssessmentStatus.REVIEW_REQUIRED
            if probability_ppm >= config.review_threshold_ppm
            else PolicyAssessmentStatus.PENDING
        )
        return _make_assessment(
            hypothesis,
            config,
            status,
            reasons,
            intent=(intent if status is PolicyAssessmentStatus.REVIEW_REQUIRED else None),
            reconciliation=reconciliation,
        )

    if probability_ppm >= config.human_authorization_threshold_ppm:
        reasons = [PolicyReason.HUMAN_AUTHORIZATION_REQUIRED]
        if (
            reconciliation is not None
            and reconciliation.outcome is NextServerOutcome.AMBIGUOUS_SAME_SERVER
        ):
            reasons.append(PolicyReason.NEXT_SERVER_AMBIGUOUS)
        return _make_assessment(
            hypothesis,
            config,
            PolicyAssessmentStatus.HUMAN_AUTHORIZATION_REQUIRED,
            reasons,
            intent=intent,
            reconciliation=reconciliation,
        )
    if probability_ppm >= config.review_threshold_ppm:
        return _make_assessment(
            hypothesis,
            config,
            PolicyAssessmentStatus.REVIEW_REQUIRED,
            [PolicyReason.INSUFFICIENT_CONFIDENCE],
            intent=intent,
            reconciliation=reconciliation,
        )
    return _make_assessment(
        hypothesis,
        config,
        PolicyAssessmentStatus.PENDING,
        [PolicyReason.WAITING_FOR_EVIDENCE],
        reconciliation=reconciliation,
    )
