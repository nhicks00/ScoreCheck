"""Next-server evidence reconciliation without point or authorization authority."""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from enum import Enum

from .domain_events import (
    MAX_ID_LENGTH,
    MAX_SEQUENCE_NUMBER,
    MAX_SET_NUMBER,
    Team,
)
from .hypotheses import (
    PPM_TOTAL,
    EvidenceKind,
    EvidenceProvenance,
    HypothesisModelProvenance,
    RallyHypothesis,
)
from .rules import MatchState, SetPhase


class NextServerOutcome(str, Enum):
    """What next-server evidence says about an independently inferred point."""

    CORROBORATES = "CORROBORATES"
    CONTRADICTS = "CONTRADICTS"
    AMBIGUOUS_SAME_SERVER = "AMBIGUOUS_SAME_SERVER"
    SERVICE_ORDER_CONFLICT = "SERVICE_ORDER_CONFLICT"
    NOT_APPLICABLE_TERMINAL = "NOT_APPLICABLE_TERMINAL"
    UNAVAILABLE = "UNAVAILABLE"


@dataclass(frozen=True, slots=True)
class NextServerObservation:
    """One identified post-rally server observation."""

    match_id: str
    rally_id: str
    set_number: int
    state_revision: int
    team: Team
    player_id: str
    probability_ppm: int
    evidence: EvidenceProvenance
    model: HypothesisModelProvenance

    def __post_init__(self) -> None:
        for value, field_name in (
            (self.match_id, "match_id"),
            (self.rally_id, "rally_id"),
        ):
            if (
                type(value) is not str
                or len(value) > MAX_ID_LENGTH
                or re.fullmatch(r"[\x21-\x7e]+", value) is None
            ):
                raise ValueError(
                    f"{field_name} must be printable non-whitespace ASCII"
                )
        if (
            type(self.set_number) is not int
            or not 1 <= self.set_number <= MAX_SET_NUMBER
        ):
            raise ValueError(f"set_number must be in [1, {MAX_SET_NUMBER}]")
        if (
            type(self.state_revision) is not int
            or not 0 <= self.state_revision <= MAX_SEQUENCE_NUMBER
        ):
            raise ValueError(
                "state_revision must be a non-negative signed 64-bit integer"
            )
        if not isinstance(self.team, Team):
            raise ValueError("team must be Team A or B")
        if (
            type(self.player_id) is not str
            or re.fullmatch(r"[\x21-\x7e]+", self.player_id) is None
            or len(self.player_id) > MAX_ID_LENGTH
        ):
            raise ValueError(
                f"player_id must be non-empty and at most {MAX_ID_LENGTH} characters"
            )
        if (
            type(self.probability_ppm) is not int
            or not 0 <= self.probability_ppm <= PPM_TOTAL
        ):
            raise ValueError("probability_ppm must be an integer in [0, 1000000]")
        if not isinstance(self.evidence, EvidenceProvenance):
            raise ValueError("evidence must be EvidenceProvenance")
        if self.evidence.kind is not EvidenceKind.NEXT_SERVER:
            raise ValueError("next-server observations require NEXT_SERVER evidence")
        if not isinstance(self.model, HypothesisModelProvenance):
            raise ValueError("model must be HypothesisModelProvenance")


@dataclass(frozen=True, slots=True)
class NextServerReconciliation:
    """A reproducible comparison that is never itself authorization-ready."""

    hypothesis_id: str
    hypothesis_fingerprint: str
    match_id: str
    rally_id: str
    set_number: int
    state_revision: int
    causal_cutoff_timestamp_ns: int
    outcome: NextServerOutcome
    expected_team: Team | None
    expected_player_id: str | None
    observed_team: Team | None
    observed_player_id: str | None
    observed_probability_ppm: int | None
    evidence: EvidenceProvenance | None
    model: HypothesisModelProvenance | None
    schema_version: str = "1.0"

    def __post_init__(self) -> None:
        if (
            type(self.hypothesis_id) is not str
            or len(self.hypothesis_id) > MAX_ID_LENGTH
            or re.fullmatch(r"[\x21-\x7e]+", self.hypothesis_id) is None
        ):
            raise ValueError("hypothesis_id must be printable non-whitespace ASCII")
        if self.schema_version != "1.0":
            raise ValueError("schema_version must be exactly '1.0'")
        for value, field_name in (
            (self.match_id, "match_id"),
            (self.rally_id, "rally_id"),
        ):
            if (
                type(value) is not str
                or len(value) > MAX_ID_LENGTH
                or re.fullmatch(r"[\x21-\x7e]+", value) is None
            ):
                raise ValueError(
                    f"{field_name} must be printable non-whitespace ASCII"
                )
        if (
            type(self.set_number) is not int
            or not 1 <= self.set_number <= MAX_SET_NUMBER
        ):
            raise ValueError(f"set_number must be in [1, {MAX_SET_NUMBER}]")
        if (
            type(self.hypothesis_fingerprint) is not str
            or re.fullmatch(r"[0-9a-f]{64}", self.hypothesis_fingerprint) is None
        ):
            raise ValueError(
                "hypothesis_fingerprint must be a lowercase 64-character SHA-256"
            )
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
        if not isinstance(self.outcome, NextServerOutcome):
            raise ValueError("outcome must be a NextServerOutcome")
        if (self.expected_team is None) != (self.expected_player_id is None):
            raise ValueError("expected server team and player must be present together")
        if (self.observed_team is None) != (self.observed_player_id is None):
            raise ValueError("observed server team and player must be present together")
        for team, field_name in (
            (self.expected_team, "expected_team"),
            (self.observed_team, "observed_team"),
        ):
            if team is not None and not isinstance(team, Team):
                raise ValueError(f"{field_name} must be Team A or B when present")
        for player_id, field_name in (
            (self.expected_player_id, "expected_player_id"),
            (self.observed_player_id, "observed_player_id"),
        ):
            if player_id is not None and (
                type(player_id) is not str
                or re.fullmatch(r"[\x21-\x7e]+", player_id) is None
                or len(player_id) > MAX_ID_LENGTH
            ):
                raise ValueError(f"{field_name} is invalid")
        observation_fields = (
            self.observed_team,
            self.observed_probability_ppm,
            self.evidence,
            self.model,
        )
        if any(value is None for value in observation_fields) and not all(
            value is None for value in observation_fields
        ):
            raise ValueError("observed server, probability, and evidence must be present together")
        if self.observed_probability_ppm is not None and (
            type(self.observed_probability_ppm) is not int
            or not 0 <= self.observed_probability_ppm <= PPM_TOTAL
        ):
            raise ValueError("observed_probability_ppm must be integer ppm when present")
        if self.evidence is not None:
            if not isinstance(self.evidence, EvidenceProvenance):
                raise ValueError("evidence must be EvidenceProvenance when present")
            if self.evidence.kind is not EvidenceKind.NEXT_SERVER:
                raise ValueError("reconciliation requires NEXT_SERVER evidence")
            if self.evidence.captured_at_ns > self.causal_cutoff_timestamp_ns:
                raise ValueError("evidence exceeds causal_cutoff_timestamp_ns")
        if self.model is not None and not isinstance(
            self.model,
            HypothesisModelProvenance,
        ):
            raise ValueError("model must be HypothesisModelProvenance when present")
        if self.outcome in {
            NextServerOutcome.CORROBORATES,
            NextServerOutcome.CONTRADICTS,
            NextServerOutcome.AMBIGUOUS_SAME_SERVER,
            NextServerOutcome.SERVICE_ORDER_CONFLICT,
        } and (self.expected_team is None or self.observed_team is None):
            raise ValueError(f"{self.outcome.value} requires expected and observed servers")
        if self.outcome in {
            NextServerOutcome.UNAVAILABLE,
            NextServerOutcome.NOT_APPLICABLE_TERMINAL,
        } and self.expected_team is not None:
            raise ValueError(f"{self.outcome.value} cannot contain an expected server")
        if self.outcome is NextServerOutcome.CONTRADICTS and (
            self.expected_team is self.observed_team
        ):
            raise ValueError("CONTRADICTS requires different expected and observed teams")
        if self.outcome is NextServerOutcome.SERVICE_ORDER_CONFLICT and (
            self.expected_team is not self.observed_team
            or self.expected_player_id == self.observed_player_id
        ):
            raise ValueError(
                "SERVICE_ORDER_CONFLICT requires the expected team and a different player"
            )
        if self.outcome in {
            NextServerOutcome.CORROBORATES,
            NextServerOutcome.AMBIGUOUS_SAME_SERVER,
        } and (
            self.expected_team is not self.observed_team
            or self.expected_player_id != self.observed_player_id
        ):
            raise ValueError(f"{self.outcome.value} requires an exact server match")

    def canonical_dict(self) -> dict[str, object]:
        return {
            "causal_cutoff_timestamp_ns": self.causal_cutoff_timestamp_ns,
            "evidence": (
                self.evidence.canonical_dict() if self.evidence is not None else None
            ),
            "expected_player_id": self.expected_player_id,
            "expected_team": (
                self.expected_team.value if self.expected_team is not None else None
            ),
            "hypothesis_fingerprint": self.hypothesis_fingerprint,
            "hypothesis_id": self.hypothesis_id,
            "match_id": self.match_id,
            "model": self.model.canonical_dict() if self.model is not None else None,
            "observed_player_id": self.observed_player_id,
            "observed_probability_ppm": self.observed_probability_ppm,
            "observed_team": (
                self.observed_team.value if self.observed_team is not None else None
            ),
            "outcome": self.outcome.value,
            "rally_id": self.rally_id,
            "schema_version": self.schema_version,
            "set_number": self.set_number,
            "state_revision": self.state_revision,
        }

    @property
    def evidence_ref(self) -> str | None:
        return self.evidence.evidence_ref if self.evidence is not None else None

    def fingerprint(self) -> str:
        encoded = json.dumps(
            self.canonical_dict(),
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
        return hashlib.sha256(encoded).hexdigest()


def _would_complete_set(state: MatchState, winner: Team) -> bool:
    current = state.current_set
    if current is None:
        return False
    team_a_points = current.team_a_points + (1 if winner is Team.A else 0)
    team_b_points = current.team_b_points + (1 if winner is Team.B else 0)
    return (
        max(team_a_points, team_b_points) >= current.target_points
        and abs(team_a_points - team_b_points) >= current.win_by
    )


def _result(
    hypothesis: RallyHypothesis,
    outcome: NextServerOutcome,
    *,
    expected_team: Team | None = None,
    expected_player_id: str | None = None,
    observation: NextServerObservation | None = None,
) -> NextServerReconciliation:
    return NextServerReconciliation(
        hypothesis_id=hypothesis.hypothesis_id,
        hypothesis_fingerprint=hypothesis.fingerprint(),
        match_id=hypothesis.match_id,
        rally_id=hypothesis.rally_id,
        set_number=hypothesis.set_number,
        state_revision=hypothesis.state_revision,
        causal_cutoff_timestamp_ns=max(
            hypothesis.causal_cutoff_timestamp_ns,
            (
                observation.evidence.captured_at_ns
                if observation is not None
                else hypothesis.causal_cutoff_timestamp_ns
            ),
        ),
        outcome=outcome,
        expected_team=expected_team,
        expected_player_id=expected_player_id,
        observed_team=observation.team if observation is not None else None,
        observed_player_id=observation.player_id if observation is not None else None,
        observed_probability_ppm=(
            observation.probability_ppm if observation is not None else None
        ),
        evidence=observation.evidence if observation is not None else None,
        model=observation.model if observation is not None else None,
    )


def reconcile_next_server(
    *,
    hypothesis: RallyHypothesis,
    state: MatchState,
    observation: NextServerObservation | None,
) -> NextServerReconciliation:
    """Compare next-server evidence to a point hypothesis without upgrading it.

    Context mismatches are programmer/dataflow errors. Policy separately treats a
    stale hypothesis as unresolved before consulting a reconciliation result.
    """

    if not isinstance(hypothesis, RallyHypothesis):
        raise ValueError("hypothesis must be a RallyHypothesis")
    if not isinstance(state, MatchState):
        raise ValueError("state must be a MatchState")
    if observation is not None and not isinstance(observation, NextServerObservation):
        raise ValueError("observation must be NextServerObservation or None")
    if hypothesis.match_id != state.match_id:
        raise ValueError("hypothesis and state match ids differ")
    if hypothesis.state_revision != state.revision:
        raise ValueError("hypothesis and state revisions differ")
    if hypothesis.ruleset_fingerprint != state.ruleset_fingerprint:
        raise ValueError("hypothesis and state ruleset fingerprints differ")
    if state.current_set is None or hypothesis.set_number != state.current_set.number:
        raise ValueError("hypothesis set number does not match the active set")
    if observation is not None:
        if (
            observation.match_id != hypothesis.match_id
            or observation.rally_id != hypothesis.rally_id
            or observation.set_number != hypothesis.set_number
            or observation.state_revision != hypothesis.state_revision
        ):
            raise ValueError(
                "next-server observation context does not match the hypothesis"
            )
        if observation.evidence.captured_at_ns < hypothesis.causal_cutoff_timestamp_ns:
            raise ValueError(
                "next-server observation must occur at or after the rally cutoff"
            )
        if any(
            item.evidence_ref == observation.evidence.evidence_ref
            for item in hypothesis.evidence
        ):
            raise ValueError(
                "next-server evidence reference must be distinct from hypothesis evidence"
            )
    winner = hypothesis.proposed_winner
    current = state.current_set
    if state.match_complete or (
        current is not None
        and (
            current.phase is SetPhase.COMPLETE
            or (
                winner is not None
                and _would_complete_set(state, winner)
            )
        )
    ):
        return _result(
            hypothesis,
            NextServerOutcome.NOT_APPLICABLE_TERMINAL,
            observation=observation,
        )
    if winner is None or current is None or observation is None:
        return _result(
            hypothesis,
            NextServerOutcome.UNAVAILABLE,
            observation=observation,
        )

    if winner is current.serving_team:
        expected_team = current.serving_team
        expected_player_id = current.serving_player
    else:
        expected_team = winner
        expected_player_id = current.expected_next_server(winner)

    if observation.team is not expected_team:
        outcome = NextServerOutcome.CONTRADICTS
    elif observation.player_id != expected_player_id:
        outcome = NextServerOutcome.SERVICE_ORDER_CONFLICT
    elif winner is current.serving_team:
        # The same server follows both a serving-team point and replay/no-point.
        outcome = NextServerOutcome.AMBIGUOUS_SAME_SERVER
    else:
        outcome = NextServerOutcome.CORROBORATES
    return _result(
        hypothesis,
        outcome,
        expected_team=expected_team,
        expected_player_id=expected_player_id,
        observation=observation,
    )
