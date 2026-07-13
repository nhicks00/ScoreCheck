from __future__ import annotations

from dataclasses import FrozenInstanceError, replace
import json
import unittest

try:
    import torch
except ModuleNotFoundError:  # Base runtime intentionally omits training extras.
    torch = None  # type: ignore[assignment]

from vision_scoring.contract_wire import CanonicalWireError
from vision_scoring.label_bundle import LabelBundleSplit

if torch is not None:
    from vision_scoring.annotations import BallVisibility, PixelPoint
    from vision_scoring.ball_target_materialization import (
        MaterializedCausalBallTargetsV1,
        materialize_causal_ball_targets_v1,
    )
    from vision_scoring.clip_input_contract import (
        CausalBallClipFrameBindingV1,
        CausalBallClipInputReceiptV1,
        LoadedCausalBallClipInputV1,
        encode_rgb24_causal_ball_clip_input_v1,
        source_pts_to_timestamp_ns_v1,
    )
    from vision_scoring.training_admission_contracts import (
        target_tensor_set_sha256_v1,
    )
    from vision_scoring.training_target_encoding import (
        causal_ball_target_tensor_rows_v1,
    )
    from vision_scoring.training_tensor_binding import (
        DECODED_FRAME_SEQUENCE_DOMAIN,
        FRAME_IDENTITY_SEQUENCE_DOMAIN,
        TrainingTensorBindingError,
        TrainingTensorBindingsV1,
        bind_training_tensors_v1,
        decoded_frame_sequence_sha256_v1,
        frame_identity_sequence_sha256_v1,
    )

    if __package__:
        from .test_ball_target_materialization import (
            CAPTURE_POLICY,
            SOURCE,
            TRACE,
            _ball,
            _bundle,
            _model_config,
        )
    else:
        from test_ball_target_materialization import (  # type: ignore[no-redef]
            CAPTURE_POLICY,
            SOURCE,
            TRACE,
            _ball,
            _bundle,
            _model_config,
        )


def _canonical(value: object) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=True,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    ).encode("ascii")


@unittest.skipIf(torch is None, "optional training dependency is not installed")
class TrainingTensorBindingTests(unittest.TestCase):
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
        self.statement = _bundle(annotations)
        self.materialized = materialize_causal_ball_targets_v1(
            self.statement,
            annotations,
            model_config=_model_config(),
        )
        frames = (
            bytes(index % 256 for index in range(48 * 32 * 3)),
            bytes((index * 7 + 13) % 256 for index in range(48 * 32 * 3)),
        )
        encoded = encode_rgb24_causal_ball_clip_input_v1(
            frames,
            output_width=48,
            output_height=32,
        )
        time_base_numerator = 1
        time_base_denominator = 100_000_000
        frame_bindings = tuple(
            CausalBallClipFrameBindingV1(
                frame_index=index,
                source_pts=10 + index,
                timestamp_ns=source_pts_to_timestamp_ns_v1(
                    10 + index,
                    source_time_base_numerator=time_base_numerator,
                    source_time_base_denominator=time_base_denominator,
                ),
                decoded_frame_sha256=(
                    self.materialized.decoded_frame_sha256s[index]
                ),
                frame_identity_sha256=(
                    self.materialized.frame_identity_sha256s[index]
                ),
            )
            for index in range(2)
        )
        decode_contract = annotations[0].frame.identity.decode_contract
        receipt = CausalBallClipInputReceiptV1(
            label_pack_generation_id="1" * 64,
            label_pack_sha256="2" * 64,
            label_bundle_statement_sha256=self.statement.fingerprint(),
            bundle_id=self.statement.bundle_id,
            source_asset_sha256=SOURCE,
            split=LabelBundleSplit.TRAIN,
            finalized_trace_sha256=TRACE,
            capture_policy_sha256=CAPTURE_POLICY,
            capture_policy_generation=3,
            artifact_generation_id="7" * 64,
            source_byte_length=8192,
            decoder_runtime_generation_id="8" * 64,
            decoder_runtime_manifest_sha256=(
                decode_contract.decoder_artifact_sha256
            ),
            decoder_runtime_id=decode_contract.decoder_build_id,
            decoder_recipe_sha256="9" * 64,
            decode_contract_sha256=decode_contract.fingerprint(),
            selected_video_stream_index=0,
            source_time_base_numerator=time_base_numerator,
            source_time_base_denominator=time_base_denominator,
            output_width=48,
            output_height=32,
            frame_count=2,
            frame_bindings=frame_bindings,
            input_encoding_sha256=encoded.input_encoding_sha256,
            input_tensor_sha256=encoded.input_tensor_sha256,
        )
        self.loaded = LoadedCausalBallClipInputV1(
            receipt=receipt,
            model_input=encoded.model_input,
        )

    def assert_binding_error(self, code: str, callback: object) -> None:
        self.assertTrue(callable(callback))
        with self.assertRaises(TrainingTensorBindingError) as caught:
            callback()  # type: ignore[operator]
        self.assertEqual(caught.exception.code, code)
        self.assertLess(len(str(caught.exception)), 180)

    def test_binding_is_exact_deterministic_canonical_and_non_authorizing(self) -> None:
        first = bind_training_tensors_v1(
            loaded_clip=self.loaded,
            materialized_targets=self.materialized,
        )
        second = bind_training_tensors_v1(
            loaded_clip=self.loaded,
            materialized_targets=self.materialized,
        )
        self.assertEqual(first, second)
        self.assertEqual(
            first.clip_input_receipt_sha256,
            self.loaded.receipt.fingerprint(),
        )
        self.assertEqual(
            first.input_tensor_sha256,
            self.loaded.receipt.input_tensor_sha256,
        )
        self.assertEqual(
            first.target_tensor_rows,
            causal_ball_target_tensor_rows_v1(self.materialized),
        )
        self.assertEqual(
            first.target_tensor_set_sha256,
            target_tensor_set_sha256_v1(first.target_tensor_rows),
        )
        parsed = TrainingTensorBindingsV1.from_json_bytes(first.to_json_bytes())
        self.assertEqual(parsed, first)
        self.assertEqual(parsed.fingerprint(), first.fingerprint())
        first.validate_mutable_bindings(
            loaded_clip=self.loaded,
            materialized_targets=self.materialized,
        )
        for field_name in (
            "admissible_for_training",
            "admissible_for_evaluation",
            "admissible_for_test",
            "admissible_for_deployment",
            "admissible_for_live_scoring",
        ):
            self.assertIs(getattr(first, field_name), False)
        self.assertNotIn(b'"split":"TEST"', first.to_json_bytes())
        with self.assertRaises(FrozenInstanceError):
            first.input_tensor_sha256 = "0" * 64  # type: ignore[misc]

    def test_sequence_commitments_are_ordered_and_domain_separated(self) -> None:
        identities = self.materialized.frame_identity_sha256s
        decoded = self.materialized.decoded_frame_sha256s
        identity_sha256 = frame_identity_sequence_sha256_v1(identities)
        decoded_sha256 = decoded_frame_sequence_sha256_v1(decoded)
        self.assertNotEqual(identity_sha256, decoded_sha256)
        self.assertNotEqual(
            identity_sha256,
            frame_identity_sequence_sha256_v1(tuple(reversed(identities))),
        )
        self.assertNotEqual(
            FRAME_IDENTITY_SEQUENCE_DOMAIN,
            DECODED_FRAME_SEQUENCE_DOMAIN,
        )
        with self.assertRaises(ValueError):
            frame_identity_sequence_sha256_v1(  # type: ignore[arg-type]
                list(identities)
            )
        with self.assertRaises(ValueError):
            decoded_frame_sequence_sha256_v1(())

    def test_every_exact_clip_target_join_mismatch_fails_closed(self) -> None:
        mismatches = (
            replace(self.materialized, source_asset_sha256="0" * 64),
            replace(self.materialized, bundle_id="other-bundle"),
            replace(self.materialized, split=LabelBundleSplit.DEV),
            replace(self.materialized, statement_sha256="0" * 64),
            replace(
                self.materialized,
                frame_identity_sha256s=("0" * 64, "1" * 64),
            ),
            replace(
                self.materialized,
                decoded_frame_sha256s=("2" * 64, "3" * 64),
            ),
        )
        for mismatch in mismatches:
            with self.subTest(field=mismatch):
                self.assert_binding_error(
                    "TENSOR_BINDING_JOIN",
                    lambda mismatch=mismatch: bind_training_tensors_v1(
                        loaded_clip=self.loaded,
                        materialized_targets=mismatch,
                    ),
                )

        assert torch is not None
        changed_targets = replace(
            self.materialized.targets,
            heatmap_target=torch.zeros((1, 2, 1, 9, 12), dtype=torch.float32),
        )
        changed_geometry = replace(self.materialized, targets=changed_targets)
        self.assert_binding_error(
            "TENSOR_BINDING_JOIN",
            lambda: bind_training_tensors_v1(
                loaded_clip=self.loaded,
                materialized_targets=changed_geometry,
            ),
        )

    def test_input_and_target_mutation_fail_at_consumption_boundary(self) -> None:
        binding = bind_training_tensors_v1(
            loaded_clip=self.loaded,
            materialized_targets=self.materialized,
        )
        assert torch is not None
        self.loaded.model_input.frames[0, 0, 0, 0, 0] = 0.5
        self.assert_binding_error(
            "TENSOR_BINDING_MUTATION",
            lambda: binding.validate_mutable_bindings(
                loaded_clip=self.loaded,
                materialized_targets=self.materialized,
            ),
        )

        self.setUp()
        binding = bind_training_tensors_v1(
            loaded_clip=self.loaded,
            materialized_targets=self.materialized,
        )
        self.materialized.targets.heatmap_target[0, 0, 0, 0, 0] = 0.25
        self.assert_binding_error(
            "TENSOR_BINDING_MUTATION",
            lambda: binding.validate_mutable_bindings(
                loaded_clip=self.loaded,
                materialized_targets=self.materialized,
            ),
        )

    def test_initial_binding_rejects_mutated_clip_and_wrong_exact_types(self) -> None:
        assert torch is not None
        self.loaded.model_input.frames[0, 0, 0, 0, 0] = 0.5
        self.assert_binding_error(
            "TENSOR_BINDING_INPUT_MUTATION",
            lambda: bind_training_tensors_v1(
                loaded_clip=self.loaded,
                materialized_targets=self.materialized,
            ),
        )
        self.assert_binding_error(
            "TENSOR_BINDING_INPUT",
            lambda: bind_training_tensors_v1(  # type: ignore[arg-type]
                loaded_clip=object(),
                materialized_targets=self.materialized,
            ),
        )
        self.setUp()
        self.assert_binding_error(
            "TENSOR_BINDING_INPUT",
            lambda: bind_training_tensors_v1(  # type: ignore[arg-type]
                loaded_clip=self.loaded,
                materialized_targets=object(),
            ),
        )

    def test_binding_wire_and_contract_reject_tampering(self) -> None:
        binding = bind_training_tensors_v1(
            loaded_clip=self.loaded,
            materialized_targets=self.materialized,
        )
        payload = binding.to_dict()
        payload["surprise"] = False
        self.assert_binding_error(
            "TENSOR_BINDING_WIRE",
            lambda: TrainingTensorBindingsV1.from_json_bytes(_canonical(payload)),
        )
        with self.assertRaises(CanonicalWireError):
            TrainingTensorBindingsV1.from_json_bytes(
                binding.to_json_bytes().replace(b'"domain"', b' "domain"', 1)
            )
        with self.assertRaises(ValueError):
            replace(binding, admissible_for_training=True)
        with self.assertRaises(ValueError):
            replace(binding, target_tensor_set_sha256="0" * 64)
        with self.assertRaisesRegex(ValueError, "must not alias"):
            replace(
                binding,
                input_tensor_sha256=binding.target_tensor_rows[0].content_sha256,
            )
        with self.assertRaises(ValueError):
            replace(
                binding,
                target_tensor_rows=list(  # type: ignore[arg-type]
                    binding.target_tensor_rows
                ),
            )

        object.__setattr__(binding, "admissible_for_training", True)
        self.assert_binding_error(
            "TENSOR_BINDING_MUTATION",
            lambda: binding.validate_mutable_bindings(
                loaded_clip=self.loaded,
                materialized_targets=self.materialized,
            ),
        )

    def test_binding_does_not_modify_tensor_values(self) -> None:
        assert torch is not None
        input_before = self.loaded.model_input.frames.clone()
        targets_before = tuple(
            getattr(self.materialized.targets, field_name).clone()
            for field_name in self.materialized.targets.__dataclass_fields__
        )
        bind_training_tensors_v1(
            loaded_clip=self.loaded,
            materialized_targets=self.materialized,
        )
        self.assertTrue(torch.equal(input_before, self.loaded.model_input.frames))
        for before, field_name in zip(
            targets_before,
            self.materialized.targets.__dataclass_fields__,
            strict=True,
        ):
            after = getattr(self.materialized.targets, field_name)
            if before.dtype.is_floating_point:
                self.assertTrue(
                    torch.allclose(
                        before,
                        after,
                        rtol=0.0,
                        atol=0.0,
                        equal_nan=True,
                    )
                )
            else:
                self.assertTrue(torch.equal(before, after))


if __name__ == "__main__":
    unittest.main()
