# Event Infrastructure Lifecycle Canary

Date: 2026-07-15

Classification: **PASS for provider lifecycle mechanics and protected cold-start
rendering; the destructive zero-to-12-to-zero live rehearsal and eight-court
production capacity remain unqualified.**

## Bound release

- Git ref: `codex/turnkey-event-lifecycle`
- Git SHA: `9998992c63f0e4a169d685036aad76356d5dfe47`
- Canary run: `20260715t1957`
- Evidence schema: `3`
- Evidence digest:
  `23b3173e43ace91c56b084cf269865bfdc09e5b8248123afac6831cdf855bf1d`
- The provider canary started alongside the seven legacy/test Droplets with no
  Reserved IPv4s or lifecycle-canary snapshots. Those seven machines are not a
  required rollback tier and are not part of the target recurring topology.

The signed attestation and complete provider evidence remain in protected
operator storage. Provider account identifiers, addresses, credentials, and
SSH material are intentionally not copied into this repository.

## Passed gates

1. Live size inventory proved a reversible, disk-preserving resize contract:
   `c-4` (4 vCPU, 8 GiB, 50 GiB) to `s-1vcpu-2gb` (1 vCPU, 2 GiB,
   50 GiB).
2. One isolated `c-4` Droplet was created with a unique run tag and endpoint.
3. A temporary Reserved IPv4 was assigned and the exact Vercel DNS record
   converged on the authoritative nameservers, system resolver, Cloudflare,
   and Google without a stale answer.
4. Endpoint identity passed before resize, after resize down, and after resize
   back to `c-4`.
5. Snapshot create and read passed with the dedicated lifecycle token's
   `snapshot:read` and `snapshot:delete` scopes.
6. The original exact Droplet was destroyed and a different Droplet was
   reconstructed from the snapshot.
7. The same Reserved IPv4 and hostname identified the replacement instance.
8. The replacement, DNS record, Reserved IPv4, snapshot, and tag were deleted.
9. Independent post-run inventory proved all seven baseline Droplets remained
   and no run-owned provider artifact remained.

The full run completed at `2026-07-15T20:10:02.896Z`. DigitalOcean's
post-unassign Reserved IPv4 release returned its transient HTTP 422 state for
about five minutes. The bounded retry path waited for exact HTTP 404 absence
and completed without manual cleanup. This delay is provider behavior worth
budgeting into teardown; it was not hidden or treated as immediate deletion.

## Cold-start reconstruction contract

The recurring event topology is **zero event Droplets -> exactly 12 event
Droplets -> zero event Droplets**. It is not seven plus 12, and it does not
require 19 simultaneously running Droplets.

The 12-host manifest is fixed and fail closed:

- one commentary host;
- one observability host;
- one ingest host;
- eight one-court compositor hosts; and
- one warm compositor spare.

An account Droplet limit of at least 12 is sufficient for this exact topology.
A higher approved limit is only unused ceiling and does not create or bill
additional Droplets. The manifest, not the account ceiling, controls actual
resource creation.

The versioned reconstruction path now requires a protected production recovery
source. It contains the stable camera publisher identities, eight YouTube stream
keys, commentary binding, program-page token, monitoring application bindings,
and the private camera WireGuard server configuration. The production bundle
renders all 12 host environments from that source and refuses to proceed when
the source is missing, incomplete, weakly permissioned, contains Twilio
residue, or fails its integrity marker.

The current protected source is:

- `/Users/nathanhicks/.config/scorecheck/event-stack/production-recovery-source-v1`
- source digest:
  `bf310efa73f27215d8e11e104e21ada21cb27d61f37c9d274a6955508d839d55`

The source is deliberately outside Git because it contains credentials. The
source code remains on the pushed Git branch; credentials remain in mode-0600
operator storage.

An offline cold-start preflight passed from an explicit zero-Droplet baseline:

- exactly 12 manifest resources;
- exactly 17 rendered protected runtime files;
- all eight camera and output identities present;
- no Twilio configuration;
- production WireGuard configuration included; and
- complete cleanup back to zero in the fake-provider lifecycle.

The lifecycle simulator also passed definite partial-create resume,
ambiguous-create reconciliation, DNS failure retry without Droplet recreation,
live-destruction blocking, and failed pre-live build cleanup.

## Persistent non-Droplet state

Deleting event Droplets is the billing boundary, but it must not mean deleting
the entire provider account. The following low/no-compute control-plane state is
intentionally persistent:

- the DigitalOcean VPC and account SSH public-key registration;
- two stable Reserved IPv4 endpoint anchors for ingest and commentary;
- Vercel DNS and the web deployment;
- Supabase durable application and incident data;
- YouTube channel/stream identities;
- Pushover and Healthchecks configuration;
- the protected production recovery source and provider credentials; and
- the venue router, Speedify account, camera settings, and WireGuard peer.

The two SFO2 Reserved IPv4 anchors were allocated on 2026-07-15. On 2026-07-16
they were attached to the exact existing ingest and commentary Droplet IDs,
`preview`, `rtc`, and `turn` converged through authoritative and recursive DNS,
and the venue-router peer was rebound to the stable ingest address. A protected
router sysupgrade backup and transaction-specific router rollback directory are
retained. The fail-closed rules, Speedify route, fresh WireGuard handshake, and
singleton watchdog all passed after cutover. The seven legacy/test Droplets can
now be treated as disposable only at the separately approved destructive drill
boundary.

The DigitalOcean API independently reported an active account, a Droplet limit
of 15, seven active Droplets, and eight free slots at
2026-07-16T00:23:41.529Z. The exact 12-host manifest passed capacity preflight:
the five missing compositor slots fit without changing any current server.
Increasing the ceiling did not create a Droplet or start billing for unused
slots.

An encrypted off-device recovery archive was created and restore-tested at
2026-07-16T00:34:23Z. It contains the complete protected event-stack directory
and lifecycle SSH identity: 113 files, 122,999 encrypted bytes, SHA-256
`8f235f6f991952f6dd797c5af0b792b77d598b268d97d25ef6712986b7c2f43e`.
The Google Drive copy was downloaded independently and matched the local byte
count and digest. A decrypted temporary restore passed the production-source
integrity verifier and contained the provider credential, endpoint binding, and
SSH identity. The recovery key is held separately in iCloud Drive and the local
login Keychain; it is not stored with the encrypted Google Drive archive.

The persistent DigitalOcean network contract was reconciled at
2026-07-16T00:45Z. The three existing service firewalls were changed from the
legacy observability private-IP source to the stable `bvm-observability` tag,
and the missing observability firewall was created. A protected copy of the
three pre-cutover provider firewall objects was captured first. Post-cutover
verification found all four contracts healthy, all seven existing servers
reachable on SSH, the monitor collector healthy with six of six agents fresh,
Camera 1 raw ready with zero frame errors, and no active event, incident, fault
gate, or Egress.

The generated production drill bundle is durably planned with zero event
Droplets. Its real provider-backed `status` command now passes and reports a
healthy network contract. A discovered status defect was hard-cut over so the
planned and provisioning phases validate exact partial inventory, ready/live/
closed require all 12 resources, cleanup permits only recorded survivors, and
terminal phases prove provider inventory is empty. The complete 188-test event
lifecycle suite and all five provider-free failure simulations pass.

## Remaining live gate

The one-Droplet canary proves provider permissions, DNS and stable-address
behavior, reversible resizing, reconstruction, and exact cleanup. The offline
preflight proves the code and protected material can produce the complete
12-host input set without reading an old Droplet. Neither qualifies the live
eight-output media system.

Before destructive rehearsal:

1. capture and rebind the venue-router WireGuard peer to the retained ingest
   anchor;
2. confirm no event, coverage, soak, output, or camera publisher is active; and
3. obtain explicit operator approval to remove the seven legacy/test Droplets.

The reconstruction commit, protected backup, endpoint anchors, and account
quota prerequisites are complete. At the latest read-only monitoring sample
there was no event, incident, fault gate, or Egress, but Camera 1 was still
publishing raw video. That publisher must be stopped and verified absent before
the destructive boundary. The venue router was unreachable from the operator
network, so its client-side configuration was not guessed or changed.

The full rehearsal must then start with zero event Droplets, create exactly 12,
run eight synthetic camera publishers and eight program outputs through the
30-minute soak, capture evidence, and return to zero. Do not call the system
production-ready until that live cold-start rehearsal passes with zero owned
provider artifacts remaining.
