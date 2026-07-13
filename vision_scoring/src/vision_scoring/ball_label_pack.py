"""Load one exact immutable causal-ball label contract generation.

The pack is a storage and reconstruction boundary, not a trust or admission
boundary.  It keeps the signed curator statement and every concrete Annotation
Truth V2 contract in one content-addressed generation while deliberately
excluding source media, raw review/capture evidence, and protected trust state.
"""

from __future__ import annotations

import hashlib
import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping, Protocol

from .annotation_trust import (
    AnnotationAttestation,
    annotation_attestation_set_fingerprint,
)
from .annotations import BallFrameAnnotationV2, FrameReference
from .contract_wire import (
    CanonicalWireError,
    canonical_json_bytes,
    parse_canonical_json_object,
    require_exact_fields,
    require_sha256,
)
from .immutable_store import (
    ImmutableStoreError,
    generation_read_lease,
)
from .label_bundle import (
    MAX_LABEL_BUNDLE_ATTESTATION_BYTES,
    MAX_LABEL_BUNDLE_BYTES,
    MAX_LABEL_BUNDLE_TRUST_SNAPSHOT_BYTES,
    CausalBallLabelBundleAttestationV1,
    CausalBallLabelBundleTrustSnapshotV1,
    CausalBallLabelBundleV1,
    LabelBundleError,
    LabelBundleSplit,
    build_causal_ball_label_bundle_v1,
)


BALL_LABEL_PACK_SCHEMA_VERSION = "1.0"
MAX_BALL_LABEL_PACK_ROOT_BYTES = 4 * 1024
MAX_BALL_LABEL_PACK_ANNOTATION_BYTES = 64 * 1024
MAX_BALL_LABEL_PACK_ANNOTATION_ATTESTATION_BYTES = 4 * 1024
MAX_BALL_LABEL_PACK_OBJECTS = 20_000
MAX_BALL_LABEL_PACK_CONTRACT_BYTES = 256 * 1024 * 1024

_CONTENT_ADDRESS_RE = re.compile(r"^sha256:[0-9a-f]{64}$")


class BallLabelPackError(ValueError):
    """Fail-closed pack error with a stable machine-readable code."""

    def __init__(self, code: str, message: str) -> None:
        self.code = code
        super().__init__(f"{code}: {message}")


def _fail(code: str, message: str) -> None:
    raise BallLabelPackError(code, message)


def _require_content_address(value: object, field_name: str) -> str:
    if type(value) is not str or _CONTENT_ADDRESS_RE.fullmatch(value) is None:
        raise ValueError(f"{field_name} must be an exact sha256 content address")
    return value


def _address_digest(address: str) -> str:
    _require_content_address(address, "content address")
    return address.removeprefix("sha256:")


@dataclass(frozen=True, slots=True)
class BallLabelPackRootV1:
    """Four-field root manifest for one exact contract closure."""

    label_bundle_statement_ref: str
    curator_attestation_ref: str
    curator_trust_snapshot_ref: str
    schema_version: str = BALL_LABEL_PACK_SCHEMA_VERSION

    def __post_init__(self) -> None:
        if self.schema_version != BALL_LABEL_PACK_SCHEMA_VERSION:
            raise ValueError("unsupported ball-label-pack root schema")
        references = (
            self.label_bundle_statement_ref,
            self.curator_attestation_ref,
            self.curator_trust_snapshot_ref,
        )
        for field_name, value in zip(
            (
                "label_bundle_statement_ref",
                "curator_attestation_ref",
                "curator_trust_snapshot_ref",
            ),
            references,
            strict=True,
        ):
            _require_content_address(value, field_name)
        if len(set(references)) != len(references):
            raise ValueError("root contract references must be globally distinct")
        canonical_json_bytes(
            self.to_dict(),
            label="ball label pack root",
            maximum_bytes=MAX_BALL_LABEL_PACK_ROOT_BYTES,
        )

    def to_dict(self) -> dict[str, str]:
        return {
            "curator_attestation_ref": self.curator_attestation_ref,
            "curator_trust_snapshot_ref": self.curator_trust_snapshot_ref,
            "label_bundle_statement_ref": self.label_bundle_statement_ref,
            "schema_version": self.schema_version,
        }

    def to_json_bytes(self) -> bytes:
        return canonical_json_bytes(
            self.to_dict(),
            label="ball label pack root",
            maximum_bytes=MAX_BALL_LABEL_PACK_ROOT_BYTES,
        )

    def fingerprint(self) -> str:
        return hashlib.sha256(self.to_json_bytes()).hexdigest()

    @classmethod
    def from_json_bytes(cls, raw: bytes) -> "BallLabelPackRootV1":
        try:
            payload = parse_canonical_json_object(
                raw,
                label="ball label pack root",
                maximum_bytes=MAX_BALL_LABEL_PACK_ROOT_BYTES,
                maximum_depth=2,
                maximum_nodes=8,
                maximum_containers=1,
            )
            payload = require_exact_fields(
                payload,
                {
                    "schema_version",
                    "label_bundle_statement_ref",
                    "curator_attestation_ref",
                    "curator_trust_snapshot_ref",
                },
                label="ball label pack root",
            )
            root = cls(**payload)
        except CanonicalWireError:
            raise
        except (KeyError, TypeError, ValueError) as exc:
            raise CanonicalWireError(
                "BALL_LABEL_PACK_ROOT_SHAPE",
                "ball label pack root fields are invalid",
            ) from exc
        if raw != root.to_json_bytes():
            raise CanonicalWireError(
                "NONCANONICAL_CONTRACT",
                "ball label pack root bytes changed during reconstruction",
            )
        return root


class _BallLabelPackEvidence(Protocol):
    """Private read-only shape; structural conformance grants no authority."""

    @property
    def generation_id(self) -> str: ...

    @property
    def pack_sha256(self) -> str: ...

    @property
    def contract_object_sha256s(self) -> tuple[str, ...]: ...

    @property
    def total_contract_bytes(self) -> int: ...

    @property
    def statement(self) -> CausalBallLabelBundleV1: ...

    @property
    def curator_attestation(self) -> CausalBallLabelBundleAttestationV1: ...

    @property
    def curator_trust_snapshot(self) -> CausalBallLabelBundleTrustSnapshotV1: ...

    @property
    def annotations(self) -> tuple[BallFrameAnnotationV2, ...]: ...

    @property
    def annotation_attestations(self) -> tuple[AnnotationAttestation, ...]: ...

    @property
    def split(self) -> LabelBundleSplit: ...

    @property
    def admissible_for_training(self) -> bool: ...

    @property
    def admissible_for_evaluation(self) -> bool: ...

    @property
    def admissible_for_test(self) -> bool: ...

    @property
    def admissible_for_deployment(self) -> bool: ...

    @property
    def admissible_for_live_scoring(self) -> bool: ...


class _LoadedBallLabelPackEvidence:
    __slots__ = (
        "_generation_id",
        "_pack_sha256",
        "_contract_object_sha256s",
        "_total_contract_bytes",
        "_statement",
        "_curator_attestation",
        "_curator_trust_snapshot",
        "_annotations",
        "_annotation_attestations",
    )

    def __init__(
        self,
        *,
        generation_id: str,
        pack_sha256: str,
        contract_object_sha256s: tuple[str, ...],
        total_contract_bytes: int,
        statement: CausalBallLabelBundleV1,
        curator_attestation: CausalBallLabelBundleAttestationV1,
        curator_trust_snapshot: CausalBallLabelBundleTrustSnapshotV1,
        annotations: tuple[BallFrameAnnotationV2, ...],
        annotation_attestations: tuple[AnnotationAttestation, ...],
    ) -> None:
        require_sha256(generation_id, "generation_id")
        require_sha256(pack_sha256, "pack_sha256")
        if (
            type(contract_object_sha256s) is not tuple
            or contract_object_sha256s != tuple(sorted(contract_object_sha256s))
            or len(set(contract_object_sha256s)) != len(contract_object_sha256s)
        ):
            raise ValueError("contract object digests must be sorted and unique")
        for digest in contract_object_sha256s:
            require_sha256(digest, "contract object digest")
        if (
            type(total_contract_bytes) is not int
            or not 1 <= total_contract_bytes <= MAX_BALL_LABEL_PACK_CONTRACT_BYTES
        ):
            raise ValueError("total_contract_bytes is outside the pack bound")
        if type(statement) is not CausalBallLabelBundleV1:
            raise ValueError("statement has the wrong exact type")
        if type(curator_attestation) is not CausalBallLabelBundleAttestationV1:
            raise ValueError("curator attestation has the wrong exact type")
        if type(curator_trust_snapshot) is not CausalBallLabelBundleTrustSnapshotV1:
            raise ValueError("curator trust snapshot has the wrong exact type")
        if type(annotations) is not tuple or any(
            type(item) is not BallFrameAnnotationV2 for item in annotations
        ):
            raise ValueError("annotations have the wrong exact type")
        if type(annotation_attestations) is not tuple or any(
            type(item) is not AnnotationAttestation
            for item in annotation_attestations
        ):
            raise ValueError("annotation attestations have the wrong exact type")
        object.__setattr__(self, "_generation_id", generation_id)
        object.__setattr__(self, "_pack_sha256", pack_sha256)
        object.__setattr__(
            self, "_contract_object_sha256s", contract_object_sha256s
        )
        object.__setattr__(self, "_total_contract_bytes", total_contract_bytes)
        object.__setattr__(self, "_statement", statement)
        object.__setattr__(self, "_curator_attestation", curator_attestation)
        object.__setattr__(self, "_curator_trust_snapshot", curator_trust_snapshot)
        object.__setattr__(self, "_annotations", annotations)
        object.__setattr__(
            self, "_annotation_attestations", annotation_attestations
        )

    def __setattr__(self, name: str, value: object) -> None:
        raise AttributeError("loaded ball-label-pack evidence is immutable")

    @property
    def generation_id(self) -> str:
        return self._generation_id

    @property
    def pack_sha256(self) -> str:
        return self._pack_sha256

    @property
    def contract_object_sha256s(self) -> tuple[str, ...]:
        return self._contract_object_sha256s

    @property
    def total_contract_bytes(self) -> int:
        return self._total_contract_bytes

    @property
    def statement(self) -> CausalBallLabelBundleV1:
        return self._statement

    @property
    def curator_attestation(self) -> CausalBallLabelBundleAttestationV1:
        return self._curator_attestation

    @property
    def curator_trust_snapshot(self) -> CausalBallLabelBundleTrustSnapshotV1:
        return self._curator_trust_snapshot

    @property
    def annotations(self) -> tuple[BallFrameAnnotationV2, ...]:
        return self._annotations

    @property
    def annotation_attestations(self) -> tuple[AnnotationAttestation, ...]:
        return self._annotation_attestations

    @property
    def split(self) -> LabelBundleSplit:
        return self._statement.split

    @property
    def admissible_for_training(self) -> bool:
        return False

    @property
    def admissible_for_evaluation(self) -> bool:
        return False

    @property
    def admissible_for_test(self) -> bool:
        return False

    @property
    def admissible_for_deployment(self) -> bool:
        return False

    @property
    def admissible_for_live_scoring(self) -> bool:
        return False


def _read_contract_object(
    lease: Any,
    digest: str,
    *,
    maximum_bytes: int,
    total_so_far: int,
) -> tuple[bytes, int]:
    try:
        with lease.open_verified_object(digest, max_bytes=maximum_bytes) as staged:
            size = os.fstat(staged.fileno()).st_size
            if size < 1 or size > maximum_bytes:
                _fail(
                    "BALL_LABEL_PACK_OBJECT_SIZE",
                    "contract object is outside its fixed type-specific bound",
                )
            if size > MAX_BALL_LABEL_PACK_CONTRACT_BYTES - total_so_far:
                _fail(
                    "BALL_LABEL_PACK_TOTAL_SIZE",
                    "contract generation exceeds the 256 MiB aggregate bound",
                )
            raw = staged.read()
            if len(raw) != size:
                _fail(
                    "BALL_LABEL_PACK_OBJECT_READ",
                    "verified contract object could not be read exactly",
                )
    except BallLabelPackError:
        raise
    except OSError as exc:
        raise BallLabelPackError(
            "BALL_LABEL_PACK_OBJECT_READ",
            "verified contract object could not be inspected",
        ) from exc
    return raw, total_so_far + size


def _parse_root(raw: bytes) -> BallLabelPackRootV1:
    try:
        return BallLabelPackRootV1.from_json_bytes(raw)
    except (CanonicalWireError, ValueError) as exc:
        raise BallLabelPackError(
            "BALL_LABEL_PACK_ROOT_WIRE",
            "pack root is not the exact V1 canonical contract",
        ) from exc


def _parse_statement(raw: bytes) -> CausalBallLabelBundleV1:
    try:
        return CausalBallLabelBundleV1.from_json_bytes(raw)
    except (LabelBundleError, CanonicalWireError, ValueError) as exc:
        raise BallLabelPackError(
            "BALL_LABEL_PACK_STATEMENT_WIRE",
            "label bundle statement is not the exact canonical contract",
        ) from exc


def _parse_curator_attestation(
    raw: bytes,
) -> CausalBallLabelBundleAttestationV1:
    try:
        return CausalBallLabelBundleAttestationV1.from_json_bytes(raw)
    except (LabelBundleError, CanonicalWireError, ValueError) as exc:
        raise BallLabelPackError(
            "BALL_LABEL_PACK_CURATOR_ATTESTATION_WIRE",
            "curator attestation is not the exact canonical contract",
        ) from exc


def _parse_curator_snapshot(
    raw: bytes,
) -> CausalBallLabelBundleTrustSnapshotV1:
    try:
        return CausalBallLabelBundleTrustSnapshotV1.from_json_bytes(raw)
    except (LabelBundleError, CanonicalWireError, ValueError) as exc:
        raise BallLabelPackError(
            "BALL_LABEL_PACK_CURATOR_SNAPSHOT_WIRE",
            "curator trust snapshot is not the exact canonical contract",
        ) from exc


def _statement_contract_addresses(
    statement: CausalBallLabelBundleV1,
    *,
    core_addresses: tuple[str, ...],
    pack_sha256: str,
) -> tuple[tuple[str, ...], tuple[str, ...], tuple[str, ...]]:
    annotation_addresses: list[str] = []
    attestation_addresses: list[str] = []
    for frame in statement.frames:
        for reference in frame.annotations:
            annotation_addresses.append(reference.annotation_preimage_ref)
            attestation_addresses.extend(reference.annotation_attestation_refs)

    if len(annotation_addresses) != statement.annotation_count:
        _fail(
            "BALL_LABEL_PACK_REFERENCE_COUNT",
            "statement annotation references disagree with annotation_count",
        )
    all_addresses = (
        (f"sha256:{pack_sha256}",)
        + core_addresses
        + tuple(annotation_addresses)
        + tuple(attestation_addresses)
    )
    if len(set(all_addresses)) != len(all_addresses):
        _fail(
            "BALL_LABEL_PACK_REFERENCE_ALIAS",
            "contract references repeat globally or alias another contract type",
        )
    if len(all_addresses) > MAX_BALL_LABEL_PACK_OBJECTS:
        _fail(
            "BALL_LABEL_PACK_OBJECT_COUNT",
            "derived contract closure exceeds the fixed object-count bound",
        )
    return (
        tuple(annotation_addresses),
        tuple(attestation_addresses),
        all_addresses,
    )


def _external_statement_digests(
    statement: CausalBallLabelBundleV1,
) -> frozenset[str]:
    """Return statement commitments that cannot be pack object addresses."""

    external = {
        statement.source_asset_sha256,
        statement.finalized_trace_sha256,
        statement.capture_policy_sha256,
        statement.ontology_sha256,
        statement.decode_contract_sha256,
        statement.annotation_attestation_set_sha256,
        statement.annotation_trust_store_sha256,
        statement.annotation_verification_policy_sha256,
    }
    for frame in statement.frames:
        external.add(frame.decoded_frame_sha256)
        external.add(frame.frame_identity_sha256)
    return frozenset(external)


def _external_annotation_digests(
    statement: CausalBallLabelBundleV1,
    annotations: tuple[BallFrameAnnotationV2, ...],
) -> frozenset[str]:
    """Return all commitments intentionally outside the contract pack."""

    external = set(_external_statement_digests(statement))
    for annotation in annotations:
        frame = annotation.frame
        if type(frame) is not FrameReference:
            _fail(
                "BALL_LABEL_PACK_ANNOTATION_BINDING",
                "complete ball-label packs cannot contain unavailable frames",
            )
        external.update(
            {
                frame.source_sha256,
                frame.decoded_frame_sha256,
                frame.identity.fingerprint(),
                frame.decode_contract.fingerprint(),
                frame.decode_contract.decoder_artifact_sha256,
                annotation.ontology_sha256,
            }
        )
        evidence_addresses = list(annotation.review_evidence_refs)
        evidence_addresses.extend(annotation.adjudication_evidence_refs)
        evidence_addresses.extend(frame.capture_integrity_attestation_refs)
        search = annotation.search_region_observability_attestation
        if search is not None:
            evidence_addresses.extend(search.review_evidence_refs)
            evidence_addresses.extend(search.capture_integrity_attestation_refs)
        external.update(_address_digest(item) for item in evidence_addresses)
    return frozenset(external)


def _verify_curator_binding(
    statement: CausalBallLabelBundleV1,
    statement_sha256: str,
    attestation: CausalBallLabelBundleAttestationV1,
    attestation_sha256: str,
    snapshot: CausalBallLabelBundleTrustSnapshotV1,
) -> None:
    current = snapshot.current_bundle
    if attestation.statement_sha256 != statement_sha256:
        _fail(
            "BALL_LABEL_PACK_CURATOR_BINDING",
            "curator attestation binds a different statement",
        )
    if (
        current.bundle_id != statement.bundle_id
        or current.statement_sha256 != statement_sha256
        or current.attestation_sha256 != attestation_sha256
    ):
        _fail(
            "BALL_LABEL_PACK_CURATOR_BINDING",
            "curator snapshot does not identify the exact current "
            "statement/attestation",
        )
    if (
        snapshot.current_key_id != attestation.key_id
        or snapshot.curator_id != attestation.curator_id
        or snapshot.trust_domain_id != attestation.trust_domain_id
    ):
        _fail(
            "BALL_LABEL_PACK_CURATOR_BINDING",
            "curator attestation differs from the snapshot's current authority scope",
        )
    key = next(
        item for item in snapshot.keys if item.key_id == snapshot.current_key_id
    )
    if (
        key.curator_id != attestation.curator_id
        or key.key_role is not attestation.key_role
    ):
        _fail(
            "BALL_LABEL_PACK_CURATOR_BINDING",
            "curator attestation differs from the snapshot's current key",
        )


def _parse_and_bind_annotations(
    statement: CausalBallLabelBundleV1,
    annotation_addresses: tuple[str, ...],
    attestation_addresses: tuple[str, ...],
    raw_objects: Mapping[str, bytes],
) -> tuple[tuple[BallFrameAnnotationV2, ...], tuple[AnnotationAttestation, ...]]:
    annotations: list[BallFrameAnnotationV2] = []
    attestations: list[AnnotationAttestation] = []
    attestation_by_digest: dict[str, AnnotationAttestation] = {}

    for address in annotation_addresses:
        digest = _address_digest(address)
        try:
            annotation = BallFrameAnnotationV2.from_json_bytes(raw_objects[digest])
        except (CanonicalWireError, ValueError) as exc:
            raise BallLabelPackError(
                "BALL_LABEL_PACK_ANNOTATION_WIRE",
                "annotation preimage is not the exact canonical V2 contract",
            ) from exc
        if (
            annotation.fingerprint() != digest
            or annotation.to_json_bytes() != raw_objects[digest]
        ):
            _fail(
                "BALL_LABEL_PACK_ANNOTATION_FINGERPRINT",
                "annotation fingerprint does not rebind its content address",
            )
        annotations.append(annotation)

    for address in attestation_addresses:
        digest = _address_digest(address)
        try:
            attestation = AnnotationAttestation.from_json_bytes(raw_objects[digest])
        except (CanonicalWireError, ValueError) as exc:
            raise BallLabelPackError(
                "BALL_LABEL_PACK_ANNOTATION_ATTESTATION_WIRE",
                "annotation attestation is not the exact canonical V2 contract",
            ) from exc
        if (
            attestation.fingerprint() != digest
            or attestation.to_json_bytes() != raw_objects[digest]
        ):
            _fail(
                "BALL_LABEL_PACK_ANNOTATION_ATTESTATION_FINGERPRINT",
                "annotation attestation fingerprint does not rebind its address",
            )
        attestation_by_digest[digest] = attestation
        attestations.append(attestation)

    annotation_by_digest = {
        annotation.fingerprint(): annotation for annotation in annotations
    }
    for frame in statement.frames:
        for reference in frame.annotations:
            annotation_digest = _address_digest(reference.annotation_preimage_ref)
            annotation = annotation_by_digest[annotation_digest]
            if (
                reference.annotation_sha256 != annotation_digest
                or reference.annotation_id != annotation.annotation_id
                or reference.annotation_type is not annotation.annotation_type
                or reference.ball_instance_id != annotation.ball_instance_id
                or reference.role is not annotation.role
                or reference.visibility is not annotation.visibility
            ):
                _fail(
                    "BALL_LABEL_PACK_ANNOTATION_BINDING",
                    "statement annotation reference differs from its concrete preimage",
                )
            for attestation_ref in reference.annotation_attestation_refs:
                selected = attestation_by_digest[_address_digest(attestation_ref)]
                if (
                    selected.annotation_sha256 != annotation_digest
                    or selected.annotation_type is not annotation.annotation_type
                ):
                    _fail(
                        "BALL_LABEL_PACK_ANNOTATION_ATTESTATION_BINDING",
                        "detached attestation binds a different annotation preimage",
                    )
    immutable_attestations = tuple(attestations)
    if (
        annotation_attestation_set_fingerprint(immutable_attestations)
        != statement.annotation_attestation_set_sha256
    ):
        _fail(
            "BALL_LABEL_PACK_ANNOTATION_ATTESTATION_SET",
            "detached attestation set differs from the statement commitment",
        )
    return tuple(annotations), immutable_attestations


def _rebuild_statement(
    statement: CausalBallLabelBundleV1,
    annotations: tuple[BallFrameAnnotationV2, ...],
    attestations: tuple[AnnotationAttestation, ...],
) -> None:
    try:
        rebuilt = build_causal_ball_label_bundle_v1(
            bundle_id=statement.bundle_id,
            source_asset_sha256=statement.source_asset_sha256,
            finalized_trace_sha256=statement.finalized_trace_sha256,
            capture_policy_sha256=statement.capture_policy_sha256,
            capture_policy_generation=statement.capture_policy_generation,
            split=statement.split,
            ontology_sha256=statement.ontology_sha256,
            ontology_version=statement.ontology_version,
            match_ball_instance_id=statement.match_ball_instance_id,
            annotations=annotations,
            attestations=attestations,
            annotation_trust_store_sha256=statement.annotation_trust_store_sha256,
            annotation_verification_policy_sha256=(
                statement.annotation_verification_policy_sha256
            ),
        )
    except ValueError as exc:
        raise BallLabelPackError(
            "BALL_LABEL_PACK_REBUILD",
            "concrete contracts cannot rebuild the label bundle",
        ) from exc
    if rebuilt.to_json_bytes() != statement.to_json_bytes():
        _fail(
            "BALL_LABEL_PACK_REBUILD",
            "concrete contracts do not rebuild the statement byte-for-byte",
        )


_IMMUTABLE_ERROR_MAP = {
    "PLATFORM_UNSAFE": (
        "BALL_LABEL_PACK_STORE_PLATFORM",
        "immutable label storage is unsupported on this platform",
    ),
    "STORE_SHAPE": (
        "BALL_LABEL_PACK_STORE",
        "immutable label store is unavailable or unsafe",
    ),
    "LOCK_MISSING": (
        "BALL_LABEL_PACK_GENERATION",
        "label generation lock is unavailable",
    ),
    "LOCK_SHAPE": (
        "BALL_LABEL_PACK_GENERATION",
        "label generation lock is unsafe",
    ),
    "LOCK_CHANGED": (
        "BALL_LABEL_PACK_GENERATION",
        "label generation lock changed",
    ),
    "GENERATION_BUSY": (
        "BALL_LABEL_PACK_GENERATION",
        "label generation is unavailable",
    ),
    "DESCRIPTOR_MISSING": (
        "BALL_LABEL_PACK_GENERATION",
        "label generation descriptor is unavailable",
    ),
    "DESCRIPTOR_OPEN": (
        "BALL_LABEL_PACK_GENERATION",
        "label generation descriptor is unsafe",
    ),
    "DESCRIPTOR_SHAPE": (
        "BALL_LABEL_PACK_GENERATION",
        "label generation descriptor is invalid",
    ),
    "DESCRIPTOR_CHANGED": (
        "BALL_LABEL_PACK_GENERATION",
        "label generation descriptor changed",
    ),
    "GENERATION_MISMATCH": (
        "BALL_LABEL_PACK_GENERATION",
        "label generation identifier is inconsistent",
    ),
    "OBJECT_UNDECLARED": (
        "BALL_LABEL_PACK_MEMBERSHIP",
        "contract object is not declared by the label generation",
    ),
    "OBJECT_OPEN": (
        "BALL_LABEL_PACK_OBJECT_MISSING",
        "contract object is missing or unsafe",
    ),
    "OBJECT_SHAPE": (
        "BALL_LABEL_PACK_OBJECT_SHAPE",
        "contract object must be a resident non-aliased regular file",
    ),
    "OBJECT_SIZE": (
        "BALL_LABEL_PACK_OBJECT_SIZE",
        "contract object exceeds its fixed type-specific bound",
    ),
    "OBJECT_CHANGED": (
        "BALL_LABEL_PACK_OBJECT_CHANGED",
        "contract object changed while being staged",
    ),
    "OBJECT_REPLACED": (
        "BALL_LABEL_PACK_OBJECT_CHANGED",
        "contract object path changed while being staged",
    ),
    "OBJECT_HASH": (
        "BALL_LABEL_PACK_OBJECT_HASH",
        "contract object bytes differ from their content address",
    ),
    "STAGING_WRITE": (
        "BALL_LABEL_PACK_OBJECT_STAGING",
        "contract object could not be staged completely",
    ),
}


def _translate_immutable_error(error: ImmutableStoreError) -> BallLabelPackError:
    code, message = _IMMUTABLE_ERROR_MAP.get(
        error.code,
        (
            "BALL_LABEL_PACK_STORE",
            "immutable label-store verification failed",
        ),
    )
    return BallLabelPackError(code, message)


def load_ball_label_pack(
    *,
    label_store_root: Path,
    generation_id: str,
    pack_sha256: str,
) -> _BallLabelPackEvidence:
    """Load, reconstruct, and rebind one exact leased contract generation.

    The only authority-bearing inputs are immutable-store coordinates.  This
    function intentionally has no overload accepting preconstructed contracts.
    The returned object remains evidence-only and grants no consumer admission.
    """

    try:
        if not isinstance(label_store_root, Path):
            raise ValueError("label_store_root must be a pathlib.Path")
        require_sha256(generation_id, "generation_id")
        require_sha256(pack_sha256, "pack_sha256")
    except ValueError as exc:
        raise BallLabelPackError(
            "BALL_LABEL_PACK_INPUT",
            "immutable label-store coordinates are invalid",
        ) from exc

    try:
        with generation_read_lease(label_store_root, generation_id) as lease:
            descriptor_sha256s = lease.descriptor.object_sha256s
            # Descriptor cardinality and root membership precede contract parsing.
            if len(descriptor_sha256s) > MAX_BALL_LABEL_PACK_OBJECTS:
                _fail(
                    "BALL_LABEL_PACK_OBJECT_COUNT",
                    "generation exceeds the fixed object-count bound",
                )
            if pack_sha256 not in descriptor_sha256s:
                _fail(
                    "BALL_LABEL_PACK_MEMBERSHIP",
                    "pack root is not declared by the exact generation",
                )

            total_contract_bytes = 0
            root_raw, total_contract_bytes = _read_contract_object(
                lease,
                pack_sha256,
                maximum_bytes=MAX_BALL_LABEL_PACK_ROOT_BYTES,
                total_so_far=total_contract_bytes,
            )
            root = _parse_root(root_raw)
            if root.fingerprint() != pack_sha256:
                _fail(
                    "BALL_LABEL_PACK_ROOT_FINGERPRINT",
                    "root fingerprint does not rebind pack_sha256",
                )
            core_addresses = (
                root.label_bundle_statement_ref,
                root.curator_attestation_ref,
                root.curator_trust_snapshot_ref,
            )
            core_digests = tuple(_address_digest(item) for item in core_addresses)
            if pack_sha256 in core_digests:
                _fail(
                    "BALL_LABEL_PACK_REFERENCE_ALIAS",
                    "pack root aliases one of its typed child contracts",
                )

            core_limits = (
                MAX_LABEL_BUNDLE_BYTES,
                MAX_LABEL_BUNDLE_ATTESTATION_BYTES,
                MAX_LABEL_BUNDLE_TRUST_SNAPSHOT_BYTES,
            )
            raw_objects: dict[str, bytes] = {pack_sha256: root_raw}
            for digest, maximum_bytes in zip(
                core_digests, core_limits, strict=True
            ):
                raw, total_contract_bytes = _read_contract_object(
                    lease,
                    digest,
                    maximum_bytes=maximum_bytes,
                    total_so_far=total_contract_bytes,
                )
                raw_objects[digest] = raw

            statement_sha256, curator_sha256, snapshot_sha256 = core_digests
            statement = _parse_statement(raw_objects[statement_sha256])
            if (
                statement.fingerprint() != statement_sha256
                or statement.to_json_bytes() != raw_objects[statement_sha256]
            ):
                _fail(
                    "BALL_LABEL_PACK_STATEMENT_FINGERPRINT",
                    "statement fingerprint does not rebind its root reference",
                )

            (
                annotation_addresses,
                annotation_attestation_addresses,
                closure_addresses,
            ) = _statement_contract_addresses(
                statement,
                core_addresses=core_addresses,
                pack_sha256=pack_sha256,
            )
            closure_sha256s = tuple(
                sorted(_address_digest(address) for address in closure_addresses)
            )
            # Exact closure is checked before any annotation/attestation parsing.
            if descriptor_sha256s != closure_sha256s:
                _fail(
                    "BALL_LABEL_PACK_MEMBERSHIP",
                    "generation has missing or extra objects outside the exact closure",
                )
            if _external_statement_digests(statement).intersection(
                descriptor_sha256s
            ):
                _fail(
                    "BALL_LABEL_PACK_FORBIDDEN_OBJECT_ALIAS",
                    "external statement state aliases a pack contract object",
                )

            for address in annotation_addresses:
                digest = _address_digest(address)
                raw, total_contract_bytes = _read_contract_object(
                    lease,
                    digest,
                    maximum_bytes=MAX_BALL_LABEL_PACK_ANNOTATION_BYTES,
                    total_so_far=total_contract_bytes,
                )
                raw_objects[digest] = raw
            for address in annotation_attestation_addresses:
                digest = _address_digest(address)
                raw, total_contract_bytes = _read_contract_object(
                    lease,
                    digest,
                    maximum_bytes=MAX_BALL_LABEL_PACK_ANNOTATION_ATTESTATION_BYTES,
                    total_so_far=total_contract_bytes,
                )
                raw_objects[digest] = raw

            # Every contract byte is staged and aggregate-bounded before child parse.
            curator_attestation = _parse_curator_attestation(
                raw_objects[curator_sha256]
            )
            curator_snapshot = _parse_curator_snapshot(raw_objects[snapshot_sha256])
            if (
                curator_attestation.fingerprint() != curator_sha256
                or curator_attestation.to_json_bytes()
                != raw_objects[curator_sha256]
                or curator_snapshot.fingerprint() != snapshot_sha256
                or curator_snapshot.to_json_bytes() != raw_objects[snapshot_sha256]
            ):
                _fail(
                    "BALL_LABEL_PACK_CURATOR_FINGERPRINT",
                    "curator contract fingerprint does not rebind its root reference",
                )
            _verify_curator_binding(
                statement,
                statement_sha256,
                curator_attestation,
                curator_sha256,
                curator_snapshot,
            )
            annotations, annotation_attestations = _parse_and_bind_annotations(
                statement,
                annotation_addresses,
                annotation_attestation_addresses,
                raw_objects,
            )
            forbidden = _external_annotation_digests(statement, annotations)
            if forbidden.intersection(descriptor_sha256s):
                _fail(
                    "BALL_LABEL_PACK_FORBIDDEN_OBJECT_ALIAS",
                    "media, evidence, or protected trust state aliases a pack contract",
                )
            _rebuild_statement(statement, annotations, annotation_attestations)

            return _LoadedBallLabelPackEvidence(
                generation_id=generation_id,
                pack_sha256=pack_sha256,
                contract_object_sha256s=descriptor_sha256s,
                total_contract_bytes=total_contract_bytes,
                statement=statement,
                curator_attestation=curator_attestation,
                curator_trust_snapshot=curator_snapshot,
                annotations=annotations,
                annotation_attestations=annotation_attestations,
            )
    except BallLabelPackError:
        raise
    except ImmutableStoreError as exc:
        raise _translate_immutable_error(exc) from exc
    except ValueError as exc:
        # Descriptor parsing errors originate in store-controlled bytes.  All
        # contract parse paths above already use stable, type-specific codes.
        raise BallLabelPackError(
            "BALL_LABEL_PACK_GENERATION",
            "immutable label generation metadata is invalid",
        ) from exc


__all__ = [
    "BALL_LABEL_PACK_SCHEMA_VERSION",
    "MAX_BALL_LABEL_PACK_ANNOTATION_ATTESTATION_BYTES",
    "MAX_BALL_LABEL_PACK_ANNOTATION_BYTES",
    "MAX_BALL_LABEL_PACK_CONTRACT_BYTES",
    "MAX_BALL_LABEL_PACK_OBJECTS",
    "MAX_BALL_LABEL_PACK_ROOT_BYTES",
    "BallLabelPackError",
    "BallLabelPackRootV1",
    "load_ball_label_pack",
]
