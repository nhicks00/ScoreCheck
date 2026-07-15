# Phase 2 one-court c-4 capacity gate

Date: 2026-07-14 CDT / 2026-07-15 UTC

## Sealed result

The first 30-minute end-to-end run is **INCONCLUSIVE/FAIL**, not a capacity
qualification.

- Egress `EG_4zbJNPRcxdc7` ran from `00:15:43.478Z` through the final
  synchronized endpoint at `00:49:37Z`.
- Observed Court 1 output passed: one active Egress, healthy raw/preview/program
  paths, approximately 30 fps, no FFmpeg drops, no browser drops/freezes/RTP
  loss/reconnects/reloads, healthy unlisted YouTube output, no resource threshold
  breach, and no peer-court readers.
- Formal host evidence covered only `259 / 361` expected official-window samples
  (`71.745%`, below the required `80%`). The sequential SSH loop produced a
  median 7-second and p95/max 8-second cadence instead of 5 seconds.
- The compositor zero-zombie gate failed. A persistent `cat` child appeared at
  Egress launch, and a transient second `runc` zombie was observed at the
  endpoint before it was reaped.
- Preview speed was absent in FFmpeg progress, program speed was intermittently
  absent in monitoring, and the all-zero browser-drop counter had no labeled
  Prometheus series. These are telemetry-contract failures, not evidence of
  degraded media.
- Native Egress admission oscillated while one job was active. No duplicate job
  was requested or observed, but the one-job contract was not deterministic.
- The 3 GB Egress shared-memory mount remained unused because Chrome launched
  with `--disable-dev-shm-usage`.

The protected local artifacts are under
`~/.config/scorecheck/capacity/court1-c4-20260715T001521Z/`. The canonical
pre-hardening report is a four-check `FAIL`: two missing speed checks, missing
zero browser-drop samples, and observed compositor zombie growth of two.

## Root causes

1. `/usr/bin/google-chrome` is a Bash wrapper that redirects stdout/stderr
   through process-substitution `cat` children and then execs Chrome. One child
   received SIGPIPE and remained a zombie under the live Chrome parent.
2. LiveKit enables `--disable-dev-shm-usage` by default, bypassing the configured
   container tmpfs.
3. FFmpeg may omit `speed=` while still advancing output timestamps normally.
4. Counter export skipped zero increments, so a healthy all-zero labeled series
   did not exist.
5. The host sampler waited for two sequential SSH probes and then slept five
   seconds, adding probe duration to every interval.
6. Native `can_accept_request` did not consistently reflect the configured
   single-web-request ceiling.

## Hard-cutover response

- Mount a direct `headless_shell` launcher that execs the real Chrome binary and
  never creates wrapper `cat` children.
- Remove LiveKit's shared-memory bypass flag and require launch-time proof that
  Chrome uses the configured tmpfs.
- Export native-or-derived FFmpeg speed plus an explicit availability metric.
- Initialize labeled browser quality counters even when their delta is zero.
- Replace manual host CPU/shm calculations with one protected long-lived
  Python sampler/watcher per host, aligned to fixed UTC deadlines without
  repeated SSH or container-exec probes.
- Gate host evidence on count coverage, p95 gap, maximum gap, both window-edge
  gaps, sample lag, nearest pre-start baseline, CPU, and shared memory.
- Scan `/proc` every 50 ms, preserve bounded PID/PPID/command/fingerprint
  lifecycle evidence, abort immediately on a new unclassified zombie, and gate
  exact observer/healthcheck exemptions by duration, count, and rolling rate.
- Derive admission from the native health signal plus active web-request count,
  export the active/maximum counts, and serialize/reject a second operator start
  locally.
- Treat one active request at the configured maximum as healthy processing, not
  an alert. Excess multiplicity is critical; an idle worker unable to admit is
  degraded.

## Cleanup

The unlisted YouTube broadcast was transitioned to complete before stopping the
exact Egress id. By `00:57:37Z`, YouTube was complete/inactive, active Egress
count was zero, the saved id was absent, WHEP and on-demand branches had drained,
Camera 1 raw remained healthy, compositor zombies were zero, and Courts 2-8
remained isolated. No StreamRun change was made.

## Rerun measurement correction

The second formal attempt, scheduled for `01:49:23Z` through `02:19:23Z`, was
aborted as **INADMISSIBLE** at `01:59:27Z`. The five-second host row at
`01:58:05.249Z` reported three ingest zombies while a separate dwell watcher
showed only the known baseline `timeout` child. A 100 ms attribution trace then
proved that repeated SSH and container healthcheck probes were themselves
creating sub-second exit-to-wait children. The output and unlisted destination
were stopped in order and idle teardown was verified before further work.

This is a measurement correction, not a relaxed zombie threshold. The revised
harness removes repeated SSH/PAM and `docker exec` sampling entirely. Each host
uses one long-lived Python process for aligned CPU/shared-memory samples and
continuous 50 ms `/proc` evidence. New unclassified processes still fail
immediately. Exact healthcheck runtime children remain bounded by a two-second
duration limit, a 16-per-minute rate, and a 480-event 30-minute ceiling.

Idle calibration under
`~/.config/scorecheck/capacity/zombie-calibration-20260715T024229Z/` passed a
130-second interior window with `27/27` valid rows, exact five-second cadence,
maximum sample lag below 50 ms, maximum scan gap below 53 ms, no new
unclassified process, and two exact approximately 50 ms healthcheck runtime
events. The one permitted ingest baseline is locked to `timeout` under
`mediamtx` plus its current cgroup fingerprint; any baseline drift fails.

The first launch under that corrected observer produced a distinct process
event at `02:57:50.511Z`: direct Chrome briefly left a `chrome` child in `Z`
state under another Chrome process. The sampler durably recorded the lineage
and aborted immediately, before YouTube transitioned live. The exact Egress
was stopped and the attempt was discarded. A sandbox-preserving
`single-process` calibration repeated the same event because sandboxed Chrome
still requires its zygote; the candidate was reverted. Disabling the browser
sandbox solely to avoid a transient process state is rejected. The gate must
retain raw lifecycle evidence and fail persistent or accumulating workload
zombies without treating every bounded parent wait interval as a resource
leak. The corrected contract recognizes only a `chrome` child of `chrome`
whose ancestry and cgroup both resolve to the Egress container. That lifecycle
must close within 500 ms, remain single-concurrent, and occur no more than 16
times total or eight times per rolling minute. Every other new workload process remains
unclassified and still aborts the sampler immediately.

The first bounded lifecycle calibration also exposed a harness cleanup error:
the fail-closed path used `SIGKILL` on its SSH transport, and a later watcher
observed an `sshd` child under `systemd`. Failure shutdown now requests a
graceful remote watcher exit and reserves `SIGKILL` for a one-second timeout.
That observer artifact remains preserved in the rejected calibration evidence;
it is not reclassified as workload behavior. The existing observer contract now
recognizes only `sshd` children under `sshd` or `systemd`; their lifecycle is
still bounded by the observer duration, total-count, rolling-rate, and closure
checks.

The five-minute rate calibration then found seven Egress Chrome waits: one at
launch and a six-event program-startup burst, all closed within 103 ms and with
no further event after `03:15:30Z`. Media remained healthy after warmup. The
calibration's terminal Ctrl-C reached an SSH child before the parent marked it
intentional, so signal handling now marks and stops both watchers synchronously.
Formal 30-minute runs use a bounded 35-minute sampler and do not rely on
terminal interruption.

## Required rerun

This gate can pass only after deployment provenance is verified and a new full
30-minute run proves all evaluator checks, including at least 80% host-sample
coverage, bounded gaps and lag, the exact process baseline, zero new
unclassified zombies, bounded/reaped healthcheck children, real shared-memory
use, continuously available speed telemetry, a present all-zero browser-drop
series, and deterministic single-job admission.
