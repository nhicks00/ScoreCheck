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

## Dual-role ingest recovery

The existing warm compositor spare can temporarily become the ingest host. This
is an operator-confirmed recovery transaction, not an automatic failover and
not a thirteenth Droplet. Preparation copies the retained ingest TLS state and
stages stopped MediaMTX and WireGuard roles while the spare compositor remains
idle and healthy. Preparation does not move the Reserved IPv4, open the ingest
firewall, stop the spare compositor service, or change monitoring targets.

Use one protected recovery-state path per recovery episode. All paths below
must be normalized absolute paths, and protected files remain mode `0600`:

```bash
node infra/event-stack/ingest-recoveryctl.mjs prepare \
  --manifest /absolute/event/manifest.json \
  --lifecycle-state /absolute/event/lifecycle-state.json \
  --anchors /absolute/protected/endpoint-anchors.json \
  --recovery-state /absolute/protected/ingest-recovery.json \
  --secrets /absolute/protected/deployment-secrets \
  --ssh-key /absolute/protected/scorecheck-do \
  --known-hosts /absolute/event/known_hosts \
  --ingest-tls-state /absolute/protected/ingest-tls-state \
  --credentials-env /absolute/protected/provider.env

node infra/event-stack/ingest-recoveryctl.mjs status \
  --recovery-state /absolute/protected/ingest-recovery.json
```

Takeover is admitted only after the primary host fails the protected local
health check, the stable endpoint fails three public checks, the Reserved IPv4
still has the expected exact owner, the spare owns no Egress, and all eight
current output-owner records are exact. The operator must provide the literal
event-scoped confirmation shown by `status` and the manifest:

```bash
node infra/event-stack/ingest-recoveryctl.mjs takeover \
  --manifest /absolute/event/manifest.json \
  --lifecycle-state /absolute/event/lifecycle-state.json \
  --anchors /absolute/protected/endpoint-anchors.json \
  --recovery-state /absolute/protected/ingest-recovery.json \
  --secrets /absolute/protected/deployment-secrets \
  --ssh-key /absolute/protected/scorecheck-do \
  --known-hosts /absolute/event/known_hosts \
  --ingest-tls-state /absolute/protected/ingest-tls-state \
  --credentials-env /absolute/protected/provider.env \
  --confirm TAKEOVER-INGEST:EVENT
```

Every completed mutation is checkpointed. If a command exits in `FAILED`, run
`status`, correct the reported dependency, and repeat the same exact command and
confirmation. The controller resumes the first incomplete step; it does not
replay a completed Reserved-IP move, firewall change, compositor rebind, or
output start. Never delete or hand-edit the recovery state to force progress.

Rollback is allowed only after the original ingest is locally healthy. It moves
the same Reserved IPv4 back, rebinds and resumes each exact output generation,
restores the single MediaMTX monitoring target, deactivates the temporary ingest
role, removes only its temporary firewall policy, and verifies the warm spare as
an idle compositor:

```bash
node infra/event-stack/ingest-recoveryctl.mjs rollback \
  --manifest /absolute/event/manifest.json \
  --lifecycle-state /absolute/event/lifecycle-state.json \
  --anchors /absolute/protected/endpoint-anchors.json \
  --recovery-state /absolute/protected/ingest-recovery.json \
  --secrets /absolute/protected/deployment-secrets \
  --ssh-key /absolute/protected/scorecheck-do \
  --known-hosts /absolute/event/known_hosts \
  --ingest-tls-state /absolute/protected/ingest-tls-state \
  --credentials-env /absolute/protected/provider.env \
  --confirm ROLLBACK-INGEST:EVENT
```

Archive the protected state only after phase `ROLLED_BACK`. A later recovery
episode uses a new state path. This flow is implemented but remains unavailable
for production reliance until a protected synthetic 12-host takeover and
rollback records measured RTO and exact output/monitor/provider convergence.

### Camera-independent recovery rehearsal

The recovery proof does not require physical cameras. It uses eight local,
looping 1080p30 fixtures against the real production ingest and output chain.
The publisher launcher first requires an exact live 12-host generation and an
idle raw path for every camera. It refuses to start if any physical or unknown
publisher is already present. Cameras 1-2 use the production RTMP contract and
Cameras 3-8 use the production SRT contract; credentials remain in protected
event inputs and are never written to state or command output.

This is an attended, paid production-shaped rehearsal. It is not a local unit
test and does not create, destroy, or automatically clean up infrastructure.
Run it only after the normal production build and live admission have passed,
with enough time remaining for the ordinary ordered output close and explicit
provider teardown. Never leave it running while the operator is unavailable.

Every disruptive synthetic qualification CLI uses the single protected lock
next to the event lifecycle state (`lifecycle-state.json.qualification-gate.lock`).
Renderer loss, Supabase loss, overlay-exception prepare/run/cleanup, and ingest
recovery therefore cannot mutate one event generation concurrently. Status
commands do not acquire the lock, and the ordinary production-soak runner must
remain active because it supplies the evidence baseline. If a second gate
reports a live owner, stop and wait; never delete the lock. A later command may
reclaim it only after the recorded local process is no longer alive.
Lifecycle start, close, evidence, destroy, and abort use the same exclusion
boundary, so coverage cannot transition or retire while a disruptive gate is
still active. Read-only lifecycle plan/status and initial provisioning do not
acquire it.

In one terminal, start the ordinary production soak and wait for its `ARMED`
line. In a second terminal, start the synthetic publishers:

```bash
node infra/event-stack/production-synthetic-publishers.mjs start \
  --profile /absolute/protected/events/EVENT/operator-profile.json \
  --state /absolute/protected/evidence/EVENT/synthetic-publishers.json \
  --evidence /absolute/protected/evidence/EVENT/synthetic-publishers \
  --runtime /absolute/protected/runtime/EVENT/synthetic-publishers \
  --ffmpeg /absolute/toolchain/ffmpeg \
  --confirm START-SYNTHETIC-PUBLISHERS:EVENT
```

The production soak then performs its normal source admission, output
conformance, Egress start, YouTube health, and stable-output checks. Wait for
`SOAK_STARTED`; do not run the recovery transaction while the soak is merely
armed or starting. The recovery runner requires the soak state to be `RUNNING`
and uses the same destinations and exact event generation:

```bash
node infra/event-stack/ingest-recovery-rehearsal.mjs run \
  --profile /absolute/protected/events/EVENT/operator-profile.json \
  --destinations /absolute/protected/youtube/EVENT/destinations.json \
  --soak-evidence /absolute/protected/evidence/EVENT/production-soak \
  --publisher-state /absolute/protected/evidence/EVENT/synthetic-publishers.json \
  --recovery-state /absolute/protected/evidence/EVENT/ingest-recovery.json \
  --evidence /absolute/protected/evidence/EVENT/ingest-recovery-rehearsal \
  --confirm-fault FAULT-PRIMARY-INGEST:EVENT \
  --confirm-takeover TAKEOVER-INGEST:EVENT \
  --confirm-restore RESTORE-PRIMARY-INGEST:EVENT \
  --confirm-rollback ROLLBACK-INGEST:EVENT
```

The fault adapter stops only the primary ingest host's `caddy` and `mediamtx`
Compose services and durably marks its exact event/recovery ownership. It does
not alter WireGuard, routing, the Droplet, any compositor, or any output. The
existing recovery controller performs the real Reserved-IPv4 takeover,
compositor rebind, output-owner reconciliation, monitoring-role move, primary
restore, and rollback. Each mutation remains resumable from protected state.

A pass requires all of the following:

- six consecutive healthy five-second monitor/provider samples before fault,
  on the spare, and after rollback;
- all twelve agents fresh, no fault gates, and no unresolved incidents after
  each stabilization window;
- exact output and YouTube destination health for all eight synthetic feeds;
- takeover and rollback RTO no greater than five minutes each;
- bounded publisher reconnects and all eight feeds healthy after rollback;
- final recovery phase `ROLLED_BACK` with the primary active and the warm spare
  restored.

Inspect the protected result without changing runtime:

```bash
node infra/event-stack/ingest-recovery-rehearsal.mjs status \
  --evidence /absolute/protected/evidence/EVENT/ingest-recovery-rehearsal
```

After evidence is sealed, let the ordinary production-soak runner perform its
normal ordered close. Then stop only the owned local publishers:

```bash
node infra/event-stack/production-synthetic-publishers.mjs stop \
  --profile /absolute/protected/events/EVENT/operator-profile.json \
  --state /absolute/protected/evidence/EVENT/synthetic-publishers.json \
  --confirm STOP-SYNTHETIC-PUBLISHERS:EVENT
```

If the rehearsal exits in failure after fault injection, it first uses the
already supplied confirmations to make one bounded safety return: an incomplete
takeover is resumed, the primary services are restored, and an active or
incomplete rollback is resumed. The failure artifact records every safety
action and whether the primary returned. Preserve both recovery and fault state
regardless. If the safety return also fails, use `ingest-recoveryctl.mjs status`
to correct the reported provider/host dependency and resume the exact incomplete
step. Reach `ROLLED_BACK` before ordinary output cleanup or provider teardown.
Never delete state to force recovery.

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
  "schemaVersion": 9,
  "manifest": "/absolute/protected/event/manifest.json",
  "state": "/absolute/protected/event/state.json",
  "anchors": "/absolute/protected/endpoint-anchors.json",
  "secrets": "/absolute/protected/event/secrets",
  "sshKey": "/absolute/protected/scorecheck_do",
  "knownHosts": "/absolute/protected/event/known_hosts",
  "commentaryTlsState": "/absolute/protected/retained-commentary-tls/HOSTSET_ID",
  "ingestTlsState": "/absolute/protected/retained-ingest-tls/HOSTSET_ID",
  "observabilityTlsState": "/absolute/protected/retained-observability-tls/HOSTSET_ID",
  "credentialsEnv": "/absolute/protected/provider.env",
  "lifecycleAttestation": "/absolute/protected/lifecycle-attestation.json",
  "rendererBinding": "/absolute/protected/event/renderer-binding.json",
  "venueProfile": "/absolute/protected/event/venue-profile.json",
  "commentaryQualification": "/absolute/protected/event/commentary-qualification.json",
  "evidence": "/absolute/protected/event/final-evidence",
  "rehearsalEvidence": null
}
```

The protected provider environment also contains `SCORECHECK_ACME_EMAIL`.
All three TLS state paths are deliberately outside the disposable event bundle.
Each contains the complete role-specific Caddy data directory, a mode-`0600`
integrity manifest, certificate fingerprints, expiry evidence, and the exact
hostname binding. Commentary retains the two commentary hosts, ingest retains
the stable media endpoint, and observability retains the monitor host. The
lifecycle refuses a healthy teardown unless all three
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

### SSH evidence and outbound dependencies

Every event host disables password and keyboard-interactive authentication,
permits root recovery only with the protected key, disables X11 forwarding,
and records accepted-key fingerprints plus session type at OpenSSH `VERBOSE`
level. After coverage closes, final evidence queries each host's read-only SSH
journal from event creation through capture. The retained summary contains the
accepted source, key identity, authentication method, and whether the session
was a command, subsystem, or interactive shell; it does not retain command
content. Non-key authentication, a source outside the rendered admin addresses
and exact event observability host, an unexpected user, or an interactive shell
from the bastion marks stack evidence unhealthy. Evidence capture and cost-safe
teardown remain available so an audit failure cannot strand billed compute.

The observability host remains the only event bastion. Adding a thirteenth
security-only host would increase cost and recovery complexity without removing
the operator-key dependency. A separate bastion is not admitted unless retained
event evidence shows that this bounded design is inadequate.

DigitalOcean Cloud Firewalls support destination addresses and tags, not stable
DNS-name policy. The event stack depends on dynamic provider networks, so a
static IP allowlist would fail closed on ordinary address rotation and could
interrupt coverage. The provider firewall therefore retains outbound TCP, UDP,
and ICMP while ingress stays role-scoped. Required outbound purposes are:

| Role | Required destinations and purpose |
| --- | --- |
| Every host during provisioning | DNS, NTP, Ubuntu and container registries; public TLS roles also require ACME |
| Ingest | Camera return traffic, private compositor/monitor traffic, and certificate issuance |
| Commentary | LiveKit ICE/TURN traffic, private monitoring, and certificate issuance |
| Compositor | Private ingest WHEP/RTSP, pinned renderer and Supabase HTTPS/WSS, monitoring, LiveKit commentary, and YouTube RTMPS |
| Observability | Private agent collection plus Supabase, Pushover, Healthchecks, YouTube API/watch probes, and bounded public sentinels |

This is an explicit reliability tradeoff, not an assertion that unrestricted
egress is ideal. Do not add a DNS proxy or destination gateway until an attended
synthetic event captures the exact runtime dependency set and proves the new
component cannot become a broadcast failure domain.

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
  --production-source /absolute/protected/production-recovery-source \
  --renderer-binding /absolute/protected/renderer-binding.json \
  --venue-profile /absolute/protected/venue-profile.json \
  --commentary-qualification /absolute/protected/commentary-qualification.json
```

The generator refuses an existing destination, weak input permissions, relative
paths, a nondeployable network template, an incomplete mode-specific
configuration, or an unbound manifest. It embeds the normalized effective
network contract in the immutable manifest, writes the exact next command, and
does not execute it.

This is a hard cutover to event manifest schema v6 and operator profile schema
v8. Any earlier bundle must be regenerated from the protected recovery source
and rendered network contract; lifecycle commands reject it before provider
access.

The scoring schema hard cutover is complete. On 2026-07-22 production applied
exactly `023`, `024`, `026`, `027`, `028`, and `030` in one transaction after
the rollback-only rehearsal passed. Independent SQL and PostgREST verification
passed, and the matching web and worker revision is
`2645dd484d4e537a7184feed8fa853ebd339bf1f`. The protected evidence is under
`~/.config/scorecheck/cutovers/scoring-schema-023-030-20260722T122341Z/`.
Never replay `029`, use a broad database push, or run a pre-cutover worker
against the current schema. Applying only `030` is invalid because its provider
commit RPC depends on the complete `023` through `028` scoring chain.

## Native 1080 production output

Production YouTube destinations use reusable streams with variable resolution
and frame-rate admission. At each broadcast start, the runner probes the exact
camera source against its event-bound rational frame rate, codec, bitrate,
identity, model, firmware, GOP, timestamp, scan, pixel, and audio contract.
Direct browser input is progressive H.264/yuv420p with no B-frames. HEVC remains
available as a bandwidth-saving camera source only when the venue profile assigns
that camera to the isolated compositor-local HEVC-to-H.264 normalizer; an HEVC
camera without that assignment fails admission. It then starts a matching H.264
1080p30 or 1080p60 scoreboard-overlay Web Egress and retains an actual ffprobe
output-conformance artifact. Monitoring previews remain independent low-bandwidth
derivatives and never determine the YouTube output profile. A camera that changes
frame rate mid-broadcast requires a controlled output restart so one YouTube
session never silently changes encoder contracts.

Prepare the protected YouTube identities before creating the production
bundle, then migrate the legacy recovery source once:

```bash
node infra/event-stack/production-youtube.mjs prepare \
  --credentials-env /absolute/protected/provider.env \
  --event next-event-slug \
  --active-cameras 1,2,3,4,5,6 \
  --output /absolute/protected/youtube/next-event-slug

node infra/event-stack/production-recovery.mjs migrate-youtube \
  --source /absolute/protected/production-recovery-source-v1 \
  --destinations /absolute/protected/youtube/next-event-slug/destinations.json \
  --output /absolute/protected/production-recovery-source-v2

node infra/event-stack/production-recovery.mjs refresh-monitoring \
  --source /absolute/protected/production-recovery-source-v2 \
  --monitoring-env /absolute/protected/monitoring.env \
  --output /absolute/protected/production-recovery-source-current
```

`refresh-monitoring` is the one-way migration for a schema-v2 recovery source
captured before the dedicated platform-sentinel check existed. It preserves all
other checksummed recovery material, adds only the unique sentinel ping URL,
and refuses an already-migrated source, dead-man URL reuse, Twilio residue,
weak permissions, malformed HTTPS, or a pre-existing destination.

The compositor pool uses one SFO2 premium Intel 8-vCPU/16-GiB host per camera
plus one warm spare. Start no public output merely because the 12-host stack is
ready. After the router is online and the lifecycle is explicitly live, arm
the bounded six-camera soak:

```bash
node infra/event-stack/production-soak.mjs run \
  --profile /absolute/protected/events/next-event-slug/operator-profile.json \
  --destinations /absolute/protected/youtube/next-event-slug/destinations.json \
  --evidence /absolute/protected/evidence/next-event-slug \
  --minimum-hours 4 \
  --maximum-hours 6
```

The runner first proves an idle 12-host baseline and healthy fail-closed venue
routing, then prints `ARMED` while every public output remains stopped. Cameras
1-6 may start only after that line. It probes each source, starts exactly one
matching output per camera, verifies the scoreboard page and unlisted YouTube
destination, records five-second end-to-end samples plus host and router
evidence, and sends deduplicated plain-English Pushover alerts. A separate
off-VPC sentinel checks monitor, ingest, commentary, and the immutable renderer
once per minute through its own Healthchecks check. One long-lived Compose log
stream per Droplet retains redacted critical lifecycle/error evidence on the
operator machine without repeated SSH polling. Sentinel/log liveness, full-host
readiness, edge gaps, and coverage are hard acceptance inputs. Cameras 7-8 must
remain isolated for this six-camera soak.

`HEALTHCHECKS_SENTINEL_PING_URL` is a third protected Healthchecks check. Do not
reuse the monitor-service baseline or active ping URL: reuse could let one
process mask another process's failure. Attach Pushover to the sentinel check
before capturing the production recovery source.

### Priority-court YouTube backup gate

YouTube exposes a distinct backup RTMPS ingestion address on the same reusable
stream. Production destination admission requires both addresses and refuses a
missing or identical pair. The primary compositor and warm spare use the same
protected stream key, but their owner records are explicit schema-2 `primary`
and `backup` roles and their RTMPS base hosts must differ.

Run this only during an attended synthetic production soak for one selected
priority court. It does not require a physical camera when the protected
synthetic publishers are the admitted source:

```bash
node infra/event-stack/youtube-backupctl.mjs run \
  --profile /absolute/protected/events/EVENT/operator-profile.json \
  --destinations /absolute/protected/youtube/EVENT/destinations.json \
  --soak-evidence /absolute/protected/evidence/EVENT \
  --evidence /absolute/protected/evidence/EVENT/youtube-backup-camera-1 \
  --camera 1 \
  --confirm YOUTUBE-BACKUP:EVENT:SOAK_RUN_ID:CAMERA-1
```

The runner stages one mode-0600, court-scoped backup assignment on the spare;
starts exactly one backup Egress; verifies dual ingest; stops the exact owned
primary; verifies backup-only provider and viewer delivery; restores primary;
verifies dual delivery; stops backup; removes the assignment; and seals
primary-only rollback evidence. A stale checkpoint that no longer shows dual
ingest restores primary before backup can be removed. It never creates a new
stream or broadcast and never logs or stores the stream key in public state.

In addition to the phase probes, one no-cookie external viewer remains open for
the entire transaction. It samples readiness, playhead, adaptive dimensions at
or above 640x360, and decoded audio every 250 ms; hashes nonblank video frames at
ordered phase markers; caps retained samples; fails a sampling gap over one
second or playhead stall over two seconds; and closes on every success or failure
path. A process restart can
safely restore output, but it cannot reconstruct the lost trace and therefore
cannot pass the gate. Until the attended protected artifact exists, the
implementation is ready but I-09 remains `PARTIAL`.

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
  --ingest-tls-state /absolute/protected/retained-ingest-tls/HOSTSET_ID \
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
6. Public commentary, ingest, and monitor TLS health checks pass.
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
  --ingest-tls-state /absolute/protected/retained-ingest-tls/HOSTSET_ID \
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
  --ingest-tls-state /absolute/protected/retained-ingest-tls/HOSTSET_ID \
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
  --ingest-tls-state /absolute/protected/retained-ingest-tls/HOSTSET_ID \
  --observability-tls-state /absolute/protected/retained-observability-tls/HOSTSET_ID \
  --credentials-env /absolute/protected/provider.env \
  --evidence /absolute/protected/next-event-slug/final-evidence \
  --confirm DESTROY:next-event-slug
```

Destroy is blocked while coverage is live, before the manifest review date,
without protected evidence, or when provider inventory differs from state. It
stops all three Caddy services and atomically refreshes the protected
commentary, ingest, and observability TLS states before deleting any Droplet. If
any healthy service cannot preserve valid state, teardown fails closed and restarts that Caddy
service; no compute is deleted. The retained directories are local lifecycle
authority, not provider resources, so they create no DigitalOcean idle cost.
After TLS capture, teardown stops the observability monitor sender and pauses
the baseline, active-coverage, and external-sentinel Healthchecks checks. It
verifies all three are paused before deletion; a provider error blocks teardown
and restores the stopped monitor and Caddy services. This keeps intentional
provider-zero periods quiet without weakening event-time dead-men. Destroy then
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

Run the read-only cost sentinel at a bounded cadence, such as every 15 minutes,
while an event lifecycle exists:

```bash
node infra/event-stack/cost-reminders.mjs \
  --profile /absolute/protected/event/operator-profile.json
```

It deduplicates Pushover reminders for active outputs after close, billed event
Droplets one hour and twelve hours after close, unused setup compute, and a
terminal lifecycle whose event Droplets are not zero. It never stops an output,
closes a broadcast, or deletes infrastructure. A reminder is not teardown
authorization.

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
  --soak-seconds 1800
```

Execute the exact `operator.command` with the exact `operator.args` written to
the protected bundle's `BUNDLE.json`. Do not transcribe or reconstruct the
invocation. That runner owns plan, prepare, provision, explicit start, 30-minute soak,
ordered output cleanup, evidence sealing, and exact infrastructure teardown. A
failure enters the bounded recovery plan and leaves a protected report; it does
not silently skip cleanup.

During the full rehearsal, the eight 1080p30 synthetic source loops run on the
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

The synthetic commentator is admitted before output only after the preview
advances and Chromium proves a live microphone source with non-silent capture
energy, duration, RTP packets, and RTP bytes. The visible microphone meter is
operator feedback, not an authority: its headless rendering can be silent while
the actual WebRTC audio path is healthy. This split is intentional: LiveKit
pauses an upstream publication after roughly half a second when no program mixer
has subscribed yet. Requiring sustained outbound RTP at this point creates a
circular startup dependency. After Egress starts, the full-stack verifier remains
authoritative and requires fresh non-silent commentary audio, zero packet loss,
and locked clock/synchronization telemetry from the actual program mixer before
the soak can begin. A failed startup closes Chromium immediately; it never waits
on a leaked browser process before bounded recovery and provider cleanup can
begin.

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

DigitalOcean control-plane reads, deletes, and idempotent updates use four
bounded attempts for transport failures and HTTP 429/500/502/503/504 responses.
Create and action `POST` requests remain single-attempt because a lost response
can hide a successful provider-side mutation; automatically replaying one could
duplicate a Droplet, Reserved IPv4, firewall, or action. After any ambiguous
`POST` failure, rerun the exact immutable event bundle. The lifecycle reconciles
the recorded event tags and resource identities before it creates anything else.
Errors include only the provider method and sanitized path, never request bodies
or credentials.

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

For each court, the controller starts Egress and waits for the empty-room program
pipeline to reach its persistent YouTube destination before it starts the
synthetic commentator. It then requires two fresh monitor heartbeats proving
that the actual program browser is playing with exactly one reader and is
connected to its LiveKit commentary room. This guarantees that LiveKit has a
program subscriber before the microphone publication begins. The program mixer
disables adaptive-stream suspension because it consumes remote commentary via
Web Audio and must remain a continuous broadcast subscriber. It also keeps each
remote commentary track attached to a muted LiveKit media sink; the custom Web
Audio graph remains the only audible broadcast path while the SDK-supported
attachment keeps the subscription lifecycle active. Commentary readiness then requires
advancing preview video, a live microphone sender and source, at least 75 percent
positive microphone-meter coverage, and sustained outbound RTP, captured-audio
duration, and nonzero audio energy throughout the eight-second cadence window.
The monitor's commentary heartbeat remains the authoritative program-side audio
contract and must prove current audio, synchronization lock, bounded timing, and
zero packet loss before qualification starts and throughout the soak.

Production and rehearsal share the exact persistent pool named `ScoreCheck
Production Camera 1 Auto Stream` through `ScoreCheck Production Camera 8 Auto
Stream`. Every member must be reusable variable-profile RTMP, idle before
admission, unique by provider ID and stream key, then active/good with no
configuration issues during qualification. Production preparation creates a
missing pool before compute provisioning; the rehearsal controller only adopts
it and never creates or deletes streams. Fresh unlisted broadcasts, watch pages,
stream binding, recording, and lifecycle transitions are a separate
once-per-tournament control-plane preflight. That preflight should be
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
