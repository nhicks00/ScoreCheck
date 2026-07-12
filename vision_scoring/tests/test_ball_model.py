from __future__ import annotations

from dataclasses import fields, replace
import math
import unittest

try:
    import torch
except ModuleNotFoundError:  # Base runtime intentionally omits training dependencies.
    torch = None  # type: ignore[assignment]

if torch is not None:
    import vision_scoring.ball_model as ball_model_module
    from vision_scoring.annotations import BallRole, BallVisibility
    from vision_scoring.ball_model import (
        CausalBallInput,
        CausalBallLossConfig,
        CausalBallModelConfig,
        CausalBallMultiTaskLoss,
        CausalBallPerceptionModel,
        ROLE_INDEX,
        ROLE_STATES,
        VISIBILITY_INDEX,
        VISIBILITY_STATES,
        source_pixel_center_to_heatmap_coordinate,
    )
    from vision_scoring.synthetic_ball_data import (
        SyntheticBallSequenceConfig,
        make_synthetic_ball_batch,
    )


@unittest.skipIf(torch is None, "optional training dependency is not installed")
class CausalBallModelTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        torch.set_num_threads(1)

    def setUp(self) -> None:
        torch.manual_seed(19)
        self.model_config = CausalBallModelConfig(
            spatial_channels=8,
            temporal_channels=8,
            residual_blocks=1,
            max_batch_size=4,
            max_frames=8,
            max_height=64,
            max_width=96,
            max_total_input_pixels=1_000_000,
            max_blur_extent_heatmap_px=16.0,
        )
        self.synthetic_config = SyntheticBallSequenceConfig(
            batch_size=2,
            frames=6,
            height=32,
            width=48,
            seed=913,
        )

    def _model_and_batch(self):
        return (
            CausalBallPerceptionModel(self.model_config),
            make_synthetic_ball_batch(self.synthetic_config),
        )

    def test_candidate_local_heads_have_bounded_shapes_and_no_score_contract(self) -> None:
        model, batch = self._model_and_batch()
        output = model(batch.inputs)

        self.assertEqual(output.heatmap_logits.shape, (2, 6, 1, 8, 12))
        self.assertEqual(
            output.match_visibility_logits.shape,
            (2, 6, len(VISIBILITY_STATES)),
        )
        self.assertEqual(
            output.ball_role_logits.shape,
            (2, 6, len(ROLE_STATES), 8, 12),
        )
        self.assertEqual(output.center_offset_xy_heatmap.shape, (2, 6, 2, 8, 12))
        self.assertEqual(output.blur_axis.shape, (2, 6, 2, 8, 12))
        self.assertEqual(output.blur_extent_heatmap_px.shape, (2, 6, 1, 8, 12))
        self.assertEqual(output.spatial_log_variance.shape, (2, 6, 2, 8, 12))
        self.assertEqual(output.match_ball_probability.shape, (2, 6, 1, 8, 12))
        self.assertTrue(
            torch.allclose(
                output.ball_role_probability.sum(dim=2),
                torch.ones((2, 6, 8, 12)),
                atol=1e-6,
            )
        )
        self.assertTrue(
            torch.allclose(
                torch.linalg.vector_norm(output.blur_axis, dim=2),
                torch.ones((2, 6, 8, 12)),
                atol=1e-6,
            )
        )
        self.assertLessEqual(
            float(output.center_offset_xy_heatmap.detach().abs().max()),
            0.5,
        )
        self.assertGreaterEqual(
            float(output.blur_extent_heatmap_px.detach().min()),
            0.0,
        )
        self.assertLessEqual(
            float(output.blur_extent_heatmap_px.detach().max()),
            self.model_config.max_blur_extent_heatmap_px,
        )
        self.assertGreaterEqual(
            float(output.spatial_log_variance.detach().min()),
            self.model_config.min_log_variance,
        )
        self.assertLessEqual(
            float(output.spatial_log_variance.detach().max()),
            self.model_config.max_log_variance,
        )
        output_fields = {item.name for item in fields(output)}
        self.assertTrue(
            output_fields.isdisjoint(
                {"score", "score_state", "event", "rule_event", "authorization"}
            )
        )

    def test_prefix_outputs_are_invariant_to_appended_and_changed_future(self) -> None:
        model, batch = self._model_and_batch()
        model.eval()
        prefix_length = 3
        prefix_input = CausalBallInput(
            frames=batch.inputs.frames[:, :prefix_length].clone(),
            valid_frame_mask=batch.inputs.valid_frame_mask[:, :prefix_length].clone(),
        )
        changed_future_frames = batch.inputs.frames.clone()
        generator = torch.Generator(device="cpu")
        generator.manual_seed(7781)
        changed_future_frames[:, prefix_length:] = torch.rand(
            changed_future_frames[:, prefix_length:].shape,
            generator=generator,
        )
        changed_future = CausalBallInput(
            frames=changed_future_frames,
            valid_frame_mask=batch.inputs.valid_frame_mask.clone(),
        )

        with torch.inference_mode():
            prefix_output = model(prefix_input)
            appended_output = model(batch.inputs)
            changed_output = model(changed_future)

        for field_name in (
            "heatmap_logits",
            "match_visibility_logits",
            "ball_role_logits",
            "center_offset_xy_heatmap",
            "blur_axis",
            "blur_extent_heatmap_px",
            "spatial_log_variance",
        ):
            expected = getattr(prefix_output, field_name)
            appended_prefix = getattr(appended_output, field_name)[:, :prefix_length]
            changed_prefix = getattr(changed_output, field_name)[:, :prefix_length]
            self.assertTrue(
                torch.allclose(expected, appended_prefix, atol=1e-6, rtol=1e-6),
                field_name,
            )
            self.assertTrue(
                torch.allclose(expected, changed_prefix, atol=1e-6, rtol=1e-6),
                field_name,
            )

    def test_capture_gap_resets_all_pre_gap_recurrent_evidence(self) -> None:
        model, batch = self._model_and_batch()
        model.eval()
        gap_index = 2
        first_frames = batch.inputs.frames[:1].clone()
        changed_frames = first_frames.clone()
        generator = torch.Generator(device="cpu")
        generator.manual_seed(1881)
        changed_frames[:, : gap_index + 1] = torch.rand(
            changed_frames[:, : gap_index + 1].shape,
            generator=generator,
        )
        valid_mask = batch.inputs.valid_frame_mask[:1].clone()
        valid_mask[:, gap_index] = False

        with torch.inference_mode():
            first_output = model(
                CausalBallInput(
                    frames=first_frames,
                    valid_frame_mask=valid_mask,
                )
            )
            changed_output = model(
                CausalBallInput(
                    frames=changed_frames,
                    valid_frame_mask=valid_mask,
                )
            )

        for field_name in (
            "heatmap_logits",
            "match_visibility_logits",
            "ball_role_logits",
            "center_offset_xy_heatmap",
            "blur_axis",
            "blur_extent_heatmap_px",
            "spatial_log_variance",
        ):
            first_suffix = getattr(first_output, field_name)[:, gap_index + 1 :]
            changed_suffix = getattr(changed_output, field_name)[:, gap_index + 1 :]
            self.assertTrue(
                torch.allclose(first_suffix, changed_suffix, atol=1e-6, rtol=1e-6),
                field_name,
            )

    def test_cpu_smoke_training_has_finite_loss_and_gradients(self) -> None:
        model, batch = self._model_and_batch()
        model.train()
        optimizer = torch.optim.Adam(model.parameters(), lr=1e-3)
        loss_function = CausalBallMultiTaskLoss()

        optimizer.zero_grad(set_to_none=True)
        output = model(batch.inputs)
        loss = loss_function(output, batch.targets)
        self.assertTrue(bool(torch.isfinite(loss.total)))
        self.assertGreater(loss.heatmap_frames, 0)
        self.assertGreater(loss.match_visibility_frames, 0)
        self.assertGreater(loss.candidates, 0)
        self.assertGreater(loss.role_candidates, 0)
        self.assertGreater(loss.blur_axis_candidates, 0)
        self.assertGreater(loss.blur_extent_candidates, loss.blur_axis_candidates)
        loss.total.backward()

        gradients = [
            parameter.grad
            for parameter in model.parameters()
            if parameter.requires_grad and parameter.grad is not None
        ]
        self.assertTrue(gradients)
        self.assertTrue(all(bool(torch.isfinite(gradient).all()) for gradient in gradients))
        self.assertGreater(
            sum(float(gradient.abs().sum()) for gradient in gradients),
            0.0,
        )
        optimizer.step()
        self.assertTrue(
            all(
                bool(torch.isfinite(parameter).all())
                for parameter in model.parameters()
            )
        )

    def test_simultaneous_and_unknown_roles_are_representable(self) -> None:
        model, batch = self._model_and_batch()
        simultaneous = batch.targets.candidate_mask[0, 1]
        self.assertEqual(int(simultaneous.sum()), 2)
        roles = batch.targets.candidate_role_index[0, 1][simultaneous]
        self.assertEqual(
            set(roles.tolist()),
            {
                ROLE_INDEX[BallRole.MATCH_BALL],
                ROLE_INDEX[BallRole.SPARE_BALL],
            },
        )

        output = model(batch.inputs)
        role_logits = torch.zeros_like(output.ball_role_logits)
        for batch_index in range(batch.targets.candidate_mask.shape[0]):
            for time_index in range(batch.targets.candidate_mask.shape[1]):
                for candidate_index in range(batch.targets.candidate_mask.shape[2]):
                    if not bool(
                        batch.targets.candidate_role_mask[
                            batch_index,
                            time_index,
                            candidate_index,
                        ]
                    ):
                        continue
                    x, y = torch.floor(
                        batch.targets.candidate_xy_heatmap[
                            batch_index,
                            time_index,
                            candidate_index,
                        ]
                        + 0.5
                    ).to(torch.long)
                    target = batch.targets.candidate_role_index[
                        batch_index,
                        time_index,
                        candidate_index,
                    ]
                    role_logits[
                        batch_index,
                        time_index,
                        int(target),
                        y,
                        x,
                    ] = 12.0
        controlled = replace(output, ball_role_logits=role_logits)
        loss = CausalBallMultiTaskLoss()(controlled, batch.targets)
        self.assertLess(float(loss.role.detach()), 1e-4)
        self.assertTrue(bool(torch.isfinite(loss.total)))

        unknown_index = ROLE_INDEX[BallRole.UNKNOWN]
        unknown_candidates = batch.targets.candidate_role_mask & (
            batch.targets.candidate_role_index == unknown_index
        )
        self.assertTrue(bool(unknown_candidates.any()))
        unknown_location = unknown_candidates.nonzero()[0]
        batch_index, time_index, candidate_index = unknown_location.tolist()
        x, y = torch.floor(
            batch.targets.candidate_xy_heatmap[
                batch_index,
                time_index,
                candidate_index,
            ]
            + 0.5
        ).to(torch.long)
        self.assertGreater(
            float(
                controlled.ball_role_probability[
                    batch_index,
                    time_index,
                    unknown_index,
                    y,
                    x,
                ]
            ),
            0.99,
        )

    def test_half_pixel_coordinate_contract_preserves_source_borders(self) -> None:
        model, batch = self._model_and_batch()
        output = model(batch.inputs)
        source_borders = (
            ((0, 0), (-0.375, -0.375), (0, 0)),
            ((47, 31), (11.375, 7.375), (11, 7)),
        )
        for source_xy, expected_heatmap_xy, expected_anchor in source_borders:
            with self.subTest(source_xy=source_xy):
                heatmap_xy = (
                    source_pixel_center_to_heatmap_coordinate(source_xy[0]),
                    source_pixel_center_to_heatmap_coordinate(source_xy[1]),
                )
                self.assertEqual(heatmap_xy, expected_heatmap_xy)
                candidate_xy = batch.targets.candidate_xy_heatmap.clone()
                candidate_xy[0, 0, 0] = torch.tensor(heatmap_xy)
                heatmap_target = batch.targets.heatmap_target.clone()
                heatmap_target[0, 0] = 0.0
                heatmap_target[
                    0,
                    0,
                    0,
                    expected_anchor[1],
                    expected_anchor[0],
                ] = 1.0
                border_targets = replace(
                    batch.targets,
                    candidate_xy_heatmap=candidate_xy,
                    heatmap_target=heatmap_target,
                )
                loss = CausalBallMultiTaskLoss()(output, border_targets)
                self.assertTrue(bool(torch.isfinite(loss.total)))

        outside = batch.targets.candidate_xy_heatmap.clone()
        outside[0, 0, 0, 0] = output.heatmap_logits.shape[-1] - 0.5
        with self.assertRaisesRegex(ValueError, "center x is outside"):
            CausalBallMultiTaskLoss()(
                output,
                replace(batch.targets, candidate_xy_heatmap=outside),
            )

    def test_focal_balance_does_not_scale_with_background_grid_area(self) -> None:
        small_logits = torch.zeros((1, 1, 8, 12))
        small_target = torch.zeros_like(small_logits)
        small_target[0, 0, 3, 5] = 1.0
        large_logits = torch.zeros((1, 1, 16, 24))
        large_target = torch.zeros_like(large_logits)
        large_target[0, 0, 7, 11] = 1.0
        small_loss = ball_model_module._positive_balanced_focal_heatmap_loss(
            small_logits,
            small_target,
            alpha=0.75,
            gamma=2.0,
        )
        large_loss = ball_model_module._positive_balanced_focal_heatmap_loss(
            large_logits,
            large_target,
            alpha=0.75,
            gamma=2.0,
        )
        self.assertTrue(torch.allclose(small_loss, large_loss, atol=1e-7))

    def test_huge_finite_outputs_fail_closed_only_when_supervised_loss_overflows(self) -> None:
        model, batch = self._model_and_batch()
        output = model(batch.inputs)
        huge_heatmap = output.heatmap_logits * 0.0 + 3e38
        huge_visibility = output.match_visibility_logits * 0.0 + 3e38
        huge_roles = output.ball_role_logits * 0.0 + 3e38
        huge_output = replace(
            output,
            heatmap_logits=huge_heatmap,
            match_visibility_logits=huge_visibility,
            ball_role_logits=huge_roles,
        )
        self.assertTrue(bool(torch.isfinite(huge_heatmap).all()))

        no_frame_supervision = torch.zeros_like(batch.targets.heatmap_mask)
        no_candidate_supervision = torch.zeros_like(batch.targets.candidate_mask)
        unsupervised = replace(
            batch.targets,
            heatmap_mask=no_frame_supervision,
            match_visibility_mask=no_frame_supervision,
            candidate_mask=no_candidate_supervision,
            candidate_role_mask=no_candidate_supervision,
            candidate_blur_axis_mask=no_candidate_supervision,
            candidate_blur_extent_mask=no_candidate_supervision,
        )
        zero_loss = CausalBallMultiTaskLoss()(huge_output, unsupervised)
        for field_name in (
            "total",
            "heatmap",
            "match_visibility",
            "role",
            "blur_axis",
            "blur_extent",
            "center_uncertainty_nll",
        ):
            scalar = getattr(zero_loss, field_name)
            self.assertTrue(bool(torch.isfinite(scalar)), field_name)
            self.assertEqual(float(scalar.detach()), 0.0, field_name)
        zero_loss.total.backward()

        supervised_overflow = replace(output, heatmap_logits=huge_heatmap)
        with self.assertRaisesRegex(ValueError, "non-finite loss component or total"):
            CausalBallMultiTaskLoss()(supervised_overflow, batch.targets)

    def test_nonlocalizable_candidate_cannot_enable_coordinate_supervision(self) -> None:
        model, batch = self._model_and_batch()
        output = model(batch.inputs)
        candidate_visibility = batch.targets.candidate_visibility_index.clone()
        candidate_visibility[0, 0, 0] = VISIBILITY_INDEX[BallVisibility.NOT_PRESENT]
        invalid_targets = replace(
            batch.targets,
            candidate_visibility_index=candidate_visibility,
        )

        with self.assertRaisesRegex(ValueError, "coordinate supervision requires"):
            CausalBallMultiTaskLoss()(output, invalid_targets)

    def test_candidate_enumeration_and_match_identity_fail_closed(self) -> None:
        model, batch = self._model_and_batch()
        output = model(batch.inputs)

        missing_match_role = batch.targets.candidate_role_index.clone()
        missing_match_role[0, 0, 0] = ROLE_INDEX[BallRole.SPARE_BALL]
        with self.assertRaisesRegex(ValueError, "requires one match-ball candidate"):
            CausalBallMultiTaskLoss()(
                output,
                replace(
                    batch.targets,
                    candidate_role_index=missing_match_role,
                ),
            )

        empty_frame = (~batch.targets.candidate_mask.any(dim=-1)).nonzero()[0]
        changed_heatmap = batch.targets.heatmap_target.clone()
        changed_heatmap[empty_frame[0], empty_frame[1], 0, 0, 0] = 1.0
        with self.assertRaisesRegex(ValueError, "must be exactly zero"):
            CausalBallMultiTaskLoss()(
                output,
                replace(batch.targets, heatmap_target=changed_heatmap),
            )

        collided_xy = batch.targets.candidate_xy_heatmap.clone()
        collided_xy[0, 1, 1] = collided_xy[0, 1, 0]
        with self.assertRaisesRegex(ValueError, "share one heatmap anchor"):
            CausalBallMultiTaskLoss()(
                output,
                replace(batch.targets, candidate_xy_heatmap=collided_xy),
            )

    def test_capture_unknown_is_structural_and_cannot_supervise_a_head(self) -> None:
        self.assertNotIn(BallVisibility.CAPTURE_UNKNOWN, VISIBILITY_STATES)
        model, batch = self._model_and_batch()
        valid_frame_mask = batch.inputs.valid_frame_mask.clone()
        valid_frame_mask[0, -1] = False
        output = model(
            CausalBallInput(
                frames=batch.inputs.frames,
                valid_frame_mask=valid_frame_mask,
            )
        )
        with self.assertRaisesRegex(ValueError, "invalid frame"):
            CausalBallMultiTaskLoss()(output, batch.targets)

    def test_inactive_candidate_placeholders_do_not_change_loss(self) -> None:
        model, batch = self._model_and_batch()
        output = model(batch.inputs)
        loss_function = CausalBallMultiTaskLoss()
        original = loss_function(output, batch.targets)

        inactive = ~batch.targets.candidate_mask
        changed_xy = batch.targets.candidate_xy_heatmap.clone()
        changed_xy[inactive] = torch.tensor((0.0, 0.0))
        changed_roles = batch.targets.candidate_role_index.clone()
        changed_roles[inactive] = ROLE_INDEX[BallRole.MATCH_BALL]
        changed_visibility = batch.targets.candidate_visibility_index.clone()
        changed_visibility[inactive] = VISIBILITY_INDEX[BallVisibility.NOT_PRESENT]
        changed = replace(
            batch.targets,
            candidate_xy_heatmap=changed_xy,
            candidate_role_index=changed_roles,
            candidate_visibility_index=changed_visibility,
        )
        alternative = loss_function(output, changed)

        for field_name in (
            "total",
            "heatmap",
            "match_visibility",
            "role",
            "blur_axis",
            "blur_extent",
            "center_uncertainty_nll",
        ):
            self.assertTrue(
                torch.equal(getattr(original, field_name), getattr(alternative, field_name)),
                field_name,
            )

    def test_synthetic_generator_is_deterministic_and_has_dense_negatives(self) -> None:
        first = make_synthetic_ball_batch(self.synthetic_config)
        second = make_synthetic_ball_batch(self.synthetic_config)
        for field_name in ("frames", "valid_frame_mask"):
            self.assertTrue(
                torch.equal(
                    getattr(first.inputs, field_name),
                    getattr(second.inputs, field_name),
                )
            )
        for item in fields(first.targets):
            self.assertTrue(
                torch.allclose(
                    getattr(first.targets, item.name),
                    getattr(second.targets, item.name),
                    equal_nan=True,
                ),
                item.name,
            )
        self.assertGreater(int(first.targets.candidate_blur_axis_mask.sum()), 0)
        self.assertTrue(bool((~first.targets.candidate_mask).any()))
        empty_frames = ~first.targets.candidate_mask.any(dim=-1)
        self.assertTrue(bool(empty_frames.any()))
        self.assertTrue(
            bool((first.targets.heatmap_target[empty_frames] == 0).all())
        )

    def test_synthetic_boundary_configurations_generate_valid_targets(self) -> None:
        boundary_configs = (
            SyntheticBallSequenceConfig(
                batch_size=1,
                frames=2,
                height=16,
                width=16,
                candidate_slots=2,
            ),
            SyntheticBallSequenceConfig(
                batch_size=16,
                frames=32,
                height=16,
                width=16,
                candidate_slots=16,
            ),
            SyntheticBallSequenceConfig(
                batch_size=1,
                frames=2,
                height=512,
                width=512,
                candidate_slots=2,
            ),
        )
        for synthetic_config in boundary_configs:
            with self.subTest(config=synthetic_config):
                batch = make_synthetic_ball_batch(synthetic_config)
                input_pixels = (
                    synthetic_config.batch_size
                    * synthetic_config.frames
                    * synthetic_config.height
                    * synthetic_config.width
                )
                model_config = CausalBallModelConfig(
                    spatial_channels=8,
                    temporal_channels=8,
                    residual_blocks=1,
                    max_batch_size=synthetic_config.batch_size,
                    max_frames=synthetic_config.frames,
                    max_height=synthetic_config.height,
                    max_width=synthetic_config.width,
                    max_total_input_pixels=max(4096, input_pixels),
                )
                output = CausalBallPerceptionModel(model_config)(batch.inputs)
                batch.targets.validate(output)

        with self.assertRaisesRegex(ValueError, "aggregate pixel bound"):
            SyntheticBallSequenceConfig(
                batch_size=16,
                frames=32,
                height=512,
                width=512,
            )

    def test_input_config_and_focal_bounds_fail_closed(self) -> None:
        with self.assertRaisesRegex(ValueError, "heatmap_stride is fixed"):
            CausalBallModelConfig(heatmap_stride=8)
        with self.assertRaisesRegex(ValueError, "less than 1"):
            CausalBallLossConfig(heatmap_focal_alpha=1.0)
        with self.assertRaisesRegex(ValueError, "activation budget"):
            CausalBallModelConfig(
                spatial_channels=256,
                temporal_channels=256,
                max_total_input_pixels=16_777_216,
            )
        model, batch = self._model_and_batch()
        wrong_channels = CausalBallInput(
            frames=batch.inputs.frames[:, :, :2],
            valid_frame_mask=batch.inputs.valid_frame_mask,
        )
        with self.assertRaisesRegex(ValueError, "three RGB"):
            model(wrong_channels)
        non_finite_frames = batch.inputs.frames.clone()
        non_finite_frames[0, 0, 0, 0, 0] = math.nan
        with self.assertRaisesRegex(ValueError, "finite"):
            model(
                CausalBallInput(
                    frames=non_finite_frames,
                    valid_frame_mask=batch.inputs.valid_frame_mask,
                )
            )


if __name__ == "__main__":
    unittest.main()
