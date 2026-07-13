"""Owned-code, strictly causal ball-perception training baseline.

This optional module requires PyTorch.  It converts present/past RGB frames into
per-frame perception tensors only.  It has no rule-event, authorization, score,
or persistence contract and must not be treated as a scoring component.
"""

from __future__ import annotations

from dataclasses import dataclass
import math

try:
    import torch
    from torch import Tensor, nn
    import torch.nn.functional as F
except ModuleNotFoundError as error:  # pragma: no cover - exercised without extra
    raise ModuleNotFoundError(
        "vision_scoring.ball_model requires the optional 'training' dependency; "
        "install multicourt-vision-scoring[training]"
    ) from error

from .annotations import BallRole, BallVisibility


VISIBILITY_STATES: tuple[BallVisibility, ...] = tuple(
    state for state in BallVisibility if state is not BallVisibility.CAPTURE_UNKNOWN
)
VISIBILITY_INDEX: dict[BallVisibility, int] = {
    state: index for index, state in enumerate(VISIBILITY_STATES)
}
ROLE_STATES: tuple[BallRole, ...] = tuple(BallRole)
ROLE_INDEX: dict[BallRole, int] = {
    role: index for index, role in enumerate(ROLE_STATES)
}
LOCALIZABLE_VISIBILITY_INDICES = frozenset(
    {
        VISIBILITY_INDEX[BallVisibility.VISIBLE],
        VISIBILITY_INDEX[BallVisibility.PARTIALLY_OCCLUDED],
    }
)
MAX_CANDIDATES_PER_FRAME = 16
_MAX_SOURCE_PIXEL_CHANNEL_BUDGET = 536_870_912


def _require_exact_int(
    value: object,
    field_name: str,
    *,
    minimum: int,
    maximum: int,
) -> None:
    if type(value) is not int or not minimum <= value <= maximum:
        raise ValueError(
            f"{field_name} must be an integer in [{minimum}, {maximum}]"
        )


def _require_finite_number(
    value: object,
    field_name: str,
    *,
    minimum: float,
    maximum: float,
    minimum_inclusive: bool = True,
) -> None:
    if (
        not isinstance(value, (int, float))
        or isinstance(value, bool)
        or not math.isfinite(value)
    ):
        raise ValueError(f"{field_name} must be a finite number")
    normalized = float(value)
    lower_ok = normalized >= minimum if minimum_inclusive else normalized > minimum
    if not lower_ok or normalized > maximum:
        lower_symbol = "[" if minimum_inclusive else "("
        raise ValueError(
            f"{field_name} must be in {lower_symbol}{minimum}, {maximum}]"
        )


def source_pixel_center_to_heatmap_coordinate(
    source_coordinate: int | float,
    *,
    heatmap_stride: int = 4,
) -> float:
    """Map a source pixel-center coordinate to the stride-four heatmap grid."""

    if heatmap_stride != 4:
        raise ValueError("heatmap_stride is fixed at 4 for this baseline")
    if (
        not isinstance(source_coordinate, (int, float))
        or isinstance(source_coordinate, bool)
        or not math.isfinite(source_coordinate)
        or source_coordinate < 0
    ):
        raise ValueError("source_coordinate must be a finite non-negative number")
    return (float(source_coordinate) + 0.5) / heatmap_stride - 0.5


@dataclass(frozen=True, slots=True)
class CausalBallModelConfig:
    """Bounded architecture contract for the V0 baseline.

    The fixed four-pixel stride keeps the center heatmap materially denser than
    a generic detector grid.  Larger source frames are expected to be processed
    as native-resolution regions or tiles rather than silently resized.
    """

    spatial_channels: int = 24
    temporal_channels: int = 32
    residual_blocks: int = 2
    heatmap_stride: int = 4
    max_batch_size: int = 16
    max_frames: int = 32
    max_height: int = 2160
    max_width: int = 3840
    max_total_input_pixels: int = 16_777_216
    min_log_variance: float = -4.0
    max_log_variance: float = 6.0
    max_blur_extent_heatmap_px: float = 64.0

    def __post_init__(self) -> None:
        _require_exact_int(
            self.spatial_channels,
            "spatial_channels",
            minimum=8,
            maximum=256,
        )
        _require_exact_int(
            self.temporal_channels,
            "temporal_channels",
            minimum=8,
            maximum=256,
        )
        _require_exact_int(
            self.residual_blocks,
            "residual_blocks",
            minimum=1,
            maximum=8,
        )
        if self.heatmap_stride != 4:
            raise ValueError("heatmap_stride is fixed at 4 for this baseline")
        _require_exact_int(
            self.max_batch_size,
            "max_batch_size",
            minimum=1,
            maximum=256,
        )
        _require_exact_int(
            self.max_frames,
            "max_frames",
            minimum=1,
            maximum=256,
        )
        _require_exact_int(
            self.max_height,
            "max_height",
            minimum=16,
            maximum=8192,
        )
        _require_exact_int(
            self.max_width,
            "max_width",
            minimum=16,
            maximum=8192,
        )
        _require_exact_int(
            self.max_total_input_pixels,
            "max_total_input_pixels",
            minimum=4096,
            maximum=2_147_483_647,
        )
        _require_finite_number(
            self.min_log_variance,
            "min_log_variance",
            minimum=-20.0,
            maximum=20.0,
        )
        _require_finite_number(
            self.max_log_variance,
            "max_log_variance",
            minimum=-20.0,
            maximum=20.0,
        )
        if self.min_log_variance >= self.max_log_variance:
            raise ValueError("min_log_variance must be less than max_log_variance")
        _require_finite_number(
            self.max_blur_extent_heatmap_px,
            "max_blur_extent_heatmap_px",
            minimum=0.0,
            maximum=4096.0,
            minimum_inclusive=False,
        )
        if (
            self.max_total_input_pixels
            * max(self.spatial_channels, self.temporal_channels)
            > _MAX_SOURCE_PIXEL_CHANNEL_BUDGET
        ):
            raise ValueError(
                "configured channel and input-pixel maxima exceed the activation budget"
            )


@dataclass(frozen=True, slots=True)
class CausalBallInput:
    """RGB sequence and explicit availability mask.

    ``frames`` is ``[batch, time, 3, height, width]`` in the closed interval
    ``[0, 1]``.  Invalid frames do not update recurrent state; their outputs are
    retained only for shape stability and remain masked by ``valid_frame_mask``.
    Capture unavailability is structural input truth, not a learned visibility
    class.
    """

    frames: Tensor
    valid_frame_mask: Tensor

    def validate(self, config: CausalBallModelConfig) -> tuple[int, int, int, int]:
        if not isinstance(self.frames, Tensor):
            raise ValueError("frames must be a torch.Tensor")
        if self.frames.ndim != 5:
            raise ValueError("frames must have shape [batch,time,3,height,width]")
        batch, frames, channels, height, width = self.frames.shape
        if channels != 3:
            raise ValueError("frames must contain exactly three RGB channels")
        if self.frames.dtype is not torch.float32:
            raise ValueError("frames must use torch.float32")
        if not 1 <= batch <= config.max_batch_size:
            raise ValueError("frame batch exceeds the configured bound")
        if not 1 <= frames <= config.max_frames:
            raise ValueError("frame sequence length exceeds the configured bound")
        if not 16 <= height <= config.max_height:
            raise ValueError("frame height exceeds the configured bounds")
        if not 16 <= width <= config.max_width:
            raise ValueError("frame width exceeds the configured bounds")
        if height % config.heatmap_stride or width % config.heatmap_stride:
            raise ValueError("frame height and width must be divisible by heatmap_stride")
        if batch * frames * height * width > config.max_total_input_pixels:
            raise ValueError("input exceeds max_total_input_pixels")
        if not bool(torch.isfinite(self.frames).all()):
            raise ValueError("frames must contain only finite values")
        if bool((self.frames < 0).any()) or bool((self.frames > 1).any()):
            raise ValueError("frames must be normalized to the closed interval [0, 1]")

        if not isinstance(self.valid_frame_mask, Tensor):
            raise ValueError("valid_frame_mask must be a torch.Tensor")
        if self.valid_frame_mask.dtype is not torch.bool:
            raise ValueError("valid_frame_mask must use torch.bool")
        if self.valid_frame_mask.shape != (batch, frames):
            raise ValueError("valid_frame_mask must have shape [batch,time]")
        if self.valid_frame_mask.device != self.frames.device:
            raise ValueError("valid_frame_mask and frames must share a device")
        return batch, frames, height, width


@dataclass(frozen=True, slots=True)
class CausalBallOutput:
    """Per-frame perception tensors without any scoring semantics.

    Candidate attributes remain dense on the heatmap grid.  They are read at a
    detected peak, so two simultaneous balls can carry different match-role,
    blur, center-offset, and uncertainty values.
    """

    heatmap_logits: Tensor
    match_visibility_logits: Tensor
    ball_role_logits: Tensor
    center_offset_xy_heatmap: Tensor
    blur_axis: Tensor
    blur_extent_heatmap_px: Tensor
    spatial_log_variance: Tensor
    valid_frame_mask: Tensor

    def validate(self) -> tuple[int, int, int, int]:
        if not isinstance(self.heatmap_logits, Tensor) or self.heatmap_logits.ndim != 5:
            raise ValueError("heatmap_logits must have shape [batch,time,1,height,width]")
        batch, frames, one, height, width = self.heatmap_logits.shape
        if one != 1 or batch < 1 or frames < 1 or height < 1 or width < 1:
            raise ValueError("heatmap_logits has an invalid bounded shape")
        expected_shapes = {
            "match_visibility_logits": (
                batch,
                frames,
                len(VISIBILITY_STATES),
            ),
            "ball_role_logits": (
                batch,
                frames,
                len(ROLE_STATES),
                height,
                width,
            ),
            "center_offset_xy_heatmap": (batch, frames, 2, height, width),
            "blur_axis": (batch, frames, 2, height, width),
            "blur_extent_heatmap_px": (batch, frames, 1, height, width),
            "spatial_log_variance": (batch, frames, 2, height, width),
            "valid_frame_mask": (batch, frames),
        }
        for field_name, expected in expected_shapes.items():
            value = getattr(self, field_name)
            if not isinstance(value, Tensor) or value.shape != expected:
                raise ValueError(f"{field_name} must have shape {list(expected)}")
            if value.device != self.heatmap_logits.device:
                raise ValueError(f"{field_name} must share the heatmap device")
        if self.valid_frame_mask.dtype is not torch.bool:
            raise ValueError("valid_frame_mask must use torch.bool")
        for field_name in (
            "heatmap_logits",
            "match_visibility_logits",
            "ball_role_logits",
            "center_offset_xy_heatmap",
            "blur_axis",
            "blur_extent_heatmap_px",
            "spatial_log_variance",
        ):
            value = getattr(self, field_name)
            if not value.dtype.is_floating_point or not bool(torch.isfinite(value).all()):
                raise ValueError(f"{field_name} must be finite floating-point output")
            if value.dtype != self.heatmap_logits.dtype:
                raise ValueError(f"{field_name} must share the heatmap dtype")
        axis_norm = torch.linalg.vector_norm(self.blur_axis, dim=2)
        if not bool(torch.allclose(axis_norm, torch.ones_like(axis_norm), atol=1e-5)):
            raise ValueError("blur_axis output must be unit length")
        if bool((self.center_offset_xy_heatmap.abs() > 0.5).any()):
            raise ValueError("center_offset_xy_heatmap output must be in [-0.5, 0.5]")
        if bool((self.blur_extent_heatmap_px < 0).any()):
            raise ValueError("blur_extent_heatmap_px output cannot be negative")
        if bool((self.blur_extent_heatmap_px > 4096.0).any()):
            raise ValueError("blur_extent_heatmap_px output exceeds the global bound")
        if bool((self.spatial_log_variance < -20.0).any()) or bool(
            (self.spatial_log_variance > 20.0).any()
        ):
            raise ValueError("spatial_log_variance output exceeds global bounds")
        return batch, frames, height, width

    @property
    def heatmap_probability(self) -> Tensor:
        return torch.sigmoid(self.heatmap_logits)

    @property
    def match_visibility_probability(self) -> Tensor:
        return torch.softmax(self.match_visibility_logits, dim=-1)

    @property
    def match_ball_probability(self) -> Tensor:
        role_probability = torch.softmax(self.ball_role_logits, dim=2)
        match_index = ROLE_INDEX[BallRole.MATCH_BALL]
        return role_probability[:, :, match_index : match_index + 1]

    @property
    def ball_role_probability(self) -> Tensor:
        return torch.softmax(self.ball_role_logits, dim=2)


@dataclass(frozen=True, slots=True)
class CausalBallTargets:
    """Dense heatmap truth plus a bounded set of candidate-local attributes.

    Candidate coordinates are rejected unless that candidate is visible or
    partially occluded. Unknown, absent, out-of-frame, fully occluded, and
    capture-unavailable truth therefore cannot be converted into invented
    coordinates. Capture-unavailable frames use ``valid_frame_mask=False`` and
    cannot supervise any head.
    """

    heatmap_target: Tensor
    heatmap_mask: Tensor
    match_visibility_index: Tensor
    match_visibility_mask: Tensor
    candidate_xy_heatmap: Tensor
    candidate_visibility_index: Tensor
    candidate_mask: Tensor
    candidate_role_index: Tensor
    candidate_role_mask: Tensor
    candidate_blur_axis_target: Tensor
    candidate_blur_extent_heatmap_px_target: Tensor
    candidate_blur_axis_mask: Tensor
    candidate_blur_extent_mask: Tensor

    def validate(self, output: CausalBallOutput) -> None:
        batch, frames, height, width = output.validate()
        if (
            not isinstance(self.candidate_xy_heatmap, Tensor)
            or self.candidate_xy_heatmap.ndim != 4
            or self.candidate_xy_heatmap.shape[:2] != (batch, frames)
            or self.candidate_xy_heatmap.shape[-1] != 2
        ):
            raise ValueError(
                "candidate_xy_heatmap must have shape [batch,time,candidate,2]"
            )
        candidates = self.candidate_xy_heatmap.shape[2]
        if not 1 <= candidates <= MAX_CANDIDATES_PER_FRAME:
            raise ValueError("candidate axis exceeds MAX_CANDIDATES_PER_FRAME")
        frame_shape = (batch, frames)
        candidate_shape = (batch, frames, candidates)
        expected_shapes = {
            "heatmap_target": (batch, frames, 1, height, width),
            "heatmap_mask": frame_shape,
            "match_visibility_index": frame_shape,
            "match_visibility_mask": frame_shape,
            "candidate_xy_heatmap": (*candidate_shape, 2),
            "candidate_visibility_index": candidate_shape,
            "candidate_mask": candidate_shape,
            "candidate_role_index": candidate_shape,
            "candidate_role_mask": candidate_shape,
            "candidate_blur_axis_target": (*candidate_shape, 2),
            "candidate_blur_extent_heatmap_px_target": candidate_shape,
            "candidate_blur_axis_mask": candidate_shape,
            "candidate_blur_extent_mask": candidate_shape,
        }
        for field_name, expected in expected_shapes.items():
            value = getattr(self, field_name)
            if not isinstance(value, Tensor) or value.shape != expected:
                raise ValueError(f"{field_name} must have shape {list(expected)}")
            if value.device != output.heatmap_logits.device:
                raise ValueError(f"{field_name} must share the output device")

        for field_name in (
            "match_visibility_index",
            "candidate_visibility_index",
            "candidate_role_index",
        ):
            if getattr(self, field_name).dtype is not torch.long:
                raise ValueError(f"{field_name} must use torch.long")
        for field_name in (
            "heatmap_mask",
            "match_visibility_mask",
            "candidate_mask",
            "candidate_role_mask",
            "candidate_blur_axis_mask",
            "candidate_blur_extent_mask",
        ):
            if getattr(self, field_name).dtype is not torch.bool:
                raise ValueError(f"{field_name} must use torch.bool")
        for field_name in (
            "heatmap_target",
            "candidate_xy_heatmap",
            "candidate_blur_axis_target",
            "candidate_blur_extent_heatmap_px_target",
        ):
            value = getattr(self, field_name)
            if not value.dtype.is_floating_point:
                raise ValueError(f"{field_name} must use a floating-point dtype")
            if value.dtype != output.heatmap_logits.dtype:
                raise ValueError(f"{field_name} must share the output dtype")

        valid_frames = output.valid_frame_mask
        for field_name in (
            "heatmap_mask",
            "match_visibility_mask",
        ):
            mask = getattr(self, field_name)
            if bool((mask & ~valid_frames).any()):
                raise ValueError(f"{field_name} cannot supervise an invalid frame")
        valid_candidates = valid_frames[:, :, None]
        for field_name in (
            "candidate_mask",
            "candidate_role_mask",
            "candidate_blur_axis_mask",
            "candidate_blur_extent_mask",
        ):
            mask = getattr(self, field_name)
            if bool((mask & ~valid_candidates).any()):
                raise ValueError(f"{field_name} cannot supervise an invalid frame")
        if bool((self.candidate_mask & ~self.heatmap_mask[:, :, None]).any()):
            raise ValueError("candidate_mask must be a subset of heatmap_mask")
        for field_name in (
            "candidate_role_mask",
            "candidate_blur_axis_mask",
            "candidate_blur_extent_mask",
        ):
            if bool((getattr(self, field_name) & ~self.candidate_mask).any()):
                raise ValueError(f"{field_name} must be a subset of candidate_mask")
        if bool(
            (self.candidate_blur_axis_mask & ~self.candidate_blur_extent_mask).any()
        ):
            raise ValueError(
                "candidate_blur_axis_mask must be a subset of blur extent mask"
            )

        if bool(self.match_visibility_mask.any()):
            selected_visibility = self.match_visibility_index[
                self.match_visibility_mask
            ]
            if bool((selected_visibility < 0).any()) or bool(
                (selected_visibility >= len(VISIBILITY_STATES)).any()
            ):
                raise ValueError("supervised match_visibility_index is out of range")
        if bool(self.candidate_mask.any()):
            coordinate_visibility = self.candidate_visibility_index[
                self.candidate_mask
            ]
            localizable = torch.zeros_like(coordinate_visibility, dtype=torch.bool)
            for index in LOCALIZABLE_VISIBILITY_INDICES:
                localizable |= coordinate_visibility == index
            if not bool(localizable.all()):
                raise ValueError(
                    "coordinate supervision requires visible or partially occluded truth"
                )
            selected_centers = self.candidate_xy_heatmap[self.candidate_mask]
            if not bool(torch.isfinite(selected_centers).all()):
                raise ValueError("supervised centers must be finite")
            if bool((selected_centers[:, 0] < -0.5).any()) or bool(
                (selected_centers[:, 0] >= width - 0.5).any()
            ):
                raise ValueError("supervised center x is outside the heatmap")
            if bool((selected_centers[:, 1] < -0.5).any()) or bool(
                (selected_centers[:, 1] >= height - 0.5).any()
            ):
                raise ValueError("supervised center y is outside the heatmap")

        if bool(self.heatmap_mask.any()):
            selected_heatmaps = self.heatmap_target[self.heatmap_mask]
            if not bool(torch.isfinite(selected_heatmaps).all()):
                raise ValueError("supervised heatmaps must be finite")
            if bool((selected_heatmaps < 0).any()) or bool(
                (selected_heatmaps > 1).any()
            ):
                raise ValueError("supervised heatmaps must be in [0, 1]")
            empty_enumerations = self.heatmap_mask & ~self.candidate_mask.any(
                dim=-1
            )
            if bool(empty_enumerations.any()) and bool(
                (self.heatmap_target[empty_enumerations] != 0).any()
            ):
                raise ValueError(
                    "zero-candidate heatmap supervision must be exactly zero"
                )

        if bool(self.candidate_role_mask.any()):
            selected_roles = self.candidate_role_index[
                self.candidate_role_mask
            ]
            if bool((selected_roles < 0).any()) or bool(
                (selected_roles >= len(ROLE_STATES)).any()
            ):
                raise ValueError(
                    "supervised candidate_role_index is out of range"
                )
        supervised_match_candidates = self.candidate_role_mask & (
            self.candidate_role_index == ROLE_INDEX[BallRole.MATCH_BALL]
        )
        match_counts = supervised_match_candidates.sum(dim=-1)
        if bool((match_counts > 1).any()):
            raise ValueError("a frame cannot contain multiple logical match balls")
        if bool(self.match_visibility_mask.any()):
            localizable_match = torch.zeros_like(self.match_visibility_mask)
            for index in LOCALIZABLE_VISIBILITY_INDICES:
                localizable_match |= self.match_visibility_index == index
            expected_one = self.match_visibility_mask & localizable_match
            expected_zero = self.match_visibility_mask & ~localizable_match
            if bool((expected_one & (match_counts != 1)).any()):
                raise ValueError(
                    "localizable match visibility requires one match-ball candidate"
                )
            if bool((expected_zero & (match_counts != 0)).any()):
                raise ValueError(
                    "nonlocalizable match visibility forbids a match-ball candidate"
                )

        if bool(self.candidate_blur_axis_mask.any()):
            axes = self.candidate_blur_axis_target[
                self.candidate_blur_axis_mask
            ]
            if not bool(torch.isfinite(axes).all()):
                raise ValueError("supervised blur axes must be finite")
            norms = torch.linalg.vector_norm(axes, dim=-1)
            if not bool(torch.allclose(norms, torch.ones_like(norms), atol=1e-4)):
                raise ValueError("supervised candidate blur axes must be unit length")
        if bool(self.candidate_blur_extent_mask.any()):
            extents = self.candidate_blur_extent_heatmap_px_target[
                self.candidate_blur_extent_mask
            ]
            if not bool(torch.isfinite(extents).all()):
                raise ValueError("supervised blur extents must be finite")
            if bool((extents < 0).any()):
                raise ValueError("supervised blur extent cannot be negative")
            max_extent = math.hypot(width, height)
            if bool((extents > max_extent).any()):
                raise ValueError("supervised blur extent exceeds the heatmap diagonal")
            axis_extents = self.candidate_blur_extent_heatmap_px_target[
                self.candidate_blur_axis_mask
            ]
            if bool((axis_extents <= 0).any()):
                raise ValueError("supervised blur axis requires a positive extent")

        self._validate_candidate_anchors(height=height, width=width)

    def _validate_candidate_anchors(self, *, height: int, width: int) -> None:
        if not bool(self.candidate_mask.any()):
            return
        rounded = _candidate_anchor_xy(
            self.candidate_xy_heatmap,
            self.candidate_mask,
        )
        for batch_index in range(self.candidate_mask.shape[0]):
            for time_index in range(self.candidate_mask.shape[1]):
                active = self.candidate_mask[batch_index, time_index]
                if not bool(active.any()):
                    continue
                anchors = rounded[batch_index, time_index][active]
                anchor_pairs = [tuple(item) for item in anchors.tolist()]
                if len(set(anchor_pairs)) != len(anchor_pairs):
                    raise ValueError(
                        "supervised candidates cannot share one heatmap anchor"
                    )
                for x_index, y_index in anchor_pairs:
                    if not (0 <= x_index < width and 0 <= y_index < height):
                        raise ValueError("rounded candidate anchor is outside the heatmap")
                    peak = self.heatmap_target[
                        batch_index,
                        time_index,
                        0,
                        y_index,
                        x_index,
                    ]
                    if not bool(torch.isfinite(peak)) or float(peak) <= 0.0:
                        raise ValueError(
                            "candidate anchor must have positive heatmap supervision"
                        )


@dataclass(frozen=True, slots=True)
class CausalBallLossConfig:
    heatmap_weight: float = 1.0
    visibility_weight: float = 1.0
    role_weight: float = 0.5
    blur_axis_weight: float = 0.25
    blur_extent_weight: float = 0.25
    uncertainty_weight: float = 0.25
    heatmap_focal_alpha: float = 0.75
    heatmap_focal_gamma: float = 2.0

    def __post_init__(self) -> None:
        for field_name in (
            "heatmap_weight",
            "visibility_weight",
            "role_weight",
            "blur_axis_weight",
            "blur_extent_weight",
            "uncertainty_weight",
        ):
            _require_finite_number(
                getattr(self, field_name),
                field_name,
                minimum=0.0,
                maximum=1_000_000.0,
                minimum_inclusive=False,
            )
        _require_finite_number(
            self.heatmap_focal_alpha,
            "heatmap_focal_alpha",
            minimum=0.0,
            maximum=1.0,
            minimum_inclusive=False,
        )
        if self.heatmap_focal_alpha >= 1.0:
            raise ValueError("heatmap_focal_alpha must be less than 1")
        _require_finite_number(
            self.heatmap_focal_gamma,
            "heatmap_focal_gamma",
            minimum=0.0,
            maximum=8.0,
            minimum_inclusive=False,
        )


@dataclass(frozen=True, slots=True)
class CausalBallLossOutput:
    total: Tensor
    heatmap: Tensor
    match_visibility: Tensor
    role: Tensor
    blur_axis: Tensor
    blur_extent: Tensor
    center_uncertainty_nll: Tensor
    heatmap_frames: int
    match_visibility_frames: int
    candidates: int
    role_candidates: int
    blur_axis_candidates: int
    blur_extent_candidates: int


def _group_count(channels: int) -> int:
    for groups in (8, 4, 2):
        if channels % groups == 0:
            return groups
    return 1


class _ConvNormActivation(nn.Module):
    def __init__(self, in_channels: int, out_channels: int, *, stride: int) -> None:
        super().__init__()
        self.layers = nn.Sequential(
            nn.Conv2d(
                in_channels,
                out_channels,
                kernel_size=3,
                stride=stride,
                padding=1,
                bias=False,
            ),
            nn.GroupNorm(_group_count(out_channels), out_channels),
            nn.SiLU(),
        )

    def forward(self, inputs: Tensor) -> Tensor:
        return self.layers(inputs)


class _ResidualSpatialBlock(nn.Module):
    def __init__(self, channels: int) -> None:
        super().__init__()
        self.conv1 = _ConvNormActivation(channels, channels, stride=1)
        self.conv2 = nn.Conv2d(channels, channels, kernel_size=3, padding=1, bias=False)
        self.norm2 = nn.GroupNorm(_group_count(channels), channels)

    def forward(self, inputs: Tensor) -> Tensor:
        return F.silu(inputs + self.norm2(self.conv2(self.conv1(inputs))))


class _SpatialEncoder(nn.Module):
    def __init__(self, config: CausalBallModelConfig) -> None:
        super().__init__()
        stem_channels = max(8, config.spatial_channels // 2)
        self.stem = nn.Sequential(
            _ConvNormActivation(3, stem_channels, stride=2),
            _ConvNormActivation(stem_channels, config.spatial_channels, stride=2),
        )
        self.blocks = nn.Sequential(
            *[
                _ResidualSpatialBlock(config.spatial_channels)
                for _ in range(config.residual_blocks)
            ]
        )

    def forward(self, frames: Tensor) -> Tensor:
        return self.blocks(self.stem(frames))


class _CausalConvGRUCell(nn.Module):
    def __init__(self, input_channels: int, hidden_channels: int) -> None:
        super().__init__()
        combined = input_channels + hidden_channels
        self.hidden_channels = hidden_channels
        self.gates = nn.Conv2d(combined, 2 * hidden_channels, 3, padding=1)
        self.candidate = nn.Conv2d(combined, hidden_channels, 3, padding=1)

    def forward(self, inputs: Tensor, hidden: Tensor) -> Tensor:
        reset, update = torch.sigmoid(
            self.gates(torch.cat((inputs, hidden), dim=1))
        ).chunk(2, dim=1)
        candidate = torch.tanh(
            self.candidate(torch.cat((inputs, reset * hidden), dim=1))
        )
        return (1.0 - update) * hidden + update * candidate


class CausalBallPerceptionModel(nn.Module):
    """Stride-four encoder plus a forward-only spatial recurrent fusion cell."""

    def __init__(self, config: CausalBallModelConfig) -> None:
        super().__init__()
        if type(config) is not CausalBallModelConfig:
            raise ValueError("config must be a CausalBallModelConfig")
        self.config = config
        self.encoder = _SpatialEncoder(config)
        self.temporal = _CausalConvGRUCell(
            config.spatial_channels,
            config.temporal_channels,
        )
        channels = config.temporal_channels
        self.heatmap_head = nn.Conv2d(channels, 1, kernel_size=1)
        self.match_visibility_head = nn.Linear(channels, len(VISIBILITY_STATES))
        self.ball_role_head = nn.Conv2d(channels, len(ROLE_STATES), kernel_size=1)
        self.center_offset_head = nn.Conv2d(channels, 2, kernel_size=1)
        self.blur_phase_head = nn.Conv2d(channels, 1, kernel_size=1)
        self.blur_extent_head = nn.Conv2d(channels, 1, kernel_size=1)
        self.uncertainty_head = nn.Conv2d(channels, 2, kernel_size=1)

    def forward(self, inputs: CausalBallInput) -> CausalBallOutput:
        if type(inputs) is not CausalBallInput:
            raise ValueError("inputs must be a CausalBallInput")
        batch, frames, height, width = inputs.validate(self.config)
        parameter = self.heatmap_head.weight
        if inputs.frames.device != parameter.device:
            raise ValueError("frames and model parameters must share a device")
        if inputs.frames.dtype != parameter.dtype:
            raise ValueError("frames and model parameters must share a dtype")
        heatmap_height = height // self.config.heatmap_stride
        heatmap_width = width // self.config.heatmap_stride

        encoded = self.encoder(inputs.frames.reshape(batch * frames, 3, height, width))
        encoded = encoded.reshape(
            batch,
            frames,
            self.config.spatial_channels,
            heatmap_height,
            heatmap_width,
        )
        hidden = encoded.new_zeros(
            batch,
            self.config.temporal_channels,
            heatmap_height,
            heatmap_width,
        )
        causal_features: list[Tensor] = []
        for time_index in range(frames):
            candidate_hidden = self.temporal(encoded[:, time_index], hidden)
            update_mask = inputs.valid_frame_mask[:, time_index, None, None, None]
            hidden = torch.where(
                update_mask,
                candidate_hidden,
                torch.zeros_like(hidden),
            )
            causal_features.append(hidden)
        features = torch.stack(causal_features, dim=1)
        flat_features = features.reshape(
            batch * frames,
            self.config.temporal_channels,
            heatmap_height,
            heatmap_width,
        )
        heatmap_logits = self.heatmap_head(flat_features).reshape(
            batch,
            frames,
            1,
            heatmap_height,
            heatmap_width,
        )
        pooled = F.adaptive_avg_pool2d(flat_features, 1).flatten(1)
        match_visibility_logits = self.match_visibility_head(pooled).reshape(
            batch,
            frames,
            len(VISIBILITY_STATES),
        )
        ball_role_logits = self.ball_role_head(flat_features).reshape(
            batch,
            frames,
            len(ROLE_STATES),
            heatmap_height,
            heatmap_width,
        )
        center_offset_xy_heatmap = 0.5 * torch.tanh(
            self.center_offset_head(flat_features)
        ).reshape(
            batch,
            frames,
            2,
            heatmap_height,
            heatmap_width,
        )

        axial_phase = math.pi * torch.tanh(self.blur_phase_head(flat_features))
        blur_axis = torch.cat(
            (torch.cos(axial_phase), torch.sin(axial_phase)),
            dim=1,
        ).reshape(
            batch,
            frames,
            2,
            heatmap_height,
            heatmap_width,
        )
        blur_extent = self.config.max_blur_extent_heatmap_px * torch.sigmoid(
            self.blur_extent_head(flat_features)
        ).reshape(
            batch,
            frames,
            1,
            heatmap_height,
            heatmap_width,
        )

        uncertainty_fraction = torch.sigmoid(
            self.uncertainty_head(flat_features)
        ).reshape(
            batch,
            frames,
            2,
            heatmap_height,
            heatmap_width,
        )
        spatial_log_variance = self.config.min_log_variance + (
            self.config.max_log_variance - self.config.min_log_variance
        ) * uncertainty_fraction

        return CausalBallOutput(
            heatmap_logits=heatmap_logits,
            match_visibility_logits=match_visibility_logits,
            ball_role_logits=ball_role_logits,
            center_offset_xy_heatmap=center_offset_xy_heatmap,
            blur_axis=blur_axis,
            blur_extent_heatmap_px=blur_extent,
            spatial_log_variance=spatial_log_variance,
            valid_frame_mask=inputs.valid_frame_mask,
        )


def _candidate_anchor_xy(
    candidate_xy_heatmap: Tensor,
    candidate_mask: Tensor,
) -> Tensor:
    safe_coordinates = torch.where(
        candidate_mask[..., None],
        candidate_xy_heatmap,
        torch.zeros_like(candidate_xy_heatmap),
    )
    return torch.floor(safe_coordinates + 0.5).to(torch.long)


def _gather_candidate_map(
    dense_map: Tensor,
    candidate_xy_heatmap: Tensor,
    candidate_mask: Tensor,
) -> Tensor:
    """Sample ``[B,T,C,H,W]`` maps at bounded nearest candidate anchors."""

    batch, frames, _channels, _height, _width = dense_map.shape
    candidates = candidate_xy_heatmap.shape[2]
    anchors = _candidate_anchor_xy(candidate_xy_heatmap, candidate_mask)
    batch_index = torch.arange(batch, device=dense_map.device)[:, None, None]
    time_index = torch.arange(frames, device=dense_map.device)[None, :, None]
    batch_index = batch_index.expand(batch, frames, candidates)
    time_index = time_index.expand(batch, frames, candidates)
    dense_last = dense_map.permute(0, 1, 3, 4, 2)
    return dense_last[
        batch_index,
        time_index,
        anchors[..., 1],
        anchors[..., 0],
    ]


def _positive_balanced_focal_heatmap_loss(
    logits: Tensor,
    targets: Tensor,
    *,
    alpha: float,
    gamma: float,
) -> Tensor:
    """Soft focal loss with separately normalized positive and negative mass."""

    probability = torch.sigmoid(logits)
    positive = (
        -alpha
        * targets
        * (1.0 - probability).pow(gamma)
        * F.logsigmoid(logits)
    )
    negative = (
        -(1.0 - alpha)
        * (1.0 - targets)
        * probability.pow(gamma)
        * F.logsigmoid(-logits)
    )
    positive_mass = targets.flatten(1).sum(dim=1)
    negative_mass = (1.0 - targets).flatten(1).sum(dim=1)
    positive_per_frame = positive.flatten(1).sum(dim=1) / positive_mass.clamp_min(
        1.0
    )
    negative_per_frame = negative.flatten(1).sum(dim=1) / negative_mass.clamp_min(
        1.0
    )
    return (positive_per_frame + negative_per_frame).mean()


def _zero_loss(reference: Tensor) -> Tensor:
    return reference.reshape(-1)[0] * 0.0


class CausalBallMultiTaskLoss(nn.Module):
    """Candidate-local supervision with focal detection and center NLL."""

    def __init__(self, config: CausalBallLossConfig | None = None) -> None:
        super().__init__()
        self.config = config or CausalBallLossConfig()
        if type(self.config) is not CausalBallLossConfig:
            raise ValueError("config must be a CausalBallLossConfig")

    def forward(
        self,
        output: CausalBallOutput,
        targets: CausalBallTargets,
    ) -> CausalBallLossOutput:
        if type(output) is not CausalBallOutput:
            raise ValueError("output must be a CausalBallOutput")
        if type(targets) is not CausalBallTargets:
            raise ValueError("targets must be CausalBallTargets")
        targets.validate(output)

        heatmap_mask = targets.heatmap_mask
        visibility_mask = targets.match_visibility_mask
        candidate_mask = targets.candidate_mask
        role_mask = targets.candidate_role_mask
        blur_axis_mask = targets.candidate_blur_axis_mask
        blur_extent_mask = targets.candidate_blur_extent_mask

        if bool(heatmap_mask.any()):
            heatmap_loss = _positive_balanced_focal_heatmap_loss(
                output.heatmap_logits[heatmap_mask],
                targets.heatmap_target[heatmap_mask],
                alpha=self.config.heatmap_focal_alpha,
                gamma=self.config.heatmap_focal_gamma,
            )
        else:
            heatmap_loss = _zero_loss(output.heatmap_logits)

        sampled_offset = _gather_candidate_map(
            output.center_offset_xy_heatmap,
            targets.candidate_xy_heatmap,
            candidate_mask,
        )
        sampled_log_variance = _gather_candidate_map(
            output.spatial_log_variance,
            targets.candidate_xy_heatmap,
            candidate_mask,
        )
        if bool(candidate_mask.any()):
            anchors = _candidate_anchor_xy(
                targets.candidate_xy_heatmap,
                candidate_mask,
            ).to(output.heatmap_logits.dtype)
            predicted_center = anchors + sampled_offset
            center_error = (
                predicted_center[candidate_mask]
                - targets.candidate_xy_heatmap[candidate_mask]
            )
            log_variance = sampled_log_variance[candidate_mask]
            center_uncertainty_nll = (
                0.5
                * (torch.exp(-log_variance) * center_error.square() + log_variance)
            ).sum(dim=-1).mean()
        else:
            center_uncertainty_nll = _zero_loss(output.spatial_log_variance)

        if bool(visibility_mask.any()):
            visibility_loss = F.cross_entropy(
                output.match_visibility_logits[visibility_mask],
                targets.match_visibility_index[visibility_mask],
            )
        else:
            visibility_loss = _zero_loss(output.match_visibility_logits)

        sampled_role_logits = _gather_candidate_map(
            output.ball_role_logits,
            targets.candidate_xy_heatmap,
            candidate_mask,
        )
        if bool(role_mask.any()):
            role_loss = F.cross_entropy(
                sampled_role_logits[role_mask],
                targets.candidate_role_index[role_mask],
            )
        else:
            role_loss = _zero_loss(output.ball_role_logits)

        sampled_blur_axis = _gather_candidate_map(
            output.blur_axis,
            targets.candidate_xy_heatmap,
            candidate_mask,
        )
        if bool(blur_axis_mask.any()):
            predicted_axis = sampled_blur_axis[blur_axis_mask]
            target_axis = targets.candidate_blur_axis_target[blur_axis_mask]
            blur_axis_loss = (1.0 - (predicted_axis * target_axis).sum(dim=-1)).mean()
        else:
            blur_axis_loss = _zero_loss(output.blur_axis)

        sampled_blur_extent = _gather_candidate_map(
            output.blur_extent_heatmap_px,
            targets.candidate_xy_heatmap,
            candidate_mask,
        ).squeeze(-1)
        if bool(blur_extent_mask.any()):
            blur_extent_loss = F.smooth_l1_loss(
                sampled_blur_extent[blur_extent_mask],
                targets.candidate_blur_extent_heatmap_px_target[
                    blur_extent_mask
                ],
            )
        else:
            blur_extent_loss = _zero_loss(output.blur_extent_heatmap_px)

        total = (
            self.config.heatmap_weight * heatmap_loss
            + self.config.visibility_weight * visibility_loss
            + self.config.role_weight * role_loss
            + self.config.blur_axis_weight * blur_axis_loss
            + self.config.blur_extent_weight * blur_extent_loss
            + self.config.uncertainty_weight * center_uncertainty_nll
        )
        loss_scalars = (
            heatmap_loss,
            visibility_loss,
            role_loss,
            blur_axis_loss,
            blur_extent_loss,
            center_uncertainty_nll,
            total,
        )
        if any(
            scalar.numel() != 1 or not bool(torch.isfinite(scalar))
            for scalar in loss_scalars
        ):
            raise ValueError("non-finite loss component or total")
        return CausalBallLossOutput(
            total=total,
            heatmap=heatmap_loss,
            match_visibility=visibility_loss,
            role=role_loss,
            blur_axis=blur_axis_loss,
            blur_extent=blur_extent_loss,
            center_uncertainty_nll=center_uncertainty_nll,
            heatmap_frames=int(heatmap_mask.sum().item()),
            match_visibility_frames=int(visibility_mask.sum().item()),
            candidates=int(candidate_mask.sum().item()),
            role_candidates=int(role_mask.sum().item()),
            blur_axis_candidates=int(blur_axis_mask.sum().item()),
            blur_extent_candidates=int(blur_extent_mask.sum().item()),
        )


__all__ = (
    "CausalBallInput",
    "CausalBallLossConfig",
    "CausalBallLossOutput",
    "CausalBallModelConfig",
    "CausalBallMultiTaskLoss",
    "CausalBallOutput",
    "CausalBallPerceptionModel",
    "CausalBallTargets",
    "LOCALIZABLE_VISIBILITY_INDICES",
    "MAX_CANDIDATES_PER_FRAME",
    "ROLE_INDEX",
    "ROLE_STATES",
    "VISIBILITY_INDEX",
    "VISIBILITY_STATES",
    "source_pixel_center_to_heatmap_coordinate",
)
