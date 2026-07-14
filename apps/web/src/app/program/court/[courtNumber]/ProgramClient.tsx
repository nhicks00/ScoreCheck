"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { OverlayClient, type OverlayRenderHealth } from "@/app/overlay/court/[courtNumber]/OverlayClient";
import { StreamPlayer, type StreamConnectionHealth } from "@/components/StreamPlayer";
import type { CommentaryConnection } from "@/lib/commentary";
import type { ProgramMonitoringConnection } from "@/lib/programMonitoring";
import { incrementProgramReconnect, recordProgramPageLoad } from "@/lib/programDiagnostics";
import type { StreamTimingSample } from "@/lib/rtcTiming";
import {
  analyzeVisualFrame,
  EMPTY_PROGRAM_VISUAL_HEALTH,
  initialVisualAnalysisState,
  VISUAL_ANALYSIS_HEIGHT,
  VISUAL_ANALYSIS_INTERVAL_MS,
  VISUAL_ANALYSIS_WIDTH,
  type ProgramVisualHealth
} from "@/lib/visualHealth";
import {
  buildProgramMonitorHeartbeat,
  initialProgramWatchdog,
  PROGRAM_COMMENTARY_WAIT_MS,
  PROGRAM_HEARTBEAT_INTERVAL_MS,
  PROGRAM_STAGE_HEIGHT,
  PROGRAM_STAGE_WIDTH,
  PROGRAM_WATCHDOG_TICK_MS,
  programWatchdogStep
} from "@/lib/programWatchdog";
import {
  EMPTY_PROGRAM_AUDIO_HEALTH,
  ProgramAudioMixer,
  type ProgramAudioHealth
} from "./ProgramAudioMixer";

/**
 * The compositor scene (docs/PRODUCTION_PLATFORM_PLAN.md §3.1): court video,
 * the exact broadcast scorebug, and hidden commentary audio on a fixed
 * 1280x720 logical stage scaled to the viewport. A headless-Chrome LiveKit
 * egress captures this page, waiting for the START_RECORDING console signal.
 */

type ProgramClientProps = {
  courtNumber: number;
  sources: { whepUrl: string | null; hlsUrl: string | null };
  commentary: CommentaryConnection | null;
  cameraGainDb: number;
  commentaryGainDb: number;
  commentaryDelayMs: number;
  debug: boolean;
  buildVersion: string;
  configurationVersion: string;
  monitoring: ProgramMonitoringConnection | null;
};

const PROGRAM_STABLE_FRAME_TICKS = 3;
const PROGRAM_THUMBNAIL_INTERVAL_MS = 15_000;
const PROGRAM_THUMBNAIL_WIDTH = 256;
const PROGRAM_THUMBNAIL_HEIGHT = 144;
const PROGRAM_THUMBNAIL_JPEG_QUALITY = 0.48;

export function ProgramClient({
  courtNumber,
  sources,
  commentary,
  cameraGainDb,
  commentaryGainDb,
  commentaryDelayMs,
  debug,
  buildVersion,
  configurationVersion,
  monitoring
}: ProgramClientProps) {
  const hasSources = Boolean(sources.whepUrl);

  const rootRef = useRef<HTMLDivElement | null>(null);
  const videoWrapRef = useRef<HTMLDivElement | null>(null);
  const watchdogRef = useRef(initialProgramWatchdog(0));
  const startLoggedRef = useRef(false);
  const endLoggedRef = useRef(false);
  const audioBlockedRef = useRef(false);
  const framesRef = useRef(0);
  const reconnectsRef = useRef(0);
  const reloadCountRef = useRef(0);
  const presentedFramesRef = useRef(0);
  const stableFrameTicksRef = useRef(0);
  const videoStateRef = useRef("waiting");
  const audioHealthRef = useRef<ProgramAudioHealth>(EMPTY_PROGRAM_AUDIO_HEALTH);
  const programTimingRef = useRef<StreamTimingSample | null>(null);
  const streamHealthRef = useRef<StreamConnectionHealth | null>(null);
  const visualHealthRef = useRef<ProgramVisualHealth>(EMPTY_PROGRAM_VISUAL_HEALTH);
  const overlayHealthRef = useRef<OverlayRenderHealth>(EMPTY_OVERLAY_RENDER_HEALTH);
  const pageLoadedAtRef = useRef(new Date().toISOString());
  const heartbeatSeqRef = useRef(0);
  const thumbnailSeqRef = useRef(0);
  const thumbnailCanvasRef = useRef<HTMLCanvasElement | null>(null);

  const [playerEpoch, setPlayerEpoch] = useState(0);
  const [reconnects, setReconnects] = useState(0);
  const [reloadCount, setReloadCount] = useState(0);
  const [framesFlowing, setFramesFlowing] = useState(false);
  const [videoState, setVideoStateState] = useState("waiting");
  const [debugFrames, setDebugFrames] = useState(0);
  const [cameraElement, setCameraElement] = useState<HTMLVideoElement | null>(null);
  const [audioHealth, setAudioHealth] = useState<ProgramAudioHealth>(EMPTY_PROGRAM_AUDIO_HEALTH);
  const [commentaryWaitExpired, setCommentaryWaitExpired] = useState(false);
  const [heartbeatState, setHeartbeatState] = useState<"disabled" | "waiting" | "ok" | "error">(monitoring ? "waiting" : "disabled");

  const setVideoState = useCallback((next: string) => {
    videoStateRef.current = next;
    setVideoStateState(next);
  }, []);

  const recordReconnect = useCallback(() => {
    try {
      const counters = incrementProgramReconnect(window.sessionStorage, courtNumber);
      reconnectsRef.current = counters.reconnectCount;
    } catch {
      reconnectsRef.current += 1;
    }
    setReconnects(reconnectsRef.current);
  }, [courtNumber]);

  const updateAudioHealth = useCallback((next: ProgramAudioHealth) => {
    audioHealthRef.current = next;
    setAudioHealth(next);
  }, []);
  const updateProgramTiming = useCallback((sample: StreamTimingSample | null) => {
    programTimingRef.current = sample;
  }, []);
  const updateStreamHealth = useCallback((health: StreamConnectionHealth | null) => {
    streamHealthRef.current = health;
  }, []);
  const updateOverlayHealth = useCallback((health: OverlayRenderHealth) => {
    overlayHealthRef.current = health;
  }, []);

  const logEndOnce = useCallback(() => {
    if (endLoggedRef.current) return;
    endLoggedRef.current = true;
    console.log("END_RECORDING");
  }, []);

  /* Stage scaling: author at 1280x720, scale to whatever viewport the egress
     (or a human previewing) opens — 720p and 1080p both land pixel-exact. */
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const update = () => {
      const scale = Math.min(
        window.innerWidth / PROGRAM_STAGE_WIDTH,
        window.innerHeight / PROGRAM_STAGE_HEIGHT
      );
      root.style.setProperty("--program-scale", scale.toFixed(5));
    };
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  /* Fatal, unrecoverable state: the court has no playback sources at all, so
     video can never start. Signal the egress rather than pretending. */
  useEffect(() => {
    if (hasSources) return;
    setVideoState("fatal");
    logEndOnce();
  }, [hasSources, setVideoState, logEndOnce]);

  /* Diagnostics survive reload descendants in this tab and never reset when
     playback recovers. performance.timeOrigin makes this Strict Mode safe. */
  useEffect(() => {
    try {
      const navigation = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
      const counters = recordProgramPageLoad(window.sessionStorage, courtNumber, {
        type: navigation?.type ?? "navigate",
        timeOrigin: performance.timeOrigin
      });
      reconnectsRef.current = counters.reconnectCount;
      reloadCountRef.current = counters.reloadCount;
      setReconnects(counters.reconnectCount);
      setReloadCount(counters.reloadCount);
    } catch {
      reconnectsRef.current = 0;
      reloadCountRef.current = 0;
    }
  }, [courtNumber]);

  /* A human previewing the page can click to lift an autoplay-policy mute;
     egress Chrome never blocks autoplay, so this is a no-op there. */
  useEffect(() => {
    const onPointerDown = () => {
      audioBlockedRef.current = false;
    };
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, []);

  /* requestVideoFrameCallback advances only when a frame is actually presented.
     currentTime and decoded-frame counters can advance through some frozen or
     repeated-frame failures, so the watchdog uses this compositor-grade clock. */
  useEffect(() => {
    if (!cameraElement) return;
    let cancelled = false;
    let callbackId = 0;
    const sample = (_now: number, metadata: VideoFrameCallbackMetadata) => {
      if (cancelled) return;
      presentedFramesRef.current = metadata.presentedFrames;
      callbackId = cameraElement.requestVideoFrameCallback(sample);
    };
    callbackId = cameraElement.requestVideoFrameCallback(sample);
    return () => {
      cancelled = true;
      cameraElement.cancelVideoFrameCallback(callbackId);
      presentedFramesRef.current = 0;
    };
  }, [cameraElement]);

  useEffect(() => {
    if (!cameraElement) return;
    const canvas = document.createElement("canvas");
    canvas.width = VISUAL_ANALYSIS_WIDTH;
    canvas.height = VISUAL_ANALYSIS_HEIGHT;
    const context = canvas.getContext("2d", { alpha: false, willReadFrequently: true });
    if (!context) return;
    let state = initialVisualAnalysisState();
    const sample = () => {
      if (videoStateRef.current !== "playing" || cameraElement.readyState < 2 || cameraElement.videoWidth <= 0) {
        state = initialVisualAnalysisState();
        visualHealthRef.current = EMPTY_PROGRAM_VISUAL_HEALTH;
        return;
      }
      try {
        drawCover(context, cameraElement, canvas.width, canvas.height);
        const image = context.getImageData(0, 0, canvas.width, canvas.height);
        const result = analyzeVisualFrame(state, image.data, canvas.width, canvas.height, Date.now());
        state = result.state;
        visualHealthRef.current = result.health;
      } catch {
        state = initialVisualAnalysisState();
        visualHealthRef.current = EMPTY_PROGRAM_VISUAL_HEALTH;
      }
    };
    sample();
    const timer = window.setInterval(sample, VISUAL_ANALYSIS_INTERVAL_MS);
    return () => {
      window.clearInterval(timer);
      visualHealthRef.current = EMPTY_PROGRAM_VISUAL_HEALTH;
    };
  }, [cameraElement]);

  /* StreamPlayer owns normal source/transport recovery. This watchdog remounts
     only a foreground connected player that presents no frames past the grace
     window, including a nominally connected but inbound-stalled peer. */
  useEffect(() => {
    if (!hasSources) return;
    const id = window.setInterval(() => {
      const video = videoWrapRef.current?.querySelector("video");
      if (video) ensureProgramPlayback(video, audioBlockedRef);
      const frames = presentedFramesRef.current;
      framesRef.current = frames;
      if (debug) setDebugFrames(frames);
      const stream = streamHealthRef.current;
      const connected = stream?.connectionState === "connected";
      const inboundFrames = stream?.framesDecoded ?? stream?.framesReceived ?? null;

      const step = programWatchdogStep(watchdogRef.current, {
        nowMs: Date.now(),
        hasSources,
        renderWatchdogEligible: connected && document.visibilityState === "visible",
        presentedFrames: frames,
        inboundFrames
      });
      watchdogRef.current = step.state;

      if (!connected) {
        stableFrameTicksRef.current = 0;
        setFramesFlowing(false);
        const state = stream?.connectionState;
        setVideoState(state === "failed" || state === "disconnected" || state === "closed" ? "reconnecting" : "waiting");
        return;
      }

      if (step.progressed) {
        stableFrameTicksRef.current += 1;
        if (stableFrameTicksRef.current >= PROGRAM_STABLE_FRAME_TICKS) {
          setFramesFlowing(true);
          setVideoState("playing");
        } else {
          setVideoState("stabilizing");
        }
      } else if (step.action === "reconnect") {
        stableFrameTicksRef.current = 0;
        setFramesFlowing(false);
        setVideoState("reconnecting");
        recordReconnect();
        setPlayerEpoch((current) => current + 1);
      }
    }, PROGRAM_WATCHDOG_TICK_MS);
    return () => window.clearInterval(id);
  }, [hasSources, debug, recordReconnect, setVideoState]);

  /* START signal: first stable frames plus a connected audio room. An empty
     room is ready; absence of an audio track is health data, not a start gate. */
  const commentaryReady = !commentary || audioHealth.roomConnected || commentaryWaitExpired;
  useEffect(() => {
    if (!framesFlowing || !commentaryReady) return;
    if (startLoggedRef.current || endLoggedRef.current) return;
    startLoggedRef.current = true;
    console.log("START_RECORDING");
  }, [framesFlowing, commentaryReady]);

  /* Never hold START hostage to the commentary server: proceed after 10s and
     keep reconnecting while the broadcast remains alive. */
  useEffect(() => {
    if (!commentary) return;
    const id = window.setTimeout(() => setCommentaryWaitExpired(true), PROGRAM_COMMENTARY_WAIT_MS);
    return () => window.clearTimeout(id);
  }, [commentary]);

  /* Heartbeat: 5s health upsert so the console alarms on page semantics, not
     just "Chrome is running". Failures are swallowed — the heartbeat must
     never destabilize the broadcast page. */
  useEffect(() => {
    if (!monitoring) {
      setHeartbeatState("disabled");
      return;
    }
    const connection = monitoring;
    let cancelled = false;
    async function beat() {
      try {
        heartbeatSeqRef.current += 1;
        const audio = audioHealthRef.current;
        const res = await fetch(connection.heartbeatUrl, {
          method: "POST",
          headers: {
            authorization: `Bearer ${connection.credential}`,
            "content-type": "application/json"
          },
          body: JSON.stringify(
            buildProgramMonitorHeartbeat({
              credentialId: connection.credentialId,
              courtNumber,
              heartbeatSeq: heartbeatSeqRef.current,
              sampledAt: new Date().toISOString(),
              pageLoadedAt: pageLoadedAtRef.current,
              pageBuildVersion: buildVersion,
              configurationVersion,
              videoState: videoStateRef.current,
              framesRendered: framesRef.current,
              streamHealth: streamHealthRef.current,
              visualHealth: visualHealthRef.current,
              reconnectCount: reconnectsRef.current,
              reloadCount: reloadCountRef.current,
              commentaryConfigured: Boolean(commentary),
              commentaryRoomConnected: audio.roomConnected,
              commentaryParticipantCount: audio.participantCount,
              commentaryAudioTrackCount: audio.audioTrackCount,
              commentaryMutedAudioTrackCount: audio.mutedAudioTrackCount,
              commentaryRmsDb: audio.commentaryRmsDb,
              commentaryPeakDb: audio.commentaryPeakDb,
              commentaryClippedSampleRatio: audio.commentaryClippedSampleRatio,
              secondsSinceCommentaryAudio: audio.secondsSinceCommentaryAudio,
              commentaryPacketsLost: audio.commentaryPacketsLost,
              commentaryPacketsReceived: audio.commentaryPacketsReceived,
              commentaryJitterBufferMs: audio.commentaryJitterBufferMs,
              cameraAudioTrackPresent: audio.cameraTrackPresent,
              cameraAudioRmsDb: audio.cameraRmsDb,
              cameraAudioPeakDb: audio.cameraPeakDb,
              cameraAudioClippedSampleRatio: audio.cameraClippedSampleRatio,
              secondsSinceCameraAudio: audio.secondsSinceCameraAudio,
              commentarySyncStatus: audio.commentarySyncStatus,
              commentaryDelayConfiguredMs: audio.commentaryDelayConfiguredMs,
              commentaryDelayTargetMs: audio.commentaryDelayTargetMs,
              commentaryDelayAppliedMs: audio.commentaryDelayAppliedMs,
              commentarySyncRttMs: audio.commentarySyncRttMs,
              commentarySyncSampleAgeMs: audio.commentarySyncSampleAgeMs,
              scoreRender: overlayHealthRef.current
            })
          )
        });
        if (!cancelled) setHeartbeatState(res.ok ? "ok" : "error");
      } catch {
        if (!cancelled) setHeartbeatState("error");
      }
    }
    void beat();
    const id = window.setInterval(() => void beat(), PROGRAM_HEARTBEAT_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [buildVersion, commentary, configurationVersion, courtNumber, monitoring]);

  useEffect(() => {
    if (!monitoring || !cameraElement) return;
    const connection = monitoring;
    const video = cameraElement;
    let cancelled = false;
    let uploading = false;
    async function capture() {
      if (cancelled || uploading || videoStateRef.current !== "playing" || video.readyState < 2 || video.videoWidth <= 0) return;
      uploading = true;
      try {
        const canvas = thumbnailCanvasRef.current ?? document.createElement("canvas");
        thumbnailCanvasRef.current = canvas;
        canvas.width = PROGRAM_THUMBNAIL_WIDTH;
        canvas.height = PROGRAM_THUMBNAIL_HEIGHT;
        const context = canvas.getContext("2d", { alpha: false });
        if (!context) return;
        drawCover(context, video, canvas.width, canvas.height);
        const blob = await canvasJpeg(canvas, PROGRAM_THUMBNAIL_JPEG_QUALITY);
        if (!blob || cancelled) return;
        thumbnailSeqRef.current += 1;
        const sampledAt = new Date().toISOString();
        await fetch(connection.thumbnailUrl, {
          method: "POST",
          headers: {
            authorization: `Bearer ${connection.credential}`,
            "content-type": "image/jpeg",
            "x-scorecheck-court": String(courtNumber),
            "x-scorecheck-credential-id": connection.credentialId,
            "x-scorecheck-sequence": String(thumbnailSeqRef.current),
            "x-scorecheck-sampled-at": sampledAt
          },
          body: blob
        });
      } catch {
        // Visual telemetry is best-effort and must never affect program output.
      } finally {
        uploading = false;
      }
    }
    void capture();
    const id = window.setInterval(() => void capture(), PROGRAM_THUMBNAIL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [cameraElement, courtNumber, monitoring]);

  return (
    <div ref={rootRef} className="program-root">
      <div className="program-stage">
        <div ref={videoWrapRef} className="program-video">
          <StreamPlayer
            key={playerEpoch}
            courtNumber={courtNumber}
            sources={sources}
            chromeless
            mode="program"
            onVideoElement={setCameraElement}
            onTimingSample={updateProgramTiming}
            onConnectionHealth={updateStreamHealth}
            onReconnect={recordReconnect}
          />
        </div>
        {videoState !== "playing" && (
          <div className="program-signal-slate" role="status">
            <span>ScoreCheck</span>
            <strong>Court video signal interrupted</strong>
            <small>Stay tuned</small>
            <p>
              Nathan has been notified via an alert system he built. He&apos;s
              working on getting the camera back up now.
            </p>
          </div>
        )}
        <div className="program-overlay">
          <OverlayClient
            courtNumber={String(courtNumber)}
            eventId=""
            theme="default"
            buildVersion={buildVersion}
            reloadOnVersionChange={false}
            onHealth={updateOverlayHealth}
          />
        </div>
        <ProgramAudioMixer
          courtNumber={courtNumber}
          cameraElement={cameraElement}
          programTimingRef={programTimingRef}
          commentary={commentary}
          cameraGainDb={cameraGainDb}
          commentaryGainDb={commentaryGainDb}
          commentaryDelayMs={commentaryDelayMs}
          onHealth={updateAudioHealth}
        />
      </div>
      {debug && (
        <div className="program-debug">
          <span>court {courtNumber}</span>
          <span>video <strong>{videoState}</strong></span>
          <span>frames <strong>{debugFrames}</strong></span>
          <span>reconnects <strong>{reconnects}</strong></span>
          <span>reloads <strong>{reloadCount}</strong></span>
          <span>commentary <strong>{commentary ? (audioHealth.roomConnected ? `${audioHealth.audioTrackCount} track(s)` : "connecting") : "off"}</strong></span>
          <span>commentary rms <strong>{formatDb(audioHealth.commentaryRmsDb)}</strong></span>
          <span>camera rms <strong>{formatDb(audioHealth.cameraRmsDb)}</strong></span>
          <span>sync <strong>{audioHealth.commentarySyncStatus}</strong></span>
          <span>delay <strong>{formatMs(audioHealth.commentaryDelayAppliedMs)}</strong></span>
          <span>heartbeat <strong>{heartbeatState}</strong></span>
        </div>
      )}
    </div>
  );
}

function canvasJpeg(canvas: HTMLCanvasElement, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
}

function drawCover(context: CanvasRenderingContext2D, video: HTMLVideoElement, width: number, height: number) {
  const sourceAspect = video.videoWidth / video.videoHeight;
  const targetAspect = width / height;
  let sourceX = 0;
  let sourceY = 0;
  let sourceWidth = video.videoWidth;
  let sourceHeight = video.videoHeight;
  if (sourceAspect > targetAspect) {
    sourceWidth = video.videoHeight * targetAspect;
    sourceX = (video.videoWidth - sourceWidth) / 2;
  } else if (sourceAspect < targetAspect) {
    sourceHeight = video.videoWidth / targetAspect;
    sourceY = (video.videoHeight - sourceHeight) / 2;
  }
  context.drawImage(video, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, width, height);
}

const EMPTY_OVERLAY_RENDER_HEALTH: OverlayRenderHealth = {
  loaded: false,
  connected: false,
  stale: false,
  frozen: false,
  matchId: null,
  phase: "UNKNOWN",
  sourceSignature: null,
  renderedSignature: null,
  domMismatchReason: null,
  stateUpdatedAt: null
};

function formatDb(value: number | null): string {
  return value == null ? "n/a" : `${value.toFixed(1)} dB`;
}

function formatMs(value: number | null): string {
  return value == null ? "n/a" : `${Math.round(value)} ms`;
}

/**
 * Keeps the captured feed unmuted and running. If the browser's autoplay
 * policy rejects unmuted playback (human preview without a gesture), fall
 * back to muted playback so the watchdog sees frames instead of a fake stall;
 * egress Chrome allows autoplay, so the fallback never engages there.
 */
function ensureProgramPlayback(video: HTMLVideoElement, audioBlockedRef: { current: boolean }) {
  if (!audioBlockedRef.current && (video.muted || video.volume !== 1)) {
    video.muted = false;
    video.volume = 1;
  }
  if (video.paused && (video.srcObject || video.currentSrc)) {
    void video.play().catch((error: unknown) => {
      // Only a NotAllowedError means the autoplay policy blocked unmuted
      // playback. Anything else (AbortError from reconnect teardown races,
      // NotSupportedError from a dead source) must NOT trip the muted
      // fallback, or a transient glitch would silence the broadcast forever.
      if (!(error instanceof DOMException) || error.name !== "NotAllowedError") return;
      audioBlockedRef.current = true;
      video.muted = true;
      void video.play().catch(() => {
        // Still blocked; the watchdog will keep retrying next tick.
      });
    });
  }
}
