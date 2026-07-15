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
- Replace manual host CPU/shm calculations with a protected CSV sampler that
  probes both hosts concurrently against fixed deadlines.
- Gate host evidence on count coverage, p95 gap, maximum gap, both window-edge
  gaps, nearest pre-start baseline, CPU, shared memory, and sampled zombie
  growth. Retain independent zombie-growth attestation for sub-interval events.
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

## Required rerun

This gate can pass only after deployment provenance is verified and a new full
30-minute run proves all evaluator checks, including at least 80% host-sample
coverage, bounded gaps, zero sampled and independently observed zombie growth,
real shared-memory use, continuously available speed telemetry, a present
all-zero browser-drop series, and deterministic single-job admission.
