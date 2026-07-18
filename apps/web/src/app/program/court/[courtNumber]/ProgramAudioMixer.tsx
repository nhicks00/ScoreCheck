"use client";

import {
  Room,
  RoomEvent,
  Track,
  type RemoteParticipant,
  type RemoteTrack,
  type RemoteTrackPublication
} from "livekit-client";
import { type RefObject, useEffect } from "react";
import type { CommentaryConnection } from "@/lib/commentary";
import {
  bestClockEstimate,
  commentarySyncStep,
  COMMENTARY_SYNC_CLOCK_TOPIC,
  COMMENTARY_SYNC_INTERVAL_MS,
  COMMENTARY_SYNC_PING_INTERVAL_MS,
  COMMENTARY_SYNC_PREVIEW_TOPIC,
  COMMENTARY_SYNC_SAMPLE_MAX_AGE_MS,
  decodeCommentarySyncMessage,
  encodeCommentarySyncMessage,
  estimateClockOffset,
  initialCommentarySyncController,
  previewSampleAgeOnProgramClock,
  syncObservation,
  type ClockEstimate,
  type CommentarySyncController,
  type CommentarySyncStatus
} from "@/lib/commentarySync";
import {
  intervalJitterSample,
  monotonicEpochMs,
  timingSampleAgeMs,
  type RtcJitterTotals,
  type StreamTimingSample
} from "@/lib/rtcTiming";

export type ProgramAudioHealth = {
  roomConnected: boolean;
  participantCount: number;
  audioTrackCount: number;
  mutedAudioTrackCount: number;
  commentaryRmsDb: number | null;
  commentaryPeakDb: number | null;
  commentaryClippedSampleRatio: number | null;
  secondsSinceCommentaryAudio: number | null;
  commentaryPacketsLost: number | null;
  commentaryPacketsReceived: number | null;
  commentaryJitterBufferMs: number | null;
  cameraTrackPresent: boolean;
  cameraRmsDb: number | null;
  cameraPeakDb: number | null;
  cameraClippedSampleRatio: number | null;
  secondsSinceCameraAudio: number | null;
  commentarySyncStatus: CommentarySyncStatus;
  commentaryDelayConfiguredMs: number | null;
  commentaryDelayTargetMs: number | null;
  commentaryDelayAppliedMs: number | null;
  commentarySyncRttMs: number | null;
  commentarySyncSampleAgeMs: number | null;
};

export const EMPTY_PROGRAM_AUDIO_HEALTH: ProgramAudioHealth = {
  roomConnected: false,
  participantCount: 0,
  audioTrackCount: 0,
  mutedAudioTrackCount: 0,
  commentaryRmsDb: null,
  commentaryPeakDb: null,
  commentaryClippedSampleRatio: null,
  secondsSinceCommentaryAudio: null,
  commentaryPacketsLost: null,
  commentaryPacketsReceived: null,
  commentaryJitterBufferMs: null,
  cameraTrackPresent: false,
  cameraRmsDb: null,
  cameraPeakDb: null,
  cameraClippedSampleRatio: null,
  secondsSinceCameraAudio: null,
  commentarySyncStatus: "fallback",
  commentaryDelayConfiguredMs: null,
  commentaryDelayTargetMs: null,
  commentaryDelayAppliedMs: null,
  commentarySyncRttMs: null,
  commentarySyncSampleAgeMs: null
};

type ProgramAudioMixerProps = {
  courtNumber: number;
  cameraElement: HTMLVideoElement | null;
  programTimingRef: RefObject<StreamTimingSample | null>;
  commentary: CommentaryConnection | null;
  cameraGainDb: number;
  commentaryGainDb: number;
  commentaryDelayMs: number;
  onHealth: (health: ProgramAudioHealth) => void;
};

type ParticipantTimingState = {
  previewTiming: StreamTimingSample | null;
  clockEstimates: ClockEstimate[];
};

type CommentarySourceState = {
  source: MediaStreamAudioSourceNode;
  delay: DelayNode;
  track: RemoteTrack;
  participantIdentity: string;
  previousJitterTotals: RtcJitterTotals | null;
  controller: CommentarySyncController;
  scheduledDelayMs: number;
};

export function ProgramAudioMixer({
  courtNumber,
  cameraElement,
  programTimingRef,
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
    let lastCameraNonSilenceAtMs: number | null = null;
    let commentaryTrackObservedAtMs: number | null = null;
    let cameraTrackObservedAtMs: number | null = null;
    let peakDb = -120;
    let cameraPeakDb = -120;
    let commentaryPacketsLost: number | null = null;
    let commentaryPacketsReceived: number | null = null;
    let commentaryJitterBufferMs: number | null = null;
    let syncSampling = false;
    let syncStatus: CommentarySyncStatus = "fallback";
    let syncTargetDelayMs: number | null = null;
    let syncAppliedDelayMs: number | null = null;
    let syncRttMs: number | null = null;
    let syncSampleAgeMs: number | null = null;
    const pendingPings = new Map<string, number>();
    const participantTimings = new Map<string, ParticipantTimingState>();
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
      if (!(stream instanceof MediaStream)) {
        cameraSource?.disconnect();
        cameraSource = null;
        attachedCameraStream = null;
        lastCameraNonSilenceAtMs = null;
        cameraTrackObservedAtMs = null;
        return;
      }
      if (stream === attachedCameraStream) return;
      cameraSource?.disconnect();
      cameraSource = null;
      attachedCameraStream = stream;
      lastCameraNonSilenceAtMs = null;
      cameraTrackObservedAtMs = null;
      if (stream.getAudioTracks().length === 0) return;
      cameraSource = context.createMediaStreamSource(stream);
      cameraSource.connect(cameraGain);
    };
    attachCameraStream();
    const cameraAttachTimer = window.setInterval(attachCameraStream, 500);

    const commentaryGain = context.createGain();
    const compressor = context.createDynamicsCompressor();
    const commentaryAnalyser = context.createAnalyser();
    commentaryAnalyser.fftSize = 1024;
    commentaryGain.gain.value = dbToGain(commentaryGainDb);
    compressor.threshold.value = -18;
    compressor.knee.value = 12;
    compressor.ratio.value = 4;
    compressor.attack.value = 0.005;
    compressor.release.value = 0.2;
    commentaryGain.connect(compressor).connect(commentaryAnalyser).connect(context.destination);

    const commentarySources = new Map<string, CommentarySourceState>();
    const ensureParticipantTiming = (identity: string) => {
      const existing = participantTimings.get(identity);
      if (existing) return existing;
      const created = { previewTiming: null, clockEstimates: [] };
      participantTimings.set(identity, created);
      return created;
    };
    const attachTrack = (
      track: RemoteTrack,
      _publication: RemoteTrackPublication,
      participant: RemoteParticipant
    ) => {
      if (track.kind !== Track.Kind.Audio || commentarySources.has(track.mediaStreamTrack.id)) return;
      if (commentarySources.size === 0) {
        lastNonSilenceAtMs = null;
        commentaryTrackObservedAtMs = Date.now();
      }
      const source = context.createMediaStreamSource(new MediaStream([track.mediaStreamTrack]));
      const delay = context.createDelay(10);
      const configuredDelay = clamp(commentaryDelayMs, 0, 10_000);
      delay.delayTime.value = configuredDelay / 1000;
      source.connect(delay).connect(commentaryGain);
      commentarySources.set(track.mediaStreamTrack.id, {
        source,
        delay,
        track,
        participantIdentity: participant.identity,
        previousJitterTotals: null,
        controller: initialCommentarySyncController(configuredDelay),
        scheduledDelayMs: configuredDelay
      });
      ensureParticipantTiming(participant.identity);
    };
    const detachTrack = (track: RemoteTrack) => {
      const state = commentarySources.get(track.mediaStreamTrack.id);
      state?.source.disconnect();
      state?.delay.disconnect();
      commentarySources.delete(track.mediaStreamTrack.id);
      if (commentarySources.size === 0) {
        lastNonSilenceAtMs = null;
        commentaryTrackObservedAtMs = null;
      }
    };

    void context.resume();
    if (commentary) {
      room = new Room({ adaptiveStream: false, dynacast: true });
      room.on(RoomEvent.TrackSubscribed, attachTrack);
      room.on(RoomEvent.TrackUnsubscribed, detachTrack);
      room.on(RoomEvent.ParticipantConnected, (participant) => {
        participantCount = room?.remoteParticipants.size ?? 0;
        if (participant.identity.startsWith(`commentator-${courtNumber}-`)) ensureParticipantTiming(participant.identity);
      });
      room.on(RoomEvent.ParticipantDisconnected, (participant) => {
        participantCount = room?.remoteParticipants.size ?? 0;
        participantTimings.delete(participant.identity);
      });
      room.on(RoomEvent.DataReceived, (
        payload: Uint8Array,
        participant?: RemoteParticipant,
        _kind?: unknown,
        topic?: string
      ) => {
        if (!participant?.identity.startsWith(`commentator-${courtNumber}-`)) return;
        const message = decodeCommentarySyncMessage(payload);
        if (!message) return;
        const timingState = ensureParticipantTiming(participant.identity);
        if (topic === COMMENTARY_SYNC_PREVIEW_TOPIC
          && message.type === "preview-timing"
          && message.courtNumber === courtNumber) {
          timingState.previewTiming = message.timing;
          return;
        }
        if (topic !== COMMENTARY_SYNC_CLOCK_TOPIC || message.type !== "clock-pong") return;
        const sentAt = pendingPings.get(message.id);
        if (sentAt == null || Math.abs(sentAt - message.t0Ms) > 1) return;
        const estimate = estimateClockOffset(message, monotonicEpochMs());
        if (!estimate) return;
        timingState.clockEstimates = [...timingState.clockEstimates, estimate].slice(-10);
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
        const delay = Math.min(30_000, 1000 * 2 ** reconnectAttempt);
        reconnectAttempt += 1;
        reconnectTimer = window.setTimeout(() => {
          reconnectTimer = null;
          void connectRoom();
        }, delay);
      }
      void connectRoom();
    }

    const sendClockPing = () => {
      if (!room || !roomConnected) return;
      const destinationIdentities = [...room.remoteParticipants.values()]
        .map((participant) => participant.identity)
        .filter((identity) => identity.startsWith(`commentator-${courtNumber}-`));
      if (destinationIdentities.length === 0) return;
      const t0Ms = monotonicEpochMs();
      const id = globalThis.crypto.randomUUID();
      pendingPings.set(id, t0Ms);
      for (const [pendingId, sentAt] of pendingPings) {
        if (t0Ms - sentAt > 10_000) pendingPings.delete(pendingId);
      }
      void room.localParticipant.publishData(encodeCommentarySyncMessage({
        version: 1,
        type: "clock-ping",
        id,
        t0Ms
      }), {
        reliable: true,
        topic: COMMENTARY_SYNC_CLOCK_TOPIC,
        destinationIdentities
      }).catch(() => {
        // Existing fixed delay remains active when clock telemetry is unavailable.
      });
    };
    const clockTimer = window.setInterval(sendClockPing, COMMENTARY_SYNC_PING_INTERVAL_MS);

    const sampleSync = async () => {
      if (cancelled || syncSampling) return;
      syncSampling = true;
      try {
        const nowMs = monotonicEpochMs();
        const programTiming = programTimingRef.current;
        const validProgramTiming = programTiming
          && timingSampleAgeMs(programTiming, nowMs) <= 3000
          ? programTiming
          : null;
        const statuses: CommentarySyncStatus[] = [];
        const targetDelays: number[] = [];
        const appliedDelays: number[] = [];
        const rtts: number[] = [];
        const ages: number[] = [];
        const audioJitters: number[] = [];
        let packetsLost = 0;
        let packetsReceived = 0;
        let packetCountersAvailable = false;

        await Promise.all([...commentarySources.values()].map(async (sourceState) => {
          const participantTiming = participantTimings.get(sourceState.participantIdentity);
          const clock = participantTiming
            ? bestClockEstimate(participantTiming.clockEstimates, nowMs)
            : null;
          const previewTiming = participantTiming?.previewTiming ?? null;
          const previewAgeMs = previewTiming && clock
            ? previewSampleAgeOnProgramClock(previewTiming, clock, nowMs)
            : null;
          const network = await sampleAudioNetwork(sourceState);
          const audioJitterMs = network?.jitterBufferMs ?? null;
          if (audioJitterMs != null) audioJitters.push(audioJitterMs);
          if (network?.packetsLost != null && network.packetsReceived != null) {
            packetsLost += network.packetsLost;
            packetsReceived += network.packetsReceived;
            packetCountersAvailable = true;
          }
          const observation = previewAgeMs != null
            && previewAgeMs <= COMMENTARY_SYNC_SAMPLE_MAX_AGE_MS
            ? syncObservation({
              programTiming: validProgramTiming,
              previewTiming,
              commentaryJitterMs: audioJitterMs,
              commentaryClockRttMs: clock?.rttMs ?? null
            })
            : null;
          sourceState.controller = commentarySyncStep(sourceState.controller, observation);
          scheduleDelay(sourceState, context);
          statuses.push(sourceState.controller.status);
          targetDelays.push(sourceState.controller.targetDelayMs);
          appliedDelays.push(sourceState.controller.appliedDelayMs);
          if (clock) rtts.push(clock.rttMs);
          if (previewAgeMs != null) ages.push(previewAgeMs);
        }));

        syncStatus = aggregateSyncStatus(statuses);
        syncTargetDelayMs = average(targetDelays);
        syncAppliedDelayMs = average(appliedDelays);
        syncRttMs = average(rtts);
        syncSampleAgeMs = ages.length > 0 ? Math.max(...ages) : null;
        commentaryJitterBufferMs = average(audioJitters);
        commentaryPacketsLost = packetCountersAvailable ? packetsLost : null;
        commentaryPacketsReceived = packetCountersAvailable ? packetsReceived : null;
      } finally {
        syncSampling = false;
      }
    };
    const syncTimer = window.setInterval(() => void sampleSync(), COMMENTARY_SYNC_INTERVAL_MS);
    sendClockPing();
    void sampleSync();

    const meter = window.setInterval(() => {
      if (cancelled) return;
      const nowMs = Date.now();
      const commentaryLevels = analyserLevels(commentaryAnalyser);
      const cameraLevels = analyserLevels(cameraAnalyser);
      peakDb = Math.max(commentaryLevels.peakDb, peakDb - 2);
      cameraPeakDb = Math.max(cameraLevels.peakDb, cameraPeakDb - 2);
      const cameraTrackPresent = attachedCameraStream?.getAudioTracks().some((track) => track.readyState === "live") ?? false;
      const mutedAudioTrackCount = [...commentarySources.values()].filter((state) => state.track.isMuted).length;
      if (commentarySources.size > 0 && commentaryTrackObservedAtMs == null) commentaryTrackObservedAtMs = nowMs;
      if (commentarySources.size === 0) commentaryTrackObservedAtMs = null;
      if (cameraTrackPresent && cameraTrackObservedAtMs == null) cameraTrackObservedAtMs = nowMs;
      if (!cameraTrackPresent) {
        cameraTrackObservedAtMs = null;
        lastCameraNonSilenceAtMs = null;
      }
      if (commentarySources.size > 0 && commentaryLevels.rmsDb > -52) lastNonSilenceAtMs = nowMs;
      if (cameraTrackPresent && cameraLevels.rmsDb > -52) lastCameraNonSilenceAtMs = nowMs;
      const commentaryAudioReferenceMs = lastNonSilenceAtMs ?? commentaryTrackObservedAtMs;
      const cameraAudioReferenceMs = lastCameraNonSilenceAtMs ?? cameraTrackObservedAtMs;
      onHealth({
        roomConnected,
        participantCount,
        audioTrackCount: commentarySources.size,
        mutedAudioTrackCount,
        commentaryRmsDb: commentarySources.size > 0 ? commentaryLevels.rmsDb : null,
        commentaryPeakDb: commentarySources.size > 0 ? peakDb : null,
        commentaryClippedSampleRatio: commentarySources.size > 0 ? commentaryLevels.clippedSampleRatio : null,
        secondsSinceCommentaryAudio: commentaryAudioReferenceMs == null ? null : Math.max(0, (nowMs - commentaryAudioReferenceMs) / 1000),
        commentaryPacketsLost,
        commentaryPacketsReceived,
        commentaryJitterBufferMs,
        cameraTrackPresent,
        cameraRmsDb: cameraTrackPresent ? cameraLevels.rmsDb : null,
        cameraPeakDb: cameraTrackPresent ? cameraPeakDb : null,
        cameraClippedSampleRatio: cameraTrackPresent ? cameraLevels.clippedSampleRatio : null,
        secondsSinceCameraAudio: cameraAudioReferenceMs == null ? null : Math.max(0, (nowMs - cameraAudioReferenceMs) / 1000),
        commentarySyncStatus: syncStatus,
        commentaryDelayConfiguredMs: commentarySources.size > 0 ? clamp(commentaryDelayMs, 0, 10_000) : null,
        commentaryDelayTargetMs: syncTargetDelayMs,
        commentaryDelayAppliedMs: syncAppliedDelayMs,
        commentarySyncRttMs: syncRttMs,
        commentarySyncSampleAgeMs: syncSampleAgeMs
      });
    }, 500);

    return () => {
      cancelled = true;
      window.clearInterval(meter);
      window.clearInterval(cameraAttachTimer);
      window.clearInterval(clockTimer);
      window.clearInterval(syncTimer);
      if (reconnectTimer != null) window.clearTimeout(reconnectTimer);
      for (const state of commentarySources.values()) {
        state.source.disconnect();
        state.delay.disconnect();
      }
      commentarySources.clear();
      room?.disconnect();
      cameraSource?.disconnect();
      cameraGain.disconnect();
      cameraAnalyser.disconnect();
      commentaryGain.disconnect();
      compressor.disconnect();
      commentaryAnalyser.disconnect();
      void context.close();
      onHealth(EMPTY_PROGRAM_AUDIO_HEALTH);
    };
  }, [
    cameraElement,
    cameraGainDb,
    commentary,
    commentaryDelayMs,
    commentaryGainDb,
    courtNumber,
    onHealth,
    programTimingRef
  ]);

  return null;
}

async function sampleAudioNetwork(state: CommentarySourceState): Promise<{
  jitterBufferMs: number | null;
  packetsLost: number | null;
  packetsReceived: number | null;
} | null> {
  const receiver = state.track.receiver;
  if (!receiver) return null;
  try {
    const reports = await receiver.getStats();
    let totals: RtcJitterTotals | null = null;
    let packetsLost: number | null = null;
    let packetsReceived: number | null = null;
    reports.forEach((report) => {
      const row = report as RTCStats & Record<string, unknown>;
      if (row.type !== "inbound-rtp" || (row.kind !== "audio" && row.mediaType !== "audio")) return;
      packetsLost = finiteNumber(row.packetsLost);
      packetsReceived = finiteNumber(row.packetsReceived);
      const emittedCount = finiteNumber(row.jitterBufferEmittedCount);
      const jitterBufferDelaySeconds = finiteNumber(row.jitterBufferDelay);
      if (emittedCount == null || jitterBufferDelaySeconds == null) return;
      totals = {
        emittedCount,
        jitterBufferDelaySeconds,
        jitterBufferTargetDelaySeconds: finiteNumber(row.jitterBufferTargetDelay)
      };
    });
    if (!totals) return packetsLost != null || packetsReceived != null
      ? { jitterBufferMs: null, packetsLost, packetsReceived }
      : null;
    const sample = intervalJitterSample(state.previousJitterTotals, totals);
    state.previousJitterTotals = totals;
    return {
      jitterBufferMs: sample.jitterBufferTargetMs ?? sample.jitterBufferMs,
      packetsLost,
      packetsReceived
    };
  } catch {
    return null;
  }
}

function scheduleDelay(state: CommentarySourceState, context: AudioContext) {
  const nextDelayMs = state.controller.appliedDelayMs;
  if (Math.abs(nextDelayMs - state.scheduledDelayMs) < 0.5) return;
  const now = context.currentTime;
  state.delay.delayTime.cancelScheduledValues(now);
  state.delay.delayTime.setValueAtTime(state.scheduledDelayMs / 1000, now);
  state.delay.delayTime.linearRampToValueAtTime(nextDelayMs / 1000, now + 0.8);
  state.scheduledDelayMs = nextDelayMs;
}

function aggregateSyncStatus(statuses: CommentarySyncStatus[]): CommentarySyncStatus {
  if (statuses.length === 0 || statuses.some((status) => status === "fallback")) return "fallback";
  if (statuses.some((status) => status === "calibrating")) return "calibrating";
  return "locked";
}

function average(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function dbToGain(db: number): number {
  const safe = clamp(Number.isFinite(db) ? db : 0, -60, 12);
  return 10 ** (safe / 20);
}

function analyserLevels(analyser: AnalyserNode): { rmsDb: number; peakDb: number; clippedSampleRatio: number } {
  const samples = new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(samples);
  let sum = 0;
  let peak = 0;
  let clipped = 0;
  for (const sample of samples) {
    const absolute = Math.abs(sample);
    sum += sample * sample;
    peak = Math.max(peak, absolute);
    if (absolute >= 0.99) clipped += 1;
  }
  const rms = Math.sqrt(sum / samples.length);
  return {
    rmsDb: rms > 0 ? Math.max(-120, 20 * Math.log10(rms)) : -120,
    peakDb: peak > 0 ? Math.max(-120, 20 * Math.log10(peak)) : -120,
    clippedSampleRatio: clipped / samples.length
  };
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
