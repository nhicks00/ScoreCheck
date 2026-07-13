"""Protected replay of one complete bounded finalized-source segment.

This coordinator leases one independently pinned decoder runtime and one exact
immutable source object, executes the fixed measurement recipe, and returns an
in-memory replay result only after both capabilities clean up.  The embedded
receipt remains explicitly unverified and publicly fabricable; this module does
not grant training, evaluation, deployment, or scoring authority.
"""

from __future__ import annotations

from dataclasses import dataclass
import hashlib
import math
import os
from pathlib import Path
import time
from typing import ClassVar

from .artifact_store import MAX_ARTIFACT_FILES
from .capture_contracts import MAX_FINALIZED_SOURCE_BYTES
from .capture_measurement_commands import (
    CAPTURE_MEASUREMENT_RECIPE_SHA256_V1,
    capture_measurement_presentation_metadata_argv_v1,
    capture_measurement_rgb24_framehash_argv_v1,
    capture_measurement_selected_video_packets_argv_v1,
)
from .capture_measurement_contracts import DecodedCaptureMeasurementReceiptV1
from .capture_measurement_parsers import (
    MAX_CAPTURE_MEASUREMENT_FRAMEHASH_BYTES,
    MAX_CAPTURE_MEASUREMENT_PRESENTATION_METADATA_BYTES,
    MAX_CAPTURE_MEASUREMENT_SELECTED_PACKET_BYTES,
    ParsedPresentationMetadataV1,
    parse_capture_measurement_presentation_metadata_v1,
    parse_capture_measurement_rgb24_framehash_v1,
    parse_capture_measurement_selected_video_packets_v1,
)
from .capture_measurement_rows import (
    DecodedFrameContentRowV1,
    DecodedMeasurementRecipeV1,
    PresentationTimingRowV1,
    SelectedVideoPacketPayloadRowV1,
    build_decoded_capture_measurement_receipt_v1,
)
from .capture_profile_contracts import VideoCodecV1
from .contract_wire import (
    MAX_SIGNED_64,
    require_exact_int,
    require_sha256,
    require_stable_id,
)
from .decoder_runtime import (
    MAX_DECODER_VERSION_OUTPUT_BYTES,
    DecoderRuntimeError,
    DecoderRuntimeManifestV1,
    _VerifiedDecoderRuntimeLease,
    load_verified_decoder_runtime,
    normalized_decoder_version_output_sha256,
)
from .immutable_store import generation_id_for
from .protected_process import (
    PROTECTED_PROCESS_CLEANUP,
    PROTECTED_PROCESS_OUTPUT_LIMIT,
    PROTECTED_PROCESS_START,
    PROTECTED_PROCESS_TIMEOUT,
    ProtectedProcessError,
    ProtectedProcessResult,
    run_protected_process,
)
from .protected_store_namespaces import (
    validate_distinct_protected_store_namespaces,
)
from .staged_media import (
    StagedMediaError,
    _StagedVerifiedArtifactMediaV1,
    stage_verified_artifact_media_v1,
)


CAPTURE_MEASUREMENT_ERROR_CODES = frozenset(
    {
        "CAPTURE_MEASUREMENT_INPUT",
        "CAPTURE_MEASUREMENT_RECIPE",
        "CAPTURE_MEASUREMENT_RUNTIME",
        "CAPTURE_MEASUREMENT_RUNTIME_VERSION",
        "CAPTURE_MEASUREMENT_MEDIA",
        "CAPTURE_MEASUREMENT_PROCESS_START",
        "CAPTURE_MEASUREMENT_PROCESS_CLEANUP",
        "CAPTURE_MEASUREMENT_PROCESS_TIMEOUT",
        "CAPTURE_MEASUREMENT_PROCESS_OUTPUT_LIMIT",
        "CAPTURE_MEASUREMENT_METADATA",
        "CAPTURE_MEASUREMENT_PACKETS",
        "CAPTURE_MEASUREMENT_FRAMEHASH",
        "CAPTURE_MEASUREMENT_RECEIPT",
        "CAPTURE_MEASUREMENT_INTERNAL",
    }
)

MAX_CAPTURE_MEASUREMENT_PROCESS_STDERR_BYTES = 64 * 1024
RUNTIME_VERSION_TIMEOUT_SECONDS = 60.0
METADATA_TIMEOUT_SECONDS = 180.0
PACKET_TIMEOUT_SECONDS = 180.0
FRAMEHASH_TIMEOUT_SECONDS = 300.0
FRAMEHASH_STDOUT_LIMIT_BYTES = 1

_EXPECTED_SYSTEM_INSTALL_NAMES = ("/usr/lib/libSystem.B.dylib",)
_PATH_TYPE = type(Path("/"))
_AUTHORITY_FIELDS = (
    "admissible_for_training",
    "admissible_for_evaluation",
    "admissible_for_test",
    "admissible_for_deployment",
    "admissible_for_live_scoring",
)


class CaptureMeasurementError(ValueError):
    """Fail-closed protected measurement failure with a finite stable code."""

    def __init__(self, code: str, message: str) -> None:
        if code not in CAPTURE_MEASUREMENT_ERROR_CODES:
            raise ValueError("capture measurement error code is invalid")
        self.code = code
        super().__init__(f"{code}: {message}")


def _fail(code: str, message: str) -> None:
    raise CaptureMeasurementError(code, message)


def _require_false_authorities(value: object, *, label: str) -> None:
    for field in _AUTHORITY_FIELDS:
        if getattr(value, field, None) is not False:
            _fail(
                "CAPTURE_MEASUREMENT_INTERNAL",
                f"{label} authority fields must remain false",
            )


def _canonical_recipe(value: object) -> DecodedMeasurementRecipeV1:
    if type(value) is not DecodedMeasurementRecipeV1:
        _fail("CAPTURE_MEASUREMENT_RECIPE", "measurement recipe has wrong type")
    try:
        reconstructed = DecodedMeasurementRecipeV1.from_json_bytes(
            value.to_json_bytes()
        )
    except (AttributeError, TypeError, ValueError) as exc:
        raise CaptureMeasurementError(
            "CAPTURE_MEASUREMENT_RECIPE",
            "measurement recipe is not canonical",
        ) from exc
    if reconstructed != value:
        _fail("CAPTURE_MEASUREMENT_RECIPE", "measurement recipe changed on replay")
    return reconstructed


def _canonical_receipt(
    value: object,
) -> DecodedCaptureMeasurementReceiptV1:
    if type(value) is not DecodedCaptureMeasurementReceiptV1:
        raise ValueError("receipt has the wrong exact type")
    reconstructed = DecodedCaptureMeasurementReceiptV1.from_json_bytes(
        value.to_json_bytes()
    )
    if reconstructed != value:
        raise ValueError("receipt changed during canonical reconstruction")
    return reconstructed


@dataclass(frozen=True, slots=True)
class UnverifiedCaptureMeasurementReplayV1:
    """Public, fabricable structural result of one protected replay attempt.

    Neither this type nor any of its values proves that protected execution
    occurred.  Downstream authority requires a separate protected verifier.
    """

    receipt: DecodedCaptureMeasurementReceiptV1
    decoder_runtime_generation_id: str
    decoder_runtime_manifest_sha256: str
    decoder_runtime_id: str
    capture_measurement_command_recipe_sha256: str
    metadata_output_sha256: str
    packet_output_sha256: str
    framehash_output_sha256: str
    admissible_for_training: bool = False
    admissible_for_evaluation: bool = False
    admissible_for_test: bool = False
    admissible_for_deployment: bool = False
    admissible_for_live_scoring: bool = False

    _NON_AUTHORITY_STATEMENT: ClassVar[str] = (
        "Replay results are fabricable structural evidence only; the receipt "
        "remains unverified and grants no admission or scoring authority."
    )

    def __post_init__(self) -> None:
        receipt = _canonical_receipt(self.receipt)
        require_sha256(
            self.decoder_runtime_generation_id,
            "decoder_runtime_generation_id",
        )
        require_sha256(
            self.decoder_runtime_manifest_sha256,
            "decoder_runtime_manifest_sha256",
        )
        require_stable_id(self.decoder_runtime_id, "decoder_runtime_id")
        require_sha256(
            self.capture_measurement_command_recipe_sha256,
            "capture_measurement_command_recipe_sha256",
        )
        for field in (
            "metadata_output_sha256",
            "packet_output_sha256",
            "framehash_output_sha256",
        ):
            require_sha256(getattr(self, field), field)
        if (
            receipt.decoder_runtime_manifest_sha256
            != self.decoder_runtime_manifest_sha256
        ):
            raise ValueError("receipt runtime manifest differs from replay result")
        if (
            self.capture_measurement_command_recipe_sha256
            != CAPTURE_MEASUREMENT_RECIPE_SHA256_V1
        ):
            raise ValueError("replay result command recipe is not fixed V1")
        for field in _AUTHORITY_FIELDS:
            if getattr(self, field) is not False:
                raise ValueError(f"{field} must remain exactly false")

    @property
    def non_authority_statement(self) -> str:
        return self._NON_AUTHORITY_STATEMENT


@dataclass(frozen=True, slots=True)
class _ProtectedCaptureMeasurementRowsV1:
    """Private exact rows retained only for the next protected coordinator."""

    replay: UnverifiedCaptureMeasurementReplayV1
    measurement_recipe: DecodedMeasurementRecipeV1
    observed_codec: VideoCodecV1
    presentation_timing_rows: tuple[PresentationTimingRowV1, ...]
    selected_video_packet_rows: tuple[SelectedVideoPacketPayloadRowV1, ...]
    decoded_frame_rows: tuple[DecodedFrameContentRowV1, ...]

    def __post_init__(self) -> None:
        if type(self.replay) is not UnverifiedCaptureMeasurementReplayV1:
            raise ValueError("protected measurement replay has the wrong type")
        canonical_replay = UnverifiedCaptureMeasurementReplayV1(
            **{
                field: getattr(self.replay, field)
                for field in self.replay.__dataclass_fields__
                if not field.startswith("_")
            }
        )
        if canonical_replay != self.replay:
            raise ValueError("protected measurement replay changed on reconstruction")
        for rows, row_type, label in (
            (
                self.presentation_timing_rows,
                PresentationTimingRowV1,
                "presentation timing rows",
            ),
            (
                self.selected_video_packet_rows,
                SelectedVideoPacketPayloadRowV1,
                "selected video packet rows",
            ),
            (
                self.decoded_frame_rows,
                DecodedFrameContentRowV1,
                "decoded frame rows",
            ),
        ):
            if type(rows) is not tuple or any(
                type(row) is not row_type for row in rows
            ):
                raise ValueError(f"{label} must be an exact row tuple")
        recipe = _canonical_recipe(self.measurement_recipe)
        receipt = canonical_replay.receipt
        rebuilt = build_decoded_capture_measurement_receipt_v1(
            source_id=receipt.source_id,
            source_asset_sha256=receipt.source_asset_sha256,
            source_asset_byte_length=receipt.source_asset_byte_length,
            artifact_generation_id=receipt.artifact_generation_id,
            selected_video_stream_index=receipt.selected_video_stream_index,
            decoder_runtime_manifest_sha256=(receipt.decoder_runtime_manifest_sha256),
            observed_codec=self.observed_codec,
            recipe=recipe,
            presentation_timing_rows=self.presentation_timing_rows,
            selected_video_packet_rows=self.selected_video_packet_rows,
            decoded_frame_rows=self.decoded_frame_rows,
        )
        if rebuilt != receipt:
            raise ValueError("protected rows do not rebuild the exact receipt")

    def __reduce__(self) -> object:
        raise TypeError("protected measurement rows are not serializable")

    def __reduce_ex__(self, protocol: int) -> object:
        del protocol
        raise TypeError("protected measurement rows are not serializable")

    def __copy__(self) -> object:
        raise TypeError("protected measurement rows are not copyable")

    def __deepcopy__(self, memo: object) -> object:
        del memo
        raise TypeError("protected measurement rows are not copyable")


def _validate_inputs(
    *,
    source_id: str,
    artifact_store_root: Path,
    artifact_generation_id: str,
    artifact_sha256s: tuple[str, ...],
    source_asset_sha256: str,
    source_asset_byte_length: int,
    selected_video_stream_index: int,
    runtime_store_root: Path,
    runtime_generation_id: str,
    runtime_manifest_sha256: str,
    expected_runtime_manifest_sha256: str,
    expected_platform: str,
    expected_architecture: str,
    expected_abi: str,
    expected_system_runtime_id: str,
    expected_system_runtime_measurement_sha256: str,
    recipe: DecodedMeasurementRecipeV1,
) -> DecodedMeasurementRecipeV1:
    try:
        require_stable_id(source_id, "source_id")
        for path, label in (
            (artifact_store_root, "artifact_store_root"),
            (runtime_store_root, "runtime_store_root"),
        ):
            if type(path) is not _PATH_TYPE or not path.is_absolute():
                raise ValueError(f"{label} must be an exact absolute Path")
        validate_distinct_protected_store_namespaces(
            artifact_store_root,
            runtime_store_root,
        )
        for value, label in (
            (artifact_generation_id, "artifact_generation_id"),
            (source_asset_sha256, "source_asset_sha256"),
            (runtime_generation_id, "runtime_generation_id"),
            (runtime_manifest_sha256, "runtime_manifest_sha256"),
            (
                expected_runtime_manifest_sha256,
                "expected_runtime_manifest_sha256",
            ),
            (
                expected_system_runtime_measurement_sha256,
                "expected_system_runtime_measurement_sha256",
            ),
        ):
            require_sha256(value, label)
        for value, label in (
            (expected_platform, "expected_platform"),
            (expected_architecture, "expected_architecture"),
            (expected_abi, "expected_abi"),
            (expected_system_runtime_id, "expected_system_runtime_id"),
        ):
            require_stable_id(value, label)
        if runtime_manifest_sha256 != expected_runtime_manifest_sha256:
            raise ValueError("runtime manifest differs from independent pin")
        require_exact_int(
            source_asset_byte_length,
            "source_asset_byte_length",
            minimum=1,
            maximum=MAX_FINALIZED_SOURCE_BYTES,
        )
        require_exact_int(
            selected_video_stream_index,
            "selected_video_stream_index",
            minimum=0,
            maximum=MAX_SIGNED_64,
        )
        if (
            type(artifact_sha256s) is not tuple
            or not 1 <= len(artifact_sha256s) <= MAX_ARTIFACT_FILES
        ):
            raise ValueError("artifact_sha256s must be a bounded exact tuple")
        for index, digest in enumerate(artifact_sha256s):
            require_sha256(digest, f"artifact_sha256s[{index}]")
        if artifact_sha256s != tuple(sorted(artifact_sha256s)) or len(
            set(artifact_sha256s)
        ) != len(artifact_sha256s):
            raise ValueError("artifact_sha256s must be unique and sorted")
        if source_asset_sha256 not in artifact_sha256s:
            raise ValueError("source object is absent from artifact generation")
        if generation_id_for(artifact_sha256s) != artifact_generation_id:
            raise ValueError("artifact generation ID differs from its exact tuple")
        canonical_recipe = _canonical_recipe(recipe)
        artifact_roles = {artifact_generation_id, *artifact_sha256s}
        known_runtime_roles = {
            runtime_generation_id,
            runtime_manifest_sha256,
            expected_system_runtime_measurement_sha256,
        }
        measurement_roles = {
            canonical_recipe.fingerprint(),
            CAPTURE_MEASUREMENT_RECIPE_SHA256_V1,
        }
        if (
            len(artifact_roles) != len(artifact_sha256s) + 1
            or len(known_runtime_roles) != 3
            or len(measurement_roles) != 2
            or artifact_roles.intersection(known_runtime_roles)
            or artifact_roles.intersection(measurement_roles)
            or known_runtime_roles.intersection(measurement_roles)
        ):
            raise ValueError("artifact, runtime, and measurement digest roles alias")
        return canonical_recipe
    except CaptureMeasurementError:
        raise
    except (OSError, TypeError, ValueError) as exc:
        raise CaptureMeasurementError(
            "CAPTURE_MEASUREMENT_INPUT",
            "measurement coordinates are invalid",
        ) from exc


def _run_process(
    argv: tuple[str, ...],
    *,
    pass_fds: tuple[int, ...],
    timeout_seconds: float,
    stdout_limit: int,
    auxiliary_read_fd: int = -1,
    auxiliary_write_fd: int = -1,
    auxiliary_limit: int = 0,
) -> ProtectedProcessResult:
    clock_error: BaseException | None = None
    deadline = math.nan
    try:
        deadline = time.monotonic() + timeout_seconds
        if type(deadline) is not float or not math.isfinite(deadline):
            raise ValueError("process deadline is invalid")
    except BaseException as exc:
        # The protected runner must still receive any transferred auxiliary
        # descriptors.  Its invalid-deadline path owns and closes them before
        # this clock failure is classified or propagated.
        clock_error = exc
    try:
        result = run_protected_process(
            argv,
            pass_fds=pass_fds,
            deadline=deadline,
            stdout_limit=stdout_limit,
            stderr_limit=MAX_CAPTURE_MEASUREMENT_PROCESS_STDERR_BYTES,
            auxiliary_read_fd=auxiliary_read_fd,
            auxiliary_write_fd=auxiliary_write_fd,
            auxiliary_limit=auxiliary_limit,
        )
    except ProtectedProcessError as exc:
        if clock_error is not None:
            if exc.code == PROTECTED_PROCESS_CLEANUP:
                raise CaptureMeasurementError(
                    "CAPTURE_MEASUREMENT_PROCESS_CLEANUP",
                    "transferred process descriptors did not clean up",
                ) from clock_error
            if isinstance(clock_error, (KeyboardInterrupt, SystemExit)):
                raise clock_error
            raise CaptureMeasurementError(
                "CAPTURE_MEASUREMENT_PROCESS_CLEANUP",
                "process deadline construction failed",
            ) from clock_error
        code = {
            PROTECTED_PROCESS_START: "CAPTURE_MEASUREMENT_PROCESS_START",
            PROTECTED_PROCESS_CLEANUP: "CAPTURE_MEASUREMENT_PROCESS_CLEANUP",
            PROTECTED_PROCESS_TIMEOUT: "CAPTURE_MEASUREMENT_PROCESS_TIMEOUT",
            PROTECTED_PROCESS_OUTPUT_LIMIT: (
                "CAPTURE_MEASUREMENT_PROCESS_OUTPUT_LIMIT"
            ),
        }[exc.code]
        raise CaptureMeasurementError(
            code, "pinned measurement process failed"
        ) from exc
    if clock_error is not None:
        # A conforming protected runner rejects the sentinel deadline after
        # consuming descriptor ownership.  Fail closed if a substituted runner
        # violates that contract.
        if isinstance(clock_error, (KeyboardInterrupt, SystemExit)):
            raise clock_error
        raise CaptureMeasurementError(
            "CAPTURE_MEASUREMENT_PROCESS_CLEANUP",
            "process deadline construction failed",
        ) from clock_error
    return result


def _bind_runtime_manifest(
    runtime: _VerifiedDecoderRuntimeLease,
    *,
    runtime_generation_id: str,
    runtime_manifest_sha256: str,
    expected_platform: str,
    expected_architecture: str,
    expected_abi: str,
    expected_system_runtime_id: str,
    expected_system_runtime_measurement_sha256: str,
) -> DecoderRuntimeManifestV1:
    if type(runtime) is not _VerifiedDecoderRuntimeLease:
        _fail("CAPTURE_MEASUREMENT_RUNTIME", "runtime capability has wrong type")
    _require_false_authorities(runtime, label="decoder runtime")
    try:
        manifest_value = runtime._runtime_manifest()
        if type(manifest_value) is not DecoderRuntimeManifestV1:
            raise ValueError("runtime manifest has wrong exact type")
        manifest = DecoderRuntimeManifestV1.from_json_bytes(
            manifest_value.to_json_bytes()
        )
    except (DecoderRuntimeError, RuntimeError, TypeError, ValueError) as exc:
        raise CaptureMeasurementError(
            "CAPTURE_MEASUREMENT_RUNTIME",
            "runtime manifest could not be reconstructed",
        ) from exc
    if manifest != manifest_value or manifest.fingerprint() != runtime_manifest_sha256:
        _fail("CAPTURE_MEASUREMENT_RUNTIME", "runtime manifest binding changed")
    if (
        runtime.generation_id != runtime_generation_id
        or runtime.manifest_sha256 != runtime_manifest_sha256
        or runtime.runtime_id != manifest.runtime_id
        or runtime.decoder_recipe_sha256 != manifest.decoder_recipe_sha256
        or manifest.platform != expected_platform
        or manifest.architecture != expected_architecture
        or manifest.abi != expected_abi
        or manifest.system_runtime_measurement.runtime_id != expected_system_runtime_id
        or manifest.system_runtime_measurement.measurement_sha256
        != expected_system_runtime_measurement_sha256
        or manifest.dependency_closure != ()
        or manifest.system_runtime_measurement.allowed_install_names
        != _EXPECTED_SYSTEM_INSTALL_NAMES
    ):
        _fail(
            "CAPTURE_MEASUREMENT_RUNTIME",
            "runtime identity, dependency, or system linkage is unsupported",
        )
    return manifest


def _require_runtime_coordinates(
    runtime: _VerifiedDecoderRuntimeLease,
    manifest: DecoderRuntimeManifestV1,
    *,
    runtime_generation_id: str,
    runtime_manifest_sha256: str,
) -> None:
    if type(runtime) is not _VerifiedDecoderRuntimeLease:
        _fail("CAPTURE_MEASUREMENT_RUNTIME", "runtime capability has wrong type")
    _require_false_authorities(runtime, label="decoder runtime")
    observed = (
        runtime.generation_id,
        runtime.manifest_sha256,
        runtime.runtime_id,
        runtime.decoder_recipe_sha256,
    )
    expected = (
        runtime_generation_id,
        runtime_manifest_sha256,
        manifest.runtime_id,
        manifest.decoder_recipe_sha256,
    )
    if observed != expected:
        _fail("CAPTURE_MEASUREMENT_RUNTIME", "runtime coordinates changed")


def _require_media_coordinates(
    media: _StagedVerifiedArtifactMediaV1,
    *,
    artifact_generation_id: str,
    artifact_sha256s: tuple[str, ...],
    source_asset_sha256: str,
    source_asset_byte_length: int,
) -> None:
    if type(media) is not _StagedVerifiedArtifactMediaV1:
        _fail("CAPTURE_MEASUREMENT_MEDIA", "media capability has wrong type")
    _require_false_authorities(media, label="staged media")
    observed = (
        media.artifact_generation_id,
        media.artifact_sha256s,
        media.source_sha256,
        media.source_byte_length,
    )
    expected = (
        artifact_generation_id,
        artifact_sha256s,
        source_asset_sha256,
        source_asset_byte_length,
    )
    if observed != expected:
        _fail("CAPTURE_MEASUREMENT_MEDIA", "staged media coordinates changed")


def _remeasure_runtime_versions(
    runtime: _VerifiedDecoderRuntimeLease,
    manifest: DecoderRuntimeManifestV1,
) -> None:
    for tool, expected in (
        ("ffprobe", manifest.ffprobe_version_output_sha256),
        ("ffmpeg", manifest.ffmpeg_version_output_sha256),
    ):
        try:
            executable = runtime._executable_path(tool)
            result = _run_process(
                (str(executable), "-hide_banner", "-version"),
                pass_fds=(),
                timeout_seconds=RUNTIME_VERSION_TIMEOUT_SECONDS,
                stdout_limit=MAX_DECODER_VERSION_OUTPUT_BYTES,
            )
            if (
                result.returncode != 0
                or result.stderr != b""
                or result.auxiliary != b""
            ):
                raise ValueError("version command channels are invalid")
            measured = normalized_decoder_version_output_sha256(result.stdout)
        except CaptureMeasurementError:
            raise
        except (DecoderRuntimeError, RuntimeError, TypeError, ValueError) as exc:
            raise CaptureMeasurementError(
                "CAPTURE_MEASUREMENT_RUNTIME_VERSION",
                "pinned decoder version measurement failed",
            ) from exc
        if measured != expected:
            _fail(
                "CAPTURE_MEASUREMENT_RUNTIME_VERSION",
                "pinned decoder version output changed",
            )


def _run_metadata(
    runtime: _VerifiedDecoderRuntimeLease,
    media: _StagedVerifiedArtifactMediaV1,
    selected_stream: int,
) -> tuple[ParsedPresentationMetadataV1, bytes]:
    with media._open_immediate_child_reader() as input_fd:
        executable = runtime._executable_path("ffprobe")
        argv = capture_measurement_presentation_metadata_argv_v1(
            executable,
            input_fd=input_fd,
            selected_video_stream_index=selected_stream,
        )
        result = _run_process(
            argv,
            pass_fds=(input_fd,),
            timeout_seconds=METADATA_TIMEOUT_SECONDS,
            stdout_limit=MAX_CAPTURE_MEASUREMENT_PRESENTATION_METADATA_BYTES,
        )
    if result.returncode != 0 or result.stderr != b"" or result.auxiliary != b"":
        _fail("CAPTURE_MEASUREMENT_METADATA", "metadata process channels are invalid")
    try:
        parsed = parse_capture_measurement_presentation_metadata_v1(
            result.stdout,
            selected_video_stream_index=selected_stream,
        )
    except (TypeError, ValueError) as exc:
        raise CaptureMeasurementError(
            "CAPTURE_MEASUREMENT_METADATA",
            "metadata output is invalid",
        ) from exc
    return parsed, result.stdout


def _run_packets(
    runtime: _VerifiedDecoderRuntimeLease,
    media: _StagedVerifiedArtifactMediaV1,
    selected_stream: int,
) -> tuple[tuple[SelectedVideoPacketPayloadRowV1, ...], bytes]:
    with media._open_immediate_child_reader() as input_fd:
        executable = runtime._executable_path("ffprobe")
        argv = capture_measurement_selected_video_packets_argv_v1(
            executable,
            input_fd=input_fd,
            selected_video_stream_index=selected_stream,
        )
        result = _run_process(
            argv,
            pass_fds=(input_fd,),
            timeout_seconds=PACKET_TIMEOUT_SECONDS,
            stdout_limit=MAX_CAPTURE_MEASUREMENT_SELECTED_PACKET_BYTES,
        )
    if result.returncode != 0 or result.stderr != b"" or result.auxiliary != b"":
        _fail("CAPTURE_MEASUREMENT_PACKETS", "packet process channels are invalid")
    try:
        rows = parse_capture_measurement_selected_video_packets_v1(
            result.stdout,
            selected_video_stream_index=selected_stream,
        )
    except (TypeError, ValueError) as exc:
        raise CaptureMeasurementError(
            "CAPTURE_MEASUREMENT_PACKETS",
            "packet output is invalid",
        ) from exc
    return rows, result.stdout


def _run_framehash(
    runtime: _VerifiedDecoderRuntimeLease,
    media: _StagedVerifiedArtifactMediaV1,
    selected_stream: int,
    metadata: ParsedPresentationMetadataV1,
) -> tuple[tuple[DecodedFrameContentRowV1, ...], bytes]:
    read_fd = -1
    write_fd = -1
    try:
        try:
            read_fd, write_fd = os.pipe()
            os.set_inheritable(read_fd, False)
            os.set_inheritable(write_fd, False)
        except OSError as exc:
            raise CaptureMeasurementError(
                "CAPTURE_MEASUREMENT_FRAMEHASH",
                "framehash pipe setup failed",
            ) from exc
        with media._open_immediate_child_reader() as input_fd:
            executable = runtime._executable_path("ffmpeg")
            argv = capture_measurement_rgb24_framehash_argv_v1(
                executable,
                input_fd=input_fd,
                framehash_output_fd=write_fd,
                selected_video_stream_index=selected_stream,
            )
            transferred_read_fd = read_fd
            transferred_write_fd = write_fd
            read_fd = -1
            write_fd = -1
            result = _run_process(
                argv,
                pass_fds=(input_fd, transferred_write_fd),
                timeout_seconds=FRAMEHASH_TIMEOUT_SECONDS,
                stdout_limit=FRAMEHASH_STDOUT_LIMIT_BYTES,
                auxiliary_read_fd=transferred_read_fd,
                auxiliary_write_fd=transferred_write_fd,
                auxiliary_limit=MAX_CAPTURE_MEASUREMENT_FRAMEHASH_BYTES,
            )
        if result.returncode != 0 or result.stdout != b"" or result.stderr != b"":
            _fail(
                "CAPTURE_MEASUREMENT_FRAMEHASH",
                "framehash process channels are invalid",
            )
        try:
            rows = parse_capture_measurement_rgb24_framehash_v1(
                result.auxiliary,
                metadata=metadata,
            )
        except (TypeError, ValueError) as exc:
            raise CaptureMeasurementError(
                "CAPTURE_MEASUREMENT_FRAMEHASH",
                "framehash output is invalid",
            ) from exc
        return rows, result.auxiliary
    finally:
        local_cleanup_error: BaseException | None = None
        for descriptor in (write_fd, read_fd):
            if descriptor >= 0:
                try:
                    os.close(descriptor)
                except BaseException as exc:
                    # A close failure leaves ownership ambiguous.  Consume the
                    # numeric descriptor with this single attempt, continue
                    # cleaning the other endpoint, and never retry either
                    # number after it could have been reused concurrently.
                    if local_cleanup_error is None:
                        local_cleanup_error = exc
        if local_cleanup_error is not None:
            raise CaptureMeasurementError(
                "CAPTURE_MEASUREMENT_PROCESS_CLEANUP",
                "local framehash descriptors did not clean up",
            ) from local_cleanup_error


def _execute_core(
    *,
    runtime: _VerifiedDecoderRuntimeLease,
    manifest: DecoderRuntimeManifestV1,
    runtime_generation_id: str,
    runtime_manifest_sha256: str,
    media: _StagedVerifiedArtifactMediaV1,
    source_id: str,
    artifact_generation_id: str,
    artifact_sha256s: tuple[str, ...],
    source_asset_sha256: str,
    source_asset_byte_length: int,
    selected_video_stream_index: int,
    recipe: DecodedMeasurementRecipeV1,
) -> _ProtectedCaptureMeasurementRowsV1:
    _require_runtime_coordinates(
        runtime,
        manifest,
        runtime_generation_id=runtime_generation_id,
        runtime_manifest_sha256=runtime_manifest_sha256,
    )
    _require_media_coordinates(
        media,
        artifact_generation_id=artifact_generation_id,
        artifact_sha256s=artifact_sha256s,
        source_asset_sha256=source_asset_sha256,
        source_asset_byte_length=source_asset_byte_length,
    )

    metadata, metadata_raw = _run_metadata(
        runtime,
        media,
        selected_video_stream_index,
    )
    packet_rows, packet_raw = _run_packets(
        runtime,
        media,
        selected_video_stream_index,
    )
    frame_rows, framehash_raw = _run_framehash(
        runtime,
        media,
        selected_video_stream_index,
        metadata,
    )
    _require_runtime_coordinates(
        runtime,
        manifest,
        runtime_generation_id=runtime_generation_id,
        runtime_manifest_sha256=runtime_manifest_sha256,
    )
    _require_media_coordinates(
        media,
        artifact_generation_id=artifact_generation_id,
        artifact_sha256s=artifact_sha256s,
        source_asset_sha256=source_asset_sha256,
        source_asset_byte_length=source_asset_byte_length,
    )
    try:
        receipt = build_decoded_capture_measurement_receipt_v1(
            source_id=source_id,
            source_asset_sha256=source_asset_sha256,
            source_asset_byte_length=source_asset_byte_length,
            artifact_generation_id=artifact_generation_id,
            selected_video_stream_index=selected_video_stream_index,
            decoder_runtime_manifest_sha256=runtime_manifest_sha256,
            observed_codec=metadata.observed_codec,
            recipe=recipe,
            presentation_timing_rows=metadata.presentation_timing_rows,
            selected_video_packet_rows=packet_rows,
            decoded_frame_rows=frame_rows,
        )
        replay = UnverifiedCaptureMeasurementReplayV1(
            receipt=receipt,
            decoder_runtime_generation_id=runtime_generation_id,
            decoder_runtime_manifest_sha256=runtime_manifest_sha256,
            decoder_runtime_id=manifest.runtime_id,
            capture_measurement_command_recipe_sha256=(
                CAPTURE_MEASUREMENT_RECIPE_SHA256_V1
            ),
            metadata_output_sha256=hashlib.sha256(metadata_raw).hexdigest(),
            packet_output_sha256=hashlib.sha256(packet_raw).hexdigest(),
            framehash_output_sha256=hashlib.sha256(framehash_raw).hexdigest(),
        )
        protected_rows = _ProtectedCaptureMeasurementRowsV1(
            replay=replay,
            measurement_recipe=recipe,
            observed_codec=metadata.observed_codec,
            presentation_timing_rows=metadata.presentation_timing_rows,
            selected_video_packet_rows=packet_rows,
            decoded_frame_rows=frame_rows,
        )
    except (TypeError, ValueError) as exc:
        raise CaptureMeasurementError(
            "CAPTURE_MEASUREMENT_RECEIPT",
            "measurement receipt or protected row binding failed",
        ) from exc
    _require_false_authorities(replay, label="capture replay")
    return protected_rows


def _replay_protected_capture_measurement_rows_v1(
    *,
    source_id: str,
    artifact_store_root: Path,
    artifact_generation_id: str,
    artifact_sha256s: tuple[str, ...],
    source_asset_sha256: str,
    source_asset_byte_length: int,
    selected_video_stream_index: int,
    runtime_store_root: Path,
    runtime_generation_id: str,
    runtime_manifest_sha256: str,
    expected_runtime_manifest_sha256: str,
    expected_platform: str,
    expected_architecture: str,
    expected_abi: str,
    expected_system_runtime_id: str,
    expected_system_runtime_measurement_sha256: str,
    recipe: DecodedMeasurementRecipeV1,
) -> _ProtectedCaptureMeasurementRowsV1:
    """Replay one exact segment while retaining rows for protected callers."""

    canonical_recipe = _validate_inputs(
        source_id=source_id,
        artifact_store_root=artifact_store_root,
        artifact_generation_id=artifact_generation_id,
        artifact_sha256s=artifact_sha256s,
        source_asset_sha256=source_asset_sha256,
        source_asset_byte_length=source_asset_byte_length,
        selected_video_stream_index=selected_video_stream_index,
        runtime_store_root=runtime_store_root,
        runtime_generation_id=runtime_generation_id,
        runtime_manifest_sha256=runtime_manifest_sha256,
        expected_runtime_manifest_sha256=expected_runtime_manifest_sha256,
        expected_platform=expected_platform,
        expected_architecture=expected_architecture,
        expected_abi=expected_abi,
        expected_system_runtime_id=expected_system_runtime_id,
        expected_system_runtime_measurement_sha256=(
            expected_system_runtime_measurement_sha256
        ),
        recipe=recipe,
    )
    protected_rows: _ProtectedCaptureMeasurementRowsV1 | None = None
    deferred: BaseException | None = None
    try:
        with load_verified_decoder_runtime(
            runtime_store_root=runtime_store_root,
            generation_id=runtime_generation_id,
            manifest_sha256=runtime_manifest_sha256,
            expected_manifest_sha256=expected_runtime_manifest_sha256,
            expected_platform=expected_platform,
            expected_architecture=expected_architecture,
            expected_abi=expected_abi,
            expected_system_runtime_id=expected_system_runtime_id,
            expected_system_runtime_measurement_sha256=(
                expected_system_runtime_measurement_sha256
            ),
        ) as runtime:
            try:
                manifest = _bind_runtime_manifest(
                    runtime,
                    runtime_generation_id=runtime_generation_id,
                    runtime_manifest_sha256=runtime_manifest_sha256,
                    expected_platform=expected_platform,
                    expected_architecture=expected_architecture,
                    expected_abi=expected_abi,
                    expected_system_runtime_id=expected_system_runtime_id,
                    expected_system_runtime_measurement_sha256=(
                        expected_system_runtime_measurement_sha256
                    ),
                )
                artifact_roles = {artifact_generation_id, *artifact_sha256s}
                runtime_roles = {
                    runtime_generation_id,
                    runtime_manifest_sha256,
                    manifest.ffmpeg_object_sha256,
                    manifest.ffprobe_object_sha256,
                    manifest.ffmpeg_version_output_sha256,
                    manifest.ffprobe_version_output_sha256,
                    manifest.decoder_recipe_sha256,
                    manifest.system_runtime_measurement.measurement_sha256,
                    manifest.license_review_ref.removeprefix("sha256:"),
                    *(item.object_sha256 for item in manifest.dependency_closure),
                }
                measurement_roles = {
                    canonical_recipe.fingerprint(),
                    CAPTURE_MEASUREMENT_RECIPE_SHA256_V1,
                }
                expected_runtime_role_count = 9 + len(manifest.dependency_closure)
                if (
                    len(artifact_roles) != len(artifact_sha256s) + 1
                    or len(runtime_roles) != expected_runtime_role_count
                    or len(measurement_roles) != 2
                    or artifact_roles.intersection(runtime_roles)
                    or artifact_roles.intersection(measurement_roles)
                    or runtime_roles.intersection(measurement_roles)
                ):
                    _fail(
                        "CAPTURE_MEASUREMENT_RUNTIME",
                        "artifact, runtime, and measurement digest roles alias",
                    )
                _remeasure_runtime_versions(runtime, manifest)
                try:
                    with stage_verified_artifact_media_v1(
                        artifact_store_root,
                        artifact_generation_id,
                        artifact_sha256s,
                        source_asset_sha256,
                        source_asset_byte_length,
                    ) as media:
                        try:
                            protected_rows = _execute_core(
                                runtime=runtime,
                                manifest=manifest,
                                runtime_generation_id=runtime_generation_id,
                                runtime_manifest_sha256=runtime_manifest_sha256,
                                media=media,
                                source_id=source_id,
                                artifact_generation_id=artifact_generation_id,
                                artifact_sha256s=artifact_sha256s,
                                source_asset_sha256=source_asset_sha256,
                                source_asset_byte_length=source_asset_byte_length,
                                selected_video_stream_index=(
                                    selected_video_stream_index
                                ),
                                recipe=canonical_recipe,
                            )
                        except BaseException as exc:
                            deferred = exc
                except BaseException as exc:
                    # The body is already deferred inside the media context,
                    # so an exception reaching this boundary came from media
                    # acquisition or teardown and must override it.
                    if isinstance(exc, StagedMediaError):
                        deferred = CaptureMeasurementError(
                            (
                                "CAPTURE_MEASUREMENT_PROCESS_CLEANUP"
                                if exc.code == "MEDIA_CLEANUP"
                                else "CAPTURE_MEASUREMENT_MEDIA"
                            ),
                            "artifact media verification failed",
                        )
                    elif isinstance(exc, (KeyboardInterrupt, SystemExit)):
                        deferred = exc
                    else:
                        deferred = CaptureMeasurementError(
                            "CAPTURE_MEASUREMENT_PROCESS_CLEANUP",
                            "artifact media context failed unexpectedly",
                        )
            except BaseException as exc:
                if deferred is None:
                    deferred = exc
    except BaseException as exc:
        # All runtime-body failures were deferred before this boundary.  An
        # exception here therefore belongs to runtime acquisition/teardown and
        # has precedence over that body failure.
        if isinstance(exc, DecoderRuntimeError):
            deferred = CaptureMeasurementError(
                (
                    "CAPTURE_MEASUREMENT_PROCESS_CLEANUP"
                    if exc.code == "CLEANUP"
                    else "CAPTURE_MEASUREMENT_RUNTIME"
                ),
                "decoder runtime verification failed",
            )
        elif isinstance(exc, (KeyboardInterrupt, SystemExit)):
            deferred = exc
        else:
            deferred = CaptureMeasurementError(
                "CAPTURE_MEASUREMENT_PROCESS_CLEANUP",
                "decoder runtime context failed unexpectedly",
            )

    if deferred is not None:
        if isinstance(deferred, CaptureMeasurementError):
            raise deferred
        if isinstance(deferred, (KeyboardInterrupt, SystemExit)):
            raise deferred
        if isinstance(deferred, DecoderRuntimeError):
            raise CaptureMeasurementError(
                (
                    "CAPTURE_MEASUREMENT_PROCESS_CLEANUP"
                    if deferred.code == "CLEANUP"
                    else "CAPTURE_MEASUREMENT_RUNTIME"
                ),
                "decoder runtime verification failed",
            ) from deferred
        if isinstance(deferred, StagedMediaError):
            raise CaptureMeasurementError(
                (
                    "CAPTURE_MEASUREMENT_PROCESS_CLEANUP"
                    if deferred.code == "MEDIA_CLEANUP"
                    else "CAPTURE_MEASUREMENT_MEDIA"
                ),
                "artifact media verification failed",
            ) from deferred
        raise CaptureMeasurementError(
            "CAPTURE_MEASUREMENT_INTERNAL",
            "protected measurement failed unexpectedly",
        ) from deferred
    if type(protected_rows) is not _ProtectedCaptureMeasurementRowsV1:
        _fail(
            "CAPTURE_MEASUREMENT_PROCESS_CLEANUP",
            "capabilities closed without a replay result",
        )
    return protected_rows


def replay_protected_capture_measurement_v1(
    *,
    source_id: str,
    artifact_store_root: Path,
    artifact_generation_id: str,
    artifact_sha256s: tuple[str, ...],
    source_asset_sha256: str,
    source_asset_byte_length: int,
    selected_video_stream_index: int,
    runtime_store_root: Path,
    runtime_generation_id: str,
    runtime_manifest_sha256: str,
    expected_runtime_manifest_sha256: str,
    expected_platform: str,
    expected_architecture: str,
    expected_abi: str,
    expected_system_runtime_id: str,
    expected_system_runtime_measurement_sha256: str,
    recipe: DecodedMeasurementRecipeV1,
) -> UnverifiedCaptureMeasurementReplayV1:
    """Replay one exact segment; the returned receipt remains unverified."""

    return _replay_protected_capture_measurement_rows_v1(
        source_id=source_id,
        artifact_store_root=artifact_store_root,
        artifact_generation_id=artifact_generation_id,
        artifact_sha256s=artifact_sha256s,
        source_asset_sha256=source_asset_sha256,
        source_asset_byte_length=source_asset_byte_length,
        selected_video_stream_index=selected_video_stream_index,
        runtime_store_root=runtime_store_root,
        runtime_generation_id=runtime_generation_id,
        runtime_manifest_sha256=runtime_manifest_sha256,
        expected_runtime_manifest_sha256=expected_runtime_manifest_sha256,
        expected_platform=expected_platform,
        expected_architecture=expected_architecture,
        expected_abi=expected_abi,
        expected_system_runtime_id=expected_system_runtime_id,
        expected_system_runtime_measurement_sha256=(
            expected_system_runtime_measurement_sha256
        ),
        recipe=recipe,
    ).replay


__all__ = [
    "CAPTURE_MEASUREMENT_ERROR_CODES",
    "CaptureMeasurementError",
    "UnverifiedCaptureMeasurementReplayV1",
    "replay_protected_capture_measurement_v1",
]
