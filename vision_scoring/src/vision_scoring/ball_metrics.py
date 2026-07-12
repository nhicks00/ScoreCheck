"""Deterministic ball-center localization benchmark contracts.

The evaluator processes every non-excluded candidate globally at descending
confidence thresholds. All candidates with exactly equal confidence are
processed atomically. At one threshold, each previously unmatched ``VISIBLE``
or ``BLUR`` frame contributes one true positive when at least one tied
candidate is within the required, predeclared tolerance measured in apparent
minor-axis ball diameters; the reported center error is the minimum valid error
for that frame at that threshold. Every remaining
candidate is a false positive. Candidate IDs and input order therefore cannot
change matching or metrics within a confidence tie. Each unmatched localizable
frame is a false negative.

``average_precision_101`` is the mean interpolated precision at the 101 recall
thresholds 0.00, 0.01, ..., 1.00. Ranking points exist only after a complete
confidence group. At each recall threshold, interpolated precision is the
maximum observed precision at any operating point whose recall is at least that
threshold; it is zero when no such point exists.

Every evaluation also requires one explicit operating confidence threshold.
TP, FP, FN, precision, recall, F1, negative-frame activation, and localization
errors use only candidates at or above that threshold. AP101 continues to use
the complete confidence ranking, so changing the operating threshold cannot
change AP101.

Center-error percentiles sort the matched errors and use linear interpolation
at zero-based position ``(n - 1) * q`` (the common type-7 rule), with q=0.50
and q=0.95. Error summaries are ``None`` when there are no matches.
Each candidate error is divided by its truth annotation's apparent minor-axis
ball diameter before matching. The resulting dimensionless population drives
TP/FP/FN, AP101, and operating metrics consistently across apparent ball scales.
Matched raw-pixel errors remain descriptive and are reported alongside the
normalized mean, P50, P95, and maximum.

All-negative hard-negative suites are valid. They report unique negative frames
activated at the operating threshold and the corresponding activation rate.
Localization metrics fail closed to zero and ``localization_metrics_defined``
is false when there is no positive truth, preventing a negative-only suite from
being mistaken for positive localization readiness.

Duplicate exclusion is fail-closed. A ``FrameReference`` duplicate pointer must
resolve to an earlier, non-duplicate truth frame in the same source and selected
stream with the same decode contract, decoded-frame SHA-256, hash basis, width,
and height. Orphan, chained, or mismatched claims reject the whole evaluation.
Pixel-equivalent frames remain evaluable. Only adjudicated
``VERIFIED_CAPTURE_DUPLICATE`` frames carrying capture-integrity evidence and
their predictions are excluded; their counts remain in the report. That opaque
evidence supports a claim authorized by trusted human reviewer/adjudicator
signatures. It is not interpreted as a capture-principal signature. The
duplicate's ball truth must exactly agree with its original.

Predictions carry the complete ``DecodedFrameIdentity`` and must exactly match
truth, including stream selection, presentation position, decoder artifact and
build, autorotation policy, colorspace/range, pixel format/dimensions, and
decoded-pixel hash. Reports retain confidence-threshold operating points and
the matched error population so their constructor can recompute precision,
recall, F1, AP101, and every center-error summary rather than trusting supplied
aggregates.

``REVIEWED`` and ``ADJUDICATED`` are never accepted as payload assertions. The
evaluator requires detached Ed25519 attestations from every declared reviewer
and adjudicator, resident content-addressed evidence, and an out-of-band
``AnnotationVerificationPolicy`` whose separately pinned fingerprint binds the
trust store, evaluator artifact, minimum truth policy, validity window, and
governance domain. A launcher-owned protected configuration generation binds
that store, policy, evaluator, and governance domain atomically. Verification
uses actual UTC. The exact manifest, protected configuration, policy,
trust-store, attestation-set, evidence-set, immutable evidence-generation,
evaluator-artifact, governance-domain, and verification-time proofs are bound
into both the evaluation-input hash and the report. The report hash is
integrity evidence, not authority by itself.
"""

from __future__ import annotations

import hashlib
import json
import math
import platform
import re
import sys
import types
from dataclasses import dataclass
from datetime import datetime, timezone
from enum import Enum
from pathlib import Path
from typing import Any

import cryptography
from cryptography.hazmat.backends import default_backend

from .annotation_trust import (
    AnnotationAttestation,
    AnnotationTrustStore,
    AnnotationVerificationPolicy,
    ProtectedAnnotationConfigurationGeneration,
    annotation_evidence_set_fingerprint,
)
from .annotations import (
    BallFrameAnnotation,
    BallState,
    DecodedFrameIdentity,
    FrameDuplicateKind,
    PixelPoint,
    ReviewState,
)
from .immutable_store import generation_id_for


_SCHEMA_VERSION = "3.0"
_METRIC_NAME = "BALL_CENTER_LOCALIZATION"
_EVALUATOR_ARTIFACT_DOMAIN = (
    "multicourt-vision-scoring:ball-localization-evaluator-artifact:v6"
)
_EVALUATOR_MODULE_NAMES = (
    "vision_scoring.contracts",
    "vision_scoring.annotations",
    "vision_scoring.immutable_store",
    "vision_scoring.annotation_trust",
    "vision_scoring.ball_metrics",
)
_TRUTH_SET_DOMAIN = "multicourt-vision-scoring:ball-truth-set:v1"
_PREDICTION_SET_DOMAIN = "multicourt-vision-scoring:ball-prediction-set:v1"
_EVALUATION_INPUT_DOMAIN = "multicourt-vision-scoring:ball-evaluation-input:v5"
_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
_ASCII_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,127}$")
_UTC_TIMESTAMP_RE = re.compile(
    r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$"
)
_LOCALIZABLE_STATES = frozenset({BallState.VISIBLE, BallState.BLUR})
_NEGATIVE_STATES = frozenset(
    {BallState.OCCLUDED, BallState.OUT_OF_FRAME, BallState.ABSENT}
)
_MAX_TRUTH_FRAME_COUNT = 100_000
_MAX_PREDICTION_COUNT = 500_000
_MAX_PREDICTIONS_PER_FRAME = 256


class TruthPolicy(str, Enum):
    """Minimum review state admitted to a benchmark."""

    ADJUDICATED_ONLY = "ADJUDICATED_ONLY"
    REVIEWED_OR_ADJUDICATED = "REVIEWED_OR_ADJUDICATED"


def ball_localization_evaluator_artifact_sha256() -> str:
    """Fingerprint loaded evaluator code, installed bytes, and selected runtime.

    This is a process-local software identity, not a hardware-rooted attestation
    and not protection against an attacker who already controls this Python
    process. A deployment must calculate and approve the expected value in a
    controlled build/runtime, bind it into the protected verification policy,
    and load that policy's fingerprint from an independent protected source.
    """

    modules: dict[str, Any] = {}
    for module_name in _EVALUATOR_MODULE_NAMES:
        module = sys.modules.get(module_name)
        if type(module) is not types.ModuleType:
            raise RuntimeError(
                f"evaluator module is not loaded for artifact identity: {module_name}"
            )
        module_file = getattr(module, "__file__", None)
        if type(module_file) is not str:
            raise RuntimeError(
                f"evaluator module has no installed artifact file: {module_name}"
            )
        artifact_path = Path(module_file)
        try:
            installed_bytes = artifact_path.read_bytes()
        except OSError as error:
            raise RuntimeError(
                f"evaluator artifact file is unavailable: {module_name}"
            ) from error
        spec = getattr(module, "__spec__", None)
        loader = getattr(spec, "loader", None)
        modules[module_name] = {
            "installed_file_name": artifact_path.name,
            "installed_file_sha256": hashlib.sha256(installed_bytes).hexdigest(),
            "loaded_identity": _stabilized_loaded_module_identity(module),
            "loader_type": _qualified_type_name(loader),
        }

    backend = default_backend()
    openssl_version = getattr(backend, "openssl_version_text", None)
    if not callable(openssl_version):
        raise RuntimeError("cryptography backend does not expose its runtime version")
    payload = {
        "domain": _EVALUATOR_ARTIFACT_DOMAIN,
        "modules": modules,
        "runtime": {
            "byteorder": sys.byteorder,
            "cryptography_version": cryptography.__version__,
            "machine": platform.machine(),
            "openssl_version": openssl_version(),
            "python_cache_tag": sys.implementation.cache_tag,
            "python_implementation": sys.implementation.name,
            "python_version": [
                sys.version_info.major,
                sys.version_info.minor,
                sys.version_info.micro,
                sys.version_info.releaselevel,
                sys.version_info.serial,
            ],
            "sys_platform": sys.platform,
        },
        "schema_version": _SCHEMA_VERSION,
        "scope": "loaded-python-code+installed-module-bytes+selected-runtime",
    }
    return hashlib.sha256(_canonical_json(payload).encode("utf-8")).hexdigest()


def _stabilized_loaded_module_identity(module: types.ModuleType) -> dict[str, Any]:
    """Return a stable loaded-code identity despite CPython quickening.

    CPython 3.11+ may specialize a code object the first time its nested code
    metadata is traversed. Require two consecutive identical snapshots so the
    first policy pin and every later evaluation produce the same identity.
    """

    previous = _loaded_module_identity(module)
    for _ in range(3):
        current = _loaded_module_identity(module)
        if current == previous:
            return current
        previous = current
    raise RuntimeError("loaded evaluator module identity did not stabilize")


def _loaded_module_identity(module: types.ModuleType) -> dict[str, Any]:
    functions: dict[str, Any] = {}
    classes: dict[str, Any] = {}
    constants: dict[str, Any] = {}
    for name, value in sorted(vars(module).items()):
        if type(value) is types.FunctionType and value.__module__ == module.__name__:
            functions[name] = _loaded_function_identity(value)
        elif isinstance(value, type) and value.__module__ == module.__name__:
            classes[name] = _loaded_class_identity(value)
        elif name.lstrip("_").isupper() and not callable(value):
            constants[name] = _stable_runtime_value(value)
    return {
        "classes": classes,
        "constants": constants,
        "functions": functions,
    }


def _loaded_class_identity(class_value: type[Any]) -> dict[str, Any]:
    methods: dict[str, Any] = {}
    for name, member in sorted(vars(class_value).items()):
        candidates: tuple[tuple[str, object], ...]
        if type(member) in {staticmethod, classmethod}:
            candidates = ((name, member.__func__),)
        elif type(member) is property:
            candidates = tuple(
                (f"{name}.{accessor_name}", accessor)
                for accessor_name, accessor in (
                    ("get", member.fget),
                    ("set", member.fset),
                    ("delete", member.fdel),
                )
                if accessor is not None
            )
        else:
            candidates = ((name, member),)
        for candidate_name, candidate in candidates:
            if type(candidate) is types.FunctionType:
                methods[candidate_name] = _loaded_function_identity(candidate)
    enum_members: dict[str, Any] = {}
    if issubclass(class_value, Enum):
        enum_members = {
            name: _stable_runtime_value(member.value)
            for name, member in class_value.__members__.items()
        }
    return {
        "bases": [
            f"{base.__module__}.{base.__qualname__}"
            for base in class_value.__bases__
        ],
        "enum_members": enum_members,
        "methods": methods,
        "slots": _stable_runtime_value(getattr(class_value, "__slots__", None)),
    }


def _loaded_function_identity(function: types.FunctionType) -> dict[str, Any]:
    closure = tuple(
        _stable_runtime_value(cell.cell_contents)
        for cell in (function.__closure__ or ())
    )
    return {
        "closure": list(closure),
        "code_sha256": hashlib.sha256(
            _canonical_json(_code_object_identity(function.__code__)).encode(
                "utf-8"
            )
        ).hexdigest(),
        "defaults": _stable_runtime_value(function.__defaults__),
        "keyword_defaults": _stable_runtime_value(function.__kwdefaults__),
    }


def _code_object_identity(code: types.CodeType) -> dict[str, Any]:
    """Canonical loaded-bytecode identity independent of marshal quickening."""

    return {
        "argcount": code.co_argcount,
        "cellvars": list(code.co_cellvars),
        "code_hex": code.co_code.hex(),
        "constants": [
            _code_constant_identity(value) for value in code.co_consts
        ],
        "exception_table_hex": code.co_exceptiontable.hex(),
        "flags": code.co_flags,
        "freevars": list(code.co_freevars),
        "kwonlyargcount": code.co_kwonlyargcount,
        "name": code.co_name,
        "names": list(code.co_names),
        "nlocals": code.co_nlocals,
        "posonlyargcount": code.co_posonlyargcount,
        "qualname": code.co_qualname,
        "stacksize": code.co_stacksize,
        "varnames": list(code.co_varnames),
    }


def _code_constant_identity(value: object) -> Any:
    if type(value) is types.CodeType:
        return {"code": _code_object_identity(value)}
    if type(value) is tuple:
        return {
            "tuple": [_code_constant_identity(item) for item in value]
        }
    if type(value) is frozenset:
        items = [_code_constant_identity(item) for item in value]
        return {
            "frozenset": sorted(
                items,
                key=lambda item: _canonical_json({"value": item}),
            )
        }
    if type(value) is complex:
        return {
            "complex_imag_hex": value.imag.hex(),
            "complex_real_hex": value.real.hex(),
        }
    if value is Ellipsis:
        return {"singleton": "Ellipsis"}
    return _stable_runtime_value(value)


def _stable_runtime_value(value: object) -> Any:
    if value is None or type(value) in {bool, int, str}:
        return value
    if type(value) is float:
        return {"float_hex": value.hex()}
    if type(value) is bytes:
        return {"bytes_hex": value.hex()}
    if isinstance(value, Enum):
        return {
            "enum": f"{type(value).__module__}.{type(value).__qualname__}",
            "value": _stable_runtime_value(value.value),
        }
    if type(value) in {tuple, list}:
        return [_stable_runtime_value(item) for item in value]
    if type(value) in {set, frozenset}:
        items = [_stable_runtime_value(item) for item in value]
        return {
            "set": sorted(
                items,
                key=lambda item: json.dumps(
                    item,
                    ensure_ascii=False,
                    sort_keys=True,
                    separators=(",", ":"),
                    allow_nan=False,
                ),
            )
        }
    if type(value) is dict:
        return {
            "mapping": [
                [_stable_runtime_value(key), _stable_runtime_value(item)]
                for key, item in sorted(
                    value.items(),
                    key=lambda pair: repr(pair[0]),
                )
            ]
        }
    if isinstance(value, re.Pattern):
        return {"regex_flags": value.flags, "regex_pattern": value.pattern}
    if isinstance(value, type):
        return {"type": f"{value.__module__}.{value.__qualname__}"}
    if type(value) is types.FunctionType:
        return {"function": f"{value.__module__}.{value.__qualname__}"}
    return {"type_only": _qualified_type_name(value)}


def _qualified_type_name(value: object) -> str:
    value_type = type(value)
    return f"{value_type.__module__}.{value_type.__qualname__}"


@dataclass(frozen=True, slots=True)
class BallPrediction:
    """One source-pixel ball-center candidate."""

    frame_identity: DecodedFrameIdentity
    candidate_id: str
    center: PixelPoint
    confidence: float

    def __post_init__(self) -> None:
        if type(self.frame_identity) is not DecodedFrameIdentity:
            raise ValueError("frame_identity must be a DecodedFrameIdentity")
        if type(self.candidate_id) is not str or not _ASCII_ID_RE.fullmatch(
            self.candidate_id
        ):
            raise ValueError(
                "candidate_id must be an ASCII-stable identifier of at most "
                "128 characters"
            )
        if type(self.center) is not PixelPoint:
            raise ValueError("center must be a PixelPoint")
        if (
            not isinstance(self.confidence, (int, float))
            or isinstance(self.confidence, bool)
            or not math.isfinite(self.confidence)
            or not 0.0 <= self.confidence <= 1.0
        ):
            raise ValueError("confidence must be a finite probability in [0, 1]")
        normalized = float(self.confidence)
        object.__setattr__(self, "confidence", 0.0 if normalized == 0.0 else normalized)

    @property
    def source_sha256(self) -> str:
        return self.frame_identity.source_sha256

    @property
    def selected_video_stream_index(self) -> int:
        return self.frame_identity.selected_video_stream_index

    @property
    def frame_index(self) -> int:
        return self.frame_identity.frame_index

    def to_canonical_dict(self) -> dict[str, Any]:
        return {
            "candidate_id": self.candidate_id,
            "center": self.center.to_canonical_dict(),
            "confidence": self.confidence,
            "frame_identity": self.frame_identity.to_canonical_dict(),
        }


@dataclass(frozen=True, slots=True)
class ConfidenceRankingPoint:
    """Cumulative full-ranking state after one complete confidence group."""

    confidence_threshold: float
    cumulative_prediction_count: int
    cumulative_true_positive_count: int

    def __post_init__(self) -> None:
        if (
            not isinstance(self.confidence_threshold, (int, float))
            or isinstance(self.confidence_threshold, bool)
            or not math.isfinite(self.confidence_threshold)
            or not 0.0 <= self.confidence_threshold <= 1.0
        ):
            raise ValueError("confidence_threshold must be a finite probability")
        normalized = float(self.confidence_threshold)
        object.__setattr__(
            self,
            "confidence_threshold",
            0.0 if normalized == 0.0 else normalized,
        )
        if (
            type(self.cumulative_prediction_count) is not int
            or self.cumulative_prediction_count <= 0
            or type(self.cumulative_true_positive_count) is not int
            or self.cumulative_true_positive_count < 0
            or self.cumulative_true_positive_count
            > self.cumulative_prediction_count
        ):
            raise ValueError("operating-point cumulative counts are invalid")

    def to_canonical_dict(self) -> dict[str, Any]:
        return {
            "confidence_threshold": self.confidence_threshold,
            "cumulative_prediction_count": self.cumulative_prediction_count,
            "cumulative_true_positive_count": self.cumulative_true_positive_count,
        }


@dataclass(frozen=True, slots=True)
class BallLocalizationReport:
    """Immutable aggregate returned by :func:`evaluate_ball_localization`.

    ``truth_set_sha256`` and ``prediction_set_sha256`` are explicit commitments
    because the aggregate report does not retain their raw preimages. The
    constructor recomputes ``evaluation_input_sha256`` from those commitments
    and every recorded trust proof, including the exact immutable annotation
    evidence generation. Independent verification of the commitment preimages
    requires retaining the original truth and prediction inputs.
    Confusion counts and both error populations describe the explicit operating
    threshold; confidence sweep points and AP101 describe the full ranking.
    Apparent diameters align positionally with the sorted pixel-error tuple;
    normalized errors are the independently sorted elementwise ratios.
    """

    truth_policy: TruthPolicy
    evaluation_manifest_sha256: str
    annotation_verification_policy: AnnotationVerificationPolicy
    annotation_verification_policy_sha256: str
    annotation_trust_store_sha256: str
    annotation_attestation_set_sha256: str
    annotation_evidence_set_sha256: str
    annotation_evidence_generation_id: str
    annotation_evidence_refs: tuple[str, ...]
    protected_configuration_generation: ProtectedAnnotationConfigurationGeneration
    protected_configuration_generation_sha256: str
    governance_domain_id: str
    evaluator_artifact_sha256: str
    verified_at_utc: str
    normalized_tolerance_ball_diameters: float
    operating_confidence_threshold: float
    truth_set_sha256: str
    prediction_set_sha256: str
    evaluation_input_sha256: str
    truth_frame_count: int
    prediction_count: int
    evaluated_frame_count: int
    evaluated_localizable_frame_count: int
    evaluated_negative_frame_count: int
    evaluated_prediction_count: int
    operating_prediction_count: int
    full_ranking_true_positive_count: int
    excluded_duplicate_frame_count: int
    excluded_duplicate_prediction_count: int
    activated_negative_frame_identities: tuple[DecodedFrameIdentity, ...]
    negative_frame_activation_count: int
    negative_frame_activation_rate: float
    state_counts: tuple[tuple[BallState, int], ...]
    confidence_ranking_points: tuple[ConfidenceRankingPoint, ...]
    matched_center_errors_px: tuple[float, ...]
    matched_apparent_minor_axis_diameters_px: tuple[float, ...]
    matched_center_errors_normalized: tuple[float, ...]
    true_positives: int
    false_positives: int
    false_negatives: int
    precision: float
    recall: float
    f1: float
    average_precision_101: float
    matched_center_error_mean_px: float | None
    matched_center_error_p50_px: float | None
    matched_center_error_p95_px: float | None
    matched_center_error_max_px: float | None
    matched_center_error_normalized_mean: float | None
    matched_center_error_normalized_p50: float | None
    matched_center_error_normalized_p95: float | None
    matched_center_error_normalized_max: float | None

    def __post_init__(self) -> None:
        if type(self.truth_policy) is not TruthPolicy:
            raise ValueError("truth_policy must be a TruthPolicy")
        if type(self.annotation_verification_policy) is not AnnotationVerificationPolicy:
            raise ValueError(
                "annotation_verification_policy must be an AnnotationVerificationPolicy"
            )
        for value, field_name in (
            (self.evaluation_manifest_sha256, "evaluation_manifest_sha256"),
            (
                self.annotation_verification_policy_sha256,
                "annotation_verification_policy_sha256",
            ),
            (
                self.annotation_trust_store_sha256,
                "annotation_trust_store_sha256",
            ),
            (
                self.annotation_attestation_set_sha256,
                "annotation_attestation_set_sha256",
            ),
            (
                self.annotation_evidence_set_sha256,
                "annotation_evidence_set_sha256",
            ),
            (
                self.annotation_evidence_generation_id,
                "annotation_evidence_generation_id",
            ),
            (
                self.protected_configuration_generation_sha256,
                "protected_configuration_generation_sha256",
            ),
            (self.evaluator_artifact_sha256, "evaluator_artifact_sha256"),
            (self.truth_set_sha256, "truth_set_sha256"),
            (self.prediction_set_sha256, "prediction_set_sha256"),
            (self.evaluation_input_sha256, "evaluation_input_sha256"),
        ):
            if type(value) is not str or not _SHA256_RE.fullmatch(value):
                raise ValueError(f"{field_name} must be a lowercase SHA-256")
        if self.annotation_verification_policy.fingerprint() != (
            self.annotation_verification_policy_sha256
        ):
            raise ValueError(
                "annotation_verification_policy_sha256 must match the policy"
            )
        if self.annotation_verification_policy.trust_store_sha256 != (
            self.annotation_trust_store_sha256
        ):
            raise ValueError("annotation trust-store proof does not match the policy")
        if self.annotation_verification_policy.evaluator_artifact_sha256 != (
            self.evaluator_artifact_sha256
        ):
            raise ValueError("evaluator artifact proof does not match the policy")
        if type(self.protected_configuration_generation) is not (
            ProtectedAnnotationConfigurationGeneration
        ):
            raise ValueError(
                "protected_configuration_generation must be a "
                "ProtectedAnnotationConfigurationGeneration"
            )
        if self.protected_configuration_generation.fingerprint() != (
            self.protected_configuration_generation_sha256
        ):
            raise ValueError(
                "protected_configuration_generation_sha256 must match the exact "
                "protected_configuration_generation"
            )
        if (
            type(self.governance_domain_id) is not str
            or not _ASCII_ID_RE.fullmatch(self.governance_domain_id)
        ):
            raise ValueError(
                "governance_domain_id must be an ASCII-stable identifier"
            )
        protected_configuration = self.protected_configuration_generation
        protected_component_comparisons = (
            (
                protected_configuration.annotation_trust_store_sha256,
                self.annotation_trust_store_sha256,
                "annotation_trust_store_sha256",
            ),
            (
                protected_configuration.annotation_verification_policy_sha256,
                self.annotation_verification_policy_sha256,
                "annotation_verification_policy_sha256",
            ),
            (
                protected_configuration.evaluator_artifact_sha256,
                self.evaluator_artifact_sha256,
                "evaluator_artifact_sha256",
            ),
            (
                protected_configuration.governance_domain_id,
                self.governance_domain_id,
                "governance_domain_id",
            ),
            (
                self.annotation_verification_policy.governance_domain_id,
                self.governance_domain_id,
                "annotation policy governance_domain_id",
            ),
        )
        for declared, reported, field_name in protected_component_comparisons:
            if declared != reported:
                raise ValueError(
                    "protected_configuration_generation must match report "
                    f"{field_name}"
                )
        if not self.annotation_verification_policy.permits_truth_policy(
            self.truth_policy.value
        ):
            raise ValueError("truth_policy is weaker than the protected minimum")
        if type(self.annotation_evidence_refs) is not tuple:
            raise ValueError("annotation_evidence_refs must be an immutable tuple")
        if annotation_evidence_set_fingerprint(self.annotation_evidence_refs) != (
            self.annotation_evidence_set_sha256
        ):
            raise ValueError(
                "annotation_evidence_set_sha256 must match annotation_evidence_refs"
            )
        raw_evidence_digests = tuple(
            reference.removeprefix("sha256:")
            for reference in self.annotation_evidence_refs
        )
        if generation_id_for(raw_evidence_digests) != (
            self.annotation_evidence_generation_id
        ):
            raise ValueError(
                "annotation_evidence_generation_id must commit the exact "
                "annotation_evidence_refs"
            )
        if type(self.verified_at_utc) is not str or not _UTC_TIMESTAMP_RE.fullmatch(
            self.verified_at_utc
        ):
            raise ValueError("verified_at_utc must be a canonical UTC timestamp")
        try:
            parsed_verified_at = datetime.fromisoformat(
                self.verified_at_utc[:-1] + "+00:00"
            )
        except ValueError as error:
            raise ValueError(
                "verified_at_utc must be a canonical UTC timestamp"
            ) from error
        if parsed_verified_at.astimezone(timezone.utc).isoformat(
            timespec="microseconds"
        ).replace("+00:00", "Z") != self.verified_at_utc:
            raise ValueError("verified_at_utc must be a canonical UTC timestamp")
        if not self.annotation_verification_policy.is_active(
            parsed_verified_at.date()
        ):
            raise ValueError(
                "verified_at_utc must fall within the verification policy validity window"
            )
        if (
            type(self.normalized_tolerance_ball_diameters) is not float
            or not math.isfinite(self.normalized_tolerance_ball_diameters)
            or self.normalized_tolerance_ball_diameters <= 0.0
        ):
            raise ValueError(
                "normalized_tolerance_ball_diameters must be a finite positive float"
            )
        if (
            type(self.operating_confidence_threshold) is not float
            or not math.isfinite(self.operating_confidence_threshold)
            or not 0.0 <= self.operating_confidence_threshold <= 1.0
        ):
            raise ValueError(
                "operating_confidence_threshold must be a finite float in [0, 1]"
            )
        count_fields = (
            "truth_frame_count",
            "prediction_count",
            "evaluated_frame_count",
            "evaluated_localizable_frame_count",
            "evaluated_negative_frame_count",
            "evaluated_prediction_count",
            "operating_prediction_count",
            "full_ranking_true_positive_count",
            "excluded_duplicate_frame_count",
            "excluded_duplicate_prediction_count",
            "negative_frame_activation_count",
            "true_positives",
            "false_positives",
            "false_negatives",
        )
        if any(
            type(getattr(self, name)) is not int or getattr(self, name) < 0
            for name in count_fields
        ):
            raise ValueError("report counts must be non-negative integers")
        if self.truth_frame_count != (
            self.evaluated_frame_count + self.excluded_duplicate_frame_count
        ):
            raise ValueError("truth-frame counts are inconsistent")
        if self.prediction_count != (
            self.evaluated_prediction_count + self.excluded_duplicate_prediction_count
        ):
            raise ValueError("prediction counts are inconsistent")
        if self.evaluated_frame_count != (
            self.evaluated_localizable_frame_count + self.evaluated_negative_frame_count
        ):
            raise ValueError("evaluated frame counts are inconsistent")
        if self.evaluated_localizable_frame_count != (
            self.true_positives + self.false_negatives
        ):
            raise ValueError("localizable truth counts are inconsistent")
        if self.operating_prediction_count != (
            self.true_positives + self.false_positives
        ):
            raise ValueError("operating-threshold prediction counts are inconsistent")
        if self.operating_prediction_count > self.evaluated_prediction_count:
            raise ValueError(
                "operating prediction count cannot exceed the full-ranking count"
            )
        if (
            self.full_ranking_true_positive_count
            > self.evaluated_localizable_frame_count
        ):
            raise ValueError(
                "full-ranking true positives cannot exceed localizable truth"
            )
        if self.negative_frame_activation_count > min(
            self.evaluated_negative_frame_count,
            self.operating_prediction_count,
            self.false_positives,
        ):
            raise ValueError("negative-frame activation count is inconsistent")
        if (
            type(self.activated_negative_frame_identities) is not tuple
            or any(
                type(identity) is not DecodedFrameIdentity
                for identity in self.activated_negative_frame_identities
            )
        ):
            raise ValueError(
                "activated_negative_frame_identities must be an immutable tuple"
            )
        activation_identity_keys = tuple(
            (
                identity.source_sha256,
                identity.selected_video_stream_index,
                identity.frame_index,
            )
            for identity in self.activated_negative_frame_identities
        )
        if (
            tuple(sorted(activation_identity_keys)) != activation_identity_keys
            or len(set(activation_identity_keys)) != len(activation_identity_keys)
            or len(activation_identity_keys) != self.negative_frame_activation_count
        ):
            raise ValueError(
                "activated negative-frame identities must be sorted, unique, and "
                "match the activation count"
            )
        if (
            type(self.negative_frame_activation_rate) is not float
            or not math.isfinite(self.negative_frame_activation_rate)
            or not 0.0 <= self.negative_frame_activation_rate <= 1.0
            or self.negative_frame_activation_rate
            != _safe_ratio(
                self.negative_frame_activation_count,
                self.evaluated_negative_frame_count,
            )
        ):
            raise ValueError("negative_frame_activation_rate is inconsistent")
        expected_evaluation_input_sha256 = _evaluation_input_sha256_from_commitments(
            truth_set_sha256=self.truth_set_sha256,
            prediction_set_sha256=self.prediction_set_sha256,
            truth_frame_count=self.truth_frame_count,
            prediction_count=self.prediction_count,
            normalized_tolerance_ball_diameters=(
                self.normalized_tolerance_ball_diameters
            ),
            operating_confidence_threshold=self.operating_confidence_threshold,
            truth_policy=self.truth_policy,
            evaluation_manifest_sha256=self.evaluation_manifest_sha256,
            annotation_verification_policy=self.annotation_verification_policy,
            annotation_verification_policy_sha256=(
                self.annotation_verification_policy_sha256
            ),
            annotation_trust_store_sha256=self.annotation_trust_store_sha256,
            annotation_attestation_set_sha256=(
                self.annotation_attestation_set_sha256
            ),
            annotation_evidence_set_sha256=self.annotation_evidence_set_sha256,
            annotation_evidence_generation_id=(
                self.annotation_evidence_generation_id
            ),
            annotation_evidence_refs=self.annotation_evidence_refs,
            protected_configuration_generation=(
                self.protected_configuration_generation
            ),
            protected_configuration_generation_sha256=(
                self.protected_configuration_generation_sha256
            ),
            governance_domain_id=self.governance_domain_id,
            evaluator_artifact_sha256=self.evaluator_artifact_sha256,
            verified_at_utc=self.verified_at_utc,
        )
        if self.evaluation_input_sha256 != expected_evaluation_input_sha256:
            raise ValueError(
                "evaluation_input_sha256 does not match the report's input commitments"
            )

        expected_states = tuple(BallState)
        if (
            type(self.state_counts) is not tuple
            or tuple(state for state, _ in self.state_counts) != expected_states
            or any(type(count) is not int or count < 0 for _, count in self.state_counts)
            or sum(count for _, count in self.state_counts) != self.evaluated_frame_count
        ):
            raise ValueError("state_counts must contain every BallState in enum order")
        if sum(
            count for state, count in self.state_counts if state in _LOCALIZABLE_STATES
        ) != self.evaluated_localizable_frame_count:
            raise ValueError("state_counts localizable total is inconsistent")
        if sum(
            count for state, count in self.state_counts if state in _NEGATIVE_STATES
        ) != self.evaluated_negative_frame_count:
            raise ValueError("state_counts negative total is inconsistent")

        if (
            type(self.confidence_ranking_points) is not tuple
            or any(
                type(point) is not ConfidenceRankingPoint
                for point in self.confidence_ranking_points
            )
        ):
            raise ValueError(
                "confidence_ranking_points must be a tuple of "
                "ConfidenceRankingPoint values"
            )
        previous_threshold = math.inf
        previous_prediction_count = 0
        previous_true_positive_count = 0
        for point in self.confidence_ranking_points:
            if point.confidence_threshold >= previous_threshold:
                raise ValueError(
                    "confidence-ranking thresholds must be strictly descending"
                )
            if point.cumulative_prediction_count <= previous_prediction_count:
                raise ValueError(
                    "confidence-ranking prediction counts must be strictly increasing"
                )
            if (
                point.cumulative_true_positive_count
                < previous_true_positive_count
                or point.cumulative_true_positive_count
                - previous_true_positive_count
                > point.cumulative_prediction_count - previous_prediction_count
                or point.cumulative_true_positive_count
                > self.evaluated_localizable_frame_count
            ):
                raise ValueError("confidence-ranking true-positive counts are inconsistent")
            previous_threshold = point.confidence_threshold
            previous_prediction_count = point.cumulative_prediction_count
            previous_true_positive_count = point.cumulative_true_positive_count
        if self.evaluated_prediction_count == 0:
            if (
                self.confidence_ranking_points
                or self.full_ranking_true_positive_count != 0
            ):
                raise ValueError("zero predictions require no operating points")
        elif (
            not self.confidence_ranking_points
            or previous_prediction_count != self.evaluated_prediction_count
            or previous_true_positive_count
            != self.full_ranking_true_positive_count
        ):
            raise ValueError("final ranking point does not match report counts")

        selected_operating_point: ConfidenceRankingPoint | None = None
        for point in self.confidence_ranking_points:
            if point.confidence_threshold >= self.operating_confidence_threshold:
                selected_operating_point = point
        expected_operating_prediction_count = (
            selected_operating_point.cumulative_prediction_count
            if selected_operating_point is not None
            else 0
        )
        expected_operating_true_positives = (
            selected_operating_point.cumulative_true_positive_count
            if selected_operating_point is not None
            else 0
        )
        if (
            self.operating_prediction_count
            != expected_operating_prediction_count
            or self.true_positives != expected_operating_true_positives
            or self.false_positives
            != expected_operating_prediction_count
            - expected_operating_true_positives
            or self.false_negatives
            != self.evaluated_localizable_frame_count
            - expected_operating_true_positives
        ):
            raise ValueError(
                "operating-threshold confusion counts do not match the ranking evidence"
            )

        for name in ("precision", "recall", "f1", "average_precision_101"):
            value = getattr(self, name)
            if (
                type(value) is not float
                or not math.isfinite(value)
                or not 0.0 <= value <= 1.0
            ):
                raise ValueError(f"{name} must be a finite probability")

        expected_precision = _safe_ratio(
            self.true_positives,
            self.true_positives + self.false_positives,
        )
        expected_recall = _safe_ratio(
            self.true_positives,
            self.true_positives + self.false_negatives,
        )
        expected_f1 = _safe_ratio(
            2.0 * expected_precision * expected_recall,
            expected_precision + expected_recall,
        )
        expected_ap = (
            _average_precision_101(
                [
                    (
                        point.cumulative_true_positive_count
                        / self.evaluated_localizable_frame_count,
                        point.cumulative_true_positive_count
                        / point.cumulative_prediction_count,
                    )
                    for point in self.confidence_ranking_points
                ]
            )
            if self.evaluated_localizable_frame_count
            else 0.0
        )
        derived_metrics = (
            ("precision", self.precision, expected_precision),
            ("recall", self.recall, expected_recall),
            ("f1", self.f1, expected_f1),
            ("average_precision_101", self.average_precision_101, expected_ap),
        )
        for name, actual, expected in derived_metrics:
            if actual != expected:
                raise ValueError(f"{name} does not match the report evidence")

        if (
            type(self.matched_center_errors_px) is not tuple
            or any(
                type(error) is not float
                or not math.isfinite(error)
                or error < 0.0
                for error in self.matched_center_errors_px
            )
            or tuple(sorted(self.matched_center_errors_px))
            != self.matched_center_errors_px
            or len(self.matched_center_errors_px) != self.true_positives
        ):
            raise ValueError(
                "matched_center_errors_px must be a sorted tuple containing one "
                "finite non-negative float per true positive"
            )
        if (
            type(self.matched_apparent_minor_axis_diameters_px) is not tuple
            or len(self.matched_apparent_minor_axis_diameters_px)
            != len(self.matched_center_errors_px)
            or any(
                type(diameter) is not float
                or not math.isfinite(diameter)
                or diameter <= 0.0
                for diameter in self.matched_apparent_minor_axis_diameters_px
            )
        ):
            raise ValueError(
                "matched apparent diameters must contain one finite positive float "
                "per true positive"
            )
        expected_normalized_errors = tuple(
            sorted(
                _normalized_center_error(error, diameter)
                for error, diameter in zip(
                    self.matched_center_errors_px,
                    self.matched_apparent_minor_axis_diameters_px,
                    strict=True,
                )
            )
        )
        if (
            type(self.matched_center_errors_normalized) is not tuple
            or any(
                type(error) is not float
                or not math.isfinite(error)
                or error < 0.0
                or error > self.normalized_tolerance_ball_diameters
                for error in self.matched_center_errors_normalized
            )
            or tuple(sorted(self.matched_center_errors_normalized))
            != self.matched_center_errors_normalized
            or self.matched_center_errors_normalized
            != expected_normalized_errors
        ):
            raise ValueError(
                "matched_center_errors_normalized must match pixel errors divided "
                "by apparent minor-axis diameters"
            )

        expected_mean = (
            math.fsum(self.matched_center_errors_px)
            / len(self.matched_center_errors_px)
            if self.matched_center_errors_px
            else None
        )
        expected_p50 = _linear_percentile(list(self.matched_center_errors_px), 0.50)
        expected_p95 = _linear_percentile(list(self.matched_center_errors_px), 0.95)
        expected_max = (
            self.matched_center_errors_px[-1]
            if self.matched_center_errors_px
            else None
        )
        expected_normalized_mean = (
            math.fsum(self.matched_center_errors_normalized)
            / len(self.matched_center_errors_normalized)
            if self.matched_center_errors_normalized
            else None
        )
        expected_normalized_p50 = _linear_percentile(
            list(self.matched_center_errors_normalized),
            0.50,
        )
        expected_normalized_p95 = _linear_percentile(
            list(self.matched_center_errors_normalized),
            0.95,
        )
        expected_normalized_max = (
            self.matched_center_errors_normalized[-1]
            if self.matched_center_errors_normalized
            else None
        )
        derived_errors = (
            (
                "matched_center_error_mean_px",
                self.matched_center_error_mean_px,
                expected_mean,
            ),
            (
                "matched_center_error_p50_px",
                self.matched_center_error_p50_px,
                expected_p50,
            ),
            (
                "matched_center_error_p95_px",
                self.matched_center_error_p95_px,
                expected_p95,
            ),
            (
                "matched_center_error_max_px",
                self.matched_center_error_max_px,
                expected_max,
            ),
            (
                "matched_center_error_normalized_mean",
                self.matched_center_error_normalized_mean,
                expected_normalized_mean,
            ),
            (
                "matched_center_error_normalized_p50",
                self.matched_center_error_normalized_p50,
                expected_normalized_p50,
            ),
            (
                "matched_center_error_normalized_p95",
                self.matched_center_error_normalized_p95,
                expected_normalized_p95,
            ),
            (
                "matched_center_error_normalized_max",
                self.matched_center_error_normalized_max,
                expected_normalized_max,
            ),
        )
        for name, actual, expected in derived_errors:
            if expected is None:
                valid = actual is None
            else:
                valid = type(actual) is float and actual == expected
            if not valid:
                raise ValueError(f"{name} does not match the recorded error population")

    def to_canonical_dict(self) -> dict[str, Any]:
        state_counts = {state.value: count for state, count in self.state_counts}
        return {
            "annotation_trust": {
                "attestation_set_sha256": self.annotation_attestation_set_sha256,
                "evidence_refs": list(self.annotation_evidence_refs),
                "evidence_generation_id": self.annotation_evidence_generation_id,
                "evidence_set_sha256": self.annotation_evidence_set_sha256,
                "evaluation_manifest_sha256": self.evaluation_manifest_sha256,
                "evaluator_artifact_sha256": self.evaluator_artifact_sha256,
                "governance_domain_id": self.governance_domain_id,
                "protected_configuration_generation": (
                    self.protected_configuration_generation.to_canonical_dict()
                ),
                "protected_configuration_generation_sha256": (
                    self.protected_configuration_generation_sha256
                ),
                "trust_store_sha256": self.annotation_trust_store_sha256,
                "verification_policy": (
                    self.annotation_verification_policy.to_canonical_dict()
                ),
                "verification_policy_sha256": (
                    self.annotation_verification_policy_sha256
                ),
                "verified_at_utc": self.verified_at_utc,
            },
            "center_error_px": {
                "matched_apparent_minor_axis_diameters_px": list(
                    self.matched_apparent_minor_axis_diameters_px
                ),
                "matched_max": self.matched_center_error_max_px,
                "matched_mean": self.matched_center_error_mean_px,
                "matched_p50": self.matched_center_error_p50_px,
                "matched_p95": self.matched_center_error_p95_px,
                "matched_values": list(self.matched_center_errors_px),
            },
            "center_error_normalized_by_apparent_minor_axis": {
                "matched_max": self.matched_center_error_normalized_max,
                "matched_mean": self.matched_center_error_normalized_mean,
                "matched_p50": self.matched_center_error_normalized_p50,
                "matched_p95": self.matched_center_error_normalized_p95,
                "matched_values": list(self.matched_center_errors_normalized),
            },
            "confidence_ranking_points": [
                point.to_canonical_dict()
                for point in self.confidence_ranking_points
            ],
            "counts": {
                "evaluated_frames": self.evaluated_frame_count,
                "evaluated_localizable_frames": self.evaluated_localizable_frame_count,
                "evaluated_negative_frames": self.evaluated_negative_frame_count,
                "evaluated_predictions": self.evaluated_prediction_count,
                "excluded_duplicate_frames": self.excluded_duplicate_frame_count,
                "excluded_duplicate_predictions": self.excluded_duplicate_prediction_count,
                "full_ranking_true_positives": (
                    self.full_ranking_true_positive_count
                ),
                "input_predictions": self.prediction_count,
                "input_truth_frames": self.truth_frame_count,
            },
            "evaluation_input_sha256": self.evaluation_input_sha256,
            "input_commitments": {
                "prediction_set_sha256": self.prediction_set_sha256,
                "truth_set_sha256": self.truth_set_sha256,
            },
            "metric": _METRIC_NAME,
            "localization_metrics_defined": self.localization_metrics_defined,
            "metrics": {
                "average_precision_101": self.average_precision_101,
                "operating_f1": self.f1,
                "operating_precision": self.precision,
                "operating_recall": self.recall,
            },
            "operating_point": {
                "activated_negative_frames": [
                    identity.to_canonical_dict()
                    for identity in self.activated_negative_frame_identities
                ],
                "confidence_threshold": self.operating_confidence_threshold,
                "false_negatives": self.false_negatives,
                "false_positives": self.false_positives,
                "negative_frame_activation_count": (
                    self.negative_frame_activation_count
                ),
                "negative_frame_activation_rate": self.negative_frame_activation_rate,
                "prediction_count": self.operating_prediction_count,
                "true_positives": self.true_positives,
            },
            "normalized_tolerance_ball_diameters": (
                self.normalized_tolerance_ball_diameters
            ),
            "schema_version": _SCHEMA_VERSION,
            "state_counts": state_counts,
            "truth_policy": self.truth_policy.value,
        }

    @property
    def localization_metrics_defined(self) -> bool:
        """Whether the suite contains positive truth for localization metrics."""

        return self.evaluated_localizable_frame_count > 0

    def canonical_json(self) -> str:
        return _canonical_json(self.to_canonical_dict())

    def fingerprint(self) -> str:
        return hashlib.sha256(self.canonical_json().encode("utf-8")).hexdigest()


def evaluate_ball_localization(
    truth: tuple[BallFrameAnnotation, ...],
    predictions: tuple[BallPrediction, ...],
    *,
    normalized_tolerance_ball_diameters: float,
    operating_confidence_threshold: float,
    truth_policy: TruthPolicy = TruthPolicy.ADJUDICATED_ONLY,
    evaluation_manifest_sha256: str,
    annotation_attestations: tuple[AnnotationAttestation, ...],
    annotation_trust_store: AnnotationTrustStore,
    annotation_evidence_store_root: Path,
    annotation_protected_configuration_generation_path: Path,
    annotation_verification_policy: AnnotationVerificationPolicy,
    expected_annotation_verification_policy_sha256: str,
) -> BallLocalizationReport:
    """Evaluate candidates only after cryptographic annotation verification.

    The expected policy fingerprint is mandatory and must be loaded from a
    protected source independent of ``annotation_verification_policy``. This
    function intentionally provides no derive-the-pin or default-policy path.
    Confusion counts and localization errors are computed only from candidates
    at or above ``operating_confidence_threshold``; AP101 uses the full ranking.
    Matching always uses ``normalized_tolerance_ball_diameters``. No fixed-pixel
    matching fallback exists.
    """

    if type(truth) is not tuple:
        raise ValueError("truth must be an immutable tuple")
    if type(predictions) is not tuple:
        raise ValueError("predictions must be an immutable tuple")
    if len(truth) > _MAX_TRUTH_FRAME_COUNT:
        raise ValueError(
            f"truth cannot exceed {_MAX_TRUTH_FRAME_COUNT} frames"
        )
    if len(predictions) > _MAX_PREDICTION_COUNT:
        raise ValueError(
            f"predictions cannot exceed {_MAX_PREDICTION_COUNT} candidates"
        )
    if any(type(annotation) is not BallFrameAnnotation for annotation in truth):
        raise ValueError("truth must contain only BallFrameAnnotation values")
    if any(type(prediction) is not BallPrediction for prediction in predictions):
        raise ValueError("predictions must contain only BallPrediction values")
    if type(truth_policy) is not TruthPolicy:
        raise ValueError("truth_policy must be a TruthPolicy enum value")
    if type(evaluation_manifest_sha256) is not str or not _SHA256_RE.fullmatch(
        evaluation_manifest_sha256
    ):
        raise ValueError("evaluation_manifest_sha256 must be a lowercase SHA-256")
    if type(annotation_attestations) is not tuple:
        raise ValueError("annotation_attestations must be an immutable tuple")
    if type(annotation_trust_store) is not AnnotationTrustStore:
        raise ValueError("annotation_trust_store must be an AnnotationTrustStore")
    if not isinstance(annotation_evidence_store_root, Path):
        raise ValueError(
            "annotation_evidence_store_root must be a pathlib.Path"
        )
    if not isinstance(annotation_protected_configuration_generation_path, Path):
        raise ValueError(
            "annotation_protected_configuration_generation_path must be a "
            "pathlib.Path"
        )
    if type(annotation_verification_policy) is not AnnotationVerificationPolicy:
        raise ValueError(
            "annotation_verification_policy must be an AnnotationVerificationPolicy"
        )
    if (
        type(expected_annotation_verification_policy_sha256) is not str
        or not _SHA256_RE.fullmatch(
            expected_annotation_verification_policy_sha256
        )
    ):
        raise ValueError(
            "expected_annotation_verification_policy_sha256 must be a lowercase SHA-256"
        )
    if (
        not isinstance(operating_confidence_threshold, (int, float))
        or isinstance(operating_confidence_threshold, bool)
        or not math.isfinite(operating_confidence_threshold)
        or not 0.0 <= operating_confidence_threshold <= 1.0
    ):
        raise ValueError(
            "operating_confidence_threshold must be a finite probability in [0, 1]"
        )
    normalized_operating_threshold = float(operating_confidence_threshold)
    if normalized_operating_threshold == 0.0:
        normalized_operating_threshold = 0.0
    if (
        not isinstance(normalized_tolerance_ball_diameters, (int, float))
        or isinstance(normalized_tolerance_ball_diameters, bool)
        or not math.isfinite(normalized_tolerance_ball_diameters)
        or normalized_tolerance_ball_diameters <= 0.0
    ):
        raise ValueError(
            "normalized_tolerance_ball_diameters must be a finite positive number"
        )
    normalized_tolerance = float(normalized_tolerance_ball_diameters)

    truth_by_frame: dict[tuple[str, int, int], BallFrameAnnotation] = {}
    annotation_ids: set[str] = set()
    for annotation in truth:
        _validate_truth_review(annotation, truth_policy)
        if annotation.annotation_id in annotation_ids:
            raise ValueError(
                "annotation IDs must be unique within an evaluation: "
                + annotation.annotation_id
            )
        annotation_ids.add(annotation.annotation_id)
        frame_key = _frame_key_from_truth(annotation)
        if frame_key in truth_by_frame:
            raise ValueError(
                "truth must contain exactly one BallFrameAnnotation per source frame"
            )
        truth_by_frame[frame_key] = annotation

    candidate_ids: set[str] = set()
    prediction_counts_by_frame: dict[tuple[str, int, int], int] = {}
    for prediction in predictions:
        frame_key = _frame_key_from_prediction(prediction)
        frame_prediction_count = prediction_counts_by_frame.get(frame_key, 0) + 1
        if frame_prediction_count > _MAX_PREDICTIONS_PER_FRAME:
            raise ValueError(
                "predictions cannot exceed "
                f"{_MAX_PREDICTIONS_PER_FRAME} candidates per frame"
            )
        prediction_counts_by_frame[frame_key] = frame_prediction_count
        if prediction.candidate_id in candidate_ids:
            raise ValueError(f"duplicate candidate_id: {prediction.candidate_id}")
        candidate_ids.add(prediction.candidate_id)
        annotation = truth_by_frame.get(frame_key)
        if annotation is None:
            raise ValueError(
                "prediction references an unknown truth frame: "
                f"{prediction.source_sha256}:stream-"
                f"{prediction.selected_video_stream_index}:{prediction.frame_index}"
            )
        if prediction.frame_identity != annotation.frame.identity:
            raise ValueError(
                f"prediction {prediction.candidate_id!r} does not match the full "
                "decoded-frame identity of its truth frame"
            )
        frame = annotation.frame
        if not (
            0.0 <= prediction.center.x <= frame.width - 1
            and 0.0 <= prediction.center.y <= frame.height - 1
        ):
            raise ValueError(
                f"prediction {prediction.candidate_id!r} center is outside source frame bounds"
            )

    evaluator_artifact_sha256 = ball_localization_evaluator_artifact_sha256()
    annotation_verification = annotation_trust_store.verify_annotation_set(
        truth,
        annotation_attestations,
        evidence_store_root=annotation_evidence_store_root,
        protected_configuration_generation_path=(
            annotation_protected_configuration_generation_path
        ),
        verification_policy=annotation_verification_policy,
        expected_verification_policy_sha256=(
            expected_annotation_verification_policy_sha256
        ),
        evaluator_artifact_sha256=evaluator_artifact_sha256,
        requested_truth_policy=truth_policy.value,
    )
    if annotation_verification.requested_truth_policy.value != truth_policy.value:
        raise RuntimeError(
            "annotation trust verification did not bind the requested truth policy"
        )

    duplicate_frame_keys = _validated_duplicate_frame_keys(truth_by_frame)
    evaluated_truth = tuple(
        annotation
        for annotation in truth
        if not annotation.frame.is_excludable_capture_duplicate
    )
    evaluated_predictions = tuple(
        prediction
        for prediction in predictions
        if _frame_key_from_prediction(prediction) not in duplicate_frame_keys
    )

    localizable_truth = {
        _frame_key_from_truth(annotation): annotation
        for annotation in evaluated_truth
        if annotation.state in _LOCALIZABLE_STATES
    }

    matched_frames: set[tuple[str, int, int]] = set()
    matched_error_evidence: dict[
        tuple[str, int, int],
        tuple[float, float],
    ] = {}
    operating_matched_error_evidence: dict[
        tuple[str, int, int],
        tuple[float, float],
    ] = {}
    confidence_ranking_points: list[ConfidenceRankingPoint] = []
    predictions_by_confidence: dict[float, list[BallPrediction]] = {}
    for prediction in evaluated_predictions:
        predictions_by_confidence.setdefault(prediction.confidence, []).append(
            prediction
        )

    processed_prediction_count = 0
    for confidence in sorted(predictions_by_confidence, reverse=True):
        confidence_group = predictions_by_confidence[confidence]
        group_by_frame: dict[tuple[str, int, int], list[BallPrediction]] = {}
        for prediction in confidence_group:
            group_by_frame.setdefault(
                _frame_key_from_prediction(prediction),
                [],
            ).append(prediction)

        newly_matched_errors: dict[
            tuple[str, int, int],
            tuple[float, float],
        ] = {}
        for frame_key, frame_predictions in group_by_frame.items():
            annotation = localizable_truth.get(frame_key)
            if annotation is None or frame_key in matched_frames:
                continue
            assert annotation.center is not None
            assert annotation.apparent_minor_axis_diameter_px is not None
            valid_errors: list[float] = []
            for prediction in frame_predictions:
                error = math.hypot(
                    prediction.center.x - annotation.center.x,
                    prediction.center.y - annotation.center.y,
                )
                normalized_error = _normalized_center_error(
                    error,
                    annotation.apparent_minor_axis_diameter_px,
                )
                if normalized_error <= normalized_tolerance:
                    valid_errors.append(error)
            if valid_errors:
                newly_matched_errors[frame_key] = (
                    min(valid_errors),
                    annotation.apparent_minor_axis_diameter_px,
                )

        matched_frames.update(newly_matched_errors)
        matched_error_evidence.update(newly_matched_errors)
        processed_prediction_count += len(confidence_group)
        confidence_ranking_points.append(
            ConfidenceRankingPoint(
                confidence_threshold=confidence,
                cumulative_prediction_count=processed_prediction_count,
                cumulative_true_positive_count=len(matched_frames),
            )
        )
        if confidence >= normalized_operating_threshold:
            operating_matched_error_evidence = dict(matched_error_evidence)

    operating_predictions = tuple(
        prediction
        for prediction in evaluated_predictions
        if prediction.confidence >= normalized_operating_threshold
    )
    operating_prediction_count = len(operating_predictions)
    true_positives = len(operating_matched_error_evidence)
    full_ranking_true_positives = len(matched_frames)
    false_positives = operating_prediction_count - true_positives
    false_negatives = len(localizable_truth) - true_positives
    precision = _safe_ratio(true_positives, true_positives + false_positives)
    recall = _safe_ratio(true_positives, true_positives + false_negatives)
    f1 = _safe_ratio(2.0 * precision * recall, precision + recall)
    average_precision = (
        _average_precision_101(
            [
                (
                    point.cumulative_true_positive_count / len(localizable_truth),
                    point.cumulative_true_positive_count
                    / point.cumulative_prediction_count,
                )
                for point in confidence_ranking_points
            ]
        )
        if localizable_truth
        else 0.0
    )

    sorted_error_evidence = sorted(operating_matched_error_evidence.values())
    sorted_errors = [error for error, _ in sorted_error_evidence]
    matched_diameters = [diameter for _, diameter in sorted_error_evidence]
    normalized_errors = sorted(
        _normalized_center_error(error, diameter)
        for error, diameter in sorted_error_evidence
    )
    mean_error = (
        math.fsum(sorted_errors) / len(sorted_errors) if sorted_errors else None
    )
    p50_error = _linear_percentile(sorted_errors, 0.50)
    p95_error = _linear_percentile(sorted_errors, 0.95)
    max_error = sorted_errors[-1] if sorted_errors else None
    normalized_mean_error = (
        math.fsum(normalized_errors) / len(normalized_errors)
        if normalized_errors
        else None
    )
    normalized_p50_error = _linear_percentile(normalized_errors, 0.50)
    normalized_p95_error = _linear_percentile(normalized_errors, 0.95)
    normalized_max_error = normalized_errors[-1] if normalized_errors else None

    state_counts = tuple(
        (state, sum(annotation.state is state for annotation in evaluated_truth))
        for state in BallState
    )
    negative_frame_count = sum(
        count for state, count in state_counts if state in _NEGATIVE_STATES
    )
    negative_frame_keys = {
        _frame_key_from_truth(annotation)
        for annotation in evaluated_truth
        if annotation.state in _NEGATIVE_STATES
    }
    activated_negative_frame_keys = {
        _frame_key_from_prediction(prediction)
        for prediction in operating_predictions
        if _frame_key_from_prediction(prediction) in negative_frame_keys
    }
    activated_negative_frame_identities = tuple(
        truth_by_frame[frame_key].frame.identity
        for frame_key in sorted(activated_negative_frame_keys)
    )
    negative_frame_activation_count = len(activated_negative_frame_keys)
    negative_frame_activation_rate = _safe_ratio(
        negative_frame_activation_count,
        negative_frame_count,
    )
    truth_set_sha256 = _truth_set_sha256(truth)
    prediction_set_sha256 = _prediction_set_sha256(predictions)
    evaluation_input_sha256 = _evaluation_input_sha256_from_commitments(
        truth_set_sha256=truth_set_sha256,
        prediction_set_sha256=prediction_set_sha256,
        truth_frame_count=len(truth),
        prediction_count=len(predictions),
        normalized_tolerance_ball_diameters=normalized_tolerance,
        operating_confidence_threshold=normalized_operating_threshold,
        truth_policy=truth_policy,
        evaluation_manifest_sha256=evaluation_manifest_sha256,
        annotation_verification_policy=annotation_verification_policy,
        annotation_verification_policy_sha256=(
            annotation_verification.verification_policy_sha256
        ),
        annotation_trust_store_sha256=annotation_verification.trust_store_sha256,
        annotation_attestation_set_sha256=(
            annotation_verification.attestation_set_sha256
        ),
        annotation_evidence_set_sha256=annotation_verification.evidence_set_sha256,
        annotation_evidence_generation_id=(
            annotation_verification.evidence_generation_id
        ),
        annotation_evidence_refs=annotation_verification.verified_evidence_refs,
        protected_configuration_generation=(
            annotation_verification.protected_configuration_generation
        ),
        protected_configuration_generation_sha256=(
            annotation_verification.protected_configuration_generation_sha256
        ),
        governance_domain_id=annotation_verification.governance_domain_id,
        evaluator_artifact_sha256=annotation_verification.evaluator_artifact_sha256,
        verified_at_utc=annotation_verification.verified_at_utc,
    )

    return BallLocalizationReport(
        truth_policy=truth_policy,
        evaluation_manifest_sha256=evaluation_manifest_sha256,
        annotation_verification_policy=annotation_verification_policy,
        annotation_verification_policy_sha256=(
            annotation_verification.verification_policy_sha256
        ),
        annotation_trust_store_sha256=(
            annotation_verification.trust_store_sha256
        ),
        annotation_attestation_set_sha256=(
            annotation_verification.attestation_set_sha256
        ),
        annotation_evidence_set_sha256=(
            annotation_verification.evidence_set_sha256
        ),
        annotation_evidence_generation_id=(
            annotation_verification.evidence_generation_id
        ),
        annotation_evidence_refs=(
            annotation_verification.verified_evidence_refs
        ),
        protected_configuration_generation=(
            annotation_verification.protected_configuration_generation
        ),
        protected_configuration_generation_sha256=(
            annotation_verification.protected_configuration_generation_sha256
        ),
        governance_domain_id=annotation_verification.governance_domain_id,
        evaluator_artifact_sha256=(
            annotation_verification.evaluator_artifact_sha256
        ),
        verified_at_utc=annotation_verification.verified_at_utc,
        normalized_tolerance_ball_diameters=normalized_tolerance,
        operating_confidence_threshold=normalized_operating_threshold,
        truth_set_sha256=truth_set_sha256,
        prediction_set_sha256=prediction_set_sha256,
        evaluation_input_sha256=evaluation_input_sha256,
        truth_frame_count=len(truth),
        prediction_count=len(predictions),
        evaluated_frame_count=len(evaluated_truth),
        evaluated_localizable_frame_count=len(localizable_truth),
        evaluated_negative_frame_count=negative_frame_count,
        evaluated_prediction_count=len(evaluated_predictions),
        operating_prediction_count=operating_prediction_count,
        full_ranking_true_positive_count=full_ranking_true_positives,
        excluded_duplicate_frame_count=len(duplicate_frame_keys),
        excluded_duplicate_prediction_count=len(predictions) - len(evaluated_predictions),
        activated_negative_frame_identities=activated_negative_frame_identities,
        negative_frame_activation_count=negative_frame_activation_count,
        negative_frame_activation_rate=negative_frame_activation_rate,
        state_counts=state_counts,
        confidence_ranking_points=tuple(confidence_ranking_points),
        matched_center_errors_px=tuple(sorted_errors),
        matched_apparent_minor_axis_diameters_px=tuple(matched_diameters),
        matched_center_errors_normalized=tuple(normalized_errors),
        true_positives=true_positives,
        false_positives=false_positives,
        false_negatives=false_negatives,
        precision=precision,
        recall=recall,
        f1=f1,
        average_precision_101=average_precision,
        matched_center_error_mean_px=mean_error,
        matched_center_error_p50_px=p50_error,
        matched_center_error_p95_px=p95_error,
        matched_center_error_max_px=max_error,
        matched_center_error_normalized_mean=normalized_mean_error,
        matched_center_error_normalized_p50=normalized_p50_error,
        matched_center_error_normalized_p95=normalized_p95_error,
        matched_center_error_normalized_max=normalized_max_error,
    )


def _validate_truth_review(
    annotation: BallFrameAnnotation,
    policy: TruthPolicy,
) -> None:
    if annotation.review_state is ReviewState.DRAFT:
        raise ValueError(
            f"DRAFT annotation is not evaluable: {annotation.annotation_id}"
        )
    if (
        policy is TruthPolicy.ADJUDICATED_ONLY
        and annotation.review_state is not ReviewState.ADJUDICATED
    ):
        raise ValueError(
            "truth is below ADJUDICATED_ONLY policy: " + annotation.annotation_id
        )
    if annotation.review_state not in {ReviewState.REVIEWED, ReviewState.ADJUDICATED}:
        raise ValueError(f"truth is below selected policy: {annotation.annotation_id}")


def _validated_duplicate_frame_keys(
    truth_by_frame: dict[tuple[str, int, int], BallFrameAnnotation],
) -> set[tuple[str, int, int]]:
    excludable_frame_keys: set[tuple[str, int, int]] = set()
    for frame_key, annotation in truth_by_frame.items():
        frame = annotation.frame
        original_index = frame.duplicate_of_frame_index
        if frame.duplicate_kind is FrameDuplicateKind.NONE:
            continue
        assert original_index is not None

        original = truth_by_frame.get(
            (
                frame.source_sha256,
                frame.selected_video_stream_index,
                original_index,
            )
        )
        if original is None:
            raise ValueError(
                "duplicate truth references a missing original frame in the same "
                "source and selected video stream: "
                f"{frame.source_sha256}:stream-{frame.selected_video_stream_index}:"
                f"{frame.frame_index} -> {original_index}"
            )
        if original.frame.duplicate_kind is not FrameDuplicateKind.NONE:
            raise ValueError(
                "duplicate truth cannot reference another duplicate frame: "
                f"{frame.source_sha256}:stream-{frame.selected_video_stream_index}:"
                f"{frame.frame_index} -> {original_index}"
            )

        mismatches: list[str] = []
        if frame.decoded_frame_sha256 != original.frame.decoded_frame_sha256:
            mismatches.append("decoded_frame_sha256")
        if frame.decoded_frame_hash_basis is not original.frame.decoded_frame_hash_basis:
            mismatches.append("decoded_frame_hash_basis")
        if frame.width != original.frame.width:
            mismatches.append("width")
        if frame.height != original.frame.height:
            mismatches.append("height")
        if frame.decode_contract != original.frame.decode_contract:
            mismatches.append("decode_contract")
        if mismatches:
            raise ValueError(
                "duplicate truth does not match the original decoded-frame identity "
                f"({', '.join(mismatches)}): "
                f"{frame.source_sha256}:stream-{frame.selected_video_stream_index}:"
                f"{frame.frame_index} -> {original_index}"
            )
        if frame.is_excludable_capture_duplicate:
            if annotation.review_state is not ReviewState.ADJUDICATED:
                raise ValueError(
                    "VERIFIED_CAPTURE_DUPLICATE truth must be ADJUDICATED so "
                    "trusted humans authorize its exclusion and supporting evidence"
                )
            semantic_fields = (
                "state",
                "center",
                "blur_start",
                "blur_end",
                "blur_ellipse",
                "apparent_minor_axis_diameter_px",
                "uncertainty_radius_px",
                "ambiguity_reason",
                "track_segment_id",
            )
            semantic_mismatches = [
                field_name
                for field_name in semantic_fields
                if getattr(annotation, field_name) != getattr(original, field_name)
            ]
            if semantic_mismatches:
                raise ValueError(
                    "VERIFIED_CAPTURE_DUPLICATE truth disagrees with its original "
                    f"({', '.join(semantic_mismatches)}): "
                    f"{frame.source_sha256}:stream-{frame.selected_video_stream_index}:"
                    f"{frame.frame_index} -> {original_index}"
                )
            excludable_frame_keys.add(frame_key)
    return excludable_frame_keys


def _frame_key_from_truth(annotation: BallFrameAnnotation) -> tuple[str, int, int]:
    return (
        annotation.frame.source_sha256,
        annotation.frame.selected_video_stream_index,
        annotation.frame.frame_index,
    )


def _frame_key_from_prediction(prediction: BallPrediction) -> tuple[str, int, int]:
    return (
        prediction.source_sha256,
        prediction.selected_video_stream_index,
        prediction.frame_index,
    )


def _safe_ratio(numerator: int | float, denominator: int | float) -> float:
    return float(numerator / denominator) if denominator else 0.0


def _normalized_center_error(error_px: float, apparent_diameter_px: float) -> float:
    normalized = error_px / apparent_diameter_px
    if not math.isfinite(normalized):
        raise ValueError(
            "center error normalized by apparent ball diameter must be finite"
        )
    return 0.0 if normalized == 0.0 else normalized


def _average_precision_101(
    operating_points: list[tuple[float, float]],
) -> float:
    interpolated: list[float] = []
    for index in range(101):
        threshold = index / 100.0
        eligible = (
            precision
            for recall, precision in operating_points
            if recall >= threshold
        )
        interpolated.append(max(eligible, default=0.0))
    return math.fsum(interpolated) / 101.0


def _linear_percentile(sorted_values: list[float], quantile: float) -> float | None:
    if not sorted_values:
        return None
    position = (len(sorted_values) - 1) * quantile
    lower_index = math.floor(position)
    upper_index = math.ceil(position)
    if lower_index == upper_index:
        return sorted_values[lower_index]
    fraction = position - lower_index
    return (
        sorted_values[lower_index] * (1.0 - fraction)
        + sorted_values[upper_index] * fraction
    )


def _truth_set_sha256(truth: tuple[BallFrameAnnotation, ...]) -> str:
    ordered_truth = sorted(
        truth,
        key=lambda annotation: (
            annotation.frame.source_sha256,
            annotation.frame.selected_video_stream_index,
            annotation.frame.frame_index,
            annotation.annotation_id,
        ),
    )
    payload = {
        "domain": _TRUTH_SET_DOMAIN,
        "schema_version": _SCHEMA_VERSION,
        "truth": [annotation.to_canonical_dict() for annotation in ordered_truth],
    }
    return hashlib.sha256(_canonical_json(payload).encode("utf-8")).hexdigest()


def _prediction_set_sha256(predictions: tuple[BallPrediction, ...]) -> str:
    ordered_predictions = sorted(
        predictions,
        key=lambda prediction: prediction.candidate_id,
    )
    payload = {
        "domain": _PREDICTION_SET_DOMAIN,
        "predictions": [
            prediction.to_canonical_dict() for prediction in ordered_predictions
        ],
        "schema_version": _SCHEMA_VERSION,
    }
    return hashlib.sha256(_canonical_json(payload).encode("utf-8")).hexdigest()


def _evaluation_input_sha256_from_commitments(
    *,
    truth_set_sha256: str,
    prediction_set_sha256: str,
    truth_frame_count: int,
    prediction_count: int,
    normalized_tolerance_ball_diameters: float,
    operating_confidence_threshold: float,
    truth_policy: TruthPolicy,
    evaluation_manifest_sha256: str,
    annotation_verification_policy: AnnotationVerificationPolicy,
    annotation_verification_policy_sha256: str,
    annotation_trust_store_sha256: str,
    annotation_attestation_set_sha256: str,
    annotation_evidence_set_sha256: str,
    annotation_evidence_generation_id: str,
    annotation_evidence_refs: tuple[str, ...],
    protected_configuration_generation: ProtectedAnnotationConfigurationGeneration,
    protected_configuration_generation_sha256: str,
    governance_domain_id: str,
    evaluator_artifact_sha256: str,
    verified_at_utc: str,
) -> str:
    payload = {
        "annotation_trust": {
            "attestation_set_sha256": annotation_attestation_set_sha256,
            "evidence_refs": list(annotation_evidence_refs),
            "evidence_generation_id": annotation_evidence_generation_id,
            "evidence_set_sha256": annotation_evidence_set_sha256,
            "evaluation_manifest_sha256": evaluation_manifest_sha256,
            "evaluator_artifact_sha256": evaluator_artifact_sha256,
            "governance_domain_id": governance_domain_id,
            "protected_configuration_generation": (
                protected_configuration_generation.to_canonical_dict()
            ),
            "protected_configuration_generation_sha256": (
                protected_configuration_generation_sha256
            ),
            "trust_store_sha256": annotation_trust_store_sha256,
            "verification_policy": annotation_verification_policy.to_canonical_dict(),
            "verification_policy_sha256": annotation_verification_policy_sha256,
            "verified_at_utc": verified_at_utc,
        },
        "domain": _EVALUATION_INPUT_DOMAIN,
        "metric": _METRIC_NAME,
        "operating_confidence_threshold": operating_confidence_threshold,
        "normalized_tolerance_ball_diameters": normalized_tolerance_ball_diameters,
        "prediction_count": prediction_count,
        "prediction_set_sha256": prediction_set_sha256,
        "schema_version": _SCHEMA_VERSION,
        "truth_frame_count": truth_frame_count,
        "truth_policy": truth_policy.value,
        "truth_set_sha256": truth_set_sha256,
    }
    return hashlib.sha256(_canonical_json(payload).encode("utf-8")).hexdigest()


def _canonical_json(value: dict[str, Any]) -> str:
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    )
