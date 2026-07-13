from __future__ import annotations

from dataclasses import replace
import hashlib
import unittest
from unittest.mock import patch

try:
    import torch
except ModuleNotFoundError:  # Base runtime intentionally omits training extras.
    torch = None  # type: ignore[assignment]

from vision_scoring.annotations import BallVisibility, PixelPoint

if torch is not None:
    import vision_scoring.training_target_encoding as target_encoding
    from vision_scoring.training_admission_contracts import (
        TargetTensorDTypeV1,
        TargetTensorFieldV1,
        target_tensor_set_sha256_v1,
    )
    from vision_scoring.training_target_encoding import (
        TrainingTargetEncodingError,
        causal_ball_target_tensor_rows_v1,
        validate_causal_ball_target_tensor_rows_v1,
    )

    if __package__:
        from .test_ball_target_materialization import (
            _ball,
            _bundle,
            _model_config,
        )
    else:
        from test_ball_target_materialization import (  # type: ignore[no-redef]
            _ball,
            _bundle,
            _model_config,
        )

    from vision_scoring.ball_target_materialization import (
        materialize_causal_ball_targets_v1,
    )


@unittest.skipIf(torch is None, "optional training dependency is not installed")
class TrainingTargetEncodingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        assert torch is not None
        torch.set_num_threads(1)

    def setUp(self) -> None:
        assert torch is not None
        annotations = (
            _ball(0, center=PixelPoint(8, 8)),
            _ball(1, visibility=BallVisibility.NOT_PRESENT),
        )
        self.materialized = materialize_causal_ball_targets_v1(
            _bundle(annotations),
            annotations,
            model_config=_model_config(),
        )

    def assert_encoding_error(self, code: str, callback: object) -> None:
        assert callable(callback)
        with self.assertRaises(TrainingTargetEncodingError) as caught:
            callback()
        self.assertEqual(caught.exception.code, code)

    def test_rows_are_exact_ordered_deterministic_and_pinned(self) -> None:
        first = causal_ball_target_tensor_rows_v1(self.materialized)
        second = causal_ball_target_tensor_rows_v1(self.materialized)
        self.assertEqual(first, second)
        self.assertEqual(
            tuple(row.field for row in first),
            tuple(TargetTensorFieldV1),
        )
        self.assertEqual(
            tuple(row.dtype for row in first),
            (
                TargetTensorDTypeV1.IEEE754_BINARY32_LE,
                TargetTensorDTypeV1.BOOL_U8,
                TargetTensorDTypeV1.SIGNED_INT64_LE,
                TargetTensorDTypeV1.BOOL_U8,
                TargetTensorDTypeV1.IEEE754_BINARY32_LE,
                TargetTensorDTypeV1.SIGNED_INT64_LE,
                TargetTensorDTypeV1.BOOL_U8,
                TargetTensorDTypeV1.SIGNED_INT64_LE,
                TargetTensorDTypeV1.BOOL_U8,
                TargetTensorDTypeV1.IEEE754_BINARY32_LE,
                TargetTensorDTypeV1.IEEE754_BINARY32_LE,
                TargetTensorDTypeV1.BOOL_U8,
                TargetTensorDTypeV1.BOOL_U8,
            ),
        )
        self.assertEqual(
            target_tensor_set_sha256_v1(first),
            "d3a443e8aa12093685d255c08424b6bbec03dbeb257978d1f908c553de44899e",
        )
        self.assertEqual(
            tuple(row.content_sha256 for row in first),
            (
                "38073c9adad292ce163140bb1bc05100b7d56d4a622cda7cdd178eb7ec96c602",
                "9dcf97a184f32623d11a73124ceb99a5709b083721e878a16d78f596718ba7b2",
                "f7548c023e431138b11357593f5cceb9dd35eb0b0a2041f0b1560212eeb6f13e",
                "9dcf97a184f32623d11a73124ceb99a5709b083721e878a16d78f596718ba7b2",
                "0bbce7375b5b2fa98ef813d1eccd7b83645d894d4cd46aa0c2b782dfe75a8f36",
                "a60e30d47249b4b8c280b4b4c3f27ebec287f4e719f40d8f4e378077af798bd7",
                "01d0fabd251fcbbe2b93b4b927b26ad2a1a99077152e45ded1e678afa45dbec5",
                "a60e30d47249b4b8c280b4b4c3f27ebec287f4e719f40d8f4e378077af798bd7",
                "01d0fabd251fcbbe2b93b4b927b26ad2a1a99077152e45ded1e678afa45dbec5",
                "bd0189b8e6e6ab3e87fd07f63087061d591dbe6b524852d5e65e0a74c71c2b5a",
                "4c0d082d340ef2e540aa9ed85a3070a44f3c117811f3fc13d24653d8090f34ed",
                "66687aadf862bd776c8fc18b8e9f8e20089714856ee233b3902a591d0d5f2925",
                "01d0fabd251fcbbe2b93b4b927b26ad2a1a99077152e45ded1e678afa45dbec5",
            ),
        )
        validate_causal_ball_target_tensor_rows_v1(self.materialized, first)

    def test_bool_u8_hash_is_exact_raw_row_major_bytes(self) -> None:
        rows = causal_ball_target_tensor_rows_v1(self.materialized)
        selected = next(
            row for row in rows if row.field is TargetTensorFieldV1.HEATMAP_MASK
        )
        self.assertEqual(selected.shape, (1, 2))
        self.assertEqual(
            selected.content_sha256,
            hashlib.sha256(b"\x01\x01").hexdigest(),
        )

    def test_post_binding_mutation_is_detected(self) -> None:
        rows = causal_ball_target_tensor_rows_v1(self.materialized)
        tensor = self.materialized.targets.heatmap_target
        tensor[0, 0, 0, 0, 0] += torch.tensor(0.125, dtype=torch.float32)
        self.assert_encoding_error(
            "TARGET_ENCODING_MUTATION",
            lambda: validate_causal_ball_target_tensor_rows_v1(
                self.materialized,
                rows,
            ),
        )

    def test_nan_payload_bytes_are_content_significant(self) -> None:
        first = causal_ball_target_tensor_rows_v1(self.materialized)
        tensor = self.materialized.targets.candidate_xy_heatmap
        self.assertTrue(bool(torch.isnan(tensor[0, 0, 1, 0])))
        tensor.view(torch.int32)[0, 0, 1, 0] = 0x7FC00001
        self.assertTrue(bool(torch.isnan(tensor[0, 0, 1, 0])))
        second = causal_ball_target_tensor_rows_v1(self.materialized)
        first_row = next(
            row
            for row in first
            if row.field is TargetTensorFieldV1.CANDIDATE_XY_HEATMAP
        )
        second_row = next(
            row
            for row in second
            if row.field is TargetTensorFieldV1.CANDIDATE_XY_HEATMAP
        )
        self.assertNotEqual(first_row.content_sha256, second_row.content_sha256)

    def test_noncontiguous_lazy_and_gradient_storage_fail_closed(self) -> None:
        targets = self.materialized.targets
        original = targets.candidate_xy_heatmap
        backing = torch.empty(
            (*original.shape[:-1], original.shape[-1] * 2),
            dtype=original.dtype,
        )
        noncontiguous = backing[..., ::2]
        noncontiguous.copy_(original)
        self.assertFalse(noncontiguous.is_contiguous())
        bad_targets = replace(targets, candidate_xy_heatmap=noncontiguous)
        bad_materialized = replace(self.materialized, targets=bad_targets)
        self.assert_encoding_error(
            "TARGET_ENCODING_TENSOR",
            lambda: causal_ball_target_tensor_rows_v1(bad_materialized),
        )

        negative_view_targets = replace(
            targets,
            heatmap_target=torch._neg_view(targets.heatmap_target),
        )
        self.assertTrue(negative_view_targets.heatmap_target.is_neg())
        negative_view_materialized = replace(
            self.materialized,
            targets=negative_view_targets,
        )
        self.assert_encoding_error(
            "TARGET_ENCODING_TENSOR",
            lambda: causal_ball_target_tensor_rows_v1(negative_view_materialized),
        )

        efficient_zero_targets = replace(
            targets,
            heatmap_target=torch._efficientzerotensor(
                targets.heatmap_target.shape,
                dtype=targets.heatmap_target.dtype,
                device="cpu",
            ),
        )
        self.assertTrue(efficient_zero_targets.heatmap_target._is_zerotensor())
        self.assertEqual(efficient_zero_targets.heatmap_target.data_ptr(), 0)
        efficient_zero_materialized = replace(
            self.materialized,
            targets=efficient_zero_targets,
        )
        self.assert_encoding_error(
            "TARGET_ENCODING_TENSOR",
            lambda: causal_ball_target_tensor_rows_v1(efficient_zero_materialized),
        )

        functional_targets = replace(
            targets,
            heatmap_target=torch._to_functional_tensor(targets.heatmap_target),
        )
        self.assertEqual(functional_targets.heatmap_target.data_ptr(), 0)
        functional_materialized = replace(
            self.materialized,
            targets=functional_targets,
        )
        self.assert_encoding_error(
            "TARGET_ENCODING_TENSOR",
            lambda: causal_ball_target_tensor_rows_v1(functional_materialized),
        )

        batched_backing = targets.heatmap_target.unsqueeze(0)
        batched_target = torch._C._functorch._add_batch_dim(
            batched_backing,
            0,
            1,
        )
        self.assertEqual(batched_target.shape, targets.heatmap_target.shape)
        batched_materialized = replace(
            self.materialized,
            targets=replace(targets, heatmap_target=batched_target),
        )
        self.assert_encoding_error(
            "TARGET_ENCODING_TENSOR",
            lambda: causal_ball_target_tensor_rows_v1(batched_materialized),
        )

        undersized_target = targets.heatmap_target.clone()
        undersized_target.untyped_storage().resize_(
            undersized_target.element_size()
        )
        self.assertLess(
            undersized_target.untyped_storage().nbytes(),
            undersized_target.numel() * undersized_target.element_size(),
        )
        undersized_materialized = replace(
            self.materialized,
            targets=replace(targets, heatmap_target=undersized_target),
        )
        self.assert_encoding_error(
            "TARGET_ENCODING_TENSOR",
            lambda: causal_ball_target_tensor_rows_v1(undersized_materialized),
        )

        gradient_targets = replace(
            targets,
            heatmap_target=targets.heatmap_target.clone().requires_grad_(True),
        )
        gradient_materialized = replace(
            self.materialized,
            targets=gradient_targets,
        )
        self.assert_encoding_error(
            "TARGET_ENCODING_TENSOR",
            lambda: causal_ball_target_tensor_rows_v1(gradient_materialized),
        )

    def test_wrong_types_rows_and_platform_fail_closed(self) -> None:
        self.assert_encoding_error(
            "TARGET_ENCODING_INPUT",
            lambda: causal_ball_target_tensor_rows_v1(object()),  # type: ignore[arg-type]
        )
        self.assert_encoding_error(
            "TARGET_ENCODING_INPUT",
            lambda: validate_causal_ball_target_tensor_rows_v1(
                self.materialized,
                [],  # type: ignore[arg-type]
            ),
        )
        with patch.object(target_encoding.sys, "byteorder", "big"):
            self.assert_encoding_error(
                "TARGET_ENCODING_PLATFORM",
                lambda: causal_ball_target_tensor_rows_v1(self.materialized),
            )

    def test_envelope_dtype_and_geometry_mutation_fail_closed(self) -> None:
        wrong_dtype_targets = replace(
            self.materialized.targets,
            match_visibility_index=(
                self.materialized.targets.match_visibility_index.to(torch.int32)
            ),
        )
        object.__setattr__(self.materialized, "targets", wrong_dtype_targets)
        self.assert_encoding_error(
            "TARGET_ENCODING_ENVELOPE",
            lambda: causal_ball_target_tensor_rows_v1(self.materialized),
        )


if __name__ == "__main__":
    unittest.main()
