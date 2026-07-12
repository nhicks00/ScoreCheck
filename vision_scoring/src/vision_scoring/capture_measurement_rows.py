"""Canonical streaming rows for decoded-capture measurement receipts.

These contracts describe only bounded decoder observations.  They do not
carry file paths, capture transport, source provenance, profile identity,
readiness, admission, or scoring authority.  The aggregators are deliberately
one-pass and retain only scalar summaries plus one current identical-frame
run.  Their output remains an unverified, recipe-bound claim until a protected
verifier independently replays the committed rows.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
import hashlib
from itertools import zip_longest
import math
from typing import Any, ClassVar, Iterable

from .capture_measurement_commands import CAPTURE_MEASUREMENT_RECIPE_SHA256_V1
from .capture_measurement_contracts import (
    MAX_DECODED_CAPTURE_MEASUREMENT_BYTES,
    DecodedCadenceDerivationV1,
    DecodedCaptureMeasurementReceiptV1,
    DecodedInterlaceObservationV1,
    DecodedMeasurementAnalysisStatusV1,
    average_payload_bitrate_rational_v1,
    derive_exact_decoded_cadence_v1,
)
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


CAPTURE_MEASUREMENT_ROW_SCHEMA_VERSION = "1.0"
MAX_CAPTURE_MEASUREMENT_ROW_BYTES = 4 * 1024
MAX_DECODED_DIMENSION_PX = 16_384

PRESENTATION_TIMING_ROW_DOMAIN = "multicourt-vision-scoring:presentation-timing-row:v1"
SELECTED_VIDEO_PACKET_ROW_DOMAIN = (
    "multicourt-vision-scoring:selected-video-packet-row:v1"
)
DECODED_FRAME_ROW_DOMAIN = "multicourt-vision-scoring:decoded-frame-row:v1"
DECODED_MEASUREMENT_RECIPE_DOMAIN = (
    "multicourt-vision-scoring:decoded-measurement-recipe:v1"
)
PRESENTATION_TIMING_ROW_SET_DOMAIN = (
    "multicourt-vision-scoring:presentation-timing-row-set:v1"
)
SELECTED_VIDEO_PACKET_ROW_SET_DOMAIN = (
    "multicourt-vision-scoring:selected-video-packet-row-set:v1"
)
DECODED_FRAME_ROW_SET_DOMAIN = "multicourt-vision-scoring:decoded-frame-row-set:v1"

_DISPLAY_ROTATIONS = frozenset({0, 90, 180, 270})
_AUTHORITY_FIELDS = (
    "admissible_for_training",
    "admissible_for_evaluation",
    "admissible_for_test",
    "admissible_for_deployment",
    "admissible_for_live_scoring",
)


class DecodedFrameInterlaceFactV1(str, Enum):
    """Per-frame scan fact emitted by the bound decoder recipe."""

    PROGRESSIVE = "PROGRESSIVE"
    INTERLACED = "INTERLACED"
    UNKNOWN = "UNKNOWN"


class DecodedFrameContentDigestBasisV1(str, Enum):
    """The exact byte representation hashed for identical-pixel candidates."""

    BITEXACT_NOAUTOROTATE_BT709_LIMITED_RGB24_FRAME_BYTES_SHA256 = (
        "BITEXACT_NOAUTOROTATE_BT709_LIMITED_RGB24_FRAME_BYTES_SHA256"
    )


def _require_schema(value: object, label: str) -> None:
    if type(value) is not str or value != CAPTURE_MEASUREMENT_ROW_SCHEMA_VERSION:
        raise ValueError(f"{label} schema_version is invalid")


def _require_exact_enum(value: object, enum_type: type[Enum], field: str) -> None:
    if type(value) is not enum_type:
        raise ValueError(f"{field} must be an exact {enum_type.__name__}")


def _require_authority_false(value: object, field: str) -> None:
    if value is not False:
        raise ValueError(f"{field} must be exactly false")


def _require_time_base(numerator: object, denominator: object) -> tuple[int, int]:
    numerator_value = require_exact_int(
        numerator,
        "source_time_base_numerator",
        minimum=1,
        maximum=MAX_SIGNED_64,
    )
    denominator_value = require_exact_int(
        denominator,
        "source_time_base_denominator",
        minimum=1,
        maximum=MAX_SIGNED_64,
    )
    if math.gcd(numerator_value, denominator_value) != 1:
        raise ValueError("source time base must be a reduced positive rational")
    return numerator_value, denominator_value


def _require_optional_pts(value: object) -> int | None:
    if value is None:
        return None
    return require_exact_int(
        value,
        "presentation_pts",
        minimum=MIN_SIGNED_64,
        maximum=MAX_SIGNED_64,
    )


def _require_optional_packet_timestamp(value: object, field: str) -> int | None:
    if value is None:
        return None
    return require_exact_int(
        value,
        field,
        minimum=MIN_SIGNED_64,
        maximum=MAX_SIGNED_64,
    )


def _public_field_names(contract_type: type[object]) -> set[str]:
    return {
        name
        for name in contract_type.__dataclass_fields__  # type: ignore[attr-defined]
        if not name.startswith("_")
    }


def _parse_row(
    raw: bytes, *, contract_type: type[object], domain: str, label: str
) -> dict[str, Any]:
    payload = require_exact_fields(
        parse_canonical_json_object(
            raw,
            label=label,
            maximum_bytes=MAX_CAPTURE_MEASUREMENT_ROW_BYTES,
            maximum_depth=3,
            maximum_nodes=64,
            maximum_containers=4,
        ),
        {"domain", *_public_field_names(contract_type)},
        label=label,
    )
    if payload.pop("domain") != domain:
        raise ValueError(f"{label} domain is invalid")
    return payload


class _CanonicalContract:
    _DOMAIN: ClassVar[str]
    _LABEL: ClassVar[str]

    def to_dict(self) -> dict[str, Any]:
        result: dict[str, Any] = {"domain": self._DOMAIN}
        for name in _public_field_names(type(self)):
            value = getattr(self, name)
            result[name] = value.value if isinstance(value, Enum) else value
        return result

    def to_json_bytes(self) -> bytes:
        return canonical_json_bytes(
            self.to_dict(),
            label=self._LABEL,
            maximum_bytes=MAX_CAPTURE_MEASUREMENT_ROW_BYTES,
        )

    def fingerprint(self) -> str:
        return hashlib.sha256(self.to_json_bytes()).hexdigest()


def _reconstruct_canonical_contract(
    value: object,
    *,
    contract_type: type[_CanonicalContract],
    label: str,
) -> tuple[Any, bytes]:
    """Revalidate frozen objects from bytes; type identity is not authority."""

    if type(value) is not contract_type:
        raise ValueError(f"{label} must be an exact {contract_type.__name__}")
    try:
        raw = value.to_json_bytes()  # type: ignore[attr-defined]
        reconstructed = contract_type.from_json_bytes(raw)  # type: ignore[attr-defined]
    except (AttributeError, TypeError, ValueError) as exc:
        raise ValueError(f"{label} is not a valid canonical contract") from exc
    return reconstructed, raw


@dataclass(frozen=True, slots=True)
class PresentationTimingRowV1(_CanonicalContract):
    decoded_frame_ordinal: int
    selected_video_stream_index: int
    presentation_pts: int | None
    source_time_base_numerator: int
    source_time_base_denominator: int
    admissible_for_training: bool = False
    admissible_for_evaluation: bool = False
    admissible_for_test: bool = False
    admissible_for_deployment: bool = False
    admissible_for_live_scoring: bool = False
    schema_version: str = CAPTURE_MEASUREMENT_ROW_SCHEMA_VERSION

    _DOMAIN: ClassVar[str] = PRESENTATION_TIMING_ROW_DOMAIN
    _LABEL: ClassVar[str] = "presentation timing row"

    def __post_init__(self) -> None:
        _require_schema(self.schema_version, self._LABEL)
        require_exact_int(
            self.decoded_frame_ordinal,
            "decoded_frame_ordinal",
            minimum=0,
            maximum=MAX_SIGNED_64,
        )
        require_exact_int(
            self.selected_video_stream_index,
            "selected_video_stream_index",
            minimum=0,
            maximum=MAX_SIGNED_64,
        )
        _require_optional_pts(self.presentation_pts)
        _require_time_base(
            self.source_time_base_numerator,
            self.source_time_base_denominator,
        )
        for field in _AUTHORITY_FIELDS:
            _require_authority_false(getattr(self, field), field)
        self.to_json_bytes()

    @classmethod
    def from_dict(cls, value: object) -> "PresentationTimingRowV1":
        return cls(
            **require_exact_fields(value, _public_field_names(cls), label=cls._LABEL)
        )

    @classmethod
    def from_json_bytes(cls, raw: bytes) -> "PresentationTimingRowV1":
        result = cls.from_dict(
            _parse_row(raw, contract_type=cls, domain=cls._DOMAIN, label=cls._LABEL)
        )
        if result.to_json_bytes() != raw:
            raise ValueError("presentation timing row reconstruction changed bytes")
        return result


@dataclass(frozen=True, slots=True)
class SelectedVideoPacketPayloadRowV1(_CanonicalContract):
    packet_ordinal: int
    selected_video_stream_index: int
    payload_byte_length: int
    packet_pts: int | None = None
    packet_dts: int | None = None
    admissible_for_training: bool = False
    admissible_for_evaluation: bool = False
    admissible_for_test: bool = False
    admissible_for_deployment: bool = False
    admissible_for_live_scoring: bool = False
    schema_version: str = CAPTURE_MEASUREMENT_ROW_SCHEMA_VERSION

    _DOMAIN: ClassVar[str] = SELECTED_VIDEO_PACKET_ROW_DOMAIN
    _LABEL: ClassVar[str] = "selected video packet payload row"

    def __post_init__(self) -> None:
        _require_schema(self.schema_version, self._LABEL)
        require_exact_int(
            self.packet_ordinal,
            "packet_ordinal",
            minimum=0,
            maximum=MAX_SIGNED_64,
        )
        require_exact_int(
            self.selected_video_stream_index,
            "selected_video_stream_index",
            minimum=0,
            maximum=MAX_SIGNED_64,
        )
        require_exact_int(
            self.payload_byte_length,
            "payload_byte_length",
            minimum=1,
            maximum=MAX_SIGNED_64,
        )
        _require_optional_packet_timestamp(self.packet_pts, "packet_pts")
        _require_optional_packet_timestamp(self.packet_dts, "packet_dts")
        for field in _AUTHORITY_FIELDS:
            _require_authority_false(getattr(self, field), field)
        self.to_json_bytes()

    @classmethod
    def from_dict(cls, value: object) -> "SelectedVideoPacketPayloadRowV1":
        return cls(
            **require_exact_fields(value, _public_field_names(cls), label=cls._LABEL)
        )

    @classmethod
    def from_json_bytes(cls, raw: bytes) -> "SelectedVideoPacketPayloadRowV1":
        result = cls.from_dict(
            _parse_row(raw, contract_type=cls, domain=cls._DOMAIN, label=cls._LABEL)
        )
        if result.to_json_bytes() != raw:
            raise ValueError(
                "selected video packet payload row reconstruction changed bytes"
            )
        return result


@dataclass(frozen=True, slots=True)
class DecodedFrameContentRowV1(_CanonicalContract):
    decoded_frame_ordinal: int
    selected_video_stream_index: int
    presentation_pts: int | None
    decoded_pixel_sha256: str
    decoded_width_px: int
    decoded_height_px: int
    display_rotation_degrees: int
    interlace_fact: DecodedFrameInterlaceFactV1
    source_time_base_numerator: int
    source_time_base_denominator: int
    admissible_for_training: bool = False
    admissible_for_evaluation: bool = False
    admissible_for_test: bool = False
    admissible_for_deployment: bool = False
    admissible_for_live_scoring: bool = False
    schema_version: str = CAPTURE_MEASUREMENT_ROW_SCHEMA_VERSION

    _DOMAIN: ClassVar[str] = DECODED_FRAME_ROW_DOMAIN
    _LABEL: ClassVar[str] = "decoded frame content row"

    def __post_init__(self) -> None:
        _require_schema(self.schema_version, self._LABEL)
        require_exact_int(
            self.decoded_frame_ordinal,
            "decoded_frame_ordinal",
            minimum=0,
            maximum=MAX_SIGNED_64,
        )
        require_exact_int(
            self.selected_video_stream_index,
            "selected_video_stream_index",
            minimum=0,
            maximum=MAX_SIGNED_64,
        )
        _require_optional_pts(self.presentation_pts)
        require_sha256(self.decoded_pixel_sha256, "decoded_pixel_sha256")
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
            self.interlace_fact,
            DecodedFrameInterlaceFactV1,
            "interlace_fact",
        )
        _require_time_base(
            self.source_time_base_numerator,
            self.source_time_base_denominator,
        )
        for field in _AUTHORITY_FIELDS:
            _require_authority_false(getattr(self, field), field)
        self.to_json_bytes()

    @classmethod
    def from_dict(cls, value: object) -> "DecodedFrameContentRowV1":
        fields = dict(
            require_exact_fields(value, _public_field_names(cls), label=cls._LABEL)
        )
        fields["interlace_fact"] = enum_from_json(
            DecodedFrameInterlaceFactV1,
            fields["interlace_fact"],
            "interlace_fact",
        )
        return cls(**fields)

    @classmethod
    def from_json_bytes(cls, raw: bytes) -> "DecodedFrameContentRowV1":
        result = cls.from_dict(
            _parse_row(raw, contract_type=cls, domain=cls._DOMAIN, label=cls._LABEL)
        )
        if result.to_json_bytes() != raw:
            raise ValueError("decoded frame content row reconstruction changed bytes")
        return result


@dataclass(frozen=True, slots=True)
class DecodedMeasurementRecipeV1(_CanonicalContract):
    """Exact candidate-counting rule bound by the receipt recipe digest."""

    content_digest_basis: DecodedFrameContentDigestBasisV1
    capture_measurement_command_recipe_sha256: str
    identical_frame_run_minimum_frames: int
    freeze_candidate_minimum_frames: int
    admissible_for_training: bool = False
    admissible_for_evaluation: bool = False
    admissible_for_test: bool = False
    admissible_for_deployment: bool = False
    admissible_for_live_scoring: bool = False
    schema_version: str = CAPTURE_MEASUREMENT_ROW_SCHEMA_VERSION

    _DOMAIN: ClassVar[str] = DECODED_MEASUREMENT_RECIPE_DOMAIN
    _LABEL: ClassVar[str] = "decoded measurement recipe"

    def __post_init__(self) -> None:
        _require_schema(self.schema_version, self._LABEL)
        _require_exact_enum(
            self.content_digest_basis,
            DecodedFrameContentDigestBasisV1,
            "content_digest_basis",
        )
        command_recipe_sha256 = require_sha256(
            self.capture_measurement_command_recipe_sha256,
            "capture_measurement_command_recipe_sha256",
        )
        if command_recipe_sha256 != CAPTURE_MEASUREMENT_RECIPE_SHA256_V1:
            raise ValueError(
                "capture measurement command recipe SHA-256 is not the fixed V1 recipe"
            )
        identical_minimum = require_exact_int(
            self.identical_frame_run_minimum_frames,
            "identical_frame_run_minimum_frames",
            minimum=2,
            maximum=MAX_SIGNED_64,
        )
        freeze_minimum = require_exact_int(
            self.freeze_candidate_minimum_frames,
            "freeze_candidate_minimum_frames",
            minimum=2,
            maximum=MAX_SIGNED_64,
        )
        if freeze_minimum < identical_minimum:
            raise ValueError(
                "freeze candidate minimum cannot be below identical-run minimum"
            )
        for field in _AUTHORITY_FIELDS:
            _require_authority_false(getattr(self, field), field)
        self.to_json_bytes()

    @classmethod
    def from_dict(cls, value: object) -> "DecodedMeasurementRecipeV1":
        fields = dict(
            require_exact_fields(value, _public_field_names(cls), label=cls._LABEL)
        )
        fields["content_digest_basis"] = enum_from_json(
            DecodedFrameContentDigestBasisV1,
            fields["content_digest_basis"],
            "content_digest_basis",
        )
        return cls(**fields)

    @classmethod
    def from_json_bytes(cls, raw: bytes) -> "DecodedMeasurementRecipeV1":
        result = cls.from_dict(
            _parse_row(raw, contract_type=cls, domain=cls._DOMAIN, label=cls._LABEL)
        )
        if result.to_json_bytes() != raw:
            raise ValueError("decoded measurement recipe reconstruction changed bytes")
        return result


class _RollingRowSetDigest:
    """Constant-memory, domain-separated digest over exact ordered row bytes."""

    __slots__ = ("_count", "_hasher")

    def __init__(self, domain: str) -> None:
        self._count = 0
        self._hasher = hashlib.sha256()
        self._hasher.update(domain.encode("ascii"))
        self._hasher.update(b"\x00rows\x00")

    def add(self, raw: bytes) -> None:
        if self._count == MAX_SIGNED_64:
            raise ValueError("row count exceeds signed 64-bit")
        if (
            type(raw) is not bytes
            or not 1 <= len(raw) <= MAX_CAPTURE_MEASUREMENT_ROW_BYTES
        ):
            raise ValueError("row bytes are not exact bounded bytes")
        self._hasher.update(b"row\x00")
        self._hasher.update(len(raw).to_bytes(8, "big", signed=False))
        self._hasher.update(raw)
        self._count += 1

    @property
    def count(self) -> int:
        return self._count

    def finish(self) -> str:
        if self._count == 0:
            raise ValueError("row set must contain at least one row")
        self._hasher.update(b"count\x00")
        self._hasher.update(self._count.to_bytes(8, "big", signed=False))
        return self._hasher.hexdigest()


def _exact_iterator(rows: object, label: str) -> Any:
    """Yield one hostile iterable through a stable validation boundary."""

    try:
        iterator = iter(rows)  # type: ignore[arg-type]
    except Exception as exc:
        raise ValueError(f"{label} iteration failed") from exc
    while True:
        try:
            yield next(iterator)
        except StopIteration:
            return
        except Exception as exc:
            raise ValueError(f"{label} iteration failed") from exc


@dataclass(frozen=True, slots=True)
class PresentationTimingAggregationV1:
    cadence: DecodedCadenceDerivationV1
    rows_sha256: str


@dataclass(frozen=True, slots=True)
class SelectedVideoPacketAggregationV1:
    packet_count: int
    payload_bytes: int
    rows_sha256: str


@dataclass(frozen=True, slots=True)
class DecodedFrameAggregationV1:
    frame_count: int
    decoded_width_px: int
    decoded_height_px: int
    display_rotation_degrees: int
    source_time_base_numerator: int
    source_time_base_denominator: int
    interlace_observation: DecodedInterlaceObservationV1
    identical_frame_run_count: int
    freeze_candidate_count: int
    rows_sha256: str


@dataclass(frozen=True, slots=True)
class PairedPresentationFrameAggregationV1:
    presentation_timing: PresentationTimingAggregationV1
    decoded_frames: DecodedFrameAggregationV1


def _canonical_recipe(value: object) -> DecodedMeasurementRecipeV1:
    recipe, _ = _reconstruct_canonical_contract(
        value,
        contract_type=DecodedMeasurementRecipeV1,
        label="recipe",
    )
    return recipe


class _PresentationAccumulator:
    __slots__ = ("_digest", "_selected_stream", "_time_base")

    def __init__(self, selected_stream: int) -> None:
        self._digest = _RollingRowSetDigest(PRESENTATION_TIMING_ROW_SET_DOMAIN)
        self._selected_stream = selected_stream
        self._time_base: tuple[int, int] | None = None

    @property
    def time_base(self) -> tuple[int, int]:
        if self._time_base is None:
            raise ValueError("presentation timing rows must not be empty")
        return self._time_base

    def add(self, value: object, expected_ordinal: int) -> int | None:
        row, raw = _reconstruct_canonical_contract(
            value,
            contract_type=PresentationTimingRowV1,
            label="presentation timing row",
        )
        if row.decoded_frame_ordinal != expected_ordinal:
            raise ValueError(
                "presentation timing row ordinals must be contiguous from zero"
            )
        if row.selected_video_stream_index != self._selected_stream:
            raise ValueError("presentation timing row belongs to another stream")
        row_time_base = (
            row.source_time_base_numerator,
            row.source_time_base_denominator,
        )
        if self._time_base is None:
            self._time_base = row_time_base
        elif row_time_base != self._time_base:
            raise ValueError("presentation timing row time base changed")
        self._digest.add(raw)
        return row.presentation_pts

    def finish(
        self, cadence: DecodedCadenceDerivationV1
    ) -> PresentationTimingAggregationV1:
        if cadence.decoded_frame_count != self._digest.count:
            raise AssertionError("cadence and presentation row counts diverged")
        return PresentationTimingAggregationV1(
            cadence=cadence,
            rows_sha256=self._digest.finish(),
        )


class _FrameAccumulator:
    __slots__ = (
        "_current_pixel_sha256",
        "_current_run_length",
        "_digest",
        "_freeze_candidates",
        "_geometry",
        "_identical_runs",
        "_observed_scan_facts",
        "_recipe",
        "_selected_stream",
        "_time_base",
    )

    def __init__(
        self, selected_stream: int, recipe: DecodedMeasurementRecipeV1
    ) -> None:
        self._selected_stream = selected_stream
        self._recipe = recipe
        self._digest = _RollingRowSetDigest(DECODED_FRAME_ROW_SET_DOMAIN)
        self._geometry: tuple[int, int, int] | None = None
        self._time_base: tuple[int, int] | None = None
        self._observed_scan_facts: set[DecodedFrameInterlaceFactV1] = set()
        self._current_pixel_sha256: str | None = None
        self._current_run_length = 0
        self._identical_runs = 0
        self._freeze_candidates = 0

    def _finalize_run(self) -> None:
        if self._current_run_length >= self._recipe.identical_frame_run_minimum_frames:
            self._identical_runs += 1
        if self._current_run_length >= self._recipe.freeze_candidate_minimum_frames:
            self._freeze_candidates += 1

    def add(self, value: object, expected_ordinal: int) -> int | None:
        row, raw = _reconstruct_canonical_contract(
            value,
            contract_type=DecodedFrameContentRowV1,
            label="decoded frame row",
        )
        if row.decoded_frame_ordinal != expected_ordinal:
            raise ValueError("decoded frame row ordinals must be contiguous from zero")
        if row.selected_video_stream_index != self._selected_stream:
            raise ValueError("decoded frame row belongs to another stream")
        row_geometry = (
            row.decoded_width_px,
            row.decoded_height_px,
            row.display_rotation_degrees,
        )
        row_time_base = (
            row.source_time_base_numerator,
            row.source_time_base_denominator,
        )
        if self._geometry is None:
            self._geometry = row_geometry
            self._time_base = row_time_base
        elif row_geometry != self._geometry:
            raise ValueError("decoded frame geometry or display rotation changed")
        elif row_time_base != self._time_base:
            raise ValueError("decoded frame time base changed")
        self._observed_scan_facts.add(row.interlace_fact)
        if row.decoded_pixel_sha256 == self._current_pixel_sha256:
            self._current_run_length += 1
        else:
            if self._current_pixel_sha256 is not None:
                self._finalize_run()
            self._current_pixel_sha256 = row.decoded_pixel_sha256
            self._current_run_length = 1
        self._digest.add(raw)
        return row.presentation_pts

    def finish(self) -> DecodedFrameAggregationV1:
        if self._digest.count == 0 or self._geometry is None or self._time_base is None:
            raise ValueError("decoded frame rows must not be empty")
        self._finalize_run()
        if self._observed_scan_facts == {DecodedFrameInterlaceFactV1.PROGRESSIVE}:
            interlace = DecodedInterlaceObservationV1.PROGRESSIVE_ONLY
        elif self._observed_scan_facts == {DecodedFrameInterlaceFactV1.INTERLACED}:
            interlace = DecodedInterlaceObservationV1.INTERLACED_OBSERVED
        elif self._observed_scan_facts == {DecodedFrameInterlaceFactV1.UNKNOWN}:
            interlace = DecodedInterlaceObservationV1.UNKNOWN
        else:
            interlace = DecodedInterlaceObservationV1.MIXED
        return DecodedFrameAggregationV1(
            frame_count=self._digest.count,
            decoded_width_px=self._geometry[0],
            decoded_height_px=self._geometry[1],
            display_rotation_degrees=self._geometry[2],
            source_time_base_numerator=self._time_base[0],
            source_time_base_denominator=self._time_base[1],
            interlace_observation=interlace,
            identical_frame_run_count=self._identical_runs,
            freeze_candidate_count=self._freeze_candidates,
            rows_sha256=self._digest.finish(),
        )


def aggregate_presentation_timing_rows_v1(
    rows: Iterable[PresentationTimingRowV1],
    *,
    selected_video_stream_index: int,
) -> PresentationTimingAggregationV1:
    """Validate and summarize exact presentation rows in one pass."""

    selected_stream = require_exact_int(
        selected_video_stream_index,
        "selected_video_stream_index",
        minimum=0,
        maximum=MAX_SIGNED_64,
    )
    accumulator = _PresentationAccumulator(selected_stream)
    iterator = _exact_iterator(rows, "presentation timing rows")
    sentinel = object()
    first_row = next(iterator, sentinel)
    if first_row is sentinel:
        raise ValueError("presentation timing rows must not be empty")
    first_pts = accumulator.add(first_row, 0)

    def presentation_pts() -> Iterable[int | None]:
        yield first_pts
        for expected_ordinal, row in enumerate(iterator, start=1):
            yield accumulator.add(row, expected_ordinal)

    time_base = accumulator.time_base
    cadence = derive_exact_decoded_cadence_v1(
        presentation_pts(),
        source_time_base_numerator=time_base[0],
        source_time_base_denominator=time_base[1],
    )
    return accumulator.finish(cadence)


def aggregate_selected_video_packet_rows_v1(
    rows: Iterable[SelectedVideoPacketPayloadRowV1],
    *,
    selected_video_stream_index: int,
) -> SelectedVideoPacketAggregationV1:
    """Validate selected-stream packet payload facts in one bounded pass."""

    selected_stream = require_exact_int(
        selected_video_stream_index,
        "selected_video_stream_index",
        minimum=0,
        maximum=MAX_SIGNED_64,
    )
    digest = _RollingRowSetDigest(SELECTED_VIDEO_PACKET_ROW_SET_DOMAIN)
    payload_bytes = 0
    for expected_ordinal, value in enumerate(
        _exact_iterator(rows, "selected video packet rows")
    ):
        row, raw = _reconstruct_canonical_contract(
            value,
            contract_type=SelectedVideoPacketPayloadRowV1,
            label="selected video packet row",
        )
        if row.packet_ordinal != expected_ordinal:
            raise ValueError("packet row ordinals must be contiguous from zero")
        if row.selected_video_stream_index != selected_stream:
            raise ValueError("packet row belongs to another stream")
        if payload_bytes > MAX_SIGNED_64 - row.payload_byte_length:
            raise ValueError("selected video payload bytes exceed signed 64-bit")
        payload_bytes += row.payload_byte_length
        digest.add(raw)
    return SelectedVideoPacketAggregationV1(
        packet_count=digest.count,
        payload_bytes=payload_bytes,
        rows_sha256=digest.finish(),
    )


def aggregate_decoded_frame_rows_v1(
    rows: Iterable[DecodedFrameContentRowV1],
    *,
    selected_video_stream_index: int,
    recipe: DecodedMeasurementRecipeV1,
) -> DecodedFrameAggregationV1:
    """Aggregate geometry, scan facts, and recipe-bound identical candidates."""

    selected_stream = require_exact_int(
        selected_video_stream_index,
        "selected_video_stream_index",
        minimum=0,
        maximum=MAX_SIGNED_64,
    )
    canonical_recipe = _canonical_recipe(recipe)
    accumulator = _FrameAccumulator(selected_stream, canonical_recipe)
    for expected_ordinal, row in enumerate(_exact_iterator(rows, "decoded frame rows")):
        accumulator.add(row, expected_ordinal)
    return accumulator.finish()


def aggregate_paired_presentation_and_frame_rows_v1(
    presentation_timing_rows: Iterable[PresentationTimingRowV1],
    decoded_frame_rows: Iterable[DecodedFrameContentRowV1],
    *,
    selected_video_stream_index: int,
    recipe: DecodedMeasurementRecipeV1,
) -> PairedPresentationFrameAggregationV1:
    """Join frame content to presentation PTS by exact ordinal in one pass."""

    selected_stream = require_exact_int(
        selected_video_stream_index,
        "selected_video_stream_index",
        minimum=0,
        maximum=MAX_SIGNED_64,
    )
    canonical_recipe = _canonical_recipe(recipe)
    timing_accumulator = _PresentationAccumulator(selected_stream)
    frame_accumulator = _FrameAccumulator(selected_stream, canonical_recipe)
    timing_iterator = _exact_iterator(
        presentation_timing_rows, "presentation timing rows"
    )
    frame_iterator = _exact_iterator(decoded_frame_rows, "decoded frame rows")
    sentinel = object()
    first_timing = next(timing_iterator, sentinel)
    first_frame = next(frame_iterator, sentinel)
    if first_timing is sentinel and first_frame is sentinel:
        raise ValueError("presentation timing and decoded frame rows must not be empty")
    if first_timing is sentinel or first_frame is sentinel:
        raise ValueError("decoded frame and presentation timing row counts differ")
    first_pts = timing_accumulator.add(first_timing, 0)
    first_frame_pts = frame_accumulator.add(first_frame, 0)
    if first_frame_pts != first_pts:
        raise ValueError("decoded frame PTS does not match presentation timing row")

    def paired_pts() -> Iterable[int | None]:
        yield first_pts
        for expected_ordinal, (timing_value, frame_value) in enumerate(
            zip_longest(timing_iterator, frame_iterator, fillvalue=sentinel),
            start=1,
        ):
            if timing_value is sentinel or frame_value is sentinel:
                raise ValueError(
                    "decoded frame and presentation timing row counts differ"
                )
            presentation_pts = timing_accumulator.add(timing_value, expected_ordinal)
            frame_pts = frame_accumulator.add(frame_value, expected_ordinal)
            if frame_pts != presentation_pts:
                raise ValueError(
                    "decoded frame PTS does not match presentation timing row"
                )
            yield presentation_pts

    time_base = timing_accumulator.time_base
    cadence = derive_exact_decoded_cadence_v1(
        paired_pts(),
        source_time_base_numerator=time_base[0],
        source_time_base_denominator=time_base[1],
    )
    timing = timing_accumulator.finish(cadence)
    frames = frame_accumulator.finish()
    if (
        frames.source_time_base_numerator,
        frames.source_time_base_denominator,
    ) != time_base:
        raise ValueError("decoded frame and presentation timing time bases differ")
    return PairedPresentationFrameAggregationV1(
        presentation_timing=timing,
        decoded_frames=frames,
    )


def build_decoded_capture_measurement_receipt_v1(
    *,
    source_id: str,
    source_asset_sha256: str,
    source_asset_byte_length: int,
    artifact_generation_id: str,
    selected_video_stream_index: int,
    decoder_runtime_manifest_sha256: str,
    observed_codec: VideoCodecV1,
    recipe: DecodedMeasurementRecipeV1,
    presentation_timing_rows: Iterable[PresentationTimingRowV1],
    selected_video_packet_rows: Iterable[SelectedVideoPacketPayloadRowV1],
    decoded_frame_rows: Iterable[DecodedFrameContentRowV1],
) -> DecodedCaptureMeasurementReceiptV1:
    """Construct one non-authorizing receipt from three exact row streams."""

    require_stable_id(source_id, "source_id")
    require_sha256(source_asset_sha256, "source_asset_sha256")
    require_exact_int(
        source_asset_byte_length,
        "source_asset_byte_length",
        minimum=1,
        maximum=MAX_SIGNED_64,
    )
    require_sha256(artifact_generation_id, "artifact_generation_id")
    selected_stream = require_exact_int(
        selected_video_stream_index,
        "selected_video_stream_index",
        minimum=0,
        maximum=MAX_SIGNED_64,
    )
    require_sha256(
        decoder_runtime_manifest_sha256,
        "decoder_runtime_manifest_sha256",
    )
    _require_exact_enum(observed_codec, VideoCodecV1, "observed_codec")
    canonical_recipe = _canonical_recipe(recipe)
    paired = aggregate_paired_presentation_and_frame_rows_v1(
        presentation_timing_rows,
        decoded_frame_rows,
        selected_video_stream_index=selected_stream,
        recipe=canonical_recipe,
    )
    timing = paired.presentation_timing
    frames = paired.decoded_frames
    packets = aggregate_selected_video_packet_rows_v1(
        selected_video_packet_rows,
        selected_video_stream_index=selected_stream,
    )
    cadence = timing.cadence
    average_bitrate = average_payload_bitrate_rational_v1(
        selected_video_payload_bytes=packets.payload_bytes,
        first_presentation_pts=cadence.first_presentation_pts,
        last_presentation_pts=cadence.last_presentation_pts,
        source_time_base_numerator=cadence.source_time_base_numerator,
        source_time_base_denominator=cadence.source_time_base_denominator,
    )
    receipt = DecodedCaptureMeasurementReceiptV1(
        source_id=source_id,
        source_asset_sha256=source_asset_sha256,
        source_asset_byte_length=source_asset_byte_length,
        artifact_generation_id=artifact_generation_id,
        selected_video_stream_index=selected_stream,
        decoder_runtime_manifest_sha256=decoder_runtime_manifest_sha256,
        measurement_recipe_sha256=canonical_recipe.fingerprint(),
        measurement_analysis_status=(
            DecodedMeasurementAnalysisStatusV1.RECIPE_BOUND_FULL_STREAM_CLAIMS_UNVERIFIED
        ),
        observed_codec=observed_codec,
        decoded_width_px=frames.decoded_width_px,
        decoded_height_px=frames.decoded_height_px,
        display_rotation_degrees=frames.display_rotation_degrees,
        interlace_observation=frames.interlace_observation,
        source_time_base_numerator=cadence.source_time_base_numerator,
        source_time_base_denominator=cadence.source_time_base_denominator,
        decoded_frame_count=cadence.decoded_frame_count,
        first_presentation_pts=cadence.first_presentation_pts,
        last_presentation_pts=cadence.last_presentation_pts,
        presentation_timing_rows_sha256=timing.rows_sha256,
        selected_video_packet_count=packets.packet_count,
        selected_video_packet_rows_sha256=packets.rows_sha256,
        decoded_frame_rows_sha256=frames.rows_sha256,
        missing_presentation_pts_count=cadence.missing_presentation_pts_count,
        duplicate_presentation_pts_count=cadence.duplicate_presentation_pts_count,
        regressing_presentation_pts_count=(cadence.regressing_presentation_pts_count),
        cadence_status=cadence.cadence_status,
        constant_presentation_pts_delta=cadence.constant_presentation_pts_delta,
        cadence_numerator=cadence.cadence_numerator,
        cadence_denominator=cadence.cadence_denominator,
        selected_video_payload_bytes=packets.payload_bytes,
        average_payload_bitrate_numerator=average_bitrate[0],
        average_payload_bitrate_denominator=average_bitrate[1],
        identical_frame_run_count=frames.identical_frame_run_count,
        freeze_candidate_count=frames.freeze_candidate_count,
    )
    if len(receipt.to_json_bytes()) > MAX_DECODED_CAPTURE_MEASUREMENT_BYTES:
        raise AssertionError("decoded capture measurement receipt exceeded its bound")
    return receipt


__all__ = [
    "CAPTURE_MEASUREMENT_ROW_SCHEMA_VERSION",
    "DECODED_FRAME_ROW_DOMAIN",
    "DECODED_MEASUREMENT_RECIPE_DOMAIN",
    "PRESENTATION_TIMING_ROW_DOMAIN",
    "SELECTED_VIDEO_PACKET_ROW_DOMAIN",
    "DecodedFrameAggregationV1",
    "DecodedFrameContentDigestBasisV1",
    "DecodedFrameContentRowV1",
    "DecodedFrameInterlaceFactV1",
    "DecodedMeasurementRecipeV1",
    "PairedPresentationFrameAggregationV1",
    "PresentationTimingAggregationV1",
    "PresentationTimingRowV1",
    "SelectedVideoPacketAggregationV1",
    "SelectedVideoPacketPayloadRowV1",
    "aggregate_decoded_frame_rows_v1",
    "aggregate_paired_presentation_and_frame_rows_v1",
    "aggregate_presentation_timing_rows_v1",
    "aggregate_selected_video_packet_rows_v1",
    "build_decoded_capture_measurement_receipt_v1",
]
