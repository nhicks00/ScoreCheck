from __future__ import annotations

from dataclasses import replace
import hashlib
import inspect
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import vision_scoring.training_protected_configuration as protected_configuration
from vision_scoring.annotation_trust import AnnotationMinimumTruthPolicy
from vision_scoring.contract_wire import CanonicalWireError, MAX_SIGNED_64
from vision_scoring.protected_file import (
    PROTECTED_FILE_CHANGED,
    PROTECTED_FILE_INPUT,
    PROTECTED_FILE_SHAPE,
    ProtectedFileError,
    read_protected_file_bytes,
)
from vision_scoring.training_admission_contracts import MAX_TRAINING_EXAMPLES
from vision_scoring.training_protected_configuration import (
    DECODER_RUNTIME_PINS_DOMAIN,
    LABEL_BUNDLE_CURRENT_PIN_DOMAIN,
    LABEL_BUNDLE_CURRENT_PIN_SET_DOMAIN,
    MAX_DECODER_RUNTIME_PINS_BYTES,
    MAX_LABEL_BUNDLE_CURRENT_PIN_SET_BYTES,
    MAX_PROTECTED_TRAINING_CONFIGURATION_BYTES,
    PROTECTED_TRAINING_CONFIGURATION_GENERATION_DOMAIN,
    DecoderRuntimePinsV1,
    LabelBundleCurrentPinSetV1,
    LabelBundleCurrentPinV1,
    ProtectedTrainingConfigurationGenerationV1,
    TrainingProtectedConfigurationError,
    load_decoder_runtime_pins_v1,
    load_label_bundle_current_pin_set_v1,
    load_protected_training_configuration_generation_v1,
)


def _digest(value: int) -> str:
    return f"{value:064x}"


def _canonical(value: object) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=True,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    ).encode("ascii")


def _decoder_pins() -> DecoderRuntimePinsV1:
    return DecoderRuntimePinsV1(
        decoder_runtime_generation_id=_digest(1),
        decoder_runtime_manifest_sha256=_digest(2),
        platform="macos",
        architecture="arm64",
        abi="macos-26.0-arm64",
        system_runtime_id="macos-system-runtime-v1",
        system_runtime_measurement_sha256=_digest(3),
    )


def _label_pin(index: int) -> LabelBundleCurrentPinV1:
    start = 10_000 + index * 10
    return LabelBundleCurrentPinV1(
        source_id=f"source-{index:04d}",
        label_pack_generation_id=_digest(start),
        label_pack_sha256=_digest(start + 1),
        bundle_id=f"bundle-{index:04d}",
        curator_trust_snapshot_sha256=_digest(start + 2),
        curator_trust_snapshot_generation=index,
        curator_attestation_sha256=_digest(start + 3),
        curator_id="dataset-curator-v1",
        trust_domain_id="label-curation-domain-v1",
    )


def _pin_set(count: int = 2) -> LabelBundleCurrentPinSetV1:
    return LabelBundleCurrentPinSetV1(
        pins=tuple(_label_pin(index) for index in range(count))
    )


def _protected_configuration() -> ProtectedTrainingConfigurationGenerationV1:
    return ProtectedTrainingConfigurationGenerationV1(
        readiness_configuration_generation_sha256=_digest(101),
        training_admission_policy_sha256=_digest(102),
        annotation_configuration_generation_sha256=_digest(103),
        label_bundle_current_pin_set_sha256=_pin_set().fingerprint(),
        decoder_runtime_pins_sha256=_decoder_pins().fingerprint(),
        coordinator_source_tree_sha256=_digest(106),
        coordinator_deployment_artifact_sha256=_digest(107),
        trainer_source_tree_sha256=_digest(108),
        environment_lock_sha256=_digest(109),
        requested_truth_policy=(
            AnnotationMinimumTruthPolicy.REVIEWED_OR_ADJUDICATED
        ),
        governance_domain_id="training-governance-v1",
    )


def _sorted_pins(
    *pins: LabelBundleCurrentPinV1,
) -> tuple[LabelBundleCurrentPinV1, ...]:
    return tuple(sorted(pins, key=lambda pin: pin.canonical_sort_key))


class TrainingProtectedConfigurationTests(unittest.TestCase):
    def assert_round_trip(self, value: object, parser: object) -> None:
        raw = value.to_json_bytes()  # type: ignore[attr-defined]
        parsed = parser(raw)  # type: ignore[operator]
        self.assertEqual(parsed, value)
        self.assertEqual(parsed.to_json_bytes(), raw)
        self.assertEqual(parsed.fingerprint(), hashlib.sha256(raw).hexdigest())
        self.assertEqual(raw, _canonical(value.to_dict()))  # type: ignore[attr-defined]

    def test_decoder_runtime_pins_round_trip_and_match_runtime_api_names(self) -> None:
        pins = _decoder_pins()
        self.assert_round_trip(pins, DecoderRuntimePinsV1.from_json_bytes)
        self.assertEqual(
            set(pins.to_dict()),
            {
                "abi",
                "architecture",
                "decoder_runtime_generation_id",
                "decoder_runtime_manifest_sha256",
                "domain",
                "platform",
                "schema_version",
                "system_runtime_id",
                "system_runtime_measurement_sha256",
            },
        )
        self.assertEqual(pins.to_dict()["domain"], DECODER_RUNTIME_PINS_DOMAIN)
        self.assertNotEqual(
            pins.fingerprint(),
            replace(pins, architecture="arm64e").fingerprint(),
        )

    def test_decoder_runtime_pins_reject_exact_type_and_digest_alias_errors(
        self,
    ) -> None:
        pins = _decoder_pins()
        for field_name in (
            "decoder_runtime_manifest_sha256",
            "system_runtime_measurement_sha256",
        ):
            with self.subTest(field_name=field_name):
                with self.assertRaisesRegex(ValueError, "must not alias"):
                    replace(
                        pins,
                        **{field_name: pins.decoder_runtime_generation_id},
                    )
        for field_name, value in (
            ("decoder_runtime_generation_id", "A" * 64),
            ("platform", ""),
            ("architecture", object()),
            ("abi", "contains space"),
            ("system_runtime_id", True),
        ):
            with self.subTest(field_name=field_name):
                with self.assertRaises(ValueError):
                    replace(pins, **{field_name: value})

        class StringSubclass(str):
            pass

        with self.assertRaises(ValueError):
            replace(pins, schema_version=StringSubclass("1.0"))

    def test_label_pin_round_trip_integer_bounds_and_digest_roles(self) -> None:
        pin = _label_pin(1)
        self.assert_round_trip(pin, LabelBundleCurrentPinV1.from_json_bytes)
        self.assertEqual(pin.to_dict()["domain"], LABEL_BUNDLE_CURRENT_PIN_DOMAIN)
        self.assertEqual(pin.curator_trust_snapshot_generation, 1)
        replace(pin, curator_trust_snapshot_generation=0)
        replace(pin, curator_trust_snapshot_generation=MAX_SIGNED_64)
        for invalid in (-1, MAX_SIGNED_64 + 1, True, 1.0, "1"):
            with self.subTest(invalid=invalid):
                with self.assertRaises(ValueError):
                    replace(pin, curator_trust_snapshot_generation=invalid)
        for field_name in (
            "label_pack_sha256",
            "curator_trust_snapshot_sha256",
            "curator_attestation_sha256",
        ):
            with self.subTest(field_name=field_name):
                with self.assertRaisesRegex(ValueError, "must not alias"):
                    replace(
                        pin,
                        **{field_name: pin.label_pack_generation_id},
                    )
        for field_name in (
            "source_id",
            "bundle_id",
            "curator_id",
            "trust_domain_id",
        ):
            with self.subTest(field_name=field_name):
                with self.assertRaises(ValueError):
                    replace(pin, **{field_name: "not stable"})

    def test_label_pin_set_round_trip_canonical_order_and_maximum(self) -> None:
        pins = _pin_set()
        self.assert_round_trip(pins, LabelBundleCurrentPinSetV1.from_json_bytes)
        self.assertEqual(
            pins.to_dict()["domain"], LABEL_BUNDLE_CURRENT_PIN_SET_DOMAIN
        )
        maximum = _pin_set(MAX_TRAINING_EXAMPLES)
        self.assertEqual(len(maximum.pins), MAX_TRAINING_EXAMPLES)
        self.assertEqual(
            LabelBundleCurrentPinSetV1.from_json_bytes(maximum.to_json_bytes()),
            maximum,
        )
        self.assertLess(len(maximum.to_json_bytes()), 1024 * 1024)

    def test_label_pin_set_rejects_bounds_order_and_wrong_exact_types(self) -> None:
        first = _label_pin(1)
        second = _label_pin(2)
        with self.assertRaises(ValueError):
            LabelBundleCurrentPinSetV1(pins=())
        with self.assertRaises(ValueError):
            LabelBundleCurrentPinSetV1(
                pins=tuple(
                    _label_pin(index)
                    for index in range(MAX_TRAINING_EXAMPLES + 1)
                )
            )
        with self.assertRaisesRegex(ValueError, "canonical"):
            LabelBundleCurrentPinSetV1(pins=(second, first))
        with self.assertRaises(ValueError):
            LabelBundleCurrentPinSetV1(pins=[first])  # type: ignore[arg-type]

        class TupleSubclass(tuple):
            pass

        with self.assertRaises(ValueError):
            LabelBundleCurrentPinSetV1(pins=TupleSubclass((first,)))

        class PinSubclass(LabelBundleCurrentPinV1):
            pass

        subclass = PinSubclass(**{
            name: getattr(first, name)
            for name in (
                "source_id",
                "label_pack_generation_id",
                "label_pack_sha256",
                "bundle_id",
                "curator_trust_snapshot_sha256",
                "curator_trust_snapshot_generation",
                "curator_attestation_sha256",
                "curator_id",
                "trust_domain_id",
                "schema_version",
            )
        })
        with self.assertRaises(ValueError):
            LabelBundleCurrentPinSetV1(pins=(subclass,))

    def test_label_pin_set_rejects_semantic_duplicates_and_cross_role_aliases(
        self,
    ) -> None:
        first = _label_pin(1)
        second = _label_pin(2)
        scenarios = (
            replace(second, source_id=first.source_id),
            replace(
                second,
                label_pack_generation_id=first.label_pack_generation_id,
            ),
            replace(
                second,
                label_pack_generation_id=first.label_pack_generation_id,
                label_pack_sha256=first.label_pack_sha256,
            ),
            replace(second, label_pack_sha256=first.label_pack_sha256),
            replace(second, bundle_id=first.bundle_id),
            replace(
                second,
                curator_trust_snapshot_sha256=(
                    first.curator_trust_snapshot_sha256
                ),
            ),
            replace(
                second,
                curator_attestation_sha256=first.curator_attestation_sha256,
            ),
        )
        for candidate in scenarios:
            with self.subTest(candidate=candidate.to_dict()):
                with self.assertRaisesRegex(ValueError, "unique"):
                    LabelBundleCurrentPinSetV1(
                        pins=_sorted_pins(first, candidate)
                    )

        cross_role = replace(
            second,
            label_pack_generation_id=first.curator_trust_snapshot_sha256,
        )
        with self.assertRaisesRegex(ValueError, "must not alias"):
            LabelBundleCurrentPinSetV1(
                pins=_sorted_pins(first, cross_role)
            )

    def test_protected_generation_round_trip_enum_and_exact_fields(self) -> None:
        generation = _protected_configuration()
        self.assert_round_trip(
            generation,
            ProtectedTrainingConfigurationGenerationV1.from_json_bytes,
        )
        self.assertEqual(
            generation.to_dict()["domain"],
            PROTECTED_TRAINING_CONFIGURATION_GENERATION_DOMAIN,
        )
        self.assertIs(
            generation.requested_truth_policy,
            AnnotationMinimumTruthPolicy.REVIEWED_OR_ADJUDICATED,
        )
        adjudicated = replace(
            generation,
            requested_truth_policy=AnnotationMinimumTruthPolicy.ADJUDICATED_ONLY,
        )
        self.assertEqual(
            ProtectedTrainingConfigurationGenerationV1.from_json_bytes(
                adjudicated.to_json_bytes()
            ),
            adjudicated,
        )
        self.assertEqual(
            set(generation.to_dict()),
            {
                "annotation_configuration_generation_sha256",
                "coordinator_deployment_artifact_sha256",
                "coordinator_source_tree_sha256",
                "decoder_runtime_pins_sha256",
                "domain",
                "environment_lock_sha256",
                "governance_domain_id",
                "label_bundle_current_pin_set_sha256",
                "readiness_configuration_generation_sha256",
                "requested_truth_policy",
                "schema_version",
                "trainer_source_tree_sha256",
                "training_admission_policy_sha256",
            },
        )

    def test_protected_generation_rejects_every_digest_alias_and_wrong_enum(
        self,
    ) -> None:
        generation = _protected_configuration()
        digest_fields = (
            "readiness_configuration_generation_sha256",
            "training_admission_policy_sha256",
            "annotation_configuration_generation_sha256",
            "label_bundle_current_pin_set_sha256",
            "decoder_runtime_pins_sha256",
            "coordinator_source_tree_sha256",
            "coordinator_deployment_artifact_sha256",
            "trainer_source_tree_sha256",
            "environment_lock_sha256",
        )
        for field_name in digest_fields[1:]:
            with self.subTest(field_name=field_name):
                with self.assertRaisesRegex(ValueError, "must not alias"):
                    replace(
                        generation,
                        **{
                            field_name: (
                                generation.readiness_configuration_generation_sha256
                            )
                        },
                    )
        for invalid in (
            AnnotationMinimumTruthPolicy.REVIEWED_OR_ADJUDICATED.value,
            object(),
            None,
        ):
            with self.subTest(invalid=invalid):
                with self.assertRaises(ValueError):
                    replace(generation, requested_truth_policy=invalid)
        with self.assertRaises(ValueError):
            replace(generation, governance_domain_id="not stable")

    def test_all_wire_contracts_reject_noncanonical_unknown_missing_and_duplicates(
        self,
    ) -> None:
        values_and_parsers = (
            (_decoder_pins(), DecoderRuntimePinsV1.from_json_bytes),
            (_label_pin(1), LabelBundleCurrentPinV1.from_json_bytes),
            (_pin_set(), LabelBundleCurrentPinSetV1.from_json_bytes),
            (
                _protected_configuration(),
                ProtectedTrainingConfigurationGenerationV1.from_json_bytes,
            ),
        )
        for value, parser in values_and_parsers:
            raw = value.to_json_bytes()
            payload = json.loads(raw)
            field_to_remove = next(key for key in payload if key != "domain")
            missing = dict(payload)
            missing.pop(field_to_remove)
            unknown = {**payload, "unsupported": False}
            wrong_domain = {**payload, "domain": "wrong-domain"}
            duplicate_domain = (
                b'{"domain":'
                + json.dumps(payload["domain"]).encode("ascii")
                + b","
                + raw[1:]
            )
            candidates = (
                json.dumps(payload, indent=2, sort_keys=True).encode("ascii"),
                raw + b"\n",
                _canonical(missing),
                _canonical(unknown),
                _canonical(wrong_domain),
                duplicate_domain,
                b"[]",
                b"\xff",
            )
            for candidate in candidates:
                with self.subTest(
                    contract=type(value).__name__,
                    candidate=candidate[:32],
                ):
                    with self.assertRaises(ValueError):
                        parser(candidate)

    def test_wire_shape_errors_have_stable_contract_codes(self) -> None:
        decoder = json.loads(_decoder_pins().to_json_bytes())
        decoder["platform"] = True
        with self.assertRaises(TrainingProtectedConfigurationError) as caught:
            DecoderRuntimePinsV1.from_json_bytes(_canonical(decoder))
        self.assertEqual(caught.exception.code, "DECODER_RUNTIME_PINS_WIRE")

        pin = json.loads(_label_pin(1).to_json_bytes())
        pin["curator_trust_snapshot_generation"] = True
        with self.assertRaises(TrainingProtectedConfigurationError) as caught:
            LabelBundleCurrentPinV1.from_json_bytes(_canonical(pin))
        self.assertEqual(caught.exception.code, "LABEL_BUNDLE_CURRENT_PIN_WIRE")

        generation = json.loads(_protected_configuration().to_json_bytes())
        generation["requested_truth_policy"] = "UNKNOWN"
        with self.assertRaises(TrainingProtectedConfigurationError) as caught:
            ProtectedTrainingConfigurationGenerationV1.from_json_bytes(
                _canonical(generation)
            )
        self.assertEqual(
            caught.exception.code,
            "PROTECTED_TRAINING_CONFIGURATION_WIRE",
        )

        with self.assertRaises(CanonicalWireError) as caught:
            DecoderRuntimePinsV1.from_json_bytes(
                json.dumps(
                    json.loads(_decoder_pins().to_json_bytes()),
                    indent=2,
                ).encode("ascii")
            )
        self.assertEqual(caught.exception.code, "NONCANONICAL_JSON")

    def test_pin_set_wire_rejects_nested_bytes_fields_and_nonarray_rows(self) -> None:
        payload = json.loads(_pin_set().to_json_bytes())
        payload["pins"][0]["snapshot_bytes"] = "forbidden"
        with self.assertRaises(TrainingProtectedConfigurationError) as caught:
            LabelBundleCurrentPinSetV1.from_json_bytes(_canonical(payload))
        self.assertEqual(
            caught.exception.code,
            "LABEL_BUNDLE_CURRENT_PIN_SET_WIRE",
        )

        payload = json.loads(_pin_set().to_json_bytes())
        payload["pins"] = {}
        with self.assertRaises(TrainingProtectedConfigurationError) as caught:
            LabelBundleCurrentPinSetV1.from_json_bytes(_canonical(payload))
        self.assertEqual(
            caught.exception.code,
            "LABEL_BUNDLE_CURRENT_PIN_SET_WIRE",
        )

    def test_contracts_contain_no_authority_path_clock_secret_or_snapshot_bytes(
        self,
    ) -> None:
        forbidden = (
            b"admissible",
            b"approved",
            b"authority",
            b"capability",
            b"token",
            b"secret",
            b"password",
            b"path",
            b"clock",
            b"verified_at",
            b"not_after",
            b"snapshot_bytes",
        )
        for value in (
            _decoder_pins(),
            _label_pin(1),
            _pin_set(),
            _protected_configuration(),
        ):
            raw = value.to_json_bytes()
            self.assertTrue(all(item not in raw.lower() for item in forbidden))
            self.assertFalse(
                any(type(item) is bool for item in value.to_dict().values())
            )

    def test_protected_loaders_read_exact_caps_and_return_typed_values(self) -> None:
        values = (
            (
                "decoder.json",
                _decoder_pins(),
                load_decoder_runtime_pins_v1,
                MAX_DECODER_RUNTIME_PINS_BYTES,
                "decoder runtime pins",
            ),
            (
                "labels.json",
                _pin_set(),
                load_label_bundle_current_pin_set_v1,
                MAX_LABEL_BUNDLE_CURRENT_PIN_SET_BYTES,
                "label bundle current pin set",
            ),
            (
                "configuration.json",
                _protected_configuration(),
                load_protected_training_configuration_generation_v1,
                MAX_PROTECTED_TRAINING_CONFIGURATION_BYTES,
                "protected training configuration generation",
            ),
        )
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            paths: list[Path] = []
            for filename, value, _, _, _ in values:
                path = root / filename
                path.write_bytes(value.to_json_bytes())
                paths.append(path)

            calls: list[tuple[Path, int, str]] = []

            def recording_reader(
                path: Path,
                *,
                max_bytes: int,
                label: str,
            ) -> bytes:
                calls.append((path, max_bytes, label))
                return read_protected_file_bytes(
                    path,
                    max_bytes=max_bytes,
                    label=label,
                )

            with patch.object(
                protected_configuration,
                "read_protected_file_bytes",
                side_effect=recording_reader,
            ):
                loaded = tuple(
                    loader(path)
                    for path, (_, _, loader, _, _) in zip(
                        paths,
                        values,
                        strict=True,
                    )
                )

        self.assertEqual(
            loaded,
            tuple(value for _, value, _, _, _ in values),
        )
        self.assertEqual(
            calls,
            [
                (path, maximum, label)
                for path, (_, _, _, maximum, label) in zip(
                    paths,
                    values,
                    strict=True,
                )
            ],
        )

    def test_protected_loader_surface_accepts_only_one_path_coordinate(self) -> None:
        loaders = (
            load_decoder_runtime_pins_v1,
            load_label_bundle_current_pin_set_v1,
            load_protected_training_configuration_generation_v1,
        )
        concrete_path_type = type(Path())

        class DerivedPath(concrete_path_type):  # type: ignore[misc, valid-type]
            pass

        for loader in loaders:
            with self.subTest(loader=loader.__name__):
                self.assertEqual(tuple(inspect.signature(loader).parameters), ("path",))
                for invalid in (
                    "pins.json",
                    Path("pins.json"),
                    DerivedPath("pins.json"),
                ):
                    with self.assertRaises(ProtectedFileError) as caught:
                        loader(invalid)  # type: ignore[arg-type]
                    self.assertEqual(caught.exception.code, PROTECTED_FILE_INPUT)

    def test_protected_loaders_reject_noncanonical_and_trailing_bytes(self) -> None:
        values = (
            (_decoder_pins(), load_decoder_runtime_pins_v1),
            (_pin_set(), load_label_bundle_current_pin_set_v1),
            (
                _protected_configuration(),
                load_protected_training_configuration_generation_v1,
            ),
        )
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "pins.json"
            for value, loader in values:
                payload = json.loads(value.to_json_bytes())
                candidates = (
                    value.to_json_bytes() + b"\n",
                    json.dumps(payload, indent=2, sort_keys=True).encode("ascii"),
                )
                for candidate in candidates:
                    path.write_bytes(candidate)
                    with self.subTest(loader=loader.__name__, size=len(candidate)):
                        with self.assertRaises(CanonicalWireError) as caught:
                            loader(path)
                        self.assertEqual(
                            caught.exception.code,
                            "NONCANONICAL_JSON",
                        )

    def test_protected_loaders_reject_symlink_and_hardlink_shapes(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            original = root / "decoder.json"
            original.write_bytes(_decoder_pins().to_json_bytes())

            symlink = root / "decoder-symlink.json"
            symlink.symlink_to(original)
            with self.assertRaises(ProtectedFileError) as caught:
                load_decoder_runtime_pins_v1(symlink)
            self.assertEqual(caught.exception.code, PROTECTED_FILE_SHAPE)

            hardlink = root / "decoder-hardlink.json"
            os.link(original, hardlink)
            with self.assertRaises(ProtectedFileError) as caught:
                load_decoder_runtime_pins_v1(hardlink)
            self.assertEqual(caught.exception.code, PROTECTED_FILE_SHAPE)

    def test_protected_loaders_preserve_reader_race_error(self) -> None:
        failure = ProtectedFileError(
            PROTECTED_FILE_CHANGED,
            "protected file changed during the bounded read",
        )
        for loader in (
            load_decoder_runtime_pins_v1,
            load_label_bundle_current_pin_set_v1,
            load_protected_training_configuration_generation_v1,
        ):
            with self.subTest(loader=loader.__name__):
                with (
                    patch.object(
                        protected_configuration,
                        "read_protected_file_bytes",
                        side_effect=failure,
                    ),
                    self.assertRaises(ProtectedFileError) as caught,
                ):
                    loader(Path("unused.json"))
                self.assertIs(caught.exception, failure)
                self.assertEqual(caught.exception.code, PROTECTED_FILE_CHANGED)

    def test_loader_rechecks_parser_byte_reconstruction(self) -> None:
        original = _decoder_pins()
        changed = replace(original, architecture="arm64e")
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "decoder.json"
            path.write_bytes(original.to_json_bytes())
            with patch.object(
                DecoderRuntimePinsV1,
                "from_json_bytes",
                return_value=changed,
            ):
                with self.assertRaises(
                    TrainingProtectedConfigurationError
                ) as caught:
                    load_decoder_runtime_pins_v1(path)
        self.assertEqual(caught.exception.code, "DECODER_RUNTIME_PINS_WIRE")


if __name__ == "__main__":
    unittest.main()
