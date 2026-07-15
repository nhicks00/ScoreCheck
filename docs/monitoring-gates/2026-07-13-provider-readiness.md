# Provider Readiness Gate

Date: 2026-07-13

## Pushover

- ScoreCheck's direct Pushover emergency path is configured.
- The Court 4 raw-ingest gate proved one emergency page, one cancellation/recovery, and no duplicate phone notification.
- Provider health remains healthy with no recorded submission failure.

An intentional provider-only acknowledgement gate opened at
`2026-07-13T13:45:21Z`. Pushover accepted and delivered one emergency at
`13:45:28Z`; the operator did not acknowledge it during the three-minute test
window. The monitor cancelled the emergency and accepted one recovery at
`13:48:28Z`. Twilio remained disabled, no SMS was attempted, and provider
health returned healthy with no active incident. This proves delivery,
repetition, cancellation, recovery, and deduplication again, but it does not
close the acknowledgement acceptance row. Repeat the gate when the operator is
available to tap **Acknowledge**.

## Twilio

- The Twilio account is reachable with the restricted API key.
- The account has exactly one Twilio-owned sender with SMS, MMS, and voice capabilities.
- The restricted API key can create, read, and poll Message resources.
- A single delivery test to the configured operator number reached terminal status `undelivered` with Twilio error `30034`.
- Error `30034` confirms that the U.S. 10DLC sender is not yet associated with an approved A2P campaign. Buying another local number would not bypass that requirement.
- A read-only recheck at `2026-07-15T02:40Z` found one SMS-capable sender and one
  sole-proprietor brand in `APPROVED` state with no registration errors. The
  brand step is no longer the blocker.
- Campaign and sender association remain unverified. The current restricted API
  key can read Message resources but receives `401` for Messaging Service list,
  so campaign verification requires Twilio Console or the narrow service/campaign
  read permissions.
- Production SMS escalation remains disabled. The approved credential set is stored outside the repository in a protected pending file and is not sourced by deployment.

ScoreCheck now uses the restricted API key for message creation and polls only nonterminal Twilio receipts. It no longer exposes a public Twilio status callback or requires the account auth token at runtime. With no pending SMS, this path makes no Twilio requests.

Activation requires a successful live delivery test after A2P approval. Only then should the pending values be promoted into the protected monitoring deployment environment and the escalation/recovery gate be run.

Twilio is not a blocker for the current monitoring release. Pushover is the
required phone channel; SMS remains an optional future escalation path and must
stay disabled until campaign association and actual delivery pass.

## Healthchecks

The Healthchecks Management API currently reports:

| Check | State | Period | Grace | Phone channel |
| --- | --- | --- | --- | --- |
| ScoreCheck monitor baseline | Up | 10 minutes | 3 minutes | Yes, Pushover |
| ScoreCheck active coverage monitor | Paused while idle | 1 minute | 1 minute | Yes, Pushover |

The Healthchecks Pushover subscription is active with high-priority Down events
and normal-priority recovery events. It is assigned to exactly the baseline and
active-coverage checks; the unused legacy check remains email-only. The
Management API independently confirms one `po` channel and both required check
assignments. No test notification was sent during subscription.

## Read-only release preflight: 2026-07-15 02:35Z

The channel-readiness hard-cutover candidate is commit `36f86322`. Its monitoring
suite passed 119 tests, strict typecheck, and build; the web suite passed 432
tests, strict typecheck, lint, and production build; Prometheus 3.13.1 accepted
all 46 rules and their fixtures. Desktop and 390-pixel mobile dashboard checks
had no console errors or horizontal overflow.

Production remained unchanged during this preflight. The observability health
endpoint was healthy and monitor-service was still running revision `fe661e9b`
with restart count zero. The protected environment has both ping URLs, the API
key, and the active check id; the new explicit baseline check id is not present
yet and must be added during the bounded service cutover.

The candidate audit implementation was then executed locally against the real
Healthchecks Management API using protected credentials and read-only `GET`
requests. It returned a successful provider audit with both attachment booleans
false. An independent sanitized API check agreed: one email channel, zero
Pushover channels, and both check ids valid. No provider, monitoring, media,
routing, browser, output, Supabase, or Vercel state was changed.

After provider subscription, use this order:

1. Add the explicit baseline check id to the protected observability environment
   and back up the prior environment and container provenance.
2. Recreate monitor-service only at the matching candidate revision. Verify
   health, restart count, the new secret-free snapshot field, and both attachment
   metrics before continuing.
3. Deploy the matching Prometheus rules only after both attachment metrics are
   `1`, then require 46/46 rules healthy and zero new alerts.
4. Deploy the matching web build and verify desktop and mobile Watchdog labels
   show `Idle protected` or `Coverage protected` as appropriate.
5. Run the controlled withheld-ping delivery gate separately; do not combine it
   with the configuration cutover.

## Bounded release evidence: 2026-07-15

The attachment audit and Pushover-only phone-readiness cutover are live.
Monitor-service started at `2026-07-15T03:35:05Z` on exact revision
`ce73f7d520f013fb3506691887bd3881179a36d1`; container
`4c7b97603b81` is healthy with restart count zero. Prometheus, Alertmanager,
Caddy, and node-exporter retained their pre-cutover container ids and restart
count zero. Production Prometheus reports 46 rules, zero unhealthy rules, and
zero active alerts; Alertmanager has zero alerts.

The secret-free live snapshot confirms six of six agents fresh, notifications
healthy, direct Pushover configured with no recorded failure, Twilio disabled,
the baseline Healthchecks check running, the active-coverage check idle-paused,
and the Pushover channel attached to both checks. There are no active incidents
or fault gates. Camera 1 is publishing raw video with positive bitrate and zero
frame errors; all overview reader counts are zero.

The operator dashboard release is production Vercel deployment
`dpl_4D91tZi4ThRWCU8xbjJ4H5Cu1zwD`, created at
`2026-07-15T04:16:44Z` from sealed source commit
`ed239f527e3c48da8aeb8d43a555a0bc5643ca9e`. The deployment is `READY` and
serves both production aliases. Its local authenticated desktop/mobile smoke
used the live read-only monitor API and showed no horizontal overflow, console
error, or idle stream reader. A fresh authenticated production visual pass is
still pending because the current local admin artifact is stale and Vercel does
not export the encrypted production credential.

No test Pushover page was sent during this release. The controlled
withheld-ping down/recovery gate remains a separate operator-visible test.

## Current decision

- Keep direct Pushover enabled.
- Keep Twilio disabled and optional until A2P delivery succeeds.
- Keep baseline Healthchecks running and active-coverage Healthchecks paused while all courts are off.
- Keep the deployed attachment audit healthy before running the withheld-ping phone gate.
- Keep the Pushover acknowledgement gate open until a delivered emergency is acknowledged during the controlled window.
