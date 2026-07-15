# ScoreCheck Commentary Transport

This is the self-hosted LiveKit audio control plane. It is intentionally
separate from MediaMTX and compositor hosts so camera, encoder, or ingest
failures do not remove commentator audio.

- Signal endpoint: `wss://rtc.beachvolleyballmedia.com`
- TURN/TLS: `turn.beachvolleyballmedia.com:443`
- TURN/UDP: port `3478`
- WebRTC fallback: TCP `7881`
- WebRTC media: UDP `50000-60000`

The checked-in stack is based on LiveKit's official VM generator with image
versions and digests pinned for Gate 1. Secrets are rendered only into the
gitignored `.generated` directory and the remote `livekit.yaml`.

Deployment requires the API keypair and public IP in the environment:

```bash
LIVEKIT_COMMENTARY_API_KEY=... \
LIVEKIT_COMMENTARY_API_SECRET=... \
LIVEKIT_COMMENTARY_SSH_HOST=root@SERVER_IPV4 \
LIVEKIT_COMMENTARY_PUBLIC_IP=RESERVED_IPV4 \
LIVEKIT_COMMENTARY_RTC_HOST=rtc.beachvolleyballmedia.com \
LIVEKIT_COMMENTARY_TURN_HOST=turn.beachvolleyballmedia.com \
./deploy.sh
```

The current Gate 1 node is a `2 vCPU / 2 GB` DigitalOcean droplet in `sfo2`
at $18/month. It is sized for the audio-only commentary workload; compositor
egress does not run here. Each service has an in-container health check and
Docker logs are capped at four 25 MB files.
