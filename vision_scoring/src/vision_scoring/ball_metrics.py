"""Deterministic ball-center localization benchmark contracts.

The evaluator's primary target is the single logical ``match-ball`` subject in
each frame. Multiple typed ball instances may coexist on a decoded frame, but
non-match roles never contribute a true positive; operating activations near
their geometry are disclosed by role as hard-negative diagnostics.

The evaluator processes every eligible non-excluded candidate globally at
descending confidence thresholds. All candidates with exactly equal confidence
are processed atomically. At one threshold, each previously unmatched
``VISIBLE`` or ``PARTIALLY_OCCLUDED`` resolved match-ball frame contributes one
true positive when at least one tied candidate is within the required tolerance
measured in apparent minor-axis ball diameters; the reported center error is the
minimum valid error for that frame at that threshold. Every remaining candidate
on localizable or attested ``NOT_PRESENT`` truth is a false positive. Candidate
IDs and input order therefore cannot change matching or metrics within a
confidence tie. Each unmatched localizable frame is a false negative.

``FULLY_OCCLUDED``, ``OUT_OF_FRAME``, ``INDISTINGUISHABLE``, and
``CAPTURE_UNKNOWN`` are disclosed match-ball nonlocalizable strata. A logical
match-ball with ``role=UNKNOWN`` is a separate unresolved-role diagnostic and
can never become a primary TP. Predictions in either category are never
collapsed into ordinary negatives or localization confusion counts.
``NOT_PRESENT`` alone is a confident negative, because its
annotation contract requires an attested observable search region. Motion blur
is an appearance slice, not a visibility state.

The typed evaluation manifest recomputes ontology, TEST split, evaluated source,
and exact annotation coverage commitments. It is deliberately labeled an
``UNVERIFIED_UNIT_BENCHMARK`` and cannot authorize training or production
readiness. Aggregate metrics claim only match-ball performance; appearance and
play-state performance partitions resolved match-ball metrics, while role
slices distinguish primary localization, non-match hard-negative activation,
and unresolved-role diagnostics. These slices do not claim production readiness.

``average_precision_101`` is the mean interpolated precision at the 101 recall
thresholds 0.00, 0.01, ..., 1.00. Ranking points exist only after a complete
confidence group. At each recall threshold, interpolated precision is the
maximum observed precision at any operating point whose recall is at least that
threshold; it is zero when no such point exists.

Every evaluation also requires one explicit operating confidence threshold.
TP, FP, FN, precision, recall, F1, confident-negative activation, and localization
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

All-``NOT_PRESENT`` hard-negative suites are valid. They report unique
confident-negative frames activated at the operating threshold and the
corresponding activation rate.
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
uses one launcher-supplied, protected Unix-epoch-nanosecond snapshot. The exact
manifest, protected configuration, policy, trust-store, attestation-set,
evidence-set, immutable evidence-generation, evaluator-artifact,
governance-domain, and verification-time proofs are bound into both the
evaluation-input hash and the report. The report hash is integrity evidence,
not authority by itself.
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
from datetime import date, timedelta
from enum import Enum
from pathlib import Path
from typing import Any

import cryptography
from cryptography.hazmat.backends import default_backend

from . import contracts as _contracts  # Load the pinned evaluator dependency.
from . import dataset_split as _dataset_split
from . import domain_events as _domain_events
from .annotation_trust import (
    AnnotationAttestation,
    AnnotationTrustStore,
    AnnotationVerificationPolicy,
    ProtectedAnnotationConfigurationGeneration,
    annotation_evidence_set_fingerprint,
)
from .annotations import (
    SCHEMA_VERSION as ANNOTATION_SCHEMA_VERSION,
    BallAppearance,
    BallFrameAnnotationV2,
    BallPlayState,
    BallRole,
    BallVisibility,
    DecodedFrameIdentity,
    FrameDuplicateKind,
    FrameReference,
    PixelPoint,
    ReviewState,
)
from .immutable_store import generation_id_for
from .dataset_split import DatasetSplit, SplitManifest


_SCHEMA_VERSION = "8.0"
_METRIC_NAME = "MATCH_BALL_CENTER_LOCALIZATION_V2"
_EVALUATOR_ARTIFACT_DOMAIN = (
    "multicourt-vision-scoring:ball-localization-evaluator-artifact:v10"
)
_EVALUATOR_MODULE_NAMES = (
    "vision_scoring.contracts",
    "vision_scoring.dataset_split",
    "vision_scoring.domain_events",
    "vision_scoring.annotations",
    "vision_scoring.immutable_store",
    "vision_scoring.annotation_trust",
    "vision_scoring.ball_metrics",
)
_TRUTH_SET_DOMAIN = "multicourt-vision-scoring:ball-observation-truth-set:v3"
_PREDICTION_SET_DOMAIN = "multicourt-vision-scoring:ball-prediction-set:v2"
_EVALUATION_INPUT_DOMAIN = "multicourt-vision-scoring:ball-evaluation-input:v10"
_EVALUATED_NEGATIVE_IDENTITY_SET_DOMAIN = (
    "multicourt-vision-scoring:evaluated-confident-negative-frames:v1"
)
_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
_ASCII_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,127}$")
_MAX_SIGNED_64 = (1 << 63) - 1
_NANOSECONDS_PER_DAY = 86_400_000_000_000
_UNIX_EPOCH_DATE = date(1970, 1, 1)
_LOCALIZABLE_VISIBILITIES = frozenset(
    {BallVisibility.VISIBLE, BallVisibility.PARTIALLY_OCCLUDED}
)
_CONFIDENT_NEGATIVE_VISIBILITIES = frozenset({BallVisibility.NOT_PRESENT})
_NONLOCALIZABLE_VISIBILITIES = frozenset(
    {
        BallVisibility.FULLY_OCCLUDED,
        BallVisibility.OUT_OF_FRAME,
        BallVisibility.INDISTINGUISHABLE,
        BallVisibility.CAPTURE_UNKNOWN,
    }
)
_MAX_TRUTH_ANNOTATION_COUNT = 100_000
_MAX_PREDICTION_COUNT = 500_000
_MAX_PREDICTIONS_PER_FRAME = 256
_MATCH_BALL_INSTANCE_ID = "match-ball"


def _date_from_protected_unix_epoch_ns(value: object) -> date:
    if type(value) is not int or not 0 <= value <= _MAX_SIGNED_64:
        raise ValueError(
            "protected_verified_at_ns must be an exact nonnegative signed-64 "
            "Unix epoch nanosecond"
        )
    return _UNIX_EPOCH_DATE + timedelta(days=value // _NANOSECONDS_PER_DAY)


class TruthPolicy(str, Enum):
    """Minimum review state admitted to a benchmark."""

    ADJUDICATED_ONLY = "ADJUDICATED_ONLY"
    REVIEWED_OR_ADJUDICATED = "REVIEWED_OR_ADJUDICATED"


class BenchmarkTrustScope(str, Enum):
    """V2 has no authority bridge from readiness into this unit evaluator."""

    UNVERIFIED_UNIT_BENCHMARK = "UNVERIFIED_UNIT_BENCHMARK"


class PerformanceSliceDimension(str, Enum):
    APPEARANCE = "APPEARANCE"
    ROLE = "ROLE"
    PLAY_STATE = "PLAY_STATE"


class PerformanceSliceSemantics(str, Enum):
    PRIMARY_MATCH_BALL_LOCALIZATION = "PRIMARY_MATCH_BALL_LOCALIZATION"
    NON_MATCH_HARD_NEGATIVE = "NON_MATCH_HARD_NEGATIVE"
    UNRESOLVED_ROLE_DIAGNOSTIC = "UNRESOLVED_ROLE_DIAGNOSTIC"


@dataclass(frozen=True, slots=True)
class UnitEvaluationSplitProof:
    """Typed, recomputable TEST assignment proof without an authority claim."""

    split_manifest: SplitManifest
    evaluated_source_sha256s: tuple[str, ...]
    evaluated_split: DatasetSplit = DatasetSplit.TEST

    def __post_init__(self) -> None:
        if type(self.split_manifest) is not SplitManifest:
            raise ValueError("split_manifest must be a SplitManifest")
        if self.split_manifest.require_unseen_test_venue is not True:
            raise ValueError(
                "unit evaluation requires the unseen TEST venue split policy"
            )
        if (
            type(self.evaluated_source_sha256s) is not tuple
            or not self.evaluated_source_sha256s
            or any(
                type(source) is not str or not _SHA256_RE.fullmatch(source)
                for source in self.evaluated_source_sha256s
            )
            or tuple(sorted(set(self.evaluated_source_sha256s)))
            != self.evaluated_source_sha256s
        ):
            raise ValueError(
                "evaluated_source_sha256s must be a sorted unique non-empty tuple "
                "of lowercase SHA-256 values"
            )
        if self.evaluated_split is not DatasetSplit.TEST:
            raise ValueError("unit evaluation split must be TEST")
        assignments = {
            record.asset_sha256: record.split for record in self.split_manifest.records
        }
        if any(
            assignments.get(source) is not DatasetSplit.TEST
            for source in self.evaluated_source_sha256s
        ):
            raise ValueError(
                "every evaluated source must have an exact TEST assignment in the "
                "typed split manifest"
            )

    def to_canonical_dict(self) -> dict[str, Any]:
        return {
            "evaluated_source_sha256s": list(self.evaluated_source_sha256s),
            "evaluated_split": self.evaluated_split.value,
            "split_manifest": self.split_manifest.to_dict(),
            "split_manifest_sha256": self.split_manifest.fingerprint(),
        }

    def fingerprint(self) -> str:
        return hashlib.sha256(
            _canonical_json(self.to_canonical_dict()).encode("utf-8")
        ).hexdigest()


@dataclass(frozen=True, slots=True)
class UnitEvaluationCoverageProof:
    """Typed exact commitments checked against the supplied annotation objects."""

    ontology_sha256: str
    annotation_sha256s: tuple[str, ...]
    match_ball_frame_count: int
    non_match_ball_annotation_count: int

    def __post_init__(self) -> None:
        if type(self.ontology_sha256) is not str or not _SHA256_RE.fullmatch(
            self.ontology_sha256
        ):
            raise ValueError("ontology_sha256 must be a lowercase SHA-256")
        if (
            type(self.annotation_sha256s) is not tuple
            or not self.annotation_sha256s
            or any(
                type(value) is not str or not _SHA256_RE.fullmatch(value)
                for value in self.annotation_sha256s
            )
            or tuple(sorted(set(self.annotation_sha256s)))
            != self.annotation_sha256s
        ):
            raise ValueError(
                "annotation_sha256s must be a sorted unique non-empty tuple of "
                "lowercase SHA-256 values"
            )
        if (
            type(self.match_ball_frame_count) is not int
            or self.match_ball_frame_count <= 0
            or type(self.non_match_ball_annotation_count) is not int
            or self.non_match_ball_annotation_count < 0
            or self.match_ball_frame_count + self.non_match_ball_annotation_count
            != len(self.annotation_sha256s)
        ):
            raise ValueError("coverage counts do not match annotation_sha256s")

    def to_canonical_dict(self) -> dict[str, Any]:
        return {
            "annotation_sha256s": list(self.annotation_sha256s),
            "match_ball_frame_count": self.match_ball_frame_count,
            "non_match_ball_annotation_count": self.non_match_ball_annotation_count,
            "ontology_sha256": self.ontology_sha256,
        }

    def fingerprint(self) -> str:
        return hashlib.sha256(
            _canonical_json(self.to_canonical_dict()).encode("utf-8")
        ).hexdigest()


@dataclass(frozen=True, slots=True)
class UnitBallEvaluationManifest:
    """Typed unit-benchmark input; explicitly not a readiness authority token."""

    manifest_id: str
    ontology_sha256: str
    split_proof: UnitEvaluationSplitProof
    coverage_proof: UnitEvaluationCoverageProof
    trust_scope: BenchmarkTrustScope = BenchmarkTrustScope.UNVERIFIED_UNIT_BENCHMARK

    def __post_init__(self) -> None:
        if type(self.manifest_id) is not str or not _ASCII_ID_RE.fullmatch(
            self.manifest_id
        ):
            raise ValueError("manifest_id must be an ASCII-stable identifier")
        if type(self.ontology_sha256) is not str or not _SHA256_RE.fullmatch(
            self.ontology_sha256
        ):
            raise ValueError("ontology_sha256 must be a lowercase SHA-256")
        if type(self.split_proof) is not UnitEvaluationSplitProof:
            raise ValueError("split_proof must be a UnitEvaluationSplitProof")
        if type(self.coverage_proof) is not UnitEvaluationCoverageProof:
            raise ValueError("coverage_proof must be a UnitEvaluationCoverageProof")
        if self.coverage_proof.ontology_sha256 != self.ontology_sha256:
            raise ValueError("coverage proof ontology does not match manifest ontology")
        if self.trust_scope is not BenchmarkTrustScope.UNVERIFIED_UNIT_BENCHMARK:
            raise ValueError("only UNVERIFIED_UNIT_BENCHMARK is implemented")

    @property
    def readiness_claim_permitted(self) -> bool:
        return False

    def to_canonical_dict(self) -> dict[str, Any]:
        return {
            "coverage_proof": self.coverage_proof.to_canonical_dict(),
            "manifest_id": self.manifest_id,
            "ontology_sha256": self.ontology_sha256,
            "readiness_claim_permitted": False,
            "split_proof": self.split_proof.to_canonical_dict(),
            "trust_scope": self.trust_scope.value,
        }

    def fingerprint(self) -> str:
        return hashlib.sha256(
            _canonical_json(self.to_canonical_dict()).encode("utf-8")
        ).hexdigest()


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
class BallLocalizationPerformanceSlice:
    """One operating-threshold performance slice with explicit semantics.

    ``operating_prediction_count`` includes every retained above-threshold
    candidate on a frame represented by the slice. ``evaluated_prediction_count``
    is the subset eligible for TP/FP accounting; the rest are disclosed through
    ``ignored_prediction_count``. Error evidence exists only for true positives.
    """

    dimension: PerformanceSliceDimension
    slice_value: str
    semantics: PerformanceSliceSemantics
    truth_annotation_count: int
    evaluable_positive_count: int
    evaluable_negative_count: int
    activated_negative_target_count: int
    ignored_truth_annotation_count: int
    operating_prediction_count: int
    evaluated_prediction_count: int
    ignored_prediction_count: int
    true_positives: int
    false_positives: int
    false_negatives: int
    precision: float
    recall: float
    f1: float
    localization_metrics_defined: bool
    matched_center_errors_px: tuple[float, ...]
    matched_apparent_minor_axis_diameters_px: tuple[float, ...]
    matched_center_errors_normalized: tuple[float, ...]
    matched_center_error_mean_px: float | None
    matched_center_error_p50_px: float | None
    matched_center_error_p95_px: float | None
    matched_center_error_max_px: float | None
    matched_center_error_normalized_mean: float | None
    matched_center_error_normalized_p50: float | None
    matched_center_error_normalized_p95: float | None
    matched_center_error_normalized_max: float | None

    def __post_init__(self) -> None:
        if type(self.dimension) is not PerformanceSliceDimension:
            raise ValueError("slice dimension must be a PerformanceSliceDimension")
        if type(self.slice_value) is not str:
            raise ValueError("slice_value must be an exact built-in string")
        enum_type: type[Enum]
        if self.dimension is PerformanceSliceDimension.APPEARANCE:
            enum_type = BallAppearance
        elif self.dimension is PerformanceSliceDimension.ROLE:
            enum_type = BallRole
        else:
            enum_type = BallPlayState
        try:
            enum_type(self.slice_value)
        except ValueError as error:
            raise ValueError(
                "slice_value is not declared by the selected dimension"
            ) from error
        if type(self.semantics) is not PerformanceSliceSemantics:
            raise ValueError("slice semantics must be a PerformanceSliceSemantics")

        count_fields = (
            "truth_annotation_count",
            "evaluable_positive_count",
            "evaluable_negative_count",
            "activated_negative_target_count",
            "ignored_truth_annotation_count",
            "operating_prediction_count",
            "evaluated_prediction_count",
            "ignored_prediction_count",
            "true_positives",
            "false_positives",
            "false_negatives",
        )
        if any(
            type(getattr(self, name)) is not int or getattr(self, name) < 0
            for name in count_fields
        ):
            raise ValueError("slice counts must be non-negative exact integers")
        if self.truth_annotation_count != (
            self.evaluable_positive_count
            + self.evaluable_negative_count
            + self.ignored_truth_annotation_count
        ):
            raise ValueError("slice truth counts are inconsistent")
        if self.activated_negative_target_count > self.evaluable_negative_count:
            raise ValueError(
                "slice activated-negative count exceeds evaluable negative truth"
            )
        if (
            self.activated_negative_target_count > 0
            and self.evaluated_prediction_count == 0
        ):
            raise ValueError(
                "slice activated-negative evidence requires an evaluated prediction"
            )
        if self.operating_prediction_count != (
            self.evaluated_prediction_count + self.ignored_prediction_count
        ):
            raise ValueError("slice prediction counts are inconsistent")
        if self.evaluable_positive_count != (
            self.true_positives + self.false_negatives
        ):
            raise ValueError("slice positive truth counts are inconsistent")
        if self.evaluated_prediction_count != (
            self.true_positives + self.false_positives
        ):
            raise ValueError("slice confusion counts are inconsistent")
        if self.localization_metrics_defined is not (
            self.evaluable_positive_count > 0
        ):
            raise ValueError(
                "slice localization_metrics_defined must reflect positive truth"
            )
        if self.semantics is PerformanceSliceSemantics.NON_MATCH_HARD_NEGATIVE:
            if (
                self.evaluable_positive_count != 0
                or self.true_positives != 0
                or self.false_negatives != 0
            ):
                raise ValueError(
                    "non-match hard-negative slices cannot claim positive truth"
                )
        if self.semantics is PerformanceSliceSemantics.UNRESOLVED_ROLE_DIAGNOSTIC:
            if (
                self.evaluable_positive_count != 0
                or self.evaluable_negative_count != 0
                or self.activated_negative_target_count != 0
                or self.evaluated_prediction_count != 0
            ):
                raise ValueError(
                    "unresolved-role slices must keep truth and predictions diagnostic"
                )

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
        for name, expected in (
            ("precision", expected_precision),
            ("recall", expected_recall),
            ("f1", expected_f1),
        ):
            actual = getattr(self, name)
            if type(actual) is not float or actual != expected:
                raise ValueError(f"slice {name} does not match confusion evidence")

        if (
            type(self.matched_center_errors_px) is not tuple
            or type(self.matched_apparent_minor_axis_diameters_px) is not tuple
            or type(self.matched_center_errors_normalized) is not tuple
            or any(
                type(value) is not float or not math.isfinite(value) or value < 0.0
                for value in self.matched_center_errors_px
            )
            or any(
                type(value) is not float or not math.isfinite(value) or value <= 0.0
                for value in self.matched_apparent_minor_axis_diameters_px
            )
            or any(
                type(value) is not float or not math.isfinite(value) or value < 0.0
                for value in self.matched_center_errors_normalized
            )
            or tuple(sorted(self.matched_center_errors_px))
            != self.matched_center_errors_px
            or tuple(sorted(self.matched_center_errors_normalized))
            != self.matched_center_errors_normalized
            or len(self.matched_center_errors_px) != self.true_positives
            or len(self.matched_apparent_minor_axis_diameters_px)
            != self.true_positives
            or len(self.matched_center_errors_normalized) != self.true_positives
        ):
            raise ValueError("slice matched-error evidence is malformed")
        expected_normalized = tuple(
            sorted(
                _normalized_center_error(error, diameter)
                for error, diameter in zip(
                    self.matched_center_errors_px,
                    self.matched_apparent_minor_axis_diameters_px,
                    strict=True,
                )
            )
        )
        if self.matched_center_errors_normalized != expected_normalized:
            raise ValueError("slice normalized errors do not match pixel evidence")

        expected_summaries = (
            (
                "matched_center_error_mean_px",
                _mean_or_none(self.matched_center_errors_px),
            ),
            (
                "matched_center_error_p50_px",
                _linear_percentile(list(self.matched_center_errors_px), 0.50),
            ),
            (
                "matched_center_error_p95_px",
                _linear_percentile(list(self.matched_center_errors_px), 0.95),
            ),
            (
                "matched_center_error_max_px",
                self.matched_center_errors_px[-1]
                if self.matched_center_errors_px
                else None,
            ),
            (
                "matched_center_error_normalized_mean",
                _mean_or_none(self.matched_center_errors_normalized),
            ),
            (
                "matched_center_error_normalized_p50",
                _linear_percentile(
                    list(self.matched_center_errors_normalized),
                    0.50,
                ),
            ),
            (
                "matched_center_error_normalized_p95",
                _linear_percentile(
                    list(self.matched_center_errors_normalized),
                    0.95,
                ),
            ),
            (
                "matched_center_error_normalized_max",
                self.matched_center_errors_normalized[-1]
                if self.matched_center_errors_normalized
                else None,
            ),
        )
        for name, expected in expected_summaries:
            actual = getattr(self, name)
            if expected is None:
                valid = actual is None
            else:
                valid = type(actual) is float and actual == expected
            if not valid:
                raise ValueError(f"slice {name} does not match error evidence")

    def to_canonical_dict(self) -> dict[str, Any]:
        return {
            "confusion": {
                "false_negatives": self.false_negatives,
                "false_positives": self.false_positives,
                "true_positives": self.true_positives,
            },
            "dimension": self.dimension.value,
            "error_evidence": {
                "matched_apparent_minor_axis_diameters_px": list(
                    self.matched_apparent_minor_axis_diameters_px
                ),
                "matched_center_errors_normalized": list(
                    self.matched_center_errors_normalized
                ),
                "matched_center_errors_px": list(self.matched_center_errors_px),
                "normalized_max": self.matched_center_error_normalized_max,
                "normalized_mean": self.matched_center_error_normalized_mean,
                "normalized_p50": self.matched_center_error_normalized_p50,
                "normalized_p95": self.matched_center_error_normalized_p95,
                "pixel_max": self.matched_center_error_max_px,
                "pixel_mean": self.matched_center_error_mean_px,
                "pixel_p50": self.matched_center_error_p50_px,
                "pixel_p95": self.matched_center_error_p95_px,
            },
            "localization_metrics_defined": self.localization_metrics_defined,
            "metrics": {
                "f1": self.f1,
                "precision": self.precision,
                "recall": self.recall,
            },
            "prediction_counts": {
                "evaluated": self.evaluated_prediction_count,
                "ignored": self.ignored_prediction_count,
                "operating": self.operating_prediction_count,
            },
            "semantics": self.semantics.value,
            "slice_value": self.slice_value,
            "truth_counts": {
                "evaluable_negative": self.evaluable_negative_count,
                "activated_negative": self.activated_negative_target_count,
                "evaluable_positive": self.evaluable_positive_count,
                "ignored": self.ignored_truth_annotation_count,
                "total": self.truth_annotation_count,
            },
        }


def _exact_enum_count_pairs(
    values: object,
    enum_type: type[Enum],
    field_name: str,
    *,
    expected_members: tuple[Enum, ...] | None = None,
) -> tuple[tuple[Enum, int], ...]:
    if type(values) is not tuple:
        raise ValueError(f"{field_name} must be an exact built-in tuple")
    selected_members = expected_members or tuple(enum_type)
    if len(values) != len(selected_members):
        raise ValueError(f"{field_name} must contain every {enum_type.__name__}")
    for index, pair in enumerate(values):
        if type(pair) is not tuple or len(pair) != 2:
            raise ValueError(
                f"{field_name} entries must be exact two-item built-in tuples"
            )
        member, count = pair
        if type(member) is not enum_type or member is not selected_members[index]:
            raise ValueError(
                f"{field_name} must use {enum_type.__name__} declaration order"
            )
        if type(count) is not int or count < 0:
            raise ValueError(f"{field_name} counts must be non-negative integers")
    return values


def _frame_identity_key(identity: DecodedFrameIdentity) -> tuple[str, int, int]:
    return (
        identity.source_sha256,
        identity.selected_video_stream_index,
        identity.frame_index,
    )


def _validated_frame_identity_tuple(
    value: object,
    field_name: str,
) -> tuple[DecodedFrameIdentity, ...]:
    if type(value) is not tuple or any(
        type(identity) is not DecodedFrameIdentity for identity in value
    ):
        raise ValueError(
            f"{field_name} must be an exact tuple of DecodedFrameIdentity values"
        )
    keys = tuple(_frame_identity_key(identity) for identity in value)
    if tuple(sorted(keys)) != keys or len(set(keys)) != len(keys):
        raise ValueError(f"{field_name} must be sorted and unique")
    return value


def _frame_identity_set_sha256(
    identities: tuple[DecodedFrameIdentity, ...],
    *,
    domain: str,
) -> str:
    payload = {
        "domain": domain,
        "frame_identities": [
            identity.to_canonical_dict() for identity in identities
        ],
        "schema_version": _SCHEMA_VERSION,
    }
    return hashlib.sha256(_canonical_json(payload).encode("utf-8")).hexdigest()


def _validated_performance_slices(
    value: object,
    *,
    dimension: PerformanceSliceDimension,
    enum_type: type[Enum],
    field_name: str,
) -> tuple[BallLocalizationPerformanceSlice, ...]:
    if type(value) is not tuple or any(
        type(item) is not BallLocalizationPerformanceSlice for item in value
    ):
        raise ValueError(
            f"{field_name} must be an exact tuple of performance slices"
        )
    expected_values = tuple(member.value for member in enum_type)
    if (
        tuple(item.slice_value for item in value) != expected_values
        or any(item.dimension is not dimension for item in value)
    ):
        raise ValueError(
            f"{field_name} must contain every declared value in enum order"
        )
    return value


@dataclass(frozen=True, slots=True)
class BallLocalizationReport:
    """Immutable aggregate returned by :func:`evaluate_ball_localization`.

    ``truth_set_sha256`` and ``prediction_set_sha256`` are explicit commitments.
    The exact immutable truth and prediction preimages are retained in-memory so
    the constructor can recompute those commitments, every typed performance
    slice, and every diagnostic identity set. They are deliberately omitted from
    the compact canonical report representation; an independently persisted
    report therefore has to retain the committed input artifacts alongside it.
    The constructor also recomputes ``evaluation_input_sha256`` from those
    commitments and every recorded trust proof, including the exact immutable
    annotation evidence generation.
    Confusion counts and both error populations describe the explicit operating
    threshold; confidence sweep points and AP101 describe the full ranking.
    Apparent diameters align positionally with the sorted pixel-error tuple;
    normalized errors are the independently sorted elementwise ratios.
    """

    truth_policy: TruthPolicy
    evaluation_manifest: UnitBallEvaluationManifest
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
    protected_verified_at_ns: int
    normalized_tolerance_ball_diameters: float
    operating_confidence_threshold: float
    truth_set_sha256: str
    prediction_set_sha256: str
    evaluation_input_sha256: str
    truth_preimage: tuple[BallFrameAnnotationV2, ...]
    prediction_preimage: tuple[BallPrediction, ...]
    truth_annotation_count: int
    truth_frame_count: int
    prediction_count: int
    evaluated_frame_count: int
    evaluated_localizable_frame_count: int
    evaluated_confident_negative_frame_count: int
    evaluated_nonlocalizable_frame_count: int
    evaluated_prediction_count: int
    ignored_nonlocalizable_prediction_count: int
    operating_ignored_nonlocalizable_prediction_count: int
    unresolved_role_frame_count: int
    unresolved_role_prediction_count: int
    operating_unresolved_role_prediction_count: int
    operating_prediction_count: int
    full_ranking_true_positive_count: int
    excluded_duplicate_frame_count: int
    excluded_duplicate_prediction_count: int
    non_match_ball_annotation_count: int
    evaluated_confident_negative_frame_identities: tuple[
        DecodedFrameIdentity, ...
    ]
    evaluated_confident_negative_frame_identity_set_sha256: str
    activated_confident_negative_frame_identities: tuple[DecodedFrameIdentity, ...]
    confident_negative_frame_activation_count: int
    confident_negative_frame_activation_rate: float
    unresolved_role_frame_identities: tuple[DecodedFrameIdentity, ...]
    activated_unresolved_role_frame_identities: tuple[DecodedFrameIdentity, ...]
    unresolved_role_visibility_counts: tuple[tuple[BallVisibility, int], ...]
    unresolved_role_frame_activation_count: int
    unresolved_role_frame_activation_rate: float
    visibility_counts: tuple[tuple[BallVisibility, int], ...]
    appearance_counts: tuple[tuple[BallAppearance, int], ...]
    role_counts: tuple[tuple[BallRole, int], ...]
    play_state_counts: tuple[tuple[BallPlayState, int], ...]
    non_match_role_counts: tuple[tuple[BallRole, int], ...]
    non_match_role_activation_counts: tuple[tuple[BallRole, int], ...]
    nonlocalizable_visibility_activation_counts: tuple[
        tuple[BallVisibility, int], ...
    ]
    appearance_performance_slices: tuple[
        BallLocalizationPerformanceSlice, ...
    ]
    role_performance_slices: tuple[BallLocalizationPerformanceSlice, ...]
    play_state_performance_slices: tuple[
        BallLocalizationPerformanceSlice, ...
    ]
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
        if type(self.evaluation_manifest) is not UnitBallEvaluationManifest:
            raise ValueError(
                "evaluation_manifest must be a UnitBallEvaluationManifest"
            )
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
                self.evaluated_confident_negative_frame_identity_set_sha256,
                "evaluated_confident_negative_frame_identity_set_sha256",
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
        if self.evaluation_manifest.fingerprint() != self.evaluation_manifest_sha256:
            raise ValueError(
                "evaluation_manifest_sha256 must match the typed evaluation manifest"
            )
        if self.evaluation_manifest.readiness_claim_permitted:
            raise ValueError("unit benchmark manifest cannot claim readiness authority")
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
        protected_verified_on = _date_from_protected_unix_epoch_ns(
            self.protected_verified_at_ns
        )
        if not self.annotation_verification_policy.is_active(
            protected_verified_on
        ):
            raise ValueError(
                "protected_verified_at_ns must fall within the verification "
                "policy validity window"
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
            "truth_annotation_count",
            "truth_frame_count",
            "prediction_count",
            "evaluated_frame_count",
            "evaluated_localizable_frame_count",
            "evaluated_confident_negative_frame_count",
            "evaluated_nonlocalizable_frame_count",
            "evaluated_prediction_count",
            "ignored_nonlocalizable_prediction_count",
            "operating_ignored_nonlocalizable_prediction_count",
            "unresolved_role_frame_count",
            "unresolved_role_prediction_count",
            "operating_unresolved_role_prediction_count",
            "operating_prediction_count",
            "full_ranking_true_positive_count",
            "excluded_duplicate_frame_count",
            "excluded_duplicate_prediction_count",
            "non_match_ball_annotation_count",
            "confident_negative_frame_activation_count",
            "unresolved_role_frame_activation_count",
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
        if self.truth_annotation_count != (
            self.truth_frame_count + self.non_match_ball_annotation_count
        ):
            raise ValueError("truth-annotation counts are inconsistent")
        coverage = self.evaluation_manifest.coverage_proof
        if (
            coverage.match_ball_frame_count != self.truth_frame_count
            or coverage.non_match_ball_annotation_count
            != self.non_match_ball_annotation_count
            or len(coverage.annotation_sha256s) != self.truth_annotation_count
        ):
            raise ValueError(
                "typed evaluation coverage proof does not match report counts"
            )
        if self.prediction_count != (
            self.evaluated_prediction_count
            + self.ignored_nonlocalizable_prediction_count
            + self.unresolved_role_prediction_count
            + self.excluded_duplicate_prediction_count
        ):
            raise ValueError("prediction counts are inconsistent")
        if self.evaluated_frame_count != (
            self.evaluated_localizable_frame_count
            + self.evaluated_confident_negative_frame_count
            + self.evaluated_nonlocalizable_frame_count
            + self.unresolved_role_frame_count
        ):
            raise ValueError("evaluated frame counts are inconsistent")
        if (
            self.operating_ignored_nonlocalizable_prediction_count
            > self.ignored_nonlocalizable_prediction_count
            or self.operating_unresolved_role_prediction_count
            > self.unresolved_role_prediction_count
        ):
            raise ValueError(
                "operating diagnostic predictions exceed their full populations"
            )
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
        if self.confident_negative_frame_activation_count > min(
            self.evaluated_confident_negative_frame_count,
            self.operating_prediction_count,
            self.false_positives,
        ):
            raise ValueError(
                "confident-negative frame activation count is inconsistent"
            )
        evaluated_negative_identities = _validated_frame_identity_tuple(
            self.evaluated_confident_negative_frame_identities,
            "evaluated_confident_negative_frame_identities",
        )
        activated_negative_identities = _validated_frame_identity_tuple(
            self.activated_confident_negative_frame_identities,
            "activated_confident_negative_frame_identities",
        )
        if len(evaluated_negative_identities) != (
            self.evaluated_confident_negative_frame_count
        ):
            raise ValueError(
                "evaluated confident-negative identities must match the frame count"
            )
        if self.evaluated_confident_negative_frame_identity_set_sha256 != (
            _frame_identity_set_sha256(
                evaluated_negative_identities,
                domain=_EVALUATED_NEGATIVE_IDENTITY_SET_DOMAIN,
            )
        ):
            raise ValueError(
                "evaluated confident-negative identity commitment is inconsistent"
            )
        evaluated_negative_fingerprints = {
            identity.fingerprint() for identity in evaluated_negative_identities
        }
        evaluated_sources = set(
            self.evaluation_manifest.split_proof.evaluated_source_sha256s
        )
        if (
            len(activated_negative_identities)
            != self.confident_negative_frame_activation_count
            or any(
                identity.fingerprint() not in evaluated_negative_fingerprints
                for identity in activated_negative_identities
            )
            or any(
                identity.source_sha256 not in evaluated_sources
                for identity in (
                    *evaluated_negative_identities,
                    *activated_negative_identities,
                )
            )
        ):
            raise ValueError(
                "activated confident-negative identities must be an exact subset "
                "of evaluated negative identities"
            )
        if (
            type(self.confident_negative_frame_activation_rate) is not float
            or not math.isfinite(self.confident_negative_frame_activation_rate)
            or not 0.0 <= self.confident_negative_frame_activation_rate <= 1.0
            or self.confident_negative_frame_activation_rate
            != _safe_ratio(
                self.confident_negative_frame_activation_count,
                self.evaluated_confident_negative_frame_count,
            )
        ):
            raise ValueError("confident_negative_frame_activation_rate is inconsistent")

        unresolved_identities = _validated_frame_identity_tuple(
            self.unresolved_role_frame_identities,
            "unresolved_role_frame_identities",
        )
        activated_unresolved_identities = _validated_frame_identity_tuple(
            self.activated_unresolved_role_frame_identities,
            "activated_unresolved_role_frame_identities",
        )
        unresolved_fingerprints = {
            identity.fingerprint() for identity in unresolved_identities
        }
        if (
            len(unresolved_identities) != self.unresolved_role_frame_count
            or len(activated_unresolved_identities)
            != self.unresolved_role_frame_activation_count
            or any(
                identity.fingerprint() not in unresolved_fingerprints
                for identity in activated_unresolved_identities
            )
            or any(
                identity.source_sha256 not in evaluated_sources
                for identity in (
                    *unresolved_identities,
                    *activated_unresolved_identities,
                )
            )
            or self.unresolved_role_frame_activation_count
            > min(
                self.unresolved_role_frame_count,
                self.operating_unresolved_role_prediction_count,
            )
        ):
            raise ValueError("unresolved-role identity diagnostics are inconsistent")
        if (
            type(self.unresolved_role_frame_activation_rate) is not float
            or self.unresolved_role_frame_activation_rate
            != _safe_ratio(
                self.unresolved_role_frame_activation_count,
                self.unresolved_role_frame_count,
            )
        ):
            raise ValueError("unresolved-role activation rate is inconsistent")
        expected_evaluation_input_sha256 = _evaluation_input_sha256_from_commitments(
            truth_set_sha256=self.truth_set_sha256,
            prediction_set_sha256=self.prediction_set_sha256,
            truth_annotation_count=self.truth_annotation_count,
            truth_frame_count=self.truth_frame_count,
            prediction_count=self.prediction_count,
            normalized_tolerance_ball_diameters=(
                self.normalized_tolerance_ball_diameters
            ),
            operating_confidence_threshold=self.operating_confidence_threshold,
            truth_policy=self.truth_policy,
            evaluation_manifest=self.evaluation_manifest,
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
            protected_verified_at_ns=self.protected_verified_at_ns,
        )
        if self.evaluation_input_sha256 != expected_evaluation_input_sha256:
            raise ValueError(
                "evaluation_input_sha256 does not match the report's input commitments"
            )

        _exact_enum_count_pairs(
            self.visibility_counts,
            BallVisibility,
            "visibility_counts",
        )
        _exact_enum_count_pairs(
            self.unresolved_role_visibility_counts,
            BallVisibility,
            "unresolved_role_visibility_counts",
        )
        for field_name, values, enum_type in (
            ("appearance_counts", self.appearance_counts, BallAppearance),
            ("role_counts", self.role_counts, BallRole),
            ("play_state_counts", self.play_state_counts, BallPlayState),
            ("non_match_role_counts", self.non_match_role_counts, BallRole),
            (
                "non_match_role_activation_counts",
                self.non_match_role_activation_counts,
                BallRole,
            ),
        ):
            _exact_enum_count_pairs(values, enum_type, field_name)
        if sum(count for _, count in self.visibility_counts) != (
            self.evaluated_frame_count
        ):
            raise ValueError("visibility_counts total is inconsistent")
        if sum(count for _, count in self.unresolved_role_visibility_counts) != (
            self.unresolved_role_frame_count
        ):
            raise ValueError("unresolved-role visibility total is inconsistent")
        visibility_count_map = dict(self.visibility_counts)
        unresolved_visibility_count_map = dict(
            self.unresolved_role_visibility_counts
        )
        for visibility in BallVisibility:
            if unresolved_visibility_count_map[visibility] > (
                visibility_count_map[visibility]
            ):
                raise ValueError(
                    "unresolved-role visibility exceeds the primary visibility total"
                )
        if (
            unresolved_visibility_count_map[BallVisibility.NOT_PRESENT] != 0
            or unresolved_visibility_count_map[BallVisibility.CAPTURE_UNKNOWN] != 0
            or unresolved_visibility_count_map[BallVisibility.INDISTINGUISHABLE]
            != visibility_count_map[BallVisibility.INDISTINGUISHABLE]
        ):
            raise ValueError(
                "unresolved-role visibility counts violate annotation semantics"
            )
        if sum(
            visibility_count_map[visibility]
            - unresolved_visibility_count_map[visibility]
            for visibility in _LOCALIZABLE_VISIBILITIES
        ) != self.evaluated_localizable_frame_count:
            raise ValueError("match-ball localizable visibility total is inconsistent")
        if sum(
            visibility_count_map[visibility]
            - unresolved_visibility_count_map[visibility]
            for visibility in _CONFIDENT_NEGATIVE_VISIBILITIES
        ) != self.evaluated_confident_negative_frame_count:
            raise ValueError("match-ball confident-negative total is inconsistent")
        if sum(
            visibility_count_map[visibility]
            - unresolved_visibility_count_map[visibility]
            for visibility in _NONLOCALIZABLE_VISIBILITIES
        ) != self.evaluated_nonlocalizable_frame_count:
            raise ValueError("match-ball nonlocalizable total is inconsistent")
        for values, field_name in (
            (self.appearance_counts, "appearance_counts"),
            (self.role_counts, "role_counts"),
            (self.play_state_counts, "play_state_counts"),
        ):
            if sum(count for _, count in values) != self.evaluated_frame_count:
                raise ValueError(f"{field_name} total is inconsistent")
        appearance_count_map = dict(self.appearance_counts)
        if (
            appearance_count_map[BallAppearance.SHARP]
            + appearance_count_map[BallAppearance.MOTION_BLURRED]
            != visibility_count_map[BallVisibility.VISIBLE]
            + visibility_count_map[BallVisibility.PARTIALLY_OCCLUDED]
            or appearance_count_map[BallAppearance.NOT_OBSERVABLE]
            != self.evaluated_frame_count
            - visibility_count_map[BallVisibility.VISIBLE]
            - visibility_count_map[BallVisibility.PARTIALLY_OCCLUDED]
        ):
            raise ValueError("appearance_counts do not match visibility coverage")
        role_count_map = dict(self.role_counts)
        play_state_count_map = dict(self.play_state_counts)
        if (
            role_count_map[BallRole.UNKNOWN] != self.unresolved_role_frame_count
            or role_count_map[BallRole.MATCH_BALL]
            != self.evaluated_frame_count - self.unresolved_role_frame_count
            or sum(
                role_count_map[role]
                for role in BallRole
                if role not in {BallRole.MATCH_BALL, BallRole.UNKNOWN}
            )
            != 0
            or play_state_count_map[BallPlayState.NOT_APPLICABLE]
            != self.evaluated_confident_negative_frame_count
        ):
            raise ValueError(
                "primary role/play-state counts do not match NOT_PRESENT truth"
            )
        if sum(count for _, count in self.non_match_role_counts) != (
            self.non_match_ball_annotation_count
        ):
            raise ValueError(
                "non_match_role_counts must match non-match annotation count"
            )
        non_match_counts = dict(self.non_match_role_counts)
        if (
            non_match_counts[BallRole.MATCH_BALL] != 0
            or any(
                activated > non_match_counts[role]
                for role, activated in self.non_match_role_activation_counts
            )
        ):
            raise ValueError(
                "non-match role counts or activations are inconsistent"
            )

        expected_nonlocalizable_order = tuple(
            visibility
            for visibility in BallVisibility
            if visibility in _NONLOCALIZABLE_VISIBILITIES
        )
        _exact_enum_count_pairs(
            self.nonlocalizable_visibility_activation_counts,
            BallVisibility,
            "nonlocalizable_visibility_activation_counts",
            expected_members=expected_nonlocalizable_order,
        )
        if any(
            activated
            > visibility_count_map[visibility]
            - unresolved_visibility_count_map[visibility]
            for visibility, activated in self.nonlocalizable_visibility_activation_counts
        ) or sum(
            activated
            for _, activated in self.nonlocalizable_visibility_activation_counts
        ) > self.operating_ignored_nonlocalizable_prediction_count:
            raise ValueError(
                "nonlocalizable visibility activation count exceeds its truth or "
                "ignored-prediction stratum"
            )

        appearance_slices = _validated_performance_slices(
            self.appearance_performance_slices,
            dimension=PerformanceSliceDimension.APPEARANCE,
            enum_type=BallAppearance,
            field_name="appearance_performance_slices",
        )
        role_slices = _validated_performance_slices(
            self.role_performance_slices,
            dimension=PerformanceSliceDimension.ROLE,
            enum_type=BallRole,
            field_name="role_performance_slices",
        )
        play_state_slices = _validated_performance_slices(
            self.play_state_performance_slices,
            dimension=PerformanceSliceDimension.PLAY_STATE,
            enum_type=BallPlayState,
            field_name="play_state_performance_slices",
        )
        role_slice_map = {item.slice_value: item for item in role_slices}
        match_slice = role_slice_map[BallRole.MATCH_BALL.value]
        if match_slice.semantics is not (
            PerformanceSliceSemantics.PRIMARY_MATCH_BALL_LOCALIZATION
        ):
            raise ValueError("MATCH_BALL role slice must use primary semantics")
        match_slice_comparisons = (
            (
                match_slice.truth_annotation_count,
                self.evaluated_frame_count - self.unresolved_role_frame_count,
            ),
            (match_slice.evaluable_positive_count, self.evaluated_localizable_frame_count),
            (match_slice.evaluable_negative_count, self.evaluated_confident_negative_frame_count),
            (
                match_slice.activated_negative_target_count,
                self.confident_negative_frame_activation_count,
            ),
            (
                match_slice.ignored_truth_annotation_count,
                self.evaluated_nonlocalizable_frame_count,
            ),
            (
                match_slice.operating_prediction_count,
                self.operating_prediction_count
                + self.operating_ignored_nonlocalizable_prediction_count,
            ),
            (match_slice.evaluated_prediction_count, self.operating_prediction_count),
            (
                match_slice.ignored_prediction_count,
                self.operating_ignored_nonlocalizable_prediction_count,
            ),
            (match_slice.true_positives, self.true_positives),
            (match_slice.false_positives, self.false_positives),
            (match_slice.false_negatives, self.false_negatives),
            (match_slice.matched_center_errors_px, self.matched_center_errors_px),
            (
                match_slice.matched_apparent_minor_axis_diameters_px,
                self.matched_apparent_minor_axis_diameters_px,
            ),
            (
                match_slice.matched_center_errors_normalized,
                self.matched_center_errors_normalized,
            ),
        )
        if any(actual != expected for actual, expected in match_slice_comparisons):
            raise ValueError("MATCH_BALL role slice does not match primary report")

        non_match_count_map = dict(self.non_match_role_counts)
        non_match_activation_map = dict(self.non_match_role_activation_counts)
        for role in BallRole:
            role_slice = role_slice_map[role.value]
            if role is BallRole.MATCH_BALL:
                continue
            if role is BallRole.UNKNOWN:
                if (
                    role_slice.semantics
                    is not PerformanceSliceSemantics.UNRESOLVED_ROLE_DIAGNOSTIC
                    or role_slice.truth_annotation_count
                    != self.unresolved_role_frame_count
                    + non_match_count_map[role]
                ):
                    raise ValueError("UNKNOWN role slice diagnostics are inconsistent")
                continue
            if (
                role_slice.semantics
                is not PerformanceSliceSemantics.NON_MATCH_HARD_NEGATIVE
                or role_slice.truth_annotation_count != non_match_count_map[role]
                or role_slice.activated_negative_target_count
                != non_match_activation_map[role]
            ):
                raise ValueError(f"{role.value} role slice is inconsistent")

        partition_fields = (
            "truth_annotation_count",
            "evaluable_positive_count",
            "evaluable_negative_count",
            "activated_negative_target_count",
            "ignored_truth_annotation_count",
            "operating_prediction_count",
            "evaluated_prediction_count",
            "ignored_prediction_count",
            "true_positives",
            "false_positives",
            "false_negatives",
        )
        for field_name, slices in (
            ("appearance", appearance_slices),
            ("play-state", play_state_slices),
        ):
            if any(
                item.semantics
                is not PerformanceSliceSemantics.PRIMARY_MATCH_BALL_LOCALIZATION
                for item in slices
            ):
                raise ValueError(f"{field_name} slices must use primary semantics")
            if any(
                sum(getattr(item, field) for item in slices)
                != getattr(match_slice, field)
                for field in partition_fields
            ):
                raise ValueError(
                    f"{field_name} slices do not partition MATCH_BALL performance"
                )
            combined_error_pairs = sorted(
                (
                    error,
                    diameter,
                )
                for item in slices
                for error, diameter in zip(
                    item.matched_center_errors_px,
                    item.matched_apparent_minor_axis_diameters_px,
                    strict=True,
                )
            )
            match_error_pairs = sorted(
                zip(
                    match_slice.matched_center_errors_px,
                    match_slice.matched_apparent_minor_axis_diameters_px,
                    strict=True,
                )
            )
            if (
                combined_error_pairs != match_error_pairs
                or sorted(
                    error
                    for item in slices
                    for error in item.matched_center_errors_normalized
                )
                != list(match_slice.matched_center_errors_normalized)
            ):
                raise ValueError(
                    f"{field_name} slice error evidence does not partition MATCH_BALL"
                )

        _validate_report_preimages(self)

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
        visibility_counts = {
            visibility.value: count for visibility, count in self.visibility_counts
        }
        appearance_counts = {
            appearance.value: count for appearance, count in self.appearance_counts
        }
        role_counts = {role.value: count for role, count in self.role_counts}
        play_state_counts = {
            play_state.value: count
            for play_state, count in self.play_state_counts
        }
        nonlocalizable_activation_counts = {
            visibility.value: count
            for visibility, count in self.nonlocalizable_visibility_activation_counts
        }
        unresolved_role_visibility_counts = {
            visibility.value: count
            for visibility, count in self.unresolved_role_visibility_counts
        }
        return {
            "annotation_trust": {
                "attestation_set_sha256": self.annotation_attestation_set_sha256,
                "evidence_refs": list(self.annotation_evidence_refs),
                "evidence_generation_id": self.annotation_evidence_generation_id,
                "evidence_set_sha256": self.annotation_evidence_set_sha256,
                "evaluation_manifest": self.evaluation_manifest.to_canonical_dict(),
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
                "protected_verified_at_ns": self.protected_verified_at_ns,
            },
            "annotation_schema_version": ANNOTATION_SCHEMA_VERSION,
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
                "evaluated_confident_negative_frames": (
                    self.evaluated_confident_negative_frame_count
                ),
                "evaluated_nonlocalizable_frames": (
                    self.evaluated_nonlocalizable_frame_count
                ),
                "evaluated_predictions": self.evaluated_prediction_count,
                "ignored_nonlocalizable_predictions": (
                    self.ignored_nonlocalizable_prediction_count
                ),
                "operating_ignored_nonlocalizable_predictions": (
                    self.operating_ignored_nonlocalizable_prediction_count
                ),
                "unresolved_role_frames": self.unresolved_role_frame_count,
                "unresolved_role_predictions": (
                    self.unresolved_role_prediction_count
                ),
                "operating_unresolved_role_predictions": (
                    self.operating_unresolved_role_prediction_count
                ),
                "excluded_duplicate_frames": self.excluded_duplicate_frame_count,
                "excluded_duplicate_predictions": self.excluded_duplicate_prediction_count,
                "full_ranking_true_positives": (
                    self.full_ranking_true_positive_count
                ),
                "input_predictions": self.prediction_count,
                "input_truth_annotations": self.truth_annotation_count,
                "input_truth_frames": self.truth_frame_count,
                "non_match_ball_annotations": self.non_match_ball_annotation_count,
            },
            "evaluation_input_sha256": self.evaluation_input_sha256,
            "input_commitments": {
                "prediction_set_sha256": self.prediction_set_sha256,
                "truth_set_sha256": self.truth_set_sha256,
            },
            "metric": _METRIC_NAME,
            "claim_scope": {
                "appearance_performance_claimed": True,
                "benchmark_trust_scope": self.evaluation_manifest.trust_scope.value,
                "match_ball_aggregate_only": False,
                "play_state_performance_claimed": True,
                "primary_ball_instance_id": _MATCH_BALL_INSTANCE_ID,
                "readiness_claim_permitted": False,
                "role_performance_claimed": True,
                "target_role": BallRole.MATCH_BALL.value,
            },
            "localization_metrics_defined": self.localization_metrics_defined,
            "metrics": {
                "average_precision_101": self.average_precision_101,
                "operating_f1": self.f1,
                "operating_precision": self.precision,
                "operating_recall": self.recall,
            },
            "operating_point": {
                "evaluated_confident_negative_frame_identity_set_sha256": (
                    self.evaluated_confident_negative_frame_identity_set_sha256
                ),
                "evaluated_confident_negative_frames": [
                    identity.to_canonical_dict()
                    for identity in self.evaluated_confident_negative_frame_identities
                ],
                "activated_confident_negative_frames": [
                    identity.to_canonical_dict()
                    for identity in self.activated_confident_negative_frame_identities
                ],
                "confidence_threshold": self.operating_confidence_threshold,
                "false_negatives": self.false_negatives,
                "false_positives": self.false_positives,
                "confident_negative_activation_count": (
                    self.confident_negative_frame_activation_count
                ),
                "confident_negative_activation_rate": (
                    self.confident_negative_frame_activation_rate
                ),
                "nonlocalizable_visibility_activation_counts": (
                    nonlocalizable_activation_counts
                ),
                "prediction_count": self.operating_prediction_count,
                "true_positives": self.true_positives,
                "unresolved_role": {
                    "activated_frame_count": (
                        self.unresolved_role_frame_activation_count
                    ),
                    "activated_frame_rate": self.unresolved_role_frame_activation_rate,
                    "activated_frames": [
                        identity.to_canonical_dict()
                        for identity in self.activated_unresolved_role_frame_identities
                    ],
                    "evaluated_frames": [
                        identity.to_canonical_dict()
                        for identity in self.unresolved_role_frame_identities
                    ],
                    "visibility_counts": unresolved_role_visibility_counts,
                },
            },
            "normalized_tolerance_ball_diameters": (
                self.normalized_tolerance_ball_diameters
            ),
            "schema_version": _SCHEMA_VERSION,
            "performance_slices": {
                "appearance": [
                    item.to_canonical_dict()
                    for item in self.appearance_performance_slices
                ],
                "play_state": [
                    item.to_canonical_dict()
                    for item in self.play_state_performance_slices
                ],
                "role": [
                    item.to_canonical_dict()
                    for item in self.role_performance_slices
                ],
            },
            "appearance_counts": appearance_counts,
            "play_state_counts": play_state_counts,
            "non_match_role_counts": {
                role.value: count for role, count in self.non_match_role_counts
            },
            "non_match_role_activation_counts": {
                role.value: count
                for role, count in self.non_match_role_activation_counts
            },
            "role_counts": role_counts,
            "visibility_counts": visibility_counts,
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
    truth: tuple[BallFrameAnnotationV2, ...],
    predictions: tuple[BallPrediction, ...],
    *,
    normalized_tolerance_ball_diameters: float,
    operating_confidence_threshold: float,
    truth_policy: TruthPolicy = TruthPolicy.ADJUDICATED_ONLY,
    evaluation_manifest: UnitBallEvaluationManifest,
    annotation_attestations: tuple[AnnotationAttestation, ...],
    annotation_trust_store: AnnotationTrustStore,
    annotation_evidence_store_root: Path,
    annotation_protected_configuration_generation_path: Path,
    annotation_verification_policy: AnnotationVerificationPolicy,
    expected_annotation_verification_policy_sha256: str,
    protected_verified_at_ns: int,
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
    if len(truth) > _MAX_TRUTH_ANNOTATION_COUNT:
        raise ValueError(
            f"truth cannot exceed {_MAX_TRUTH_ANNOTATION_COUNT} annotations"
        )
    if len(predictions) > _MAX_PREDICTION_COUNT:
        raise ValueError(
            f"predictions cannot exceed {_MAX_PREDICTION_COUNT} candidates"
        )
    if any(type(annotation) is not BallFrameAnnotationV2 for annotation in truth):
        raise ValueError("truth must contain only BallFrameAnnotationV2 values")
    if any(type(prediction) is not BallPrediction for prediction in predictions):
        raise ValueError("predictions must contain only BallPrediction values")
    if type(truth_policy) is not TruthPolicy:
        raise ValueError("truth_policy must be a TruthPolicy enum value")
    if type(evaluation_manifest) is not UnitBallEvaluationManifest:
        raise ValueError(
            "evaluation_manifest must be a UnitBallEvaluationManifest"
        )
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
    _date_from_protected_unix_epoch_ns(protected_verified_at_ns)
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

    truth_lists_by_frame: dict[
        tuple[str, int, int],
        list[BallFrameAnnotationV2],
    ] = {}
    annotation_ids: set[str] = set()
    ball_keys: set[tuple[str, int, int, str, BallRole]] = set()
    for annotation in truth:
        _validate_truth_review(annotation, truth_policy)
        if annotation.annotation_id in annotation_ids:
            raise ValueError(
                "annotation IDs must be unique within an evaluation: "
                + annotation.annotation_id
            )
        annotation_ids.add(annotation.annotation_id)
        frame_key = _frame_key_from_truth(annotation)
        frame_annotations = truth_lists_by_frame.setdefault(frame_key, [])
        if frame_annotations and annotation.frame != frame_annotations[0].frame:
            raise ValueError(
                "all ball annotations on one source frame must bind the same typed "
                "frame reference"
            )
        ball_key = (*frame_key, annotation.ball_instance_id, annotation.role)
        if ball_key in ball_keys:
            raise ValueError(
                "ball truth must be unique by source frame, ball_instance_id, and role"
            )
        ball_keys.add(ball_key)
        frame_annotations.append(annotation)

    truth_by_frame: dict[tuple[str, int, int], BallFrameAnnotationV2] = {}
    non_match_truth: list[BallFrameAnnotationV2] = []
    for frame_key, frame_annotations in truth_lists_by_frame.items():
        match_subjects = [
            annotation
            for annotation in frame_annotations
            if annotation.ball_instance_id == _MATCH_BALL_INSTANCE_ID
        ]
        if len(match_subjects) != 1:
            raise ValueError(
                "each source frame requires exactly one match-ball subject annotation"
            )
        truth_by_frame[frame_key] = match_subjects[0]
        for annotation in frame_annotations:
            if annotation.ball_instance_id == _MATCH_BALL_INSTANCE_ID:
                if annotation.role not in {BallRole.MATCH_BALL, BallRole.UNKNOWN}:
                    raise ValueError(
                        "match-ball subject must have MATCH_BALL or UNKNOWN role"
                    )
                continue
            if annotation.role is BallRole.MATCH_BALL:
                raise ValueError(
                    "non-match ball instances cannot claim MATCH_BALL role"
                )
            non_match_truth.append(annotation)

    expected_sources = tuple(
        sorted({annotation.frame.source_sha256 for annotation in truth})
    )
    expected_annotation_sha256s = tuple(
        sorted(annotation.fingerprint() for annotation in truth)
    )
    coverage = evaluation_manifest.coverage_proof
    if (
        evaluation_manifest.ontology_sha256
        not in {annotation.ontology_sha256 for annotation in truth}
        or len({annotation.ontology_sha256 for annotation in truth}) != 1
    ):
        raise ValueError(
            "every annotation must bind the evaluation manifest ontology fingerprint"
        )
    if evaluation_manifest.split_proof.evaluated_source_sha256s != expected_sources:
        raise ValueError(
            "typed split proof must bind the exact evaluated source set"
        )
    if (
        coverage.annotation_sha256s != expected_annotation_sha256s
        or coverage.match_ball_frame_count != len(truth_by_frame)
        or coverage.non_match_ball_annotation_count != len(non_match_truth)
    ):
        raise ValueError(
            "typed coverage proof must bind the exact annotation set and ball-role counts"
        )

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
        if type(annotation.frame) is not FrameReference:
            raise ValueError(
                "predictions cannot reference a CAPTURE_UNKNOWN frame without decoded pixels"
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
        protected_verified_at_ns=protected_verified_at_ns,
    )
    if annotation_verification.requested_truth_policy.value != truth_policy.value:
        raise RuntimeError(
            "annotation trust verification did not bind the requested truth policy"
        )
    if annotation_verification.protected_verified_at_ns != protected_verified_at_ns:
        raise RuntimeError(
            "annotation trust verification did not preserve the protected time"
        )

    duplicate_frame_keys = _validated_duplicate_frame_keys(truth_by_frame)
    evaluated_truth = tuple(
        annotation
        for frame_key, annotation in truth_by_frame.items()
        if frame_key not in duplicate_frame_keys
    )
    evaluated_non_match_truth = tuple(
        annotation
        for annotation in non_match_truth
        if _frame_key_from_truth(annotation) not in duplicate_frame_keys
    )
    retained_predictions = tuple(
        prediction
        for prediction in predictions
        if _frame_key_from_prediction(prediction) not in duplicate_frame_keys
    )

    unresolved_role_truth = {
        _frame_key_from_truth(annotation): annotation
        for annotation in evaluated_truth
        if annotation.role is BallRole.UNKNOWN
    }
    resolved_match_ball_truth = tuple(
        annotation
        for annotation in evaluated_truth
        if annotation.role is BallRole.MATCH_BALL
    )
    localizable_truth = {
        _frame_key_from_truth(annotation): annotation
        for annotation in resolved_match_ball_truth
        if annotation.visibility in _LOCALIZABLE_VISIBILITIES
    }
    confident_negative_frame_keys = {
        _frame_key_from_truth(annotation)
        for annotation in resolved_match_ball_truth
        if annotation.visibility in _CONFIDENT_NEGATIVE_VISIBILITIES
    }
    nonlocalizable_frame_keys = {
        _frame_key_from_truth(annotation)
        for annotation in resolved_match_ball_truth
        if annotation.visibility in _NONLOCALIZABLE_VISIBILITIES
    }
    unresolved_role_frame_keys = set(unresolved_role_truth)
    evaluable_frame_keys = set(localizable_truth) | confident_negative_frame_keys
    evaluated_predictions = tuple(
        prediction
        for prediction in retained_predictions
        if _frame_key_from_prediction(prediction) in evaluable_frame_keys
    )
    ignored_nonlocalizable_predictions = tuple(
        prediction
        for prediction in retained_predictions
        if _frame_key_from_prediction(prediction) in nonlocalizable_frame_keys
    )
    unresolved_role_predictions = tuple(
        prediction
        for prediction in retained_predictions
        if _frame_key_from_prediction(prediction) in unresolved_role_frame_keys
    )

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
    retained_operating_predictions = tuple(
        prediction
        for prediction in retained_predictions
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

    visibility_counts = tuple(
        (
            visibility,
            sum(
                annotation.visibility is visibility
                for annotation in evaluated_truth
            ),
        )
        for visibility in BallVisibility
    )
    confident_negative_frame_count = len(confident_negative_frame_keys)
    nonlocalizable_frame_count = len(nonlocalizable_frame_keys)
    unresolved_role_visibility_counts = tuple(
        (
            visibility,
            sum(
                annotation.visibility is visibility
                for annotation in unresolved_role_truth.values()
            ),
        )
        for visibility in BallVisibility
    )
    appearance_counts = tuple(
        (
            appearance,
            sum(annotation.appearance is appearance for annotation in evaluated_truth),
        )
        for appearance in BallAppearance
    )
    role_counts = tuple(
        (role, sum(annotation.role is role for annotation in evaluated_truth))
        for role in BallRole
    )
    play_state_counts = tuple(
        (
            play_state,
            sum(
                annotation.play_state is play_state
                for annotation in evaluated_truth
            ),
        )
        for play_state in BallPlayState
    )
    non_match_role_counts = tuple(
        (
            role,
            sum(annotation.role is role for annotation in non_match_truth),
        )
        for role in BallRole
    )
    operating_predictions_by_frame: dict[
        tuple[str, int, int],
        list[BallPrediction],
    ] = {}
    for prediction in retained_operating_predictions:
        operating_predictions_by_frame.setdefault(
            _frame_key_from_prediction(prediction),
            [],
        ).append(prediction)
    activated_non_match_annotation_ids: set[str] = set()
    for annotation in evaluated_non_match_truth:
        if (
            annotation.role is BallRole.UNKNOWN
            or not annotation.is_localizable_observation
        ):
            continue
        assert annotation.center is not None
        assert annotation.apparent_minor_axis_diameter_px is not None
        if any(
            _normalized_center_error(
                math.hypot(
                    prediction.center.x - annotation.center.x,
                    prediction.center.y - annotation.center.y,
                ),
                annotation.apparent_minor_axis_diameter_px,
            )
            <= normalized_tolerance
            for prediction in operating_predictions_by_frame.get(
                _frame_key_from_truth(annotation),
                (),
            )
        ):
            activated_non_match_annotation_ids.add(annotation.annotation_id)
    non_match_role_activation_counts = tuple(
        (
            role,
            sum(
                annotation.role is role
                and annotation.annotation_id in activated_non_match_annotation_ids
                for annotation in evaluated_non_match_truth
            ),
        )
        for role in BallRole
    )
    evaluated_confident_negative_frame_identities = tuple(
        truth_by_frame[frame_key].frame.identity
        for frame_key in sorted(confident_negative_frame_keys)
    )
    evaluated_confident_negative_frame_identity_set_sha256 = (
        _frame_identity_set_sha256(
            evaluated_confident_negative_frame_identities,
            domain=_EVALUATED_NEGATIVE_IDENTITY_SET_DOMAIN,
        )
    )
    activated_confident_negative_frame_keys = {
        _frame_key_from_prediction(prediction)
        for prediction in operating_predictions
        if _frame_key_from_prediction(prediction) in confident_negative_frame_keys
    }
    activated_confident_negative_frame_identities = tuple(
        truth_by_frame[frame_key].frame.identity
        for frame_key in sorted(activated_confident_negative_frame_keys)
    )
    confident_negative_frame_activation_count = len(activated_confident_negative_frame_keys)
    confident_negative_frame_activation_rate = _safe_ratio(
        confident_negative_frame_activation_count,
        confident_negative_frame_count,
    )
    unresolved_role_frame_identities = tuple(
        unresolved_role_truth[frame_key].frame.identity
        for frame_key in sorted(unresolved_role_frame_keys)
    )
    operating_unresolved_role_predictions = tuple(
        prediction
        for prediction in unresolved_role_predictions
        if prediction.confidence >= normalized_operating_threshold
    )
    activated_unresolved_role_frame_keys = {
        _frame_key_from_prediction(prediction)
        for prediction in operating_unresolved_role_predictions
    }
    activated_unresolved_role_frame_identities = tuple(
        unresolved_role_truth[frame_key].frame.identity
        for frame_key in sorted(activated_unresolved_role_frame_keys)
    )
    unresolved_role_frame_activation_count = len(
        activated_unresolved_role_frame_keys
    )
    unresolved_role_frame_activation_rate = _safe_ratio(
        unresolved_role_frame_activation_count,
        len(unresolved_role_truth),
    )
    operating_ignored_nonlocalizable_predictions = tuple(
        prediction
        for prediction in ignored_nonlocalizable_predictions
        if prediction.confidence >= normalized_operating_threshold
    )
    activated_nonlocalizable_frame_keys = {
        _frame_key_from_prediction(prediction)
        for prediction in operating_ignored_nonlocalizable_predictions
    }
    nonlocalizable_visibility_activation_counts = tuple(
        (
            visibility,
            sum(
                1
                for frame_key in activated_nonlocalizable_frame_keys
                if truth_by_frame[frame_key].visibility is visibility
            ),
        )
        for visibility in BallVisibility
        if visibility in _NONLOCALIZABLE_VISIBILITIES
    )
    appearance_performance_slices = tuple(
        _build_primary_performance_slice(
            dimension=PerformanceSliceDimension.APPEARANCE,
            slice_member=appearance,
            annotations=tuple(
                annotation
                for annotation in resolved_match_ball_truth
                if annotation.appearance is appearance
            ),
            retained_operating_predictions=retained_operating_predictions,
            operating_matched_error_evidence=operating_matched_error_evidence,
        )
        for appearance in BallAppearance
    )
    role_performance_slices_list: list[BallLocalizationPerformanceSlice] = []
    for role in BallRole:
        if role is BallRole.MATCH_BALL:
            role_performance_slices_list.append(
                _build_primary_performance_slice(
                    dimension=PerformanceSliceDimension.ROLE,
                    slice_member=role,
                    annotations=resolved_match_ball_truth,
                    retained_operating_predictions=retained_operating_predictions,
                    operating_matched_error_evidence=(
                        operating_matched_error_evidence
                    ),
                )
            )
            continue
        selected_role_annotations = tuple(
            annotation
            for annotation in non_match_truth
            if annotation.role is role
        )
        if role is BallRole.UNKNOWN:
            selected_role_annotations = (
                *tuple(unresolved_role_truth.values()),
                *selected_role_annotations,
            )
        role_performance_slices_list.append(
            _build_non_match_role_performance_slice(
                role=role,
                annotations=selected_role_annotations,
                duplicate_frame_keys=duplicate_frame_keys,
                retained_operating_predictions=retained_operating_predictions,
                normalized_tolerance=normalized_tolerance,
            )
        )
    role_performance_slices = tuple(role_performance_slices_list)
    play_state_performance_slices = tuple(
        _build_primary_performance_slice(
            dimension=PerformanceSliceDimension.PLAY_STATE,
            slice_member=play_state,
            annotations=tuple(
                annotation
                for annotation in resolved_match_ball_truth
                if annotation.play_state is play_state
            ),
            retained_operating_predictions=retained_operating_predictions,
            operating_matched_error_evidence=operating_matched_error_evidence,
        )
        for play_state in BallPlayState
    )
    truth_set_sha256 = _truth_set_sha256(truth)
    prediction_set_sha256 = _prediction_set_sha256(predictions)
    evaluation_input_sha256 = _evaluation_input_sha256_from_commitments(
        truth_set_sha256=truth_set_sha256,
        prediction_set_sha256=prediction_set_sha256,
        truth_annotation_count=len(truth),
        truth_frame_count=len(truth_by_frame),
        prediction_count=len(predictions),
        normalized_tolerance_ball_diameters=normalized_tolerance,
        operating_confidence_threshold=normalized_operating_threshold,
        truth_policy=truth_policy,
        evaluation_manifest=evaluation_manifest,
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
        protected_verified_at_ns=(
            annotation_verification.protected_verified_at_ns
        ),
    )

    return BallLocalizationReport(
        truth_policy=truth_policy,
        evaluation_manifest=evaluation_manifest,
        evaluation_manifest_sha256=evaluation_manifest.fingerprint(),
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
        protected_verified_at_ns=(
            annotation_verification.protected_verified_at_ns
        ),
        normalized_tolerance_ball_diameters=normalized_tolerance,
        operating_confidence_threshold=normalized_operating_threshold,
        truth_set_sha256=truth_set_sha256,
        prediction_set_sha256=prediction_set_sha256,
        evaluation_input_sha256=evaluation_input_sha256,
        truth_preimage=truth,
        prediction_preimage=predictions,
        truth_annotation_count=len(truth),
        truth_frame_count=len(truth_by_frame),
        prediction_count=len(predictions),
        evaluated_frame_count=len(evaluated_truth),
        evaluated_localizable_frame_count=len(localizable_truth),
        evaluated_confident_negative_frame_count=confident_negative_frame_count,
        evaluated_nonlocalizable_frame_count=nonlocalizable_frame_count,
        evaluated_prediction_count=len(evaluated_predictions),
        ignored_nonlocalizable_prediction_count=len(
            ignored_nonlocalizable_predictions
        ),
        operating_ignored_nonlocalizable_prediction_count=len(
            operating_ignored_nonlocalizable_predictions
        ),
        unresolved_role_frame_count=len(unresolved_role_truth),
        unresolved_role_prediction_count=len(unresolved_role_predictions),
        operating_unresolved_role_prediction_count=len(
            operating_unresolved_role_predictions
        ),
        operating_prediction_count=operating_prediction_count,
        full_ranking_true_positive_count=full_ranking_true_positives,
        excluded_duplicate_frame_count=len(duplicate_frame_keys),
        excluded_duplicate_prediction_count=len(predictions) - len(retained_predictions),
        non_match_ball_annotation_count=len(non_match_truth),
        evaluated_confident_negative_frame_identities=(
            evaluated_confident_negative_frame_identities
        ),
        evaluated_confident_negative_frame_identity_set_sha256=(
            evaluated_confident_negative_frame_identity_set_sha256
        ),
        activated_confident_negative_frame_identities=(
            activated_confident_negative_frame_identities
        ),
        confident_negative_frame_activation_count=confident_negative_frame_activation_count,
        confident_negative_frame_activation_rate=confident_negative_frame_activation_rate,
        unresolved_role_frame_identities=unresolved_role_frame_identities,
        activated_unresolved_role_frame_identities=(
            activated_unresolved_role_frame_identities
        ),
        unresolved_role_visibility_counts=unresolved_role_visibility_counts,
        unresolved_role_frame_activation_count=(
            unresolved_role_frame_activation_count
        ),
        unresolved_role_frame_activation_rate=unresolved_role_frame_activation_rate,
        visibility_counts=visibility_counts,
        appearance_counts=appearance_counts,
        role_counts=role_counts,
        play_state_counts=play_state_counts,
        non_match_role_counts=non_match_role_counts,
        non_match_role_activation_counts=non_match_role_activation_counts,
        nonlocalizable_visibility_activation_counts=(
            nonlocalizable_visibility_activation_counts
        ),
        appearance_performance_slices=appearance_performance_slices,
        role_performance_slices=role_performance_slices,
        play_state_performance_slices=play_state_performance_slices,
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
    annotation: BallFrameAnnotationV2,
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
    truth_by_frame: dict[tuple[str, int, int], BallFrameAnnotationV2],
) -> set[tuple[str, int, int]]:
    excludable_frame_keys: set[tuple[str, int, int]] = set()
    for frame_key, annotation in truth_by_frame.items():
        frame = annotation.frame
        if type(frame) is not FrameReference:
            continue
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
                "visibility",
                "appearance",
                "role",
                "play_state",
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


def _frame_key_from_truth(annotation: BallFrameAnnotationV2) -> tuple[str, int, int]:
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


def _mean_or_none(values: tuple[float, ...] | list[float]) -> float | None:
    return math.fsum(values) / len(values) if values else None


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


def _build_performance_slice(
    *,
    dimension: PerformanceSliceDimension,
    slice_member: Enum,
    semantics: PerformanceSliceSemantics,
    truth_annotation_count: int,
    evaluable_positive_count: int,
    evaluable_negative_count: int,
    activated_negative_target_count: int,
    ignored_truth_annotation_count: int,
    operating_prediction_count: int,
    evaluated_prediction_count: int,
    ignored_prediction_count: int,
    true_positives: int,
    false_positives: int,
    false_negatives: int,
    matched_error_evidence: dict[tuple[str, int, int], tuple[float, float]],
) -> BallLocalizationPerformanceSlice:
    ordered_error_evidence = sorted(matched_error_evidence.values())
    errors = tuple(error for error, _ in ordered_error_evidence)
    diameters = tuple(diameter for _, diameter in ordered_error_evidence)
    normalized_errors = tuple(
        sorted(
            _normalized_center_error(error, diameter)
            for error, diameter in ordered_error_evidence
        )
    )
    precision = _safe_ratio(true_positives, true_positives + false_positives)
    recall = _safe_ratio(true_positives, true_positives + false_negatives)
    f1 = _safe_ratio(2.0 * precision * recall, precision + recall)
    return BallLocalizationPerformanceSlice(
        dimension=dimension,
        slice_value=slice_member.value,
        semantics=semantics,
        truth_annotation_count=truth_annotation_count,
        evaluable_positive_count=evaluable_positive_count,
        evaluable_negative_count=evaluable_negative_count,
        activated_negative_target_count=activated_negative_target_count,
        ignored_truth_annotation_count=ignored_truth_annotation_count,
        operating_prediction_count=operating_prediction_count,
        evaluated_prediction_count=evaluated_prediction_count,
        ignored_prediction_count=ignored_prediction_count,
        true_positives=true_positives,
        false_positives=false_positives,
        false_negatives=false_negatives,
        precision=precision,
        recall=recall,
        f1=f1,
        localization_metrics_defined=evaluable_positive_count > 0,
        matched_center_errors_px=errors,
        matched_apparent_minor_axis_diameters_px=diameters,
        matched_center_errors_normalized=normalized_errors,
        matched_center_error_mean_px=_mean_or_none(errors),
        matched_center_error_p50_px=_linear_percentile(list(errors), 0.50),
        matched_center_error_p95_px=_linear_percentile(list(errors), 0.95),
        matched_center_error_max_px=errors[-1] if errors else None,
        matched_center_error_normalized_mean=_mean_or_none(normalized_errors),
        matched_center_error_normalized_p50=_linear_percentile(
            list(normalized_errors),
            0.50,
        ),
        matched_center_error_normalized_p95=_linear_percentile(
            list(normalized_errors),
            0.95,
        ),
        matched_center_error_normalized_max=(
            normalized_errors[-1] if normalized_errors else None
        ),
    )


def _build_primary_performance_slice(
    *,
    dimension: PerformanceSliceDimension,
    slice_member: Enum,
    annotations: tuple[BallFrameAnnotationV2, ...],
    retained_operating_predictions: tuple[BallPrediction, ...],
    operating_matched_error_evidence: dict[
        tuple[str, int, int],
        tuple[float, float],
    ],
) -> BallLocalizationPerformanceSlice:
    frame_keys = {_frame_key_from_truth(annotation) for annotation in annotations}
    positive_frame_keys = {
        _frame_key_from_truth(annotation)
        for annotation in annotations
        if annotation.visibility in _LOCALIZABLE_VISIBILITIES
    }
    negative_frame_keys = {
        _frame_key_from_truth(annotation)
        for annotation in annotations
        if annotation.visibility in _CONFIDENT_NEGATIVE_VISIBILITIES
    }
    evaluable_frame_keys = positive_frame_keys | negative_frame_keys
    slice_predictions = tuple(
        prediction
        for prediction in retained_operating_predictions
        if _frame_key_from_prediction(prediction) in frame_keys
    )
    evaluated_predictions = tuple(
        prediction
        for prediction in slice_predictions
        if _frame_key_from_prediction(prediction) in evaluable_frame_keys
    )
    matched_evidence = {
        frame_key: evidence
        for frame_key, evidence in operating_matched_error_evidence.items()
        if frame_key in positive_frame_keys
    }
    activated_negative_keys = {
        _frame_key_from_prediction(prediction)
        for prediction in evaluated_predictions
        if _frame_key_from_prediction(prediction) in negative_frame_keys
    }
    true_positives = len(matched_evidence)
    return _build_performance_slice(
        dimension=dimension,
        slice_member=slice_member,
        semantics=PerformanceSliceSemantics.PRIMARY_MATCH_BALL_LOCALIZATION,
        truth_annotation_count=len(annotations),
        evaluable_positive_count=len(positive_frame_keys),
        evaluable_negative_count=len(negative_frame_keys),
        activated_negative_target_count=len(activated_negative_keys),
        ignored_truth_annotation_count=(
            len(annotations) - len(positive_frame_keys) - len(negative_frame_keys)
        ),
        operating_prediction_count=len(slice_predictions),
        evaluated_prediction_count=len(evaluated_predictions),
        ignored_prediction_count=len(slice_predictions) - len(evaluated_predictions),
        true_positives=true_positives,
        false_positives=len(evaluated_predictions) - true_positives,
        false_negatives=len(positive_frame_keys) - true_positives,
        matched_error_evidence=matched_evidence,
    )


def _build_non_match_role_performance_slice(
    *,
    role: BallRole,
    annotations: tuple[BallFrameAnnotationV2, ...],
    duplicate_frame_keys: set[tuple[str, int, int]],
    retained_operating_predictions: tuple[BallPrediction, ...],
    normalized_tolerance: float,
) -> BallLocalizationPerformanceSlice:
    frame_keys = {_frame_key_from_truth(annotation) for annotation in annotations}
    slice_predictions = tuple(
        prediction
        for prediction in retained_operating_predictions
        if _frame_key_from_prediction(prediction) in frame_keys
    )
    if role is BallRole.UNKNOWN:
        return _build_performance_slice(
            dimension=PerformanceSliceDimension.ROLE,
            slice_member=role,
            semantics=PerformanceSliceSemantics.UNRESOLVED_ROLE_DIAGNOSTIC,
            truth_annotation_count=len(annotations),
            evaluable_positive_count=0,
            evaluable_negative_count=0,
            activated_negative_target_count=0,
            ignored_truth_annotation_count=len(annotations),
            operating_prediction_count=len(slice_predictions),
            evaluated_prediction_count=0,
            ignored_prediction_count=len(slice_predictions),
            true_positives=0,
            false_positives=0,
            false_negatives=0,
            matched_error_evidence={},
        )

    negative_targets = tuple(
        annotation
        for annotation in annotations
        if _frame_key_from_truth(annotation) not in duplicate_frame_keys
        and annotation.is_localizable_observation
    )
    targets_by_frame: dict[
        tuple[str, int, int],
        list[BallFrameAnnotationV2],
    ] = {}
    for annotation in negative_targets:
        targets_by_frame.setdefault(_frame_key_from_truth(annotation), []).append(
            annotation
        )
    activated_annotation_ids: set[str] = set()
    activated_predictions: list[BallPrediction] = []
    for prediction in slice_predictions:
        prediction_activated = False
        for annotation in targets_by_frame.get(
            _frame_key_from_prediction(prediction),
            (),
        ):
            assert annotation.center is not None
            assert annotation.apparent_minor_axis_diameter_px is not None
            normalized_error = _normalized_center_error(
                math.hypot(
                    prediction.center.x - annotation.center.x,
                    prediction.center.y - annotation.center.y,
                ),
                annotation.apparent_minor_axis_diameter_px,
            )
            if normalized_error <= normalized_tolerance:
                prediction_activated = True
                activated_annotation_ids.add(annotation.annotation_id)
        if prediction_activated:
            activated_predictions.append(prediction)
    return _build_performance_slice(
        dimension=PerformanceSliceDimension.ROLE,
        slice_member=role,
        semantics=PerformanceSliceSemantics.NON_MATCH_HARD_NEGATIVE,
        truth_annotation_count=len(annotations),
        evaluable_positive_count=0,
        evaluable_negative_count=len(negative_targets),
        activated_negative_target_count=len(activated_annotation_ids),
        ignored_truth_annotation_count=len(annotations) - len(negative_targets),
        operating_prediction_count=len(slice_predictions),
        evaluated_prediction_count=len(activated_predictions),
        ignored_prediction_count=len(slice_predictions) - len(activated_predictions),
        true_positives=0,
        false_positives=len(activated_predictions),
        false_negatives=0,
        matched_error_evidence={},
    )


def _validate_report_preimages(report: BallLocalizationReport) -> None:
    """Recompute label-sensitive report evidence from its exact input objects.

    Aggregate partitions alone cannot prove that a slice labeled ``SHARP`` was
    actually derived from SHARP truth, or that a disclosed negative identity is
    present in the committed truth set. Retaining and replaying the exact typed
    preimages closes that ambiguity without treating a local aggregate hash as
    an authority token.
    """

    truth = report.truth_preimage
    predictions = report.prediction_preimage
    if type(truth) is not tuple or any(
        type(annotation) is not BallFrameAnnotationV2 for annotation in truth
    ):
        raise ValueError(
            "truth_preimage must be an exact tuple of BallFrameAnnotationV2 values"
        )
    if type(predictions) is not tuple or any(
        type(prediction) is not BallPrediction for prediction in predictions
    ):
        raise ValueError(
            "prediction_preimage must be an exact tuple of BallPrediction values"
        )
    if len(truth) > _MAX_TRUTH_ANNOTATION_COUNT:
        raise ValueError("truth_preimage exceeds the evaluator resource bound")
    if len(predictions) > _MAX_PREDICTION_COUNT:
        raise ValueError("prediction_preimage exceeds the evaluator resource bound")
    if (
        len(truth) != report.truth_annotation_count
        or len(predictions) != report.prediction_count
        or _truth_set_sha256(truth) != report.truth_set_sha256
        or _prediction_set_sha256(predictions) != report.prediction_set_sha256
    ):
        raise ValueError("report input commitments do not match retained preimages")

    truth_lists_by_frame: dict[
        tuple[str, int, int],
        list[BallFrameAnnotationV2],
    ] = {}
    annotation_ids: set[str] = set()
    ball_keys: set[tuple[str, int, int, str, BallRole]] = set()
    for annotation in truth:
        _validate_truth_review(annotation, report.truth_policy)
        if annotation.annotation_id in annotation_ids:
            raise ValueError("truth_preimage contains a duplicate annotation ID")
        annotation_ids.add(annotation.annotation_id)
        frame_key = _frame_key_from_truth(annotation)
        frame_annotations = truth_lists_by_frame.setdefault(frame_key, [])
        if frame_annotations and annotation.frame != frame_annotations[0].frame:
            raise ValueError(
                "truth_preimage frame annotations do not share one frame reference"
            )
        ball_key = (*frame_key, annotation.ball_instance_id, annotation.role)
        if ball_key in ball_keys:
            raise ValueError("truth_preimage contains a duplicate logical ball key")
        ball_keys.add(ball_key)
        frame_annotations.append(annotation)

    truth_by_frame: dict[tuple[str, int, int], BallFrameAnnotationV2] = {}
    non_match_truth: list[BallFrameAnnotationV2] = []
    for frame_key, frame_annotations in truth_lists_by_frame.items():
        match_subjects = tuple(
            annotation
            for annotation in frame_annotations
            if annotation.ball_instance_id == _MATCH_BALL_INSTANCE_ID
        )
        if len(match_subjects) != 1:
            raise ValueError(
                "truth_preimage requires exactly one match-ball subject per frame"
            )
        truth_by_frame[frame_key] = match_subjects[0]
        non_match_truth.extend(
            annotation
            for annotation in frame_annotations
            if annotation.ball_instance_id != _MATCH_BALL_INSTANCE_ID
        )

    expected_sources = tuple(
        sorted({annotation.frame.source_sha256 for annotation in truth})
    )
    expected_annotation_sha256s = tuple(
        sorted(annotation.fingerprint() for annotation in truth)
    )
    coverage = report.evaluation_manifest.coverage_proof
    if (
        {annotation.ontology_sha256 for annotation in truth}
        != {report.evaluation_manifest.ontology_sha256}
        or report.evaluation_manifest.split_proof.evaluated_source_sha256s
        != expected_sources
        or coverage.annotation_sha256s != expected_annotation_sha256s
        or coverage.match_ball_frame_count != len(truth_by_frame)
        or coverage.non_match_ball_annotation_count != len(non_match_truth)
    ):
        raise ValueError(
            "typed evaluation manifest does not match retained truth preimage"
        )

    candidate_ids: set[str] = set()
    prediction_counts_by_frame: dict[tuple[str, int, int], int] = {}
    for prediction in predictions:
        frame_key = _frame_key_from_prediction(prediction)
        prediction_counts_by_frame[frame_key] = (
            prediction_counts_by_frame.get(frame_key, 0) + 1
        )
        if prediction_counts_by_frame[frame_key] > _MAX_PREDICTIONS_PER_FRAME:
            raise ValueError("prediction_preimage exceeds the per-frame resource bound")
        if prediction.candidate_id in candidate_ids:
            raise ValueError("prediction_preimage contains a duplicate candidate ID")
        candidate_ids.add(prediction.candidate_id)
        annotation = truth_by_frame.get(frame_key)
        if annotation is None or type(annotation.frame) is not FrameReference:
            raise ValueError("prediction_preimage references an ineligible truth frame")
        if prediction.frame_identity != annotation.frame.identity:
            raise ValueError("prediction_preimage frame identity does not match truth")
        if not (
            0.0 <= prediction.center.x <= annotation.frame.width - 1
            and 0.0 <= prediction.center.y <= annotation.frame.height - 1
        ):
            raise ValueError("prediction_preimage center is outside truth frame bounds")

    duplicate_frame_keys = _validated_duplicate_frame_keys(truth_by_frame)
    evaluated_truth = tuple(
        annotation
        for frame_key, annotation in truth_by_frame.items()
        if frame_key not in duplicate_frame_keys
    )
    evaluated_non_match_truth = tuple(
        annotation
        for annotation in non_match_truth
        if _frame_key_from_truth(annotation) not in duplicate_frame_keys
    )
    retained_predictions = tuple(
        prediction
        for prediction in predictions
        if _frame_key_from_prediction(prediction) not in duplicate_frame_keys
    )
    unresolved_role_truth = {
        _frame_key_from_truth(annotation): annotation
        for annotation in evaluated_truth
        if annotation.role is BallRole.UNKNOWN
    }
    resolved_match_ball_truth = tuple(
        annotation
        for annotation in evaluated_truth
        if annotation.role is BallRole.MATCH_BALL
    )
    localizable_truth = {
        _frame_key_from_truth(annotation): annotation
        for annotation in resolved_match_ball_truth
        if annotation.visibility in _LOCALIZABLE_VISIBILITIES
    }
    confident_negative_frame_keys = {
        _frame_key_from_truth(annotation)
        for annotation in resolved_match_ball_truth
        if annotation.visibility in _CONFIDENT_NEGATIVE_VISIBILITIES
    }
    nonlocalizable_frame_keys = {
        _frame_key_from_truth(annotation)
        for annotation in resolved_match_ball_truth
        if annotation.visibility in _NONLOCALIZABLE_VISIBILITIES
    }
    unresolved_role_frame_keys = set(unresolved_role_truth)
    evaluable_frame_keys = set(localizable_truth) | confident_negative_frame_keys
    evaluated_predictions = tuple(
        prediction
        for prediction in retained_predictions
        if _frame_key_from_prediction(prediction) in evaluable_frame_keys
    )
    ignored_nonlocalizable_predictions = tuple(
        prediction
        for prediction in retained_predictions
        if _frame_key_from_prediction(prediction) in nonlocalizable_frame_keys
    )
    unresolved_role_predictions = tuple(
        prediction
        for prediction in retained_predictions
        if _frame_key_from_prediction(prediction) in unresolved_role_frame_keys
    )

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
        group_by_frame: dict[tuple[str, int, int], list[BallPrediction]] = {}
        confidence_group = predictions_by_confidence[confidence]
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
            valid_errors = tuple(
                error
                for prediction in frame_predictions
                for error in (
                    math.hypot(
                        prediction.center.x - annotation.center.x,
                        prediction.center.y - annotation.center.y,
                    ),
                )
                if _normalized_center_error(
                    error,
                    annotation.apparent_minor_axis_diameter_px,
                )
                <= report.normalized_tolerance_ball_diameters
            )
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
        if confidence >= report.operating_confidence_threshold:
            operating_matched_error_evidence = dict(matched_error_evidence)

    operating_predictions = tuple(
        prediction
        for prediction in evaluated_predictions
        if prediction.confidence >= report.operating_confidence_threshold
    )
    retained_operating_predictions = tuple(
        prediction
        for prediction in retained_predictions
        if prediction.confidence >= report.operating_confidence_threshold
    )
    operating_unresolved_role_predictions = tuple(
        prediction
        for prediction in unresolved_role_predictions
        if prediction.confidence >= report.operating_confidence_threshold
    )
    operating_ignored_nonlocalizable_predictions = tuple(
        prediction
        for prediction in ignored_nonlocalizable_predictions
        if prediction.confidence >= report.operating_confidence_threshold
    )

    operating_predictions_by_frame: dict[
        tuple[str, int, int],
        list[BallPrediction],
    ] = {}
    for prediction in retained_operating_predictions:
        operating_predictions_by_frame.setdefault(
            _frame_key_from_prediction(prediction),
            [],
        ).append(prediction)
    activated_non_match_annotation_ids: set[str] = set()
    for annotation in evaluated_non_match_truth:
        if annotation.role is BallRole.UNKNOWN or not annotation.is_localizable_observation:
            continue
        assert annotation.center is not None
        assert annotation.apparent_minor_axis_diameter_px is not None
        if any(
            _normalized_center_error(
                math.hypot(
                    prediction.center.x - annotation.center.x,
                    prediction.center.y - annotation.center.y,
                ),
                annotation.apparent_minor_axis_diameter_px,
            )
            <= report.normalized_tolerance_ball_diameters
            for prediction in operating_predictions_by_frame.get(
                _frame_key_from_truth(annotation),
                (),
            )
        ):
            activated_non_match_annotation_ids.add(annotation.annotation_id)

    expected_appearance_counts = tuple(
        (
            appearance,
            sum(annotation.appearance is appearance for annotation in evaluated_truth),
        )
        for appearance in BallAppearance
    )
    expected_visibility_counts = tuple(
        (
            visibility,
            sum(annotation.visibility is visibility for annotation in evaluated_truth),
        )
        for visibility in BallVisibility
    )
    expected_unresolved_role_visibility_counts = tuple(
        (
            visibility,
            sum(
                annotation.visibility is visibility
                for annotation in unresolved_role_truth.values()
            ),
        )
        for visibility in BallVisibility
    )
    expected_role_counts = tuple(
        (role, sum(annotation.role is role for annotation in evaluated_truth))
        for role in BallRole
    )
    expected_play_state_counts = tuple(
        (
            play_state,
            sum(annotation.play_state is play_state for annotation in evaluated_truth),
        )
        for play_state in BallPlayState
    )
    expected_non_match_role_counts = tuple(
        (
            role,
            sum(annotation.role is role for annotation in non_match_truth),
        )
        for role in BallRole
    )
    expected_non_match_role_activation_counts = tuple(
        (
            role,
            sum(
                annotation.role is role
                and annotation.annotation_id in activated_non_match_annotation_ids
                for annotation in evaluated_non_match_truth
            ),
        )
        for role in BallRole
    )

    expected_appearance_slices = tuple(
        _build_primary_performance_slice(
            dimension=PerformanceSliceDimension.APPEARANCE,
            slice_member=appearance,
            annotations=tuple(
                annotation
                for annotation in resolved_match_ball_truth
                if annotation.appearance is appearance
            ),
            retained_operating_predictions=retained_operating_predictions,
            operating_matched_error_evidence=operating_matched_error_evidence,
        )
        for appearance in BallAppearance
    )
    expected_role_slices_list: list[BallLocalizationPerformanceSlice] = []
    for role in BallRole:
        if role is BallRole.MATCH_BALL:
            expected_role_slices_list.append(
                _build_primary_performance_slice(
                    dimension=PerformanceSliceDimension.ROLE,
                    slice_member=role,
                    annotations=resolved_match_ball_truth,
                    retained_operating_predictions=retained_operating_predictions,
                    operating_matched_error_evidence=operating_matched_error_evidence,
                )
            )
            continue
        selected_role_annotations = tuple(
            annotation for annotation in non_match_truth if annotation.role is role
        )
        if role is BallRole.UNKNOWN:
            selected_role_annotations = (
                *tuple(unresolved_role_truth.values()),
                *selected_role_annotations,
            )
        expected_role_slices_list.append(
            _build_non_match_role_performance_slice(
                role=role,
                annotations=selected_role_annotations,
                duplicate_frame_keys=duplicate_frame_keys,
                retained_operating_predictions=retained_operating_predictions,
                normalized_tolerance=report.normalized_tolerance_ball_diameters,
            )
        )
    expected_role_slices = tuple(expected_role_slices_list)
    expected_play_state_slices = tuple(
        _build_primary_performance_slice(
            dimension=PerformanceSliceDimension.PLAY_STATE,
            slice_member=play_state,
            annotations=tuple(
                annotation
                for annotation in resolved_match_ball_truth
                if annotation.play_state is play_state
            ),
            retained_operating_predictions=retained_operating_predictions,
            operating_matched_error_evidence=operating_matched_error_evidence,
        )
        for play_state in BallPlayState
    )

    expected_negative_identities = tuple(
        truth_by_frame[frame_key].frame.identity
        for frame_key in sorted(confident_negative_frame_keys)
    )
    activated_negative_keys = {
        _frame_key_from_prediction(prediction)
        for prediction in operating_predictions
        if _frame_key_from_prediction(prediction) in confident_negative_frame_keys
    }
    expected_activated_negative_identities = tuple(
        truth_by_frame[frame_key].frame.identity
        for frame_key in sorted(activated_negative_keys)
    )
    expected_unresolved_identities = tuple(
        unresolved_role_truth[frame_key].frame.identity
        for frame_key in sorted(unresolved_role_frame_keys)
    )
    activated_unresolved_keys = {
        _frame_key_from_prediction(prediction)
        for prediction in operating_unresolved_role_predictions
    }
    expected_activated_unresolved_identities = tuple(
        unresolved_role_truth[frame_key].frame.identity
        for frame_key in sorted(activated_unresolved_keys)
    )
    activated_nonlocalizable_keys = {
        _frame_key_from_prediction(prediction)
        for prediction in operating_ignored_nonlocalizable_predictions
    }
    expected_nonlocalizable_activation_counts = tuple(
        (
            visibility,
            sum(
                truth_by_frame[frame_key].visibility is visibility
                for frame_key in activated_nonlocalizable_keys
            ),
        )
        for visibility in BallVisibility
        if visibility in _NONLOCALIZABLE_VISIBILITIES
    )

    expected_pairs: tuple[tuple[str, object, object], ...] = (
        ("truth_frame_count", report.truth_frame_count, len(truth_by_frame)),
        ("evaluated_frame_count", report.evaluated_frame_count, len(evaluated_truth)),
        (
            "evaluated_localizable_frame_count",
            report.evaluated_localizable_frame_count,
            len(localizable_truth),
        ),
        (
            "evaluated_confident_negative_frame_count",
            report.evaluated_confident_negative_frame_count,
            len(confident_negative_frame_keys),
        ),
        (
            "evaluated_nonlocalizable_frame_count",
            report.evaluated_nonlocalizable_frame_count,
            len(nonlocalizable_frame_keys),
        ),
        (
            "evaluated_prediction_count",
            report.evaluated_prediction_count,
            len(evaluated_predictions),
        ),
        (
            "ignored_nonlocalizable_prediction_count",
            report.ignored_nonlocalizable_prediction_count,
            len(ignored_nonlocalizable_predictions),
        ),
        (
            "operating_ignored_nonlocalizable_prediction_count",
            report.operating_ignored_nonlocalizable_prediction_count,
            len(operating_ignored_nonlocalizable_predictions),
        ),
        (
            "unresolved_role_frame_count",
            report.unresolved_role_frame_count,
            len(unresolved_role_truth),
        ),
        (
            "unresolved_role_prediction_count",
            report.unresolved_role_prediction_count,
            len(unresolved_role_predictions),
        ),
        (
            "operating_unresolved_role_prediction_count",
            report.operating_unresolved_role_prediction_count,
            len(operating_unresolved_role_predictions),
        ),
        (
            "operating_prediction_count",
            report.operating_prediction_count,
            len(operating_predictions),
        ),
        (
            "full_ranking_true_positive_count",
            report.full_ranking_true_positive_count,
            len(matched_frames),
        ),
        (
            "excluded_duplicate_frame_count",
            report.excluded_duplicate_frame_count,
            len(duplicate_frame_keys),
        ),
        (
            "excluded_duplicate_prediction_count",
            report.excluded_duplicate_prediction_count,
            len(predictions) - len(retained_predictions),
        ),
        (
            "non_match_ball_annotation_count",
            report.non_match_ball_annotation_count,
            len(non_match_truth),
        ),
        (
            "evaluated_confident_negative_frame_identities",
            report.evaluated_confident_negative_frame_identities,
            expected_negative_identities,
        ),
        (
            "activated_confident_negative_frame_identities",
            report.activated_confident_negative_frame_identities,
            expected_activated_negative_identities,
        ),
        (
            "unresolved_role_frame_identities",
            report.unresolved_role_frame_identities,
            expected_unresolved_identities,
        ),
        (
            "activated_unresolved_role_frame_identities",
            report.activated_unresolved_role_frame_identities,
            expected_activated_unresolved_identities,
        ),
        ("visibility_counts", report.visibility_counts, expected_visibility_counts),
        (
            "unresolved_role_visibility_counts",
            report.unresolved_role_visibility_counts,
            expected_unresolved_role_visibility_counts,
        ),
        ("appearance_counts", report.appearance_counts, expected_appearance_counts),
        ("role_counts", report.role_counts, expected_role_counts),
        ("play_state_counts", report.play_state_counts, expected_play_state_counts),
        (
            "non_match_role_counts",
            report.non_match_role_counts,
            expected_non_match_role_counts,
        ),
        (
            "non_match_role_activation_counts",
            report.non_match_role_activation_counts,
            expected_non_match_role_activation_counts,
        ),
        (
            "nonlocalizable_visibility_activation_counts",
            report.nonlocalizable_visibility_activation_counts,
            expected_nonlocalizable_activation_counts,
        ),
        (
            "appearance_performance_slices",
            report.appearance_performance_slices,
            expected_appearance_slices,
        ),
        ("role_performance_slices", report.role_performance_slices, expected_role_slices),
        (
            "play_state_performance_slices",
            report.play_state_performance_slices,
            expected_play_state_slices,
        ),
        (
            "confidence_ranking_points",
            report.confidence_ranking_points,
            tuple(confidence_ranking_points),
        ),
    )
    for field_name, actual, expected in expected_pairs:
        if actual != expected:
            raise ValueError(
                f"{field_name} does not match retained evaluation preimages"
            )


def _truth_set_sha256(truth: tuple[BallFrameAnnotationV2, ...]) -> str:
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
    truth_annotation_count: int,
    truth_frame_count: int,
    prediction_count: int,
    normalized_tolerance_ball_diameters: float,
    operating_confidence_threshold: float,
    truth_policy: TruthPolicy,
    evaluation_manifest: UnitBallEvaluationManifest,
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
    protected_verified_at_ns: int,
) -> str:
    payload = {
        "annotation_trust": {
            "attestation_set_sha256": annotation_attestation_set_sha256,
            "evidence_refs": list(annotation_evidence_refs),
            "evidence_generation_id": annotation_evidence_generation_id,
            "evidence_set_sha256": annotation_evidence_set_sha256,
            "evaluation_manifest": evaluation_manifest.to_canonical_dict(),
            "evaluation_manifest_sha256": evaluation_manifest.fingerprint(),
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
            "protected_verified_at_ns": protected_verified_at_ns,
        },
        "annotation_schema_version": ANNOTATION_SCHEMA_VERSION,
        "domain": _EVALUATION_INPUT_DOMAIN,
        "metric": _METRIC_NAME,
        "operating_confidence_threshold": operating_confidence_threshold,
        "normalized_tolerance_ball_diameters": normalized_tolerance_ball_diameters,
        "prediction_count": prediction_count,
        "prediction_set_sha256": prediction_set_sha256,
        "schema_version": _SCHEMA_VERSION,
        "truth_annotation_count": truth_annotation_count,
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
