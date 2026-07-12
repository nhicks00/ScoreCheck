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

from .contract_wire import (
    CanonicalWireError,
    canonical_finite_json_bytes,
    enum_from_json,
    exact_list,
    parse_canonical_finite_json_object,
    require_exact_fields,
)
from .domain_events import Team


SCHEMA_VERSION = "2.0"
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
_MAX_BALL_FRAME_ANNOTATION_JSON_BYTES = 64 * 1024
_MAX_BALL_FRAME_ANNOTATION_JSON_DEPTH = 12
_MAX_BALL_FRAME_ANNOTATION_JSON_NODES = 4_096
_MAX_BALL_FRAME_ANNOTATION_JSON_CONTAINERS = 512


def _require_sha256(value: object, field_name: str) -> None:
    if type(value) is not str or not _SHA256_RE.fullmatch(value):
        raise ValueError(f"{field_name} must be a lowercase 64-character SHA-256")


def _require_content_address(value: object, field_name: str) -> None:
    if type(value) is not str or not _CONTENT_ADDRESS_RE.fullmatch(value):
        raise ValueError(
            f"{field_name} must be an exact sha256:<64 lowercase hex> content address"
        )


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
    if type(value) is not tuple:
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
    if type(value) is not tuple:
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


class AnnotationType(str, Enum):
    BALL_FRAME_OBSERVATION = "BALL_FRAME_OBSERVATION"
    OBSERVED_TEMPORAL_EVENT = "OBSERVED_TEMPORAL_EVENT"
    PHYSICAL_EVENT_ADJUDICATION = "PHYSICAL_EVENT_ADJUDICATION"
    REPORTED_OFFICIAL_EVENT = "REPORTED_OFFICIAL_EVENT"


class TruthLayer(str, Enum):
    OBSERVATIONAL = "OBSERVATIONAL"
    PHYSICAL_ADJUDICATION = "PHYSICAL_ADJUDICATION"
    REPORTED_OFFICIAL_UNVERIFIED = "REPORTED_OFFICIAL_UNVERIFIED"


class BallVisibility(str, Enum):
    VISIBLE = "VISIBLE"
    PARTIALLY_OCCLUDED = "PARTIALLY_OCCLUDED"
    FULLY_OCCLUDED = "FULLY_OCCLUDED"
    OUT_OF_FRAME = "OUT_OF_FRAME"
    NOT_PRESENT = "NOT_PRESENT"
    INDISTINGUISHABLE = "INDISTINGUISHABLE"
    CAPTURE_UNKNOWN = "CAPTURE_UNKNOWN"


class BallAppearance(str, Enum):
    SHARP = "SHARP"
    MOTION_BLURRED = "MOTION_BLURRED"
    NOT_OBSERVABLE = "NOT_OBSERVABLE"


class BallRole(str, Enum):
    MATCH_BALL = "MATCH_BALL"
    SPARE_BALL = "SPARE_BALL"
    ADJACENT_COURT_BALL = "ADJACENT_COURT_BALL"
    RETRIEVER_BALL = "RETRIEVER_BALL"
    WARMUP_BALL = "WARMUP_BALL"
    UNKNOWN = "UNKNOWN"


class BallPlayState(str, Enum):
    IN_PLAY = "IN_PLAY"
    NOT_IN_PLAY = "NOT_IN_PLAY"
    UNKNOWN = "UNKNOWN"
    NOT_APPLICABLE = "NOT_APPLICABLE"


class SearchRegionScope(str, Enum):
    FULL_DECODED_FRAME = "FULL_DECODED_FRAME"


class SearchRegionVisibility(str, Enum):
    FULLY_OBSERVABLE = "FULLY_OBSERVABLE"


class CaptureUnavailabilityReason(str, Enum):
    MISSING_CAPTURE_SEGMENT = "MISSING_CAPTURE_SEGMENT"
    PRESENTATION_GAP = "PRESENTATION_GAP"
    CORRUPT_ENCODED_FRAME = "CORRUPT_ENCODED_FRAME"
    DECODE_FAILED = "DECODE_FAILED"
    CLOCK_MAPPING_UNRESOLVED = "CLOCK_MAPPING_UNRESOLVED"


class ReportedOfficialVerificationState(str, Enum):
    UNVERIFIED = "UNVERIFIED"


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


class ObservedTemporalEventType(str, Enum):
    WHISTLE = "WHISTLE"
    SERVICE_AUTHORIZATION_SIGNAL = "SERVICE_AUTHORIZATION_SIGNAL"
    TOSS_RELEASE = "TOSS_RELEASE"
    SERVE_CONTACT = "SERVE_CONTACT"
    PLAYER_CONTACT_CANDIDATE = "PLAYER_CONTACT_CANDIDATE"
    NET_CROSSING_CANDIDATE = "NET_CROSSING_CANDIDATE"
    LANDING_CANDIDATE = "LANDING_CANDIDATE"
    OUT_OF_PLAY_CANDIDATE = "OUT_OF_PLAY_CANDIDATE"
    RALLY_END_SIGNAL = "RALLY_END_SIGNAL"
    REFEREE_DIRECTION = "REFEREE_DIRECTION"
    CHALLENGE_REQUEST = "CHALLENGE_REQUEST"
    TIMEOUT_SIGNAL = "TIMEOUT_SIGNAL"
    SIDE_SWITCH_OBSERVATION = "SIDE_SWITCH_OBSERVATION"
    SCOREBOARD_DISPLAY_CHANGE = "SCOREBOARD_DISPLAY_CHANGE"
    NEXT_SERVER_OBSERVATION = "NEXT_SERVER_OBSERVATION"


class PhysicalEventType(str, Enum):
    OBSERVED_CONTACT = "OBSERVED_CONTACT"
    LANDING_REGION = "LANDING_REGION"
    NET_CONTACT = "NET_CONTACT"
    ANTENNA_CONTACT = "ANTENNA_CONTACT"
    LAST_TOUCH = "LAST_TOUCH"
    ORDINARY_RALLY_WINNER = "ORDINARY_RALLY_WINNER"
    PHYSICAL_INTERFERENCE = "PHYSICAL_INTERFERENCE"
    UNRESOLVED = "UNRESOLVED"


class PhysicalLandingRegion(str, Enum):
    IN_BOUNDS = "IN_BOUNDS"
    OUT_OF_BOUNDS = "OUT_OF_BOUNDS"
    LINE = "LINE"
    UNRESOLVED = "UNRESOLVED"


class ReportedOfficialEventType(str, Enum):
    SET_SEED = "SET_SEED"
    SET_START = "SET_START"
    ORDINARY_POINT = "ORDINARY_POINT"
    REPLAY_NO_POINT = "REPLAY_NO_POINT"
    CHALLENGE_RESULT = "CHALLENGE_RESULT"
    REPORTED_SANCTION = "REPORTED_SANCTION"
    REPORTED_SERVICE_ORDER_REMEDY = "REPORTED_SERVICE_ORDER_REMEDY"
    REQUESTED_TIMEOUT = "REQUESTED_TIMEOUT"
    TECHNICAL_TIMEOUT = "TECHNICAL_TIMEOUT"
    SIDE_SWITCH = "SIDE_SWITCH"
    REPORTED_CORRECTION = "REPORTED_CORRECTION"
    SET_END = "SET_END"
    MATCH_END = "MATCH_END"
    INTERRUPTION = "INTERRUPTION"
    RESUMPTION = "RESUMPTION"


class TeamAttributionRole(str, Enum):
    SERVING_TEAM = "SERVING_TEAM"
    CONTACT_TEAM = "CONTACT_TEAM"
    PHYSICAL_RALLY_WINNER = "PHYSICAL_RALLY_WINNER"
    LAST_TOUCH_TEAM = "LAST_TOUCH_TEAM"
    RESPONSIBLE_TEAM = "RESPONSIBLE_TEAM"
    SIGNALLED_TEAM = "SIGNALLED_TEAM"
    CHALLENGING_TEAM = "CHALLENGING_TEAM"
    REQUESTING_TEAM = "REQUESTING_TEAM"
    POINT_AWARDED_TEAM = "POINT_AWARDED_TEAM"


class PlayerAttributionRole(str, Enum):
    SERVING_PLAYER = "SERVING_PLAYER"
    CONTACTING_PLAYER = "CONTACTING_PLAYER"
    LAST_TOUCH_PLAYER = "LAST_TOUCH_PLAYER"
    RESPONSIBLE_PLAYER = "RESPONSIBLE_PLAYER"


class AttributionState(str, Enum):
    NOT_APPLICABLE = "NOT_APPLICABLE"
    UNKNOWN = "UNKNOWN"
    KNOWN = "KNOWN"


_OBSERVED_TEAM_ROLE_BY_EVENT = {
    ObservedTemporalEventType.SERVICE_AUTHORIZATION_SIGNAL: (
        TeamAttributionRole.SERVING_TEAM
    ),
    ObservedTemporalEventType.TOSS_RELEASE: TeamAttributionRole.SERVING_TEAM,
    ObservedTemporalEventType.SERVE_CONTACT: TeamAttributionRole.SERVING_TEAM,
    ObservedTemporalEventType.PLAYER_CONTACT_CANDIDATE: (
        TeamAttributionRole.CONTACT_TEAM
    ),
    ObservedTemporalEventType.REFEREE_DIRECTION: TeamAttributionRole.SIGNALLED_TEAM,
    ObservedTemporalEventType.CHALLENGE_REQUEST: TeamAttributionRole.CHALLENGING_TEAM,
    ObservedTemporalEventType.NEXT_SERVER_OBSERVATION: (
        TeamAttributionRole.SERVING_TEAM
    ),
}
_OBSERVED_PLAYER_ROLE_BY_EVENT = {
    ObservedTemporalEventType.SERVICE_AUTHORIZATION_SIGNAL: (
        PlayerAttributionRole.SERVING_PLAYER
    ),
    ObservedTemporalEventType.TOSS_RELEASE: PlayerAttributionRole.SERVING_PLAYER,
    ObservedTemporalEventType.SERVE_CONTACT: PlayerAttributionRole.SERVING_PLAYER,
    ObservedTemporalEventType.PLAYER_CONTACT_CANDIDATE: (
        PlayerAttributionRole.CONTACTING_PLAYER
    ),
    ObservedTemporalEventType.NEXT_SERVER_OBSERVATION: (
        PlayerAttributionRole.SERVING_PLAYER
    ),
}
_PHYSICAL_TEAM_ROLE_BY_EVENT = {
    PhysicalEventType.OBSERVED_CONTACT: TeamAttributionRole.CONTACT_TEAM,
    PhysicalEventType.NET_CONTACT: TeamAttributionRole.CONTACT_TEAM,
    PhysicalEventType.ANTENNA_CONTACT: TeamAttributionRole.CONTACT_TEAM,
    PhysicalEventType.LAST_TOUCH: TeamAttributionRole.LAST_TOUCH_TEAM,
    PhysicalEventType.ORDINARY_RALLY_WINNER: (
        TeamAttributionRole.PHYSICAL_RALLY_WINNER
    ),
    PhysicalEventType.PHYSICAL_INTERFERENCE: (
        TeamAttributionRole.RESPONSIBLE_TEAM
    ),
}
_PHYSICAL_PLAYER_ROLE_BY_EVENT = {
    PhysicalEventType.OBSERVED_CONTACT: PlayerAttributionRole.CONTACTING_PLAYER,
    PhysicalEventType.NET_CONTACT: PlayerAttributionRole.CONTACTING_PLAYER,
    PhysicalEventType.ANTENNA_CONTACT: PlayerAttributionRole.CONTACTING_PLAYER,
    PhysicalEventType.LAST_TOUCH: PlayerAttributionRole.LAST_TOUCH_PLAYER,
    PhysicalEventType.PHYSICAL_INTERFERENCE: (
        PlayerAttributionRole.RESPONSIBLE_PLAYER
    ),
}
_REPORTED_OFFICIAL_TEAM_ROLE_BY_EVENT = {
    ReportedOfficialEventType.SET_SEED: TeamAttributionRole.SERVING_TEAM,
    ReportedOfficialEventType.ORDINARY_POINT: TeamAttributionRole.POINT_AWARDED_TEAM,
    ReportedOfficialEventType.CHALLENGE_RESULT: TeamAttributionRole.CHALLENGING_TEAM,
    ReportedOfficialEventType.REPORTED_SANCTION: TeamAttributionRole.RESPONSIBLE_TEAM,
    ReportedOfficialEventType.REPORTED_SERVICE_ORDER_REMEDY: (
        TeamAttributionRole.RESPONSIBLE_TEAM
    ),
    ReportedOfficialEventType.REQUESTED_TIMEOUT: TeamAttributionRole.REQUESTING_TEAM,
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
class PixelRegion(_CanonicalContract):
    """Inclusive source-pixel rectangle used by an observability review."""

    left: float
    top: float
    right: float
    bottom: float

    def __post_init__(self) -> None:
        for field_name in ("left", "top", "right", "bottom"):
            object.__setattr__(
                self,
                field_name,
                _normalized_finite_number(getattr(self, field_name), field_name),
            )
        if self.left < 0.0 or self.top < 0.0:
            raise ValueError("pixel region cannot begin outside the source frame")
        if self.right < self.left or self.bottom < self.top:
            raise ValueError("pixel region bounds cannot be inverted")

    def to_canonical_dict(self) -> dict[str, Any]:
        return {
            "bottom": self.bottom,
            "left": self.left,
            "right": self.right,
            "schema_version": SCHEMA_VERSION,
            "top": self.top,
        }


@dataclass(frozen=True, slots=True)
class BlurEllipse(_CanonicalContract):
    """Ellipse shape centered on ``BallFrameAnnotationV2.center``.

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
        object.__setattr__(
            self,
            "capture_integrity_attestation_refs",
            tuple(sorted(self.capture_integrity_attestation_refs)),
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


@dataclass(frozen=True, slots=True)
class UnavailableFrameReference(_CanonicalContract):
    """Typed capture gap that deliberately contains no decoded-pixel identity."""

    source_sha256: str
    selected_video_stream_index: int
    frame_index: int
    expected_interval_start_ns: int
    expected_interval_end_ns: int
    timestamp_basis: TimestampBasis
    capture_segment_ref: str
    unavailability_reason: CaptureUnavailabilityReason
    capture_integrity_attestation_refs: tuple[str, ...]
    gap_evidence_refs: tuple[str, ...]

    def __post_init__(self) -> None:
        _require_sha256(self.source_sha256, "source_sha256")
        if (
            type(self.selected_video_stream_index) is not int
            or not 0 <= self.selected_video_stream_index <= _MAX_SIGNED_64_BIT_INTEGER
        ):
            raise ValueError(
                "selected_video_stream_index must be a non-negative signed 64-bit integer"
            )
        if (
            type(self.frame_index) is not int
            or not 0 <= self.frame_index <= _MAX_SIGNED_64_BIT_INTEGER
        ):
            raise ValueError("frame_index must be a non-negative signed 64-bit integer")
        _validate_interval(
            interval_start_ns=self.expected_interval_start_ns,
            interval_end_ns=self.expected_interval_end_ns,
            timestamp_basis=self.timestamp_basis,
        )
        _require_content_address(self.capture_segment_ref, "capture_segment_ref")
        if type(self.unavailability_reason) is not CaptureUnavailabilityReason:
            raise ValueError(
                "unavailability_reason must be a CaptureUnavailabilityReason"
            )
        _validate_content_address_tuple(
            self.capture_integrity_attestation_refs,
            "capture_integrity_attestation_refs",
            required=True,
            max_items=_MAX_CAPTURE_ATTESTATION_REFS,
        )
        _validate_content_address_tuple(
            self.gap_evidence_refs,
            "gap_evidence_refs",
            required=True,
            max_items=_MAX_EVIDENCE_REFS_PER_ANNOTATION,
        )
        _validate_annotation_evidence_total(
            (self.capture_segment_ref,),
            self.capture_integrity_attestation_refs,
            self.gap_evidence_refs,
        )
        object.__setattr__(
            self,
            "capture_integrity_attestation_refs",
            tuple(sorted(self.capture_integrity_attestation_refs)),
        )
        object.__setattr__(
            self,
            "gap_evidence_refs",
            tuple(sorted(self.gap_evidence_refs)),
        )

    def to_canonical_dict(self) -> dict[str, Any]:
        return {
            "capture_integrity_attestation_refs": _canonical_string_list(
                self.capture_integrity_attestation_refs
            ),
            "capture_segment_ref": self.capture_segment_ref,
            "decoded_pixels_available": False,
            "expected_interval_end_ns": self.expected_interval_end_ns,
            "expected_interval_start_ns": self.expected_interval_start_ns,
            "frame_index": self.frame_index,
            "gap_evidence_refs": _canonical_string_list(self.gap_evidence_refs),
            "schema_version": SCHEMA_VERSION,
            "selected_video_stream_index": self.selected_video_stream_index,
            "source_sha256": self.source_sha256,
            "timestamp_basis": self.timestamp_basis.value,
            "unavailability_reason": self.unavailability_reason.value,
        }


@dataclass(frozen=True, slots=True)
class SearchRegionObservabilityAttestation(_CanonicalContract):
    """Reviewer-authorized proof that a full decoded frame was searchable.

    This contract has no independent authority. It becomes usable only as a
    field of a reviewed/adjudicated ball annotation whose detached reviewer
    signatures cover the complete annotation fingerprint.
    """

    source_sha256: str
    selected_video_stream_index: int
    frame_index: int
    decoded_frame_sha256: str
    frame_identity_sha256: str
    target_role: BallRole
    region_scope: SearchRegionScope
    searched_region: PixelRegion
    region_visibility: SearchRegionVisibility
    capture_integrity_attestation_refs: tuple[str, ...]
    reviewer_ids: tuple[str, ...]
    review_evidence_refs: tuple[str, ...]

    def __post_init__(self) -> None:
        _require_sha256(self.source_sha256, "source_sha256")
        if (
            type(self.selected_video_stream_index) is not int
            or not 0 <= self.selected_video_stream_index <= _MAX_SIGNED_64_BIT_INTEGER
        ):
            raise ValueError(
                "selected_video_stream_index must be a non-negative signed 64-bit integer"
            )
        if (
            type(self.frame_index) is not int
            or not 0 <= self.frame_index <= _MAX_SIGNED_64_BIT_INTEGER
        ):
            raise ValueError("frame_index must be a non-negative signed 64-bit integer")
        _require_sha256(self.decoded_frame_sha256, "decoded_frame_sha256")
        _require_sha256(self.frame_identity_sha256, "frame_identity_sha256")
        if self.target_role is not BallRole.MATCH_BALL:
            raise ValueError("search-region target_role must be MATCH_BALL")
        if self.region_scope is not SearchRegionScope.FULL_DECODED_FRAME:
            raise ValueError("search-region scope must be FULL_DECODED_FRAME")
        if type(self.searched_region) is not PixelRegion:
            raise ValueError("searched_region must be a PixelRegion")
        if self.region_visibility is not SearchRegionVisibility.FULLY_OBSERVABLE:
            raise ValueError("search region must be FULLY_OBSERVABLE")
        _validate_content_address_tuple(
            self.capture_integrity_attestation_refs,
            "capture_integrity_attestation_refs",
            required=True,
            max_items=_MAX_CAPTURE_ATTESTATION_REFS,
        )
        _validate_id_tuple(
            self.reviewer_ids,
            "reviewer_ids",
            required=True,
            max_items=_MAX_REVIEWERS_PER_ANNOTATION,
        )
        _validate_content_address_tuple(
            self.review_evidence_refs,
            "review_evidence_refs",
            required=True,
            max_items=_MAX_EVIDENCE_REFS_PER_ANNOTATION,
        )
        _validate_annotation_evidence_total(
            self.capture_integrity_attestation_refs,
            self.review_evidence_refs,
        )
        object.__setattr__(
            self,
            "capture_integrity_attestation_refs",
            tuple(sorted(self.capture_integrity_attestation_refs)),
        )
        object.__setattr__(
            self,
            "reviewer_ids",
            tuple(sorted(self.reviewer_ids)),
        )
        object.__setattr__(
            self,
            "review_evidence_refs",
            tuple(sorted(self.review_evidence_refs)),
        )

    def validate_for(
        self,
        frame: FrameReference,
        *,
        reviewer_ids: tuple[str, ...],
        review_evidence_refs: tuple[str, ...],
    ) -> None:
        if type(frame) is not FrameReference:
            raise ValueError("search-region attestation requires a decoded frame")
        expected_region = PixelRegion(0, 0, frame.width - 1, frame.height - 1)
        if (
            self.source_sha256 != frame.source_sha256
            or self.selected_video_stream_index != frame.selected_video_stream_index
            or self.frame_index != frame.frame_index
            or self.decoded_frame_sha256 != frame.decoded_frame_sha256
            or self.frame_identity_sha256 != frame.identity.fingerprint()
            or self.searched_region != expected_region
        ):
            raise ValueError(
                "search-region attestation must bind the exact full decoded frame"
            )
        if tuple(sorted(self.reviewer_ids)) != tuple(sorted(reviewer_ids)):
            raise ValueError(
                "search-region reviewer authority must match annotation reviewers"
            )
        if not set(self.review_evidence_refs).issubset(review_evidence_refs):
            raise ValueError(
                "search-region review evidence must be included in annotation review evidence"
            )

    def to_canonical_dict(self) -> dict[str, Any]:
        return {
            "capture_integrity_attestation_refs": _canonical_string_list(
                self.capture_integrity_attestation_refs
            ),
            "decoded_frame_sha256": self.decoded_frame_sha256,
            "frame_identity_sha256": self.frame_identity_sha256,
            "frame_index": self.frame_index,
            "region_scope": self.region_scope.value,
            "region_visibility": self.region_visibility.value,
            "review_evidence_refs": _canonical_string_list(
                self.review_evidence_refs
            ),
            "reviewer_ids": _canonical_string_list(self.reviewer_ids),
            "schema_version": SCHEMA_VERSION,
            "searched_region": self.searched_region.to_canonical_dict(),
            "selected_video_stream_index": self.selected_video_stream_index,
            "source_sha256": self.source_sha256,
            "target_role": self.target_role.value,
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


def _validate_interval(
    *,
    interval_start_ns: object,
    interval_end_ns: object,
    timestamp_basis: object,
) -> None:
    if type(timestamp_basis) is not TimestampBasis:
        raise ValueError("timestamp_basis must be a TimestampBasis")
    if type(interval_start_ns) is not int or type(interval_end_ns) is not int:
        raise ValueError("event interval bounds must be integers")
    if interval_start_ns < 0 or interval_end_ns < 0:
        raise ValueError("event interval bounds cannot be negative")
    if (
        interval_start_ns > _MAX_SIGNED_64_BIT_INTEGER
        or interval_end_ns > _MAX_SIGNED_64_BIT_INTEGER
    ):
        raise ValueError("event interval bounds must fit a signed 64-bit integer")
    if interval_end_ns < interval_start_ns:
        raise ValueError("event uncertainty interval cannot be inverted")


def _validate_attribution(
    *,
    event_label: str,
    team_role: TeamAttributionRole | None,
    player_role: PlayerAttributionRole | None,
    team_attribution_state: object,
    player_attribution_state: object,
    team: object,
    player_id: object,
    ambiguity_reason: str | None,
) -> None:
    if type(team_attribution_state) is not AttributionState:
        raise ValueError("team_attribution_state must be an AttributionState")
    if type(player_attribution_state) is not AttributionState:
        raise ValueError("player_attribution_state must be an AttributionState")
    if team is not None and type(team) is not Team:
        raise ValueError("team must be a Team")
    if player_id is not None:
        _require_ascii_id(player_id, "player_id")

    if team_role is None:
        if team_attribution_state is not AttributionState.NOT_APPLICABLE:
            raise ValueError(f"{event_label} team attribution must be NOT_APPLICABLE")
        if team is not None:
            raise ValueError(f"{event_label} does not allow team attribution")
    elif team_attribution_state is AttributionState.NOT_APPLICABLE:
        raise ValueError(
            f"{event_label} requires explicit KNOWN or UNKNOWN team attribution"
        )
    elif team_attribution_state is AttributionState.KNOWN:
        if team is None:
            raise ValueError("KNOWN team attribution requires a team")
    elif team is not None:
        raise ValueError("UNKNOWN team attribution cannot contain a team")

    if player_role is None:
        if player_attribution_state is not AttributionState.NOT_APPLICABLE:
            raise ValueError(f"{event_label} player attribution must be NOT_APPLICABLE")
        if player_id is not None:
            raise ValueError(f"{event_label} does not allow player attribution")
    elif player_attribution_state is AttributionState.NOT_APPLICABLE:
        raise ValueError(
            f"{event_label} requires explicit KNOWN or UNKNOWN player attribution"
        )
    elif player_attribution_state is AttributionState.KNOWN:
        if player_id is None:
            raise ValueError("KNOWN player attribution requires a player_id")
        if team_attribution_state is not AttributionState.KNOWN:
            raise ValueError("known player attribution requires known team attribution")
    elif player_id is not None:
        raise ValueError("UNKNOWN player attribution cannot contain a player_id")

    if (
        AttributionState.UNKNOWN
        in (team_attribution_state, player_attribution_state)
        and ambiguity_reason is None
    ):
        raise ValueError("UNKNOWN attribution requires an ambiguity_reason")


def _validate_annotation_evidence_total(
    *collections: tuple[str, ...],
    capture_refs: tuple[str, ...] = (),
) -> None:
    if sum(len(collection) for collection in collections) + len(capture_refs) > (
        _MAX_EVIDENCE_REFS_PER_ANNOTATION
    ):
        raise ValueError(
            "annotation evidence cannot exceed "
            f"{_MAX_EVIDENCE_REFS_PER_ANNOTATION} total refs"
        )


def _wire_object(
    value: object,
    fields: set[str],
    *,
    label: str,
) -> dict[str, Any]:
    payload = require_exact_fields(value, fields, label=label)
    if payload["schema_version"] != SCHEMA_VERSION:
        raise ValueError(f"{label}.schema_version must be {SCHEMA_VERSION}")
    return payload


def _wire_string_tuple(
    payload: dict[str, Any],
    field_name: str,
    *,
    label: str,
) -> tuple[str, ...]:
    values = exact_list(payload, field_name, label=label)
    if any(type(value) is not str for value in values):
        raise ValueError(f"{label}.{field_name} must contain only strings")
    return tuple(values)


def _wire_optional_string(value: object, field_name: str) -> str | None:
    if value is not None and type(value) is not str:
        raise ValueError(f"{field_name} must be a string or null")
    return value


def _wire_exact_integer(value: object, field_name: str) -> int:
    if type(value) is not int:
        raise ValueError(f"{field_name} must be an exact JSON integer")
    return value


def _wire_optional_number(value: object, field_name: str) -> int | float | None:
    if value is not None and type(value) not in {int, float}:
        raise ValueError(f"{field_name} must be a JSON number or null")
    return value


def _wire_frame_decode_contract(value: object) -> FrameDecodeContract:
    label = "ball annotation frame decode contract"
    payload = _wire_object(
        value,
        {
            "autorotation_policy",
            "color_range",
            "color_space",
            "decoder_artifact_sha256",
            "decoder_build_id",
            "output_height",
            "output_pixel_format",
            "output_width",
            "schema_version",
        },
        label=label,
    )
    return FrameDecodeContract(
        decoder_artifact_sha256=payload["decoder_artifact_sha256"],
        decoder_build_id=payload["decoder_build_id"],
        autorotation_policy=enum_from_json(
            AutorotationPolicy,
            payload["autorotation_policy"],
            f"{label}.autorotation_policy",
        ),  # type: ignore[arg-type]
        color_space=enum_from_json(
            DecodedColorSpace,
            payload["color_space"],
            f"{label}.color_space",
        ),  # type: ignore[arg-type]
        color_range=enum_from_json(
            DecodedColorRange,
            payload["color_range"],
            f"{label}.color_range",
        ),  # type: ignore[arg-type]
        output_pixel_format=enum_from_json(
            DecodedPixelFormat,
            payload["output_pixel_format"],
            f"{label}.output_pixel_format",
        ),  # type: ignore[arg-type]
        output_width=_wire_exact_integer(
            payload["output_width"], f"{label}.output_width"
        ),
        output_height=_wire_exact_integer(
            payload["output_height"], f"{label}.output_height"
        ),
    )


def _wire_decoded_frame_identity(value: object) -> DecodedFrameIdentity:
    label = "ball annotation decoded frame identity"
    payload = _wire_object(
        value,
        {
            "decode_contract",
            "decoded_frame_hash_basis",
            "decoded_frame_sha256",
            "frame_index",
            "pixel_coordinate_space",
            "schema_version",
            "selected_video_stream_index",
            "source_sha256",
            "timestamp_basis",
            "timestamp_ns",
        },
        label=label,
    )
    return DecodedFrameIdentity(
        source_sha256=payload["source_sha256"],
        selected_video_stream_index=_wire_exact_integer(
            payload["selected_video_stream_index"],
            f"{label}.selected_video_stream_index",
        ),
        frame_index=_wire_exact_integer(
            payload["frame_index"], f"{label}.frame_index"
        ),
        timestamp_ns=_wire_exact_integer(
            payload["timestamp_ns"], f"{label}.timestamp_ns"
        ),
        timestamp_basis=enum_from_json(
            TimestampBasis,
            payload["timestamp_basis"],
            f"{label}.timestamp_basis",
        ),  # type: ignore[arg-type]
        pixel_coordinate_space=enum_from_json(
            PixelCoordinateSpace,
            payload["pixel_coordinate_space"],
            f"{label}.pixel_coordinate_space",
        ),  # type: ignore[arg-type]
        decode_contract=_wire_frame_decode_contract(payload["decode_contract"]),
        decoded_frame_sha256=payload["decoded_frame_sha256"],
        decoded_frame_hash_basis=enum_from_json(
            DecodedFrameHashBasis,
            payload["decoded_frame_hash_basis"],
            f"{label}.decoded_frame_hash_basis",
        ),  # type: ignore[arg-type]
    )


def _wire_frame_reference(value: object) -> FrameReference:
    label = "ball annotation frame reference"
    payload = _wire_object(
        value,
        {
            "capture_integrity_attestation_refs",
            "duplicate_kind",
            "duplicate_of_frame_index",
            "identity",
            "schema_version",
        },
        label=label,
    )
    duplicate_of = payload["duplicate_of_frame_index"]
    if duplicate_of is not None:
        duplicate_of = _wire_exact_integer(
            duplicate_of, f"{label}.duplicate_of_frame_index"
        )
    return FrameReference(
        identity=_wire_decoded_frame_identity(payload["identity"]),
        duplicate_kind=enum_from_json(
            FrameDuplicateKind,
            payload["duplicate_kind"],
            f"{label}.duplicate_kind",
        ),  # type: ignore[arg-type]
        duplicate_of_frame_index=duplicate_of,
        capture_integrity_attestation_refs=_wire_string_tuple(
            payload,
            "capture_integrity_attestation_refs",
            label=label,
        ),
    )


def _wire_unavailable_frame_reference(value: object) -> UnavailableFrameReference:
    label = "ball annotation unavailable frame reference"
    payload = _wire_object(
        value,
        {
            "capture_integrity_attestation_refs",
            "capture_segment_ref",
            "decoded_pixels_available",
            "expected_interval_end_ns",
            "expected_interval_start_ns",
            "frame_index",
            "gap_evidence_refs",
            "schema_version",
            "selected_video_stream_index",
            "source_sha256",
            "timestamp_basis",
            "unavailability_reason",
        },
        label=label,
    )
    if type(payload["decoded_pixels_available"]) is not bool or payload[
        "decoded_pixels_available"
    ]:
        raise ValueError(f"{label}.decoded_pixels_available must be false")
    return UnavailableFrameReference(
        source_sha256=payload["source_sha256"],
        selected_video_stream_index=_wire_exact_integer(
            payload["selected_video_stream_index"],
            f"{label}.selected_video_stream_index",
        ),
        frame_index=_wire_exact_integer(
            payload["frame_index"], f"{label}.frame_index"
        ),
        expected_interval_start_ns=_wire_exact_integer(
            payload["expected_interval_start_ns"],
            f"{label}.expected_interval_start_ns",
        ),
        expected_interval_end_ns=_wire_exact_integer(
            payload["expected_interval_end_ns"],
            f"{label}.expected_interval_end_ns",
        ),
        timestamp_basis=enum_from_json(
            TimestampBasis,
            payload["timestamp_basis"],
            f"{label}.timestamp_basis",
        ),  # type: ignore[arg-type]
        capture_segment_ref=payload["capture_segment_ref"],
        unavailability_reason=enum_from_json(
            CaptureUnavailabilityReason,
            payload["unavailability_reason"],
            f"{label}.unavailability_reason",
        ),  # type: ignore[arg-type]
        capture_integrity_attestation_refs=_wire_string_tuple(
            payload,
            "capture_integrity_attestation_refs",
            label=label,
        ),
        gap_evidence_refs=_wire_string_tuple(
            payload,
            "gap_evidence_refs",
            label=label,
        ),
    )


def _wire_pixel_point(value: object, field_name: str) -> PixelPoint:
    payload = _wire_object(
        value,
        {"schema_version", "x", "y"},
        label=field_name,
    )
    x = _wire_optional_number(payload["x"], f"{field_name}.x")
    y = _wire_optional_number(payload["y"], f"{field_name}.y")
    if x is None or y is None:
        raise ValueError(f"{field_name} coordinates cannot be null")
    return PixelPoint(x=x, y=y)


def _wire_optional_pixel_point(value: object, field_name: str) -> PixelPoint | None:
    return None if value is None else _wire_pixel_point(value, field_name)


def _wire_blur_ellipse(value: object) -> BlurEllipse:
    label = "ball annotation blur ellipse"
    payload = _wire_object(
        value,
        {
            "angle_degrees",
            "major_radius_px",
            "minor_radius_px",
            "schema_version",
        },
        label=label,
    )
    values = {
        field_name: _wire_optional_number(payload[field_name], f"{label}.{field_name}")
        for field_name in ("major_radius_px", "minor_radius_px", "angle_degrees")
    }
    if any(value is None for value in values.values()):
        raise ValueError(f"{label} numbers cannot be null")
    return BlurEllipse(**values)  # type: ignore[arg-type]


def _wire_pixel_region(value: object) -> PixelRegion:
    label = "ball annotation searched region"
    payload = _wire_object(
        value,
        {"bottom", "left", "right", "schema_version", "top"},
        label=label,
    )
    values = {
        field_name: _wire_optional_number(payload[field_name], f"{label}.{field_name}")
        for field_name in ("left", "top", "right", "bottom")
    }
    if any(value is None for value in values.values()):
        raise ValueError(f"{label} numbers cannot be null")
    return PixelRegion(**values)  # type: ignore[arg-type]


def _wire_search_attestation(
    value: object,
) -> SearchRegionObservabilityAttestation:
    label = "ball annotation search-region observability attestation"
    payload = _wire_object(
        value,
        {
            "capture_integrity_attestation_refs",
            "decoded_frame_sha256",
            "frame_identity_sha256",
            "frame_index",
            "region_scope",
            "region_visibility",
            "review_evidence_refs",
            "reviewer_ids",
            "schema_version",
            "searched_region",
            "selected_video_stream_index",
            "source_sha256",
            "target_role",
        },
        label=label,
    )
    return SearchRegionObservabilityAttestation(
        source_sha256=payload["source_sha256"],
        selected_video_stream_index=_wire_exact_integer(
            payload["selected_video_stream_index"],
            f"{label}.selected_video_stream_index",
        ),
        frame_index=_wire_exact_integer(
            payload["frame_index"], f"{label}.frame_index"
        ),
        decoded_frame_sha256=payload["decoded_frame_sha256"],
        frame_identity_sha256=payload["frame_identity_sha256"],
        target_role=enum_from_json(
            BallRole, payload["target_role"], f"{label}.target_role"
        ),  # type: ignore[arg-type]
        region_scope=enum_from_json(
            SearchRegionScope,
            payload["region_scope"],
            f"{label}.region_scope",
        ),  # type: ignore[arg-type]
        searched_region=_wire_pixel_region(payload["searched_region"]),
        region_visibility=enum_from_json(
            SearchRegionVisibility,
            payload["region_visibility"],
            f"{label}.region_visibility",
        ),  # type: ignore[arg-type]
        capture_integrity_attestation_refs=_wire_string_tuple(
            payload,
            "capture_integrity_attestation_refs",
            label=label,
        ),
        reviewer_ids=_wire_string_tuple(payload, "reviewer_ids", label=label),
        review_evidence_refs=_wire_string_tuple(
            payload,
            "review_evidence_refs",
            label=label,
        ),
    )


def _ball_frame_annotation_from_wire_dict(
    value: object,
) -> BallFrameAnnotationV2:
    label = "ball frame annotation V2"
    payload = _wire_object(
        value,
        {
            "adjudication_evidence_refs",
            "adjudicator_id",
            "ambiguity_reason",
            "annotation_id",
            "annotation_type",
            "appearance",
            "apparent_minor_axis_diameter_px",
            "ball_instance_id",
            "blur_ellipse",
            "blur_end",
            "blur_start",
            "center",
            "frame",
            "ontology_sha256",
            "play_state",
            "review_evidence_refs",
            "review_state",
            "reviewer_ids",
            "role",
            "schema_version",
            "search_region_observability_attestation",
            "track_segment_id",
            "truth_layer",
            "uncertainty_radius_px",
            "visibility",
        },
        label=label,
    )
    if payload["annotation_type"] != AnnotationType.BALL_FRAME_OBSERVATION.value:
        raise ValueError(f"{label}.annotation_type is unsupported")
    if payload["truth_layer"] != TruthLayer.OBSERVATIONAL.value:
        raise ValueError(f"{label}.truth_layer is unsupported")
    frame_payload = payload["frame"]
    if type(frame_payload) is not dict:
        raise ValueError(f"{label}.frame must be an exact JSON object")
    frame = (
        _wire_unavailable_frame_reference(frame_payload)
        if "decoded_pixels_available" in frame_payload
        else _wire_frame_reference(frame_payload)
    )
    search_payload = payload["search_region_observability_attestation"]
    blur_ellipse_payload = payload["blur_ellipse"]
    return BallFrameAnnotationV2(
        annotation_id=payload["annotation_id"],
        ontology_sha256=payload["ontology_sha256"],
        ball_instance_id=payload["ball_instance_id"],
        frame=frame,
        visibility=enum_from_json(
            BallVisibility, payload["visibility"], f"{label}.visibility"
        ),  # type: ignore[arg-type]
        appearance=enum_from_json(
            BallAppearance, payload["appearance"], f"{label}.appearance"
        ),  # type: ignore[arg-type]
        role=enum_from_json(
            BallRole, payload["role"], f"{label}.role"
        ),  # type: ignore[arg-type]
        play_state=enum_from_json(
            BallPlayState, payload["play_state"], f"{label}.play_state"
        ),  # type: ignore[arg-type]
        center=_wire_optional_pixel_point(payload["center"], f"{label}.center"),
        blur_start=_wire_optional_pixel_point(
            payload["blur_start"], f"{label}.blur_start"
        ),
        blur_end=_wire_optional_pixel_point(
            payload["blur_end"], f"{label}.blur_end"
        ),
        blur_ellipse=(
            None
            if blur_ellipse_payload is None
            else _wire_blur_ellipse(blur_ellipse_payload)
        ),
        apparent_minor_axis_diameter_px=_wire_optional_number(
            payload["apparent_minor_axis_diameter_px"],
            f"{label}.apparent_minor_axis_diameter_px",
        ),
        uncertainty_radius_px=_wire_optional_number(
            payload["uncertainty_radius_px"],
            f"{label}.uncertainty_radius_px",
        ),
        ambiguity_reason=_wire_optional_string(
            payload["ambiguity_reason"], f"{label}.ambiguity_reason"
        ),
        track_segment_id=_wire_optional_string(
            payload["track_segment_id"], f"{label}.track_segment_id"
        ),
        search_region_observability_attestation=(
            None
            if search_payload is None
            else _wire_search_attestation(search_payload)
        ),
        review_state=enum_from_json(
            ReviewState, payload["review_state"], f"{label}.review_state"
        ),  # type: ignore[arg-type]
        reviewer_ids=_wire_string_tuple(payload, "reviewer_ids", label=label),
        review_evidence_refs=_wire_string_tuple(
            payload, "review_evidence_refs", label=label
        ),
        adjudicator_id=_wire_optional_string(
            payload["adjudicator_id"], f"{label}.adjudicator_id"
        ),
        adjudication_evidence_refs=_wire_string_tuple(
            payload, "adjudication_evidence_refs", label=label
        ),
    )


@dataclass(frozen=True, slots=True)
class BallFrameAnnotationV2(_CanonicalContract):
    """One observed-ball label with independent visibility and semantics.

    Only ``VISIBLE`` and ``PARTIALLY_OCCLUDED`` carry observed point geometry.
    Motion blur is an appearance property of those observations. A trajectory
    estimate through an unobservable frame is intentionally not representable.
    """

    annotation_id: str
    ontology_sha256: str
    ball_instance_id: str
    frame: FrameReference | UnavailableFrameReference
    visibility: BallVisibility
    appearance: BallAppearance
    role: BallRole
    play_state: BallPlayState
    center: PixelPoint | None = None
    blur_start: PixelPoint | None = None
    blur_end: PixelPoint | None = None
    blur_ellipse: BlurEllipse | None = None
    apparent_minor_axis_diameter_px: float | None = None
    uncertainty_radius_px: float | None = None
    ambiguity_reason: str | None = None
    track_segment_id: str | None = None
    search_region_observability_attestation: (
        SearchRegionObservabilityAttestation | None
    ) = None
    review_state: ReviewState = ReviewState.DRAFT
    reviewer_ids: tuple[str, ...] = ()
    review_evidence_refs: tuple[str, ...] = ()
    adjudicator_id: str | None = None
    adjudication_evidence_refs: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        _require_ascii_id(self.annotation_id, "annotation_id")
        _require_sha256(self.ontology_sha256, "ontology_sha256")
        _require_ascii_id(self.ball_instance_id, "ball_instance_id")
        if type(self.frame) not in {FrameReference, UnavailableFrameReference}:
            raise ValueError(
                "frame must be a FrameReference or UnavailableFrameReference"
            )
        if type(self.visibility) is not BallVisibility:
            raise ValueError("visibility must be a BallVisibility")
        if type(self.appearance) is not BallAppearance:
            raise ValueError("appearance must be a BallAppearance")
        if type(self.role) is not BallRole:
            raise ValueError("role must be a BallRole")
        if type(self.play_state) is not BallPlayState:
            raise ValueError("play_state must be a BallPlayState")
        for field_name in ("center", "blur_start", "blur_end"):
            point = getattr(self, field_name)
            if point is not None and type(point) is not PixelPoint:
                raise ValueError(f"{field_name} must be a PixelPoint")
            if point is not None and type(self.frame) is FrameReference:
                _point_within_frame(point, self.frame, field_name)
        if self.blur_ellipse is not None and type(self.blur_ellipse) is not BlurEllipse:
            raise ValueError("blur_ellipse must be a BlurEllipse")
        if self.track_segment_id is not None:
            _require_ascii_id(self.track_segment_id, "track_segment_id")
        if (
            self.search_region_observability_attestation is not None
            and type(self.search_region_observability_attestation)
            is not SearchRegionObservabilityAttestation
        ):
            raise ValueError(
                "search_region_observability_attestation must be a "
                "SearchRegionObservabilityAttestation"
            )
        if self.ambiguity_reason is not None:
            _require_nfc_utf8_text(self.ambiguity_reason, "ambiguity_reason")
        if self.uncertainty_radius_px is not None:
            radius = _normalized_finite_number(
                self.uncertainty_radius_px,
                "uncertainty_radius_px",
            )
            if radius <= 0.0:
                raise ValueError("uncertainty_radius_px must be positive")
            if type(self.frame) is not FrameReference:
                raise ValueError(
                    "uncertainty_radius_px requires an available decoded frame"
                )
            if radius > math.hypot(self.frame.width, self.frame.height):
                raise ValueError(
                    "uncertainty_radius_px cannot exceed the source-frame diagonal"
                )
            object.__setattr__(self, "uncertainty_radius_px", radius)
        if self.apparent_minor_axis_diameter_px is not None:
            diameter = _normalized_finite_number(
                self.apparent_minor_axis_diameter_px,
                "apparent_minor_axis_diameter_px",
            )
            if type(self.frame) is not FrameReference:
                raise ValueError(
                    "apparent_minor_axis_diameter_px requires an available decoded frame"
                )
            if diameter <= 0.0 or diameter > min(self.frame.width, self.frame.height):
                raise ValueError(
                    "apparent_minor_axis_diameter_px must be positive and fit the frame"
                )
            object.__setattr__(self, "apparent_minor_axis_diameter_px", diameter)

        if (self.blur_start is None) != (self.blur_end is None):
            raise ValueError("blur_start and blur_end must be provided together")

        localizable = self.visibility in {
            BallVisibility.VISIBLE,
            BallVisibility.PARTIALLY_OCCLUDED,
        }
        if self.visibility is BallVisibility.CAPTURE_UNKNOWN:
            if type(self.frame) is not UnavailableFrameReference:
                raise ValueError(
                    "CAPTURE_UNKNOWN requires an UnavailableFrameReference without "
                    "invented decoded pixels"
                )
        elif type(self.frame) is not FrameReference:
            raise ValueError(
                f"{self.visibility.value} requires an available decoded FrameReference"
            )
        if localizable:
            if self.center is None:
                raise ValueError(f"{self.visibility.value} requires an observed center")
            if self.apparent_minor_axis_diameter_px is None:
                raise ValueError(
                    f"{self.visibility.value} requires apparent_minor_axis_diameter_px"
                )
            if self.appearance is BallAppearance.NOT_OBSERVABLE:
                raise ValueError("localizable observations require an observable appearance")
            if self.track_segment_id is None:
                raise ValueError("localizable observations require a track_segment_id")
            if self.search_region_observability_attestation is not None:
                raise ValueError(
                    "localizable observations cannot claim a not-present search region"
                )
        else:
            if self.appearance is not BallAppearance.NOT_OBSERVABLE:
                raise ValueError(
                    f"{self.visibility.value} requires appearance=NOT_OBSERVABLE"
                )
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
                raise ValueError(
                    f"{self.visibility.value} cannot contain invented observation geometry"
                )

        if self.appearance is BallAppearance.SHARP:
            if self.blur_start is not None or self.blur_ellipse is not None:
                raise ValueError("SHARP appearance cannot contain blur geometry")
        elif self.appearance is BallAppearance.MOTION_BLURRED:
            has_endpoints = self.blur_start is not None
            has_ellipse = self.blur_ellipse is not None
            if has_endpoints == has_ellipse:
                raise ValueError(
                    "MOTION_BLURRED requires exactly one blur geometry representation"
                )
            assert self.center is not None
            assert self.apparent_minor_axis_diameter_px is not None
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
                if (
                    self.apparent_minor_axis_diameter_px
                    > major_axis_length + _GEOMETRY_TOLERANCE
                ):
                    raise ValueError(
                        "apparent_minor_axis_diameter_px cannot exceed the blur "
                        "endpoint major-axis length"
                    )
            if self.blur_ellipse is not None:
                _ellipse_within_frame(self.center, self.blur_ellipse, self.frame)
                if not math.isclose(
                    self.apparent_minor_axis_diameter_px,
                    2.0 * self.blur_ellipse.minor_radius_px,
                    rel_tol=0.0,
                    abs_tol=_GEOMETRY_TOLERANCE,
                ):
                    raise ValueError(
                        "apparent_minor_axis_diameter_px must equal twice the "
                        "blur ellipse minor radius"
                    )

        _validate_review(
            review_state=self.review_state,
            reviewer_ids=self.reviewer_ids,
            review_evidence_refs=self.review_evidence_refs,
            adjudicator_id=self.adjudicator_id,
            adjudication_evidence_refs=self.adjudication_evidence_refs,
        )

        if self.visibility is BallVisibility.NOT_PRESENT:
            if self.search_region_observability_attestation is None:
                raise ValueError(
                    "NOT_PRESENT requires a SearchRegionObservabilityAttestation"
                )
            if self.role is not BallRole.MATCH_BALL:
                raise ValueError("NOT_PRESENT is permitted only for role=MATCH_BALL")
            if self.play_state is not BallPlayState.NOT_APPLICABLE:
                raise ValueError("NOT_PRESENT requires play_state=NOT_APPLICABLE")
            if self.track_segment_id is not None:
                raise ValueError("NOT_PRESENT cannot belong to a track segment")
            if self.review_state is ReviewState.DRAFT:
                raise ValueError(
                    "NOT_PRESENT cannot become a confident negative while DRAFT"
                )
            assert type(self.frame) is FrameReference
            self.search_region_observability_attestation.validate_for(
                self.frame,
                reviewer_ids=self.reviewer_ids,
                review_evidence_refs=self.review_evidence_refs,
            )
        else:
            if self.search_region_observability_attestation is not None:
                raise ValueError(
                    "search_region_observability_attestation is permitted only for "
                    "NOT_PRESENT"
                )
            if self.play_state is BallPlayState.NOT_APPLICABLE:
                raise ValueError(
                    "play_state=NOT_APPLICABLE is permitted only for NOT_PRESENT"
                )

        if self.visibility in {
            BallVisibility.FULLY_OCCLUDED,
            BallVisibility.OUT_OF_FRAME,
        } and self.track_segment_id is None:
            raise ValueError(f"{self.visibility.value} requires a track_segment_id")
        if self.visibility in {
            BallVisibility.INDISTINGUISHABLE,
            BallVisibility.CAPTURE_UNKNOWN,
        }:
            if self.track_segment_id is not None:
                raise ValueError(
                    f"{self.visibility.value} cannot claim an observed track segment"
                )
            if (
                self.visibility is BallVisibility.INDISTINGUISHABLE
                and self.role is not BallRole.UNKNOWN
            ):
                raise ValueError(
                    "INDISTINGUISHABLE requires UNKNOWN role"
                )
            if (
                self.visibility is BallVisibility.CAPTURE_UNKNOWN
                and self.role is not BallRole.MATCH_BALL
            ):
                raise ValueError(
                    "CAPTURE_UNKNOWN is a match-ball availability claim"
                )
            if self.play_state is not BallPlayState.UNKNOWN:
                raise ValueError(
                    f"{self.visibility.value} requires UNKNOWN play_state"
                )

        if (
            self.visibility
            in {BallVisibility.INDISTINGUISHABLE, BallVisibility.CAPTURE_UNKNOWN}
            or self.role is BallRole.UNKNOWN
            or self.play_state is BallPlayState.UNKNOWN
        ) and self.ambiguity_reason is None:
            raise ValueError("unknown or ambiguous ball truth requires ambiguity_reason")

        _validate_annotation_evidence_total(
            self.review_evidence_refs,
            self.adjudication_evidence_refs,
            (
                self.search_region_observability_attestation.review_evidence_refs
                if self.search_region_observability_attestation is not None
                else ()
            ),
            (
                self.search_region_observability_attestation.capture_integrity_attestation_refs
                if self.search_region_observability_attestation is not None
                else ()
            ),
            (
                (self.frame.capture_segment_ref,)
                if type(self.frame) is UnavailableFrameReference
                else ()
            ),
            (
                self.frame.gap_evidence_refs
                if type(self.frame) is UnavailableFrameReference
                else ()
            ),
            capture_refs=self.frame.capture_integrity_attestation_refs,
        )
        object.__setattr__(
            self,
            "reviewer_ids",
            tuple(sorted(self.reviewer_ids)),
        )
        object.__setattr__(
            self,
            "review_evidence_refs",
            tuple(sorted(self.review_evidence_refs)),
        )
        object.__setattr__(
            self,
            "adjudication_evidence_refs",
            tuple(sorted(self.adjudication_evidence_refs)),
        )

    @property
    def annotation_type(self) -> AnnotationType:
        return AnnotationType.BALL_FRAME_OBSERVATION

    @property
    def truth_layer(self) -> TruthLayer:
        return TruthLayer.OBSERVATIONAL

    @property
    def is_localizable_observation(self) -> bool:
        return self.visibility in {
            BallVisibility.VISIBLE,
            BallVisibility.PARTIALLY_OCCLUDED,
        }

    @property
    def confident_negative_claim_structurally_complete(self) -> bool:
        """Whether the payload is structurally eligible for later verification.

        This property is not reviewer authority. Only successful detached
        signature and evidence verification by ``AnnotationTrustStore`` can
        admit the claim as confident-negative benchmark truth.
        """

        return (
            self.visibility is BallVisibility.NOT_PRESENT
            and self.review_state in {ReviewState.REVIEWED, ReviewState.ADJUDICATED}
            and self.search_region_observability_attestation is not None
        )

    def to_canonical_dict(self) -> dict[str, Any]:
        return {
            "adjudication_evidence_refs": _canonical_string_list(
                self.adjudication_evidence_refs
            ),
            "adjudicator_id": self.adjudicator_id,
            "ambiguity_reason": self.ambiguity_reason,
            "annotation_id": self.annotation_id,
            "annotation_type": self.annotation_type.value,
            "appearance": self.appearance.value,
            "apparent_minor_axis_diameter_px": self.apparent_minor_axis_diameter_px,
            "blur_ellipse": (
                self.blur_ellipse.to_canonical_dict() if self.blur_ellipse else None
            ),
            "blur_end": self.blur_end.to_canonical_dict() if self.blur_end else None,
            "blur_start": (
                self.blur_start.to_canonical_dict() if self.blur_start else None
            ),
            "ball_instance_id": self.ball_instance_id,
            "center": self.center.to_canonical_dict() if self.center else None,
            "frame": self.frame.to_canonical_dict(),
            "ontology_sha256": self.ontology_sha256,
            "play_state": self.play_state.value,
            "review_evidence_refs": _canonical_string_list(
                self.review_evidence_refs
            ),
            "review_state": self.review_state.value,
            "reviewer_ids": _canonical_string_list(self.reviewer_ids),
            "role": self.role.value,
            "schema_version": SCHEMA_VERSION,
            "search_region_observability_attestation": (
                self.search_region_observability_attestation.to_canonical_dict()
                if self.search_region_observability_attestation is not None
                else None
            ),
            "track_segment_id": self.track_segment_id,
            "truth_layer": self.truth_layer.value,
            "uncertainty_radius_px": self.uncertainty_radius_px,
            "visibility": self.visibility.value,
        }

    def to_json_bytes(self) -> bytes:
        """Return the bounded canonical persisted representation."""

        return canonical_finite_json_bytes(
            self.to_canonical_dict(),
            label="ball frame annotation V2",
            maximum_bytes=_MAX_BALL_FRAME_ANNOTATION_JSON_BYTES,
            maximum_depth=_MAX_BALL_FRAME_ANNOTATION_JSON_DEPTH,
            maximum_nodes=_MAX_BALL_FRAME_ANNOTATION_JSON_NODES,
            maximum_containers=_MAX_BALL_FRAME_ANNOTATION_JSON_CONTAINERS,
        )

    @classmethod
    def from_json_bytes(cls, raw: bytes) -> BallFrameAnnotationV2:
        """Reconstruct one annotation only from exact canonical persisted bytes."""

        payload = parse_canonical_finite_json_object(
            raw,
            label="ball frame annotation V2",
            maximum_bytes=_MAX_BALL_FRAME_ANNOTATION_JSON_BYTES,
            maximum_depth=_MAX_BALL_FRAME_ANNOTATION_JSON_DEPTH,
            maximum_nodes=_MAX_BALL_FRAME_ANNOTATION_JSON_NODES,
            maximum_containers=_MAX_BALL_FRAME_ANNOTATION_JSON_CONTAINERS,
        )
        try:
            annotation = _ball_frame_annotation_from_wire_dict(payload)
        except CanonicalWireError:
            raise
        except (KeyError, TypeError, ValueError) as exc:
            raise CanonicalWireError(
                "ANNOTATION_SHAPE",
                "ball frame annotation V2 fields are invalid",
            ) from exc
        if type(annotation) is not cls:
            raise CanonicalWireError(
                "ANNOTATION_SHAPE",
                "ball frame annotation V2 reconstructed as an unsupported type",
            )
        if raw != annotation.to_json_bytes():
            raise CanonicalWireError(
                "NONCANONICAL_CONTRACT",
                "ball frame annotation V2 bytes changed during reconstruction",
            )
        return annotation


@dataclass(frozen=True, slots=True)
class ObservedTemporalEventAnnotation(_CanonicalContract):
    """A directly visible or audible signal, never a legal conclusion."""

    annotation_id: str
    source_sha256: str
    ontology_sha256: str
    event_type: ObservedTemporalEventType
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
        _require_sha256(self.ontology_sha256, "ontology_sha256")
        if type(self.event_type) is not ObservedTemporalEventType:
            raise ValueError("event_type must be an ObservedTemporalEventType")
        _validate_interval(
            interval_start_ns=self.interval_start_ns,
            interval_end_ns=self.interval_end_ns,
            timestamp_basis=self.timestamp_basis,
        )
        _validate_content_address_tuple(
            self.evidence_refs,
            "evidence_refs",
            required=True,
            max_items=_MAX_EVIDENCE_REFS_PER_ANNOTATION,
        )
        if self.ambiguity_reason is not None:
            _require_nfc_utf8_text(self.ambiguity_reason, "ambiguity_reason")
        _validate_attribution(
            event_label=self.event_type.value,
            team_role=self.team_role,
            player_role=self.player_role,
            team_attribution_state=self.team_attribution_state,
            player_attribution_state=self.player_attribution_state,
            team=self.team,
            player_id=self.player_id,
            ambiguity_reason=self.ambiguity_reason,
        )
        _validate_review(
            review_state=self.review_state,
            reviewer_ids=self.reviewer_ids,
            review_evidence_refs=self.review_evidence_refs,
            adjudicator_id=self.adjudicator_id,
            adjudication_evidence_refs=self.adjudication_evidence_refs,
        )
        _validate_annotation_evidence_total(
            self.evidence_refs,
            self.review_evidence_refs,
            self.adjudication_evidence_refs,
        )

    @property
    def annotation_type(self) -> AnnotationType:
        return AnnotationType.OBSERVED_TEMPORAL_EVENT

    @property
    def truth_layer(self) -> TruthLayer:
        return TruthLayer.OBSERVATIONAL

    @property
    def team_role(self) -> TeamAttributionRole | None:
        return _OBSERVED_TEAM_ROLE_BY_EVENT.get(self.event_type)

    @property
    def player_role(self) -> PlayerAttributionRole | None:
        return _OBSERVED_PLAYER_ROLE_BY_EVENT.get(self.event_type)

    def to_canonical_dict(self) -> dict[str, Any]:
        return _temporal_canonical_dict(
            annotation=self,
            annotation_type=self.annotation_type,
            truth_layer=self.truth_layer,
            event_type=self.event_type.value,
            ontology_sha256=self.ontology_sha256,
            source_sha256=self.source_sha256,
            interval_start_ns=self.interval_start_ns,
            interval_end_ns=self.interval_end_ns,
            timestamp_basis=self.timestamp_basis,
            evidence_refs=self.evidence_refs,
            team_attribution_state=self.team_attribution_state,
            player_attribution_state=self.player_attribution_state,
            team=self.team,
            player_id=self.player_id,
            team_role=self.team_role,
            player_role=self.player_role,
            ambiguity_reason=self.ambiguity_reason,
        )


@dataclass(frozen=True, slots=True)
class PhysicalEventAdjudication(_CanonicalContract):
    """An expert physical conclusion with no score or authorization authority."""

    annotation_id: str
    source_sha256: str
    ontology_sha256: str
    event_type: PhysicalEventType
    interval_start_ns: int
    interval_end_ns: int
    timestamp_basis: TimestampBasis
    observational_annotations: tuple[ObservedTemporalEventAnnotation, ...]
    team_attribution_state: AttributionState
    player_attribution_state: AttributionState
    team: Team | None = None
    player_id: str | None = None
    landing_region: PhysicalLandingRegion | None = None
    ambiguity_reason: str | None = None
    review_state: ReviewState = ReviewState.DRAFT
    reviewer_ids: tuple[str, ...] = ()
    review_evidence_refs: tuple[str, ...] = ()
    adjudicator_id: str | None = None
    adjudication_evidence_refs: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        _require_ascii_id(self.annotation_id, "annotation_id")
        _require_sha256(self.source_sha256, "source_sha256")
        _require_sha256(self.ontology_sha256, "ontology_sha256")
        if type(self.event_type) is not PhysicalEventType:
            raise ValueError("event_type must be a PhysicalEventType")
        _validate_interval(
            interval_start_ns=self.interval_start_ns,
            interval_end_ns=self.interval_end_ns,
            timestamp_basis=self.timestamp_basis,
        )
        if (
            type(self.observational_annotations) is not tuple
            or not self.observational_annotations
            or len(self.observational_annotations)
            > _MAX_EVIDENCE_REFS_PER_ANNOTATION
            or any(
                type(annotation) is not ObservedTemporalEventAnnotation
                for annotation in self.observational_annotations
            )
        ):
            raise ValueError(
                "observational_annotations must be a non-empty bounded tuple of "
                "resolved ObservedTemporalEventAnnotation values"
            )
        observational_ids = tuple(
            annotation.annotation_id
            for annotation in self.observational_annotations
        )
        if len(set(observational_ids)) != len(observational_ids):
            raise ValueError(
                "observational_annotations cannot contain duplicate logical "
                "annotation_id values"
            )
        for annotation in self.observational_annotations:
            if annotation.source_sha256 != self.source_sha256:
                raise ValueError(
                    "resolved observational annotations must use the same source"
                )
            if annotation.ontology_sha256 != self.ontology_sha256:
                raise ValueError(
                    "resolved observational annotations must use the same ontology"
                )
            if (
                annotation.interval_start_ns < self.interval_start_ns
                or annotation.interval_end_ns > self.interval_end_ns
                or annotation.timestamp_basis is not self.timestamp_basis
            ):
                raise ValueError(
                    "resolved observational annotations must fall within the physical "
                    "adjudication interval and timestamp basis"
                )
        if self.ambiguity_reason is not None:
            _require_nfc_utf8_text(self.ambiguity_reason, "ambiguity_reason")
        if self.landing_region is not None and type(self.landing_region) is not (
            PhysicalLandingRegion
        ):
            raise ValueError("landing_region must be a PhysicalLandingRegion")
        if self.event_type is PhysicalEventType.LANDING_REGION:
            if self.landing_region is None:
                raise ValueError("LANDING_REGION requires a landing_region")
            if (
                self.landing_region is PhysicalLandingRegion.UNRESOLVED
                and self.ambiguity_reason is None
            ):
                raise ValueError("unresolved landing region requires ambiguity_reason")
        elif self.landing_region is not None:
            raise ValueError("landing_region is permitted only for LANDING_REGION")
        if self.event_type is PhysicalEventType.UNRESOLVED and self.ambiguity_reason is None:
            raise ValueError("UNRESOLVED physical adjudication requires ambiguity_reason")
        _validate_attribution(
            event_label=self.event_type.value,
            team_role=self.team_role,
            player_role=self.player_role,
            team_attribution_state=self.team_attribution_state,
            player_attribution_state=self.player_attribution_state,
            team=self.team,
            player_id=self.player_id,
            ambiguity_reason=self.ambiguity_reason,
        )
        _validate_review(
            review_state=self.review_state,
            reviewer_ids=self.reviewer_ids,
            review_evidence_refs=self.review_evidence_refs,
            adjudicator_id=self.adjudicator_id,
            adjudication_evidence_refs=self.adjudication_evidence_refs,
        )
        if self.review_state is not ReviewState.ADJUDICATED:
            raise ValueError(
                "PhysicalEventAdjudication requires ADJUDICATED review truth"
            )
        _validate_annotation_evidence_total(
            self.observational_annotations,
            self.review_evidence_refs,
            self.adjudication_evidence_refs,
        )

    @property
    def annotation_type(self) -> AnnotationType:
        return AnnotationType.PHYSICAL_EVENT_ADJUDICATION

    @property
    def truth_layer(self) -> TruthLayer:
        return TruthLayer.PHYSICAL_ADJUDICATION

    @property
    def team_role(self) -> TeamAttributionRole | None:
        return _PHYSICAL_TEAM_ROLE_BY_EVENT.get(self.event_type)

    @property
    def player_role(self) -> PlayerAttributionRole | None:
        return _PHYSICAL_PLAYER_ROLE_BY_EVENT.get(self.event_type)

    @property
    def observational_evidence_set_sha256(self) -> str:
        payload = {
            "annotations": sorted(
                (
                    {
                        "annotation_id": annotation.annotation_id,
                        "annotation_sha256": annotation.fingerprint(),
                        "annotation_type": annotation.annotation_type.value,
                    }
                    for annotation in self.observational_annotations
                ),
                key=lambda item: (item["annotation_id"], item["annotation_sha256"]),
            ),
            "domain": "multicourt-vision-scoring:physical-observation-set:v2",
            "schema_version": SCHEMA_VERSION,
        }
        return hashlib.sha256(
            json.dumps(
                payload,
                sort_keys=True,
                separators=(",", ":"),
                ensure_ascii=False,
                allow_nan=False,
            ).encode("utf-8")
        ).hexdigest()

    def to_canonical_dict(self) -> dict[str, Any]:
        payload = _temporal_canonical_dict(
            annotation=self,
            annotation_type=self.annotation_type,
            truth_layer=self.truth_layer,
            event_type=self.event_type.value,
            ontology_sha256=self.ontology_sha256,
            source_sha256=self.source_sha256,
            interval_start_ns=self.interval_start_ns,
            interval_end_ns=self.interval_end_ns,
            timestamp_basis=self.timestamp_basis,
            evidence_refs=(),
            team_attribution_state=self.team_attribution_state,
            player_attribution_state=self.player_attribution_state,
            team=self.team,
            player_id=self.player_id,
            team_role=self.team_role,
            player_role=self.player_role,
            ambiguity_reason=self.ambiguity_reason,
        )
        payload.update(
            {
                "landing_region": (
                    self.landing_region.value if self.landing_region else None
                ),
                "observational_annotations": sorted(
                    (
                        {
                            "annotation_id": annotation.annotation_id,
                            "annotation_sha256": annotation.fingerprint(),
                            "annotation_type": annotation.annotation_type.value,
                            "interval_end_ns": annotation.interval_end_ns,
                            "interval_start_ns": annotation.interval_start_ns,
                            "ontology_sha256": annotation.ontology_sha256,
                            "source_sha256": annotation.source_sha256,
                        }
                        for annotation in self.observational_annotations
                    ),
                    key=lambda item: (
                        item["annotation_id"],
                        item["annotation_sha256"],
                    ),
                ),
                "observational_evidence_set_sha256": (
                    self.observational_evidence_set_sha256
                ),
                "score_authority": False,
            }
        )
        return payload


@dataclass(frozen=True, slots=True)
class ReportedOfficialEventAnnotation(_CanonicalContract):
    """Human-reviewed report of an official record, explicitly unverified.

    The contract neither authenticates the reported source/authority nor grants
    score authority. A separate official-source signature verifier is required
    before a future schema may represent authenticated official/legal truth.
    """

    annotation_id: str
    match_id: str
    ontology_sha256: str
    ruleset_sha256: str
    event_type: ReportedOfficialEventType
    reported_source_label: str
    reported_authority_label: str
    reported_record_ref: str
    source_match_revision: int | None
    evidence_refs: tuple[str, ...]
    team_attribution_state: AttributionState
    team: Team | None = None
    ambiguity_reason: str | None = None
    review_state: ReviewState = ReviewState.DRAFT
    reviewer_ids: tuple[str, ...] = ()
    review_evidence_refs: tuple[str, ...] = ()
    adjudicator_id: str | None = None
    adjudication_evidence_refs: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        _require_ascii_id(self.annotation_id, "annotation_id")
        _require_ascii_id(self.match_id, "match_id")
        _require_sha256(self.ontology_sha256, "ontology_sha256")
        _require_sha256(self.ruleset_sha256, "ruleset_sha256")
        if type(self.event_type) is not ReportedOfficialEventType:
            raise ValueError("event_type must be a ReportedOfficialEventType")
        _require_nfc_utf8_text(self.reported_source_label, "reported_source_label")
        _require_nfc_utf8_text(
            self.reported_authority_label,
            "reported_authority_label",
        )
        _require_content_address(self.reported_record_ref, "reported_record_ref")
        if self.source_match_revision is not None and (
            type(self.source_match_revision) is not int
            or self.source_match_revision < 0
            or self.source_match_revision > _MAX_SIGNED_64_BIT_INTEGER
        ):
            raise ValueError(
                "source_match_revision must be a non-negative signed 64-bit integer or None"
            )
        _validate_content_address_tuple(
            self.evidence_refs,
            "evidence_refs",
            required=True,
            max_items=_MAX_EVIDENCE_REFS_PER_ANNOTATION,
        )
        if self.reported_record_ref not in self.evidence_refs:
            raise ValueError("evidence_refs must include reported_record_ref")
        if self.ambiguity_reason is not None:
            _require_nfc_utf8_text(self.ambiguity_reason, "ambiguity_reason")
        _validate_attribution(
            event_label=self.event_type.value,
            team_role=self.team_role,
            player_role=None,
            team_attribution_state=self.team_attribution_state,
            player_attribution_state=AttributionState.NOT_APPLICABLE,
            team=self.team,
            player_id=None,
            ambiguity_reason=self.ambiguity_reason,
        )
        _validate_review(
            review_state=self.review_state,
            reviewer_ids=self.reviewer_ids,
            review_evidence_refs=self.review_evidence_refs,
            adjudicator_id=self.adjudicator_id,
            adjudication_evidence_refs=self.adjudication_evidence_refs,
        )
        if self.review_state is ReviewState.DRAFT:
            raise ValueError(
                "reported official records cannot be DRAFT or claim unreviewed authority"
            )
        _validate_annotation_evidence_total(
            self.evidence_refs,
            self.review_evidence_refs,
            self.adjudication_evidence_refs,
        )

    @property
    def annotation_type(self) -> AnnotationType:
        return AnnotationType.REPORTED_OFFICIAL_EVENT

    @property
    def truth_layer(self) -> TruthLayer:
        return TruthLayer.REPORTED_OFFICIAL_UNVERIFIED

    @property
    def team_role(self) -> TeamAttributionRole | None:
        return _REPORTED_OFFICIAL_TEAM_ROLE_BY_EVENT.get(self.event_type)

    def to_canonical_dict(self) -> dict[str, Any]:
        return {
            "adjudication_evidence_refs": _canonical_string_list(
                self.adjudication_evidence_refs
            ),
            "adjudicator_id": self.adjudicator_id,
            "ambiguity_reason": self.ambiguity_reason,
            "annotation_id": self.annotation_id,
            "annotation_only": True,
            "annotation_type": self.annotation_type.value,
            "event_type": self.event_type.value,
            "evidence_refs": _canonical_string_list(self.evidence_refs),
            "match_id": self.match_id,
            "official_source_authenticated": False,
            "official_mutation_permitted": False,
            "ontology_sha256": self.ontology_sha256,
            "reported_authority_label": self.reported_authority_label,
            "reported_official_verification_state": (
                ReportedOfficialVerificationState.UNVERIFIED.value
            ),
            "reported_record_ref": self.reported_record_ref,
            "reported_source_label": self.reported_source_label,
            "review_evidence_refs": _canonical_string_list(
                self.review_evidence_refs
            ),
            "review_state": self.review_state.value,
            "reviewer_ids": _canonical_string_list(self.reviewer_ids),
            "ruleset_sha256": self.ruleset_sha256,
            "schema_version": SCHEMA_VERSION,
            "score_authority": False,
            "source_match_revision": self.source_match_revision,
            "team": self.team.value if self.team else None,
            "team_attribution_state": self.team_attribution_state.value,
            "team_role": self.team_role.value if self.team_role else None,
            "truth_layer": self.truth_layer.value,
        }


def _temporal_canonical_dict(
    *,
    annotation: ObservedTemporalEventAnnotation | PhysicalEventAdjudication,
    annotation_type: AnnotationType,
    truth_layer: TruthLayer,
    event_type: str,
    ontology_sha256: str,
    source_sha256: str,
    interval_start_ns: int,
    interval_end_ns: int,
    timestamp_basis: TimestampBasis,
    evidence_refs: tuple[str, ...],
    team_attribution_state: AttributionState,
    player_attribution_state: AttributionState,
    team: Team | None,
    player_id: str | None,
    team_role: TeamAttributionRole | None,
    player_role: PlayerAttributionRole | None,
    ambiguity_reason: str | None,
) -> dict[str, Any]:
    return {
        "adjudication_evidence_refs": _canonical_string_list(
            annotation.adjudication_evidence_refs
        ),
        "adjudicator_id": annotation.adjudicator_id,
        "ambiguity_reason": ambiguity_reason,
        "annotation_id": annotation.annotation_id,
        "annotation_type": annotation_type.value,
        "event_type": event_type,
        "evidence_refs": _canonical_string_list(evidence_refs),
        "interval_end_ns": interval_end_ns,
        "interval_start_ns": interval_start_ns,
        "ontology_sha256": ontology_sha256,
        "player_attribution_state": player_attribution_state.value,
        "player_id": player_id,
        "player_role": player_role.value if player_role else None,
        "review_evidence_refs": _canonical_string_list(
            annotation.review_evidence_refs
        ),
        "review_state": annotation.review_state.value,
        "reviewer_ids": _canonical_string_list(annotation.reviewer_ids),
        "schema_version": SCHEMA_VERSION,
        "source_sha256": source_sha256,
        "team": team.value if team else None,
        "team_attribution_state": team_attribution_state.value,
        "team_role": team_role.value if team_role else None,
        "timestamp_basis": timestamp_basis.value,
        "truth_layer": truth_layer.value,
    }
