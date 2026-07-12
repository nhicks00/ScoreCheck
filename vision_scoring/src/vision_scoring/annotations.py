"""Strict, immutable annotation contracts for source-pixel evidence.

This module intentionally defines annotation truth, not a training-file format.
Coordinates are expressed only in the referenced source frame's pixel space.
``ADJUDICATED`` requires an independent reviewer and adjudicator, but this
object-level rule does not claim that a dataset satisfies the release-test
double-annotation policy. Dataset coverage and sampling remain a separate gate.
"""

from __future__ import annotations

import hashlib
import json
import math
import re
import unicodedata
from dataclasses import dataclass
from enum import Enum
from typing import Any

from .contracts import Team


SCHEMA_VERSION = "1.0"
_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
_CONTENT_ADDRESS_RE = re.compile(r"^sha256:[0-9a-f]{64}$")
_ASCII_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,127}$")
_GEOMETRY_TOLERANCE = 1e-6
_MAX_UTF8_TEXT_BYTES = 2_048
_MAX_REVIEWERS_PER_ANNOTATION = 16
_MAX_EVIDENCE_REFS_PER_ANNOTATION = 64
_MAX_CAPTURE_ATTESTATION_REFS = 16
_MAX_SOURCE_DIMENSION_PX = 65_536
_MAX_SIGNED_64_BIT_INTEGER = (1 << 63) - 1


def _require_sha256(value: object, field_name: str) -> None:
    if not isinstance(value, str) or not _SHA256_RE.fullmatch(value):
        raise ValueError(f"{field_name} must be a lowercase 64-character SHA-256")


def _require_ascii_id(value: object, field_name: str) -> None:
    if type(value) is not str or not _ASCII_ID_RE.fullmatch(value):
        raise ValueError(
            f"{field_name} must be a non-empty ASCII-stable identifier"
        )


def _require_nfc_utf8_text(value: object, field_name: str) -> None:
    if type(value) is not str or not value or value != value.strip():
        raise ValueError(f"{field_name} must be non-empty trimmed UTF-8 text")
    try:
        encoded = value.encode("utf-8", errors="strict")
    except UnicodeEncodeError as error:
        raise ValueError(f"{field_name} must be valid UTF-8 text") from error
    if len(encoded) > _MAX_UTF8_TEXT_BYTES:
        raise ValueError(
            f"{field_name} cannot exceed {_MAX_UTF8_TEXT_BYTES} UTF-8 bytes"
        )
    if unicodedata.normalize("NFC", value) != value:
        raise ValueError(f"{field_name} must use Unicode NFC normalization")


def _validate_id_tuple(
    value: object,
    field_name: str,
    *,
    required: bool = False,
    max_items: int,
) -> None:
    if not isinstance(value, tuple):
        raise ValueError(f"{field_name} must be a tuple of ASCII-stable identifiers")
    if required and not value:
        raise ValueError(f"{field_name} cannot be empty")
    if len(value) > max_items:
        raise ValueError(f"{field_name} cannot exceed {max_items} items")
    for item in value:
        _require_ascii_id(item, f"{field_name} item")
    if len(set(value)) != len(value):
        raise ValueError(f"{field_name} cannot contain duplicates")


def _validate_content_address_tuple(
    value: object,
    field_name: str,
    *,
    required: bool = False,
    max_items: int,
) -> None:
    if not isinstance(value, tuple):
        raise ValueError(f"{field_name} must be a tuple of SHA-256 content addresses")
    if required and not value:
        raise ValueError(f"{field_name} cannot be empty")
    if len(value) > max_items:
        raise ValueError(f"{field_name} cannot exceed {max_items} items")
    for item in value:
        if type(item) is not str or not _CONTENT_ADDRESS_RE.fullmatch(item):
            raise ValueError(
                f"{field_name} items must be exact sha256:<64 lowercase hex> content addresses"
            )
    if len(set(value)) != len(value):
        raise ValueError(f"{field_name} cannot contain duplicates")


def _normalized_finite_number(value: object, field_name: str) -> float:
    if (
        not isinstance(value, (int, float))
        or isinstance(value, bool)
        or not math.isfinite(value)
    ):
        raise ValueError(f"{field_name} must be a finite number, not a boolean")
    normalized = float(value)
    return 0.0 if normalized == 0.0 else normalized


def _canonical_string_list(values: tuple[str, ...]) -> list[str]:
    return sorted(values)


class _CanonicalContract:
    __slots__ = ()

    def to_canonical_dict(self) -> dict[str, Any]:
        raise NotImplementedError

    def canonical_json(self) -> str:
        return json.dumps(
            self.to_canonical_dict(),
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=False,
            allow_nan=False,
        )

    def fingerprint(self) -> str:
        return hashlib.sha256(self.canonical_json().encode("utf-8")).hexdigest()


class BallState(str, Enum):
    VISIBLE = "VISIBLE"
    BLUR = "BLUR"
    OCCLUDED = "OCCLUDED"
    OUT_OF_FRAME = "OUT_OF_FRAME"
    ABSENT = "ABSENT"


class ReviewState(str, Enum):
    DRAFT = "DRAFT"
    REVIEWED = "REVIEWED"
    ADJUDICATED = "ADJUDICATED"


class PixelCoordinateSpace(str, Enum):
    SOURCE_PIXEL_CENTERS_TOP_LEFT_X_RIGHT_Y_DOWN = (
        "SOURCE_PIXEL_CENTERS_TOP_LEFT_X_RIGHT_Y_DOWN"
    )


class TimestampBasis(str, Enum):
    SOURCE_PRESENTATION_OFFSET_NS = "SOURCE_PRESENTATION_OFFSET_NS"


class DecodedFrameHashBasis(str, Enum):
    """Exact byte layout hashed by ``DecodedFrameIdentity``.

    The RGB24 basis hashes exactly ``width * height * 3`` bytes. Rows are
    ordered from y=0 through y=height-1, pixels within a row from x=0 through
    x=width-1, and each pixel is the unsigned byte triple R, G, B. There is no
    header, row stride/padding, timestamp, or metadata in the hash input. The
    source pixel grid is hashed after decode and before resize, crop, display
    rotation, or augmentation.
    """

    RGB24_SOURCE_DIMENSIONS_ROW_MAJOR_NO_PADDING = (
        "RGB24_SOURCE_DIMENSIONS_ROW_MAJOR_NO_PADDING"
    )


class AutorotationPolicy(str, Enum):
    IGNORE_CONTAINER_DISPLAY_TRANSFORM = "IGNORE_CONTAINER_DISPLAY_TRANSFORM"


class DecodedColorSpace(str, Enum):
    BT601 = "BT601"
    BT709 = "BT709"
    BT2020_NCL = "BT2020_NCL"
    SRGB = "SRGB"


class DecodedColorRange(str, Enum):
    LIMITED = "LIMITED"
    FULL = "FULL"


class DecodedPixelFormat(str, Enum):
    RGB24 = "RGB24"


class FrameDuplicateKind(str, Enum):
    NONE = "NONE"
    PIXEL_EQUIVALENT = "PIXEL_EQUIVALENT"
    VERIFIED_CAPTURE_DUPLICATE = "VERIFIED_CAPTURE_DUPLICATE"


@dataclass(frozen=True, slots=True)
class FrameDecodeContract(_CanonicalContract):
    """Pinned recipe that produced a decoded frame's canonical pixel grid."""

    decoder_artifact_sha256: str
    decoder_build_id: str
    autorotation_policy: AutorotationPolicy
    color_space: DecodedColorSpace
    color_range: DecodedColorRange
    output_pixel_format: DecodedPixelFormat
    output_width: int
    output_height: int

    def __post_init__(self) -> None:
        _require_sha256(self.decoder_artifact_sha256, "decoder_artifact_sha256")
        _require_ascii_id(self.decoder_build_id, "decoder_build_id")
        if type(self.autorotation_policy) is not AutorotationPolicy:
            raise ValueError("autorotation_policy must be an AutorotationPolicy")
        if type(self.color_space) is not DecodedColorSpace:
            raise ValueError("color_space must be a DecodedColorSpace")
        if type(self.color_range) is not DecodedColorRange:
            raise ValueError("color_range must be a DecodedColorRange")
        if type(self.output_pixel_format) is not DecodedPixelFormat:
            raise ValueError("output_pixel_format must be a DecodedPixelFormat")
        if (
            type(self.output_width) is not int
            or type(self.output_height) is not int
            or self.output_width <= 0
            or self.output_height <= 0
            or self.output_width > _MAX_SOURCE_DIMENSION_PX
            or self.output_height > _MAX_SOURCE_DIMENSION_PX
        ):
            raise ValueError(
                "decode output dimensions must be positive integers no greater "
                f"than {_MAX_SOURCE_DIMENSION_PX}"
            )

    def to_canonical_dict(self) -> dict[str, Any]:
        return {
            "autorotation_policy": self.autorotation_policy.value,
            "color_range": self.color_range.value,
            "color_space": self.color_space.value,
            "decoder_artifact_sha256": self.decoder_artifact_sha256,
            "decoder_build_id": self.decoder_build_id,
            "output_height": self.output_height,
            "output_pixel_format": self.output_pixel_format.value,
            "output_width": self.output_width,
            "schema_version": SCHEMA_VERSION,
        }


@dataclass(frozen=True, slots=True)
class DecodedFrameIdentity(_CanonicalContract):
    """Full identity of one canonical decode output.

    The selected video stream, presentation position, decoder artifact/build,
    rotation policy, color conversion, range, output format/dimensions, and
    decoded bytes all participate in equality and the canonical fingerprint.
    """

    source_sha256: str
    selected_video_stream_index: int
    frame_index: int
    timestamp_ns: int
    timestamp_basis: TimestampBasis
    pixel_coordinate_space: PixelCoordinateSpace
    decode_contract: FrameDecodeContract
    decoded_frame_sha256: str
    decoded_frame_hash_basis: DecodedFrameHashBasis

    def __post_init__(self) -> None:
        _require_sha256(self.source_sha256, "source_sha256")
        if (
            type(self.selected_video_stream_index) is not int
            or self.selected_video_stream_index < 0
            or self.selected_video_stream_index > _MAX_SIGNED_64_BIT_INTEGER
        ):
            raise ValueError(
                "selected_video_stream_index must be a non-negative integer"
            )
        if (
            type(self.frame_index) is not int
            or self.frame_index < 0
            or self.frame_index > _MAX_SIGNED_64_BIT_INTEGER
        ):
            raise ValueError("frame_index must be a non-negative integer")
        if (
            type(self.timestamp_ns) is not int
            or self.timestamp_ns < 0
            or self.timestamp_ns > _MAX_SIGNED_64_BIT_INTEGER
        ):
            raise ValueError("timestamp_ns must be a non-negative integer")
        if type(self.timestamp_basis) is not TimestampBasis:
            raise ValueError("timestamp_basis must be a TimestampBasis")
        if type(self.pixel_coordinate_space) is not PixelCoordinateSpace:
            raise ValueError("pixel_coordinate_space must be a PixelCoordinateSpace")
        if type(self.decode_contract) is not FrameDecodeContract:
            raise ValueError("decode_contract must be a FrameDecodeContract")
        _require_sha256(self.decoded_frame_sha256, "decoded_frame_sha256")
        if type(self.decoded_frame_hash_basis) is not DecodedFrameHashBasis:
            raise ValueError(
                "decoded_frame_hash_basis must be a DecodedFrameHashBasis"
            )
        if (
            self.decoded_frame_hash_basis
            is DecodedFrameHashBasis.RGB24_SOURCE_DIMENSIONS_ROW_MAJOR_NO_PADDING
            and self.decode_contract.output_pixel_format is not DecodedPixelFormat.RGB24
        ):
            raise ValueError("RGB24 hash basis requires RGB24 decode output")

    @property
    def width(self) -> int:
        return self.decode_contract.output_width

    @property
    def height(self) -> int:
        return self.decode_contract.output_height

    def to_canonical_dict(self) -> dict[str, Any]:
        return {
            "decode_contract": self.decode_contract.to_canonical_dict(),
            "decoded_frame_hash_basis": self.decoded_frame_hash_basis.value,
            "decoded_frame_sha256": self.decoded_frame_sha256,
            "frame_index": self.frame_index,
            "pixel_coordinate_space": self.pixel_coordinate_space.value,
            "schema_version": SCHEMA_VERSION,
            "selected_video_stream_index": self.selected_video_stream_index,
            "source_sha256": self.source_sha256,
            "timestamp_basis": self.timestamp_basis.value,
            "timestamp_ns": self.timestamp_ns,
        }


class EventType(str, Enum):
    SET_START = "SET_START"
    SERVE_PREPARATION = "SERVE_PREPARATION"
    SERVE_CONTACT = "SERVE_CONTACT"
    RALLY_START = "RALLY_START"
    RALLY_END = "RALLY_END"
    CANDIDATE_CONTACT = "CANDIDATE_CONTACT"
    BALL_BOUNCE = "BALL_BOUNCE"
    DEAD_BALL = "DEAD_BALL"
    NEXT_AUTHORIZED_SERVE = "NEXT_AUTHORIZED_SERVE"
    REPLAY = "REPLAY"
    CHALLENGE = "CHALLENGE"
    REPORTED_ADMINISTRATIVE_POINT = "REPORTED_ADMINISTRATIVE_POINT"
    CORRECTION = "CORRECTION"
    TERMINAL_POINT = "TERMINAL_POINT"
    SIDE_SWITCH = "SIDE_SWITCH"


class TeamAttributionRole(str, Enum):
    SERVING_TEAM = "SERVING_TEAM"
    CONTACT_TEAM = "CONTACT_TEAM"
    RALLY_WINNER = "RALLY_WINNER"
    CHALLENGING_TEAM = "CHALLENGING_TEAM"
    POINT_AWARDED_TEAM = "POINT_AWARDED_TEAM"


class PlayerAttributionRole(str, Enum):
    SERVING_PLAYER = "SERVING_PLAYER"
    CONTACTING_PLAYER = "CONTACTING_PLAYER"


class AttributionState(str, Enum):
    NOT_APPLICABLE = "NOT_APPLICABLE"
    UNKNOWN = "UNKNOWN"
    KNOWN = "KNOWN"


_TEAM_ROLE_BY_EVENT = {
    EventType.SERVE_PREPARATION: TeamAttributionRole.SERVING_TEAM,
    EventType.SERVE_CONTACT: TeamAttributionRole.SERVING_TEAM,
    EventType.RALLY_END: TeamAttributionRole.RALLY_WINNER,
    EventType.CANDIDATE_CONTACT: TeamAttributionRole.CONTACT_TEAM,
    EventType.NEXT_AUTHORIZED_SERVE: TeamAttributionRole.SERVING_TEAM,
    EventType.CHALLENGE: TeamAttributionRole.CHALLENGING_TEAM,
    EventType.REPORTED_ADMINISTRATIVE_POINT: TeamAttributionRole.POINT_AWARDED_TEAM,
    EventType.TERMINAL_POINT: TeamAttributionRole.POINT_AWARDED_TEAM,
}
_PLAYER_ROLE_BY_EVENT = {
    EventType.SERVE_PREPARATION: PlayerAttributionRole.SERVING_PLAYER,
    EventType.SERVE_CONTACT: PlayerAttributionRole.SERVING_PLAYER,
    EventType.CANDIDATE_CONTACT: PlayerAttributionRole.CONTACTING_PLAYER,
    EventType.NEXT_AUTHORIZED_SERVE: PlayerAttributionRole.SERVING_PLAYER,
}


@dataclass(frozen=True, slots=True)
class PixelPoint(_CanonicalContract):
    """A point in the source image, before any coordinate transform."""

    x: float
    y: float

    def __post_init__(self) -> None:
        object.__setattr__(self, "x", _normalized_finite_number(self.x, "x"))
        object.__setattr__(self, "y", _normalized_finite_number(self.y, "y"))

    def to_canonical_dict(self) -> dict[str, Any]:
        return {"schema_version": SCHEMA_VERSION, "x": self.x, "y": self.y}


@dataclass(frozen=True, slots=True)
class BlurEllipse(_CanonicalContract):
    """Ellipse shape centered on ``BallFrameAnnotation.center``.

    ``angle_degrees`` is the major-axis angle measured clockwise from the
    positive x-axis in image coordinates (x right, y down).
    """

    major_radius_px: float
    minor_radius_px: float
    angle_degrees: float

    def __post_init__(self) -> None:
        major = _normalized_finite_number(self.major_radius_px, "major_radius_px")
        minor = _normalized_finite_number(self.minor_radius_px, "minor_radius_px")
        angle = _normalized_finite_number(self.angle_degrees, "angle_degrees")
        if major <= 0.0 or minor <= 0.0:
            raise ValueError("blur ellipse radii must be positive")
        if major < minor:
            raise ValueError("major_radius_px cannot be smaller than minor_radius_px")
        if not 0.0 <= angle < 180.0:
            raise ValueError("angle_degrees must be in [0, 180)")
        object.__setattr__(self, "major_radius_px", major)
        object.__setattr__(self, "minor_radius_px", minor)
        object.__setattr__(self, "angle_degrees", angle)

    def to_canonical_dict(self) -> dict[str, Any]:
        return {
            "angle_degrees": self.angle_degrees,
            "major_radius_px": self.major_radius_px,
            "minor_radius_px": self.minor_radius_px,
            "schema_version": SCHEMA_VERSION,
        }


@dataclass(frozen=True, slots=True)
class FrameReference(_CanonicalContract):
    """Annotation reference plus a conservative duplicate classification.

    ``identity`` is independent of annotation policy and may therefore also be
    carried by model predictions. A duplicate pointer is always relative to
    the same source, selected stream, and decode contract and must name an
    earlier frame. Pixel equivalence alone is recorded but never excluded from
    evaluation. ``VERIFIED_CAPTURE_DUPLICATE`` additionally requires immutable
    supporting capture-integrity evidence before it can be considered for
    exclusion by a dataset evaluator. These references are opaque human-review
    evidence: trusted reviewer and adjudicator signatures authorize the
    duplicate claim. They are not, by themselves, a signature from a
    capture-device principal.
    """

    identity: DecodedFrameIdentity
    duplicate_kind: FrameDuplicateKind = FrameDuplicateKind.NONE
    duplicate_of_frame_index: int | None = None
    capture_integrity_attestation_refs: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        if type(self.identity) is not DecodedFrameIdentity:
            raise ValueError("identity must be a DecodedFrameIdentity")
        if type(self.duplicate_kind) is not FrameDuplicateKind:
            raise ValueError("duplicate_kind must be a FrameDuplicateKind")
        _validate_content_address_tuple(
            self.capture_integrity_attestation_refs,
            "capture_integrity_attestation_refs",
            max_items=_MAX_CAPTURE_ATTESTATION_REFS,
        )

        if self.duplicate_kind is FrameDuplicateKind.NONE:
            if self.duplicate_of_frame_index is not None:
                raise ValueError("NONE duplicate kind cannot name an original frame")
            if self.capture_integrity_attestation_refs:
                raise ValueError("NONE duplicate kind cannot claim capture attestations")
            return

        if self.duplicate_of_frame_index is None:
            raise ValueError(f"{self.duplicate_kind.value} requires an earlier frame pointer")
        if self.duplicate_of_frame_index is not None:
            if (
                type(self.duplicate_of_frame_index) is not int
                or self.duplicate_of_frame_index < 0
                or self.duplicate_of_frame_index > _MAX_SIGNED_64_BIT_INTEGER
            ):
                raise ValueError(
                    "duplicate_of_frame_index must be a non-negative integer or None"
                )
            if self.duplicate_of_frame_index >= self.frame_index:
                raise ValueError(
                    "duplicate_of_frame_index must reference an earlier frame "
                    "in the same source"
                )

        if self.duplicate_kind is FrameDuplicateKind.PIXEL_EQUIVALENT:
            if self.capture_integrity_attestation_refs:
                raise ValueError(
                    "PIXEL_EQUIVALENT cannot claim capture-integrity attestations"
                )
        elif not self.capture_integrity_attestation_refs:
            raise ValueError(
                "VERIFIED_CAPTURE_DUPLICATE requires capture-integrity "
                "attestation evidence"
            )

    @property
    def source_sha256(self) -> str:
        return self.identity.source_sha256

    @property
    def selected_video_stream_index(self) -> int:
        return self.identity.selected_video_stream_index

    @property
    def frame_index(self) -> int:
        return self.identity.frame_index

    @property
    def timestamp_ns(self) -> int:
        return self.identity.timestamp_ns

    @property
    def timestamp_basis(self) -> TimestampBasis:
        return self.identity.timestamp_basis

    @property
    def pixel_coordinate_space(self) -> PixelCoordinateSpace:
        return self.identity.pixel_coordinate_space

    @property
    def decode_contract(self) -> FrameDecodeContract:
        return self.identity.decode_contract

    @property
    def width(self) -> int:
        return self.identity.width

    @property
    def height(self) -> int:
        return self.identity.height

    @property
    def decoded_frame_sha256(self) -> str:
        return self.identity.decoded_frame_sha256

    @property
    def decoded_frame_hash_basis(self) -> DecodedFrameHashBasis:
        return self.identity.decoded_frame_hash_basis

    @property
    def is_excludable_capture_duplicate(self) -> bool:
        return self.duplicate_kind is FrameDuplicateKind.VERIFIED_CAPTURE_DUPLICATE

    def to_canonical_dict(self) -> dict[str, Any]:
        return {
            "capture_integrity_attestation_refs": _canonical_string_list(
                self.capture_integrity_attestation_refs
            ),
            "duplicate_kind": self.duplicate_kind.value,
            "duplicate_of_frame_index": self.duplicate_of_frame_index,
            "identity": self.identity.to_canonical_dict(),
            "schema_version": SCHEMA_VERSION,
        }


def _validate_review(
    *,
    review_state: object,
    reviewer_ids: object,
    review_evidence_refs: object,
    adjudicator_id: object,
    adjudication_evidence_refs: object,
) -> None:
    if type(review_state) is not ReviewState:
        raise ValueError("review_state must be a ReviewState")
    _validate_id_tuple(
        reviewer_ids,
        "reviewer_ids",
        max_items=_MAX_REVIEWERS_PER_ANNOTATION,
    )
    _validate_content_address_tuple(
        review_evidence_refs,
        "review_evidence_refs",
        max_items=_MAX_EVIDENCE_REFS_PER_ANNOTATION,
    )
    _validate_content_address_tuple(
        adjudication_evidence_refs,
        "adjudication_evidence_refs",
        max_items=_MAX_EVIDENCE_REFS_PER_ANNOTATION,
    )
    if len(review_evidence_refs) + len(adjudication_evidence_refs) > (
        _MAX_EVIDENCE_REFS_PER_ANNOTATION
    ):
        raise ValueError(
            "review and adjudication evidence cannot exceed "
            f"{_MAX_EVIDENCE_REFS_PER_ANNOTATION} total refs per annotation"
        )
    if adjudicator_id is not None:
        _require_ascii_id(adjudicator_id, "adjudicator_id")

    if review_state is ReviewState.DRAFT:
        if (
            reviewer_ids
            or review_evidence_refs
            or adjudicator_id is not None
            or adjudication_evidence_refs
        ):
            raise ValueError("DRAFT cannot claim review or adjudication evidence")
        return

    if not reviewer_ids or not review_evidence_refs:
        raise ValueError("reviewed annotations require reviewer IDs and review evidence")

    if review_state is ReviewState.REVIEWED:
        if adjudicator_id is not None or adjudication_evidence_refs:
            raise ValueError("REVIEWED cannot claim adjudication evidence")
        return

    if adjudicator_id is None or not adjudication_evidence_refs:
        raise ValueError("ADJUDICATED requires an adjudicator and adjudication evidence")
    if adjudicator_id in reviewer_ids:
        raise ValueError("adjudicator must be independent of the reviewers")


def _point_within_frame(point: PixelPoint, frame: FrameReference, field_name: str) -> None:
    if not (0.0 <= point.x <= frame.width - 1 and 0.0 <= point.y <= frame.height - 1):
        raise ValueError(f"{field_name} must be within source pixel bounds")


def _ellipse_within_frame(
    center: PixelPoint,
    ellipse: BlurEllipse,
    frame: FrameReference,
) -> None:
    angle = math.radians(ellipse.angle_degrees)
    x_extent = math.sqrt(
        (ellipse.major_radius_px * math.cos(angle)) ** 2
        + (ellipse.minor_radius_px * math.sin(angle)) ** 2
    )
    y_extent = math.sqrt(
        (ellipse.major_radius_px * math.sin(angle)) ** 2
        + (ellipse.minor_radius_px * math.cos(angle)) ** 2
    )
    if (
        center.x - x_extent < -_GEOMETRY_TOLERANCE
        or center.x + x_extent > frame.width - 1 + _GEOMETRY_TOLERANCE
        or center.y - y_extent < -_GEOMETRY_TOLERANCE
        or center.y + y_extent > frame.height - 1 + _GEOMETRY_TOLERANCE
    ):
        raise ValueError("blur_ellipse must be within source pixel bounds")


@dataclass(frozen=True, slots=True)
class BallFrameAnnotation(_CanonicalContract):
    """A ball-state label for one source frame.

    BLUR geometry has exactly one representation. ``blur_start`` and
    ``blur_end`` are the paired major-axis endpoints whose midpoint is
    ``center``; alternatively, ``blur_ellipse`` carries the full ellipse.
    VISIBLE and BLUR labels also record the observed minor-axis diameter so
    localization error can be reported in resolution- and scale-normalized
    ball diameters instead of pixels alone.
    """

    annotation_id: str
    frame: FrameReference
    state: BallState
    center: PixelPoint | None = None
    blur_start: PixelPoint | None = None
    blur_end: PixelPoint | None = None
    blur_ellipse: BlurEllipse | None = None
    apparent_minor_axis_diameter_px: float | None = None
    uncertainty_radius_px: float | None = None
    ambiguity_reason: str | None = None
    track_segment_id: str | None = None
    review_state: ReviewState = ReviewState.DRAFT
    reviewer_ids: tuple[str, ...] = ()
    review_evidence_refs: tuple[str, ...] = ()
    adjudicator_id: str | None = None
    adjudication_evidence_refs: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        _require_ascii_id(self.annotation_id, "annotation_id")
        if type(self.frame) is not FrameReference:
            raise ValueError("frame must be a FrameReference")
        if type(self.state) is not BallState:
            raise ValueError("state must be a BallState")
        for field_name in ("center", "blur_start", "blur_end"):
            point = getattr(self, field_name)
            if point is not None and type(point) is not PixelPoint:
                raise ValueError(f"{field_name} must be a PixelPoint")
            if point is not None:
                _point_within_frame(point, self.frame, field_name)
        if self.blur_ellipse is not None and type(self.blur_ellipse) is not BlurEllipse:
            raise ValueError("blur_ellipse must be a BlurEllipse")
        if self.track_segment_id is not None:
            _require_ascii_id(self.track_segment_id, "track_segment_id")
        if self.ambiguity_reason is not None:
            _require_nfc_utf8_text(self.ambiguity_reason, "ambiguity_reason")
        if self.uncertainty_radius_px is not None:
            radius = _normalized_finite_number(
                self.uncertainty_radius_px,
                "uncertainty_radius_px",
            )
            if radius <= 0.0:
                raise ValueError("uncertainty_radius_px must be positive")
            object.__setattr__(self, "uncertainty_radius_px", radius)
        if self.apparent_minor_axis_diameter_px is not None:
            diameter = _normalized_finite_number(
                self.apparent_minor_axis_diameter_px,
                "apparent_minor_axis_diameter_px",
            )
            if diameter <= 0.0 or diameter > min(self.frame.width, self.frame.height):
                raise ValueError(
                    "apparent_minor_axis_diameter_px must be positive and fit the frame"
                )
            object.__setattr__(self, "apparent_minor_axis_diameter_px", diameter)

        endpoints_are_paired = (self.blur_start is None) == (self.blur_end is None)
        if not endpoints_are_paired:
            raise ValueError("blur_start and blur_end must be provided together")

        if self.state is BallState.VISIBLE:
            if self.center is None:
                raise ValueError("VISIBLE requires an exact center")
            if self.apparent_minor_axis_diameter_px is None:
                raise ValueError("VISIBLE requires apparent_minor_axis_diameter_px")
            if self.blur_start is not None or self.blur_ellipse is not None:
                raise ValueError("VISIBLE cannot contain blur geometry")
        elif self.state is BallState.BLUR:
            if self.center is None:
                raise ValueError("BLUR requires a center")
            if self.apparent_minor_axis_diameter_px is None:
                raise ValueError("BLUR requires apparent_minor_axis_diameter_px")
            has_endpoints = self.blur_start is not None
            has_ellipse = self.blur_ellipse is not None
            if has_endpoints == has_ellipse:
                raise ValueError(
                    "BLUR requires exactly one geometry representation: "
                    "paired major-axis endpoints XOR ellipse"
                )
            if self.blur_start is not None and self.blur_end is not None:
                if self.blur_start == self.blur_end:
                    raise ValueError("blur endpoints must be distinct")
                midpoint_x = (self.blur_start.x + self.blur_end.x) / 2.0
                midpoint_y = (self.blur_start.y + self.blur_end.y) / 2.0
                if not (
                    math.isclose(self.center.x, midpoint_x, abs_tol=_GEOMETRY_TOLERANCE)
                    and math.isclose(self.center.y, midpoint_y, abs_tol=_GEOMETRY_TOLERANCE)
                ):
                    raise ValueError("blur center must equal the endpoint midpoint")
                major_axis_length = math.hypot(
                    self.blur_end.x - self.blur_start.x,
                    self.blur_end.y - self.blur_start.y,
                )
                assert self.apparent_minor_axis_diameter_px is not None
                if (
                    self.apparent_minor_axis_diameter_px
                    > major_axis_length + _GEOMETRY_TOLERANCE
                ):
                    raise ValueError(
                        "apparent_minor_axis_diameter_px cannot exceed the "
                        "blur endpoint major-axis length"
                    )
            if self.blur_ellipse is not None:
                _ellipse_within_frame(self.center, self.blur_ellipse, self.frame)
                expected_minor_axis_diameter = 2.0 * self.blur_ellipse.minor_radius_px
                assert self.apparent_minor_axis_diameter_px is not None
                if not math.isclose(
                    self.apparent_minor_axis_diameter_px,
                    expected_minor_axis_diameter,
                    rel_tol=0.0,
                    abs_tol=_GEOMETRY_TOLERANCE,
                ):
                    raise ValueError(
                        "apparent_minor_axis_diameter_px must equal twice the "
                        "blur ellipse minor radius"
                    )
        else:
            if any(
                value is not None
                for value in (
                    self.center,
                    self.blur_start,
                    self.blur_end,
                    self.blur_ellipse,
                    self.apparent_minor_axis_diameter_px,
                    self.uncertainty_radius_px,
                )
            ):
                raise ValueError(f"{self.state.value} cannot contain invented exact geometry")

        if self.state is BallState.ABSENT:
            if self.track_segment_id is not None:
                raise ValueError("ABSENT cannot belong to a track segment")
        elif self.track_segment_id is None:
            raise ValueError(f"{self.state.value} requires a track_segment_id")

        _validate_review(
            review_state=self.review_state,
            reviewer_ids=self.reviewer_ids,
            review_evidence_refs=self.review_evidence_refs,
            adjudicator_id=self.adjudicator_id,
            adjudication_evidence_refs=self.adjudication_evidence_refs,
        )
        if (
            len(self.review_evidence_refs)
            + len(self.adjudication_evidence_refs)
            + len(self.frame.capture_integrity_attestation_refs)
            > _MAX_EVIDENCE_REFS_PER_ANNOTATION
        ):
            raise ValueError(
                "annotation evidence cannot exceed "
                f"{_MAX_EVIDENCE_REFS_PER_ANNOTATION} total refs"
            )

    def to_canonical_dict(self) -> dict[str, Any]:
        return {
            "adjudication_evidence_refs": _canonical_string_list(self.adjudication_evidence_refs),
            "adjudicator_id": self.adjudicator_id,
            "ambiguity_reason": self.ambiguity_reason,
            "apparent_minor_axis_diameter_px": self.apparent_minor_axis_diameter_px,
            "annotation_id": self.annotation_id,
            "blur_ellipse": self.blur_ellipse.to_canonical_dict() if self.blur_ellipse else None,
            "blur_end": self.blur_end.to_canonical_dict() if self.blur_end else None,
            "blur_start": self.blur_start.to_canonical_dict() if self.blur_start else None,
            "center": self.center.to_canonical_dict() if self.center else None,
            "frame": self.frame.to_canonical_dict(),
            "review_evidence_refs": _canonical_string_list(self.review_evidence_refs),
            "review_state": self.review_state.value,
            "reviewer_ids": _canonical_string_list(self.reviewer_ids),
            "schema_version": SCHEMA_VERSION,
            "state": self.state.value,
            "track_segment_id": self.track_segment_id,
            "uncertainty_radius_px": self.uncertainty_radius_px,
        }


@dataclass(frozen=True, slots=True)
class TemporalEventAnnotation(_CanonicalContract):
    """An event known to occur within an inclusive source-time interval.

    ``team`` and ``player_id`` never have an implicit generic meaning. Their
    exact semantic roles are derived from ``event_type`` and exposed by
    ``team_role`` and ``player_role`` as well as the canonical payload.

    Interval bounds are offsets under ``timestamp_basis``. Zero means the
    source presentation origin, not UTC, wall-clock capture time, or receive
    time.
    """

    annotation_id: str
    source_sha256: str
    event_type: EventType
    interval_start_ns: int
    interval_end_ns: int
    timestamp_basis: TimestampBasis
    evidence_refs: tuple[str, ...]
    team_attribution_state: AttributionState
    player_attribution_state: AttributionState
    team: Team | None = None
    player_id: str | None = None
    ambiguity_reason: str | None = None
    review_state: ReviewState = ReviewState.DRAFT
    reviewer_ids: tuple[str, ...] = ()
    review_evidence_refs: tuple[str, ...] = ()
    adjudicator_id: str | None = None
    adjudication_evidence_refs: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        _require_ascii_id(self.annotation_id, "annotation_id")
        _require_sha256(self.source_sha256, "source_sha256")
        if type(self.event_type) is not EventType:
            raise ValueError("event_type must be an EventType")
        if type(self.timestamp_basis) is not TimestampBasis:
            raise ValueError("timestamp_basis must be a TimestampBasis")
        if type(self.interval_start_ns) is not int or type(self.interval_end_ns) is not int:
            raise ValueError("event interval bounds must be integers")
        if self.interval_start_ns < 0 or self.interval_end_ns < 0:
            raise ValueError("event interval bounds cannot be negative")
        if (
            self.interval_start_ns > _MAX_SIGNED_64_BIT_INTEGER
            or self.interval_end_ns > _MAX_SIGNED_64_BIT_INTEGER
        ):
            raise ValueError("event interval bounds must fit a signed 64-bit integer")
        if self.interval_end_ns < self.interval_start_ns:
            raise ValueError("event uncertainty interval cannot be inverted")
        _validate_content_address_tuple(
            self.evidence_refs,
            "evidence_refs",
            required=True,
            max_items=_MAX_EVIDENCE_REFS_PER_ANNOTATION,
        )
        if type(self.team_attribution_state) is not AttributionState:
            raise ValueError("team_attribution_state must be an AttributionState")
        if type(self.player_attribution_state) is not AttributionState:
            raise ValueError("player_attribution_state must be an AttributionState")
        if self.team is not None and type(self.team) is not Team:
            raise ValueError("team must be a Team")
        if self.player_id is not None:
            _require_ascii_id(self.player_id, "player_id")
        if self.ambiguity_reason is not None:
            _require_nfc_utf8_text(self.ambiguity_reason, "ambiguity_reason")

        team_is_applicable = self.event_type in _TEAM_ROLE_BY_EVENT
        player_is_applicable = self.event_type in _PLAYER_ROLE_BY_EVENT
        if not team_is_applicable:
            if self.team_attribution_state is not AttributionState.NOT_APPLICABLE:
                raise ValueError(
                    f"{self.event_type.value} team attribution must be NOT_APPLICABLE"
                )
            if self.team is not None:
                raise ValueError(f"{self.event_type.value} does not allow team attribution")
        elif self.team_attribution_state is AttributionState.NOT_APPLICABLE:
            raise ValueError(
                f"{self.event_type.value} requires an explicit KNOWN or UNKNOWN team attribution"
            )
        elif self.team_attribution_state is AttributionState.KNOWN:
            if self.team is None:
                raise ValueError("KNOWN team attribution requires a team")
        elif self.team is not None:
            raise ValueError("UNKNOWN team attribution cannot contain a team")

        if not player_is_applicable:
            if self.player_attribution_state is not AttributionState.NOT_APPLICABLE:
                raise ValueError(
                    f"{self.event_type.value} player attribution must be NOT_APPLICABLE"
                )
            if self.player_id is not None:
                raise ValueError(f"{self.event_type.value} does not allow player attribution")
        elif self.player_attribution_state is AttributionState.NOT_APPLICABLE:
            raise ValueError(
                f"{self.event_type.value} requires an explicit KNOWN or UNKNOWN player attribution"
            )
        elif self.player_attribution_state is AttributionState.KNOWN:
            if self.player_id is None:
                raise ValueError("KNOWN player attribution requires a player_id")
            if self.team_attribution_state is not AttributionState.KNOWN:
                raise ValueError("known player attribution requires known team attribution")
        elif self.player_id is not None:
            raise ValueError("UNKNOWN player attribution cannot contain a player_id")

        if (
            AttributionState.UNKNOWN
            in (self.team_attribution_state, self.player_attribution_state)
            and self.ambiguity_reason is None
        ):
            raise ValueError("UNKNOWN attribution requires an ambiguity_reason")

        _validate_review(
            review_state=self.review_state,
            reviewer_ids=self.reviewer_ids,
            review_evidence_refs=self.review_evidence_refs,
            adjudicator_id=self.adjudicator_id,
            adjudication_evidence_refs=self.adjudication_evidence_refs,
        )
        if (
            len(self.evidence_refs)
            + len(self.review_evidence_refs)
            + len(self.adjudication_evidence_refs)
            > _MAX_EVIDENCE_REFS_PER_ANNOTATION
        ):
            raise ValueError(
                "annotation evidence cannot exceed "
                f"{_MAX_EVIDENCE_REFS_PER_ANNOTATION} total refs"
            )

    @property
    def team_role(self) -> TeamAttributionRole | None:
        return _TEAM_ROLE_BY_EVENT.get(self.event_type)

    @property
    def player_role(self) -> PlayerAttributionRole | None:
        return _PLAYER_ROLE_BY_EVENT.get(self.event_type)

    def to_canonical_dict(self) -> dict[str, Any]:
        return {
            "adjudication_evidence_refs": _canonical_string_list(self.adjudication_evidence_refs),
            "adjudicator_id": self.adjudicator_id,
            "ambiguity_reason": self.ambiguity_reason,
            "annotation_id": self.annotation_id,
            "event_type": self.event_type.value,
            "evidence_refs": _canonical_string_list(self.evidence_refs),
            "interval_end_ns": self.interval_end_ns,
            "interval_start_ns": self.interval_start_ns,
            "player_id": self.player_id,
            "player_role": self.player_role.value if self.player_role else None,
            "review_evidence_refs": _canonical_string_list(self.review_evidence_refs),
            "review_state": self.review_state.value,
            "reviewer_ids": _canonical_string_list(self.reviewer_ids),
            "schema_version": SCHEMA_VERSION,
            "source_sha256": self.source_sha256,
            "team": self.team.value if self.team else None,
            "team_attribution_state": self.team_attribution_state.value,
            "team_role": self.team_role.value if self.team_role else None,
            "player_attribution_state": self.player_attribution_state.value,
            "timestamp_basis": self.timestamp_basis.value,
        }
