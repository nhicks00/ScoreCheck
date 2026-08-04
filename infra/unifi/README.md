# ScoreCheck UniFi control plane

ScoreCheck uses Official UniFi Hosting as the persistent controller for the
three Ubiquiti UK-Ultra access points. This is deliberately separate from the
temporary DigitalOcean event stack.

## Operating boundary

- No MacBook or local UniFi Network Server is required during an event.
- No CloudKey or other travel hardware is added.
- No controller Droplet is created or destroyed with an event.
- The hosted controller and its protected API key persist between events.
- The APs retain their last applied configuration when the controller is
  temporarily unreachable, so media does not depend on the API.
- Initial adoption and settings changes use the authenticated UniFi UI. Routine
  readiness, monitoring, and evidence are read-only API operations.

Official UniFi Hosting is a paid Ubiquiti service. Creating the subscription is
the only billing action in this design and requires Nathan's explicit approval
at the purchase screen.

## One-time commissioning

1. Power all three UK-Ultra APs from the PoE switch or injectors and give their
   upstream network normal Internet access.
2. Create the Official UniFi Hosting instance and its first ScoreCheck site.
3. Remotely adopt the three APs and rename them `scorecheck-ap-1`,
   `scorecheck-ap-2`, and `scorecheck-ap-3`.
4. Apply the camera radio baseline from
   `docs/PEPLINK_BR1_PRO_5GK_HW3_COMMISSIONING_PLAN.md`: wired uplinks, mesh off,
   a dedicated 5 GHz WPA2 camera SSID, fixed non-DFS 40 MHz channels, medium
   transmit power, and no automatic channel changes during coverage.
5. Create a dedicated read-only official API key.
6. Record the hosted console id, local Network site UUID, and each AP's device
   UUID and MAC address in the protected production monitoring source.
7. Confirm the API reports each AP as `ONLINE` with a fresh heartbeat, then set
   `MONITOR_UNIFI_REQUIRED=true`.

The API key must never be committed, printed in evidence, or passed to Caddy,
Prometheus, browser code, or the event router.

## Protected monitoring contract

The observability service consumes these values from its mode-0600 environment:

```dotenv
MONITOR_UNIFI_REQUIRED=true
MONITOR_UNIFI_API_KEY=<protected official API key>
MONITOR_UNIFI_HOST_ID=<Official UniFi Hosting console id>
MONITOR_UNIFI_SITE_ID=<Network site UUID>
MONITOR_UNIFI_ACCESS_POINTS_JSON=[{"name":"scorecheck-ap-1","deviceId":"<uuid>","macAddress":"<mac>"},{"name":"scorecheck-ap-2","deviceId":"<uuid>","macAddress":"<mac>"},{"name":"scorecheck-ap-3","deviceId":"<uuid>","macAddress":"<mac>"}]
MONITOR_UNIFI_POLL_INTERVAL_MS=30000
```

All four identity/credential values are atomic: partial configuration is
rejected. The AP names, UUIDs, and MACs must each be unique, and exactly three
APs are required.

## Automatic event behavior

`eventctl up` deploys the existing observability service. The service reads the
Official UniFi API every 30 seconds through Ubiquiti's remote connector and adds
the following to `/v1/snapshot` and Prometheus:

- controller reachability;
- expected and online AP count;
- AP model, firmware, state, IP, heartbeat, CPU, memory, and uplink rates;
- radio transmit-retry percentage;
- connected clients and each client's `uplinkDeviceId`, which identifies its AP.

Production stack verification and soak admission require `unifi.state=HEALTHY`
when `MONITOR_UNIFI_REQUIRED=true`. Alerts use plain operator language for:

- hosted controller/API unavailable;
- an expected AP offline;
- sustained radio retries above 25 percent.

Event teardown preserves normal monitoring evidence, destroys the temporary
DigitalOcean fleet only after the protected lifecycle confirmation, and leaves
Official UniFi Hosting untouched. No UniFi setup or teardown step is required
for later events beyond powering and cabling the APs.

## Remaining live step

The code path can be validated without hardware, but real host/site/device IDs
cannot be invented. Live commissioning starts only after all three APs are
powered and online. Cameras are not required for adoption; they are required
later to map Camera 1-8 MAC addresses to AP associations and qualify the RF
layout.

## Official references

- [Official UniFi Hosting setup](https://help.ui.com/hc/en-us/articles/4415364143511-Getting-Started-with-Official-UniFi-Hosting)
- [Official UniFi API overview](https://help.ui.com/hc/en-us/articles/30076656117655-Getting-Started-with-the-Official-UniFi-API)
- [Remote API connector](https://developer.ui.com/site-manager/v1.0.0/connectorget)
- [Network device details](https://developer.ui.com/network/v10.3.58/getadopteddevicedetails)
- [Network device statistics](https://developer.ui.com/network/v9.5.21/getdevicelateststatistics)
- [Connected clients](https://developer.ui.com/network/v9.5.21/getconnectedclientoverviewpage)
