#!/usr/bin/env python3
"""Regenerate the deterministic synthetic readiness V3 fixture generation.

Run from ``vision_scoring/`` with the locked Python 3.11 environment.  The
script intentionally imports test builders: these files are executable smoke
fixtures, not production trust anchors or trainable truth.
"""

from __future__ import annotations

import base64
from dataclasses import replace
import hashlib
import json
from pathlib import Path
import shutil
import sys

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "src"))

import tests.test_label_bundle as label_fixture
from tests.test_ball_label_pack import _contract_payloads
from vision_scoring.capture_profile_contracts import (
    CompressionStratumV1,
    avkans_go_owner_live_1080p30_v1,
    mevo_core_owner_live_1080p60_v1,
)
from vision_scoring.dataset_split import DatasetSplit
from vision_scoring.immutable_store import (
    GenerationDescriptor,
    bootstrap_generation_lock,
)
from vision_scoring.label_bundle import LabelBundleSplit
from vision_scoring.readiness import (
    _required_dataset_artifact_sha256s,
    load_manifest,
    readiness_runtime_identity_sha256,
    readiness_verifier_source_tree_sha256,
)
from vision_scoring.readiness_trust import (
    CurrentDatasetManifest,
    DatasetManifestAttestation,
    ProtectedConfigurationGeneration,
    canonical_manifest_sha256,
    dataset_manifest_attestation_signing_message,
    load_dataset_trust_store,
    load_readiness_verification_policy,
)
from vision_scoring.rights_trust import (
    load_rights_trust_store,
    load_rights_verification_policy,
)


EXAMPLES = ROOT / "examples"
DATASET_PRIVATE_KEY = Ed25519PrivateKey.from_private_bytes(b"\x44" * 32)
DEPLOYMENT_BYTES = (
    b"synthetic trusted readiness launcher v3 with capture reports\n"
)


def _capture_evidence_payloads(
    profile_name: str,
) -> tuple[dict[str, str], dict[str, bytes]]:
    roles = (
        "encoder-settings",
        "calibration",
        "clock-model",
        "camera-attestation",
        "exposure-descriptor",
    )
    payloads = {
        role: (
            f"synthetic readiness V3 {profile_name} {role} evidence\n"
        ).encode("utf-8")
        for role in roles
    }
    return (
        {role: hashlib.sha256(payload).hexdigest() for role, payload in payloads.items()},
        {hashlib.sha256(payload).hexdigest(): payload for payload in payloads.values()},
    )


def _empirical_capture_measurements(*, frames_per_second: int) -> dict[str, object]:
    if frames_per_second not in {30, 60}:
        raise ValueError("synthetic readiness fixture supports only 30 or 60 fps")
    return {
        "calibration_holdout_p95_px": 1.5,
        "capture_soak_minutes": 180.0,
        "court_plane_holdout_p95_cm": 4.0,
        "critical_unexplained_drop_events": 0,
        "far_ball_processed_pixels_p10": 7.0,
        "fixed_mount": True,
        "frame_interpolation_detected": False,
        "human_resolvable_visible_ball_ratio": 0.997,
        "sampled_decisive_event_windows": 1200,
        "sampled_visible_ball_frames": 1200,
        "service_zones_fully_visible": True,
        "shutter_reciprocal": 1000.0 if frames_per_second == 60 else 600.0,
        "timestamp_regressions": 0,
        "unexplained_freeze_events": 0,
        "upscaled_from_lower_resolution": False,
        "usable_observed_positions_per_eligible_event_p10": 4.0,
        "visible_ball_blur_to_minor_axis_ratio_p95": (
            0.8 if frames_per_second == 60 else 1.5
        ),
        "visible_serve_frames_meeting_pixel_gate_ratio": 0.995,
    }


def _write_json(path: Path, value: object) -> None:
    path.write_text(
        json.dumps(
            value,
            allow_nan=False,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        ),
        encoding="utf-8",
    )


def _publish_generation(
    store_root: Path,
    payloads: dict[str, bytes],
) -> GenerationDescriptor:
    descriptor = GenerationDescriptor.build(tuple(sorted(payloads)))
    bootstrap_generation_lock(store_root, descriptor.generation_id)
    generation = store_root / "generations" / descriptor.generation_id
    objects = generation / "objects"
    objects.mkdir(parents=True)
    for digest, payload in sorted(payloads.items()):
        if hashlib.sha256(payload).hexdigest() != digest:
            raise RuntimeError("fixture payload does not match its content address")
        (objects / digest).write_bytes(payload)
    (generation / "descriptor.json").write_bytes(descriptor.canonical_bytes())
    return descriptor


def _reset_store(path: Path) -> None:
    if path.exists():
        shutil.rmtree(path)
    (path / "locks").mkdir(parents=True)
    (path / "generations").mkdir()


def main() -> None:
    manifest_path = EXAMPLES / "readiness-manifest.json"
    old_manifest = dict(load_manifest(manifest_path))
    old_manifest_sha256 = canonical_manifest_sha256(old_manifest)
    old_dataset_store = load_dataset_trust_store(
        EXAMPLES / "dataset-trust-store.json"
    )
    old_readiness_policy = load_readiness_verification_policy(
        EXAMPLES / "readiness-verification-policy.json"
    )
    rights_store = load_rights_trust_store(EXAMPLES / "rights-trust-store.json")
    old_rights_policy = load_rights_verification_policy(
        EXAMPLES / "rights-verification-policy.json"
    )

    # Preserve the three resident synthetic media payloads. Capture evidence is
    # rebuilt below from ten deterministic, explicitly synthetic role payloads.
    artifact_payloads: dict[str, bytes] = {}
    for path in (EXAMPLES / "dataset-artifacts" / "generations").glob(
        "*/objects/*"
    ):
        if path.is_file():
            artifact_payloads[path.name] = path.read_bytes()

    manifest = json.loads(json.dumps(old_manifest))
    manifest["domain"] = "multicourt-vision-scoring:readiness-manifest:v3"
    manifest["schema_version"] = "3.0"
    manifest["dataset_id"] = "synthetic-readiness-example-v3"

    mevo_digests, mevo_payloads = _capture_evidence_payloads("mevo-core")
    avkans_digests, avkans_payloads = _capture_evidence_payloads("avkans-go")
    artifact_payloads.update(mevo_payloads)
    artifact_payloads.update(avkans_payloads)
    profile_receipts: dict[str, object] = {}
    source_receipts: dict[str, object] = {}
    for source in manifest["data_sources"]:
        if source["split"] in {"TRAIN", "TEST"}:
            digests = mevo_digests
            receipt = mevo_core_owner_live_1080p60_v1(
                source_id=source["source_id"],
                encoder_settings_sha256=digests["encoder-settings"],
                calibration_sha256=digests["calibration"],
                clock_model_sha256=digests["clock-model"],
                camera_attestation_sha256=digests["camera-attestation"],
                exposure_descriptor_sha256=digests["exposure-descriptor"],
                compression_stratum=(
                    CompressionStratumV1.CONSTRAINED_INTERFRAME
                ),
            )
            frames_per_second = 60
        else:
            digests = avkans_digests
            # This model-scoped synthetic profile deliberately contains no
            # claim about six physical cameras, three logical streams, or a
            # physical-device-to-logical-stream mapping.
            receipt = avkans_go_owner_live_1080p30_v1(
                source_id=source["source_id"],
                encoder_settings_sha256=digests["encoder-settings"],
                calibration_sha256=digests["calibration"],
                clock_model_sha256=digests["clock-model"],
                camera_attestation_sha256=digests["camera-attestation"],
                exposure_descriptor_sha256=digests["exposure-descriptor"],
                compression_stratum=(
                    CompressionStratumV1.CONSTRAINED_INTERFRAME
                ),
            )
            frames_per_second = 30
        profile_sha256 = receipt.capture_profile.fingerprint()
        profile_receipts.setdefault(
            profile_sha256,
            (receipt, frames_per_second),
        )
        source_receipts[source["source_id"]] = receipt

    manifest["capture_profiles"] = [
        {
            "capture_profile": receipt.capture_profile.to_dict(),
            "empirical_capture_measurements": (
                _empirical_capture_measurements(
                    frames_per_second=frames_per_second
                )
            ),
            "encoder_configuration": receipt.encoder_configuration.to_dict(),
        }
        for _, (receipt, frames_per_second) in sorted(profile_receipts.items())
    ]
    for source in manifest["data_sources"]:
        source.pop("capture_profile_id", None)
        source["source_capture_facts"] = source_receipts[
            source["source_id"]
        ].source_capture_facts.to_dict()

    label_store = EXAMPLES / "ball-label-packs"
    _reset_store(label_store)
    split_map = {
        DatasetSplit.TRAIN: LabelBundleSplit.TRAIN,
        DatasetSplit.DEV: LabelBundleSplit.DEV,
        DatasetSplit.TEST: LabelBundleSplit.TEST,
    }
    for source in manifest["data_sources"]:
        source_split = DatasetSplit(source["split"])
        label_fixture.SOURCE = source["asset_sha256"]
        statement, annotations, raw_attestations = label_fixture._bundle(
            split=split_map[source_split],
            all_balls=True,
        )
        statement = replace(
            statement,
            bundle_id=f"label-pack-{source['source_id']}",
        )
        root, payloads = _contract_payloads(
            statement,
            annotations,
            tuple(raw_attestations),
        )
        descriptor = _publish_generation(label_store, payloads)
        source["labels_sha256"] = root.fingerprint()
        source["label_pack_generation_id"] = descriptor.generation_id

    required_artifacts = _required_dataset_artifact_sha256s(manifest)
    missing_artifacts = sorted(set(required_artifacts) - artifact_payloads.keys())
    if missing_artifacts:
        raise RuntimeError(
            "fixture artifact payloads are missing required digests: "
            + ", ".join(missing_artifacts)
        )
    selected_artifacts = {
        digest: artifact_payloads[digest] for digest in required_artifacts
    }
    if len(selected_artifacts) != 13:
        raise RuntimeError("readiness V3 fixture requires an exact 13-object closure")
    artifact_store = EXAMPLES / "dataset-artifacts"
    _reset_store(artifact_store)
    artifact_descriptor = _publish_generation(artifact_store, selected_artifacts)
    if artifact_descriptor.object_sha256s != required_artifacts:
        raise RuntimeError("artifact fixture closure is inconsistent")

    manifest_sha256 = canonical_manifest_sha256(manifest)
    signature = DATASET_PRIVATE_KEY.sign(
        dataset_manifest_attestation_signing_message(
            dataset_id=manifest["dataset_id"],
            manifest_sha256=manifest_sha256,
            curator_id="example-dataset-curator",
            key_id="example-dataset-key-1",
            trust_domain_id="example-dataset-governance",
            signed_on="2026-07-12",
        )
    )
    attestation = DatasetManifestAttestation(
        dataset_id=manifest["dataset_id"],
        manifest_sha256=manifest_sha256,
        curator_id="example-dataset-curator",
        key_id="example-dataset-key-1",
        trust_domain_id="example-dataset-governance",
        signed_on="2026-07-12",
        signature_base64=base64.b64encode(signature).decode("ascii"),
    )
    dataset_store = replace(
        old_dataset_store,
        current_manifests=tuple(
            sorted(
                (
                    item
                    for item in old_dataset_store.current_manifests
                    if item.dataset_id
                    not in {old_manifest["dataset_id"], manifest["dataset_id"]}
                ),
                key=lambda item: item.dataset_id,
            )
        )
        + (
            CurrentDatasetManifest(manifest["dataset_id"], manifest_sha256),
        ),
        revoked_manifest_sha256s=tuple(
            sorted(
                set(old_dataset_store.revoked_manifest_sha256s)
                | (
                    {old_manifest_sha256}
                    if old_manifest_sha256 != manifest_sha256
                    else set()
                )
            )
        ),
    )

    verifier_sha256 = readiness_verifier_source_tree_sha256()
    rights_policy = replace(
        old_rights_policy,
        verifier_source_tree_sha256=verifier_sha256,
    )
    deployment_sha256 = hashlib.sha256(DEPLOYMENT_BYTES).hexdigest()
    readiness_policy = replace(
        old_readiness_policy,
        policy_id="synthetic-readiness-policy-v3",
        dataset_trust_store_sha256=dataset_store.fingerprint(),
        rights_verification_policy_sha256=rights_policy.fingerprint(),
        verifier_source_tree_sha256=verifier_sha256,
        deployment_artifact_sha256=deployment_sha256,
        runtime_identity_sha256=readiness_runtime_identity_sha256(),
    )
    protected_generation = ProtectedConfigurationGeneration(
        dataset_trust_store_sha256=dataset_store.fingerprint(),
        dataset_manifest_attestation_sha256=attestation.fingerprint(),
        readiness_verification_policy_sha256=readiness_policy.fingerprint(),
        rights_trust_store_sha256=rights_store.fingerprint(),
        rights_verification_policy_sha256=rights_policy.fingerprint(),
        trusted_launcher_deployment_artifact_sha256=deployment_sha256,
        governance_domain_id="example-dataset-governance",
    )

    deployment_root = EXAMPLES / "deployment-artifacts"
    for path in deployment_root.iterdir():
        if path.is_file():
            path.unlink()
    (deployment_root / deployment_sha256).write_bytes(DEPLOYMENT_BYTES)

    _write_json(manifest_path, manifest)
    _write_json(
        EXAMPLES / "dataset-manifest-attestation.json",
        attestation.to_canonical_dict(),
    )
    _write_json(
        EXAMPLES / "dataset-trust-store.json",
        dataset_store.to_canonical_dict(),
    )
    _write_json(
        EXAMPLES / "rights-verification-policy.json",
        rights_policy.to_canonical_dict(),
    )
    _write_json(
        EXAMPLES / "readiness-verification-policy.json",
        readiness_policy.to_canonical_dict(),
    )
    _write_json(
        EXAMPLES / "protected-configuration-generation.json",
        protected_generation.to_canonical_dict(),
    )
    print(
        json.dumps(
            {
                "artifact_generation_id": artifact_descriptor.generation_id,
                "dataset_manifest_sha256": manifest_sha256,
                "deployment_artifact_sha256": deployment_sha256,
                "readiness_policy_sha256": readiness_policy.fingerprint(),
                "rights_policy_sha256": rights_policy.fingerprint(),
                "verifier_source_tree_sha256": verifier_sha256,
            },
            indent=2,
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    main()
