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

The commentator return contract is explicit:

- video is the low-latency `courtN_preview` path;
- return audio is camera ambience plus other commentators;
- the local commentator microphone is excluded from that commentator's return;
- headphones are mandatory;
- program output receives delayed camera video/ambience plus independently
  delayed commentary.

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
receiver buffer. `courts.commentary_delay_ms` is the 0-10000 ms
human-calibrated baseline inside the browser audio graph. It accounts for the
commentator reacting to the low-latency preview; software cannot infer that
semantic reaction time from network packets alone.

After the baseline is established, the program mixer automatically holds sync:

1. The commentator page samples preview WHEP jitter-buffer and selected-path
   RTT once per second.
2. Program and commentator participants run an NTP-style four-timestamp clock
   exchange over their court-scoped LiveKit data channel.
3. The program samples its own WHEP transport and each incoming commentary
   track's audio jitter buffer.
4. Eight valid observations establish a transport baseline. Subsequent changes
   steer each track's DelayNode independently, capped at +/-500 ms from the
   persisted baseline and slewed by at most 25 ms per second.
5. Missing, stale, malformed, or high-RTT telemetry freezes the last safe value
   and reports `fallback`; it never removes the persisted delay.

Browser `mediaTime` and RTP timestamp offsets are deliberately not compared
across preview and program sessions. MediaMTX/WebRTC rebase those independent
sessions, so treating either value as a shared source clock would create false
corrections.

Calibrate with a real clap in frame:

1. Start with `commentary_delay_ms` approximately 500 ms below the configured
   program-video buffer; for the Gate 1 path that is 3000 ms.
2. Record a local Mevo clap and a remote commentator repeating the clap.
3. Inspect the unlisted YouTube archive at the beginning, middle, and end.
4. Change only the persisted commentary baseline unless the camera-to-cloud
   buffer changes materially. The runtime controller handles transport drift.

Production bundle creation also requires a mode-0600 commentary qualification
for every enabled camera. It records at least 120 seconds of return video and
ambience, a two-commentator mix-minus observation, headphones, late join and
drop/rejoin continuity, AAC stereo 128 kbps/48 kHz output, left/right centering,
and clap offsets at the beginning, middle, and end. Each offset must remain
within plus or minus 250 ms. The global section must prove at least 120 seconds
of commentary over TURN/TLS TCP 443 from a network where UDP is blocked. A
synthetic rehearsal exercises the contract shape only; it is not physical
production proof.

Never switch the program page to HLS to fix sync. Program mode is WHEP-only so
its latency class cannot change silently.

## Failure behavior

- LiveKit initial connection failures retry with exponential backoff.
- Established rooms use LiveKit reconnect handling.
- Camera loss leaves the scorebug and commentary alive over a controlled slate.
- The program remains on `courtN_program`; it never falls back to HLS.
- Audio-health failures are reported through program heartbeats.

The production gate is not complete until the protected qualification passes
and a real remote voice remains audible and in sync throughout the event-shaped
soak.
