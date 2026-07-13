"""Deterministic synthetic inputs for causal ball-model smoke tests.

The generator is deliberately small and artificial. It exercises tensor,
candidate, mask, simultaneous-ball, motion-blur, and optimization contracts; it
is not evaluation data and cannot support an accuracy or readiness claim.
"""

from __future__ import annotations

from dataclasses import dataclass
import math

try:
    import torch
    from torch import Tensor
except ModuleNotFoundError as error:  # pragma: no cover - optional dependency
    raise ModuleNotFoundError(
        "vision_scoring.synthetic_ball_data requires the optional 'training' "
        "dependency; install multicourt-vision-scoring[training]"
    ) from error

from .annotations import BallRole, BallVisibility
from .ball_model import (
    CausalBallInput,
    CausalBallTargets,
    MAX_CANDIDATES_PER_FRAME,
    ROLE_INDEX,
    VISIBILITY_INDEX,
    source_pixel_center_to_heatmap_coordinate,
)


_MATCH_VISIBILITY_SCHEDULE = (
    BallVisibility.VISIBLE,
    BallVisibility.VISIBLE,
    BallVisibility.PARTIALLY_OCCLUDED,
    BallVisibility.FULLY_OCCLUDED,
    BallVisibility.NOT_PRESENT,
    BallVisibility.OUT_OF_FRAME,
    BallVisibility.INDISTINGUISHABLE,
)
_MAX_SYNTHETIC_INPUT_PIXELS = 4_194_304


def _exact_int(
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


def _finite_float(
    value: object,
    field_name: str,
    *,
    minimum_exclusive: float,
    maximum: float,
) -> None:
    if (
        not isinstance(value, (int, float))
        or isinstance(value, bool)
        or not math.isfinite(value)
        or not minimum_exclusive < float(value) <= maximum
    ):
        raise ValueError(
            f"{field_name} must be finite and in ({minimum_exclusive}, {maximum}]"
        )


@dataclass(frozen=True, slots=True)
class SyntheticBallSequenceConfig:
    batch_size: int = 2
    frames: int = 6
    height: int = 32
    width: int = 48
    heatmap_stride: int = 4
    candidate_slots: int = 2
    seed: int = 20260712
    source_sigma_px: float = 1.5
    background_noise: float = 0.04

    def __post_init__(self) -> None:
        _exact_int(self.batch_size, "batch_size", minimum=1, maximum=16)
        _exact_int(self.frames, "frames", minimum=2, maximum=32)
        _exact_int(self.height, "height", minimum=16, maximum=512)
        _exact_int(self.width, "width", minimum=16, maximum=512)
        if self.heatmap_stride != 4:
            raise ValueError("heatmap_stride is fixed at 4")
        if self.height % self.heatmap_stride or self.width % self.heatmap_stride:
            raise ValueError("height and width must be divisible by heatmap_stride")
        if (
            self.batch_size * self.frames * self.height * self.width
            > _MAX_SYNTHETIC_INPUT_PIXELS
        ):
            raise ValueError("synthetic input exceeds the aggregate pixel bound")
        _exact_int(
            self.candidate_slots,
            "candidate_slots",
            minimum=2,
            maximum=MAX_CANDIDATES_PER_FRAME,
        )
        _exact_int(self.seed, "seed", minimum=0, maximum=(1 << 63) - 1)
        _finite_float(
            self.source_sigma_px,
            "source_sigma_px",
            minimum_exclusive=0.0,
            maximum=64.0,
        )
        _finite_float(
            self.background_noise,
            "background_noise",
            minimum_exclusive=0.0,
            maximum=0.25,
        )


@dataclass(frozen=True, slots=True)
class SyntheticBallBatch:
    inputs: CausalBallInput
    targets: CausalBallTargets


def _gaussian(
    grid_x: Tensor,
    grid_y: Tensor,
    *,
    center_x: float,
    center_y: float,
    sigma: float,
) -> Tensor:
    squared_distance = (grid_x - center_x).square() + (grid_y - center_y).square()
    return torch.exp(-0.5 * squared_distance / (sigma * sigma))


def make_synthetic_ball_batch(
    config: SyntheticBallSequenceConfig | None = None,
) -> SyntheticBallBatch:
    """Create repeatable match/spare Gaussian balls, streaks, and masks."""

    selected = config or SyntheticBallSequenceConfig()
    if type(selected) is not SyntheticBallSequenceConfig:
        raise ValueError("config must be a SyntheticBallSequenceConfig")

    generator = torch.Generator(device="cpu")
    generator.manual_seed(selected.seed)
    frames = selected.background_noise * torch.rand(
        (
            selected.batch_size,
            selected.frames,
            3,
            selected.height,
            selected.width,
        ),
        generator=generator,
        dtype=torch.float32,
    )
    frames += 0.03
    valid_frame_mask = torch.ones(
        (selected.batch_size, selected.frames),
        dtype=torch.bool,
    )

    heatmap_height = selected.height // selected.heatmap_stride
    heatmap_width = selected.width // selected.heatmap_stride
    heatmap_target = torch.zeros(
        (selected.batch_size, selected.frames, 1, heatmap_height, heatmap_width),
        dtype=torch.float32,
    )
    heatmap_mask = torch.ones(
        (selected.batch_size, selected.frames),
        dtype=torch.bool,
    )
    match_visibility_index = torch.empty(
        (selected.batch_size, selected.frames),
        dtype=torch.long,
    )
    match_visibility_mask = torch.ones_like(heatmap_mask)
    candidate_shape = (
        selected.batch_size,
        selected.frames,
        selected.candidate_slots,
    )
    candidate_xy = torch.full(
        (*candidate_shape, 2),
        float("nan"),
        dtype=torch.float32,
    )
    candidate_visibility_index = torch.full(
        candidate_shape,
        -1,
        dtype=torch.long,
    )
    candidate_mask = torch.zeros(candidate_shape, dtype=torch.bool)
    candidate_role_index = torch.full(
        candidate_shape,
        -1,
        dtype=torch.long,
    )
    candidate_role_mask = torch.zeros_like(candidate_mask)
    candidate_blur_axis_target = torch.full(
        (*candidate_shape, 2),
        float("nan"),
        dtype=torch.float32,
    )
    candidate_blur_extent_target = torch.full(
        candidate_shape,
        float("nan"),
        dtype=torch.float32,
    )
    candidate_blur_axis_mask = torch.zeros_like(candidate_mask)
    candidate_blur_extent_mask = torch.zeros_like(candidate_mask)

    source_y, source_x = torch.meshgrid(
        torch.arange(selected.height, dtype=torch.float32),
        torch.arange(selected.width, dtype=torch.float32),
        indexing="ij",
    )
    heatmap_y, heatmap_x = torch.meshgrid(
        torch.arange(heatmap_height, dtype=torch.float32),
        torch.arange(heatmap_width, dtype=torch.float32),
        indexing="ij",
    )

    def add_candidate(
        *,
        batch_index: int,
        time_index: int,
        slot: int,
        center_x: float,
        center_y: float,
        role: BallRole,
        visibility: BallVisibility,
        blurred: bool,
        blur_dx: float,
        blur_dy: float,
    ) -> None:
        center_heatmap_x = source_pixel_center_to_heatmap_coordinate(
            center_x,
            heatmap_stride=selected.heatmap_stride,
        )
        center_heatmap_y = source_pixel_center_to_heatmap_coordinate(
            center_y,
            heatmap_stride=selected.heatmap_stride,
        )
        candidate_mask[batch_index, time_index, slot] = True
        candidate_xy[batch_index, time_index, slot] = torch.tensor(
            (center_heatmap_x, center_heatmap_y),
            dtype=torch.float32,
        )
        candidate_visibility_index[batch_index, time_index, slot] = (
            VISIBILITY_INDEX[visibility]
        )
        candidate_role_mask[batch_index, time_index, slot] = True
        candidate_role_index[batch_index, time_index, slot] = ROLE_INDEX[role]
        candidate_blur_extent_mask[batch_index, time_index, slot] = True

        target_gaussian = _gaussian(
            heatmap_x,
            heatmap_y,
            center_x=center_heatmap_x,
            center_y=center_heatmap_y,
            sigma=max(0.7, selected.source_sigma_px / selected.heatmap_stride),
        )
        heatmap_target[batch_index, time_index, 0] = torch.maximum(
            heatmap_target[batch_index, time_index, 0],
            target_gaussian,
        )

        if blurred:
            source_blob = torch.zeros_like(source_x)
            for fraction in torch.linspace(-0.5, 0.5, 7):
                source_blob += _gaussian(
                    source_x,
                    source_y,
                    center_x=center_x + float(fraction) * blur_dx,
                    center_y=center_y + float(fraction) * blur_dy,
                    sigma=selected.source_sigma_px,
                )
            source_blob /= 7.0
            extent = math.hypot(blur_dx, blur_dy) / selected.heatmap_stride
            angle = math.atan2(blur_dy, blur_dx)
            candidate_blur_extent_target[batch_index, time_index, slot] = extent
            candidate_blur_axis_target[batch_index, time_index, slot] = torch.tensor(
                (math.cos(2.0 * angle), math.sin(2.0 * angle)),
                dtype=torch.float32,
            )
            candidate_blur_axis_mask[batch_index, time_index, slot] = True
        else:
            source_blob = _gaussian(
                source_x,
                source_y,
                center_x=center_x,
                center_y=center_y,
                sigma=selected.source_sigma_px,
            )
            candidate_blur_extent_target[batch_index, time_index, slot] = 0.0

        if visibility is BallVisibility.PARTIALLY_OCCLUDED:
            source_blob = source_blob * (source_x <= center_x)
        color = (
            (0.90, 0.75, 0.12)
            if role is BallRole.MATCH_BALL
            else (0.68, 0.78, 0.88)
        )
        for channel, intensity in enumerate(color):
            frames[batch_index, time_index, channel] += intensity * source_blob

    for batch_index in range(selected.batch_size):
        x_step = (selected.width - 1) * 0.28 / (selected.frames - 1)
        y_step = (selected.height - 1) * 0.28 / (selected.frames - 1)
        blur_dx = min(6.0, max(0.75, 2.2 * x_step))
        blur_dy = min(6.0, max(0.75, 2.2 * y_step))

        for time_index in range(selected.frames):
            progress = time_index / (selected.frames - 1)
            match_center_x = (selected.width - 1) * (
                0.15 + 0.02 * (batch_index % 4) + 0.28 * progress
            )
            match_center_y = (selected.height - 1) * (
                0.18 + 0.02 * (batch_index % 3) + 0.28 * progress
            )
            match_visibility = _MATCH_VISIBILITY_SCHEDULE[
                (time_index + batch_index) % len(_MATCH_VISIBILITY_SCHEDULE)
            ]
            match_visibility_index[batch_index, time_index] = VISIBILITY_INDEX[
                match_visibility
            ]
            if match_visibility in {
                BallVisibility.VISIBLE,
                BallVisibility.PARTIALLY_OCCLUDED,
            }:
                add_candidate(
                    batch_index=batch_index,
                    time_index=time_index,
                    slot=0,
                    center_x=match_center_x,
                    center_y=match_center_y,
                    role=BallRole.MATCH_BALL,
                    visibility=match_visibility,
                    blurred=time_index % 3 in {1, 2},
                    blur_dx=blur_dx,
                    blur_dy=blur_dy,
                )

            # A separately moving spare/adjacent ball is sometimes simultaneous
            # with the match ball and sometimes the only localizable ball.
            if time_index in {1, 4}:
                add_candidate(
                    batch_index=batch_index,
                    time_index=time_index,
                    slot=1,
                    center_x=(selected.width - 1) * (0.82 - 0.05 * progress),
                    center_y=(selected.height - 1) * (0.80 - 0.05 * progress),
                    role=(
                        BallRole.SPARE_BALL
                        if batch_index % 2 == 0
                        else (
                            BallRole.UNKNOWN
                            if time_index == 4
                            else BallRole.ADJACENT_COURT_BALL
                        )
                    ),
                    visibility=BallVisibility.VISIBLE,
                    blurred=False,
                    blur_dx=0.0,
                    blur_dy=0.0,
                )

    frames.clamp_(0.0, 1.0)
    return SyntheticBallBatch(
        inputs=CausalBallInput(
            frames=frames,
            valid_frame_mask=valid_frame_mask,
        ),
        targets=CausalBallTargets(
            heatmap_target=heatmap_target,
            heatmap_mask=heatmap_mask,
            match_visibility_index=match_visibility_index,
            match_visibility_mask=match_visibility_mask,
            candidate_xy_heatmap=candidate_xy,
            candidate_visibility_index=candidate_visibility_index,
            candidate_mask=candidate_mask,
            candidate_role_index=candidate_role_index,
            candidate_role_mask=candidate_role_mask,
            candidate_blur_axis_target=candidate_blur_axis_target,
            candidate_blur_extent_heatmap_px_target=(
                candidate_blur_extent_target
            ),
            candidate_blur_axis_mask=candidate_blur_axis_mask,
            candidate_blur_extent_mask=candidate_blur_extent_mask,
        ),
    )


__all__ = (
    "SyntheticBallBatch",
    "SyntheticBallSequenceConfig",
    "make_synthetic_ball_batch",
)
