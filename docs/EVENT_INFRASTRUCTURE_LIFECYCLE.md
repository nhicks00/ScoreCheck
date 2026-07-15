# Event Infrastructure Lifecycle

ScoreCheck media compute is event infrastructure, not permanent infrastructure.
Vercel, Supabase, GitHub, protected configuration, retained evidence, and two
stable endpoint IPv4 addresses persist between events. The 12 DigitalOcean
Droplets are reconstructed before coverage and destroyed only after coverage is
closed and final evidence is complete.

Powering off a Droplet does not end billing. Resizing a Droplet reduces its
hourly rate but retains a billed server and introduces extra state transitions.
The normal idle state is therefore zero event Droplets, not powered-off or
downsized Droplets.

## Production shape

`infra/event-stack/service-pool.json` and
`infra/event-stack/compositor-pool.json` define one exact stack:

| Role | Count | Size | Address behavior |
| --- | ---: | --- | --- |
| Commentary / LiveKit | 1 | `s-2vcpu-2gb` | retained commentary Reserved IPv4 |
| Observability | 1 | `s-2vcpu-4gb` | dynamic public IPv4; DNS restored on teardown |
| MediaMTX / ingest | 1 | `c-4` | retained ingest Reserved IPv4 |
| Camera compositors | 8 | `c-4` | event-specific public/private IPv4s |
| Warm spare compositor | 1 | `c-4` | event-specific public/private IPv4s |
| **Total** | **12** | | |

Each camera has one compositor. The spare is not preassigned to a camera. This
is intentionally more machines than a dense shared-worker layout: one failed or
overloaded compositor cannot take several courts down with it, and one court can
be replaced without moving the others.

The account Droplet limit must be at least 12 when no unrelated Droplets remain.
Before `up` creates anything, the controller computes current account occupancy
plus every missing event resource. A limit of 12 does not fit a fresh 12-server
stack while old test servers still exist. The controller rejects partial
affordability instead of creating the first few servers and then discovering the
account cannot fit the complete stack.

## Stable public endpoints

Two retained DigitalOcean Reserved IPv4s are the endpoint anchors:

| DNS name | Address | Lifecycle |
| --- | --- | --- |
| `preview.beachvolleyballmedia.com` | ingest anchor | reassigned to each event's ingest Droplet |
| `rtc.beachvolleyballmedia.com` | commentary anchor | reassigned to each event's commentary Droplet |
| `turn.beachvolleyballmedia.com` | commentary anchor | same address as `rtc` |
| `monitor.beachvolleyballmedia.com` | dynamic | changed for the event and restored on teardown |

Camera encoders and commentator clients use hostnames, never a newly allocated
Droplet address. Critical hostnames stay unchanged while the underlying Droplet
IDs and ordinary public/private addresses change. Reserved IPv4s can only move
between Droplets in the same DigitalOcean region, so the manifest, anchors, and
all event servers are pinned to `sfo2`.

The retained records use a 60-second TTL. DNS verification requires both the
authoritative Vercel record and a normal resolver to return the intended value.
The lifecycle will not overwrite multiple records, a non-A record, or a record
whose provider identity changed after the lifecycle first touched it.

While idle, `preview`, `rtc`, and `turn` may still resolve to their unassigned
Reserved IPv4s. This is deliberate: they accept no event traffic but never drift
to an unrelated new Droplet. The monitoring record is restored to its exact
pre-event record.

## Address and identity complications

The lifecycle handles these explicitly:

- **Ordinary Droplet addresses change.** Monitoring targets are regenerated
  from the new private IPv4 inventory on every build.
- **SSH host keys change.** Every event has a separate protected `known_hosts`
  file. A new key is captured only for the newly created provider-owned address;
  deployment uses strict host-key checking afterward.
- **IP reuse is possible.** Provider Droplet ID, exact name, region, size,
  image, event tag, role tag, temporary tag, and destruction date must all
  match. An address or name alone never grants deletion authority.
- **DNS can cache briefly.** The build waits for Vercel's record and a resolver;
  event preflight still reserves at least the TTL before accepting traffic.
- **Reserved IPv4 assignment is asynchronous.** The build waits until the API
  reports the exact destination Droplet ID before accepting DNS.
- **Private addresses are not durable.** Prometheus and agent targets are
  generated only after all 12 exact resources exist.
- **Certificates bind to names, not servers.** No certificate or camera setting
  should contain an ephemeral IP.
- **External source-IP allowlists are separate.** A Reserved IPv4 is an inbound
  endpoint contract. Any future provider that allowlists outbound source IPs
  must be tested and pinned separately.
- **Unique state lives outside Droplets.** Stream keys, LiveKit credentials,
  provider tokens, manifests, and evidence remain in protected storage. A
  Droplet is replaceable compute, not a database or secret authority.

## One-time endpoint anchors

Creating two unassigned Reserved IPv4s incurs the only intentional idle
DigitalOcean charge. At the current published rate this is approximately
`$5/month` per unassigned address, or approximately `$10/month` total while the
event stack is absent. Recheck live billing before relying on that estimate.

Use the resumable manager once. It writes each successful allocation immediately
to a mode-`0600` file, so failure during the second allocation cannot orphan the
first:

```bash
node infra/event-stack/manage-endpoint-anchors.mjs create \
  --anchors /absolute/protected/endpoint-anchors.json \
  --credentials-env /absolute/protected/provider.env \
  --region sfo2 \
  --confirm CREATE:ENDPOINT-ANCHORS

node infra/event-stack/manage-endpoint-anchors.mjs verify \
  --anchors /absolute/protected/endpoint-anchors.json \
  --credentials-env /absolute/protected/provider.env \
  --region sfo2
```

There is intentionally no routine delete-anchors command. The anchors are the
stable endpoint contract. Removing them is a separate architecture change, not
ordinary post-event teardown.

## Protected inputs

Provider credentials are loaded from a mode-`0600` environment file and are
never printed:

```text
DIGITALOCEAN_TOKEN
SCORECHECK_DO_SSH_KEYS
VERCEL_TOKEN
VERCEL_TEAM_ID              # only for a team-owned DNS zone
PUSHOVER_APP_TOKEN
PUSHOVER_USER_KEY
```

`DIGITALOCEAN_TOKEN` must be a dedicated lifecycle credential with create,
read, update, and delete access for Droplets and actions, Reserved IPv4s, tags,
and images/snapshots. A token that can create but cannot delete is unsafe: the
build can appear healthy while teardown is impossible. Do not begin an event
or live canary with a read/create-only token. The isolated canary is the final
proof that the configured credential can complete the entire delete path; its
cleanup inventory must pass before that credential is approved for events.
The passing canary writes a mode-`0600` lifecycle attestation valid for 30
days. It is HMAC-bound to the exact DigitalOcean token, Vercel token/team,
DigitalOcean account UUID, configured DigitalOcean SSH key IDs, and local SSH
private key. Production `up` verifies that attestation before it writes event
state or calls a mutating provider API. Replacing or narrowing any credential,
changing SSH identity, changing the Vercel team, or letting the attestation
expire requires another complete canary. Status, evidence, and teardown do not
depend on the attestation, so the safety gate can never prevent recovery.

The local deployment secrets directory is mode `0700`; every file in it is mode
`0600`:

```text
commentary.env
ingest.env
observability.env
agent-tokens.json
compositors/bvm-compositor-a.env
...
compositors/bvm-compositor-h.env
compositors/bvm-compositor-spare.env
```

`agent-tokens.json` contains exactly one bounded token for every resource in the
manifest. Missing, extra, short, or ambiguous token ownership fails preflight.

For routine operation, place the repeated absolute paths in one mode-`0600`
operator profile:

```json
{
  "schemaVersion": 2,
  "manifest": "/absolute/protected/event/manifest.json",
  "state": "/absolute/protected/event/state.json",
  "anchors": "/absolute/protected/endpoint-anchors.json",
  "secrets": "/absolute/protected/event/secrets",
  "sshKey": "/absolute/protected/scorecheck_do",
  "knownHosts": "/absolute/protected/event/known_hosts",
  "credentialsEnv": "/absolute/protected/provider.env",
  "lifecycleAttestation": "/absolute/protected/lifecycle-attestation.json",
  "evidence": "/absolute/protected/event/final-evidence"
}
```

Then event-day commands are short and consistent:

```bash
node infra/event-stack/eventctl.mjs up --profile /absolute/protected/event/profile.json
node infra/event-stack/eventctl.mjs status --profile /absolute/protected/event/profile.json
node infra/event-stack/eventctl.mjs start --profile /absolute/protected/event/profile.json --confirm START:event-slug
node infra/event-stack/eventctl.mjs close --profile /absolute/protected/event/profile.json --confirm CLOSE:event-slug
node infra/event-stack/eventctl.mjs evidence --profile /absolute/protected/event/profile.json
node infra/event-stack/eventctl.mjs destroy --profile /absolute/protected/event/profile.json --confirm DESTROY:event-slug
```

The wrapper invokes Node directly without a shell and never invents a start,
close, or destroy confirmation.

## Event build

Generate a new immutable manifest for every event. The generator binds the
exact service spec, compositor pool, and all role-specific cloud-init bytes. It
writes mode `0600`, refuses to overwrite, and rejects additions, omissions,
court reassignment, size drift, or hand-edited digests.

```bash
node infra/event-stack/event-manifest.mjs generate \
  --event next-event-slug \
  --destroy-after YYYY-MM-DD \
  --output /absolute/protected/next-event-slug/manifest.json

node infra/event-stack/event-manifest.mjs validate \
  --manifest /absolute/protected/next-event-slug/manifest.json
```

Create protected event state and SSH trust, then build the stack:

```bash
node infra/event-stack/event-stack.mjs plan \
  --manifest /absolute/protected/next-event-slug/manifest.json \
  --state /absolute/protected/next-event-slug/state.json

node infra/event-stack/event-stack.mjs up \
  --manifest /absolute/protected/next-event-slug/manifest.json \
  --state /absolute/protected/next-event-slug/state.json \
  --anchors /absolute/protected/endpoint-anchors.json \
  --secrets /absolute/protected/event-secrets \
  --ssh-key /absolute/protected/scorecheck_do \
  --known-hosts /absolute/protected/next-event-slug/known_hosts \
  --credentials-env /absolute/protected/provider.env \
  --attestation /absolute/protected/lifecycle-attestation.json
```

`up` is resumable. It reconciles an ambiguous create only when exactly one
provider resource matches the complete event identity. It never creates a
same-name duplicate merely because a previous API response was lost.

The stack is `ready` only after:

1. The exact 12-resource inventory exists with no extra event-tagged resource.
2. Both Reserved IPv4s target the intended exact Droplet IDs.
3. All four public DNS records pass provider and resolver checks.
4. Commentary, ingest, eight compositors, spare, and observability are deployed
   from the bound repository revision.
5. All 12 read-only monitoring agents are reachable on generated private IPs.
6. Public commentary and monitor TLS health checks pass.
7. Pushover accepts the plain-English readiness notification.

Do not connect cameras or begin destinations before `ready`.

## Coverage and teardown

Coverage requires a separate exact operator action and fresh aggregate health:

```bash
node infra/event-stack/event-stack.mjs start \
  --manifest /absolute/protected/next-event-slug/manifest.json \
  --state /absolute/protected/next-event-slug/state.json \
  --secrets /absolute/protected/event-secrets \
  --ssh-key /absolute/protected/scorecheck_do \
  --known-hosts /absolute/protected/next-event-slug/known_hosts \
  --confirm START:next-event-slug
```

After the final destination is complete and coverage is explicitly over:

```bash
node infra/event-stack/event-stack.mjs close \
  --manifest /absolute/protected/next-event-slug/manifest.json \
  --state /absolute/protected/next-event-slug/state.json \
  --confirm CLOSE:next-event-slug

node infra/event-stack/event-stack.mjs evidence \
  --manifest /absolute/protected/next-event-slug/manifest.json \
  --state /absolute/protected/next-event-slug/state.json \
  --secrets /absolute/protected/event-secrets \
  --ssh-key /absolute/protected/scorecheck_do \
  --known-hosts /absolute/protected/next-event-slug/known_hosts \
  --credentials-env /absolute/protected/provider.env \
  --evidence /absolute/protected/next-event-slug/final-evidence

node infra/event-stack/event-stack.mjs destroy \
  --manifest /absolute/protected/next-event-slug/manifest.json \
  --state /absolute/protected/next-event-slug/state.json \
  --credentials-env /absolute/protected/provider.env \
  --evidence /absolute/protected/next-event-slug/final-evidence \
  --confirm DESTROY:next-event-slug
```

Destroy is blocked while coverage is live, before the manifest review date,
without protected evidence, or when provider inventory differs from state. It
deletes 12 verified Droplet IDs one by one; it never issues a tag-wide bulk
delete. It then proves both anchors are unassigned, restores dynamic DNS, and
sends one Pushover completion message.

There is no timer deletion. Tournament schedules and post-event soaks move, so
a timer is not authorized to decide that coverage is over.

## Dry run and live canary

The provider-free rehearsal exercises the exact 12-server workflow, stable
critical addresses, live teardown rejection, partial and ambiguous create
resumption, DNS failure recovery, evidence, and exact teardown:

```bash
node infra/event-stack/simulate-event-lifecycle.mjs
node --test infra/event-stack/*.test.mjs
```

The isolated live canary uses one unique nonproduction hostname and tag. It does
not use a production endpoint or select an existing Droplet. It performs:

1. Create one `c-4` from bound canary cloud-init.
2. Create and assign one temporary Reserved IPv4.
3. Create unique Vercel DNS and prove HTTP instance identity.
4. Flex-resize to `c-2`, then back to `c-4`, proving the endpoint each time.
5. Sanitize and snapshot the server.
6. Destroy the original exact provider ID.
7. Recreate from the snapshot with a new provider ID.
8. Reassign the same temporary address without changing the hostname.
9. Prove the endpoint identifies the replacement.
10. Remove replacement, DNS, snapshot, temporary address, and tag.
11. Prove every baseline Droplet ID remains and no canary artifact remains.

```bash
node infra/event-stack/run-lifecycle-canary.mjs run \
  --run-id 20260715a \
  --evidence /absolute/protected/canary-20260715a.json \
  --attestation /absolute/protected/lifecycle-attestation.json \
  --credentials-env /absolute/protected/provider.env \
  --ssh-key /absolute/protected/scorecheck_do \
  --known-hosts /absolute/protected/canary-20260715a.known_hosts \
  --confirm RUN:LIFECYCLE-CANARY
```

A failed test must still complete exact cleanup and remains classified `FAIL`.
Only a clean `PASS` with all four endpoint/resize checks and every exact cleanup
check can issue the lifecycle attestation. The certificate contains only
one-way credential/file digests and provider identity; it never contains a
provider token or SSH private key.
If the process is interrupted, rerun with the same run ID/evidence path or use
the `cleanup` subcommand with the same arguments.

DigitalOcean may return an attached Reserved IPv4 while its assignment or
detachment is still locked. Both the assignment and deletion paths wait for the
exact address to report `locked=false`; an unassigned-but-locked address is not
considered safe to delete.

## Cost model

As captured on 2026-07-15, the full 12-Droplet shape is approximately `$1.3125`
per running hour:

| Running window | Approximate compute |
| --- | ---: |
| 24 hours | $31.50 |
| 72 hours | $94.50 |
| 30-day maximum equivalent | $882.00 |

DigitalOcean bills Droplets per second with a monthly cap. Recheck live prices,
available sizes, account limits, snapshots, volumes, Reserved IPv4s, and any
other retained resources before each event. The canary snapshot is temporary
and deleted; the versioned build recipe is the normal source of truth.

The expected between-event DigitalOcean state is:

- zero event Droplets;
- zero event snapshots and volumes;
- no canary DNS, tags, addresses, or images;
- exactly two unassigned endpoint Reserved IPv4s, approximately `$10/month`
  total at the current rate.

Savings come from deleting replaceable event compute, not from reducing
headroom during coverage.
