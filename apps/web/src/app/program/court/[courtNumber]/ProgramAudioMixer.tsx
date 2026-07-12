"use client";

import { Room, RoomEvent, Track, type RemoteTrack } from "livekit-client";
import { useEffect } from "react";
import type { CommentaryConnection } from "@/lib/commentary";

export type ProgramAudioHealth = {
  roomConnected: boolean;
  participantCount: number;
  audioTrackCount: number;
  commentaryRmsDb: number | null;
  commentaryPeakDb: number | null;
  secondsSinceCommentaryAudio: number | null;
  cameraRmsDb: number | null;
};

export const EMPTY_PROGRAM_AUDIO_HEALTH: ProgramAudioHealth = {
  roomConnected: false,
  participantCount: 0,
  audioTrackCount: 0,
  commentaryRmsDb: null,
  commentaryPeakDb: null,
  secondsSinceCommentaryAudio: null,
  cameraRmsDb: null
};

type ProgramAudioMixerProps = {
  cameraElement: HTMLVideoElement | null;
  commentary: CommentaryConnection | null;
  cameraGainDb: number;
  commentaryGainDb: number;
  commentaryDelayMs: number;
  onHealth: (health: ProgramAudioHealth) => void;
};

export function ProgramAudioMixer({
  cameraElement,
  commentary,
  cameraGainDb,
  commentaryGainDb,
  commentaryDelayMs,
  onHealth
}: ProgramAudioMixerProps) {
  useEffect(() => {
    if (!cameraElement) return;
    let cancelled = false;
    let room: Room | null = null;
    let roomConnected = false;
    let participantCount = 0;
    let reconnectTimer: number | null = null;
    let reconnectAttempt = 0;
    let connecting = false;
    let cameraSource: MediaStreamAudioSourceNode | null = null;
    let attachedCameraStream: MediaStream | null = null;
    let lastNonSilenceAtMs: number | null = null;
    let peakDb = -120;
    const context = new AudioContext();
    const cameraGain = context.createGain();
    const cameraAnalyser = context.createAnalyser();
    cameraAnalyser.fftSize = 1024;
    cameraGain.gain.value = dbToGain(cameraGainDb);
    cameraGain.connect(cameraAnalyser).connect(context.destination);

    // WHEP assigns a MediaStream to video.srcObject after the element mounts.
    // MediaElementAudioSourceNode is silent for this Chromium/WebRTC shape, so
    // attach the actual stream and repeat whenever a reconnect replaces it.
    const attachCameraStream = () => {
      const stream = cameraElement.srcObject;
      if (!(stream instanceof MediaStream) || stream === attachedCameraStream || stream.getAudioTracks().length === 0) return;
      cameraSource?.disconnect();
      cameraSource = context.createMediaStreamSource(stream);
      cameraSource.connect(cameraGain);
      attachedCameraStream = stream;
    };
    attachCameraStream();
    const cameraAttachTimer = window.setInterval(attachCameraStream, 500);

    const commentaryDelay = context.createDelay(10);
    const commentaryGain = context.createGain();
    const compressor = context.createDynamicsCompressor();
    const commentaryAnalyser = context.createAnalyser();
    commentaryAnalyser.fftSize = 1024;
    commentaryDelay.delayTime.value = Math.min(10, Math.max(0, commentaryDelayMs / 1000));
    commentaryGain.gain.value = dbToGain(commentaryGainDb);
    compressor.threshold.value = -18;
    compressor.knee.value = 12;
    compressor.ratio.value = 4;
    compressor.attack.value = 0.005;
    compressor.release.value = 0.2;
    commentaryDelay.connect(commentaryGain).connect(compressor).connect(commentaryAnalyser).connect(context.destination);

    const commentarySources = new Map<string, MediaStreamAudioSourceNode>();
    const attachTrack = (track: RemoteTrack) => {
      if (track.kind !== Track.Kind.Audio || commentarySources.has(track.mediaStreamTrack.id)) return;
      const source = context.createMediaStreamSource(new MediaStream([track.mediaStreamTrack]));
      source.connect(commentaryDelay);
      commentarySources.set(track.mediaStreamTrack.id, source);
    };
    const detachTrack = (track: RemoteTrack) => {
      const source = commentarySources.get(track.mediaStreamTrack.id);
      source?.disconnect();
      commentarySources.delete(track.mediaStreamTrack.id);
    };

    void context.resume();
    if (commentary) {
      room = new Room({ adaptiveStream: true, dynacast: true });
      room.on(RoomEvent.TrackSubscribed, attachTrack);
      room.on(RoomEvent.TrackUnsubscribed, detachTrack);
      room.on(RoomEvent.ParticipantConnected, () => {
        participantCount = room?.remoteParticipants.size ?? 0;
      });
      room.on(RoomEvent.ParticipantDisconnected, () => {
        participantCount = room?.remoteParticipants.size ?? 0;
      });
      room.on(RoomEvent.Reconnected, () => {
        roomConnected = true;
        reconnectAttempt = 0;
      });
      room.on(RoomEvent.Reconnecting, () => { roomConnected = false; });
      room.on(RoomEvent.Disconnected, () => {
        roomConnected = false;
        scheduleReconnect();
      });

      const connectRoom = async () => {
        if (cancelled || !room || connecting || roomConnected) return;
        connecting = true;
        try {
          await room.connect(commentary.serverUrl, commentary.token, { autoSubscribe: true });
          roomConnected = true;
          reconnectAttempt = 0;
          participantCount = room.remoteParticipants.size;
        } catch {
          roomConnected = false;
          scheduleReconnect();
        } finally {
          connecting = false;
        }
      };
      function scheduleReconnect() {
        if (cancelled || reconnectTimer != null) return;
        const delay = Math.min(30_000, 1_000 * 2 ** reconnectAttempt);
        reconnectAttempt += 1;
        reconnectTimer = window.setTimeout(() => {
          reconnectTimer = null;
          void connectRoom();
        }, delay);
      }
      void connectRoom();
    }

    const meter = window.setInterval(() => {
      if (cancelled) return;
      const commentaryDb = analyserRmsDb(commentaryAnalyser);
      const cameraDb = analyserRmsDb(cameraAnalyser);
      peakDb = Math.max(commentaryDb, peakDb - 2);
      if (commentarySources.size > 0 && commentaryDb > -52) lastNonSilenceAtMs = Date.now();
      onHealth({
        roomConnected,
        participantCount,
        audioTrackCount: commentarySources.size,
        commentaryRmsDb: commentarySources.size > 0 ? commentaryDb : null,
        commentaryPeakDb: commentarySources.size > 0 ? peakDb : null,
        secondsSinceCommentaryAudio: lastNonSilenceAtMs == null ? null : Math.max(0, (Date.now() - lastNonSilenceAtMs) / 1000),
        cameraRmsDb: cameraDb
      });
    }, 500);

    return () => {
      cancelled = true;
      window.clearInterval(meter);
      window.clearInterval(cameraAttachTimer);
      if (reconnectTimer != null) window.clearTimeout(reconnectTimer);
      for (const source of commentarySources.values()) source.disconnect();
      commentarySources.clear();
      room?.disconnect();
      cameraSource?.disconnect();
      cameraGain.disconnect();
      cameraAnalyser.disconnect();
      commentaryDelay.disconnect();
      commentaryGain.disconnect();
      compressor.disconnect();
      commentaryAnalyser.disconnect();
      void context.close();
      onHealth(EMPTY_PROGRAM_AUDIO_HEALTH);
    };
  }, [cameraElement, cameraGainDb, commentary, commentaryDelayMs, commentaryGainDb, onHealth]);

  return null;
}

function dbToGain(db: number): number {
  const safe = Math.min(12, Math.max(-60, Number.isFinite(db) ? db : 0));
  return 10 ** (safe / 20);
}

function analyserRmsDb(analyser: AnalyserNode): number {
  const samples = new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(samples);
  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  const rms = Math.sqrt(sum / samples.length);
  return rms > 0 ? Math.max(-120, 20 * Math.log10(rms)) : -120;
}
