from __future__ import annotations

from contextlib import redirect_stderr, redirect_stdout
from copy import deepcopy
from dataclasses import replace
from datetime import datetime, timezone
import base64
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from vision_scoring.artifact_store import (
    DatasetArtifactSetProof,
    canonical_artifact_set_fingerprint,
)
from vision_scoring.capture_profile_contracts import (
    CadenceTypeV1,
    CaptureRiskTagV1,
    CaptureSourceClassificationV1,
    CaptureTransportV1,
    CompressionStratumV1,
    SourceCaptureFactsV1,
    SourceRepresentationV1,
    avkans_go_owner_live_1080p30_v1,
    classify_capture_profile_v1,
    mevo_core_owner_live_1080p60_v1,
)
from vision_scoring.immutable_store import generation_id_for
from vision_scoring.dataset_split import DatasetSplit as CanonicalDatasetSplit
from vision_scoring.readiness import (
    DatasetSplit as ReadinessDatasetSplit,
    ManifestValidator,
    ReadinessIssue,
    Severity,
    load_manifest,
    main,
    readiness_runtime_identity_sha256,
    readiness_verifier_source_tree_sha256,
)
from vision_scoring.readiness_label_packs import (
    source_label_pack_proof_set_sha256,
    verify_source_label_pack_batch,
)
from vision_scoring.readiness_trust import (
    CurrentDatasetManifest,
    DatasetManifestAttestation,
    ProtectedConfigurationGeneration,
    dataset_manifest_attestation_signing_message,
    canonical_json_bytes,
    canonical_manifest_sha256,
    load_dataset_manifest_attestation,
    load_dataset_trust_store,
    load_protected_configuration_generation,
    load_readiness_verification_policy,
)
from vision_scoring.rights import PermittedUse, rights_decision_from_dict
from vision_scoring.rights_trust import (
    CurrentRightsDecision,
    RightsAttestation,
    attestation_signing_message,
    load_rights_trust_store,
    load_rights_verification_policy,
)


EXAMPLE = Path(__file__).parents[1] / "examples" / "readiness-manifest.json"
TRUST_STORE = Path(__file__).parents[1] / "examples" / "rights-trust-store.json"
VERIFICATION_POLICY = (
    Path(__file__).parents[1] / "examples" / "rights-verification-policy.json"
)
RIGHTS_EVIDENCE_STORE_ROOT = (
    Path(__file__).parents[1] / "examples" / "rights-evidence"
)
DATASET_TRUST_STORE = Path(__file__).parents[1] / "examples" / "dataset-trust-store.json"
DATASET_ATTESTATION = (
    Path(__file__).parents[1] / "examples" / "dataset-manifest-attestation.json"
)
READINESS_POLICY = (
    Path(__file__).parents[1] / "examples" / "readiness-verification-policy.json"
)
PROTECTED_CONFIGURATION_GENERATION = (
    Path(__file__).parents[1]
    / "examples"
    / "protected-configuration-generation.json"
)
ARTIFACT_STORE_ROOT = (
    Path(__file__).parents[1] / "examples" / "dataset-artifacts"
)
LABEL_STORE_ROOT = (
    Path(__file__).parents[1] / "examples" / "ball-label-packs"
)
DEPLOYMENT_ARTIFACT_SHA256 = (
    "b6efd12cebbb91882653219e477b3eff3e90d49f70aa4a77d66d65e57882ca6f"
)
GOVERNANCE_DOMAIN_ID = "example-dataset-governance"
EXAMPLE_PRIVATE_KEY = Ed25519PrivateKey.from_private_bytes(b"\x33" * 32)
EXAMPLE_DATASET_PRIVATE_KEY = Ed25519PrivateKey.from_private_bytes(b"\x44" * 32)


class ReadinessTests(unittest.TestCase):
    def setUp(self) -> None:
        self._configuration_directories: list[tempfile.TemporaryDirectory[str]] = []
        self.manifest = deepcopy(load_manifest(EXAMPLE))
        self.trust_store = load_rights_trust_store(TRUST_STORE)
        self.verification_policy = load_rights_verification_policy(
            VERIFICATION_POLICY
        )
        self.dataset_trust_store = load_dataset_trust_store(DATASET_TRUST_STORE)
        self.dataset_attestation = load_dataset_manifest_attestation(
            DATASET_ATTESTATION
        )
        self.readiness_policy = load_readiness_verification_policy(
            READINESS_POLICY
        )
        self.validator = self._validator_for_manifest(self.manifest)

    def test_verifier_source_manifest_exactly_covers_imported_package_modules(
        self,
    ) -> None:
        probe = """
import json
from pathlib import Path
import sys
import vision_scoring.readiness as readiness

source_root = Path(readiness.__file__).resolve().parent
loaded = sorted(
    {
        Path(module.__file__).name
        for module in sys.modules.values()
        if getattr(module, "__file__", None) is not None
        and Path(module.__file__).resolve().parent == source_root
    }
)
print(json.dumps({"listed": sorted(readiness._VERIFIER_SOURCE_FILES), "loaded": loaded}))
"""
        completed = subprocess.run(
            [sys.executable, "-c", probe],
            check=True,
            capture_output=True,
            text=True,
        )
        result = json.loads(completed.stdout)
        self.assertEqual(result["loaded"], result["listed"])

    def _validator_for_manifest(
        self,
        manifest: dict,
        *,
        rights_store=None,
        rights_policy=None,
        readiness_policy_base=None,
        expected_readiness_policy_sha256=None,
        deployment_artifact_sha256=DEPLOYMENT_ARTIFACT_SHA256,
        governance_domain_id=GOVERNANCE_DOMAIN_ID,
        artifact_store_root=ARTIFACT_STORE_ROOT,
        label_store_root=LABEL_STORE_ROOT,
    ) -> ManifestValidator:
        selected_rights_store = rights_store or self.trust_store
        selected_rights_policy = replace(
            rights_policy or self.verification_policy,
            verifier_source_tree_sha256=readiness_verifier_source_tree_sha256(),
        )
        manifest_sha256 = canonical_manifest_sha256(manifest)
        signature = EXAMPLE_DATASET_PRIVATE_KEY.sign(
            dataset_manifest_attestation_signing_message(
                dataset_id=manifest["dataset_id"],
                manifest_sha256=manifest_sha256,
                curator_id="example-dataset-curator",
                key_id="example-dataset-key-1",
                trust_domain_id=GOVERNANCE_DOMAIN_ID,
                signed_on="2026-07-12",
            )
        )
        attestation = DatasetManifestAttestation(
            dataset_id=manifest["dataset_id"],
            manifest_sha256=manifest_sha256,
            curator_id="example-dataset-curator",
            key_id="example-dataset-key-1",
            trust_domain_id=GOVERNANCE_DOMAIN_ID,
            signed_on="2026-07-12",
            signature_base64=base64.b64encode(signature).decode("ascii"),
        )
        dataset_store = replace(
            self.dataset_trust_store,
            current_manifests=(
                CurrentDatasetManifest(manifest["dataset_id"], manifest_sha256),
            ),
        )
        readiness_policy = replace(
            readiness_policy_base or self.readiness_policy,
            dataset_trust_store_sha256=dataset_store.fingerprint(),
            rights_verification_policy_sha256=selected_rights_policy.fingerprint(),
            verifier_source_tree_sha256=readiness_verifier_source_tree_sha256(),
            runtime_identity_sha256=readiness_runtime_identity_sha256(),
        )
        configuration_generation = ProtectedConfigurationGeneration(
            dataset_trust_store_sha256=dataset_store.fingerprint(),
            dataset_manifest_attestation_sha256=attestation.fingerprint(),
            readiness_verification_policy_sha256=readiness_policy.fingerprint(),
            rights_trust_store_sha256=selected_rights_store.fingerprint(),
            rights_verification_policy_sha256=selected_rights_policy.fingerprint(),
            trusted_launcher_deployment_artifact_sha256=(
                deployment_artifact_sha256
            ),
            governance_domain_id=governance_domain_id,
        )
        configuration_directory = tempfile.TemporaryDirectory()
        self._configuration_directories.append(configuration_directory)
        self.addCleanup(configuration_directory.cleanup)
        configuration_generation_path = (
            Path(configuration_directory.name) / "current-generation.json"
        )
        configuration_generation_path.write_text(
            configuration_generation.canonical_json(),
            encoding="utf-8",
        )
        return ManifestValidator(
            dataset_trust_store=dataset_store,
            dataset_manifest_attestation=attestation,
            readiness_verification_policy=readiness_policy,
            expected_readiness_verification_policy_sha256=(
                readiness_policy.fingerprint()
                if expected_readiness_policy_sha256 is None
                else expected_readiness_policy_sha256
            ),
            trusted_launcher_deployment_artifact_sha256=(
                deployment_artifact_sha256
            ),
            expected_governance_domain_id=governance_domain_id,
            protected_configuration_generation_path=(
                configuration_generation_path
            ),
            artifact_store_root=artifact_store_root,
            label_store_root=label_store_root,
            rights_trust_store=selected_rights_store,
            rights_evidence_store_root=RIGHTS_EVIDENCE_STORE_ROOT,
            rights_verification_policy=selected_rights_policy,
            expected_rights_verification_policy_sha256=(
                selected_rights_policy.fingerprint()
            ),
        )

    def _validate(self, manifest: dict):
        return self._validator_for_manifest(manifest).validate(manifest)

    def _run_cli(
        self,
        manifest: dict,
        *,
        label_store_root: Path = LABEL_STORE_ROOT,
    ) -> tuple[int, dict, str]:
        with tempfile.TemporaryDirectory() as temporary_directory:
            manifest_path = Path(temporary_directory) / "manifest.json"
            manifest_path.write_text(
                json.dumps(manifest, sort_keys=True),
                encoding="utf-8",
            )
            source_tree_sha256 = readiness_verifier_source_tree_sha256()
            rights_policy = replace(
                self.verification_policy,
                verifier_source_tree_sha256=source_tree_sha256,
            )
            readiness_policy = replace(
                self.readiness_policy,
                rights_verification_policy_sha256=rights_policy.fingerprint(),
                verifier_source_tree_sha256=source_tree_sha256,
                runtime_identity_sha256=readiness_runtime_identity_sha256(),
            )
            rights_policy_path = Path(temporary_directory) / "rights-policy.json"
            rights_policy_path.write_text(
                rights_policy.canonical_json(),
                encoding="utf-8",
            )
            readiness_policy_path = (
                Path(temporary_directory) / "readiness-policy.json"
            )
            readiness_policy_path.write_text(
                readiness_policy.canonical_json(),
                encoding="utf-8",
            )
            configuration_generation = ProtectedConfigurationGeneration(
                dataset_trust_store_sha256=self.dataset_trust_store.fingerprint(),
                dataset_manifest_attestation_sha256=(
                    self.dataset_attestation.fingerprint()
                ),
                readiness_verification_policy_sha256=(
                    readiness_policy.fingerprint()
                ),
                rights_trust_store_sha256=self.trust_store.fingerprint(),
                rights_verification_policy_sha256=rights_policy.fingerprint(),
                trusted_launcher_deployment_artifact_sha256=(
                    DEPLOYMENT_ARTIFACT_SHA256
                ),
                governance_domain_id=GOVERNANCE_DOMAIN_ID,
            )
            configuration_generation_path = (
                Path(temporary_directory) / "current-generation.json"
            )
            configuration_generation_path.write_text(
                configuration_generation.canonical_json(),
                encoding="utf-8",
            )
            stdout = io.StringIO()
            stderr = io.StringIO()
            with redirect_stdout(stdout), redirect_stderr(stderr):
                exit_code = main(
                    [
                        str(manifest_path),
                        "--dataset-trust-store",
                        str(DATASET_TRUST_STORE),
                        "--dataset-manifest-attestation",
                        str(DATASET_ATTESTATION),
                        "--readiness-verification-policy",
                        str(readiness_policy_path),
                        "--expected-readiness-verification-policy-sha256",
                        readiness_policy.fingerprint(),
                        "--trusted-launcher-deployment-artifact-sha256",
                        DEPLOYMENT_ARTIFACT_SHA256,
                        "--expected-governance-domain-id",
                        GOVERNANCE_DOMAIN_ID,
                        "--protected-configuration-generation",
                        str(configuration_generation_path),
                        "--artifact-store-root",
                        str(ARTIFACT_STORE_ROOT),
                        "--label-store-root",
                        str(label_store_root),
                        "--rights-trust-store",
                        str(TRUST_STORE),
                        "--rights-verification-policy",
                        str(rights_policy_path),
                        "--expected-rights-verification-policy-sha256",
                        rights_policy.fingerprint(),
                        "--rights-evidence-store-root",
                        str(RIGHTS_EVIDENCE_STORE_ROOT),
                    ]
                )
        return exit_code, json.loads(stdout.getvalue()), stderr.getvalue()

    def _derived_source(
        self,
        asset_character: str,
        *,
        parent_sha256: str,
    ) -> dict:
        root = self.manifest["data_sources"][0]
        derived = deepcopy(root)
        derived.update(
            {
                "source_id": f"derived-{asset_character}",
                "asset_sha256": asset_character * 64,
                "root_asset_sha256": root["root_asset_sha256"],
                "parent_asset_sha256": parent_sha256,
                "labels_sha256": ("a" if asset_character != "a" else "b") * 64,
            }
        )
        return derived

    def _replace_source_rights(self, index: int, decision) -> ManifestValidator:
        source = self.manifest["data_sources"][index]
        signature = EXAMPLE_PRIVATE_KEY.sign(
            attestation_signing_message(
                decision,
                key_id="example-rights-key-1",
                trust_domain_id="example-rights-keyring",
                signed_on="2026-07-11",
            )
        )
        attestation = RightsAttestation(
            decision_sha256=decision.fingerprint(),
            key_id="example-rights-key-1",
            trust_domain_id="example-rights-keyring",
            signed_on="2026-07-11",
            signature_base64=base64.b64encode(signature).decode("ascii"),
        )
        source["rights_decision"] = decision.to_canonical_dict()
        source["rights_decision_sha256"] = decision.fingerprint()
        source["rights_attestation"] = attestation.to_canonical_dict()
        current = tuple(
            CurrentRightsDecision(
                item.asset_sha256,
                (
                    decision.fingerprint()
                    if item.asset_sha256 == decision.asset_sha256
                    else item.decision_sha256
                ),
            )
            for item in self.trust_store.current_decisions
        )
        store = replace(self.trust_store, current_decisions=current)
        policy = replace(
            self.verification_policy,
            trust_store_sha256=store.fingerprint(),
        )
        return self._validator_for_manifest(
            self.manifest,
            rights_store=store,
            rights_policy=policy,
        )

    def test_example_manifest_is_ready_and_uses_one_dataset_split_enum(self) -> None:
        self.assertIs(ReadinessDatasetSplit, CanonicalDatasetSplit)
        report = self._validate(self.manifest)
        self.assertTrue(report.ready, report.to_dict())
        self.assertEqual(
            report.rights_trust_store_sha256,
            self.trust_store.fingerprint(),
        )
        payload = report.to_dict()
        self.assertEqual(payload["report_schema_version"], "3.0")
        self.assertRegex(payload["manifest_sha256"], r"^[0-9a-f]{64}$")
        self.assertEqual(
            payload["rights_trust"]["verification_policy_sha256"],
            replace(
                self.verification_policy,
                verifier_source_tree_sha256=readiness_verifier_source_tree_sha256(),
            ).fingerprint(),
        )
        self.assertEqual(len(payload["source_rights_proofs"]), 3)
        self.assertRegex(
            payload["verifier_source_tree_sha256"],
            r"^[0-9a-f]{64}$",
        )
        self.assertRegex(
            payload["protected_configuration_generation_sha256"],
            r"^[0-9a-f]{64}$",
        )
        self.assertTrue(payload["dataset_trust"]["manifest_trust_verified"])
        self.assertEqual(len(payload["artifact_set_proof"]["artifacts"]), 7)
        self.assertEqual(len(payload["source_label_pack_proofs"]), 3)
        self.assertEqual(
            payload["label_pack_evidence_scope"],
            {
                "verification": "STRUCTURAL_EVIDENCE_ONLY",
                "training_admission_granted": False,
                "evaluation_admission_granted": False,
                "test_admission_granted": False,
                "deployment_admission_granted": False,
                "live_scoring_admission_granted": False,
            },
        )
        self.assertTrue(
            {
                source["labels_sha256"]
                for source in self.manifest["data_sources"]
            }.isdisjoint(report.required_artifact_sha256s)
        )
        self.assertEqual(
            payload["artifact_set_proof"]["generation_id"],
            generation_id_for(report.required_artifact_sha256s),
        )
        self.assertEqual(
            payload["rights_trust"]["evidence_generation_id"],
            generation_id_for(
                tuple(
                    sorted(
                        {
                            digest
                            for proof in report.source_rights_proofs
                            for digest in proof.evidence_sha256s
                        }
                    )
                )
            ),
        )
        self.assertRegex(payload["report_sha256"], r"^[0-9a-f]{64}$")
        unsigned = dict(payload)
        report_sha256 = unsigned.pop("report_sha256")
        self.assertEqual(
            report_sha256,
            hashlib.sha256(
                json.dumps(
                    unsigned,
                    ensure_ascii=False,
                    sort_keys=True,
                    separators=(",", ":"),
                ).encode("utf-8")
            ).hexdigest(),
        )
        serialized = json.dumps(payload)
        self.assertIn('"ready": true', serialized)
        with self.assertRaisesRegex(ValueError, "runtime identity"):
            replace(report, runtime_identity_sha256="0" * 64)
        with self.assertRaisesRegex(ValueError, "deployment artifact"):
            replace(
                report,
                trusted_launcher_deployment_artifact_sha256="0" * 64,
            )
        with self.assertRaisesRegex(ValueError, "proof-set commitment"):
            replace(report, source_rights_proofs=())
        with self.assertRaisesRegex(ValueError, "label-pack proof-set"):
            replace(report, source_label_pack_proof_set_sha256="0" * 64)
        with self.assertRaisesRegex(ValueError, "rights evidence generation"):
            replace(report, rights_evidence_generation_id="0" * 64)
        report_provenance_forgery_cases = (
            ({"manifest_sha256": "0" * 64}, "manifest.*attestation"),
            (
                {"dataset_manifest_attestation_sha256": "0" * 64},
                "attestation proof",
            ),
            (
                {"protected_configuration_generation_sha256": "0" * 64},
                "configuration proof",
            ),
            (
                {"manifest_schema_version": "totally-invalid"},
                "schema_version 2.0",
            ),
            ({"dataset_id": "other-dataset"}, "dataset_id.*attestation"),
        )
        for changes, message in report_provenance_forgery_cases:
            with self.subTest(changes=changes):
                with self.assertRaisesRegex(ValueError, message):
                    replace(report, **changes)
        with self.assertRaisesRegex(ValueError, "dependency versions"):
            replace(
                report,
                verifier_dependency_versions=(("cryptography", "forged"),),
            )
        with self.assertRaisesRegex(ValueError, "dependency_versions"):
            replace(
                report,
                verifier_dependency_versions=(
                    report.verifier_dependency_versions[0],
                    report.verifier_dependency_versions[0],
                ),
            )
        with self.assertRaisesRegex(ValueError, "exactly cryptography"):
            replace(
                report,
                verifier_dependency_versions=(
                    (
                        "python_version",
                        dict(report.runtime_identity)["python_version"],
                    ),
                ),
            )
        with self.assertRaisesRegex(ValueError, "0 through 512"):
            replace(report, data_source_count=513)

        proof = report.source_rights_proofs[0]
        invalid_proof_cases = (
            ({"source_id": "söurce"}, "ASCII-stable"),
            ({"evidence_sha256s": ()}, "bounded non-empty"),
            (
                {"rights_reviewed_on": "2026-07-13"},
                "review cannot occur after",
            ),
            ({"rights_expires_on": "2026-07-11"}, "expired"),
            (
                {"required_uses": (PermittedUse.INTERNAL_RESEARCH,)},
                "protected split profile",
            ),
        )
        for changes, message in invalid_proof_cases:
            with self.subTest(proof_changes=changes):
                with self.assertRaisesRegex(ValueError, message):
                    replace(proof, **changes)

        pack_proof = report.source_label_pack_proofs[0]
        mismatched_pack_proofs = (
            replace(pack_proof, asset_sha256="0" * 64),
        ) + report.source_label_pack_proofs[1:]
        with self.assertRaisesRegex(ValueError, "different source coordinates"):
            replace(
                report,
                source_label_pack_proofs=mismatched_pack_proofs,
                source_label_pack_proof_set_sha256=(
                    source_label_pack_proof_set_sha256(
                        mismatched_pack_proofs,
                        report_schema_version="3.0",
                    )
                ),
            )
        disjoint_pack_proofs = (
            replace(pack_proof, source_id="different-source"),
        ) + report.source_label_pack_proofs[1:]
        with self.assertRaisesRegex(ValueError, "proof ID sets differ"):
            replace(
                report,
                source_label_pack_proofs=disjoint_pack_proofs,
                source_label_pack_proof_set_sha256=(
                    source_label_pack_proof_set_sha256(
                        disjoint_pack_proofs,
                        report_schema_version="3.0",
                    )
                ),
            )

        empty_artifacts = ()
        empty_proof = DatasetArtifactSetProof(
            generation_id=generation_id_for(()),
            artifacts=empty_artifacts,
            total_size_bytes=0,
            canonical_set_fingerprint=canonical_artifact_set_fingerprint(
                empty_artifacts
            ),
        )
        with self.assertRaisesRegex(ValueError, "manifest-required digest set"):
            replace(report, artifact_set_proof=empty_proof)

    def test_checked_in_cli_fixture_is_operable_on_its_pinned_runtime(self) -> None:
        if self.readiness_policy.runtime_identity_sha256 != (
            readiness_runtime_identity_sha256()
        ):
            self.skipTest("checked-in synthetic policy is pinned to another host")
        self.assertEqual(
            self.readiness_policy.verifier_source_tree_sha256,
            readiness_verifier_source_tree_sha256(),
        )
        stdout = io.StringIO()
        stderr = io.StringIO()
        with redirect_stdout(stdout), redirect_stderr(stderr):
            exit_code = main(
                [
                    str(EXAMPLE),
                    "--dataset-trust-store",
                    str(DATASET_TRUST_STORE),
                    "--dataset-manifest-attestation",
                    str(DATASET_ATTESTATION),
                    "--readiness-verification-policy",
                    str(READINESS_POLICY),
                    "--expected-readiness-verification-policy-sha256",
                    self.readiness_policy.fingerprint(),
                    "--trusted-launcher-deployment-artifact-sha256",
                    DEPLOYMENT_ARTIFACT_SHA256,
                    "--expected-governance-domain-id",
                    GOVERNANCE_DOMAIN_ID,
                    "--protected-configuration-generation",
                    str(PROTECTED_CONFIGURATION_GENERATION),
                    "--artifact-store-root",
                    str(ARTIFACT_STORE_ROOT),
                    "--label-store-root",
                    str(LABEL_STORE_ROOT),
                    "--rights-trust-store",
                    str(TRUST_STORE),
                    "--rights-verification-policy",
                    str(VERIFICATION_POLICY),
                    "--expected-rights-verification-policy-sha256",
                    self.verification_policy.fingerprint(),
                    "--rights-evidence-store-root",
                    str(RIGHTS_EVIDENCE_STORE_ROOT),
                ]
            )
        self.assertEqual(exit_code, 0, stderr.getvalue())
        self.assertEqual(stderr.getvalue(), "")
        self.assertTrue(json.loads(stdout.getvalue())["ready"])

    def test_schema_v1_and_missing_v2_pack_fields_are_hard_rejected(self) -> None:
        old = deepcopy(self.manifest)
        old["schema_version"] = "1.0"
        with patch(
            "vision_scoring.readiness.verify_source_label_pack_batch"
        ) as pack_worker:
            report = self._validate(old)
        self.assertIn("SCHEMA_VERSION", {item.code for item in report.blockers})
        pack_worker.assert_not_called()

        for field_name in ("labels_sha256", "label_pack_generation_id"):
            manifest = deepcopy(self.manifest)
            del manifest["data_sources"][0][field_name]
            with self.subTest(field_name=field_name), patch(
                "vision_scoring.readiness.verify_source_label_pack_batch"
            ) as pack_worker:
                report = self._validate(manifest)
                self.assertIn(
                    "SOURCE_CHECKSUM",
                    {item.code for item in report.blockers},
                )
                pack_worker.assert_not_called()

    def test_artifact_and_label_store_roots_must_be_distinct(self) -> None:
        alias = ARTIFACT_STORE_ROOT / ".." / "dataset-artifacts"
        with self.assertRaisesRegex(ValueError, "distinct stores"):
            self._validator_for_manifest(
                self.manifest,
                label_store_root=alias,
            )
        with tempfile.TemporaryDirectory() as temporary_directory:
            symlink = Path(temporary_directory) / "artifact-alias"
            symlink.symlink_to(ARTIFACT_STORE_ROOT, target_is_directory=True)
            with self.assertRaisesRegex(ValueError, "distinct stores"):
                self._validator_for_manifest(
                    self.manifest,
                    label_store_root=symlink,
                )
        case_variant = ARTIFACT_STORE_ROOT.with_name(
            ARTIFACT_STORE_ROOT.name.swapcase()
        )
        if case_variant.exists() and case_variant != ARTIFACT_STORE_ROOT:
            self.assertTrue(os.path.samefile(case_variant, ARTIFACT_STORE_ROOT))
            with self.assertRaisesRegex(ValueError, "distinct stores"):
                self._validator_for_manifest(
                    self.manifest,
                    label_store_root=case_variant,
                )

    def test_513_sources_are_rejected_before_label_worker(self) -> None:
        template = self.manifest["data_sources"][0]
        self.manifest["data_sources"] = [
            {**deepcopy(template), "source_id": f"source-{index}"}
            for index in range(513)
        ]
        with patch(
            "vision_scoring.readiness.verify_source_label_pack_batch"
        ) as pack_worker:
            report = self._validate(self.manifest)
        self.assertIn(
            "DATA_SOURCE_COUNT",
            {item.code for item in report.blockers},
        )
        self.assertEqual(report.data_source_count, 0)
        pack_worker.assert_not_called()

    def test_protected_configuration_change_during_pack_worker_discards_result(
        self,
    ) -> None:
        validator = self._validator_for_manifest(self.manifest)
        generation_path = validator._protected_configuration_generation_path
        original = load_protected_configuration_generation(generation_path)

        def verify_then_rotate(**kwargs):  # type: ignore[no-untyped-def]
            proofs = verify_source_label_pack_batch(**kwargs)
            generation_path.write_text(
                replace(
                    original,
                    governance_domain_id="rotated-governance-domain",
                ).canonical_json(),
                encoding="utf-8",
            )
            return proofs

        with patch(
            "vision_scoring.readiness.verify_source_label_pack_batch",
            side_effect=verify_then_rotate,
        ), self.assertRaisesRegex(
            ValueError,
            "protected configuration generation changed",
        ):
            validator.validate(self.manifest)

    def test_cli_requires_a_safe_distinct_label_store_root(self) -> None:
        stderr = io.StringIO()
        with redirect_stderr(stderr), self.assertRaises(SystemExit) as caught:
            main([str(EXAMPLE)])
        self.assertEqual(caught.exception.code, 2)
        self.assertIn("--label-store-root", stderr.getvalue())

        with tempfile.TemporaryDirectory() as temporary_directory:
            unsafe_root = Path(temporary_directory) / "not-a-store"
            unsafe_root.write_text("not a directory", encoding="utf-8")
            exit_code, payload, _ = self._run_cli(
                self.manifest,
                label_store_root=unsafe_root,
            )
        self.assertEqual(exit_code, 2)
        self.assertFalse(payload["ready"])
        self.assertIn(
            "LABEL_PACK_PREFLIGHT_STORE",
            {item["code"] for item in payload["blockers"]},
        )

    def test_validation_uses_one_detached_manifest_snapshot(self) -> None:
        original_asset_sha256 = self.manifest["data_sources"][0]["asset_sha256"]
        mutated_asset_sha256 = "e" * 64
        did_mutate = False

        def snapshot_then_mutate(value):
            nonlocal did_mutate
            encoded = canonical_json_bytes(value)
            if not did_mutate and value is self.manifest:
                self.manifest["data_sources"][0][
                    "asset_sha256"
                ] = mutated_asset_sha256
                did_mutate = True
            return encoded

        with patch(
            "vision_scoring.readiness.canonical_json_bytes",
            side_effect=snapshot_then_mutate,
        ):
            report = self.validator.validate(self.manifest)

        self.assertTrue(report.ready, report.to_dict())
        self.assertEqual(
            report.source_rights_proofs[0].asset_sha256,
            original_asset_sha256,
        )
        self.assertEqual(
            self.manifest["data_sources"][0]["asset_sha256"],
            mutated_asset_sha256,
        )

    def test_unsigned_manifest_cannot_assert_capture_or_trigger_artifact_trust(self) -> None:
        self.manifest["capture_profiles"][0]["native_capture_verified"] = False
        report = self.validator.validate(self.manifest)
        codes = {issue.code for issue in report.blockers}
        self.assertIn("DATASET_ATTESTATION_MANIFEST", codes)
        self.assertIn("CAPTURE_GATE", codes)
        self.assertIsNone(report.artifact_set_proof)

    def test_unsigned_self_asserted_rights_are_a_blocker(self) -> None:
        self.manifest["data_sources"][0]["rights_attestation"] = None
        report = self._validate(self.manifest)
        self.assertFalse(report.ready)
        self.assertIn(
            "RIGHTS_ATTESTATION_FORMAT",
            {issue.code for issue in report.blockers},
        )

        self.manifest = deepcopy(load_manifest(EXAMPLE))
        with self.assertRaises(TypeError):
            ManifestValidator()  # type: ignore[call-arg]

    def test_altered_decision_and_forged_signature_are_blockers(self) -> None:
        source = self.manifest["data_sources"][0]
        source["rights_decision"]["owner_or_licensor"] = "Forged Owner LLC"
        report = self._validate(self.manifest)
        self.assertIn(
            "RIGHTS_DECISION_CHECKSUM",
            {issue.code for issue in report.blockers},
        )

        self.manifest = deepcopy(load_manifest(EXAMPLE))
        signature = self.manifest["data_sources"][0]["rights_attestation"][
            "signature_base64"
        ]
        self.manifest["data_sources"][0]["rights_attestation"][
            "signature_base64"
        ] = ("A" if signature[0] != "A" else "B") + signature[1:]
        report = self._validate(self.manifest)
        self.assertIn(
            "RIGHTS_ATTESTATION_SIGNATURE",
            {issue.code for issue in report.blockers},
        )

    def test_dev_requires_training_rights_and_policy_geography_is_protected(self) -> None:
        dev = rights_decision_from_dict(
            self.manifest["data_sources"][1]["rights_decision"]
        )
        evaluation_only = replace(
            dev,
            permitted_uses=(
                PermittedUse.COMMERCIAL_MODEL_EVALUATION,
                PermittedUse.DERIVATIVE_DATASET_CREATION,
                PermittedUse.BIOMETRIC_POSE_ANALYSIS,
            ),
        )
        report = self._replace_source_rights(1, evaluation_only).validate(
            self.manifest
        )
        self.assertIn("SOURCE_RIGHTS", {issue.code for issue in report.blockers})

        self.manifest = deepcopy(load_manifest(EXAMPLE))
        dev = rights_decision_from_dict(
            self.manifest["data_sources"][1]["rights_decision"]
        )
        training_without_deployment = replace(
            dev,
            permitted_uses=tuple(
                use
                for use in dev.permitted_uses
                if use is not PermittedUse.MODEL_DEPLOYMENT
            ),
        )
        report = self._replace_source_rights(
            1,
            training_without_deployment,
        ).validate(self.manifest)
        self.assertIn("SOURCE_RIGHTS", {issue.code for issue in report.blockers})

        self.manifest = deepcopy(load_manifest(EXAMPLE))
        canada_policy = replace(
            self.verification_policy,
            deployment_geography="CA",
        )
        validator = self._validator_for_manifest(
            self.manifest,
            rights_policy=canada_policy,
        )
        report = validator.validate(self.manifest)
        self.assertIn("SOURCE_RIGHTS", {issue.code for issue in report.blockers})

    def test_expired_signed_decision_cannot_be_restored_by_manifest_date(self) -> None:
        train = rights_decision_from_dict(
            self.manifest["data_sources"][0]["rights_decision"]
        )
        expired = replace(train, expires_on="2026-07-10")
        report = self._replace_source_rights(0, expired).validate(self.manifest)
        self.assertIn("SOURCE_RIGHTS", {issue.code for issue in report.blockers})

    def test_match_and_unseen_venue_leakage_use_split_manifest(self) -> None:
        self.manifest["data_sources"][2]["match_id"] = self.manifest["data_sources"][0][
            "match_id"
        ]
        report = self._validate(self.manifest)
        self.assertIn("SPLIT_MATCH_LEAKAGE", {issue.code for issue in report.blockers})

        self.manifest = deepcopy(load_manifest(EXAMPLE))
        self.manifest["data_sources"][2].update(
            {
                "venue_id": self.manifest["data_sources"][0]["venue_id"],
                "camera_setup_id": "different-test-camera",
                "recording_date": "2026-07-04",
                "split_group_id": "same-venue-different-camera-day",
            }
        )
        report = self._validate(self.manifest)
        self.assertIn("SPLIT_TEST_VENUE_LEAKAGE", {issue.code for issue in report.blockers})

    def test_capture_pixel_and_timestamp_failures_block_training(self) -> None:
        capture = self.manifest["capture_profiles"][0]
        capture["far_ball_processed_pixels_p10"] = 4.0
        capture["timestamp_regressions"] = 1
        report = self._validate(self.manifest)
        paths = {issue.path for issue in report.blockers}
        self.assertIn("capture_profiles[0].far_ball_processed_pixels_p10", paths)
        self.assertIn("capture_profiles[0].timestamp_regressions", paths)

    def test_native_freeze_observability_and_calibration_gates_fail_closed(self) -> None:
        capture = self.manifest["capture_profiles"][0]
        capture.update(
            {
                "native_capture_verified": False,
                "frame_interpolation_detected": True,
                "unexplained_freeze_events": 1,
                "sampled_decisive_event_windows": 999,
                "visible_ball_blur_to_minor_axis_ratio_p95": 1.01,
                "usable_observed_positions_per_eligible_event_p10": 2.99,
                "calibration_holdout_p95_px": 2.01,
                "court_plane_holdout_p95_cm": 5.01,
                "capture_soak_minutes": 119.9,
                "camera_device_attestation_sha256": "not-a-hash",
            }
        )
        report = self._validate(self.manifest)
        blocked_paths = {issue.path for issue in report.blockers}
        for field_name in capture:
            if field_name in {
                "native_capture_verified",
                "frame_interpolation_detected",
                "unexplained_freeze_events",
                "sampled_decisive_event_windows",
                "visible_ball_blur_to_minor_axis_ratio_p95",
                "usable_observed_positions_per_eligible_event_p10",
                "calibration_holdout_p95_px",
                "court_plane_holdout_p95_cm",
                "capture_soak_minutes",
                "camera_device_attestation_sha256",
            }:
                self.assertIn(f"capture_profiles[0].{field_name}", blocked_paths)

    def test_dual_view_requires_measured_exposure_sync(self) -> None:
        capture = self.manifest["capture_profiles"][0]
        capture["mode"] = "DUAL_4K60"
        capture["camera_count"] = 2
        report = self._validate(self.manifest)
        self.assertIn("EXPOSURE_SYNC", {issue.code for issue in report.blockers})
        capture["exposure_sync_p95_ms"] = 0.8
        self.assertTrue(self._validate(self.manifest).ready)

    def test_source_must_reference_capture_and_keep_declared_group_together(self) -> None:
        self.manifest["data_sources"][0]["capture_profile_id"] = "missing-profile"
        self.manifest["data_sources"][2]["split_group_id"] = self.manifest["data_sources"][1][
            "split_group_id"
        ]
        report = self._validate(self.manifest)
        codes = {issue.code for issue in report.blockers}
        self.assertIn("CAPTURE_PROFILE_REFERENCE", codes)
        self.assertIn("SPLIT_GROUP_LEAKAGE", codes)

    def test_1080p_profile_is_ready_only_as_warned_compatibility_mode(self) -> None:
        capture = self.manifest["capture_profiles"][0]
        capture.update(
            {
                "mode": "1080P30",
                "width": 1920,
                "height": 1080,
                "fps": 30.0,
                "shutter_reciprocal": 600.0,
                "far_ball_processed_pixels_p10": 7.0,
            }
        )
        report = self._validate(self.manifest)
        self.assertTrue(report.ready)
        self.assertIn("COMPATIBILITY_CAPTURE", {issue.code for issue in report.warnings})

    def test_1080p60_profile_is_an_enhanced_ready_mode(self) -> None:
        capture = self.manifest["capture_profiles"][0]
        capture.update(
            {
                "mode": "1080P60",
                "width": 1920,
                "height": 1080,
                "fps": 60.0,
                "bitrate_mbps": 6.0,
                "shutter_reciprocal": 1000.0,
                "far_ball_processed_pixels_p10": 7.0,
            }
        )
        report = self._validate(self.manifest)
        self.assertTrue(report.ready)
        self.assertNotIn(
            "COMPATIBILITY_CAPTURE",
            {issue.code for issue in report.warnings},
        )

    def test_1080p60_requires_sixty_fps_shutter_and_low_blur(self) -> None:
        capture = self.manifest["capture_profiles"][0]
        capture.update(
            {
                "mode": "1080P60",
                "width": 1920,
                "height": 1080,
                "fps": 58.99,
                "shutter_reciprocal": 999.99,
                "far_ball_processed_pixels_p10": 7.0,
                "visible_ball_blur_to_minor_axis_ratio_p95": 1.01,
            }
        )
        report = self._validate(self.manifest)
        blocked_paths = {issue.path for issue in report.blockers}
        self.assertIn("capture_profiles[0].fps", blocked_paths)
        self.assertIn(
            "capture_profiles[0].shutter_reciprocal",
            blocked_paths,
        )
        self.assertIn(
            "capture_profiles[0].visible_ball_blur_to_minor_axis_ratio_p95",
            blocked_paths,
        )

    def test_dataset_cannot_supply_or_weaken_split_and_rights_policy(self) -> None:
        self.manifest["capture_profiles"][0]["far_ball_processed_pixel_p10"] = 11.0
        self.manifest["policies"] = {
            "require_unseen_test_venue": False,
            "rights_as_of": "2020-01-01",
            "deployment_geography": "US",
        }
        self.manifest["data_sources"][2]["venue_id"] = self.manifest[
            "data_sources"
        ][0]["venue_id"]
        report = self._validate(self.manifest)
        codes = {issue.code for issue in report.blockers}
        self.assertIn("UNKNOWN_FIELD", codes)
        self.assertIn("SPLIT_TEST_VENUE_LEAKAGE", codes)

    def test_direct_api_requires_exact_protected_policy_and_active_clock_window(self) -> None:
        with self.assertRaisesRegex(ValueError, "separately pinned"):
            self._validator_for_manifest(
                self.manifest,
                expected_readiness_policy_sha256="0" * 64,
            )
        expired_readiness_policy = replace(
            self.readiness_policy,
            valid_from="2025-01-01",
            valid_until="2025-12-31",
        )
        with self.assertRaisesRegex(ValueError, "not active"):
            self._validator_for_manifest(
                self.manifest,
                readiness_policy_base=expired_readiness_policy,
            ).validate(self.manifest)
        wrong_store_policy = replace(
            self.verification_policy,
            trust_store_sha256="0" * 64,
        )
        with self.assertRaisesRegex(ValueError, "trust store"):
            self._validator_for_manifest(
                self.manifest,
                rights_policy=wrong_store_policy,
            )
        with self.assertRaisesRegex(ValueError, "deployment artifact"):
            self._validator_for_manifest(
                self.manifest,
                deployment_artifact_sha256="0" * 64,
            ).validate(self.manifest)

    def test_validator_is_single_use_and_uses_the_actual_clock(self) -> None:
        one_day_policy = replace(
            self.readiness_policy,
            valid_from="2026-07-12",
            valid_until="2026-07-12",
        )
        validator = self._validator_for_manifest(
            self.manifest,
            readiness_policy_base=one_day_policy,
        )

        class CurrentDay(datetime):
            @classmethod
            def now(cls, tz=None):
                return cls(2026, 7, 12, tzinfo=timezone.utc)

        class FollowingDay(datetime):
            @classmethod
            def now(cls, tz=None):
                return cls(2026, 7, 13, tzinfo=timezone.utc)

        with patch("vision_scoring.readiness.datetime", CurrentDay):
            self.assertTrue(validator.validate(self.manifest).ready)
            with self.assertRaisesRegex(RuntimeError, "single-use"):
                validator.validate(self.manifest)

        following_day_validator = self._validator_for_manifest(
            self.manifest,
            readiness_policy_base=one_day_policy,
        )
        with patch("vision_scoring.readiness.datetime", FollowingDay):
            with self.assertRaisesRegex(ValueError, "not active"):
                following_day_validator.validate(self.manifest)

    def test_validation_rechecks_policy_at_completion_across_midnight(self) -> None:
        one_day_policy = replace(
            self.readiness_policy,
            valid_from="2026-07-12",
            valid_until="2026-07-12",
        )
        validator = self._validator_for_manifest(
            self.manifest,
            readiness_policy_base=one_day_policy,
        )

        class CrossingMidnight(datetime):
            calls = 0

            @classmethod
            def now(cls, tz=None):
                cls.calls += 1
                if cls.calls == 1:
                    return cls(
                        2026,
                        7,
                        12,
                        23,
                        59,
                        59,
                        tzinfo=timezone.utc,
                    )
                return cls(2026, 7, 13, tzinfo=timezone.utc)

        with patch("vision_scoring.readiness.datetime", CrossingMidnight):
            with self.assertRaisesRegex(ValueError, "not active"):
                validator.validate(self.manifest)

        self.assertEqual(CrossingMidnight.calls, 2)

    def test_final_generation_reload_crossing_midnight_repeats_all_checks(self) -> None:
        class LateCrossing(datetime):
            samples = (
                (2026, 7, 12, 23, 59, 58, 0),
                (2026, 7, 12, 23, 59, 59, 0),
                (2026, 7, 13, 0, 0, 0, 100_000),
                (2026, 7, 13, 0, 0, 0, 200_000),
            )
            calls = 0

            @classmethod
            def now(cls, tz=None):
                sample = cls.samples[cls.calls]
                cls.calls += 1
                return cls(*sample, tzinfo=timezone.utc)

        validator = self._validator_for_manifest(self.manifest)
        with patch("vision_scoring.readiness.datetime", LateCrossing):
            report = validator.validate(self.manifest)

        self.assertTrue(report.ready, report.to_dict())
        self.assertEqual(report.verified_at_utc, "2026-07-13T00:00:00Z")
        self.assertEqual(
            {proof.verified_on for proof in report.source_rights_proofs},
            {"2026-07-13"},
        )
        self.assertEqual(LateCrossing.calls, 4)

    def test_completion_clock_rollback_fails_closed(self) -> None:
        class RollingBack(datetime):
            samples = (
                (2026, 7, 12, 12, 0, 0),
                (2026, 7, 12, 12, 1, 0),
                (2026, 7, 12, 11, 59, 0),
            )
            calls = 0

            @classmethod
            def now(cls, tz=None):
                sample = cls.samples[cls.calls]
                cls.calls += 1
                return cls(*sample, tzinfo=timezone.utc)

        validator = self._validator_for_manifest(self.manifest)
        with patch("vision_scoring.readiness.datetime", RollingBack):
            with self.assertRaisesRegex(ValueError, "moved backward") as caught:
                validator.validate(self.manifest)
        self.assertEqual(caught.exception.code, "TRUSTED_CLOCK_ROLLBACK")

    def test_validation_discards_result_if_protected_generation_changes(self) -> None:
        validator = self._validator_for_manifest(self.manifest)
        current = load_protected_configuration_generation(
            validator._protected_configuration_generation_path
        )
        published_replacement = replace(
            current,
            rights_trust_store_sha256="f" * 64,
        )
        with patch(
            "vision_scoring.readiness.load_protected_configuration_generation",
            side_effect=(current, published_replacement),
        ), self.assertRaisesRegex(
            ValueError,
            "changed during validation",
        ) as caught:
            validator.validate(self.manifest)
        self.assertEqual(
            caught.exception.code,
            "PROTECTED_CONFIGURATION_CHANGED",
        )

    def test_protected_generation_must_match_every_loaded_component(self) -> None:
        validator = self._validator_for_manifest(self.manifest)
        current = load_protected_configuration_generation(
            validator._protected_configuration_generation_path
        )
        mismatch = replace(
            current,
            dataset_trust_store_sha256="f" * 64,
        )
        with patch(
            "vision_scoring.readiness.load_protected_configuration_generation",
            return_value=mismatch,
        ), self.assertRaisesRegex(
            ValueError,
            "does not match dataset trust store",
        ) as caught:
            validator.validate(self.manifest)
        self.assertEqual(
            caught.exception.code,
            "PROTECTED_CONFIGURATION_COMPONENT",
        )

    def test_manifest_loader_rejects_duplicate_keys_and_nonregular_inputs(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            duplicate = Path(temporary_directory) / "duplicate.json"
            duplicate.write_text(
                '{"schema_version":"1.0","schema_version":"1.0"}',
                encoding="utf-8",
            )
            with self.assertRaisesRegex(ValueError, "duplicate JSON object key"):
                load_manifest(duplicate)
            directory = Path(temporary_directory) / "not-a-file"
            directory.mkdir()
            with self.assertRaisesRegex(ValueError, "regular file"):
                load_manifest(directory)

    def test_readiness_issue_shape_and_severity_are_fail_closed(self) -> None:
        issue = ReadinessIssue(
            code="CAPTURE_GATE",
            severity=Severity.BLOCKER,
            path="capture_profiles[0].fps",
            message="fixture blocker",
        )
        self.assertEqual(issue.severity, Severity.BLOCKER)
        for changes, message in (
            ({"code": "bad-code"}, "uppercase code"),
            ({"severity": "BLOCKER"}, "Severity"),
            ({"path": ""}, "bounded non-empty"),
            ({"message": ""}, "bounded non-empty"),
        ):
            with self.subTest(changes=changes):
                with self.assertRaisesRegex(ValueError, message):
                    replace(issue, **changes)

    def test_old_media_and_camera_fields_have_no_compatibility_alias(self) -> None:
        source = self.manifest["data_sources"][0]
        source["media_sha256"] = source.pop("asset_sha256")
        source["camera_id"] = source.pop("camera_setup_id")
        source["rights_status"] = "OWNED"
        source["rights_ref"] = "contract:self-asserted"
        report = self._validate(self.manifest)
        codes = {issue.code for issue in report.blockers}
        self.assertIn("UNKNOWN_FIELD", codes)
        self.assertIn("SOURCE_SPLIT_RECORD", codes)

    def test_cli_rejects_unpinned_verification_policy(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            manifest_path = Path(temporary_directory) / "manifest.json"
            manifest_path.write_text(json.dumps(self.manifest), encoding="utf-8")
            stdout = io.StringIO()
            stderr = io.StringIO()
            with redirect_stdout(stdout), redirect_stderr(stderr):
                exit_code = main(
                    [
                        str(manifest_path),
                        "--dataset-trust-store",
                        str(DATASET_TRUST_STORE),
                        "--dataset-manifest-attestation",
                        str(DATASET_ATTESTATION),
                        "--readiness-verification-policy",
                        str(READINESS_POLICY),
                        "--expected-readiness-verification-policy-sha256",
                        self.readiness_policy.fingerprint(),
                        "--trusted-launcher-deployment-artifact-sha256",
                        DEPLOYMENT_ARTIFACT_SHA256,
                        "--expected-governance-domain-id",
                        GOVERNANCE_DOMAIN_ID,
                        "--protected-configuration-generation",
                        str(
                            Path(temporary_directory)
                            / "unused-current-generation.json"
                        ),
                        "--artifact-store-root",
                        str(ARTIFACT_STORE_ROOT),
                        "--label-store-root",
                        str(LABEL_STORE_ROOT),
                        "--rights-trust-store",
                        str(TRUST_STORE),
                        "--rights-verification-policy",
                        str(VERIFICATION_POLICY),
                        "--expected-rights-verification-policy-sha256",
                        "0" * 64,
                        "--rights-evidence-store-root",
                        str(RIGHTS_EVIDENCE_STORE_ROOT),
                    ]
                )
        self.assertEqual(exit_code, 2)
        self.assertEqual(stdout.getvalue(), "")
        self.assertIn("does not match", stderr.getvalue())

    def test_capture_ratios_must_be_finite_probabilities(self) -> None:
        capture = self.manifest["capture_profiles"][0]
        capture["human_resolvable_visible_ball_ratio"] = float("nan")
        report = self.validator.validate(self.manifest)
        self.assertIn(
            "MANIFEST_CANONICALIZATION",
            {issue.code for issue in report.blockers},
        )

        self.manifest = deepcopy(load_manifest(EXAMPLE))
        self.manifest["capture_profiles"][0][
            "visible_serve_frames_meeting_pixel_gate_ratio"
        ] = 1.01
        report = self._validate(self.manifest)
        blocked_paths = {issue.path for issue in report.blockers}
        self.assertIn(
            "capture_profiles[0].visible_serve_frames_meeting_pixel_gate_ratio",
            blocked_paths,
        )

    def test_boolean_values_do_not_satisfy_numeric_zero_gates(self) -> None:
        self.manifest["capture_profiles"][0]["timestamp_regressions"] = False
        report = self._validate(self.manifest)
        self.assertIn(
            "capture_profiles[0].timestamp_regressions",
            {issue.path for issue in report.blockers},
        )

    def test_labels_checksum_and_capture_profile_checks_are_preserved(self) -> None:
        source = self.manifest["data_sources"][0]
        source["labels_sha256"] = "not-a-hash"
        source["capture_profile_id"] = "not-a-profile"
        report = self._validate(self.manifest)
        codes = {issue.code for issue in report.blockers}
        self.assertIn("SOURCE_CHECKSUM", codes)
        self.assertIn("CAPTURE_PROFILE_REFERENCE", codes)

    def test_ready_requires_resident_pack_and_media_capture_bytes(self) -> None:
        self.manifest["data_sources"][0]["labels_sha256"] = "e" * 64
        report = self._validate(self.manifest)
        self.assertFalse(report.ready)
        self.assertIn(
            "BALL_LABEL_PACK_MEMBERSHIP",
            {issue.code for issue in report.blockers},
        )
        self.assertIsNotNone(report.artifact_set_proof)

        manifest = deepcopy(load_manifest(EXAMPLE))
        manifest["data_sources"][0]["asset_sha256"] = "e" * 64
        report = self._validate(manifest)
        self.assertFalse(report.ready)
        self.assertIn(
            "ARTIFACT_GENERATION_LOCK_MISSING",
            {issue.code for issue in report.blockers},
        )
        self.assertIsNone(report.artifact_set_proof)

    def test_cli_blocks_lineage_cross_split_and_orphan(self) -> None:
        root = self.manifest["data_sources"][0]
        cross_split = self._derived_source("7", parent_sha256=root["asset_sha256"])
        cross_split["split"] = "DEV"
        self.manifest["data_sources"].append(cross_split)
        exit_code, payload, stderr = self._run_cli(self.manifest)
        self.assertEqual(exit_code, 2)
        self.assertEqual(stderr, "")
        self.assertIn(
            "SPLIT_LINEAGE_EDGE_LEAKAGE",
            {blocker["code"] for blocker in payload["blockers"]},
        )

        self.manifest = deepcopy(load_manifest(EXAMPLE))
        orphan = self._derived_source("7", parent_sha256="8" * 64)
        self.manifest["data_sources"].append(orphan)
        exit_code, payload, _ = self._run_cli(self.manifest)
        self.assertEqual(exit_code, 2)
        self.assertIn(
            "SPLIT_LINEAGE_ORPHAN",
            {blocker["code"] for blocker in payload["blockers"]},
        )

    def test_cli_blocks_lineage_cycle(self) -> None:
        first = self._derived_source("7", parent_sha256="8" * 64)
        second = self._derived_source("8", parent_sha256="7" * 64)
        self.manifest["data_sources"].extend((first, second))

        exit_code, payload, _ = self._run_cli(self.manifest)

        self.assertEqual(exit_code, 2)
        self.assertIn(
            "SPLIT_LINEAGE_CYCLE",
            {blocker["code"] for blocker in payload["blockers"]},
        )

    def test_cli_blocks_synchronized_capture_leakage(self) -> None:
        self.manifest["data_sources"][1]["synchronized_capture_group_id"] = self.manifest[
            "data_sources"
        ][0]["synchronized_capture_group_id"]

        exit_code, payload, _ = self._run_cli(self.manifest)

        self.assertEqual(exit_code, 2)
        self.assertIn(
            "SPLIT_SYNC_LEAKAGE",
            {blocker["code"] for blocker in payload["blockers"]},
        )

    def test_cli_blocks_computed_venue_camera_day_leakage(self) -> None:
        train = self.manifest["data_sources"][0]
        dev = self.manifest["data_sources"][1]
        dev.update(
            {
                "venue_id": train["venue_id"],
                "camera_setup_id": train["camera_setup_id"],
                "recording_date": train["recording_date"],
                "split_group_id": "different-declared-id",
            }
        )
        exit_code, payload, _ = self._run_cli(self.manifest)

        self.assertEqual(exit_code, 2)
        self.assertIn(
            "SPLIT_VENUE_CAMERA_DAY_LEAKAGE",
            {blocker["code"] for blocker in payload["blockers"]},
        )

    @staticmethod
    def _capture_v3_measurements() -> dict:
        return {
            "capture_soak_minutes": 180.0,
            "calibration_holdout_p95_px": 1.5,
            "court_plane_holdout_p95_cm": 4.0,
            "critical_unexplained_drop_events": 0,
            "far_ball_processed_pixels_p10": 7.0,
            "fixed_mount": True,
            "frame_interpolation_detected": False,
            "human_resolvable_visible_ball_ratio": 0.997,
            "sampled_decisive_event_windows": 1200,
            "sampled_visible_ball_frames": 1200,
            "service_zones_fully_visible": True,
            "shutter_reciprocal": 1000.0,
            "timestamp_regressions": 0,
            "unexplained_freeze_events": 0,
            "upscaled_from_lower_resolution": False,
            "usable_observed_positions_per_eligible_event_p10": 4.0,
            "visible_ball_blur_to_minor_axis_ratio_p95": 0.8,
            "visible_serve_frames_meeting_pixel_gate_ratio": 0.995,
        }

    def _capture_v3_template_receipts(self, template) -> tuple:
        return tuple(
            template(
                source_id=source["source_id"],
                encoder_settings_sha256="0" * 64,
                calibration_sha256="1" * 64,
                clock_model_sha256="2" * 64,
                camera_attestation_sha256="3" * 64,
                exposure_descriptor_sha256="4" * 64,
                compression_stratum=CompressionStratumV1.CONSTRAINED_INTERFRAME,
            )
            for source in self.manifest["data_sources"]
        )

    def _install_capture_v3_receipts(self, receipts: tuple) -> None:
        by_profile: dict[str, object] = {}
        for receipt in receipts:
            by_profile.setdefault(receipt.capture_profile.fingerprint(), receipt)
        self.manifest["domain"] = (
            "multicourt-vision-scoring:readiness-manifest:v3"
        )
        self.manifest["schema_version"] = "3.0"
        self.manifest["capture_profiles"] = [
            {
                "encoder_configuration": receipt.encoder_configuration.to_dict(),
                "capture_profile": receipt.capture_profile.to_dict(),
                "empirical_capture_measurements": (
                    self._capture_v3_measurements()
                ),
            }
            for _, receipt in sorted(by_profile.items())
        ]
        receipts_by_source = {
            receipt.source_capture_facts.source_id: receipt
            for receipt in receipts
        }
        for source in self.manifest["data_sources"]:
            source.pop("capture_profile_id", None)
            source["source_capture_facts"] = receipts_by_source[
                source["source_id"]
            ].source_capture_facts.to_dict()

    def _capture_v3_receipts_for_representation(
        self,
        *,
        source_classification: CaptureSourceClassificationV1,
        source_representation: SourceRepresentationV1,
        transport: CaptureTransportV1,
        cadence_type: CadenceTypeV1 = CadenceTypeV1.CFR,
        source_provenance_complete: bool = True,
    ) -> tuple:
        base_receipts = self._capture_v3_template_receipts(
            mevo_core_owner_live_1080p60_v1
        )
        results = []
        for index, base in enumerate(base_receipts):
            cadence_numerator = 60 if cadence_type is CadenceTypeV1.CFR else 0
            cadence_denominator = 1 if cadence_type is CadenceTypeV1.CFR else 0
            encoder = replace(
                base.encoder_configuration,
                encoder_configuration_id=f"representation-encoder-{index}",
                source_representation=source_representation,
                transport=transport,
                cadence_type=cadence_type,
                cadence_numerator=cadence_numerator,
                cadence_denominator=cadence_denominator,
            )
            profile = replace(
                base.capture_profile,
                capture_profile_id=f"representation-profile-{index}",
                device_model_or_class="consumer-or-archive-camera",
                encoder_configuration_sha256=encoder.fingerprint(),
            )
            source_facts = SourceCaptureFactsV1(
                source_id=base.source_capture_facts.source_id,
                capture_profile_sha256=profile.fingerprint(),
                source_classification=source_classification,
                source_provenance_complete=source_provenance_complete,
                source_risk_tags=(
                    CaptureRiskTagV1.MOTION_BLUR,
                ),
            )
            results.append(
                classify_capture_profile_v1(encoder, profile, source_facts)
            )
        return tuple(results)

    def test_capture_v3_mevo_and_avkans_derive_ordered_receipts(self) -> None:
        for template, expected_mode in (
            (mevo_core_owner_live_1080p60_v1, "1080P60"),
            (avkans_go_owner_live_1080p30_v1, "1080P30"),
        ):
            with self.subTest(template=template.__name__):
                self.manifest = deepcopy(load_manifest(EXAMPLE))
                receipts = self._capture_v3_template_receipts(template)
                self._install_capture_v3_receipts(receipts)
                validator = self._validator_for_manifest(self.manifest)
                report = validator.validate(self.manifest)
                self.assertFalse(
                    {
                        issue.code
                        for issue in report.blockers
                        if (
                            issue.code.startswith("CAPTURE")
                            or issue.code.startswith("SOURCE_CAPTURE")
                        )
                        and issue.code != "CAPTURE_REPORT_BINDING_PENDING"
                    },
                    report.to_dict(),
                )
                self.assertNotIn(
                    "UNKNOWN_FIELD",
                    {issue.code for issue in report.blockers},
                    report.to_dict(),
                )
                self.assertIn(
                    "CAPTURE_REPORT_BINDING_PENDING",
                    {issue.code for issue in report.blockers},
                    report.to_dict(),
                )
                self.assertFalse(report.ready)
                derived = validator._validated_capture_classifications
                self.assertEqual(
                    tuple(
                        receipt.source_capture_facts.source_id
                        for receipt in derived
                    ),
                    tuple(
                        sorted(
                            source["source_id"]
                            for source in self.manifest["data_sources"]
                        )
                    ),
                )
                self.assertEqual(
                    {receipt.training_capture_mode.value for receipt in derived},
                    {expected_mode},
                )

    def test_capture_v3_avkans_does_not_invent_physical_mapping(self) -> None:
        receipt = self._capture_v3_template_receipts(
            avkans_go_owner_live_1080p30_v1
        )[0]
        profile = receipt.capture_profile.to_dict()
        source_facts = receipt.source_capture_facts.to_dict()
        self.assertEqual(profile["device_scope"], "DEVICE_MODEL")
        self.assertIsNone(profile["exact_device_id"])
        self.assertEqual(profile["view_count"], 1)
        self.assertFalse(
            {
                "physical_device_count",
                "logical_stream_id",
                "physical_to_logical_stream_mapping",
            }
            & (profile.keys() | source_facts.keys())
        )

    def test_capture_v3_exact_phone_and_archive_representations_classify(self) -> None:
        cases = (
            (
                CaptureSourceClassificationV1.PHONE_OR_CONSUMER_CAMERA,
                SourceRepresentationV1.PHONE_OR_CONSUMER_CAPTURE,
                CaptureTransportV1.LOCAL_CAPTURE,
            ),
            (
                CaptureSourceClassificationV1.OWNER_PRODUCED_ARCHIVE,
                SourceRepresentationV1.ORIGINAL_CAMERA_MASTER,
                CaptureTransportV1.FILE,
            ),
            (
                CaptureSourceClassificationV1.OWNER_PRODUCED_ARCHIVE,
                SourceRepresentationV1.PLATFORM_TRANSCODE,
                CaptureTransportV1.FILE,
            ),
        )
        for source_classification, representation, transport in cases:
            with self.subTest(representation=representation.value):
                self.manifest = deepcopy(load_manifest(EXAMPLE))
                receipts = self._capture_v3_receipts_for_representation(
                    source_classification=source_classification,
                    source_representation=representation,
                    transport=transport,
                )
                self._install_capture_v3_receipts(receipts)
                validator = self._validator_for_manifest(self.manifest)
                report = validator.validate(self.manifest)
                self.assertFalse(
                    {
                        issue.code
                        for issue in report.blockers
                        if (
                            issue.code.startswith("CAPTURE")
                            or issue.code.startswith("SOURCE_CAPTURE")
                        )
                        and issue.code != "CAPTURE_REPORT_BINDING_PENDING"
                    },
                    report.to_dict(),
                )
                self.assertTrue(
                    all(
                        receipt.status.value == "CLASSIFIED"
                        for receipt in validator._validated_capture_classifications
                    )
                )

    def test_capture_v3_vfr_phone_and_unknown_source_abstain(self) -> None:
        cases = (
            self._capture_v3_receipts_for_representation(
                source_classification=(
                    CaptureSourceClassificationV1.PHONE_OR_CONSUMER_CAMERA
                ),
                source_representation=(
                    SourceRepresentationV1.PHONE_OR_CONSUMER_CAPTURE
                ),
                transport=CaptureTransportV1.LOCAL_CAPTURE,
                cadence_type=CadenceTypeV1.VFR,
            ),
            self._capture_v3_receipts_for_representation(
                source_classification=(
                    CaptureSourceClassificationV1.EXTERNAL_OR_UNKNOWN
                ),
                source_representation=SourceRepresentationV1.UNKNOWN,
                transport=CaptureTransportV1.FILE,
                source_provenance_complete=False,
            ),
        )
        for receipts in cases:
            with self.subTest(reason=receipts[0].abstention_reason.value):
                self.manifest = deepcopy(load_manifest(EXAMPLE))
                self._install_capture_v3_receipts(receipts)
                validator = self._validator_for_manifest(self.manifest)
                report = validator.validate(self.manifest)
                self.assertFalse(report.ready)
                self.assertIn(
                    "CAPTURE_CLASSIFICATION_ABSTAINED",
                    {issue.code for issue in report.blockers},
                )
                self.assertTrue(
                    all(
                        receipt.status.value == "ABSTAINED"
                        for receipt in validator._validated_capture_classifications
                    )
                )

    def test_capture_v3_source_profile_and_source_id_mismatches_block(self) -> None:
        receipts = self._capture_v3_template_receipts(
            mevo_core_owner_live_1080p60_v1
        )
        self._install_capture_v3_receipts(receipts)
        source_facts = self.manifest["data_sources"][0]["source_capture_facts"]
        source_facts["capture_profile_sha256"] = "e" * 64
        report = self._validate(self.manifest)
        self.assertIn(
            "CAPTURE_PROFILE_REFERENCE", {issue.code for issue in report.blockers}
        )

        self.manifest = deepcopy(load_manifest(EXAMPLE))
        self._install_capture_v3_receipts(receipts)
        self.manifest["data_sources"][0]["source_capture_facts"][
            "source_id"
        ] = "different-source"
        report = self._validate(self.manifest)
        self.assertIn(
            "SOURCE_CAPTURE_BINDING", {issue.code for issue in report.blockers}
        )

        self.manifest = deepcopy(load_manifest(EXAMPLE))
        self._install_capture_v3_receipts(receipts)
        self.manifest["capture_profiles"][0]["capture_profile"][
            "encoder_configuration_sha256"
        ] = "d" * 64
        report = self._validate(self.manifest)
        self.assertIn(
            "CAPTURE_PROFILE_ENCODER_BINDING",
            {issue.code for issue in report.blockers},
        )

    def test_capture_v3_mode_drives_nested_empirical_thresholds(self) -> None:
        receipts = self._capture_v3_template_receipts(
            mevo_core_owner_live_1080p60_v1
        )
        self._install_capture_v3_receipts(receipts)
        measurements = self.manifest["capture_profiles"][0][
            "empirical_capture_measurements"
        ]
        measurements["shutter_reciprocal"] = 999.0
        measurements["visible_ball_blur_to_minor_axis_ratio_p95"] = 1.01
        report = self._validate(self.manifest)
        blocker_paths = {issue.path for issue in report.blockers}
        self.assertIn(
            "capture_profiles[0].empirical_capture_measurements."
            "shutter_reciprocal",
            blocker_paths,
        )
        self.assertIn(
            "capture_profiles[0].empirical_capture_measurements."
            "visible_ball_blur_to_minor_axis_ratio_p95",
            blocker_paths,
        )

    def test_capture_v3_rejects_v2_flat_capture_fields(self) -> None:
        report = self._validate(self.manifest)
        codes = {issue.code for issue in report.blockers}
        self.assertIn("MANIFEST_DOMAIN", codes)
        self.assertIn("SCHEMA_VERSION", codes)
        self.assertIn("UNKNOWN_FIELD", codes)


if __name__ == "__main__":
    unittest.main()
