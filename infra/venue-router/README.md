# Venue Router Speedify Routing

Production camera traffic must use Speedify without making the bonded tunnel
the default route for laptops, camera control pages, or other venue devices.
The router therefore policy-routes only these ingest flows:

- UDP `8890` to the MediaMTX ingest address for SRT callers.
- TCP `1935` to the MediaMTX ingest address for RTMP publishers.

Run the route tool before cameras start. It refuses a live migration because
moving established RTMP/SRT sessions together produces a reconnect burst and
can trigger a retransmission spiral.

```sh
chmod 0755 scorecheck-speedify-routing.sh
./scorecheck-speedify-routing.sh preflight 85
./scorecheck-speedify-routing.sh apply 85
./scorecheck-speedify-routing.sh status
```

The numeric argument is the worst sustained bonded upload measured at the
venue before cameras start. The default floor is 75 Mbps for the current
nominal 30 Mbps camera payload. Do not substitute an ISP plan speed or a
single momentary speed-test peak.

Emergency fail-open reset:

```sh
./scorecheck-speedify-routing.sh reset
```

Reset removes only the ScoreCheck policy rules, clears stale ingest
connections, and disconnects Speedify. Camera publishers can then reconnect
over the router's ordinary route.

## Required Speedify settings

- Mode: Speed.
- Transport: UDP.
- Default route: Off.
- PEP: On for RTMP.
- Target connections: Automatic.

Do not use Auto transport for this production path. In the July 12 test it
selected TCP and caused severe loss inside the nested camera-LAN tunnel.
Multi-TCP carried the five direct publishers but made the WireGuard handshake
stale and dropped listener-camera paths, so it is also rejected.

## Temporary MAKI cameras

The MAKI Live cameras are listener-only and currently require WireGuard from
the ingest VPS to the venue LAN. That temporary test topology is not included
in the production policy tool. The final two-Mevo/six-AVKANS topology sends all
eight feeds directly to RTMP/SRT ingest and must be requalified through
Speedify when the remaining AVKANS cameras arrive.

The first July 12 home-network attempt could sustain the three direct SRT
callers and, after staged reconnects, the five direct publishers. Routing the
temporary WireGuard-carried listeners through the same tunnel raised Speedify
input to roughly 77 Mbps for a nominal 30 Mbps payload and dropped SRT paths.

The overnight qualification uses the supported split instead: exactly five
direct publishers are source-and-port policy-routed through Speedify, while
the three temporary MAKI listener pulls use the ordinary WireGuard route. The
router default route and operator devices remain direct. This produced all
eight healthy raw feeds while keeping exactly five camera flows in table 900.
It qualifies selective routing for the current test mix, not the final
two-Mevo/six-AVKANS topology.

During a soak, run `scorecheck-speedify-soak-recorder.sh` on the router. It
records Speedify state, rule/flow counts, interface counters, WireGuard
handshake age, and load without collecting credentials or payloads.
