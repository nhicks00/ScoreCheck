"""Pure, bounded evidence-window planning over closed fragment metadata."""

from __future__ import annotations

from .capture_contracts import (
    MAX_CLOSED_FRAGMENTS,
    MAX_FINALIZED_FRAMES,
    MAX_FINALIZED_SOURCE_BYTES,
    MAX_PENDING_WINDOWS,
    MAX_RETENTION_NS,
    MAX_RING_BYTES,
    CaptureFragmentDescriptor,
    EvidenceWindowPlan,
    EvidenceWindowRequest,
    EvidenceWindowStatus,
)


class EvidenceWindowPlanningError(ValueError):
    """The planner was called with a structurally invalid projection."""


def _unplanned(
    request: EvidenceWindowRequest,
    status: EvidenceWindowStatus,
    reason_code: str,
) -> EvidenceWindowPlan:
    return EvidenceWindowPlan(
        request_fingerprint=request.fingerprint(),
        status=status,
        session_fingerprint=request.session_fingerprint,
        reconnect_epoch=request.reconnect_epoch,
        requested_start_ns=request.requested_start_ns,
        requested_end_ns=request.requested_end_ns,
        actual_start_ns=None,
        actual_end_ns=None,
        selected_fragment_ids=(),
        selected_fragment_fingerprints=(),
        configuration_fingerprint=None,
        total_byte_length=0,
        total_frame_count=0,
        reason_code=reason_code,
    )


def plan_evidence_window(
    request: EvidenceWindowRequest,
    fragments: tuple[CaptureFragmentDescriptor, ...],
    *,
    pending_window_count: int = 0,
) -> EvidenceWindowPlan:
    """Select a complete keyframe-aligned source interval without shortening.

    ``fragments`` is a single, immutable projection of the bounded closed-
    fragment ring.  It must already be ordered and must not mix sessions,
    reconnect epochs, or configurations.  Availability failures are returned
    as explicit plans; malformed Python inputs raise.
    """

    if type(request) is not EvidenceWindowRequest:
        raise EvidenceWindowPlanningError(
            "request must be an EvidenceWindowRequest"
        )
    if type(fragments) is not tuple:
        raise EvidenceWindowPlanningError("fragments must be an immutable tuple")
    if any(type(item) is not CaptureFragmentDescriptor for item in fragments):
        raise EvidenceWindowPlanningError(
            "fragments contain an unsupported descriptor"
        )
    if type(pending_window_count) is not int or not 0 <= pending_window_count:
        raise EvidenceWindowPlanningError(
            "pending_window_count must be a non-negative exact integer"
        )
    if pending_window_count >= MAX_PENDING_WINDOWS:
        return _unplanned(
            request,
            EvidenceWindowStatus.CAPACITY_EXCEEDED,
            "PENDING_WINDOW_CAPACITY_EXCEEDED",
        )
    if len(fragments) > MAX_CLOSED_FRAGMENTS:
        return _unplanned(
            request,
            EvidenceWindowStatus.CAPACITY_EXCEEDED,
            "CLOSED_FRAGMENT_COUNT_EXCEEDED",
        )
    if not fragments:
        return _unplanned(
            request,
            EvidenceWindowStatus.PREROLL_UNAVAILABLE,
            "NO_CLOSED_FRAGMENTS",
        )
    if request.pre_roll_ns > request.trigger_evidence_time_ns:
        return _unplanned(
            request,
            EvidenceWindowStatus.PREROLL_UNAVAILABLE,
            "PREROLL_PRECEDES_EVIDENCE_EPOCH",
        )

    if any(
        fragment.session_fingerprint != request.session_fingerprint
        or fragment.reconnect_epoch != request.reconnect_epoch
        for fragment in fragments
    ):
        return _unplanned(
            request,
            EvidenceWindowStatus.FRAGMENT_SCOPE_MISMATCH,
            "SESSION_OR_RECONNECT_EPOCH_MIXED",
        )
    fragment_ids = tuple(fragment.fragment_id for fragment in fragments)
    if len(set(fragment_ids)) != len(fragment_ids):
        return _unplanned(
            request,
            EvidenceWindowStatus.FRAGMENT_GAP,
            "DUPLICATE_FRAGMENT_ID",
        )

    if any(
        fragment.session_configuration_fingerprint
        != request.expected_session_configuration_fingerprint
        for fragment in fragments
    ):
        return _unplanned(
            request,
            EvidenceWindowStatus.CONFIGURATION_MISMATCH,
            "FRAGMENT_SESSION_CONFIGURATION_SUBSTITUTED",
        )

    configuration = fragments[0].configuration_fingerprint
    if any(
        fragment.configuration_fingerprint != configuration
        for fragment in fragments[1:]
    ):
        return _unplanned(
            request,
            EvidenceWindowStatus.CONFIGURATION_MISMATCH,
            "FRAGMENT_CONFIGURATION_MIXED",
        )

    total_ring_bytes = 0
    for index, fragment in enumerate(fragments):
        total_ring_bytes += fragment.byte_length
        if index == 0:
            continue
        previous = fragments[index - 1]
        if fragment.fragment_sequence != previous.fragment_sequence + 1:
            return _unplanned(
                request,
                EvidenceWindowStatus.FRAGMENT_GAP,
                "FRAGMENT_SEQUENCE_GAP",
            )
        if fragment.evidence_start_ns != previous.evidence_end_ns:
            return _unplanned(
                request,
                EvidenceWindowStatus.FRAGMENT_GAP,
                "FRAGMENT_EVIDENCE_INTERVAL_GAP_OR_OVERLAP",
            )
        if fragment.device_start_timestamp != previous.device_end_timestamp:
            return _unplanned(
                request,
                EvidenceWindowStatus.FRAGMENT_GAP,
                "FRAGMENT_DEVICE_INTERVAL_GAP_OR_OVERLAP",
            )
        if (
            fragment.device_time_base_numerator
            != previous.device_time_base_numerator
            or fragment.device_time_base_denominator
            != previous.device_time_base_denominator
        ):
            return _unplanned(
                request,
                EvidenceWindowStatus.CONFIGURATION_MISMATCH,
                "FRAGMENT_DEVICE_TIME_BASE_MIXED",
            )

    if total_ring_bytes > MAX_RING_BYTES:
        return _unplanned(
            request,
            EvidenceWindowStatus.CAPACITY_EXCEEDED,
            "RING_BYTE_CEILING_EXCEEDED",
        )
    if fragments[-1].evidence_end_ns - fragments[0].evidence_start_ns > MAX_RETENTION_NS:
        return _unplanned(
            request,
            EvidenceWindowStatus.CAPACITY_EXCEEDED,
            "RETENTION_INTERVAL_EXCEEDED",
        )

    requested_start = request.requested_start_ns
    requested_end = request.requested_end_ns
    if requested_start < fragments[0].evidence_start_ns:
        return _unplanned(
            request,
            EvidenceWindowStatus.PREROLL_UNAVAILABLE,
            "REQUIRED_PREROLL_EVICTED",
        )
    if requested_end > fragments[-1].evidence_end_ns:
        return _unplanned(
            request,
            EvidenceWindowStatus.POSTROLL_UNAVAILABLE,
            "REQUIRED_POSTROLL_NOT_CLOSED",
        )

    start_index: int | None = None
    for index, fragment in enumerate(fragments):
        if (
            fragment.evidence_start_ns <= requested_start < fragment.evidence_end_ns
            or (
                requested_start == fragments[-1].evidence_end_ns
                and index == len(fragments) - 1
            )
        ):
            start_index = index
            break
    if start_index is None:
        return _unplanned(
            request,
            EvidenceWindowStatus.PREROLL_UNAVAILABLE,
            "REQUEST_START_NOT_RETAINED",
        )
    end_index: int | None = start_index if requested_end == requested_start else None
    if end_index is None:
        for index, fragment in enumerate(fragments[start_index:], start=start_index):
            if fragment.evidence_start_ns < requested_end <= fragment.evidence_end_ns:
                end_index = index
                break
    if end_index is None:
        return _unplanned(
            request,
            EvidenceWindowStatus.POSTROLL_UNAVAILABLE,
            "REQUEST_END_NOT_CLOSED",
        )

    keyframe_index = start_index
    while keyframe_index >= 0 and not fragments[keyframe_index].keyframe_at_start:
        keyframe_index -= 1
    if keyframe_index < 0:
        return _unplanned(
            request,
            EvidenceWindowStatus.KEYFRAME_UNAVAILABLE,
            "NO_RETAINED_KEYFRAME_BEFORE_REQUEST",
        )

    selected = fragments[keyframe_index : end_index + 1]
    selected_bytes = sum(fragment.byte_length for fragment in selected)
    selected_frames = sum(fragment.frame_count for fragment in selected)
    if selected_bytes > MAX_FINALIZED_SOURCE_BYTES:
        return _unplanned(
            request,
            EvidenceWindowStatus.CAPACITY_EXCEEDED,
            "FINALIZED_SOURCE_BYTE_CEILING_EXCEEDED",
        )
    if selected_frames > MAX_FINALIZED_FRAMES:
        return _unplanned(
            request,
            EvidenceWindowStatus.CAPACITY_EXCEEDED,
            "FINALIZED_FRAME_CEILING_EXCEEDED",
        )

    return EvidenceWindowPlan(
        request_fingerprint=request.fingerprint(),
        status=EvidenceWindowStatus.PLANNED,
        session_fingerprint=request.session_fingerprint,
        reconnect_epoch=request.reconnect_epoch,
        requested_start_ns=requested_start,
        requested_end_ns=requested_end,
        actual_start_ns=selected[0].evidence_start_ns,
        actual_end_ns=selected[-1].evidence_end_ns,
        selected_fragment_ids=tuple(fragment.fragment_id for fragment in selected),
        selected_fragment_fingerprints=tuple(
            fragment.fingerprint() for fragment in selected
        ),
        configuration_fingerprint=configuration,
        total_byte_length=selected_bytes,
        total_frame_count=selected_frames,
        reason_code="COMPLETE_KEYFRAME_ALIGNED_WINDOW",
    )


__all__ = ["EvidenceWindowPlanningError", "plan_evidence_window"]
