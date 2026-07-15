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

## Healthchecks

The Healthchecks Management API currently reports:

| Check | State | Period | Grace | Phone channel |
| --- | --- | --- | --- | --- |
| ScoreCheck monitor baseline | Up | 10 minutes | 3 minutes | No |
| ScoreCheck active coverage monitor | Paused while idle | 1 minute | 1 minute | No |

Both checks are assigned to the project's single email integration. The API can
list and assign integrations but cannot create a Pushover subscription.
Healthchecks is authenticated in Safari and the final Pushover subscription page
is staged with emergency down priority, five-minute repeats for up to one day,
and normal recovery priority. The external subscription has not been confirmed,
so no Pushover integration exists in the Healthchecks project yet.

To unblock the independent phone dead-man gate, Nathan must explicitly confirm
the staged Healthchecks-to-Pushover subscription. After it exists, attach that
integration to both checks, verify the new channel-readiness snapshot and
dashboard state, and only then run the controlled withheld-ping test.

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

After explicit subscription confirmation, use this order:

1. Confirm exactly one Healthchecks Pushover channel exists and attach it to
   both the baseline and active checks.
2. Add the explicit baseline check id to the protected observability environment
   and back up the prior environment and container provenance.
3. Recreate monitor-service only at the matching candidate revision. Verify
   health, restart count, the new secret-free snapshot field, and both attachment
   metrics before continuing.
4. Deploy the matching Prometheus rules only after both attachment metrics are
   `1`, then require 46/46 rules healthy and zero new alerts.
5. Deploy the matching web build and verify desktop and mobile Watchdog labels
   show `Idle protected` or `Coverage protected` as appropriate.
6. Run the controlled withheld-ping delivery gate separately; do not combine it
   with the configuration cutover.

## Current decision

- Keep direct Pushover enabled.
- Keep Twilio disabled until A2P delivery succeeds.
- Keep baseline Healthchecks running and active-coverage Healthchecks paused while all courts are off.
- Do not run the withheld-ping phone gate until Healthchecks has an independent phone channel.
- Keep the Pushover acknowledgement gate open until a delivered emergency is acknowledged during the controlled window.
