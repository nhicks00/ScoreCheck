from __future__ import annotations

from dataclasses import replace
import json
from typing import Any
import unittest

from vision_scoring.capture_profile_contracts import (
    CadenceTypeV1,
    CaptureClassificationAbstentionV1,
    CaptureClassificationStatusV1,
    CaptureProfileClassificationV1,
    CaptureProfileDescriptorV1,
    CaptureRiskTagV1,
    CaptureSourceClassificationV1,
    CaptureTransportV1,
    CodingStructureV1,
    CompressionStratumV1,
    DeviceScopeV1,
    EncoderConfigurationDescriptorV1,
    LensTopologyV1,
    NominalBitrateBasisV1,
    ScanTypeV1,
    SourceCaptureFactsV1,
    SourceRepresentationV1,
    TrainingCaptureModeV1,
    VideoCodecV1,
    ViewTopologyV1,
    avkans_go_owner_live_1080p30_v1,
    classify_capture_profile_v1,
    mevo_core_owner_live_1080p60_v1,
)
from vision_scoring.contract_wire import CanonicalWireError


def _digest(value: int) -> str:
    return f"{value:064x}"


def _encoder(
    *,
    width: int = 1920,
    height: int = 1080,
    cadence_numerator: int | None = None,
    cadence_denominator: int | None = None,
    cadence_type: CadenceTypeV1 = CadenceTypeV1.CFR,
    scan_type: ScanTypeV1 = ScanTypeV1.PROGRESSIVE,
    bitrate: int | None = None,
    coding_structure: CodingStructureV1 = CodingStructureV1.INTERFRAME,
    source_representation: SourceRepresentationV1 = (
        SourceRepresentationV1.LIVE_ENCODER_OUTPUT
    ),
    bitrate_basis: NominalBitrateBasisV1 = NominalBitrateBasisV1.OWNER_DECLARED,
) -> EncoderConfigurationDescriptorV1:
    if cadence_numerator is None:
        cadence_numerator = 30 if cadence_type is CadenceTypeV1.CFR else 0
    if cadence_denominator is None:
        cadence_denominator = 1 if cadence_type is CadenceTypeV1.CFR else 0
    if bitrate is None:
        bitrate = (
            0
            if bitrate_basis is NominalBitrateBasisV1.UNKNOWN
            else 3_000_000
        )
    return EncoderConfigurationDescriptorV1(
        encoder_configuration_id="test-encoder-v1",
        codec=VideoCodecV1.HEVC_H265,
        coding_structure=coding_structure,
        transport=CaptureTransportV1.SRT,
        source_representation=source_representation,
        width_px=width,
        height_px=height,
        scan_type=scan_type,
        cadence_type=cadence_type,
        cadence_numerator=cadence_numerator,
        cadence_denominator=cadence_denominator,
        nominal_bitrate_bps=bitrate,
        nominal_bitrate_basis=bitrate_basis,
        encoder_settings_sha256=_digest(1),
    )


def _profile(
    encoder: EncoderConfigurationDescriptorV1,
    *,
    compression: CompressionStratumV1 = (
        CompressionStratumV1.CONSTRAINED_INTERFRAME
    ),
    lens_topology: LensTopologyV1 = LensTopologyV1.SINGLE_LENS,
    view_topology: ViewTopologyV1 = ViewTopologyV1.SINGLE_VIEW,
    view_count: int = 1,
) -> CaptureProfileDescriptorV1:
    return CaptureProfileDescriptorV1(
        capture_profile_id="test-capture-profile-v1",
        device_scope=DeviceScopeV1.DEVICE_CLASS,
        device_model_or_class="consumer.1080p-camera",
        exact_device_id=None,
        lens_topology=lens_topology,
        view_topology=view_topology,
        view_count=view_count,
        encoder_configuration_sha256=encoder.fingerprint(),
        compression_stratum=compression,
        calibration_sha256=_digest(2),
        clock_model_sha256=_digest(3),
        camera_attestation_sha256=_digest(4),
        exposure_descriptor_sha256=_digest(5),
    )


def _source_facts(
    profile: CaptureProfileDescriptorV1,
    *,
    source_id: str = "test-source-1",
    source_classification: CaptureSourceClassificationV1 = (
        CaptureSourceClassificationV1.OWNER_PRODUCED_LIVE
    ),
    source_complete: bool = True,
    source_risk_tags: tuple[CaptureRiskTagV1, ...] = (),
) -> SourceCaptureFactsV1:
    return SourceCaptureFactsV1(
        source_id=source_id,
        capture_profile_sha256=profile.fingerprint(),
        source_classification=source_classification,
        source_provenance_complete=source_complete,
        source_risk_tags=source_risk_tags,
    )


def _classify_profile(
    encoder: EncoderConfigurationDescriptorV1,
    profile: CaptureProfileDescriptorV1,
    **source_changes: Any,
) -> CaptureProfileClassificationV1:
    return classify_capture_profile_v1(
        encoder,
        profile,
        _source_facts(profile, **source_changes),
    )


def _classify(encoder: EncoderConfigurationDescriptorV1) -> CaptureProfileClassificationV1:
    return _classify_profile(encoder, _profile(encoder))


class ExactModeClassificationTests(unittest.TestCase):
    def test_only_exact_1080_cadences_classify(self) -> None:
        cases = (
            (30, 1, TrainingCaptureModeV1.HD_1080P30),
            (30_000, 1_001, TrainingCaptureModeV1.HD_1080P30),
            (60, 1, TrainingCaptureModeV1.HD_1080P60),
            (60_000, 1_001, TrainingCaptureModeV1.HD_1080P60),
        )
        for numerator, denominator, expected in cases:
            with self.subTest(cadence=(numerator, denominator)):
                receipt = _classify(
                    _encoder(
                        cadence_numerator=numerator,
                        cadence_denominator=denominator,
                    )
                )
                self.assertIs(receipt.status, CaptureClassificationStatusV1.CLASSIFIED)
                self.assertIs(receipt.training_capture_mode, expected)
                self.assertIsNone(receipt.abstention_reason)

    def test_only_exact_4k60_cadences_classify(self) -> None:
        for numerator, denominator in ((60, 1), (60_000, 1_001)):
            receipt = _classify(
                _encoder(
                    width=3840,
                    height=2160,
                    cadence_numerator=numerator,
                    cadence_denominator=denominator,
                )
            )
            self.assertIs(
                receipt.training_capture_mode, TrainingCaptureModeV1.UHD_4K60
            )
        self.assertNotIn("DUAL_4K60", {item.value for item in TrainingCaptureModeV1})

    def test_near_cadence_and_unsupported_geometry_abstain(self) -> None:
        near = _classify(_encoder(cadence_numerator=2997, cadence_denominator=100))
        self.assertIs(
            near.abstention_reason,
            CaptureClassificationAbstentionV1.UNSUPPORTED_CADENCE,
        )
        geometry = _classify(_encoder(width=1918))
        self.assertIs(
            geometry.abstention_reason,
            CaptureClassificationAbstentionV1.UNSUPPORTED_GEOMETRY,
        )

    def test_vfr_unknown_and_interlaced_are_distinct_abstentions(self) -> None:
        cases = (
            (
                {"cadence_type": CadenceTypeV1.VFR},
                CaptureClassificationAbstentionV1.VARIABLE_FRAME_RATE,
            ),
            (
                {"cadence_type": CadenceTypeV1.UNKNOWN},
                CaptureClassificationAbstentionV1.UNKNOWN_CADENCE,
            ),
            (
                {"scan_type": ScanTypeV1.INTERLACED},
                CaptureClassificationAbstentionV1.INTERLACED,
            ),
            (
                {"scan_type": ScanTypeV1.UNKNOWN},
                CaptureClassificationAbstentionV1.UNKNOWN_SCAN,
            ),
        )
        for changes, expected in cases:
            with self.subTest(changes=changes):
                receipt = _classify(_encoder(**changes))
                self.assertIs(receipt.status, CaptureClassificationStatusV1.ABSTAINED)
                self.assertIs(receipt.abstention_reason, expected)
                self.assertIsNone(receipt.training_capture_mode)

    def test_unknown_or_other_codec_explicitly_abstains(self) -> None:
        for codec in (VideoCodecV1.UNKNOWN, VideoCodecV1.OTHER):
            receipt = _classify(replace(_encoder(), codec=codec))
            self.assertIs(
                receipt.abstention_reason,
                CaptureClassificationAbstentionV1.UNSUPPORTED_CODEC,
            )
            self.assertIn(
                CaptureRiskTagV1.COMPATIBILITY_1080P30,
                receipt.capture_risk_tags,
            )

    def test_multi_or_unknown_view_topology_explicitly_abstains(self) -> None:
        encoder = _encoder()
        multi_profile = _profile(
            encoder,
            lens_topology=LensTopologyV1.MULTI_LENS,
            view_topology=ViewTopologyV1.COMPOSITE_MULTI_VIEW,
            view_count=2,
        )
        multi = _classify_profile(encoder, multi_profile)
        self.assertIs(
            multi.abstention_reason,
            CaptureClassificationAbstentionV1.UNSUPPORTED_VIEW_TOPOLOGY,
        )
        self.assertIn(
            CaptureRiskTagV1.MULTI_VIEW_SYNCHRONIZATION,
            multi.capture_risk_tags,
        )
        self.assertIn(
            CaptureRiskTagV1.COMPATIBILITY_1080P30,
            multi.capture_risk_tags,
        )
        with self.assertRaisesRegex(ValueError, "requires view_count=1"):
            _profile(encoder, view_count=2)
        with self.assertRaisesRegex(ValueError, "at least two views"):
            _profile(
                encoder,
                view_topology=ViewTopologyV1.COMPOSITE_MULTI_VIEW,
                view_count=1,
            )
        unknown = _classify_profile(
            encoder,
            _profile(encoder, view_topology=ViewTopologyV1.UNKNOWN),
        )
        self.assertIs(
            unknown.abstention_reason,
            CaptureClassificationAbstentionV1.UNSUPPORTED_VIEW_TOPOLOGY,
        )

    def test_nonreduced_cadence_is_rejected_not_rounded(self) -> None:
        with self.assertRaisesRegex(ValueError, "exact reduced rational"):
            _encoder(cadence_numerator=60_000, cadence_denominator=2_002)

    def test_vfr_unknown_cadence_use_exact_zero_sentinel(self) -> None:
        for cadence_type in (CadenceTypeV1.VFR, CadenceTypeV1.UNKNOWN):
            encoder = _encoder(cadence_type=cadence_type)
            self.assertEqual(
                (encoder.cadence_numerator, encoder.cadence_denominator), (0, 0)
            )
            with self.assertRaisesRegex(ValueError, "\\[0, 0\\]"):
                replace(encoder, cadence_numerator=30, cadence_denominator=1)

    def test_unknown_bitrate_basis_uses_exact_zero_sentinel(self) -> None:
        unknown = _encoder(bitrate_basis=NominalBitrateBasisV1.UNKNOWN)
        self.assertEqual(unknown.nominal_bitrate_bps, 0)
        with self.assertRaisesRegex(ValueError, "\\[0, 0\\]"):
            replace(unknown, nominal_bitrate_bps=1)
        with self.assertRaisesRegex(ValueError, "\\[1"):
            replace(_encoder(), nominal_bitrate_bps=0)


class CompressionAndRiskTests(unittest.TestCase):
    def test_bitrate_changes_do_not_change_either_interframe_stratum(self) -> None:
        for stratum in (
            CompressionStratumV1.CONSTRAINED_INTERFRAME,
            CompressionStratumV1.HIGH_BITRATE_INTERFRAME,
        ):
            receipts = []
            for bitrate in (1_000_000, 50_000_000):
                encoder = _encoder(bitrate=bitrate)
                receipts.append(
                    _classify_profile(
                        encoder, _profile(encoder, compression=stratum)
                    )
                )
            self.assertTrue(
                all(
                    receipt.capture_profile.compression_stratum is stratum
                    for receipt in receipts
                )
            )
            expected_high_compression = (
                stratum is CompressionStratumV1.CONSTRAINED_INTERFRAME
            )
            self.assertTrue(
                all(
                    (
                        CaptureRiskTagV1.HIGH_COMPRESSION
                        in receipt.capture_risk_tags
                    )
                    is expected_high_compression
                    for receipt in receipts
                )
            )

    def test_intra_and_interframe_strata_must_be_consistent(self) -> None:
        intra_encoder = _encoder(coding_structure=CodingStructureV1.INTRA_ONLY)
        with self.assertRaisesRegex(ValueError, "compression_stratum"):
            _classify_profile(intra_encoder, _profile(intra_encoder))
        interframe_encoder = _encoder()
        with self.assertRaisesRegex(ValueError, "compression_stratum"):
            _classify_profile(
                interframe_encoder,
                _profile(
                    interframe_encoder,
                    compression=CompressionStratumV1.LOSSLESS_OR_INTRA,
                ),
            )

    def test_raw_and_prores_coding_structure_is_exact(self) -> None:
        with self.assertRaisesRegex(ValueError, "RAW codec requires LOSSLESS"):
            replace(_encoder(), codec=VideoCodecV1.RAW)
        raw = replace(
            _encoder(coding_structure=CodingStructureV1.LOSSLESS),
            codec=VideoCodecV1.RAW,
        )
        _classify_profile(
            raw,
            _profile(raw, compression=CompressionStratumV1.LOSSLESS_OR_INTRA),
        )
        with self.assertRaisesRegex(ValueError, "PRORES codec requires INTRA_ONLY"):
            replace(_encoder(), codec=VideoCodecV1.PRORES)

    def test_risks_are_exact_structural_union_plus_source_only(self) -> None:
        encoder = _encoder()
        profile = _profile(encoder)
        receipt = _classify_profile(
            encoder,
            profile,
            source_risk_tags=(
                CaptureRiskTagV1.LOW_LIGHT,
                CaptureRiskTagV1.MOTION_BLUR,
            ),
        )
        self.assertEqual(
            receipt.capture_risk_tags,
            tuple(
                sorted(
                    (
                        CaptureRiskTagV1.COMPATIBILITY_1080P30,
                        CaptureRiskTagV1.HIGH_COMPRESSION,
                        CaptureRiskTagV1.LOW_LIGHT,
                        CaptureRiskTagV1.MOTION_BLUR,
                        CaptureRiskTagV1.SINGLE_VIEW_OCCLUSION,
                    ),
                    key=lambda item: item.value,
                )
            ),
        )
        with self.assertRaisesRegex(ValueError, "source_risk_tags"):
            _source_facts(
                profile,
                source_risk_tags=(CaptureRiskTagV1.HIGH_COMPRESSION,),
            )


class SourceAndTemplateTests(unittest.TestCase):
    def test_one_profile_is_reused_across_distinct_bright_and_low_light_sources(
        self,
    ) -> None:
        encoder = _encoder()
        profile = _profile(encoder)
        bright_facts = _source_facts(profile, source_id="bright-recording")
        low_light_facts = _source_facts(
            profile,
            source_id="low-light-recording",
            source_risk_tags=(CaptureRiskTagV1.LOW_LIGHT,),
        )
        bright = classify_capture_profile_v1(encoder, profile, bright_facts)
        low_light = classify_capture_profile_v1(
            encoder, profile, low_light_facts
        )

        self.assertEqual(
            bright.capture_profile.fingerprint(),
            low_light.capture_profile.fingerprint(),
        )
        self.assertNotEqual(
            bright.source_capture_facts.fingerprint(),
            low_light.source_capture_facts.fingerprint(),
        )
        self.assertNotEqual(
            bright.source_classification_proof_set_sha256,
            low_light.source_classification_proof_set_sha256,
        )
        self.assertNotEqual(
            bright.capture_classification_proof_set_sha256,
            low_light.capture_classification_proof_set_sha256,
        )
        self.assertNotIn(CaptureRiskTagV1.LOW_LIGHT, bright.capture_risk_tags)
        self.assertIn(CaptureRiskTagV1.LOW_LIGHT, low_light.capture_risk_tags)
        profile_wire = profile.to_json_bytes().decode("ascii")
        self.assertNotIn("source_classification", profile_wire)
        self.assertNotIn("source_provenance_complete", profile_wire)
        self.assertNotIn("source_risk_tags", profile_wire)

    def test_source_facts_must_bind_the_exact_profile(self) -> None:
        encoder = _encoder()
        profile = _profile(encoder)
        wrong_profile_facts = replace(
            _source_facts(profile),
            capture_profile_sha256=_digest(62),
        )
        with self.assertRaisesRegex(ValueError, "do not bind the capture profile"):
            classify_capture_profile_v1(
                encoder,
                profile,
                wrong_profile_facts,
            )

    def test_source_facts_require_exact_bool_and_canonical_risk_order(self) -> None:
        profile = _profile(_encoder())
        with self.assertRaisesRegex(ValueError, "exact boolean"):
            _source_facts(profile, source_complete=1)
        with self.assertRaisesRegex(ValueError, "canonically sorted"):
            _source_facts(
                profile,
                source_risk_tags=(
                    CaptureRiskTagV1.MOTION_BLUR,
                    CaptureRiskTagV1.LOW_LIGHT,
                ),
            )

    def test_incomplete_provenance_explicitly_abstains(self) -> None:
        encoder = _encoder()
        receipt = _classify_profile(
            encoder, _profile(encoder), source_complete=False
        )
        self.assertIs(
            receipt.abstention_reason,
            CaptureClassificationAbstentionV1.INCOMPLETE_SOURCE_PROVENANCE,
        )
        self.assertIn(
            CaptureRiskTagV1.COMPATIBILITY_1080P30,
            receipt.capture_risk_tags,
        )
        unknown_encoder = _encoder(
            source_representation=SourceRepresentationV1.UNKNOWN,
            bitrate_basis=NominalBitrateBasisV1.UNKNOWN,
        )
        unknown = _classify_profile(
            unknown_encoder, _profile(unknown_encoder)
        )
        self.assertIs(
            unknown.abstention_reason,
            CaptureClassificationAbstentionV1.INCOMPLETE_SOURCE_PROVENANCE,
        )

        mismatched = _classify_profile(
            encoder,
            _profile(encoder),
            source_classification=(
                CaptureSourceClassificationV1.PHONE_OR_CONSUMER_CAMERA
            ),
        )
        self.assertIs(
            mismatched.abstention_reason,
            CaptureClassificationAbstentionV1.INCOMPLETE_SOURCE_PROVENANCE,
        )

    def test_phone_and_archive_facts_classify_without_special_casing(self) -> None:
        phone_encoder = _encoder(
            source_representation=SourceRepresentationV1.PHONE_OR_CONSUMER_CAPTURE
        )
        phone = _classify_profile(
            phone_encoder,
            _profile(phone_encoder),
            source_classification=(
                CaptureSourceClassificationV1.PHONE_OR_CONSUMER_CAMERA
            ),
        )
        self.assertIs(phone.training_capture_mode, TrainingCaptureModeV1.HD_1080P30)

        archive_encoder = _encoder(
            source_representation=SourceRepresentationV1.ORIGINAL_CAMERA_MASTER,
            bitrate_basis=NominalBitrateBasisV1.CONTAINER_METADATA,
        )
        archive = _classify_profile(
            archive_encoder,
            _profile(archive_encoder),
            source_classification=(
                CaptureSourceClassificationV1.OWNER_PRODUCED_ARCHIVE
            ),
        )
        self.assertIs(
            archive.training_capture_mode, TrainingCaptureModeV1.HD_1080P30
        )

    def test_owner_templates_are_exact_and_avkans_invents_no_mapping(self) -> None:
        facts = {
            "source_id": "owner-source-1",
            "encoder_settings_sha256": _digest(1),
            "calibration_sha256": _digest(2),
            "clock_model_sha256": _digest(3),
            "camera_attestation_sha256": _digest(4),
            "exposure_descriptor_sha256": _digest(5),
        }
        with self.assertRaises(TypeError):
            mevo_core_owner_live_1080p60_v1(**facts)
        kwargs = {
            **facts,
            "compression_stratum": (
                CompressionStratumV1.CONSTRAINED_INTERFRAME
            ),
        }
        mevo = mevo_core_owner_live_1080p60_v1(**kwargs)
        self.assertIs(mevo.training_capture_mode, TrainingCaptureModeV1.HD_1080P60)
        self.assertEqual(mevo.encoder_configuration.nominal_bitrate_bps, 6_000_000)
        self.assertIs(mevo.encoder_configuration.codec, VideoCodecV1.AVC_H264)
        self.assertIs(mevo.encoder_configuration.transport, CaptureTransportV1.RTMP)

        avkans = avkans_go_owner_live_1080p30_v1(**kwargs)
        self.assertIs(
            avkans.training_capture_mode, TrainingCaptureModeV1.HD_1080P30
        )
        self.assertEqual(avkans.encoder_configuration.nominal_bitrate_bps, 3_000_000)
        self.assertIs(avkans.encoder_configuration.codec, VideoCodecV1.HEVC_H265)
        self.assertIs(avkans.encoder_configuration.transport, CaptureTransportV1.SRT)
        self.assertIs(avkans.capture_profile.device_scope, DeviceScopeV1.DEVICE_MODEL)
        self.assertIsNone(avkans.capture_profile.exact_device_id)
        wire = avkans.to_json_bytes().decode("ascii").lower()
        self.assertNotIn("mapping", wire)
        self.assertNotIn("physical_device", wire)
        self.assertNotIn("logical_stream", wire)

        high_bitrate_stratum = mevo_core_owner_live_1080p60_v1(
            **{
                **facts,
                "compression_stratum": (
                    CompressionStratumV1.HIGH_BITRATE_INTERFRAME
                ),
            }
        )
        self.assertIs(
            high_bitrate_stratum.capture_profile.compression_stratum,
            CompressionStratumV1.HIGH_BITRATE_INTERFRAME,
        )
        self.assertNotIn(
            CaptureRiskTagV1.HIGH_COMPRESSION,
            high_bitrate_stratum.capture_risk_tags,
        )


class CanonicalWireAndProofTests(unittest.TestCase):
    def test_round_trip_and_proof_sets_are_bound(self) -> None:
        receipt = _classify(_encoder())
        self.assertEqual(
            EncoderConfigurationDescriptorV1.from_json_bytes(
                receipt.encoder_configuration.to_json_bytes()
            ),
            receipt.encoder_configuration,
        )
        self.assertEqual(
            CaptureProfileDescriptorV1.from_json_bytes(
                receipt.capture_profile.to_json_bytes()
            ),
            receipt.capture_profile,
        )
        self.assertEqual(
            SourceCaptureFactsV1.from_json_bytes(
                receipt.source_capture_facts.to_json_bytes()
            ),
            receipt.source_capture_facts,
        )
        self.assertEqual(
            CaptureProfileClassificationV1.from_json_bytes(
                receipt.to_json_bytes()
            ),
            receipt,
        )
        tampered = receipt.to_dict()
        tampered["source_classification_proof_set_sha256"] = _digest(63)
        raw = json.dumps(tampered, sort_keys=True, separators=(",", ":")).encode()
        with self.assertRaisesRegex(ValueError, "proof-set hash"):
            CaptureProfileClassificationV1.from_json_bytes(raw)

        changed_source = receipt.to_dict()
        changed_source["source_capture_facts"]["source_id"] = "different-source"
        raw = json.dumps(
            changed_source, sort_keys=True, separators=(",", ":")
        ).encode()
        with self.assertRaisesRegex(ValueError, "proof-set hash"):
            CaptureProfileClassificationV1.from_json_bytes(raw)

    def test_unknown_field_bool_and_noncanonical_wire_are_rejected(self) -> None:
        receipt = _classify(_encoder())
        payload = receipt.to_dict()
        payload["unknown"] = 1
        raw = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
        with self.assertRaisesRegex(ValueError, "unsupported unknown"):
            CaptureProfileClassificationV1.from_json_bytes(raw)

        payload = receipt.to_dict()
        payload["admissible_for_training"] = 0
        raw = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
        with self.assertRaisesRegex(ValueError, "exactly false"):
            CaptureProfileClassificationV1.from_json_bytes(raw)

        pretty = json.dumps(receipt.to_dict(), indent=2, sort_keys=True).encode()
        with self.assertRaises(CanonicalWireError) as raised:
            CaptureProfileClassificationV1.from_json_bytes(pretty)
        self.assertEqual(raised.exception.code, "NONCANONICAL_JSON")

    def test_unknown_enum_and_risk_order_are_rejected(self) -> None:
        receipt = _classify(_encoder())
        payload = receipt.to_dict()
        payload["status"] = "MAYBE"
        raw = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
        with self.assertRaisesRegex(ValueError, "unsupported enum"):
            CaptureProfileClassificationV1.from_json_bytes(raw)

        payload = receipt.to_dict()
        payload["capture_risk_tags"] = list(
            reversed(payload["capture_risk_tags"])
        )
        raw = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
        with self.assertRaisesRegex(ValueError, "canonically sorted"):
            CaptureProfileClassificationV1.from_json_bytes(raw)

    def test_typed_digest_aliases_are_rejected(self) -> None:
        encoder = _encoder()
        with self.assertRaisesRegex(ValueError, "digest roles must not alias"):
            replace(
                _profile(encoder),
                clock_model_sha256=_digest(2),
            )

    def test_profile_binding_change_invalidates_classification(self) -> None:
        receipt = _classify(_encoder())
        changed_encoder = replace(
            receipt.encoder_configuration, nominal_bitrate_bps=3_000_001
        )
        with self.assertRaisesRegex(ValueError, "does not bind"):
            classify_capture_profile_v1(
                changed_encoder,
                receipt.capture_profile,
                receipt.source_capture_facts,
            )


if __name__ == "__main__":
    unittest.main()
