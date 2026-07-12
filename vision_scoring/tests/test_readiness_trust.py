from __future__ import annotations

import base64
from dataclasses import replace
import hashlib
import json
import os
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from vision_scoring.readiness_trust import (
    CurrentDatasetManifest,
    DatasetManifestAttestation,
    DatasetTrustStore,
    ProtectedConfigurationGeneration,
    ReadinessTrustError,
    ReadinessVerificationPolicy,
    TrustedDatasetKey,
    canonical_json_bytes,
    canonical_manifest_sha256,
    dataset_manifest_attestation_from_dict,
    dataset_manifest_attestation_signing_message,
    dataset_trust_store_from_dict,
    load_dataset_manifest_attestation,
    load_dataset_trust_store,
    load_protected_configuration_generation,
    load_readiness_verification_policy,
    readiness_verification_policy_from_dict,
    protected_configuration_generation_from_dict,
    verify_readiness_policy_pins,
)


DATASET_ID = "beach-volleyball-v1"
MANIFEST = {
    "dataset_id": DATASET_ID,
    "policy": {"require_unseen_test_venue": True},
    "sources": [{"asset_sha256": "a" * 64, "split": "TRAIN"}],
}
MANIFEST_SHA256 = canonical_manifest_sha256(MANIFEST)
STALE_MANIFEST_SHA256 = hashlib.sha256(b"stale").hexdigest()
REVOKED_MANIFEST_SHA256 = hashlib.sha256(b"revoked").hexdigest()
PRIVATE_KEY = Ed25519PrivateKey.from_private_bytes(b"\x41" * 32)
OTHER_PRIVATE_KEY = Ed25519PrivateKey.from_private_bytes(b"\x42" * 32)
PUBLIC_KEY_BASE64 = base64.b64encode(
    PRIVATE_KEY.public_key().public_bytes_raw()
).decode("ascii")


def _attestation(
    *,
    private_key: Ed25519PrivateKey = PRIVATE_KEY,
    dataset_id: str = DATASET_ID,
    manifest_sha256: str = MANIFEST_SHA256,
    curator_id: str = "dataset-curator-1",
    key_id: str = "dataset-key-1",
    trust_domain_id: str = "dataset-governance-prod",
    signed_on: str = "2026-07-11",
) -> DatasetManifestAttestation:
    signature = private_key.sign(
        dataset_manifest_attestation_signing_message(
            dataset_id=dataset_id,
            manifest_sha256=manifest_sha256,
            curator_id=curator_id,
            key_id=key_id,
            trust_domain_id=trust_domain_id,
            signed_on=signed_on,
        )
    )
    return DatasetManifestAttestation(
        dataset_id=dataset_id,
        manifest_sha256=manifest_sha256,
        curator_id=curator_id,
        key_id=key_id,
        trust_domain_id=trust_domain_id,
        signed_on=signed_on,
        signature_base64=base64.b64encode(signature).decode("ascii"),
    )


def _key(**overrides: object) -> TrustedDatasetKey:
    values: dict[str, object] = {
        "key_id": "dataset-key-1",
        "curator_id": "dataset-curator-1",
        "public_key_base64": PUBLIC_KEY_BASE64,
        "valid_from": "2026-01-01",
        "valid_until": "2026-12-31",
        "compromised_on": None,
    }
    values.update(overrides)
    return TrustedDatasetKey(**values)  # type: ignore[arg-type]


def _store(**overrides: object) -> DatasetTrustStore:
    values: dict[str, object] = {
        "keyring_id": "dataset-governance-prod",
        "keys": (_key(),),
        "current_manifests": (
            CurrentDatasetManifest(
                dataset_id=DATASET_ID,
                manifest_sha256=MANIFEST_SHA256,
            ),
        ),
        "revoked_manifest_sha256s": (),
    }
    values.update(overrides)
    return DatasetTrustStore(**values)  # type: ignore[arg-type]


def _policy(store: DatasetTrustStore | None = None) -> ReadinessVerificationPolicy:
    store = store or _store()
    return ReadinessVerificationPolicy(
        policy_id="readiness-production-v1",
        dataset_trust_store_sha256=store.fingerprint(),
        rights_verification_policy_sha256="b" * 64,
        verifier_source_tree_sha256="c" * 64,
        deployment_artifact_sha256="d" * 64,
        runtime_identity_sha256="e" * 64,
        governance_domain_id="dataset-governance-prod",
        require_unseen_test_venue=True,
        valid_from="2026-01-01",
        valid_until="2026-12-31",
    )


def _configuration_generation(
    *,
    store: DatasetTrustStore | None = None,
    attestation: DatasetManifestAttestation | None = None,
    policy: ReadinessVerificationPolicy | None = None,
) -> ProtectedConfigurationGeneration:
    store = store or _store()
    attestation = attestation or _attestation()
    policy = policy or _policy(store)
    return ProtectedConfigurationGeneration(
        dataset_trust_store_sha256=store.fingerprint(),
        dataset_manifest_attestation_sha256=attestation.fingerprint(),
        readiness_verification_policy_sha256=policy.fingerprint(),
        rights_trust_store_sha256="a" * 64,
        rights_verification_policy_sha256=(
            policy.rights_verification_policy_sha256
        ),
        trusted_launcher_deployment_artifact_sha256=(
            policy.deployment_artifact_sha256
        ),
        governance_domain_id=policy.governance_domain_id,
    )


def _policy_pin_arguments(
    policy: ReadinessVerificationPolicy,
) -> dict[str, str]:
    return {
        "expected_policy_sha256": policy.fingerprint(),
        "actual_dataset_trust_store_sha256": policy.dataset_trust_store_sha256,
        "actual_rights_verification_policy_sha256": (
            policy.rights_verification_policy_sha256
        ),
        "actual_verifier_source_tree_sha256": policy.verifier_source_tree_sha256,
        "trusted_launcher_deployment_artifact_sha256": (
            policy.deployment_artifact_sha256
        ),
        "actual_runtime_identity_sha256": policy.runtime_identity_sha256,
        "expected_governance_domain_id": policy.governance_domain_id,
        "verified_on": "2026-07-12",
    }


class DatasetManifestTrustTests(unittest.TestCase):
    def test_valid_current_manifest_attestation_verifies(self) -> None:
        store = _store()
        attestation = _attestation()

        self.assertIsNone(
            store.verify(
                dataset_id=DATASET_ID,
                manifest_sha256=MANIFEST_SHA256,
                attestation=attestation,
                verified_on="2026-07-12",
            )
        )
        self.assertRegex(store.fingerprint(), r"^[0-9a-f]{64}$")
        self.assertRegex(attestation.fingerprint(), r"^[0-9a-f]{64}$")

    def test_signature_forgery_and_signed_field_changes_fail_closed(self) -> None:
        with self.assertRaisesRegex(ReadinessTrustError, "signature is invalid") as caught:
            _store().verify(
                dataset_id=DATASET_ID,
                manifest_sha256=MANIFEST_SHA256,
                attestation=_attestation(private_key=OTHER_PRIVATE_KEY),
                verified_on="2026-07-12",
            )
        self.assertEqual(caught.exception.code, "DATASET_ATTESTATION_SIGNATURE")

        authentic = _attestation()
        changed_principal = replace(authentic, curator_id="dataset-curator-2")
        changed_key = _key(curator_id="dataset-curator-2")
        with self.assertRaisesRegex(ReadinessTrustError, "signature is invalid"):
            _store(keys=(changed_key,)).verify(
                dataset_id=DATASET_ID,
                manifest_sha256=MANIFEST_SHA256,
                attestation=changed_principal,
                verified_on="2026-07-12",
            )

    def test_attestation_must_name_exact_dataset_and_manifest(self) -> None:
        cases = (
            (
                {"dataset_id": "another-dataset"},
                "DATASET_ATTESTATION_DATASET",
                "requested dataset",
            ),
            (
                {"manifest_sha256": STALE_MANIFEST_SHA256},
                "DATASET_ATTESTATION_MANIFEST",
                "canonical manifest",
            ),
        )
        attestation = _attestation()
        for changes, code, message in cases:
            with self.subTest(code=code):
                with self.assertRaisesRegex(ReadinessTrustError, message) as caught:
                    _store().verify(
                        dataset_id=changes.get("dataset_id", DATASET_ID),
                        manifest_sha256=changes.get(
                            "manifest_sha256", MANIFEST_SHA256
                        ),
                        attestation=attestation,
                        verified_on="2026-07-12",
                    )
                self.assertEqual(caught.exception.code, code)

    def test_stale_revoked_and_untrusted_manifests_are_distinct(self) -> None:
        with self.assertRaisesRegex(ReadinessTrustError, "not current") as stale:
            _store(
                current_manifests=(
                    CurrentDatasetManifest(DATASET_ID, STALE_MANIFEST_SHA256),
                )
            ).verify(
                dataset_id=DATASET_ID,
                manifest_sha256=MANIFEST_SHA256,
                attestation=_attestation(),
                verified_on="2026-07-12",
            )
        self.assertEqual(stale.exception.code, "DATASET_MANIFEST_STALE")

        revoked_attestation = _attestation(
            manifest_sha256=REVOKED_MANIFEST_SHA256
        )
        with self.assertRaisesRegex(ReadinessTrustError, "revoked") as revoked:
            _store(
                current_manifests=(
                    CurrentDatasetManifest(DATASET_ID, STALE_MANIFEST_SHA256),
                ),
                revoked_manifest_sha256s=(REVOKED_MANIFEST_SHA256,),
            ).verify(
                dataset_id=DATASET_ID,
                manifest_sha256=REVOKED_MANIFEST_SHA256,
                attestation=revoked_attestation,
                verified_on="2026-07-12",
            )
        self.assertEqual(revoked.exception.code, "DATASET_MANIFEST_REVOKED")

        with self.assertRaisesRegex(ReadinessTrustError, "no current manifest") as missing:
            _store(current_manifests=()).verify(
                dataset_id=DATASET_ID,
                manifest_sha256=MANIFEST_SHA256,
                attestation=_attestation(),
                verified_on="2026-07-12",
            )
        self.assertEqual(missing.exception.code, "DATASET_MANIFEST_UNTRUSTED")

    def test_domain_key_and_curator_principal_are_bound(self) -> None:
        wrong_domain = _attestation(trust_domain_id="dataset-governance-dev")
        with self.assertRaisesRegex(ReadinessTrustError, "trust domain") as domain:
            _store().verify(
                dataset_id=DATASET_ID,
                manifest_sha256=MANIFEST_SHA256,
                attestation=wrong_domain,
                verified_on="2026-07-12",
            )
        self.assertEqual(domain.exception.code, "DATASET_ATTESTATION_DOMAIN")

        unknown_key = _attestation(key_id="dataset-key-missing")
        with self.assertRaisesRegex(ReadinessTrustError, "not in the pinned") as unknown:
            _store().verify(
                dataset_id=DATASET_ID,
                manifest_sha256=MANIFEST_SHA256,
                attestation=unknown_key,
                verified_on="2026-07-12",
            )
        self.assertEqual(unknown.exception.code, "DATASET_CURATOR_UNTRUSTED")

        with self.assertRaisesRegex(ReadinessTrustError, "trusted key principal") as principal:
            _store(keys=(_key(curator_id="dataset-curator-2"),)).verify(
                dataset_id=DATASET_ID,
                manifest_sha256=MANIFEST_SHA256,
                attestation=_attestation(),
                verified_on="2026-07-12",
            )
        self.assertEqual(principal.exception.code, "DATASET_CURATOR_MISMATCH")

    def test_signing_date_key_validity_and_retroactive_compromise(self) -> None:
        with self.assertRaisesRegex(ReadinessTrustError, "after the trusted") as future:
            _store().verify(
                dataset_id=DATASET_ID,
                manifest_sha256=MANIFEST_SHA256,
                attestation=_attestation(signed_on="2026-07-13"),
                verified_on="2026-07-12",
            )
        self.assertEqual(future.exception.code, "DATASET_ATTESTATION_DATE")

        for key, signed_on in (
            (_key(valid_from="2026-08-01"), "2026-07-11"),
            (_key(valid_until="2026-06-30"), "2026-07-11"),
        ):
            with self.subTest(key=key):
                with self.assertRaisesRegex(ReadinessTrustError, "not valid") as date_error:
                    _store(keys=(key,)).verify(
                        dataset_id=DATASET_ID,
                        manifest_sha256=MANIFEST_SHA256,
                        attestation=_attestation(signed_on=signed_on),
                        verified_on="2026-07-12",
                    )
                self.assertEqual(date_error.exception.code, "DATASET_CURATOR_KEY_DATE")

        compromised = _store(keys=(_key(compromised_on="2026-07-12"),))
        with self.assertRaisesRegex(ReadinessTrustError, "retroactively") as compromise:
            compromised.verify(
                dataset_id=DATASET_ID,
                manifest_sha256=MANIFEST_SHA256,
                attestation=_attestation(),
                verified_on="2026-07-12",
            )
        self.assertEqual(
            compromise.exception.code,
            "DATASET_CURATOR_KEY_COMPROMISED",
        )

        # A compromise scheduled for tomorrow does not rewrite today's result.
        self.assertIsNone(
            _store(keys=(_key(compromised_on="2026-07-13"),)).verify(
                dataset_id=DATASET_ID,
                manifest_sha256=MANIFEST_SHA256,
                attestation=_attestation(),
                verified_on="2026-07-12",
            )
        )

    def test_store_rejects_ambiguous_keys_current_mappings_and_revocations(self) -> None:
        second_key = _key(
            key_id="dataset-key-2",
            public_key_base64=base64.b64encode(
                OTHER_PRIVATE_KEY.public_key().public_bytes_raw()
            ).decode("ascii"),
        )
        with self.assertRaisesRegex(ValueError, "key IDs must be unique"):
            _store(keys=(_key(), replace(_key(), curator_id="another-curator")))
        with self.assertRaisesRegex(ValueError, "one public key"):
            _store(keys=(_key(), replace(second_key, public_key_base64=PUBLIC_KEY_BASE64)))
        with self.assertRaisesRegex(ValueError, "only one current"):
            _store(
                current_manifests=(
                    CurrentDatasetManifest(DATASET_ID, MANIFEST_SHA256),
                    CurrentDatasetManifest(DATASET_ID, STALE_MANIFEST_SHA256),
                )
            )
        with self.assertRaisesRegex(ValueError, "cannot contain duplicates"):
            _store(
                current_manifests=(),
                revoked_manifest_sha256s=(
                    REVOKED_MANIFEST_SHA256,
                    REVOKED_MANIFEST_SHA256,
                ),
            )
        with self.assertRaisesRegex(ValueError, "cannot also be current"):
            _store(revoked_manifest_sha256s=(MANIFEST_SHA256,))

    def test_canonical_store_is_order_independent_and_content_sensitive(self) -> None:
        other_hash = hashlib.sha256(b"other-current").hexdigest()
        other_revoked = hashlib.sha256(b"other-revoked").hexdigest()
        second_key = _key(
            key_id="dataset-key-2",
            curator_id="dataset-curator-2",
            public_key_base64=base64.b64encode(
                OTHER_PRIVATE_KEY.public_key().public_bytes_raw()
            ).decode("ascii"),
        )
        first = _store(
            keys=(_key(), second_key),
            current_manifests=(
                CurrentDatasetManifest(DATASET_ID, MANIFEST_SHA256),
                CurrentDatasetManifest("other-dataset", other_hash),
            ),
            revoked_manifest_sha256s=(REVOKED_MANIFEST_SHA256, other_revoked),
        )
        reordered = _store(
            keys=(second_key, _key()),
            current_manifests=tuple(reversed(first.current_manifests)),
            revoked_manifest_sha256s=tuple(reversed(first.revoked_manifest_sha256s)),
        )
        self.assertEqual(first.canonical_json(), reordered.canonical_json())
        self.assertEqual(first.fingerprint(), reordered.fingerprint())
        self.assertNotEqual(
            first.fingerprint(),
            replace(first, keyring_id="dataset-governance-backup").fingerprint(),
        )

    def test_attestation_and_trust_store_dict_parsers_are_exact(self) -> None:
        attestation = _attestation()
        store = _store()
        self.assertEqual(
            dataset_manifest_attestation_from_dict(attestation.to_canonical_dict()),
            attestation,
        )
        self.assertEqual(dataset_trust_store_from_dict(store.to_canonical_dict()), store)

        with self.assertRaisesRegex(ValueError, "unsupported fields"):
            dataset_manifest_attestation_from_dict(
                {**attestation.to_canonical_dict(), "trusted": True}
            )
        with self.assertRaisesRegex(ValueError, "missing fields"):
            payload = attestation.to_canonical_dict()
            del payload["curator_id"]
            dataset_manifest_attestation_from_dict(payload)
        with self.assertRaisesRegex(ValueError, "canonical base64"):
            dataset_manifest_attestation_from_dict(
                {**attestation.to_canonical_dict(), "signature_base64": "!!!!"}
            )
        with self.assertRaisesRegex(ValueError, "schema_version"):
            dataset_trust_store_from_dict(
                {**store.to_canonical_dict(), "schema_version": "2.0"}
            )

    def test_ascii_ids_dates_hashes_and_base64_are_strict(self) -> None:
        with self.assertRaisesRegex(ValueError, "ASCII stable ID"):
            replace(_attestation(), dataset_id="beach-völlèy")
        with self.assertRaisesRegex(ValueError, "lowercase SHA-256"):
            replace(_attestation(), manifest_sha256="A" * 64)
        with self.assertRaisesRegex(ValueError, "calendar date"):
            replace(_attestation(), signed_on="2026-7-1")
        with self.assertRaisesRegex(ValueError, "canonical base64"):
            replace(_attestation(), signature_base64="A" * 64)
        with self.assertRaisesRegex(ValueError, "valid_until cannot precede"):
            _key(valid_from="2026-02-01", valid_until="2026-01-31")

    def test_canonical_manifest_hash_is_stable_and_rejects_nonfinite_json(self) -> None:
        reordered = {
            "sources": MANIFEST["sources"],
            "dataset_id": DATASET_ID,
            "policy": MANIFEST["policy"],
        }
        self.assertEqual(
            canonical_manifest_sha256(MANIFEST),
            canonical_manifest_sha256(reordered),
        )
        self.assertEqual(
            MANIFEST_SHA256,
            hashlib.sha256(canonical_json_bytes(MANIFEST)).hexdigest(),
        )
        with self.assertRaisesRegex(ValueError, "finite UTF-8 JSON"):
            canonical_manifest_sha256({"bad": float("nan")})
        with self.assertRaisesRegex(ValueError, "root must be a mapping"):
            canonical_json_bytes(["not", "an", "object"])  # type: ignore[arg-type]


class ReadinessPolicyTests(unittest.TestCase):
    def test_every_independent_policy_pin_and_active_date_must_match(self) -> None:
        policy = _policy()
        arguments = _policy_pin_arguments(policy)
        self.assertIsNone(verify_readiness_policy_pins(policy, **arguments))

        mismatches = (
            (
                "expected_policy_sha256",
                "f" * 64,
                "READINESS_POLICY_UNPINNED",
            ),
            (
                "actual_dataset_trust_store_sha256",
                "f" * 64,
                "READINESS_DATASET_TRUST_STORE_PIN",
            ),
            (
                "actual_rights_verification_policy_sha256",
                "f" * 64,
                "READINESS_RIGHTS_POLICY_PIN",
            ),
            (
                "actual_verifier_source_tree_sha256",
                "f" * 64,
                "READINESS_VERIFIER_SOURCE_PIN",
            ),
            (
                "trusted_launcher_deployment_artifact_sha256",
                "f" * 64,
                "READINESS_DEPLOYMENT_ARTIFACT_PIN",
            ),
            (
                "actual_runtime_identity_sha256",
                "f" * 64,
                "READINESS_RUNTIME_IDENTITY_PIN",
            ),
            (
                "expected_governance_domain_id",
                "dataset-governance-dev",
                "READINESS_GOVERNANCE_DOMAIN",
            ),
        )
        for field, value, code in mismatches:
            with self.subTest(field=field):
                changed = {**arguments, field: value}
                with self.assertRaises(ReadinessTrustError) as caught:
                    verify_readiness_policy_pins(policy, **changed)
                self.assertEqual(caught.exception.code, code)

        for verified_on in ("2025-12-31", "2027-01-01"):
            with self.subTest(verified_on=verified_on):
                changed = {**arguments, "verified_on": verified_on}
                with self.assertRaises(ReadinessTrustError) as caught:
                    verify_readiness_policy_pins(policy, **changed)
                self.assertEqual(caught.exception.code, "READINESS_POLICY_DATE")

    def test_policy_validity_boundaries_are_inclusive(self) -> None:
        policy = _policy()
        for verified_on in (policy.valid_from, policy.valid_until):
            with self.subTest(verified_on=verified_on):
                arguments = {
                    **_policy_pin_arguments(policy),
                    "verified_on": verified_on,
                }
                self.assertIsNone(
                    verify_readiness_policy_pins(policy, **arguments)
                )

    def test_policy_requires_unseen_test_venue_true_and_all_explicit_pins(self) -> None:
        policy = _policy()
        with self.assertRaisesRegex(ValueError, "JSON boolean true"):
            replace(policy, require_unseen_test_venue=False)
        with self.assertRaisesRegex(ValueError, "JSON boolean true"):
            replace(policy, require_unseen_test_venue=1)  # type: ignore[arg-type]
        with self.assertRaisesRegex(ValueError, "valid_until cannot precede"):
            replace(policy, valid_from="2027-01-01")
        with self.assertRaises(TypeError):
            verify_readiness_policy_pins(policy)  # type: ignore[call-arg]

    def test_policy_parser_is_canonical_exact_and_content_sensitive(self) -> None:
        policy = _policy()
        self.assertEqual(
            readiness_verification_policy_from_dict(policy.to_canonical_dict()),
            policy,
        )
        self.assertEqual(
            policy.fingerprint(),
            hashlib.sha256(policy.canonical_json().encode("utf-8")).hexdigest(),
        )
        self.assertNotEqual(
            policy.fingerprint(),
            replace(policy, deployment_artifact_sha256="f" * 64).fingerprint(),
        )
        with self.assertRaisesRegex(ValueError, "unsupported fields"):
            readiness_verification_policy_from_dict(
                {**policy.to_canonical_dict(), "manifest_can_override": True}
            )
        with self.assertRaisesRegex(ValueError, "JSON boolean true"):
            readiness_verification_policy_from_dict(
                {**policy.to_canonical_dict(), "require_unseen_test_venue": "true"}
            )

    def test_protected_configuration_generation_is_canonical_and_exact(self) -> None:
        generation = _configuration_generation()
        self.assertEqual(
            protected_configuration_generation_from_dict(
                generation.to_canonical_dict()
            ),
            generation,
        )
        self.assertRegex(generation.fingerprint(), r"^[0-9a-f]{64}$")
        self.assertNotEqual(
            generation.fingerprint(),
            replace(
                generation,
                rights_trust_store_sha256="f" * 64,
            ).fingerprint(),
        )
        with self.assertRaisesRegex(ValueError, "unsupported fields"):
            protected_configuration_generation_from_dict(
                {**generation.to_canonical_dict(), "dataset_override": True}
            )
        with self.assertRaisesRegex(ValueError, "missing fields"):
            payload = generation.to_canonical_dict()
            del payload["governance_domain_id"]
            protected_configuration_generation_from_dict(payload)


class StrictReadinessTrustLoaderTests(unittest.TestCase):
    def test_regular_attestation_store_and_policy_files_round_trip(self) -> None:
        attestation = _attestation()
        store = _store()
        policy = _policy(store)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            attestation_path = root / "attestation.json"
            store_path = root / "store.json"
            policy_path = root / "policy.json"
            generation_path = root / "current-generation.json"
            attestation_path.write_text(attestation.canonical_json(), encoding="utf-8")
            store_path.write_text(store.canonical_json(), encoding="utf-8")
            policy_path.write_text(policy.canonical_json(), encoding="utf-8")
            generation = _configuration_generation(
                store=store,
                attestation=attestation,
                policy=policy,
            )
            generation_path.write_text(
                generation.canonical_json(),
                encoding="utf-8",
            )

            self.assertEqual(
                load_dataset_manifest_attestation(attestation_path),
                attestation,
            )
            self.assertEqual(load_dataset_trust_store(store_path), store)
            self.assertEqual(load_readiness_verification_policy(policy_path), policy)
            self.assertEqual(
                load_protected_configuration_generation(generation_path),
                generation,
            )

    def test_loaders_reject_duplicate_keys_invalid_utf8_and_nonobject_roots(self) -> None:
        store = _store()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            duplicate = root / "duplicate.json"
            duplicate.write_text(
                store.canonical_json().replace(
                    '"key_id":"dataset-key-1"',
                    '"key_id":"dataset-key-1","key_id":"hidden-key"',
                ),
                encoding="utf-8",
            )
            with self.assertRaisesRegex(ValueError, "duplicate JSON object key"):
                load_dataset_trust_store(duplicate)

            invalid_utf8 = root / "invalid-utf8.json"
            invalid_utf8.write_bytes(b'{"bad":"\xff"}')
            with self.assertRaisesRegex(ValueError, "valid UTF-8 JSON"):
                load_dataset_trust_store(invalid_utf8)

            array = root / "array.json"
            array.write_text("[]", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "root must be a JSON object"):
                load_dataset_trust_store(array)

    def test_loaders_reject_symlink_fifo_device_and_oversize_without_blocking(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            target = root / "store.json"
            target.write_text(_store().canonical_json(), encoding="utf-8")

            symlink = root / "symlink.json"
            symlink.symlink_to(target)
            with self.assertRaisesRegex(ValueError, "non-symlink regular file"):
                load_dataset_trust_store(symlink)

            oversize = root / "oversize.json"
            with oversize.open("wb") as output:
                output.truncate(4 * 1024 * 1024 + 1)
            with self.assertRaisesRegex(ValueError, "exceeds 4194304 bytes"):
                load_dataset_trust_store(oversize)

            if hasattr(os, "mkfifo"):
                fifo = root / "policy.fifo"
                os.mkfifo(fifo)
                started = time.monotonic()
                with self.assertRaisesRegex(ValueError, "non-symlink regular file"):
                    load_readiness_verification_policy(fifo)
                self.assertLess(time.monotonic() - started, 2.0)

            if Path("/dev/null").exists():
                started = time.monotonic()
                with self.assertRaisesRegex(ValueError, "non-symlink regular file"):
                    load_dataset_manifest_attestation(Path("/dev/null"))
                self.assertLess(time.monotonic() - started, 2.0)

    def test_descriptor_loader_detects_truncation_growth_and_mutation(self) -> None:
        raw = _store().canonical_json().encode("utf-8")
        real_read = os.read
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "store.json"

            path.write_bytes(raw)
            truncated = False

            def truncate_before_read(descriptor: int, count: int) -> bytes:
                nonlocal truncated
                if not truncated:
                    truncated = True
                    path.write_bytes(b"")
                return real_read(descriptor, count)

            with patch(
                "vision_scoring.readiness_trust.os.read",
                side_effect=truncate_before_read,
            ), self.assertRaisesRegex(ValueError, "truncated while reading"):
                load_dataset_trust_store(path)

            path.write_bytes(raw)
            grown = False

            def grow_after_read(descriptor: int, count: int) -> bytes:
                nonlocal grown
                chunk = real_read(descriptor, count)
                if not grown:
                    grown = True
                    with path.open("ab") as output:
                        output.write(b"x")
                        output.flush()
                        os.fsync(output.fileno())
                return chunk

            with patch(
                "vision_scoring.readiness_trust.os.read",
                side_effect=grow_after_read,
            ), self.assertRaisesRegex(ValueError, "grew while reading"):
                load_dataset_trust_store(path)

            path.write_bytes(raw)
            mutated = False

            def mutate_after_read(descriptor: int, count: int) -> bytes:
                nonlocal mutated
                chunk = real_read(descriptor, count)
                if not mutated:
                    mutated = True
                    with path.open("r+b") as output:
                        output.write(b"[")
                        output.flush()
                        os.fsync(output.fileno())
                return chunk

            with patch(
                "vision_scoring.readiness_trust.os.read",
                side_effect=mutate_after_read,
            ), self.assertRaisesRegex(ValueError, "changed while reading"):
                load_dataset_trust_store(path)

    def test_descriptor_loader_detects_path_replacement_before_and_during_read(self) -> None:
        raw = _store().canonical_json().encode("utf-8")
        real_open = os.open
        real_read = os.read
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / "store.json"
            displaced = root / "displaced.json"
            replacement = root / "replacement.json"
            path.write_bytes(raw)
            replacement.write_bytes(raw)
            replaced_before_open = False

            def replace_before_open(
                target: str | bytes | os.PathLike[str] | os.PathLike[bytes],
                flags: int,
                mode: int = 0o777,
                *,
                dir_fd: int | None = None,
            ) -> int:
                nonlocal replaced_before_open
                if not replaced_before_open and Path(target) == path:
                    replaced_before_open = True
                    os.replace(path, displaced)
                    os.replace(replacement, path)
                return real_open(target, flags, mode, dir_fd=dir_fd)

            with patch(
                "vision_scoring.readiness_trust.os.open",
                side_effect=replace_before_open,
            ), self.assertRaisesRegex(ValueError, "changed while opening"):
                load_dataset_trust_store(path)

            displaced.unlink()
            replaced_during_read = False

            def replace_after_read(descriptor: int, count: int) -> bytes:
                nonlocal replaced_during_read
                chunk = real_read(descriptor, count)
                if not replaced_during_read:
                    replaced_during_read = True
                    path.replace(displaced)
                    path.write_bytes(raw)
                return chunk

            with patch(
                "vision_scoring.readiness_trust.os.read",
                side_effect=replace_after_read,
            ), self.assertRaisesRegex(ValueError, "changed while reading"):
                load_dataset_trust_store(path)


if __name__ == "__main__":
    unittest.main()
