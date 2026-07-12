# ScoreCheck Commentary Workflow

ScoreCheck commentary uses self-hosted LiveKit audio. VDO.Ninja and StreamRun
are not part of this path.

## Signal flow

```text
Mevo -> courtN_raw -> MediaMTX courtN_preview -> commentator browser
                    -> MediaMTX courtN_program -> program page video/ambient

Commentator microphone -> LiveKit court room -> program page Web Audio mixer

Program page = delayed video + ambient gain + commentary gain/delay/compression
             + scorebug + health meters
             -> LiveKit Web Egress -> YouTube RTMPS
```

## Commentator steps

1. Open `https://score.beachvolleyballmedia.com/commentary`.
2. Enter the event commentary passcode.
3. Open the assigned court.
4. Enter a display name and select **Join live audio**.
5. Allow microphone access and use headphones.
6. Confirm the microphone meter moves while speaking.
7. Leave the tab open for the entire match.

Remote co-commentators in the same court room hear one another. A commentator
never subscribes to their own microphone, so headphones prevent the court feed
or another participant from feeding back into the microphone.

## Program mixer

The program page joins the same room as a subscribe-only participant. Its Web
Audio graph is:

```text
camera MediaStream -> camera gain -> camera meter -> browser output
LiveKit tracks -> delay -> commentary gain -> compressor -> meter -> output
```

The mixer reports these values every five seconds:

- LiveKit room connection state.
- Remote participant and audio-track counts.
- Commentary RMS and peak dB.
- Seconds since commentary crossed the speech threshold.
- Camera/ambient RMS dB.

An empty room does not prevent a broadcast from starting. A room that is
connected but has no audio track is visible as a production warning.

## Configuration

Required Vercel variables:

```text
NEXT_PUBLIC_LIVEKIT_COMMENTARY_URL=wss://rtc.beachvolleyballmedia.com
LIVEKIT_COMMENTARY_API_KEY=<secret>
LIVEKIT_COMMENTARY_API_SECRET=<secret>
COMMENTATOR_PASSCODE=<secret>
PROGRAM_PAGE_TOKEN=<secret>
```

Optional variables:

```text
LIVEKIT_COMMENTARY_ROOM_PREFIX=scorecheck-court-
```

Infrastructure is versioned in `infra/commentary`. Secrets are rendered only
into gitignored local files and `/opt/livekit/livekit.yaml` on the commentary
node.

## Sync calibration

`courts.program_video_delay_ms` records the coarse program-video target. The
MediaMTX Gate 1 deployment currently renders that target as a 3500 ms SRT
receiver buffer. `courts.commentary_delay_ms` is a 0-10000 ms fine adjustment
inside the browser audio graph.

Calibrate with a real clap in frame:

1. Keep `commentary_delay_ms` at zero.
2. Record a local Mevo clap and a remote commentator repeating the clap.
3. Inspect the unlisted YouTube archive at the beginning, middle, and end.
4. Change only the fine commentary delay unless the camera-to-cloud baseline
   changes materially.

Never switch the program page to HLS to fix sync. Program mode is WHEP-only so
its latency class cannot change silently.

## Failure behavior

- LiveKit initial connection failures retry with exponential backoff.
- Established rooms use LiveKit reconnect handling.
- Camera loss leaves the scorebug and commentary alive over a controlled slate.
- The program remains on `courtN_program`; it never falls back to HLS.
- Audio-health failures are reported through program heartbeats.

The production gate is not complete until a real remote voice remains audible
and in sync throughout the ten-hour one-court soak.
