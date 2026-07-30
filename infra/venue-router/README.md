# Venue Router Operations

The replacement-router intake, exact HW3 settings, phased commissioning, and
physical acceptance gates are defined in
[`docs/PEPLINK_BR1_PRO_5GK_HW3_COMMISSIONING_PLAN.md`](../../docs/PEPLINK_BR1_PRO_5GK_HW3_COMMISSIONING_PLAN.md).
Do not import a full binary configuration from a different product code or
hardware revision into the incoming `MAX-BR1-PRO-5GK-T-PRM` HW3 router.

## Peplink MAX BR1 Pro 5G remote management

The active Peplink router is managed through Peplink's supported APIs, not a
public SSH port. An InControl OAuth client obtains a short-lived token, and the
same bearer token reaches the router API through its stable Remote Web Admin
hostname. This remains reachable when venue WAN addresses change or use carrier
NAT.

The protected client credential is stored outside Git at:

```text
~/.config/scorecheck/peplink/incontrol-client.json
```

The file must be mode `0600`. Use the dependency-free client for bounded reads:

```sh
node infra/venue-router/peplinkctl.mjs status
node infra/venue-router/peplinkctl.mjs snapshot
node infra/venue-router/peplinkctl.mjs get status.client
node infra/venue-router/peplinkctl.mjs get config.ssid.profile
```

Command output automatically redacts known modem, SIM, and credential fields so
routine diagnostics can be retained safely.

Use `snapshot` for routine monitoring and preflight. It obtains one short-lived
token and reads the supported router endpoints sequentially. Do not launch one
CLI process per endpoint: firmware 8.6 invalidates older Remote Web Admin
sessions when overlapping OAuth grants are created. The snapshot includes WAN,
SpeedFusion, LAN, connected-client, SSID, port, allowance, and SNMP state so
event checks do not require the Web Admin interface. The Ubiquiti APs are not
Peplink-managed mesh devices; collect their radio health through their own
management interface when that hardware is connected.

Configuration calls are supported only as an explicit write with a local JSON
body and confirmation marker:

```sh
node infra/venue-router/peplinkctl.mjs post config.ssid.profile \
  --body /absolute/path/request.json \
  --confirm-write
```

Before a write, use the matching `get` endpoint and preserve the response as
the rollback record. Use only endpoints documented by Peplink for the installed
firmware. Some router controls, including the SpeedFusion Cloud profile editor,
are not present in the supported Router API. Treat those as bounded console-only
commissioning changes rather than reverse-engineering an unsupported endpoint;
normal event preflight and monitoring must continue through `snapshot`.

Do not enable WAN SSH or add a router port forward. It does not solve changing
WAN addresses or carrier NAT, and it adds an unnecessary management surface.
The Peplink client AP role is disabled for the production candidate. Its radios
are reserved for the optional phone-hotspot Wi-Fi WAN. The three wired Ubiquiti
APs carry camera and operator clients.

## Peplink production profile

The event topology is intentionally narrow:

- `WAN` is the wired Starlink input and is Priority 1.
- `Cellular` is the internal modem and is Priority 1.
- The phone hotspot is an optional Priority 1 Wi-Fi WAN; leave its BSSID unpinned
  until reboot and reconnect tests pass.
- VLAN WAN is disabled.
- One LAN port connects to the PoE switch. Never connect both LAN ports to the
  same switch unless loop prevention has been deliberately configured.
- The switch feeds the three external Ubiquiti Swiss Army Knife Ultra access
  points. The Peplink does not serve camera or operator client Wi-Fi.
- The flat event network remains `BVM LAN` at `192.168.50.0/24` until the
  switch and all three APs are present for a measured VLAN qualification.

Only media publishing traffic is sent through SpeedFusion Connect. The applied
outbound rules are:

| Rule | Destination | Protocol | Route | No-tunnel behavior |
| --- | --- | --- | --- | --- |
| `ScoreCheck SRT` | persistent ingest Reserved IPv4 | UDP `8890` | Enforced `SFC` | Drop |
| `ScoreCheck RTMP` | persistent ingest Reserved IPv4 | TCP `1935` | Enforced `SFC` | Drop |

All other traffic retains the router's normal automatic policy. The initial
SpeedFusion profile uses Dynamic Weighted Bonding with `Fast` failure detection,
Low congestion latency, a 150 ms jitter buffer, a 250 ms latency-difference
cutoff, and both FEC and WAN Smoothing off. The only initial A/B enables Adaptive
FEC. Test `Faster` detection and WAN Smoothing later and one at a time. These
settings must be applied and verified through the authenticated SFC profile
editor when they are not exposed by the supported Router API.

The WAN bandwidth fields are ceilings, not measured capacity evidence. Do not
replace them with a speed-test peak or use them as admission proof. Event
preflight must record sustained Starlink, cellular, and optional phone-hotspot
delivery separately with real camera media, then prove the combined camera
payload retains at least 30% reserve.

Keep Remote Web Admin over InControl, HTTPS redirect, LAN-only local Web Admin,
disabled SSH/console, disabled UPnP/NAT-PMP, and an empty port-forward table.
The production preflight still requires the real Starlink terminal, active SIM,
PoE switch, all three APs, and camera associations; router-only setup cannot
truthfully certify those physical dependencies.

## Legacy GL-XE3000 Speedify routing

The scripts below apply only to the retired OpenWrt GL-XE3000 plus Speedify
topology. Do not deploy them to a Peplink router.

Production camera traffic is fail-closed through Speedify. It must never fall
back to one venue WAN. Ordinary laptops, camera-control pages, and other venue
traffic stay outside the tunnel.

The router selectively handles only these MediaMTX ingest flows:

- UDP `8890` for SRT callers.
- TCP `1935` for RTMP publishers.

Two independent controls enforce the policy:

1. Primary policy table `900` routes camera traffic through `connectify0`.
   Guard table `901` blackholes the same traffic if the primary route vanishes.
2. An early `iptables` forwarding rule rejects camera traffic on every output
   interface except `connectify0`.

The watchdog checks bounded Speedify state every five seconds. After a daemon,
interface, or router-network restart, it restores table `900`, replaces the two
camera rules, and clears only stale MediaMTX connection tracking. The guards
stay active throughout recovery, so the cameras reconnect through Speedify or
remain blocked. The watch process holds a separate lifetime `flock`; an
overlapping `procd` start exits before it can reconcile. The shorter reconcile
lock still serializes route mutations within the single owner.

## Install

From a trusted operator computer on the router LAN:

```sh
./deploy.sh root@192.168.8.1
ssh root@192.168.8.1 /usr/sbin/scorecheck-speedify-routing preflight 85
ssh root@192.168.8.1 /usr/sbin/scorecheck-speedify-routing enable 85
ssh root@192.168.8.1 /usr/sbin/scorecheck-speedify-routing status
```

Replace `85` with the worst sustained bonded upload measured at the venue. The
default floor is 75 Mbps for the current nominal 30 Mbps camera payload. Do not
substitute an ISP plan speed or a momentary speed-test peak.

`deploy.sh` installs and starts the watchdog but deliberately does not enable or
disable camera routing. `enable` installs both guards before connecting or
migrating active publishers. A failed enable leaves camera traffic blocked and
the watchdog retrying; it never rolls back to direct WAN.

## Rebind the persistent ingest anchor

Production cameras publish to `preview.beachvolleyballmedia.com`, and the venue
WireGuard peer targets the same retained ingest Reserved IPv4. Rebind the
provider and DNS first, wait for authoritative plus recursive DNS convergence,
and stop every camera publisher before changing the router endpoint. Then run:

```sh
./rebind-ingest-anchor.sh root@192.168.8.1 EXPECTED_OLD_IPV4 NEW_RESERVED_IPV4
```

The command refuses an unexpected current endpoint or any RTMP/SRT flow to the
old or new address. It creates a mode-`0700` router backup, updates the peer and
both checked-in routing tools, restarts only `camera_lan` and the routing
watchdog, and runs fail-closed reconciliation. Success requires matching source
hashes, a fresh WireGuard handshake, four policy rules, two firewall guards,
both protocol routes through `connectify0` table `900`, and exactly one live
watchdog. Any failed postcondition restores the prior network and tool files.

The provider/DNS transaction has its own rollback record. Do not remove that
record or the router backup until the post-cutover monitor snapshot is healthy
and both public endpoints have been verified.

At an event end, stop every camera first, verify coverage is over, then run:

```sh
ssh root@192.168.8.1 /usr/sbin/scorecheck-speedify-routing disable EVENT_ENDED
```

The command refuses to remove the guards while camera flows are active. There
is no emergency fail-open or `reset` command.

## Required Speedify settings

- Mode: Streaming.
- Transport: UDP.
- Fixed delay: 75 ms.
- Packet pool: Default.
- Default route: Off.
- PEP: On for RTMP.
- Target connections: Automatic.

Do not use Auto transport for this production path. In the July 12 test it
selected TCP and caused severe loss inside the nested camera-LAN tunnel.
Multi-TCP carried the five direct publishers but made the WireGuard handshake
stale and dropped listener-camera paths, so it is also rejected.

The camera 5 GHz radio must use `HE80`; router preflight rejects narrower AP
configuration. In the July 27 eight-camera test, `HE20` left several AVKANS
stations negotiated at only 8-17 Mbps. After the `HE80` reassociation, all
eight stations negotiated at 229-286 Mbps and SRT loss fell materially. Clients
may still report a 20 MHz client channel width; the acceptance signal is the
negotiated station rate and clean media, not that field alone.

Every Speedify adapter admitted for an event must represent a physically
independent WAN. Do not admit both Ethernet and Wi-Fi repeater interfaces when
they lead to the same modem or ISP gateway; that duplicates one failure domain
and can amplify its queueing. This remains an operator-verified topology check
because matching ISP names alone cannot distinguish duplicate paths from two
independent circuits from the same carrier.

Every discovered Speedify input must keep its saved priority set to `automatic`.
Speedify may independently report a working role such as `always` or
`secondary`; that is scheduler state, not an operator policy change. The router
heartbeat reports both values, and active-event monitoring pages if any saved
policy drifts from `automatic`. A temporary diagnostic change must be restored
before the diagnostic ends.

The router heartbeat also reports the number of devices associated with the
dedicated camera Wi-Fi interface and its weakest client signal. This is
diagnostic telemetry only: it distinguishes a camera that left the venue AP
from an ingest failure without changing camera or Speedify configuration.

## July 13 OOM incident

The overnight Speedify reconnect was not evidence that eight streams exceeded
Speedify capacity. The router kernel killed Speedify under memory pressure. An
unbounded diagnostic command, `speedify_cli -s stats`, was left in a pipeline
that removed newlines and caused roughly 100 MB of buffering on a router with
about 491 MB RAM. Speedify itself used roughly another 101 MB at the time.

Never invoke `speedify_cli -s stats` without both a finite sample duration and
an outer process timeout. The unqualified form is a continuous stream, not a
one-shot query. The recorder uses bounded state queries; the router heartbeat
uses the finite `stats 1 current` form with a three-second timeout. Both track
available memory, Speedify RSS, and any accidental streaming-stats process.

The watchdog is still required even after fixing this monitor defect. Any
long-running process can restart because of a software fault, router reboot, or
package upgrade. Recovery exists to preserve the routing invariant, not because
routine reconnects are expected.

## Temporary MAKI cameras

The three MAKI Live cameras used in the July test are listener-only. Their VPS
pulls traverse WireGuard and are not representative of the final production
path. Nesting that temporary WireGuard topology inside Speedify exceeded the
home test uplink and dropped paths.

The final two-Mevo/six-AVKANS topology has eight direct RTMP/SRT publishers and
must be qualified with all eight camera flows through Speedify. A test segment
that routes any production camera publisher directly over one WAN does not
qualify the design.

## Soak evidence

Run `scorecheck-speedify-soak-recorder` on the router. It records bounded
Speedify state, protocol-specific route devices, primary and guard rule counts,
kill-switch state, camera flow counts, interface counters, WireGuard handshake
age, load, available memory, Speedify RSS, and streaming-stats leak count. It
does not collect credentials or media payloads.

The router also sends one bounded telemetry heartbeat every ten seconds to the
monitor service. It uses a dedicated write-only bearer token stored as mode
`0600` at `/etc/scorecheck-monitoring-router-token`; never install the dashboard
read token on the router. Each sample runs `speedify_cli -s stats 1 current`
with a three-second process timeout and verifies that no stats process remains.
The payload contains only aggregate/link quality, route guards, resource use,
and flow counts. It never contains WAN addresses, camera credentials, or media.

For a detached OpenWrt run, export the duration, interval, and log path, then
launch the recorder with `start-stop-daemon`; this router image does not include
`nohup`:

```sh
export SCORECHECK_SOAK_DURATION_SECONDS=10800
export SCORECHECK_SOAK_INTERVAL_SECONDS=60
export SCORECHECK_SOAK_LOG_FILE=/root/scorecheck-speedify-soak.tsv
start-stop-daemon -S -b -x /usr/sbin/scorecheck-speedify-soak-recorder
```
