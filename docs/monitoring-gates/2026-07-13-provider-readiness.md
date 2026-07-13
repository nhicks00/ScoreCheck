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
- Production SMS escalation remains disabled. The approved credential set is stored outside the repository in a protected pending file and is not sourced by deployment.

ScoreCheck now uses the restricted API key for message creation and polls only nonterminal Twilio receipts. It no longer exposes a public Twilio status callback or requires the account auth token at runtime. With no pending SMS, this path makes no Twilio requests.

Activation requires a successful live delivery test after A2P approval. Only then should the pending values be promoted into the protected monitoring deployment environment and the escalation/recovery gate be run.

## Healthchecks

The Healthchecks Management API currently reports:

| Check | State | Period | Grace | Phone channel |
| --- | --- | --- | --- | --- |
| ScoreCheck monitor baseline | Up | 10 minutes | 3 minutes | No |
| ScoreCheck active coverage monitor | Paused while idle | 1 minute | 1 minute | No |

Both checks are assigned to the project's single email integration. The API can list and assign integrations but cannot create a Pushover subscription. Healthchecks requires an authenticated UI subscription, and the available automation browser is not signed in.

To unblock the independent phone dead-man gate, sign in to Healthchecks.io in the in-app browser, add the Pushover integration with Emergency priority, and leave that page open for Codex. Codex can then verify and assign the new channel to both checks through the API before running the controlled withheld-ping test.

## Current decision

- Keep direct Pushover enabled.
- Keep Twilio disabled until A2P delivery succeeds.
- Keep baseline Healthchecks running and active-coverage Healthchecks paused while all courts are off.
- Do not run the withheld-ping phone gate until Healthchecks has an independent phone channel.
- Keep the Pushover acknowledgement gate open until a delivered emergency is acknowledged during the controlled window.
