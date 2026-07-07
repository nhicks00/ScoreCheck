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

## Commentator Setup (per person)

1. Open the court preview: `/admin/stream-preview/{courtNumber}` (admin login) or a
   link shared by the producer. Confirm the status chip reads `Live — low latency`
   (WHEP). If it says `Live — HLS`, reload — HLS adds seconds of delay and is not
   suitable for calling live action.
2. Tap the unmute button if program audio is wanted (keep it low or muted to avoid
   echo into the mic).
3. Join the VDO.Ninja room the producer shares, e.g.
   `https://vdo.ninja/?room=bvmcourt1&push=CASTER1` with a headset. Use headphones —
   no open speakers.

## Producer Setup (per court)

1. Create a VDO.Ninja room: `https://vdo.ninja/?director=bvmcourt1`.
2. Bring the room's mixed audio into StreamRun using one of:
   - StreamRun HTML/browser-source element pointed at the VDO.Ninja scene/room link
     (e.g. `https://vdo.ninja/?scene&room=bvmcourt1&audioonly`), or
   - a local OBS/companion machine that plays the VDO.Ninja return feed and
     republishes it to a StreamRun input.
3. In the StreamRun editor, mix that commentary audio element over the program
   (camera) feed on the YouTube output branch. Keep the MediaMTX preview output
   branch clean (camera only) so scorers and commentators see an undelayed,
   commentary-free feed.
4. Send the commentators their watch link and the VDO.Ninja room link.

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
  leads the program video, add audio delay to the commentary element in StreamRun
  (typically 0 - 700 ms) rather than delaying video.
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
