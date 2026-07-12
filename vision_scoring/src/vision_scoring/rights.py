"""Reviewed, content-addressed rights decisions for dataset intake.

Media preflight may record an unverified claim supplied by an operator.  This
module is the separate trust-boundary contract: only a reviewed ``ACCEPTED``
decision can authorize a declared use, geography, and validity date.
"""

from __future__ import annotations

import hashlib
import json
import re
import unicodedata
from dataclasses import dataclass
from datetime import date
from enum import Enum
from typing import Any, Mapping


SCHEMA_VERSION = "1.0"
_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
_ISO_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_COUNTRY_RE = re.compile(r"^[A-Z]{2}$")
_STABLE_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$")
_MAX_EVIDENCE_REFERENCES = 64
_DECISION_FIELDS = frozenset(
    {
        "asset_sha256",
        "basis",
        "evidence_sha256s",
        "expires_on",
        "geography_scope",
        "license_id",
        "owner_or_licensor",
        "participant_age_status",
        "participant_release_sha256s",
        "permitted_uses",
        "reviewed_on",
        "reviewer_id",
        "schema_version",
        "state",
    }
)


class RightsDecisionState(str, Enum):
    PENDING = "PENDING"
    ACCEPTED = "ACCEPTED"
    REJECTED = "REJECTED"


class RightsBasis(str, Enum):
    OWNED = "OWNED"
    LICENSED = "LICENSED"
    PUBLIC_DOMAIN = "PUBLIC_DOMAIN"


class PermittedUse(str, Enum):
    INTERNAL_RESEARCH = "INTERNAL_RESEARCH"
    COMMERCIAL_MODEL_TRAINING = "COMMERCIAL_MODEL_TRAINING"
    COMMERCIAL_MODEL_EVALUATION = "COMMERCIAL_MODEL_EVALUATION"
    MODEL_DEPLOYMENT = "MODEL_DEPLOYMENT"
    BIOMETRIC_POSE_ANALYSIS = "BIOMETRIC_POSE_ANALYSIS"
    DERIVATIVE_DATASET_CREATION = "DERIVATIVE_DATASET_CREATION"
    SOURCE_REDISTRIBUTION = "SOURCE_REDISTRIBUTION"
    DERIVATIVE_REDISTRIBUTION = "DERIVATIVE_REDISTRIBUTION"


class ParticipantAgeStatus(str, Enum):
    NO_MINORS = "NO_MINORS"
    MINORS_CLEARED = "MINORS_CLEARED"
    MINORS_NOT_CLEARED = "MINORS_NOT_CLEARED"
    UNKNOWN = "UNKNOWN"


def _require_sha256(value: object, field_name: str) -> None:
    if type(value) is not str or not _SHA256_RE.fullmatch(value):
        raise ValueError(f"{field_name} must be a lowercase SHA-256")


def _require_utf8_nfc_text(value: object, field_name: str) -> None:
    if type(value) is not str or not value.strip() or value != value.strip():
        raise ValueError(f"{field_name} must be non-empty trimmed UTF-8 NFC text")
    try:
        value.encode("utf-8", errors="strict")
    except UnicodeEncodeError as exc:
        raise ValueError(f"{field_name} must be non-empty trimmed UTF-8 NFC text") from exc
    if unicodedata.normalize("NFC", value) != value or any(
        unicodedata.category(character).startswith("C") for character in value
    ):
        raise ValueError(f"{field_name} must be non-empty trimmed UTF-8 NFC text")


def _require_stable_id(value: object, field_name: str) -> None:
    if type(value) is not str or not _STABLE_ID_RE.fullmatch(value):
        raise ValueError(
            f"{field_name} must be an ASCII stable ID using letters, digits, . _ : @ / or -"
        )


def _require_sha_tuple(
    value: object,
    field_name: str,
    *,
    required: bool,
) -> None:
    if type(value) is not tuple:
        raise ValueError(f"{field_name} must be an immutable tuple")
    if required and not value:
        raise ValueError(f"{field_name} cannot be empty")
    if len(value) > _MAX_EVIDENCE_REFERENCES:
        raise ValueError(
            f"{field_name} cannot contain more than {_MAX_EVIDENCE_REFERENCES} hashes"
        )
    if len(set(value)) != len(value):
        raise ValueError(f"{field_name} cannot contain duplicates")
    for item in value:
        _require_sha256(item, f"{field_name} item")


def _parse_iso_date(value: object, field_name: str) -> date:
    if type(value) is not str or not _ISO_DATE_RE.fullmatch(value):
        raise ValueError(f"{field_name} must be an ISO-8601 calendar date")
    try:
        parsed = date.fromisoformat(value)
    except ValueError as exc:
        raise ValueError(f"{field_name} must be an ISO-8601 calendar date") from exc
    if parsed.isoformat() != value:
        raise ValueError(f"{field_name} must be an ISO-8601 calendar date")
    return parsed


@dataclass(frozen=True, slots=True)
class RightsDecision:
    """One legal/operational review decision bound to exact source bytes."""

    asset_sha256: str
    state: RightsDecisionState
    basis: RightsBasis | None
    owner_or_licensor: str | None
    license_id: str | None
    evidence_sha256s: tuple[str, ...]
    permitted_uses: tuple[PermittedUse, ...]
    geography_scope: tuple[str, ...]
    participant_age_status: ParticipantAgeStatus
    participant_release_sha256s: tuple[str, ...]
    reviewer_id: str
    reviewed_on: str
    expires_on: str | None = None

    def __post_init__(self) -> None:
        _require_sha256(self.asset_sha256, "asset_sha256")
        if type(self.state) is not RightsDecisionState:
            raise ValueError("state must be a RightsDecisionState")
        if self.basis is not None and type(self.basis) is not RightsBasis:
            raise ValueError("basis must be a RightsBasis or None")
        if self.owner_or_licensor is not None:
            _require_utf8_nfc_text(self.owner_or_licensor, "owner_or_licensor")
        if self.license_id is not None:
            _require_stable_id(self.license_id, "license_id")
        _require_sha_tuple(
            self.evidence_sha256s,
            "evidence_sha256s",
            required=True,
        )
        _require_sha_tuple(
            self.participant_release_sha256s,
            "participant_release_sha256s",
            required=False,
        )
        _require_stable_id(self.reviewer_id, "reviewer_id")
        reviewed_on = _parse_iso_date(self.reviewed_on, "reviewed_on")
        if self.expires_on is not None:
            expires_on = _parse_iso_date(self.expires_on, "expires_on")
            if expires_on < reviewed_on:
                raise ValueError("expires_on cannot precede reviewed_on")

        if type(self.permitted_uses) is not tuple or any(
            type(use) is not PermittedUse for use in self.permitted_uses
        ):
            raise ValueError("permitted_uses must be a tuple of PermittedUse values")
        if len(set(self.permitted_uses)) != len(self.permitted_uses):
            raise ValueError("permitted_uses cannot contain duplicates")

        if type(self.geography_scope) is not tuple:
            raise ValueError("geography_scope must be an immutable tuple")
        if len(set(self.geography_scope)) != len(self.geography_scope):
            raise ValueError("geography_scope cannot contain duplicates")
        for geography in self.geography_scope:
            if type(geography) is not str or (
                geography != "GLOBAL" and not _COUNTRY_RE.fullmatch(geography)
            ):
                raise ValueError("geography_scope values must be GLOBAL or ISO alpha-2 codes")
        if "GLOBAL" in self.geography_scope and len(self.geography_scope) != 1:
            raise ValueError("GLOBAL cannot be combined with country codes")

        if type(self.participant_age_status) is not ParticipantAgeStatus:
            raise ValueError("participant_age_status must be a ParticipantAgeStatus")
        if (
            self.participant_age_status is ParticipantAgeStatus.MINORS_CLEARED
            and not self.participant_release_sha256s
        ):
            raise ValueError("MINORS_CLEARED requires participant release evidence")

        if self.state is RightsDecisionState.ACCEPTED:
            if self.basis is None or self.owner_or_licensor is None:
                raise ValueError("ACCEPTED requires a rights basis and owner/licensor")
            if not self.permitted_uses or not self.geography_scope:
                raise ValueError("ACCEPTED requires permitted uses and geography scope")
            if self.participant_age_status in {
                ParticipantAgeStatus.UNKNOWN,
                ParticipantAgeStatus.MINORS_NOT_CLEARED,
            }:
                raise ValueError("ACCEPTED requires participant age/minor clearance")
            if self.basis is RightsBasis.LICENSED and self.license_id is None:
                raise ValueError("LICENSED acceptance requires license_id")
            if self.basis is not RightsBasis.LICENSED and self.license_id is not None:
                raise ValueError("license_id is allowed only for LICENSED acceptance")
        else:
            if self.permitted_uses or self.geography_scope:
                raise ValueError("non-ACCEPTED decisions cannot grant uses or geographies")
            if self.license_id is not None:
                raise ValueError("non-ACCEPTED decisions cannot grant a license_id")

    def authorizes(
        self,
        required_uses: tuple[PermittedUse, ...],
        *,
        as_of: str,
        geography: str,
    ) -> bool:
        """Return whether this reviewed decision authorizes the exact request."""

        if type(required_uses) is not tuple or any(
            type(use) is not PermittedUse for use in required_uses
        ):
            raise ValueError("required_uses must be a tuple of PermittedUse values")
        if len(set(required_uses)) != len(required_uses):
            raise ValueError("required_uses cannot contain duplicates")
        if not required_uses:
            raise ValueError("required_uses cannot be empty")
        as_of_date = _parse_iso_date(as_of, "as_of")
        if type(geography) is not str or not _COUNTRY_RE.fullmatch(geography):
            raise ValueError("geography must be an ISO alpha-2 code")
        if self.state is not RightsDecisionState.ACCEPTED:
            return False
        if as_of_date < date.fromisoformat(self.reviewed_on):
            return False
        if self.expires_on is not None and as_of_date > date.fromisoformat(self.expires_on):
            return False
        if not set(required_uses).issubset(self.permitted_uses):
            return False
        return "GLOBAL" in self.geography_scope or geography in self.geography_scope

    def to_canonical_dict(self) -> dict[str, Any]:
        return {
            "asset_sha256": self.asset_sha256,
            "basis": self.basis.value if self.basis is not None else None,
            "evidence_sha256s": sorted(self.evidence_sha256s),
            "expires_on": self.expires_on,
            "geography_scope": sorted(self.geography_scope),
            "license_id": self.license_id,
            "owner_or_licensor": self.owner_or_licensor,
            "participant_age_status": self.participant_age_status.value,
            "participant_release_sha256s": sorted(self.participant_release_sha256s),
            "permitted_uses": sorted(use.value for use in self.permitted_uses),
            "reviewed_on": self.reviewed_on,
            "reviewer_id": self.reviewer_id,
            "schema_version": SCHEMA_VERSION,
            "state": self.state.value,
        }

    def canonical_json(self) -> str:
        return json.dumps(
            self.to_canonical_dict(),
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        )

    def fingerprint(self) -> str:
        return hashlib.sha256(self.canonical_json().encode("utf-8")).hexdigest()


def rights_decision_from_dict(payload: Mapping[str, Any]) -> RightsDecision:
    """Parse an exact JSON-shaped decision without weakening enum validation."""

    if not isinstance(payload, Mapping):
        raise ValueError("rights decision must be a JSON object")
    fields = set(payload)
    unknown = sorted(str(field) for field in fields - _DECISION_FIELDS)
    missing = sorted(_DECISION_FIELDS - fields)
    if unknown:
        raise ValueError("rights decision has unsupported fields: " + ", ".join(unknown))
    if missing:
        raise ValueError("rights decision is missing fields: " + ", ".join(missing))
    if payload.get("schema_version") != SCHEMA_VERSION:
        raise ValueError(f"rights decision schema_version must be {SCHEMA_VERSION}")

    def exact_list(field_name: str) -> list[Any]:
        value = payload.get(field_name)
        if type(value) is not list:
            raise ValueError(f"rights decision {field_name} must be a JSON array")
        return value

    raw_permitted_uses = exact_list("permitted_uses")
    try:
        state = RightsDecisionState(payload.get("state"))
        raw_basis = payload.get("basis")
        basis = None if raw_basis is None else RightsBasis(raw_basis)
        participant_age_status = ParticipantAgeStatus(
            payload.get("participant_age_status")
        )
        permitted_uses = tuple(PermittedUse(value) for value in raw_permitted_uses)
    except (TypeError, ValueError) as exc:
        raise ValueError("rights decision contains an unsupported enum value") from exc

    return RightsDecision(
        asset_sha256=payload.get("asset_sha256"),
        state=state,
        basis=basis,
        owner_or_licensor=payload.get("owner_or_licensor"),
        license_id=payload.get("license_id"),
        evidence_sha256s=tuple(exact_list("evidence_sha256s")),
        permitted_uses=permitted_uses,
        geography_scope=tuple(exact_list("geography_scope")),
        participant_age_status=participant_age_status,
        participant_release_sha256s=tuple(
            exact_list("participant_release_sha256s")
        ),
        reviewer_id=payload.get("reviewer_id"),
        reviewed_on=payload.get("reviewed_on"),
        expires_on=payload.get("expires_on"),
    )
