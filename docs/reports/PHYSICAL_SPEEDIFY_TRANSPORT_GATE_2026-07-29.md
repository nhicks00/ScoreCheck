# Physical Eight-Camera Speedify Transport Gate

Date: 2026-07-29 UTC  
Branch: `codex/reliability-qualification`  
Result: **No tested transport profile qualified for sustained eight-camera production**

## Scope

This gate used all eight physical cameras at 1920x1080 through the event
router and the temporary DigitalOcean event stack. All camera publishers used
SRT to the protected ingest endpoint:

- Cameras 1-2: Mevo Core, HEVC/AAC;
- Cameras 3-8: AVKANS GO, H.264/AAC.

No synthetic media was used. No YouTube output or LiveKit Egress was started.
All four Speedify input records remained saved as `automatic` throughout the
comparisons. Camera traffic remained fail-closed through Speedify, with the
primary route, blackhole guard table, firewall kill switch, and routing
watchdog active.

The test compared four real router/runtime combinations:

1. Speed mode with single TCP transport;
2. Enhanced Streaming mode with UDP transport;
3. Speed mode with UDP transport;
4. Speed mode with Multi-TCP transport.

The gate also tested an official GL.iNet/Speedify recommendation to disable
GL.iNet Network Acceleration. That experiment did not improve the physical
workload and was fully reverted in Git and on the router.

## Media Runtime

Before the transport comparison, the MediaMTX SRT listener recovery window was
increased from approximately 2.5 seconds to 8 seconds. This was a
MediaMTX-only cutover:

| Property | Value |
| --- | --- |
| Cutover started | `2026-07-29T03:09:56.179Z` |
| Healthy | `2026-07-29T03:10:01.997Z` |
| Image | `scorecheck/mediamtx:1.19.2-avkans-adts-gop2-srt8s` |
| Image digest | `sha256:c218804eb5cd4c28336ca3277d2f155ae648dfa2f106f3cf636c11c571d9cebc` |
| Container ID | `5869b17dbfda04788f7f12928af8dea308183de6663637feeafe0a5fad2e106b` |
| MediaMTX restart count | `0` |
| MediaMTX zombies | `0` |

All eight physical sources returned within approximately four seconds after
that service cutover. The longer receiver window did not prevent subsequent
transport collapse, so it is not a substitute for adequate venue-router
capacity.

The raw SRT `packetsReceivedDrop` counter includes retransmissions that arrive
after the receiver has already accepted or acknowledged their sequence. It is
therefore preserved as transport evidence but is not treated by itself as
unrecovered viewer loss. Readiness, source bitrate, RTT, analyzer process
generation, branch continuity, and browser evidence remain required.

## Results

| Profile | Best observed state | Failure evidence | Verdict |
| --- | --- | --- | --- |
| Speed + single TCP | Eight paths remained ready during the 315-second control. | AVKANS loss/retransmit counters grew rapidly; C4/C6/C7/C8 analyzers restarted; final AVKANS RTT reached 555-798 ms. | FAIL |
| Enhanced Streaming + UDP | The tunnel reconnected with every saved input still Automatic. | Queue reached 20,220 packets; C4 and C7 were not ready; several AVKANS streams delivered near-zero bitrate; RTT reached 1,878 ms. | FAIL |
| Speed + UDP | Queue fell briefly after the mode change. | Queue remained 13,475 at the endpoint; AVKANS bitrates stayed severely reduced; RTT reached 2,359 ms. | FAIL |
| Speed + Multi-TCP | Strong warmup: eight ready paths, 27.45 Mbps aggregate send, 68.13 Mbps estimated upload, queue 66, AVKANS RTT 86-106 ms. | After about ten minutes, send fell to 8.43 Mbps, queue reached 9,695, router health became unknown, AVKANS bitrate collapsed, and analyzer restarts resumed. | FAIL |

### Speed + single TCP control

The synchronized control ran from `03:10:52.679Z` through
`03:16:07.679Z`, or 315 seconds. Cameras 1 and 2 had no analyzer restarts.
The AVKANS results were materially worse:

| Camera | Received delta | Lost delta | Retransmitted delta | Dropped delta | Analyzer restart delta | Final RTT |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 3 | 118,767 | 41,027 | 38,666 | 8,544 | 0 | 754.5 ms |
| 4 | 115,735 | 47,644 | 42,128 | 8,563 | 1 | 676.3 ms |
| 5 | 123,968 | 32,260 | 34,851 | 8,284 | 0 | 798.1 ms |
| 6 | 116,601 | 39,908 | 35,463 | 8,016 | 1 | 555.1 ms |
| 7 | 114,788 | 57,716 | 50,488 | 9,915 | 2 | 606.2 ms |
| 8 | 118,242 | 57,334 | 53,193 | 11,197 | 1 | 740.6 ms |

This profile did not provide reliable AVKANS delivery despite zero reported
aggregate tunnel loss at the sampled endpoint.

### Enhanced Streaming + UDP

The Enhanced Streaming comparison was not skipped. At the endpoint
(`03:21:37.660Z`):

- aggregate send had fallen to 6.23 Mbps;
- estimated upload had fallen to 9.73 Mbps;
- the Speedify read queue was 20,220 packets;
- C4 and C7 were offline;
- C3/C5/C8 were delivering only approximately 12/18/73 kbps;
- AVKANS RTT reached approximately 1.88 seconds;
- router load was 5.19.

Enhanced Streaming is generally intended to favor detected live streams. This
gate did not prove that feature harmful: it proved only that the physical
Enhanced-plus-UDP pairing could not overcome the router's saturated processing
path. A later A/B step left the router and checked-in watchdog on Speed plus
Multi-TCP, but that mode also failed endurance and is not a qualified
production selection.

Enhanced Streaming with Multi-TCP has not yet been tested. The router reached
0% idle CPU in the strongest sustained profile, so another mode permutation
is not justified until the router-capacity constraint is addressed. Once the
tunnel runs on hardware with measured headroom, Enhanced plus Multi-TCP should
be compared against plain Speed plus Multi-TCP with the same eight physical
cameras and all saved inputs Automatic.

### Speed + UDP

Changing only the mode back to Speed did not recover the loaded UDP tunnel. At
`03:23:37.679Z`, the queue was still 13,475 packets and all six AVKANS sources
were far below their approximately 3 Mbps configured profiles. Camera 5 RTT
was 2,358.6 ms. This excludes Enhanced Streaming alone as the sole cause of
the UDP failure.

### Speed + Multi-TCP

Multi-TCP produced the best initial physical result. At the formal start
(`03:27:07.679Z`):

- all eight raw paths were ready;
- all eight had positive expected-class bitrate;
- Camera 3-8 bitrates were approximately 3.23 Mbps each;
- the read queue was 66 packets;
- aggregate send was 27.45 Mbps;
- estimated upload was 68.13 Mbps;
- AVKANS RTT was 86-106 ms;
- router load was 3.03;
- no media-path frame errors were present.

The profile did not survive the sustained window. At the final direct monitor
snapshot (`03:38:22.540Z`):

- aggregate send was only 8.43 Mbps despite a 57.28 Mbps estimate;
- the read queue was 9,695 packets;
- router load was 6.50;
- monitor state for the router was `UNKNOWN` because current management data
  had stopped arriving;
- C3-C8 bitrates had collapsed to approximately 35-283 kbps;
- C3-C8 RTT was approximately 668-868 ms;
- analyzer restart deltas from the formal start were C3 `+3`, C4 `+5`, C5
  `+4`, C6 `+6`, C7 `+2`, and C8 `+5`.

The independent direct router inspection during the collapse found:

- 0% CPU idle;
- approximately 43.7% user CPU, 31.2% system CPU, and 21.8% softirq;
- Speedify using approximately 37.5% CPU;
- load near 6.9 and later above 12;
- approximately 73 MB memory available and no swap;
- CPU thermal telemetry around 73.9 C;
- management SSH repeatedly timing out while the router's outbound monitor
  heartbeat still reached the observability service.

This is a sustained-processing failure, not evidence that the home Internet
service lacked raw upload capacity. The same window reported approximately
57-72 Mbps estimated upload while source payload was approximately 22-33
Mbps. The leading proven bottleneck is the GL-XE3000's processing of the
encrypted bonded tunnel and packet workload.

## Network Acceleration Experiment

Speedify documents a possible interaction between its PEP support and GL.iNet
Network Acceleration. A minimal hard cut was therefore tested:

1. commit `9cfef3e50` disabled and stopped `shortcut-fe` before Speedify
   configuration;
2. router script SHA `3163fd1abf37e82010d93a01f52d456943fd0a3af19a1be5463e8fa257911c82`
   was verified live;
3. the router rebooted and returned with four saved Automatic inputs,
   Speed/Multi-TCP, PEP enabled, and all fail-closed controls intact.

The physical result did not improve:

- immediate load remained above 9 and reached above 11;
- CPU remained 0% idle;
- queue samples included 8,536, 9,154, 6,042, and 13,378 packets;
- source bitrate and analyzer continuity continued degrading.

The experiment was therefore rejected, not retained as speculative
hardening. Commit `bebbfdb0e` reverts it. The remote Git branch was verified at
`bebbfdb0e99cbff40bf80f7cee210e1f854da349`, and the router was restored to:

- script SHA `0fdabda5b7c0cc0c981de953d4d1c7be2efa31a86d3d30f0ff71fd6553c4612b`;
- `shortcut-fe` enabled;
- Speed mode with Multi-TCP;
- PEP enabled;
- all four saved input priorities `automatic`;
- exact two primary rules and two guard rules;
- active firewall kill switch and one watchdog owner.

After restoration and reboot, router load fell to 0.78 and queue fell to zero.

## Reconnect Finding

The restoration reboot exposed a separate camera-firmware behavior:

- both Mevo cameras automatically opened new SRT flows and returned ready;
- none of Cameras 3-8 opened a new SRT flow;
- the router reported exactly two camera flows, with no server-side raw path
  for Cameras 3-8;
- ingest, Speedify, route guards, and the two Mevo flows were healthy.

This localizes the immediate post-reboot loss to AVKANS publisher recovery,
not MediaMTX listener availability or aggregate bandwidth. Cameras 3-8 need a
physical streaming restart before the eight-camera gate can continue. A
plain-English Pushover request was delivered to the operator. This behavior
must be included in event operations unless a camera firmware/configuration
change proves autonomous reconnect.

## Monitoring Contract Cutover

The idle-output monitoring cutover completed at `04:24Z` from Git revision
`5699ac2bdd57a20368f1c16ca7f6418212cc29c2`:

- the monitor service was the only observability container recreated and
  returned healthy with restart count `0`;
- Prometheus rules increased from `63` to `64` and all rule plus inhibition
  fixtures passed;
- Prometheus, Alertmanager, Caddy, and node-exporter retained their exact
  container identities;
- router heartbeat contract v4 began reporting measured whole-router CPU and
  actual per-uplink tunnel protocol;
- the first stable post-cutover router sample measured `0.324451` CPU usage,
  Speed/Multi-TCP globally, TCP on each connected physical uplink, four of four
  saved inputs Automatic, and zero read-queue packets;
- the primary and guard rule counts remained two each, the kill switch stayed
  active, and both camera protocol lookups remained on `connectify0` table
  `900`;
- all 12 monitor agents remained fresh and no incident or fault gate was
  created.

This telemetry closes the earlier blind spot where Speedify could report
`badCpu=false` while the router had zero idle CPU. During required media,
measured CPU at or above 90% now produces a plain-English venue-router overload
incident.

## Classification

| Gate | Result |
| --- | --- |
| Eight-camera physical source coverage | PASS before transport comparisons |
| 8-second SRT receiver deployment safety | PASS |
| Speed + single TCP sustained quality | FAIL |
| Enhanced Streaming + UDP sustained quality | FAIL |
| Speed + UDP sustained quality | FAIL |
| Speed + Multi-TCP sustained quality | FAIL after strong warmup |
| Router fail-closed controls | PASS |
| All Speedify saved inputs Automatic | PASS |
| Network Acceleration disabled | FAIL / reverted |
| Mevo reconnect after router reboot | PASS |
| AVKANS reconnect after router reboot | FAIL |
| Overall eight-camera transport qualification | FAIL |

## Next Decision

Do not start eight YouTube outputs or expand the program path while the source
transport is failing.

The next physical test should measure the current router's sustainable camera
count as a capacity staircase, or move the Speedify tunnel to a stronger
dedicated router/host and repeat the exact eight-camera gate. The MacBook
should remain off the event data path; a stronger dedicated Speedify device is
the cleaner production comparison. On hardware with headroom, compare
Enhanced plus Multi-TCP with Speed plus Multi-TCP before selecting the event
default. Another permutation on the same saturated dual-core router is lower
value than addressing the proven compute limit.

The AVKANS reconnect failure should be retested independently after Cameras
3-8 are manually restarted. It is a separate release risk even if the router
is replaced.

## Protected Evidence

Protected root:

```text
~/.config/scorecheck/event-stack/events/weekend-dry-run-20260726/
  final-evidence/diagnostic-20260726T2301Z/
  srt8s-transport-gate-20260729T030837Z/
```

Representative artifact hashes:

| Artifact | SHA-256 |
| --- | --- |
| `speed-tcp-control-summary.json` | `536b25c459e85038f4c3209c97e2df6932e4c1eb2a288089c9301447d95cba61` |
| `monitor-streaming-udp-end.json` | `1162bc66936c27cfa8903a2cec2131e6ab8bcabace6ffbcaea1fb7b9c6ca4c4b` |
| `monitor-speed-udp-end.json` | `273cd0b02e53cd605f2aa7ee1d0df4e28af9d506868349863e7d148a7e865f38` |
| `monitor-multitcp-start.json` | `edc663e84471d3be161951288d9c92a4f54060b3a9cc802b56370690c7b6cb5b` |
| `monitor-multitcp-end-direct.json` | `dd51b02fb56b79952e9b6688bffb90f13dd8d1c27efa87d5342c9c28d1a8292b` |
| Network Acceleration evidence manifest | `c8f1db429bb8e0ac89f0bb29c7c852dceec26c5fe8cd694cc2664457ea2843c6` |

The continuous 15-second monitor recorder and 60-second router recorder remain
under the parent diagnostic evidence directory. Raw event evidence is
protected and excluded from Git; this report contains only sanitized values
and hashes.

The monitoring cutover evidence is retained under the same parent at:

```text
monitoring-contract-v4-cutover-20260729T042001Z/
```
