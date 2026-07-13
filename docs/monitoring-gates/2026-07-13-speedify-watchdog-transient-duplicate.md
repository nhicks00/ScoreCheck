# Speedify Watchdog Transient Duplicate

Date: 2026-07-13
Status: transient duplicate observed; no routing or output drift; root cause unresolved

## Observation

At approximately `19:28Z`, a direct exact-command process listing briefly
showed two `/bin/sh /usr/sbin/scorecheck-speedify-routing watch` processes,
PIDs 24292 and 28201. Five seconds later only the long-lived PID 24292 remained,
and `procd` reported its single managed instance running.

This was not the earlier `pgrep` self-observation error because the direct
listing emitted two distinct exact command lines. It was also not sustained
duplication: the second process exited before the recheck without an operator
action.

## Impact and assessment

No route, policy-rule, firewall, fail-closed state, publisher identity, or
stream drift coincided with the duplicate. Media paths, Egress, and YouTube
remained healthy. The event should therefore be treated as a transient
supervision anomaly requiring root-cause review, not as evidence that two
watchdogs were continuously reconciling routing.

Post-soak review should correlate `procd` lifecycle logs, watchdog start and
exit timestamps, and any shell-wrapper retry path around the event. The
acceptance criterion remains one managed watchdog process in steady state,
with duplicate-start prevention and no fail-open interval during restart.

## 19:59Z recurrence

The anomaly recurred at `19:59Z`. Exact process listing simultaneously showed
PIDs 10904, 10957, and the long-lived 24292 running
`/bin/sh /usr/sbin/scorecheck-speedify-routing watch`. After 32 seconds, only
PID 24292 remained. This establishes recurrence and rules out classifying the
earlier event as an isolated observation artifact.

No routing or firewall drift accompanied the recurrence. Speedify remained
connected; primary and guard rules were both present 2/2; tables 900 and 901
were correct; UDP and TCP camera-route lookups used `connectify0` through table
900; five camera conntrack flows remained present; ordinary WAN traffic stayed
direct; and the kill switch remained active. No stats process was running.
Router available memory remained approximately 169-171 MB.

The system self-converged without an observed fail-open interval, but recurring
transient duplicate starts are still a supervision defect. Root-cause review
must determine whether `procd`, a shell retry path, or concurrent watchdog
invocations can overlap and must add an atomic single-instance guard rather
than relying on eventual process exit.
