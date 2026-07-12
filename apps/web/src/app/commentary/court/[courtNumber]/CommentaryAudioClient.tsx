"use client";

import { Headphones, LogOut, Mic, MicOff } from "lucide-react";
import { createLocalAudioTrack, LocalAudioTrack, Room, RoomEvent, Track, type RemoteTrack } from "livekit-client";
import { useEffect, useRef, useState } from "react";

type CommentaryAudioClientProps = {
  courtNumber: number;
  displayName: string;
  configured: boolean;
};

type ConnectionResponse = {
  serverUrl: string;
  roomName: string;
  token: string;
};

type AudioState = "idle" | "connecting" | "live" | "reconnecting" | "error";

export function CommentaryAudioClient({ courtNumber, displayName, configured }: CommentaryAudioClientProps) {
  const roomRef = useRef<Room | null>(null);
  const trackRef = useRef<LocalAudioTrack | null>(null);
  const meterCleanupRef = useRef<(() => void) | null>(null);
  const remoteAudioRef = useRef<HTMLDivElement | null>(null);
  const remoteElementsRef = useRef(new Map<string, HTMLMediaElement>());
  const [state, setState] = useState<AudioState>("idle");
  const [roomName, setRoomName] = useState<string | null>(null);
  const [muted, setMuted] = useState(false);
  const [level, setLevel] = useState(0);
  const [participants, setParticipants] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => () => disconnect(), []);

  async function connect() {
    if (!configured || state === "connecting" || state === "live") return;
    setState("connecting");
    setError(null);
    try {
      const response = await fetch("/api/commentary/token", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ courtNumber, displayName: displayName.trim() || "Commentator" })
      });
      const connection = await response.json().catch(() => null) as ConnectionResponse | { error?: string } | null;
      if (!response.ok || !connection || !("token" in connection)) {
        throw new Error(connection && "error" in connection ? connection.error : "Audio room is not ready");
      }

      const room = new Room({ adaptiveStream: true, dynacast: true });
      roomRef.current = room;
      const updateParticipants = () => setParticipants(room.remoteParticipants.size + 1);
      room.on(RoomEvent.ParticipantConnected, updateParticipants);
      room.on(RoomEvent.ParticipantDisconnected, updateParticipants);
      room.on(RoomEvent.Reconnecting, () => setState("reconnecting"));
      room.on(RoomEvent.Reconnected, () => setState("live"));
      room.on(RoomEvent.Disconnected, () => {
        if (roomRef.current === room) setState("idle");
      });
      room.on(RoomEvent.TrackSubscribed, attachRemoteAudio);
      room.on(RoomEvent.TrackUnsubscribed, detachRemoteAudio);

      await room.connect(connection.serverUrl, connection.token, { autoSubscribe: true });
      await room.startAudio();
      const track = await createLocalAudioTrack({
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: false
      });
      trackRef.current = track;
      await room.localParticipant.publishTrack(track, { source: Track.Source.Microphone });
      meterCleanupRef.current = startMicrophoneMeter(track, setLevel);
      setRoomName(connection.roomName);
      setParticipants(room.remoteParticipants.size + 1);
      setMuted(false);
      setState("live");
    } catch (reason) {
      disconnect();
      setError(friendlyAudioError(reason));
      setState("error");
    }
  }

  async function toggleMute() {
    const track = trackRef.current;
    if (!track) return;
    if (track.isMuted) await track.unmute();
    else await track.mute();
    setMuted(track.isMuted);
  }

  function disconnect() {
    meterCleanupRef.current?.();
    meterCleanupRef.current = null;
    trackRef.current?.stop();
    trackRef.current = null;
    for (const element of remoteElementsRef.current.values()) element.remove();
    remoteElementsRef.current.clear();
    roomRef.current?.disconnect();
    roomRef.current = null;
    setLevel(0);
    setParticipants(0);
    setMuted(false);
    setRoomName(null);
    setState("idle");
  }

  function attachRemoteAudio(track: RemoteTrack) {
    if (track.kind !== Track.Kind.Audio || remoteElementsRef.current.has(track.mediaStreamTrack.id)) return;
    const element = track.attach();
    element.autoplay = true;
    remoteAudioRef.current?.appendChild(element);
    remoteElementsRef.current.set(track.mediaStreamTrack.id, element);
  }

  function detachRemoteAudio(track: RemoteTrack) {
    const element = remoteElementsRef.current.get(track.mediaStreamTrack.id);
    if (!element) return;
    track.detach(element);
    element.remove();
    remoteElementsRef.current.delete(track.mediaStreamTrack.id);
  }

  if (!configured) {
    return (
      <section className="panel stack commentary-audio-panel">
        <h2><Headphones size={18} aria-hidden="true" /> Audio room</h2>
        <p className="form-alert">Commentary audio has not been deployed yet.</p>
      </section>
    );
  }

  const joined = state === "live" || state === "reconnecting";
  return (
    <section className="panel stack commentary-audio-panel">
      <div className="commentary-room-head">
        <h2><Headphones size={18} aria-hidden="true" /> Audio room</h2>
        <span className={`status ${joined ? "success" : ""}`}>
          {state === "live" ? "Live" : state === "reconnecting" ? "Reconnecting" : state === "connecting" ? "Connecting" : "Not joined"}
        </span>
      </div>
      <p className="muted">Use headphones. Your microphone is sent directly to the self-hosted court mixer.</p>
      {error && <p className="form-alert" role="alert">{error}</p>}

      {!joined ? (
        <button className="primary" type="button" onClick={() => void connect()} disabled={state === "connecting"}>
          <Mic size={16} /> {state === "connecting" ? "Joining audio…" : "Join live audio"}
        </button>
      ) : (
        <>
          <div className="commentary-live-meter" aria-label="Microphone level">
            <span style={{ width: `${Math.round(level * 100)}%` }} />
          </div>
          <div className="commentary-audio-meta">
            <span>{roomName ?? `Court ${courtNumber}`}</span>
            <span>{participants} connected</span>
          </div>
          <div className="commentary-audio-actions">
            <button className={muted ? "warn" : "primary"} type="button" onClick={() => void toggleMute()}>
              {muted ? <MicOff size={16} /> : <Mic size={16} />} {muted ? "Unmute" : "Mute"}
            </button>
            <button type="button" onClick={disconnect}><LogOut size={16} /> Leave audio</button>
          </div>
        </>
      )}
      <small className="muted">The meter must move while you speak. A connected room with no level is not broadcast-ready.</small>
      <div ref={remoteAudioRef} hidden aria-hidden="true" />
    </section>
  );
}

function startMicrophoneMeter(track: LocalAudioTrack, onLevel: (level: number) => void): () => void {
  const context = new AudioContext();
  const source = context.createMediaStreamSource(new MediaStream([track.mediaStreamTrack]));
  const analyser = context.createAnalyser();
  analyser.fftSize = 512;
  source.connect(analyser);
  const samples = new Float32Array(analyser.fftSize);
  let frame = 0;
  const tick = () => {
    analyser.getFloatTimeDomainData(samples);
    let sum = 0;
    for (const sample of samples) sum += sample * sample;
    onLevel(Math.min(1, Math.sqrt(sum / samples.length) * 5));
    frame = requestAnimationFrame(tick);
  };
  void context.resume();
  frame = requestAnimationFrame(tick);
  return () => {
    cancelAnimationFrame(frame);
    source.disconnect();
    analyser.disconnect();
    void context.close();
  };
}

function friendlyAudioError(reason: unknown): string {
  if (reason instanceof DOMException && reason.name === "NotAllowedError") {
    return "Microphone access was blocked. Allow microphone access in the browser and join again.";
  }
  const message = reason instanceof Error ? reason.message : "Audio room connection failed";
  if (/api|token|secret|credential|livekit|websocket/i.test(message)) return "Audio room is not ready. Ask the producer to check it.";
  return message;
}
