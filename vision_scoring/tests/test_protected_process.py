from __future__ import annotations

import os
from pathlib import Path
import shlex
import signal
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

import vision_scoring.protected_process as protected_process
from vision_scoring.protected_process import ProtectedProcessError


class _SelectorProxy:
    def __init__(
        self,
        delegate: object,
        *,
        register_error: BaseException | None = None,
        select_error: BaseException | None = None,
        close_error: BaseException | None = None,
    ) -> None:
        self.delegate = delegate
        self.register_error = register_error
        self.select_error = select_error
        self.close_error = close_error
        self.close_calls = 0

    def register(self, *args: object, **kwargs: object) -> object:
        result = self.delegate.register(*args, **kwargs)  # type: ignore[attr-defined]
        if self.register_error is not None:
            raise self.register_error
        return result

    def unregister(self, *args: object, **kwargs: object) -> object:
        return self.delegate.unregister(*args, **kwargs)  # type: ignore[attr-defined]

    def select(self, *args: object, **kwargs: object) -> object:
        if self.select_error is not None:
            raise self.select_error
        return self.delegate.select(*args, **kwargs)  # type: ignore[attr-defined]

    def close(self) -> None:
        self.close_calls += 1
        self.delegate.close()  # type: ignore[attr-defined]
        if self.close_error is not None:
            raise self.close_error


class _TrackedStream:
    def __init__(
        self,
        delegate: object,
        *,
        malformed_descriptor: bool = False,
        close_error: BaseException | None = None,
    ) -> None:
        self.delegate = delegate
        self.malformed_descriptor = malformed_descriptor
        self.close_error = close_error
        self.close_calls = 0

    def fileno(self) -> object:
        if self.malformed_descriptor:
            return "not-an-fd"
        return self.delegate.fileno()  # type: ignore[attr-defined]

    def close(self) -> None:
        self.close_calls += 1
        self.delegate.close()  # type: ignore[attr-defined]
        if self.close_error is not None:
            raise self.close_error


class ProtectedProcessTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary_directory.name)

    def tearDown(self) -> None:
        for directory in self.root.glob("process-*"):
            try:
                directory.chmod(0o700)
            except OSError:
                pass
        self.temporary_directory.cleanup()

    def _script(self, body: str) -> tuple[Path, Path]:
        directory = self.root / f"process-{len(list(self.root.glob('process-*')))}"
        directory.mkdir(mode=0o700)
        executable = directory / "fixture-tool"
        executable.write_text("#!/bin/sh\n" + body, encoding="utf-8")
        executable.chmod(0o500)
        directory.chmod(0o500)
        return directory, executable

    def _run(
        self,
        executable: Path,
        *arguments: str,
        pass_fds: tuple[int, ...] = (),
        timeout_seconds: float = 2.0,
        stdout_limit: int = 4096,
        stderr_limit: int = 4096,
        auxiliary_read_fd: int = -1,
        auxiliary_write_fd: int = -1,
        auxiliary_limit: int = 0,
    ) -> protected_process.ProtectedProcessResult:
        return protected_process.run_protected_process(
            (str(executable), *arguments),
            pass_fds=pass_fds,
            deadline=time.monotonic() + timeout_seconds,
            stdout_limit=stdout_limit,
            stderr_limit=stderr_limit,
            auxiliary_read_fd=auxiliary_read_fd,
            auxiliary_write_fd=auxiliary_write_fd,
            auxiliary_limit=auxiliary_limit,
        )

    def assert_process_error(
        self,
        code: str,
        operation: object,
    ) -> ProtectedProcessError:
        self.assertTrue(callable(operation))
        with self.assertRaises(ProtectedProcessError) as caught:
            operation()  # type: ignore[operator]
        self.assertEqual(caught.exception.code, code)
        return caught.exception

    def test_stable_error_codes_are_closed(self) -> None:
        self.assertEqual(
            protected_process.PROTECTED_PROCESS_ERROR_CODES,
            frozenset(
                {
                    "PROTECTED_PROCESS_START",
                    "PROTECTED_PROCESS_CLEANUP",
                    "PROTECTED_PROCESS_TIMEOUT",
                    "PROTECTED_PROCESS_OUTPUT_LIMIT",
                }
            ),
        )
        with self.assertRaises(ValueError):
            ProtectedProcessError("UNKNOWN", "not part of the finite surface")

    def test_fixed_environment_and_exact_process_security_arguments(self) -> None:
        directory, executable = self._script(
            'printf "%s" "$PATH|$HOME|$LC_ALL|$TZ|$PWD"\n'
        )
        captured: list[tuple[object, dict[str, object]]] = []
        real_initialize = protected_process._initialize_popen

        def start(process: object, argv: object, **kwargs: object) -> None:
            self.assertIs(type(process), protected_process._PINNED_POPEN_CLASS)
            captured.append((argv, kwargs))
            real_initialize(process, argv, **kwargs)  # type: ignore[arg-type]

        with patch.object(protected_process, "_initialize_popen", side_effect=start):
            result = self._run(executable)

        self.assertEqual(result.returncode, 0)
        self.assertEqual(
            result.stdout.decode("utf-8"),
            f"/nonexistent|/nonexistent|C|UTC|{directory.resolve()}",
        )
        self.assertEqual(result.stderr, b"")
        self.assertEqual(result.auxiliary, b"")
        self.assertEqual(len(captured), 1)
        argv, process_kwargs = captured[0]
        self.assertEqual(argv, (str(executable),))
        self.assertIs(process_kwargs["stdin"], subprocess.DEVNULL)
        self.assertIs(process_kwargs["stdout"], subprocess.PIPE)
        self.assertIs(process_kwargs["stderr"], subprocess.PIPE)
        self.assertIs(process_kwargs["shell"], False)
        self.assertIs(process_kwargs["close_fds"], True)
        self.assertEqual(process_kwargs["pass_fds"], ())
        self.assertIs(process_kwargs["start_new_session"], True)
        self.assertEqual(process_kwargs["cwd"], str(directory))
        self.assertEqual(process_kwargs["env"], protected_process._FIXED_ENV)

    def test_initializer_base_exceptions_after_child_creation_are_cleaned(
        self,
    ) -> None:
        real_initialize = protected_process._initialize_popen
        for injected, expected in (
            (KeyboardInterrupt(), KeyboardInterrupt),
            (RuntimeError("synthetic post-start failure"), ProtectedProcessError),
        ):
            with self.subTest(error=type(injected).__name__):
                directory, executable = self._script("while :; do :; done\n")
                processes: list[subprocess.Popen[bytes]] = []

                def start_then_raise(
                    process: subprocess.Popen[bytes],
                    argv: tuple[str, ...],
                    **kwargs: object,
                ) -> None:
                    real_initialize(process, argv, **kwargs)
                    processes.append(process)
                    raise injected

                try:
                    with (
                        patch.object(
                            protected_process,
                            "_initialize_popen",
                            side_effect=start_then_raise,
                        ),
                        self.assertRaises(expected) as caught,
                    ):
                        self._run(executable)
                    if isinstance(caught.exception, ProtectedProcessError):
                        self.assertEqual(
                            caught.exception.code,
                            protected_process.PROTECTED_PROCESS_CLEANUP,
                        )
                    self.assertEqual(len(processes), 1)
                    process = processes[0]
                    self.assertIs(type(process), protected_process._PINNED_POPEN_CLASS)
                    self.assertIsNotNone(process.returncode)
                    with self.assertRaises(ProcessLookupError):
                        os.kill(process.pid, 0)
                finally:
                    directory.chmod(0o700)

    def test_initializer_pre_child_oserror_remains_start_without_group_cleanup(
        self,
    ) -> None:
        directory, executable = self._script("exit 0\n")
        candidates: list[subprocess.Popen[bytes]] = []

        def fail_before_child(
            process: subprocess.Popen[bytes],
            argv: tuple[str, ...],
            **kwargs: object,
        ) -> None:
            del argv, kwargs
            candidates.append(process)
            raise OSError("synthetic pre-child start failure")

        try:
            with (
                patch.object(
                    protected_process,
                    "_initialize_popen",
                    side_effect=fail_before_child,
                ),
                patch.object(
                    protected_process,
                    "_terminate_process_group",
                ) as terminate,
            ):
                self.assert_process_error(
                    protected_process.PROTECTED_PROCESS_START,
                    lambda: self._run(executable),
                )
            terminate.assert_not_called()
            self.assertEqual(len(candidates), 1)
            self.assertFalse(protected_process._popen_child_created(candidates[0]))
        finally:
            directory.chmod(0o700)

    def test_worker_child_inherits_the_callers_original_signal_mask(self) -> None:
        python = shlex.quote(sys.executable)
        statement = shlex.quote(
            "import signal; print(','.join(str(int(item)) for item in "
            "sorted(signal.pthread_sigmask(signal.SIG_BLOCK, set()), key=int)))"
        )
        directory, executable = self._script(f"exec {python} -c {statement}\n")
        prior_mask = signal.pthread_sigmask(signal.SIG_BLOCK, set())
        expected_mask = set(prior_mask)
        expected_mask.add(signal.SIGUSR1)
        signal.pthread_sigmask(signal.SIG_SETMASK, expected_mask)
        try:
            result = self._run(executable)
            measured = {
                int(item)
                for item in result.stdout.decode("ascii").strip().split(",")
                if item
            }
            self.assertEqual(measured, {int(item) for item in expected_mask})
        finally:
            signal.pthread_sigmask(signal.SIG_SETMASK, prior_mask)
            directory.chmod(0o700)

    def test_pending_sigint_waits_for_publication_then_child_is_reaped(self) -> None:
        directory, executable = self._script("while :; do :; done\n")
        real_initialize = protected_process._initialize_popen
        processes: list[subprocess.Popen[bytes]] = []
        sent_without_interrupt = False

        def start_then_signal(
            process: subprocess.Popen[bytes],
            argv: tuple[str, ...],
            **kwargs: object,
        ) -> None:
            nonlocal sent_without_interrupt
            real_initialize(process, argv, **kwargs)
            processes.append(process)
            os.kill(os.getpid(), signal.SIGINT)
            sent_without_interrupt = True
            time.sleep(0.1)

        try:
            worker_names_before = {
                thread.ident
                for thread in threading.enumerate()
                if thread.name == protected_process._POPEN_WORKER_NAME
            }
            with (
                patch.object(
                    protected_process,
                    "_initialize_popen",
                    side_effect=start_then_signal,
                ),
                self.assertRaises(KeyboardInterrupt),
            ):
                self._run(executable)
            self.assertTrue(sent_without_interrupt)
            self.assertEqual(len(processes), 1)
            process = processes[0]
            self.assertTrue(protected_process._popen_child_created(process))
            self.assertIsNotNone(process.returncode)
            with self.assertRaises(ProcessLookupError):
                os.kill(process.pid, 0)
            self.assertEqual(
                {
                    thread.ident
                    for thread in threading.enumerate()
                    if thread.name == protected_process._POPEN_WORKER_NAME
                },
                worker_names_before,
            )
        finally:
            directory.chmod(0o700)

    def test_worker_publication_is_awaited_after_the_deadline_then_times_out(
        self,
    ) -> None:
        directory, executable = self._script("while :; do :; done\n")
        real_initialize = protected_process._initialize_popen
        processes: list[subprocess.Popen[bytes]] = []

        def initialize_then_delay(
            process: subprocess.Popen[bytes],
            argv: tuple[str, ...],
            **kwargs: object,
        ) -> None:
            real_initialize(process, argv, **kwargs)
            processes.append(process)
            time.sleep(0.1)

        try:
            with patch.object(
                protected_process,
                "_initialize_popen",
                side_effect=initialize_then_delay,
            ):
                self.assert_process_error(
                    protected_process.PROTECTED_PROCESS_TIMEOUT,
                    lambda: self._run(executable, timeout_seconds=0.05),
                )
            self.assertEqual(len(processes), 1)
            self.assertIsNotNone(processes[0].returncode)
            self.assertFalse(
                any(
                    thread.name == protected_process._POPEN_WORKER_NAME
                    for thread in threading.enumerate()
                )
            )
        finally:
            directory.chmod(0o700)

    def test_caller_wait_base_exceptions_are_deferred_until_worker_cleanup(
        self,
    ) -> None:
        for injected, expected in (
            (SystemExit(19), SystemExit),
            (RuntimeError("synthetic caller wait failure"), ProtectedProcessError),
        ):
            with self.subTest(error=type(injected).__name__):
                directory, executable = self._script("while :; do :; done\n")
                real_initialize = protected_process._initialize_popen
                real_wait = protected_process._wait_for_popen_publication
                release = threading.Event()
                processes: list[subprocess.Popen[bytes]] = []
                wait_calls = 0

                def initialize_then_pause(
                    process: subprocess.Popen[bytes],
                    argv: tuple[str, ...],
                    **kwargs: object,
                ) -> None:
                    real_initialize(process, argv, **kwargs)
                    processes.append(process)
                    release.wait()

                def interrupt_wait(event: threading.Event, timeout: float) -> bool:
                    nonlocal wait_calls
                    wait_calls += 1
                    if wait_calls == 1:
                        release.set()
                        raise injected
                    return real_wait(event, timeout)

                try:
                    with (
                        patch.object(
                            protected_process,
                            "_initialize_popen",
                            side_effect=initialize_then_pause,
                        ),
                        patch.object(
                            protected_process,
                            "_wait_for_popen_publication",
                            side_effect=interrupt_wait,
                        ),
                        self.assertRaises(expected) as caught,
                    ):
                        self._run(executable)
                    if isinstance(caught.exception, ProtectedProcessError):
                        self.assertEqual(
                            caught.exception.code,
                            protected_process.PROTECTED_PROCESS_CLEANUP,
                        )
                    self.assertGreaterEqual(wait_calls, 1)
                    self.assertEqual(len(processes), 1)
                    self.assertIsNotNone(processes[0].returncode)
                    self.assertFalse(
                        any(
                            thread.name == protected_process._POPEN_WORKER_NAME
                            for thread in threading.enumerate()
                        )
                    )
                finally:
                    release.set()
                    directory.chmod(0o700)

    def test_nul_executable_and_argument_are_rejected_before_initialization(
        self,
    ) -> None:
        directory, executable = self._script("exit 0\n")
        for argv in (
            (str(executable) + "\x00suffix",),
            (str(executable), "argument\x00suffix"),
        ):
            with self.subTest(argv=argv):
                with patch.object(
                    protected_process,
                    "_initialize_popen",
                ) as initialize:
                    self.assert_process_error(
                        protected_process.PROTECTED_PROCESS_START,
                        lambda argv=argv: protected_process.run_protected_process(
                            argv,
                            pass_fds=(),
                            deadline=time.monotonic() + 1.0,
                            stdout_limit=8,
                            stderr_limit=8,
                        ),
                    )
                initialize.assert_not_called()
        directory.chmod(0o700)

    def test_absolute_executable_and_mode_0500_paths_are_revalidated(self) -> None:
        directory, executable = self._script("exit 0\n")
        cases: list[tuple[tuple[str, ...], tuple[int, ...]]] = [
            ((executable.name,), ()),
        ]
        for argv, pass_fds in cases:
            self.assert_process_error(
                protected_process.PROTECTED_PROCESS_START,
                lambda argv=argv, pass_fds=pass_fds: (
                    protected_process.run_protected_process(
                        argv,
                        pass_fds=pass_fds,
                        deadline=time.monotonic() + 1.0,
                        stdout_limit=8,
                        stderr_limit=8,
                    )
                ),
            )

        executable.chmod(0o700)
        self.assert_process_error(
            protected_process.PROTECTED_PROCESS_START,
            lambda: self._run(executable),
        )
        executable.chmod(0o500)
        directory.chmod(0o700)
        self.assert_process_error(
            protected_process.PROTECTED_PROCESS_START,
            lambda: self._run(executable),
        )

    def test_stdout_stderr_and_auxiliary_are_independently_bounded(self) -> None:
        for body, stdout_limit, stderr_limit in (
            ('printf "12345"\n', 4, 8),
            ('printf "12345" >&2\n', 8, 4),
        ):
            directory, executable = self._script(body)
            with self.subTest(body=body):
                self.assert_process_error(
                    protected_process.PROTECTED_PROCESS_OUTPUT_LIMIT,
                    lambda executable=executable, stdout_limit=stdout_limit, stderr_limit=stderr_limit: (
                        self._run(
                            executable,
                            stdout_limit=stdout_limit,
                            stderr_limit=stderr_limit,
                        )
                    ),
                )
            directory.chmod(0o700)

        read_fd, write_fd = os.pipe()
        directory, executable = self._script(f'printf "12345" >&{write_fd}\n')
        try:
            self.assert_process_error(
                protected_process.PROTECTED_PROCESS_OUTPUT_LIMIT,
                lambda: self._run(
                    executable,
                    pass_fds=(write_fd,),
                    auxiliary_read_fd=read_fd,
                    auxiliary_write_fd=write_fd,
                    auxiliary_limit=4,
                ),
            )
            for descriptor in (read_fd, write_fd):
                with self.assertRaises(OSError):
                    os.fstat(descriptor)
        finally:
            directory.chmod(0o700)
            for descriptor in (read_fd, write_fd):
                try:
                    os.close(descriptor)
                except OSError:
                    pass

    def test_optional_auxiliary_channel_is_drained_and_owned(self) -> None:
        read_fd, write_fd = os.pipe()
        directory, executable = self._script(f'printf "framehash" >&{write_fd}\n')
        try:
            result = self._run(
                executable,
                pass_fds=(write_fd,),
                auxiliary_read_fd=read_fd,
                auxiliary_write_fd=write_fd,
                auxiliary_limit=32,
            )
            self.assertEqual(result.auxiliary, b"framehash")
            for descriptor in (read_fd, write_fd):
                with self.assertRaises(OSError):
                    os.fstat(descriptor)
        finally:
            directory.chmod(0o700)
            for descriptor in (read_fd, write_fd):
                try:
                    os.close(descriptor)
                except OSError:
                    pass

    def test_expired_deadline_rejects_before_paths_or_spawn_and_consumes_fds(
        self,
    ) -> None:
        read_fd, write_fd = os.pipe()
        try:
            with (
                patch.object(protected_process.Path, "lstat") as lstat,
                patch.object(protected_process, "_initialize_popen") as initialize,
            ):
                self.assert_process_error(
                    protected_process.PROTECTED_PROCESS_TIMEOUT,
                    lambda: protected_process.run_protected_process(
                        ("/absent/pinned-tool",),
                        pass_fds=(write_fd,),
                        deadline=1.0,
                        stdout_limit=8,
                        stderr_limit=8,
                        auxiliary_read_fd=read_fd,
                        auxiliary_write_fd=write_fd,
                        auxiliary_limit=8,
                    ),
                )
            lstat.assert_not_called()
            initialize.assert_not_called()
            for descriptor in (read_fd, write_fd):
                with self.assertRaises(OSError):
                    os.fstat(descriptor)
        finally:
            for descriptor in (read_fd, write_fd):
                try:
                    os.close(descriptor)
                except OSError:
                    pass

    def test_final_deadline_check_includes_successful_wait_time(self) -> None:
        directory, executable = self._script("exit 0\n")
        real_initialize = protected_process._initialize_popen
        processes: list[subprocess.Popen[bytes]] = []
        wait_calls = 0

        def start(
            process: subprocess.Popen[bytes],
            argv: tuple[str, ...],
            **kwargs: object,
        ) -> None:
            nonlocal wait_calls
            real_initialize(process, argv, **kwargs)
            real_wait = process.wait

            def delayed_wait(*args: object, **wait_kwargs: object) -> int:
                nonlocal wait_calls
                wait_calls += 1
                time.sleep(0.1)
                return real_wait(*args, **wait_kwargs)

            process.wait = delayed_wait  # type: ignore[method-assign]
            processes.append(process)

        try:
            with patch.object(
                protected_process,
                "_initialize_popen",
                side_effect=start,
            ):
                self.assert_process_error(
                    protected_process.PROTECTED_PROCESS_TIMEOUT,
                    lambda: self._run(executable, timeout_seconds=0.05),
                )
            self.assertEqual(len(processes), 1)
            self.assertEqual(wait_calls, 1)
            self.assertIsNotNone(processes[0].returncode)
        finally:
            directory.chmod(0o700)

    def test_selector_faults_converge_on_all_attempt_cleanup(self) -> None:
        real_selector_factory = protected_process.selectors.DefaultSelector

        for phase in ("construct", "register", "select", "close"):
            with self.subTest(phase=phase):
                directory, executable = self._script(
                    "exit 0\n" if phase == "close" else "while :; do :; done\n"
                )
                proxies: list[_SelectorProxy] = []

                def selector_factory() -> object:
                    proxy = _SelectorProxy(
                        real_selector_factory(),
                        register_error=(
                            RuntimeError("synthetic register failure")
                            if phase == "register"
                            else None
                        ),
                        select_error=(
                            RuntimeError("synthetic select failure")
                            if phase == "select"
                            else None
                        ),
                        close_error=(
                            RuntimeError("synthetic close failure")
                            if phase == "close"
                            else None
                        ),
                    )
                    proxies.append(proxy)
                    return proxy

                effect = (
                    RuntimeError("synthetic selector construction failure")
                    if phase == "construct"
                    else selector_factory
                )
                try:
                    with patch.object(
                        protected_process.selectors,
                        "DefaultSelector",
                        side_effect=effect,
                    ):
                        self.assert_process_error(
                            protected_process.PROTECTED_PROCESS_CLEANUP,
                            lambda: self._run(executable),
                        )
                    if proxies:
                        self.assertEqual(proxies[0].close_calls, 1)
                finally:
                    directory.chmod(0o700)

    def test_base_exceptions_rethrow_only_after_successful_cleanup(self) -> None:
        real_selector_factory = protected_process.selectors.DefaultSelector
        for close_fails, expected in (
            (False, KeyboardInterrupt),
            (True, ProtectedProcessError),
        ):
            with self.subTest(close_fails=close_fails):
                directory, executable = self._script("while :; do :; done\n")

                def selector_factory() -> _SelectorProxy:
                    return _SelectorProxy(
                        real_selector_factory(),
                        select_error=KeyboardInterrupt(),
                        close_error=(
                            RuntimeError("synthetic close failure")
                            if close_fails
                            else None
                        ),
                    )

                try:
                    with (
                        patch.object(
                            protected_process.selectors,
                            "DefaultSelector",
                            side_effect=selector_factory,
                        ),
                        self.assertRaises(expected) as caught,
                    ):
                        self._run(executable)
                    if close_fails:
                        self.assertEqual(
                            caught.exception.code,  # type: ignore[attr-defined]
                            protected_process.PROTECTED_PROCESS_CLEANUP,
                        )
                finally:
                    directory.chmod(0o700)

    def test_poll_read_wait_and_malformed_stream_faults_are_stable_cleanup(
        self,
    ) -> None:
        real_initialize = protected_process._initialize_popen

        directory, executable = self._script("while :; do :; done\n")
        poll_processes: list[subprocess.Popen[bytes]] = []
        poll_calls = 0
        poll_wait_calls = 0

        def poll_start(
            process: subprocess.Popen[bytes],
            argv: tuple[str, ...],
            **kwargs: object,
        ) -> None:
            nonlocal poll_calls, poll_wait_calls
            real_initialize(process, argv, **kwargs)
            real_wait = process.wait

            def failed_poll() -> int | None:
                nonlocal poll_calls
                poll_calls += 1
                raise RuntimeError("synthetic poll failure")

            def tracked_wait(*args: object, **wait_kwargs: object) -> int:
                nonlocal poll_wait_calls
                poll_wait_calls += 1
                return real_wait(*args, **wait_kwargs)

            process.poll = failed_poll  # type: ignore[method-assign]
            process.wait = tracked_wait  # type: ignore[method-assign]
            poll_processes.append(process)

        try:
            with patch.object(
                protected_process,
                "_initialize_popen",
                side_effect=poll_start,
            ):
                self.assert_process_error(
                    protected_process.PROTECTED_PROCESS_CLEANUP,
                    lambda: self._run(executable),
                )
            self.assertGreaterEqual(poll_calls, 2)
            self.assertGreaterEqual(poll_wait_calls, 1)
            self.assertIsNotNone(poll_processes[0].returncode)
        finally:
            directory.chmod(0o700)

        directory, executable = self._script('printf "x"\n')
        read_processes: list[subprocess.Popen[bytes]] = []

        def read_start(
            process: subprocess.Popen[bytes],
            argv: tuple[str, ...],
            **kwargs: object,
        ) -> None:
            real_initialize(process, argv, **kwargs)
            read_processes.append(process)

        try:
            with (
                patch.object(
                    protected_process,
                    "_initialize_popen",
                    side_effect=read_start,
                ),
                patch.object(
                    protected_process,
                    "_read_process_output",
                    side_effect=RuntimeError("synthetic read failure"),
                ),
            ):
                self.assert_process_error(
                    protected_process.PROTECTED_PROCESS_CLEANUP,
                    lambda: self._run(executable),
                )
            self.assertIsNotNone(read_processes[0].returncode)
        finally:
            directory.chmod(0o700)

        directory, executable = self._script("exit 0\n")
        wait_processes: list[subprocess.Popen[bytes]] = []
        wait_calls = 0

        def wait_start(
            process: subprocess.Popen[bytes],
            argv: tuple[str, ...],
            **kwargs: object,
        ) -> None:
            nonlocal wait_calls
            real_initialize(process, argv, **kwargs)
            real_wait = process.wait

            def failed_once_wait(*args: object, **wait_kwargs: object) -> int:
                nonlocal wait_calls
                wait_calls += 1
                if wait_calls == 1:
                    raise RuntimeError("synthetic wait failure")
                return real_wait(*args, **wait_kwargs)

            process.wait = failed_once_wait  # type: ignore[method-assign]
            wait_processes.append(process)

        try:
            with patch.object(
                protected_process,
                "_initialize_popen",
                side_effect=wait_start,
            ):
                self.assert_process_error(
                    protected_process.PROTECTED_PROCESS_CLEANUP,
                    lambda: self._run(executable),
                )
            self.assertGreaterEqual(wait_calls, 2)
            self.assertIsNotNone(wait_processes[0].returncode)
        finally:
            directory.chmod(0o700)

        directory, executable = self._script("while :; do :; done\n")
        tracked_streams: list[_TrackedStream] = []
        malformed_processes: list[subprocess.Popen[bytes]] = []

        def malformed_start(
            process: subprocess.Popen[bytes],
            argv: tuple[str, ...],
            **kwargs: object,
        ) -> None:
            real_initialize(process, argv, **kwargs)
            assert process.stdout is not None and process.stderr is not None
            bad_stdout = _TrackedStream(
                process.stdout,
                malformed_descriptor=True,
                close_error=RuntimeError("synthetic stdout close failure"),
            )
            tracked_stderr = _TrackedStream(process.stderr)
            tracked_streams.extend((bad_stdout, tracked_stderr))
            process.stdout = bad_stdout  # type: ignore[assignment]
            process.stderr = tracked_stderr  # type: ignore[assignment]
            malformed_processes.append(process)

        try:
            with patch.object(
                protected_process,
                "_initialize_popen",
                side_effect=malformed_start,
            ):
                self.assert_process_error(
                    protected_process.PROTECTED_PROCESS_CLEANUP,
                    lambda: self._run(executable),
                )
            self.assertEqual(
                tuple(stream.close_calls for stream in tracked_streams),
                (1, 1),
            )
            self.assertIsNotNone(malformed_processes[0].returncode)
        finally:
            directory.chmod(0o700)

    def test_error_precedence_is_cleanup_then_timeout_then_output(self) -> None:
        real_selector_factory = protected_process.selectors.DefaultSelector
        directory, executable = self._script("while :; do :; done\n")

        def selector_factory() -> _SelectorProxy:
            return _SelectorProxy(
                real_selector_factory(),
                close_error=RuntimeError("synthetic close failure"),
            )

        try:
            with patch.object(
                protected_process.selectors,
                "DefaultSelector",
                side_effect=selector_factory,
            ):
                self.assert_process_error(
                    protected_process.PROTECTED_PROCESS_CLEANUP,
                    lambda: self._run(executable, timeout_seconds=0.05),
                )
        finally:
            directory.chmod(0o700)

        directory, executable = self._script('printf "12345"\n')
        real_terminate = protected_process._terminate_process_group

        def delayed_terminate(process: object) -> bool:
            time.sleep(0.55)
            return real_terminate(process)  # type: ignore[arg-type]

        try:
            with patch.object(
                protected_process,
                "_terminate_process_group",
                side_effect=delayed_terminate,
            ):
                self.assert_process_error(
                    protected_process.PROTECTED_PROCESS_TIMEOUT,
                    lambda: self._run(
                        executable,
                        timeout_seconds=0.5,
                        stdout_limit=4,
                    ),
                )
        finally:
            directory.chmod(0o700)

    def test_absolute_deadline_terminates_group_and_reaps_leader(self) -> None:
        directory, executable = self._script("while :; do :; done\n")
        with patch.object(
            protected_process,
            "PROCESS_TERMINATE_GRACE_SECONDS",
            0.1,
        ):
            self.assert_process_error(
                protected_process.PROTECTED_PROCESS_TIMEOUT,
                lambda: self._run(executable, timeout_seconds=0.05),
            )
        directory.chmod(0o700)

        directory, executable = self._script(
            "/bin/sleep 30 </dev/null >/dev/null 2>&1 &\n"
            'printf \'%s\' "$!" > "$1"\n'
            "exit 0\n"
        )
        directory.chmod(0o700)
        child_pid_path = directory / "child.pid"
        child_pid_path.write_text("", encoding="ascii")
        child_pid_path.chmod(0o600)
        directory.chmod(0o500)
        child_pid = -1
        try:
            with patch.object(
                protected_process,
                "PROCESS_TERMINATE_GRACE_SECONDS",
                0.1,
            ):
                self.assert_process_error(
                    protected_process.PROTECTED_PROCESS_CLEANUP,
                    lambda: self._run(executable, str(child_pid_path)),
                )
            child_pid = int(child_pid_path.read_text(encoding="ascii"))
            deadline = time.monotonic() + 5.0
            while time.monotonic() < deadline:
                try:
                    os.kill(child_pid, 0)
                except ProcessLookupError:
                    break
                time.sleep(0.01)
            else:
                self.fail(f"same-group child {child_pid} survived group cleanup")
        finally:
            if child_pid > 0:
                try:
                    os.kill(child_pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
            directory.chmod(0o700)

    def test_auxiliary_writer_close_is_single_attempt_owned(self) -> None:
        real_close = os.close
        for same_inode in (True, False):
            with self.subTest(same_inode=same_inode):
                directory, executable = self._script("exit 0\n")
                read_fd, write_fd = os.pipe()
                backup_write_fd = os.dup(write_fd)
                original_inode = os.fstat(write_fd).st_ino
                foreign_path = self.root / f"foreign-{int(same_inode)}.bin"
                foreign_path.write_bytes(b"foreign descriptor fixture")
                write_close_attempts = 0
                foreign_fd = -1

                def ambiguous_close(descriptor: int) -> None:
                    nonlocal write_close_attempts, foreign_fd
                    if descriptor == write_fd:
                        write_close_attempts += 1
                        real_close(descriptor)
                        foreign_fd = (
                            os.dup(backup_write_fd)
                            if same_inode
                            else os.open(foreign_path, os.O_RDONLY)
                        )
                        self.assertEqual(foreign_fd, write_fd)
                        raise OSError("synthetic ambiguous close")
                    real_close(descriptor)

                try:
                    with patch.object(
                        protected_process.os,
                        "close",
                        side_effect=ambiguous_close,
                    ):
                        self.assert_process_error(
                            protected_process.PROTECTED_PROCESS_CLEANUP,
                            lambda: self._run(
                                executable,
                                pass_fds=(write_fd,),
                                auxiliary_read_fd=read_fd,
                                auxiliary_write_fd=write_fd,
                                auxiliary_limit=8,
                            ),
                        )
                    self.assertEqual(write_close_attempts, 1)
                    foreign_inode = os.fstat(foreign_fd).st_ino
                    if same_inode:
                        self.assertEqual(foreign_inode, original_inode)
                    else:
                        self.assertNotEqual(foreign_inode, original_inode)
                finally:
                    directory.chmod(0o700)
                    for descriptor in {
                        read_fd,
                        write_fd,
                        backup_write_fd,
                        foreign_fd,
                    }:
                        if descriptor >= 0:
                            try:
                                real_close(descriptor)
                            except OSError:
                                pass

    def test_auxiliary_descriptors_are_consumed_on_start_rejection(self) -> None:
        for pass_stderr in (False, True):
            with self.subTest(pass_stderr=pass_stderr):
                read_fd, write_fd = os.pipe()
                pass_fds = (2, write_fd) if pass_stderr else (write_fd,)
                try:
                    self.assert_process_error(
                        protected_process.PROTECTED_PROCESS_START,
                        lambda: protected_process.run_protected_process(
                            (str(self.root / "absent-runtime" / "fixture-tool"),),
                            pass_fds=pass_fds,
                            deadline=time.monotonic() + 2.0,
                            stdout_limit=8,
                            stderr_limit=8,
                            auxiliary_read_fd=read_fd,
                            auxiliary_write_fd=write_fd,
                            auxiliary_limit=8,
                        ),
                    )
                    for descriptor in (read_fd, write_fd):
                        with self.assertRaises(OSError):
                            os.fstat(descriptor)
                finally:
                    for descriptor in (read_fd, write_fd):
                        try:
                            os.close(descriptor)
                        except OSError:
                            pass


if __name__ == "__main__":
    unittest.main()
