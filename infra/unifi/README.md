# ScoreCheck UniFi control plane

ScoreCheck manages the three Ubiquiti UK-Ultra access points with UniFi OS
Server. The existing macOS controller is the one-time commissioning environment.
The event target is the same protected controller state restored on the temporary
observability Droplet, so the MacBook and extra controller hardware are not part
of event operation.

## Operating boundary

- The APs keep their last applied configuration if the controller is unavailable;
  camera media does not depend on the controller or monitoring API.
- No CloudKey or other travel hardware is required.
- No paid Official UniFi Hosting subscription is required.
- The controller backup and API credential persist securely between events, but
  controller compute exists only while the event stack is running.
- Initial adoption and radio changes use the authenticated UniFi UI. Routine
  readiness, monitoring, and evidence use the official API.
- The event lifecycle must restore and start the controller before setting
  `MONITOR_UNIFI_REQUIRED=true`, and export its state before provider teardown.

The controller restore/export lifecycle step is not automated yet. Until it is,
the Mac controller is suitable for commissioning only and UniFi must not be
claimed as a production-required event dependency.

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
5. Create a dedicated read-only official API key.
6. Record the controller host id, Network site UUID, and each AP device UUID and
   MAC address in the protected production monitoring source.
7. Confirm the API reports each AP as `ONLINE` with a fresh heartbeat before
   setting `MONITOR_UNIFI_REQUIRED=true`.

The API key must never be committed, printed in evidence, or passed to Caddy,
Prometheus, browser code, or the event router.

## Applied AP baseline

`UK Ultra 1` was commissioned on 2026-08-04 with:

- outdoor mode and Ubiquiti panel antenna;
- DHCP and wired uplink;
- mesh parent and mesh connect disabled;
- 2.4 GHz radio disabled;
- 5 GHz channel 157, 20 MHz, medium transmit power;
- existing `BVM 1` Wi-Fi name and credentials preserved;
- existing stable AP firmware preserved.

The 20 MHz profile was saved while AP1 was offline. Its last live check was at
157/40 MHz, so verify 157/20 MHz when all three APs are powered together.

`UK Ultra 2` was commissioned on 2026-08-04 with:

- outdoor mode and Ubiquiti panel antenna;
- DHCP and wired uplink;
- mesh parent and mesh connect disabled;
- 2.4 GHz radio disabled;
- 5 GHz channel 149, 20 MHz, medium transmit power;
- existing `BVM 2` Wi-Fi name and credentials preserved;
- existing stable AP firmware preserved.

The 20 MHz profile was saved while AP2 was offline. Its last live check was at
149/40 MHz, so verify 149/20 MHz when all three APs are powered together.

`UK Ultra 3` was commissioned on 2026-08-04 with:

- outdoor mode and Ubiquiti omni antenna;
- DHCP and wired uplink;
- mesh parent and mesh connect disabled;
- 2.4 GHz radio disabled;
- 5 GHz channel 161, 20 MHz, medium transmit power;
- existing `BVM 3` Wi-Fi name and credentials preserved;
- existing stable AP firmware preserved.

AP3 was live-verified `Up to date` on wired GbE at `192.168.0.95`, with no
2.4 GHz channel and live 5 GHz channel 161/20 MHz.

## Protected monitoring contract

The observability service consumes these values from its mode-0600 environment:

```dotenv
MONITOR_UNIFI_REQUIRED=true
MONITOR_UNIFI_API_KEY=<protected official API key>
MONITOR_UNIFI_HOST_ID=<UniFi OS Server console id>
MONITOR_UNIFI_SITE_ID=<Network site UUID>
MONITOR_UNIFI_ACCESS_POINTS_JSON=[{"name":"UK Ultra 1","deviceId":"<uuid>","macAddress":"<mac>"},{"name":"UK Ultra 2","deviceId":"<uuid>","macAddress":"<mac>"},{"name":"UK Ultra 3","deviceId":"<uuid>","macAddress":"<mac>"}]
MONITOR_UNIFI_POLL_INTERVAL_MS=30000
```

All four identity/credential values are atomic: partial configuration is
rejected. The AP names, UUIDs, and MACs must each be unique, and exactly three
APs are required.

## Automatic event behavior

After the controller lifecycle step is implemented, `eventctl up` restores the
controller on the observability host before monitoring becomes required. The
monitor reads the official UniFi API every 30 seconds and adds the following to
`/v1/snapshot` and Prometheus:

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

Event teardown must export the controller state before destroying the temporary
DigitalOcean fleet. The APs retain their last configuration while powered down.

## Remaining live steps

- Power all three APs together and verify the saved 149/157/161 MHz channel
  plan after an event-location RF scan.
- Create the protected read-only API credential and capture all three real
  device UUID/MAC bindings.
- Automate controller restore, health verification, backup export, and teardown
  in the protected event lifecycle.
- Connect the cameras later to map Camera 1-8 MAC addresses to AP associations
  and qualify the final RF layout.

## Official references

- [Official UniFi API overview](https://help.ui.com/hc/en-us/articles/30076656117655-Getting-Started-with-the-Official-UniFi-API)
- [Self-hosting UniFi](https://help.ui.com/hc/en-us/articles/34210126298775-Self-Hosting-UniFi)
- [Remote API connector](https://developer.ui.com/site-manager/v1.0.0/connectorget)
- [Network device details](https://developer.ui.com/network/v10.3.58/getadopteddevicedetails)
- [Network device statistics](https://developer.ui.com/network/v9.5.21/getdevicelateststatistics)
- [Connected clients](https://developer.ui.com/network/v9.5.21/getconnectedclientoverviewpage)
