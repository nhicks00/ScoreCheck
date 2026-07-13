# Court 4 Raw-Ingest Fault Gate

Date: 2026-07-13
Result: Passed after one monitor-model correction and one audit-event correction

## Scope and safety

- Court 4 only; its source was raw-only with no program or YouTube output.
- The outage was produced by disconnecting only the live `court4_raw` SRT session through the MediaMTX control API.
- Router policy, Speedify, conntrack, MediaMTX configuration, other courts, and public outputs were unchanged.
- The source remained configured as SRT push, H.265/AAC, 1920x1080 and reconnected without operator changes.
- Start and restoration were announced to the thread supervising the concurrent camera soak.

## Preflight correction

The first arm at approximately `2026-07-13T12:56:33Z` exposed an expectation-model defect before any source interruption. A generic media-required expectation incorrectly made preview and program branches required during a raw-ingest-only test. The gate was disarmed within about two seconds, before an alert could become pending or notify.

The correlator was corrected so a fault gate requires only `RAW_INGEST`; preview, program, browser, commentary, scoring, egress, and YouTube continue to follow production expectations. A regression fixture now proves that raw can be critical while derived branches remain `EXPECTED_OFF` or `NOT_APPLICABLE`.

## Executed gate

| Observation | UTC time |
| --- | --- |
| Fault gate armed | `2026-07-13T12:59:26.707Z` |
| Court 4 disconnect loop began | `2026-07-13T13:00:06.233Z` |
| Critical incident condition began | `2026-07-13T13:00:35.709Z` |
| Monitor persisted `OPENED` | `2026-07-13T13:00:40.725Z` |
| Pushover accepted and delivered the open page | `2026-07-13T13:00:41Z` |
| Disconnect loop ended | `2026-07-13T13:00:42.010Z` |
| Alertmanager condition resolved | `2026-07-13T13:00:45.709Z` |
| Monitor persisted `RESOLVED` | `2026-07-13T13:00:48.483Z` |
| Pushover emergency cancelled and recovery accepted | `2026-07-13T13:00:48.949Z` |
| Court 4 bitrate stabilized above 1.6 Mbps | approximately `2026-07-13T13:00:50Z` |
| Recovery-ramp low-bitrate warning cleared | approximately `2026-07-13T13:01:16Z` |
| Court 4 fully healthy and stable | approximately `2026-07-13T13:01:24Z` |

The critical issue was `REQUIRED_RAW_PATH_MISSING`. The notification summary was explicitly prefixed `[INTENTIONAL FAULT GATE]`. A transient warning-level `RAW_BITRATE_LOW` incident correctly captured the zero-rate period and reconnect ramp without paging.

## Isolation and recovery evidence

- Court 4 was the only raw path that became unready. The other seven raw paths remained ready throughout.
- Six of six monitoring agents remained fresh.
- The active dead-man changed from paused to running while the gate was armed, then returned to paused after disarm; the baseline dead-man remained running.
- One Pushover open notification and one recovery notification were submitted. No SMS path was configured or invoked.
- After disarm, the monitor reported no active incidents, no armed gate, all eight raw paths ready, and Court 4 healthy.
- The post-fix production snapshot at `2026-07-13T13:09:44.686Z` reported Court 4 at about 3.2 Mbps with its original codec, resolution, and source mode.

## Duplicate-resolution correction

The provider notification ledger was already deduplicated, but the gate evidence exposed two durable `RESOLVED` audit events for the same critical incident. Alertmanager can legitimately repeat a resolved webhook, and `IncidentManager.applyWebhook` had not treated an already-resolved incident as a no-op.

The manager now ignores repeated resolved webhooks. Verification included:

- 19 monitoring test files and 76 tests passed.
- Monitoring typecheck and build passed.
- 37 Prometheus rules and their executable fixtures passed remotely.
- 14 Alertmanager inhibition fixtures passed remotely.
- A production warning-level synthetic acceptance event returned accepted transition counts `1, 1, 0` for firing, first resolved, and repeated resolved webhooks.
- Supabase durably recorded exactly one `OPENED` event and one `RESOLVED` event for that acceptance incident.
- The synthetic warning did not call Pushover and left no active incident.

## Gate conclusion

The Court 4 raw-ingest loss gate passes. The monitor detected the required-path outage, isolated it to the correct court and stage, delivered one actionable phone page, recovered automatically with the source, preserved peer-court health, and resumed the correct idle monitoring posture. The two implementation defects found by the gate are covered by regression tests and production acceptance evidence.
