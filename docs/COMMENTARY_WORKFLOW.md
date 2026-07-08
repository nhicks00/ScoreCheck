# Remote Commentary Workflow

How remote commentators call matches without being at the venue, using the MediaMTX
WHEP feed for a sub-second program view, VDO.Ninja for voice, and StreamRun to mix
commentary back over the program feed.

## Architecture

```text
Venue camera ──RTMP/SRT──> MediaMTX droplet ──WHEP (~0.5s)──> Commentator browser
                                                                    │ (watches + talks)
                                                                    ▼
                                                             VDO.Ninja room
                                                                    │ (browser-source /
                                                                    ▼  return feed)
Venue camera ──────────────────────────> StreamRun ── mixes commentary audio over
                                             │        the program feed
                                             ▼
                                YouTube / broadcast destinations
```

Key idea: commentators never watch the YouTube output (10-30 s behind). They watch
the same MediaMTX WHEP feed the scorers use, which is sub-second, so their audio
lines up with the live action when StreamRun mixes it in.

## Commentator Portal (recommended flow)

The portal at `/commentary` wraps the whole commentator workflow behind one
passcode — no admin access, no hand-built links:

1. The producer shares the site URL and the commentator passcode
   (`COMMENTATOR_PASSCODE`).
2. The commentator opens `/commentary`, enters the passcode once (24h cookie),
   and lands on the court dashboard: every court with its current match, score
   snapshot, and stream number.
3. They pick their court → `/commentary/court/{n}`, which gives them everything
   on one screen:
   - the low-latency MediaMTX feed (WHEP first, HLS fallback) — confirm the
     status chip reads `Live — low latency`;
   - the fan scorer session, claimed inline with one tap (they score the match
     they are calling, in `courtside` mode so no duplicate video loads);
   - the VDO.Ninja audio room for that court (`{VDO_ROOM_PREFIX}{n}`, e.g.
     `BVMCOURT3`) embedded in the right rail, with "Open in new tab" and copy
     buttons if the embed cannot reach the microphone.
4. Headphones always — no open speakers. Keep the program audio muted in the
   player and rely on VDO.Ninja monitoring to avoid echo.

Setting the portal up requires four env vars on the web app (see
`apps/web/.env.example`):

| Env var | Meaning | Default |
| --- | --- | --- |
| `COMMENTATOR_PASSCODE` | Shared passcode for `/commentary`. Blank = portal disabled. | unset |
| `VDO_ROOM_PREFIX` | VDO.Ninja room name prefix per stream. | `BVMCOURT` |
| `VDO_ROOM_PASSWORD` | Room password baked into every link (alphanumeric only). | `bvm2026` |
| `VDO_SCENE_BUFFER_MS` | Commentary audio delay in the StreamRun scene link (0-4000). | `2000` |

## Producer Setup (per court)

All links below are generated on `/admin/commentary` (admin login) with copy
buttons per stream — director console, StreamRun scene URL, and guest links.

1. Open the Director link for the court and keep it open — it uses
   `?director&room={prefix}{n}&...&rooms={prefix}1,...,{prefix}8` so you can hop
   between all eight rooms from one console.
2. Bring the room's audio into StreamRun: paste the Scene URL
   (`?scene&room={prefix}{n}&...&novideo&audiobitrate=80&buffer={ms}&retry`)
   into a StreamRun HTML/browser-source element. The `buffer` value delays the
   commentary audio to align with the delayed program video — tune it via
   `VDO_SCENE_BUFFER_MS` and clap-test per court.
3. In the StreamRun editor, mix that commentary audio element over the program
   (camera) feed on the YouTube output branch. Keep the MediaMTX preview output
   branch clean (camera only) so scorers and commentators see an undelayed,
   commentary-free feed.
4. Send the commentators the site URL and the portal passcode. For a talent on
   flaky wifi, send the "bad wifi" guest link variant (`&relay`) from
   `/admin/commentary` instead — it forces TURN relay routing.

## Latency Budget

| Hop | Typical latency |
| --- | --- |
| Venue camera/encoder -> MediaMTX (RTMP/SRT ingest) | 0.5 - 1.0 s |
| MediaMTX -> commentator browser (WHEP) | 0.3 - 0.5 s |
| Commentator voice -> VDO.Ninja -> StreamRun | 0.3 - 0.5 s |
| StreamRun mix -> platform ingest | 1 - 2 s |
| YouTube delivery to viewers (ultra-low-latency mode) | 3 - 10 s |

What matters for sync is only the first three rows: the commentator reacts about
1 - 2 s after the real play, and their voice arrives at StreamRun roughly when the
matching program video frames do, because the program feed reaching StreamRun and
the WHEP feed the commentator watched share the same upstream. Viewers then see
video+voice together, delayed as a unit by the platform.

## Sync Tips

- Measure the true offset once per court: have the commentator clap on a visible
  rally end, then compare against the StreamRun preview. If commentary consistently
  leads the program video, raise the scene link's `buffer` value (via
  `VDO_SCENE_BUFFER_MS`, or per-element in StreamRun) rather than delaying video.
- Keep commentators on WHEP. If a commentator's network forces the player onto HLS,
  their calls will trail the action by several seconds — fix their network or have
  them rejoin, do not compensate in the mix.
- One commentary room per court. Cross-court rooms make delay compensation
  impossible because each court's encoder chain differs slightly.
- Commentators should mute the program audio in the player (default) and rely on
  their own voice monitoring in VDO.Ninja to avoid echo and doubled crowd noise.
- VDO.Ninja quality flags worth using: `&stereo=0&autogain=0&denoise=1` for speech,
  and `&novideo` for audio-only participants to save bandwidth.
- If YouTube chat interaction matters to the talent, give them a second (muted)
  browser tab with the YouTube stream for chat only — never for watching the game.

## Program Pages (compositor scenes)

`/program/court/{n}?token={PROGRAM_PAGE_TOKEN}` is the self-hosted replacement
for the StreamRun mix (see `docs/PRODUCTION_PLATFORM_PLAN.md` §3.1): one page
per court renders the court video (WHEP/HLS via `StreamPlayer`), the exact
broadcast scorebug (`OverlayClient`, hosted on a 1920x1080 virtual canvas so
placement matches the StreamRun overlay), and the court's VDO.Ninja scene as a
hidden audio iframe. A headless-Chrome LiveKit egress captures the page and
pushes it to YouTube.

- **Gate**: `PROGRAM_PAGE_TOKEN` env; wrong/missing token is a plain 404. The
  same token authenticates the page's 5s heartbeat POSTs to
  `/api/program/heartbeat` (upserted into `program_heartbeats`, one row per
  court — the console alarms on stale `last_seen_at`).
- **Commentary sync**: unlike the StreamRun scene link, the embedded scene has
  **no `&buffer` by default** — the egress path gets its own alignment. Trim
  with `?cbuf={0..4000}` (ms, appended as `&buffer`); disable commentary
  entirely with `?scene=0`.
- **Egress signals**: the page logs `START_RECORDING` once video frames are
  flowing and commentary has loaded (or 10s passed, or `scene=0`), and
  `END_RECORDING` only in the unrecoverable no-sources state — wire the egress
  with `await_start_signal`.
- **Self-healing**: frame progress stalled >5s remounts the player; three
  fruitless remounts reload the page, indefinitely — a court feed returning
  mid-event recovers on its own. `?debug=1` shows a diagnostics strip
  (video state, frames, reconnects, reloads, commentary, heartbeat).
