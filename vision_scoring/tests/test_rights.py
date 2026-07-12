from __future__ import annotations

from dataclasses import FrozenInstanceError, replace
import json
import unittest

from vision_scoring.rights import (
    ParticipantAgeStatus,
    PermittedUse,
    RightsBasis,
    RightsDecision,
    RightsDecisionState,
    rights_decision_from_dict,
)


SHA = "a" * 64
EVIDENCE = "b" * 64
RELEASE = "c" * 64


def _accepted(**overrides: object) -> RightsDecision:
    values: dict[str, object] = {
        "asset_sha256": SHA,
        "state": RightsDecisionState.ACCEPTED,
        "basis": RightsBasis.OWNED,
        "owner_or_licensor": "Beach Volleyball Media LLC",
        "license_id": None,
        "evidence_sha256s": (EVIDENCE,),
        "permitted_uses": (
            PermittedUse.COMMERCIAL_MODEL_TRAINING,
            PermittedUse.MODEL_DEPLOYMENT,
        ),
        "geography_scope": ("US",),
        "participant_age_status": ParticipantAgeStatus.NO_MINORS,
        "participant_release_sha256s": (),
        "reviewer_id": "rights-reviewer-1",
        "reviewed_on": "2026-07-11",
        "expires_on": None,
    }
    values.update(overrides)
    return RightsDecision(**values)  # type: ignore[arg-type]


class RightsDecisionTests(unittest.TestCase):
    def test_accepted_decision_authorizes_only_exact_scope(self) -> None:
        decision = _accepted()
        required = (
            PermittedUse.COMMERCIAL_MODEL_TRAINING,
            PermittedUse.MODEL_DEPLOYMENT,
        )
        self.assertTrue(decision.authorizes(required, as_of="2026-07-11", geography="US"))
        self.assertFalse(decision.authorizes(required, as_of="2026-07-11", geography="CA"))
        self.assertFalse(
            decision.authorizes(
                (*required, PermittedUse.SOURCE_REDISTRIBUTION),
                as_of="2026-07-11",
                geography="US",
            )
        )

    def test_expiration_and_review_date_are_enforced(self) -> None:
        decision = _accepted(expires_on="2026-12-31")
        uses = (PermittedUse.COMMERCIAL_MODEL_TRAINING,)
        self.assertFalse(decision.authorizes(uses, as_of="2026-07-10", geography="US"))
        self.assertTrue(decision.authorizes(uses, as_of="2026-12-31", geography="US"))
        self.assertFalse(decision.authorizes(uses, as_of="2027-01-01", geography="US"))
        with self.assertRaisesRegex(ValueError, "cannot precede"):
            _accepted(expires_on="2026-07-10")

    def test_global_scope_and_license_requirements_are_explicit(self) -> None:
        licensed = _accepted(
            basis=RightsBasis.LICENSED,
            license_id="license-2026-001",
            geography_scope=("GLOBAL",),
        )
        self.assertTrue(
            licensed.authorizes(
                (PermittedUse.MODEL_DEPLOYMENT,),
                as_of="2026-07-11",
                geography="GB",
            )
        )
        with self.assertRaisesRegex(ValueError, "requires license_id"):
            _accepted(basis=RightsBasis.LICENSED)
        with self.assertRaisesRegex(ValueError, "only for LICENSED"):
            _accepted(license_id="not-allowed")
        with self.assertRaisesRegex(ValueError, "GLOBAL cannot"):
            _accepted(geography_scope=("GLOBAL", "US"))

    def test_minor_clearance_requires_content_addressed_release_evidence(self) -> None:
        cleared = _accepted(
            participant_age_status=ParticipantAgeStatus.MINORS_CLEARED,
            participant_release_sha256s=(RELEASE,),
        )
        self.assertEqual(cleared.participant_release_sha256s, (RELEASE,))
        with self.assertRaisesRegex(ValueError, "release evidence"):
            _accepted(participant_age_status=ParticipantAgeStatus.MINORS_CLEARED)
        with self.assertRaisesRegex(ValueError, "minor clearance"):
            _accepted(participant_age_status=ParticipantAgeStatus.UNKNOWN)
        with self.assertRaisesRegex(ValueError, "minor clearance"):
            _accepted(participant_age_status=ParticipantAgeStatus.MINORS_NOT_CLEARED)

    def test_pending_and_rejected_decisions_cannot_grant_rights(self) -> None:
        for state in (RightsDecisionState.PENDING, RightsDecisionState.REJECTED):
            with self.subTest(state=state):
                decision = _accepted(
                    state=state,
                    basis=None,
                    owner_or_licensor=None,
                    permitted_uses=(),
                    geography_scope=(),
                )
                self.assertFalse(
                    decision.authorizes(
                        (PermittedUse.INTERNAL_RESEARCH,),
                        as_of="2026-07-11",
                        geography="US",
                    )
                )
                with self.assertRaisesRegex(ValueError, "cannot grant"):
                    replace(decision, permitted_uses=(PermittedUse.INTERNAL_RESEARCH,))

    def test_enums_hashes_dates_and_immutable_tuples_fail_closed(self) -> None:
        invalid = (
            {"state": "ACCEPTED"},
            {"basis": "OWNED"},
            {"participant_age_status": "NO_MINORS"},
            {"asset_sha256": "A" * 64},
            {"evidence_sha256s": ("not-a-hash",)},
            {"evidence_sha256s": [EVIDENCE]},
            {"permitted_uses": ("COMMERCIAL_MODEL_TRAINING",)},
            {"geography_scope": ("usa",)},
            {"reviewed_on": "2026-02-30"},
            {"reviewer_id": " padded"},
        )
        for overrides in invalid:
            with self.subTest(overrides=overrides), self.assertRaises(ValueError):
                _accepted(**overrides)
        with self.assertRaisesRegex(ValueError, "more than 64"):
            _accepted(
                evidence_sha256s=tuple(f"{index:064x}" for index in range(65))
            )

    def test_principal_ids_are_ascii_and_free_text_is_utf8_nfc(self) -> None:
        with self.assertRaisesRegex(ValueError, "ASCII stable ID"):
            _accepted(reviewer_id="reviewer-é")
        with self.assertRaisesRegex(ValueError, "ASCII stable ID"):
            _accepted(
                basis=RightsBasis.LICENSED,
                license_id="license with spaces",
            )
        with self.assertRaisesRegex(ValueError, "UTF-8 NFC"):
            _accepted(owner_or_licensor="Cafe\u0301 Media")
        with self.assertRaisesRegex(ValueError, "UTF-8 NFC"):
            _accepted(owner_or_licensor="invalid-\ud800")

    def test_authorization_request_is_strict(self) -> None:
        decision = _accepted()
        with self.assertRaisesRegex(ValueError, "cannot be empty"):
            decision.authorizes((), as_of="2026-07-11", geography="US")
        with self.assertRaisesRegex(ValueError, "tuple"):
            decision.authorizes([], as_of="2026-07-11", geography="US")
        with self.assertRaisesRegex(ValueError, "PermittedUse"):
            decision.authorizes(("MODEL_DEPLOYMENT",), as_of="2026-07-11", geography="US")
        with self.assertRaisesRegex(ValueError, "duplicates"):
            decision.authorizes(
                (PermittedUse.MODEL_DEPLOYMENT, PermittedUse.MODEL_DEPLOYMENT),
                as_of="2026-07-11",
                geography="US",
            )
        with self.assertRaisesRegex(ValueError, "alpha-2"):
            decision.authorizes(
                (PermittedUse.MODEL_DEPLOYMENT,),
                as_of="2026-07-11",
                geography="GLOBAL",
            )

    def test_canonical_fingerprint_is_order_independent_and_content_sensitive(self) -> None:
        first = _accepted(
            evidence_sha256s=(EVIDENCE, RELEASE),
            permitted_uses=(
                PermittedUse.MODEL_DEPLOYMENT,
                PermittedUse.COMMERCIAL_MODEL_TRAINING,
            ),
            geography_scope=("US", "CA"),
        )
        reordered = _accepted(
            evidence_sha256s=(RELEASE, EVIDENCE),
            permitted_uses=(
                PermittedUse.COMMERCIAL_MODEL_TRAINING,
                PermittedUse.MODEL_DEPLOYMENT,
            ),
            geography_scope=("CA", "US"),
        )
        changed = replace(first, owner_or_licensor="Different Licensor")
        self.assertEqual(first.canonical_json(), reordered.canonical_json())
        self.assertEqual(first.fingerprint(), reordered.fingerprint())
        self.assertNotEqual(first.fingerprint(), changed.fingerprint())
        payload = json.loads(first.canonical_json())
        self.assertEqual(payload["schema_version"], "1.0")
        self.assertRegex(first.fingerprint(), r"^[0-9a-f]{64}$")

    def test_decision_is_frozen_and_slotted(self) -> None:
        decision = _accepted()
        self.assertFalse(hasattr(decision, "__dict__"))
        with self.assertRaises(FrozenInstanceError):
            decision.state = RightsDecisionState.REJECTED  # type: ignore[misc]

    def test_exact_json_loader_round_trips_and_rejects_schema_drift(self) -> None:
        decision = _accepted()
        payload = decision.to_canonical_dict()
        loaded = rights_decision_from_dict(payload)
        self.assertEqual(loaded, decision)
        self.assertEqual(loaded.fingerprint(), decision.fingerprint())

        with self.assertRaisesRegex(ValueError, "unsupported fields"):
            rights_decision_from_dict({**payload, "rights_status": "OWNED"})
        missing = dict(payload)
        missing.pop("evidence_sha256s")
        with self.assertRaisesRegex(ValueError, "missing fields"):
            rights_decision_from_dict(missing)
        with self.assertRaisesRegex(ValueError, "schema_version"):
            rights_decision_from_dict({**payload, "schema_version": "2.0"})
        with self.assertRaisesRegex(ValueError, "JSON array"):
            rights_decision_from_dict({**payload, "permitted_uses": "MODEL_DEPLOYMENT"})


if __name__ == "__main__":
    unittest.main()
