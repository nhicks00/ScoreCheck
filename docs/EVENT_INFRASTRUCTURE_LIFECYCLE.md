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

DigitalOcean's API prices at `2026-07-16T01:21Z` make this exact manifest
`$1.3125/hour`: one `s-2vcpu-2gb` at `$0.02679/hour`, one `s-2vcpu-4gb` at
`$0.03571/hour`, and ten `c-4` hosts at `$0.125/hour` each. That is about
`$63.02` for 48 hours or `$94.54` for 72 hours. The `$882/month` sum is only the
monthly equivalent if all 12 Droplets are left allocated continuously; it is
not the normal event cost. Provider credit and unused account quota do not
create a Droplet or a charge. Reserved IPv4, bandwidth, snapshot, tax, or other
provider charges remain separate.

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

The full rehearsal uses the real recurring lifecycle: retire the seven legacy
test servers only after the protected recovery and endpoint prerequisites pass,
then prove zero event Droplets -> exactly 12 rehearsal Droplets -> zero event
Droplets. It does not build 12 servers beside the legacy seven and therefore
does not require a limit of 19. The account limit was verified as **15** on
2026-07-15, which fits the exact 12-host manifest and leaves three unused slots.
The manifest, not the account ceiling, controls what is created.

Do not delete a legacy server merely to free quota. The destructive boundary
still requires no active event, coverage, soak, output, or camera publisher;
complete protected recovery material and endpoint anchors; sealed pre-cutover
evidence; and explicit operator confirmation.

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

The initial hard cutover completed on 2026-07-16 while all camera publishers
were stopped. Both anchors are attached to the exact existing ingest and
commentary Droplets, the three public records have converged, and the venue
router WireGuard peer now targets the retained ingest anchor. The protected
provider/DNS transaction and router backup remain the rollback evidence. A
future rebuild reassigns those same anchors; it does not introduce a new camera
or commentator endpoint.

The retained records use a 60-second TTL. DNS readiness requires the exact
Vercel control-plane record plus every authoritative Vercel nameserver, the
system resolver, Cloudflare 1.1.1.1, and Google Public DNS to return the
intended value. Recursive queries are deferred until the authoritative servers
agree, preventing the lifecycle's own first query from caching a transient
wildcard answer. The lifecycle waits for up to
40 minutes because a previously cached wildcard answer can legitimately
outlive a newly created exact record by roughly 30 minutes. It will not
overwrite multiple records, a non-A record, or a record whose provider
identity changed after the lifecycle first touched it.

While idle, `preview`, `rtc`, and `turn` may still resolve to their unassigned
Reserved IPv4s. This is deliberate: they accept no event traffic but never drift
to an unrelated new Droplet. The monitoring record is restored to its exact
pre-event record.

A rehearsal never uses those production names or permanent anchors. It gets a
deterministic event namespace and unique Droplet provider names. The ingest
endpoint is namespace-unique; commentary and observability use the stable
`rtc-rehearsal`, `turn-rehearsal`, and `monitor-rehearsal` names so their Caddy
certificate state can be reused safely across disposable stacks. All four names
still point directly to rehearsal Droplets and are removed and proved absent at
teardown. Rehearsal allocates no Reserved IPv4, so an interrupted test cannot
leak an unnamed address. Any pre-existing rehearsal hostname is treated as an
ownership collision rather than adopted.

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
- **DNS can retain an older wildcard answer.** The build records stale resolver
   answers and waits for Vercel authoritative DNS, the system resolver,
   Cloudflare, and Google to agree. Run setup at least 45 minutes before cameras may connect; `start`
  remains unavailable until DNS convergence is durably recorded.
- **Reserved IPv4 assignment is asynchronous.** The build waits until the API
  reports the exact destination Droplet ID before accepting DNS.
- **A create response can be lost.** Before each one-time production anchor
  allocation, the manager durably records the complete Reserved-IP inventory.
  On restart it adopts only one unassigned, same-region inventory delta and
  fails closed when the delta is ambiguous. Do not create or delete another
  Reserved IP during this short bootstrap operation.
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

Use the resumable manager once. It writes a protected inventory checkpoint
before each allocation and writes each resolved address immediately afterward.
A lost API response or local interruption is reconciled from that checkpoint;
multiple inventory deltas fail closed:

```bash
node infra/event-stack/manage-endpoint-anchors.mjs create \
  --anchors /absolute/protected/endpoint-anchors.json \
  --credentials-env /absolute/protected/provider.env \
  --region sfo2 \
  --retention persistent \
  --confirm CREATE:PERSISTENT-ENDPOINT-ANCHORS

node infra/event-stack/manage-endpoint-anchors.mjs verify \
  --anchors /absolute/protected/endpoint-anchors.json \
  --credentials-env /absolute/protected/provider.env \
  --region sfo2 \
  --retention persistent
```

There is intentionally no routine delete-anchors command. The anchors are the
stable endpoint contract. Removing them is a separate architecture change, not
ordinary post-event teardown.

The bundle generator writes an empty, protected rehearsal endpoint binding.
That binding proves the rehearsal manifest has no Reserved-IP slots; it does
not call the Reserved-IP API. Rehearsal DNS is disposable and bound to exact
Droplet IDs/public addresses in lifecycle state.

## Protected inputs

Provider credentials are loaded from a mode-`0600` environment file and are
never printed:

```text
DIGITALOCEAN_TOKEN
SCORECHECK_DO_SSH_KEYS
VERCEL_TOKEN
VERCEL_TEAM_ID              # only for a team-owned DNS zone
YOUTUBE_CLIENT_ID           # full rehearsal only
YOUTUBE_CLIENT_SECRET       # full rehearsal only
YOUTUBE_REFRESH_TOKEN       # full rehearsal only
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

As verified against DigitalOcean's custom-scope documentation on 2026-07-15,
select only these scopes for the dedicated lifecycle token:

```text
account:read
actions:read
droplet:read
droplet:create
droplet:update
droplet:delete
firewall:read
firewall:create
firewall:update
image:read
image:create
image:delete
project:read
regions:read
reserved_ip:read
reserved_ip:create
reserved_ip:update
reserved_ip:delete
sizes:read
snapshot:read
snapshot:delete
ssh_key:read
tag:read
tag:create
tag:delete
vpc:read
```

DigitalOcean's token form requires `snapshot:read` and `snapshot:delete` as
dependent scopes when `image:read` and `image:delete` are selected. Keep all
four: the canary lists the created Droplet snapshot through the image API and
must prove that the exact snapshot is absent after teardown.

Do not select Full Access, `api:write`, `droplet:admin`, firewall deletion,
DigitalOcean Monitoring, databases, volumes, domains, or Kubernetes. Event
Droplets set DigitalOcean's optional monitoring-agent flag to false because
ScoreCheck deploys its own browser-independent host agent and never reads the
DigitalOcean Monitoring API. This removes an unused agent, permission, and
provider dependency without reducing ScoreCheck telemetry.

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

Do not copy provider values into chat or hand-merge the event credential file.
Build its exact allowlisted Pushover-only contract from existing protected
sources. When DigitalOcean issues a replacement lifecycle token, place only
that token in a mode-`0600` file and use the override form:

```bash
node infra/event-stack/create-lifecycle-credentials.mjs create \
  --provider-env /absolute/protected/existing-provider.env \
  --monitoring-env /absolute/protected/monitoring.env \
  --digitalocean-token-file /absolute/protected/digitalocean-lifecycle.token \
  --acme-email operations@example.com \
  --output /absolute/protected/provider.env
```

The output contains exactly DigitalOcean, Vercel, YouTube, Pushover, and ACME
contact values.
It intentionally excludes Twilio, Supabase, dashboard passwords, and unrelated
runtime configuration. Existing output is never overwritten.

For routine operation, place the repeated absolute paths in one mode-`0600`
operator profile:

```json
{
  "schemaVersion": 5,
  "manifest": "/absolute/protected/event/manifest.json",
  "state": "/absolute/protected/event/state.json",
  "anchors": "/absolute/protected/endpoint-anchors.json",
  "secrets": "/absolute/protected/event/secrets",
  "sshKey": "/absolute/protected/scorecheck_do",
  "knownHosts": "/absolute/protected/event/known_hosts",
  "commentaryTlsState": "/absolute/protected/retained-commentary-tls/HOSTSET_ID",
  "observabilityTlsState": "/absolute/protected/retained-observability-tls/HOSTSET_ID",
  "credentialsEnv": "/absolute/protected/provider.env",
  "lifecycleAttestation": "/absolute/protected/lifecycle-attestation.json",
  "evidence": "/absolute/protected/event/final-evidence",
  "rehearsalEvidence": null
}
```

The protected provider environment also contains `SCORECHECK_ACME_EMAIL`.
Both TLS state paths are deliberately outside the disposable event bundle. Each
contains the complete role-specific Caddy data directory, a mode-`0600`
integrity manifest, certificate fingerprints, expiry evidence, and the exact
hostname binding. Commentary retains the two commentary hosts; observability
retains the monitor host. The lifecycle refuses a healthy teardown unless both
states verify with at least 24 hours of certificate validity remaining. Caddy
requests ZeroSSL first and uses Let's Encrypt as the fallback issuer, preventing
one CA's per-domain issuance limit from blocking a rebuild.

Then event-day commands are short and consistent:

```bash
node infra/event-stack/eventctl.mjs up --profile /absolute/protected/event/profile.json
node infra/event-stack/eventctl.mjs status --profile /absolute/protected/event/profile.json
node infra/event-stack/eventctl.mjs start --profile /absolute/protected/event/profile.json --confirm START:event-slug
node infra/event-stack/eventctl.mjs close --profile /absolute/protected/event/profile.json --confirm CLOSE:event-slug
node infra/event-stack/eventctl.mjs evidence --profile /absolute/protected/event/profile.json
node infra/event-stack/eventctl.mjs destroy --profile /absolute/protected/event/profile.json --confirm DESTROY:event-slug
node infra/event-stack/eventctl.mjs abort --profile /absolute/protected/event/profile.json --confirm ABORT:event-slug
```

The wrapper invokes Node directly without a shell and never invents a start,
close, destroy, or abort confirmation.

## Protected SSH network contract

The checked-in `network-contract.json` is a template, not a deployable firewall
specification. Its documentation-only admin address is deliberately rejected by
every provider-facing command. Before creating an event bundle, place the
current operator public host CIDR in a mode-`0600` JSON file inside a mode-`0700`
directory:

```json
{
  "schemaVersion": 1,
  "addresses": ["CURRENT_OPERATOR_PUBLIC_IPV4/32"]
}
```

Render a new immutable effective contract without placing the address in Git:

```bash
node infra/event-stack/render-admin-ssh-network.mjs render \
  --admin-cidrs /absolute/protected/network/admin-cidrs.json \
  --output /absolute/protected/network/network-contract.json
```

The renderer accepts only public `/32` or `/128` host CIDRs. SSH reaches the
observability host only from those operator addresses. Ingest, commentary, and
compositor hosts additionally accept SSH from the `bvm-observability` tag so
the observability host is the event bastion. No SSH rule permits a global
source. Provider verification and the separately confirmed apply action both
require this protected rendered file explicitly:

```bash
node infra/event-stack/manage-event-network.mjs verify \
  --credentials-env /absolute/protected/provider.env \
  --network-spec /absolute/protected/network/network-contract.json
```

If the operator address changes, render a new protected output path and verify
it before an apply. Existing event manifests remain immutable evidence of the
contract used for that event.

## Protected bundle

Do not hand-author the manifest and operator profiles. Create one immutable,
mode-`0700` event bundle. Existing credentials, SSH identity, canary attestation,
and production anchors remain outside the event directory and are referenced by
absolute path:

```bash
node infra/event-stack/create-event-bundle.mjs create \
  --event next-event-slug \
  --kind production \
  --destroy-after YYYY-MM-DD \
  --root /absolute/protected/events/next-event-slug \
  --credentials-env /absolute/protected/provider.env \
  --ssh-key /absolute/protected/scorecheck_do \
  --attestation /absolute/protected/lifecycle-attestation.json \
  --network-spec /absolute/protected/network/network-contract.json \
  --anchors /absolute/protected/endpoint-anchors.json \
  --production-source /absolute/protected/production-recovery-source
```

The generator refuses an existing destination, weak input permissions, relative
paths, a nondeployable network template, an incomplete mode-specific
configuration, or an unbound manifest. It embeds the normalized effective
network contract in the immutable manifest, writes the exact next command, and
does not execute it.

This is a hard cutover to event manifest schema v6 and operator profile schema
v5. Any earlier bundle must be regenerated from the protected recovery source
and rendered network contract; lifecycle commands reject it before provider
access.

## Event build

The bundle contains a new immutable manifest for every event. The manifest
binds the exact service spec, compositor pool, network contract, and all
role-specific cloud-init bytes. Validation rejects additions, omissions, court
reassignment, size drift, network drift, or hand-edited digests.

```bash
node infra/event-stack/event-manifest.mjs generate \
  --event next-event-slug \
  --kind production \
  --destroy-after YYYY-MM-DD \
  --output /absolute/protected/next-event-slug/manifest.json \
  --network-spec /absolute/protected/network/network-contract.json

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
  --commentary-tls-state /absolute/protected/retained-commentary-tls/HOSTSET_ID \
  --observability-tls-state /absolute/protected/retained-observability-tls/HOSTSET_ID \
  --credentials-env /absolute/protected/provider.env \
  --attestation /absolute/protected/lifecycle-attestation.json
```

`up` is resumable. It reconciles an ambiguous create only when exactly one
provider resource matches the complete event identity. It never creates a
same-name duplicate merely because a previous API response was lost.

The stack is `ready` only after:

1. The exact 12-resource inventory exists with no extra event-tagged resource.
2. Production has both Reserved IPv4s assigned to the intended exact Droplet
   IDs; rehearsal has no Reserved IP allocation and each scoped endpoint targets
   the exact event-owned Droplet public IPv4.
3. All four public DNS records pass Vercel control-plane and authoritative DNS,
   system resolver, Cloudflare, and Google checks.
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
  --commentary-tls-state /absolute/protected/retained-commentary-tls/HOSTSET_ID \
  --observability-tls-state /absolute/protected/retained-observability-tls/HOSTSET_ID \
  --credentials-env /absolute/protected/provider.env \
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
  --commentary-tls-state /absolute/protected/retained-commentary-tls/HOSTSET_ID \
  --observability-tls-state /absolute/protected/retained-observability-tls/HOSTSET_ID \
  --credentials-env /absolute/protected/provider.env \
  --evidence /absolute/protected/next-event-slug/final-evidence

node infra/event-stack/event-stack.mjs destroy \
  --manifest /absolute/protected/next-event-slug/manifest.json \
  --state /absolute/protected/next-event-slug/state.json \
  --secrets /absolute/protected/event-secrets \
  --ssh-key /absolute/protected/scorecheck_do \
  --known-hosts /absolute/protected/next-event-slug/known_hosts \
  --commentary-tls-state /absolute/protected/retained-commentary-tls/HOSTSET_ID \
  --observability-tls-state /absolute/protected/retained-observability-tls/HOSTSET_ID \
  --credentials-env /absolute/protected/provider.env \
  --evidence /absolute/protected/next-event-slug/final-evidence \
  --confirm DESTROY:next-event-slug
```

Destroy is blocked while coverage is live, before the manifest review date,
without protected evidence, or when provider inventory differs from state. It
stops both Caddy services and atomically refreshes the protected commentary and
observability TLS states before deleting any Droplet. If either healthy service
cannot preserve valid state, teardown fails closed and restarts that Caddy
service; no compute is deleted. The retained directories are local lifecycle
authority, not provider resources, so they create no DigitalOcean idle cost.
Destroy then
deletes 12 verified Droplet IDs one by one; it never issues a tag-wide bulk
delete. It is resumable after a lost delete response or local interruption. It
then deletes each lifecycle tag object only after DigitalOcean proves the tag
owns zero resources. The event-specific tag must be absent before the lifecycle
can become terminal; shared role/kind tags are retained only while another
resource still uses them and are reconsidered on a resumed cleanup. It then
proves production anchors are unassigned, restores dynamic DNS, and sends one
Pushover completion message before declaring the lifecycle destroyed.
Rehearsal teardown instead removes all event DNS and proves that no rehearsal
Reserved IP exists. The ordinary public IPv4s disappear with their exact
Droplets. A failed completion notification leaves teardown in a retryable
`destroying` phase rather than falsely reporting success.

If setup fails or is intentionally cancelled before coverage starts, use the
separate abort action. It inventories only exact event-tagged identities,
captures protected pre-cleanup state, reconciles an ambiguous create, restores
owned DNS, removes exact Droplet IDs, proves the rehearsal namespace and
provider inventory are empty, and records durable completion evidence:

```bash
node infra/event-stack/eventctl.mjs abort \
  --profile /absolute/protected/event/profile.json \
  --confirm ABORT:next-event-slug
```

Abort is unavailable after `start`; live coverage must follow close, evidence,
and destroy. There is no tag-wide resource-deletion command in the repository;
tag metadata is removed individually only after its resource count is zero.

There is no timer deletion. Tournament schedules and post-event soaks move, so
a timer is not authorized to decide that coverage is over.

## Dry run and live canary

The provider-free rehearsal exercises the exact isolated 12-server workflow,
dynamic rehearsal endpoints, retained TLS restoration, live teardown rejection, partial and ambiguous
create resumption, DNS failure recovery, failed-build abort, protected
evidence, exact teardown, and event DNS removal:

```bash
node infra/event-stack/simulate-event-lifecycle.mjs
node --test infra/event-stack/*.test.mjs
```

The live 12-server rehearsal bundle is generated once and contains the exact
runner executable and argument array in `operator.command` and `operator.args`.
It points to the GitHub owner/repository slug,
numeric repository ID, exact tested Git ref and 40-character commit SHA, and the
local executables used to encode the protected synthetic fixtures and perform
LiveKit verification:

```bash
node infra/event-stack/create-event-bundle.mjs create \
  --event next-event-full-rehearsal \
  --kind rehearsal \
  --destroy-after YYYY-MM-DD \
  --root /absolute/protected/events/next-event-full-rehearsal \
  --credentials-env /absolute/protected/provider.env \
  --ssh-key /absolute/protected/scorecheck_do \
  --attestation /absolute/protected/lifecycle-attestation.json \
  --network-spec /absolute/protected/network/network-contract.json \
  --git-repo GITHUB_OWNER/GITHUB_REPOSITORY \
  --git-repo-id NUMERIC_GITHUB_REPOSITORY_ID \
  --git-ref codex/turnkey-event-lifecycle \
  --git-sha 40_CHARACTER_TESTED_COMMIT_SHA \
  --ffmpeg /absolute/path/to/ffmpeg \
  --livekit-cli /absolute/path/to/lk \
  --soak-seconds 1800
```

Execute the exact `operator.command` with the exact `operator.args` written to
the protected bundle's `BUNDLE.json`. Do not transcribe or reconstruct the
invocation. That runner owns plan, prepare, provision, explicit start, 30-minute soak,
ordered output cleanup, evidence sealing, and exact infrastructure teardown. A
failure enters the bounded recovery plan and leaves a protected report; it does
not silently skip cleanup.

During the full rehearsal, the eight 720p30 synthetic source loops run on the
single manifest-owned warm-spare compositor. This does not add a thirteenth
Droplet or alter the production pool shape. The controller encodes fixtures
locally, pulls one digest-pinned MediaMTX FFmpeg image, and stages the fixtures
before host sampling begins. It then starts one exact transient systemd/Docker
unit per camera on the spare, publishes through the public rehearsal ingest
hostname, and fails qualification on any missing source, restart, stale
progress, cadence outside 29-31 fps, non-realtime speed, dropped frame, or
duplicated frame. Source credentials live only in protected mode-0600 files;
they are not placed in service names or process arguments. Source units and
their generation directory are removed before infrastructure teardown.

The synthetic commentator is admitted only after the preview advances and
Chromium's WebRTC statistics prove that the captured microphone source has
nonzero audio energy, captured-sample duration advances continuously, and the
outbound audio RTP packets and bytes increase. The visible microphone meter is
recorded as supporting UI evidence because headless animation scheduling can
lag even while the captured and transmitted audio is healthy. A failed startup
closes Chromium immediately; it never waits on a leaked browser process before
the bounded recovery and provider cleanup can begin.

This source placement removes the operator laptop and venue Wi-Fi from the
DigitalOcean media-capacity result. It does not qualify the venue uplink,
router, Speedify path, or physical cameras. Those remain a separate pre-event
connectivity gate using the actual venue network.

Before provisioning and again after exact teardown, run the independent
provider-zero audit into a new protected mode-0600 evidence file:

```bash
node infra/event-stack/audit-provider-zero.mjs \
  --event next-event-full-rehearsal \
  --credentials-env /absolute/protected/provider.env \
  --anchors /absolute/protected/endpoint-anchors.json \
  --zone beachvolleyballmedia.com \
  --output /absolute/protected/provider-zero-audit.json
```

Admission and teardown are not complete unless this independent inventory
proves an active account with capacity for 12 Droplets, zero Droplets, exactly
two unassigned persistent endpoint Reserved IPv4s, zero ScoreCheck snapshots,
zero event tags, zero rehearsal Vercel projects/DNS, zero volumes when that
least-privilege API is readable, and the exact eight persistent YouTube test
streams idle with no configuration issues.

The isolated live canary uses one unique nonproduction hostname and tag. It does
not use a production endpoint or select an existing Droplet. It performs:

1. Create one `c-4` from bound canary cloud-init.
2. Create and assign one temporary Reserved IPv4.
3. Create unique Vercel DNS; prove authoritative Vercel DNS first, then wait for
   system, Cloudflare, and Google resolver convergence; finally prove HTTP
   instance identity.
4. Prove from live size inventory that `c-4` and `s-1vcpu-2gb` have a
   reversible disk contract, flex-resize down and back, and prove the endpoint
   each time. The canary refuses to create a paid resource if the selected
   target has a smaller disk or is unavailable in `sfo2`. The former `c-2`
   target is intentionally invalid because its 25 GB disk is smaller than the
   `c-4` plan's 50 GB disk.
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
considered safe to delete. Droplet deletion can also race the provider's
asynchronous unassignment action. Exact Reserved-IP release therefore retries
only the provider's transient HTTP 422 state and succeeds only after the same
address returns HTTP 404.

The one-Droplet canary proves provider permissions and replacement mechanics;
it does **not** qualify the 12-server media system. With the verified account
limit of 15, the final dry run is a full isolated rehearsal from a proved zero
event-Droplet baseline: 12 unique rehearsal Droplets, eight synthetic moving
camera publishers, eight preview/program chains, eight one-per-host Egress
jobs, an isolated program-page deployment, eight persistent reusable YouTube
ingest streams, monitoring, commentary connectivity, resource and zombie gates,
exact evidence, ordered output cleanup, and complete infrastructure teardown.
No legacy Droplet is retained as an undocumented rollback dependency.
Production is not approved until this run passes and provider inventory returns
to the exact persistent non-Droplet baseline.

Rehearsal publisher staging uses the same bounded transport policy as host
deployment: SSH and SCP retry at most three times, with short increasing waits,
and only for recognized connection-level failures such as a banner timeout or
connection reset. Authentication, host-key, command, and configuration failures
remain immediate hard failures. This prevents one transient new-Droplet SSH
handshake from discarding an otherwise healthy 12-host build without masking a
real ownership or deployment defect.

Commentary startup evidence is reset-safe across a LiveKit peer-connection
replacement. The browser samples individual outbound-audio RTP and media-source
reports throughout the bounded cadence window and accumulates only positive
deltas for each stable report identity. A removed report is not subtracted and
a new report establishes a fresh baseline. Readiness still requires advancing
preview video, outbound audio packets and bytes, nonzero captured-audio energy,
and at least 75 percent media-sample coverage; meter animation remains supporting
UI evidence rather than the authoritative audio contract.

The rehearsal YouTube contract is an exact persistent pool named `ScoreCheck
Court 1 Test Stream` through `ScoreCheck Court 8 Test Stream`. Every member must
be reusable RTMP, 720p30, idle before admission, unique by provider ID and stream
key, then active/good with no configuration issues during qualification. The
controller never creates or deletes these streams. Fresh unlisted broadcasts,
watch pages, stream binding, recording, and lifecycle transitions are a
separate once-per-tournament control-plane preflight. That preflight should be
completed at least 24 hours before coverage and may use YouTube Studio through
an authenticated operator session when the API is unavailable. A channel daily
creation limit applies to both API and Studio and cannot be bypassed by changing
clients; it must not delay compute teardown or cause rehearsal resource churn.

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
- no event or canary DNS, empty lifecycle tags, addresses, or images;
- exactly two unassigned endpoint Reserved IPv4s, approximately `$10/month`
  total at the current rate.
- exactly eight retained reusable YouTube test ingest streams; they are provider
  control-plane objects, not billable DigitalOcean compute.

Savings come from deleting replaceable event compute, not from reducing
headroom during coverage.

The full 12-server test costs approximately `$1.3125` for each running hour at
the captured rate. Rehearsal endpoints use the ordinary public IPv4 addresses
included with their Droplets and add no Reserved-IP charge. The unique ingest
name and stable rehearsal commentary/monitor names are all deleted during
teardown; only their protected local TLS state remains.
