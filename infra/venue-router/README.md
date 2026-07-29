# Venue Router Speedify Routing

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

## Current diagnostic Speedify settings

- Mode: Speed.
- Transport: Multi-TCP.
- Fixed delay: 75 ms.
- Packet pool: Default.
- Default route: Off.
- PEP: On for RTMP.
- Target connections: Automatic.

These mode and transport values preserve the last physical A/B diagnostic;
they are not a production qualification. In the July 29 eight-physical-camera
gate, Speed with single TCP, Enhanced Streaming with UDP, Speed with UDP, and
Speed with Multi-TCP all failed sustained delivery. The best Multi-TCP warmup
later saturated the dual-core router. Enhanced Streaming was not proven
harmful; Enhanced plus Multi-TCP should be compared against Speed plus
Multi-TCP only after the tunnel runs with measured CPU headroom. Do not infer a
production choice from the current test residue.

Do not use Auto transport for this path. In the July 12 test it selected TCP
and caused severe loss inside the nested camera-LAN tunnel.

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
