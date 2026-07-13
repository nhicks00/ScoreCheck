"""Conservative structural evidence for a quantized presentation-time grid.

This module deliberately answers only one narrow question: can one complete,
strictly increasing presentation-order PTS sequence have been produced by
quantizing a fixed-phase grid at exactly one supported target rate?  It does
not call the input CFR and it grants no admission or scoring authority.

For target-period ``N / D`` ticks in lowest terms and normalized PTS ``z_i``,
the unknown fixed phase ``r`` must satisfy, for every sample::

    D * z_i <= i * N + r < D * (z_i + 1)

The implementation intersects those half-open intervals using exact integer
arithmetic.  Only the running intersection for each of four candidates is
retained, so an iterator is consumed once without retaining its rows.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
import hashlib
import hmac
import json
import math
from typing import Iterable


MAX_SIGNED_64 = (1 << 63) - 1
MIN_SIGNED_64 = -(1 << 63)
MAX_PRESENTATION_TIMESTAMP_COUNT = 10_000_000
MIN_TARGET_SECONDS = 10

PROOF_SCOPE_STATEMENT = (
    "Untrusted structural claim only: the presentation timestamps are consistent "
    "with one fixed-phase quantized target-rate grid. It does not prove "
    "sensor CFR, complete capture, the absence of dropped, duplicated, or "
    "interpolated frames or splices, or pixel-content uniqueness."
)

ORDERED_PTS_ROWS_DOMAIN = (
    "multicourt-vision-scoring:ordered-presentation-timestamp-rows:v1"
)
UNTRUSTED_CLAIM_DOMAIN = (
    "multicourt-vision-scoring:untrusted-quantized-pts-grid-claim:v1"
)

_TARGET_RATES: tuple[tuple[int, int], ...] = (
    (30, 1),
    (30_000, 1_001),
    (60, 1),
    (60_000, 1_001),
)


class QuantizedPtsGridUntrustedClaimStatusV1(str, Enum):
    UNTRUSTED_CLAIM_QUANTIZED_PTS_GRID_CONSISTENT_WITH_RATE = (
        "UNTRUSTED_CLAIM_QUANTIZED_PTS_GRID_CONSISTENT_WITH_RATE"
    )
    UNTRUSTED_CLAIM_QUANTIZED_PTS_GRID_ABSTAINED = (
        "UNTRUSTED_CLAIM_QUANTIZED_PTS_GRID_ABSTAINED"
    )


class QuantizedPtsGridUntrustedClaimAbstentionV1(str, Enum):
    INVALID_TIMEBASE = "INVALID_TIMEBASE"
    UNSUPPORTED_TIMEBASE = "UNSUPPORTED_TIMEBASE"
    INVALID_PRESENTATION_TIMESTAMPS = "INVALID_PRESENTATION_TIMESTAMPS"
    PRESENTATION_TIMESTAMP_LIMIT_EXCEEDED = "PRESENTATION_TIMESTAMP_LIMIT_EXCEEDED"
    INSUFFICIENT_EVIDENCE = "INSUFFICIENT_EVIDENCE"
    NO_CONSISTENT_RATE = "NO_CONSISTENT_RATE"
    AMBIGUOUS_RATE = "AMBIGUOUS_RATE"


def _require_exact_int(value: object, field_name: str) -> int:
    if type(value) is not int:
        raise ValueError(f"{field_name} must be an exact integer")
    return value


def _require_bounded_int(value: object, field_name: str) -> int:
    integer = _require_exact_int(value, field_name)
    if integer < MIN_SIGNED_64 or integer > MAX_SIGNED_64:
        raise ValueError(f"{field_name} must fit a signed 64-bit integer")
    return integer


def _require_sha256(value: object, field_name: str) -> str:
    if (
        type(value) is not str
        or len(value) != 64
        or any(character not in "0123456789abcdef" for character in value)
    ):
        raise ValueError(f"{field_name} must be an exact lowercase SHA-256 digest")
    return value


@dataclass(slots=True)
class _OrderedPtsDigestAccumulator:
    """Streaming canonical digest over an ordered validated PTS prefix."""

    _hasher: object
    count: int = 0

    @classmethod
    def create(cls) -> _OrderedPtsDigestAccumulator:
        hasher = hashlib.sha256()
        domain = ORDERED_PTS_ROWS_DOMAIN.encode("ascii")
        hasher.update(len(domain).to_bytes(4, "big"))
        hasher.update(domain)
        return cls(_hasher=hasher)

    def add(self, pts: int) -> None:
        # Fixed-width framing makes row order, row index, and signed value exact.
        self._hasher.update(b"R")  # type: ignore[attr-defined]
        self._hasher.update(self.count.to_bytes(8, "big"))  # type: ignore[attr-defined]
        self._hasher.update(pts.to_bytes(8, "big", signed=True))  # type: ignore[attr-defined]
        self.count += 1

    def hexdigest(self) -> str:
        final = self._hasher.copy()  # type: ignore[attr-defined]
        final.update(b"C")
        final.update(self.count.to_bytes(8, "big"))
        return final.hexdigest()


def _empty_ordered_pts_sha256() -> str:
    return _OrderedPtsDigestAccumulator.create().hexdigest()


def _parse_timebase(numerator: object, denominator: object) -> tuple[int, int] | None:
    try:
        parsed_numerator = _require_bounded_int(numerator, "timebase_numerator")
        parsed_denominator = _require_bounded_int(denominator, "timebase_denominator")
    except ValueError:
        return None
    if parsed_numerator <= 0 or parsed_denominator <= 0:
        return None
    if math.gcd(parsed_numerator, parsed_denominator) != 1:
        return None
    return parsed_numerator, parsed_denominator


def _reduced_period_ticks(
    timebase: tuple[int, int], rate: tuple[int, int]
) -> tuple[int, int]:
    timebase_numerator, timebase_denominator = timebase
    rate_numerator, rate_denominator = rate
    numerator = timebase_denominator * rate_denominator
    denominator = timebase_numerator * rate_numerator
    divisor = math.gcd(numerator, denominator)
    return numerator // divisor, denominator // divisor


def _timebase_supports_rate(timebase: tuple[int, int], rate: tuple[int, int]) -> bool:
    timebase_numerator, timebase_denominator = timebase
    rate_numerator, rate_denominator = rate
    return (
        1_000 * timebase_numerator <= timebase_denominator
        and 16 * timebase_numerator * rate_numerator
        <= timebase_denominator * rate_denominator
    )


@dataclass(frozen=True, slots=True)
class QuantizedPtsGridUntrustedCandidateClaimV1:
    """Untrusted exact phase-intersection claim for one supported target rate."""

    timebase_numerator: int
    timebase_denominator: int
    rate_numerator: int
    rate_denominator: int
    target_period_ticks_numerator: int
    target_period_ticks_denominator: int
    phase_lower_numerator: int
    phase_upper_exclusive_numerator: int
    phase_denominator: int
    presentation_timestamp_count: int
    interval_count: int
    presentation_span_ticks: int
    evidence_sufficient: bool

    def __post_init__(self) -> None:
        timebase = _parse_timebase(self.timebase_numerator, self.timebase_denominator)
        if timebase is None:
            raise ValueError(
                "candidate timebase must be positive, bounded, and reduced"
            )
        _require_exact_int(self.rate_numerator, "rate_numerator")
        _require_exact_int(self.rate_denominator, "rate_denominator")
        rate = (self.rate_numerator, self.rate_denominator)
        if rate not in _TARGET_RATES:
            raise ValueError("candidate rate must be one exact supported target rate")
        if not _timebase_supports_rate(timebase, rate):
            raise ValueError("candidate timebase does not resolve its target rate")
        for name in (
            "target_period_ticks_numerator",
            "target_period_ticks_denominator",
            "phase_denominator",
        ):
            if _require_exact_int(getattr(self, name), name) <= 0:
                raise ValueError(f"{name} must be positive")
        for name in (
            "phase_lower_numerator",
            "phase_upper_exclusive_numerator",
            "presentation_timestamp_count",
            "interval_count",
            "presentation_span_ticks",
        ):
            if _require_exact_int(getattr(self, name), name) < 0:
                raise ValueError(f"{name} must be nonnegative")
        expected_period = _reduced_period_ticks(timebase, rate)
        if (
            self.target_period_ticks_numerator,
            self.target_period_ticks_denominator,
        ) != expected_period:
            raise ValueError("candidate target period is not the exact reduced period")
        if self.phase_denominator != expected_period[1]:
            raise ValueError(
                "phase_denominator must equal the reduced grid denominator"
            )
        if not (
            0
            <= self.phase_lower_numerator
            < self.phase_upper_exclusive_numerator
            <= self.phase_denominator
        ):
            raise ValueError("phase interval must be a non-empty subset of [0, D)")
        if self.presentation_timestamp_count > MAX_PRESENTATION_TIMESTAMP_COUNT:
            raise ValueError("candidate timestamp count exceeds the checked limit")
        if self.interval_count != max(0, self.presentation_timestamp_count - 1):
            raise ValueError("candidate interval count does not match timestamp count")
        if self.presentation_timestamp_count == 0:
            if self.presentation_span_ticks != 0:
                raise ValueError("an empty candidate must have zero span")
        elif self.presentation_timestamp_count == 1:
            if self.presentation_span_ticks != 0:
                raise ValueError("a one-row candidate must have zero span")
        elif self.presentation_span_ticks <= 0:
            raise ValueError("a multi-row candidate must have positive span")
        expected_sufficient = (
            self.interval_count >= expected_period[1]
            and self.interval_count * self.rate_denominator
            >= MIN_TARGET_SECONDS * self.rate_numerator
        )
        if (
            type(self.evidence_sufficient) is not bool
            or self.evidence_sufficient is not expected_sufficient
        ):
            raise ValueError("evidence_sufficient must equal the exact evidence floor")

    def _canonical_payload(self) -> dict[str, object]:
        return {
            "timebase_numerator": self.timebase_numerator,
            "timebase_denominator": self.timebase_denominator,
            "rate_numerator": self.rate_numerator,
            "rate_denominator": self.rate_denominator,
            "target_period_ticks_numerator": self.target_period_ticks_numerator,
            "target_period_ticks_denominator": self.target_period_ticks_denominator,
            "phase_lower_numerator": self.phase_lower_numerator,
            "phase_upper_exclusive_numerator": self.phase_upper_exclusive_numerator,
            "phase_denominator": self.phase_denominator,
            "presentation_timestamp_count": self.presentation_timestamp_count,
            "interval_count": self.interval_count,
            "presentation_span_ticks": self.presentation_span_ticks,
            "evidence_sufficient": self.evidence_sufficient,
        }


@dataclass(frozen=True, slots=True)
class QuantizedPtsGridUntrustedClaimV1:
    """Untrusted claim requiring replay validation before any reliance.

    ``frozen=True`` prevents accidental assignment only; it is not an
    authenticity boundary. Callers must invoke ``validate_against`` with the
    source PTS iterable and timebase. An accepted claim binds the complete
    iterable; an abstention binds only its validated prefix and reason.
    """

    untrusted_claim_status: QuantizedPtsGridUntrustedClaimStatusV1
    abstention_reason: QuantizedPtsGridUntrustedClaimAbstentionV1 | None
    timebase_numerator: int | None
    timebase_denominator: int | None
    origin_pts: int | None
    presentation_timestamp_count: int
    interval_count: int
    presentation_span_ticks: int
    ordered_validated_pts_sha256: str
    consistent_candidate_claims: tuple[QuantizedPtsGridUntrustedCandidateClaimV1, ...]
    matched_candidate_claim: QuantizedPtsGridUntrustedCandidateClaimV1 | None
    proof_scope: str = PROOF_SCOPE_STATEMENT
    admissible_for_training: bool = False
    admissible_for_evaluation: bool = False
    admissible_for_test: bool = False
    admissible_for_deployment: bool = False
    admissible_for_live_scoring: bool = False

    def __post_init__(self) -> None:
        if (
            type(self.untrusted_claim_status)
            is not QuantizedPtsGridUntrustedClaimStatusV1
        ):
            raise ValueError("untrusted_claim_status must be an exact claim status")
        if (
            self.abstention_reason is not None
            and type(self.abstention_reason)
            is not QuantizedPtsGridUntrustedClaimAbstentionV1
        ):
            raise ValueError("abstention_reason has the wrong type")
        if (self.timebase_numerator is None) != (self.timebase_denominator is None):
            raise ValueError(
                "timebase numerator and denominator must be present together"
            )
        timebase = (
            None
            if self.timebase_numerator is None
            else _parse_timebase(self.timebase_numerator, self.timebase_denominator)
        )
        if self.timebase_numerator is not None and timebase is None:
            raise ValueError("present timebase must be positive, bounded, and reduced")
        for name in (
            "presentation_timestamp_count",
            "interval_count",
            "presentation_span_ticks",
        ):
            if _require_exact_int(getattr(self, name), name) < 0:
                raise ValueError(f"{name} must be nonnegative")
        if self.presentation_timestamp_count > MAX_PRESENTATION_TIMESTAMP_COUNT:
            raise ValueError("presentation_timestamp_count exceeds the checked limit")
        expected_intervals = max(0, self.presentation_timestamp_count - 1)
        if self.interval_count != expected_intervals:
            raise ValueError("interval_count does not match the timestamp count")
        _require_sha256(
            self.ordered_validated_pts_sha256, "ordered_validated_pts_sha256"
        )
        if self.presentation_timestamp_count == 0:
            if self.origin_pts is not None or self.presentation_span_ticks != 0:
                raise ValueError("empty evidence cannot have an origin or span")
            if self.ordered_validated_pts_sha256 != _empty_ordered_pts_sha256():
                raise ValueError(
                    "empty claim must carry the canonical empty-row digest"
                )
        else:
            if self.origin_pts is None:
                raise ValueError("non-empty evidence must retain its exact origin")
            _require_bounded_int(self.origin_pts, "origin_pts")
            if self.presentation_timestamp_count == 1:
                if self.presentation_span_ticks != 0:
                    raise ValueError("one-row evidence must have zero span")
            elif self.presentation_span_ticks <= 0:
                raise ValueError("multi-row evidence must have positive span")
            if self.ordered_validated_pts_sha256 == _empty_ordered_pts_sha256():
                raise ValueError("non-empty claim cannot carry the empty-row digest")
        if type(self.consistent_candidate_claims) is not tuple:
            raise ValueError("consistent_candidate_claims must be an exact tuple")
        for candidate in self.consistent_candidate_claims:
            if type(candidate) is not QuantizedPtsGridUntrustedCandidateClaimV1:
                raise ValueError("consistent_candidate_claims contains an invalid item")
        if (
            self.matched_candidate_claim is not None
            and type(self.matched_candidate_claim)
            is not QuantizedPtsGridUntrustedCandidateClaimV1
        ):
            raise ValueError("matched_candidate_claim has the wrong type")
        candidate_rates = tuple(
            (item.rate_numerator, item.rate_denominator)
            for item in self.consistent_candidate_claims
        )
        canonical_rates = tuple(
            rate for rate in _TARGET_RATES if rate in candidate_rates
        )
        if candidate_rates != canonical_rates:
            raise ValueError(
                "consistent_candidate_claims must use canonical target-rate order"
            )
        if len(candidate_rates) != len(set(candidate_rates)):
            raise ValueError("consistent candidate rates must be unique")
        for candidate in self.consistent_candidate_claims:
            if (
                timebase is None
                or (
                    candidate.timebase_numerator,
                    candidate.timebase_denominator,
                )
                != timebase
            ):
                raise ValueError("candidate timebase must equal the outer timebase")
            if (
                candidate.presentation_timestamp_count
                != self.presentation_timestamp_count
                or candidate.interval_count != self.interval_count
                or candidate.presentation_span_ticks != self.presentation_span_ticks
            ):
                raise ValueError(
                    "candidate metrics must equal the outer evidence metrics"
                )
        authority_values = (
            self.admissible_for_training,
            self.admissible_for_evaluation,
            self.admissible_for_test,
            self.admissible_for_deployment,
            self.admissible_for_live_scoring,
        )
        if any(type(value) is not bool or value for value in authority_values):
            raise ValueError("quantized PTS evidence never grants authority")
        if self.proof_scope != PROOF_SCOPE_STATEMENT:
            raise ValueError("proof_scope must retain the exact structural limitation")

        accepted = (
            self.untrusted_claim_status
            is QuantizedPtsGridUntrustedClaimStatusV1.UNTRUSTED_CLAIM_QUANTIZED_PTS_GRID_CONSISTENT_WITH_RATE
        )
        if accepted:
            if self.abstention_reason is not None:
                raise ValueError("accepted claim cannot have an abstention reason")
            if self.matched_candidate_claim is None:
                raise ValueError("accepted claim must name its unique candidate claim")
            if timebase is None or self.origin_pts is None:
                raise ValueError("accepted claim requires a valid timebase and rows")
            if not self.matched_candidate_claim.evidence_sufficient:
                raise ValueError("accepted candidate must meet the evidence floor")
            sufficient = tuple(
                item
                for item in self.consistent_candidate_claims
                if item.evidence_sufficient
            )
            if sufficient != (self.matched_candidate_claim,):
                raise ValueError(
                    "accepted claim must have exactly one sufficient candidate claim"
                )
        else:
            if self.abstention_reason is None:
                raise ValueError("abstained claim must have an explicit reason")
            if self.matched_candidate_claim is not None:
                raise ValueError(
                    "abstained claim cannot name a matched candidate claim"
                )
            self._validate_abstention_shape(timebase)

    def canonical_claim_sha256(self) -> str:
        """Digest every field of this untrusted claim in a separate domain."""

        payload = {
            "domain": UNTRUSTED_CLAIM_DOMAIN,
            "untrusted_claim_status": self.untrusted_claim_status.value,
            "abstention_reason": (
                None if self.abstention_reason is None else self.abstention_reason.value
            ),
            "timebase_numerator": self.timebase_numerator,
            "timebase_denominator": self.timebase_denominator,
            "origin_pts": self.origin_pts,
            "presentation_timestamp_count": self.presentation_timestamp_count,
            "interval_count": self.interval_count,
            "presentation_span_ticks": self.presentation_span_ticks,
            "ordered_validated_pts_sha256": self.ordered_validated_pts_sha256,
            "consistent_candidate_claims": [
                item._canonical_payload() for item in self.consistent_candidate_claims
            ],
            "matched_candidate_claim": (
                None
                if self.matched_candidate_claim is None
                else self.matched_candidate_claim._canonical_payload()
            ),
            "proof_scope": self.proof_scope,
            "admissible_for_training": self.admissible_for_training,
            "admissible_for_evaluation": self.admissible_for_evaluation,
            "admissible_for_test": self.admissible_for_test,
            "admissible_for_deployment": self.admissible_for_deployment,
            "admissible_for_live_scoring": self.admissible_for_live_scoring,
        }
        canonical = json.dumps(
            payload,
            ensure_ascii=True,
            allow_nan=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("ascii")
        return hashlib.sha256(canonical).hexdigest()

    def validate_against(
        self,
        presentation_order_pts: Iterable[int],
        *,
        timebase_numerator: int,
        timebase_denominator: int,
    ) -> bool:
        """Replay the source and compare the entire exact canonical claim.

        This is the mandatory integrity boundary.  A public constructor,
        frozen dataclass, or digest string alone is never evidence that the
        claimed intermediate phase intersection came from the supplied rows.
        """

        try:
            canonical_self = _canonical_untrusted_claim_v1(self)
            rederived = evaluate_quantized_pts_grid_untrusted_claim_v1(
                presentation_order_pts,
                timebase_numerator=timebase_numerator,
                timebase_denominator=timebase_denominator,
            )
            return (
                hmac.compare_digest(
                    canonical_self.canonical_claim_sha256(),
                    rederived.canonical_claim_sha256(),
                )
                and hmac.compare_digest(
                    canonical_self.ordered_validated_pts_sha256,
                    rederived.ordered_validated_pts_sha256,
                )
                and canonical_self == rederived
            )
        except Exception:
            return False

    def _validate_abstention_shape(self, timebase: tuple[int, int] | None) -> None:
        reason = self.abstention_reason
        empty_metrics = (
            self.origin_pts is None
            and self.presentation_timestamp_count == 0
            and self.interval_count == 0
            and self.presentation_span_ticks == 0
        )
        if reason is QuantizedPtsGridUntrustedClaimAbstentionV1.INVALID_TIMEBASE:
            if (
                timebase is not None
                or not empty_metrics
                or self.consistent_candidate_claims
                or self.ordered_validated_pts_sha256 != _empty_ordered_pts_sha256()
            ):
                raise ValueError(
                    "INVALID_TIMEBASE must have no timebase, rows, or candidates"
                )
            return
        if timebase is None:
            raise ValueError("all other abstentions require a valid reduced timebase")
        supported = any(
            _timebase_supports_rate(timebase, rate) for rate in _TARGET_RATES
        )
        if reason is QuantizedPtsGridUntrustedClaimAbstentionV1.UNSUPPORTED_TIMEBASE:
            if (
                supported
                or not empty_metrics
                or self.consistent_candidate_claims
                or self.ordered_validated_pts_sha256 != _empty_ordered_pts_sha256()
            ):
                raise ValueError("UNSUPPORTED_TIMEBASE must be empty and unsupported")
            return
        if not supported:
            raise ValueError("non-timebase abstention requires a supported timebase")
        if reason in {
            QuantizedPtsGridUntrustedClaimAbstentionV1.INVALID_PRESENTATION_TIMESTAMPS,
            QuantizedPtsGridUntrustedClaimAbstentionV1.PRESENTATION_TIMESTAMP_LIMIT_EXCEEDED,
            QuantizedPtsGridUntrustedClaimAbstentionV1.NO_CONSISTENT_RATE,
        }:
            if self.consistent_candidate_claims:
                raise ValueError(
                    f"{reason.value} cannot retain candidate intersections"
                )
            if (
                reason
                is QuantizedPtsGridUntrustedClaimAbstentionV1.PRESENTATION_TIMESTAMP_LIMIT_EXCEEDED
                and self.presentation_timestamp_count
                != MAX_PRESENTATION_TIMESTAMP_COUNT
            ):
                raise ValueError("timestamp-limit abstention requires the exact limit")
            if (
                reason is QuantizedPtsGridUntrustedClaimAbstentionV1.NO_CONSISTENT_RATE
                and self.presentation_timestamp_count < 2
            ):
                raise ValueError("NO_CONSISTENT_RATE requires at least two timestamps")
            return
        sufficient_count = sum(
            item.evidence_sufficient for item in self.consistent_candidate_claims
        )
        if reason is QuantizedPtsGridUntrustedClaimAbstentionV1.INSUFFICIENT_EVIDENCE:
            if not self.consistent_candidate_claims or sufficient_count != 0:
                raise ValueError(
                    "INSUFFICIENT_EVIDENCE requires only insufficient intersections"
                )
            return
        if reason is QuantizedPtsGridUntrustedClaimAbstentionV1.AMBIGUOUS_RATE:
            if sufficient_count < 2:
                raise ValueError(
                    "AMBIGUOUS_RATE requires multiple sufficient intersections"
                )
            return
        raise ValueError("abstention reason is not canonical for this evidence shape")


def _canonical_candidate_claim_v1(
    value: object,
) -> QuantizedPtsGridUntrustedCandidateClaimV1:
    if type(value) is not QuantizedPtsGridUntrustedCandidateClaimV1:
        raise ValueError("candidate claim has the wrong exact type")
    return QuantizedPtsGridUntrustedCandidateClaimV1(**value._canonical_payload())


def _canonical_untrusted_claim_v1(
    value: object,
) -> QuantizedPtsGridUntrustedClaimV1:
    """Reconstruct one possibly tampered frozen object through all validators."""

    if type(value) is not QuantizedPtsGridUntrustedClaimV1:
        raise ValueError("untrusted claim has the wrong exact type")
    raw_candidates = value.consistent_candidate_claims
    if type(raw_candidates) is not tuple:
        raise ValueError("candidate claims must be an exact tuple")
    candidates = tuple(
        _canonical_candidate_claim_v1(candidate) for candidate in raw_candidates
    )
    raw_matched = value.matched_candidate_claim
    matched = (
        None if raw_matched is None else _canonical_candidate_claim_v1(raw_matched)
    )
    return QuantizedPtsGridUntrustedClaimV1(
        untrusted_claim_status=value.untrusted_claim_status,
        abstention_reason=value.abstention_reason,
        timebase_numerator=value.timebase_numerator,
        timebase_denominator=value.timebase_denominator,
        origin_pts=value.origin_pts,
        presentation_timestamp_count=value.presentation_timestamp_count,
        interval_count=value.interval_count,
        presentation_span_ticks=value.presentation_span_ticks,
        ordered_validated_pts_sha256=value.ordered_validated_pts_sha256,
        consistent_candidate_claims=candidates,
        matched_candidate_claim=matched,
        proof_scope=value.proof_scope,
        admissible_for_training=value.admissible_for_training,
        admissible_for_evaluation=value.admissible_for_evaluation,
        admissible_for_test=value.admissible_for_test,
        admissible_for_deployment=value.admissible_for_deployment,
        admissible_for_live_scoring=value.admissible_for_live_scoring,
    )


@dataclass(slots=True)
class _CandidateAccumulator:
    rate_numerator: int
    rate_denominator: int
    period_numerator: int
    period_denominator: int
    lower: int
    upper: int
    possible: bool = True

    def observe(self, index: int, normalized_pts: int) -> None:
        if not self.possible:
            return
        lower = self.period_denominator * normalized_pts - index * self.period_numerator
        upper = (
            self.period_denominator * (normalized_pts + 1)
            - index * self.period_numerator
        )
        self.lower = max(self.lower, lower)
        self.upper = min(self.upper, upper)
        self.possible = self.lower < self.upper


def _candidate_accumulators(
    timebase_numerator: int, timebase_denominator: int
) -> list[_CandidateAccumulator]:
    candidates: list[_CandidateAccumulator] = []
    timebase = (timebase_numerator, timebase_denominator)
    for rate_numerator, rate_denominator in _TARGET_RATES:
        rate = (rate_numerator, rate_denominator)
        if not _timebase_supports_rate(timebase, rate):
            continue
        period_numerator, period_denominator = _reduced_period_ticks(timebase, rate)
        candidates.append(
            _CandidateAccumulator(
                rate_numerator=rate_numerator,
                rate_denominator=rate_denominator,
                period_numerator=period_numerator,
                period_denominator=period_denominator,
                lower=0,
                upper=period_denominator,
            )
        )
    return candidates


def _result(
    *,
    status: QuantizedPtsGridUntrustedClaimStatusV1,
    reason: QuantizedPtsGridUntrustedClaimAbstentionV1 | None,
    timebase: tuple[int, int] | None,
    origin_pts: int | None,
    count: int,
    span: int,
    ordered_validated_pts_sha256: str,
    candidates: tuple[QuantizedPtsGridUntrustedCandidateClaimV1, ...] = (),
    matched: QuantizedPtsGridUntrustedCandidateClaimV1 | None = None,
) -> QuantizedPtsGridUntrustedClaimV1:
    return QuantizedPtsGridUntrustedClaimV1(
        untrusted_claim_status=status,
        abstention_reason=reason,
        timebase_numerator=None if timebase is None else timebase[0],
        timebase_denominator=None if timebase is None else timebase[1],
        origin_pts=origin_pts,
        presentation_timestamp_count=count,
        interval_count=max(0, count - 1),
        presentation_span_ticks=span,
        ordered_validated_pts_sha256=ordered_validated_pts_sha256,
        consistent_candidate_claims=candidates,
        matched_candidate_claim=matched,
    )


def evaluate_quantized_pts_grid_untrusted_claim_v1(
    presentation_order_pts: Iterable[int],
    *,
    timebase_numerator: int,
    timebase_denominator: int,
) -> QuantizedPtsGridUntrustedClaimV1:
    """Build an untrusted structural claim from one complete PTS iterable.

    The returned claim is non-authorizing until ``validate_against`` replays
    the original rows. PTS and timebase inputs are signed-64 bounded; all grid
    products and intersections use arbitrary-precision integers.
    """

    ordered_pts_digest = _OrderedPtsDigestAccumulator.create()
    timebase = _parse_timebase(timebase_numerator, timebase_denominator)
    if timebase is None:
        return _result(
            status=QuantizedPtsGridUntrustedClaimStatusV1.UNTRUSTED_CLAIM_QUANTIZED_PTS_GRID_ABSTAINED,
            reason=QuantizedPtsGridUntrustedClaimAbstentionV1.INVALID_TIMEBASE,
            timebase=None,
            origin_pts=None,
            count=0,
            span=0,
            ordered_validated_pts_sha256=ordered_pts_digest.hexdigest(),
        )
    accumulators = _candidate_accumulators(*timebase)
    if not accumulators:
        return _result(
            status=QuantizedPtsGridUntrustedClaimStatusV1.UNTRUSTED_CLAIM_QUANTIZED_PTS_GRID_ABSTAINED,
            reason=QuantizedPtsGridUntrustedClaimAbstentionV1.UNSUPPORTED_TIMEBASE,
            timebase=timebase,
            origin_pts=None,
            count=0,
            span=0,
            ordered_validated_pts_sha256=ordered_pts_digest.hexdigest(),
        )

    try:
        iterator = iter(presentation_order_pts)
    except Exception:
        return _result(
            status=QuantizedPtsGridUntrustedClaimStatusV1.UNTRUSTED_CLAIM_QUANTIZED_PTS_GRID_ABSTAINED,
            reason=QuantizedPtsGridUntrustedClaimAbstentionV1.INVALID_PRESENTATION_TIMESTAMPS,
            timebase=timebase,
            origin_pts=None,
            count=0,
            span=0,
            ordered_validated_pts_sha256=ordered_pts_digest.hexdigest(),
        )

    origin_pts: int | None = None
    previous_pts: int | None = None
    count = 0
    while True:
        try:
            raw_pts = next(iterator)
        except StopIteration:
            break
        except Exception:
            return _result(
                status=QuantizedPtsGridUntrustedClaimStatusV1.UNTRUSTED_CLAIM_QUANTIZED_PTS_GRID_ABSTAINED,
                reason=QuantizedPtsGridUntrustedClaimAbstentionV1.INVALID_PRESENTATION_TIMESTAMPS,
                timebase=timebase,
                origin_pts=origin_pts,
                count=count,
                span=(
                    0 if origin_pts is None else previous_pts - origin_pts  # type: ignore[operator]
                ),
                ordered_validated_pts_sha256=ordered_pts_digest.hexdigest(),
            )
        if count == MAX_PRESENTATION_TIMESTAMP_COUNT:
            return _result(
                status=QuantizedPtsGridUntrustedClaimStatusV1.UNTRUSTED_CLAIM_QUANTIZED_PTS_GRID_ABSTAINED,
                reason=(
                    QuantizedPtsGridUntrustedClaimAbstentionV1.PRESENTATION_TIMESTAMP_LIMIT_EXCEEDED
                ),
                timebase=timebase,
                origin_pts=origin_pts,
                count=count,
                span=0 if origin_pts is None else previous_pts - origin_pts,  # type: ignore[operator]
                ordered_validated_pts_sha256=ordered_pts_digest.hexdigest(),
            )
        try:
            pts = _require_bounded_int(raw_pts, f"presentation_order_pts[{count}]")
        except ValueError:
            return _result(
                status=QuantizedPtsGridUntrustedClaimStatusV1.UNTRUSTED_CLAIM_QUANTIZED_PTS_GRID_ABSTAINED,
                reason=QuantizedPtsGridUntrustedClaimAbstentionV1.INVALID_PRESENTATION_TIMESTAMPS,
                timebase=timebase,
                origin_pts=origin_pts,
                count=count,
                span=0 if origin_pts is None else previous_pts - origin_pts,  # type: ignore[operator]
                ordered_validated_pts_sha256=ordered_pts_digest.hexdigest(),
            )
        if previous_pts is not None and pts <= previous_pts:
            return _result(
                status=QuantizedPtsGridUntrustedClaimStatusV1.UNTRUSTED_CLAIM_QUANTIZED_PTS_GRID_ABSTAINED,
                reason=QuantizedPtsGridUntrustedClaimAbstentionV1.INVALID_PRESENTATION_TIMESTAMPS,
                timebase=timebase,
                origin_pts=origin_pts,
                count=count,
                # The offending endpoint cannot define a valid presentation
                # span. Retain the exact span of the validated prefix.
                span=previous_pts - origin_pts,  # type: ignore[operator]
                ordered_validated_pts_sha256=ordered_pts_digest.hexdigest(),
            )
        if origin_pts is None:
            origin_pts = pts
        normalized_pts = pts - origin_pts
        for accumulator in accumulators:
            accumulator.observe(count, normalized_pts)
        ordered_pts_digest.add(pts)
        previous_pts = pts
        count += 1

    span = 0 if origin_pts is None else previous_pts - origin_pts  # type: ignore[operator]
    interval_count = max(0, count - 1)
    consistent = tuple(
        QuantizedPtsGridUntrustedCandidateClaimV1(
            timebase_numerator=timebase[0],
            timebase_denominator=timebase[1],
            rate_numerator=item.rate_numerator,
            rate_denominator=item.rate_denominator,
            target_period_ticks_numerator=item.period_numerator,
            target_period_ticks_denominator=item.period_denominator,
            phase_lower_numerator=item.lower,
            phase_upper_exclusive_numerator=item.upper,
            phase_denominator=item.period_denominator,
            presentation_timestamp_count=count,
            interval_count=interval_count,
            presentation_span_ticks=span,
            evidence_sufficient=(
                interval_count >= item.period_denominator
                and interval_count * item.rate_denominator
                >= MIN_TARGET_SECONDS * item.rate_numerator
            ),
        )
        for item in accumulators
        if item.possible
    )
    sufficient = tuple(item for item in consistent if item.evidence_sufficient)
    if len(sufficient) == 1:
        return _result(
            status=(
                QuantizedPtsGridUntrustedClaimStatusV1.UNTRUSTED_CLAIM_QUANTIZED_PTS_GRID_CONSISTENT_WITH_RATE
            ),
            reason=None,
            timebase=timebase,
            origin_pts=origin_pts,
            count=count,
            span=span,
            ordered_validated_pts_sha256=ordered_pts_digest.hexdigest(),
            candidates=consistent,
            matched=sufficient[0],
        )
    if len(sufficient) > 1:
        reason = QuantizedPtsGridUntrustedClaimAbstentionV1.AMBIGUOUS_RATE
    elif consistent:
        reason = QuantizedPtsGridUntrustedClaimAbstentionV1.INSUFFICIENT_EVIDENCE
    else:
        reason = QuantizedPtsGridUntrustedClaimAbstentionV1.NO_CONSISTENT_RATE
    return _result(
        status=QuantizedPtsGridUntrustedClaimStatusV1.UNTRUSTED_CLAIM_QUANTIZED_PTS_GRID_ABSTAINED,
        reason=reason,
        timebase=timebase,
        origin_pts=origin_pts,
        count=count,
        span=span,
        ordered_validated_pts_sha256=ordered_pts_digest.hexdigest(),
        candidates=consistent,
    )
