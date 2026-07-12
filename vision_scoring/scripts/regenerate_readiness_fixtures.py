#!/usr/bin/env python3
"""Regenerate the deterministic synthetic readiness V2 fixture generation.

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
    b"synthetic trusted readiness launcher v2 with isolated label-pack store\n"
)


def _write_json(path: Path, value: object) -> None:
    path.write_text(
        json.dumps(value, indent=2, sort_keys=True, ensure_ascii=False) + "\n",
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

    # Preserve the resident synthetic media/capture placeholder bytes, then
    # republish only the V2 artifact closure (labels move to a separate store).
    artifact_payloads: dict[str, bytes] = {}
    for path in (EXAMPLES / "dataset-artifacts" / "generations").glob(
        "*/objects/*"
    ):
        if path.is_file():
            artifact_payloads[path.name] = path.read_bytes()

    manifest = json.loads(json.dumps(old_manifest))
    manifest["schema_version"] = "2.0"
    manifest["dataset_id"] = "synthetic-readiness-example-v2"

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
    selected_artifacts = {
        digest: artifact_payloads[digest] for digest in required_artifacts
    }
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
        policy_id="synthetic-readiness-policy-v2",
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
