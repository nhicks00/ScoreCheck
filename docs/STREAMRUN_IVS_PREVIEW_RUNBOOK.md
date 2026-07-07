# StreamRun IVS Preview Runbook (Obsolete)

The Amazon IVS preview layer was replaced by self-hosted MediaMTX, so the IVS
destination setup, IVS signing, and IVS validation steps that used to live here no
longer apply.

Current documentation:

- MediaMTX droplet setup, StreamRun RTMP destination values, encoder settings, and
  the verification checklist: `docs/MEDIAMTX_DIGITALOCEAN_SETUP.md`
- Remote commentary over the WHEP feed: `docs/COMMENTARY_WORKFLOW.md`

Still-relevant lesson retained from the IVS era: when sending local test video into
StreamRun, do not use this Mac's FFmpeg native SRT output (its protocol list has
`srtp`, not `srt`) — use a local UDP MPEG-TS handoff into `srt-live-transmit` with
`pkt_size=1316`, and use the `inputstream-1` element's runtime stream key, not the
top-level instance stream key.
