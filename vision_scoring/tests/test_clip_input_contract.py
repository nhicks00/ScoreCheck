from __future__ import annotations

from dataclasses import FrozenInstanceError, replace
import hashlib
import json
import struct
import unittest

try:
    import torch
except ModuleNotFoundError:  # Base runtime intentionally omits training extras.
    torch = None  # type: ignore[assignment]

from vision_scoring.contract_wire import CanonicalWireError, MAX_SIGNED_64
from vision_scoring.label_bundle import LabelBundleSplit

if torch is not None:
    from vision_scoring.ball_model import CausalBallInput
    from vision_scoring.clip_input_contract import (
        CAUSAL_BALL_CLIP_INPUT_ENCODING_SHA256,
        CLIP_INPUT_ENCODING_DOMAIN,
        CLIP_INPUT_RECEIPT_DOMAIN,
        CLIP_INPUT_SCHEMA_VERSION,
        MAX_CLIP_INPUT_FRAMES,
        MAX_CLIP_INPUT_RECEIPT_BYTES,
        CausalBallClipFrameBindingV1,
        CausalBallClipInputReceiptV1,
        ClipInputContractError,
        EncodedCausalBallClipInputV1,
        LoadedCausalBallClipInputV1,
        causal_ball_clip_input_encoding_descriptor_v1,
        causal_ball_input_tensor_sha256_v1,
        encode_rgb24_causal_ball_clip_input_v1,
        source_pts_to_timestamp_ns_v1,
    )


def _canonical(value: object) -> bytes:
    return json.dumps(
        value,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=True,
        allow_nan=False,
    ).encode("ascii")


@unittest.skipIf(torch is None, "optional training dependency is not installed")
class ClipInputContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        assert torch is not None
        torch.set_num_threads(1)

    def _encoded(
        self,
        *,
        frame_count: int = 1,
        width: int = 16,
        height: int = 16,
    ) -> EncodedCausalBallClipInputV1:
        frame = bytes(range(256)) * 3
        self.assertEqual(len(frame), 16 * 16 * 3)
        if width != 16 or height != 16:
            frame = bytes([17]) * (width * height * 3)
        return encode_rgb24_causal_ball_clip_input_v1(
            tuple(frame for _ in range(frame_count)),
            output_width=width,
            output_height=height,
        )

    def _receipt(
        self,
        encoded: EncodedCausalBallClipInputV1,
        *,
        split: LabelBundleSplit = LabelBundleSplit.TRAIN,
        first_pts: int = 1,
        time_base_numerator: int = 1,
        time_base_denominator: int = 10_000_000,
    ) -> CausalBallClipInputReceiptV1:
        rows = tuple(
            CausalBallClipFrameBindingV1(
                frame_index=index,
                source_pts=first_pts + index,
                timestamp_ns=source_pts_to_timestamp_ns_v1(
                    first_pts + index,
                    source_time_base_numerator=time_base_numerator,
                    source_time_base_denominator=time_base_denominator,
                ),
                decoded_frame_sha256=f"{index + 1:064x}",
                frame_identity_sha256=f"{index + 101:064x}",
            )
            for index in range(encoded.frame_count)
        )
        return CausalBallClipInputReceiptV1(
            label_pack_generation_id="1" * 64,
            label_pack_sha256="2" * 64,
            label_bundle_statement_sha256="3" * 64,
            bundle_id="bundle-clip-v1",
            source_asset_sha256="4" * 64,
            split=split,
            finalized_trace_sha256="5" * 64,
            capture_policy_sha256="6" * 64,
            capture_policy_generation=7,
            artifact_generation_id="7" * 64,
            source_byte_length=8192,
            decoder_runtime_generation_id="8" * 64,
            decoder_runtime_manifest_sha256="9" * 64,
            decoder_runtime_id="ffmpeg-static-v1",
            decoder_recipe_sha256="a" * 64,
            decode_contract_sha256="b" * 64,
            selected_video_stream_index=2,
            source_time_base_numerator=time_base_numerator,
            source_time_base_denominator=time_base_denominator,
            output_width=encoded.output_width,
            output_height=encoded.output_height,
            frame_count=encoded.frame_count,
            frame_bindings=rows,
            input_encoding_sha256=encoded.input_encoding_sha256,
            input_tensor_sha256=encoded.input_tensor_sha256,
        )

    def assert_contract_error(self, code: str, operation: object) -> None:
        self.assertTrue(callable(operation))
        with self.assertRaises(ClipInputContractError) as caught:
            operation()  # type: ignore[operator]
        self.assertEqual(caught.exception.code, code)

    def test_encoding_descriptor_and_digest_are_exact(self) -> None:
        descriptor = causal_ball_clip_input_encoding_descriptor_v1()
        self.assertEqual(descriptor["domain"], CLIP_INPUT_ENCODING_DOMAIN)
        self.assertEqual(descriptor["schema_version"], CLIP_INPUT_SCHEMA_VERSION)
        self.assertEqual(
            hashlib.sha256(_canonical(descriptor)).hexdigest(),
            CAUSAL_BALL_CLIP_INPUT_ENCODING_SHA256,
        )
        self.assertEqual(
            CAUSAL_BALL_CLIP_INPUT_ENCODING_SHA256,
            "e163cd45f875869fe20545ad6304524cc88545d77da4e539413e3f4ad36dfe0c",
        )
        self.assertEqual(descriptor["layout"], "NTCHW_CONTIGUOUS")
        self.assertEqual(
            descriptor["tensor_hash_basis"],
            "SHA256_LITTLE_ENDIAN_FLOAT32_NTCHW_NO_HEADER",
        )
        descriptor["layout"] = "mutated"
        self.assertEqual(
            causal_ball_clip_input_encoding_descriptor_v1()["layout"],
            "NTCHW_CONTIGUOUS",
        )

    def test_all_256_bytes_encode_exact_contiguous_ntchw_and_hash(self) -> None:
        assert torch is not None
        raw = bytes(range(256)) * 3
        encoded = encode_rgb24_causal_ball_clip_input_v1(
            (raw,),
            output_width=16,
            output_height=16,
        )
        model_input = encoded.model_input
        self.assertEqual(model_input.frames.shape, (1, 1, 3, 16, 16))
        self.assertIs(model_input.frames.dtype, torch.float32)
        self.assertEqual(model_input.frames.device.type, "cpu")
        self.assertTrue(model_input.frames.is_contiguous())
        self.assertFalse(model_input.frames.requires_grad)
        self.assertEqual(model_input.valid_frame_mask.shape, (1, 1))
        self.assertIs(model_input.valid_frame_mask.dtype, torch.bool)
        self.assertTrue(bool(model_input.valid_frame_mask.all()))

        actual_hwc = model_input.frames[0, 0].permute(1, 2, 0).reshape(-1)
        expected_hwc = torch.tensor(list(raw), dtype=torch.float32).div(255.0)
        self.assertTrue(torch.equal(actual_hwc, expected_hwc))

        tensor_bytes = bytearray()
        for channel in range(3):
            for pixel in range(16 * 16):
                tensor_bytes.extend(
                    struct.pack("<f", raw[pixel * 3 + channel] / 255.0)
                )
        expected_hash = hashlib.sha256(tensor_bytes).hexdigest()
        self.assertEqual(encoded.input_tensor_sha256, expected_hash)
        self.assertEqual(
            causal_ball_input_tensor_sha256_v1(model_input),
            expected_hash,
        )
        for field_name in (
            "admissible_for_training",
            "admissible_for_evaluation",
            "admissible_for_test",
            "admissible_for_deployment",
            "admissible_for_live_scoring",
        ):
            self.assertFalse(getattr(encoded, field_name))

    def test_multiframe_hash_is_exact_ntchw_not_ncthw(self) -> None:
        first = bytes((1, 2, 3)) * (16 * 16)
        second = bytes((4, 5, 6)) * (16 * 16)
        encoded = encode_rgb24_causal_ball_clip_input_v1(
            (first, second),
            output_width=16,
            output_height=16,
        )

        ntchw_bytes = bytearray()
        for frame in (first, second):
            for channel in range(3):
                for pixel in range(16 * 16):
                    ntchw_bytes.extend(
                        struct.pack("<f", frame[pixel * 3 + channel] / 255.0)
                    )
        ncthw_bytes = bytearray()
        for channel in range(3):
            for frame in (first, second):
                for pixel in range(16 * 16):
                    ncthw_bytes.extend(
                        struct.pack("<f", frame[pixel * 3 + channel] / 255.0)
                    )
        expected = hashlib.sha256(ntchw_bytes).hexdigest()
        self.assertEqual(encoded.input_tensor_sha256, expected)
        self.assertNotEqual(
            encoded.input_tensor_sha256,
            hashlib.sha256(ncthw_bytes).hexdigest(),
        )

    def test_contiguous_nonzero_storage_offset_hashes_only_logical_window(
        self,
    ) -> None:
        assert torch is not None
        encoded = self._encoded()
        original = encoded.model_input.frames
        backing = torch.empty(
            original.numel() + 1,
            dtype=original.dtype,
            device="cpu",
        )
        offset_frames = backing[1:].view(original.shape)
        offset_frames.copy_(original)
        self.assertTrue(offset_frames.is_contiguous())
        self.assertEqual(offset_frames.storage_offset(), 1)
        self.assertEqual(
            causal_ball_input_tensor_sha256_v1(
                CausalBallInput(
                    frames=offset_frames,
                    valid_frame_mask=encoded.model_input.valid_frame_mask,
                )
            ),
            encoded.input_tensor_sha256,
        )

    def test_rgb24_input_shape_and_exact_type_bounds_fail_closed(self) -> None:
        frame = bytes(16 * 16 * 3)
        self.assert_contract_error(
            "CLIP_INPUT_ENCODING_INPUT",
            lambda: encode_rgb24_causal_ball_clip_input_v1(  # type: ignore[arg-type]
                [frame], output_width=16, output_height=16
            ),
        )
        self.assert_contract_error(
            "CLIP_INPUT_ENCODING_INPUT",
            lambda: encode_rgb24_causal_ball_clip_input_v1(
                (bytearray(frame),),  # type: ignore[arg-type]
                output_width=16,
                output_height=16,
            ),
        )
        self.assert_contract_error(
            "CLIP_INPUT_ENCODING_INPUT",
            lambda: encode_rgb24_causal_ball_clip_input_v1(
                (frame[:-1],), output_width=16, output_height=16
            ),
        )
        for width, height in ((15, 16), (16, 15), (18, 16), (16, 18)):
            self.assert_contract_error(
                "CLIP_INPUT_ENCODING_INPUT",
                lambda width=width, height=height: (
                    encode_rgb24_causal_ball_clip_input_v1(
                        (b"",),
                        output_width=width,
                        output_height=height,
                    )
                ),
            )
        self.assert_contract_error(
            "CLIP_INPUT_ENCODING_INPUT",
            lambda: encode_rgb24_causal_ball_clip_input_v1(
                tuple(frame for _ in range(MAX_CLIP_INPUT_FRAMES + 1)),
                output_width=16,
                output_height=16,
            ),
        )
        self.assert_contract_error(
            "CLIP_INPUT_ENCODING_INPUT",
            lambda: encode_rgb24_causal_ball_clip_input_v1(
                (b"", b"", b""),
                output_width=3840,
                output_height=2160,
            ),
        )

    def test_receipt_round_trips_canonical_wire_and_carries_only_join_keys(self) -> None:
        encoded = self._encoded(frame_count=3)
        receipt = self._receipt(encoded, split=LabelBundleSplit.DEV)
        raw = receipt.to_json_bytes()
        restored = CausalBallClipInputReceiptV1.from_json_bytes(raw)
        self.assertEqual(restored, receipt)
        self.assertEqual(restored.to_json_bytes(), raw)
        self.assertEqual(restored.fingerprint(), hashlib.sha256(raw).hexdigest())
        self.assertLess(len(raw), MAX_CLIP_INPUT_RECEIPT_BYTES)
        payload = receipt.to_dict()
        self.assertEqual(payload["domain"], CLIP_INPUT_RECEIPT_DOMAIN)
        for forbidden in (
            "path",
            "filename",
            "match_id",
            "venue_id",
            "camera_setup_id",
            "lighting_condition",
            "compression",
        ):
            self.assertNotIn(forbidden, payload)
        for field_name in (
            "admissible_for_training",
            "admissible_for_evaluation",
            "admissible_for_test",
            "admissible_for_deployment",
            "admissible_for_live_scoring",
        ):
            self.assertIs(payload[field_name], False)

    def test_receipt_strict_wire_rejects_mutations_duplicates_and_size(self) -> None:
        receipt = self._receipt(self._encoded())
        raw = receipt.to_json_bytes()

        payload = json.loads(raw)
        payload["unsupported"] = None
        self.assert_contract_error(
            "CLIP_INPUT_RECEIPT_SHAPE",
            lambda: CausalBallClipInputReceiptV1.from_json_bytes(
                _canonical(payload)
            ),
        )
        payload = json.loads(raw)
        payload.pop("bundle_id")
        self.assert_contract_error(
            "CLIP_INPUT_RECEIPT_SHAPE",
            lambda: CausalBallClipInputReceiptV1.from_json_bytes(
                _canonical(payload)
            ),
        )
        duplicate = (
            b'{"artifact_generation_id":"'
            + b"7" * 64
            + b'",'
            + raw[1:]
        )
        with self.assertRaises(CanonicalWireError) as caught:
            CausalBallClipInputReceiptV1.from_json_bytes(duplicate)
        self.assertEqual(caught.exception.code, "DUPLICATE_JSON_KEY")
        with self.assertRaises(CanonicalWireError) as caught:
            CausalBallClipInputReceiptV1.from_json_bytes(raw + b"\n")
        self.assertEqual(caught.exception.code, "NONCANONICAL_JSON")
        floating = raw.replace(b'"source_byte_length":8192', b'"source_byte_length":8192.0')
        with self.assertRaises(CanonicalWireError) as caught:
            CausalBallClipInputReceiptV1.from_json_bytes(floating)
        self.assertEqual(caught.exception.code, "INVALID_JSON_NUMBER")
        with self.assertRaises(CanonicalWireError) as caught:
            CausalBallClipInputReceiptV1.from_json_bytes(
                b"x" * (MAX_CLIP_INPUT_RECEIPT_BYTES + 1)
            )
        self.assertEqual(caught.exception.code, "JSON_SIZE")

    def test_receipt_rejects_test_and_every_true_admission_flag(self) -> None:
        encoded = self._encoded()
        train = self._receipt(encoded)
        with self.assertRaisesRegex(ValueError, "TRAIN or DEV"):
            replace(train, split=LabelBundleSplit.TEST)
        with self.assertRaisesRegex(ValueError, "fixed V1 encoding"):
            replace(train, input_encoding_sha256="f" * 64)
        for field_name in (
            "admissible_for_training",
            "admissible_for_evaluation",
            "admissible_for_test",
            "admissible_for_deployment",
            "admissible_for_live_scoring",
        ):
            with self.subTest(field_name=field_name):
                with self.assertRaisesRegex(ValueError, "admission flags"):
                    replace(train, **{field_name: True})
                with self.assertRaisesRegex(ValueError, "admission flags"):
                    replace(train, **{field_name: 0})

    def test_receipt_digest_roles_reject_aliases_but_allow_repeated_frame_bytes(self) -> None:
        receipt = self._receipt(self._encoded(frame_count=2))
        first, second = receipt.frame_bindings

        repeated_decoded = replace(
            receipt,
            frame_bindings=(
                first,
                replace(second, decoded_frame_sha256=first.decoded_frame_sha256),
            ),
        )
        self.assertEqual(
            repeated_decoded.frame_bindings[0].decoded_frame_sha256,
            repeated_decoded.frame_bindings[1].decoded_frame_sha256,
        )
        with self.assertRaisesRegex(ValueError, "must be unique"):
            replace(
                receipt,
                frame_bindings=(
                    first,
                    replace(
                        second,
                        frame_identity_sha256=first.frame_identity_sha256,
                    ),
                ),
            )
        with self.assertRaisesRegex(ValueError, "identity and decoded-frame"):
            replace(
                receipt,
                frame_bindings=(
                    first,
                    replace(
                        second,
                        frame_identity_sha256=first.decoded_frame_sha256,
                    ),
                ),
            )
        with self.assertRaisesRegex(ValueError, "top-level typed"):
            replace(
                receipt,
                source_asset_sha256=receipt.label_pack_sha256,
            )
        with self.assertRaisesRegex(ValueError, "frame and top-level"):
            replace(
                receipt,
                frame_bindings=(
                    replace(
                        first,
                        decoded_frame_sha256=receipt.source_asset_sha256,
                    ),
                    second,
                ),
            )

    def test_exact_pts_mapping_preserves_nonzero_origin_and_allows_ns_collision(self) -> None:
        self.assertEqual(
            source_pts_to_timestamp_ns_v1(
                1,
                source_time_base_numerator=1,
                source_time_base_denominator=10_000_000,
            ),
            100,
        )
        encoded = self._encoded(frame_count=2)
        receipt = self._receipt(
            encoded,
            first_pts=0,
            time_base_numerator=1,
            time_base_denominator=2_000_000_000,
        )
        self.assertEqual(
            tuple(row.source_pts for row in receipt.frame_bindings),
            (0, 1),
        )
        self.assertEqual(
            tuple(row.timestamp_ns for row in receipt.frame_bindings),
            (0, 0),
        )

        rows = receipt.frame_bindings
        with self.assertRaisesRegex(ValueError, "strictly increasing"):
            replace(receipt, frame_bindings=(rows[0], replace(rows[1], source_pts=0)))
        with self.assertRaisesRegex(ValueError, "exact preserved-PTS"):
            replace(
                receipt,
                frame_bindings=(rows[0], replace(rows[1], timestamp_ns=1)),
            )
        with self.assertRaisesRegex(ValueError, "reduced positive rational"):
            replace(
                receipt,
                source_time_base_numerator=2,
                source_time_base_denominator=4_000_000_000,
            )
        with self.assertRaisesRegex(ValueError, "outside"):
            source_pts_to_timestamp_ns_v1(
                MAX_SIGNED_64,
                source_time_base_numerator=MAX_SIGNED_64,
                source_time_base_denominator=1,
            )

    def test_loaded_envelope_rebinds_tensor_and_detects_later_mutation(self) -> None:
        encoded = self._encoded()
        receipt = self._receipt(encoded)
        loaded = LoadedCausalBallClipInputV1(
            receipt=receipt,
            model_input=encoded.model_input,
        )
        original_hash = causal_ball_input_tensor_sha256_v1(loaded.model_input)
        self.assertEqual(original_hash, receipt.input_tensor_sha256)
        for field_name in (
            "admissible_for_training",
            "admissible_for_evaluation",
            "admissible_for_test",
            "admissible_for_deployment",
            "admissible_for_live_scoring",
        ):
            self.assertFalse(getattr(loaded, field_name))
        with self.assertRaises(FrozenInstanceError):
            loaded.receipt = receipt  # type: ignore[misc]

        loaded.model_input.frames[0, 0, 0, 0, 0] = 1.0 / 255.0
        self.assertNotEqual(
            causal_ball_input_tensor_sha256_v1(loaded.model_input),
            original_hash,
        )
        with self.assertRaisesRegex(ValueError, "does not bind"):
            loaded.validate_tensor_binding()
        with self.assertRaisesRegex(ValueError, "does not bind"):
            LoadedCausalBallClipInputV1(
                receipt=receipt,
                model_input=loaded.model_input,
            )

    def test_tensor_contract_rejects_mask_dtype_layout_and_metadata_forgery(self) -> None:
        assert torch is not None
        encoded = self._encoded()
        wrong_mask = CausalBallInput(
            frames=encoded.model_input.frames,
            valid_frame_mask=torch.zeros((1, 1), dtype=torch.bool),
        )
        with self.assertRaisesRegex(ValueError, "all true"):
            causal_ball_input_tensor_sha256_v1(wrong_mask)
        wrong_dtype = CausalBallInput(
            frames=encoded.model_input.frames.to(torch.float64),
            valid_frame_mask=encoded.model_input.valid_frame_mask,
        )
        with self.assertRaisesRegex(ValueError, "CPU torch.float32"):
            causal_ball_input_tensor_sha256_v1(wrong_dtype)
        with self.assertRaisesRegex(ValueError, "does not bind"):
            replace(encoded, input_tensor_sha256="f" * 64)
        with self.assertRaisesRegex(ValueError, "shape does not match"):
            replace(encoded, output_width=20)

    def test_tensor_subclasses_cannot_spoof_data_pointer_or_mask_validation(self) -> None:
        assert torch is not None

        class TensorSubclass(torch.Tensor):
            @staticmethod
            def __new__(cls, value: torch.Tensor) -> "TensorSubclass":
                return torch.Tensor._make_subclass(cls, value, False)

            def data_ptr(self) -> int:
                raise AssertionError("subclass data_ptr must never be called")

        encoded = self._encoded()
        forged_frames = TensorSubclass(encoded.model_input.frames)
        with self.assertRaisesRegex(ValueError, "exact five-dimensional"):
            causal_ball_input_tensor_sha256_v1(
                CausalBallInput(
                    frames=forged_frames,
                    valid_frame_mask=encoded.model_input.valid_frame_mask,
                )
            )
        forged_mask = TensorSubclass(encoded.model_input.valid_frame_mask)
        with self.assertRaisesRegex(ValueError, "valid_frame_mask"):
            causal_ball_input_tensor_sha256_v1(
                CausalBallInput(
                    frames=encoded.model_input.frames,
                    valid_frame_mask=forged_mask,
                )
            )

    def test_lazy_storage_less_and_undersized_tensors_fail_before_raw_read(
        self,
    ) -> None:
        assert torch is not None
        encoded = self._encoded()
        frames = encoded.model_input.frames
        mask = encoded.model_input.valid_frame_mask

        batched_frames = torch._C._functorch._add_batch_dim(
            frames.unsqueeze(0),
            0,
            1,
        )
        self.assertEqual(batched_frames.shape, frames.shape)
        undersized_frames = frames.clone()
        undersized_frames.untyped_storage().resize_(
            undersized_frames.element_size()
        )
        self.assertLess(
            undersized_frames.untyped_storage().nbytes(),
            undersized_frames.numel() * undersized_frames.element_size(),
        )
        frame_variants = (
            torch._neg_view(frames),
            torch._efficientzerotensor(
                frames.shape,
                dtype=frames.dtype,
                device="cpu",
            ),
            torch._to_functional_tensor(frames),
            batched_frames,
            undersized_frames,
        )
        for variant in frame_variants:
            with self.subTest(variant_type=type(variant).__name__):
                with self.assertRaisesRegex(ValueError, "frames"):
                    causal_ball_input_tensor_sha256_v1(
                        CausalBallInput(
                            frames=variant,
                            valid_frame_mask=mask,
                        )
                    )

        functional_mask = torch._to_functional_tensor(mask)
        with self.assertRaisesRegex(ValueError, "valid_frame_mask"):
            causal_ball_input_tensor_sha256_v1(
                CausalBallInput(
                    frames=frames,
                    valid_frame_mask=functional_mask,
                )
            )

    def test_every_tensor_value_must_be_an_exact_u8_normalization_codeword(self) -> None:
        invalid_values = (
            0.5,
            struct.unpack("<f", struct.pack("<I", 0x80000000))[0],
            struct.unpack("<f", struct.pack("<I", 0x00000001))[0],
        )
        for value in invalid_values:
            with self.subTest(value_bits=struct.pack("<f", value).hex()):
                encoded = self._encoded()
                encoded.model_input.frames[0, 0, 0, 0, 0] = value
                with self.assertRaisesRegex(ValueError, "U8/255 binary32"):
                    causal_ball_input_tensor_sha256_v1(encoded.model_input)
                with self.assertRaisesRegex(ValueError, "U8/255 binary32"):
                    replace(encoded, input_tensor_sha256="f" * 64)
                receipt = self._receipt(self._encoded())
                with self.assertRaisesRegex(ValueError, "U8/255 binary32"):
                    LoadedCausalBallClipInputV1(
                        receipt=receipt,
                        model_input=encoded.model_input,
                    )


if __name__ == "__main__":
    unittest.main()
