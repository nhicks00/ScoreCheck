from __future__ import annotations

import ast
import base64
from dataclasses import FrozenInstanceError, replace
import hashlib
import inspect
import json
import unittest

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

import vision_scoring.capture_assets as capture_assets_module
from vision_scoring.capture_assets import (
    AssetResidencyStatus,
    AudioProvenanceStatus,
    BoundaryAdmissibilityStatus,
    CaptureAssetError,
    CaptureAssetKeyRole,
    CaptureAssetTrustPolicy,
    CaptureReferenceStatus,
    CaptureSourceScope,
    ContentInspectionStatus,
    FINALIZED_CAPTURE_METADATA_SIGNING_DOMAIN,
    FinalizedAssetClaim,
    FinalizedCaptureMetadataAttestation,
    FinalizedCaptureMetadataTrustSnapshot,
    FinalizedSourceAssembly,
    FrameDerivationStatus,
    ReviewClipProvenance,
    STRUCTURALLY_VERIFIED_CAPTURE_METADATA_SCHEMA_VERSION,
    StructurallyVerifiedCaptureMetadata,
    TrustedCaptureMetadataSignerKey,
    CurrentFinalizedCaptureMetadata,
    build_video_only_review_clip_provenance,
    finalized_capture_metadata_signing_message,
    verify_capture_metadata_policy_binding,
    verify_finalized_capture_metadata_attestation,
    build_structurally_verified_capture_metadata,
)
from vision_scoring.capture_contracts import (
    CaptureBoundaryKind,
    CaptureFragmentDescriptor,
    CaptureFrameSignal,
    CaptureSessionDescriptor,
    CaptureSourceKind,
    CaptureStreamBoundary,
    CaptureTrustDomain,
    EvidenceWindowRequest,
    ExposurePolicy,
    FinalizedSourceFrameSignal,
    WindowRequestOrigin,
)
from vision_scoring.capture_integrity import ClockMappingCandidate
from vision_scoring.capture_rights import (
    CAPTURE_OPERATION_REQUIRED_USES,
    CaptureRightsKeyRole,
    CaptureRightsTrustSnapshot,
    CaptureSessionRightsGrant,
    CaptureSessionRightsGrantAttestation,
    CurrentCaptureSessionRightsGrant,
    TrustedCaptureRightsReviewerKey,
    capture_session_rights_grant_signing_message,
)
from vision_scoring.capture_windows import plan_evidence_window
from vision_scoring.rights import (
    ParticipantAgeStatus,
    PermittedUse,
    RightsBasis,
)


CAPTURE_KEY = Ed25519PrivateKey.from_private_bytes(b"\x61" * 32)
SOURCE_KEY = Ed25519PrivateKey.from_private_bytes(b"\x63" * 32)
RIGHTS_POLICY = "a" * 64
ROSTER = "b" * 64
RIGHTS_EVIDENCE = "c" * 64


def _public_base64(key: Ed25519PrivateKey) -> str:
    return base64.b64encode(key.public_key().public_bytes_raw()).decode("ascii")


def _capture_grant() -> CaptureSessionRightsGrant:
    return CaptureSessionRightsGrant(
        grant_id="grant-1",
        match_id="match-1",
        capture_session_id="capture-session-1",
        venue_id="venue-1",
        camera_ids=("camera-a",),
        roster_scope_sha256=ROSTER,
        participant_ids=(
            "participant-1",
            "participant-2",
            "participant-3",
            "participant-4",
        ),
        valid_from_ns=100,
        valid_until_ns=1_000,
        geography_scope=("US",),
        permitted_uses=CAPTURE_OPERATION_REQUIRED_USES,
        basis=RightsBasis.OWNED,
        owner_or_licensor="Fixture Capture Media LLC",
        license_id=None,
        participant_age_status=ParticipantAgeStatus.NO_MINORS,
        participant_release_sha256s=(),
        evidence_sha256s=(RIGHTS_EVIDENCE,),
        reviewer_id="capture-rights-reviewer",
        reviewed_at_ns=90,
        protected_policy_fingerprint=RIGHTS_POLICY,
        protected_policy_generation=7,
    )


def _capture_attestation(
    grant: CaptureSessionRightsGrant,
) -> CaptureSessionRightsGrantAttestation:
    role = CaptureRightsKeyRole.CAPTURE_SESSION_RIGHTS_GRANT_SIGNER
    signature = CAPTURE_KEY.sign(
        capture_session_rights_grant_signing_message(
            grant,
            key_id="capture-rights-key",
            key_role=role,
            trust_domain_id="capture-rights-domain",
            signed_at_ns=95,
        )
    )
    return CaptureSessionRightsGrantAttestation(
        grant_sha256=grant.fingerprint(),
        key_id="capture-rights-key",
        key_role=role,
        trust_domain_id="capture-rights-domain",
        signed_at_ns=95,
        signature_base64=base64.b64encode(signature).decode("ascii"),
    )


def _capture_snapshot(
    grant: CaptureSessionRightsGrant,
    *,
    revoked_key_at: int | None = None,
) -> CaptureRightsTrustSnapshot:
    return CaptureRightsTrustSnapshot(
        trust_domain_id="capture-rights-domain",
        protected_policy_fingerprint=RIGHTS_POLICY,
        protected_policy_generation=7,
        keys=(
            TrustedCaptureRightsReviewerKey(
                key_id="capture-rights-key",
                reviewer_id="capture-rights-reviewer",
                key_role=(
                    CaptureRightsKeyRole.CAPTURE_SESSION_RIGHTS_GRANT_SIGNER
                ),
                public_key_base64=_public_base64(CAPTURE_KEY),
                valid_from_ns=1,
                valid_until_ns=2_000,
                revoked_at_ns=revoked_key_at,
            ),
        ),
        current_grants=(
            CurrentCaptureSessionRightsGrant(
                grant_id=grant.grant_id,
                match_id=grant.match_id,
                capture_session_id=grant.capture_session_id,
                grant_sha256=grant.fingerprint(),
            ),
        ),
        revoked_grant_sha256s=(),
    )


def _fixture(*, device_timestamp_offset: int = 0) -> dict[str, object]:
    grant = _capture_grant()
    attestation = _capture_attestation(grant)
    snapshot = _capture_snapshot(grant)
    session = CaptureSessionDescriptor(
        source_kind=CaptureSourceKind.LIVE_CAMERA,
        trust_domain=CaptureTrustDomain.PRODUCTION_CAPTURE,
        deployment_id="deployment-1",
        session_id="capture-session-1",
        match_id="match-1",
        stream_id="stream-main",
        reconnect_epoch=0,
        expected_width=3840,
        expected_height=2160,
        fps_numerator=1,
        fps_denominator=1,
        capture_profile_sha256="1" * 64,
        backend_artifact_sha256="2" * 64,
        camera_attestation_sha256="3" * 64,
        clock_attestation_sha256="4" * 64,
        encoder_configuration_sha256="5" * 64,
        rights_grant_sha256=grant.fingerprint(),
        evidence_time_open_ns=0,
        exposure_policy=ExposurePolicy.MANUAL_LOCKED,
        exposure_configuration_sha256="6" * 64,
        locked_exposure_duration_ns=10_000_000,
        locked_gain_milli_db=100,
        locked_iso=200,
    )
    mapping = ClockMappingCandidate(
        session_fingerprint=session.fingerprint(),
        reconnect_epoch=0,
        trust_domain=CaptureTrustDomain.PRODUCTION_CAPTURE,
        clock_attestation_sha256=session.clock_attestation_sha256,
        device_anchor_timestamp=device_timestamp_offset,
        device_time_base_numerator=1,
        device_time_base_denominator=1,
        evidence_anchor_ns=0,
        rate_numerator=1,
        rate_denominator=1,
        valid_host_start_ns=0,
        valid_host_end_ns=3_000_000_000,
        claimed_max_absolute_error_ns=100,
    )
    frames = tuple(
        CaptureFrameSignal(
            session_fingerprint=session.fingerprint(),
            reconnect_epoch=0,
            observed_sequence=index,
            device_sequence=index,
            device_timestamp=device_timestamp_offset + index,
            device_time_base_numerator=1,
            device_time_base_denominator=1,
            host_monotonic_ns=index * 1_000_000_000,
            width=3840,
            height=2160,
            configuration_fingerprint=session.configuration_fingerprint,
            exposure_duration_ns=10_000_000,
            gain_milli_db=100,
            iso=200,
        )
        for index in range(3)
    )
    finalized_trace = tuple(
        FinalizedSourceFrameSignal(
            session_fingerprint=session.fingerprint(),
            reconnect_epoch=0,
            configuration_fingerprint=session.configuration_fingerprint,
            presentation_index=index,
            source_pts=device_timestamp_offset + index,
            source_time_base_numerator=1,
            source_time_base_denominator=1,
            mapped_evidence_timestamp_ns=index * 1_000_000_000,
            width=3840,
            height=2160,
            represented_in_output=True,
        )
        for index in range(3)
    )
    records = (
        CaptureStreamBoundary(
            session_fingerprint=session.fingerprint(),
            reconnect_epoch=0,
            at_observed_sequence=0,
            host_monotonic_ns=0,
            kind=CaptureBoundaryKind.START,
            configuration_fingerprint=session.configuration_fingerprint,
        ),
        *frames,
        CaptureStreamBoundary(
            session_fingerprint=session.fingerprint(),
            reconnect_epoch=0,
            at_observed_sequence=3,
            host_monotonic_ns=2_000_000_000,
            kind=CaptureBoundaryKind.STOP,
            configuration_fingerprint=session.configuration_fingerprint,
        ),
    )
    payloads = (b"fragment-zero", b"fragment-one")
    fragments = tuple(
        CaptureFragmentDescriptor(
            fragment_id=f"fragment-{index}",
            session_fingerprint=session.fingerprint(),
            session_configuration_fingerprint=session.configuration_fingerprint,
            reconnect_epoch=0,
            fragment_sequence=index,
            evidence_start_ns=index * 1_000_000_000,
            evidence_end_ns=(index + 1) * 1_000_000_000,
            device_start_timestamp=device_timestamp_offset + index,
            device_end_timestamp=device_timestamp_offset + index + 1,
            device_time_base_numerator=1,
            device_time_base_denominator=1,
            byte_length=len(payloads[index]),
            content_sha256=hashlib.sha256(payloads[index]).hexdigest(),
            frame_count=2 if index == 0 else 1,
            keyframe_at_start=index == 0,
            capture_profile_sha256=session.capture_profile_sha256,
            camera_fingerprint=session.camera_attestation_sha256,
            clock_fingerprint=mapping.fingerprint(),
            encoder_configuration_sha256=session.encoder_configuration_sha256,
            exposure_configuration_sha256=(
                session.exposure_configuration_sha256
            ),
        )
        for index in range(2)
    )
    request = EvidenceWindowRequest(
        request_id="window-request-1",
        idempotency_key="window:1",
        session_fingerprint=session.fingerprint(),
        expected_session_configuration_fingerprint=(
            session.configuration_fingerprint
        ),
        reconnect_epoch=0,
        trigger_evidence_time_ns=1_000_000_000,
        pre_roll_ns=1_000_000_000,
        post_roll_ns=1_000_000_000,
        origin=WindowRequestOrigin.HUMAN_REVIEW_TRIGGER,
        requested_at_ns=2_000_000_000,
    )
    plan = plan_evidence_window(request, fragments)
    asset_bytes = b"".join(payloads)
    claim = FinalizedAssetClaim(
        asset_id="source-asset-1",
        asset_sha256=hashlib.sha256(asset_bytes).hexdigest(),
        byte_length=len(asset_bytes),
        assembly=FinalizedSourceAssembly.ORDERED_SELECTED_FRAGMENT_CONCAT_V1,
    )
    scope = CaptureSourceScope(
        match_id=grant.match_id,
        capture_session_id=grant.capture_session_id,
        venue_id=grant.venue_id,
        camera_id="camera-a",
        camera_ids=grant.camera_ids,
        stream_id=session.stream_id,
        roster_scope_sha256=grant.roster_scope_sha256,
        participant_ids=grant.participant_ids,
        geography="US",
    )
    policy = CaptureAssetTrustPolicy(
        policy_id="capture-policy-1",
        policy_generation=11,
        trust_domain_id="capture-assets-production",
        valid_from_ns=1,
        valid_until_ns=2_000,
        deployment_id=session.deployment_id,
        match_id=scope.match_id,
        capture_session_id=scope.capture_session_id,
        venue_id=scope.venue_id,
        camera_id=scope.camera_id,
        stream_id=scope.stream_id,
        session_fingerprint=session.fingerprint(),
        session_configuration_fingerprint=session.configuration_fingerprint,
        camera_attestation_sha256=session.camera_attestation_sha256,
        clock_attestation_sha256=session.clock_attestation_sha256,
        clock_mapping_fingerprint=mapping.fingerprint(),
        capture_profile_sha256=session.capture_profile_sha256,
        backend_artifact_sha256=session.backend_artifact_sha256,
        encoder_configuration_sha256=session.encoder_configuration_sha256,
        exposure_configuration_sha256=session.exposure_configuration_sha256,
        max_clock_absolute_error_ns=1_000,
    )
    return {
        "metadata_id": "trusted-source-1",
        "scope": scope,
        "asset_claim": claim,
        "selected_fragment_payloads": payloads,
        "session": session,
        "clock_mapping": mapping,
        "records": records,
        "finalized_trace": finalized_trace,
        "window_request": request,
        "fragment_projection": fragments,
        "committed_window_plan": plan,
        "capture_policy": policy,
        "expected_capture_policy_sha256": policy.fingerprint(),
        "expected_capture_policy_generation": policy.policy_generation,
        "capture_rights_grant": grant,
        "capture_rights_attestation": attestation,
        "capture_rights_trust_snapshot": snapshot,
        "expected_capture_rights_trust_snapshot_sha256": snapshot.fingerprint(),
        "expected_rights_policy_sha256": RIGHTS_POLICY,
        "expected_rights_policy_generation": 7,
        "verified_at_ns": 300,
    }


def _review_arguments(
    source: StructurallyVerifiedCaptureMetadata,
    fixture: dict[str, object],
) -> dict[str, object]:
    capture_metadata_attestation = _capture_metadata_attestation(source)
    capture_metadata_trust_snapshot = _capture_metadata_trust_snapshot(source)
    return {
        "clip_id": "review-clip-1",
        "clip_bytes": b"synthetic-container-bytes",
        "capture_metadata": source,
        "finalized_trace": fixture["finalized_trace"],
        "declared_decoder_contract_sha256": "7" * 64,
        "declared_render_profile_sha256": "8" * 64,
        "declared_renderer_runtime_sha256": "9" * 64,
        "intended_uses": CAPTURE_OPERATION_REQUIRED_USES,
        "capture_metadata_attestation": capture_metadata_attestation,
        "capture_metadata_trust_snapshot": capture_metadata_trust_snapshot,
        "expected_capture_metadata_trust_snapshot_sha256": (
            capture_metadata_trust_snapshot.fingerprint()
        ),
        "capture_policy": fixture["capture_policy"],
        "expected_capture_policy_sha256": fixture[
            "expected_capture_policy_sha256"
        ],
        "expected_capture_policy_generation": fixture[
            "expected_capture_policy_generation"
        ],
        "capture_rights_grant": fixture["capture_rights_grant"],
        "capture_rights_attestation": fixture["capture_rights_attestation"],
        "capture_rights_trust_snapshot": fixture[
            "capture_rights_trust_snapshot"
        ],
        "expected_capture_rights_trust_snapshot_sha256": fixture[
            "expected_capture_rights_trust_snapshot_sha256"
        ],
        "expected_rights_policy_sha256": RIGHTS_POLICY,
        "expected_rights_policy_generation": 7,
        "rights_reverified_at_ns": 400,
    }


def _capture_metadata_attestation(
    source: StructurallyVerifiedCaptureMetadata,
    *,
    private_key: Ed25519PrivateKey = SOURCE_KEY,
    key_id: str = "source-key",
    trust_domain_id: str = "source-trust-domain",
    signed_at_ns: int = 350,
) -> FinalizedCaptureMetadataAttestation:
    role = CaptureAssetKeyRole.FINALIZED_CAPTURE_METADATA_SIGNER
    signature = private_key.sign(
        finalized_capture_metadata_signing_message(
            source,
            key_id=key_id,
            key_role=role,
            trust_domain_id=trust_domain_id,
            signed_at_ns=signed_at_ns,
        )
    )
    return FinalizedCaptureMetadataAttestation(
        metadata_sha256=source.fingerprint(),
        key_id=key_id,
        key_role=role,
        trust_domain_id=trust_domain_id,
        signed_at_ns=signed_at_ns,
        signature_base64=base64.b64encode(signature).decode("ascii"),
    )


def _capture_metadata_trust_snapshot(
    source: StructurallyVerifiedCaptureMetadata,
    *,
    private_key: Ed25519PrivateKey = SOURCE_KEY,
    key_id: str = "source-key",
    trust_domain_id: str = "source-trust-domain",
    revoked_at_ns: int | None = None,
    current_source: CurrentFinalizedCaptureMetadata | None = None,
    revoked_metadata_sha256s: tuple[str, ...] = (),
) -> FinalizedCaptureMetadataTrustSnapshot:
    return FinalizedCaptureMetadataTrustSnapshot(
        trust_domain_id=trust_domain_id,
        capture_policy_sha256=source.capture_policy_sha256,
        capture_policy_generation=source.capture_policy_generation,
        keys=(
            TrustedCaptureMetadataSignerKey(
                key_id=key_id,
                key_role=CaptureAssetKeyRole.FINALIZED_CAPTURE_METADATA_SIGNER,
                public_key_base64=_public_base64(private_key),
                valid_from_ns=1,
                valid_until_ns=2_000,
                revoked_at_ns=revoked_at_ns,
            ),
        ),
        current_metadata=(
            current_source
            if current_source is not None
            else CurrentFinalizedCaptureMetadata(
                metadata_id=source.metadata_id,
                asset_sha256=source.asset_sha256,
                metadata_sha256=source.fingerprint(),
            ),
        ),
        revoked_metadata_sha256s=revoked_metadata_sha256s,
    )


class StructurallyVerifiedCaptureMetadataTests(unittest.TestCase):
    def test_exact_source_rechecks_plan_trace_bytes_rights_and_policy(self) -> None:
        fixture = _fixture()
        source = build_structurally_verified_capture_metadata(**fixture)  # type: ignore[arg-type]
        self.assertEqual(
            source.asset_sha256,
            hashlib.sha256(b"fragment-zerofragment-one").hexdigest(),
        )
        self.assertEqual(source.frame_count, 3)
        self.assertEqual(source.requested_start_ns, 0)
        self.assertEqual(source.requested_end_ns, 2_000_000_000)
        self.assertEqual(source.evidence_end_ns, 2_000_000_000)
        session = fixture["session"]
        assert type(session) is CaptureSessionDescriptor
        self.assertEqual(
            source.capture_profile_sha256,
            session.capture_profile_sha256,
        )
        self.assertEqual(
            source.encoder_configuration_sha256,
            session.encoder_configuration_sha256,
        )
        self.assertEqual(
            source.schema_version,
            STRUCTURALLY_VERIFIED_CAPTURE_METADATA_SCHEMA_VERSION,
        )
        self.assertEqual(
            source.content_inspection_status,
            ContentInspectionStatus.NOT_INSPECTED,
        )
        self.assertEqual(
            source.audio_provenance_status,
            AudioProvenanceStatus.ABSENT_FROM_CONTRACT_NOT_INSPECTED,
        )
        self.assertEqual(
            source.capture_reference_status,
            CaptureReferenceStatus.PINNED_SERVICE_REFERENCES_NOT_ATTESTATION_VERIFIED,
        )
        self.assertEqual(
            source.asset_residency_status,
            AssetResidencyStatus.NOT_VERIFIED,
        )
        self.assertEqual(
            source.admissibility_status,
            BoundaryAdmissibilityStatus.NOT_ADMISSIBLE_PENDING_CAPTURE_SEGMENT_AND_MEDIA_VALIDATION,
        )
        self.assertFalse(source.admissible_for_live_scorecheck_presentation)
        self.assertFalse(source.admissible_for_training)
        self.assertFalse(source.admissible_for_evaluation)
        self.assertFalse(source.admissible_for_deployment)
        self.assertEqual(
            StructurallyVerifiedCaptureMetadata.from_json_bytes(source.to_json_bytes()),
            source,
        )

    def test_capture_profile_and_encoder_are_typed_session_policy_bindings(
        self,
    ) -> None:
        fixture = _fixture()
        session = fixture["session"]
        policy = fixture["capture_policy"]
        assert type(session) is CaptureSessionDescriptor
        assert type(policy) is CaptureAssetTrustPolicy
        source = build_structurally_verified_capture_metadata(
            **fixture  # type: ignore[arg-type]
        )

        builder_parameters = inspect.signature(
            build_structurally_verified_capture_metadata
        ).parameters
        self.assertNotIn("capture_profile_sha256", builder_parameters)
        self.assertNotIn("encoder_configuration_sha256", builder_parameters)
        self.assertEqual(
            source.capture_profile_sha256,
            session.capture_profile_sha256,
        )
        self.assertEqual(
            source.encoder_configuration_sha256,
            session.encoder_configuration_sha256,
        )

        for field_name, replacement_digest in (
            ("capture_profile_sha256", "d" * 64),
            ("encoder_configuration_sha256", "e" * 64),
        ):
            with self.subTest(metadata_field=field_name):
                substituted = replace(source, **{field_name: replacement_digest})
                with self.assertRaises(CaptureAssetError) as caught:
                    verify_capture_metadata_policy_binding(substituted, policy)
                self.assertEqual(caught.exception.code, "CAPTURE_POLICY_SCOPE")

            with self.subTest(policy_field=field_name):
                substituted_policy = replace(
                    policy,
                    **{field_name: replacement_digest},
                )
                with self.assertRaises(CaptureAssetError) as caught:
                    verify_capture_metadata_policy_binding(
                        source,
                        substituted_policy,
                    )
                self.assertEqual(caught.exception.code, "CAPTURE_POLICY_SCOPE")

        swapped = replace(
            source,
            capture_profile_sha256=source.encoder_configuration_sha256,
            encoder_configuration_sha256=source.capture_profile_sha256,
        )
        with self.assertRaises(CaptureAssetError) as caught:
            verify_capture_metadata_policy_binding(swapped, policy)
        self.assertEqual(caught.exception.code, "CAPTURE_POLICY_SCOPE")

    def test_capture_profile_and_encoder_reject_typed_digest_aliases(self) -> None:
        fixture = _fixture()
        source = build_structurally_verified_capture_metadata(
            **fixture  # type: ignore[arg-type]
        )
        for field_name, alias_digest in (
            ("capture_profile_sha256", source.encoder_configuration_sha256),
            ("capture_profile_sha256", source.session_fingerprint),
            (
                "encoder_configuration_sha256",
                source.session_configuration_fingerprint,
            ),
        ):
            with self.subTest(field_name=field_name, alias_digest=alias_digest):
                with self.assertRaisesRegex(ValueError, "must be distinct"):
                    replace(source, **{field_name: alias_digest})

    def test_metadata_v2_wire_and_signing_domain_have_no_v1_alias(self) -> None:
        fixture = _fixture()
        source = build_structurally_verified_capture_metadata(
            **fixture  # type: ignore[arg-type]
        )
        with self.assertRaisesRegex(ValueError, "unsupported.*schema"):
            replace(source, schema_version="1.0")
        message = finalized_capture_metadata_signing_message(
            source,
            key_id="source-key",
            key_role=CaptureAssetKeyRole.FINALIZED_CAPTURE_METADATA_SIGNER,
            trust_domain_id="source-trust-domain",
            signed_at_ns=350,
        )
        decoded = json.loads(message)
        self.assertEqual(
            decoded["domain"],
            FINALIZED_CAPTURE_METADATA_SIGNING_DOMAIN,
        )
        self.assertTrue(decoded["domain"].endswith(":v2"))
        self.assertEqual(
            decoded["capture_metadata"]["capture_profile_sha256"],
            source.capture_profile_sha256,
        )
        self.assertEqual(
            decoded["capture_metadata"]["encoder_configuration_sha256"],
            source.encoder_configuration_sha256,
        )

    def test_fragment_hash_size_and_order_substitution_fail_closed(self) -> None:
        for payloads, expected_code in (
            ((b"fragment-ZERO", b"fragment-one"), "CAPTURE_FRAGMENT_HASH"),
            ((b"fragment-xxx", b"fragment-one"), "CAPTURE_FRAGMENT_SIZE"),
            ((b"fragment-one", b"fragment-zero"), "CAPTURE_FRAGMENT_SIZE"),
        ):
            fixture = _fixture()
            fixture["selected_fragment_payloads"] = payloads
            with self.subTest(expected_code=expected_code), self.assertRaises(
                CaptureAssetError
            ) as caught:
                build_structurally_verified_capture_metadata(**fixture)  # type: ignore[arg-type]
            self.assertEqual(caught.exception.code, expected_code)

    def test_asset_claim_and_committed_plan_tampering_fail_closed(self) -> None:
        fixture = _fixture()
        claim = fixture["asset_claim"]
        assert type(claim) is FinalizedAssetClaim
        fixture["asset_claim"] = replace(claim, asset_sha256="f" * 64)
        with self.assertRaises(CaptureAssetError) as caught:
            build_structurally_verified_capture_metadata(**fixture)  # type: ignore[arg-type]
        self.assertEqual(caught.exception.code, "CAPTURE_ASSET_IDENTITY")

        fixture = _fixture()
        plan = fixture["committed_window_plan"]
        fixture["committed_window_plan"] = replace(plan, request_fingerprint="f" * 64)
        with self.assertRaises(CaptureAssetError) as caught:
            build_structurally_verified_capture_metadata(**fixture)  # type: ignore[arg-type]
        self.assertEqual(caught.exception.code, "CAPTURE_WINDOW_PLAN_MISMATCH")

    def test_structural_evaluator_is_rerun_over_exact_trace(self) -> None:
        fixture = _fixture()
        records = fixture["records"]
        assert type(records) is tuple
        bad_frame = replace(records[2], observed_sequence=0)
        fixture["records"] = (records[0], records[1], bad_frame, *records[3:])
        with self.assertRaises(CaptureAssetError) as caught:
            build_structurally_verified_capture_metadata(**fixture)  # type: ignore[arg-type]
        self.assertEqual(caught.exception.code, "CAPTURE_INTEGRITY")

    def test_requested_context_may_not_be_silently_shortened(self) -> None:
        fixture = _fixture()
        fragments = fixture["fragment_projection"]
        assert type(fragments) is tuple
        shortened_fragments = (
            replace(fragments[0], frame_count=1),
            replace(fragments[1], frame_count=1),
        )
        request = fixture["window_request"]
        fixture["fragment_projection"] = shortened_fragments
        fixture["committed_window_plan"] = plan_evidence_window(
            request, shortened_fragments
        )
        records = fixture["records"]
        finalized = fixture["finalized_trace"]
        fixture["records"] = (
            records[0],
            records[1],
            records[2],
            replace(records[-1], at_observed_sequence=2),
        )
        fixture["finalized_trace"] = finalized[:2]
        with self.assertRaises(CaptureAssetError) as caught:
            build_structurally_verified_capture_metadata(**fixture)  # type: ignore[arg-type]
        self.assertEqual(caught.exception.code, "CAPTURE_CONTEXT_SHORTENED")

    def test_policy_pin_clock_error_and_session_scope_are_protected(self) -> None:
        fixture = _fixture()
        fixture["expected_capture_policy_sha256"] = "f" * 64
        with self.assertRaises(CaptureAssetError) as caught:
            build_structurally_verified_capture_metadata(**fixture)  # type: ignore[arg-type]
        self.assertEqual(caught.exception.code, "CAPTURE_POLICY_PIN")

        fixture = _fixture()
        policy = fixture["capture_policy"]
        fixture["capture_policy"] = replace(
            policy, max_clock_absolute_error_ns=99
        )
        fixture["expected_capture_policy_sha256"] = fixture[
            "capture_policy"
        ].fingerprint()
        with self.assertRaises(CaptureAssetError) as caught:
            build_structurally_verified_capture_metadata(**fixture)  # type: ignore[arg-type]
        self.assertEqual(caught.exception.code, "CAPTURE_CLOCK_ERROR_BOUND")

    def test_current_capture_rights_are_verified_not_copied(self) -> None:
        fixture = _fixture()
        grant = fixture["capture_rights_grant"]
        revoked = _capture_snapshot(grant, revoked_key_at=250)
        fixture["capture_rights_trust_snapshot"] = revoked
        fixture["expected_capture_rights_trust_snapshot_sha256"] = (
            revoked.fingerprint()
        )
        with self.assertRaisesRegex(ValueError, "CAPTURE_RIGHTS_KEY_REVOKED"):
            build_structurally_verified_capture_metadata(**fixture)  # type: ignore[arg-type]

    def test_public_contracts_are_frozen_strict_and_bounded(self) -> None:
        fixture = _fixture()
        scope = fixture["scope"]
        policy = fixture["capture_policy"]
        claim = fixture["asset_claim"]
        self.assertEqual(
            CaptureSourceScope.from_json_bytes(scope.to_json_bytes()), scope
        )
        self.assertEqual(
            CaptureAssetTrustPolicy.from_json_bytes(policy.to_json_bytes()), policy
        )
        self.assertEqual(
            FinalizedAssetClaim.from_json_bytes(claim.to_json_bytes()), claim
        )
        with self.assertRaises(FrozenInstanceError):
            scope.match_id = "other"  # type: ignore[misc]
        duplicate = scope.to_json_bytes()[:-1] + b',"match_id":"other"}'
        with self.assertRaises(CaptureAssetError) as caught:
            CaptureSourceScope.from_json_bytes(duplicate)
        self.assertEqual(caught.exception.code, "DUPLICATE_JSON_KEY")
        with self.assertRaises(CaptureAssetError) as caught:
            CaptureSourceScope.from_json_bytes(b" " + scope.to_json_bytes())
        self.assertEqual(caught.exception.code, "NONCANONICAL_JSON")
        deeply_nested = b'{"x":' + b"[" * 1_000 + b"0" + b"]" * 1_000 + b"}"
        with self.assertRaises(CaptureAssetError) as caught:
            CaptureSourceScope.from_json_bytes(deeply_nested)
        self.assertEqual(caught.exception.code, "JSON_DEPTH_EXCEEDED")

    def test_durable_source_rejects_scope_or_asset_claim_split_brain(self) -> None:
        fixture = _fixture()
        source = build_structurally_verified_capture_metadata(**fixture)  # type: ignore[arg-type]
        with self.assertRaisesRegex(ValueError, "scope_fingerprint"):
            replace(source, match_id="match-other")
        with self.assertRaisesRegex(ValueError, "asset_claim_sha256"):
            replace(source, asset_id="different-asset-id")
        with self.assertRaisesRegex(ValueError, "not admissible"):
            replace(
                source,
                admissibility_status=(
                    BoundaryAdmissibilityStatus.NOT_ADMISSIBLE_PENDING_RENDERER_DECODER_AND_RESIDENCY_VALIDATION
                ),
            )

    def test_signed_negative_source_pts_round_trip_without_identity_loss(self) -> None:
        fixture = _fixture(device_timestamp_offset=-2)
        negative = build_structurally_verified_capture_metadata(
            **fixture  # type: ignore[arg-type]
        )
        self.assertEqual(negative.source_start_pts, -2)
        self.assertEqual(negative.source_end_pts, 0)
        self.assertEqual(
            StructurallyVerifiedCaptureMetadata.from_json_bytes(negative.to_json_bytes()),
            negative,
        )


class CaptureMetadataAttestationTests(unittest.TestCase):
    def test_current_domain_separated_capture_metadata_attestation_verifies_and_round_trips(self) -> None:
        fixture = _fixture()
        source = build_structurally_verified_capture_metadata(**fixture)  # type: ignore[arg-type]
        attestation = _capture_metadata_attestation(source)
        snapshot = _capture_metadata_trust_snapshot(source)
        verified = verify_finalized_capture_metadata_attestation(
            source,
            attestation,
            snapshot,
            capture_rights_trust_snapshot=fixture[
                "capture_rights_trust_snapshot"
            ],
            expected_capture_rights_trust_snapshot_sha256=fixture[
                "expected_capture_rights_trust_snapshot_sha256"
            ],
            expected_trust_snapshot_sha256=snapshot.fingerprint(),
            expected_capture_policy_sha256=source.capture_policy_sha256,
            expected_capture_policy_generation=source.capture_policy_generation,
            verified_at_ns=400,
        )
        self.assertIs(verified, source)
        self.assertEqual(
            FinalizedCaptureMetadataAttestation.from_json_bytes(
                attestation.to_json_bytes()
            ),
            attestation,
        )
        self.assertEqual(
            FinalizedCaptureMetadataTrustSnapshot.from_json_bytes(
                snapshot.to_json_bytes()
            ),
            snapshot,
        )

    def test_capture_metadata_and_session_rights_signer_keys_cannot_overlap(self) -> None:
        fixture = _fixture()
        capture_metadata = build_structurally_verified_capture_metadata(
            **fixture  # type: ignore[arg-type]
        )
        attestation = _capture_metadata_attestation(
            capture_metadata,
            private_key=CAPTURE_KEY,
        )
        snapshot = _capture_metadata_trust_snapshot(
            capture_metadata,
            private_key=CAPTURE_KEY,
        )
        with self.assertRaises(CaptureAssetError) as caught:
            verify_finalized_capture_metadata_attestation(
                capture_metadata,
                attestation,
                snapshot,
                capture_rights_trust_snapshot=fixture[
                    "capture_rights_trust_snapshot"
                ],
                expected_capture_rights_trust_snapshot_sha256=fixture[
                    "expected_capture_rights_trust_snapshot_sha256"
                ],
                expected_trust_snapshot_sha256=snapshot.fingerprint(),
                expected_capture_policy_sha256=(
                    capture_metadata.capture_policy_sha256
                ),
                expected_capture_policy_generation=(
                    capture_metadata.capture_policy_generation
                ),
                verified_at_ns=400,
            )
        self.assertEqual(
            caught.exception.code,
            "CAPTURE_METADATA_KEY_DOMAIN_OVERLAP",
        )

    def test_current_metadata_cannot_alias_one_asset_under_multiple_ids(self) -> None:
        fixture = _fixture()
        capture_metadata = build_structurally_verified_capture_metadata(
            **fixture  # type: ignore[arg-type]
        )
        first = CurrentFinalizedCaptureMetadata(
            metadata_id=capture_metadata.metadata_id,
            asset_sha256=capture_metadata.asset_sha256,
            metadata_sha256=capture_metadata.fingerprint(),
        )
        second = CurrentFinalizedCaptureMetadata(
            metadata_id="metadata-alias",
            asset_sha256=capture_metadata.asset_sha256,
            metadata_sha256="f" * 64,
        )
        with self.assertRaisesRegex(ValueError, "multiple metadata IDs"):
            FinalizedCaptureMetadataTrustSnapshot(
                trust_domain_id="source-trust-domain",
                capture_policy_sha256=capture_metadata.capture_policy_sha256,
                capture_policy_generation=capture_metadata.capture_policy_generation,
                keys=(
                    TrustedCaptureMetadataSignerKey(
                        key_id="source-key",
                        key_role=(
                            CaptureAssetKeyRole.FINALIZED_CAPTURE_METADATA_SIGNER
                        ),
                        public_key_base64=_public_base64(SOURCE_KEY),
                        valid_from_ns=1,
                        valid_until_ns=2_000,
                        revoked_at_ns=None,
                    ),
                ),
                current_metadata=(second, first),
                revoked_metadata_sha256s=(),
            )

    def test_direct_payload_signature_is_not_a_domain_separated_attestation(self) -> None:
        fixture = _fixture()
        source = build_structurally_verified_capture_metadata(**fixture)  # type: ignore[arg-type]
        forged = replace(
            _capture_metadata_attestation(source),
            signature_base64=base64.b64encode(
                SOURCE_KEY.sign(source.to_json_bytes())
            ).decode("ascii"),
        )
        snapshot = _capture_metadata_trust_snapshot(source)
        with self.assertRaises(CaptureAssetError) as caught:
            verify_finalized_capture_metadata_attestation(
                source,
                forged,
                snapshot,
                capture_rights_trust_snapshot=fixture[
                    "capture_rights_trust_snapshot"
                ],
                expected_capture_rights_trust_snapshot_sha256=fixture[
                    "expected_capture_rights_trust_snapshot_sha256"
                ],
                expected_trust_snapshot_sha256=snapshot.fingerprint(),
                expected_capture_policy_sha256=source.capture_policy_sha256,
                expected_capture_policy_generation=source.capture_policy_generation,
                verified_at_ns=400,
            )
        self.assertEqual(caught.exception.code, "CAPTURE_METADATA_SIGNATURE")

    def test_source_key_and_source_revocations_are_current_at_use_time(self) -> None:
        fixture = _fixture()
        source = build_structurally_verified_capture_metadata(**fixture)  # type: ignore[arg-type]
        attestation = _capture_metadata_attestation(source)
        key_revoked = _capture_metadata_trust_snapshot(source, revoked_at_ns=399)
        with self.assertRaises(CaptureAssetError) as caught:
            verify_finalized_capture_metadata_attestation(
                source,
                attestation,
                key_revoked,
                capture_rights_trust_snapshot=fixture[
                    "capture_rights_trust_snapshot"
                ],
                expected_capture_rights_trust_snapshot_sha256=fixture[
                    "expected_capture_rights_trust_snapshot_sha256"
                ],
                expected_trust_snapshot_sha256=key_revoked.fingerprint(),
                expected_capture_policy_sha256=source.capture_policy_sha256,
                expected_capture_policy_generation=source.capture_policy_generation,
                verified_at_ns=400,
            )
        self.assertEqual(caught.exception.code, "CAPTURE_METADATA_KEY_REVOKED")

        replacement = CurrentFinalizedCaptureMetadata(
            metadata_id=source.metadata_id,
            asset_sha256="e" * 64,
            metadata_sha256="f" * 64,
        )
        source_revoked = _capture_metadata_trust_snapshot(
            source,
            current_source=replacement,
            revoked_metadata_sha256s=(source.fingerprint(),),
        )
        with self.assertRaises(CaptureAssetError) as caught:
            verify_finalized_capture_metadata_attestation(
                source,
                attestation,
                source_revoked,
                capture_rights_trust_snapshot=fixture[
                    "capture_rights_trust_snapshot"
                ],
                expected_capture_rights_trust_snapshot_sha256=fixture[
                    "expected_capture_rights_trust_snapshot_sha256"
                ],
                expected_trust_snapshot_sha256=source_revoked.fingerprint(),
                expected_capture_policy_sha256=source.capture_policy_sha256,
                expected_capture_policy_generation=source.capture_policy_generation,
                verified_at_ns=400,
            )
        self.assertEqual(caught.exception.code, "CAPTURE_METADATA_REVOKED")

    def test_source_trust_pin_and_current_record_fail_closed(self) -> None:
        fixture = _fixture()
        source = build_structurally_verified_capture_metadata(**fixture)  # type: ignore[arg-type]
        attestation = _capture_metadata_attestation(source)
        snapshot = _capture_metadata_trust_snapshot(source)
        with self.assertRaises(CaptureAssetError) as caught:
            verify_finalized_capture_metadata_attestation(
                source,
                attestation,
                snapshot,
                capture_rights_trust_snapshot=fixture[
                    "capture_rights_trust_snapshot"
                ],
                expected_capture_rights_trust_snapshot_sha256=fixture[
                    "expected_capture_rights_trust_snapshot_sha256"
                ],
                expected_trust_snapshot_sha256="f" * 64,
                expected_capture_policy_sha256=source.capture_policy_sha256,
                expected_capture_policy_generation=source.capture_policy_generation,
                verified_at_ns=400,
            )
        self.assertEqual(caught.exception.code, "CAPTURE_METADATA_TRUST_PIN")

        with self.assertRaises(CaptureAssetError) as caught:
            verify_finalized_capture_metadata_attestation(
                source,
                attestation,
                snapshot,
                capture_rights_trust_snapshot=fixture[
                    "capture_rights_trust_snapshot"
                ],
                expected_capture_rights_trust_snapshot_sha256="f" * 64,
                expected_trust_snapshot_sha256=snapshot.fingerprint(),
                expected_capture_policy_sha256=source.capture_policy_sha256,
                expected_capture_policy_generation=source.capture_policy_generation,
                verified_at_ns=400,
            )
        self.assertEqual(
            caught.exception.code,
            "CAPTURE_METADATA_RIGHTS_TRUST_PIN",
        )

        stale = _capture_metadata_trust_snapshot(
            source,
            current_source=CurrentFinalizedCaptureMetadata(
                metadata_id=source.metadata_id,
                asset_sha256="e" * 64,
                metadata_sha256="f" * 64,
            ),
        )
        with self.assertRaises(CaptureAssetError) as caught:
            verify_finalized_capture_metadata_attestation(
                source,
                attestation,
                stale,
                capture_rights_trust_snapshot=fixture[
                    "capture_rights_trust_snapshot"
                ],
                expected_capture_rights_trust_snapshot_sha256=fixture[
                    "expected_capture_rights_trust_snapshot_sha256"
                ],
                expected_trust_snapshot_sha256=stale.fingerprint(),
                expected_capture_policy_sha256=source.capture_policy_sha256,
                expected_capture_policy_generation=source.capture_policy_generation,
                verified_at_ns=400,
            )
        self.assertEqual(caught.exception.code, "CAPTURE_METADATA_STALE")


class ReviewClipProvenanceTests(unittest.TestCase):
    def test_operational_review_binds_exact_bytes_and_source_frame_identity(self) -> None:
        fixture = _fixture()
        source = build_structurally_verified_capture_metadata(**fixture)  # type: ignore[arg-type]
        arguments = _review_arguments(source, fixture)
        provenance = build_video_only_review_clip_provenance(
            **arguments  # type: ignore[arg-type]
        )
        self.assertEqual(
            provenance.clip_sha256,
            hashlib.sha256(arguments["clip_bytes"]).hexdigest(),
        )
        self.assertEqual(
            tuple(frame.source_presentation_index for frame in provenance.frame_refs),
            (0, 1, 2),
        )
        self.assertEqual(
            provenance.frame_derivation_status,
            FrameDerivationStatus.NOT_VERIFIED_AGAINST_CLIP_BYTES,
        )
        self.assertFalse(provenance.admissible_for_live_scorecheck_presentation)
        self.assertFalse(provenance.admissible_for_training)
        self.assertFalse(provenance.admissible_for_evaluation)
        self.assertFalse(provenance.admissible_for_deployment)
        self.assertEqual(
            ReviewClipProvenance.from_json_bytes(provenance.to_json_bytes()),
            provenance,
        )

    def test_review_rejects_substituted_trace_and_revoked_operational_rights(self) -> None:
        fixture = _fixture()
        source = build_structurally_verified_capture_metadata(**fixture)  # type: ignore[arg-type]
        arguments = _review_arguments(source, fixture)
        trace = arguments["finalized_trace"]
        arguments["finalized_trace"] = (
            trace[0],
            replace(trace[1], source_pts=9),
            trace[2],
        )
        with self.assertRaises(CaptureAssetError) as caught:
            build_video_only_review_clip_provenance(
                **arguments  # type: ignore[arg-type]
            )
        self.assertEqual(caught.exception.code, "REVIEW_FRAME_TRACE")

        arguments = _review_arguments(source, fixture)
        grant = fixture["capture_rights_grant"]
        revoked = _capture_snapshot(grant, revoked_key_at=350)
        arguments["capture_rights_trust_snapshot"] = revoked
        arguments["expected_capture_rights_trust_snapshot_sha256"] = (
            revoked.fingerprint()
        )
        with self.assertRaisesRegex(ValueError, "CAPTURE_RIGHTS_KEY_REVOKED"):
            build_video_only_review_clip_provenance(
                **arguments  # type: ignore[arg-type]
            )

        arguments = _review_arguments(source, fixture)
        source_revoked = _capture_metadata_trust_snapshot(source, revoked_at_ns=399)
        arguments["capture_metadata_trust_snapshot"] = source_revoked
        arguments["expected_capture_metadata_trust_snapshot_sha256"] = (
            source_revoked.fingerprint()
        )
        with self.assertRaises(CaptureAssetError) as caught:
            build_video_only_review_clip_provenance(
                **arguments  # type: ignore[arg-type]
            )
        self.assertEqual(caught.exception.code, "CAPTURE_METADATA_KEY_REVOKED")

    def test_review_trusted_time_cannot_regress_before_source_verification(self) -> None:
        fixture = _fixture()
        source = build_structurally_verified_capture_metadata(**fixture)  # type: ignore[arg-type]
        arguments = _review_arguments(source, fixture)
        arguments["rights_reverified_at_ns"] = source.verified_at_ns - 1
        with self.assertRaises(CaptureAssetError) as caught:
            build_video_only_review_clip_provenance(
                **arguments  # type: ignore[arg-type]
            )
        self.assertEqual(caught.exception.code, "TRUSTED_TIME_REGRESSION")

    def test_every_non_operational_use_is_rejected_without_an_api_escape_hatch(self) -> None:
        fixture = _fixture()
        capture_metadata = build_structurally_verified_capture_metadata(
            **fixture  # type: ignore[arg-type]
        )
        operational = set(CAPTURE_OPERATION_REQUIRED_USES)
        for additional_use in tuple(
            use for use in PermittedUse if use not in operational
        ):
            arguments = _review_arguments(capture_metadata, fixture)
            arguments["intended_uses"] = tuple(
                sorted(
                    (*CAPTURE_OPERATION_REQUIRED_USES, additional_use),
                    key=lambda value: value.value,
                )
            )
            with self.subTest(additional_use=additional_use), self.assertRaises(
                CaptureAssetError
            ) as caught:
                build_video_only_review_clip_provenance(
                    **arguments  # type: ignore[arg-type]
                )
            self.assertEqual(
                caught.exception.code,
                "REVIEW_NON_OPERATIONAL_USE_FORBIDDEN",
            )

        public_parameters = inspect.signature(
            build_video_only_review_clip_provenance
        ).parameters
        self.assertFalse(
            any("exact_asset" in parameter for parameter in public_parameters)
        )
        self.assertFalse(
            any(
                "exact_asset" in field
                for field in ReviewClipProvenance.__dataclass_fields__
            )
        )

    def test_clip_record_cannot_claim_audio_content_or_frame_validation(self) -> None:
        fixture = _fixture()
        source = build_structurally_verified_capture_metadata(**fixture)  # type: ignore[arg-type]
        provenance = build_video_only_review_clip_provenance(
            **_review_arguments(source, fixture)  # type: ignore[arg-type]
        )
        payload = json.loads(provenance.to_json_bytes())
        payload["content_inspection_status"] = "VALIDATED"
        encoded = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
        with self.assertRaises(CaptureAssetError) as caught:
            ReviewClipProvenance.from_json_bytes(encoded)
        self.assertEqual(caught.exception.code, "INVALID_REVIEW_CLIP_PROVENANCE")
        payload = json.loads(provenance.to_json_bytes())
        payload["audio_provenance_status"] = "AUDIO_ABSENT_VALIDATED"
        encoded = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
        with self.assertRaises(CaptureAssetError):
            ReviewClipProvenance.from_json_bytes(encoded)
        payload = json.loads(provenance.to_json_bytes())
        payload["admissibility_status"] = (
            BoundaryAdmissibilityStatus.NOT_ADMISSIBLE_PENDING_CAPTURE_SEGMENT_AND_MEDIA_VALIDATION.value
        )
        encoded = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
        with self.assertRaises(CaptureAssetError):
            ReviewClipProvenance.from_json_bytes(encoded)

    def test_capture_asset_module_has_no_score_mutation_import_path(self) -> None:
        tree = ast.parse(inspect.getsource(capture_assets_module))
        imported: set[str] = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                imported.update(alias.name.rsplit(".", 1)[-1] for alias in node.names)
            elif isinstance(node, ast.ImportFrom) and node.module:
                imported.add(node.module.rsplit(".", 1)[-1])
        self.assertTrue(
            {
                "authorization",
                "domain_events",
                "event_store",
                "policy",
                "rules",
                "state_codec",
            }.isdisjoint(imported)
        )
        self.assertFalse(
            {"RuleEvent", "AuthorizationCommand", "ScoreCheck"}
            & set(vars(capture_assets_module))
        )


if __name__ == "__main__":
    unittest.main()
