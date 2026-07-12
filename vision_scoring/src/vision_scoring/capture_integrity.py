"""Exact-rational clock mapping and pure capture-trace evaluation."""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from fractions import Fraction

from .capture_contracts import (
    CAPTURE_SCHEMA_VERSION,
    FREEZE_CANDIDATE_MIN_NS,
    INVALID_CAPTURE_FINDING_KINDS,
    MAX_CAPTURE_FINDINGS,
    MAX_CAPTURE_RECORDS,
    MAX_FINALIZED_FRAMES,
    MAX_SIGNED_64,
    MIN_SIGNED_64,
    CaptureBoundaryKind,
    CaptureDropNotice,
    CaptureFrameSignal,
    CaptureSegmentIntegrityReport,
    CaptureSessionDescriptor,
    CaptureSourceKind,
    CaptureStreamBoundary,
    CaptureTraceRecord,
    CaptureTrustDomain,
    FinalizedSourceFrameSignal,
    IntegrityDisposition,
    IntegrityFinding,
    IntegrityFindingKind,
    _canonical_json_bytes,
    _require_enum,
    _require_exact_int,
    _require_nonnegative,
    _require_optional_sha256,
    _require_reduced_rational,
    _require_sha256,
    encode_capture_trace_record,
)


class CaptureIntegrityError(ValueError):
    """The evaluator was called with an invalid structural input."""


@dataclass(frozen=True, slots=True)
class ClockMappingCandidate:
    """An unverified affine-map candidate from device to evidence time.

    Arithmetic remains rational until the final, explicitly defined nearest-
    nanosecond quantization.  Source PTS values with a different time base can
    be mapped because both the anchor and input are interpreted as exact
    rational seconds. Cryptographic capture trust and the claimed error bound
    are verified only by the later capture-trust boundary, not this pure slice.
    """

    session_fingerprint: str
    reconnect_epoch: int
    trust_domain: CaptureTrustDomain
    clock_attestation_sha256: str | None
    device_anchor_timestamp: int
    device_time_base_numerator: int
    device_time_base_denominator: int
    evidence_anchor_ns: int
    rate_numerator: int
    rate_denominator: int
    valid_host_start_ns: int
    valid_host_end_ns: int
    claimed_max_absolute_error_ns: int
    schema_version: str = CAPTURE_SCHEMA_VERSION

    def __post_init__(self) -> None:
        if self.schema_version != CAPTURE_SCHEMA_VERSION:
            raise ValueError("unsupported clock-mapping schema")
        _require_sha256(self.session_fingerprint, "session_fingerprint")
        _require_nonnegative(self.reconnect_epoch, "reconnect_epoch")
        _require_enum(self.trust_domain, CaptureTrustDomain, "trust_domain")
        _require_optional_sha256(
            self.clock_attestation_sha256, "clock_attestation_sha256"
        )
        _require_exact_int(self.device_anchor_timestamp, "device_anchor_timestamp")
        _require_reduced_rational(
            self.device_time_base_numerator,
            self.device_time_base_denominator,
            field_prefix="device_time_base",
        )
        _require_nonnegative(self.evidence_anchor_ns, "evidence_anchor_ns")
        _require_reduced_rational(
            self.rate_numerator,
            self.rate_denominator,
            field_prefix="rate",
        )
        _require_nonnegative(self.valid_host_start_ns, "valid_host_start_ns")
        _require_nonnegative(self.valid_host_end_ns, "valid_host_end_ns")
        if self.valid_host_end_ns < self.valid_host_start_ns:
            raise ValueError("clock host validity interval is reversed")
        _require_nonnegative(
            self.claimed_max_absolute_error_ns,
            "claimed_max_absolute_error_ns",
        )
        if self.trust_domain is CaptureTrustDomain.PRODUCTION_CAPTURE:
            if self.clock_attestation_sha256 is None:
                raise ValueError("production clock mapping requires an attestation")
        elif self.clock_attestation_sha256 is not None:
            raise ValueError("synthetic clock mapping cannot carry production trust")

    def to_dict(self) -> dict[str, object]:
        return {
            "clock_attestation_sha256": self.clock_attestation_sha256,
            "device_anchor_timestamp": self.device_anchor_timestamp,
            "device_time_base_denominator": self.device_time_base_denominator,
            "device_time_base_numerator": self.device_time_base_numerator,
            "evidence_anchor_ns": self.evidence_anchor_ns,
            "claimed_max_absolute_error_ns": self.claimed_max_absolute_error_ns,
            "rate_denominator": self.rate_denominator,
            "rate_numerator": self.rate_numerator,
            "reconnect_epoch": self.reconnect_epoch,
            "schema_version": self.schema_version,
            "session_fingerprint": self.session_fingerprint,
            "trust_domain": self.trust_domain.value,
            "valid_host_end_ns": self.valid_host_end_ns,
            "valid_host_start_ns": self.valid_host_start_ns,
        }

    def fingerprint(self) -> str:
        return hashlib.sha256(
            _canonical_json_bytes(self.to_dict(), label="clock mapping")
        ).hexdigest()

    def map_fraction(
        self,
        timestamp: int,
        *,
        time_base_numerator: int,
        time_base_denominator: int,
    ) -> Fraction:
        _require_exact_int(timestamp, "timestamp")
        _require_reduced_rational(
            time_base_numerator,
            time_base_denominator,
            field_prefix="time_base",
        )
        input_seconds = Fraction(
            timestamp * time_base_numerator, time_base_denominator
        )
        anchor_seconds = Fraction(
            self.device_anchor_timestamp * self.device_time_base_numerator,
            self.device_time_base_denominator,
        )
        elapsed_evidence_ns = (
            (input_seconds - anchor_seconds)
            * 1_000_000_000
            * self.rate_numerator
            / self.rate_denominator
        )
        return Fraction(self.evidence_anchor_ns, 1) + elapsed_evidence_ns

    def map_ns(
        self,
        timestamp: int,
        *,
        time_base_numerator: int,
        time_base_denominator: int,
    ) -> int:
        value = self.map_fraction(
            timestamp,
            time_base_numerator=time_base_numerator,
            time_base_denominator=time_base_denominator,
        )
        mapped = _round_fraction_nearest_away_from_zero(value)
        if not 0 <= mapped <= MAX_SIGNED_64:
            raise CaptureIntegrityError("mapped evidence time exceeds signed 64-bit range")
        return mapped

    def permits_host_time(self, host_monotonic_ns: int) -> bool:
        _require_nonnegative(host_monotonic_ns, "host_monotonic_ns")
        return self.valid_host_start_ns <= host_monotonic_ns <= self.valid_host_end_ns


def _round_fraction_nearest_away_from_zero(value: Fraction) -> int:
    numerator = value.numerator
    denominator = value.denominator
    sign = -1 if numerator < 0 else 1
    magnitude = abs(numerator)
    quotient, remainder = divmod(magnitude, denominator)
    if remainder * 2 >= denominator:
        quotient += 1
    return sign * quotient


def _basis(**values: int | str | bool | None) -> tuple[tuple[str, object], ...]:
    return tuple(sorted(values.items()))


def _bounded_basis_integer(value: int) -> int | str:
    """Keep derived exact integers representable in bounded finding payloads."""

    if MIN_SIGNED_64 <= value <= MAX_SIGNED_64:
        return value
    return f"decimal:{value}"


def evaluate_capture_trace(
    session: CaptureSessionDescriptor,
    clock_mapping: ClockMappingCandidate,
    records: tuple[CaptureTraceRecord, ...],
    finalized_trace: tuple[FinalizedSourceFrameSignal, ...],
) -> CaptureSegmentIntegrityReport:
    """Evaluate one immutable, single-epoch video-only capture segment.

    The function is pure.  It does not open media, mutate a score, persist an
    event, or infer that a rally ended.
    """

    if type(session) is not CaptureSessionDescriptor:
        raise CaptureIntegrityError("session must be a CaptureSessionDescriptor")
    if type(clock_mapping) is not ClockMappingCandidate:
        raise CaptureIntegrityError(
            "clock_mapping must be a ClockMappingCandidate"
        )
    if type(records) is not tuple or len(records) > MAX_CAPTURE_RECORDS:
        raise CaptureIntegrityError("records must be a bounded immutable tuple")
    if any(
        type(item) not in (CaptureFrameSignal, CaptureDropNotice, CaptureStreamBoundary)
        for item in records
    ):
        raise CaptureIntegrityError("records contain an unsupported trace type")
    if sum(type(item) is CaptureFrameSignal for item in records) > MAX_FINALIZED_FRAMES:
        raise CaptureIntegrityError("observed frame count exceeds the fixed ceiling")
    if type(finalized_trace) is not tuple or len(finalized_trace) > MAX_FINALIZED_FRAMES:
        raise CaptureIntegrityError("finalized_trace must be a bounded immutable tuple")
    if any(type(item) is not FinalizedSourceFrameSignal for item in finalized_trace):
        raise CaptureIntegrityError("finalized_trace contains an unsupported type")

    session_fingerprint = session.fingerprint()
    configuration_fingerprint = session.configuration_fingerprint
    all_findings: list[IntegrityFinding] = []
    reasons: set[str] = set()
    frames: list[CaptureFrameSignal] = []
    mapped_evidence: list[int] = []
    explicit_drop_notice_count = 0
    explicit_reported_drop_count = 0
    explicit_unknown_drop_count_notices = 0
    inferred_gap_count = 0
    device_sequence_gap_count = 0
    timestamp_failure_count = 0
    freeze_candidate_count = 0

    def add_finding(
        kind: IntegrityFindingKind,
        *,
        observed_start: int | None = None,
        observed_end: int | None = None,
        evidence_start: int | None = None,
        evidence_end: int | None = None,
        **basis: int | str | bool | None,
    ) -> None:
        # Invalid traces can regress in either sequence or time.  Findings are
        # evidence about that failure, so constructing the finding must never
        # become a second failure.  Canonicalize complete intervals centrally;
        # callers deliberately pass (None, None) when a clock mapping was not
        # established for one of the endpoints.
        if observed_start is not None and observed_end is not None:
            observed_start, observed_end = (
                min(observed_start, observed_end),
                max(observed_start, observed_end),
            )
        if evidence_start is not None and evidence_end is not None:
            evidence_start, evidence_end = (
                min(evidence_start, evidence_end),
                max(evidence_start, evidence_end),
            )
        all_findings.append(
            IntegrityFinding(
                kind=kind,
                observed_sequence_start=observed_start,
                observed_sequence_end=observed_end,
                evidence_start_ns=evidence_start,
                evidence_end_ns=evidence_end,
                basis=_basis(**basis),
            )
        )
        reasons.add(kind.value)

    if records and not (
        type(records[0]) is CaptureStreamBoundary
        and records[0].kind is CaptureBoundaryKind.START
        and records[0].at_observed_sequence == 0
    ):
        add_finding(
            IntegrityFindingKind.STREAM_SEQUENCE_FAILURE,
            reason="FIRST_RECORD_MUST_BE_START_AT_SEQUENCE_ZERO",
        )

    if (
        clock_mapping.session_fingerprint != session_fingerprint
        or clock_mapping.reconnect_epoch != session.reconnect_epoch
        or clock_mapping.trust_domain is not session.trust_domain
        or clock_mapping.clock_attestation_sha256 != session.clock_attestation_sha256
        or clock_mapping.evidence_anchor_ns != session.evidence_time_open_ns
    ):
        add_finding(
            IntegrityFindingKind.CLOCK_MAPPING_FAILURE,
            expected_session=session_fingerprint,
            observed_session=clock_mapping.session_fingerprint,
            expected_epoch=session.reconnect_epoch,
            observed_epoch=clock_mapping.reconnect_epoch,
            expected_evidence_anchor_ns=session.evidence_time_open_ns,
            observed_evidence_anchor_ns=clock_mapping.evidence_anchor_ns,
        )

    expected_observed_sequence = 0
    observed_sequence_exhausted = False
    previous_device_timestamp: int | None = None
    previous_device_sequence: int | None = None
    previous_device_sequence_observed_sequence: int | None = None
    previous_device_sequence_evidence_ns: int | None = None
    previous_device_sequence_evidence_valid = False
    previous_host_ns: int | None = None
    previous_evidence_ns: int | None = None
    previous_evidence_valid = False
    first_boundary_seen = False
    stop_seen = False
    freeze_hash: str | None = None
    freeze_start_sequence: int | None = None
    freeze_start_evidence: int | None = None
    freeze_emitted = False
    pending_drop_notice_evidence: list[tuple[int, int | None]] = []

    expected_period_ns = Fraction(
        1_000_000_000 * session.fps_denominator, session.fps_numerator
    )

    for record in records:
        record_session = record.session_fingerprint
        record_epoch = record.reconnect_epoch
        if record_session != session_fingerprint or record_epoch != session.reconnect_epoch:
            add_finding(
                IntegrityFindingKind.RECONNECT_BOUNDARY,
                expected_epoch=session.reconnect_epoch,
                observed_epoch=record_epoch,
                session_match=record_session == session_fingerprint,
            )

        host_ns = record.host_monotonic_ns
        if previous_host_ns is not None and host_ns < previous_host_ns:
            add_finding(
                IntegrityFindingKind.HOST_CLOCK_REGRESSION,
                previous_host_ns=previous_host_ns,
                observed_host_ns=host_ns,
            )
        previous_host_ns = host_ns
        if not clock_mapping.permits_host_time(host_ns):
            add_finding(
                IntegrityFindingKind.CLOCK_MAPPING_FAILURE,
                host_monotonic_ns=host_ns,
                valid_host_start_ns=clock_mapping.valid_host_start_ns,
                valid_host_end_ns=clock_mapping.valid_host_end_ns,
            )

        if type(record) is CaptureStreamBoundary:
            if record.configuration_fingerprint != configuration_fingerprint:
                add_finding(
                    IntegrityFindingKind.CONFIGURATION_CHANGE,
                    expected_configuration=configuration_fingerprint,
                    observed_configuration=record.configuration_fingerprint,
                )
            if record.at_observed_sequence != expected_observed_sequence:
                add_finding(
                    IntegrityFindingKind.STREAM_SEQUENCE_FAILURE,
                    expected_sequence=expected_observed_sequence,
                    observed_sequence=record.at_observed_sequence,
                )
            if not first_boundary_seen:
                first_boundary_seen = True
                if record.kind is not CaptureBoundaryKind.START:
                    add_finding(
                        IntegrityFindingKind.STREAM_SEQUENCE_FAILURE,
                        boundary=record.kind.value,
                        expected_boundary=CaptureBoundaryKind.START.value,
                    )
            elif record.kind is CaptureBoundaryKind.START:
                add_finding(
                    IntegrityFindingKind.STREAM_SEQUENCE_FAILURE,
                    boundary=record.kind.value,
                    reason="DUPLICATE_START",
                )
            if record.kind in (CaptureBoundaryKind.INTERRUPT, CaptureBoundaryKind.RESUME):
                add_finding(
                    IntegrityFindingKind.RECONNECT_BOUNDARY,
                    boundary=record.kind.value,
                    epoch=record.reconnect_epoch,
                    expected_resumed_epoch=(
                        session.reconnect_epoch + 1
                        if record.kind is CaptureBoundaryKind.RESUME
                        and session.reconnect_epoch < MAX_SIGNED_64
                        else None
                    ),
                )
            elif record.kind is CaptureBoundaryKind.CONFIG_CHANGE:
                add_finding(
                    IntegrityFindingKind.CONFIGURATION_CHANGE,
                    previous_configuration=record.configuration_fingerprint,
                    new_configuration=record.new_configuration_fingerprint,
                )
            elif record.kind is CaptureBoundaryKind.STOP:
                if stop_seen:
                    add_finding(
                        IntegrityFindingKind.STREAM_SEQUENCE_FAILURE,
                        boundary=record.kind.value,
                        reason="DUPLICATE_STOP",
                    )
                stop_seen = True
            continue

        if stop_seen:
            add_finding(
                IntegrityFindingKind.STREAM_SEQUENCE_FAILURE,
                expected_sequence=expected_observed_sequence,
                reason="RECORD_AFTER_STOP",
            )

        if type(record) is CaptureDropNotice:
            explicit_drop_notice_count += 1
            if record.reported_count is None:
                explicit_unknown_drop_count_notices += 1
            else:
                explicit_reported_drop_count += record.reported_count
                if explicit_reported_drop_count > MAX_SIGNED_64:
                    raise CaptureIntegrityError(
                        "aggregate reported drop count exceeds signed 64-bit range"
                    )
            expected_after_sequence = (
                frames[-1].observed_sequence if frames else None
            )
            if record.after_observed_sequence != expected_after_sequence:
                add_finding(
                    IntegrityFindingKind.STREAM_SEQUENCE_FAILURE,
                    expected_after_sequence=expected_after_sequence,
                    observed_after_sequence=record.after_observed_sequence,
                )
            notice_evidence: int | None = (
                previous_evidence_ns if previous_evidence_valid else None
            )
            notice_evidence_basis = (
                "PREVIOUS_FRAME_NO_NOTICE_TIMESTAMP"
                if previous_evidence_valid
                else "UNAVAILABLE_PREVIOUS_FRAME_MAPPING_FAILED"
            )
            if record.device_timestamp is not None:
                if (
                    record.device_time_base_numerator
                    != clock_mapping.device_time_base_numerator
                    or record.device_time_base_denominator
                    != clock_mapping.device_time_base_denominator
                ):
                    notice_evidence = None
                    notice_evidence_basis = "UNAVAILABLE_TIME_BASE_SUBSTITUTED"
                    add_finding(
                        IntegrityFindingKind.CLOCK_MAPPING_FAILURE,
                        observed_start=record.after_observed_sequence,
                        observed_end=record.after_observed_sequence,
                        reason="DROP_NOTICE_DEVICE_TIME_BASE_SUBSTITUTION",
                    )
                else:
                    try:
                        notice_evidence = clock_mapping.map_ns(
                            record.device_timestamp,
                            time_base_numerator=record.device_time_base_numerator,
                            time_base_denominator=record.device_time_base_denominator,
                        )
                        notice_evidence_basis = "MAPPED_NOTICE_DEVICE_TIMESTAMP"
                    except (ValueError, CaptureIntegrityError):
                        notice_evidence = None
                        notice_evidence_basis = "UNAVAILABLE_MAPPING_FAILED"
                        add_finding(
                            IntegrityFindingKind.CLOCK_MAPPING_FAILURE,
                            observed_start=record.after_observed_sequence,
                            observed_end=record.after_observed_sequence,
                            reason="DROP_NOTICE_MAPPING_FAILED",
                        )
                if (
                    notice_evidence is not None
                    and previous_evidence_valid
                    and previous_evidence_ns is not None
                    and notice_evidence < previous_evidence_ns
                ):
                    add_finding(
                        IntegrityFindingKind.CLOCK_MAPPING_FAILURE,
                        observed_start=record.after_observed_sequence,
                        observed_end=record.after_observed_sequence,
                        reason="DROP_NOTICE_PRECEDES_PRIOR_FRAME",
                    )
                    notice_evidence = None
                    notice_evidence_basis = "UNAVAILABLE_CAUSAL_ORDER_FAILURE"
            if notice_evidence is not None and record.device_timestamp is not None:
                pending_drop_notice_evidence.append(
                    (notice_evidence, record.after_observed_sequence)
                )
            add_finding(
                IntegrityFindingKind.EXPLICIT_BACKEND_DROP,
                observed_start=record.after_observed_sequence,
                observed_end=record.after_observed_sequence,
                evidence_start=notice_evidence,
                evidence_end=notice_evidence,
                reason=record.reason.value,
                reported_count=record.reported_count,
                evidence_time_basis=notice_evidence_basis,
            )
            continue

        frame = record
        frames.append(frame)
        if observed_sequence_exhausted:
            add_finding(
                IntegrityFindingKind.STREAM_SEQUENCE_FAILURE,
                observed_start=frame.observed_sequence,
                observed_end=frame.observed_sequence,
                reason="OBSERVED_SEQUENCE_EXHAUSTED",
            )
        if frame.observed_sequence != expected_observed_sequence:
            add_finding(
                IntegrityFindingKind.STREAM_SEQUENCE_FAILURE,
                observed_start=frame.observed_sequence,
                observed_end=frame.observed_sequence,
                expected_sequence=expected_observed_sequence,
                observed_sequence=frame.observed_sequence,
            )
            if frame.observed_sequence == MAX_SIGNED_64:
                observed_sequence_exhausted = True
                expected_observed_sequence = MAX_SIGNED_64
            else:
                expected_observed_sequence = frame.observed_sequence + 1
        else:
            if expected_observed_sequence == MAX_SIGNED_64:
                observed_sequence_exhausted = True
            else:
                expected_observed_sequence += 1

        if frame.configuration_fingerprint != configuration_fingerprint:
            add_finding(
                IntegrityFindingKind.CONFIGURATION_CHANGE,
                observed_start=frame.observed_sequence,
                observed_end=frame.observed_sequence,
                expected_configuration=configuration_fingerprint,
                observed_configuration=frame.configuration_fingerprint,
            )
        if frame.width != session.expected_width or frame.height != session.expected_height:
            add_finding(
                IntegrityFindingKind.DIMENSION_CHANGE,
                observed_start=frame.observed_sequence,
                observed_end=frame.observed_sequence,
                expected_width=session.expected_width,
                expected_height=session.expected_height,
                observed_width=frame.width,
                observed_height=frame.height,
            )
        if (
            frame.device_time_base_numerator
            != clock_mapping.device_time_base_numerator
            or frame.device_time_base_denominator
            != clock_mapping.device_time_base_denominator
        ):
            add_finding(
                IntegrityFindingKind.CLOCK_MAPPING_FAILURE,
                observed_start=frame.observed_sequence,
                observed_end=frame.observed_sequence,
                reason="DEVICE_TIME_BASE_SUBSTITUTION",
            )

        evidence_valid = True
        try:
            evidence_ns = clock_mapping.map_ns(
                frame.device_timestamp,
                time_base_numerator=frame.device_time_base_numerator,
                time_base_denominator=frame.device_time_base_denominator,
            )
        except (ValueError, CaptureIntegrityError):
            evidence_valid = False
            evidence_ns = session.evidence_time_open_ns
            add_finding(
                IntegrityFindingKind.CLOCK_MAPPING_FAILURE,
                observed_start=frame.observed_sequence,
                observed_end=frame.observed_sequence,
                reason="FRAME_MAPPING_FAILED",
            )
        mapped_evidence.append(evidence_ns)

        for notice_time_ns, after_sequence in pending_drop_notice_evidence:
            if evidence_valid and notice_time_ns > evidence_ns:
                add_finding(
                    IntegrityFindingKind.CLOCK_MAPPING_FAILURE,
                    observed_start=(
                        after_sequence
                        if after_sequence is not None
                        else frame.observed_sequence
                    ),
                    observed_end=frame.observed_sequence,
                    reason="DROP_NOTICE_FOLLOWS_NEXT_FRAME",
                )
        pending_drop_notice_evidence.clear()

        if previous_device_timestamp is not None:
            previous_observed_sequence = frames[-2].observed_sequence
            paired_evidence_start = (
                previous_evidence_ns
                if previous_evidence_valid and evidence_valid
                else None
            )
            paired_evidence_end = (
                evidence_ns if previous_evidence_valid and evidence_valid else None
            )
            delta_ticks = frame.device_timestamp - previous_device_timestamp
            if delta_ticks <= 0:
                timestamp_failure_count += 1
                add_finding(
                    IntegrityFindingKind.TIMESTAMP_DUPLICATE_OR_REGRESSION,
                    observed_start=min(
                        previous_observed_sequence, frame.observed_sequence
                    ),
                    observed_end=max(
                        previous_observed_sequence, frame.observed_sequence
                    ),
                    evidence_start=paired_evidence_start,
                    evidence_end=paired_evidence_end,
                    delta_ticks=_bounded_basis_integer(delta_ticks),
                )
            else:
                delta_ns = Fraction(
                    delta_ticks
                    * frame.device_time_base_numerator
                    * 1_000_000_000,
                    frame.device_time_base_denominator,
                )
                if delta_ns * 2 > expected_period_ns * 3:
                    inferred_gap_count += 1
                    add_finding(
                        IntegrityFindingKind.INFERRED_DEVICE_TIMESTAMP_GAP,
                        observed_start=min(
                            previous_observed_sequence, frame.observed_sequence
                        ),
                        observed_end=max(
                            previous_observed_sequence, frame.observed_sequence
                        ),
                        evidence_start=paired_evidence_start,
                        evidence_end=paired_evidence_end,
                        delta_ns_numerator=_bounded_basis_integer(
                            delta_ns.numerator
                        ),
                        delta_ns_denominator=_bounded_basis_integer(
                            delta_ns.denominator
                        ),
                    )
        if previous_device_sequence is not None and frame.device_sequence is not None:
            assert previous_device_sequence_observed_sequence is not None
            assert previous_device_sequence_evidence_ns is not None
            device_sequence_evidence_start = (
                previous_device_sequence_evidence_ns
                if previous_device_sequence_evidence_valid and evidence_valid
                else None
            )
            device_sequence_evidence_end = (
                evidence_ns
                if previous_device_sequence_evidence_valid and evidence_valid
                else None
            )
            device_sequence_delta = frame.device_sequence - previous_device_sequence
            if device_sequence_delta > 1:
                device_sequence_gap_count += 1
                add_finding(
                    IntegrityFindingKind.DEVICE_SEQUENCE_GAP,
                    observed_start=min(
                        previous_device_sequence_observed_sequence,
                        frame.observed_sequence,
                    ),
                    observed_end=max(
                        previous_device_sequence_observed_sequence,
                        frame.observed_sequence,
                    ),
                    evidence_start=device_sequence_evidence_start,
                    evidence_end=device_sequence_evidence_end,
                    device_sequence_delta=_bounded_basis_integer(
                        device_sequence_delta
                    ),
                )
            elif device_sequence_delta <= 0:
                add_finding(
                    IntegrityFindingKind.STREAM_SEQUENCE_FAILURE,
                    observed_start=min(
                        previous_device_sequence_observed_sequence,
                        frame.observed_sequence,
                    ),
                    observed_end=max(
                        previous_device_sequence_observed_sequence,
                        frame.observed_sequence,
                    ),
                    evidence_start=device_sequence_evidence_start,
                    evidence_end=device_sequence_evidence_end,
                    device_sequence_delta=_bounded_basis_integer(
                        device_sequence_delta
                    ),
                    reason="DEVICE_SEQUENCE_DUPLICATE_OR_REGRESSION",
                )

        exposure_values = {
            "exposure_duration_ns": frame.exposure_duration_ns,
            "gain_milli_db": frame.gain_milli_db,
            "iso": frame.iso,
        }
        locked_values = {
            "exposure_duration_ns": session.locked_exposure_duration_ns,
            "gain_milli_db": session.locked_gain_milli_db,
            "iso": session.locked_iso,
        }
        for name, observed in exposure_values.items():
            if observed is None:
                continue
            expected = locked_values[name]
            if observed != expected:
                add_finding(
                    IntegrityFindingKind.EXPOSURE_POLICY_VIOLATION,
                    observed_start=frame.observed_sequence,
                    observed_end=frame.observed_sequence,
                    evidence_start=evidence_ns if evidence_valid else None,
                    evidence_end=evidence_ns if evidence_valid else None,
                    field=name,
                    expected=expected,
                    observed=observed,
                    policy=session.exposure_policy.value,
                )

        if (
            not evidence_valid
            or not previous_evidence_valid
            and previous_device_timestamp is not None
        ):
            freeze_hash = None
            freeze_start_sequence = None
            freeze_start_evidence = None
            freeze_emitted = False
        elif frame.diagnostic_luma_sha256 is None:
            freeze_hash = None
            freeze_start_sequence = None
            freeze_start_evidence = None
            freeze_emitted = False
        elif frame.diagnostic_luma_sha256 != freeze_hash:
            freeze_hash = frame.diagnostic_luma_sha256
            freeze_start_sequence = frame.observed_sequence
            freeze_start_evidence = evidence_ns
            freeze_emitted = False
        elif (
            not freeze_emitted
            and freeze_start_evidence is not None
            and evidence_ns - freeze_start_evidence >= FREEZE_CANDIDATE_MIN_NS
        ):
            freeze_candidate_count += 1
            freeze_emitted = True
            add_finding(
                IntegrityFindingKind.DIAGNOSTIC_FREEZE_CANDIDATE,
                observed_start=freeze_start_sequence,
                observed_end=frame.observed_sequence,
                evidence_start=freeze_start_evidence,
                evidence_end=evidence_ns,
                diagnostic_contract=frame.diagnostic_contract,
                duration_ns=evidence_ns - freeze_start_evidence,
                authority="NON_AUTHORITATIVE_CANDIDATE_ONLY",
            )

        previous_device_timestamp = frame.device_timestamp
        if frame.device_sequence is not None:
            previous_device_sequence = frame.device_sequence
            previous_device_sequence_observed_sequence = frame.observed_sequence
            previous_device_sequence_evidence_ns = evidence_ns
            previous_device_sequence_evidence_valid = evidence_valid
        else:
            previous_device_sequence = None
            previous_device_sequence_observed_sequence = None
            previous_device_sequence_evidence_ns = None
            previous_device_sequence_evidence_valid = False
        previous_evidence_ns = evidence_ns
        previous_evidence_valid = evidence_valid

    if not records or not first_boundary_seen:
        add_finding(
            IntegrityFindingKind.STREAM_SEQUENCE_FAILURE,
            reason="MISSING_START_BOUNDARY",
        )
    if not stop_seen:
        add_finding(
            IntegrityFindingKind.STREAM_SEQUENCE_FAILURE,
            reason="MISSING_STOP_BOUNDARY",
        )
    if not frames:
        add_finding(
            IntegrityFindingKind.STREAM_SEQUENCE_FAILURE,
            reason="NO_CAPTURE_FRAMES",
        )

    finalized_valid = True
    if not finalized_trace:
        finalized_valid = False
        add_finding(
            IntegrityFindingKind.FINALIZED_OUTPUT_VALIDATION_FAILURE,
            reason="NO_FINALIZED_FRAMES",
        )

    previous_pts: int | None = None
    finalized_time_base: tuple[int, int] | None = None
    finalized_mapped: list[int] = []
    for expected_index, finalized in enumerate(finalized_trace):
        if (
            finalized.session_fingerprint != session_fingerprint
            or finalized.reconnect_epoch != session.reconnect_epoch
            or finalized.configuration_fingerprint != configuration_fingerprint
        ):
            finalized_valid = False
            add_finding(
                IntegrityFindingKind.FINALIZED_OUTPUT_VALIDATION_FAILURE,
                observed_start=expected_index,
                observed_end=expected_index,
                reason="FINALIZED_PROVENANCE_SUBSTITUTION",
            )
        if finalized.presentation_index != expected_index:
            finalized_valid = False
            add_finding(
                IntegrityFindingKind.FINALIZED_OUTPUT_VALIDATION_FAILURE,
                observed_start=expected_index,
                observed_end=expected_index,
                expected_index=expected_index,
                observed_index=finalized.presentation_index,
            )
        if previous_pts is not None and finalized.source_pts <= previous_pts:
            finalized_valid = False
            add_finding(
                IntegrityFindingKind.FINALIZED_OUTPUT_VALIDATION_FAILURE,
                observed_start=max(0, expected_index - 1),
                observed_end=expected_index,
                previous_pts=previous_pts,
                observed_pts=finalized.source_pts,
                reason="PTS_NOT_STRICTLY_INCREASING",
            )
        previous_pts = finalized.source_pts
        observed_time_base = (
            finalized.source_time_base_numerator,
            finalized.source_time_base_denominator,
        )
        if finalized_time_base is None:
            finalized_time_base = observed_time_base
        elif observed_time_base != finalized_time_base:
            finalized_valid = False
            add_finding(
                IntegrityFindingKind.FINALIZED_OUTPUT_VALIDATION_FAILURE,
                observed_start=expected_index,
                observed_end=expected_index,
                expected_time_base=(
                    f"{finalized_time_base[0]}/{finalized_time_base[1]}"
                ),
                observed_time_base=(
                    f"{observed_time_base[0]}/{observed_time_base[1]}"
                ),
                reason="FINALIZED_TIME_BASE_CHANGED",
            )
        if not finalized.represented_in_output:
            finalized_valid = False
            add_finding(
                IntegrityFindingKind.ENCODER_FRAME_LOSS,
                observed_start=expected_index,
                observed_end=expected_index,
                reason="FRAME_NOT_REPRESENTED",
            )
        if (
            finalized.width != session.expected_width
            or finalized.height != session.expected_height
        ):
            finalized_valid = False
            add_finding(
                IntegrityFindingKind.FINALIZED_OUTPUT_VALIDATION_FAILURE,
                observed_start=expected_index,
                observed_end=expected_index,
                reason="FINALIZED_DIMENSION_MISMATCH",
            )
        if expected_index < len(frames):
            observed_frame = frames[expected_index]
            if (
                finalized.source_pts != observed_frame.device_timestamp
                or finalized.source_time_base_numerator
                != observed_frame.device_time_base_numerator
                or finalized.source_time_base_denominator
                != observed_frame.device_time_base_denominator
            ):
                finalized_valid = False
                add_finding(
                    IntegrityFindingKind.FINALIZED_OUTPUT_VALIDATION_FAILURE,
                    observed_start=expected_index,
                    observed_end=expected_index,
                    reason="SOURCE_PTS_DID_NOT_PRESERVE_DEVICE_TIMESTAMP",
                )
        try:
            exact_mapped = clock_mapping.map_ns(
                finalized.source_pts,
                time_base_numerator=finalized.source_time_base_numerator,
                time_base_denominator=finalized.source_time_base_denominator,
            )
        except (ValueError, CaptureIntegrityError):
            exact_mapped = finalized.mapped_evidence_timestamp_ns
            finalized_valid = False
            add_finding(
                IntegrityFindingKind.FINALIZED_OUTPUT_VALIDATION_FAILURE,
                observed_start=expected_index,
                observed_end=expected_index,
                reason="FINALIZED_PTS_MAPPING_FAILED",
            )
        finalized_mapped.append(exact_mapped)
        if exact_mapped != finalized.mapped_evidence_timestamp_ns:
            finalized_valid = False
            add_finding(
                IntegrityFindingKind.FINALIZED_OUTPUT_VALIDATION_FAILURE,
                observed_start=expected_index,
                observed_end=expected_index,
                expected_evidence_ns=exact_mapped,
                observed_evidence_ns=finalized.mapped_evidence_timestamp_ns,
                reason="CALLER_SUPPLIED_EVIDENCE_TIME_MISMATCH",
            )

    if len(finalized_trace) != len(frames):
        finalized_valid = False
        add_finding(
            IntegrityFindingKind.ENCODER_FRAME_LOSS,
            observed_frame_count=len(frames),
            finalized_frame_count=len(finalized_trace),
        )
    elif finalized_mapped != mapped_evidence:
        finalized_valid = False
        add_finding(
            IntegrityFindingKind.FINALIZED_OUTPUT_VALIDATION_FAILURE,
            reason="FINALIZED_EVIDENCE_SEQUENCE_MISMATCH",
        )

    if len(all_findings) > MAX_CAPTURE_FINDINGS:
        reasons.add("FINDING_DETAILS_TRUNCATED")
    finding_details_truncated = len(all_findings) > MAX_CAPTURE_FINDINGS
    findings = tuple(all_findings[:MAX_CAPTURE_FINDINGS])
    finding_kind_counts = tuple(
        (
            kind,
            sum(finding.kind is kind for finding in all_findings),
        )
        for kind in sorted(IntegrityFindingKind, key=lambda item: item.value)
    )
    if finding_details_truncated or any(
        finding.kind in INVALID_CAPTURE_FINDING_KINDS
        for finding in all_findings
    ):
        disposition = IntegrityDisposition.INVALID
    elif all_findings:
        disposition = IntegrityDisposition.OBSERVED_DEGRADED
    else:
        disposition = IntegrityDisposition.OBSERVED_CLEAN

    if session.source_kind is CaptureSourceKind.SYNTHETIC_TEST:
        reasons.add("SYNTHETIC_NON_OPERATIONAL")
    else:
        reasons.add("CRYPTOGRAPHIC_CAPTURE_TRUST_NOT_VERIFIED")
    structurally_eligible_for_trust_verification = (
        session.source_kind is CaptureSourceKind.LIVE_CAMERA
        and session.trust_domain is CaptureTrustDomain.PRODUCTION_CAPTURE
        and clock_mapping.trust_domain is CaptureTrustDomain.PRODUCTION_CAPTURE
        and disposition is IntegrityDisposition.OBSERVED_CLEAN
        and finalized_valid
    )

    if finalized_trace:
        source_start_pts = min(frame.source_pts for frame in finalized_trace)
        source_end_pts = max(frame.source_pts for frame in finalized_trace)
        source_time_base_numerator = finalized_trace[0].source_time_base_numerator
        source_time_base_denominator = finalized_trace[0].source_time_base_denominator
        evidence_start_ns = min(finalized_mapped)
        evidence_end_ns = max(finalized_mapped)
    else:
        source_start_pts = source_end_pts = clock_mapping.device_anchor_timestamp
        source_time_base_numerator = clock_mapping.device_time_base_numerator
        source_time_base_denominator = clock_mapping.device_time_base_denominator
        evidence_start_ns = evidence_end_ns = session.evidence_time_open_ns

    trace_digest = hashlib.sha256()
    trace_digest.update(b"capture-window-v1\0")
    trace_digest.update(session_fingerprint.encode("ascii"))
    for record in records:
        encoded = encode_capture_trace_record(record)
        trace_digest.update(len(encoded).to_bytes(8, "big"))
        trace_digest.update(encoded)
    for finalized in finalized_trace:
        encoded = finalized.to_json_bytes()
        trace_digest.update(len(encoded).to_bytes(8, "big"))
        trace_digest.update(encoded)

    return CaptureSegmentIntegrityReport(
        session_fingerprint=session_fingerprint,
        source_kind=session.source_kind,
        trust_domain=session.trust_domain,
        window_fingerprint=trace_digest.hexdigest(),
        reconnect_epoch=session.reconnect_epoch,
        source_start_pts=source_start_pts,
        source_end_pts=source_end_pts,
        source_time_base_numerator=source_time_base_numerator,
        source_time_base_denominator=source_time_base_denominator,
        evidence_start_ns=evidence_start_ns,
        evidence_end_ns=evidence_end_ns,
        observed_frame_count=len(frames),
        finalized_frame_count=len(finalized_trace),
        fps_numerator=session.fps_numerator,
        fps_denominator=session.fps_denominator,
        explicit_drop_notice_count=explicit_drop_notice_count,
        explicit_reported_drop_count=explicit_reported_drop_count,
        explicit_unknown_drop_count_notices=explicit_unknown_drop_count_notices,
        inferred_timestamp_gap_count=inferred_gap_count,
        device_sequence_gap_count=device_sequence_gap_count,
        timestamp_failure_count=timestamp_failure_count,
        freeze_candidate_count=freeze_candidate_count,
        findings=findings,
        finding_details_truncated=finding_details_truncated,
        total_finding_count=len(all_findings),
        finding_kind_counts=finding_kind_counts,
        camera_fingerprint=session.camera_attestation_sha256,
        clock_fingerprint=clock_mapping.fingerprint(),
        encoder_configuration_sha256=session.encoder_configuration_sha256,
        exposure_configuration_sha256=session.exposure_configuration_sha256,
        finalized_trace_structurally_valid=finalized_valid,
        disposition=disposition,
        reason_codes=tuple(sorted(reasons)),
        structurally_eligible_for_trust_verification=(
            structurally_eligible_for_trust_verification
        ),
    )


__all__ = [
    "CaptureIntegrityError",
    "ClockMappingCandidate",
    "evaluate_capture_trace",
]
