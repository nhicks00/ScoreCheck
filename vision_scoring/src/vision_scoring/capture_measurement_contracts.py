"""Canonical, non-authorizing decoded-capture measurement contracts.

The V1 receipt commits bounded summaries and opaque, recipe-bound streaming
row digests for one reportedly complete selected-video-stream decode.  A
receipt constructor verifies structural consistency only: it does not replay
the rows named by those hashes.  In particular, zero identical-frame or
freeze-candidate counts do not prove the absence of freezes, interpolation,
or transport loss.  A future protected verifier must replay the committed
rows under the bound recipe before any separate admission decision.

This contract deliberately does not claim a transport, device, provenance,
compression stratum, operator identity, training admission, readiness, or
scoring authority.  Its cadence is decoded presentation-PTS cadence only.

Cadence derivation is intentionally exact.  It recognizes only 30/1,
30000/1001, 60/1, and 60000/1001 from adjacent presentation timestamps with
one positive constant delta.  Missing, duplicate, regressing, variable,
single-frame, unsupported, or otherwise ambiguous timing is never rounded.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
import hashlib
import math
from typing import Any, ClassVar, Iterable

from .capture_profile_contracts import VideoCodecV1
from .contract_wire import (
    MAX_SIGNED_64,
    MIN_SIGNED_64,
    canonical_json_bytes,
    enum_from_json,
    parse_canonical_json_object,
    require_exact_fields,
    require_exact_int,
    require_sha256,
    require_stable_id,
)


DECODED_CAPTURE_MEASUREMENT_SCHEMA_VERSION = "1.0"
DECODED_CAPTURE_MEASUREMENT_RECEIPT_DOMAIN = (
    "multicourt-vision-scoring:decoded-capture-measurement-receipt:v1"
)
MAX_DECODED_CAPTURE_MEASUREMENT_BYTES = 64 * 1024
MAX_DECODED_DIMENSION_PX = 16_384

_SUPPORTED_CADENCES = frozenset(
    {
        (30, 1),
        (30_000, 1_001),
        (60, 1),
        (60_000, 1_001),
    }
)
_DISPLAY_ROTATIONS = frozenset({0, 90, 180, 270})
_AUTHORITY_FIELDS = (
    "admissible_for_training",
    "admissible_for_evaluation",
    "admissible_for_test",
    "admissible_for_deployment",
    "admissible_for_live_scoring",
)
_TYPED_DIGEST_FIELDS = (
    "source_asset_sha256",
    "artifact_generation_id",
    "decoder_runtime_manifest_sha256",
    "measurement_recipe_sha256",
    "presentation_timing_rows_sha256",
    "selected_video_packet_rows_sha256",
    "decoded_frame_rows_sha256",
)


class DecodedInterlaceObservationV1(str, Enum):
    """What the full selected-stream decode observed about scan structure."""

    PROGRESSIVE_ONLY = "PROGRESSIVE_ONLY"
    INTERLACED_OBSERVED = "INTERLACED_OBSERVED"
    MIXED = "MIXED"
    UNKNOWN = "UNKNOWN"


class DecodedCadenceStatusV1(str, Enum):
    """Exact cadence result or the fail-closed reason it was not derived."""

    EXACT_SUPPORTED_CFR = "EXACT_SUPPORTED_CFR"
    ABSTAINED_MISSING_PTS = "ABSTAINED_MISSING_PTS"
    ABSTAINED_DUPLICATE_PTS = "ABSTAINED_DUPLICATE_PTS"
    ABSTAINED_REGRESSING_PTS = "ABSTAINED_REGRESSING_PTS"
    ABSTAINED_VARIABLE_DELTA = "ABSTAINED_VARIABLE_DELTA"
    ABSTAINED_SINGLE_FRAME = "ABSTAINED_SINGLE_FRAME"
    ABSTAINED_UNSUPPORTED_RATE = "ABSTAINED_UNSUPPORTED_RATE"
    ABSTAINED_AMBIGUOUS_TIMING = "ABSTAINED_AMBIGUOUS_TIMING"


class DecodedMeasurementAnalysisStatusV1(str, Enum):
    """V1 receipts contain unverified, recipe-bound structural claims only."""

    RECIPE_BOUND_FULL_STREAM_CLAIMS_UNVERIFIED = (
        "RECIPE_BOUND_FULL_STREAM_CLAIMS_UNVERIFIED"
    )


def _require_exact_enum(value: object, enum_type: type[Enum], field_name: str) -> None:
    if type(value) is not enum_type:
        raise ValueError(f"{field_name} must be an exact {enum_type.__name__}")


def _require_reduced_positive_rational(
    numerator: object,
    denominator: object,
    *,
    field_prefix: str,
) -> tuple[int, int]:
    numerator_value = require_exact_int(
        numerator,
        f"{field_prefix}_numerator",
        minimum=1,
        maximum=MAX_SIGNED_64,
    )
    denominator_value = require_exact_int(
        denominator,
        f"{field_prefix}_denominator",
        minimum=1,
        maximum=MAX_SIGNED_64,
    )
    if math.gcd(numerator_value, denominator_value) != 1:
        raise ValueError(f"{field_prefix} must be a reduced positive rational")
    return numerator_value, denominator_value


def _require_optional_pts(value: object, field_name: str) -> int | None:
    if value is None:
        return None
    return require_exact_int(
        value,
        field_name,
        minimum=MIN_SIGNED_64,
        maximum=MAX_SIGNED_64,
    )


def _reduced_rate_for_delta(
    *,
    source_time_base_numerator: int,
    source_time_base_denominator: int,
    constant_presentation_pts_delta: int,
) -> tuple[int, int]:
    numerator = source_time_base_denominator
    denominator = source_time_base_numerator * constant_presentation_pts_delta
    divisor = math.gcd(numerator, denominator)
    return numerator // divisor, denominator // divisor


@dataclass(frozen=True, slots=True)
class DecodedCadenceDerivationV1:
    """Bounded output of the one-pass exact presentation-cadence derivation."""

    source_time_base_numerator: int
    source_time_base_denominator: int
    decoded_frame_count: int
    first_presentation_pts: int | None
    last_presentation_pts: int | None
    missing_presentation_pts_count: int
    duplicate_presentation_pts_count: int
    regressing_presentation_pts_count: int
    cadence_status: DecodedCadenceStatusV1
    constant_presentation_pts_delta: int
    cadence_numerator: int
    cadence_denominator: int

    def __post_init__(self) -> None:
        time_base_numerator, time_base_denominator = (
            _require_reduced_positive_rational(
                self.source_time_base_numerator,
                self.source_time_base_denominator,
                field_prefix="source_time_base",
            )
        )
        _validate_decoded_cadence_summary_v1(
            frame_count=self.decoded_frame_count,
            first_pts=self.first_presentation_pts,
            last_pts=self.last_presentation_pts,
            missing_count=self.missing_presentation_pts_count,
            duplicate_count=self.duplicate_presentation_pts_count,
            regression_count=self.regressing_presentation_pts_count,
            cadence_status=self.cadence_status,
            constant_delta=self.constant_presentation_pts_delta,
            cadence_numerator=self.cadence_numerator,
            cadence_denominator=self.cadence_denominator,
            time_base_numerator=time_base_numerator,
            time_base_denominator=time_base_denominator,
        )


def _validate_decoded_cadence_summary_v1(
    *,
    frame_count: object,
    first_pts: object,
    last_pts: object,
    missing_count: object,
    duplicate_count: object,
    regression_count: object,
    cadence_status: object,
    constant_delta: object,
    cadence_numerator: object,
    cadence_denominator: object,
    time_base_numerator: int,
    time_base_denominator: int,
) -> None:
    """Validate necessary, bounded consistency of an opaque timing summary.

    This proves only that at least one row sequence could have produced the
    summary.  It cannot prove that the opaque presentation-row digest actually
    names such a sequence; protected replay is deliberately out of scope.
    """

    frames = require_exact_int(
        frame_count,
        "decoded_frame_count",
        minimum=1,
        maximum=MAX_SIGNED_64,
    )
    first = _require_optional_pts(first_pts, "first_presentation_pts")
    last = _require_optional_pts(last_pts, "last_presentation_pts")
    missing = require_exact_int(
        missing_count,
        "missing_presentation_pts_count",
        minimum=0,
        maximum=frames,
    )
    present = frames - missing

    if frames == 1 and (first is None) != (last is None):
        raise ValueError("single decoded frame PTS endpoints must have equal presence")
    if frames == 1 and first is not None and first != last:
        raise ValueError("single decoded frame PTS endpoints must be equal")
    if present == 0 and (first is not None or last is not None):
        raise ValueError("all-missing presentation timing requires null endpoints")
    if missing == 0 and (first is None or last is None):
        raise ValueError("complete presentation timing requires first and last PTS")
    endpoint_present_count = int(first is not None) + int(last is not None)
    endpoint_missing_count = int(first is None) + int(last is None)
    if frames == 1 and endpoint_present_count == 2:
        endpoint_present_count = 1
    if frames == 1 and endpoint_missing_count == 2:
        endpoint_missing_count = 1
    if present < endpoint_present_count:
        raise ValueError("PTS endpoints exceed the reported present-frame count")
    if missing < endpoint_missing_count:
        raise ValueError("null PTS endpoints exceed the reported missing-frame count")

    # Missing rows break adjacency.  If both endpoints are present while at
    # least one internal row is missing, at least two present runs are forced.
    maximum_adjacent_present_pairs = max(0, present - 1)
    if missing and frames > 1 and first is not None and last is not None:
        maximum_adjacent_present_pairs = max(0, present - 2)
    duplicates = require_exact_int(
        duplicate_count,
        "duplicate_presentation_pts_count",
        minimum=0,
        maximum=frames - 1,
    )
    regressions = require_exact_int(
        regression_count,
        "regressing_presentation_pts_count",
        minimum=0,
        maximum=frames - 1,
    )
    if duplicates + regressions > maximum_adjacent_present_pairs:
        raise ValueError(
            "PTS anomaly comparisons exceed feasible adjacent present pairs"
        )
    if (
        missing == 0
        and regressions == 0
        and first is not None
        and last is not None
        and last < first
    ):
        raise ValueError("no-regression PTS summary requires monotonic endpoints")
    if missing == 0:
        assert first is not None and last is not None
        positive_comparison_count = frames - 1 - duplicates - regressions
        span = last - first
        if regressions == 0 and span < positive_comparison_count:
            raise ValueError("PTS anomaly counts have an infeasible endpoint span")
        if regressions > 0 and positive_comparison_count == 0 and span > -regressions:
            raise ValueError("all-nonpositive PTS comparisons have an infeasible span")

    _require_exact_enum(cadence_status, DecodedCadenceStatusV1, "cadence_status")
    delta = require_exact_int(
        constant_delta,
        "constant_presentation_pts_delta",
        minimum=0,
        maximum=MAX_SIGNED_64,
    )
    numerator = require_exact_int(
        cadence_numerator,
        "cadence_numerator",
        minimum=0,
        maximum=MAX_SIGNED_64,
    )
    denominator = require_exact_int(
        cadence_denominator,
        "cadence_denominator",
        minimum=0,
        maximum=MAX_SIGNED_64,
    )
    status = cadence_status
    visible_anomaly_kinds = sum(
        value > 0 for value in (missing, duplicates, regressions)
    )

    if status is DecodedCadenceStatusV1.EXACT_SUPPORTED_CFR:
        if visible_anomaly_kinds or frames < 2:
            raise ValueError("exact cadence contradicts PTS anomaly counts")
        if first is None or last is None or delta <= 0:
            raise ValueError("exact cadence requires complete positive timing")
        if first + delta * (frames - 1) != last:
            raise ValueError("exact cadence endpoints contradict the constant delta")
        exact_rate = _reduced_rate_for_delta(
            source_time_base_numerator=time_base_numerator,
            source_time_base_denominator=time_base_denominator,
            constant_presentation_pts_delta=delta,
        )
        if exact_rate not in _SUPPORTED_CADENCES:
            raise ValueError("exact cadence is not one of the supported rates")
        if (numerator, denominator) != exact_rate:
            raise ValueError("cadence rational does not match exact PTS timing")
        return

    if numerator != 0 or denominator != 0:
        raise ValueError("abstained cadence must use the exact 0/0 rational")
    if status is DecodedCadenceStatusV1.ABSTAINED_UNSUPPORTED_RATE:
        if visible_anomaly_kinds or frames < 2:
            raise ValueError("unsupported cadence contradicts PTS anomaly counts")
        if first is None or last is None or delta <= 0:
            raise ValueError("unsupported constant cadence requires complete timing")
        if first + delta * (frames - 1) != last:
            raise ValueError("unsupported cadence endpoints contradict its delta")
        if (
            _reduced_rate_for_delta(
                source_time_base_numerator=time_base_numerator,
                source_time_base_denominator=time_base_denominator,
                constant_presentation_pts_delta=delta,
            )
            in _SUPPORTED_CADENCES
        ):
            raise ValueError("a supported exact cadence cannot abstain as unsupported")
        return
    if delta != 0:
        raise ValueError("non-constant cadence abstention must use delta zero")

    if status is DecodedCadenceStatusV1.ABSTAINED_SINGLE_FRAME:
        if frames != 1 or visible_anomaly_kinds:
            raise ValueError("single-frame cadence status is inconsistent")
    elif status is DecodedCadenceStatusV1.ABSTAINED_MISSING_PTS:
        if missing == 0 or duplicates or regressions:
            raise ValueError(
                "missing-PTS status requires exactly one visible anomaly kind"
            )
    elif status is DecodedCadenceStatusV1.ABSTAINED_DUPLICATE_PTS:
        if missing or duplicates == 0 or regressions:
            raise ValueError(
                "duplicate-PTS status requires exactly one visible anomaly kind"
            )
        assert first is not None and last is not None
        positive_comparison_count = frames - 1 - duplicates
        span = last - first
        if positive_comparison_count == 0:
            if span != 0:
                raise ValueError("all-duplicate PTS summary requires equal endpoints")
        elif span < positive_comparison_count:
            raise ValueError("duplicate PTS summary has an infeasible endpoint span")
    elif status is DecodedCadenceStatusV1.ABSTAINED_REGRESSING_PTS:
        if missing or duplicates or regressions == 0:
            raise ValueError(
                "regressing-PTS status requires exactly one visible anomaly kind"
            )
        assert first is not None and last is not None
        positive_comparison_count = frames - 1 - regressions
        if positive_comparison_count == 0 and last - first > -regressions:
            raise ValueError("all-regressing PTS summary has an infeasible endpoint span")
    elif status is DecodedCadenceStatusV1.ABSTAINED_VARIABLE_DELTA:
        if visible_anomaly_kinds or present < 3:
            raise ValueError(
                "variable-delta status requires three complete increasing PTS values"
            )
        assert first is not None and last is not None
        # K strictly-positive integer deltas have minimum sum K.  To be
        # unequal, at least one delta must add one more tick.
        if last - first < present:
            raise ValueError("variable-delta PTS span cannot contain unequal deltas")
    elif status is DecodedCadenceStatusV1.ABSTAINED_AMBIGUOUS_TIMING:
        if visible_anomaly_kinds < 2:
            raise ValueError("ambiguous timing requires multiple visible anomalies")


def derive_exact_decoded_cadence_v1(
    presentation_pts: Iterable[int | None],
    *,
    source_time_base_numerator: int,
    source_time_base_denominator: int,
) -> DecodedCadenceDerivationV1:
    """Derive a supported exact CFR cadence in one pass over presentation PTS.

    Packet/DTS order is intentionally absent from this interface.  B-frame
    packet reordering therefore cannot influence presentation cadence.  Raw
    millisecond RTMP patterns such as 33/34-ms or 16/17-ms alternation remain
    variable here; a later trusted rescaling rule would need to bind its exact
    lineage and result rather than silently rounding this observation.
    """

    time_base_numerator, time_base_denominator = (
        _require_reduced_positive_rational(
            source_time_base_numerator,
            source_time_base_denominator,
            field_prefix="source_time_base",
        )
    )
    try:
        iterator = iter(presentation_pts)
    except TypeError as exc:
        raise ValueError("presentation_pts must be an iterable") from exc

    count = 0
    missing_count = 0
    duplicate_count = 0
    regression_count = 0
    first_pts: int | None = None
    last_pts: int | None = None
    previous_pts: int | None = None
    constant_positive_delta: int | None = None
    variable_delta = False

    for value in iterator:
        if count == MAX_SIGNED_64:
            raise ValueError("decoded frame count exceeds signed 64-bit")
        count += 1
        pts = _require_optional_pts(value, "presentation_pts item")
        if count == 1:
            first_pts = pts
        last_pts = pts
        if pts is None:
            missing_count += 1
            previous_pts = None
            continue
        if previous_pts is not None:
            delta = pts - previous_pts
            if delta == 0:
                duplicate_count += 1
            elif delta < 0:
                regression_count += 1
            else:
                if delta > MAX_SIGNED_64:
                    raise ValueError("presentation PTS delta exceeds signed 64-bit")
                if constant_positive_delta is None:
                    constant_positive_delta = delta
                elif constant_positive_delta != delta:
                    variable_delta = True
        previous_pts = pts

    if count == 0:
        raise ValueError("presentation_pts must contain at least one decoded frame")

    anomaly_statuses: list[DecodedCadenceStatusV1] = []
    if missing_count:
        anomaly_statuses.append(DecodedCadenceStatusV1.ABSTAINED_MISSING_PTS)
    if duplicate_count:
        anomaly_statuses.append(DecodedCadenceStatusV1.ABSTAINED_DUPLICATE_PTS)
    if regression_count:
        anomaly_statuses.append(DecodedCadenceStatusV1.ABSTAINED_REGRESSING_PTS)
    constant_delta = 0
    cadence_numerator = 0
    cadence_denominator = 0
    if len(anomaly_statuses) > 1:
        status = DecodedCadenceStatusV1.ABSTAINED_AMBIGUOUS_TIMING
    elif anomaly_statuses:
        status = anomaly_statuses[0]
    elif variable_delta:
        status = DecodedCadenceStatusV1.ABSTAINED_VARIABLE_DELTA
    elif count == 1:
        status = DecodedCadenceStatusV1.ABSTAINED_SINGLE_FRAME
    else:
        if constant_positive_delta is None:
            # With at least two present frames and no duplicate/regression this
            # cannot normally occur.  Fail closed if an exotic iterable ever
            # violates that invariant.
            status = DecodedCadenceStatusV1.ABSTAINED_AMBIGUOUS_TIMING
        else:
            constant_delta = constant_positive_delta
            exact_rate = _reduced_rate_for_delta(
                source_time_base_numerator=time_base_numerator,
                source_time_base_denominator=time_base_denominator,
                constant_presentation_pts_delta=constant_delta,
            )
            if exact_rate in _SUPPORTED_CADENCES:
                status = DecodedCadenceStatusV1.EXACT_SUPPORTED_CFR
                cadence_numerator, cadence_denominator = exact_rate
            else:
                status = DecodedCadenceStatusV1.ABSTAINED_UNSUPPORTED_RATE

    return DecodedCadenceDerivationV1(
        source_time_base_numerator=time_base_numerator,
        source_time_base_denominator=time_base_denominator,
        decoded_frame_count=count,
        first_presentation_pts=first_pts,
        last_presentation_pts=last_pts,
        missing_presentation_pts_count=missing_count,
        duplicate_presentation_pts_count=duplicate_count,
        regressing_presentation_pts_count=regression_count,
        cadence_status=status,
        constant_presentation_pts_delta=constant_delta,
        cadence_numerator=cadence_numerator,
        cadence_denominator=cadence_denominator,
    )


def average_payload_bitrate_rational_v1(
    *,
    selected_video_payload_bytes: int,
    first_presentation_pts: int | None,
    last_presentation_pts: int | None,
    source_time_base_numerator: int,
    source_time_base_denominator: int,
) -> tuple[int, int]:
    """Return exact average payload bits/second over the observed PTS span.

    A non-positive or unavailable span is represented as 0/0; it is not
    estimated from metadata or a nominal frame rate.
    """

    payload_bytes = require_exact_int(
        selected_video_payload_bytes,
        "selected_video_payload_bytes",
        minimum=0,
        maximum=MAX_SIGNED_64,
    )
    time_base_numerator, time_base_denominator = (
        _require_reduced_positive_rational(
            source_time_base_numerator,
            source_time_base_denominator,
            field_prefix="source_time_base",
        )
    )
    first_pts = _require_optional_pts(first_presentation_pts, "first_presentation_pts")
    last_pts = _require_optional_pts(last_presentation_pts, "last_presentation_pts")
    if first_pts is None or last_pts is None or last_pts <= first_pts:
        return 0, 0
    numerator = payload_bytes * 8 * time_base_denominator
    denominator = (last_pts - first_pts) * time_base_numerator
    divisor = math.gcd(numerator, denominator)
    if divisor:
        numerator //= divisor
        denominator //= divisor
    if numerator > MAX_SIGNED_64 or denominator > MAX_SIGNED_64:
        raise ValueError("average payload bitrate rational exceeds signed 64-bit")
    return numerator, denominator


def _contract_field_names() -> set[str]:
    return {
        field_name
        for field_name in DecodedCaptureMeasurementReceiptV1.__dataclass_fields__
        if not field_name.startswith("_")
    }


@dataclass(frozen=True, slots=True)
class DecodedCaptureMeasurementReceiptV1:
    """Unverified full-stream measurement claims with no admission authority."""

    source_id: str
    source_asset_sha256: str
    source_asset_byte_length: int
    artifact_generation_id: str
    selected_video_stream_index: int
    decoder_runtime_manifest_sha256: str
    measurement_recipe_sha256: str
    measurement_analysis_status: DecodedMeasurementAnalysisStatusV1
    observed_codec: VideoCodecV1
    decoded_width_px: int
    decoded_height_px: int
    display_rotation_degrees: int
    interlace_observation: DecodedInterlaceObservationV1
    source_time_base_numerator: int
    source_time_base_denominator: int
    decoded_frame_count: int
    first_presentation_pts: int | None
    last_presentation_pts: int | None
    presentation_timing_rows_sha256: str
    selected_video_packet_count: int
    selected_video_packet_rows_sha256: str
    decoded_frame_rows_sha256: str
    missing_presentation_pts_count: int
    duplicate_presentation_pts_count: int
    regressing_presentation_pts_count: int
    cadence_status: DecodedCadenceStatusV1
    constant_presentation_pts_delta: int
    cadence_numerator: int
    cadence_denominator: int
    selected_video_payload_bytes: int
    average_payload_bitrate_numerator: int
    average_payload_bitrate_denominator: int
    identical_frame_run_count: int
    freeze_candidate_count: int
    admissible_for_training: bool = False
    admissible_for_evaluation: bool = False
    admissible_for_test: bool = False
    admissible_for_deployment: bool = False
    admissible_for_live_scoring: bool = False
    schema_version: str = DECODED_CAPTURE_MEASUREMENT_SCHEMA_VERSION

    _DOMAIN: ClassVar[str] = DECODED_CAPTURE_MEASUREMENT_RECEIPT_DOMAIN
    _LABEL: ClassVar[str] = "decoded capture measurement receipt"

    def __post_init__(self) -> None:
        if (
            type(self.schema_version) is not str
            or self.schema_version != DECODED_CAPTURE_MEASUREMENT_SCHEMA_VERSION
        ):
            raise ValueError("decoded capture measurement schema_version is invalid")
        require_stable_id(self.source_id, "source_id")
        for field_name in _TYPED_DIGEST_FIELDS:
            require_sha256(getattr(self, field_name), field_name)
        digest_values = tuple(getattr(self, name) for name in _TYPED_DIGEST_FIELDS)
        if len(set(digest_values)) != len(digest_values):
            raise ValueError("decoded measurement typed digest roles must not alias")

        source_bytes = require_exact_int(
            self.source_asset_byte_length,
            "source_asset_byte_length",
            minimum=1,
            maximum=MAX_SIGNED_64,
        )
        require_exact_int(
            self.selected_video_stream_index,
            "selected_video_stream_index",
            minimum=0,
            maximum=MAX_SIGNED_64,
        )
        _require_exact_enum(self.observed_codec, VideoCodecV1, "observed_codec")
        _require_exact_enum(
            self.measurement_analysis_status,
            DecodedMeasurementAnalysisStatusV1,
            "measurement_analysis_status",
        )
        if (
            self.measurement_analysis_status
            is not DecodedMeasurementAnalysisStatusV1.RECIPE_BOUND_FULL_STREAM_CLAIMS_UNVERIFIED
        ):
            raise ValueError("V1 decoded measurement analysis status is invalid")
        require_exact_int(
            self.decoded_width_px,
            "decoded_width_px",
            minimum=1,
            maximum=MAX_DECODED_DIMENSION_PX,
        )
        require_exact_int(
            self.decoded_height_px,
            "decoded_height_px",
            minimum=1,
            maximum=MAX_DECODED_DIMENSION_PX,
        )
        rotation = require_exact_int(
            self.display_rotation_degrees,
            "display_rotation_degrees",
            minimum=0,
            maximum=270,
        )
        if rotation not in _DISPLAY_ROTATIONS:
            raise ValueError("display_rotation_degrees must be 0, 90, 180, or 270")
        _require_exact_enum(
            self.interlace_observation,
            DecodedInterlaceObservationV1,
            "interlace_observation",
        )
        time_base_numerator, time_base_denominator = (
            _require_reduced_positive_rational(
                self.source_time_base_numerator,
                self.source_time_base_denominator,
                field_prefix="source_time_base",
            )
        )

        _validate_decoded_cadence_summary_v1(
            frame_count=self.decoded_frame_count,
            first_pts=self.first_presentation_pts,
            last_pts=self.last_presentation_pts,
            missing_count=self.missing_presentation_pts_count,
            duplicate_count=self.duplicate_presentation_pts_count,
            regression_count=self.regressing_presentation_pts_count,
            cadence_status=self.cadence_status,
            constant_delta=self.constant_presentation_pts_delta,
            cadence_numerator=self.cadence_numerator,
            cadence_denominator=self.cadence_denominator,
            time_base_numerator=time_base_numerator,
            time_base_denominator=time_base_denominator,
        )
        frame_count = self.decoded_frame_count
        first_pts = self.first_presentation_pts
        last_pts = self.last_presentation_pts

        packet_count = require_exact_int(
            self.selected_video_packet_count,
            "selected_video_packet_count",
            minimum=1,
            maximum=MAX_SIGNED_64,
        )
        payload_bytes = require_exact_int(
            self.selected_video_payload_bytes,
            "selected_video_payload_bytes",
            minimum=1,
            maximum=source_bytes,
        )
        if packet_count > payload_bytes:
            raise ValueError("selected video packet count exceeds payload bytes")

        expected_bitrate = average_payload_bitrate_rational_v1(
            selected_video_payload_bytes=payload_bytes,
            first_presentation_pts=first_pts,
            last_presentation_pts=last_pts,
            source_time_base_numerator=time_base_numerator,
            source_time_base_denominator=time_base_denominator,
        )
        if (
            self.average_payload_bitrate_numerator,
            self.average_payload_bitrate_denominator,
        ) != expected_bitrate:
            raise ValueError(
                "average payload bitrate does not bind payload bytes and PTS span"
            )

        identical_runs = require_exact_int(
            self.identical_frame_run_count,
            "identical_frame_run_count",
            minimum=0,
            maximum=frame_count,
        )
        freeze_candidates = require_exact_int(
            self.freeze_candidate_count,
            "freeze_candidate_count",
            minimum=0,
            maximum=frame_count,
        )
        if freeze_candidates > identical_runs:
            raise ValueError("freeze candidates cannot exceed identical-frame runs")

        for field_name in _AUTHORITY_FIELDS:
            if getattr(self, field_name) is not False:
                raise ValueError(f"{field_name} must be exactly false")
        self.to_json_bytes()

    def to_dict(self) -> dict[str, Any]:
        return {
            "admissible_for_deployment": self.admissible_for_deployment,
            "admissible_for_evaluation": self.admissible_for_evaluation,
            "admissible_for_live_scoring": self.admissible_for_live_scoring,
            "admissible_for_test": self.admissible_for_test,
            "admissible_for_training": self.admissible_for_training,
            "artifact_generation_id": self.artifact_generation_id,
            "average_payload_bitrate_denominator": (
                self.average_payload_bitrate_denominator
            ),
            "average_payload_bitrate_numerator": (
                self.average_payload_bitrate_numerator
            ),
            "cadence_denominator": self.cadence_denominator,
            "cadence_numerator": self.cadence_numerator,
            "cadence_status": self.cadence_status.value,
            "constant_presentation_pts_delta": (
                self.constant_presentation_pts_delta
            ),
            "decoded_frame_count": self.decoded_frame_count,
            "decoded_frame_rows_sha256": self.decoded_frame_rows_sha256,
            "decoded_height_px": self.decoded_height_px,
            "decoded_width_px": self.decoded_width_px,
            "decoder_runtime_manifest_sha256": (
                self.decoder_runtime_manifest_sha256
            ),
            "display_rotation_degrees": self.display_rotation_degrees,
            "domain": self._DOMAIN,
            "duplicate_presentation_pts_count": (
                self.duplicate_presentation_pts_count
            ),
            "first_presentation_pts": self.first_presentation_pts,
            "freeze_candidate_count": self.freeze_candidate_count,
            "identical_frame_run_count": self.identical_frame_run_count,
            "interlace_observation": self.interlace_observation.value,
            "last_presentation_pts": self.last_presentation_pts,
            "measurement_analysis_status": self.measurement_analysis_status.value,
            "measurement_recipe_sha256": self.measurement_recipe_sha256,
            "missing_presentation_pts_count": (
                self.missing_presentation_pts_count
            ),
            "observed_codec": self.observed_codec.value,
            "presentation_timing_rows_sha256": (
                self.presentation_timing_rows_sha256
            ),
            "regressing_presentation_pts_count": (
                self.regressing_presentation_pts_count
            ),
            "schema_version": self.schema_version,
            "selected_video_packet_count": self.selected_video_packet_count,
            "selected_video_packet_rows_sha256": (
                self.selected_video_packet_rows_sha256
            ),
            "selected_video_payload_bytes": self.selected_video_payload_bytes,
            "selected_video_stream_index": self.selected_video_stream_index,
            "source_asset_byte_length": self.source_asset_byte_length,
            "source_asset_sha256": self.source_asset_sha256,
            "source_id": self.source_id,
            "source_time_base_denominator": self.source_time_base_denominator,
            "source_time_base_numerator": self.source_time_base_numerator,
        }

    def to_json_bytes(self) -> bytes:
        return canonical_json_bytes(
            self.to_dict(),
            label=self._LABEL,
            maximum_bytes=MAX_DECODED_CAPTURE_MEASUREMENT_BYTES,
        )

    def fingerprint(self) -> str:
        return hashlib.sha256(self.to_json_bytes()).hexdigest()

    @classmethod
    def from_dict(cls, value: object) -> "DecodedCaptureMeasurementReceiptV1":
        fields = dict(
            require_exact_fields(value, _contract_field_names(), label=cls._LABEL)
        )
        fields["observed_codec"] = enum_from_json(
            VideoCodecV1, fields["observed_codec"], "observed_codec"
        )
        fields["measurement_analysis_status"] = enum_from_json(
            DecodedMeasurementAnalysisStatusV1,
            fields["measurement_analysis_status"],
            "measurement_analysis_status",
        )
        fields["interlace_observation"] = enum_from_json(
            DecodedInterlaceObservationV1,
            fields["interlace_observation"],
            "interlace_observation",
        )
        fields["cadence_status"] = enum_from_json(
            DecodedCadenceStatusV1,
            fields["cadence_status"],
            "cadence_status",
        )
        return cls(**fields)

    @classmethod
    def from_json_bytes(
        cls, raw: bytes
    ) -> "DecodedCaptureMeasurementReceiptV1":
        payload = require_exact_fields(
            parse_canonical_json_object(
                raw,
                label=cls._LABEL,
                maximum_bytes=MAX_DECODED_CAPTURE_MEASUREMENT_BYTES,
                maximum_depth=3,
                maximum_nodes=128,
                maximum_containers=4,
            ),
            {"domain", *_contract_field_names()},
            label=cls._LABEL,
        )
        if payload.pop("domain") != cls._DOMAIN:
            raise ValueError("decoded capture measurement receipt domain is invalid")
        result = cls.from_dict(payload)
        if result.to_json_bytes() != raw:
            raise ValueError(
                "decoded capture measurement receipt reconstruction changed bytes"
            )
        return result


__all__ = [
    "DECODED_CAPTURE_MEASUREMENT_RECEIPT_DOMAIN",
    "DECODED_CAPTURE_MEASUREMENT_SCHEMA_VERSION",
    "DecodedCadenceDerivationV1",
    "DecodedCadenceStatusV1",
    "DecodedCaptureMeasurementReceiptV1",
    "DecodedInterlaceObservationV1",
    "DecodedMeasurementAnalysisStatusV1",
    "average_payload_bitrate_rational_v1",
    "derive_exact_decoded_cadence_v1",
]
