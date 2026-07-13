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

The July 12 home-network test could sustain the three direct SRT callers and,
after staged reconnects, the five direct publishers. Adding the temporary
WireGuard-carried listeners exceeded the usable bonded path: tunnel input rose
to roughly 77 Mbps for a nominal 30 Mbps payload and SRT paths dropped. The
router was restored to direct routing with Speedify disconnected; all eight
raw feeds recovered.
