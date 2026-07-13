from __future__ import annotations

from dataclasses import replace
import os
from pathlib import Path
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

if __package__:
    from .test_ball_label_pack import _contract_payloads
    from .test_label_bundle import _bundle
else:
    from test_ball_label_pack import _contract_payloads  # type: ignore[no-redef]
    from test_label_bundle import _bundle  # type: ignore[no-redef]

from vision_scoring.dataset_split import DatasetSplit
from vision_scoring.immutable_store import (
    GenerationDescriptor,
    bootstrap_generation_lock,
)
from vision_scoring.label_bundle import LabelBundleSplit
import vision_scoring.readiness_label_packs as packs
from vision_scoring.readiness_label_packs import (
    MAX_READINESS_LABEL_PACKS,
    ReadinessLabelPackError,
    SourceLabelPackProof,
    _SourceLabelPackRequest,
    _read_worker_result_frame,
    _validate_requests,
    _validate_worker_result,
    _verify_source_label_pack_batch_sync,
    verify_source_label_pack_batch,
)


class ReadinessLabelPackTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary_directory.cleanup)
        self.store_root = Path(self.temporary_directory.name) / "labels"
        (self.store_root / "locks").mkdir(parents=True)
        (self.store_root / "generations").mkdir()
        self.request, self.descriptor, self.pack_sha256 = self._publish(
            LabelBundleSplit.TRAIN
        )

    def _publish(
        self,
        split: LabelBundleSplit,
    ) -> tuple[_SourceLabelPackRequest, GenerationDescriptor, str]:
        statement, annotations, attestations = _bundle(
            split=split,
            all_balls=True,
        )
        root, payloads = _contract_payloads(
            statement,
            annotations,
            tuple(attestations),
        )
        descriptor = GenerationDescriptor.build(tuple(sorted(payloads)))
        bootstrap_generation_lock(self.store_root, descriptor.generation_id)
        generation = self.store_root / "generations" / descriptor.generation_id
        objects = generation / "objects"
        objects.mkdir(parents=True)
        for digest, payload in payloads.items():
            (objects / digest).write_bytes(payload)
        (generation / "descriptor.json").write_bytes(
            descriptor.canonical_bytes()
        )
        request = _SourceLabelPackRequest(
            source_id=f"source-{split.value.lower()}",
            asset_sha256=statement.source_asset_sha256,
            labels_sha256=root.fingerprint(),
            label_pack_generation_id=descriptor.generation_id,
            split=DatasetSplit(split.value),
        )
        return request, descriptor, root.fingerprint()

    def _sync(
        self,
        request: _SourceLabelPackRequest | None = None,
        *,
        artifacts: tuple[str, ...] = (),
    ) -> tuple[SourceLabelPackProof, ...]:
        return _verify_source_label_pack_batch_sync(
            label_store_root=self.store_root,
            requests=(request or self.request,),
            media_capture_artifact_sha256s=artifacts,
            deadline=time.monotonic() + 10.0,
        )

    def _stalled_frame_context(
        self,
        prefix: bytes,
        *,
        start_delay: float = 0.0,
    ):
        state: dict[str, object] = {}

        class Receiver:
            def __init__(self, descriptor: int) -> None:
                self.descriptor = descriptor

            def fileno(self) -> int:
                return self.descriptor

            def close(self) -> None:
                if self.descriptor >= 0:
                    os.close(self.descriptor)
                    self.descriptor = -1

        class Sender:
            def __init__(self, descriptor: int) -> None:
                self.descriptor = descriptor

            def fileno(self) -> int:
                return self.descriptor

            def close(self) -> None:
                if self.descriptor >= 0:
                    os.close(self.descriptor)
                    self.descriptor = -1

        class Worker:
            def __init__(self, child_descriptor: int) -> None:
                self.child_descriptor = child_descriptor
                self.alive = False
                self.terminated = False
                self.killed = False
                self.exitcode = None

            def start(self) -> None:
                if start_delay:
                    time.sleep(start_delay)
                self.alive = True
                if prefix:
                    os.write(self.child_descriptor, prefix)

            def is_alive(self) -> bool:
                return self.alive

            def terminate(self) -> None:
                self.terminated = True

            def kill(self) -> None:
                self.killed = True
                self.alive = False
                if self.child_descriptor >= 0:
                    os.close(self.child_descriptor)
                    self.child_descriptor = -1

            def join(self, timeout: float) -> None:
                return None

            def close(self) -> None:
                if self.child_descriptor >= 0:
                    os.close(self.child_descriptor)
                    self.child_descriptor = -1

        class Context:
            def Pipe(self, *, duplex: bool):  # type: ignore[no-untyped-def]
                read_descriptor, write_descriptor = os.pipe()
                receiver = Receiver(read_descriptor)
                sender = Sender(write_descriptor)
                state["sender"] = sender
                return receiver, sender

            def Process(self, **kwargs):  # type: ignore[no-untyped-def]
                sender = kwargs["args"][0]
                worker = Worker(os.dup(sender.fileno()))
                state["worker"] = worker
                return worker

        return Context(), state

    def test_sync_core_reconstructs_exact_structural_proof_and_no_admission(self) -> None:
        proof = self._sync()[0]
        self.assertEqual(proof.source_id, self.request.source_id)
        self.assertEqual(proof.asset_sha256, self.request.asset_sha256)
        self.assertEqual(proof.labels_sha256, self.pack_sha256)
        self.assertEqual(
            proof.label_pack_generation_id,
            self.descriptor.generation_id,
        )
        self.assertEqual(
            proof.contract_object_count,
            len(self.descriptor.object_sha256s),
        )
        payload = proof.to_dict()
        for field_name in (
            "admissible_for_training",
            "admissible_for_evaluation",
            "admissible_for_test",
            "admissible_for_deployment",
            "admissible_for_live_scoring",
        ):
            self.assertIs(payload[field_name], False)
        self.assertEqual(
            SourceLabelPackProof.from_worker_dict(payload),
            proof,
        )

    def test_spawn_worker_verifies_one_complete_batch(self) -> None:
        proofs = verify_source_label_pack_batch(
            label_store_root=self.store_root,
            requests=(self.request,),
            media_capture_artifact_sha256s=(),
        )
        self.assertEqual(proofs, self._sync())

    def test_test_split_is_structurally_proved_but_never_admitted(self) -> None:
        request, _, _ = self._publish(LabelBundleSplit.TEST)
        proof = self._sync(request)[0]
        self.assertIs(proof.split, DatasetSplit.TEST)
        self.assertFalse(proof.admissible_for_training)
        self.assertFalse(proof.admissible_for_evaluation)
        self.assertFalse(proof.admissible_for_test)

    def test_exact_source_split_root_and_generation_are_required(self) -> None:
        cases = (
            (
                replace(self.request, asset_sha256="b" * 64),
                "LABEL_PACK_SOURCE_MISMATCH",
            ),
            (
                replace(self.request, split=DatasetSplit.DEV),
                "LABEL_PACK_SPLIT_MISMATCH",
            ),
            (
                replace(self.request, labels_sha256="b" * 64),
                "BALL_LABEL_PACK_MEMBERSHIP",
            ),
            (
                replace(self.request, label_pack_generation_id="b" * 64),
                "LABEL_PACK_PREFLIGHT_STORE",
            ),
        )
        for request, code in cases:
            with self.subTest(code=code):
                with self.assertRaises(ReadinessLabelPackError) as caught:
                    self._sync(request)
                self.assertEqual(caught.exception.code, code)

    def test_media_capture_digest_cannot_alias_pack_closure(self) -> None:
        with self.assertRaises(ReadinessLabelPackError) as caught:
            self._sync(artifacts=(self.descriptor.object_sha256s[0],))
        self.assertEqual(caught.exception.code, "LABEL_PACK_ARTIFACT_OVERLAP")

    def test_cross_generation_overlap_allows_only_same_typed_curator_snapshot(
        self,
    ) -> None:
        from vision_scoring.ball_label_pack import load_ball_label_pack

        evidence = load_ball_label_pack(
            label_store_root=self.store_root,
            generation_id=self.request.label_pack_generation_id,
            pack_sha256=self.request.labels_sha256,
        )
        snapshot = evidence.curator_trust_snapshot.fingerprint()
        first_digest = "1" * 64
        second_digest = "2" * 64

        def fake(closure: tuple[str, ...]):
            return SimpleNamespace(
                generation_id=evidence.generation_id,
                pack_sha256=evidence.pack_sha256,
                contract_object_sha256s=closure,
                total_contract_bytes=100,
                statement=evidence.statement,
                curator_attestation=evidence.curator_attestation,
                curator_trust_snapshot=evidence.curator_trust_snapshot,
                admissible_for_training=False,
                admissible_for_evaluation=False,
                admissible_for_test=False,
                admissible_for_deployment=False,
                admissible_for_live_scoring=False,
            )

        second_request = replace(self.request, source_id="source-second")
        with patch.object(
            packs,
            "load_ball_label_pack",
            side_effect=(
                fake((first_digest, snapshot)),
                fake((second_digest, snapshot)),
            ),
        ):
            proofs = _verify_source_label_pack_batch_sync(
                label_store_root=self.store_root,
                requests=(self.request, second_request),
                media_capture_artifact_sha256s=(),
                deadline=time.monotonic() + 10.0,
            )
        self.assertEqual(len(proofs), 2)

        with patch.object(
            packs,
            "load_ball_label_pack",
            side_effect=(
                fake((first_digest, snapshot)),
                fake((first_digest, second_digest, snapshot)),
            ),
        ), self.assertRaises(ReadinessLabelPackError) as caught:
            _verify_source_label_pack_batch_sync(
                label_store_root=self.store_root,
                requests=(self.request, second_request),
                media_capture_artifact_sha256s=(),
                deadline=time.monotonic() + 10.0,
            )
        self.assertEqual(
            caught.exception.code,
            "LABEL_PACK_CROSS_GENERATION_ALIAS",
        )

    def test_worker_ipc_is_exact_and_rebinds_every_request_coordinate(self) -> None:
        proof = self._sync()[0]
        valid = {
            "ok": True,
            "proofs": [proof.to_dict()],
            "contract_object_count": proof.contract_object_count,
            "total_contract_bytes": proof.total_contract_bytes,
        }
        self.assertEqual(
            _validate_worker_result(valid, requests=(self.request,)),
            (proof,),
        )
        forged = (
            {**valid, "ok": 1},
            {**valid, "extra": False},
            {**valid, "contract_object_count": True},
            {
                **valid,
                "proofs": [
                    {**proof.to_dict(), "admissible_for_training": True}
                ],
            },
            {
                **valid,
                "proofs": [
                    {**proof.to_dict(), "source_id": "forged-source"}
                ],
            },
        )
        for result in forged:
            with self.subTest(result=result):
                with self.assertRaises(ReadinessLabelPackError) as caught:
                    _validate_worker_result(result, requests=(self.request,))
                self.assertEqual(
                    caught.exception.code,
                    "LABEL_PACK_WORKER_PROTOCOL",
                )

    def test_framed_worker_wire_is_strict_bounded_and_canonical(self) -> None:
        class Receiver:
            def __init__(self, descriptor: int) -> None:
                self.descriptor = descriptor

            def fileno(self) -> int:
                return self.descriptor

            def close(self) -> None:
                if self.descriptor >= 0:
                    os.close(self.descriptor)
                    self.descriptor = -1

        def read(frame: bytes):  # type: ignore[no-untyped-def]
            read_descriptor, write_descriptor = os.pipe()
            receiver = Receiver(read_descriptor)
            try:
                os.write(write_descriptor, frame)
            finally:
                os.close(write_descriptor)
            try:
                return _read_worker_result_frame(
                    receiver,  # type: ignore[arg-type]
                    deadline=time.monotonic() + 1.0,
                )
            finally:
                receiver.close()

        valid_raw = b'{"code":"","message":"","ok":true}'
        self.assertEqual(
            read(len(valid_raw).to_bytes(8, "big") + valid_raw),
            {"code": "", "message": "", "ok": True},
        )
        invalid_frames = (
            (0).to_bytes(8, "big"),
            (2 * 1024 * 1024 + 1).to_bytes(8, "big"),
            len(b'{"ok": true}').to_bytes(8, "big") + b'{"ok": true}',
            (11).to_bytes(8, "big") + b'{"ok":true}x',
            (20).to_bytes(8, "big") + b'{"ok":true}',
            b"\x00\x00\x00\x01",
        )
        for frame in invalid_frames:
            with self.subTest(frame=frame[:16]), self.assertRaises(
                ReadinessLabelPackError
            ) as caught:
                read(frame)
            self.assertEqual(
                caught.exception.code,
                "LABEL_PACK_WORKER_PROTOCOL",
            )

    def test_512_boundary_is_allowed_and_513_rejected_before_worker_setup(self) -> None:
        requests = tuple(
            replace(self.request, source_id=f"source-{index}")
            for index in range(MAX_READINESS_LABEL_PACKS)
        )
        _validate_requests(requests)
        too_many = requests + (
            replace(self.request, source_id="source-overflow"),
        )
        with patch(
            "vision_scoring.readiness_label_packs.multiprocessing.get_context"
        ) as get_context, self.assertRaisesRegex(ValueError, "1 through 512"):
            verify_source_label_pack_batch(
                label_store_root=self.store_root,
                requests=too_many,
                media_capture_artifact_sha256s=(),
            )
        get_context.assert_not_called()

    def test_artifact_digest_request_is_bounded_before_spawn(self) -> None:
        artifacts = tuple(f"{index:064x}" for index in range(20_001))
        with patch(
            "vision_scoring.readiness_label_packs.multiprocessing.get_context"
        ) as get_context, self.assertRaisesRegex(ValueError, "sorted unique"):
            verify_source_label_pack_batch(
                label_store_root=self.store_root,
                requests=(self.request,),
                media_capture_artifact_sha256s=artifacts,
            )
        get_context.assert_not_called()

    def test_aggregate_object_and_byte_caps_preflight_before_pack_load(self) -> None:
        with patch.object(
            packs,
            "MAX_READINESS_LABEL_PACK_CONTRACT_OBJECTS",
            1,
        ), patch.object(packs, "load_ball_label_pack") as load:
            with self.assertRaises(ReadinessLabelPackError) as caught:
                self._sync()
            self.assertEqual(caught.exception.code, "LABEL_PACK_AGGREGATE_OBJECTS")
            load.assert_not_called()

        with patch.object(
            packs,
            "MAX_READINESS_LABEL_PACK_CONTRACT_BYTES",
            1,
        ), patch.object(packs, "load_ball_label_pack") as load:
            with self.assertRaises(ReadinessLabelPackError) as caught:
                self._sync()
            self.assertEqual(caught.exception.code, "LABEL_PACK_AGGREGATE_BYTES")
            load.assert_not_called()

    def test_worker_start_failure_has_stable_code(self) -> None:
        class Context:
            def Pipe(self, *, duplex: bool):  # type: ignore[no-untyped-def]
                self.assertFalse(duplex)  # pragma: no cover - defensive typo guard

            def Process(self, **kwargs):  # type: ignore[no-untyped-def]
                raise AssertionError("Pipe should fail first")

        context = Context()
        context.assertFalse = self.assertFalse  # type: ignore[attr-defined]
        context.Pipe = lambda **_: (_ for _ in ()).throw(OSError("no pipe"))  # type: ignore[method-assign]
        with patch(
            "vision_scoring.readiness_label_packs.multiprocessing.get_context",
            return_value=context,
        ), self.assertRaises(ReadinessLabelPackError) as caught:
            verify_source_label_pack_batch(
                label_store_root=self.store_root,
                requests=(self.request,),
                media_capture_artifact_sha256s=(),
            )
        self.assertEqual(caught.exception.code, "LABEL_PACK_WORKER_START")

    def test_process_constructor_failure_closes_both_pipe_ends(self) -> None:
        class Connection:
            def __init__(self) -> None:
                self.closed = False

            def close(self) -> None:
                self.closed = True

        receiver = Connection()
        sender = Connection()

        class Context:
            def Pipe(self, *, duplex: bool):  # type: ignore[no-untyped-def]
                return receiver, sender

            def Process(self, **kwargs):  # type: ignore[no-untyped-def]
                raise OSError("cannot construct")

        with patch(
            "vision_scoring.readiness_label_packs.multiprocessing.get_context",
            return_value=Context(),
        ), self.assertRaises(ReadinessLabelPackError) as caught:
            verify_source_label_pack_batch(
                label_store_root=self.store_root,
                requests=(self.request,),
                media_capture_artifact_sha256s=(),
            )
        self.assertEqual(caught.exception.code, "LABEL_PACK_WORKER_START")
        self.assertTrue(receiver.closed)
        self.assertTrue(sender.closed)

    def test_partial_process_start_failure_still_reaches_kill_cleanup(self) -> None:
        class Connection:
            def close(self) -> None:
                return None

        class Worker:
            def __init__(self) -> None:
                self.killed = False

            def start(self) -> None:
                raise OSError("partial start")

            def is_alive(self) -> bool:
                return not self.killed

            def terminate(self) -> None:
                return None

            def kill(self) -> None:
                self.killed = True

            def join(self, timeout: float) -> None:
                return None

            def close(self) -> None:
                return None

        worker = Worker()

        class Context:
            def Pipe(self, *, duplex: bool):  # type: ignore[no-untyped-def]
                return Connection(), Connection()

            def Process(self, **kwargs):  # type: ignore[no-untyped-def]
                return worker

        with patch(
            "vision_scoring.readiness_label_packs.multiprocessing.get_context",
            return_value=Context(),
        ), self.assertRaises(ReadinessLabelPackError) as caught:
            verify_source_label_pack_batch(
                label_store_root=self.store_root,
                requests=(self.request,),
                media_capture_artifact_sha256s=(),
            )
        self.assertEqual(caught.exception.code, "LABEL_PACK_WORKER_START")
        self.assertTrue(worker.killed)

    def test_descriptor_and_close_failures_still_kill_started_worker(self) -> None:
        class Receiver:
            def fileno(self) -> int:
                raise OSError("descriptor failed")

            def close(self) -> None:
                raise OSError("close failed")

        class Sender:
            def close(self) -> None:
                return None

        class Worker:
            def __init__(self) -> None:
                self.alive = False
                self.killed = False
                self.exitcode = None

            def start(self) -> None:
                self.alive = True

            def is_alive(self) -> bool:
                return self.alive

            def terminate(self) -> None:
                return None

            def kill(self) -> None:
                self.killed = True
                self.alive = False

            def join(self, timeout: float) -> None:
                return None

            def close(self) -> None:
                raise OSError("worker close failed")

        worker = Worker()

        class Context:
            def Pipe(self, *, duplex: bool):  # type: ignore[no-untyped-def]
                return Receiver(), Sender()

            def Process(self, **kwargs):  # type: ignore[no-untyped-def]
                return worker

        with patch(
            "vision_scoring.readiness_label_packs.multiprocessing.get_context",
            return_value=Context(),
        ), self.assertRaises(ReadinessLabelPackError) as caught:
            verify_source_label_pack_batch(
                label_store_root=self.store_root,
                requests=(self.request,),
                media_capture_artifact_sha256s=(),
            )
        self.assertEqual(caught.exception.code, "LABEL_PACK_WORKER_PROTOCOL")
        self.assertTrue(worker.killed)

    def test_timeout_terminates_then_kills_stuck_worker(self) -> None:
        context, state = self._stalled_frame_context(b"")
        started = time.monotonic()
        with patch.object(
            packs,
            "READINESS_LABEL_PACK_TIMEOUT_SECONDS",
            0.05,
        ), patch(
            "vision_scoring.readiness_label_packs.multiprocessing.get_context",
            return_value=context,
        ), self.assertRaises(ReadinessLabelPackError) as caught:
            verify_source_label_pack_batch(
                label_store_root=self.store_root,
                requests=(self.request,),
                media_capture_artifact_sha256s=(),
            )
        self.assertEqual(caught.exception.code, "LABEL_PACK_WORKER_TIMEOUT")
        self.assertLess(time.monotonic() - started, 1.0)
        worker = state["worker"]
        self.assertTrue(worker.terminated)
        self.assertTrue(worker.killed)

    def test_partial_header_and_payload_cannot_bypass_deadline(self) -> None:
        prefixes = (
            b"\x00\x00\x00\x00",
            (100).to_bytes(8, "big") + b"{}",
        )
        for prefix in prefixes:
            with self.subTest(prefix_bytes=len(prefix)):
                context, state = self._stalled_frame_context(prefix)
                started = time.monotonic()
                with patch.object(
                    packs,
                    "READINESS_LABEL_PACK_TIMEOUT_SECONDS",
                    0.05,
                ), patch(
                    "vision_scoring.readiness_label_packs.multiprocessing.get_context",
                    return_value=context,
                ), self.assertRaises(ReadinessLabelPackError) as caught:
                    verify_source_label_pack_batch(
                        label_store_root=self.store_root,
                        requests=(self.request,),
                        media_capture_artifact_sha256s=(),
                    )
                self.assertEqual(
                    caught.exception.code,
                    "LABEL_PACK_WORKER_TIMEOUT",
                )
                self.assertLess(time.monotonic() - started, 1.0)
                self.assertTrue(state["worker"].killed)

    def test_fixed_verification_deadline_begins_after_spawn_setup(self) -> None:
        context, state = self._stalled_frame_context(
            b"",
            start_delay=0.05,
        )
        started = time.monotonic()
        with patch.object(
            packs,
            "READINESS_LABEL_PACK_TIMEOUT_SECONDS",
            0.01,
        ), patch(
            "vision_scoring.readiness_label_packs.multiprocessing.get_context",
            return_value=context,
        ), self.assertRaises(ReadinessLabelPackError) as caught:
            verify_source_label_pack_batch(
                label_store_root=self.store_root,
                requests=(self.request,),
                media_capture_artifact_sha256s=(),
            )
        elapsed = time.monotonic() - started
        self.assertEqual(caught.exception.code, "LABEL_PACK_WORKER_TIMEOUT")
        self.assertGreaterEqual(elapsed, 0.05)
        self.assertLess(elapsed, 1.0)
        self.assertTrue(state["worker"].killed)


if __name__ == "__main__":
    unittest.main()
