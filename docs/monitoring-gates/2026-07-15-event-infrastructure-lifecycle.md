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

The Reserved IPv4 anchors do not exist yet. They must be allocated and the
venue-router peer must be rebound to the stable ingest address before the seven
legacy/test Droplets can be treated as safely disposable. The router-side
WireGuard private configuration must also be captured during the next on-site
router access window. The server-side configuration is already sealed.

## Remaining live gate

The one-Droplet canary proves provider permissions, DNS and stable-address
behavior, reversible resizing, reconstruction, and exact cleanup. The offline
preflight proves the code and protected material can produce the complete
12-host input set without reading an old Droplet. Neither qualifies the live
eight-output media system.

Before destructive rehearsal:

1. push the reconstruction hardening commit;
2. allocate and record the two endpoint anchors;
3. create an encrypted off-device copy of the protected recovery source;
4. confirm the account limit is at least 12;
5. confirm no event, coverage, or soak is active; and
6. obtain explicit operator approval to remove the seven legacy/test Droplets.

The full rehearsal must then start with zero event Droplets, create exactly 12,
run eight synthetic camera publishers and eight program outputs through the
30-minute soak, capture evidence, and return to zero. Do not call the system
production-ready until that live cold-start rehearsal passes with zero owned
provider artifacts remaining.
