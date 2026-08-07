# ScoreCheck UniFi control plane

ScoreCheck manages the three Ubiquiti UK-Ultra access points with UniFi OS
Server. The existing macOS controller is only the initial commissioning and
migration source. The production controller is a persistent, minimum-size
DigitalOcean Droplet so the MacBook and extra controller hardware are not part
of event startup, operation, monitoring, or maintenance.

## Operating boundary

- The APs keep their last applied configuration if the controller is unavailable;
  camera media does not depend on the controller or monitoring API.
- No CloudKey or other travel hardware is required.
- No paid Official UniFi Hosting subscription is required.
- The controller and its API remain available between events. This consumes one
  of the 15 available Droplet slots and leaves enough room for the 12-host event
  fleet plus two unused slots.
- Initial adoption and radio changes use the authenticated UniFi UI. Routine
  readiness, monitoring, and evidence use the official API.
- The event lifecycle treats this controller as persistent baseline inventory,
  verifies it before setting `MONITOR_UNIFI_REQUIRED=true`, and never deletes it
  during provider-zero event teardown.

Provision or reconcile the controller with:

```sh
node infra/unifi/cloud-controller.mjs up \
  --credentials-env "$HOME/.config/scorecheck/event-stack/lifecycle-provider.env" \
  --state "$HOME/.config/scorecheck/unifi/cloud-controller.json" \
  --confirm CREATE:PERSISTENT-UNIFI-CONTROLLER
```

The pinned deployment is UniFi OS Server 5.1.21 on Ubuntu 24.04 x64, hosted at
`unifi.beachvolleyballmedia.com` on `s-1vcpu-2gb`. The host firewall exposes only
SSH, HTTPS and its certificate-renewal challenge, device inform TCP 8080, and
STUN UDP 3478. Nginx terminates the public certificate and proxies the UniFi OS
Server; port 11443 is blocked by the host firewall. A fresh controller requires
one explicit administrator acceptance of the certificate authority terms after
DNS points at the new host. The resulting certificate renews automatically.

## Permanent AP identity and antennas

Keep the existing device names. Do not rename them:

| Device | Antenna contract |
| --- | --- |
| `UK Ultra 1` | Ubiquiti panel antenna at every event |
| `UK Ultra 2` | Ubiquiti panel antenna at every event |
| `UK Ultra 3` | Event-selected Ubiquiti panel or omni antenna; omni for the next event |

The AP3 antenna selection belongs in the event manifest and must match the
physical attachment before readiness. Changing AP3's antenna requires applying
the matching UniFi antenna type before cameras connect.

## One-time commissioning

1. Power each UK-Ultra from the PoE switch or an injector and give its upstream
   network normal Internet access.
2. Use the existing UniFi OS Server site to adopt or reconnect the AP without
   changing its permanent `UK Ultra 1/2/3` name.
3. Apply the camera radio baseline from
   `docs/PEPLINK_BR1_PRO_5GK_HW3_COMMISSIONING_PLAN.md`: wired uplink, mesh off,
   2.4 GHz disabled, dedicated 5 GHz WPA2 camera SSID, fixed non-DFS channels,
   medium transmit power, and no automatic channel changes during coverage.
4. Select the correct physical antenna type. AP1 and AP2 are always panel; AP3
   follows the event manifest.
5. Create a dedicated official Network API key. UniFi does not expose a
   per-key read-only scope here, so the ScoreCheck collector is limited to GET
   requests and the key remains only in the protected service environment.
6. Record the controller API base URL, Network site UUID, and each AP device
   UUID and MAC address in the protected production monitoring source.
7. Confirm the API reports each AP as `ONLINE` with a fresh heartbeat before
   setting `MONITOR_UNIFI_REQUIRED=true`.

The API key must never be committed, printed in evidence, or passed to Caddy,
Prometheus, browser code, or the event router.

## Venue switch relay

The LinoVision switch remains private at `192.168.50.2`. A single constrained
FRP client on the Peplink connects outbound to a pinned FRP server on this
persistent controller host. The server binds the resulting SNMP listener only
to the DigitalOcean VPC address on UDP `1161`; no switch or SNMP port is exposed
on the public interface. The event observability host therefore polls
`10.120.0.3:1161` with the existing read-only SNMPv3 identity.

This is deliberately a one-service relay, not a general site-to-site VPN. It
does not carry camera, Egress, dashboard, or ordinary venue traffic. The router
container can reach only the switch's UDP `161` endpoint, and the cloud server
is limited to 0.10 CPU and 64 MB. Peplink's Docker wrapper does not accept CPU
or memory limit flags, so router-side admission is based on measured idle and
eight-camera resource evidence rather than a limit the platform cannot enforce.

Deploy or reconcile the persistent cloud half with a mode-0600 environment
containing `SCORECHECK_VENUE_RELAY_TOKEN`:

```sh
infra/unifi/deploy-venue-relay.sh \
  --env "$HOME/.config/scorecheck/unifi/venue-relay.env" \
  --host 167.172.116.163 \
  --private-ip 10.120.0.3
```

The Peplink client uses pinned `fatedier/frpc:v0.69.0`, TLS, token
authentication, and one UDP mapping from cloud port `1161` to
`192.168.50.2:161`. Removing that one router container and disabling
`scorecheck-venue-relay.service` on the controller is the complete rollback.

## Applied AP baseline

The controller-wide production baseline was reconciled on 2026-08-04:

- `BVM 1`, `BVM 2`, and `BVM 3` each broadcast only from their matching
  `UK Ultra` AP and only on 5 GHz;
- all three SSIDs use explicit manual settings with fast roaming, handoff
  suggestions, band steering, and BSS transition disabled for stationary
  cameras;
- WPA2 compatibility, visible SSIDs, local client communication, automatic
  DTIM, and unlimited client throughput are preserved;
- wireless meshing is disabled globally because every production AP has a
  wired uplink;
- UniFi OS, Network application, and device firmware remain on the Official
  channel, but unattended updates are disabled. Updates are checked and
  applied deliberately before an event, never during coverage;
- weekly automatic controller backups remain enabled.

The third-party `PepWave` network retains its conservative Layer-2 defaults:
RSTP and rogue-DHCP detection enabled; IGMP snooping, jumbo frames, flow
control, and 802.1X disabled. No gateway, VLAN, multicast, or traffic-shaping
behavior was added during AP commissioning.

`UK Ultra 1` was commissioned on 2026-08-04 with:

- outdoor mode and Ubiquiti panel antenna;
- DHCP and wired uplink;
- mesh parent and mesh connect disabled;
- 2.4 GHz radio disabled;
- 5 GHz channel 157, 20 MHz, medium transmit power;
- existing `BVM 1` Wi-Fi name and credentials preserved;
- existing stable AP firmware preserved.

AP1 was redirected to the cloud controller and live-verified on 2026-08-04 as
`Up to date` on wired GbE at `192.168.0.219`, with no active 2.4 GHz channel and
live 5 GHz channel 157/20 MHz. It remained online with a fresh official-API
heartbeat after the macOS UniFi OS Server and its local inform listener were
stopped.

`UK Ultra 2` was commissioned on 2026-08-04 with:

- outdoor mode and Ubiquiti panel antenna;
- DHCP and wired uplink;
- mesh parent and mesh connect disabled;
- 2.4 GHz radio disabled;
- 5 GHz channel 149, 20 MHz, medium transmit power;
- existing `BVM 2` Wi-Fi name and credentials preserved;
- existing stable AP firmware preserved.

AP2 was redirected to the cloud controller and live-verified on 2026-08-04 as
`Up to date` on wired GbE at `192.168.0.216`, with no active 2.4 GHz channel and
live 5 GHz channel 149/20 MHz. It remained online with a fresh official-API
heartbeat after the macOS UniFi OS Server and its local inform listener were
stopped.

`UK Ultra 3` was commissioned on 2026-08-04 with:

- outdoor mode and Ubiquiti omni antenna;
- DHCP and wired uplink;
- mesh parent and mesh connect disabled;
- 2.4 GHz radio disabled;
- 5 GHz channel 161, 20 MHz, medium transmit power;
- existing `BVM 3` Wi-Fi name and credentials preserved;
- existing stable AP firmware preserved.

AP3 was live-verified `Up to date` on wired GbE at `192.168.0.95`, with no
active 2.4 GHz radio and live 5 GHz channel 161/20 MHz. The UniFi device table
retained an older 149 MHz summary, but the live AP details and AirView radio
state both reported 161/20 MHz; production readiness must use fresh radio
telemetry rather than the stale table summary.

## Protected controller backup

A fresh all-applications controller backup was created after the controller
hardening at 2026-08-04 20:47 CDT and stored outside Git with mode `0600`:

```text
~/.config/scorecheck/unifi/backups/unifi-os-backup-20260804T204701CDT.unifi
SHA-256 f693ecfa817c9e2e0ee84517b5b7ad8d93894660900214ac86970c485bb50e81
```

The backup may contain controller credentials and must never be committed or
copied into normal evidence. It is the one-time migration source for the cloud
controller and remains protected recovery material after migration.

## Protected monitoring contract

The observability service consumes these values from its mode-0600 environment:

```dotenv
MONITOR_UNIFI_REQUIRED=true
MONITOR_UNIFI_API_KEY=<protected official API key>
MONITOR_UNIFI_BASE_URL=https://unifi.beachvolleyballmedia.com/proxy/network/integration/v1
MONITOR_UNIFI_SITE_ID=<Network site UUID>
MONITOR_UNIFI_ACCESS_POINTS_JSON=[{"name":"UK Ultra 1","deviceId":"<uuid>","macAddress":"<mac>","expected":true},{"name":"UK Ultra 2","deviceId":"<uuid>","macAddress":"<mac>","expected":false},{"name":"UK Ultra 3","deviceId":"<uuid>","macAddress":"<mac>","expected":true}]
MONITOR_UNIFI_CAMERA_CLIENTS_JSON=[{"cameraNumber":1,"macAddress":"<camera-1-mac>"},{"cameraNumber":2,"macAddress":"<camera-2-mac>"},{"cameraNumber":3,"macAddress":"<camera-3-mac>"},{"cameraNumber":4,"macAddress":"<camera-4-mac>"},{"cameraNumber":5,"macAddress":"<camera-5-mac>"},{"cameraNumber":6,"macAddress":"<camera-6-mac>"},{"cameraNumber":7,"macAddress":"<camera-7-mac>"},{"cameraNumber":8,"macAddress":"<camera-8-mac>"}]
MONITOR_UNIFI_POLL_INTERVAL_MS=30000
```

Camera identities are bound by their permanent MAC addresses. The official
Network integration API supplies the current client-to-AP association, but it
does not expose per-client RSSI. The monitor therefore reports the observed AP
without inventing a signal value; AP-wide retry telemetry remains available.

All four identity/credential values are atomic: partial configuration is
rejected. The AP names, UUIDs, and MACs must each be unique, and exactly three
APs are required.

## Automatic event behavior

`eventctl up` verifies the persistent controller before monitoring becomes
required. The monitor reads the official UniFi API every 30 seconds and adds the
following to `/v1/snapshot` and Prometheus:

- controller reachability;
- expected and online AP count;
- AP model, firmware, state, IP, heartbeat, CPU, memory, and uplink rates;
- radio transmit-retry percentage;
- connected clients and each client's `uplinkDeviceId`, which identifies its AP.

Production verification and soak admission require `unifi.state=HEALTHY` when
`MONITOR_UNIFI_REQUIRED=true`. Alerts use plain operator language for:

- controller/API unavailable;
- an expected AP offline;
- sustained radio retries above 25 percent.

Event teardown preserves the controller and destroys only the temporary event
fleet. The APs retain their last configuration while powered down.

## Cloud cutover status

The protected controller backup was restored to the cloud controller on
2026-08-04. `UK Ultra 3`, `UK Ultra 1`, and `UK Ultra 2` were individually
redirected to `unifi.beachvolleyballmedia.com`, reached `Up to date`, and
remained online after the macOS UniFi OS Server was stopped. The official local
Network API key is stored outside Git with mode `0600`; the direct HTTPS API
reports the three permanent AP identities and fresh telemetry for whichever
APs are powered.

A post-cutover all-applications backup is stored outside Git with mode `0600`:

```text
~/.config/scorecheck/unifi/backups/unifi-os-cloud-cutover-20260804T221016CDT.unifi
SHA-256 7e7b87672f363502c3ea8d57a4bf29b37c3911bd4102cc23cf7dd1accefec0e6
```

Weekly automatic system backups are enabled in the cloud controller.

## Remaining live steps

- Power all three APs together and verify the saved 149/157/161 MHz channel
  plan and 20 MHz widths after an event-location RF scan. All three are
  individually cloud-migrated and live-verified at their saved 20 MHz widths.
- Connect the cameras later to map Camera 1-8 MAC addresses to AP associations
  and qualify the final RF layout.

## Official references

- [UniFi WiFi SSID and AP settings](https://help.ui.com/hc/en-us/articles/32065480092951-UniFi-WiFi-SSID-and-AP-Settings-Overview)
- [UniFi wireless meshing](https://help.ui.com/hc/en-us/articles/115002262328-Considerations-for-Optimal-Wireless-Mesh-Networks)
- [UniFi update controls](https://help.ui.com/hc/en-us/articles/7605005245975-UniFi-Updates)
- [Official UniFi API overview](https://help.ui.com/hc/en-us/articles/30076656117655-Getting-Started-with-the-Official-UniFi-API)
- [Self-hosting UniFi](https://help.ui.com/hc/en-us/articles/34210126298775-Self-Hosting-UniFi)
- [Remote API connector](https://developer.ui.com/site-manager/v1.0.0/connectorget)
- [Network device details](https://developer.ui.com/network/v10.3.58/getadopteddevicedetails)
- [Network device statistics](https://developer.ui.com/network/v9.5.21/getdevicelateststatistics)
- [Connected clients](https://developer.ui.com/network/v9.5.21/getconnectedclientoverviewpage)
