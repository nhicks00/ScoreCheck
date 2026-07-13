"""Secure bounded execution of a separately trusted local executable.

The runner accepts only an absolute executable path whose immediate parent and
final path component revalidate as mode-0500 directory and regular file.  It
starts a new session with a fixed environment, no shell, and an exact inherited
descriptor set, then drains every output channel under one absolute deadline.

This module controls the launched process group, not arbitrary descendants. The
caller must separately hash-trust the executable and establish that it is
non-daemonizing: it must not escape the launched group with ``setsid``,
``setpgid``, or an equivalent mechanism. Subject to that contract, the runner
terminates same-group processes, reaps the direct leader, and verifies that the
group disappears.

Process initialization runs on a supervised worker thread. The worker inherits
the caller's original signal mask, so the executable inherits that same mask.
Caller-thread exceptions raised while initialization is in flight are deferred
until the worker publishes child ownership and terminates; cleanup then precedes
propagation. Default-action process termination, adversarial asynchronous
injection into the worker, and interpreter tracing that throws inside CPython's
private ``_fork_exec`` before it returns the child PID are outside this
in-process cleanup contract. Covering those cases requires a platform-specific
spawn supervisor outside the caller process.

When an auxiliary pipe is supplied, ownership of both numeric descriptors
transfers to :func:`run_protected_process`, including structurally invalid calls.
This lets callers clear their copies before entry and avoids unsafe close retries
if a descriptor number is concurrently reused after an ambiguous close failure.
"""

from __future__ import annotations

import math
import os
import selectors
import signal
import stat
import subprocess
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import BinaryIO


PROTECTED_PROCESS_START = "PROTECTED_PROCESS_START"
PROTECTED_PROCESS_CLEANUP = "PROTECTED_PROCESS_CLEANUP"
PROTECTED_PROCESS_TIMEOUT = "PROTECTED_PROCESS_TIMEOUT"
PROTECTED_PROCESS_OUTPUT_LIMIT = "PROTECTED_PROCESS_OUTPUT_LIMIT"

PROTECTED_PROCESS_ERROR_CODES = frozenset(
    {
        PROTECTED_PROCESS_START,
        PROTECTED_PROCESS_CLEANUP,
        PROTECTED_PROCESS_TIMEOUT,
        PROTECTED_PROCESS_OUTPUT_LIMIT,
    }
)

PROCESS_TERMINATE_GRACE_SECONDS = 1.0

_READ_CHUNK_BYTES = 64 * 1024
_SELECT_POLL_SECONDS = 0.05
_FIXED_ENV = {
    "AV_LOG_FORCE_NOCOLOR": "1",
    "HOME": "/nonexistent",
    "LANG": "C",
    "LC_ALL": "C",
    "NO_COLOR": "1",
    "PATH": "/nonexistent",
    "TMPDIR": "/nonexistent",
    "TZ": "UTC",
}
_PINNED_POPEN_CLASS = subprocess.Popen
_POPEN_WORKER_NAME = "vision-scoring-protected-popen"


class ProtectedProcessError(ValueError):
    """A fail-closed protected-process error with a stable finite code."""

    def __init__(self, code: str, message: str) -> None:
        if code not in PROTECTED_PROCESS_ERROR_CODES:
            raise ValueError("protected-process error code is not recognized")
        self.code = code
        super().__init__(message)


@dataclass(frozen=True, slots=True)
class ProtectedProcessResult:
    returncode: int
    stdout: bytes
    stderr: bytes
    auxiliary: bytes


@dataclass(slots=True)
class _DrainState:
    file: BinaryIO | None
    descriptor: int
    maximum_bytes: int
    data: bytearray
    total_bytes: int = 0
    overflowed: bool = False
    closed: bool = False

    def consume(self, chunk: bytes) -> None:
        self.total_bytes += len(chunk)
        remaining = self.maximum_bytes - len(self.data)
        if remaining > 0:
            self.data.extend(chunk[:remaining])
        if self.total_bytes > self.maximum_bytes:
            self.overflowed = True

    def close(self) -> bool:
        if self.closed:
            return True
        self.closed = True
        try:
            if self.file is not None:
                self.file.close()
            else:
                os.close(self.descriptor)
            return True
        except BaseException:
            return False


def _fail(code: str, message: str) -> None:
    raise ProtectedProcessError(code, message)


def _process_group_exists(group_id: int) -> bool:
    try:
        os.killpg(group_id, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def _terminate_process_group(process: subprocess.Popen[bytes]) -> bool:
    """Attempt TERM, KILL, leader reap, and final group disappearance."""

    cleanup_ok = True
    group_id: int | None = None
    try:
        candidate = process.pid
        if type(candidate) is not int or candidate <= 0:
            raise ValueError("process pid is not an exact positive int")
        group_id = candidate
    except BaseException:
        cleanup_ok = False

    # Poll first to reap an already-exited leader on platforms where an
    # unreaped session leader can make group probes ambiguous.  A failure does
    # not prevent either signal or the later blocking reap attempt.
    try:
        process.poll()
    except BaseException:
        cleanup_ok = False

    if group_id is not None:
        try:
            os.killpg(group_id, signal.SIGTERM)
        except ProcessLookupError:
            pass
        except OSError:
            # Signal delivery can race a just-exited Darwin session leader;
            # final group disappearance is authoritative.
            pass
        except BaseException:
            cleanup_ok = False
    else:
        try:
            process.terminate()
        except ProcessLookupError:
            pass
        except BaseException:
            cleanup_ok = False

    try:
        grace_deadline = time.monotonic() + PROCESS_TERMINATE_GRACE_SECONDS
    except BaseException:
        cleanup_ok = False
        grace_deadline = 0.0
    while group_id is not None:
        try:
            if time.monotonic() >= grace_deadline:
                break
            process.poll()
            if not _process_group_exists(group_id):
                break
            time.sleep(0.01)
        except BaseException:
            cleanup_ok = False
            break

    if group_id is not None:
        try:
            os.killpg(group_id, signal.SIGKILL)
        except ProcessLookupError:
            pass
        except OSError:
            pass
        except BaseException:
            cleanup_ok = False
    else:
        try:
            process.kill()
        except ProcessLookupError:
            pass
        except BaseException:
            cleanup_ok = False

    try:
        process.wait(timeout=PROCESS_TERMINATE_GRACE_SECONDS)
    except BaseException:
        cleanup_ok = False

    if group_id is None:
        return False
    try:
        disappearance_deadline = time.monotonic() + PROCESS_TERMINATE_GRACE_SECONDS
    except BaseException:
        return False
    while True:
        try:
            if not _process_group_exists(group_id):
                return cleanup_ok
            if time.monotonic() >= disappearance_deadline:
                return False
            time.sleep(0.01)
        except BaseException:
            return False


def _close_drain(
    selector: selectors.BaseSelector,
    state: _DrainState,
) -> bool:
    if state.closed:
        return True
    try:
        selector.unregister(state.descriptor)
    except BaseException:
        unregister_ok = False
    else:
        unregister_ok = True
    return state.close() and unregister_ok


def _read_process_output(descriptor: int) -> bytes:
    """Single read indirection for adversarial lifecycle tests."""

    return os.read(descriptor, _READ_CHUNK_BYTES)


def _initialize_popen(
    process: subprocess.Popen[bytes],
    argv: tuple[str, ...],
    **kwargs: object,
) -> None:
    """Narrow initialization seam retaining the preallocated exact instance."""

    _PINNED_POPEN_CLASS.__init__(process, argv, **kwargs)


def _popen_child_created(process: subprocess.Popen[bytes]) -> bool:
    try:
        return object.__getattribute__(process, "_child_created") is True
    except BaseException:
        return False


@dataclass(slots=True)
class _PopenInitializationOutcome:
    published: threading.Event
    candidate: subprocess.Popen[bytes] | None = None
    error: BaseException | None = None


def _initialize_popen_worker(
    outcome: _PopenInitializationOutcome,
    argv: tuple[str, ...],
    *,
    pass_fds: tuple[int, ...],
    cwd: str,
) -> None:
    """Initialize and publish one candidate from the supervised worker."""

    candidate = object.__new__(_PINNED_POPEN_CLASS)
    # Make destruction safe if initialization fails before Popen establishes
    # its own pre-child state.
    object.__setattr__(candidate, "_child_created", False)
    error: BaseException | None = None
    try:
        _initialize_popen(
            candidate,
            argv,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            shell=False,
            close_fds=True,
            pass_fds=pass_fds,
            start_new_session=True,
            cwd=cwd,
            env=dict(_FIXED_ENV),
        )
    except BaseException as exc:
        error = exc
    outcome.candidate = candidate
    outcome.error = error
    outcome.published.set()


def _wait_for_popen_publication(event: threading.Event, timeout: float) -> bool:
    """Narrow caller-wait seam for lifecycle fault tests."""

    return event.wait(timeout)


def _join_popen_worker(worker: threading.Thread, timeout: float) -> None:
    """Narrow caller-join seam for lifecycle fault tests."""

    worker.join(timeout)


def _defer_first_exception(
    current: BaseException | None,
    candidate: BaseException,
) -> BaseException:
    return candidate if current is None else current


def run_protected_process(
    argv: tuple[str, ...],
    *,
    pass_fds: tuple[int, ...],
    deadline: float,
    stdout_limit: int,
    stderr_limit: int,
    auxiliary_read_fd: int = -1,
    auxiliary_write_fd: int = -1,
    auxiliary_limit: int = 0,
) -> ProtectedProcessResult:
    """Run one revalidated executable with bounded output and cleanup.

    The deadline is an absolute monotonic-clock value shared by process
    execution, output draining, and final success validation. Supplying the
    optional auxiliary channel transfers ownership of both descriptors to this
    function, even when validation fails.

    The executable must already be hash-trusted and non-daemonizing. Containment
    covers only its launched process group; a program that calls setsid, setpgid,
    or otherwise escapes that group is outside this contract. The separately
    trusted local runtime and operating-system Popen initialization are also
    required to publish a start outcome in bounded time. Once initialization
    begins, the caller waits past the execution deadline if necessary to learn
    child ownership; abandoning an in-flight spawn would make cleanup ambiguous.
    A CPython Popen initializer that never returns cannot be terminated safely
    in-process and is outside this pinned-runtime assumption. The deadline is
    still recorded while the caller waits, but it is not a wall-time guarantee
    against that explicitly excluded stuck-initializer failure.
    """

    process: subprocess.Popen[bytes] | None = None
    process_stdout: BinaryIO | None = None
    process_stderr: BinaryIO | None = None
    selector: selectors.BaseSelector | None = None
    states: list[_DrainState] = []
    owned_auxiliary_read_fd = (
        auxiliary_read_fd
        if type(auxiliary_read_fd) is int and auxiliary_read_fd >= 0
        else -1
    )
    owned_auxiliary_write_fd = (
        auxiliary_write_fd
        if type(auxiliary_write_fd) is int and auxiliary_write_fd >= 0
        else -1
    )
    parent_write_closed = owned_auxiliary_write_fd < 0
    popen_outcome: _PopenInitializationOutcome | None = None
    popen_worker: threading.Thread | None = None
    popen_worker_started = False
    pending: BaseException | None = None
    cleanup_ok = True
    process_waited = False
    timed_out = False
    overflowed = False
    returncode: int | None = None
    stdout = b""
    stderr = b""
    auxiliary = b""
    try:
        # Auxiliary descriptor ownership is established before validating the
        # rest of the invocation so every rejection path consumes it exactly.
        has_auxiliary = owned_auxiliary_read_fd >= 0 and owned_auxiliary_write_fd >= 0
        if (
            type(argv) is not tuple
            or not argv
            or any(type(item) is not str or "\x00" in item for item in argv)
            or not Path(argv[0]).is_absolute()
            or type(pass_fds) is not tuple
            or any(type(item) is not int or item < 3 for item in pass_fds)
            or len(set(pass_fds)) != len(pass_fds)
            or type(deadline) is not float
            or not math.isfinite(deadline)
            or deadline <= 0.0
            or type(stdout_limit) is not int
            or stdout_limit < 1
            or type(stderr_limit) is not int
            or stderr_limit < 1
            or type(auxiliary_read_fd) is not int
            or type(auxiliary_write_fd) is not int
            or auxiliary_read_fd < -1
            or auxiliary_write_fd < -1
            or (auxiliary_read_fd >= 0) != (auxiliary_write_fd >= 0)
            or type(auxiliary_limit) is not int
            or (has_auxiliary and auxiliary_limit < 1)
            or (not has_auxiliary and auxiliary_limit != 0)
            or (
                has_auxiliary
                and (
                    auxiliary_read_fd < 3
                    or auxiliary_write_fd < 3
                    or auxiliary_read_fd == auxiliary_write_fd
                    or auxiliary_read_fd in pass_fds
                    or auxiliary_write_fd not in pass_fds
                )
            )
        ):
            _fail(PROTECTED_PROCESS_START, "process invocation is not exact")
        if deadline <= time.monotonic():
            _fail(
                PROTECTED_PROCESS_TIMEOUT,
                "protected process deadline already expired",
            )

        selector = selectors.DefaultSelector()
        executable = Path(argv[0])
        cwd = executable.parent
        try:
            cwd_value = cwd.lstat()
            executable_value = executable.lstat()
        except OSError as exc:
            raise ProtectedProcessError(
                PROTECTED_PROCESS_START,
                "revalidated process paths are unavailable",
            ) from exc
        if (
            not stat.S_ISDIR(cwd_value.st_mode)
            or stat.S_IMODE(cwd_value.st_mode) != 0o500
            or not stat.S_ISREG(executable_value.st_mode)
            or stat.S_IMODE(executable_value.st_mode) != 0o500
        ):
            _fail(
                PROTECTED_PROCESS_START,
                "process cwd or executable mode is unsafe",
            )
        popen_outcome = _PopenInitializationOutcome(published=threading.Event())
        popen_worker = threading.Thread(
            target=_initialize_popen_worker,
            args=(popen_outcome, argv),
            kwargs={"pass_fds": pass_fds, "cwd": str(cwd)},
            name=_POPEN_WORKER_NAME,
            daemon=False,
        )
        deferred_caller_error: BaseException | None = None
        try:
            popen_worker.start()
            popen_worker_started = True
        except BaseException as exc:
            # A caller-thread exception after Thread.start launched the worker
            # must not abandon a candidate that can still create a child. A
            # normal start failure before publication has no worker to join.
            deferred_caller_error = exc
            if popen_worker.ident is None and not popen_outcome.published.is_set():
                raise
            popen_worker_started = True

        while not popen_outcome.published.is_set():
            try:
                _wait_for_popen_publication(
                    popen_outcome.published,
                    _SELECT_POLL_SECONDS,
                )
                if time.monotonic() >= deadline:
                    timed_out = True
            except BaseException as exc:
                deferred_caller_error = _defer_first_exception(
                    deferred_caller_error,
                    exc,
                )

        while popen_worker.is_alive():
            try:
                _join_popen_worker(popen_worker, _SELECT_POLL_SECONDS)
                if time.monotonic() >= deadline:
                    timed_out = True
            except BaseException as exc:
                deferred_caller_error = _defer_first_exception(
                    deferred_caller_error,
                    exc,
                )

        candidate = popen_outcome.candidate
        initialization_error = popen_outcome.error
        if candidate is None:
            raise ValueError("Popen worker did not publish a candidate")
        if _popen_child_created(candidate):
            process = candidate
            try:
                process_stdout = candidate.stdout
            except BaseException:
                cleanup_ok = False
            try:
                process_stderr = candidate.stderr
            except BaseException:
                cleanup_ok = False
            if process_stdout is None or process_stderr is None:
                cleanup_ok = False
        elif initialization_error is None:
            initialization_error = ValueError(
                "Popen initialization returned without a child"
            )

        if deferred_caller_error is not None:
            raise deferred_caller_error
        if initialization_error is not None:
            if isinstance(initialization_error, (OSError, ValueError)):
                raise ProtectedProcessError(
                    PROTECTED_PROCESS_START,
                    "protected process could not start",
                ) from initialization_error
            raise initialization_error
        if process is None:
            raise ValueError("Popen child ownership was not published")

        process_stdout = process.stdout
        process_stderr = process.stderr
        if process_stdout is None or process_stderr is None:
            raise ValueError("protected process returned malformed output streams")
        stdout_descriptor = process_stdout.fileno()
        stderr_descriptor = process_stderr.fileno()
        if (
            type(stdout_descriptor) is not int
            or stdout_descriptor < 0
            or type(stderr_descriptor) is not int
            or stderr_descriptor < 0
            or stdout_descriptor == stderr_descriptor
        ):
            raise ValueError("protected process returned malformed stream descriptors")

        if auxiliary_write_fd >= 0:
            # This numeric descriptor is consumed by this one close attempt. A
            # close failure is ambiguous and must never be retried.
            parent_write_closed = True
            try:
                os.close(auxiliary_write_fd)
            except BaseException as exc:
                raise ProtectedProcessError(
                    PROTECTED_PROCESS_CLEANUP,
                    "parent auxiliary writer could not be closed",
                ) from exc

        states = [
            _DrainState(
                file=process_stdout,
                descriptor=stdout_descriptor,
                maximum_bytes=stdout_limit,
                data=bytearray(),
            ),
            _DrainState(
                file=process_stderr,
                descriptor=stderr_descriptor,
                maximum_bytes=stderr_limit,
                data=bytearray(),
            ),
        ]
        if auxiliary_read_fd >= 0:
            states.append(
                _DrainState(
                    file=None,
                    descriptor=auxiliary_read_fd,
                    maximum_bytes=auxiliary_limit,
                    data=bytearray(),
                )
            )
        for state in states:
            os.set_blocking(state.descriptor, False)
            selector.register(state.descriptor, selectors.EVENT_READ, state)

        while True:
            poll_result = process.poll()
            if poll_result is not None and type(poll_result) is not int:
                raise ValueError("protected process poll result is malformed")
            if (
                not any(not state.closed for state in states)
                and poll_result is not None
            ):
                break
            remaining = deadline - time.monotonic()
            if remaining <= 0.0:
                timed_out = True
                break
            events = selector.select(timeout=min(_SELECT_POLL_SECONDS, remaining))
            for key, _ in events:
                state = key.data
                if type(state) is not _DrainState:
                    raise ValueError("selector returned malformed drain state")
                try:
                    chunk = _read_process_output(state.descriptor)
                except BlockingIOError:
                    continue
                except OSError:
                    cleanup_ok = False
                    if not _close_drain(selector, state):
                        cleanup_ok = False
                    continue
                if type(chunk) is not bytes or len(chunk) > _READ_CHUNK_BYTES:
                    raise ValueError("process output read returned malformed bytes")
                if not chunk:
                    if not _close_drain(selector, state):
                        cleanup_ok = False
                    continue
                state.consume(chunk)
                if state.overflowed:
                    overflowed = True
            if overflowed:
                break

        if not timed_out and not overflowed and cleanup_ok:
            try:
                wait_result = process.wait(
                    timeout=max(0.0, deadline - time.monotonic())
                )
            except subprocess.TimeoutExpired:
                timed_out = True
            else:
                if type(wait_result) is not int:
                    raise ValueError("protected process wait result is malformed")
                process_waited = True
                returncode = wait_result

        stdout = bytes(states[0].data)
        stderr = bytes(states[1].data)
        auxiliary = bytes(states[2].data) if len(states) == 3 else b""
    except BaseException as exc:
        pending = exc

    # A caller exception can arrive after worker publication but before the
    # ordinary path stores the candidate in ``process``. Re-converge on the
    # worker outcome here so no launched child can escape centralized cleanup.
    if popen_worker_started and popen_worker is not None and popen_outcome is not None:
        while True:
            try:
                if popen_outcome.published.is_set():
                    break
                _wait_for_popen_publication(
                    popen_outcome.published,
                    _SELECT_POLL_SECONDS,
                )
                if time.monotonic() >= deadline:
                    timed_out = True
            except BaseException as exc:
                pending = _defer_first_exception(pending, exc)
        while True:
            try:
                if not popen_worker.is_alive():
                    break
                _join_popen_worker(popen_worker, _SELECT_POLL_SECONDS)
                if time.monotonic() >= deadline:
                    timed_out = True
            except BaseException as exc:
                pending = _defer_first_exception(pending, exc)
        if process is None:
            while True:
                try:
                    candidate = popen_outcome.candidate
                    child_created = candidate is not None and _popen_child_created(
                        candidate
                    )
                except BaseException as exc:
                    pending = _defer_first_exception(pending, exc)
                    continue
                if child_created:
                    assert candidate is not None
                    process = candidate
                    try:
                        process_stdout = candidate.stdout
                    except BaseException as exc:
                        pending = _defer_first_exception(pending, exc)
                        cleanup_ok = False
                    try:
                        process_stderr = candidate.stderr
                    except BaseException as exc:
                        pending = _defer_first_exception(pending, exc)
                        cleanup_ok = False
                    if process_stdout is None or process_stderr is None:
                        cleanup_ok = False
                break

    # All exits after Popen converge here. Every cleanup action is attempted;
    # no cleanup exception may prevent later descriptor or process cleanup.
    if process is not None:
        terminate_group = (
            pending is not None
            or timed_out
            or overflowed
            or not cleanup_ok
            or not process_waited
        )
        if not terminate_group:
            try:
                group_id = process.pid
                if type(group_id) is not int or group_id <= 0:
                    raise ValueError("process pid is not an exact positive int")
                group_exists = _process_group_exists(group_id)
            except BaseException:
                cleanup_ok = False
                terminate_group = True
            else:
                if group_exists:
                    # Same-group children violate the non-daemonizing pinned-tool
                    # contract and are terminated before returning a cleanup error.
                    cleanup_ok = False
                    terminate_group = True
        if terminate_group:
            try:
                terminated = _terminate_process_group(process)
            except BaseException:
                terminated = False
            if not terminated:
                cleanup_ok = False

    for state in states:
        try:
            state_closed = (
                _close_drain(selector, state) if selector is not None else state.close()
            )
        except BaseException:
            state_closed = False
        if not state_closed:
            cleanup_ok = False

    represented_streams = [state.file for state in states if state.file is not None]
    attempted_streams: list[BinaryIO] = []
    for stream in (process_stdout, process_stderr):
        if (
            stream is None
            or any(stream is represented for represented in represented_streams)
            or any(stream is attempted for attempted in attempted_streams)
        ):
            continue
        attempted_streams.append(stream)
        try:
            stream.close()
        except BaseException:
            cleanup_ok = False

    if not parent_write_closed and owned_auxiliary_write_fd >= 0:
        parent_write_closed = True
        try:
            os.close(owned_auxiliary_write_fd)
        except BaseException:
            cleanup_ok = False
    auxiliary_read_represented = any(
        state.descriptor == owned_auxiliary_read_fd for state in states
    )
    if (
        owned_auxiliary_read_fd >= 0
        and not auxiliary_read_represented
        and not (
            owned_auxiliary_read_fd == owned_auxiliary_write_fd and parent_write_closed
        )
    ):
        try:
            os.close(owned_auxiliary_read_fd)
        except BaseException:
            cleanup_ok = False

    if selector is not None:
        try:
            selector.close()
        except BaseException:
            cleanup_ok = False

    if not cleanup_ok:
        raise ProtectedProcessError(
            PROTECTED_PROCESS_CLEANUP,
            "process descriptors or process group did not clean up",
        ) from pending

    if pending is not None:
        if isinstance(pending, ProtectedProcessError):
            if pending.code == PROTECTED_PROCESS_TIMEOUT:
                timed_out = True
            elif pending.code == PROTECTED_PROCESS_OUTPUT_LIMIT:
                overflowed = True
            else:
                raise pending
        elif isinstance(pending, (KeyboardInterrupt, SystemExit)):
            raise pending
        else:
            raise ProtectedProcessError(
                PROTECTED_PROCESS_CLEANUP,
                "process invocation or lifecycle failed unexpectedly",
            ) from pending

    # Cleanup time belongs to the same absolute budget. This final check also
    # gives the required precedence CLEANUP > TIMEOUT > OUTPUT_LIMIT.
    try:
        if time.monotonic() >= deadline:
            timed_out = True
    except (KeyboardInterrupt, SystemExit):
        raise
    except BaseException as exc:
        raise ProtectedProcessError(
            PROTECTED_PROCESS_CLEANUP,
            "final process deadline validation failed",
        ) from exc

    if timed_out:
        _fail(
            PROTECTED_PROCESS_TIMEOUT,
            "protected process exceeded its absolute deadline",
        )
    if overflowed:
        _fail(
            PROTECTED_PROCESS_OUTPUT_LIMIT,
            "protected process exceeded a fixed output bound",
        )
    if returncode is None:
        _fail(PROTECTED_PROCESS_CLEANUP, "process did not produce an exit status")
    return ProtectedProcessResult(
        returncode=returncode,
        stdout=stdout,
        stderr=stderr,
        auxiliary=auxiliary,
    )
