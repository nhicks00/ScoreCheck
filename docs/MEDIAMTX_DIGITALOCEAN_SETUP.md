# MediaMTX on DigitalOcean Setup Runbook

This is the complete, copy-pasteable runbook for standing up the self-hosted MediaMTX
video layer that replaced Amazon IVS. One droplet relays all eight court feeds:

```text
Cameras/StreamRun -> RTMP/SRT ingest -> MediaMTX droplet -> WHEP (sub-second) + LL-HLS -> ScoreCheck players
```

The app is fully env-driven: nothing in the codebase hardcodes the droplet address.
Provision the droplet, then set the Vercel env vars listed at the end.

## 1. Droplet Sizing

MediaMTX only relays here — it never transcodes — so CPU stays low and bandwidth is
the real constraint.

- Size: 2 vCPU / 4 GB RAM ("Basic" shared CPU, premium AMD/Intel) is comfortable for
  8 courts plus a few dozen watchers. That tier is roughly $24-28/mo.
- CPU math: relaying is packet forwarding; 8 ingest streams at 4 Mbps plus ~30 viewers
  typically stays under 25% of 2 vCPU.
- Bandwidth math: every viewer costs approximately the stream bitrate.
  - Ingest: 8 courts x 4 Mbps = 32 Mbps in (inbound is free on DO).
  - Watch: each scorer/commentator viewer of a 4 Mbps court feed = 4 Mbps out.
    20 concurrent viewers = 80 Mbps out = ~36 GB/hour.
  - DO droplet transfer allowance: the 2 vCPU / 4 GB tier includes 4 TB/mo pooled.
    A 10-hour event day at 80 Mbps out consumes ~360 GB. A full weekend stays well
    under 1.5 TB. Overage is $0.01/GB, so even a blowout weekend is cheap.
- Region: pick the DO region closest to the venue (for AVP Denver: `sfo3` or `nyc3`;
  there is no Denver region — `sfo3` is usually the better RTT from Colorado).
- OS: Ubuntu 24.04 LTS x64.

Create the droplet with your SSH key, then log in as root (or a sudo user).

## 2. Install MediaMTX

MediaMTX ships as a single static binary. Install from the GitHub release:

```bash
MEDIAMTX_VERSION=v1.9.3   # check https://github.com/bluenviron/mediamtx/releases for latest
curl -fL -o /tmp/mediamtx.tar.gz \
  "https://github.com/bluenviron/mediamtx/releases/download/${MEDIAMTX_VERSION}/mediamtx_${MEDIAMTX_VERSION}_linux_amd64.tar.gz"
sudo mkdir -p /usr/local/bin /etc/mediamtx
sudo tar -xzf /tmp/mediamtx.tar.gz -C /tmp
sudo mv /tmp/mediamtx /usr/local/bin/mediamtx
sudo mv /tmp/mediamtx.yml /etc/mediamtx/mediamtx.yml.dist   # keep the reference copy
sudo useradd --system --no-create-home --shell /usr/sbin/nologin mediamtx || true
```

Systemd unit — write `/etc/systemd/system/mediamtx.service`:

```ini
[Unit]
Description=MediaMTX media server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=mediamtx
ExecStart=/usr/local/bin/mediamtx /etc/mediamtx/mediamtx.yml
Restart=always
RestartSec=2
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
```

## 3. MediaMTX Configuration

Write `/etc/mediamtx/mediamtx.yml`. Replace `DROPLET_PUBLIC_IP`, the credentials, and
the domain before starting. This config gives you: RTMP + SRT ingest, WHEP (WebRTC)
playback, LL-HLS playback, publish auth, and read auth.

```yaml
###############################################
# General
logLevel: info

# API is handy for debugging; keep it bound to localhost only.
api: yes
apiAddress: 127.0.0.1:9997

###############################################
# Ingest protocols
rtmp: yes
rtmpAddress: :1935

srt: yes
srtAddress: :8890

###############################################
# WebRTC (WHEP) playback
webrtc: yes
webrtcAddress: :8889
# Advertise the droplet public IP in ICE candidates so browsers can connect.
webrtcAdditionalHosts: [DROPLET_PUBLIC_IP]
# Single UDP port for all WebRTC traffic (open it in the firewall).
webrtcLocalUDPAddress: :8189
webrtcIPsFromInterfaces: no

###############################################
# HLS playback (Low-Latency HLS)
hls: yes
hlsAddress: :8888
hlsVariant: lowLatency
hlsSegmentCount: 7
hlsSegmentDuration: 1s
hlsPartDuration: 200ms
hlsAllowOrigin: '*'

###############################################
# Authentication
# Publishers (StreamRun / OBS / cameras) and readers (the ScoreCheck app)
# use different credentials. Readers pass user/pass as query parameters,
# which MediaMTX accepts on its HTTP endpoints (WHEP and HLS).
authInternalUsers:
  # Publish credentials
  - user: publish
    pass: CHANGE_ME_PUBLISH_PASS
    permissions:
      - action: publish
  # Read credentials used by the website players
  - user: scorecheck
    pass: CHANGE_ME_READ_PASS
    permissions:
      - action: read
  # Allow localhost (Caddy health checks, debugging) full read
  - user: any
    ips: ['127.0.0.1', '::1']
    permissions:
      - action: read
      - action: playback

###############################################
# Paths: one per court. all_others is a catch-all so ad-hoc test paths
# (e.g. "test") also work with the same credentials.
pathDefaults:
  source: publisher

paths:
  court1:
  court2:
  court3:
  court4:
  court5:
  court6:
  court7:
  court8:
  all_others:
```

Notes:

- Per-court paths match the app default stream paths (`court1`..`court8`). If you
  rename a path here, set the matching `stream_path` on the court in the admin
  dashboard or `COURT_{N}_STREAM_PATH` in Vercel.
- `all_others` keeps the door open for scratch/test paths without editing the file.
- If your MediaMTX version predates `authInternalUsers` (older than v1.9), the
  equivalent legacy keys are `publishUser`/`publishPass` and `readUser`/`readPass`
  in `pathDefaults`.

Start it:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now mediamtx
sudo systemctl status mediamtx --no-pager
journalctl -u mediamtx -f   # watch logs during first tests
```

## 4. TLS via Caddy (required for production)

The ScoreCheck site is served over https on Vercel. Browsers block mixed content, so
`http://droplet-ip:8889` WHEP/HLS URLs will NOT load from the production site — they
only work for local/manual testing. Production needs a domain with TLS.

1. Create a DNS A record, e.g. `live.beachvolleyballmedia.com -> DROPLET_PUBLIC_IP`.
2. Install Caddy (automatic Let's Encrypt):

```bash
sudo apt-get update
sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt-get update
sudo apt-get install -y caddy
```

3. `/etc/caddy/Caddyfile` — one https domain routing WHEP to :8889 and HLS to :8888:

```caddyfile
live.beachvolleyballmedia.com {
        # WHEP: POST /{path}/whep (plus PATCH/DELETE for the WHEP session)
        @whep path_regexp whep ^/[^/]+/whep.*$
        reverse_proxy @whep 127.0.0.1:8889

        # Everything else is HLS: /{path}/index.m3u8 and segments
        reverse_proxy 127.0.0.1:8888
}
```

```bash
sudo systemctl reload caddy
```

With this unified domain:

- WHEP base URL = `https://live.beachvolleyballmedia.com`
- HLS base URL = `https://live.beachvolleyballmedia.com`

(The app builds `{base}/{path}/whep` and `{base}/{path}/index.m3u8`, so both bases
can point at the same Caddy domain.)

## 5. Firewall (ufw)

```bash
sudo ufw allow 22/tcp     # SSH
sudo ufw allow 80/tcp     # Caddy HTTP (ACME challenges + redirect)
sudo ufw allow 443/tcp    # Caddy HTTPS (WHEP + HLS)
sudo ufw allow 1935/tcp   # RTMP ingest (StreamRun/OBS/cameras)
sudo ufw allow 8890/udp   # SRT ingest
sudo ufw allow 8189/udp   # WebRTC ICE (WHEP media)
sudo ufw enable
sudo ufw status
```

Do NOT open 8888/8889 publicly once Caddy is in front — keep WHEP/HLS behind TLS.
(For pre-TLS smoke tests you can temporarily `sudo ufw allow 8888/tcp 8889/tcp`,
then remove those rules.)

## 6. Encoder / Ingest Guidance

For OBS, cameras, or the StreamRun preview output branch publishing to MediaMTX:

- Server: `rtmp://DROPLET_PUBLIC_IP:1935` (or the domain once DNS exists).
- Stream key: `court{n}?user=publish&pass=CHANGE_ME_PUBLISH_PASS`.
- Keyframe interval: 1 second. This is the single most important setting — WHEP
  startup and HLS part duration both depend on it.
- Rate control: CBR.
- Bitrate: 3-6 Mbps for 1080p (4 Mbps is the sweet spot for volleyball motion);
  2.5-3.5 Mbps for 720p.
- x264 tune `zerolatency`, preset `veryfast`, profile high (baseline also fine),
  B-frames 0.
- Audio: AAC 128 kbps 48 kHz stereo for RTMP/HLS. Note that MediaMTX does not
  transcode: WebRTC cannot carry AAC, so an AAC-only source gives video-only WHEP
  (HLS keeps full audio). That is fine for the scorer preview, which is video-first.
  If commentators need in-browser audio on the WHEP feed, publish Opus audio
  (e.g. SRT/RTSP ingest with `-c:a libopus`) instead of AAC.

SRT alternative (more resilient than RTMP over lossy venue uplinks):

```text
srt://DROPLET_PUBLIC_IP:8890?streamid=publish:court1:publish:CHANGE_ME_PUBLISH_PASS&latency=200
```

(MediaMTX streamid format: `publish:{path}:{user}:{pass}`.)

## 7. Vercel Environment Variables

Set these on the Vercel project (production + preview) once the droplet exists:

| Key | Value |
| --- | --- |
| `MEDIAMTX_WHEP_BASE_URL` | `https://live.beachvolleyballmedia.com` |
| `MEDIAMTX_HLS_BASE_URL` | `https://live.beachvolleyballmedia.com` |
| `MEDIAMTX_READ_USER` | `scorecheck` |
| `MEDIAMTX_READ_PASS` | the read password from mediamtx.yml |
| `MEDIAMTX_RTMP_INGEST_BASE` | `rtmp://DROPLET_PUBLIC_IP:1935` (setup scripts/paste sheets only) |
| `COURT_{1-8}_STREAM_PATH` | optional; only if a court uses a non-default path |

For direct-IP testing before TLS exists (local dev only, not production):
`MEDIAMTX_WHEP_BASE_URL=http://DROPLET_PUBLIC_IP:8889` and
`MEDIAMTX_HLS_BASE_URL=http://DROPLET_PUBLIC_IP:8888`.

The read credentials are appended by the server as `?user=...&pass=...` query
parameters — MediaMTX accepts query-param credentials on its HTTP endpoints. The
URLs are only ever issued by the authenticated `stream-source` API routes, never
baked into client bundles.

## 8. Verification Checklist

1. Publish a test pattern to court1 from any machine with ffmpeg:

```bash
ffmpeg -hide_banner -re \
  -f lavfi -i "smptebars=size=1280x720:rate=30" \
  -f lavfi -i "sine=frequency=1000:sample_rate=48000" \
  -c:v libx264 -preset veryfast -tune zerolatency -pix_fmt yuv420p \
  -g 30 -keyint_min 30 -sc_threshold 0 -bf 0 \
  -b:v 3000k -maxrate 3000k -bufsize 6000k \
  -c:a aac -b:a 128k -ar 48000 -ac 2 \
  -f flv "rtmp://DROPLET_PUBLIC_IP:1935/court1?user=publish&pass=CHANGE_ME_PUBLISH_PASS"
```

2. MediaMTX logs show the publisher: `journalctl -u mediamtx -n 20` should contain
   `is publishing to path 'court1'`.
3. HLS playback check (should return a playlist, HTTP 200):

```bash
curl -fsS "https://live.beachvolleyballmedia.com/court1/index.m3u8?user=scorecheck&pass=CHANGE_ME_READ_PASS" | head
```

4. WHEP endpoint check (a bare GET/POST without SDP returns 4xx but NOT a connection
   error; 404 means the path is not live):

```bash
curl -is -X POST "https://live.beachvolleyballmedia.com/court1/whep?user=scorecheck&pass=CHANGE_ME_READ_PASS" \
  -H "Content-Type: application/sdp" --data "" | head -1
```

5. App-level checks after setting the Vercel env vars:
   - `/admin/stream-preview/1` shows the test pattern with the `Live — low latency`
     status chip (WHEP) or `Live — HLS` (fallback).
   - A scorer session on court 1 with `Watch stream + score` selected shows the feed.
   - `scorer_session_events` receives `video_source_issued` rows.
6. Latency sanity check: display a running clock in the test feed and compare against
   the WHEP player — expect roughly 0.5-1 second glass-to-glass.
7. Kill the ffmpeg publisher and confirm the player shows `Stream offline — retrying`,
   then recovers automatically when publishing resumes.

## 9. Operations Notes

- Restart: `sudo systemctl restart mediamtx` (viewers auto-reconnect).
- Upgrade: download the new release binary over `/usr/local/bin/mediamtx`, restart.
- Monitoring: `curl -s 127.0.0.1:9997/v3/paths/list | jq` on the droplet lists active
  paths, publishers, and reader counts.
- StreamRun: point each court's preview output destination at the MediaMTX RTMP
  ingest; `npm run setup:streamrun` generates the paste sheet with per-court values
  when `MEDIAMTX_RTMP_INGEST_BASE` (plus optional `MEDIAMTX_PUBLISH_USER` /
  `MEDIAMTX_PUBLISH_PASS`) is set locally.
- Commentary workflow and latency budget: see `docs/COMMENTARY_WORKFLOW.md`.
